import * as fs from "fs";
import * as path from "path";

// Patreon tiers by Discord role, from patron-tiers.json beside the server (tracked in the server repo; the
// gameplay layer's patrons.js reads the same file for identity rerolls). Re-read when the file changes.
//   tiers    best first; a player gets the first tier they hold
//   bonuses  stack on top of the tier (Pre-Alpha Tester)
//   priority tiers and every adminRoles role may use the reserved places

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

export const extraSlotsFor = (roles: string[]): number => {
  const f = read();
  const tier = f.tiers.find((t) => roles.includes(t.roleId));
  const bonus = f.bonuses.filter((b) => roles.includes(b.roleId)).reduce((n, b) => n + b.extraSlots, 0);
  return (tier ? tier.extraSlots : 0) + bonus;
};

export const isPriorityPatron = (roles: string[], staffRoleIds: string[]): boolean =>
  roles.some((r) => staffRoleIds.includes(r)) || read().tiers.some((t) => t.priority === true && roles.includes(t.roleId));

export const reservedSlots = (): number => read().reservedSlots;
