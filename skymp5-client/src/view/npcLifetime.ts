// When an NPC copy may be deleted, re-seated or animated (crash-wave-1001 ANALYSIS.md §7). Pure, so a harness can run it.

// A new NPC copy takes no relayed animations or equipment for this long
export const NPC_SETTLE_MS = 1500;
// A HostStart re-seat waits until the copy has been loaded this long, and is dropped after the give-up time
export const RESEAT_MIN_LOADED_MS = 2000;
export const RESEAT_GIVE_UP_MS = 8000;
// A risky copy is disabled at once and deleted once its 3D is gone, at the earliest after the min frames, at the latest after the max
export const SAFE_DELETE_MIN_FRAMES = 3;
export const SAFE_DELETE_MAX_FRAMES = 60;
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

export type ReseatDecision = "now" | "later" | "skip";

export const reseatDecision = (s: CopyState, bornAt: number, askedAt: number, now: number): ReseatDecision => {
  const ready = s.is3DLoaded && !isRiskyToTouch(s, now) && (bornAt <= 0 || now - bornAt >= RESEAT_MIN_LOADED_MS);
  if (ready) return "now";
  return now - askedAt >= RESEAT_GIVE_UP_MS ? "skip" : "later";
};

export const deleteDecision = (framesSinceDisable: number, is3DLoaded: boolean): "delete" | "wait" =>
  framesSinceDisable >= SAFE_DELETE_MAX_FRAMES || (framesSinceDisable >= SAFE_DELETE_MIN_FRAMES && !is3DLoaded) ? "delete" : "wait";

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

export const trailLine = (now: number, kind: string, refrId: number, baseId: number, extra?: string): string =>
  `npc ${new Date(now).toISOString().slice(11, 23)} ${kind} ${hex(refrId)} base=${hex(baseId)}${extra ? " " + extra : ""}`;

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
