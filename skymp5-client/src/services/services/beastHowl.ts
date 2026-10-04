// When the player may hold a werewolf howl (Howl of Terror and the Totem of the Hunt's detect-life howl). Pure, so a
// harness can run it.
//
// beastFormService adds the howl shouts itself on the way into the form; the server never grants them. They only went
// again on a revert this client saw start, so a howl survived a death or down in the form, a relog, a lost end
// packet or a session that never saw the start, and stayed usable in human form (G8, 4 Oct). Now the player may
// hold one only while this client took the form, the player's race is that form's, and they are neither dead nor
// bleeding out; anything else strips every howl. Fails closed: no record of the form start means no howl.

// SHOU records read out of Skyrim.esm on CT 115 (esplib): HowlWerewolfFear and HowlWerewolfDetectLife
export const HOWL_SHOUTS: readonly number[] = [0x000cf790, 0x000ce218];

// Seconds between strips while nothing changed: a backstop for a howl added behind this service's back
export const HOWL_RECHECK_MS = 10000;

export interface HowlFacts {
  serviceBeastRace: number; // the race dboBeast last put this client in, 0 when it never did or reverted
  raceId: number;           // the player's race now
  dead: boolean;
  bleedingOut: boolean;
}

export const mayHoldHowl = (f: HowlFacts): boolean =>
  f.serviceBeastRace !== 0 && (f.raceId >>> 0) === (f.serviceBeastRace >>> 0) && !f.dead && !f.bleedingOut;

// The vanilla howls plus any the server's ability list named, each once
export const howlShoutIds = (learned: readonly number[]): number[] => {
  const out = new Set<number>(HOWL_SHOUTS);
  for (const id of learned) if (Number.isFinite(id) && id > 0) out.add(id >>> 0);
  return Array.from(out);
};

// Whether to strip on this check: on every change to "may not", then every HOWL_RECHECK_MS while it lasts, and at
// once after a forced check (a new connection)
export const stripDue = (may: boolean, wasMay: boolean | undefined, lastStripAt: number, now: number, forced: boolean): boolean =>
  !may && (forced || wasMay !== false || now - lastStripAt >= HOWL_RECHECK_MS);
