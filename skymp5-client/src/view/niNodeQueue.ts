import { Actor, Game, on, once } from "skyrimPlatform";
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

const install = (): void => {
  if (installed) return;
  installed = true;
  on("update", () => { frame++; flush(); });
};

export const queueCopyNiNodeUpdate = (formId: number): void => {
  install();
  plan.request(formId);
};

export const queuePlayerNiNodeUpdate = (): void => {
  install();
  if (plan.copySentIn(frame)) {
    once("update", () => queuePlayerNiNodeUpdate());
    return;
  }
  const player = Game.getPlayer();
  if (!player) return;
  player.queueNiNodeUpdate();
  plan.playerQueued(frame);
};
