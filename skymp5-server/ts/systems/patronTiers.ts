import * as fs from "fs";
import * as path from "path";

// Patreon tiers by Discord role, from patron-tiers.json beside the server (tracked in the server repo; the
// gameplay layer's patrons.js reads the same file for identity rerolls). Re-read when the file changes.
//   tiers    best first; a player gets the first tier they hold
//   bonuses  stack on top of the tier (Pre-Alpha Tester)
//   priority tiers and every adminRoles role may use the reserved places
// extraSlotsFor also counts the slots an account earned in play (earnedSlotsFor below).

export interface PatronTier {
  id: string;
  label: string;
  roleId: string;
  extraSlots: number;
  priority?: boolean;
}

interface PatronFile {
  tiers: PatronTier[];
  bonuses: PatronTier[];
  reservedSlots: number;
}

const FILE = "patron-tiers.json";
let cache: PatronFile | null = null;
let cacheMtime = -1;

const read = (): PatronFile => {
  const p = path.resolve(FILE);
  let mtime = 0;
  try { mtime = fs.statSync(p).mtimeMs; } catch { return cache ?? { tiers: [], bonuses: [], reservedSlots: 0 }; }
  if (cache && mtime === cacheMtime) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    const clean = (list: unknown): PatronTier[] => (Array.isArray(list) ? list : [])
      .filter((t: any) => t && typeof t.roleId === "string" && t.roleId)
      .map((t: any) => ({ id: String(t.id), label: String(t.label ?? t.id), roleId: t.roleId, extraSlots: Math.max(0, Math.floor(Number(t.extraSlots) || 0)), priority: t.priority === true }));
    cache = { tiers: clean(raw.tiers), bonuses: clean(raw.bonuses), reservedSlots: Math.max(0, Math.floor(Number(raw.reservedSlots) || 0)) };
    cacheMtime = mtime;
  } catch {
    // a half-written file keeps the last good table
  }
  return cache ?? { tiers: [], bonuses: [], reservedSlots: 0 };
};

export const patronTierOf = (roles: string[]): PatronTier | null =>
  read().tiers.find((t) => roles.includes(t.roleId)) ?? null;

// Slots earned in play come from the gameplay's globalThis.__dboEarnedSlots(profileId); spawn.ts asks by roles, so login.ts ties its roles array to the profile
const g = globalThis as any;
const rolesProfile: WeakMap<string[], number> = g.__alduinakRolesProfile instanceof WeakMap
  ? g.__alduinakRolesProfile : (g.__alduinakRolesProfile = new WeakMap<string[], number>());
// The gameplay promises an earned slot only once the server build counts it
g.__alduinakEarnedSlots = true;
const MAX_EARNED = 5;
// The last answer per profile stands while the hook is missing (a failed hot reload)
const lastEarned = new Map<number, number>();

export const bindRolesToProfile = (roles: string[], profileId: number): void => {
  if (Array.isArray(roles) && Number.isInteger(profileId) && profileId >= 0) rolesProfile.set(roles, profileId);
};

export const earnedSlotsFor = (roles: string[]): number => {
  const profileId = Array.isArray(roles) ? rolesProfile.get(roles) : undefined;
  if (profileId === undefined) return 0;
  const hook = g.__dboEarnedSlots;
  if (typeof hook === "function") {
    try {
      const n = Math.max(0, Math.min(MAX_EARNED, Math.floor(Number(hook(profileId)) || 0)));
      lastEarned.set(profileId, n);
      return n;
    } catch {
      // a throwing hook keeps the last answer
    }
  }
  return lastEarned.get(profileId) ?? 0;
};

export const extraSlotsFor = (roles: string[]): number => {
  const f = read();
  const tier = f.tiers.find((t) => roles.includes(t.roleId));
  const bonus = f.bonuses.filter((b) => roles.includes(b.roleId)).reduce((n, b) => n + b.extraSlots, 0);
  return (tier ? tier.extraSlots : 0) + bonus + earnedSlotsFor(roles);
};

export const isPriorityPatron = (roles: string[], staffRoleIds: string[]): boolean =>
  roles.some((r) => staffRoleIds.includes(r)) || read().tiers.some((t) => t.priority === true && roles.includes(t.roleId));

export const reservedSlots = (): number => read().reservedSlots;
