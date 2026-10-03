// Which drops the client reports, and which local refs it removes for one (DropItemService)

// A drop seen just after the inventory closed is still the player's (the event can arrive a frame late)
export const DROP_MENU_GRACE_MS = 1000;

export const inDropWindow = (menuOpen: boolean, closedAt: number, now: number): boolean =>
  menuOpen || (closedAt > 0 && now - closedAt >= 0 && now - closedAt <= DROP_MENU_GRACE_MS);

// The engine's own dropped ref always goes, with any found nearby; the server places the one everyone sees
export const dropCandidates = (found: { forEach(fn: (id: number) => void): void }, dropped: number | null | undefined): number[] => {
  const ids: number[] = [];
  const add = (id: number) => { const n = id >>> 0; if (n && ids.indexOf(n) < 0) ids.push(n); };
  if (dropped) add(dropped);
  found.forEach(add);
  return ids;
};
