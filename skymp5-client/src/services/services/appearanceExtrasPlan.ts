// RaceMenu extras that SkyMP does not sync, part 1: skee's overlays (tattoos, paint), node transforms (XPMSE size and
// proportion sliders) and body morphs. Pure logic, no SkyrimPlatform import, so a harness can drive it with a fake
// NiOverride (server tests/appearance-extras-plan-harness.js). appearanceExtrasService.ts makes the native calls.
//
// Every call goes through SkyrimPlatform callNative("NiOverride", fn, undefined, ...args) to skee64's Papyrus natives
// (skee64 PapyrusNiOverride.cpp RegisterFuncs). Facts this file relies on, read from skee's source (do not change them on
// a guess):
// - Each native takes exactly the argument count used here; callNative refuses any other count.
// - Per-reference data is keyed by the reference's form id. A 0xff.. copy id the game hands out again inherits whatever
//   was left on it, so a copy is cleared before it is deleted and before its first apply.
// - AddNodeOverride*(ref, isFemale, node, key, index, value, persist) stores the value and paints it at once when the
//   3D has the node. AddOverlays (copies only; a no-op on the player) puts the ref in the overlay set and queues the
//   overlay nodes' build, so a copy's overrides are re-applied (ApplyNodeOverrides) after a short wait.
// - AddNodeTransformScale only stores; UpdateNodeTransform paints one node. RemoveAllReferenceTransforms only forgets,
//   so a scale that must go back is first set to 1 and painted.
// - SetBodyMorph only stores; UpdateModelWeight paints (vertex buffers, no 3D reset). ClearMorphs forgets.
// - Override keys (OverrideVariant.h): 0 emissive colour (int), 1 emissive multiple, 2 glossiness, 3 specular strength,
//   7 tint colour (int), 8 alpha, 9 texture (string, index = texture slot). Only key 9 uses its index.
// - Int parameters reach Papyrus as (int)floor(number), so a colour above 0x7fffffff is passed as its signed value.
// - Transform key "internal" is skee's own (equippable transforms), rebuilt from the worn NIFs: never stored.

export const PACKET_SET = "dboAppearanceExtras";
export const PACKET_GET = "dboAppearanceExtrasGet";
export const PACKET_REV = "dboAppearanceExtrasRev";
export const PACKET_INDEX = "dboAppearanceExtrasIndex";

// [node, key, index, value]
export type OverrideEntry = [string, number, number, number | string];
// [node, key, scale, firstPerson 0/1]
export type TransformEntry = [string, string, number, number];
// [morph name, key, value]
export type MorphEntry = [string, string, number];

export interface Extras {
  f: number;
  ov: OverrideEntry[];
  tr: TransformEntry[];
  mo: MorphEntry[];
}

export const MAX_OVERLAYS_PER_AREA = 16;
export const MAX_OVERRIDES = 160;
export const MAX_TRANSFORMS = 128;
export const MAX_MORPHS = 96;
export const MAX_NAME = 48;
export const MAX_PATH = 160;

// The four overlay areas: skee's node name, and the native that says how many slots this client's skee64.ini made
export const OVERLAY_AREAS: { node: string; count: string }[] = [
  { node: "Body", count: "GetNumBodyOverlays" },
  { node: "Hands", count: "GetNumHandOverlays" },
  { node: "Feet", count: "GetNumFeetOverlays" },
  { node: "Face", count: "GetNumFaceOverlays" },
];

export type ValueKind = "int" | "float" | "string";
// After the slot's diffuse texture (9/0), the values read from and written to a slot
export const OVERLAY_EXTRA_KEYS: { key: number; index: number; kind: ValueKind }[] = [
  { key: 9, index: 1, kind: "string" },
  { key: 7, index: 0, kind: "int" },
  { key: 8, index: 0, kind: "float" },
  { key: 0, index: 0, kind: "int" },
  { key: 1, index: 0, kind: "float" },
  { key: 2, index: 0, kind: "float" },
  { key: 3, index: 0, kind: "float" },
];

export const kindOfKey = (key: number): ValueKind | null =>
  key === 9 ? "string" : key === 0 || key === 7 ? "int" : key === 1 || key === 2 || key === 3 || key === 8 ? "float" : null;

const OVERLAY_NODE = /^(Body|Hands|Feet|Face) \[Ovl([0-9]{1,2})\]$/;
const TRANSFORM_NODE = /^NPC( [A-Za-z0-9 _.\-\[\]]{1,44})?$/;
const SAFE_KEY = /^[A-Za-z0-9 _.:\-]{1,48}$/;
const MORPH_NAME = /^[A-Za-z0-9 _.\-]{1,48}$/;
const OVERLAY_TEXTURE = /^(textures\\)?actors\\character\\overlays\\[a-z0-9_ \-\\.()&'+]+\.dds$/;

export const overlayNode = (area: string, i: number): string => `${area} [Ovl${i}]`;
export const isOverlayNode = (node: string): boolean => {
  const m = OVERLAY_NODE.exec(node);
  return !!m && Number(m[2]) < MAX_OVERLAYS_PER_AREA;
};
export const isTransformNode = (node: string): boolean => typeof node === "string" && TRANSFORM_NODE.test(node);
export const isTransformKey = (key: string): boolean => typeof key === "string" && SAFE_KEY.test(key) && key !== "internal";
export const isMorphName = (name: string): boolean => typeof name === "string" && MORPH_NAME.test(name);
export const isMorphKey = (key: string): boolean => typeof key === "string" && SAFE_KEY.test(key);

// A texture path as the server accepts it: forward slashes made back, an empty or blank slot (default.dds) refused
export const normalizeTexture = (raw: unknown): string | null => {
  if (typeof raw !== "string" || !raw || raw.length > MAX_PATH) return null;
  const p = raw.replace(/\//g, "\\").replace(/\\{2,}/g, "\\");
  const low = p.toLowerCase();
  if (low.indexOf("..") >= 0 || low.indexOf(":") >= 0) return null;
  if (!OVERLAY_TEXTURE.test(low)) return null;
  if (/\\default\.dds$/.test(low)) return null;
  return p;
};

export const emptyExtras = (f: number): Extras => ({ f: f ? 1 : 0, ov: [], tr: [], mo: [] });
export const isEmpty = (x: Extras | null | undefined): boolean => !x || (!x.ov.length && !x.tr.length && !x.mo.length);

const cmp = (a: unknown[], b: unknown[]): number => {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
};
const round = (n: number): number => Math.round(n * 10000) / 10000;

// The same extras always serialise the same, so "unchanged" is a string compare
export const canonical = (x: Extras): Extras => ({
  f: x.f ? 1 : 0,
  ov: x.ov.map((e): OverrideEntry => [e[0], e[1], e[2], typeof e[3] === "number" ? (kindOfKey(e[1]) === "int" ? e[3] >>> 0 : round(e[3])) : e[3]]).sort(cmp),
  tr: x.tr.map((e): TransformEntry => [e[0], e[1], round(e[2]), e[3] ? 1 : 0]).sort(cmp),
  mo: x.mo.map((e): MorphEntry => [e[0], e[1], round(e[2])]).sort(cmp),
});
export const sameExtras = (a: Extras | null | undefined, b: Extras | null | undefined): boolean =>
  JSON.stringify(a ? canonical(a) : null) === JSON.stringify(b ? canonical(b) : null);

// What the client keeps of a server packet; anything malformed is dropped entry by entry
export const readExtras = (content: Record<string, unknown>): Extras => {
  const out = emptyExtras(Number(content["f"]) ? 1 : 0);
  const ov = Array.isArray(content["ov"]) ? (content["ov"] as unknown[]) : [];
  for (const raw of ov.slice(0, MAX_OVERRIDES)) {
    if (!Array.isArray(raw) || raw.length !== 4) continue;
    const node = String(raw[0]), key = Number(raw[1]), index = Number(raw[2]) || 0;
    const kind = kindOfKey(key);
    if (!isOverlayNode(node) || !kind) continue;
    if (kind === "string") {
      const tex = normalizeTexture(raw[3]);
      if (tex) out.ov.push([node, key, index === 1 ? 1 : 0, tex]);
    } else if (typeof raw[3] === "number" && isFinite(raw[3])) out.ov.push([node, key, 0, raw[3]]);
  }
  const tr = Array.isArray(content["tr"]) ? (content["tr"] as unknown[]) : [];
  for (const raw of tr.slice(0, MAX_TRANSFORMS)) {
    if (!Array.isArray(raw) || raw.length !== 4) continue;
    const scale = Number(raw[2]);
    if (!isTransformNode(String(raw[0])) || !isTransformKey(String(raw[1])) || !isFinite(scale) || scale <= 0) continue;
    out.tr.push([String(raw[0]), String(raw[1]), scale, raw[3] ? 1 : 0]);
  }
  const mo = Array.isArray(content["mo"]) ? (content["mo"] as unknown[]) : [];
  for (const raw of mo.slice(0, MAX_MORPHS)) {
    if (!Array.isArray(raw) || raw.length !== 3) continue;
    const v = Number(raw[2]);
    if (!isMorphName(String(raw[0])) || !isMorphKey(String(raw[1])) || !isFinite(v)) continue;
    out.mo.push([String(raw[0]), String(raw[1]), v]);
  }
  return out;
};

// ---- jobs: one reference's native calls, spread over frames --------------------------------------------------------

export type NativeCall = (fn: string, ...args: unknown[]) => unknown;
// A step makes one or a few native calls on the reference resolved this frame; a number back is a wait in ms
export type Step = (call: NativeCall, ref: unknown) => number | void;

export class Job {
  steps: Step[] = [];
  notBefore = 0;
  constructor(public readonly label: string) { }
  add(step: Step): this { this.steps.push(step); return this; }
  // Run these before the rest, in this order (a step found more work)
  next(steps: Step[]): void { this.steps.unshift(...steps); }
}

const asStrings = (v: unknown): string[] => (Array.isArray(v) ? v.map((s) => String(s)) : []);
const asBool = (v: unknown): boolean => v === true || v === 1;
// Papyrus ints arrive as (int)floor(x): a colour goes in as its signed 32-bit value
export const toPapyrusInt = (v: number): number => (Number(v) >>> 0) | 0;

// Reads the player's (or any ref's) extras. `done` gets them in canonical order.
export const captureJob = (isFemale: boolean, done: (x: Extras) => void): Job => {
  const job = new Job("capture");
  const out = emptyExtras(isFemale ? 1 : 0);
  const f = !!isFemale;
  job.add((call) => {
    const slots: Step[] = [];
    for (const area of OVERLAY_AREAS) {
      let n = 0;
      try { n = Math.max(0, Math.min(MAX_OVERLAYS_PER_AREA, Math.floor(Number(call(area.count)) || 0))); } catch { n = 0; }
      for (let i = 0; i < n; i++) {
        const node = overlayNode(area.node, i);
        slots.push((c, ref) => {
          if (out.ov.length >= MAX_OVERRIDES) return;
          if (!asBool(c("HasNodeOverride", ref, f, node, 9, 0))) return;
          const tex = normalizeTexture(c("GetNodeOverrideString", ref, f, node, 9, 0));
          if (!tex) return;
          out.ov.push([node, 9, 0, tex]);
          job.next(OVERLAY_EXTRA_KEYS.map((k): Step => (c2, ref2) => {
            if (out.ov.length >= MAX_OVERRIDES) return;
            if (!asBool(c2("HasNodeOverride", ref2, f, node, k.key, k.index))) return;
            if (k.kind === "string") {
              const t = normalizeTexture(c2("GetNodeOverrideString", ref2, f, node, k.key, k.index));
              if (t) out.ov.push([node, k.key, k.index, t]);
            } else {
              const v = Number(c2(k.kind === "int" ? "GetNodeOverrideInt" : "GetNodeOverrideFloat", ref2, f, node, k.key, k.index));
              if (isFinite(v)) out.ov.push([node, k.key, 0, k.kind === "int" ? v >>> 0 : v]);
            }
          }));
        });
      }
    }
    job.next(slots);
  });
  for (const fp of [false, true]) {
    job.add((call, ref) => {
      const names = asStrings(call("GetNodeTransformNames", ref, fp, f)).filter(isTransformNode);
      job.next(names.map((node): Step => (c, r) => {
        const keys = asStrings(c("GetNodeTransformKeys", r, fp, f, node)).filter(isTransformKey);
        job.next(keys.map((key): Step => (c2, r2) => {
          if (out.tr.length >= MAX_TRANSFORMS) return;
          if (!asBool(c2("HasNodeTransformScale", r2, fp, f, node, key))) return;
          const v = Number(c2("GetNodeTransformScale", r2, fp, f, node, key));
          if (isFinite(v) && v > 0 && Math.abs(v - 1) > 1e-4) out.tr.push([node, key, v, fp ? 1 : 0]);
        }));
      }));
    });
  }
  job.add((call, ref) => {
    const names = asStrings(call("GetMorphNames", ref)).filter(isMorphName);
    job.next(names.map((name): Step => (c, r) => {
      const keys = asStrings(c("GetMorphKeys", r, name)).filter(isMorphKey);
      job.next(keys.map((key): Step => (c2, r2) => {
        if (out.mo.length >= MAX_MORPHS) return;
        const v = Number(c2("GetBodyMorph", r2, name, key));
        if (isFinite(v) && Math.abs(v) > 1e-4) out.mo.push([name, key, v]);
      }));
    }));
  });
  job.add(() => { done(canonical(out)); });
  return job;
};

// Forgets everything skee holds for a copy. RemoveOverlays also takes its overlay nodes off the 3D; the rest only
// forgets, which is all a copy about to be deleted needs.
export const CLEAR_CALLS = ["ClearMorphs", "RemoveAllReferenceNodeOverrides", "RemoveAllReferenceTransforms", "RemoveOverlays"];
export const clearRef = (call: NativeCall, ref: unknown): void => {
  for (const fn of CLEAR_CALLS) {
    try { call(fn, ref); } catch { /* the next one still runs */ }
  }
};

export const OVERLAY_SETTLE_MS = 600;

const addOverride = (call: NativeCall, ref: unknown, f: boolean, e: OverrideEntry): void => {
  const kind = kindOfKey(e[1]);
  if (kind === "string") call("AddNodeOverrideString", ref, f, e[0], e[1], e[2], String(e[3]), true);
  else if (kind === "int") call("AddNodeOverrideInt", ref, f, e[0], e[1], e[2], toPapyrusInt(Number(e[3])), true);
  else if (kind === "float") call("AddNodeOverrideFloat", ref, f, e[0], e[1], e[2], Number(e[3]), true);
};

// Paints `x` on a reference. A copy (player false) is cleared first: `prev` is what this client put on it before, whose
// scales are set back to 1 and painted, since forgetting a transform leaves the node as it was.
export const applyJob = (isFemale: boolean, x: Extras, opts: { player: boolean; prev?: Extras | null }): Job => {
  const job = new Job(opts.player ? "apply-player" : "apply-copy");
  const f = !!isFemale;
  const prev = opts.prev || null;
  const tr = opts.player ? x.tr : x.tr.filter((e) => !e[3]);
  if (!opts.player) {
    const keep = new Set(tr.map((e) => `${e[0]}\u0000${e[1]}`));
    const back = prev ? prev.tr.filter((e) => !e[3] && !keep.has(`${e[0]}\u0000${e[1]}`)) : [];
    for (const e of back) job.add((call, ref) => { call("AddNodeTransformScale", ref, false, f, e[0], e[1], 1.0); });
    for (const node of uniq(back.map((e) => e[0]))) job.add((call, ref) => { call("UpdateNodeTransform", ref, false, f, node); });
    job.add((call, ref) => { clearRef(call, ref); });
    if (x.ov.length) {
      job.add((call, ref) => { call("AddOverlays", ref); return OVERLAY_SETTLE_MS; });
    }
  }
  for (const e of x.ov) job.add((call, ref) => { addOverride(call, ref, f, e); });
  if (x.ov.length) job.add((call, ref) => { call("ApplyNodeOverrides", ref); });
  for (const e of tr) job.add((call, ref) => { call("AddNodeTransformScale", ref, !!e[3], f, e[0], e[1], e[2]); });
  const painted = uniq(tr.map((e) => `${e[3] ? 1 : 0}\u0000${e[0]}`));
  for (const p of painted) {
    const fp = p.charAt(0) === "1", node = p.slice(2);
    job.add((call, ref) => { call("UpdateNodeTransform", ref, fp, f, node); });
  }
  for (const e of x.mo) job.add((call, ref) => { call("SetBodyMorph", ref, e[0], e[1], e[2]); });
  if (x.mo.length || (prev && prev.mo.length && !opts.player)) job.add((call, ref) => { call("UpdateModelWeight", ref); });
  return job;
};

function uniq(xs: string[]): string[] {
  const seen: Record<string, true> = {};
  const out: string[] = [];
  for (const s of xs) if (!seen[s]) { seen[s] = true; out.push(s); }
  return out;
}

// Runs jobs round robin under a per-frame call budget. A job whose reference is gone this frame is dropped.
export class JobRunner {
  private jobs = new Map<number, Job>();
  private order: number[] = [];

  get size(): number { return this.jobs.size; }
  has(refId: number): boolean { return this.jobs.has(refId); }

  // A new job for a reference replaces its unfinished one
  put(refId: number, job: Job): void {
    if (!this.jobs.has(refId)) this.order.push(refId);
    this.jobs.set(refId, job);
  }

  drop(refId: number): void {
    this.jobs.delete(refId);
    this.order = this.order.filter((id) => id !== refId);
  }

  run(call: NativeCall, resolve: (refId: number) => unknown, now: number, budget: number,
    onError: (job: Job, e: unknown) => void): number {
    let used = 0;
    const counted: NativeCall = (fn, ...args) => { used++; return call(fn, ...args); };
    let idle = 0;
    while (used < budget && this.order.length && idle < this.order.length) {
      const refId = this.order.shift() as number;
      const job = this.jobs.get(refId);
      if (!job) { continue; }
      if (job.notBefore > now) { this.order.push(refId); idle++; continue; }
      const ref = resolve(refId);
      if (!ref) { this.jobs.delete(refId); continue; }
      idle = 0;
      const step = job.steps.shift();
      if (step) {
        try {
          const wait = step(counted, ref);
          if (typeof wait === "number" && wait > 0) job.notBefore = now + wait;
        } catch (e) {
          onError(job, e);
        }
      }
      if (job.steps.length) this.order.push(refId);
      else this.jobs.delete(refId);
    }
    return used;
  }
}

// ---- which copies need what --------------------------------------------------------------------------------------

export interface CopyInfo {
  remote: number;
  local: number;
  loaded: boolean;
  guarded: boolean;
  female: boolean;
  // RaceMenu part 2 (face presets) stamps a copy when its preset load wiped these extras
  presetAt?: number;
}

export interface Applied {
  remote: number;
  rev: number;
  extras: Extras;
  loaded: boolean;
  at: number;
}

export interface Plan {
  requests: number[];
  applies: { local: number; remote: number; female: boolean; extras: Extras; prev: Extras | null }[];
  clears: number[];
}

export const REQUEST_RETRY_MS = 15000;
export const MAX_REQUEST_IDS = 16;

export class RemoteTracker {
  // remote actor -> its extras' revision, from the index and the change pushes (0: none)
  revs = new Map<number, number>();
  // remote actor -> the extras last received, with their revision
  data = new Map<number, { rev: number; extras: Extras }>();
  // local copy -> what this client painted on it
  applied = new Map<number, Applied>();
  requestedAt = new Map<number, number>();
  // local ids that may still carry skee data although no copy of ours holds them (deleted before a clear could run)
  dirty = new Set<number>();
  reapply = new Set<number>();

  setIndex(pairs: unknown): void {
    if (!Array.isArray(pairs)) return;
    for (const p of pairs) {
      if (!Array.isArray(p)) continue;
      const remote = Number(p[0]) >>> 0, rev = Number(p[1]) >>> 0;
      if (remote) this.revs.set(remote, rev);
    }
  }

  setRev(remote: number, rev: number): void {
    remote = remote >>> 0;
    if (!remote) return;
    this.revs.set(remote, rev >>> 0);
    if (!rev) this.data.delete(remote);
  }

  setData(remote: number, rev: number, extras: Extras): void {
    remote = remote >>> 0;
    if (!remote) return;
    this.revs.set(remote, rev >>> 0);
    this.data.set(remote, { rev: rev >>> 0, extras });
    this.requestedAt.delete(remote);
  }

  // A copy is about to be deleted: true when it carries something of ours, so the caller clears it now
  forget(local: number): boolean {
    const had = this.applied.delete(local);
    this.reapply.delete(local);
    return had;
  }

  plan(copies: CopyInfo[], now: number): Plan {
    const out: Plan = { requests: [], applies: [], clears: [] };
    const seen = new Set<number>();
    for (const c of copies) {
      seen.add(c.local);
      let a = this.applied.get(c.local);
      if (this.dirty.has(c.local)) {
        this.dirty.delete(c.local);
        out.clears.push(c.local);
      }
      // The game handed this copy's id to another actor: what we painted belongs to the old one
      if (a && a.remote !== c.remote) {
        if (out.clears.indexOf(c.local) < 0) out.clears.push(c.local);
        this.applied.delete(c.local);
        a = undefined;
      }
      if (c.guarded) {
        if (a) { out.clears.push(c.local); this.applied.delete(c.local); }
        continue;
      }
      const rev = this.revs.get(c.remote) || 0;
      if (!c.loaded) {
        if (a) a.loaded = false;
        continue;
      }
      if (!rev) {
        // Its owner removed everything: paint nothing over what we painted
        if (a && !isEmpty(a.extras)) {
          const empty = emptyExtras(c.female ? 1 : 0);
          out.applies.push({ local: c.local, remote: c.remote, female: c.female, extras: empty, prev: a.extras });
          this.applied.set(c.local, { remote: c.remote, rev: 0, extras: empty, loaded: true, at: now });
        }
        continue;
      }
      const d = this.data.get(c.remote);
      if (!d || d.rev !== rev) {
        const asked = this.requestedAt.get(c.remote);
        if ((asked === undefined || now - asked >= REQUEST_RETRY_MS) && out.requests.length < MAX_REQUEST_IDS && out.requests.indexOf(c.remote) < 0) {
          out.requests.push(c.remote);
          this.requestedAt.set(c.remote, now);
        }
        continue;
      }
      const need = !a || a.rev !== d.rev || !a.loaded || this.reapply.has(c.local) || (!!c.presetAt && c.presetAt > a.at);
      if (need) {
        this.reapply.delete(c.local);
        out.applies.push({ local: c.local, remote: c.remote, female: c.female, extras: d.extras, prev: a ? a.extras : null });
        this.applied.set(c.local, { remote: c.remote, rev: d.rev, extras: d.extras, loaded: true, at: now });
      }
    }
    // Copies gone without passing through forget(): clear the ones still there, remember the ids of the rest
    this.applied.forEach((_a, local) => {
      if (seen.has(local)) return;
      this.applied.delete(local);
      out.clears.push(local);
    });
    return out;
  }
}
