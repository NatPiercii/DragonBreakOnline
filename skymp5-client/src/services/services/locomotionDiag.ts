// Hosted creatures that slide without walking (trolls, skeletons, Ayleid undead: speed 0 and Standing on every report)
// What moved the reference, and the graph's movement variables, read only; no imports (tests/locomotiondiag-harness.js)

export interface ApplyView { translating: boolean; offset: string; targetAgeMs: number }

// A translateTo target this recent is still driving the copy
export const APPLY_FRESH_MS = 1000;

// "repair": our split repair placed it; "apply": movementApply drives it as if another client hosted it; "ai": the engine
export const locomotionSource = (apply: ApplyView, repairAgoMs: number, repairWindowMs: number): string => {
  if (repairAgoMs >= 0 && repairAgoMs < repairWindowMs) return "repair";
  if (apply.translating || apply.offset === "held" || apply.offset === "moving") return "apply";
  if (apply.targetAgeMs >= 0 && apply.targetAgeMs <= APPLY_FRESH_MS) return "apply";
  return "ai";
};

// Movement variables from the Creation Kit wiki's List of Animation Variables; a creature graph may define none of them
export const GRAPH_FLOATS = ["Speed", "SpeedSampled", "Direction", "TurnDelta", "SpeedWalk", "SpeedRun"];
export const GRAPH_BOOLS = ["bMotionDriven", "bInJumpState"];
export interface GraphRead {
  getFloat(name: string): number;
  getBool(name: string): boolean;
}

export interface GraphValues { vars: Record<string, number | boolean>; zeroAmbiguous: string[] }

// Read only: a 0 or false may mean the graph does not define the variable, so those are listed as ambiguous
export const readGraph = (g: GraphRead): GraphValues => {
  const vars: Record<string, number | boolean> = {};
  const zeroAmbiguous: string[] = [];
  for (const name of GRAPH_FLOATS) {
    const value = g.getFloat(name);
    if (value !== 0) vars[name] = Math.round(value * 100) / 100;
    else zeroAmbiguous.push(name);
  }
  for (const name of GRAPH_BOOLS) {
    if (g.getBool(name)) vars[name] = true;
    else zeroAmbiguous.push(name);
  }
  return { vars, zeroAmbiguous };
};
