// Staff hits for hitService.ts, import-free so a harness can drive it.
// A staff hit is sent with source = its ENCH, whether the engine names the staff or the enchantment; the server checks the staff is held.
// The staff trace writes one "staff shot" line per shot while the server holds a window open; only plain numbers are kept.
//   Server -> Client: { customPacketType: "dboStaffDiag", seconds: <30..900> }
//   Client -> Server: { customPacketType: "dbo", event: "staffShot", args: ["<line>"] }

/** Papyrus Weapon.GetWeaponType: 8 is a staff */
export const STAFF_WEAPON_TYPE = 8;

export const MIN_DIAG_MS = 30000;
export const MAX_DIAG_MS = 900000;
export const DEFAULT_DIAG_MS = 600000;

/** One shot: the hit events for one aggressor and target that arrive within this long of the first */
export const SHOT_MS = 200;
export const MAX_LINES = 60;
/** After this many lines, one line per aggressor and source per second */
export const FREE_LINES = 10;
export const LINE_EVERY_MS = 1000;

/** What one hand holds, read inside the hit event */
export interface HeldWeapon { id: number; weaponType: number; enchId: number }

/** A hit event reduced to numbers */
export interface HitFacts {
  sourceId: number;
  /** Form.getType() of the source, 0 when unreadable */
  sourceType: number;
  isWeapon: boolean;
  isSpell: boolean;
  isScroll: boolean;
  isEnchantment: boolean;
  /** For a weapon source: getWeaponType() and its enchantment's id (0 for none) */
  weaponType: number;
  weaponEnchId: number;
  /** The aggressor's right and left hand weapons, null for an empty hand or an aggressor that is not an actor */
  right: HeldWeapon | null;
  left: HeldWeapon | null;
}

export type HitRoute =
  | { kind: "weapon" | "spell" | "scroll" }
  | { kind: "staff"; enchId: number; via: "weapon" | "enchantment" }
  | { kind: "drop"; why: string };

const dynamic = (id: number) => id >= 0xff000000;

/** How a hit is reported to the server: a weapon, spell or scroll as before, a staff hit as its enchantment, or not at all */
export function routeHit(f: HitFacts): HitRoute {
  if (f.isWeapon) {
    if (f.weaponType !== STAFF_WEAPON_TYPE) return { kind: "weapon" };
    // A staff does no physical damage: reported only as its enchantment, never as a weapon hit
    if (!f.weaponEnchId) return { kind: "drop", why: "staff without enchantment" };
    if (dynamic(f.weaponEnchId)) return { kind: "drop", why: "dynamic enchantment" };
    return { kind: "staff", enchId: f.weaponEnchId, via: "weapon" };
  }
  if (f.isSpell) return { kind: "spell" };
  if (f.isScroll) return { kind: "scroll" };
  if (f.isEnchantment) {
    if (!f.sourceId || dynamic(f.sourceId)) return { kind: "drop", why: "dynamic enchantment" };
    // Only a staff the aggressor holds: an enchanted sword's enchantment stays out of this route
    const held = [f.right, f.left].some((w) => !!w && w.weaponType === STAFF_WEAPON_TYPE && w.enchId === f.sourceId);
    if (!held) return { kind: "drop", why: "enchantment not on a held staff" };
    return { kind: "staff", enchId: f.sourceId, via: "enchantment" };
  }
  return { kind: "drop", why: "other source" };
}

/** Whether the trace looks at this hit: anything staff-like, and anything that is not a weapon, spell or scroll */
export function traced(f: HitFacts): boolean {
  if (f.isWeapon) return f.weaponType === STAFF_WEAPON_TYPE;
  return !f.isSpell && !f.isScroll;
}

/** The window the server asked for, clamped, or null when the packet is not a request */
export function readStaffDiagRequest(content: Record<string, unknown> | null | undefined): number | null {
  if (!content || content["customPacketType"] !== "dboStaffDiag") return null;
  const s = Number(content["seconds"]);
  if (!Number.isFinite(s) || s <= 0) return DEFAULT_DIAG_MS;
  return Math.min(MAX_DIAG_MS, Math.max(MIN_DIAG_MS, Math.round(s * 1000)));
}

const hex = (n: number) => (n >>> 0).toString(16);

function sourceLabel(f: HitFacts): string {
  if (f.isWeapon) return `WEAP ${hex(f.sourceId)} (type ${f.sourceType}, weapon type ${f.weaponType}, ench ${f.weaponEnchId ? hex(f.weaponEnchId) : "-"})`;
  if (f.isEnchantment) return `ENCH ${hex(f.sourceId)} (type ${f.sourceType})`;
  return `OTHER ${f.sourceId ? hex(f.sourceId) : "none"} (type ${f.sourceType})`;
}

function handLabel(w: HeldWeapon | null): string {
  return w ? `${hex(w.id)} (weapon type ${w.weaponType}) ench ${w.enchId ? hex(w.enchId) : "-"}` : "-";
}

function sentLabel(r: HitRoute): string {
  if (r.kind === "staff") return `ENCH ${hex(r.enchId)} (via ${r.via})`;
  if (r.kind === "drop") return `dropped (${r.why})`;
  return r.kind;
}

interface Shot { firstAt: number; head: string; sources: Set<string>; events: number; deduped: number; sent: string }

/** Collects the hit events of each shot and writes one line per shot while a window is open */
export class StaffShotTrace {
  constructor(private write: (line: string) => void) {}

  open(ms: number, now: number): void {
    this.until = now + ms;
    this.lines = 0;
    this.shots.clear();
    this.lastLine.clear();
  }

  isOpen(now: number): boolean {
    return now < this.until && this.lines < MAX_LINES;
  }

  /** One hit event. deduped: the client's magic dedupe swallowed it, so nothing was sent for this event */
  record(now: number, aggressor: number, target: number, projectile: number, f: HitFacts, route: HitRoute, deduped: boolean): void {
    if (!this.isOpen(now) || !traced(f)) return;
    const key = `${hex(aggressor)}:${hex(target)}`;
    let shot = this.shots.get(key);
    if (shot && now - shot.firstAt >= SHOT_MS) {
      this.flushShot(key, shot);
      shot = undefined;
    }
    const source = sourceLabel(f);
    if (!shot) {
      shot = {
        firstAt: now,
        head: `aggr ${hex(aggressor)} -> tgt ${hex(target)} | source ${source} proj ${projectile ? hex(projectile) : "-"} | equipped R ${handLabel(f.right)}, L ${handLabel(f.left)}`,
        sources: new Set([source]), events: 0, deduped: 0, sent: deduped ? "dropped (dedupe)" : sentLabel(route),
      };
      this.shots.set(key, shot);
    }
    shot.sources.add(source);
    shot.events++;
    if (deduped) shot.deduped++;
  }

  /** Writes every shot whose 200 ms are over; called each update */
  flush(now: number): void {
    if (!this.shots.size) return;
    this.shots.forEach((shot, key) => {
      if (now - shot.firstAt >= SHOT_MS) this.flushShot(key, shot);
    });
  }

  private flushShot(key: string, shot: Shot): void {
    this.shots.delete(key);
    if (this.lines >= MAX_LINES) return;
    // Past the first lines a held concentration staff would fill the window: one line per aggressor and source a second
    const rateKey = `${key.split(":")[0]}|${Array.from(shot.sources)[0]}`;
    const last = this.lastLine.get(rateKey);
    if (this.lines >= FREE_LINES && last !== undefined && shot.firstAt - last < LINE_EVERY_MS) return;
    this.lastLine.set(rateKey, shot.firstAt);
    this.lines++;
    const others = shot.sources.size > 1 ? ` | also ${Array.from(shot.sources).slice(1).join("; ")}` : "";
    this.write(`staff shot: ${shot.head} | events ${shot.events}${shot.deduped ? ` (${shot.deduped} deduped)` : ""}${others} | sent ${shot.sent}`);
  }

  private until = 0;
  private lines = 0;
  private shots: Map<string, Shot> = new Map();
  private lastLine: Map<string, number> = new Map();
}
