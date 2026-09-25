// Where a hosted NPC is reported to be: its body, not its reference, when the two part (NPC system v2, phase 1).
//
// On the host an NPC's reference position and its 3D body drift apart (the npcDrift "split"), and the reference was
// sent: the server held an ogre 212 units under the terrain while it stood on the path on its host's screen, and
// correcting that reference floated the body (playtest 2026-09-25; the terrain data matched both players' real height
// to 1-2 units). So once they part by more than BODY_SPLIT_UNITS, the body's root node is reported, less the height
// that root normally sits above the reference. That height differs between skeletons, so each actor learns its own
// from its first samples after loading, while body and reference are still together; splits come later (the ogre's
// was straight down with x/y equal), so it is not relearned until the actor unloads. No game API here, so it is tested
// in node (server/tests/bodypos-harness.js).

export type Vec3 = [number, number, number];

const BODY_SPLIT_UNITS = 48;
const TOGETHER_XY = 8;
const LEARN_SAMPLES = 5;
const MAX_ROOT_OFFSET = 300;
const MAX_TRACKED = 2048;

const learnedOffset = new Map<number, { z: number; samples: number }>();

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export const reportedPos = (id: number, ref: Vec3, body: Vec3): Vec3 => {
  if (!body.every((v) => Number.isFinite(v))) return ref;
  const dz = body[2] - ref[2];
  let learned = learnedOffset.get(id);
  if (!learned || learned.samples < LEARN_SAMPLES) {
    if (Math.hypot(body[0] - ref[0], body[1] - ref[1]) <= TOGETHER_XY && Math.abs(dz) <= MAX_ROOT_OFFSET) {
      if (!learned) {
        if (learnedOffset.size >= MAX_TRACKED) learnedOffset.clear();
        learnedOffset.set(id, learned = { z: dz, samples: 0 });
      }
      learned.z = (learned.z * learned.samples + dz) / (learned.samples + 1);
      learned.samples++;
    }
    return ref;
  }
  const seated: Vec3 = [body[0], body[1], body[2] - learned.z];
  return dist(ref, seated) > BODY_SPLIT_UNITS ? seated : ref;
};

export const forgetBody = (id: number): void => { learnedOffset.delete(id); };
