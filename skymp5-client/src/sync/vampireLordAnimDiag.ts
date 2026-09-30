import * as sp from "skyrimPlatform";
import { Animation } from "./animation";

// Logging only; never changes what is applied.
// Remote Vampire Lords crashed both watchers they met (28 and 29 Sep), each seconds after the Lord's magic, while
// seven watched werewolves crashed nobody. animation.ts replays every remote event with Debug.sendAnimationEvent and
// filters none for the Lord's own behaviour graph, so each event applied to a remote Vampire Lord is written out as it
// happens: after a crash, the end of the file is the last events that copy was given.
// writeLogs (ConsoleApi.cpp) ends every line with std::endl, so a line is on disk before the event is applied. It
// writes Data\Platform\Logs\dbo-diag-logs.txt (under MO2, the overwrite folder), the file pageInputDiagService uses;
// logTrace would reach only the in-game console, never skyrim-platform.log.

const VAMPIRE_LORD_RACE = 0x0200283a;
const LOG_NAME = "dbo-diag";
// An hour of a Lord in combat is a few thousand lines; the cap only stops a loop from filling the disk
const MAX_LINES = 20000;
const KEEP = 20;

// Locomotion rather than the Lord's own actions. The sender never sends moveStart, moveStop, turnStop, TurnLeft,
// TurnRight or the Cyclic pair (animation.ts ignoredAnims), so they show up here only if that list changes.
const MOVEMENT_RE = /^(move|turn|sprint|jump|sneak|walk|run|cyclic)/i;

interface Entry {
  at: number;
  refrId: number;
  remoteId: number;
  name: string;
  movement: boolean;
}

const last: Entry[] = [];
let lines = 0;
let firstAt = 0;

const hex = (n: number): string => (n >>> 0).toString(16);
const time = (ms: number): string => new Date(ms).toISOString().slice(11, 23);

const write = (text: string): void => {
  if (lines >= MAX_LINES) return;
  lines++;
  try {
    (sp as unknown as { writeLogs: (plugin: string, ...rest: unknown[]) => void }).writeLogs(LOG_NAME, text);
  } catch (e) {
    // An older SkyrimPlatform without writeLogs: nothing to write to
  }
  if (lines === MAX_LINES) {
    try {
      (sp as unknown as { writeLogs: (plugin: string, ...rest: unknown[]) => void }).writeLogs(LOG_NAME, `vl-anim stopped after ${MAX_LINES} lines`);
    } catch (e) {
      // as above
    }
  }
};

export const isVampireLordRace = (raceId: unknown): boolean => (Number(raceId) >>> 0) === VAMPIRE_LORD_RACE;

// Call before applyAnimation, which rewrites anim.animEventName for its overrides and moves lastNumChanges on:
// this logs exactly the events it is about to apply, under the name the sender gave them.
export const noteVampireLordAnim = (refrId: number, remoteId: number | undefined, anim: Animation, lastNumChanges: number): void => {
  if (anim.numChanges === lastNumChanges) return;
  const entry: Entry = {
    at: Date.now(),
    refrId: refrId >>> 0,
    remoteId: Number(remoteId) >>> 0,
    name: String(anim.animEventName),
    movement: MOVEMENT_RE.test(String(anim.animEventName)),
  };
  if (!firstAt) {
    firstAt = entry.at;
    write(`vl-anim ${time(entry.at)}Z first event on a remote Vampire Lord this session (UTC times; one line per event applied)`);
  }
  last.push(entry);
  if (last.length > KEEP) last.shift();
  write(`vl-anim ${time(entry.at)}Z ${hex(entry.remoteId)} (local ${hex(entry.refrId)}) #${anim.numChanges} ${entry.name}${entry.movement ? " [movement]" : ""}`);
};

// The same events in memory, newest last, for a report or a console look while the game still runs
export const lastVampireLordAnims = (): ReadonlyArray<Entry> => last;
