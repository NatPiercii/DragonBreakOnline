import { Actor, Game, writeLogs } from "skyrimPlatform";
import { createBeastSkipLog, isBeastRaceId, isGuardedRaceId, setNonHumanoidRaceIds } from "./beastRaceIds";
import { NON_HUMANOID_RACES } from "./nonHumanoidRaceList";
import { beastBodyOf } from "./beastBody";

export { BEAST_RACE_IDS, isBeastRaceId, isGuardedRaceId, casterVariablesFor, emptyCasterVariables } from "./beastRaceIds";

// The copy's race when it is a beast race (sync/beastRaceIds.ts), else 0
export const beastRaceOf = (ac: Actor | null | undefined): number => {
  try {
    const raceId = (ac?.getRace()?.getFormID() ?? 0) >>> 0;
    return isBeastRaceId(raceId) ? raceId : 0;
  } catch {
    return 0;
  }
};

let nonHumanoidResolved = false;

// Once a session, in update: Skyrim.esm's races always resolve, so an empty result means the forms were not ready yet
const resolveNonHumanoidRaces = (): void => {
  if (nonHumanoidResolved) return;
  const ids: number[] = [];
  for (const [file, localId] of NON_HUMANOID_RACES) {
    try {
      const race = Game.getFormFromFile(localId, file);
      if (race) ids.push(race.getFormID());
    } catch {
      // that plugin is not loaded
    }
  }
  if (!ids.length) return;
  setNonHumanoidRaceIds(ids);
  nonHumanoidResolved = true;
};

// The copy's race when caster and animation variables must not be written into its graph (beasts included), else 0.
// remoteId: the copy's server id, guarded too while the server lists it as a beast body (sync/beastBody.ts), so a
// relayed cast between the list and the respawn, or a race the engine misreads, still writes nothing
export const guardedRaceOf = (ac: Actor | null | undefined, remoteId?: number): number => {
  resolveNonHumanoidRaces();
  const listed = beastBodyOf(remoteId);
  if (listed) return listed;
  try {
    const raceId = (ac?.getRace()?.getFormID() ?? 0) >>> 0;
    return isGuardedRaceId(raceId) ? raceId : 0;
  } catch {
    return 0;
  }
};

const DIAG_LOG = "dbo-diag";

// One line in Data\Platform\Logs\dbo-diag-logs.txt (flushed per line); an older SkyrimPlatform without writeLogs is quiet
const writeDiagLine = (line: string): void => {
  try {
    writeLogs(DIAG_LOG, line);
  } catch {
    // no writeLogs on this platform build
  }
};

// The guard's skip lines, throttled per caster and kind and capped per session
export const noteBeastSkip = createBeastSkipLog(writeDiagLine);
