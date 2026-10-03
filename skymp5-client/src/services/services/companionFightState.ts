// What a companion's fight looks like to this engine, for its npcDrift report (#bugs 2 Oct: a raised bandit given a player
// to attack stood beside them, its order held and no blow struck). Diagnostic only: it reads, it never changes anything.

// The parts of an Actor read here; each read is guarded, since a native object can be gone by the next call
export interface FightActor {
  getFormID(): number;
  isInCombat(): boolean;
  getCombatTarget(): { getFormID(): number } | null;
  getFactionReaction(other: never): number;
  isHostileToActor(other: never): boolean;
  getRelationshipRank(other: never): number;
  getEquippedWeapon(left: boolean): { getFormID(): number } | null;
  getEquippedItemType(hand: number): number;
}

const read = <T>(f: () => T, fallback: T): T => { try { return f(); } catch { return fallback; } };
const hex = (id: number | null | undefined): string => ((Number(id) || 0) >>> 0).toString(16);

export const companionFightState = (actor: FightActor, ordered: FightActor | null) => {
  const combatTarget = read(() => actor.getCombatTarget()?.getFormID() ?? 0, 0);
  const orderedId = ordered ? read(() => ordered.getFormID(), 0) : 0;
  return {
    inCombat: read(() => actor.isInCombat(), false),
    combatTarget: hex(combatTarget),
    ordered: hex(orderedId),
    // The engine is fighting the target the owner ordered
    onOrder: !!orderedId && combatTarget === orderedId,
    // Toward the ordered target: 0 neutral, 1 enemy, 2 ally, 3 friend (GetFactionReaction); relationship -4..4
    orderedReaction: ordered ? read(() => actor.getFactionReaction(ordered as never), null as number | null) : null,
    orderedHostile: ordered ? read(() => actor.isHostileToActor(ordered as never), null as boolean | null) : null,
    orderedRelationship: ordered ? read(() => actor.getRelationshipRank(ordered as never), null as number | null) : null,
    // Weapons in the hands (form ids, 0 for none) and the hands' item types (GetEquippedItemType: 0 fists .. 9 crossbow)
    rightWeapon: hex(read(() => actor.getEquippedWeapon(false)?.getFormID() ?? 0, 0)),
    leftWeapon: hex(read(() => actor.getEquippedWeapon(true)?.getFormID() ?? 0, 0)),
    rightHand: read(() => actor.getEquippedItemType(1), -1),
    leftHand: read(() => actor.getEquippedItemType(0), -1),
  };
};
