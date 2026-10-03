import * as fs from "fs";
import { Settings } from "../settings";
import { System, Log, SystemContext, Content } from "./system";
import { espmRefrFieldId, toFormId } from "./formIdUtil";
import { AdminRoleConfig, readAdminRoleConfig, adminTierOf, TIER_CAPS } from "./adminRoles";
import { getZones, Zones } from "./zones";
import { PlaceClaim, PlannedPlace, planPlaces } from "./housingPlaces";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// ── Housing: claims, locks and keys ───────────────────────────────────────────
//
// Property is granted: a hold official (MANAGER_RANKS) or an admin claims an unowned
// door or container from the housing key and hands it to a player, unless
// `housingOpenClaims` is true, when anyone may claim. Owners lock it, name it, cut
// keys, hand ownership over, or give it up. A locked property refuses activation for everyone, owner included,
// until someone with access (owner, hold official, admin or key holder) unlocks
// it from the menu; RefDecorService mirrors the lock into the engine as a Master
// lock so every player sees a locked door.
//
// Wire protocol - every message is a CustomPacket carrying JSON:
//   Client -> Server:
//     { customPacketType: "propertyInfoRequest", target: <refrId> }
//     { customPacketType: "propertyRequest", action, target, recipient?, name? }
//       action: claim | abandon | lock | unlock | rename | transfer
//             | revoke | createkey | revokekeys | grantcontainer
//   Server -> Client:
//     { customPacketType: "propertyMenu", target, view, owned, name, locked,
//       hasKeys, canGrantContainers, ownerName }
//     { customPacketType: "propertyNotice", text }
//     { customPacketType: "refDecor", full?, refs: [{refId,name,locked}] }
//
// Persistence. The record lives on the reference itself as a `private.` dynamic
// field, so it rides the engine's changeform into MongoDB and comes back on
// restart (lazily, the first time the ref is touched). `housing.json` is only an
// index of claimed ids so a boot pass knows which refs to touch; the changeform
// stays the source of truth. Giving a property up leaves an ownerless stub
// behind rather than deleting the record, so the key serial survives and a
// re-claim cannot mint a credential that old copies already answer to.
//
// Teleport doors are claimed as a pair. The record lives on the lower of the two
// form ids (the "primary"); the far side stores a pointer to it, so locking a
// house from the inside locks the outside too.

const HOUSING_PROP = "private.housing";
// N3 places: the migration plan written by the dry run, for review (runtime, beside housing.json)
const PLACE_PLAN_FILE = "./housing-places-plan.json";
const PLACE_BACKUP_PREFIX = "./housing-places-backup-";
const GAMEMODE_CONFIG_FILE = "./gamemode-config.json";
const PLACE_PLAN_DELAY_MS = 30000;
const PLACE_PLAN_MAX_TRIES = 10;
const OWNER_INDEX_PROP = "private.indexed.housingOwner";
const REGISTRY_FILE = "./housing.json";

// Vanilla key form; the name extra carries the credential.
export const KEY_BASE_ID = 0x000db0e2;

const MAX_USER_SLOTS = 1024;
const MAX_NAME_LEN = 32;
const MAX_KEYS_CARRIED = 64;
const MAX_ESPM_CACHE = 4096;
const DEFAULT_MAX_CLAIMS = 8;
const DEFAULT_MAX_DISTANCE = 512;
const DECOR_PUSH_INTERVAL_MS = 4000;
const REQUEST_COOLDOWN_MS = 500;
const CHANGE_FAILED = "That cannot be changed right now.";
const NOT_GRANTED = "Property here is granted by its ruler (Jarl, Baron or Count) or their Steward.";

// Ranks that manage property in their own zone: the Jarl (or Baron) and Steward of a hold, the
// Chieftain and Bane of a sovereign stronghold (zones.json). A stronghold's radius wins
// over the surrounding hold, so hold officials have no say inside it and vice versa.
// Managers claim, revoke, rename, transfer, re-key and cut keys for any property there.
// The Count of Bruma (zones.json region "bruma") manages property the way a Jarl does.
const MANAGER_RANKS = ["jarl", "baron", "steward", "chieftain", "bane", "count"];
// Actions on any door or chest of a place that act on the whole place (its root)
const PLACE_WIDE = ["abandon", "revoke", "rename", "createkey", "revokekeys", "transfer", "assign", "unassign", "share", "unshare"];
// The owner's Rooms and chests panel lists at most this many of a place's inner doors and chests
const MAX_ROOMS_LISTED = 48;
// A place's cells: the interior behind its door and the rooms reachable only through it, at most this many
const MAX_PLACE_CELLS = 4;
// Housing actions whose use by staff on someone else's property is logged
const STAFF_LOGGED = ["claim", "abandon", "revoke", "lock", "unlock", "rename", "createkey", "revokekeys", "transfer", "grantcontainer"];

// Interior cells that belong to a hold, kept as a fallback for interiors whose exterior
// door the server cannot place (old HoldClaims table, slugs mapped to zones.json ids).
const HOLD_CELLS: Record<number, string> = {
  0x000165a8: "whiterun",   // Breezehome
  0x0001b131: "whiterun",   // Dragonsreach Dungeon
  0x0003480e: "windhelm",   // Hjerim
  0x000d7b12: "windhelm",   // Windhelm Barracks
  0x000c9f1a: "riften",     // Honeyside
  0x0008bfe6: "riften",     // Riften Jail
  0x00017013: "markarth",   // Vlindrel Hall
  0x00018b22: "markarth",   // Hall of Justice
  0x000165a0: "solitude",   // Proudspire Manor
  0x000136c9: "solitude",   // Castle Dour Dungeon
  0x0301ab54: "dawnstar",   // Heljarchen Hall
  0x0001620b: "dawnstar",   // Dawnstar jail
  0x0300307b: "falkreath",  // Lakeview Manor
  0x000fa3d9: "falkreath",  // Falkreath jail
  0x0300307e: "morthal",    // Windstad Manor
  0x00038a92: "morthal",    // Morthal jail
  0x0001e7e0: "winterhold", // College quarters
  0x0001e7e2: "winterhold", // Winterhold jail
};

// One claimed property. Stored on the primary reference. owner 0 is an
// ownerless stub kept only to carry `serial` forward.
interface PropertyRecord {
  owner: number;
  ownerName: string;
  name: string | null;
  locked: boolean;
  serial: number;
  partner: number;
  containers: number[];
  // Key names cut at the current serial; null on records older than this field
  issued: string[] | null;
  // A place (N3): the interior cells behind this exterior door, its per-ref assignments and kept key credentials.
  // Written by the migration and the place rules only with housingPlaceMigration "apply"; always read back as they are, so
  // a write under any mode keeps them.
  place?: { cells: string[]; builtAt: number };
  assigned?: Record<string, { profile: number; name: string }>;
  // Refs (hex primaries) in the place whose chest the household may open: anyone who may open the place itself
  shared?: string[];
  keyAliases?: string[];
  // On a member of a place: the place's root; on an unlocked chest inside a house, kept for its owner and assignees
  memberOf?: number;
  ownerOnly?: boolean;
}

// The far half of a teleport pair just points at the primary.
interface PrimaryPointer {
  primary: number;
}

// Everything an access decision needs about one actor.
interface ViewerAccess {
  profileId: number;
  admin: boolean;
  ranks: Array<{ hold: string; rank: string }>;
  keys: Set<string>;
}

const emptyRecord = (): PropertyRecord => ({
  owner: 0, ownerName: "", name: null, locked: false,
  serial: 1, partner: 0, containers: [], issued: [],
});

// Oldest issued key names drop off (and stop opening) past this
const MAX_ISSUED_KEY_NAMES = 16;

export class HousingSystem implements System {
  systemName = "HousingSystem";

  constructor(private log: Log) { }

  async initAsync(ctx: SystemContext): Promise<void> {
    const s = await Settings.get();
    const all = s.allSettings as Record<string, unknown> | null;

    const placeCap = Number(all?.["housingPlaceCap"]);
    if (Number.isFinite(placeCap) && placeCap >= 1) this.placeCap = Math.floor(placeCap);
    const maxClaims = Number(all?.["housingMaxClaims"]);
    if (Number.isFinite(maxClaims) && maxClaims > 0) this.maxClaims = maxClaims;
    const maxDistance = Number(all?.["housingMaxDistance"]);
    if (Number.isFinite(maxDistance) && maxDistance > 0) this.maxDistance = maxDistance;
    this.openClaims = all?.["housingOpenClaims"] === true;
    // N3 places: "dryrun" (the default) logs and writes the migration plan once after boot and changes nothing; "off" skips it
    // "apply" (set by Nate) also writes the plan into the records, once, after a backup
    const mode = String(all?.["housingPlaceMigration"] ?? "dryrun");
    this.staffSetting = Array.isArray(all?.["housingStaffProfiles"]) ? (all!["housingStaffProfiles"] as unknown[]).map(Number).filter((p) => p > 0) : [];
    this.placeMigration = mode === "off" ? "off" : mode === "apply" ? "apply" : "dryrun";
    this.initAtMs = Date.now();

    this.roleCfg = readAdminRoleConfig(all);
    this.zones = getZones(this.log);

    this.claimed = this.loadRegistry();
    this.installActivationHook(ctx);
    ctx.gm.on("userAssignActor", (userId: number) => this.onActorAssigned(ctx, userId));
    this.exposeTenancy(ctx);
    this.log(`[housing] ready, ${this.claimed.length} claimed refs in the registry`);
  }

  // server/tenancy.js rents property out through these, under the same rules as the menu: the claim limit, re-keying
  // on a new owner, and the hold's managers. grant returns an error text, or "" when the property is theirs.
  private exposeTenancy(ctx: SystemContext): void {
    // With the place rules on, any door or chest of a place stands for the whole place (a listing at its back door rents
    // the house, not that door)
    const primary = (ref: unknown) => {
      const p = this.primaryOf(ctx, Number(ref) >>> 0);
      if (!p || !this.placesOn()) return p;
      const r = this.read(ctx, p);
      return r && r.owner !== 0 && r.memberOf && r.memberOf !== p ? r.memberOf : p;
    };
    (globalThis as any).__dboHousing = {
      primaryOf: (ref: unknown) => primary(ref),
      recordOf: (ref: unknown) => { const p = primary(ref); return p ? this.read(ctx, p) : null; },
      holdOf: (ref: unknown) => { const p = primary(ref); return p ? this.holdOf(ctx, p) : ""; },
      // What a load door's prompt should call it, or "" to keep the destination's name (gamemode.js dboDoorName)
      doorName: (ref: unknown): string => { try { return this.doorName(ctx, Number(ref) >>> 0); } catch { return ""; } },
      isManager: (actorId: unknown, ref: unknown) => { const p = primary(ref); return !!p && this.isManager(ctx, Number(actorId) >>> 0, p); },
      grant: (ref: unknown, actorId: unknown): string => {
        const p = primary(ref); if (!p) return "That is not a property.";
        const actor = Number(actorId) >>> 0;
        const profileId = this.profileOf(ctx, actor); if (!profileId) return "That is nobody.";
        const rec = this.read(ctx, p) || emptyRecord();
        if (rec.owner === profileId) return "";
        const full = this.overCap(ctx, profileId, actor, false);
        if (full) return full;
        if (rec.owner !== 0) this.reKey(ctx, p, rec);
        rec.owner = profileId;
        rec.ownerName = this.nameOf(ctx, actor);
        rec.partner = this.partnerOf(ctx, p);
        if (rec.issued === null) rec.issued = [];
        if (!this.write(ctx, p, rec)) return CHANGE_FAILED;
        if (rec.place) this.carryPlace(ctx, p, rec); else this.ensurePlace(ctx, p, rec);
        return "";
      },
      release: (ref: unknown): boolean => {
        const p = primary(ref); if (!p) return false;
        const rec = this.read(ctx, p); if (!rec || rec.owner === 0) return true;
        return this.release(ctx, p, rec);
      },
    };
  }

  // Locks are enforced here: a refused activation never reaches the door.
  private installActivationHook(ctx: SystemContext): void {
    const mp = ctx.svr as Mp;
    const previous = typeof mp.onActivate === "function" ? mp.onActivate : null;
    mp.onActivate = (targetId: number, casterId: number): boolean => {
      let allowed = true;
      try {
        allowed = this.onActivate(ctx, targetId >>> 0, casterId >>> 0);
      } catch (e) {
        this.log(`[housing] activation check failed: ${e}`);
      }
      if (!allowed) return false;
      // Chain, so another handler still gets its say.
      if (!previous) return true;
      try {
        return previous.call(mp, targetId, casterId) !== false;
      } catch {
        return true;
      }
    };
  }

  // Locked means locked for everyone; access only lets a player unlock it from the menu
  private onActivate(ctx: SystemContext, targetId: number, casterId: number): boolean {
    const primary = this.primaryOf(ctx, targetId);
    if (!primary) return true;
    const rec = this.read(ctx, primary);
    // Inside a place (N3, only with housingPlaceMigration "apply"): a door or chest nobody has claimed answers to the place's
    // owner, whoever it is assigned to and the managers; a chest is the owner's alone unless it is shared (Nate, 3 Oct)
    if ((!rec || rec.owner === 0) && this.placesOn()) {
      const place = this.placeAt(ctx, targetId);
      if (!place || this.placeRefAccess(ctx, place.root, place.rec, primary, this.viewerAccess(ctx, casterId))) return true;
      this.denyInPlace(ctx, casterId, place.rec);
      return false;
    }
    if (!rec || rec.owner === 0) return true;
    // A chest that is part of a place opens only for its owner, its assignee and the managers, or the household when shared
    if (!rec.locked && this.placesOn() && this.isPlaceContainer(ctx, primary, rec)) {
      if (this.hasAccess(ctx, primary, rec, casterId)) return true;
      const root = rec.memberOf ? this.read(ctx, rec.memberOf) : null;
      this.denyInPlace(ctx, casterId, root || rec);
      return false;
    }
    if (!rec.locked) return true;

    // One notice per player per second; a held activate key fires repeatedly.
    const userId = this.userOf(ctx, casterId);
    const now = Date.now();
    if (now - (this.lastDenyMs.get(userId) || 0) > 1000) {
      this.lastDenyMs.set(userId, now);
      const label = rec.name || "This";
      this.notice(ctx, userId, this.hasAccess(ctx, primary, rec, casterId)
        ? `${label} is locked. Unlock it from the housing menu.`
        : `${label} is locked.`);
    }
    return false;
  }

  customPacket(userId: number, type: string, content: Content, ctx: SystemContext): void {
    switch (type) {
      case "propertyInfoRequest": this.onInfoRequest(ctx, userId, content); break;
      case "propertyRequest": this.onPropertyRequest(ctx, userId, content); break;
      default: break;
    }
  }

  async updateAsync(ctx: SystemContext): Promise<void> {
    const now = Date.now();
    // Records read as null on the first ticks after boot, so the plan waits, and tries again while nothing is readable
    if (this.placeMigration !== "off" && !this.placePlanDone && now - this.initAtMs >= PLACE_PLAN_DELAY_MS && now - this.placePlanTriedMs >= PLACE_PLAN_DELAY_MS) {
      this.placePlanTriedMs = now;
      try { this.placePlanDone = this.dryRunPlaces(ctx) || ++this.placePlanTries >= PLACE_PLAN_MAX_TRIES; } catch (e) { this.placePlanDone = true; this.log(`[housing] place plan failed: ${e}`); }
    }
    if (now - this.lastDecorMs < DECOR_PUSH_INTERVAL_MS) return;
    this.lastDecorMs = now;
    if (!this.decorDirty) return;
    this.decorDirty = false;
    this.pushDecorToAll(ctx);
  }

  // A fresh actor needs the full picture: names and locks for every claim.
  private onActorAssigned(ctx: SystemContext, userId: number): void {
    this.pushDecor(ctx, userId);
  }

  // ── Requests ────────────────────────────────────────────────────────────────

  private onInfoRequest(ctx: SystemContext, userId: number, content: Content): void {
    const target = toFormId(content["target"]);
    if (!target) return;
    const actorId = this.actorOf(ctx, userId);
    if (!actorId) return;
    if (!this.withinReach(ctx, actorId, target)) {
      this.notice(ctx, userId, "That is too far away.");
      return;
    }
    this.sendMenu(ctx, userId, actorId, target);
  }

  private onPropertyRequest(ctx: SystemContext, userId: number, content: Content): void {
    const target = toFormId(content["target"]);
    const action = String(content["action"] || "");
    if (!target || !action) return;

    const now = Date.now();
    if (now - (this.lastRequestMs.get(userId) || 0) < REQUEST_COOLDOWN_MS) return;
    this.lastRequestMs.set(userId, now);

    const actorId = this.actorOf(ctx, userId);
    if (!actorId) return;
    // Inside a place, anywhere in its cells is near enough to manage it (a fort's rooms are far from its door)
    if (!this.nearProperty(ctx, actorId, target) && !(this.placesOn() && this.standsInPlaceOf(ctx, actorId, target))) {
      this.notice(ctx, userId, "That is too far away.");
      return;
    }

    let primary = this.primaryOf(ctx, target);
    if (!primary) {
      this.notice(ctx, userId, "You cannot claim that.");
      return;
    }
    let rec = this.read(ctx, primary) || emptyRecord();
    // A whole place counts as one property (Nate, 3 Oct): handing over, giving up, naming and keys go to its root from any
    // of its doors or chests
    if (this.placesOn() && rec.memberOf && rec.memberOf !== primary && PLACE_WIDE.indexOf(action) !== -1) {
      const root = this.read(ctx, rec.memberOf);
      if (root && root.owner !== 0) { primary = rec.memberOf; rec = root; }
    }
    const isOwner = rec.owner !== 0 && rec.owner === this.profileOf(ctx, actorId);
    const isManager = this.isManager(ctx, actorId, primary);
    // Every staff override of someone else's property goes to the admin log (review A3-1)
    if (!isOwner && rec.owner !== 0 && isManager && !this.isHoldManager(ctx, actorId, primary) && STAFF_LOGGED.indexOf(String(action)) !== -1) {
      try { (globalThis as any).__alduinakAdminLog?.(`HOUSING staff override: actor ${actorId.toString(16)} (profile ${this.profileOf(ctx, actorId)}) ${action} on ${primary.toString(16)}, owner profile ${rec.owner}`); } catch { /* no log */ }
    }

    switch (action) {
      case "claim": this.doClaim(ctx, userId, actorId, primary, rec, isManager); break;
      case "abandon": this.doAbandon(ctx, userId, actorId, primary, rec, isOwner, isManager); break;
      case "revoke": this.doRevoke(ctx, userId, actorId, primary, rec, isManager); break;
      case "lock": this.doLock(ctx, userId, actorId, primary, rec, true); break;
      case "unlock": this.doLock(ctx, userId, actorId, primary, rec, false); break;
      case "rename": this.doRename(ctx, userId, primary, rec, isOwner, isManager, content["name"]); break;
      case "createkey": this.doCreateKey(ctx, userId, actorId, primary, rec, isOwner || isManager); break;
      case "revokekeys": this.doRevokeKeys(ctx, userId, primary, rec, isOwner, isManager); break;
      case "transfer": this.doTransfer(ctx, userId, primary, rec, isOwner, isManager, content["recipient"]); break;
      case "grantcontainer": this.doGrantContainer(ctx, userId, primary, rec, isOwner, isManager, content["recipient"]); break;
      case "assign":
      case "unassign":
      case "share":
      case "unshare": this.doRoom(ctx, userId, actorId, primary, rec, isOwner || isManager, action, content["ref"], content["recipient"]); break;
      default: break;
    }
  }

  private doClaim(ctx: SystemContext, userId: number, actorId: number, primary: number, rec: PropertyRecord, isManager: boolean): void {
    if (rec.owner !== 0) {
      this.notice(ctx, userId, "Somebody already owns this.");
      return;
    }
    if (!isManager && !this.openClaims) {
      this.notice(ctx, userId, NOT_GRANTED);
      return;
    }
    const profileId = this.profileOf(ctx, actorId);
    if (!profileId) {
      this.notice(ctx, userId, "You cannot claim anything right now.");
      return;
    }
    // A door or chest inside someone's place is theirs already, to assign (Nate, 3 Oct: no per-door claims)
    const inside = this.placesOn() ? (this.placeAt(ctx, primary) || (rec.partner || this.partnerOf(ctx, primary) ? this.placeAt(ctx, rec.partner || this.partnerOf(ctx, primary)) : null)) : null;
    if (inside) {
      this.notice(ctx, userId, `This is part of ${inside.rec.name || "someone's property"}; its owner assigns it from the property menu.`);
      return;
    }
    // Officials claim to hand the property on, so the cap is the recipient's, checked at the hand-over
    const full = this.placesOn() && isManager ? "" : this.overCap(ctx, profileId, actorId, true);
    if (full) {
      this.notice(ctx, userId, full);
      return;
    }
    rec.owner = profileId;
    rec.ownerName = this.nameOf(ctx, actorId);
    rec.partner = this.partnerOf(ctx, primary);
    // A stub released before rec.issued existed has no keys at this serial
    if (rec.issued === null) rec.issued = [];
    if (!this.commit(ctx, userId, primary, rec)) return;
    this.ensurePlace(ctx, primary, rec);
    this.notice(ctx, userId, rec.place ? `This is yours now, with everything behind its door${rec.place.cells.length > 1 ? "s" : ""}.` : "This is yours now.");
    this.sendMenu(ctx, userId, actorId, primary);
  }

  private doAbandon(ctx: SystemContext, userId: number, actorId: number, primary: number, rec: PropertyRecord, isOwner: boolean, isManager: boolean): void {
    if (!isOwner && !isManager) {
      this.notice(ctx, userId, "This is not yours to give up.");
      return;
    }
    if (!this.release(ctx, primary, rec)) {
      this.notice(ctx, userId, CHANGE_FAILED);
      return;
    }
    this.notice(ctx, userId, "Given up.");
    this.sendMenu(ctx, userId, actorId, primary);
  }

  private doRevoke(ctx: SystemContext, userId: number, actorId: number, primary: number, rec: PropertyRecord, isManager: boolean): void {
    if (!isManager) {
      this.notice(ctx, userId, "You cannot revoke this.");
      return;
    }
    if (rec.owner === 0) {
      this.notice(ctx, userId, "Nobody owns this.");
      return;
    }
    const formerName = rec.ownerName || "the owner";
    if (!this.release(ctx, primary, rec)) {
      this.notice(ctx, userId, CHANGE_FAILED);
      return;
    }
    this.notice(ctx, userId, `Taken back from ${formerName}.`);
    this.sendMenu(ctx, userId, actorId, primary);
  }

  private doLock(ctx: SystemContext, userId: number, actorId: number, primary: number, rec: PropertyRecord, locked: boolean): void {
    if (rec.owner === 0) {
      this.notice(ctx, userId, "Claim it first.");
      return;
    }
    if (!this.hasAccess(ctx, primary, rec, actorId)) {
      this.notice(ctx, userId, "You have no key to this.");
      return;
    }
    rec.locked = locked;
    if (!this.commit(ctx, userId, primary, rec)) return;
    // Every door of a place locks with any one of them; its chests keep their own locks
    const doors = this.placesOn() && rec.partner ? this.placeDoorsWith(ctx, primary, rec) : [];
    for (const d of doors) { d.rec.locked = locked; this.write(ctx, d.ref, d.rec); }
    this.notice(ctx, userId, doors.length ? (locked ? `Locked, with every door of the place.` : `Unlocked, with every door of the place.`) : (locked ? "Locked." : "Unlocked."));
    this.sendMenu(ctx, userId, actorId, primary);
  }

  private doRename(ctx: SystemContext, userId: number, primary: number, rec: PropertyRecord, isOwner: boolean, isManager: boolean, raw: unknown): void {
    if (!isOwner && !isManager) {
      this.notice(ctx, userId, "This is not yours to name.");
      return;
    }
    const name = this.cleanName(raw);
    if (!name) {
      this.notice(ctx, userId, "That name will not do.");
      return;
    }
    // Keys already cut stay in rec.issued, so a rename keeps them working
    this.freezeKeyNames(ctx, primary, rec);
    const hadKeys = !!(rec.issued && rec.issued.length);
    rec.name = name;
    if (!this.commit(ctx, userId, primary, rec)) return;
    const doors = rec.place ? this.membersOf(ctx, primary).filter((m) => !!m.rec.partner).length + 1 : 0;
    this.notice(ctx, userId, (hadKeys
      ? `Now called ${name}. Keys already cut still open it; new ones will carry the new name.`
      : `Now called ${name}.`) + (doors > 1 ? ` All ${doors} of its doors show it.` : ""));
    const actorId = this.actorOf(ctx, userId);
    if (actorId) this.sendMenu(ctx, userId, actorId, primary);
  }

  // Keys are real inventory items; the name extra is the credential, so a key
  // handed over in trade works immediately and needs no server bookkeeping.
  private doCreateKey(ctx: SystemContext, userId: number, actorId: number, primary: number, rec: PropertyRecord, isOwner: boolean): void {
    if (!isOwner) {
      this.notice(ctx, userId, "Only the owner, the Jarl or the Steward cuts keys here.");
      return;
    }
    this.freezeKeyNames(ctx, primary, rec);
    const keyName = this.keyNameToCut(ctx, primary, rec);
    const issued = (rec.issued || []).filter((n) => n !== keyName);
    issued.push(keyName);
    rec.issued = issued.slice(-MAX_ISSUED_KEY_NAMES);
    // Recorded first, so a failed write never leaves a key nothing answers to
    if (!this.commit(ctx, userId, primary, rec)) return;
    if (!this.giveKey(ctx, actorId, keyName)) {
      this.notice(ctx, userId, "You are carrying too many keys.");
      return;
    }
    this.notice(ctx, userId, `${keyName} is in your pack.`);
    this.sendMenu(ctx, userId, actorId, primary);
  }

  private doRevokeKeys(ctx: SystemContext, userId: number, primary: number, rec: PropertyRecord, isOwner: boolean, isManager: boolean): void {
    if (!isOwner && !isManager) {
      this.notice(ctx, userId, "This is not yours to re-key.");
      return;
    }
    this.reKey(ctx, primary, rec);
    if (!this.commit(ctx, userId, primary, rec)) return;
    this.notice(ctx, userId, "Every key turned to scrap.");
    const actorId = this.actorOf(ctx, userId);
    if (actorId) this.sendMenu(ctx, userId, actorId, primary);
  }

  private doTransfer(ctx: SystemContext, userId: number, primary: number, rec: PropertyRecord, isOwner: boolean, isManager: boolean, rawRecipient: unknown): void {
    if (!isOwner && !isManager) {
      this.notice(ctx, userId, "This is not yours to hand over.");
      return;
    }
    const recipientActor = toFormId(rawRecipient);
    const recipientProfile = recipientActor ? this.profileOf(ctx, recipientActor) : 0;
    if (!recipientProfile) {
      this.notice(ctx, userId, "That is nobody.");
      return;
    }
    if (recipientProfile === rec.owner) {
      this.notice(ctx, userId, "They already own it.");
      return;
    }
    const full = this.overCap(ctx, recipientProfile, recipientActor, false);
    if (full) {
      this.notice(ctx, userId, full);
      return;
    }
    // Old keys must not open a new owner's door.
    this.reKey(ctx, primary, rec);
    rec.owner = recipientProfile;
    rec.ownerName = this.nameOf(ctx, recipientActor);
    rec.partner = this.partnerOf(ctx, primary);
    // A new owner's place: the old owner's assignments do not come with it
    if (rec.place) { delete rec.assigned; delete rec.shared; }
    if (!this.commit(ctx, userId, primary, rec)) return;
    if (rec.place) this.carryPlace(ctx, primary, rec); else this.ensurePlace(ctx, primary, rec);
    this.notice(ctx, userId, `Handed to ${rec.ownerName}.`);
    const recipientUser = this.userOf(ctx, recipientActor);
    this.notice(ctx, recipientUser, rec.name ? `${rec.name} is yours now.` : "You have been given a property.");
  }

  // The menu only offers this on a container, and a container's claim is just
  // its own record, so handing one over is exactly a transfer.
  private doGrantContainer(ctx: SystemContext, userId: number, primary: number, rec: PropertyRecord, isOwner: boolean, isManager: boolean, rawRecipient: unknown): void {
    if (this.baseTypeOf(ctx, primary) !== "CONT") {
      this.notice(ctx, userId, "That is not a container.");
      return;
    }
    if (this.placesOn() && (rec.memberOf || this.placeAt(ctx, primary))) {
      this.notice(ctx, userId, "This chest is part of a place: assign it from Rooms and chests instead.");
      return;
    }
    this.doTransfer(ctx, userId, primary, rec, isOwner, isManager, rawRecipient);
  }

  // ── Menu ────────────────────────────────────────────────────────────────────

  private sendMenu(ctx: SystemContext, userId: number, actorId: number, target: number): void {
    let primary = this.primaryOf(ctx, target);
    let rec = primary ? this.read(ctx, primary) : null;
    // A door or chest nobody claimed inside a place opens the place's own menu, with that one marked in its rooms
    let here = 0;
    if (this.placesOn() && (!rec || rec.owner === 0)) {
      const place = this.placeAt(ctx, target);
      if (place) { here = primary; primary = place.root; rec = place.rec; }
    }
    const owned = !!rec && rec.owner !== 0;
    const profileId = this.profileOf(ctx, actorId);
    const isOwner = owned && rec!.owner === profileId;
    const isManager = !!primary && this.isManager(ctx, actorId, primary);

    const holdsKey = owned && !isOwner && !isManager && this.hasAccess(ctx, primary, rec!, actorId);

    let view: string;
    if (isOwner) view = "owner";
    else if (isManager) view = "manager";
    else if (holdsKey) view = "keyholder";
    else if (primary && !owned && this.openClaims) view = "claimable";
    else view = "denied";

    this.send(ctx, userId, {
      customPacketType: "propertyMenu",
      target: primary || target,
      view,
      owned,
      name: rec ? rec.name : null,
      locked: owned && rec!.locked,
      hasKeys: owned,
      canGrantContainers: (isOwner || isManager) && owned && this.baseTypeOf(ctx, primary) === "CONT" && !(this.placesOn() && rec!.memberOf),
      ownerName: owned ? (rec!.ownerName || "Someone") : null,
      ...(owned && this.placesOn() ? this.placeMenu(ctx, primary, rec!, isOwner || isManager, profileId, here) : {}),
    });
  }

  // The place part of the menu (N3): for its owner and the managers, the Rooms and chests panel; for anyone else, whether
  // what they look at is assigned to them
  private placeMenu(ctx: SystemContext, primary: number, rec: PropertyRecord, manages: boolean, profileId: number, here: number): Record<string, unknown> {
    const root = rec.place ? primary : rec.memberOf || 0;
    if (!root) return {};
    const rootRec = root === primary ? rec : this.read(ctx, root);
    if (!rootRec || rootRec.owner === 0 || !rootRec.place) return {};
    const lookedAt = here || primary;
    const mine = rootRec.assigned && rootRec.assigned[lookedAt.toString(16)];
    if (!manages) return { place: null, placeName: rootRec.name, assignedToYou: !!mine && !!profileId && mine.profile === profileId };
    const rooms = this.roomsOf(ctx, root, rootRec);
    // What the owner looks at comes first
    rooms.sort((a, b) => (b.ref === lookedAt ? 1 : 0) - (a.ref === lookedAt ? 1 : 0));
    return {
      placeName: rootRec.name,
      place: { root, name: rootRec.name, here: lookedAt, rooms: rooms.slice(0, MAX_ROOMS_LISTED), more: Math.max(0, rooms.length - MAX_ROOMS_LISTED) },
    };
  }

  // A place's inner doors and chests, the ones its owner assigns: everything in its cells but the ways out to the world,
  // each door pair once. Another owner's own claim inside is shown as theirs and cannot be assigned.
  private roomsOf(ctx: SystemContext, root: number, rootRec: PropertyRecord): Array<Record<string, unknown> & { ref: number }> {
    const out: Array<Record<string, unknown> & { ref: number }> = [];
    const seen = new Set<number>();
    const cells = rootRec.place ? rootRec.place.cells : [];
    for (const cell of cells) {
      for (const ref of this.refsInCell(ctx, cell)) {
        const kind = this.baseTypeOf(ctx, ref) === "CONT" ? "chest" : "door";
        const far = kind === "door" ? this.partnerOf(ctx, ref) : 0;
        if (far && this.isWorldDesc(ctx, this.cellDescOf(ctx, far))) continue;
        const p = this.primaryOf(ctx, ref);
        if (!p || p === root || seen.has(p)) continue;
        seen.add(p);
        const own = this.read(ctx, p);
        const other = own && own.owner !== 0 && own.memberOf !== root ? (own.ownerName || "someone") : null;
        const hex = p.toString(16);
        const a = rootRec.assigned && rootRec.assigned[hex];
        out.push({ ref: p, label: this.labelOf(ctx, ref, kind, far), kind, assigned: a ? a.name : null, shared: (rootRec.shared || []).includes(hex), other });
      }
    }
    // Duplicate labels get a number, so "Chest" and "Chest 2" can be told apart
    const counts = new Map<string, number>();
    out.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "door" ? -1 : 1) || String(a.label).localeCompare(String(b.label)) || a.ref - b.ref);
    for (const r of out) { const n = (counts.get(String(r.label)) || 0) + 1; counts.set(String(r.label), n); if (n > 1) r.label = `${r.label} ${n}`; }
    return out;
  }

  // A ref's base name (the plugin's FULL, localized or not), else its editor id spelled out, else "Chest" / "Door"; a
  // door between two cells says where it goes
  private labelOf(ctx: SystemContext, refrId: number, kind: string, far: number): string {
    const mp = ctx.svr as Mp;
    let label = "";
    try {
      const baseId = espmRefrFieldId(mp, refrId, "NAME");
      if (baseId) {
        try { const t = typeof mp.getLocalizedString === "function" ? mp.getLocalizedString(baseId) : undefined; if (typeof t === "string") label = t.trim(); } catch { /* no strings */ }
        if (!label) {
          const r = mp.lookupEspmRecordById(baseId);
          const full = r && r.record && Array.isArray(r.record.fields) ? r.record.fields.find((f: any) => f && f.type === "FULL") : null;
          if (full && full.data && full.data.length !== 4) label = String.fromCharCode(...Array.from(full.data as ArrayLike<number>)).replace(/\0/g, "").trim();
          if (!label && r && r.record && r.record.editorId) label = String(r.record.editorId).replace(/[_\d]+$/, "").replace(/([a-z])([A-Z0-9])/g, "$1 $2").replace(/_/g, " ").trim();
        }
      }
    } catch { /* not an espm ref */ }
    label = label.replace(/[^\x20-\x7e]/g, "").slice(0, 40) || (kind === "chest" ? "Chest" : "Door");
    if (far) {
      let to = "";
      try { const cellId = mp.getIdFromDesc(this.cellDescOf(ctx, far)) >>> 0; const t = cellId && typeof mp.getLocalizedString === "function" ? mp.getLocalizedString(cellId) : undefined; if (typeof t === "string") to = t.trim(); } catch { /* unknown */ }
      if (to) label = `${label} to ${to.replace(/[^\x20-\x7e]/g, "").slice(0, 40)}`;
    }
    return label;
  }

  // Assigning the rooms and chests of a place (N3): its owner or a manager gives one to a person (it then opens for them,
  // the owner and the managers), takes it back, or shares a chest with the household (anyone who may open the place)
  private doRoom(ctx: SystemContext, userId: number, actorId: number, primary: number, rec: PropertyRecord, manages: boolean, action: string, rawRef: unknown, rawRecipient: unknown): void {
    if (!this.placesOn() || rec.owner === 0 || !rec.place) {
      this.notice(ctx, userId, "Only a whole property's rooms are assigned.");
      return;
    }
    if (!manages) {
      this.notice(ctx, userId, "This is not yours to assign.");
      return;
    }
    const ref = toFormId(rawRef);
    const room = ref ? this.roomsOf(ctx, primary, rec).find((r) => r.ref === (this.primaryOf(ctx, ref) || ref)) : undefined;
    if (!room) {
      this.notice(ctx, userId, "That is not one of this property's rooms or chests.");
      return;
    }
    if (room.other) {
      this.notice(ctx, userId, `That is ${room.other}'s own.`);
      return;
    }
    const hex = room.ref.toString(16);
    const assigned = Object.assign({}, rec.assigned || {});
    let shared = (rec.shared || []).filter((h) => h !== hex);
    let said = "";
    if (action === "assign") {
      const recipientActor = toFormId(rawRecipient);
      const profile = recipientActor ? this.profileOf(ctx, recipientActor) : 0;
      if (!profile) { this.notice(ctx, userId, "That is nobody."); return; }
      if (profile === rec.owner) { delete assigned[hex]; said = `${room.label} is yours alone again.`; }
      else { assigned[hex] = { profile, name: this.nameOf(ctx, recipientActor) }; said = `${room.label} is ${assigned[hex].name}'s now.`; }
      if (Object.keys(assigned).length > MAX_ROOMS_LISTED * 2) { this.notice(ctx, userId, "Too many rooms are assigned already."); return; }
    } else if (action === "unassign") {
      delete assigned[hex];
      said = `${room.label} is yours alone again.`;
    } else if (action === "share") {
      if (room.kind !== "chest") { this.notice(ctx, userId, "Only a chest is shared."); return; }
      delete assigned[hex];
      shared = shared.concat([hex]);
      said = `${room.label} is shared with everyone who has a key.`;
    } else {
      said = `${room.label} is yours alone again.`;
    }
    if (Object.keys(assigned).length) rec.assigned = assigned; else delete rec.assigned;
    if (shared.length) rec.shared = shared; else delete rec.shared;
    if (!this.commit(ctx, userId, primary, rec)) return;
    this.notice(ctx, userId, said);
    if (action === "assign" && room.ref && rec.assigned && rec.assigned[hex]) {
      const to = this.userOf(ctx, toFormId(rawRecipient));
      this.notice(ctx, to, `${room.label} in ${rec.name || `${rec.ownerName}'s property`} is yours to use.`);
    }
    this.sendMenu(ctx, userId, actorId, primary);
  }

  // Whether an actor stands in one of the cells of the place a ref belongs to
  private standsInPlaceOf(ctx: SystemContext, actorId: number, target: number): boolean {
    const p = this.primaryOf(ctx, target);
    const rec = p ? this.read(ctx, p) : null;
    const root = rec && rec.owner !== 0 ? (rec.place ? p : rec.memberOf || 0) : (this.placeAt(ctx, target) || { root: 0 }).root;
    const rootRec = root ? (root === p ? rec : this.read(ctx, root)) : null;
    if (!rootRec || !rootRec.place) return false;
    return rootRec.place.cells.indexOf(this.cellDescOf(ctx, actorId)) !== -1;
  }

  // ── Access ──────────────────────────────────────────────────────────────────

  private hasAccess(ctx: SystemContext, primary: number, rec: PropertyRecord, actorId: number): boolean {
    return this.hasAccessWith(ctx, primary, rec, this.viewerAccess(ctx, actorId));
  }

  private hasAccessWith(ctx: SystemContext, primary: number, rec: PropertyRecord, v: ViewerAccess): boolean {
    if (rec.owner === 0) return true;
    if (v.profileId && v.profileId === rec.owner) return true;
    if (v.admin) return true;
    const hold = this.holdOf(ctx, primary);
    if (hold && v.ranks.some((r) => r.hold === hold && MANAGER_RANKS.indexOf(r.rank) !== -1)) return true;
    const credential = this.keyCredential(primary, rec);
    const names = this.acceptedKeyNames(ctx, primary, rec);
    if (Array.from(v.keys).some((n) => this.isKeyFor(n, credential, names))) return true;
    if (!this.placesOn()) return false;
    // A place's root also answers to the key names its members had before the migration
    if (rec.keyAliases && Array.from(v.keys).some((n) => rec.keyAliases!.some((a) => n === a || n.endsWith(a)))) return true;
    // A member of a place: its assignee, and whoever may open the place itself; a chest only for the household when shared
    if (!rec.memberOf || rec.memberOf === primary) return false;
    const root = this.read(ctx, rec.memberOf);
    if (!root || root.owner === 0) return false;
    const hex = primary.toString(16);
    const assigned = root.assigned && root.assigned[hex];
    if (assigned) return (!!v.profileId && assigned.profile === v.profileId) || this.ownsOrManages(ctx, rec.memberOf, root, v);
    if (this.isPlaceContainer(ctx, primary, rec) && !(root.shared || []).includes(hex)) return this.ownsOrManages(ctx, rec.memberOf, root, v);
    return this.hasAccessWith(ctx, rec.memberOf, root, v);
  }

  // The owner, staff (Lead GM and above) and the managers of the hold: never a key holder
  private ownsOrManages(ctx: SystemContext, primary: number, rec: PropertyRecord, v: ViewerAccess): boolean {
    if (rec.owner === 0) return true;
    if (v.profileId && v.profileId === rec.owner) return true;
    if (v.admin) return true;
    const hold = this.holdOf(ctx, primary);
    return !!hold && v.ranks.some((r) => r.hold === hold && MANAGER_RANKS.indexOf(r.rank) !== -1);
  }

  // ── Places (N3): access ─────────────────────────────────────────────────────
  //
  // A place is a house's root record with place.cells: every door and chest in those cells belongs to it. A ref with a
  // record of its own (a member, or another owner's claim) keeps its own rules; one nobody has claimed follows these.

  // A container in a place: a member chest, or one the migration marked owner-only
  private isPlaceContainer(ctx: SystemContext, primary: number, rec: PropertyRecord): boolean {
    if (rec.ownerOnly) return true;
    return !!rec.memberOf && rec.memberOf !== primary && this.baseTypeOf(ctx, primary) === "CONT";
  }

  // An unclaimed door or chest inside a place: the owner and managers; its assignee; a chest that is shared, the household
  // (anyone who may open the place); any other chest no one else; a door nobody is assigned stays open, as a house's are
  private placeRefAccess(ctx: SystemContext, root: number, rootRec: PropertyRecord, primary: number, v: ViewerAccess): boolean {
    if (this.ownsOrManages(ctx, root, rootRec, v)) return true;
    const hex = primary.toString(16);
    const assigned = rootRec.assigned && rootRec.assigned[hex];
    if (assigned) return !!v.profileId && assigned.profile === v.profileId;
    if (this.baseTypeOf(ctx, primary) !== "CONT") return true;
    return (rootRec.shared || []).includes(hex) && this.hasAccessWith(ctx, root, rootRec, v);
  }

  // The place a ref stands in, by its cell, when the place's owner still holds it
  private placeAt(ctx: SystemContext, refrId: number): { root: number; rec: PropertyRecord } | null {
    const index = this.placeIndex(ctx);
    if (!index.size) return null;
    let cell = "";
    try { cell = String((ctx.svr as Mp).get(refrId, "worldOrCellDesc") || ""); } catch { return null; }
    const root = index.get(cell);
    if (!root) return null;
    const rec = this.read(ctx, root);
    return rec && rec.owner !== 0 && rec.place ? { root, rec } : null;
  }

  // cell desc -> the root of the place holding it, rebuilt after any record is written
  private placeIndex(ctx: SystemContext): Map<string, number> {
    if (this.placeCells && !this.placeCellsDirty) return this.placeCells;
    const index = new Map<string, number>();
    for (const primary of this.claimed) {
      const rec = this.read(ctx, primary);
      if (!rec || rec.owner === 0 || !rec.place) continue;
      for (const cell of rec.place.cells) if (!index.has(cell)) index.set(cell, primary);
    }
    this.placeCells = index;
    this.placeCellsDirty = false;
    return index;
  }

  // ── Places (N3): building and carrying ─────────────────────────────────────

  private cellDescOf(ctx: SystemContext, refrId: number): string {
    try { return String((ctx.svr as Mp).get(refrId, "worldOrCellDesc") || ""); } catch { return ""; }
  }

  private isWorldDesc(ctx: SystemContext, desc: string): boolean {
    if (!desc) return false;
    const cached = this.worldDescs.get(desc);
    if (cached !== undefined) return cached;
    const mp = ctx.svr as Mp;
    let world = false;
    try { const r = mp.lookupEspmRecordById(mp.getIdFromDesc(desc) >>> 0); world = !!r && !!r.record && String(r.record.type) === "WRLD"; } catch { /* unknown */ }
    this.worldDescs.set(desc, world);
    return world;
  }

  // The doors and containers placed in an interior cell (loading the cell's references, as a player entering it would)
  private refsInCell(ctx: SystemContext, desc: string): number[] {
    let ids: number[] = [];
    try { ids = Array.from((ctx.svr as Mp).getNeighborsByPosition(desc, [0, 0, 0]) as ArrayLike<number>, (id) => Number(id) >>> 0); } catch { return []; }
    return ids.filter((id) => id && id < 0xff000000 && this.isClaimable(ctx, id));
  }

  // Teleport doors in a cell and the cell each leads to
  private doorsOut(ctx: SystemContext, desc: string): Array<{ ref: number; far: number; farCell: string }> {
    const out: Array<{ ref: number; far: number; farCell: string }> = [];
    for (const ref of this.refsInCell(ctx, desc)) {
      if (this.baseTypeOf(ctx, ref) !== "DOOR") continue;
      const far = this.partnerOf(ctx, ref);
      if (far) out.push({ ref, far, farCell: this.cellDescOf(ctx, far) });
    }
    return out;
  }

  // The interior behind a house's door, and the rooms reachable only through it: a cell with a door of its own to the world
  // is another building and stops the walk; more than MAX_PLACE_CELLS (a dungeon below) keeps the first interior alone
  private placeCellsFrom(ctx: SystemContext, inner: string): string[] {
    const cells = [inner];
    for (let i = 0; i < cells.length; i++) {
      for (const d of this.doorsOut(ctx, cells[i])) {
        if (!d.farCell || this.isWorldDesc(ctx, d.farCell) || cells.indexOf(d.farCell) !== -1) continue;
        if (this.doorsOut(ctx, d.farCell).some((o) => this.isWorldDesc(ctx, o.farCell))) continue;
        cells.push(d.farCell);
        if (cells.length > MAX_PLACE_CELLS) return [inner];
      }
    }
    return cells;
  }

  // A door claimed, granted or handed over with the place rules on becomes a place when it leads from the world into an
  // interior nobody else's place holds: the cells behind it, its other entrances and the owner's own claims inside join it.
  // Staff claims stay as they are (Nate, 3 Oct). Nothing is built for a chest, or a door between two interiors.
  private ensurePlace(ctx: SystemContext, primary: number, rec: PropertyRecord): void {
    if (!this.placesOn() || rec.owner === 0 || rec.place || (rec.memberOf && rec.memberOf !== primary) || !rec.partner) return;
    if (this.isStaff(ctx, rec.owner, 0)) return;
    const near = this.cellDescOf(ctx, primary), far = this.cellDescOf(ctx, rec.partner);
    const nearWorld = this.isWorldDesc(ctx, near), farWorld = this.isWorldDesc(ctx, far);
    if (!near || !far || nearWorld === farWorld) return;
    const cells = this.placeCellsFrom(ctx, nearWorld ? far : near);
    const index = this.placeIndex(ctx);
    const taken = cells.find((c) => index.has(c) && index.get(c) !== primary);
    if (taken) { this.log(`[housing] ${primary.toString(16)} builds no place: ${taken} is part of ${index.get(taken)!.toString(16)}`); return; }
    rec.place = { cells, builtAt: Date.now() };
    if (!this.write(ctx, primary, rec)) { delete rec.place; return; }
    const joined = this.joinEntrances(ctx, primary, rec);
    let own = 0;
    for (const other of this.claimed.slice()) {
      if (other === primary) continue;
      const r = this.read(ctx, other);
      if (!r || r.owner !== rec.owner || r.memberOf || r.place) continue;
      if (cells.indexOf(this.cellDescOf(ctx, other)) === -1 && !(r.partner && cells.indexOf(this.cellDescOf(ctx, r.partner)) !== -1)) continue;
      r.memberOf = primary;
      if (this.write(ctx, other, r)) own++;
    }
    this.log(`[housing] place built: ${rec.ownerName} (${rec.owner}) ${primary.toString(16)} cells=${cells.join(",")}, ${joined.length} entrance(s) joined, ${own} own claim(s) inside`);
  }

  // Doors to the world in a place's cells that nobody else holds become members, locked as the root is
  private joinEntrances(ctx: SystemContext, root: number, rec: PropertyRecord): number[] {
    const joined: number[] = [];
    for (const cell of (rec.place ? rec.place.cells : [])) {
      for (const d of this.doorsOut(ctx, cell)) {
        if (!this.isWorldDesc(ctx, d.farCell)) continue;
        const p = this.primaryOf(ctx, d.ref);
        if (!p || p === root || joined.indexOf(p) !== -1) continue;
        const m = this.read(ctx, p);
        if (m && m.owner !== 0) {
          if (m.owner !== rec.owner) this.log(`[housing] place ${root.toString(16)}: entrance ${p.toString(16)} is ${m.ownerName || m.owner}'s and stays theirs`);
          continue;
        }
        const member = m || emptyRecord();
        member.owner = rec.owner;
        member.ownerName = rec.ownerName;
        member.partner = this.partnerOf(ctx, p);
        member.locked = rec.locked;
        member.memberOf = root;
        if (member.issued === null) member.issued = [];
        if (this.write(ctx, p, member)) joined.push(p);
      }
    }
    return joined;
  }

  private membersOf(ctx: SystemContext, root: number): Array<{ ref: number; rec: PropertyRecord }> {
    const out: Array<{ ref: number; rec: PropertyRecord }> = [];
    for (const ref of this.claimed.slice()) {
      if (ref === root) continue;
      const r = this.read(ctx, ref);
      if (r && r.owner !== 0 && r.memberOf === root) out.push({ ref, rec: r });
    }
    return out;
  }

  // A place handed over or granted: every member goes with its root (the root's re-key already re-keyed them)
  private carryPlace(ctx: SystemContext, root: number, rec: PropertyRecord): void {
    for (const m of this.membersOf(ctx, root)) {
      m.rec.owner = rec.owner;
      m.rec.ownerName = rec.ownerName;
      this.write(ctx, m.ref, m.rec);
    }
  }

  // The other doors of the place a door belongs to (the root and its member doors), not the one given
  private placeDoorsWith(ctx: SystemContext, primary: number, rec: PropertyRecord): Array<{ ref: number; rec: PropertyRecord }> {
    const root = rec.place ? primary : rec.memberOf || 0;
    if (!root) return [];
    const rootRec = root === primary ? rec : this.read(ctx, root);
    if (!rootRec || rootRec.owner === 0 || !rootRec.place) return [];
    const all = [{ ref: root, rec: rootRec }, ...this.membersOf(ctx, root)];
    return all.filter((d) => d.ref !== primary && !!d.rec.partner && this.baseTypeOf(ctx, d.ref) === "DOOR");
  }

  private denyInPlace(ctx: SystemContext, casterId: number, owner: PropertyRecord): void {
    const userId = this.userOf(ctx, casterId);
    const now = Date.now();
    if (now - (this.lastDenyMs.get(userId) || 0) <= 1000) return;
    this.lastDenyMs.set(userId, now);
    this.notice(ctx, userId, `This belongs to ${owner.name || owner.ownerName || "someone"}.`);
  }

  // Staff profiles, whose claims the place migration leaves exactly as they are and the place cap never counts (Nate,
  // 3 Oct). Owners are offline at boot, so the Discord roles cannot say; the list is gamemode-config.json
  // housingPlaces.staffProfiles (read when the plan runs, so an edit needs no restart) and the setting housingStaffProfiles.
  private staffProfiles(): Set<number> {
    const out = new Set<number>(this.staffSetting);
    try {
      const cfg = JSON.parse(fs.readFileSync(GAMEMODE_CONFIG_FILE, "utf8"));
      const list = cfg && cfg.housingPlaces && Array.isArray(cfg.housingPlaces.staffProfiles) ? cfg.housingPlaces.staffProfiles : [];
      for (const p of list) if (Number(p) > 0) out.add(Number(p));
    } catch { /* no gamemode config here */ }
    return out;
  }

  // The place rules (N3) apply only once Nate sets housingPlaceMigration "apply"
  private placesOn(): boolean {
    return this.placeMigration === "apply";
  }

  // One inventory read and one access read per actor, not per claimed ref.
  private viewerAccess(ctx: SystemContext, actorId: number): ViewerAccess {
    const mp = ctx.svr as Mp;
    const keys = new Set<string>();
    try {
      const inv = mp.get(actorId, "inventory");
      const entries = inv && Array.isArray(inv.entries) ? inv.entries : [];
      for (const e of entries) {
        if ((Number(e?.baseId) >>> 0) === KEY_BASE_ID && e?.name) keys.add(String(e.name));
      }
    } catch { /* actor gone */ }
    return {
      profileId: this.profileOf(ctx, actorId),
      admin: this.isAdmin(ctx, actorId),
      ranks: this.holdRanks(ctx, actorId),
      keys,
    };
  }

  private isManager(ctx: SystemContext, actorId: number, primary: number): boolean {
    return this.isAdmin(ctx, actorId) || this.isHoldManager(ctx, actorId, primary);
  }

  // A jarl, steward or other manager rank of the hold the property stands in
  private isHoldManager(ctx: SystemContext, actorId: number, primary: number): boolean {
    const hold = this.holdOf(ctx, primary);
    if (!hold) return false;
    return this.holdRanks(ctx, actorId).some((r) => r.hold === hold && MANAGER_RANKS.indexOf(r.rank) !== -1);
  }

  // Staff who override housing claims: Lead GM and above (TIER_CAPS.spawn). A GM observes; opening, transferring, revoking
  // or cutting keys for someone else's property is not theirs (claude-jake's review A3-1, 2026-09-28)
  private isAdmin(ctx: SystemContext, actorId: number): boolean {
    const tier = adminTierOf(ctx.svr as Mp, actorId, this.roleCfg);
    return tier !== null && TIER_CAPS[tier].spawn;
  }

  // officials.json (via zones) first, then the backend faction rows "hold:<slug>:<rank>".
  private holdRanks(ctx: SystemContext, actorId: number): Array<{ hold: string; rank: string }> {
    const out: Array<{ hold: string; rank: string }> = [];
    const profileId = this.profileOf(ctx, actorId);
    for (const z of this.zones.all) {
      const rank = this.zones.rankOf(profileId, z.id);
      if (rank) out.push({ hold: z.id, rank });
    }
    try {
      const access = (ctx.svr as Mp).get(actorId, "private.skympAccess");
      const rows = access && Array.isArray(access.factions) ? access.factions : [];
      for (const row of rows) {
        const parts = String(row?.requirementId || "").split(":");
        if (parts.length === 3 && parts[0] === "hold") out.push({ hold: parts[1], rank: parts[2] });
      }
    } catch { }
    return out;
  }

  // The zone a property answers to: where the reference stands in the world, or where its
  // teleport partner (the exterior door of an interior) stands. Strongholds win by radius.
  // The old cell table is the fallback for interiors without a placeable exterior door.
  private holdOf(ctx: SystemContext, primary: number): string | null {
    const cached = this.zoneCache.get(primary);
    if (cached !== undefined) return cached;
    let zone: string | null = this.zoneOfRef(ctx, primary);
    if (!zone) {
      const partner = this.partnerOf(ctx, primary);
      if (partner) zone = this.zoneOfRef(ctx, partner);
    }
    if (!zone) zone = HOLD_CELLS[this.cellOf(ctx, primary)] || null;
    if (!zone) {
      const partner = this.partnerOf(ctx, primary);
      if (partner) zone = HOLD_CELLS[this.cellOf(ctx, partner)] || null;
    }
    this.zoneCache.set(primary, zone);
    return zone;
  }

  private zoneOfRef(ctx: SystemContext, refrId: number): string | null {
    const mp = ctx.svr as Mp;
    try {
      const z = this.zones.zoneAt(mp.get(refrId, "worldOrCellDesc"), mp.get(refrId, "pos"));
      return z ? z.id : null;
    } catch {
      return null;
    }
  }

  // The cell this reference itself stands in.
  private cellOf(ctx: SystemContext, refrId: number): number {
    const mp = ctx.svr as Mp;
    try {
      const desc = mp.get(refrId, "worldOrCellDesc");
      return desc ? (mp.getIdFromDesc(desc) >>> 0) : 0;
    } catch {
      return 0;
    }
  }

  // Claiming has to happen at the door, not from a form id typed into a packet.
  private withinReach(ctx: SystemContext, actorId: number, refrId: number): boolean {
    const mp = ctx.svr as Mp;
    let a: any, b: any;
    try {
      a = mp.get(actorId, "pos");
      b = mp.get(refrId, "pos");
    } catch {
      return true; // position unavailable: do not block a legitimate action
    }
    if (!Array.isArray(a) || !Array.isArray(b)) return true;
    const dx = Number(a[0]) - Number(b[0]);
    const dy = Number(a[1]) - Number(b[1]);
    const dz = Number(a[2]) - Number(b[2]);
    const d2 = dx * dx + dy * dy + dz * dz;
    if (!Number.isFinite(d2)) return true;
    return d2 <= this.maxDistance * this.maxDistance;
  }

  // Either half of a teleport pair counts, since the menu answers with the primary even from the far side
  private nearProperty(ctx: SystemContext, actorId: number, refrId: number): boolean {
    if (this.withinReach(ctx, actorId, refrId)) return true;
    const partner = this.partnerOf(ctx, refrId);
    return !!partner && this.withinReach(ctx, actorId, partner);
  }

  // ── Keys ────────────────────────────────────────────────────────────────────

  // The credential is the form id plus the serial, never the player-chosen
  // label: a rename must not orphan keys, and no label may forge another
  // property's key. hasAccess matches the key item's name against it exactly.
  // The credential is the "(TAG[-serial])" suffix; the label in front of it is the property's
  // current name, so a key reads "Breezehome Key (220174E5)" and a rename cannot orphan it.
  private keyCredential(primary: number, rec: PropertyRecord): string {
    const tag = primary.toString(16).toUpperCase();
    return rec.serial > 1 ? `(${tag}-${rec.serial})` : `(${tag})`;
  }

  // Keys read as keys, not as serial numbers: "Key to the Jerall View Inn".
  // A name is only marked when it would clash with another property's name or
  // when the locks have been re-cut, and both are rare. An unnamed property
  // keeps the old form, because there is nothing to call its key.
  // Keys cut before this still open their door: the credential is still taken.
  private keyNameFor(label: string, rank: number, rec: PropertyRecord): string {
    const base = rank > 1 ? `Key to the ${label}, the ${this.ordinal(rank)}` : `Key to the ${label}`;
    if (rec.serial <= 1) return base;
    return `${base} (recut${rec.serial > 2 ? " " + (rec.serial - 1) : ""})`;
  }

  // The name keys were cut under before rec.issued existed; its rank moves when another property is renamed
  private legacyKeyName(ctx: SystemContext, primary: number, rec: PropertyRecord): string {
    const label = (rec.name || "").trim();
    if (!label) return `Property Key ${this.keyCredential(primary, rec)}`;
    return this.keyNameFor(label, this.labelRank(ctx, primary, label), rec);
  }

  // Names this property's door answers to, besides the credential suffix
  private acceptedKeyNames(ctx: SystemContext, primary: number, rec: PropertyRecord): string[] {
    return rec.issued ? rec.issued : [this.legacyKeyName(ctx, primary, rec)];
  }

  // The lowest "Key to the X[, the Nth]" no other claimed property answers to
  private keyNameToCut(ctx: SystemContext, primary: number, rec: PropertyRecord): string {
    const label = (rec.name || "").trim();
    if (!label) return `Property Key ${this.keyCredential(primary, rec)}`;
    const taken = new Set<string>();
    for (const other of this.claimed) {
      if (other === primary) continue;
      const o = this.read(ctx, other);
      if (o && o.owner !== 0) for (const n of this.acceptedKeyNames(ctx, other, o)) taken.add(n);
    }
    for (let rank = 1; ; rank++) {
      const name = this.keyNameFor(label, rank, rec);
      if (!taken.has(name)) return name;
    }
  }

  // Freezes each old record's key name; all computed before any write so no rank shifts mid-pass
  // Reads the registry without pruning it: an unreadable record is skipped, never dropped
  private migrateLegacyKeyNames(ctx: SystemContext): void {
    const todo: Array<{ primary: number; rec: PropertyRecord; name: string }> = [];
    for (const primary of this.claimed.slice()) {
      const rec = this.read(ctx, primary);
      if (rec && rec.owner !== 0 && rec.issued === null) todo.push({ primary, rec, name: this.legacyKeyName(ctx, primary, rec) });
    }
    let n = 0;
    for (const t of todo) {
      t.rec.issued = (t.rec.name || "").trim() ? [t.name] : [];
      if (this.write(ctx, t.primary, t.rec)) n++;
    }
    if (todo.length) this.log(`[housing] recorded key names for ${n}/${todo.length} properties from before key-name records`);
  }

  // Run before anything that can move a key name (a rename, a new key), with the world loaded
  private freezeKeyNames(ctx: SystemContext, primary: number, rec: PropertyRecord): void {
    this.migrateLegacyKeyNames(ctx);
    if (rec.issued !== null) return;
    const fresh = this.read(ctx, primary);
    rec.issued = fresh && fresh.issued ? fresh.issued : ((rec.name || "").trim() ? [this.legacyKeyName(ctx, primary, rec)] : []);
  }

  // Where this property stands among the ones sharing its name, lowest ref id
  // first. Two "Red Diamond"s must not answer to one key.
  private labelRank(ctx: SystemContext, primary: number, label: string): number {
    const want = label.toLowerCase();
    let rank = 1;
    for (const other of this.claimed) {
      if (other === primary || other > primary) continue;
      const rec = this.read(ctx, other) as PropertyRecord | null;
      if (rec && ((rec.name || "").trim().toLowerCase()) === want) rank++;
    }
    return rank;
  }

  private ordinal(n: number): string {
    const words = ["", "", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];
    return words[n] || `${n}th`;
  }

  private isKeyFor(name: unknown, credential: string, names?: string[]): boolean {
    if (typeof name !== "string") return false;
    if (names && names.indexOf(name) !== -1) return true;
    return name.endsWith(credential);
  }

  // Pull the current keys from everyone online and move the serial on, so any
  // copy that was missed (offline, in a container) stops matching.
  private reKey(ctx: SystemContext, primary: number, rec: PropertyRecord): void {
    const mp = ctx.svr as Mp;
    const credential = this.keyCredential(primary, rec);
    const names = this.acceptedKeyNames(ctx, primary, rec);
    for (const userId of this.onlineUsers(ctx)) {
      const actorId = this.actorOf(ctx, userId);
      if (!actorId) continue;
      try {
        const inv = mp.get(actorId, "inventory");
        const entries = inv && Array.isArray(inv.entries) ? inv.entries : [];
        const aliases = rec.keyAliases || [];
        const kept = entries.filter((e: any) => !((Number(e?.baseId) >>> 0) === KEY_BASE_ID && (this.isKeyFor(e?.name, credential, names)
          || (typeof e?.name === "string" && aliases.some((a) => e.name === a || e.name.endsWith(a))))));
        if (kept.length !== entries.length) mp.set(actorId, "inventory", { entries: kept });
      } catch { /* actor gone */ }
    }
    rec.serial += 1;
    rec.issued = [];
    // New locks: the key names a place carried over from its members stop opening it too
    if (rec.keyAliases) rec.keyAliases = [];
    // ...and every door and chest of the place gets new locks with it, so no member's own old key still opens it
    if (rec.place && this.placesOn()) {
      for (const member of this.claimed) {
        if (member === primary) continue;
        const m = this.read(ctx, member);
        if (!m || m.memberOf !== primary) continue;
        this.reKey(ctx, member, m);
        this.write(ctx, member, m);
      }
    }
  }

  private giveKey(ctx: SystemContext, actorId: number, keyName: string): boolean {
    const mp = ctx.svr as Mp;
    try {
      const inv = mp.get(actorId, "inventory") || { entries: [] };
      const entries = Array.isArray(inv.entries) ? inv.entries.slice() : [];
      const keys = entries.filter((e: any) => (Number(e?.baseId) >>> 0) === KEY_BASE_ID);
      const carried = keys.reduce((n: number, e: any) => n + (Number(e?.count) || 0), 0);
      if (carried >= MAX_KEYS_CARRIED) return false;
      const stack = keys.find((e: any) => e?.name === keyName);
      if (stack) stack.count = (Number(stack.count) || 0) + 1;
      else entries.push({ baseId: KEY_BASE_ID, count: 1, name: keyName });
      mp.set(actorId, "inventory", { entries });
      return true;
    } catch (e) {
      this.log(`[housing] could not give key: ${e}`);
      return false;
    }
  }

  // ── refDecor ────────────────────────────────────────────────────────────────

  private pushDecorToAll(ctx: SystemContext): void {
    const refs = this.decorRefs(ctx);
    for (const userId of this.onlineUsers(ctx)) this.sendDecor(ctx, userId, refs);
  }

  private pushDecor(ctx: SystemContext, userId: number): void {
    this.sendDecor(ctx, userId, this.decorRefs(ctx));
  }

  // A locked claim is locked for every viewer, so one list serves everyone. A member of a place carries the place's name, so
  // a rename shows on every door pair of it (Nate, 3 Oct)
  private decorRefs(ctx: SystemContext): Array<Record<string, unknown>> {
    const refs: Array<Record<string, unknown>> = [];
    const live = this.liveClaims(ctx);
    const names = new Map<number, string | null>(live.map((c) => [c.primary, c.rec.name]));
    for (const { primary, rec } of live) {
      const name = this.shownName(rec, names);
      refs.push({ refId: primary, name, locked: rec.locked });
      if (rec.partner) refs.push({ refId: rec.partner, name, locked: rec.locked });
    }
    return refs;
  }

  // The name a claim shows: its place's when it is a member of a named one, else its own
  private shownName(rec: PropertyRecord, rootNames: Map<number, string | null>): string | null {
    if (rec.memberOf) { const n = rootNames.get(rec.memberOf); if (n) return n; }
    return rec.name;
  }

  // The interaction prompt's name for a load door (gamemode.js dboDoorName): the property's name on the side of its door
  // that stands in the world and leads in, so a house reads as what its owner called it; "" elsewhere (the door out, a
  // door between two interiors, an unnamed or unowned claim), where the prompt keeps the destination's name
  private doorName(ctx: SystemContext, refrId: number): string {
    const primary = this.primaryOf(ctx, refrId);
    if (!primary) return "";
    const rec = this.read(ctx, primary);
    if (!rec || rec.owner === 0) return "";
    const root = rec.memberOf ? this.read(ctx, rec.memberOf) : null;
    const name = (root && root.owner !== 0 && root.name) || rec.name;
    if (!name) return "";
    const far = this.partnerOf(ctx, refrId);
    if (!far) return "";
    return this.isWorldDesc(ctx, this.cellDescOf(ctx, refrId)) && !this.isWorldDesc(ctx, this.cellDescOf(ctx, far)) ? name : "";
  }

  // The registry drops an entry only when its record says the claim is over (an ownerless stub). An entry that reads
  // as nothing - a changeform not loaded yet, right after boot or before anyone has touched the ref - is kept and only
  // left out of this pass: pruning on a null read dropped 4 live claims on 2026-09-24, and three more claims went
  // missing from the index in the days of the 22 Sep deploy wipes. The index cannot be rebuilt from inside the game,
  // so an entry is never thrown away on a read that proves nothing (2026-09-30 launch triage).
  private liveClaims(ctx: SystemContext): Array<{ primary: number; rec: PropertyRecord }> {
    const out: Array<{ primary: number; rec: PropertyRecord }> = [];
    const over: number[] = [];
    for (const primary of this.claimed) {
      const rec = this.read(ctx, primary);
      if (!rec) continue;
      if (rec.owner !== 0) out.push({ primary, rec });
      else over.push(primary);
    }
    if (over.length) {
      this.claimed = this.claimed.filter((id) => over.indexOf(id) === -1);
      this.saveRegistry();
      this.log(`[housing] dropped ${over.length} registry entries whose claim is over: ${over.map((id) => id.toString(16)).join(", ")}`);
    }
    return out;
  }

  private sendDecor(ctx: SystemContext, userId: number, refs: Array<Record<string, unknown>>): void {
    if (!this.actorOf(ctx, userId)) return;
    this.send(ctx, userId, { customPacketType: "refDecor", full: true, refs });
  }

  // ── Storage ─────────────────────────────────────────────────────────────────

  // Resolve any half of a pair (or a plain ref) to the id the record lives on.
  private primaryOf(ctx: SystemContext, refrId: number): number {
    if (!refrId) return 0;
    const mp = ctx.svr as Mp;
    let raw: any = null;
    try {
      raw = mp.get(refrId, HOUSING_PROP);
    } catch (e) {
      this.logUnclaimable(refrId, e);
      return 0;
    }
    if (raw && typeof raw === "object" && Number(raw.primary)) return Number(raw.primary) >>> 0;
    if (raw && typeof raw === "object") return refrId;

    // Nothing stored yet: only doors and containers can become property.
    if (!this.isClaimable(ctx, refrId)) return 0;

    // The pair's primary is the lower of the two ids.
    const partner = this.partnerOf(ctx, refrId);
    if (partner && partner < refrId) return partner;
    return refrId;
  }

  // The far side of a teleport door, read out of the ESM's XTEL field.
  private partnerOf(ctx: SystemContext, refrId: number): number {
    const cached = this.partnerCache.get(refrId);
    if (cached !== undefined) return cached;
    const far = espmRefrFieldId(ctx.svr as Mp, refrId, "XTEL");
    // A far side the server cannot load would fail every write, so the near side is claimed alone
    const partner = far && this.loadable(ctx, far) ? far : 0;
    this.rememberEspm(this.partnerCache, refrId, partner);
    return partner;
  }

  private loadable(ctx: SystemContext, refrId: number): boolean {
    try {
      (ctx.svr as Mp).get(refrId, HOUSING_PROP);
      return true;
    } catch {
      return false;
    }
  }

  // Once per ref, so the log names doors the server never loads without a held key flooding it
  private logUnclaimable(refrId: number, reason: unknown): void {
    if (this.unclaimableLogged.has(refrId)) return;
    if (this.unclaimableLogged.size >= MAX_ESPM_CACHE) this.unclaimableLogged.clear();
    this.unclaimableLogged.add(refrId);
    this.log(`[housing] ${refrId.toString(16)} cannot hold a claim: ${reason}`);
  }

  // "DOOR" / "CONT" / "" - the base object behind a placed reference. Claiming
  // is limited to these two so a stray form id cannot be turned into property.
  private baseTypeOf(ctx: SystemContext, refrId: number): string {
    const cached = this.baseTypeCache.get(refrId);
    if (cached !== undefined) return cached;
    const mp = ctx.svr as Mp;
    let type = "";
    try {
      const baseId = espmRefrFieldId(mp, refrId, "NAME");
      if (baseId) {
        const base = mp.lookupEspmRecordById(baseId);
        type = String((base && base.record && base.record.type) || "");
      }
    } catch { /* not an espm reference */ }
    this.rememberEspm(this.baseTypeCache, refrId, type);
    return type;
  }

  private isClaimable(ctx: SystemContext, refrId: number): boolean {
    const t = this.baseTypeOf(ctx, refrId);
    return t === "DOOR" || t === "CONT";
  }

  // ESM data never changes, so overflow can just start the cache over.
  private rememberEspm<T>(cache: Map<number, T>, refrId: number, value: T): void {
    if (cache.size >= MAX_ESPM_CACHE) cache.clear();
    cache.set(refrId, value);
  }

  private read(ctx: SystemContext, primary: number): PropertyRecord | null {
    try {
      const raw = (ctx.svr as Mp).get(primary, HOUSING_PROP);
      if (!raw || typeof raw !== "object" || Number((raw as any).primary)) return null;
      const r = raw as Partial<PropertyRecord>;
      return {
        owner: Number(r.owner) || 0,
        ownerName: String(r.ownerName || ""),
        name: typeof r.name === "string" && r.name ? r.name : null,
        locked: r.locked === true,
        serial: Number(r.serial) || 1,
        partner: Number(r.partner) || 0,
        containers: Array.isArray(r.containers) ? r.containers.map((c) => Number(c) >>> 0) : [],
        issued: Array.isArray(r.issued) ? r.issued.map((n) => String(n)).slice(-MAX_ISSUED_KEY_NAMES) : null,
        ...(r.place && Array.isArray(r.place.cells) ? { place: { cells: r.place.cells.map(String), builtAt: Number(r.place.builtAt) || 0 } } : {}),
        ...(r.assigned && typeof r.assigned === "object" ? { assigned: r.assigned } : {}),
        ...(Array.isArray(r.shared) ? { shared: r.shared.map(String) } : {}),
        ...(Array.isArray(r.keyAliases) ? { keyAliases: r.keyAliases.map(String) } : {}),
        ...(Number(r.memberOf) ? { memberOf: Number(r.memberOf) >>> 0 } : {}),
        ...(r.ownerOnly === true ? { ownerOnly: true } : {}),
      };
    } catch {
      return null;
    }
  }

  private write(ctx: SystemContext, primary: number, rec: PropertyRecord): boolean {
    const mp = ctx.svr as Mp;
    try {
      mp.set(primary, HOUSING_PROP, rec);
    } catch (e) {
      this.log(`[housing] write failed for ${primary.toString(16)}: ${e}`);
      return false;
    }
    // The index and the pointer are best-effort; the record itself is stored.
    try { mp.set(primary, OWNER_INDEX_PROP, String(rec.owner)); } catch { }
    if (rec.partner) {
      try {
        const pointer: PrimaryPointer = { primary };
        mp.set(rec.partner, HOUSING_PROP, pointer);
      } catch { }
    }
    if (rec.owner !== 0) this.remember(primary); else this.forget(primary);
    this.placeCellsDirty = true;
    // Lock changes reach every client on the next tick, not the next decor interval
    this.decorDirty = true;
    this.lastDecorMs = 0;
    return true;
  }

  // A failed write must never read as success to the player
  private commit(ctx: SystemContext, userId: number, primary: number, rec: PropertyRecord): boolean {
    if (this.write(ctx, primary, rec)) return true;
    this.notice(ctx, userId, CHANGE_FAILED);
    return false;
  }

  // Giving a property up keeps an ownerless stub so the key serial survives;
  // a later claim then cannot mint a credential old copies already answer to.
  private release(ctx: SystemContext, primary: number, rec: PropertyRecord): boolean {
    // Giving up a place gives up all of it; its members go first, so the root's re-key finds none left to cascade to
    if (rec.place) {
      for (const member of this.membersOf(ctx, primary)) {
        delete member.rec.memberOf; delete member.rec.ownerOnly;
        this.release(ctx, member.ref, member.rec);
      }
      delete rec.place; delete rec.assigned; delete rec.shared;
    }
    delete rec.keyAliases;
    delete rec.memberOf; delete rec.ownerOnly;
    this.reKey(ctx, primary, rec);
    rec.owner = 0;
    rec.ownerName = "";
    rec.name = null;
    rec.locked = false;
    return this.write(ctx, primary, rec);
  }

  // ── Places (N3): the migration dry run ──────────────────────────────────────
  //
  // Groups each owner's claims behind one exterior door into a place, as the migration will, and writes the plan to the
  // log and PLACE_PLAN_FILE for review. Nothing is written to any record. Returns false while no claim is readable yet.
  private dryRunPlaces(ctx: SystemContext): boolean {
    const mp = ctx.svr as Mp;
    const cellOf = (ref: number): string => this.cellDescOf(ctx, ref);
    const isWorld = (desc: string): boolean => this.isWorldDesc(ctx, desc);
    const claims: PlaceClaim[] = [];
    let readable = 0;
    for (const primary of this.claimed) {
      const rec = this.read(ctx, primary);
      if (!rec) continue;
      readable++;
      if (!rec.owner) continue;
      claims.push({ ref: primary, owner: rec.owner, ownerName: rec.ownerName, name: rec.name, locked: rec.locked, door: rec.partner !== 0,
        cell: cellOf(primary), partnerCell: rec.partner ? cellOf(rec.partner) : "" });
    }
    if (this.claimed.length && !readable) return false;
    const staff = this.staffProfiles();
    const plan = planPlaces(claims, isWorld, 1, staff);
    const hex = (n: number) => (n >>> 0).toString(16);
    this.log(`[housing] place plan (dry run, nothing changed): ${claims.length} owned claims -> ${plan.places.length} places`);
    for (const p of plan.places) {
      this.log(`[housing] place plan: ${p.ownerName} (${p.owner}) ${p.kind} ${hex(p.root)} "${p.name || ""}" cells=${p.cells.join(",")} members=${p.members.map(hex).join(",") || "-"}${p.openChests.length ? ` open chests becoming owner-only=${p.openChests.map(hex).join(",")}` : ""}`);
    }
    for (const o of plan.overCap) this.log(`[housing] place plan: ${o.ownerName} (${o.owner}) would hold ${o.places.length} places (${o.places.map(hex).join(", ")}); kept, for Nate to decide`);
    for (const k of plan.staffKept) this.log(`[housing] place plan: staff, left as they are: ${k.ownerName} (${k.owner}) ${k.claims.map(hex).join(", ")}`);
    try { fs.writeFileSync(PLACE_PLAN_FILE, JSON.stringify({ at: new Date().toISOString(), ...plan }, null, 1)); } catch (e) { this.log(`[housing] ${PLACE_PLAN_FILE} write failed: ${e}`); }
    if (this.placeMigration === "apply") this.applyPlaces(ctx, plan.places);
    return true;
  }

  // The migration itself, only with housingPlaceMigration "apply". Every record it touches is written to a backup file
  // first, and nothing is written if that fails. A house's root gets its place (cells) and the key names its members
  // answered to (keyAliases), so no key cut for any of its doors stops working once access goes by place; each member
  // points at its root; an unlocked chest inside a house is marked ownerOnly (Nate, 3 Oct), which the access rules apply.
  // Owners and locks stay as they are. A root that already has its place is skipped, so a second boot changes nothing.
  private applyPlaces(ctx: SystemContext, places: PlannedPlace[]): void {
    const mp = ctx.svr as Mp;
    const hex = (n: number) => (n >>> 0).toString(16);
    // A place already built (by an earlier boot, or by a claim since) is left alone, whichever of its doors the plan names
    const built = (ref: number) => { const r = this.read(ctx, ref); return !r || !!r.place || !!r.memberOf; };
    const todo = places.filter((p) => p.kind === "house").filter((p) => !built(p.root) && !p.members.some(built));
    if (!todo.length) { this.log(`[housing] place migration: nothing to apply`); return; }
    const backup: Record<string, unknown> = {};
    for (const p of todo) for (const ref of [p.root, ...p.members]) { try { backup[hex(ref)] = mp.get(ref, HOUSING_PROP); } catch { backup[hex(ref)] = null; } }
    const file = `${PLACE_BACKUP_PREFIX}${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    try { fs.writeFileSync(file, JSON.stringify(backup, null, 1)); } catch (e) { this.log(`[housing] place migration NOT applied: the backup ${file} could not be written: ${e}`); return; }
    let applied = 0, failed = 0;
    for (const p of todo) {
      const root = this.read(ctx, p.root);
      if (!root) { failed++; continue; }
      const aliases = new Set<string>(root.keyAliases || []);
      const members: Array<{ ref: number; rec: PropertyRecord }> = [];
      for (const ref of p.members) {
        const rec = this.read(ctx, ref);
        if (!rec) continue;
        aliases.add(this.keyCredential(ref, rec));
        for (const name of rec.issued || []) aliases.add(name);
        members.push({ ref, rec });
      }
      root.place = { cells: p.cells.slice(), builtAt: Date.now() };
      if (aliases.size) root.keyAliases = [...aliases];
      if (!this.write(ctx, p.root, root)) { failed++; continue; }
      // Doors to the world in the place's cells that nobody claimed join it, so no second way in stays open
      const joined = this.joinEntrances(ctx, p.root, root);
      if (joined.length) this.log(`[housing] place migration: ${hex(p.root)} gained its unclaimed entrance(s) ${joined.map(hex).join(",")}`);
      for (const m of members) {
        m.rec.memberOf = p.root;
        if (p.openChests.includes(m.ref)) m.rec.ownerOnly = true;
        if (!this.write(ctx, m.ref, m.rec)) failed++;
      }
      applied++;
      this.log(`[housing] place migration: ${p.ownerName} (${p.owner}) ${hex(p.root)} "${p.name || ""}" applied: ${members.length} member(s), ${aliases.size} key name(s) kept${p.openChests.length ? `, owner-only: ${p.openChests.map(hex).join(",")}` : ""}`);
    }
    this.log(`[housing] place migration applied to ${applied} house(s)${failed ? `, ${failed} write(s) failed` : ""}; backup ${file}`);
  }

  // The cap (Nate, 3 Oct): with the place rules on, one place per player, a place being a house with all its doors and
  // chests, or a lone claim; members of a place are not counted. Nobody loses anything: an owner already past it keeps what
  // they hold (the dry run lists them for Nate) and only cannot gain another. Staff are exempt: the profiles in
  // housingPlaces.staffProfiles / housingStaffProfiles, and anyone online with an admin tier (the roles the gear swap's
  // staff exemption reads). Without the place rules the old per-claim limit (housingMaxClaims) stands.
  // Returns the refusal, or "" when they may take one more.
  private overCap(ctx: SystemContext, profileId: number, actorId: number, self: boolean): string {
    if (!this.placesOn()) {
      if (this.countClaims(ctx, profileId) < this.maxClaims) return "";
      return self ? `You already hold ${this.maxClaims} properties.` : "They hold too much property already.";
    }
    if (this.isStaff(ctx, profileId, actorId)) return "";
    if (this.countPlaces(ctx, profileId) < this.placeCap) return "";
    const n = this.placeCap === 1 ? "a property" : `${this.placeCap} properties`;
    return self ? `You already hold ${n}; one each.` : `They already hold ${n}; one each.`;
  }

  private isStaff(ctx: SystemContext, profileId: number, actorId: number): boolean {
    if (profileId && this.staffProfiles().has(profileId)) return true;
    return !!actorId && adminTierOf(ctx.svr as Mp, actorId, this.roleCfg) !== null;
  }

  // Places held: every owned record that is not a member of a place (a root, or a claim of its own)
  private countPlaces(ctx: SystemContext, profileId: number): number {
    let n = 0;
    for (const primary of this.claimed) {
      const rec = this.read(ctx, primary);
      if (rec && rec.owner === profileId && (!rec.memberOf || rec.memberOf === primary)) n++;
    }
    return n;
  }

  private countClaims(ctx: SystemContext, profileId: number): number {
    let n = 0;
    for (const primary of this.claimed) {
      const rec = this.read(ctx, primary);
      if (rec && rec.owner === profileId) n++;
    }
    return n;
  }

  // ── Registry file ───────────────────────────────────────────────────────────
  //
  // Only an index of which refs to touch on boot; the changeform holds the data.

  private loadRegistry(): number[] {
    let raw: string;
    try {
      raw = fs.readFileSync(REGISTRY_FILE, "utf8");
    } catch {
      return []; // first run
    }
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map((v) => Number(v) >>> 0).filter((v) => v) : [];
    } catch (e) {
      this.log(`[housing] ${REGISTRY_FILE} is unreadable, starting empty: ${e}`);
      return [];
    }
  }

  // Write through a temp file so an interrupted write cannot truncate the index.
  private saveRegistry(): void {
    const tmp = REGISTRY_FILE + ".tmp";
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.claimed));
      fs.renameSync(tmp, REGISTRY_FILE);
    } catch (e) {
      this.log(`[housing] registry write failed: ${e}`);
    }
  }

  private remember(primary: number): void {
    if (this.claimed.indexOf(primary) !== -1) return;
    this.claimed.push(primary);
    this.saveRegistry();
  }

  private forget(primary: number): void {
    const i = this.claimed.indexOf(primary);
    if (i === -1) return;
    this.claimed.splice(i, 1);
    this.saveRegistry();
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private cleanName(raw: unknown): string {
    return String(raw || "").replace(/[^A-Za-z0-9 '_-]/g, "").trim().slice(0, MAX_NAME_LEN);
  }

  private actorOf(ctx: SystemContext, userId: number): number {
    if (userId < 0) return 0;
    try { return (ctx.svr as Mp).getUserActor(userId) >>> 0; } catch { return 0; }
  }

  private userOf(ctx: SystemContext, actorId: number): number {
    try { return (ctx.svr as Mp).getUserByActor(actorId); } catch { return -1; }
  }

  private profileOf(ctx: SystemContext, actorId: number): number {
    try { return Number((ctx.svr as Mp).get(actorId, "profileId")) || 0; } catch { return 0; }
  }

  private nameOf(ctx: SystemContext, actorId: number): string {
    try {
      const appearance = (ctx.svr as Mp).get(actorId, "appearance");
      return String((appearance && appearance.name) || "Someone");
    } catch {
      return "Someone";
    }
  }

  private onlineUsers(ctx: SystemContext): number[] {
    const mp = ctx.svr as Mp;
    const out: number[] = [];
    for (let userId = 0; userId < MAX_USER_SLOTS; userId++) {
      try { if (mp.isConnected(userId)) out.push(userId); } catch { /* slot gone */ }
    }
    return out;
  }

  private send(ctx: SystemContext, userId: number, payload: Record<string, unknown>): void {
    if (userId < 0) return;
    try { (ctx.svr as Mp).sendCustomPacket(userId, JSON.stringify(payload)); } catch { /* user gone */ }
  }

  private notice(ctx: SystemContext, userId: number, text: string): void {
    this.send(ctx, userId, { customPacketType: "propertyNotice", text });
  }

  private claimed: number[] = [];
  private partnerCache = new Map<number, number>();
  private baseTypeCache = new Map<number, string>();
  private unclaimableLogged = new Set<number>();
  private lastRequestMs = new Map<number, number>();
  private lastDenyMs = new Map<number, number>();
  private roleCfg: AdminRoleConfig = readAdminRoleConfig(null);
  private zones!: Zones;
  private zoneCache = new Map<number, string | null>();
  private maxClaims = DEFAULT_MAX_CLAIMS;
  private placeCap = 1;
  private placeMigration: "off" | "dryrun" | "apply" = "dryrun";
  private staffSetting: number[] = [];
  private initAtMs = 0;
  private placePlanDone = false;
  private placePlanTriedMs = 0;
  private placePlanTries = 0;
  private placeCells: Map<string, number> | null = null;
  private worldDescs = new Map<string, boolean>();
  private placeCellsDirty = true;
  private maxDistance = DEFAULT_MAX_DISTANCE;
  private openClaims = false;
  private decorDirty = false;
  private lastDecorMs = 0;
}
