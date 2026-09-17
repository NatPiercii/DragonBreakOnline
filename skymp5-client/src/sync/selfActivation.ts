// Furniture the local player activated, so a server answer meant for an NPC never seats the player
// OpenContainerMessage carries only a target, and the server routes an NPC's own sit to its hoster

const WINDOW_MS = 6000;
const recent = new Map<number, number>();

export const selfActivated = (remoteTarget: number): void => {
  const now = Date.now();
  recent.set(remoteTarget, now);
  recent.forEach((at, id) => { if (now - at > WINDOW_MS) recent.delete(id); });
};

export const wasSelfActivated = (remoteTarget: number): boolean => {
  const at = recent.get(remoteTarget);
  return at !== undefined && Date.now() - at <= WINDOW_MS;
};
