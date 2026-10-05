// Which vanilla Smithing perks the player's own game should hold, for craftPerkService.ts. Import-free, so a harness can
// run it.
//
// The crafting menu hides a recipe whose HasPerk the player lacks, and DragonBreak grants no vanilla perks, so the
// server (masterySystem, gamemode-config craftPerkTiers) sends the perks the character's Blacksmith tier stands for:
//   { customPacketType: "dboCraftPerks", perks: [<form id>...], managed: [<form id>...] }
// The client never works out a tier. It holds `perks` and drops every other perk it manages: `managed`, the perks it
// granted itself this session, and the vanilla Smithing perks below. Perks belong to the player's game, not the
// character, so a set that is not refreshed for a new character is dropped.

// Skyrim.esm PERK records named by the forge recipes' HasPerk conditions (census of the live load order, 5 Oct 2026)
export const SMITHING_PERKS: readonly number[] = [
  0x000cb40d, // SteelSmithing
  0x000cb40e, // DwarvenSmithing
  0x000cb40f, // ElvenSmithing
  0x000cb410, // OrcishSmithing
  0x000cb411, // GlassSmithing
  0x000cb412, // EbonySmithing
  0x000cb413, // DaedricSmithing
  0x000cb414, // AdvancedArmors
  0x00052190, // DragonArmor
  0x0005218e, // ArcaneBlacksmith
];

// Never held, whatever a packet says
export const NEVER_PERKS: readonly number[] = [0x0005218e];

export const CRAFT_PERK_RECHECK_MS = 10000;
// A character spawn with no packet this recent drops the set until the server sends the new character's
export const SPAWN_PACKET_GRACE_MS = 3000;
const MAX_IDS = 64;

export interface CraftPerkSet { perks: number[]; managed: number[] }

const idList = (v: unknown): number[] | null => {
  if (!Array.isArray(v) || v.length > MAX_IDS) return null;
  const out: number[] = [];
  for (const x of v) {
    const id = Number(x);
    if (!Number.isInteger(id) || id <= 0 || id > 0xffffffff) return null;
    if (out.indexOf(id >>> 0) === -1) out.push(id >>> 0);
  }
  return out;
};

export const parseCraftPerks = (content: Record<string, unknown> | null): CraftPerkSet | null => {
  if (!content || content["customPacketType"] !== "dboCraftPerks") return null;
  const perks = idList(content["perks"]);
  const managed = idList(content["managed"]);
  if (!perks || !managed) return null;
  return { perks: perks.filter((id) => NEVER_PERKS.indexOf(id) === -1), managed };
};

export interface CraftPerkPlan { add: number[]; remove: number[] }

// What to add and what to take away, given which of the candidate perks the player holds now
export const planCraftPerks = (wanted: readonly number[], managed: readonly number[], granted: readonly number[],
                               held: (id: number) => boolean): CraftPerkPlan => {
  const want = new Set(wanted.filter((id) => NEVER_PERKS.indexOf(id) === -1));
  const candidates = new Set<number>(Array.from(want).concat(managed, granted, SMITHING_PERKS));
  const add: number[] = [];
  const remove: number[] = [];
  candidates.forEach((id) => {
    const has = held(id);
    if (want.has(id) && !has) add.push(id);
    else if (!want.has(id) && has) remove.push(id);
  });
  return { add, remove };
};

export const dropOnSpawn = (lastPacketAt: number, now: number): boolean => now - lastPacketAt > SPAWN_PACKET_GRACE_MS;
