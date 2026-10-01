// Werewolf (Skyrim 0CDD84) and Vampire Lord (Dawnguard 00283A). Their behaviour graphs are not the humanoid master
// graph, which matters twice: a copy's first moments after a race swap (formView), and the caster animation variables
// a relayed spell carries (remoteServer). SkyrimPlatform's ApplyVariablesToActor writes those at the humanoid master
// graph's fixed indexes (AnimVariableMasterGraphIndexes::CreateDefault, up to 291) with no graph or bounds check, and a
// werewolf's howls crashed three watchers within seconds of their relayed stops (2026-09-30). No imports, so a harness
// can load it on its own (tests/beastguard-harness.js).
export const BEAST_RACE_IDS = new Set([0x000cdd84, 0x0200283a]);

export const isBeastRaceId = (raceId: number | undefined | null): boolean => BEAST_RACE_IDS.has(Number(raceId) >>> 0);

// Every other race whose behaviour graph is not the humanoid master graph (sync/nonHumanoidRaceList.ts), resolved at
// runtime by beastRaces.ts. An Ayleid Pelinaga's copy (draugr graph) crashed a watcher 2 s after its relayed stop (1 Oct).
const nonHumanoidRaceIds = new Set<number>();

export const setNonHumanoidRaceIds = (ids: number[]): void => {
  nonHumanoidRaceIds.clear();
  for (const id of ids) nonHumanoidRaceIds.add(Number(id) >>> 0);
};

// A copy of this race takes no caster or animation variables
export const isGuardedRaceId = (raceId: number | undefined | null): boolean =>
  isBeastRaceId(raceId) || nonHumanoidRaceIds.has(Number(raceId) >>> 0);

export interface CasterVariables {
  booleans: Uint8Array;
  floats: Uint8Array;
  integers: Uint8Array;
}

// No caster variables at all: ApplyVariablesToActor returns before writing anything. A stop still stops the clone;
// a cast is not replayed, since the native casts only after applying them
export const emptyCasterVariables = (): CasterVariables => ({ booleans: new Uint8Array(0), floats: new Uint8Array(0), integers: new Uint8Array(0) });

// What a relayed cast or stop may write into the copy of a caster of this race
export const casterVariablesFor = <T extends CasterVariables>(copyRaceId: number, vars: T): T | CasterVariables =>
  isGuardedRaceId(copyRaceId) ? emptyCasterVariables() : vars;

// A Vampire Lord's copy refuses an update every 500 ms, and Report a Problem sends only the last 60 KB of the diag file
export const SKIP_LINE_INTERVAL_MS = 5 * 60 * 1000;
export const SKIP_MAX_LINES = 50;

export type BeastSkipKind = "cast" | "stop" | "keep-alive" | "anim variables update";

const hex = (n: number): string => (Number(n) >>> 0).toString(16);

// One line per caster and kind per interval, carrying the skips it held back, and nothing past maxLines this session
export const createBeastSkipLog = (write: (line: string) => void, now: () => number = () => Date.now(),
  intervalMs = SKIP_LINE_INTERVAL_MS, maxLines = SKIP_MAX_LINES) => {
  const last = new Map<string, { at: number; held: number }>();
  let lines = 0;
  return (remoteId: number, raceId: number, kind: BeastSkipKind, spellId?: number): boolean => {
    if (lines >= maxLines) return false;
    const key = `${hex(remoteId)}:${kind}`;
    const at = now();
    const prev = last.get(key);
    if (prev && at - prev.at < intervalMs) {
      prev.held++;
      return false;
    }
    last.set(key, { at, held: 0 });
    lines++;
    const spell = spellId === undefined ? "" : ` spell ${hex(spellId)}`;
    const held = prev && prev.held ? ` (${prev.held} more since the last line)` : "";
    write(`beast cast guard: ${hex(remoteId)} race ${hex(raceId)}${spell} ${kind}: caster variables not applied${held}`);
    if (lines === maxLines) {
      last.clear();
      write(`beast cast guard: stopped after ${maxLines} lines this session`);
    }
    return true;
  };
};
