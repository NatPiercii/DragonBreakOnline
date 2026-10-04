// When a relayed Ragdoll and a NiNode update may reach a copy. Pure, so a harness can run it.
//
// Crashes of 4 Oct 10:18Z (KrizzlePop) and 10:57Z (Rocco) were both a BSJobs FaceGen job (69378 -> 26999 -> 26988, with
// BSFaceGenNiNode and BSFaceGenMorphDataHead in the registers) reading through a null pointer. In both, the client's trail
// ends with a player copy placed, pushed into a relayed Ragdoll and queued for a NiNode update within 8 ms, and the game
// died within a second. NPC copies already settle 1.5 s before relayed animations reach them; player copies did not.
import { NPC_SETTLE_MS, RAGDOLL_HOLD_MS } from "./npcLifetime";

// A relayed Ragdoll waits until the new copy has settled; the newest animation is applied once it has, as for an NPC copy
export const holdsRelayedRagdoll = (animEventName: string | undefined, spawnMoment: number, now: number): boolean =>
  animEventName === "Ragdoll" && (spawnMoment === 0 || now - spawnMoment < NPC_SETTLE_MS);

// No NiNode update (a rebuild of the copy's 3D, head included) while a relayed Ragdoll is still playing on it
export const niNodeWaitsForRagdoll = (ragdolledAt: number, now: number): boolean =>
  ragdolledAt > 0 && now - ragdolledAt < RAGDOLL_HOLD_MS;
