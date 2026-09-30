import { Actor, writeLogs } from "skyrimPlatform";
import { isBeastRaceId } from "./beastRaceIds";

export { BEAST_RACE_IDS, isBeastRaceId, casterVariablesFor, emptyCasterVariables } from "./beastRaceIds";

// The copy's race when it is a beast race (sync/beastRaceIds.ts), else 0
export const beastRaceOf = (ac: Actor | null | undefined): number => {
  try {
    const raceId = (ac?.getRace()?.getFormID() ?? 0) >>> 0;
    return isBeastRaceId(raceId) ? raceId : 0;
  } catch {
    return 0;
  }
};

const DIAG_LOG = "dbo-diag";

// One line in Data\Platform\Logs\dbo-diag-logs.txt (flushed per line); an older SkyrimPlatform without writeLogs is quiet
export const writeDiagLine = (line: string): void => {
  try {
    writeLogs(DIAG_LOG, line);
  } catch {
    // no writeLogs on this platform build
  }
};
