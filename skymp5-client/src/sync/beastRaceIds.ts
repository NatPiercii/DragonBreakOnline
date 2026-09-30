// Werewolf (Skyrim 0CDD84) and Vampire Lord (Dawnguard 00283A). Their behaviour graphs are not the humanoid master
// graph, which matters twice: a copy's first moments after a race swap (formView), and the caster animation variables
// a relayed spell carries (remoteServer). SkyrimPlatform's ApplyVariablesToActor writes those at the humanoid master
// graph's fixed indexes (AnimVariableMasterGraphIndexes::CreateDefault, up to 291) with no graph or bounds check, and a
// werewolf's howls crashed three watchers within seconds of their relayed stops (2026-09-30). No imports, so a harness
// can load it on its own (tests/beastguard-harness.js).
export const BEAST_RACE_IDS = new Set([0x000cdd84, 0x0200283a]);

export const isBeastRaceId = (raceId: number | undefined | null): boolean => BEAST_RACE_IDS.has(Number(raceId) >>> 0);

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
  isBeastRaceId(copyRaceId) ? emptyCasterVariables() : vars;
