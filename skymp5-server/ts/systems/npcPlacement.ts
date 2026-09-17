// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

export interface NpcLocation {
  cellOrWorldDesc: string;
  pos: number[];
  rot: number[];
}

// Keeps the engine from reviving placed NPCs; delays past ~1e9 s overflow its timer and fire at once
export const NEVER_RESPAWN = 1e9;

// Neighbor-visible flag (registered in the gamemode) telling clients the NPC attacks players on sight
export const HOSTILE_PROP = "ff_hostile";

// PlaceAtMe needs a self ref (anchorId); the new reference starts at the anchor's position and cell; throws on failure
export const placeAtMe = (mp: Mp, anchorId: number, baseDesc: string): number => {
  const self = { type: "form", desc: mp.getDescFromId(anchorId) };
  const res = mp.callPapyrusFunction("method", "ObjectReference", "PlaceAtMe",
    self, [{ type: "espm", desc: baseDesc }, 1, false, false]);
  if (!res?.desc) throw new Error("PlaceAtMe returned no reference");
  return mp.getIdFromDesc(res.desc);
};

// The anchor is usually a player nearby; the new actor then moves to loc and never respawns on its own
export const placeNpc = (mp: Mp, anchorId: number, baseDesc: string, loc: NpcLocation): number => {
  const id = placeAtMe(mp, anchorId, baseDesc);
  mp.set(id, "locationalData", loc);
  mp.set(id, "spawnPoint", loc);
  mp.set(id, "spawnDelay", NEVER_RESPAWN);
  // The move above never reaches clients already watching the anchor; disable/enable re-sends the actor at loc
  mp.set(id, "isDisabled", true);
  mp.set(id, "isDisabled", false);
  assertPlacedIn(mp, id, loc);
  assertStandingAt(mp, id, loc);
  return id;
};

const sameCell = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

// PlaceAtMe creates the actor in the anchor's own cell. When the anchor sits inside an interior the
// move can leave the actor there: it looks right to every client but the server has it in another
// cell, so hits on it are refused as a worldspace mismatch. One retry, then give the slot up.
const assertPlacedIn = (mp: Mp, id: number, loc: NpcLocation): void => {
  let where = "";
  try { where = String(mp.get(id, "worldOrCellDesc") || ""); } catch (e) { return; }
  if (!where || sameCell(where, loc.cellOrWorldDesc)) return;

  mp.set(id, "locationalData", loc);
  mp.set(id, "isDisabled", true);
  mp.set(id, "isDisabled", false);
  try { where = String(mp.get(id, "worldOrCellDesc") || ""); } catch (e) { return; }
  if (sameCell(where, loc.cellOrWorldDesc)) return;

  try { mp.destroyActor(id); } catch (e) { /* already gone */ }
  throw new Error(`placed in ${where}, expected ${loc.cellOrWorldDesc}`);
};

// The cell can be right while the position is still the anchor's, which puts an enemy on the player
const PLACE_TOLERANCE = 256;

const assertStandingAt = (mp: Mp, id: number, loc: NpcLocation): void => {
  const offBy = (): number => {
    let pos: number[] = [];
    try { pos = mp.getActorPos(id); } catch (e) { return 0; }
    if (!Array.isArray(pos) || pos.length < 3) return 0;
    return Math.hypot(pos[0] - loc.pos[0], pos[1] - loc.pos[1], pos[2] - loc.pos[2]);
  };
  if (offBy() <= PLACE_TOLERANCE) return;

  mp.set(id, "locationalData", loc);
  mp.set(id, "isDisabled", true);
  mp.set(id, "isDisabled", false);
  const still = offBy();
  if (still <= PLACE_TOLERANCE) return;

  try { mp.destroyActor(id); } catch (e) { /* already gone */ }
  throw new Error(`stayed ${Math.round(still)} units from its spot in ${loc.cellOrWorldDesc}`);
};
