// Whether the race the server sent for a beast form or its revert has held on the player's own character (GroundedPasta,
// 10 Oct: downed as a werewolf, the revert landed in bleed-out and did not hold; he woke at the temple still a wolf to
// himself). No imports, so tests/beast-race-check-harness.js runs it on its own.

// How long a race the server sent is watched (a down lasts up to a minute, the temple wake after it)
export const RACE_CHECK_MS = 5 * 60 * 1000;
// Seen this many times while up before it counts as held (a change the engine undoes a frame later is still caught)
export const RACE_HELD_CHECKS = 2;

export interface RaceWanted { raceId: number; beast: boolean; until: number; checks: number }

export const wantRace = (raceId: number, beast: boolean, now: number): RaceWanted =>
  ({ raceId: raceId >>> 0, beast, until: now + RACE_CHECK_MS, checks: 0 });

// One check: down or dead waits; the race in place counts toward held; another race asks for it to be set again
export function raceCheckStep(w: RaceWanted | null, now: number, player: { dead: boolean; bleeding: boolean; raceId: number } | null):
  { next: RaceWanted | null; retry: boolean } {
  if (!w) return { next: null, retry: false };
  if (now > w.until) return { next: null, retry: false };
  if (!player || player.dead || player.bleeding) return { next: w, retry: false };
  if ((player.raceId >>> 0) === w.raceId) {
    const checks = w.checks + 1;
    return { next: checks >= RACE_HELD_CHECKS ? null : { ...w, checks }, retry: false };
  }
  return { next: { ...w, checks: 0 }, retry: true };
}
