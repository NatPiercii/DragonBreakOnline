// Which actors lip sync may move a mouth on. No imports, so tests/lipsync-guard-harness.js can transpile it alone.
//
// 10 Oct (0.3.90): two clients crashed in the engine's FaceGen morph job (SkyrimSE.exe+04328E9, a null read with a
// BSFaceGenNiNode, BSFaceGenMorphDataHead and BSDynamicTriShape in the registers) about 11 s after a player near them
// went down. Every one of them was on voice, and a downed player's copy is killed with Actor.kill, so the speaking
// report kept driving setExpressionPhoneme on a dead body. Beast races carry no FaceGen head at all
// (WerewolfBeastRace and DLC1VampireBeastRace have the RACE DATA flag clear in the load order), so they are refused too.

// RACE DATA flag "FaceGen Head" (TESRace RACE_DATA kFaceGenHead = 1 << 1), read through Race.isRaceFlagSet
export const RACE_FLAG_FACEGEN_HEAD = 0x2;

export type MouthSkip = "" | "unloaded" | "disabled" | "dead" | "noFaceGenHead";

// What the natives said about the actor; null where the read threw
export interface MouthState {
  loaded: boolean | null;
  disabled: boolean | null;
  dead: boolean | null;
  faceGenHead: boolean | null;
}

// "" when the mouth may move. Anything unread is refused: a wrong skip costs a still mouth, a wrong write a crash.
export const mouthSkipReason = (s: MouthState): MouthSkip => {
  if (s.loaded !== true) return "unloaded";
  if (s.disabled !== false) return "disabled";
  if (s.dead !== false) return "dead";
  if (s.faceGenHead !== true) return "noFaceGenHead";
  return "";
};

// One trace line per speaker each time the reason changes, so a dead speaker does not log every tick
export const createSkipNotes = () => {
  const last = new Map<number, MouthSkip>();
  return {
    // The line to log, or "" when it would repeat the last one for this speaker
    note(remoteId: number, skip: MouthSkip): string {
      if ((last.get(remoteId) ?? "") === skip) return "";
      last.set(remoteId, skip);
      return skip ? `lips held for ${(remoteId >>> 0).toString(16)}: ${skip}` : "";
    },
    forget(remoteId: number): void {
      last.delete(remoteId);
    },
  };
};
