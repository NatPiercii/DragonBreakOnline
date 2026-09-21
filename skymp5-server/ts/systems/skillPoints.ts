// The arithmetic of the skill point system (server\SKILLS_DESIGN.md §3, §5, §10).
//
// Kept apart from masterySystem.ts on purpose: everything here is pure, so it can be exercised without a
// server, a world or a player. masterySystem owns the record, the espm lookups and the notices; this file
// owns levels, bands, weights, the token bucket, the daily caps and who gives up points when the pool is full.
//
// Levels run 0..100. 0 means never touched. 100 xp make one level, and a level costs a different number of
// validated units of work in each band, so the ladder is flat early and brutal at the top:
//
//   band      xp per unit   units per level   cumulative units at the top of the band
//   0-24      10            10                250   (level 25)
//   25-49     5             20                750   (level 50)
//   50-74     2.5           40                1750  (level 75)
//   75-89     1.25          80                2950  (level 90)
//   90-94     0.5           200               3950  (level 95)
//   95-99     0.25          400               5950  (level 100)

export const MAX_LEVEL = 100;
export const XP_PER_LEVEL = 100;

// [firstLevelOfBand, xpPerUnit]
const XP_BANDS: Array<[number, number]> = [[0, 10], [25, 5], [50, 2.5], [75, 1.25], [90, 0.5], [95, 0.25]];

export const xpPerUnitAt = (level: number): number => {
  let xp = XP_BANDS[0][1];
  for (const [from, perUnit] of XP_BANDS) if (level >= from) xp = perUnit;
  return xp;
};

// Tier bands, the five names the whole gameplay layer already reads: Novice 1-24, Apprentice 25-49,
// Journeyman 50-74, Expert 75-89, Master 90-100. Level 0 is "never touched" and has no tier.
const TIER_FLOORS = [1, 25, 50, 75, 90];
export const tierOfLevel = (level: number): number => {
  if (level < 1) return -1;
  let tier = 0;
  for (let i = 0; i < TIER_FLOORS.length; i++) if (level >= TIER_FLOORS[i]) tier = i;
  return tier;
};
export const levelFloorOfTier = (tier: number): number => TIER_FLOORS[Math.max(0, Math.min(tier, TIER_FLOORS.length - 1))];

/** Units of validated work to carry a skill from 0 to `level`. The inverse of `levelFromUnits`. */
export const unitsForLevel = (level: number): number => {
  let units = 0;
  for (let l = 0; l < Math.max(0, Math.min(level, MAX_LEVEL)); l++) units += XP_PER_LEVEL / xpPerUnitAt(l);
  return units;
};

/** The level `units` of work reaches from nothing, and the xp left over inside it. */
export const levelFromUnits = (units: number): { level: number; xp: number } => {
  let left = Math.max(0, units), level = 0;
  while (level < MAX_LEVEL) {
    const cost = XP_PER_LEVEL / xpPerUnitAt(level);
    if (left < cost) break;
    left -= cost; level++;
  }
  return { level, xp: level >= MAX_LEVEL ? 0 : Math.round(left * xpPerUnitAt(level)) };
};

/** Add work to one skill. Returns the new level/xp and how many levels were gained (may be 0). */
export const addUnits = (level: number, xp: number, units: number, cap = MAX_LEVEL): { level: number; xp: number; gained: number } => {
  let lv = Math.max(0, Math.min(level, cap)), x = Math.max(0, xp), gained = 0;
  let left = Math.max(0, units);
  while (left > 0 && lv < cap) {
    x += left * xpPerUnitAt(lv);
    left = 0;
    while (x >= XP_PER_LEVEL && lv < cap) { x -= XP_PER_LEVEL; lv++; gained++; }
  }
  return { level: lv, xp: lv >= cap ? 0 : x, gained };
};

/** Take `units` of work back off a skill, never below `floor`. Returns what it could actually give up. */
export const removeUnits = (level: number, xp: number, units: number, floor: number): { level: number; xp: number; taken: number } => {
  let lv = level, x = xp, left = Math.max(0, units), taken = 0;
  while (left > 0 && (lv > floor || (lv === floor && x > 0))) {
    const perUnit = xpPerUnitAt(lv > 0 ? lv - 1 : 0);
    const here = Math.min(left, x / perUnit);
    if (here > 0) { x -= here * perUnit; left -= here; taken += here; }
    if (left <= 0) break;
    if (lv <= floor) break;
    lv--; x = XP_PER_LEVEL;            // step down a level and spend it from the top
  }
  if (lv <= floor && x <= 0) { lv = floor; x = 0; }
  return { level: lv, xp: Math.max(0, x), taken };
};

// ── weights ────────────────────────────────────────────────────────────────────────────────────────
// What one act is worth before the bucket meters it. The bucket caps work per hour, so weight decides
// which work fills the hour, never how much progress an hour can hold.

export type WeightInput = { kind: string; value?: number };
export const weightOf = ({ kind, value = 0 }: WeightInput): number => {
  const v = Number.isFinite(value) ? Math.max(0, value) : 0;
  switch (kind) {
    case "craft": return clampW(0.5 + Math.min(2.5, v / 400));       // product gold value
    // A kill is scaled by the victim's ACBS level, not its max health: max health is not readable
    // server-side (percentages are 0..1 and GetBaseActorValues has no property binding), so the
    // honest measure available is the level. Most levelled NPCs report their calculated minimum,
    // so a bandit sits near the base and a fixed-level giant or dragon earns the top of the range.
    case "kill": return clampW(0.5 + Math.min(1.5, v / 40));         // victim level
    case "hit": return 0.5;                                          // too hot a path to price per blow
    case "cast": return clampW(0.5 + Math.min(1.0, v / 150));        // magicka cost
    case "hurt": return clampW(0.5 + Math.min(1.5, v / 40));         // damage taken
    case "mine": return clampW(1 + Math.min(1, v / 4));              // ore band 0..4
    case "skin": return clampW(1 + Math.min(1, v / 100));            // pelt gold value 0..300, 100+ is Master
    case "chop": case "read": case "lock": case "prayer": return 1;
    case "activate": case "eat": return 0.5;
    default: return 0.5;
  }
};
const clampW = (w: number): number => Math.max(0.5, Math.min(3, Math.round(w * 100) / 100));

/**
 * Repetition decay: the k-th act on the same target/station/recipe within the window is worth w/(1+k/8).
 * The ring is persisted with the character, because an in-memory map is cleared by a relog - which is a
 * two-key macro. Returns the multiplier and the ring to store back.
 */
export type NoveltyEntry = { h: number; at: number };
export const repetitionFactor = (ring: NoveltyEntry[], hash: number, now: number, windowMs = 3600000, size = 16): { factor: number; ring: NoveltyEntry[] } => {
  const fresh = (Array.isArray(ring) ? ring : []).filter((e) => e && now - e.at < windowMs);
  const k = fresh.filter((e) => e.h === hash).length;
  const next = fresh.concat([{ h: hash, at: now }]);
  return { factor: 1 / (1 + k / 8), ring: next.slice(-size) };
};

// ── the token bucket ───────────────────────────────────────────────────────────────────────────────

export type Bucket = { tokens: number; at: number };
export const bucketAfterRefill = (b: Bucket | undefined, now: number, perHour: number, burst: number): Bucket => {
  if (!b || !Number.isFinite(b.tokens) || !Number.isFinite(b.at)) return { tokens: burst, at: now };
  const gained = ((now - b.at) / 3600000) * perHour;
  return { tokens: Math.max(0, Math.min(burst, b.tokens + gained)), at: now };
};

/** Spend up to `want` units; returns what the bucket could actually pay for. */
export const bucketSpend = (b: Bucket, want: number): { bucket: Bucket; spent: number } => {
  const spent = Math.max(0, Math.min(want, b.tokens));
  return { bucket: { tokens: b.tokens - spent, at: b.at }, spent };
};

/** The day's ceiling for one skill, tighter the higher it already is (the calendar floor at the top). */
export const dailyCapForLevel = (level: number, caps: { low: number; expert: number; master: number }): number =>
  level >= 90 ? caps.master : level >= 75 ? caps.expert : caps.low;

// ── structural caps ────────────────────────────────────────────────────────────────────────────────
// One Seat above `seatAbove`, `expertCount` skills above `expertAbove`. A gain that would break either
// stops at the ceiling instead of being refused, so nobody is blocked from working - they just stop rising.

export type SkillLevels = Record<string, number>;
export const structuralCap = (
  levels: SkillLevels, id: string,
  opts: { capPerSkill: number; seatAbove: number; seatCount: number; expertAbove: number; expertCount: number },
): number => {
  const mine = levels[id] || 0;
  const others = Object.entries(levels).filter(([k]) => k !== id).map(([, v]) => v);
  const seats = others.filter((v) => v > opts.seatAbove).length;
  const experts = others.filter((v) => v > opts.expertAbove).length;
  if (mine > opts.seatAbove) return opts.capPerSkill;                       // already holds the Seat
  let cap = opts.capPerSkill;
  if (seats >= opts.seatCount) cap = Math.min(cap, opts.seatAbove);
  if (mine <= opts.expertAbove && experts >= opts.expertCount) cap = Math.min(cap, opts.expertAbove);
  return cap;
};

// ── the pool, and who gives way ────────────────────────────────────────────────────────────────────

export type Lock = "raise" | "hold" | "lower";
export type PoolSkill = { id: string; level: number; xp: number; lock: Lock; lastPointAt?: number };

export const poolUsed = (skills: PoolSkill[]): number => skills.reduce((n, s) => n + s.level, 0);

/**
 * Donors for `units` of overflow, in the order the design sets: everything marked to fall first, highest
 * level first; then the lowest ▲ skill still above the floor. Never ■, never below the floor, never the
 * skill that is gaining. Returns the deductions to apply and whatever it could not cover.
 */
export const chooseDonors = (skills: PoolSkill[], gainingId: string, units: number, floor: number): { from: Array<{ id: string; units: number }>; short: number } => {
  const able = (s: PoolSkill) => s.id !== gainingId && s.lock !== "hold" && s.level > floor;
  const lower = skills.filter((s) => able(s) && s.lock === "lower").sort((a, b) => b.level - a.level);
  const raise = skills.filter((s) => able(s) && s.lock === "raise").sort((a, b) => a.level - b.level);
  const out: Array<{ id: string; units: number }> = [];
  let left = units;
  for (const s of lower.concat(raise)) {
    if (left <= 0) break;
    const available = unitsForLevel(s.level) + (s.xp / xpPerUnitAt(s.level)) - unitsForLevel(floor);
    const take = Math.min(left, Math.max(0, available));
    if (take <= 0) continue;
    out.push({ id: s.id, units: take });
    left -= take;
  }
  return { from: out, short: Math.max(0, left) };
};

// ── migration from the hours record ────────────────────────────────────────────────────────────────
// The old record counted validated hours, one point an hour, with tiers at 0/10/30/70/150. At 30 units an
// hour every live character lands just inside the tier they already hold: 10h->27, 30h->53, 70h->79, 150h->96.

export const UNITS_PER_OLD_HOUR = 30;
export const levelFromOldPoints = (points: number): { level: number; xp: number } =>
  levelFromUnits(Math.max(0, Number(points) || 0) * UNITS_PER_OLD_HOUR);

// ── applying a gain to a whole record ──────────────────────────────────────────────────────────────
// Kept pure so the rules can be tested without a server. masterySystem supplies the record, the units and
// the clock; this decides what the record becomes and what the player should be told.

export type PointConfig = {
  pool: number; capPerSkill: number;
  seatAbove: number; seatCount: number; expertAbove: number; expertCount: number;
  transferFloor: number; firstTouchCost: number;
  bucketBurst: number; bucketPerHour: number;
  dailyCaps: { low: number; expert: number; master: number }; characterDaily: number;
};

export type PointSkill = { level: number; xp: number; lock: Lock; bucket?: Bucket; ring?: NoveltyEntry[]; day?: string; spentToday?: number; lastPointAt?: number };
export type PointRecord = { skills: Record<string, PointSkill>; spentToday?: number; day?: string };

export type GainOutcome = {
  gained: number;              // levels gained by the skill that worked
  units: number;               // units the bucket and the caps actually allowed
  tookFrom: Array<{ id: string; units: number; levels: number }>;
  refused?: "bucket" | "daily" | "cap" | "pool";
};

const dayKey = (now: number): string => new Date(now).toISOString().slice(0, 10);

/**
 * Apply `rawUnits` of validated work to one skill. Meters it through the token bucket, the per-skill and
 * per-character daily caps and the structural caps, then takes any pool overflow from a donor.
 * Mutates nothing: returns the outcome, with the record updated in place on the caller's copy.
 */
export const applyGain = (rec: PointRecord, id: string, rawUnits: number, cfg: PointConfig, now: number): GainOutcome => {
  const s = rec.skills[id] || (rec.skills[id] = { level: 0, xp: 0, lock: "raise" });
  const today = dayKey(now);
  if (s.day !== today) { s.day = today; s.spentToday = 0; }
  if (rec.day !== today) { rec.day = today; rec.spentToday = 0; }

  // 1. the bucket: what an hour can hold, whatever the work was worth
  const bucket = bucketAfterRefill(s.bucket, now, cfg.bucketPerHour, cfg.bucketBurst);
  const spend = bucketSpend(bucket, Math.max(0, rawUnits));
  s.bucket = spend.bucket;
  if (spend.spent <= 0) return { gained: 0, units: 0, tookFrom: [], refused: "bucket" };

  // 2. the daily ceilings, tighter the higher the skill already is
  const skillLeft = Math.max(0, dailyCapForLevel(s.level, cfg.dailyCaps) - (s.spentToday || 0));
  const charLeft = Math.max(0, cfg.characterDaily - (rec.spentToday || 0));
  const units = Math.min(spend.spent, skillLeft, charLeft);
  if (units <= 0) return { gained: 0, units: 0, tookFrom: [], refused: "daily" };
  s.spentToday = (s.spentToday || 0) + units;
  rec.spentToday = (rec.spentToday || 0) + units;
  s.lastPointAt = now;

  // 3. the ceiling this skill may rise to right now
  const levels: SkillLevels = {};
  for (const [k, v] of Object.entries(rec.skills)) levels[k] = v.level;
  const cap = structuralCap(levels, id, cfg);
  if (s.level >= cap) return { gained: 0, units, tookFrom: [], refused: "cap" };

  // 4. the pool: a gain past it has to come from somewhere
  const before = s.level;
  const grown = addUnits(s.level, s.xp, units, cap);
  const used = poolUsed(Object.entries(rec.skills).map(([k, v]) => ({ id: k, level: k === id ? grown.level : v.level, xp: v.xp, lock: v.lock })));
  const tookFrom: Array<{ id: string; units: number; levels: number }> = [];
  if (used > cfg.pool) {
    const overflowLevels = used - cfg.pool;
    const donorUnits = unitsForLevel(grown.level) - unitsForLevel(Math.max(0, grown.level - overflowLevels));
    const pool = Object.entries(rec.skills).map(([k, v]) => ({ id: k, level: v.level, xp: v.xp, lock: v.lock, lastPointAt: v.lastPointAt }));
    const donors = chooseDonors(pool, id, donorUnits, cfg.transferFloor);
    if (donors.short > 0 && !donors.from.length) return { gained: 0, units, tookFrom: [], refused: "pool" };
    for (const d of donors.from) {
      const t = rec.skills[d.id];
      const wasLevel = t.level;
      const after = removeUnits(t.level, t.xp, d.units, cfg.transferFloor);
      t.level = after.level; t.xp = after.xp;
      tookFrom.push({ id: d.id, units: after.taken, levels: wasLevel - after.level });
    }
    // whatever the donors could not cover is simply not gained
    if (donors.short > 0) {
      const allowed = Math.max(0, cfg.pool - poolUsed(Object.entries(rec.skills).filter(([k]) => k !== id).map(([k, v]) => ({ id: k, level: v.level, xp: v.xp, lock: v.lock }))));
      const capped = addUnits(before, s.xp, units, Math.min(cap, allowed));
      s.level = capped.level; s.xp = capped.xp;
      return { gained: capped.level - before, units, tookFrom, refused: "pool" };
    }
  }
  s.level = grown.level; s.xp = grown.xp;
  return { gained: grown.level - before, units, tookFrom };
};

/** The first time a character sets hand to a gated station: costs one level from the pool. */
export const firstTouch = (rec: PointRecord, id: string, cfg: PointConfig): boolean => {
  const s = rec.skills[id];
  if (s && s.level >= 1) return true;
  const pool = Object.entries(rec.skills).map(([k, v]) => ({ id: k, level: v.level, xp: v.xp, lock: v.lock }));
  if (poolUsed(pool) + cfg.firstTouchCost > cfg.pool) return false;
  rec.skills[id] = { level: Math.max(1, cfg.firstTouchCost), xp: 0, lock: "raise" };
  return true;
};

/** `order` and `rank` as the gameplay layer still reads them: everything ever touched, strongest first. */
export const derivedOrder = (rec: PointRecord): string[] =>
  Object.entries(rec.skills).filter(([, v]) => v.level >= 1).sort((a, b) => b[1].level - a[1].level).map(([k]) => k);
