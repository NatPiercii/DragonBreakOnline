// A per-frame budget for NPC copy work (crashes-1010 §1: the detection crash came within 1 s of 21-31 spawns, deletes and host
// starts in 1.5 s). Pure, so a harness can run it. Nothing is dropped: what the frame cannot take waits, in the order it came

export type CopyWork = "spawn" | "hoststart" | "delete" | "disable";

export const COPY_WORK_PER_FRAME: Readonly<Record<CopyWork, number>> = { spawn: 3, hoststart: 3, delete: 2, disable: 2 };

// A view that stopped asking for its spawn this many frames ago (destroyed, or its copy is no longer wanted) leaves the line
export const SPAWN_ASK_STALE_FRAMES = 5;

export class FrameBudget {
  private frame = -1;
  private used: Record<CopyWork, number> = { spawn: 0, hoststart: 0, delete: 0, disable: 0 };

  constructor(private limits: Readonly<Record<CopyWork, number>> = COPY_WORK_PER_FRAME) {}

  left(kind: CopyWork, frame: number): number {
    this.roll(frame);
    return Math.max(0, this.limits[kind] - this.used[kind]);
  }

  take(kind: CopyWork, frame: number): boolean {
    if (this.left(kind, frame) <= 0) return false;
    this.used[kind]++;
    return true;
  }

  // Work that is never delayed (own companions, the player's own copies) still counts, so the queue behind it waits
  force(kind: CopyWork, frame: number): void {
    this.roll(frame);
    this.used[kind]++;
  }

  usedIn(kind: CopyWork, frame: number): number {
    this.roll(frame);
    return this.used[kind];
  }

  private roll(frame: number): void {
    if (frame === this.frame) return;
    this.frame = frame;
    this.used = { spawn: 0, hoststart: 0, delete: 0, disable: 0 };
  }
}

// Spawns are asked for by the views every frame until granted, in the order each view first asked
export class SpawnLine {
  private waiting: Array<{ key: number; lastAsk: number }> = [];

  ask(key: number, frame: number, budget: FrameBudget, blocked = false): boolean {
    this.waiting = this.waiting.filter((w) => frame - w.lastAsk <= SPAWN_ASK_STALE_FRAMES);
    let i = this.waiting.findIndex((w) => w.key === key);
    if (i < 0) { this.waiting.push({ key, lastAsk: frame }); i = this.waiting.length - 1; } else this.waiting[i].lastAsk = frame;
    if (blocked || i >= budget.left("spawn", frame)) return false;
    budget.take("spawn", frame);
    this.waiting.splice(i, 1);
    return true;
  }

  forget(key: number): void {
    this.waiting = this.waiting.filter((w) => w.key !== key);
  }

  size(): number {
    return this.waiting.length;
  }
}

const runSafe = (run: () => void): void => { try { run(); } catch (e) { /* one bad item never stops the rest */ } };

export interface QueuedWork {
  kind: CopyWork;
  id: number; // the local id the work is done on
  tag: number; // the remote id it belongs to, 0 if none
  queuedAt: number; // frame
  run: () => void;
}

// Push work (deletes, disables, host-start settles): run at once while the frame has room and nothing of its kind waits,
// queued otherwise and run first-in first-out by drain()
export class WorkQueue {
  private items: QueuedWork[] = [];

  // ran: done now; queued: waits; dup: the same work on the same id already waits
  submit(kind: CopyWork, id: number, tag: number, frame: number, budget: FrameBudget, run: () => void): "ran" | "queued" | "dup" {
    if (this.has(kind, id)) return "dup";
    if (!this.items.some((w) => w.kind === kind) && budget.take(kind, frame)) { runSafe(run); return "ran"; }
    this.items.push({ kind, id, tag, queuedAt: frame, run });
    return "queued";
  }

  // Runs what the frame has room for, oldest first per kind; returns how many ran
  drain(frame: number, budget: FrameBudget): number {
    let ran = 0;
    for (let i = 0; i < this.items.length;) {
      const w = this.items[i];
      if (!budget.take(w.kind, frame)) { i++; continue; }
      this.items.splice(i, 1);
      ran++;
      runSafe(w.run);
    }
    return ran;
  }

  has(kind: CopyWork, id: number): boolean {
    return this.items.some((w) => w.kind === kind && w.id === id);
  }

  hasTag(kind: CopyWork, tag: number): boolean {
    return !!tag && this.items.some((w) => w.kind === kind && w.tag === tag);
  }

  cancel(kind: CopyWork, id: number): boolean {
    const n = this.items.length;
    this.items = this.items.filter((w) => !(w.kind === kind && w.id === id));
    return this.items.length !== n;
  }

  // Oldest waiting item's age in frames, 0 when empty
  oldestWait(frame: number): number {
    return this.items.length ? frame - this.items[0].queuedAt : 0;
  }

  size(kind?: CopyWork): number {
    return kind ? this.items.filter((w) => w.kind === kind).length : this.items.length;
  }
}
