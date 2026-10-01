import { Actor, Game, on } from "skyrimPlatform";
import { NiNodeQueuePlan } from "./niNodeQueuePlan";
import { isBeastRaceId } from "../sync/beastRaceIds";

// Every NiNode (3D) update goes through here; see niNodeQueuePlan.ts for why and the rules
const plan = new NiNodeQueuePlan();
let frame = 0;
let installed = false;

const actorOf = (formId: number): Actor | null => {
  try { return Actor.from(Game.getFormEx(formId)); } catch { return null; }
};

// Loaded this frame; a copy gone, or now a beast (its graph crashed on a queued 3D reset), is dropped
const loadedNow = (formId: number): boolean | null => {
  const actor = actorOf(formId);
  if (!actor) return null;
  try {
    const race = actor.getRace();
    if (race && isBeastRaceId(race.getFormID())) return null;
    return actor.is3DLoaded();
  } catch {
    return null;
  }
};

const flush = (): void => {
  const id = plan.next(frame, loadedNow);
  if (!id) return;
  const actor = actorOf(id);
  if (actor) actor.queueNiNodeUpdate();
};

const sendPlayer = (): void => {
  const player = Game.getPlayer();
  if (player) player.queueNiNodeUpdate();
  plan.playerQueued(frame);
};

// The order of "update" callbacks within a frame is not fixed (SkyrimPlatform's EventManager map), so a deferred
// player's update is sent here, first thing in the next frame, and no copy goes in that frame
const install = (): void => {
  if (installed) return;
  installed = true;
  on("update", () => {
    frame++;
    if (plan.playerWaiting && !plan.copySentIn(frame)) { sendPlayer(); return; }
    flush();
  });
};

export const queueCopyNiNodeUpdate = (formId: number): void => {
  install();
  plan.request(formId);
};

export const queuePlayerNiNodeUpdate = (): void => {
  install();
  if (plan.copySentIn(frame)) { plan.wantPlayer(); return; }
  sendPlayer();
};
