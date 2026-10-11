// The game side of npcLifetime.ts: deferred deletes, spread HostStart re-seats, and the trail of actor-changing calls
import { Actor, Game, ObjectReference, Ui, on } from "skyrimPlatform";
import * as sp from "skyrimPlatform";
import { CopyWork, FrameBudget, SpawnLine, WorkQueue } from "./copyBudget";
import { ActorTrail, CopyState, HostAttemptBackoff, LineBudget, PendingDelete, RecentDeletes, deleteDecision, deletePlan, dropRelayedRagdoll, newPendingDelete, reseatDecision, trailLine } from "./npcLifetime";

// The file the launcher collects (report.js DIAG_LOG_REL); writeLogs ends every line with a flush, so a line written before a crash is kept
const LOG_NAME = "dbo-diag";
const trail = new ActorTrail();
const budget = new LineBudget(100, 20000);
const ragdolledAt = new Map<number, number>();
const bornAt = new Map<number, number>();
const pendingDeletes = new Map<number, PendingDelete>(); // local id -> its wait since it was disabled
const recentDeletes = new RecentDeletes(); // local ids already handed to Delete()
const recentDisables = new RecentDeletes(); // plugin-placed actors disableOnly disabled a moment ago (isDisabled may lag)
let lastUpdateAt = 0;
const reseats: Array<{ id: number; askedAt: number }> = [];
// Frames counted on "tick" (one SKSE task a frame), so every update callback of a frame reads the same number
let frame = 0;
const copyBudget = new FrameBudget();
const copyWork = new WorkQueue();
const spawnLine = new SpawnLine();

export const hostBackoff = new HostAttemptBackoff();

const baseOf = (id: number): number => {
  try { return ObjectReference.from(Game.getFormEx(id))?.getBaseObject()?.getFormID() || 0; } catch (e) { return 0; }
};

export const noteActorCall = (kind: string, refrId: number, extra?: string): void => {
  try {
    const now = Date.now();
    const line = trailLine(now, kind, refrId, baseOf(refrId), extra, frame);
    trail.push(line);
    if (!budget.take(now)) return;
    (sp as unknown as { writeLogs: (plugin: string, ...rest: unknown[]) => void }).writeLogs(LOG_NAME, line);
  } catch (e) { /* diagnostics never break the caller */ }
};
(globalThis as any).__dboNpcTrail = () => trail.all();

const read = (get: () => boolean): boolean => { try { return get(); } catch (e) { return false; } };

// A Loading Menu or Fader Menu is open (the fade after every load and door). Unreadable counts as open: a delete can wait
const isLoadingScreen = (): boolean => {
  try { return Ui.isMenuOpen("Loading Menu") || Ui.isMenuOpen("Fader Menu"); } catch (e) { return true; }
};

export const stateOf = (ac: Actor | null, id: number): CopyState => ({
  is3DLoaded: !!ac && read(() => ac.is3DLoaded()),
  dead: !!ac && read(() => ac.isDead()),
  bleedingOut: !!ac && read(() => ac.isBleedingOut()),
  unconscious: !!ac && read(() => ac.isUnconscious()),
  inKillMove: !!ac && read(() => ac.isInKillMove()),
  ragdolledAt: ragdolledAt.get(id) || 0,
});

const forget = (id: number): void => { ragdolledAt.delete(id); bornAt.delete(id); };

export const noteCopyBorn = (id: number): void => { bornAt.set(id, Date.now()); noteActorCall("spawn", id); };

// True when a relayed Ragdoll may be applied; it is then remembered so the copy counts as ragdolling
export const allowRelayedRagdoll = (ac: Actor): boolean => {
  const id = ac.getFormID();
  if (dropRelayedRagdoll(stateOf(ac, id), Date.now())) { noteActorCall("ragdoll-dropped", id); return false; }
  ragdolledAt.set(id, Date.now());
  noteActorCall("ragdoll", id);
  return true;
};

// When a relayed Ragdoll was last applied to this local id, 0 if never (ragdollHold.ts reads it)
export const ragdolledAtOf = (id: number): number => ragdolledAt.get(id) || 0;

// A copy that is dead, downed, in a kill move or ragdolling is disabled now and deleted once its 3D is gone; any other at once.
// defer: always the slow way (the world cleaner's actors may be fighting or casting when it reaches them).
// A ref already deleted, already handed to Delete() or already waiting is left alone; one with no 3D is deleted outright
// urgent: own companions and the player's own copies, never kept waiting. tag: the remote id, so its next spawn waits for this
export const safeDelete = (refr: ObjectReference, opts?: { defer?: boolean; urgent?: boolean; tag?: number }): void => {
  const id = refr.getFormID();
  if (recentDeletes.has(id, Date.now()) || pendingDeletes.has(id) || copyWork.has("delete", id) || read(() => refr.isDeleted())) {
    noteActorCall("delete-skipped", id);
    return;
  }
  copyWork.cancel("disable", id);
  budgeted("delete", id, opts?.tag || 0, !!opts?.urgent, () => {
    const r = ObjectReference.from(Game.getFormEx(id));
    if (r) deleteOrDefer(r, !!opts?.defer);
  });
};

// Runs now while the frame has room (or urgent), queued in order otherwise
const budgeted = (kind: CopyWork, id: number, tag: number, urgent: boolean, run: () => void): void => {
  if (urgent) { copyBudget.force(kind, frame); run(); return; }
  if (copyWork.submit(kind, id, tag, frame, copyBudget, run) === "queued") noteActorCall(`${kind}-queued`, id, `waiting=${copyWork.size(kind)}`);
};

const deleteOrDefer = (refr: ObjectReference, defer: boolean): void => {
  const id = refr.getFormID();
  const now = Date.now();
  const ac = Actor.from(refr);
  const plan = deletePlan({
    handedToDelete: recentDeletes.has(id, now),
    queued: pendingDeletes.has(id),
    deleted: read(() => refr.isDeleted()),
    is3DLoaded: read(() => refr.is3DLoaded()),
    state: ac ? stateOf(ac, id) : null,
    defer,
    loadingScreen: isLoadingScreen(),
  }, now);
  if (plan === "skip") { noteActorCall("delete-skipped", id); return; }
  if (plan === "delete") {
    noteActorCall("delete", id);
    recentDeletes.note(id, now);
    try { refr.delete(); } catch (e) { /* already gone */ }
    forget(id);
    return;
  }
  try { refr.disableNoWait(false); } catch (e) { /* already gone */ }
  pendingDeletes.set(id, newPendingDelete());
  noteActorCall("delete-deferred", id);
};

// A plugin-placed actor (not 0xff) the world cleaner removes is only disabled, never deleted: disabled it is the
// Initially Disabled state the plugin passes give, it is never swept again (the cleaner skips disabled actors), and the
// client never saves. Its Delete() added nothing but the risk of the 4 Oct 07:35Z crash in the fade after a load
export const disableOnly = (refr: ObjectReference): void => {
  const id = refr.getFormID();
  if (isHandedToDelete(id) || read(() => refr.isDeleted())) return;
  budgeted("disable", id, 0, false, () => {
    const now = Date.now();
    const r = ObjectReference.from(Game.getFormEx(id));
    if (!r || recentDeletes.has(id, now) || pendingDeletes.has(id) || read(() => r.isDeleted())) return;
    recentDisables.note(id, now);
    noteActorCall("disable", id);
    try { r.disableNoWait(false); } catch (e) { /* already gone */ }
  });
};

// A HostStart's settle on a copy; one whose copy is being deleted is left alone (the delete wins)
export const hostStartSettle = (remoteId: number, urgent: boolean, settle: () => void): void => {
  budgeted("hoststart", remoteId, remoteId, urgent, settle);
};

// A view asks every frame until its copy may be placed; urgent views never wait, and none goes before its old copy's queued delete
export const maySpawnCopy = (remoteId: number, urgent: boolean): boolean => {
  if (urgent) { copyBudget.force("spawn", frame); spawnLine.forget(remoteId); return true; }
  return spawnLine.ask(remoteId, frame, copyBudget, copyWork.hasTag("delete", remoteId));
};

// True while Delete() was called on this local id a moment ago, safeDelete is waiting to call it, or disableOnly has just
// disabled it: touch nothing on it
export const isHandedToDelete = (id: number): boolean => {
  const now = Date.now();
  return pendingDeletes.has(id) || recentDeletes.has(id, now) || recentDisables.has(id, now) || copyWork.has("delete", id) || copyWork.has("disable", id);
};

// A new copy placed under an id the engine has reused is not the one that was deleted
export const noteCopyPlaced = (id: number): void => { recentDeletes.forget(id); };

export const queueReseat = (id: number): void => {
  if (!reseats.some((r) => r.id === id)) reseats.push({ id, askedAt: Date.now() });
};

const onUpdate = (): void => {
  const now = Date.now();
  const stepMs = lastUpdateAt ? now - lastUpdateAt : 0;
  lastUpdateAt = now;
  copyWork.drain(frame, copyBudget);
  const loadingScreen = pendingDeletes.size > 0 && isLoadingScreen();
  for (const [id, pending] of Array.from(pendingDeletes)) {
    const refr = ObjectReference.from(Game.getFormEx(id));
    if (!refr || read(() => refr.isDeleted())) { pendingDeletes.delete(id); forget(id); continue; }
    // A ref that cannot be read counts as loaded: it waits, and at worst is left disabled
    let loaded = true;
    try { loaded = refr.is3DLoaded(); } catch (e) { /* unreadable */ }
    const { decision, next } = deleteDecision(pending, loaded, loadingScreen, stepMs);
    if (decision === "wait") { pendingDeletes.set(id, next); continue; }
    if (decision === "delete" && !copyBudget.take("delete", frame)) { pendingDeletes.set(id, next); continue; }
    pendingDeletes.delete(id);
    if (decision === "give-up") { noteActorCall("delete-abandoned", id, `3D still loaded after ${next.waitedMs} ms; left disabled`); forget(id); continue; }
    noteActorCall("delete", id, `after ${next.waitedMs} ms`);
    recentDeletes.note(id, now);
    try { refr.delete(); } catch (e) { /* already gone */ }
    forget(id);
  }
  // At most one re-seat a frame, so a cell load's burst of host grants is spread over frames
  for (let i = 0; i < reseats.length;) {
    const r = reseats[i];
    const ac = Actor.from(Game.getFormEx(r.id));
    const d = ac ? reseatDecision(stateOf(ac, r.id), bornAt.get(r.id) || 0, r.askedAt, now) : "skip";
    if (d === "later") { i++; continue; }
    reseats.splice(i, 1);
    if (d === "skip" || !ac) { noteActorCall("reseat-dropped", r.id); continue; }
    noteActorCall("reseat", r.id);
    try { ac.setPosition(ac.getPositionX(), ac.getPositionY(), ac.getPositionZ()); } catch (e) { /* gone */ }
    break;
  }
};

if (!(globalThis as any).__dboNpcLifetimeOn) {
  (globalThis as any).__dboNpcLifetimeOn = true;
  on("tick", () => { frame++; });
  on("update", () => { try { onUpdate(); } catch (e) { /* never break the frame */ } });
}
