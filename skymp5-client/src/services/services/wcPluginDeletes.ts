// Living plugin-placed actors the world cleaner removes after an arrival, one diagnostic line a burst (dungeon crashes, 1 Oct)

// Early enough to leave before a crash a few seconds after the arrival
export const WC_BATCH_MS = 1000;
export const WC_BASES_SHOWN = 5;

interface Batch { cell: number; arrivedAt: number; firstAt: number; ids: Set<number>; inCombat: number; loaded: number; bases: number[] }

const hex = (n: number) => (n >>> 0).toString(16);

export class WcPluginDeletes {
  private cell = 0;
  private arrivedAt = 0;
  private batch: Batch | null = null;

  // The player's cell or world on each sweep; a change is an arrival and ends the last burst
  seeCell(cell: number, now: number): string | null {
    if (cell === this.cell) return null;
    const line = this.flush();
    this.cell = cell;
    this.arrivedAt = now;
    return line;
  }

  // The removal is latent, so a sweep can pick the same actor again before it is gone: each counts once a burst
  add(actorId: number, base: number, inCombat: boolean, loaded: boolean, now: number): void {
    if (!this.batch) this.batch = { cell: this.cell, arrivedAt: this.arrivedAt, firstAt: now, ids: new Set(), inCombat: 0, loaded: 0, bases: [] };
    const b = this.batch;
    if (b.ids.has(actorId)) return;
    b.ids.add(actorId);
    if (inCombat) b.inCombat++;
    if (loaded) b.loaded++;
    if (b.bases.length < WC_BASES_SHOWN && !b.bases.includes(base)) b.bases.push(base);
  }

  due(now: number): string | null {
    return this.batch && now - this.batch.firstAt >= WC_BATCH_MS ? this.flush() : null;
  }

  flush(): string | null {
    const b = this.batch;
    this.batch = null;
    if (!b) return null;
    const since = b.arrivedAt ? `${b.firstAt - b.arrivedAt} ms after arrival` : "before any arrival";
    return `cell ${hex(b.cell)}: removed ${b.ids.size} living plugin actor(s), ${b.inCombat} in combat, ${b.loaded} with 3D, first ${since}; bases ${b.bases.map(hex).join(",")}`;
  }
}
