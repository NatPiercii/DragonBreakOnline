// Hosted creatures that slide without walking (trolls, skeletons, Ayleid undead: speed 0 and Standing on every report)
// What moved the reference, and which movement variables the graph defines; no imports (tests/locomotiondiag-harness.js)

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
export const PROBE_FLOAT = 4321.5;

export interface GraphAccess {
  getFloat(name: string): number;
  setFloat(name: string, value: number): void;
  getBool(name: string): boolean;
  setBool(name: string, value: boolean): void;
}

export interface GraphProbe { vars: Record<string, number | boolean>; undefinedVars: string[] }

// An undefined variable reads 0 or false, so only a zero or false is probed: written, read back, restored at once
export const probeGraph = (g: GraphAccess): GraphProbe => {
  const vars: Record<string, number | boolean> = {};
  const undefinedVars: string[] = [];
  for (const name of GRAPH_FLOATS) {
    const value = g.getFloat(name);
    if (value !== 0) { vars[name] = Math.round(value * 100) / 100; continue; }
    g.setFloat(name, PROBE_FLOAT);
    const back = g.getFloat(name);
    g.setFloat(name, 0);
    if (back === PROBE_FLOAT) vars[name] = 0;
    else undefinedVars.push(name);
  }
  for (const name of GRAPH_BOOLS) {
    if (g.getBool(name)) { vars[name] = true; continue; }
    g.setBool(name, true);
    const back = g.getBool(name);
    g.setBool(name, false);
    if (back) vars[name] = false;
    else undefinedVars.push(name);
  }
  return { vars, undefinedVars };
};
