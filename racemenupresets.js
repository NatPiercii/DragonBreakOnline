'use strict';
// RaceMenu face presets per character: custom sliders, expressions and sculpt, the face part of a skee .jslot. The
// owner's client (fork racemenuPresetService.ts) uploads it after RaceSexMenu closes; watchers' clients and the owner
// after a login fetch it and load it onto the copy (CharGen.LoadCharacterPresetEx, face only). One file per character
// in racemenu-presets/ (gitignored), written only when the face changes. Everything is checked here, because skee
// adds a sculpt's offsets to the head's vertices with no bounds check: a bad preset could crash every watcher.
// Config "racemenuPresets": { enabled, dir, ... }; enabled false answers every request with "off", and clients stop.
const fs = require('fs');
const path = require('path');

const MAX_CUSTOM_MORPHS = 1024;
const MAX_MORPH_NAME = 128;
// RaceMenu's ranges (skee FaceMorphInterface.cpp): a slider runs -1..1 times fSliderMultiplier (1.0 unless skee64.ini
// changes it) and is applied once per whole unit past 1; a preset slider is a whole number 0..its preset count
const MAX_SLIDER = 1;
const MAX_PRESET_INDEX = 32;
const morphValueOk = (v) => typeof v === 'number' && Number.isFinite(v) && (Number.isInteger(v) ? v >= -MAX_SLIDER && v <= MAX_PRESET_INDEX : Math.abs(v) <= MAX_SLIDER);
// A sculpt moves a vertex at most this many units (a head is about 20 across)
const MAX_SCULPT_UNITS = 30;
const MAX_SCULPT_HOSTS = 16;
const MAX_VERTICES = 65535;
const MAX_SCULPT_OFFSET = 10000000;
const MAX_SCULPT_DIVISOR = 1000000;
const MAX_MOD_NAMES = 512;
const MAX_MOD_NAME = 260;
const MAX_TRI_PATH = 200;
const HASH_RX = /^[0-9a-f]{8}$/;
const KEY_RX = /^[0-9a-f]{8}$/;

const isObject = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const isUint32 = (x) => typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= 0xffffffff;
const isIntIn = (x, lo, hi) => typeof x === 'number' && Number.isInteger(x) && x >= lo && x <= hi;
const isCleanString = (x, max) => typeof x === 'string' && x.length > 0 && x.length <= max && !/[\u0000-\u001f\u007f]/.test(x);
// The platform's rule (fork skyrim-platform PresetFiles.cpp ValidateTriPath)
const isTriPath = (x) => typeof x === 'string' && x.length > 0 && x.length <= MAX_TRI_PATH && /^[A-Za-z0-9_\-. \\/]+$/.test(x)
  && !/^[\\/ ]/.test(x) && x.indexOf('..') === -1 && /\.tri$/i.test(x);

// FNV-1a over UTF-16 code units, 8 hex digits, as the client's hashText
const hashText = (text) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return ('0000000' + h.toString(16)).slice(-8);
};

// The client's facePresetFrom over its own encoded form: null when any rule is broken
const faceFrom = (raw) => {
  if (!isObject(raw)) return null;
  const v = raw.version;
  if (!isObject(v) || !isUint32(v.signature) || !isUint32(v.formatVersion) || v.formatVersion < 1) return null;
  const version = { signature: v.signature, formatVersion: v.formatVersion, skseVersion: isUint32(v.skseVersion) ? v.skseVersion : 0, runtimeVersion: isUint32(v.runtimeVersion) ? v.runtimeVersion : 0 };
  const modNames = [];
  for (const n of Array.isArray(raw.modNames) ? raw.modNames : []) if (isCleanString(n, MAX_MOD_NAME) && modNames.length < MAX_MOD_NAMES && !modNames.includes(n)) modNames.push(n);
  if (!modNames.length) modNames.push('Skyrim.esm');
  const customIn = raw.custom === undefined || raw.custom === null ? [] : raw.custom;
  if (!Array.isArray(customIn) || customIn.length > MAX_CUSTOM_MORPHS) return null;
  const custom = [];
  for (const m of customIn) {
    if (!isObject(m) || !isCleanString(m.name, MAX_MORPH_NAME)) return null;
    if (!morphValueOk(m.value)) return null;
    if (m.value !== 0) custom.push({ name: m.name, value: m.value });
  }
  const sculptIn = raw.sculpt === undefined || raw.sculpt === null ? [] : raw.sculpt;
  if (!Array.isArray(sculptIn) || sculptIn.length > MAX_SCULPT_HOSTS) return null;
  const hasSculpt = sculptIn.some((h) => isObject(h) && Array.isArray(h.data) && h.data.length > 0);
  if (hasSculpt && !isIntIn(raw.sculptDivisor, 1, MAX_SCULPT_DIVISOR)) return null;
  const sculptDivisor = hasSculpt ? raw.sculptDivisor : 10000;
  const maxOffset = Math.min(MAX_SCULPT_OFFSET, MAX_SCULPT_UNITS * sculptDivisor);
  const sculpt = [];
  for (const h of sculptIn) {
    if (!isObject(h) || !isTriPath(h.host) || !isIntIn(h.vertices, 1, MAX_VERTICES)) return null;
    const data = h.data === undefined || h.data === null ? [] : h.data;
    if (!Array.isArray(data) || data.length > h.vertices) return null;
    const out = [];
    for (const e of data) {
      if (!Array.isArray(e) || e.length !== 4 || !isIntIn(e[0], 0, h.vertices - 1)) return null;
      for (let k = 1; k < 4; k++) if (!isIntIn(e[k], -maxOffset, maxOffset)) return null;
      out.push([e[0], e[1], e[2], e[3]]);
    }
    if (out.length && !sculpt.some((o) => o.host.toLowerCase() === h.host.toLowerCase())) sculpt.push({ host: h.host, vertices: h.vertices, data: out });
  }
  return { version, modNames, custom, sculptDivisor: sculpt.length ? sculptDivisor : 10000, sculpt };
};

// The client's encodeFace: one face is always one text
const encodeFace = (f) => JSON.stringify({
  version: { signature: f.version.signature, formatVersion: f.version.formatVersion, skseVersion: f.version.skseVersion, runtimeVersion: f.version.runtimeVersion },
  modNames: f.modNames,
  custom: f.custom.map((m) => ({ name: m.name, value: m.value })),
  sculptDivisor: f.sculptDivisor,
  sculpt: f.sculpt.map((h) => ({ host: h.host, vertices: h.vertices, data: h.data })),
});

const chunkText = (text, size) => { const out = []; for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size)); return out; };

module.exports = (api) => {
  const { mp, log, sendPacket, onlineActors, actorOf, profileOf, cfg } = api;
  const C = Object.assign({
    enabled: true,
    dir: 'racemenu-presets',
    maxChars: 1000000,          // the client's PRESET_MAX_CHARS
    chunkChars: 12000,          // the client's CHUNK_CHARS
    sendMs: 250,                // one chunk per recipient this often: a sculpted face takes a few seconds, never a burst
    uploadTimeoutMs: 60000,
    uploadsPerHour: 30,         // per character; each one that changes the face is a file write
    getsPerMinute: 120,         // per player; one per copy that spawns, retried every 15 s at most
    cacheEntries: 16,
    cacheChars: 4000000,        // the read cache holds at most this much face text
    queuePerRecipient: 200,     // packets waiting for one player (a few faces); more waits for the client's retry
  }, (cfg && cfg.racemenuPresets) || {});
  const DIR = path.resolve(C.dir);
  const MAX_CHUNKS = Math.ceil(Number(C.maxChars) / Number(C.chunkChars));

  // Kept across a hot reload: uploads in flight, send queues, rate counters, the read cache, writes in flight
  const old = globalThis.__dboPresetState;
  const S = old && old.v === 1 ? old : (globalThis.__dboPresetState = { v: 1, uploads: new Map(), queues: new Map(), rates: new Map(), cache: new Map(), writing: new Map() });

  const keyOf = (a) => ((Number(a) >>> 0).toString(16)).padStart(8, '0');
  const fileOf = (k) => path.join(DIR, `${k}.json`);
  const isPlayer = (a) => profileOf(a) >= 0;
  const raceOf = (a) => { try { const ap = mp.get(a, 'appearance'); return ap && Number.isInteger(ap.raceId) ? ap.raceId >>> 0 : 0; } catch (e) { return 0; } };
  // In a beast form the appearance carries the beast race (beastform.js keeps the real one): no face is taken then
  const inBeastForm = (a) => { try { return typeof globalThis.__dboBeastOriginalRace === 'function' && globalThis.__dboBeastOriginalRace(a) > 0; } catch (e) { return true; } };

  // ---- storage: one file per character, the cache in front of it ----
  const remember = (k, doc) => {
    S.cache.delete(k);
    S.cache.set(k, doc);
    const chars = () => { let n = 0; for (const d of S.cache.values()) n += d && d.face ? d.face.length : 0; return n; };
    while (S.cache.size > Number(C.cacheEntries) || (S.cache.size > 1 && chars() > Number(C.cacheChars))) S.cache.delete(S.cache.keys().next().value);
  };
  // doc: { v, actor, profile, race, hash, face } or null for none; a file another character's profile wrote is none
  const readDoc = (a, cb) => {
    const k = keyOf(a);
    if (!KEY_RX.test(k)) return cb(null);
    const check = (doc) => (doc && doc.profile === profileOf(a) ? doc : null);
    if (S.cache.has(k)) return cb(check(S.cache.get(k)));
    fs.readFile(fileOf(k), 'utf8', (err, text) => {
      let doc = null;
      if (!err) {
        try {
          const d = JSON.parse(text);
          if (d && typeof d.face === 'string' && d.face.length <= Number(C.maxChars) && HASH_RX.test(d.hash) && hashText(d.face) === d.hash && faceFrom(JSON.parse(d.face))) doc = d;
          else log(`racemenu presets: ${k}.json fails its checks, ignored`);
        } catch (e) { log(`racemenu presets: ${k}.json unreadable, ignored`); }
      }
      remember(k, doc);
      cb(check(doc));
    });
  };
  // One write per character at a time; a newer face waits for the one in flight, and only the newest is written
  const writeDoc = (k, doc) => {
    remember(k, doc);
    const w = S.writing.get(k);
    if (w) { w.next = doc; return; }
    const run = (d) => {
      S.writing.set(k, { next: undefined });
      const done = (err) => {
        if (err) log(`racemenu presets: write ${k} failed`, err.message);
        const again = S.writing.get(k);
        S.writing.delete(k);
        if (again && again.next !== undefined) run(again.next);
      };
      fs.mkdir(DIR, { recursive: true }, (mkErr) => {
        if (mkErr) return done(mkErr);
        if (d === null) return fs.unlink(fileOf(k), (e) => done(e && e.code !== 'ENOENT' ? e : null));
        const tmp = fileOf(k) + '.tmp';
        fs.writeFile(tmp, JSON.stringify(d), (e) => (e ? done(e) : fs.rename(tmp, fileOf(k), done)));
      });
    };
    run(doc);
  };

  // ---- sending, paced per recipient ----
  const enqueue = (to, payloads) => {
    const q = S.queues.get(to) || [];
    // A newer answer about the same character replaces one still waiting
    const about = payloads.length ? payloads[0].actor : 0;
    const kept = q.filter((p) => p.actor !== about);
    if (kept.length + payloads.length > Number(C.queuePerRecipient)) { S.queues.set(to, kept); return false; }
    S.queues.set(to, kept.concat(payloads));
    return true;
  };
  const pump = () => {
    if (!S.queues.size) return;
    const online = new Set(onlineActors().map((x) => x >>> 0));
    for (const [to, q] of S.queues) {
      if (!online.has(to) || !q.length) { S.queues.delete(to); continue; }
      sendPacket(to, q.shift());
      if (!q.length) S.queues.delete(to);
    }
  };
  if (typeof api.every === 'function') api.every('racemenuPresetSend', Number(C.sendMs), pump);
  else { if (S.timer) clearInterval(S.timer); S.timer = setInterval(pump, Number(C.sendMs)); }

  const answer = (to, a, doc, have, self) => {
    const actor = a >>> 0;
    const base = self ? { actor, self: true } : { actor };
    if (!doc) return enqueue(to, [{ customPacketType: 'dboPresetNone', ...base }]);
    const meta = { customPacketType: 'dboPresetMeta', ...base, hash: doc.hash, race: doc.race };
    if (have === doc.hash) return enqueue(to, [meta]);
    const chunks = chunkText(doc.face, Number(C.chunkChars));
    enqueue(to, [meta].concat(chunks.map((data, i) => ({ customPacketType: 'dboPresetChunk', ...base, hash: doc.hash, race: doc.race, i, n: chunks.length, data }))));
  };

  // ---- rate limits ----
  const allow = (kind, who, perWindow, windowMs) => {
    const k = `${kind}:${who}`;
    const now = Date.now();
    const r = (S.rates.get(k) || []).filter((t) => now - t < windowMs);
    if (r.length >= perWindow) { S.rates.set(k, r); return false; }
    r.push(now);
    S.rates.set(k, r);
    if (S.rates.size > 5000) S.rates.clear();
    return true;
  };

  // ---- the packets ----
  const onGet = (userId, content) => {
    const me = actorOf(userId); if (!me) return;
    const self = Number(content.actor) === 0;
    if (!C.enabled) return enqueue(me, [{ customPacketType: 'dboPresetNone', actor: self ? me : (Number(content.actor) >>> 0) || me, self, off: true }]);
    if (!allow('get', me, Number(C.getsPerMinute), 60000)) return;
    const a = self ? me : Number(content.actor) >>> 0;
    if (!a || !isPlayer(a)) return enqueue(me, [{ customPacketType: 'dboPresetNone', actor: a || me, ...(self ? { self: true } : {}) }]);
    const have = typeof content.have === 'string' ? content.have : '';
    readDoc(a, (doc) => answer(me, a, doc, have, self));
  };

  const finishUpload = (me, u) => {
    const k = keyOf(me);
    if (inBeastForm(me)) { log(`racemenu presets: ${k} upload in a beast form, refused`); return; }
    const race = raceOf(me);
    if (!race) { log(`racemenu presets: ${k} has no appearance race, upload refused`); return; }
    let doc = null;
    if (u.n > 0) {
      const text = u.parts.join('');
      if (text.length > Number(C.maxChars) || hashText(text) !== u.hash) { log(`racemenu presets: ${k} upload does not match its hash, refused`); return; }
      let face = null;
      try { face = faceFrom(JSON.parse(text)); } catch (e) { face = null; }
      if (!face) { log(`racemenu presets: ${k} upload breaks the preset rules, refused`); return; }
      const encoded = encodeFace(face);
      if (face.custom.length || face.sculpt.length) doc = { v: 1, actor: k, profile: profileOf(me), race, hash: hashText(encoded), at: new Date().toISOString(), face: encoded };
    }
    readDoc(me, (prev) => {
      if ((prev ? prev.hash : '') === (doc ? doc.hash : '')) return;
      writeDoc(k, doc);
      log(`racemenu presets: ${k} (profile ${profileOf(me)}) ${doc ? `face saved, ${doc.face.length} chars, ${doc.hash}` : 'face cleared'}`);
      const rev = { customPacketType: 'dboPresetRev', actor: me >>> 0, hash: doc ? doc.hash : '' };
      for (const b of onlineActors()) if ((b >>> 0) !== (me >>> 0)) sendPacket(b, rev);
    });
  };

  const onPut = (userId, content) => {
    if (!C.enabled) return;
    const me = actorOf(userId); if (!me || !isPlayer(me)) return;
    const up = Number(content.up), n = Number(content.n), i = Number(content.i);
    const hash = typeof content.hash === 'string' ? content.hash : '';
    const data = typeof content.data === 'string' ? content.data : '';
    if (!Number.isInteger(up) || !isIntIn(n, 0, MAX_CHUNKS) || data.length > Number(C.chunkChars)) return;
    if (n === 0) {
      if (!allow('put', me, Number(C.uploadsPerHour), 3600000)) return;
      S.uploads.delete(me);
      return finishUpload(me, { n: 0 });
    }
    if (!HASH_RX.test(hash) || !isIntIn(i, 0, n - 1)) return;
    const now = Date.now();
    let u = S.uploads.get(me);
    if (u && now - u.at > Number(C.uploadTimeoutMs)) u = null;
    if (!u || u.up !== up || u.n !== n || u.hash !== hash) {
      if (!allow('put', me, Number(C.uploadsPerHour), 3600000)) { S.uploads.delete(me); return; }
      u = { up, n, hash, parts: new Array(n), got: 0, at: now };
      S.uploads.set(me, u);
    }
    u.at = now;
    if (u.parts[i] === undefined) { u.parts[i] = data; u.got++; }
    if (u.got < u.n) return;
    S.uploads.delete(me);
    finishUpload(me, u);
  };

  globalThis.__dboPresetPacket = (userId, content) => {
    try {
      if (content.customPacketType === 'dboPresetGet') return onGet(userId, content);
      if (content.customPacketType === 'dboPresetPut') return onPut(userId, content);
    } catch (e) { log('racemenu presets: packet failed', e.message); }
  };

  return { faceFrom, encodeFace, hashText, isTriPath, state: S, dir: DIR, pump };
};
module.exports.faceFrom = faceFrom;
module.exports.encodeFace = encodeFace;
module.exports.hashText = hashText;
