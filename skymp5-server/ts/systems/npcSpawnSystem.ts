import * as fs from "fs";
import * as chokidar from "chokidar";
import { Settings } from "../settings";
import { System, Log, SystemContext, WORLD_LOADED_EVENT } from "./system";
import { resolveEditorIds, isEditorId } from "./espmEditorIds";
import { espmFieldFormIds } from "./formIdUtil";
import { placeNpc, HOSTILE_PROP } from "./npcPlacement";
import { destroyLeftovers } from "./actorUtil";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// File-driven NPC spawner: ./NPC-Spawns.json (server cwd) lists zones that populate when a player walks in and clean up after the last one leaves.
// Format, id rules and the state machine are documented in docs/docs_roleplay_npc_spawns.md.
// The admin panel's NPCs tab (adminSystem.ts) lists, adds, resets and deletes zones through the public methods at the end of the class.

const POLL_MS = 2000;
const ZONES_FILE = "./NPC-Spawns.json";
const SPAWNS_FILE = "./zone-spawns.json";
const FALLEN_FILE = "./npc-fallen-spots.json";
const DESPAWN_HYSTERESIS = 1.5;
const DEFAULT_SIZE = 2000;
const DEFAULT_DESPAWN = 120;
const DEFAULT_RESPAWN = 1800;
const MAX_COUNT = 20;
const MAX_TOTAL = 40;
const MAX_NAME = 64;
const SLOT_SPACING = 96;
// Spawn height above POS so an NPC drops onto an uneven floor instead of starting inside it
const SPAWN_LIFT = 16;
const RETRY_MS = 30000;
const RELOAD_DEBOUNCE_MS = 500;
const TAG_PROP = "private.npcSpawner";
// ACBS template flag: the AI data comes from the TPLT template
const TEMPLATE_USE_AI_DATA = 0x10;
const MAX_TEMPLATE_DEPTH = 8;
// An NPC this far below its spawn point fell out of the world and is replaced on its spot
const FALL_LIMIT = 3000;
// Falls on one spot before the slot is given up: a spot with no floor would otherwise cycle forever
const MAX_SPOT_FALLS = 2;
// A copy created before the client has the room loaded drops through the missing collision, so a spot
// that has dropped an actor is only tried again once a player is this close to it
const SAFE_RESPAWN_UNITS = 2500;
// The engine refuses a hit past one cell width, so an actor further than this from its target is unhittable
const HIT_RANGE = 4096;
// Polls that far apart before the actor is pulled in, so a real chase is not yanked
const DESYNC_POLLS = 2;
// Above its spot by this much, within this radius of it and still for this many polls: stuck in the air, not climbing
const STRAND_LIFT = 600;
const STRAND_RADIUS = 384;
const STRAND_POLLS = 3;
// A copy whose X/Y are frozen while its Z creeps one way is riding a translation nobody stopped, which
// carries it with collision off until it hangs in the air or sinks through the floor. A standing npc
// holds its Z exactly, and a real fall crosses far more than FLOAT_STEP_MAX in one poll.
const FLOAT_LIFT = 250;
const FLOAT_STEP_MIN = 0.5;
const FLOAT_STEP_MAX = 64;
const FLOAT_POLLS = 3;
// Player bucket size for the zone poll; one exterior cell, so a 3000 unit zone reaches one square
const GRID_UNITS = 4096;
// Beyond this many squares a zone is cheaper to test against every player in its world
const MAX_GRID_SPAN = 8;
// Live spawned actors allowed at once across every zone. Overridable via "npcLiveBudget".
const DEFAULT_MAX_LIVE = 150;
const BUDGET_RETRY_MS = 10000;
const BUDGET_LOG_MS = 60000;
// A poll slower than this is worth a line in the log, at most once a minute
const SLOW_POLL_MS = 50;
const SLOW_LOG_MS = 60000;
// An NPC dragged this far from its zone is not coming home; its slot is freed for the next player
const LEASH_MIN = 8000;
const LEASH_RADII = 3;
// Slot cooldown marker for Respawn 0: the slot stays empty until the zone despawns or an admin resets it
const NEVER_READY = -1;
// A corpse is removed this long after death, whatever its zone does. Overridable via "npcCorpseSeconds".
const DEFAULT_CORPSE_SECONDS = 300;

interface ZoneNpc {
  baseDesc: string;
  count: number;
}

interface PlayerSnapshot {
  id: number;
  world: number;
  pos: number[];
}

interface PlayerIndex {
  byWorld: Map<number, PlayerSnapshot[]>;
  grid: Map<string, PlayerSnapshot[]>;
}

const NO_PLAYERS: PlayerSnapshot[] = [];

interface Spawned {
  id: number;
  slot: number;
  diedAt: number;
}

interface Zone {
  name: string;
  cellOrWorldDesc: string;
  cellOrWorldId: number;
  pos: number[];
  radius: number;
  // Optional placed reference used as the PlaceAtMe self, so the NPC appears on that spot instead of at a player
  anchorId: number;
  // Spawns without a player in range; needs an anchor ref as the PlaceAtMe self
  prespawn: boolean;
  // Waits for a player inside its own radius, instead of filling with the rest of its dungeon
  ambush: boolean;
  npcs: ZoneNpc[];
  // One entry per NPC to place; slot i stands at slotPos(i)
  slots: ZoneNpc[];
  total: number;
  despawnSeconds: number;
  respawnSeconds: number;
  // Per slot: 0 = may spawn now, epoch ms = cooldown end, NEVER_READY = not until reset
  slotReadyAt: number[];
  // Everything that defines the zone; a reload keeps zones whose signature did not change
  signature: string;
  spawned: Spawned[];
  emptySince: number;
  inside: Set<number>;
}

// A file entry with its fields checked but the location and NPC bases not yet resolved
interface Draft {
  name: string;
  locator: string;
  anchor: string;
  prespawn?: boolean;
  ambush?: boolean;
  pos: number[];
  radius: number;
  npcs: { id: string; count: number }[];
  despawnSeconds: number;
  respawnSeconds: number;
}

export interface ZoneSummary {
  name: string;
  active: boolean;
  alive: number;
  total: number;
  inside: number;
  // Seconds until every slot may spawn: 0 = ready, -1 = never until reset
  readyInSec: number;
}

type Reject = (msg: string) => void;

// The parsed zone file; root and key are set when the array sits under a wrapper object
interface ZoneFile {
  list: unknown[];
  root: Record<string, unknown> | null;
  key: string;
  missing: boolean;
}

// Field names in the file are matched case-insensitively; key must be lower case
const pickKey = (raw: unknown, key: string): string | undefined => {
  if (!raw || typeof raw !== "object") return undefined;
  return Object.keys(raw).find((x) => x.toLowerCase() === key);
};

const pick = (raw: unknown, key: string): unknown => {
  const k = pickKey(raw, key);
  return k === undefined ? undefined : (raw as Record<string, unknown>)[k];
};

const num = (v: unknown, fallback: number): number => {
  if (v === undefined || v === null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const hex = (id: number): string => id.toString(16);

const isHexId = (text: string): boolean => /^0x[0-9a-f]{1,8}$/i.test(text) || /^[0-9a-f]{1,8}$/i.test(text);

// ID forms: "1a26f:Skyrim.esm" desc, "0x0001A26F" / "0001A26F" load-order id, anything else an editor id

const entryName = (raw: unknown): string => String(pick(raw, "name") ?? "").trim().toLowerCase();

export class NpcSpawnSystem implements System {
  systemName = "NpcSpawnSystem";
  constructor(private log: Log) { }

  private mp: Mp = null;
  private zones: Zone[] = [];
  // Ids placed by the previous run, destroyed once the world DB has loaded
  private leftovers: number[] = [];
  private ready = false;
  private loading = false;
  // Loads run one at a time, whether the watcher or the admin panel asks
  private loadChain: Promise<void> = Promise.resolve();
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;
  // Dead NPC actorId -> epoch ms when its corpse is destroyed
  private corpses = new Map<number, number>();
  private corpseMs = DEFAULT_CORPSE_SECONDS * 1000;
  private budgetLoggedAt = 0;
  private slowLoggedAt = 0;
  private maxLive = DEFAULT_MAX_LIVE;
  // Pulling a desynced actor to its target removes its ragdoll mid fight and has crashed the client
  private desyncPull = false;

  async initAsync(ctx: SystemContext): Promise<void> {
    this.mp = ctx.svr as Mp;
    const all = (await Settings.get()).allSettings as Record<string, unknown> | null;
    const rawCorpse = Number(all?.["npcCorpseSeconds"]);
    if (Number.isFinite(rawCorpse) && rawCorpse > 0) this.corpseMs = rawCorpse * 1000;
    this.desyncPull = all?.["npcDesyncPull"] === true;
    const rawBudget = Number(all?.["npcLiveBudget"]);
    if (Number.isFinite(rawBudget) && rawBudget > 0) this.maxLive = Math.floor(rawBudget);
    this.loadFallen();
    this.cleanupLeftovers(this.mp);
    ctx.gm.once(WORLD_LOADED_EVENT, () => this.removeLeftovers());
    await this.queueLoad("boot");
    this.watchFile();
    this.ready = true;
    (globalThis as any).__alduinakNpcSpawnNow = (prefix: string): Promise<number> => this.queueLoad("gamemode").then(() => {
      let placed = 0;
      let fallback: number | undefined;
      try {
        const online = this.mp.get(0, "onlinePlayers");
        if (Array.isArray(online) && online.length > 0) fallback = online[0];
      } catch {}
      for (const zone of this.zones) {
        if (!zone.name.startsWith(String(prefix))) continue;
        // An ambush is not part of the pre-spawn: it waits for somebody to walk into its own radius
        if (zone.ambush && zone.inside.size === 0) continue;
        this.fillSlots(this.mp, zone, Date.now(), fallback);
        placed += zone.spawned.length;
      }
      return placed;
    });
  }

  private queueLoad(reason: string): Promise<void> {
    this.loadChain = this.loadChain
      .then(() => this.load(this.mp, reason))
      .catch((e) => this.log(`NpcSpawnSystem: load failed (${reason}): ${e}`));
    return this.loadChain;
  }

  private async load(mp: Mp, reason: string): Promise<void> {
    this.loading = true;
    try {
      const file = this.readZoneFile();
      if (typeof file === "string") {
        this.log(`NpcSpawnSystem: ${file}, keeping ${this.zones.length} zone(s)`);
        return;
      }
      if (file.missing) {
        this.log(`NpcSpawnSystem: ${ZONES_FILE} not found, no zones (${reason})`);
        this.replaceZones(mp, []);
        return;
      }
      const list = file.list;

      const drafts: Draft[] = [];
      const names = new Set<string>();
      for (const raw of list) {
        const draft = this.parseDraft(raw);
        if (!draft) continue;
        const key = draft.name.toLowerCase();
        if (names.has(key)) {
          this.log(`NpcSpawnSystem: '${draft.name}' skipped, duplicate zone name`);
          continue;
        }
        names.add(key);
        drafts.push(draft);
      }
      const editorIds = drafts.map((d) => d.locator).filter(isEditorId);
      const s = await Settings.get();
      const scan = await resolveEditorIds(editorIds, s.dataDir, s.loadOrder, this.log);
      if (editorIds.length) {
        const missing = scan.unresolved.length ? `, unresolved: ${scan.unresolved.join(", ")}` : "";
        this.log(`NpcSpawnSystem: resolved ${editorIds.length - scan.unresolved.length}/${editorIds.length} editor id(s) in ${scan.scannedMs} ms${missing}`);
      }
      const zones: Zone[] = [];
      for (const draft of drafts) {
        const zone = this.buildZone(mp, draft, scan.resolved);
        if (zone) zones.push(zone);
      }
      const carried = this.replaceZones(mp, zones);
      this.log(`NpcSpawnSystem: ${zones.length}/${list.length} zone(s) loaded from ${ZONES_FILE} (${reason}), carried ${carried} zone(s)`);
    } finally {
      this.loading = false;
    }
  }

  // A missing file reads as an empty list; a string names what is wrong with an existing one
  private readZoneFile(): ZoneFile | string {
    let text: string;
    try {
      text = fs.readFileSync(ZONES_FILE, "utf8");
    } catch (e: any) {
      if (e?.code === "ENOENT") return { list: [], root: null, key: "", missing: true };
      return `${ZONES_FILE} unreadable: ${e}`;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return `${ZONES_FILE} is not valid JSON: ${e}`;
    }
    if (Array.isArray(parsed)) return { list: parsed, root: null, key: "", missing: false };
    const key = pickKey(parsed, "zones");
    const list = key === undefined ? undefined : (parsed as Record<string, unknown>)[key];
    if (key === undefined || !Array.isArray(list)) return `${ZONES_FILE} must be an array or { "zones": [...] }`;
    return { list, root: parsed as Record<string, unknown>, key, missing: false };
  }

  // Temp file plus rename so an interrupted write cannot truncate the zone list; a wrapper object keeps its other keys
  private writeZoneFile(file: ZoneFile, list: unknown[]): void {
    const tmp = ZONES_FILE + ".tmp";
    if (file.root) file.root[file.key] = list;
    fs.writeFileSync(tmp, JSON.stringify(file.root ?? list, null, 2));
    fs.renameSync(tmp, ZONES_FILE);
  }

  // Zones whose name and definition did not change keep their NPCs, timers and players; the rest are despawned
  private replaceZones(mp: Mp, zones: Zone[]): number {
    const old = new Map(this.zones.map((z) => [z.name.toLowerCase(), z]));
    const carried = new Set<Zone>();
    for (const zone of zones) {
      const prev = old.get(zone.name.toLowerCase());
      if (!prev || prev.signature !== zone.signature) continue;
      zone.spawned = prev.spawned;
      zone.slotReadyAt = prev.slotReadyAt;
      zone.emptySince = prev.emptySince;
      zone.inside = prev.inside;
      carried.add(prev);
    }
    for (const gone of this.zones) {
      if (!carried.has(gone) && gone.spawned.length) this.despawn(mp, gone);
    }
    this.zones = zones;
    return carried.size;
  }

  private parseDraft(raw: unknown, reject: Reject = (msg) => this.log(`NpcSpawnSystem: ${msg}`)): Draft | null {
    const name = String(pick(raw, "name") ?? "").trim();
    if (!name) {
      reject("entry without a Name skipped");
      return null;
    }
    if (name.length > MAX_NAME) {
      reject(`'${name.slice(0, MAX_NAME)}...' skipped, Name longer than ${MAX_NAME} characters`);
      return null;
    }
    const locator = String(pick(raw, "id") ?? "").trim();
    const pos = this.parsePos(pick(raw, "pos"));
    const radius = num(pick(raw, "size"), DEFAULT_SIZE);
    const npcs = this.parseNpcs(pick(raw, "npc"));
    if (!locator || !pos || !(radius > 0) || !npcs.length) {
      reject(`'${name}' skipped, needs ID, POS {x,y,z}, a positive Size and at least one NPC`);
      return null;
    }
    if (npcs.reduce((sum, n) => sum + n.count, 0) > MAX_TOTAL) {
      reject(`'${name}' skipped, more than ${MAX_TOTAL} NPCs`);
      return null;
    }
    return {
      name, locator, pos, radius, npcs,
      anchor: String(pick(raw, "anchor") ?? "").trim(),
      prespawn: pick(raw, "prespawn") === true,
      ambush: pick(raw, "ambush") === true,
      despawnSeconds: Math.max(0, num(pick(raw, "despawn"), DEFAULT_DESPAWN)),
      respawnSeconds: Math.max(0, num(pick(raw, "respawn"), DEFAULT_RESPAWN)),
    };
  }

  // {x,y,z}, [x,y,z] or "x, y, z"
  private parsePos(raw: unknown): number[] | null {
    let parts: unknown[] | null = null;
    if (Array.isArray(raw)) parts = raw;
    else if (typeof raw === "string") parts = raw.split(/[,\s]+/).filter(Boolean);
    else if (raw && typeof raw === "object") parts = [pick(raw, "x"), pick(raw, "y"), pick(raw, "z")];
    if (!parts || parts.length !== 3) return null;
    const pos = parts.map((v) => num(v, NaN));
    return pos.every((v) => Number.isFinite(v)) ? pos : null;
  }

  // "00023A99 4", "23a99:Skyrim.esm 4" or { id, count }; count defaults to 1
  private parseNpcs(raw: unknown): { id: string; count: number }[] {
    const list = raw === undefined || raw === null ? [] : Array.isArray(raw) ? raw : [raw];
    const out: { id: string; count: number }[] = [];
    for (const item of list) {
      let id = "";
      let count = 1;
      if (typeof item === "string") {
        const m = item.trim().match(/^(.+?)(?:\s+(\d+))?$/);
        if (m) {
          id = m[1];
          count = num(m[2], 1);
        }
      } else if (item && typeof item === "object") {
        id = String(pick(item, "id") ?? "").trim();
        count = num(pick(item, "count"), 1);
      }
      if (id) out.push({ id, count: Math.max(1, Math.min(MAX_COUNT, Math.round(count))) });
    }
    return out;
  }

  private buildZone(mp: Mp, draft: Draft, editorIds: Map<string, string>, reject: Reject = (msg) => this.log(`NpcSpawnSystem: ${msg}`)): Zone | null {
    let cellOrWorldDesc = "";
    let cellOrWorldId = 0;
    try {
      cellOrWorldDesc = this.toLocatorDesc(mp, draft.locator, editorIds);
      cellOrWorldId = cellOrWorldDesc ? mp.getIdFromDesc(cellOrWorldDesc) : 0;
    } catch {
      cellOrWorldDesc = "";
    }
    if (!cellOrWorldDesc) {
      reject(`'${draft.name}' skipped, ID '${draft.locator}' is not a known cell or worldspace`);
      return null;
    }
    const npcs: ZoneNpc[] = [];
    for (const n of draft.npcs) {
      const baseDesc = this.toNpcDesc(mp, n.id);
      if (!baseDesc) {
        reject(`'${draft.name}' NPC '${n.id}' is not an NPC_ record, skipped`);
        continue;
      }
      npcs.push({ baseDesc, count: n.count });
    }
    if (!npcs.length) {
      reject(`'${draft.name}' skipped, no valid NPC`);
      return null;
    }
    const slots = npcs.flatMap((n) => Array<ZoneNpc>(n.count).fill(n));
    let anchorId = 0;
    if (draft.anchor) {
      try { anchorId = mp.getIdFromDesc(draft.anchor.includes(":") ? draft.anchor : mp.getDescFromId(parseInt(draft.anchor, 16))) >>> 0; }
      catch { reject(`'${draft.name}' Anchor '${draft.anchor}' is not a known reference, spawning at a player instead`); }
    }
    return {
      name: draft.name, cellOrWorldDesc, cellOrWorldId, pos: draft.pos, radius: draft.radius, anchorId, npcs, slots,
      prespawn: !!draft.prespawn,
      ambush: !!draft.ambush,
      total: slots.length,
      despawnSeconds: draft.despawnSeconds,
      respawnSeconds: draft.respawnSeconds,
      slotReadyAt: slots.map(() => 0),
      signature: JSON.stringify([cellOrWorldDesc, draft.pos, draft.radius, anchorId, slots.map((n) => n.baseDesc), draft.despawnSeconds, draft.respawnSeconds, !!draft.prespawn, !!draft.ambush]),
      spawned: [], emptySince: 0, inside: new Set(),
    };
  }

  // Extracts group prefix like "dungeon:CYRAngaLocation" from zone name
  private dungeonGroup(name: string): string {
    if (!name.startsWith("dungeon:")) return "";
    const parts = name.split(":");
    return parts.length >= 2 ? `${parts[0]}:${parts[1]}` : "";
  }

  private toLocatorDesc(mp: Mp, locator: string, editorIds: Map<string, string>): string {
    if (locator.includes(":")) return locator;
    if (!isEditorId(locator)) return mp.getDescFromId(parseInt(locator, 16));
    return editorIds.get(locator.toLowerCase()) ?? "";
  }

  // Base forms: "23a99:Skyrim.esm" desc or a load-order hex id; must point at an NPC_ record
  private toNpcDesc(mp: Mp, text: string): string {
    try {
      let desc = text;
      if (!text.includes(":")) {
        if (!isHexId(text)) return "";
        desc = mp.getDescFromId(parseInt(text, 16));
      }
      const rec = mp.lookupEspmRecordById(mp.getIdFromDesc(desc));
      return rec?.record?.type === "NPC_" ? desc : "";
    } catch {
      return "";
    }
  }

  async updateAsync(ctx: SystemContext): Promise<void> {
    await new Promise((r) => setTimeout(r, POLL_MS));
    if (!this.ready) return;
    const mp = ctx.svr as Mp;
    const now = Date.now();
    this.sweepCorpses(mp, now);
    if (this.loading || !this.zones.length) return;

    let playerIds: number[] = [];
    try { playerIds = mp.get(0, "onlinePlayers") ?? []; } catch { return; }

    const startedAt = Date.now();
    const index = this.buildIndex(this.snapshotPlayers(mp, playerIds));

    const activeDungeons = new Set<string>();
    const activeInteriorCells = new Set<number>();
    const dungeonAnchors = new Map<string, number>();
    const interiorAnchors = new Map<number, number>();

    for (const [cellId, playersInCell] of index.byWorld.entries()) {
      if (playersInCell && playersInCell.length > 0) {
        activeInteriorCells.add(cellId);
        interiorAnchors.set(cellId, playersInCell[0].id);
      }
    }

    for (const zone of this.zones) {
      this.updateInside(mp, zone, index);
      if (zone.inside.size > 0) {
        const dGroup = this.dungeonGroup(zone.name);
        if (dGroup) {
          activeDungeons.add(dGroup);
          if (!dungeonAnchors.has(dGroup)) {
            const pid = zone.inside.values().next().value;
            if (pid) dungeonAnchors.set(dGroup, pid);
          }
        }
      }
    }

    for (const zone of this.zones) {
      const dGroup = this.dungeonGroup(zone.name);
      const inActiveDungeon = !!dGroup && activeDungeons.has(dGroup);
      const inActiveInterior = activeInteriorCells.has(zone.cellOrWorldId);
      const isDungeonZone = !!dGroup;

      // An ambush waits for somebody inside its own radius: its vanilla template lay in a linked coffin or pod
      // until the player came close, and neither the package nor the link survives a PlaceAtMe spawn
      const occupied = zone.inside.size > 0 ||
        (!zone.ambush && (zone.prespawn || inActiveDungeon || (isDungeonZone && inActiveInterior)));
      if (zone.spawned.length) {
        this.checkDeaths(mp, zone, now);
        this.checkMisplaced(mp, zone, now);
      }
      if (occupied) {
        zone.emptySince = 0;
        this.fillSlots(mp, zone, now, (dGroup ? dungeonAnchors.get(dGroup) : undefined) ?? interiorAnchors.get(zone.cellOrWorldId));
      } else if (zone.spawned.length && zone.despawnSeconds > 0) {
        if (!zone.emptySince) zone.emptySince = now;
        if (now - zone.emptySince >= zone.despawnSeconds * 1000) this.despawn(mp, zone);
      }
    }

    // What the poll actually costs, for the gamemode's /load and for a slow-poll warning
    const took = Date.now() - startedAt;
    (globalThis as any).__alduinakSpawnPollMs = took;
    if (took > SLOW_POLL_MS && Date.now() - this.slowLoggedAt > SLOW_LOG_MS) {
      this.slowLoggedAt = Date.now();
      this.log(`NpcSpawnSystem: poll took ${took} ms for ${this.zones.length} zones and ${playerIds.length} player(s)`);
    }
  }

  // Every player is read once per poll instead of once per zone per poll
  private snapshotPlayers(mp: Mp, ids: number[]): PlayerSnapshot[] {
    const out: PlayerSnapshot[] = [];
    for (const id of ids) {
      try { out.push({ id, world: mp.getActorCellOrWorld(id), pos: mp.getActorPos(id) }); } catch { /* between cells */ }
    }
    return out;
  }

  private buildIndex(players: PlayerSnapshot[]): PlayerIndex {
    const byWorld = new Map<number, PlayerSnapshot[]>();
    const grid = new Map<string, PlayerSnapshot[]>();
    for (const p of players) {
      const world = byWorld.get(p.world);
      if (world) world.push(p); else byWorld.set(p.world, [p]);
      const key = `${p.world}:${Math.floor(p.pos[0] / GRID_UNITS)}:${Math.floor(p.pos[1] / GRID_UNITS)}`;
      const cell = grid.get(key);
      if (cell) cell.push(p); else grid.set(key, [p]);
    }
    return { byWorld, grid };
  }

  // The players a zone could possibly hold: same world, and in a grid square its radius reaches
  private candidates(zone: Zone, index: PlayerIndex): PlayerSnapshot[] {
    const inWorld = index.byWorld.get(zone.cellOrWorldId);
    if (!inWorld || !inWorld.length) return NO_PLAYERS;
    const span = Math.ceil((zone.radius * DESPAWN_HYSTERESIS) / GRID_UNITS);
    // A zone that spans half a worldspace (a dungeon cell) is cheaper to test against everyone
    if (span > MAX_GRID_SPAN) return inWorld;
    const gx = Math.floor(zone.pos[0] / GRID_UNITS);
    const gy = Math.floor(zone.pos[1] / GRID_UNITS);
    const out: PlayerSnapshot[] = [];
    for (let x = gx - span; x <= gx + span; x++) {
      for (let y = gy - span; y <= gy + span; y++) {
        const cell = index.grid.get(`${zone.cellOrWorldId}:${x}:${y}`);
        if (cell) for (const p of cell) out.push(p);
      }
    }
    return out;
  }

  private updateInside(mp: Mp, zone: Zone, index: PlayerIndex): void {
    const near = this.candidates(zone, index);
    if (!near.length) {
      if (zone.inside.size) zone.inside = new Set();
      return;
    }
    const inside = new Set<number>();
    for (const p of near) {
      // Hysteresis: a player already inside only counts as gone beyond 1.5x the trigger radius
      const reach = zone.inside.has(p.id) ? zone.radius * DESPAWN_HYSTERESIS : zone.radius;
      const dx = p.pos[0] - zone.pos[0];
      const dy = p.pos[1] - zone.pos[1];
      const dz = p.pos[2] - zone.pos[2];
      if (dx * dx + dy * dy + dz * dz > reach * reach) continue;
      inside.add(p.id);
      if (!zone.inside.has(p.id)) this.log(`NpcSpawnSystem: '${zone.name}' entered by ${this.actorLabel(mp, p.id)}`);
    }
    zone.inside = inside;
  }

  private actorLabel(mp: Mp, id: number): string {
    let name = "";
    try { name = String(mp.getActorName(id) ?? ""); } catch { }
    return `${name || hex(id)} (${hex(id)})`;
  }

  // PlaceAtMe needs a self ref; a player standing in the zone keeps the new actor in the right cell from the start
  private anchorIn(zone: Zone): number | undefined {
    return zone.inside.values().next().value;
  }

  // Live actors across every zone, so one player crossing a continent cannot trail hundreds of them
  private liveCount(): number {
    let n = 0;
    for (const zone of this.zones) n += zone.spawned.length;
    return n;
  }

  // Places every slot that is empty or holds a corpse once its cooldown has run out
  private fillSlots(mp: Mp, zone: Zone, now: number, fallbackAnchor?: number): void {
    const before = zone.spawned.length;
    let changed = false;
    let live = this.liveCount();
    for (let slot = 0; slot < zone.total; slot++) {
      const entry = zone.spawned.find((e) => e.slot === slot);
      if (entry && !entry.diedAt) continue;
      const at = zone.slotReadyAt[slot];
      if (at < 0 || at > now) continue;
      // A spot that has dropped its quota of npcs into the void has no floor, in this run or any other
      if ((this.fallenSpots.get(`${zone.name}:${slot}`) ?? 0) >= MAX_SPOT_FALLS) continue;
      if (this.fallenSpots.has(`${zone.name}:${slot}`) && !this.playerNear(mp, zone, this.slotPos(zone, slot), SAFE_RESPAWN_UNITS)) continue;
      if (!entry && live >= this.maxLive) {
        if (now - this.budgetLoggedAt > BUDGET_LOG_MS) {
          this.budgetLoggedAt = now;
          this.log(`NpcSpawnSystem: ${live} npcs alive, at the budget of ${this.maxLive}; '${zone.name}' waits for room`);
        }
        zone.slotReadyAt[slot] = now + BUDGET_RETRY_MS;
        continue;
      }
      const anchor = this.anchorIn(zone) ?? (zone.anchorId > 0 ? zone.anchorId : undefined) ?? fallbackAnchor;
      if (anchor === undefined) break;
      const npc = zone.slots[slot];
      const id = this.spawnOne(mp, zone, npc, slot, anchor, fallbackAnchor);
      if (id === null) {
        zone.slotReadyAt[slot] = now + RETRY_MS;
        continue;
      }
      if (entry) {
        this.removeNpc(mp, entry.id);
        this.log(`NpcSpawnSystem: '${zone.name}' respawned ${npc.baseDesc} (${hex(entry.id)} -> ${hex(id)})`);
        entry.id = id;
        entry.diedAt = 0;
      } else {
        zone.spawned.push({ id, slot, diedAt: 0 });
        live++;
      }
      zone.slotReadyAt[slot] = 0;
      changed = true;
    }
    if (!changed) return;
    if (!before) {
      const summary = zone.npcs.map((n) => `${n.baseDesc} x${n.count}`).join(", ");
      this.log(`NpcSpawnSystem: '${zone.name}' spawned ${zone.spawned.length}/${zone.total} npc(s): ${summary}`);
    }
    this.saveSpawns();
  }

  private spawnOne(mp: Mp, zone: Zone, npc: ZoneNpc, slot: number, anchorId: number, fallbackAnchor?: number): number | null {
    try {
      const loc = { cellOrWorldDesc: zone.cellOrWorldDesc, pos: this.slotPos(zone, slot), rot: [0, 0, 0] };
      const attempt = (anchor: number) => {
        const id = placeNpc(mp, anchor, npc.baseDesc, loc);
        try { mp.set(id, TAG_PROP, zone.name); } catch { }
        try { mp.set(id, HOSTILE_PROP, this.isHostileBase(mp, npc.baseDesc)); } catch { }
        return id;
      };
      try {
        return attempt(zone.anchorId || anchorId);
      } catch (e) {
        if (fallbackAnchor !== undefined && fallbackAnchor !== (zone.anchorId || anchorId)) {
          return attempt(fallbackAnchor);
        }
        throw e;
      }
    } catch (e) {
      this.log(`NpcSpawnSystem: '${zone.name}' failed to spawn ${npc.baseDesc}: ${e}`);
      return null;
    }
  }

  private hostileByBase = new Map<string, boolean>();

  private isHostileBase(mp: Mp, baseDesc: string): boolean {
    let hostile = this.hostileByBase.get(baseDesc);
    if (hostile === undefined) {
      try { hostile = this.aiDataHostile(mp, mp.getIdFromDesc(baseDesc) >>> 0, 0); } catch { hostile = false; }
      this.hostileByBase.set(baseDesc, hostile);
    }
    return hostile;
  }

  // Vanilla attacks-on-sight test from AIDT: aggressive, or an aggro radius on a creature that is not cowardly
  private aiDataHostile(mp: Mp, formId: number, depth: number): boolean {
    const res = mp.lookupEspmRecordById(formId);
    const rec = res?.record;
    if (!rec || depth > MAX_TEMPLATE_DEPTH) return false;
    const fields: { type: string; data: Uint8Array }[] = (rec.fields || []).filter((f: any) => f && f.data instanceof Uint8Array);
    const view = (data: Uint8Array) => new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (rec.type === "LVLN") {
      // LVLO: level, padding, then the entry's form id
      const entries: number[] = [];
      for (const f of fields) {
        if (f.type !== "LVLO" || f.data.byteLength < 8) continue;
        try { entries.push(res.toGlobalRecordId(view(f.data).getUint32(4, true)) >>> 0); } catch { }
      }
      return entries.some((id) => this.aiDataHostile(mp, id, depth + 1));
    }
    if (rec.type !== "NPC_") return false;
    const acbs = fields.find((f) => f.type === "ACBS")?.data;
    const templateFlags = acbs && acbs.byteLength >= 20 ? view(acbs).getUint16(18, true) : 0;
    const template = templateFlags & TEMPLATE_USE_AI_DATA ? espmFieldFormIds(res, "TPLT")[0] : 0;
    if (template) return this.aiDataHostile(mp, template, depth + 1);
    const aidt = fields.find((f) => f.type === "AIDT")?.data;
    if (!aidt || aidt.byteLength < 20) return false;
    const [aggression, confidence] = [aidt[0], aidt[1]];
    const aggroRadius = aidt[6] !== 0 && view(aidt).getUint32(16, true) > 0;
    return aggression >= 1 || (aggroRadius && confidence >= 1);
  }

  // Slot 0 stands on POS, the rest fill rings of 6, 12, 18... SLOT_SPACING apart so no two spawn inside each other
  private slotPos(zone: Zone, slot: number): number[] {
    let ring = 0;
    let first = 0;
    const ringSize = (r: number) => Math.max(1, 6 * r);
    while (slot >= first + ringSize(ring)) {
      first += ringSize(ring);
      ring++;
    }
    const size = Math.min(ringSize(ring), zone.total - first);
    const angle = (2 * Math.PI * (slot - first)) / size;
    const radius = ring * SLOT_SPACING;
    return [zone.pos[0] + radius * Math.cos(angle), zone.pos[1] + radius * Math.sin(angle), zone.pos[2] + (slot === 0 ? 0 : SPAWN_LIFT)];
  }

  // A death starts the slot's Respawn cooldown and the corpse's own removal timer
  private checkDeaths(mp: Mp, zone: Zone, now: number): void {
    for (const entry of zone.spawned) {
      if (entry.diedAt) continue;
      let dead = false;
      let gone = false;
      // A throw means the form is gone, which counts as dead
      try { dead = mp.get(entry.id, "isDead") === true; } catch { dead = gone = true; }
      if (!dead) continue;
      entry.diedAt = now;
      zone.slotReadyAt[entry.slot] = zone.respawnSeconds > 0 ? now + zone.respawnSeconds * 1000 : NEVER_READY;
      if (!gone) this.corpses.set(entry.id, now + this.corpseMs);
    }
  }

  private checkMisplaced(mp: Mp, zone: Zone, now: number): void {
    for (const entry of zone.spawned) {
      if (!entry.id || entry.diedAt) continue;
      let pos: number[] = [];
      try { pos = mp.getActorPos(entry.id); } catch { continue; }
      if (this.desyncPull && this.resyncDesynced(mp, zone, entry, pos)) continue;
      const slot = this.slotPos(zone, entry.slot);
      const fell = pos[2] < zone.pos[2] - FALL_LIMIT;
      const leash = Math.max(LEASH_MIN, zone.radius * LEASH_RADII);
      const away = Math.hypot(pos[0] - zone.pos[0], pos[1] - zone.pos[1]);
      const strayed = !fell && away > leash;
      // The server never moves a spawned actor between cells: a movement update that disagrees with
      // the cell it holds is dropped, so once these two part company every hit on the NPC is refused
      // as a worldspace mismatch and it can never be killed. Only a fresh copy fixes it.
      const elsewhere = !fell && !strayed && this.wrongCell(mp, entry.id, zone);
      const settled = fell || strayed || !!elsewhere;
      const stranded = !settled && this.isStranded(entry.id, pos, slot);
      const sliding = !settled && !stranded && this.isSliding(entry.id, pos, slot);
      if (!settled && !stranded && !sliding) continue;
      const why = fell
        ? `fell out of the world (z ${Math.round(pos[2])})`
        : strayed
          ? `strayed ${Math.round(away)} from its zone`
          : elsewhere
            ? `is in ${elsewhere}, not ${zone.cellOrWorldDesc}, so hits on it are refused`
            : stranded
              ? `hung ${Math.round(pos[2] - slot[2])} above its spot`
              : `is riding a translation nothing stopped, ${Math.round(pos[2] - slot[2])} off its spot with its x/y frozen`;
      this.log(`NpcSpawnSystem: '${zone.name}' ${hex(entry.id)} ${why}, placing it again`);
      try { mp.destroyActor(entry.id); } catch { }
      this.airborne.delete(entry.id);
      this.sliding.delete(entry.id);
      entry.id = 0;
      entry.diedAt = now;
      zone.slotReadyAt[entry.slot] = now;
      // A spot with no floor drops every actor placed on it, so the slot is given up after a second fall.
      // A fall with nobody near counts for nothing: the room was not loaded, so the floor was not there yet.
      if (fell) {
        const key = `${zone.name}:${entry.slot}`;
        const witnessed = this.playerNear(mp, zone, slot, SAFE_RESPAWN_UNITS);
        const falls = (this.fallenSpots.get(key) ?? 0) + (witnessed ? 1 : 0);
        this.fallenSpots.set(key, falls);
        if (witnessed) this.saveFallen();
        if (falls >= MAX_SPOT_FALLS) {
          zone.slotReadyAt[entry.slot] = NEVER_READY;
          this.log(`NpcSpawnSystem: '${zone.name}' slot ${entry.slot} at [${slot.map((n) => Math.round(n)).join(", ")}] has dropped ${falls} npcs into the void; leaving it empty`);
        }
      }
    }
  }

  // Once a hosted actor's movement disagrees with the server by a cell width the update is dropped and
  // never corrected, so the server's copy freezes and every hit on it is refused as too distant. The
  // hosting client cannot see that, but the server holds both positions: pull the actor to the player.
  private resyncDesynced(mp: Mp, zone: Zone, entry: Spawned, pos: number[]): boolean {
    let nearest = 0;
    let gap = Infinity;
    for (const playerId of zone.inside) {
      let p: number[] = [];
      try { p = mp.getActorPos(playerId); } catch { continue; }
      const d = Math.hypot(p[0] - pos[0], p[1] - pos[1], p[2] - pos[2]);
      if (d < gap) { gap = d; nearest = playerId; }
    }
    if (!nearest || gap <= HIT_RANGE) {
      this.desynced.delete(entry.id);
      return false;
    }
    const polls = (this.desynced.get(entry.id) ?? 0) + 1;
    this.desynced.set(entry.id, polls);
    if (polls < DESYNC_POLLS) return false;
    this.desynced.delete(entry.id);
    try {
      const p = mp.getActorPos(nearest);
      const loc = {
        cellOrWorldDesc: String(mp.get(nearest, "worldOrCellDesc") || zone.cellOrWorldDesc),
        pos: [p[0], p[1], p[2] + SPAWN_LIFT],
        rot: [0, 0, 0],
      };
      mp.set(entry.id, "locationalData", loc);
      this.log(`NpcSpawnSystem: '${zone.name}' ${hex(entry.id)} was ${Math.round(gap)} from the player it fights, which refuses every hit; pulled to them`);
    } catch (e) {
      this.log(`NpcSpawnSystem: '${zone.name}' ${hex(entry.id)} resync failed: ${e}`);
    }
    return true;
  }

  // Spawned actor id -> consecutive polls found too far from the player in its zone for a hit to land
  private desynced = new Map<number, number>();

  private playerNear(mp: Mp, zone: Zone, pos: number[], units: number): boolean {
    for (const playerId of zone.inside) {
      let p: number[] = [];
      try { p = mp.getActorPos(playerId); } catch { continue; }
      if (Math.hypot(p[0] - pos[0], p[1] - pos[1], p[2] - pos[2]) <= units) return true;
    }
    return false;
  }

  // Cell the server holds for a spawned actor when it is not the one its zone lives in
  private wrongCell(mp: Mp, id: number, zone: Zone): string | "" {
    let where = "";
    try { where = String(mp.get(id, "worldOrCellDesc") || ""); } catch { return ""; }
    if (!where || where.toLowerCase() === zone.cellOrWorldDesc.toLowerCase()) return "";
    return where;
  }

  // Zone slots that have dropped an NPC out of the world, by "<zone>:<slot>"
  // 'zone:slot' -> witnessed falls. A spot with no floor is a property of the world, not of this run,
  // so it is kept on disk; deleting the file makes the server try every spot again.
  private fallenSpots = new Map<string, number>();

  private loadFallen(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(FALLEN_FILE, "utf8")) as Record<string, number>;
      for (const [key, falls] of Object.entries(raw)) {
        if (typeof falls === "number" && falls > 0) this.fallenSpots.set(key, falls);
      }
      const dead = [...this.fallenSpots.values()].filter((n) => n >= MAX_SPOT_FALLS).length;
      if (this.fallenSpots.size) this.log(`NpcSpawnSystem: ${this.fallenSpots.size} spot(s) have dropped npcs before, ${dead} of them given up`);
    } catch { /* no file yet */ }
  }

  private saveFallen(): void {
    try { fs.writeFileSync(FALLEN_FILE, JSON.stringify(Object.fromEntries(this.fallenSpots), null, 1)); }
    catch (e) { this.log(`NpcSpawnSystem: fallen spots file write failed: ${e}`); }
  }

  // Last seen ground position of an NPC hanging above its spot, with the number of polls it has not moved
  private airborne = new Map<number, { xy: number[]; polls: number }>();

  private isStranded(id: number, pos: number[], slot: number[]): boolean {
    const near = pos[2] - slot[2] >= STRAND_LIFT
      && Math.hypot(pos[0] - slot[0], pos[1] - slot[1]) <= STRAND_RADIUS;
    if (!near) {
      this.airborne.delete(id);
      return false;
    }
    const prev = this.airborne.get(id);
    if (!prev || Math.hypot(pos[0] - prev.xy[0], pos[1] - prev.xy[1]) > 8) {
      this.airborne.set(id, { xy: [pos[0], pos[1]], polls: 0 });
      return false;
    }
    prev.polls++;
    return prev.polls >= STRAND_POLLS;
  }

  // Where an npc stood last poll, with how many polls its z has crept the same way while its x/y held
  private sliding = new Map<number, { xy: number[]; z: number; dir: number; polls: number }>();

  // A translation nobody stopped, anywhere in the zone; isStranded only sees one parked over its own slot
  private isSliding(id: number, pos: number[], slot: number[]): boolean {
    const prev = this.sliding.get(id);
    const step = prev ? pos[2] - prev.z : 0;
    const dir = step > 0 ? 1 : step < 0 ? -1 : 0;
    const creeping = Math.abs(step) >= FLOAT_STEP_MIN && Math.abs(step) <= FLOAT_STEP_MAX;
    const held = !!prev && Math.hypot(pos[0] - prev.xy[0], pos[1] - prev.xy[1]) <= 8;
    const offItsSpot = Math.abs(pos[2] - slot[2]) >= FLOAT_LIFT;
    if (!prev || !held || !creeping || !offItsSpot || dir !== prev.dir) {
      this.sliding.set(id, { xy: [pos[0], pos[1]], z: pos[2], dir, polls: 0 });
      return false;
    }
    prev.xy = [pos[0], pos[1]];
    prev.z = pos[2];
    prev.polls++;
    return prev.polls >= FLOAT_POLLS;
  }

  // A corpse is left to its timer unless forced (admin reset); a death the poll has not seen yet starts its timer here
  private removeNpc(mp: Mp, id: number, force = false): void {
    if (!id) return;
    if (!force && !this.corpses.has(id)) {
      let dead = false;
      try { dead = mp.get(id, "isDead") === true; } catch { }
      if (dead) this.corpses.set(id, Date.now() + this.corpseMs);
    }
    if (!force && this.corpses.has(id)) return;
    this.corpses.delete(id);
    try { mp.destroyActor(id); } catch { }
  }

  private sweepCorpses(mp: Mp, now: number): void {
    let removed = 0;
    for (const [id, at] of Array.from(this.corpses)) {
      if (at > now) continue;
      this.corpses.delete(id);
      try { mp.destroyActor(id); } catch { }
      // The slot keeps its entry and cooldown; id 0 marks its corpse as gone
      for (const zone of this.zones) {
        for (const entry of zone.spawned) {
          if (entry.id === id) entry.id = 0;
        }
      }
      removed++;
    }
    if (!removed) return;
    this.log(`NpcSpawnSystem: removed ${removed} corpse(s) ${this.corpseMs / 1000} s after death`);
    this.saveSpawns();
  }

  // Cooldowns still running survive the despawn so leaving and coming back cannot skip Respawn; reset clears them and the corpses
  private despawn(mp: Mp, zone: Zone, reset = false): void {
    for (const entry of zone.spawned) {
      this.removeNpc(mp, entry.id, reset);
    }
    this.log(`NpcSpawnSystem: '${zone.name}' despawned ${zone.spawned.length} npc(s)`);
    zone.spawned = [];
    zone.emptySince = 0;
    const now = Date.now();
    zone.slotReadyAt = zone.slotReadyAt.map((at) => reset || at < 0 || at <= now ? 0 : at);
    // An admin reset forgets the void spots as well; otherwise they are kept, or the same slot drops
    // two more npcs into it the next time this zone fills
    if (reset) {
      for (let slot = 0; slot < zone.total; slot++) this.fallenSpots.delete(`${zone.name}:${slot}`);
      this.saveFallen();
    }
    this.saveSpawns();
  }

  private watchFile(): void {
    const watcher = chokidar.watch(ZONES_FILE, { persistent: true, ignoreInitial: true, awaitWriteFinish: true });
    const schedule = () => this.scheduleReload();
    watcher.on("add", schedule);
    watcher.on("change", schedule);
    watcher.on("unlink", schedule);
    watcher.on("error", (e: unknown) => this.log(`NpcSpawnSystem: watch error: ${e}`));
  }

  // Coalesces the burst of events one save produces into a single reload
  private scheduleReload(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null;
      this.queueLoad("file changed");
    }, RELOAD_DEBOUNCE_MS);
  }

  // Spawned NPCs persist in the world DB, so ids from a previous run are read on boot and destroyed instead of leaking forever
  private cleanupLeftovers(_mp: Mp): void {
    let ids: unknown = [];
    try { ids = JSON.parse(fs.readFileSync(SPAWNS_FILE, "utf8")); } catch { }
    this.leftovers = Array.isArray(ids) ? ids.map((id) => Number(id) >>> 0).filter((id) => id > 0) : [];
  }

  // Saved forms load in attachSaveStorage after every system's init; NPCs this run placed are never touched
  private removeLeftovers(): void {
    const current = new Set(this.zones.flatMap((z) => z.spawned.map((e) => e.id)));
    const ids = this.leftovers.filter((id) => !current.has(id));
    this.leftovers = [];
    if (ids.length) {
      const removed = destroyLeftovers(this.mp, ids, (id) => !!this.mp.get(id, TAG_PROP));
      this.log(`NpcSpawnSystem: removed ${removed}/${ids.length} leftover npc(s) from the previous run`);
    }
    this.saveSpawns();
  }

  private saveSpawns(): void {
    const placed = this.zones.flatMap((z) => z.spawned.map((e) => e.id));
    const ids = Array.from(new Set([...placed, ...this.corpses.keys()])).filter((id) => id > 0);
    try { fs.writeFileSync(SPAWNS_FILE, JSON.stringify(ids)); }
    catch (e) { this.log(`NpcSpawnSystem: spawns file write failed: ${e}`); }
  }

  private findZone(name: string): Zone | undefined {
    const key = name.trim().toLowerCase();
    return this.zones.find((z) => z.name.toLowerCase() === key);
  }

  private readyInSec(zone: Zone, now: number): number {
    let wait = 0;
    for (const at of zone.slotReadyAt) {
      if (at < 0) return NEVER_READY;
      wait = Math.max(wait, at - now);
    }
    return Math.ceil(wait / 1000);
  }

  // ── Admin panel API ──────────────────────────────────────────────────────────

  listZones(): ZoneSummary[] {
    const now = Date.now();
    return this.zones.map((z) => ({
      name: z.name,
      active: z.spawned.length > 0,
      alive: z.spawned.filter((e) => !e.diedAt).length,
      total: z.total,
      inside: z.inside.size,
      readyInSec: this.readyInSec(z, now),
    }));
  }

  // Validates like a file load, then appends the entry in the documented field names; null on success, else the reason
  async addZone(raw: unknown): Promise<string | null> {
    const reasons: string[] = [];
    const reject: Reject = (msg) => reasons.push(msg);
    const draft = this.parseDraft(raw, reject);
    if (!draft) return reasons[0];
    const s = await Settings.get();
    const scan = await resolveEditorIds(isEditorId(draft.locator) ? [draft.locator] : [], s.dataDir, s.loadOrder, this.log);
    this.buildZone(this.mp, draft, scan.resolved, reject);
    if (reasons.length) return reasons[0];
    const file = this.readZoneFile();
    if (typeof file === "string") return file;
    if (file.list.some((e) => entryName(e) === draft.name.toLowerCase())) return `'${draft.name}' already exists`;
    file.list.push({
      Name: draft.name,
      ID: draft.locator,
      POS: { x: draft.pos[0], y: draft.pos[1], z: draft.pos[2] },
      Size: draft.radius,
      NPC: draft.npcs.map((n) => n.count > 1 ? `${n.id} ${n.count}` : n.id),
      Ambush: draft.ambush,
      Despawn: draft.despawnSeconds,
      Respawn: draft.respawnSeconds,
    });
    try {
      this.writeZoneFile(file, file.list);
    } catch (e) {
      this.log(`NpcSpawnSystem: ${ZONES_FILE} write failed: ${e}`);
      return `${ZONES_FILE} write failed, see server log`;
    }
    this.log(`NpcSpawnSystem: '${draft.name}' appended to ${ZONES_FILE} by admin`);
    await this.queueLoad("admin add");
    return null;
  }

  // Rewrites the file without the entry; the reload that follows despawns it
  async deleteZone(name: string): Promise<boolean> {
    const file = this.readZoneFile();
    if (typeof file === "string") {
      this.log(`NpcSpawnSystem: ${file}, delete refused`);
      return false;
    }
    const key = name.trim().toLowerCase();
    const kept = file.list.filter((e) => entryName(e) !== key);
    if (kept.length === file.list.length) return false;
    try {
      this.writeZoneFile(file, kept);
    } catch (e) {
      this.log(`NpcSpawnSystem: ${ZONES_FILE} write failed: ${e}`);
      return false;
    }
    this.log(`NpcSpawnSystem: '${name}' removed from ${ZONES_FILE} by admin`);
    await this.queueLoad("admin delete");
    return true;
  }

  // Destroys the zone's NPCs and clears every cooldown; it repopulates on the next poll with a player inside
  resetZone(name: string): boolean {
    const zone = this.findZone(name);
    if (!zone) return false;
    this.despawn(this.mp, zone, true);
    return true;
  }

  teleportTarget(name: string): { cellOrWorldDesc: string; pos: number[] } | null {
    const zone = this.findZone(name);
    return zone ? { cellOrWorldDesc: zone.cellOrWorldDesc, pos: zone.pos } : null;
  }
}
