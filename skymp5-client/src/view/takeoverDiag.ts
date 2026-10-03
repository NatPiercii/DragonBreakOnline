// A hostile NPC this client has just taken over from another host, as its AI stands then and ~5 s later (#bugs thread 10:
// hostile NPCs that change hands go passive, about one re-grant in five). Logging only, through the dboDiag relay
// (__dboDiagNote, bounded per kind); it never changes the actor or the view.

// The parts of an Actor read here; each read is guarded, a native object can be gone by the next call
export interface TakeoverActor {
  isDead(): boolean;
  isInCombat(): boolean;
  getCombatTarget(): { getFormID(): number } | null;
  getActorValue(name: string): number;
  getCurrentPackage(): { getFormID(): number } | null;
  isAIEnabled(): boolean;
}

export const TAKEOVER_RECHECK_SECONDS = 5;

const read = <T>(f: () => T, fallback: T): T => { try { return f(); } catch { return fallback; } };
const hex = (id: number): string => ((Number(id) || 0) >>> 0).toString(16);

// Hostile enough to fight a player on sight (Aggression 1 aggressive .. 3 frenzied); the dead and the unaggressive are left out
export const isHostileTakeover = (actor: TakeoverActor | null): boolean =>
  !!actor && !read(() => actor.isDead(), true) && read(() => actor.getActorValue("Aggression"), 0) >= 1;

export const takeoverLine = (actor: TakeoverActor, refrId: number, remoteId: number, at: string, seated: string, alreadyHosted: boolean): string => {
  const target = read(() => actor.getCombatTarget()?.getFormID() ?? 0, 0);
  const pkg = read(() => actor.getCurrentPackage()?.getFormID() ?? 0, 0);
  return `${hex(refrId)} remote=${hex(remoteId)} at ${at}: combat=${read(() => actor.isInCombat(), false)} target=${hex(target)}`
    + ` aggression=${read(() => actor.getActorValue("Aggression"), -1)} confidence=${read(() => actor.getActorValue("Confidence"), -1)}`
    + ` package=${hex(pkg)} ai=${read(() => actor.isAIEnabled(), false)} alreadyHosted=${alreadyHosted} havokSeated=${seated}`;
};
