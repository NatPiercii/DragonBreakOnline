'use strict';
// RaceMenu extras SkyMP does not sync (client AppearanceExtrasService, fork appearanceExtrasPlan.ts): skee overlays,
// node scales (XPMSE body sliders) and body morphs. A player's client reads them after RaceMenu closes; this keeps them per
// character in appearance-extras.json (written only on a change, off the main thread) and hands them to the owner at
// each spawn and to every client that holds a copy of that player.
//
// Client -> Server: dboAppearanceExtras { f, ov, tr, mo }; dboAppearanceExtrasGet { self?, index?, ids? }
// Server -> Client: dboAppearanceExtras { actor, rev, self?, f, ov, tr, mo }; dboAppearanceExtrasIndex { revs };
//                   dboAppearanceExtrasRev { actor, rev } (rev 0: nothing kept)
// Config "appearanceExtras" (gamemode-config.json) may override DEFAULTS; enabled:false stops saving and serving.
const fs = require('fs');
const path = require('path');

const STORE_FILE = 'appearance-extras.json';
const DEFAULTS = {
  enabled: true,
  setMinSeconds: 3,
  maxChars: 32000,
  maxIdsPerAsk: 32,
  idsPerMinute: 400,
  writeDelayMs: 5000,
  // A size a sword fight can be won by stays out: the whole body and its frame within 10%, limbs and head within 25%
  scale: { height: [0.9, 1.1], frame: [0.9, 1.1], limb: [0.8, 1.25], other: [0.5, 2.0] },
  morph: [-1, 2],
};
const MAX_SLOT = 16;
const MAX_OVERRIDES = 160;
const MAX_TRANSFORMS = 128;
const MAX_MORPHS = 96;
const MAX_PATH = 160;

const OVERLAY_NODE = /^(Body|Hands|Feet|Face) \[Ovl([0-9]{1,2})\]$/;
const TRANSFORM_NODE = /^NPC( [A-Za-z0-9 _.\-\[\]]{1,44})?$/;
const SAFE_KEY = /^[A-Za-z0-9 _.:\-]{1,48}$/;
const MORPH_NAME = /^[A-Za-z0-9 _.\-]{1,48}$/;
const OVERLAY_TEXTURE = /^(textures\\)?actors\\character\\overlays\\[a-z0-9_ \-\\.()&'+]+\.dds$/;
// The nodes every other bone hangs from: their scales multiply into the whole body's size
const HEIGHT_NODES = new Set(['NPC', 'NPC Root [Root]', 'NPC COM [COM ]', 'NPC Pelvis [Pelv]']);
const FRAME_NODE = /Spine|Spn|Neck|Thigh|Calf|Foot|Toe/;
const LIMB_NODE = /Clavicle|UpperArm|Forearm|Hand|Head/;
// skee's override keys (OverrideVariant.h) and the range each may take
const OVERRIDE_KEYS = { 0: 'int', 1: [0, 10], 2: [0, 1000], 3: [0, 100], 7: 'int', 8: [0, 1], 9: 'string' };

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = (n) => Math.round(n * 10000) / 10000;
const cmp = (a, b) => { const x = JSON.stringify(a), y = JSON.stringify(b); return x < y ? -1 : x > y ? 1 : 0; };

const normalizeTexture = (raw) => {
  if (typeof raw !== 'string' || !raw || raw.length > MAX_PATH) return null;
  const p = raw.replace(/\//g, '\\').replace(/\\{2,}/g, '\\');
  const low = p.toLowerCase();
  if (low.includes('..') || low.includes(':') || !OVERLAY_TEXTURE.test(low) || /\\default\.dds$/.test(low)) return null;
  return p;
};

const scaleRange = (node, ranges) => (HEIGHT_NODES.has(node) ? ranges.height : FRAME_NODE.test(node) ? ranges.frame
  : LIMB_NODE.test(node) ? ranges.limb : ranges.other);

// Scales on one node multiply, so a node's keys are brought back together into its range, keeping their ratio
const fitProduct = (entries, lo, hi) => {
  if (!entries.length) return 0;
  const product = entries.reduce((p, e) => p * e[2], 1);
  const target = clamp(product, lo, hi);
  if (Math.abs(target - product) < 1e-6) return 0;
  const k = Math.pow(target / product, 1 / entries.length);
  for (const e of entries) e[2] = e[2] * k;
  return entries.length;
};

// What may be kept of a client's report. Returns { extras, clamped, dropped }.
const sanitize = (content, opts) => {
  const ranges = (opts && opts.scale) || DEFAULTS.scale;
  const morphRange = (opts && opts.morph) || DEFAULTS.morph;
  let dropped = 0;
  let clamped = 0;
  const f = Number(content && content.f) ? 1 : 0;

  const byNode = new Map();
  const ov = Array.isArray(content && content.ov) ? content.ov : [];
  if (ov.length > MAX_OVERRIDES) dropped += ov.length - MAX_OVERRIDES;
  for (const raw of ov.slice(0, MAX_OVERRIDES)) {
    if (!Array.isArray(raw) || raw.length !== 4) { dropped++; continue; }
    const node = String(raw[0]); const key = Number(raw[1]);
    const m = OVERLAY_NODE.exec(node);
    const rule = OVERRIDE_KEYS[key];
    if (!m || Number(m[2]) >= MAX_SLOT || !rule) { dropped++; continue; }
    let entry = null;
    if (rule === 'string') {
      const index = Number(raw[2]) === 1 ? 1 : 0;
      const tex = normalizeTexture(raw[3]);
      if (tex) entry = [node, key, index, tex];
    } else if (typeof raw[3] === 'number' && Number.isFinite(raw[3])) {
      if (rule === 'int') entry = [node, key, 0, raw[3] >>> 0];
      else { const v = clamp(raw[3], rule[0], rule[1]); if (v !== raw[3]) clamped++; entry = [node, key, 0, round(v)]; }
    }
    if (!entry) { dropped++; continue; }
    const list = byNode.get(node) || [];
    if (list.some((e) => e[1] === entry[1] && e[2] === entry[2])) { dropped++; continue; }
    list.push(entry);
    byNode.set(node, list);
  }
  const outOv = [];
  for (const [, list] of byNode) {
    // A slot without its own texture shows nothing: its other values are noise
    if (!list.some((e) => e[1] === 9 && e[2] === 0)) { dropped += list.length; continue; }
    outOv.push(...list);
  }

  const tr = Array.isArray(content && content.tr) ? content.tr : [];
  if (tr.length > MAX_TRANSFORMS) dropped += tr.length - MAX_TRANSFORMS;
  const outTr = [];
  const seenTr = new Set();
  for (const raw of tr.slice(0, MAX_TRANSFORMS)) {
    if (!Array.isArray(raw) || raw.length !== 4) { dropped++; continue; }
    const node = String(raw[0]); const key = String(raw[1]); const v = Number(raw[2]); const fp = raw[3] ? 1 : 0;
    if (!TRANSFORM_NODE.test(node) || !SAFE_KEY.test(key) || key === 'internal' || !Number.isFinite(v) || v <= 0) { dropped++; continue; }
    const id = `${fp}|${node}|${key}`;
    if (seenTr.has(id)) { dropped++; continue; }
    seenTr.add(id);
    outTr.push([node, key, clamp(v, 0.05, 20), fp]);
  }
  for (const fp of [0, 1]) {
    const nodes = new Map();
    for (const e of outTr) if (e[3] === fp) { const l = nodes.get(e[0]) || []; l.push(e); nodes.set(e[0], l); }
    for (const [node, list] of nodes) { const r = scaleRange(node, ranges); clamped += fitProduct(list, r[0], r[1]); }
    clamped += fitProduct(outTr.filter((e) => e[3] === fp && HEIGHT_NODES.has(e[0])), ranges.height[0], ranges.height[1]);
  }
  for (const e of outTr) e[2] = round(e[2]);

  const mo = Array.isArray(content && content.mo) ? content.mo : [];
  if (mo.length > MAX_MORPHS) dropped += mo.length - MAX_MORPHS;
  const outMo = [];
  const seenMo = new Set();
  for (const raw of mo.slice(0, MAX_MORPHS)) {
    if (!Array.isArray(raw) || raw.length !== 3) { dropped++; continue; }
    const name = String(raw[0]); const key = String(raw[1]); const v = Number(raw[2]);
    if (!MORPH_NAME.test(name) || !SAFE_KEY.test(key) || !Number.isFinite(v) || seenMo.has(`${name}|${key}`)) { dropped++; continue; }
    seenMo.add(`${name}|${key}`);
    const c = clamp(v, morphRange[0], morphRange[1]);
    if (c !== v) clamped++;
    if (Math.abs(c) > 1e-4) outMo.push([name, key, round(c)]);
  }

  return {
    extras: { f, ov: outOv.sort(cmp), tr: outTr.filter((e) => Math.abs(e[2] - 1) > 1e-4).sort(cmp), mo: outMo.sort(cmp) },
    clamped, dropped,
  };
};

const isEmpty = (x) => !x || (!x.ov.length && !x.tr.length && !x.mo.length);
const hex = (a) => (Number(a) >>> 0).toString(16);

module.exports = (ctx) => {
  const { log, cfg, sendPacket, onlineActors, profileOf, display } = ctx;
  const opts = Object.assign({}, DEFAULTS, (cfg && cfg.appearanceExtras) || {});
  const file = path.resolve(STORE_FILE);
  // Kept across hot reloads: the store, a pending write and the rate windows
  const state = globalThis.__dboAppearanceExtras || (globalThis.__dboAppearanceExtras = {});
  if (!state.store) {
    state.store = { v: 1, chars: {} };
    try {
      const read = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (read && typeof read.chars === 'object' && read.chars) state.store.chars = read.chars;
    } catch (e) { if (e.code !== 'ENOENT') log(`appearance-extras.json unreadable, starting empty: ${e.message}`); }
  }
  if (!(state.lastSet instanceof Map)) state.lastSet = new Map();
  if (!(state.asks instanceof Map)) state.asks = new Map();
  if (typeof state.writing !== 'boolean') state.writing = false;
  const chars = state.store.chars;

  // Async and coalesced: a sync write on this box stalls the server's main loop
  const scheduleWrite = () => {
    state.dirty = true;
    if (state.timer) return;
    state.timer = setTimeout(() => {
      state.timer = null;
      if (state.writing) { scheduleWrite(); return; }
      state.writing = true;
      state.dirty = false;
      const tmp = file + '.tmp';
      fs.promises.writeFile(tmp, JSON.stringify(state.store))
        .then(() => fs.promises.rename(tmp, file))
        .catch((e) => log(`appearance-extras.json write failed: ${e.message}`))
        .then(() => { state.writing = false; if (state.dirty) scheduleWrite(); });
    }, Number(opts.writeDelayMs) || 5000);
  };

  // A character's entry, if it is still theirs (an actor id handed to someone else's character keeps nothing)
  const entryOf = (a) => {
    const e = chars[hex(a)];
    if (!e) return null;
    const p = profileOf(a);
    return Number.isFinite(p) && p >= 0 && e.p === p ? e : null;
  };
  const packetOf = (a, e, self) => Object.assign({ customPacketType: 'dboAppearanceExtras', actor: a >>> 0, rev: e && !isEmpty(e) ? e.rev : 0 },
    self ? { self: true } : {}, e && !isEmpty(e) ? { f: e.f, ov: e.ov, tr: e.tr, mo: e.mo } : { f: 0, ov: [], tr: [], mo: [] });
  const revOf = (a) => { const e = entryOf(a); return e && !isEmpty(e) ? e.rev : 0; };
  const tellOthers = (a, rev) => {
    for (const b of onlineActors()) if ((b >>> 0) !== (a >>> 0)) sendPacket(b, { customPacketType: 'dboAppearanceExtrasRev', actor: a >>> 0, rev });
  };

  const prune = (now) => {
    if (state.lastSet.size > 500) for (const [k, t] of state.lastSet) if (now - t > 600000) state.lastSet.delete(k);
    if (state.asks.size > 500) for (const [k, w] of state.asks) if (now - w.since > 120000) state.asks.delete(k);
  };

  const onSet = (a, content) => {
    const now = Date.now();
    prune(now);
    const last = state.lastSet.get(a >>> 0) || 0;
    if (now - last < Number(opts.setMinSeconds) * 1000) { sendPacket(a, packetOf(a, entryOf(a), true)); return; }
    state.lastSet.set(a >>> 0, now);
    if (JSON.stringify(content).length > Number(opts.maxChars)) { log(`appearance extras from ${display(a)} refused: too large`); return; }
    const { extras, clamped, dropped } = sanitize(content, opts);
    const p = profileOf(a);
    if (!Number.isFinite(p) || p < 0) return;
    const prev = entryOf(a);
    const before = prev ? JSON.stringify({ f: prev.f, ov: prev.ov, tr: prev.tr, mo: prev.mo }) : JSON.stringify({ f: extras.f, ov: [], tr: [], mo: [] });
    if (before !== JSON.stringify(extras)) {
      const rev = ((chars[hex(a)] && chars[hex(a)].rev) || 0) + 1;
      chars[hex(a)] = { p, rev, at: new Date(now).toISOString(), f: extras.f, ov: extras.ov, tr: extras.tr, mo: extras.mo };
      scheduleWrite();
      tellOthers(a, isEmpty(extras) ? 0 : rev);
      log(`appearance extras saved for ${display(a)}: ${extras.ov.length} overlay value(s), ${extras.tr.length} scale(s), ${extras.mo.length} morph(s)`
        + `${clamped ? `, ${clamped} clamped` : ''}${dropped ? `, ${dropped} dropped` : ''} (rev ${rev})`);
    }
    sendPacket(a, packetOf(a, entryOf(a), true));
  };

  const onGet = (a, content) => {
    if (content.self) {
      sendPacket(a, packetOf(a, entryOf(a), true));
      // A spawn: the others learn this character's revision, and this client everyone else's
      const mine = revOf(a);
      if (mine) tellOthers(a, mine);
    }
    if (content.index) {
      const revs = [];
      for (const b of onlineActors()) { if ((b >>> 0) === (a >>> 0)) continue; const r = revOf(b); if (r) revs.push([b >>> 0, r]); }
      sendPacket(a, { customPacketType: 'dboAppearanceExtrasIndex', revs });
    }
    if (Array.isArray(content.ids)) {
      const now = Date.now();
      prune(now);
      let w = state.asks.get(a >>> 0);
      if (!w || now - w.since >= 60000) { w = { since: now, n: 0 }; state.asks.set(a >>> 0, w); }
      const ids = [...new Set(content.ids.slice(0, Number(opts.maxIdsPerAsk)).map((x) => Number(x) >>> 0))]
        .filter((x) => x >= 0xff000000 && x !== (a >>> 0));
      for (const id of ids) {
        if (w.n >= Number(opts.idsPerMinute)) break;
        w.n++;
        sendPacket(a, packetOf(id, entryOf(id), false));
      }
    }
  };

  globalThis.__dboAppearanceExtrasPacket = (a, content) => {
    if (!a || !content || opts.enabled === false) return;
    if (content.customPacketType === 'dboAppearanceExtras') onSet(a, content);
    else if (content.customPacketType === 'dboAppearanceExtrasGet') onGet(a, content);
  };
  log(`appearanceextras: ${Object.keys(chars).length} character(s) kept${opts.enabled === false ? ' (off)' : ''}`);
};
module.exports.sanitize = sanitize;
module.exports.normalizeTexture = normalizeTexture;
module.exports.DEFAULTS = DEFAULTS;
