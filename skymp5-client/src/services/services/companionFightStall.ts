// Whether a companion's ordered fight is going anywhere (#bugs 2 Oct "Raise Zombie, not working at all": the NPC simply
// stands still). On 4 Oct a raised wolf held its order in combat for 25 s without moving a step, its target untouched,
// until the owner walked out of the leash. A fight counts as stalled when, for stallMs, the companion is out of reach of
// its target, has not moved and the target's health has not dropped; a ranged caster that lands its hits never stalls.
// The first stall restarts the fight, the next one gives the order up (companionService.ts).

export interface FightStall {
  // The target this window watches, when the window began, and the companion's place and the target's health then
  target: number;
  since: number;
  pos: number[];
  health: number;
  // Restarts already tried on this order without progress
  kicks: number;
}

export type StallAction = "none" | "restart" | "drop";

export const STALL_MS = 6000;
// Closer than this to its target it is fighting, whatever it does
export const STALL_REACH = 256;
// Moving more than this in a window is walking somewhere
export const STALL_MOVE = 64;

export const fightStallStep = (prev: FightStall | null, now: number, target: number, pos: number[], health: number,
  toTarget: number): { stall: FightStall; action: StallAction } => {
  const fresh = (kicks: number): FightStall => ({ target, since: now, pos: pos.slice(), health, kicks });
  if (!prev || prev.target !== target) return { stall: fresh(0), action: "none" };
  const moved = Math.hypot(pos[0] - prev.pos[0], pos[1] - prev.pos[1], pos[2] - prev.pos[2]);
  if (toTarget <= STALL_REACH || moved > STALL_MOVE || health < prev.health - 0.001) return { stall: fresh(0), action: "none" };
  if (now - prev.since < STALL_MS) return { stall: prev, action: "none" };
  return { stall: fresh(prev.kicks + 1), action: prev.kicks === 0 ? "restart" : "drop" };
};
