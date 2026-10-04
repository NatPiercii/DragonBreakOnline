// Scripted test for fork skymp5-client/src/services/services/racemenuPresetService.ts (RaceMenu part 2): the player's
// face saved after RaceSexMenu and uploaded in paced chunks, a copy's face fetched and loaded through skee with the
// copy's own head parts and weight, the file removed straight after, the part-1 hook, one load per copy and face, the
// gates (RaceMenu, combat, beast, race, 3D) checked when queued and again in the NiNode slot, the sculpt bound, the
// player's own face after a spawn, rev notices, the server's off switch and a SkyrimPlatform without the file calls.
// Bundled from $FORK with stubs for SkyrimPlatform and the services around it. Run by run-all, or by hand:
//
//   FORK=<fork worktree> node tests/racemenu-preset-service-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const FORK = process.env.FORK || path.resolve(__dirname, '..', '..', 'fork');
const SRC = path.join(FORK, 'skymp5-client', 'src', 'services', 'services', 'racemenuPresetService.ts');
if (!fs.existsSync(SRC)) {
  require('./expect')('racemenu-preset-service', 'this client has no racemenuPresetService');
  console.log('ok   skipped: this client has no RaceMenu face presets');
  process.exit(0);
}
const esbuildDir = [process.env.FORK_SERVER, FORK].filter(Boolean).map((f) => path.join(f, 'skymp5-server', 'node_modules', 'esbuild')).find((p) => fs.existsSync(p))
  || path.join(process.env.HOME, 'dragonbreak', 'fork', 'skymp5-server', 'node_modules', 'esbuild');
const esbuild = require(esbuildDir);

let failures = 0;
const check = (label, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && got !== undefined ? '   ' + JSON.stringify(got).slice(0, 400) : ''}`); if (!ok) failures++; };

const HEAD = 'Actors\\Character\\Character Assets\\FemaleHeadChargen.tri';
const RACE = 0x13746, OTHER_RACE = 0x13741, WEREWOLF = 0x000cdd84;
const ME = 0xff000001, R1 = 0xff000a02, L1 = 0xff00ab01, L1B = 0xff00ab09;
// The fake game. Head parts: 01A2B3 a main part, 024238 an extra (Improved Eyes' blind overlay)
const W = {
  files: {}, calls: [], packets: [], works: [], diag: [], hooks: [], menuOpen: false, me: ME, views: [],
  actors: { 0x14: { race: RACE, loaded: true, combat: false } },
  parts: { 0x0001a2b3: { extra: false }, 0x00024238: { extra: true }, 0x0201abcd: { extra: false } },
  playerParts: [0x0001a2b3, 0x00024238], loadResult: true, triCount: () => 9001,
  savedJslot: null,
};
globalThis.__rmW = W;
const STUBS = {
  skyrimPlatform: `
const W = globalThis.__rmW;
const actorOf = (id) => { const a = W.actors[id >>> 0]; if (!a) return null;
  return { getFormID: () => id >>> 0, getRace: () => ({ getFormID: () => a.race }), is3DLoaded: () => a.loaded, isInCombat: () => a.combat, getBaseObject: () => ({ base: id }) }; };
module.exports = {
  Game: { getPlayer: () => actorOf(0x14), getFormEx: (id) => ({ id: id >>> 0 }), getModName: (i) => ['Skyrim.esm', 'Update.esm', 'Dawnguard.esm'][i] || '', getLightModName: () => '' },
  Actor: { from: (f) => (f ? actorOf(f.id) : null) },
  ActorBase: { from: (b) => (b ? { getNumHeadParts: () => W.playerParts.length, getNthHeadPart: (i) => ({ getFormID: () => W.playerParts[i] }), getWeight: () => 61 } : null) },
  HeadPart: { from: (f) => { const p = f && W.parts[f.id]; return p ? { isExtraPart: () => p.extra } : null; } },
  Ui: { isMenuOpen: (m) => m === 'RaceSex Menu' && W.menuOpen },
  writeLogs: (_f, line) => W.diag.push(line),
  callNative: (cls, fn, self, ...args) => {
    W.calls.push({ cls, fn, actor: args[0] && args[0].getFormID(), name: args[1], color: args[2], flags: args[3], file: W.files[String(args[1]).replace('DBO\\\\', '')] });
    if (fn === 'SaveCharacterPreset') { if (W.savedJslot) W.files[String(args[1]).replace('DBO\\\\', '')] = JSON.stringify(W.savedJslot); return null; }
    if (fn === 'LoadCharacterPresetEx') return W.loadResult;
    return null;
  },
};`,
  clientListener: 'class ClientListener {} module.exports = { ClientListener };',
  remoteServer: 'class RemoteServer {} module.exports = { RemoteServer };',
  customPacketUtil: `module.exports = { sendCustomPacket: (_c, p) => globalThis.__rmW.packets.push(p), parseCustomPacket: (e) => { try { return JSON.parse(e.message.contentJsonDump); } catch (x) { return null; } } };`,
  worldViewMisc: `module.exports = { getViewFromStorage: () => ({ getFormViews: () => ({ getFormViewsArrayLength: () => globalThis.__rmW.views.length, getNthFormView: (i) => globalThis.__rmW.views[i] }) }) };`,
  niNodeQueue: `module.exports = { queueCopyNiNodeWork: (id, work) => globalThis.__rmW.works.push({ id: id >>> 0, work }), queuePlayerNiNodeWork: (work) => globalThis.__rmW.works.push({ id: 0x14, work }) };`,
  appearance: 'module.exports = {};',
  logging: 'module.exports = { logError: () => {}, logTrace: () => {} };',
};
const stubPlugin = {
  name: 'stubs',
  setup(b) {
    b.onResolve({ filter: /^(skyrimPlatform|\.\/clientListener|\.\/remoteServer|\.\/customPacketUtil|\.\.\/\.\.\/view\/worldViewMisc|\.\.\/\.\.\/view\/niNodeQueue|\.\.\/\.\.\/sync\/appearance|\.\.\/\.\.\/logging)$/ }, (a) => ({ path: a.path.replace(/.*\//, ''), namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ contents: STUBS[a.path], loader: 'js' }));
  },
};

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-rmservice-'));
  const out = path.join(dir, 's.js'), planOut = path.join(dir, 'p.js');
  await esbuild.build({ entryPoints: [SRC], bundle: true, platform: 'node', format: 'cjs', outfile: out, plugins: [stubPlugin], logLevel: 'error' });
  await esbuild.build({ entryPoints: [path.join(FORK, 'skymp5-client', 'src', 'sync', 'racemenuPresetPlan.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: planOut, logLevel: 'error' });
  const { RacemenuPresetService } = require(out);
  const P = require(planOut);
  fs.rmSync(dir, { recursive: true, force: true });

  let NOW = 1000000;
  Date.now = () => NOW;
  const natives = {
    readPresetFile: (n) => W.files[n],
    writePresetFile: (n, t) => { if (!/^[A-Za-z0-9_-]{1,64}$/.test(n)) throw new Error('bad name'); W.files[n] = t; },
    removePresetFile: (n) => { const had = n in W.files; delete W.files[n]; return had; },
    getTriVertexCount: (h) => W.triCount(h),
  };
  const make = (sp) => {
    const updates = [], emit = {};
    const controller = { on: (ev, fn) => { if (ev === 'update') updates.push(fn); }, emitter: { on: (ev, fn) => { (emit[ev] = emit[ev] || []).push(fn); } }, lookupListener: () => ({ getMyRemoteRefrId: () => W.me }) };
    const svc = new RacemenuPresetService(sp, controller);
    return { svc, update: () => updates.forEach((f) => f()), emit: (ev, x) => (emit[ev] || []).forEach((f) => f(x)) };
  };
  const step = (S, ms, n = 1) => { for (let i = 0; i < n; i++) { NOW += ms; S.update(); } };
  const deliver = (S, p) => S.emit('customPacketMessage', { message: { contentJsonDump: JSON.stringify(p) } });
  const runWorks = () => { const w = W.works.splice(0, W.works.length); return w.map((x) => { const a = W.actors[x.id]; return x.work({ getFormID: () => x.id, getRace: () => ({ getFormID: () => a.race }), is3DLoaded: () => a.loaded, isInCombat: () => a.combat }); }); };
  const loads = () => W.calls.filter((c) => c.fn === 'LoadCharacterPresetEx');

  // A saved .jslot as skee writes it
  const jslot = {
    version: { signature: 1163086675, formatVersion: 3, skseVersion: 1, runtimeVersion: 2 }, modNames: ['Skyrim.esm'], mods: [],
    headParts: [{ formIdentifier: 'Skyrim.esm|01A2B3', type: 1 }], actor: { weight: 61 }, tintInfo: [{ index: 0, color: 1, texture: 'x.dds' }],
    morphs: { custom: [{ name: 'NoseBridge', value: 0.4 }], default: { presets: [1], morphs: [0.5] }, sculptDivisor: 10000, sculpt: [{ host: HEAD, vertices: 9001, data: [[3, 10, 20, 30]] }] },
    overrides: [{ node: 'Body [Ovl0]', values: [] }],
  };
  const face = P.facePresetFrom(jslot);
  const faceText = P.encodeFace(face);
  const faceHash = P.hashText(faceText);

  // ---- no file calls in this SkyrimPlatform ----
  let S = make({});
  W.views = [];
  step(S, 1100, 3);
  check('without the platform\'s preset calls nothing is sent and one diag line says why', W.packets.length === 0 && W.diag.filter((l) => /no preset file calls/.test(l)).length === 1, W.diag);

  // ---- the player's own face after RaceMenu ----
  W.diag = [];
  S = make(natives);
  W.savedJslot = jslot;
  W.menuOpen = true;
  step(S, 100, 3);
  W.menuOpen = false;
  globalThis.__dboRaceMenuClosedAt = NOW;
  step(S, 1000, 3);
  check('nothing is saved before the menu has settled', !W.calls.some((c) => c.fn === 'SaveCharacterPreset'));
  W.packets = [];
  step(S, 300, 6);
  const save = W.calls.find((c) => c.fn === 'SaveCharacterPreset');
  check('after the settle the face is saved with CharGen.SaveCharacterPreset(player, "DBO\\\\self")', save && save.actor === 0x14 && save.name === 'DBO\\self', save);
  check('the saved file is removed once read', !('self' in W.files));
  let puts = W.packets.filter((p) => p.customPacketType === 'dboPresetPut');
  step(S, 300, 4);
  puts = W.packets.filter((p) => p.customPacketType === 'dboPresetPut');
  check('the face goes up as dboPresetPut chunks with its hash and race', puts.length === 1 && puts[0].hash === faceHash && puts[0].n === 1 && puts[0].data === faceText && puts[0].race === RACE, puts.map((p) => [p.i, p.n, p.hash]));
  check('only the face goes up (no tints, overrides, head parts, vanilla sliders)', !/tintInfo|overrides|headParts|"default"/.test(puts[0].data));
  W.packets = [];
  W.menuOpen = true; step(S, 100); W.menuOpen = false; globalThis.__dboRaceMenuClosedAt = NOW; step(S, 1000, 5);
  check('the same face after another RaceMenu visit is not sent again', !W.packets.some((p) => p.customPacketType === 'dboPresetPut'));
  // A long sculpt goes in paced chunks
  const big = JSON.parse(JSON.stringify(jslot)); big.morphs.sculpt[0].data = new Array(4000).fill(0).map((_, i) => [i, 100, -200, 300]);
  W.savedJslot = big;
  W.menuOpen = true; step(S, 100); W.menuOpen = false; globalThis.__dboRaceMenuClosedAt = NOW; step(S, 1000, 4);
  W.packets = [];
  step(S, 100, 2);
  const early = W.packets.filter((p) => p.customPacketType === 'dboPresetPut').length;
  step(S, 300, 20);
  puts = W.packets.filter((p) => p.customPacketType === 'dboPresetPut');
  check('a big face is sent one chunk per 250 ms, all with one upload id', early <= 1 && puts.length > 2 && puts.every((p) => p.up === puts[0].up && p.n === puts.length) && puts.map((p) => p.i).join() === puts.map((_, i) => i).join(), [early, puts.length]);
  check('the chunks join to the face whose hash they carry', P.hashText(puts.map((p) => p.data).join('')) === puts[0].hash);
  W.actors[0x14].race = WEREWOLF;
  W.calls = [];
  W.menuOpen = true; step(S, 100); W.menuOpen = false; globalThis.__dboRaceMenuClosedAt = NOW; step(S, 1000, 5);
  check('nothing is saved in a beast form', !W.calls.some((c) => c.fn === 'SaveCharacterPreset'));
  W.actors[0x14].race = RACE;
  W.savedJslot = jslot;

  // ---- a copy of another player ----
  S = make(natives);
  W.packets = []; W.calls = []; W.works = []; W.diag = [];
  W.actors[L1] = { race: RACE, loaded: true, combat: false };
  const view = (local, remote, parts) => ({ isPlayerCharacter: () => true, getLocalRefrId: () => local, getRemoteRefrId: () => remote, getAppearance: () => ({ headpartIds: parts || [0x0001a2b3, 0x00024238, 0x0201abcd], weight: 33 }) });
  W.views = [view(L1, R1)];
  step(S, 1100);
  let gets = W.packets.filter((p) => p.customPacketType === 'dboPresetGet');
  check('a new copy asks the server for its face', gets.length === 1 && gets[0].actor === R1 && gets[0].have === '', gets);
  step(S, 1100, 3);
  check('and does not ask again within 15 s', W.packets.filter((p) => p.customPacketType === 'dboPresetGet').length === 1);
  deliver(S, { customPacketType: 'dboPresetMeta', actor: R1, hash: faceHash, race: RACE });
  deliver(S, { customPacketType: 'dboPresetChunk', actor: R1, hash: faceHash, race: RACE, i: 0, n: 1, data: faceText });
  step(S, 1100);
  check('once the face is in, its load is queued in the copy\'s NiNode slot', W.works.length === 1 && W.works[0].id === L1);
  globalThis.__dboRaceMenuExtrasReapply = (id) => W.hooks.push(id);
  let r = runWorks();
  let ld = loads();
  check('the slot loads it: LoadCharacterPresetEx(copy, "DBO\\\\c<id>", none, 0), and says it queued the update', r[0] === true && ld.length === 1 && ld[0].actor === L1 && ld[0].name === 'DBO\\cff000a02' && ld[0].color === null && ld[0].flags === 0, ld);
  const handed = JSON.parse(ld[0].file);
  check('the .jslot carries the copy\'s main head parts (not the extra) and its weight', handed.headParts.map((h) => h.formIdentifier).join() === 'Skyrim.esm|01A2B3,Dawnguard.esm|01ABCD' && handed.actor.weight === 33, handed.headParts);
  check('and the face: sliders and sculpt', handed.morphs.custom[0].name === 'NoseBridge' && handed.morphs.sculpt[0].host === HEAD && !handed.tintInfo && !handed.overrides);
  check('the file is removed after the load', !('cff000a02' in W.files));
  check('part 1 is told to re-apply the extras on that copy, and the stamp is set', W.hooks.join() === String(L1) && globalThis.__dboRaceMenuPresetAppliedAt[L1] === NOW);
  step(S, 1100, 3);
  check('the same copy with the same face is not loaded again', W.works.length === 0);
  W.views = [view(L1B, R1)];
  W.actors[L1B] = { race: RACE, loaded: true, combat: false };
  step(S, 1100);
  check('a respawned copy (new local id) gets its face again, from the cache', W.works.length === 1 && W.works[0].id === L1B && W.packets.filter((p) => p.customPacketType === 'dboPresetGet' && p.actor === R1).length === 1);
  runWorks();

  // ---- the gates ----
  const fresh = (local, set) => { W.views = [view(local, R1)]; W.actors[local] = Object.assign({ race: RACE, loaded: true, combat: false }, set); W.works = []; step(S, 1100); return W.works.length; };
  check('not in a fight', fresh(0xff00ac01, { combat: true }) === 0);
  W.actors[0xff00ac01].combat = false; step(S, 1100);
  check('and once the fight is over, it goes', W.works.length === 1);
  W.works = [];
  check('not without 3D', fresh(0xff00ac02, { loaded: false }) === 0);
  check('not on a werewolf', fresh(0xff00ac03, { race: WEREWOLF }) === 0);
  check('not on another race than the face was made on', fresh(0xff00ac04, { race: OTHER_RACE }) === 0);
  W.menuOpen = true;
  check('not while this player has RaceMenu open', fresh(0xff00ac05, {}) === 0);
  W.menuOpen = false; globalThis.__dboRaceMenuClosedAt = NOW;
  step(S, 1100);
  check('nor while it settles', W.works.length === 0);
  step(S, 1100, 3);
  check('then it goes', W.works.length === 1);
  W.works = [];
  check('a copy queued while fine', fresh(0xff00ac06, {}) === 1);
  W.actors[0xff00ac06].combat = true;
  W.calls = [];
  r = runWorks();
  check('that is in a fight by its turn is not loaded, and the slot says nothing was queued', r[0] === false && loads().length === 0);
  W.actors[0xff00ac06].combat = false;
  step(S, 1100);
  check('it is handed back and queued again later', W.works.length === 1);
  W.loadResult = false; W.calls = [];
  r = runWorks();
  check('a load skee refuses reports no update queued', r[0] === false && loads().length === 1);
  W.loadResult = true;

  // ---- the sculpt bound ----
  W.triCount = () => 7000; W.diag = []; W.calls = [];
  fresh(0xff00ad01, {});
  runWorks();
  const bounded = JSON.parse(loads()[0].file);
  check('a head mesh with another vertex count here: the sculpt is left out, the sliders still go', bounded.morphs.sculpt.length === 0 && bounded.morphs.custom.length === 1 && W.diag.some((l) => /sculpt not applied/.test(l)), W.diag);
  W.triCount = () => 9001;
  W.parts[0x0201abcd] = undefined; W.diag = []; W.calls = [];
  fresh(0xff00ad02, {});
  check('a head part this game cannot resolve: no load at all (skee would leave race defaults)', W.works.length === 0 && W.diag.some((l) => /head parts unresolved/.test(l)));
  W.parts[0x0201abcd] = { extra: false };

  // ---- rev notices ----
  W.packets = [];
  deliver(S, { customPacketType: 'dboPresetRev', actor: R1, hash: 'deadbeef' });
  step(S, 1100);
  gets = W.packets.filter((p) => p.customPacketType === 'dboPresetGet');
  check('a rev notice with another hash drops the cache and asks again', gets.length === 1 && gets[0].actor === R1);

  // ---- the player's own face after a login ----
  S = make(natives);
  W.packets = []; W.works = []; W.calls = []; W.hooks = [];
  W.views = [];
  step(S, 1100, 3);
  check('nothing asked for the player before 6 s after the spawn', !W.packets.some((p) => p.customPacketType === 'dboPresetGet' && p.actor === 0));
  step(S, 1100, 4);
  gets = W.packets.filter((p) => p.customPacketType === 'dboPresetGet' && p.actor === 0);
  check('then the player asks for its own face (actor 0)', gets.length === 1);
  deliver(S, { customPacketType: 'dboPresetChunk', actor: 0xff0000aa, self: true, hash: faceHash, race: RACE, i: 0, n: 1, data: faceText });
  step(S, 1100);
  check('the answer (marked self) queues a load on the player', W.works.length === 1 && W.works[0].id === 0x14);
  r = runWorks();
  ld = loads();
  const own = JSON.parse(ld[0].file);
  check('LoadCharacterPresetEx(player, "DBO\\\\self") with the player\'s main head parts and weight', r[0] === true && ld[0].actor === 0x14 && ld[0].name === 'DBO\\self' && own.headParts.length === 1 && own.actor.weight === 61, own);
  check('part 1 re-applies on the player', W.hooks.join() === String(0x14));
  step(S, 1100, 5);
  check('the player is loaded once per face', W.works.length === 0);
  S.emit('gameLoad');
  step(S, 1100, 7);
  check('after a game load (skee reverts) the player gets the face again', W.works.length === 1 && W.works[0].id === 0x14);
  W.works = [];

  // ---- none and off ----
  S = make(natives);
  W.packets = []; W.works = [];
  step(S, 1100, 7);
  deliver(S, { customPacketType: 'dboPresetNone', actor: 0xff0000aa, self: true });
  step(S, 1100, 3);
  check('a player with no face: nothing loaded', W.works.length === 0);
  W.views = [view(0xff00ae01, R1)]; W.actors[0xff00ae01] = { race: RACE, loaded: true, combat: false };
  deliver(S, { customPacketType: 'dboPresetNone', actor: R1, off: true });
  W.packets = [];
  step(S, 1100, 20);
  W.menuOpen = true; step(S, 100); W.menuOpen = false; globalThis.__dboRaceMenuClosedAt = NOW; step(S, 1000, 6);
  check('the server\'s off switch stops every get, save and load this session', W.packets.length === 0 && W.works.length === 0);

  console.log(failures ? `${failures} FAILED` : 'all passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.log('FAIL harness threw', e.stack); process.exit(1); });
