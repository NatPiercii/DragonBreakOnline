// Where each of the owner's companions stands when it follows (Nate, 3 Oct: a GM's warband "collide with each other when
// several try to follow closely"). Every follower used to keep the same offset behind the owner, so a band of ten pushed
// for one spot. Slot 0 keeps the old spot; the rest stand in rows of three behind it, the middle first.
// Pure: no game calls, so a harness can check it.

// Offsets in the owner's own frame: x to the owner's right, y ahead of the owner (negative: behind)
export const FORMATION_FIRST_Y = -128;
export const FORMATION_SPACING = 120;
const COLUMNS = [0, -1, 1];

export const formationOffset = (slot: number): [number, number] => {
  const i = Math.max(0, Math.floor(Number(slot) || 0));
  const row = Math.floor(i / COLUMNS.length);
  const column = COLUMNS[i % COLUMNS.length];
  return [column * FORMATION_SPACING, FORMATION_FIRST_Y - row * FORMATION_SPACING];
};

// The same offset in world axes for an owner facing angleZ degrees (Skyrim: 0 is +Y, clockwise), for moveTo, whose
// offsets are world axes
export const formationWorldOffset = (slot: number, angleZ: number): [number, number] => {
  const [x, y] = formationOffset(slot);
  const rad = (Number(angleZ) || 0) * Math.PI / 180;
  return [x * Math.cos(rad) + y * Math.sin(rad), -x * Math.sin(rad) + y * Math.cos(rad)];
};
