// Which fights a companion may have with another player (Nate, 5 Oct: summons and raised corpses fight players "in pvp").
// The server decides (companionSystem.ts): it names a player as a companion's target only while the PvP rules allow that
// fight, and marks that order pvp. A player target without the mark (an older server, or an order the rules no longer
// allow) is no order at all, and a fight the engine picked itself with a player the server has not named is left.

export interface CompanionOrder {
  // Remote id of the target the server recorded, 0 for none
  target: number;
  // The server judged the target a player, or what fights for one, and the PvP rules allow the fight
  pvp: boolean;
}

// The target to fight, 0 when there is none to carry out
export const orderedTarget = (order: CompanionOrder, isPlayer: (remoteId: number) => boolean): number => {
  if (!order.target) return 0;
  return order.pvp || !isPlayer(order.target) ? order.target : 0;
};

// The engine is fighting a player (combatTarget, a remote id; 0 for none) that the server has not named for this companion
export const leavesPlayerFight = (combatTarget: number, order: CompanionOrder, isPlayer: (remoteId: number) => boolean): boolean => {
  if (!combatTarget || !isPlayer(combatTarget)) return false;
  return !(order.pvp && order.target === combatTarget);
};
