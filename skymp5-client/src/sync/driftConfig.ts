// Movement and drift switches set by the gamemode's npcDriftConfig packet; the defaults are the shipped behaviour
export const driftConfig = {
  remote: true,
  remoteRadius: 4096,
  remoteMax: 16,
  sinkReport: 120,
  hostSettle: "always" as "always" | "tracked",
  standHold: "clear" as "clear" | "hold",
  lookAheadMax: 128,
  gradeZ: true,
  snapUnits: 0,
  // "apply" is the 0.3.34 takeover timing; "packet" (B2) is switched on with /driftset for a test
  rehostClock: "apply" as "packet" | "apply",
  rehostAfterMs: 2100,
};

export type DriftConfig = typeof driftConfig;

// Parsed but read by no code yet (part C); echoed apart so a config line never claims they took effect
export const INERT_KEYS: ReadonlyArray<string> = ["hostSettle", "standHold", "lookAheadMax", "gradeZ", "snapUnits"];

// The config echo: live switches at the top level, the inert ones under "inert"
export const driftConfigEcho = (): Record<string, unknown> => {
  const live: Record<string, unknown> = {};
  const inert: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(driftConfig)) (INERT_KEYS.includes(k) ? inert : live)[k] = v;
  return { ...live, inert };
};

const isBool = (v: unknown) => typeof v === "boolean";
const range = (min: number, max: number) => (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
const oneOf = (...values: string[]) => (v: unknown) => typeof v === "string" && values.includes(v);

const RULES: Record<keyof DriftConfig, (v: unknown) => boolean> = {
  remote: isBool,
  remoteRadius: range(256, 16384),
  remoteMax: range(0, 64),
  sinkReport: range(16, 1000),
  hostSettle: oneOf("always", "tracked"),
  standHold: oneOf("clear", "hold"),
  lookAheadMax: range(0, 512),
  gradeZ: isBool,
  snapUnits: range(0, 8192),
  rehostClock: oneOf("packet", "apply"),
  rehostAfterMs: range(1000, 10000),
};

// Copies the known keys that pass their check; anything else in the packet is ignored
export const applyDriftConfig = (content: Record<string, unknown>): void => {
  const target = driftConfig as Record<string, unknown>;
  for (const key of Object.keys(RULES) as Array<keyof DriftConfig>) {
    const value = content[key];
    if (value !== undefined && RULES[key](value)) target[key] = key === "remoteMax" ? Math.round(value as number) : value;
  }
};
