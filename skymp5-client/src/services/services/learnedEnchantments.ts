// The packet that gives a character back the enchantments it learned by disenchanting (server alchemy.js, dboEnchLearned):
// { customPacketType: "dboEnchLearned", effects: number[] }, magic effect ids. Anything else, or a malformed list, is null.
export const LEARNED_MAX = 512;

export const readLearned = (content: Record<string, unknown> | null | undefined): number[] | null => {
  if (!content || content["customPacketType"] !== "dboEnchLearned" || !Array.isArray(content["effects"])) return null;
  const out: number[] = [];
  for (const raw of (content["effects"] as unknown[]).slice(0, LEARNED_MAX)) {
    const id = Number(raw);
    if (Number.isInteger(id) && id > 0 && id < 0xff000000 && out.indexOf(id >>> 0) < 0) out.push(id >>> 0);
  }
  return out;
};
