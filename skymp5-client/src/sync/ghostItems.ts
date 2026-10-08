// Items the game holds beyond the server's count (refused takes, unmodelled extras): found after an apply, removed

// Frames to wait after an apply before counting: addItemEx changes the stack in a later game-thread task
export const GHOST_CHECK_FRAMES = 30;

export interface GhostEntry { baseId: number; count: number }

// Stackable items the apply meant to remove some of, and those the server holds (a ghost the reader misses is still counted)
export const ghostCandidates = (diff: GhostEntry[], isStackable: (baseId: number) => boolean, held: GhostEntry[] = []): number[] => {
  const out: number[] = [];
  const add = (baseId: number) => { const id = baseId >>> 0; if (out.indexOf(id) < 0 && isStackable(id)) out.push(id); };
  for (const e of diff) if (e.count < 0) add(e.baseId);
  for (const e of held) add(e.baseId);
  return out;
};

// The server's count of each candidate across all its entries
export const serverTotals = (entries: GhostEntry[], ids: number[]): Map<number, number> => {
  const totals = new Map<number, number>();
  for (const id of ids) totals.set(id, 0);
  for (const e of entries) {
    const id = e.baseId >>> 0;
    if (totals.has(id)) totals.set(id, (totals.get(id) as number) + Math.max(0, Number(e.count) || 0));
  }
  return totals;
};

export const ghostExcess = (serverCount: number, held: number): number => {
  const n = Math.floor((Number(held) || 0) - (Number(serverCount) || 0));
  return n > 0 ? n : 0;
};
