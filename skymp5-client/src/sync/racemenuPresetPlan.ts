// RaceMenu face presets (custom sliders, expressions, sculpt) carried between games as the face part of a skee .jslot.
// No imports, so a harness can load it on its own (tests/racemenu-preset-plan-harness.js). The server's racemenupresets.js
// applies the same rules and is the one that counts; this copy trims the upload and guards what reaches skee here.

// Longest face preset text sent or kept (a heavily sculpted head is a few hundred KB)
export const PRESET_MAX_CHARS = 1000000;
export const CHUNK_CHARS = 12000;
export const MAX_CHUNKS = Math.ceil(PRESET_MAX_CHARS / CHUNK_CHARS);
export const MAX_CUSTOM_MORPHS = 1024;
export const MAX_MORPH_NAME = 128;
// skee repeats a preset slider's morph once per whole unit of its value (FaceMorphInterface::ApplyMorph)
export const MAX_MORPH_VALUE = 100;
export const MAX_SCULPT_HOSTS = 16;
// skee keeps sculpt indices as UInt16
export const MAX_VERTICES = 65535;
export const MAX_SCULPT_OFFSET = 10000000;
export const MAX_SCULPT_DIVISOR = 1000000;
export const MAX_MOD_NAMES = 512;
export const MAX_MOD_NAME = 260;
export const MAX_TRI_PATH = 200;

export interface PresetVersion {
  signature: number;
  formatVersion: number;
  skseVersion: number;
  runtimeVersion: number;
}

export interface CustomMorph {
  name: string;
  value: number;
}

export interface SculptHost {
  host: string;
  vertices: number;
  // [vertex index, x, y, z] with offsets multiplied by sculptDivisor
  data: number[][];
}

export interface FacePreset {
  version: PresetVersion;
  modNames: string[];
  custom: CustomMorph[];
  sculptDivisor: number;
  sculpt: SculptHost[];
}

const isObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const isUint32 = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= 0xffffffff;
const isIntIn = (x: unknown, lo: number, hi: number): x is number => typeof x === "number" && Number.isInteger(x) && x >= lo && x <= hi;
const hasControl = (s: string): boolean => /[\u0000-\u001f\u007f]/.test(s);
const isCleanString = (x: unknown, max: number): x is string => typeof x === "string" && x.length > 0 && x.length <= max && !hasControl(x);

// The rule of the platform's getTriVertexCount (platform_lib PresetFiles.cpp ValidateTriPath)
export const isTriPath = (x: unknown): x is string => {
  if (typeof x !== "string" || !x.length || x.length > MAX_TRI_PATH) return false;
  if (!/^[A-Za-z0-9_\-. \\/]+$/.test(x)) return false;
  if (/^[\\/ ]/.test(x) || x.indexOf("..") !== -1) return false;
  return /\.tri$/i.test(x);
};

const versionFrom = (x: unknown): PresetVersion | null => {
  if (!isObject(x)) return null;
  const { signature, formatVersion, skseVersion, runtimeVersion } = x;
  if (!isUint32(signature) || !isUint32(formatVersion) || formatVersion < 1) return null;
  return { signature, formatVersion, skseVersion: isUint32(skseVersion) ? skseVersion : 0, runtimeVersion: isUint32(runtimeVersion) ? runtimeVersion : 0 };
};

// skee refuses a preset whose mods and modNames are both empty; the names themselves are not used for the face
const modNamesFrom = (root: Record<string, unknown>): string[] => {
  const out: string[] = [];
  const push = (n: unknown) => { if (isCleanString(n, MAX_MOD_NAME) && out.length < MAX_MOD_NAMES && out.indexOf(n) === -1) out.push(n); };
  if (Array.isArray(root.modNames)) root.modNames.forEach(push);
  if (!out.length && Array.isArray(root.mods)) root.mods.forEach((m) => { if (isObject(m)) push(m.name); });
  if (!out.length) out.push("Skyrim.esm");
  return out;
};

const customFrom = (x: unknown): CustomMorph[] | null => {
  if (x === undefined || x === null) return [];
  if (!Array.isArray(x) || x.length > MAX_CUSTOM_MORPHS) return null;
  const out: CustomMorph[] = [];
  for (const m of x) {
    if (!isObject(m) || !isCleanString(m.name, MAX_MORPH_NAME)) return null;
    const value = m.value;
    if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > MAX_MORPH_VALUE) return null;
    if (value !== 0) out.push({ name: m.name, value });
  }
  return out;
};

const sculptFrom = (x: unknown): SculptHost[] | null => {
  if (x === undefined || x === null) return [];
  if (!Array.isArray(x) || x.length > MAX_SCULPT_HOSTS) return null;
  const out: SculptHost[] = [];
  for (const h of x) {
    if (!isObject(h) || !isTriPath(h.host) || !isIntIn(h.vertices, 1, MAX_VERTICES)) return null;
    const host = h.host, vertices = h.vertices;
    const raw = h.data === undefined || h.data === null ? [] : h.data;
    if (!Array.isArray(raw) || raw.length > vertices) return null;
    const data: number[][] = [];
    for (const v of raw) {
      if (!Array.isArray(v) || v.length !== 4 || !isIntIn(v[0], 0, vertices - 1)) return null;
      for (let k = 1; k < 4; k++) if (!isIntIn(v[k], -MAX_SCULPT_OFFSET, MAX_SCULPT_OFFSET)) return null;
      data.push([v[0], v[1], v[2], v[3]]);
    }
    if (data.length && !out.some((o) => o.host.toLowerCase() === host.toLowerCase())) out.push({ host, vertices, data });
  }
  return out;
};

// The face part of a .jslot (skee SaveJsonPreset), or null when it breaks a rule. Head parts, weight, tints, face
// textures and the vanilla sliders come from the SkyMP appearance; overrides, transforms and body morphs from part 1.
export const facePresetFrom = (jslot: unknown): FacePreset | null => {
  if (!isObject(jslot)) return null;
  const version = versionFrom(jslot.version);
  if (!version) return null;
  const morphs = isObject(jslot.morphs) ? jslot.morphs : {};
  const custom = customFrom(morphs.custom);
  const sculpt = sculptFrom(morphs.sculpt);
  if (!custom || !sculpt) return null;
  let sculptDivisor = 10000;
  if (sculpt.length) {
    if (!isIntIn(morphs.sculptDivisor, 1, MAX_SCULPT_DIVISOR)) return null;
    sculptDivisor = morphs.sculptDivisor;
  }
  return { version, modNames: modNamesFrom(jslot), custom, sculptDivisor, sculpt };
};

export const isEmptyFace = (f: FacePreset): boolean => !f.custom.length && !f.sculpt.length;

// Fixed key order, so one face is always one text and one hash
export const encodeFace = (f: FacePreset): string => JSON.stringify({
  version: { signature: f.version.signature, formatVersion: f.version.formatVersion, skseVersion: f.version.skseVersion, runtimeVersion: f.version.runtimeVersion },
  modNames: f.modNames,
  custom: f.custom.map((m) => ({ name: m.name, value: m.value })),
  sculptDivisor: f.sculptDivisor,
  sculpt: f.sculpt.map((h) => ({ host: h.host, vertices: h.vertices, data: h.data })),
});

export const decodeFace = (text: unknown): FacePreset | null => {
  if (typeof text !== "string" || !text.length || text.length > PRESET_MAX_CHARS) return null;
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!isObject(raw)) return null;
  return facePresetFrom({ version: raw.version, modNames: raw.modNames, morphs: { custom: raw.custom, sculptDivisor: raw.sculptDivisor, sculpt: raw.sculpt } });
};

// FNV-1a over UTF-16 code units, 8 hex digits; the server computes the same (racemenupresets.js)
export const hashText = (text: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ("0000000" + h.toString(16)).slice(-8);
};

// skee adds each offset to the head's vertex data with no bounds check: a host goes only when this game's own mesh has
// the vertex count the owner's had. vertexCountOf answers -1 for a mesh it cannot read.
export const boundSculpt = (f: FacePreset, vertexCountOf: (host: string) => number): { face: FacePreset; dropped: string[] } => {
  const dropped: string[] = [];
  const sculpt = f.sculpt.filter((h) => {
    let local = -1;
    try { local = vertexCountOf(h.host); } catch { local = -1; }
    const ok = local === h.vertices && h.data.every((v) => v[0] < local);
    if (!ok) dropped.push(`${h.host} (${h.vertices} here ${local})`);
    return ok;
  });
  return { face: { ...f, sculpt }, dropped };
};

// skee's GetFormIdentifier: "<plugin>|<local id, 6 hex>"; a light plugin's local id is the low 12 bits
export const formIdentifierOf = (formId: number, modName: (index: number) => string, lightModName: (index: number) => string): string | null => {
  const id = formId >>> 0;
  const top = id >>> 24;
  if (top === 0xff) return null;
  let name = "";
  try { name = top === 0xfe ? lightModName((id >>> 12) & 0xfff) : modName(top); } catch { name = ""; }
  if (!name) return null;
  const local = top === 0xfe ? id & 0xfff : id & 0xffffff;
  return `${name}|${("00000" + local.toString(16).toUpperCase()).slice(-6)}`;
};

// The .jslot handed to CharGen.LoadCharacterPresetEx. skee resets the head parts to the race's defaults and adds these
// back, sets this weight, and leaves tints, face textures and the vanilla sliders alone when they are absent.
export const buildJslot = (f: FacePreset, headParts: string[], weight: number): string => JSON.stringify({
  version: f.version,
  modNames: f.modNames,
  headParts: headParts.map((formIdentifier) => ({ formIdentifier })),
  actor: { weight: Number.isFinite(weight) ? Math.min(100, Math.max(0, weight)) : 50 },
  morphs: { custom: f.custom, sculptDivisor: f.sculptDivisor, sculpt: f.sculpt },
});

export const chunkText = (text: string, size: number = CHUNK_CHARS): string[] => {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
};

// The preset file name for one character (platform rule [A-Za-z0-9_-]{1,64}); "self" for the player
export const presetFileName = (remoteId: number | "self"): string => remoteId === "self" ? "self" : `c${(remoteId >>> 0).toString(16)}`;

export interface ChunkPacket {
  actor: number;
  hash: string;
  i: number;
  n: number;
  data: string;
}

export const readChunkPacket = (content: Record<string, unknown> | null): ChunkPacket | null => {
  if (!content) return null;
  const actor = Number(content.actor) >>> 0;
  const hash = content.hash, i = content.i, n = content.n, data = content.data;
  if (!actor || typeof hash !== "string" || !/^[0-9a-f]{8}$/.test(hash)) return null;
  if (!isIntIn(n, 1, MAX_CHUNKS) || !isIntIn(i, 0, n - 1) || typeof data !== "string" || data.length > CHUNK_CHARS) return null;
  return { actor, hash, i, n, data };
};

// Collects one preset's chunks per character; a transfer that stalls is dropped
export class ChunkAssembler {
  constructor(private timeoutMs: number = 60000, private maxOpen: number = 8) {}

  // The whole text once every chunk is in and the hash matches, else null
  push(p: ChunkPacket, now: number): string | null {
    this.expire(now);
    const key = `${p.actor}:${p.hash}`;
    let t = this.open[key];
    if (!t || t.n !== p.n) {
      if (!t && Object.keys(this.open).length >= this.maxOpen) return null;
      t = this.open[key] = { n: p.n, parts: new Array<string | undefined>(p.n), got: 0, at: now };
    }
    t.at = now;
    if (t.parts[p.i] === undefined) { t.parts[p.i] = p.data; t.got++; }
    if (t.got < t.n) return null;
    delete this.open[key];
    const text = t.parts.join("");
    return text.length <= PRESET_MAX_CHARS && hashText(text) === p.hash ? text : null;
  }

  get openCount(): number {
    return Object.keys(this.open).length;
  }

  private expire(now: number): void {
    Object.keys(this.open).forEach((k) => { if (now - this.open[k].at > this.timeoutMs) delete this.open[k]; });
  }

  private open: Record<string, { n: number; parts: (string | undefined)[]; got: number; at: number }> = {};
}

// When a character's face may go onto its copy (or onto the player): its race is the one it was made with, never a
// beast form, no RaceMenu open or settling here, its 3D in, and not in a fight (a 3D rebuild there is the crash risk)
export interface ApplyGate {
  raceNow: number;
  presetRace: number;
  isBeast: boolean;
  raceMenuSettling: boolean;
  loaded3D: boolean;
  inCombat: boolean;
}

export const applyBlockedBy = (g: ApplyGate): string | null => {
  if (g.raceMenuSettling) return "racemenu";
  if (g.isBeast) return "beast";
  if (!g.loaded3D) return "3d";
  if (g.inCombat) return "combat";
  if (g.presetRace && (g.raceNow >>> 0) !== (g.presetRace >>> 0)) return "race";
  return null;
};

// Which copies need their face: one go per local copy and preset hash. A copy that respawns has a new local id and a
// fresh base (sync/appearance.ts createNpc), so it is due again.
export class ApplyLedger {
  isDone(localId: number, hash: string): boolean {
    return this.done[localId >>> 0] === hash;
  }

  markDone(localId: number, hash: string): void {
    this.done[localId >>> 0] = hash;
  }

  forget(localId: number): void {
    delete this.done[localId >>> 0];
  }

  // Drops copies that are gone; keeps the list bounded across a long session
  keepOnly(localIds: number[]): void {
    const keep: Record<number, string> = {};
    for (const id of localIds) if (this.done[id >>> 0] !== undefined) keep[id >>> 0] = this.done[id >>> 0];
    this.done = keep;
  }

  clear(): void {
    this.done = {};
  }

  private done: Record<number, string> = {};
}
