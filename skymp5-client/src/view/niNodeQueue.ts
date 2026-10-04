import { Actor, Game, on, printConsole } from "skyrimPlatform";
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

// A call that queues the 3D update itself (skee's CharGen.LoadCharacterPresetEx) runs in the slot of a plain update and
// returns true when it queued one; a plain update asked for meanwhile still goes out if it did not
type NiNodeWork = (actor: Actor) => boolean;
const copyWork = new Map<number, NiNodeWork>();
const plainWanted = new Set<number>();
let playerWork: NiNodeWork | null = null;
let playerPlainWanted = false;

const runWork = (work: NiNodeWork, actor: Actor): boolean => {
  try { return work(actor) === true; } catch (e) { printConsole(`niNodeQueue: work failed: ${e}`); return false; }
};

const flush = (): void => {
  const id = plan.next(frame, (formId) => {
    const state = loadedNow(formId);
    if (state === null) { copyWork.delete(formId); plainWanted.delete(formId); }
    return state;
  });
  if (!id) return;
  const actor = actorOf(id);
  const work = copyWork.get(id);
  const plain = plainWanted.has(id) || !work;
  copyWork.delete(id);
  plainWanted.delete(id);
  if (!actor) return;
  const queued = work ? runWork(work, actor) : false;
  if (!queued && plain) actor.queueNiNodeUpdate();
};

const sendPlayer = (): void => {
  const player = Game.getPlayer();
  const work = playerWork;
  const plain = playerPlainWanted || !work;
  playerWork = null;
  playerPlainWanted = false;
  if (player) {
    const queued = work ? runWork(work, player) : false;
    if (!queued && plain) player.queueNiNodeUpdate();
  }
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
  plainWanted.add(formId >>> 0);
  plan.request(formId);
};

export const queuePlayerNiNodeUpdate = (): void => {
  install();
  playerPlainWanted = true;
  if (plan.copySentIn(frame)) { plan.wantPlayer(); return; }
  sendPlayer();
};

// work(actor) runs in the copy's turn, under the same rules as a plain update
export const queueCopyNiNodeWork = (formId: number, work: NiNodeWork): void => {
  install();
  copyWork.set(formId >>> 0, work);
  plan.request(formId);
};

// work(player) goes out as the player's own update does
export const queuePlayerNiNodeWork = (work: NiNodeWork): void => {
  install();
  playerWork = work;
  if (plan.copySentIn(frame)) { plan.wantPlayer(); return; }
  sendPlayer();
};
