import * as fs from "fs";
import * as path from "path";
import { Settings } from "../settings";
import { System, Log, SystemContext, Content } from "./system";
import { espmRefrFieldId } from "./formIdUtil";
import { readAdminRoleConfig, adminTierOf, AdminRoleConfig } from "./adminRoles";
import { getZones, Zones, Zone } from "./zones";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// ── Notice boards: public notices, one pool per hold ─────────────────────────
//
// Manny's Notice Board mod (and our own board activators) place boards in every
// town. Activating one opens the board of the hold it stands in: a board in
// Riverwood shows Whiterun's notices, one inside a stronghold's radius shows
// that stronghold's. Three tabs: Hold Notices (free, officials only), Shop Ads
// and Citizen Notices (30 gold a post). Everyone reads every tab. Notices fade
// after a week; a board holds 60. Officials of the hold and admins can take a
// notice down.
//
// Wire protocol - every message is a CustomPacket carrying JSON:
//   Client -> Server:
//     { customPacketType: "bountyBoardOpenRequest" }
//     { customPacketType: "bountyBoardPost", board: <zoneId>, tab, text }
//     { customPacketType: "bountyBoardRemove", board: <zoneId>, id }
//     { customPacketType: "bountyBoardClose" }
//   Server -> Client:
//     { customPacketType: "bountyBoardMenu", board: <zoneId>, boardName, reason,
//       costGold, gold, maxTextLen, maxNotes, expiryDays,
//       tabs: [{ id, label, cost, canPost }],
//       notes: [{ id, tab, author, text, ageHours, canRemove }] }
//     { customPacketType: "bountyBoardNotice", text }
//
// Persistence: notice-boards.json next to zones.json (one file, every hold),
// written atomically after each change. Notices expire lazily on every read
// plus a slow sweep.
//
// server-settings.json keys (all optional):
//   noticeBoardBaseDescs    board activator bases, default Manny's + ours
//   bountyBoardCostGold     price of a Shop or Citizen post, default 30
//   bountyBoardExpiryDays   days a notice stays up, default 7
//   bountyBoardMaxNotes     notices one hold's board holds, default 60
//   bountyBoardMaxTextLen   characters per notice, default 500
//   bountyBoardMaxDistance  posting reach in game units, default 512

const DEFAULT_BASE_DESCS = [
  "3e10:notice board.esp",          // manny_up_NoticeBoardActivator
  "6:DragonBreak.esp",              // Noticeboard
  "900:DragonBreak Harvest.esp",    // RP_NoticeBoard
  "901:DragonBreak Harvest.esp",    // RP_NoticeBoardCandle
  "902:DragonBreak Harvest.esp",    // RP_NoticeBoardWall
];

const STORE_FILE = "notice-boards.json";
const GOLD_BASE_ID = 0x0000000f;

const DEFAULT_COST_GOLD = 30;
const DEFAULT_EXPIRY_DAYS = 7;
const DEFAULT_MAX_NOTES = 60;
const DEFAULT_MAX_TEXT_LEN = 500;
const DEFAULT_MAX_DISTANCE = 512;

const POST_COOLDOWN_MS = 5000;
const OPEN_COOLDOWN_MS = 1000;
const SWEEP_INTERVAL_MS = 60 * 60000;
const MAX_ESPM_CACHE = 4096;
// getUserByActor reports failure with Networking::InvalidUserId, not -1.
const INVALID_USER_ID = 65535;

export type TabId = "hold" | "shop" | "citizen";
const TABS: Array<{ id: TabId; label: string; official: boolean }> = [
  { id: "hold", label: "Hold Notices", official: true },
  { id: "shop", label: "Shop Ads", official: false },
  { id: "citizen", label: "Citizen Notices", official: false },
];
const isTab = (v: unknown): v is TabId => TABS.some((t) => t.id === v);

interface BoardNote {
  id: number;
  tab: TabId;
  author: string;
  // Poster's account, kept for the audit trail and removal rights; never sent to clients.
  profileId: number;
  text: string;
  createdAt: number;
}

interface BoardRecord {
  nextId: number;
  notes: BoardNote[];
}

interface BoardSession {
  zoneId: string;
  // The board the player actually stood at; reach is checked against it.
  refr: number;
}

const emptyRecord = (): BoardRecord => ({ nextId: 1, notes: [] });

export class BountyBoardSystem implements System {
  systemName = "BountyBoardSystem";

  constructor(private log: Log) { }

  async initAsync(ctx: SystemContext): Promise<void> {
    const s = await Settings.get();
    const all = s.allSettings as Record<string, unknown> | null;
    this.roleCfg = readAdminRoleConfig(all);
    this.zones = getZones(this.log);

    const cost = Number(all?.["bountyBoardCostGold"]);
    if (Number.isFinite(cost) && cost >= 0) this.costGold = Math.floor(cost);
    const days = Number(all?.["bountyBoardExpiryDays"]);
    if (Number.isFinite(days) && days > 0) this.expiryDays = days;
    const maxNotes = Number(all?.["bountyBoardMaxNotes"]);
    if (Number.isFinite(maxNotes) && maxNotes > 0) this.maxNotes = Math.floor(maxNotes);
    const maxLen = Number(all?.["bountyBoardMaxTextLen"]);
    if (Number.isFinite(maxLen) && maxLen > 0) this.maxTextLen = Math.floor(maxLen);
    const maxDistance = Number(all?.["bountyBoardMaxDistance"]);
    if (Number.isFinite(maxDistance) && maxDistance > 0) this.maxDistance = maxDistance;

    this.logDir = process.env.DRAGONBREAK_LOG_DIR || String(all?.["logDir"] || "") || "C:\\logs";
    try { fs.mkdirSync(this.logDir, { recursive: true }); } catch { /* appendFile will complain */ }

    const mp = ctx.svr as Mp;
    const descs = Array.isArray(all?.["noticeBoardBaseDescs"]) ? (all!["noticeBoardBaseDescs"] as unknown[]).map(String) : DEFAULT_BASE_DESCS;
    for (const desc of descs) {
      try { this.boardBaseIds.add(mp.getIdFromDesc(desc) >>> 0); } catch { /* base missing from this load order */ }
    }
    if (!this.boardBaseIds.size) {
      this.log(`[board] no board activator base is in the load order, notice boards disabled`);
      return;
    }
    this.storePath = path.join(this.zones.dataDir || process.cwd(), STORE_FILE);
    this.loadStore();

    this.installActivationHook(ctx);
    // A character switch mid-connection voids the session, same as trade.
    ctx.gm.on("userAssignActor", (userId: number) => { this.sessions.delete(userId); });
    // The gamemode's /board chat command opens the menu through this bridge.
    (globalThis as any).__alduinakBountyOpen = (actorId: number) => {
      const userId = this.userOf(ctx, Number(actorId) >>> 0);
      if (userId >= 0) this.onOpenRequest(ctx, userId);
    };
    this.log(`[board] ready, ${this.boardBaseIds.size} board base(s), ${this.costGold} gold a notice, ${this.expiryDays} days on the board, store ${this.storePath}`);
  }

  // Activating a board opens the menu instead of the vanilla activation.
  private installActivationHook(ctx: SystemContext): void {
    const mp = ctx.svr as Mp;
    const previous = typeof mp.onActivate === "function" ? mp.onActivate : null;
    mp.onActivate = (targetId: number, casterId: number): boolean => {
      let isBoard = false;
      try { isBoard = this.onActivate(ctx, targetId >>> 0, casterId >>> 0); }
      catch (e) { this.log(`[board] activation check failed: ${e}`); }
      if (isBoard) return false;
      if (!previous) return true;
      try { return previous.call(mp, targetId, casterId) !== false; } catch { return true; }
    };
  }

  // True when the target is a board and the menu was taken care of.
  private onActivate(ctx: SystemContext, targetId: number, casterId: number): boolean {
    const zone = this.zoneOfBoard(ctx, targetId);
    if (!zone) return false;
    const userId = this.userOf(ctx, casterId);
    if (userId < 0) return true;
    this.sessions.set(userId, { zoneId: zone.id, refr: targetId });
    this.sendMenu(ctx, userId, "open");
    return true;
  }

  customPacket(userId: number, type: string, content: Content, ctx: SystemContext): void {
    switch (type) {
      case "bountyBoardOpenRequest": this.onOpenRequest(ctx, userId); break;
      case "bountyBoardPost": this.onPost(ctx, userId, content); break;
      case "bountyBoardRemove": this.onRemove(ctx, userId, content); break;
      case "bountyBoardClose": this.sessions.delete(userId); break;
      default: break;
    }
  }

  // Notices expire lazily on read; the sweep only covers boards nobody reads.
  async updateAsync(): Promise<void> {
    const now = Date.now();
    const sinceLast = now - this.lastSweepMs;
    if (sinceLast >= 0 && sinceLast < SWEEP_INTERVAL_MS) return;
    this.lastSweepMs = now;
    let dirty = false;
    for (const zoneId of Object.keys(this.store)) if (this.prune(zoneId, this.store[zoneId])) dirty = true;
    if (dirty) this.saveStore();
  }

  disconnect(userId: number): void {
    this.sessions.delete(userId);
    this.lastPostMs.delete(userId);
    this.lastOpenMs.delete(userId);
  }

  // ── Opening ─────────────────────────────────────────────────────────────────

  // The other road in, for the N hotkey and the /board command: the nearest board
  // the server has already seen activated. Reach is checked here.
  private onOpenRequest(ctx: SystemContext, userId: number): void {
    const now = Date.now();
    if (now - (this.lastOpenMs.get(userId) || 0) < OPEN_COOLDOWN_MS) return;
    this.lastOpenMs.set(userId, now);
    if (!this.boardBaseIds.size) return;
    const actorId = this.actorOf(ctx, userId);
    if (!actorId) return;
    const board = this.nearestBoard(ctx, actorId);
    if (!board) {
      this.notice(ctx, userId, "There is no notice board within reach. Walk up to one and use it.");
      return;
    }
    this.sessions.set(userId, board);
    this.sendMenu(ctx, userId, "open");
  }

  private nearestBoard(ctx: SystemContext, actorId: number): BoardSession | null {
    const mp = ctx.svr as Mp;
    let pos: any;
    try { pos = mp.get(actorId, "pos"); } catch { return null; }
    if (!Array.isArray(pos)) return null;
    let where = "";
    try { where = String(mp.get(actorId, "worldOrCellDesc") || ""); } catch { /* distance check only */ }
    let best: BoardSession | null = null;
    let bestD2 = this.maxDistance * this.maxDistance;
    this.knownBoards.forEach((zoneId, refrId) => {
      const spot = this.boardSpot(ctx, refrId);
      if (!spot || (where && spot.where && spot.where !== where)) return;
      const dx = Number(pos[0]) - spot.pos[0];
      const dy = Number(pos[1]) - spot.pos[1];
      const dz = Number(pos[2]) - spot.pos[2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (Number.isFinite(d2) && d2 <= bestD2) { bestD2 = d2; best = { zoneId, refr: refrId }; }
    });
    return best;
  }

  // Boards never move, so position and world resolve once per refr.
  private boardSpot(ctx: SystemContext, refrId: number): { pos: number[]; where: string } | null {
    const cached = this.spotCache.get(refrId);
    if (cached !== undefined) return cached;
    const mp = ctx.svr as Mp;
    let spot: { pos: number[]; where: string } | null = null;
    try {
      const pos = mp.get(refrId, "pos");
      if (Array.isArray(pos)) spot = { pos: [Number(pos[0]), Number(pos[1]), Number(pos[2])], where: String(mp.get(refrId, "worldOrCellDesc") || "") };
    } catch { /* reference the server cannot resolve */ }
    this.spotCache.set(refrId, spot);
    return spot;
  }

  // ── Posting ─────────────────────────────────────────────────────────────────

  private onPost(ctx: SystemContext, userId: number, content: Content): void {
    const now = Date.now();
    if (now - (this.lastPostMs.get(userId) || 0) < POST_COOLDOWN_MS) {
      this.notice(ctx, userId, "The pin is still warm; give it a moment.");
      return;
    }
    this.lastPostMs.set(userId, now);

    const session = this.sessions.get(userId);
    if (!session || String(content["board"]) !== session.zoneId) return;
    const zone = this.zones.byId(session.zoneId);
    if (!zone) return;
    const actorId = this.actorOf(ctx, userId);
    if (!actorId) return;
    if (!this.withinReach(ctx, actorId, session.refr)) {
      this.notice(ctx, userId, "You are too far from the board.");
      return;
    }
    const tab = content["tab"];
    if (!isTab(tab)) return;
    const tabDef = TABS.find((t) => t.id === tab)!;
    const profileId = this.profileIdOf(ctx, actorId);
    const official = this.rankIn(ctx, actorId, zone);
    const admin = this.isAdmin(ctx, actorId);
    if (tabDef.official && !official && !admin) {
      this.notice(ctx, userId, `Only the ${this.officialTitles(zone)} may post Hold Notices here.`);
      return;
    }

    const rawText = content["text"];
    if (typeof rawText !== "string") return;
    if (rawText.length > this.maxTextLen * 4) {
      this.notice(ctx, userId, `A notice holds ${this.maxTextLen} characters at most.`);
      return;
    }
    const text = this.sanitize(rawText);
    if (!text) return;
    if (text.length > this.maxTextLen) {
      this.notice(ctx, userId, `A notice holds ${this.maxTextLen} characters at most.`);
      return;
    }

    const rec = this.recordOf(session.zoneId);
    this.prune(session.zoneId, rec);
    if (rec.notes.length >= this.maxNotes) {
      this.notice(ctx, userId, "The board is full. Older notices must fade first.");
      return;
    }

    // Hold Notices are free; the fee for the others is taken only once everything else has passed.
    const cost = tabDef.official ? 0 : this.costGold;
    if (cost > 0 && !this.takeGold(ctx, actorId, cost)) {
      this.notice(ctx, userId, `Pinning a notice costs ${cost} gold, and you do not have it.`);
      return;
    }

    const author = this.displayNameOf(ctx, actorId) + (official ? `, ${this.zones.titleOf(official)}` : "");
    rec.notes.push({ id: rec.nextId, tab, author, profileId, text, createdAt: now });
    rec.nextId += 1;
    this.saveStore();

    this.appendLog(`${this.describeActor(ctx, actorId)} posted on the ${zone.name} board [${tabDef.label}]${cost ? ` (-${cost} gold)` : ""}: ${JSON.stringify(text)}`);
    this.notice(ctx, userId, "Your notice is pinned to the board.");
    this.refreshViewers(ctx, session.zoneId);
  }

  // Officials of the hold and admins take any notice down; a poster takes down their own.
  private onRemove(ctx: SystemContext, userId: number, content: Content): void {
    const session = this.sessions.get(userId);
    if (!session || String(content["board"]) !== session.zoneId) return;
    const zone = this.zones.byId(session.zoneId);
    if (!zone) return;
    const actorId = this.actorOf(ctx, userId);
    if (!actorId) return;
    const id = Number(content["id"]);
    const rec = this.recordOf(session.zoneId);
    const note = rec.notes.find((n) => n.id === id);
    if (!note) return;
    const profileId = this.profileIdOf(ctx, actorId);
    const allowed = note.profileId === profileId || this.isAdmin(ctx, actorId) || this.rankIn(ctx, actorId, zone) !== null;
    if (!allowed) {
      this.notice(ctx, userId, "That notice is not yours to take down.");
      return;
    }
    rec.notes = rec.notes.filter((n) => n.id !== id);
    this.saveStore();
    this.appendLog(`${this.describeActor(ctx, actorId)} took down note ${id} by [profile ${note.profileId}] ${JSON.stringify(note.author)} from the ${zone.name} board: ${JSON.stringify(note.text)}`);
    this.notice(ctx, userId, "The notice is taken down.");
    this.refreshViewers(ctx, session.zoneId);
  }

  // ── Menu ────────────────────────────────────────────────────────────────────

  private sendMenu(ctx: SystemContext, userId: number, reason: "open" | "refresh"): void {
    const session = this.sessions.get(userId);
    if (!session) return;
    const zone = this.zones.byId(session.zoneId);
    const actorId = this.actorOf(ctx, userId);
    if (!zone || !actorId) return;
    const rec = this.recordOf(session.zoneId);
    if (this.prune(session.zoneId, rec)) this.saveStore();
    const now = Date.now();
    const profileId = this.profileIdOf(ctx, actorId);
    const official = this.rankIn(ctx, actorId, zone) !== null;
    const admin = this.isAdmin(ctx, actorId);
    this.send(ctx, userId, {
      customPacketType: "bountyBoardMenu",
      board: session.zoneId,
      boardName: zone.name,
      reason,
      costGold: this.costGold,
      gold: this.goldOf(ctx, actorId),
      maxTextLen: this.maxTextLen,
      maxNotes: this.maxNotes,
      expiryDays: this.expiryDays,
      tabs: TABS.map((t) => ({ id: t.id, label: t.label, cost: t.official ? 0 : this.costGold, canPost: !t.official || official || admin })),
      notes: rec.notes.map((n) => ({
        id: n.id,
        tab: n.tab,
        author: n.author,
        text: n.text,
        ageHours: Math.max(0, Math.floor((now - n.createdAt) / 3600000)),
        canRemove: n.profileId === profileId || official || admin,
      })),
    });
  }

  // A new notice shows up for everyone standing at a board of that hold.
  private refreshViewers(ctx: SystemContext, zoneId: string): void {
    this.sessions.forEach((session, userId) => { if (session.zoneId === zoneId) this.sendMenu(ctx, userId, "refresh"); });
  }

  // ── Expiry ──────────────────────────────────────────────────────────────────

  private prune(zoneId: string, rec: BoardRecord): boolean {
    const cutoff = Date.now() - this.expiryDays * 24 * 3600000;
    const kept: BoardNote[] = [];
    let dropped = false;
    for (const note of rec.notes) {
      if (note.createdAt > cutoff) { kept.push(note); continue; }
      dropped = true;
      this.appendLog(`note ${note.id} by [profile ${note.profileId}] ${JSON.stringify(note.author)} faded from the ${zoneId} board: ${JSON.stringify(note.text)}`);
    }
    rec.notes = kept;
    return dropped;
  }

  // ── Officials and admins ────────────────────────────────────────────────────

  // officials.json first, then the backend faction rows "hold:<zone>:<rank>" on the actor.
  private rankIn(ctx: SystemContext, actorId: number, zone: Zone): string | null {
    const fromFile = this.zones.rankOf(this.profileIdOf(ctx, actorId), zone.id);
    if (fromFile) return fromFile;
    try {
      const access = (ctx.svr as Mp).get(actorId, "private.skympAccess");
      const rows = access && Array.isArray(access.factions) ? access.factions : [];
      for (const row of rows) {
        const parts = String(row?.requirementId || "").split(":");
        if (parts.length === 3 && parts[0] === "hold" && parts[1] === zone.id && zone.officials.indexOf(parts[2]) !== -1) return parts[2];
      }
    } catch { /* no access record */ }
    return null;
  }

  private officialTitles(zone: Zone): string {
    const titles = zone.officials.map((r) => this.zones.titleOf(r));
    return titles.length ? titles.join(", ") : "officials";
  }

  private isAdmin(ctx: SystemContext, actorId: number): boolean {
    try { return adminTierOf(ctx.svr as Mp, actorId, this.roleCfg) !== null; } catch { return false; }
  }

  // ── Gold ────────────────────────────────────────────────────────────────────

  private goldOf(ctx: SystemContext, actorId: number): number {
    const mp = ctx.svr as Mp;
    let total = 0;
    try {
      const inv = mp.get(actorId, "inventory");
      const entries = inv && Array.isArray(inv.entries) ? inv.entries : [];
      for (const e of entries) if ((Number(e?.baseId) >>> 0) === GOLD_BASE_ID) total += Number(e?.count) || 0;
    } catch { /* actor gone */ }
    return total;
  }

  // False when the actor cannot pay; nothing is taken then.
  private takeGold(ctx: SystemContext, actorId: number, amount: number): boolean {
    const mp = ctx.svr as Mp;
    try {
      const inv = mp.get(actorId, "inventory");
      const entries = inv && Array.isArray(inv.entries) ? inv.entries.slice() : [];
      let held = 0;
      for (const e of entries) if ((Number(e?.baseId) >>> 0) === GOLD_BASE_ID) held += Number(e?.count) || 0;
      if (held < amount) return false;
      let remaining = amount;
      for (const e of entries) {
        if (remaining <= 0) break;
        if ((Number(e?.baseId) >>> 0) !== GOLD_BASE_ID) continue;
        const take = Math.min(Number(e.count) || 0, remaining);
        e.count -= take;
        remaining -= take;
      }
      if (remaining > 0) return false;
      mp.set(actorId, "inventory", { entries: entries.filter((e: any) => (Number(e?.count) || 0) > 0) });
      return true;
    } catch (e) {
      this.log(`[board] could not take gold from ${actorId.toString(16)}: ${e}`);
      return false;
    }
  }

  // ── Board resolution ────────────────────────────────────────────────────────

  // A placed ref with a board base belongs to the zone its position falls in.
  private zoneOfBoard(ctx: SystemContext, refrId: number): Zone | null {
    if (!this.boardBaseIds.size || !refrId) return null;
    const known = this.knownBoards.get(refrId);
    if (known) return this.zones.byId(known);
    if (!this.boardBaseIds.has(this.baseIdOf(ctx, refrId))) return null;
    const spot = this.boardSpot(ctx, refrId);
    const zone = spot ? this.zones.zoneAt(spot.where, spot.pos) : null;
    if (!zone) {
      this.log(`[board] board ${refrId.toString(16)} at ${spot ? spot.where : "?"} ${spot ? JSON.stringify(spot.pos) : ""} is outside every zone`);
      return null;
    }
    this.knownBoards.set(refrId, zone.id);
    return zone;
  }

  // The base object behind a placed reference, from the ESM's NAME field.
  private baseIdOf(ctx: SystemContext, refrId: number): number {
    const cached = this.baseIdCache.get(refrId);
    if (cached !== undefined) return cached;
    const baseId = espmRefrFieldId(ctx.svr as Mp, refrId, "NAME");
    if (this.baseIdCache.size >= MAX_ESPM_CACHE) this.baseIdCache.clear();
    this.baseIdCache.set(refrId, baseId);
    return baseId;
  }

  // Posting has to happen at the board, not from a zone id typed into a packet.
  private withinReach(ctx: SystemContext, actorId: number, refrId: number): boolean {
    const mp = ctx.svr as Mp;
    let a: any, b: any;
    try { a = mp.get(actorId, "pos"); b = mp.get(refrId, "pos"); } catch { return true; }
    if (!Array.isArray(a) || !Array.isArray(b)) return true;
    const dx = Number(a[0]) - Number(b[0]);
    const dy = Number(a[1]) - Number(b[1]);
    const dz = Number(a[2]) - Number(b[2]);
    const d2 = dx * dx + dy * dy + dz * dz;
    if (!Number.isFinite(d2)) return true;
    return d2 <= this.maxDistance * this.maxDistance;
  }

  // ── Storage ─────────────────────────────────────────────────────────────────

  private recordOf(zoneId: string): BoardRecord {
    if (!this.store[zoneId]) this.store[zoneId] = emptyRecord();
    return this.store[zoneId];
  }

  // Re-validates and re-bounds everything: a file edited by hand must not wedge the board.
  private loadStore(): void {
    this.store = {};
    let raw: any = null;
    try { raw = JSON.parse(fs.readFileSync(this.storePath, "utf8")); } catch { return; }
    const zones = raw && typeof raw === "object" && raw.zones && typeof raw.zones === "object" ? raw.zones : {};
    const now = Date.now();
    for (const zoneId of Object.keys(zones)) {
      const r = zones[zoneId];
      if (!r || typeof r !== "object") continue;
      const notes: BoardNote[] = [];
      for (const n of Array.isArray(r.notes) ? r.notes : []) {
        if (notes.length >= this.maxNotes) break;
        if (!n || typeof n !== "object") continue;
        const text = typeof n.text === "string" ? n.text.slice(0, this.maxTextLen) : "";
        if (!text) continue;
        notes.push({
          id: Number(n.id) || 0,
          tab: isTab(n.tab) ? n.tab : "citizen",
          author: typeof n.author === "string" ? n.author.slice(0, 100) : "Unknown",
          profileId: Number.isFinite(Number(n.profileId)) ? Number(n.profileId) : -1,
          text,
          createdAt: Math.min(Number(n.createdAt) || 0, now),
        });
      }
      this.store[zoneId] = { nextId: Math.max(1, Number(r.nextId) || 1), notes };
    }
    this.log(`[board] ${Object.keys(this.store).length} board(s) loaded from ${this.storePath}`);
  }

  private saveStore(): void {
    if (!this.storePath) return;
    const tmp = this.storePath + ".tmp";
    try {
      fs.writeFileSync(tmp, JSON.stringify({ _comment: "Notice board posts per zone (zones.json ids). Written by the server; edit only while it is stopped.", zones: this.store }, null, 1));
      fs.renameSync(tmp, this.storePath);
    } catch (e) { this.log(`[board] save failed: ${e}`); }
  }

  // ── Names and audit ─────────────────────────────────────────────────────────

  // "Ysolda #K7Q2": the name others see plus the character tag the gamemode assigns.
  private displayNameOf(ctx: SystemContext, actorId: number): string {
    const mp = ctx.svr as Mp;
    let name = "Unknown";
    try { name = String(mp.getActorName(actorId) || "Unknown"); } catch { /* keep */ }
    let tag = "";
    try { const t = mp.get(actorId, "private.charTag"); if (typeof t === "string" && t.length === 4) tag = t; } catch { /* untagged */ }
    return tag ? `${name} #${tag}` : name;
  }

  private realNameOf(ctx: SystemContext, actorId: number): string {
    let stashed = "";
    try { stashed = String((ctx.svr as Mp).get(actorId, "maskName") || "").trim(); } catch { /* unmasked */ }
    return stashed || this.displayNameOf(ctx, actorId);
  }

  private profileIdOf(ctx: SystemContext, actorId: number): number {
    try {
      const profileId = Number((ctx.svr as Mp).get(actorId, "profileId"));
      return Number.isFinite(profileId) ? profileId : -1;
    } catch { return -1; }
  }

  private describeActor(ctx: SystemContext, actorId: number): string {
    const real = this.realNameOf(ctx, actorId);
    const shown = this.displayNameOf(ctx, actorId);
    const mask = shown !== real ? ` (as ${JSON.stringify(shown)})` : "";
    return `[profile ${this.profileIdOf(ctx, actorId)}] ${JSON.stringify(real)}${mask}`;
  }

  private appendLog(text: string): void {
    try { fs.appendFile(path.join(this.logDir, "bounty.log"), new Date().toISOString() + " " + text + "\n", () => { }); } catch { /* log only */ }
    // The gamemode forwards this to the Discord audit channel when it has a webhook.
    try { (globalThis as any).__alduinakBoardLog?.(text); } catch { /* log only */ }
  }

  // Keeps line breaks, drops every other control character.
  private sanitize(raw: unknown): string {
    if (typeof raw !== "string") return "";
    let out = "";
    for (const ch of raw) {
      const code = ch.charCodeAt(0);
      if (ch === "\n") { out += ch; continue; }
      if (code < 0x20 || code === 0x7f) continue;
      out += ch;
    }
    return out.replace(/\n{3,}/g, "\n\n").trim();
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private actorOf(ctx: SystemContext, userId: number): number {
    if (userId < 0) return 0;
    try { return (ctx.svr as Mp).getUserActor(userId) >>> 0; } catch { return 0; }
  }

  private userOf(ctx: SystemContext, actorId: number): number {
    try {
      const userId = (ctx.svr as Mp).getUserByActor(actorId);
      return userId === INVALID_USER_ID ? -1 : userId;
    } catch { return -1; }
  }

  private send(ctx: SystemContext, userId: number, payload: Record<string, unknown>): void {
    if (userId < 0) return;
    try { (ctx.svr as Mp).sendCustomPacket(userId, JSON.stringify(payload)); } catch { /* user gone */ }
  }

  private notice(ctx: SystemContext, userId: number, text: string): void {
    this.send(ctx, userId, { customPacketType: "bountyBoardNotice", text });
  }

  private costGold = DEFAULT_COST_GOLD;
  private expiryDays = DEFAULT_EXPIRY_DAYS;
  private maxNotes = DEFAULT_MAX_NOTES;
  private maxTextLen = DEFAULT_MAX_TEXT_LEN;
  private maxDistance = DEFAULT_MAX_DISTANCE;
  private logDir = "C:\\logs";
  private storePath = "";
  private store: Record<string, BoardRecord> = {};
  private zones!: Zones;
  private roleCfg!: AdminRoleConfig;
  private boardBaseIds = new Set<number>();
  private knownBoards = new Map<number, string>();
  private baseIdCache = new Map<number, number>();
  private sessions = new Map<number, BoardSession>();
  private lastPostMs = new Map<number, number>();
  private lastOpenMs = new Map<number, number>();
  private spotCache = new Map<number, { pos: number[]; where: string } | null>();
  private lastSweepMs = 0;
}
