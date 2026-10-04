// Scripted test for racemenupresets.js: RaceMenu face presets per character, uploaded in chunks after RaceSexMenu,
// checked, written once per change to racemenu-presets/<actor>.json, served to watchers in paced chunks, a "have"
// answered with the header only, the owner's own face after a login, clears, rev notices, the profile check on read,
// tampered files, the off switch, rate limits and a hot reload. Runs against a fake mp in a scratch folder.
// Run it from this folder's parent:
//
//   node tests/racemenu-presets-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MOD = path.join(ROOT, 'racemenupresets.js');
let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && got !== undefined ? '   ' + JSON.stringify(got).slice(0, 300) : ''}`); if (!ok) failures++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// Until every file write and read under way is done (a loaded box takes longer than any fixed wait)
const settle = async () => {
  for (let i = 0; i < 300; i++) {
    await wait(10);
    const st = globalThis.__dboPresetState;
    if ((!st || !st.writing.size) && pendingReads === 0) break;
  }
  await wait(10);
};
let pendingReads = 0;
{
  const realRead = fs.readFile;
  fs.readFile = (...x) => { pendingReads++; const cb = x[x.length - 1]; x[x.length - 1] = (...r) => { pendingReads--; cb(...r); }; return realRead(...x); };
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-rmpresets-'));
const A = 0xff000a01, B = 0xff000b02, NPC = 0xff00c003;
const users = { 1: A, 2: B };
const props = { [A]: { profileId: 61, appearance: { raceId: 0x13746 } }, [B]: { profileId: 7, appearance: { raceId: 0x13741 } }, [NPC]: { profileId: -1 } };
let online = [A, B];
const sent = [];
const logs = [];
const timers = {};
const mp = { get: (a, k) => (props[a >>> 0] || {})[k] };
const api = (extra) => ({
  mp, log: (...x) => logs.push(x.join(' ')), cfg: { racemenuPresets: Object.assign({ dir: path.join(TMP, 'racemenu-presets') }, extra || {}) },
  sendPacket: (a, p) => { sent.push({ to: a >>> 0, p }); return true; },
  onlineActors: () => online.slice(),
  actorOf: (u) => users[u] || 0,
  profileOf: (a) => { const v = (props[a >>> 0] || {}).profileId; return v === undefined ? -1 : v; },
  every: (name, ms, fn) => { timers[name] = fn; },
});
const load = (extra) => { delete require.cache[MOD]; return require(MOD)(api(extra)); };
const packet = (userId, p) => globalThis.__dboPresetPacket(userId, p);
const pumpAll = () => { for (let i = 0; i < 500; i++) timers.racemenuPresetSend(); };
const take = () => sent.splice(0, sent.length);
const fileOf = (a) => path.join(TMP, 'racemenu-presets', `${(a >>> 0).toString(16)}.json`);

const P = require(MOD);
const face = { version: { signature: 1163086675, formatVersion: 3, skseVersion: 1, runtimeVersion: 2 }, modNames: ['Skyrim.esm'], custom: [{ name: 'NoseBridge', value: 0.4 }], sculptDivisor: 10000,
  sculpt: [{ host: 'Actors\\Character\\Character Assets\\FemaleHeadChargen.tri', vertices: 9001, data: [[0, 120, -30, 5], [17, 0, 0, 10000]] }] };
const text = P.encodeFace(face);
const hash = P.hashText(text);
const upload = (userId, t, up, size) => {
  const parts = []; for (let i = 0; i < t.length; i += size || 12000) parts.push(t.slice(i, i + (size || 12000)));
  parts.forEach((data, i) => packet(userId, { customPacketType: 'dboPresetPut', up, i, n: parts.length, hash: P.hashText(t), race: 1, data }));
  return parts.length;
};

(async () => {
  let M = load();
  check('the packet handler is installed', typeof globalThis.__dboPresetPacket === 'function');

  // ---- an upload ----
  upload(1, text, 1);
  await settle();
  check('the face is written to racemenu-presets/<actor>.json', fs.existsSync(fileOf(A)));
  const doc = JSON.parse(fs.readFileSync(fileOf(A), 'utf8'));
  check('the file holds the face, its hash, the profile and the server-side race', doc.face === text && doc.hash === hash && doc.profile === 61 && doc.race === 0x13746 && doc.actor === 'ff000a01', doc);
  let s = take();
  check('everyone else online hears a rev notice, the owner does not', s.length === 1 && s[0].to === B && s[0].p.customPacketType === 'dboPresetRev' && s[0].p.hash === hash && s[0].p.actor === A, s);

  // ---- a watcher asks ----
  packet(2, { customPacketType: 'dboPresetGet', actor: A, have: '' });
  await settle();
  check('nothing is sent before the pump (paced)', take().length === 0);
  timers.racemenuPresetSend();
  s = take();
  check('one packet per pump per recipient, the header first', s.length === 1 && s[0].p.customPacketType === 'dboPresetMeta' && s[0].p.hash === hash && s[0].p.race === 0x13746, s);
  pumpAll();
  s = take();
  check('then the chunks, which join back to the face', s.length === 1 && s[0].p.customPacketType === 'dboPresetChunk' && s[0].p.n === 1 && s[0].p.data === text && s[0].p.race === 0x13746, s.length);
  packet(2, { customPacketType: 'dboPresetGet', actor: A, have: hash });
  await settle(); pumpAll();
  s = take();
  check('a client that has this hash gets the header only', s.length === 1 && s[0].p.customPacketType === 'dboPresetMeta', s);

  // ---- the owner after a login ----
  packet(1, { customPacketType: 'dboPresetGet', actor: 0, have: '' });
  await settle(); pumpAll();
  s = take();
  check('actor 0 is the asker\'s own face, marked self', s.length === 2 && s.every((x) => x.to === A && x.p.self === true && x.p.actor === A) && s[1].p.data === text, s.map((x) => x.p.customPacketType));

  // ---- none ----
  packet(1, { customPacketType: 'dboPresetGet', actor: B, have: '' });
  await settle(); pumpAll();
  s = take();
  check('a character without a face: none', s.length === 1 && s[0].p.customPacketType === 'dboPresetNone' && s[0].p.actor === B, s);
  packet(1, { customPacketType: 'dboPresetGet', actor: NPC, have: '' });
  await settle(); pumpAll();
  s = take();
  check('a server NPC is never looked up: none', s.length === 1 && s[0].p.customPacketType === 'dboPresetNone' && !fs.existsSync(fileOf(NPC)), s);

  // ---- refusals ----
  packet(2, { customPacketType: 'dboPresetPut', up: 1, i: 0, n: 1, hash: '00000000', race: 1, data: text });
  await settle();
  check('an upload that does not match its hash is refused', !fs.existsSync(fileOf(B)) && logs.some((l) => /does not match its hash/.test(l)));
  const evil = JSON.parse(text); evil.sculpt[0].data[0][0] = 65000;
  upload(2, JSON.stringify(evil), 2);
  await settle();
  check('an upload whose sculpt index is past its vertex count is refused', !fs.existsSync(fileOf(B)) && logs.some((l) => /breaks the preset rules/.test(l)));
  packet(2, { customPacketType: 'dboPresetPut', up: 3, i: 0, n: 999, hash, race: 1, data: 'x' });
  packet(2, { customPacketType: 'dboPresetPut', up: 3, i: 0, n: 1, hash, race: 1, data: 'x'.repeat(12001) });
  check('silly chunk counts and oversize chunks are ignored', !M.state.uploads.has(B));

  // ---- multi-chunk, out of order ----
  const bigFace = JSON.parse(JSON.stringify(face)); bigFace.sculpt[0].data = new Array(5000).fill(0).map((_, i) => [i, 100, -100, i]);
  const bigText = P.encodeFace(bigFace);
  const parts = []; for (let i = 0; i < bigText.length; i += 12000) parts.push(bigText.slice(i, i + 12000));
  [...parts.keys()].reverse().forEach((i) => packet(2, { customPacketType: 'dboPresetPut', up: 4, i, n: parts.length, hash: P.hashText(bigText), race: 1, data: parts[i] }));
  await settle();
  check(`a ${parts.length}-chunk upload in any order is stored`, fs.existsSync(fileOf(B)) && JSON.parse(fs.readFileSync(fileOf(B), 'utf8')).face === bigText);
  take();
  packet(1, { customPacketType: 'dboPresetGet', actor: B, have: '' });
  await settle();
  let n = 0; for (let i = 0; i < 3; i++) { timers.racemenuPresetSend(); n += take().length; }
  check('a big face goes out one chunk per pump, not in a burst', n === 3);
  pumpAll(); take();

  // ---- unchanged and cleared ----
  const mtime = fs.statSync(fileOf(A)).mtimeMs;
  await settle();
  upload(1, text, 5);
  await settle();
  check('the same face again writes nothing and tells nobody', fs.statSync(fileOf(A)).mtimeMs === mtime && take().length === 0);
  packet(1, { customPacketType: 'dboPresetPut', up: 6, i: 0, n: 0, hash: '', race: 1, data: '' });
  await settle();
  s = take();
  check('a clear removes the file and sends an empty rev', !fs.existsSync(fileOf(A)) && s.length === 1 && s[0].p.customPacketType === 'dboPresetRev' && s[0].p.hash === '', s);
  const emptyFace = P.encodeFace({ ...face, custom: [], sculpt: [] });
  upload(1, text, 7); await settle(); take();
  upload(1, emptyFace, 8); await settle();
  check('an upload of a face with nothing in it is a clear', !fs.existsSync(fileOf(A)));
  take();

  // ---- what is read from disk ----
  upload(1, text, 9); await settle(); take();
  M.state.cache.clear();
  props[A].profileId = 99;
  packet(2, { customPacketType: 'dboPresetGet', actor: A, have: '' });
  await settle(); pumpAll();
  s = take();
  check('a file another profile wrote is none (a reused actor id)', s.length === 1 && s[0].p.customPacketType === 'dboPresetNone', s);
  props[A].profileId = 61;
  M.state.cache.clear();
  const tampered = JSON.parse(fs.readFileSync(fileOf(A), 'utf8')); tampered.face = tampered.face.replace('120', '121');
  fs.writeFileSync(fileOf(A), JSON.stringify(tampered));
  packet(2, { customPacketType: 'dboPresetGet', actor: A, have: '' });
  await settle(); pumpAll();
  s = take();
  check('a file edited by hand (hash no longer matches) is none', s.length === 1 && s[0].p.customPacketType === 'dboPresetNone' && logs.some((l) => /fails its checks/.test(l)), s);

  // ---- rate limits ----
  M = load({ getsPerMinute: 5 });
  M.state.rates.clear();
  take();
  let reads = 0;
  const realRead = fs.readFile;
  M.state.cache.clear();
  fs.readFile = (...x) => { reads++; return realRead(...x); };
  for (let i = 0; i < 9; i++) { M.state.cache.clear(); packet(2, { customPacketType: 'dboPresetGet', actor: B, have: 'x' }); }
  await settle(); pumpAll();
  fs.readFile = realRead;
  check('gets past the per-minute limit are dropped', reads === 5 && M.state.rates.get(`get:${B}`).length === 5, reads);
  check('answers about one character replace each other in the queue', take().filter((x) => x.p.customPacketType === 'dboPresetMeta').length === 1);
  M = load({ uploadsPerHour: 2 });
  M.state.rates.clear();
  for (let up = 20; up < 25; up++) upload(1, P.encodeFace({ ...face, custom: [{ name: 'N', value: up / 100 }] }), up);
  await settle();
  const kept = JSON.parse(fs.readFileSync(fileOf(A), 'utf8'));
  check('uploads past the hourly limit are dropped', JSON.parse(kept.face).custom[0].value === 0.21, JSON.parse(kept.face).custom);
  take();

  // ---- hot reload and the off switch ----
  const before = globalThis.__dboPresetState;
  M = load();
  check('a hot reload keeps the state (uploads, queues, cache)', globalThis.__dboPresetState === before);
  M = load({ enabled: false });
  packet(2, { customPacketType: 'dboPresetGet', actor: A, have: '' });
  await settle(); pumpAll();
  s = take();
  check('switched off: every get is answered none, off', s.length === 1 && s[0].p.customPacketType === 'dboPresetNone' && s[0].p.off === true, s);
  const m2 = fs.statSync(fileOf(A)).mtimeMs;
  upload(1, text, 30); await settle();
  check('switched off: uploads are ignored', fs.statSync(fileOf(A)).mtimeMs === m2);
  packet(1, { customPacketType: 'dboPresetSomething' });
  check('an unknown dboPreset type is ignored quietly', true);
  online = [B];
  M = load();
  packet(2, { customPacketType: 'dboPresetGet', actor: B, have: '' });
  online = [];
  await settle(); pumpAll();
  check('a recipient who left gets nothing and the queue is dropped', take().length === 0 && M.state.queues.size === 0);

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(failures ? `${failures} FAILED` : 'all passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.log('FAIL  harness threw', e.stack); fs.rmSync(TMP, { recursive: true, force: true }); process.exit(1); });
