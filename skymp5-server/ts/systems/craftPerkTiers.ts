import * as fs from "fs";
import * as path from "path";

// Which vanilla Smithing perks a recipe may ask for, and the Blacksmith tier (1..5) that stands in for each.
// DragonBreak grants no vanilla perks, so the C++ craft check asks the gamemode (onCraftPerkRequired) whether the
// crafter counts as holding one; masterySystem answers from this table and the crafter's tier in the skill.
// Read from gamemode-config.json "craftPerkTiers" beside the server and re-read when the file changes:
//   { "skill": "blacksmith", "perks": { "<perk editor id>": <tier 1..5>, ... } }
// A perk not listed stays locked. Without the key the defaults below apply; an empty "perks" turns the stand-in off.
// The player's own game needs the perks too, or its crafting menu hides the recipes: masterySystem sends
//   { customPacketType: "dboCraftPerks", perks: [<form id>...], managed: [<form id>...] }
// at every character assignment and whenever the set changes; the client holds `perks` and drops the rest of `managed`.

export interface CraftPerkTiers {
  skill: string;
  perks: Map<string, number>;
}

export const DEFAULT_CRAFT_PERK_TIERS: Record<string, number> = {
  SteelSmithing: 2, ElvenSmithing: 2, DwarvenSmithing: 2,
  AdvancedArmors: 3, OrcishSmithing: 3,
  GlassSmithing: 4, EbonySmithing: 4,
  DaedricSmithing: 5, DragonArmor: 5,
};

// Never granted, whatever the config says: its recipes are tempering and enchanted sets, not a metal tier
const NEVER = new Set(["arcaneblacksmith"]);

const FILE = "gamemode-config.json";
const KEY = "craftPerkTiers";
const MAX_TIER = 5;

export const parseCraftPerkTiers = (raw: unknown): CraftPerkTiers => {
  const o = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const skill = typeof o.skill === "string" && o.skill ? o.skill : "blacksmith";
  const src = o.perks && typeof o.perks === "object" ? o.perks as Record<string, unknown> : DEFAULT_CRAFT_PERK_TIERS;
  const perks = new Map<string, number>();
  for (const [edid, v] of Object.entries(src)) {
    const tier = Math.floor(Number(v));
    if (!edid.startsWith("_") && !NEVER.has(edid.toLowerCase()) && tier >= 1 && tier <= MAX_TIER) perks.set(edid.toLowerCase(), tier);
  }
  return { skill, perks };
};

// Every skill write asks, so the file is looked at no more than once a second
const CHECK_MS = 1000;

let cache: CraftPerkTiers | null = null;
let cacheMtime = -1;
let checkedAt = 0;

export const readCraftPerkTiers = (): CraftPerkTiers => {
  const now = Date.now();
  if (cache && now - checkedAt < CHECK_MS) return cache;
  checkedAt = now;
  const p = path.resolve(FILE);
  let mtime = 0;
  try { mtime = fs.statSync(p).mtimeMs; } catch { return (cache = cache ?? parseCraftPerkTiers(null)); }
  if (cache && mtime === cacheMtime) return cache;
  try {
    cache = parseCraftPerkTiers(JSON.parse(fs.readFileSync(p, "utf8"))[KEY]);
    cacheMtime = mtime;
  } catch {
    // a half-written file keeps the last good table
  }
  return (cache = cache ?? parseCraftPerkTiers(null));
};

// The tier a perk needs, 0 when the table does not list it
export const perkTierOf = (table: CraftPerkTiers, perkEditorId: string): number =>
  table.perks.get(perkEditorId.toLowerCase()) || 0;

export const craftPerkHeld = (table: CraftPerkTiers, perkEditorId: string, crafterTier: number): boolean => {
  const need = perkTierOf(table, perkEditorId);
  return need > 0 && crafterTier >= need;
};

export interface CraftPerkPacket {
  perks: number[];
  managed: number[];
}

// The perks a crafter of this tier holds, and every perk of the table, as form ids (`ids`: lower-case editor id -> form id)
export const craftPerkPacket = (table: CraftPerkTiers, ids: Map<string, number>, crafterTier: number): CraftPerkPacket => {
  const perks: number[] = [];
  const managed: number[] = [];
  for (const [edid, need] of table.perks) {
    const id = ids.get(edid);
    if (!id) continue;
    managed.push(id);
    if (crafterTier >= need) perks.push(id);
  }
  return { perks: perks.sort((a, b) => a - b), managed: managed.sort((a, b) => a - b) };
};
