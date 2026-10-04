// The game side of npcLifetime.ts: deferred deletes, spread HostStart re-seats, and the trail of actor-changing calls
import { Actor, Game, ObjectReference, on } from "skyrimPlatform";
import * as sp from "skyrimPlatform";
import { ActorTrail, CopyState, HostAttemptBackoff, LineBudget, RecentDeletes, deleteDecision, deletePlan, dropRelayedRagdoll, reseatDecision, trailLine } from "./npcLifetime";

// The file the launcher collects (report.js DIAG_LOG_REL); writeLogs ends every line with a flush, so a line written before a crash is kept
const LOG_NAME = "dbo-diag";
const trail = new ActorTrail();
const budget = new LineBudget(100, 20000);
const ragdolledAt = new Map<number, number>();
const bornAt = new Map<number, number>();
const pendingDeletes = new Map<number, number>(); // local id -> frames since it was disabled
const recentDeletes = new RecentDeletes(); // local ids already handed to Delete()
const reseats: Array<{ id: number; askedAt: number }> = [];

export const hostBackoff = new HostAttemptBackoff();

const baseOf = (id: number): number => {
  try { return ObjectReference.from(Game.getFormEx(id))?.getBaseObject()?.getFormID() || 0; } catch (e) { return 0; }
};

export const noteActorCall = (kind: string, refrId: number, extra?: string): void => {
  try {
    const now = Date.now();
    const line = trailLine(now, kind, refrId, baseOf(refrId), extra);
    trail.push(line);
    if (!budget.take(now)) return;
    (sp as unknown as { writeLogs: (plugin: string, ...rest: unknown[]) => void }).writeLogs(LOG_NAME, line);
  } catch (e) { /* diagnostics never break the caller */ }
};
(globalThis as any).__dboNpcTrail = () => trail.all();

const read = (get: () => boolean): boolean => { try { return get(); } catch (e) { return false; } };

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
export const safeDelete = (refr: ObjectReference, opts?: { defer?: boolean }): void => {
  const id = refr.getFormID();
  const now = Date.now();
  const ac = Actor.from(refr);
  const plan = deletePlan({
    handedToDelete: recentDeletes.has(id, now),
    queued: pendingDeletes.has(id),
    deleted: read(() => refr.isDeleted()),
    is3DLoaded: read(() => refr.is3DLoaded()),
    state: ac ? stateOf(ac, id) : null,
    defer: !!(opts && opts.defer),
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
  pendingDeletes.set(id, 0);
  noteActorCall("delete-deferred", id);
};

// True while Delete() was called on this local id a moment ago, or safeDelete is waiting to call it: touch nothing on it
export const isHandedToDelete = (id: number): boolean => pendingDeletes.has(id) || recentDeletes.has(id, Date.now());

// A new copy placed under an id the engine has reused is not the one that was deleted
export const noteCopyPlaced = (id: number): void => { recentDeletes.forget(id); };

export const queueReseat = (id: number): void => {
  if (!reseats.some((r) => r.id === id)) reseats.push({ id, askedAt: Date.now() });
};

const onUpdate = (): void => {
  const now = Date.now();
  for (const [id, frames] of Array.from(pendingDeletes)) {
    const refr = ObjectReference.from(Game.getFormEx(id));
    if (!refr || read(() => refr.isDeleted())) { pendingDeletes.delete(id); forget(id); continue; }
    if (deleteDecision(frames + 1, read(() => refr.is3DLoaded())) === "wait") { pendingDeletes.set(id, frames + 1); continue; }
    pendingDeletes.delete(id);
    noteActorCall("delete", id, `after ${frames + 1} frames`);
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
  on("update", () => { try { onUpdate(); } catch (e) { /* never break the frame */ } });
}
