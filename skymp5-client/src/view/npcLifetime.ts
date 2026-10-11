// When an NPC copy may be deleted, re-seated or animated (crash-wave-1001 ANALYSIS.md §7). Pure, so a harness can run it.

// A new NPC copy takes no relayed animations or equipment for this long
export const NPC_SETTLE_MS = 1500;
// A HostStart re-seat waits until the copy has been loaded this long, and is dropped after the give-up time
export const RESEAT_MIN_LOADED_MS = 2000;
export const RESEAT_GIVE_UP_MS = 8000;
// A disabled copy is deleted once its 3D has read as gone for the min updates in a row and the settle time has passed, both
// counted only outside loading screens (Loading Menu, Fader Menu). One still loaded at the give-up time is left disabled,
// never force-deleted: the 60-frame cap deleted Baan Malur actors in the fade after a load while havok still stepped them
// (crash 4 Oct 07:35Z, bhkCharRigidBodyController through a freed Character)
export const SAFE_DELETE_MIN_FRAMES = 3;
export const SAFE_DELETE_SETTLE_MS = 2000;
export const SAFE_DELETE_GIVE_UP_MS = 30000;
// One update counts for at most this much: no update runs while the Loading Menu is open, so the first one after it
// would otherwise count the whole load
export const SAFE_DELETE_STEP_MS = 100;
// A relayed Ragdoll counts as ragdolling for this long
export const RAGDOLL_HOLD_MS = 3000;
// Seconds between host attempts the server does not answer: 1, 1, 2, 5, 10, then every 15
export const HOST_TRY_STEPS_MS = [1000, 1000, 2000, 5000, 10000, 15000];
export const HOST_TRY_GHOST_AFTER = 8;
export const TRAIL_SIZE = 20;

export interface CopyState {
  is3DLoaded: boolean;
  dead: boolean;
  bleedingOut: boolean;
  unconscious: boolean;
  inKillMove: boolean;
  ragdolledAt: number;
}

export const isRagdolling = (s: CopyState, now: number): boolean => s.ragdolledAt > 0 && now - s.ragdolledAt < RAGDOLL_HOLD_MS;

// Dead, downed, in a kill move or ragdolling: the states the 1 Oct crashes deleted or re-seated a copy in
export const isRiskyToTouch = (s: CopyState, now: number): boolean => s.dead || s.bleedingOut || s.unconscious || s.inKillMove || isRagdolling(s, now);

// Whether a delete may run at once; a deferred one (the world cleaner's, whose actors may be fighting or casting) never does
export const deleteNow = (s: CopyState, now: number, defer: boolean): boolean => !defer && !isRiskyToTouch(s, now);

// Delete() is latent, so a deleted ref still reads as not deleted for a while; a Disable queued on one crashed 0.3.75 (4 Oct 00:10Z)
export const RECENT_DELETE_MS = 10000;
export const RECENT_DELETE_CAP = 512;

// Local ids handed to Delete(), each for a short time; ids only, never a native object (those expire each frame)
export class RecentDeletes {
  private at = new Map<number, number>();

  constructor(private holdMs: number = RECENT_DELETE_MS, private cap: number = RECENT_DELETE_CAP) {}

  note(id: number, now: number): void {
    this.at.delete(id);
    this.at.set(id, now);
    while (this.at.size > this.cap) {
      const oldest = this.at.keys().next();
      if (oldest.done) break;
      this.at.delete(oldest.value);
    }
  }

  has(id: number, now: number): boolean {
    const t = this.at.get(id);
    if (t === undefined) return false;
    if (now - t >= this.holdMs) { this.at.delete(id); return false; }
    return true;
  }

  // A new copy placed under a reused id is not the deleted one
  forget(id: number): void {
    this.at.delete(id);
  }

  size(): number {
    return this.at.size;
  }
}

export interface DeleteFacts {
  handedToDelete: boolean; // Delete() already called on it, by the view or the cleaner, within RECENT_DELETE_MS
  queued: boolean; // already disabled by safeDelete and waiting for its 3D to go
  deleted: boolean; // isDeleted()
  is3DLoaded: boolean;
  state: CopyState | null; // null when the ref is not an actor
  defer: boolean;
  loadingScreen?: boolean; // a Loading Menu or Fader Menu is open
}

export type DeletePlan = "skip" | "delete" | "defer";

// skip: queue nothing on it; delete: Delete() now; defer: disableNoWait now, Delete() once its 3D is gone. No 3D is deleted outright,
// except during a loading screen, when nothing is deleted at once
export const deletePlan = (f: DeleteFacts, now: number): DeletePlan => {
  if (f.handedToDelete || f.queued || f.deleted) return "skip";
  if (f.loadingScreen) return "defer";
  if (!f.is3DLoaded) return "delete";
  if (!f.state) return f.defer ? "defer" : "delete";
  return deleteNow(f.state, now, f.defer) ? "delete" : "defer";
};

export type ReseatDecision = "now" | "later" | "skip";

export const reseatDecision = (s: CopyState, bornAt: number, askedAt: number, now: number): ReseatDecision => {
  const ready = s.is3DLoaded && !isRiskyToTouch(s, now) && (bornAt <= 0 || now - bornAt >= RESEAT_MIN_LOADED_MS);
  if (ready) return "now";
  return now - askedAt >= RESEAT_GIVE_UP_MS ? "skip" : "later";
};

// A copy safeDelete disabled and is waiting to delete: updates in a row its 3D read as gone, and time waited outside loading screens
export interface PendingDelete {
  unloadedFrames: number;
  waitedMs: number;
}

export const newPendingDelete = (): PendingDelete => ({ unloadedFrames: 0, waitedMs: 0 });

export type DeleteDecision = "delete" | "wait" | "give-up";

// One update of a pending delete. loadingScreen: a Loading Menu or Fader Menu is open, when nothing counts and nothing is deleted
// (the unloaded run starts again after it). give-up: leave it disabled and stop waiting
export const deleteDecision = (p: PendingDelete, is3DLoaded: boolean, loadingScreen: boolean, stepMs: number): { decision: DeleteDecision; next: PendingDelete } => {
  if (loadingScreen) return { decision: "wait", next: { unloadedFrames: 0, waitedMs: p.waitedMs } };
  const step = Math.min(Math.max(0, stepMs || 0), SAFE_DELETE_STEP_MS);
  const next = { unloadedFrames: is3DLoaded ? 0 : p.unloadedFrames + 1, waitedMs: p.waitedMs + step };
  if (is3DLoaded) return { decision: next.waitedMs >= SAFE_DELETE_GIVE_UP_MS ? "give-up" : "wait", next };
  return { decision: next.unloadedFrames >= SAFE_DELETE_MIN_FRAMES && next.waitedMs >= SAFE_DELETE_SETTLE_MS ? "delete" : "wait", next };
};

export const isSettling = (spawnMoment: number, now: number, settleMs: number = NPC_SETTLE_MS): boolean =>
  spawnMoment === 0 || now - spawnMoment < settleMs;

// A relayed Ragdoll on a copy that is already ragdolled, dead or without 3D only pushes a body havok is still holding
export const dropRelayedRagdoll = (s: CopyState, now: number): boolean => !s.is3DLoaded || s.dead || isRagdolling(s, now);

// Host attempts the server never answers (a copy of an NPC it destroyed) back off instead of going out once a second
export class HostAttemptBackoff {
  private tries = new Map<number, { n: number; last: number }>();

  due(remoteId: number, now: number): boolean {
    const t = this.tries.get(remoteId);
    if (!t) return true;
    return now - t.last >= HOST_TRY_STEPS_MS[Math.min(t.n - 1, HOST_TRY_STEPS_MS.length - 1)];
  }

  sent(remoteId: number, now: number): number {
    const t = this.tries.get(remoteId) || { n: 0, last: 0 };
    t.n++;
    t.last = now;
    this.tries.set(remoteId, t);
    return t.n;
  }

  answered(remoteId: number): void {
    this.tries.delete(remoteId);
  }

  unanswered(remoteId: number): number {
    return this.tries.get(remoteId)?.n || 0;
  }
}

// The last actor-changing calls, newest last
export class ActorTrail {
  private lines: string[] = [];

  constructor(private size: number = TRAIL_SIZE) {}

  push(line: string): void {
    this.lines.push(line);
    if (this.lines.length > this.size) this.lines.splice(0, this.lines.length - this.size);
  }

  all(): string[] {
    return this.lines.slice();
  }
}

const hex = (n: number): string => ((n || 0) >>> 0).toString(16);

// f= last (older parsers read the fields after the time): the frame counter, so a crash log shows how much copy work shared a frame
export const trailLine = (now: number, kind: string, refrId: number, baseId: number, extra?: string, frame?: number): string =>
  `npc ${new Date(now).toISOString().slice(11, 23)} ${kind} ${hex(refrId)} base=${hex(baseId)}${extra ? " " + extra : ""}${frame !== undefined ? ` f=${frame}` : ""}`;

// Lines written per second and per session: a cell load's burst is the part worth keeping, so the second's budget is wide
export class LineBudget {
  private second = 0;
  private inSecond = 0;
  private total = 0;
  dropped = 0;

  constructor(private perSecond: number, private perSession: number) {}

  take(now: number): boolean {
    const s = Math.floor(now / 1000);
    if (s !== this.second) { this.second = s; this.inSecond = 0; }
    if (this.inSecond >= this.perSecond || this.total >= this.perSession) { this.dropped++; return false; }
    this.inSecond++;
    this.total++;
    return true;
  }
}
