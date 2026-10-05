// Other players this client shows in a beast's own body, as the server lists them (dboBeastBody, server beastform.js):
// werewolves and Vampire Lords. The appearance every client is sent keeps the mortal race, so a client that never
// announced the 'beastBody' UI capability never builds a beast copy; this one swaps the race in itself. Only the two beast
// races are taken. A Lord's stance (hovering or on the ground) is its relayed LevitateStart/LandStart, which formView
// applies once the copy has settled, like any beast copy's animations.
// One import with no imports of its own, so tests/beastbody-harness.js can load it after a plain transpile.
import { isBeastRaceId } from "./beastRaceIds";

const bodies = new Map<number, number>(); // remote id -> beast race

export interface BeastBodyEntry { id: number; race: number }

// The whole list replaces what was known: a beast missing from it is shown in its mortal body again
export const setBeastBodies = (list: BeastBodyEntry[]): void => {
  bodies.clear();
  for (const e of list) {
    const id = Number(e.id) >>> 0, race = Number(e.race) >>> 0;
    if (id && isBeastRaceId(race)) bodies.set(id, race);
  }
};

export const beastBodyOf = (remoteId: number | undefined | null): number => bodies.get(Number(remoteId) >>> 0) || 0;

// The packet's list, or null for anything else. Entries that are not a beast race, or have no id, are dropped
export const parseBeastBodies = (content: Record<string, unknown> | null | undefined): BeastBodyEntry[] | null => {
  if (!content || content["customPacketType"] !== "dboBeastBody" || !Array.isArray(content["bodies"])) return null;
  const out: BeastBodyEntry[] = [];
  for (const raw of content["bodies"] as unknown[]) {
    if (!raw || typeof raw !== "object") continue;
    const id = Number((raw as any).id) >>> 0, race = Number((raw as any).race) >>> 0;
    if (id && isBeastRaceId(race)) out.push({ id, race });
  }
  return out;
};

export interface BeastBodyAppearance {
  raceId: number;
  headpartIds: number[];
  tints: unknown[];
  options: number[];
  presets: number[];
  headTextureSetId: number;
}

// The bare beast look the server used to send (beastform.js beastAppearance): a mortal head on a beast body crashed watchers
export const beastBodyAppearance = <A extends BeastBodyAppearance>(appearance: A, race: number): A =>
  Object.assign({}, appearance, { raceId: race, headpartIds: [], tints: [], options: [], presets: [], headTextureSetId: 0 });
