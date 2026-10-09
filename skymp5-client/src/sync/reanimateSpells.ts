import { Enchantment, Game, Scroll, Spell } from "skyrimPlatform";

// The magic effects with the Reanimate archetype (MGEF DATA 0x40 = 22) in the server's load order, read from the plugins
const REANIMATE_EFFECTS: [number, string][] = [
  [0x78f5f, "BSHeartland.esm"], [0x7cb4, "Dawnguard.esm"], [0xd3bf, "Dawnguard.esm"], [0xd3c1, "Dawnguard.esm"],
  [0x16b4b, "Skyrim.esm"], [0x16c0f, "Skyrim.esm"], [0x16c3b, "Skyrim.esm"], [0x16c3d, "Skyrim.esm"],
  [0x369c9, "Skyrim.esm"], [0x65bd6, "Skyrim.esm"], [0x7e8e0, "Skyrim.esm"], [0x96d0b, "Skyrim.esm"],
  [0x96d0c, "Skyrim.esm"], [0x96d0d, "Skyrim.esm"], [0xe152a, "Skyrim.esm"],
];

let effectIds: Set<number> | null = null;
const verdicts = new Map<number, boolean>();

// Ids only are kept: a native object expires at the end of the frame
const reanimateEffectIds = (): Set<number> => {
  if (effectIds) return effectIds;
  effectIds = new Set<number>();
  for (const [local, file] of REANIMATE_EFFECTS) {
    const f = Game.getFormFromFile(local, file);
    if (f) effectIds.add(f.getFormID() >>> 0);
  }
  return effectIds;
};

// Whether a spell, scroll or staff enchantment raises the dead
export const isReanimateSpell = (spellId: number): boolean => {
  const id = spellId >>> 0;
  const known = verdicts.get(id);
  if (known !== undefined) return known;
  const form = Game.getFormEx(id);
  const magic = Spell.from(form) || Scroll.from(form) || Enchantment.from(form);
  let found = false;
  if (magic) {
    const ids = reanimateEffectIds();
    for (let i = 0; i < magic.getNumEffects() && !found; i++) {
      const effect = magic.getNthEffectMagicEffect(i);
      found = !!effect && ids.has(effect.getFormID() >>> 0);
    }
  }
  verdicts.set(id, found);
  return found;
};
