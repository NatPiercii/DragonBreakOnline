// The game side of flyerGuard.ts: which copies are dragons, and the flyer lines in dbo-diag-logs.txt
import { Actor, Game, ObjectReference } from "skyrimPlatform";
import * as sp from "skyrimPlatform";
import { DRAGON_RACES, FlyerTrail, flyerLine } from "./flyerGuard";

// The file the launcher collects (report.js DIAG_LOG_REL); writeLogs ends every line with a flush
const LOG_NAME = "dbo-diag";
const trail = new FlyerTrail();
let raceIds: Set<number> | null = null;

// Once a session, in update: Skyrim.esm's races always resolve, so an empty result means the forms were not ready yet
const resolveRaces = (): Set<number> | null => {
  if (raceIds) return raceIds;
  const ids = new Set<number>();
  for (const [file, localId] of DRAGON_RACES) {
    try {
      const race = Game.getFormFromFile(localId, file);
      if (race) ids.add(race.getFormID() >>> 0);
    } catch (e) {
      // that plugin is not loaded
    }
  }
  if (ids.size) raceIds = ids;
  return raceIds;
};

// True for a copy of a dragon-graph race; false when it cannot be read
export const isDragonCopy = (refr: ObjectReference | null | undefined): boolean => {
  try {
    const ids = resolveRaces();
    const raceId = (Actor.from(refr ?? null)?.getRace()?.getFormID() ?? 0) >>> 0;
    return !!ids && !!raceId && ids.has(raceId);
  } catch (e) {
    return false;
  }
};

// One line, written before the call it names. bornAt: when the copy was placed (movement lines stop 20 s after it)
export const noteFlyer = (kind: string, refrId: number, remoteId: number, bornAt: number, extra?: string): void => {
  try {
    const now = Date.now();
    if (!trail.take(kind, refrId, now, bornAt)) return;
    (sp as unknown as { writeLogs: (plugin: string, ...rest: unknown[]) => void }).writeLogs(LOG_NAME, flyerLine(now, kind, refrId, remoteId, extra));
  } catch (e) { /* diagnostics never break the caller */ }
};

export const forgetFlyer = (refrId: number): void => trail.forget(refrId);

// The spawn's switches for a copy being placed (formView sets them before SpawnProcess runs, SpawnProcess reads them)
const spawnGuards = new Map<number, { bits: number; remoteId: number; bornAt: number }>();
export const setSpawnGuard = (refrId: number, bits: number, remoteId: number, bornAt: number): void => { spawnGuards.set(refrId, { bits, remoteId, bornAt }); };
export const takeSpawnGuard = (refrId: number): { bits: number; remoteId: number; bornAt: number } | undefined => {
  const g = spawnGuards.get(refrId);
  spawnGuards.delete(refrId);
  return g;
};
