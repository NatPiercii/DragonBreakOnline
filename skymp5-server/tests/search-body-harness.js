// Scripted test for searchSystem.ts and a dead player's body (2026-09-30): the Search action on a body follows the
// gamemode's body rule (globalThis.__dboLootBody: two random stacks and 15% of the coin, once per death, no respawn),
// exactly as pressing E on it does. Searching a living player is unchanged. It bundles searchSystem.ts with esbuild
// (settings, housing and capture stubbed) and drives customPacket against a fake mp. Run it from skymp5-server with
// node_modules present:
//
//   node tests/search-body-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const esbuild = require(path.join(root, 'node_modules', 'esbuild'));
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-search-'));
const bundle = path.join(out, 'search.js');
const stubs = {
  '../settings': 'module.exports = { Settings: { get: async () => ({ allSettings: {} }) } };',
  './housingSystem': 'module.exports = { KEY_BASE_ID: 0x10 };',
  './captureSystem': 'module.exports = { LAWFUL_PROP: "private.lawful", RESTRAINED_PROP: "private.restrained", isStruggling: () => false };',
};

let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

(async () => {
  await esbuild.build({
    entryPoints: [path.join(root, 'ts', 'systems', 'searchSystem.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'error',
    plugins: [{
      name: 'stubs',
      setup(b) {
        b.onResolve({ filter: /^(\.\.\/settings|\.\/housingSystem|\.\/captureSystem)$/ }, (a) => ({ path: a.path, namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ contents: stubs[a.path], loader: 'js' }));
      },
    }],
  });
  const { SearchSystem } = require(bundle);

  // ---- a fake world: a searcher (user 1), a dead player (user 2), a living player (user 3) ----
  const SEARCHER = 0xff000001, BODY = 0xff000002, LIVING = 0xff000003;
  const props = new Map([
    [`${SEARCHER}|profileId`, 11], [`${BODY}|profileId`, 12], [`${LIVING}|profileId`, 13],
    [`${BODY}|isDead`, true], [`${LIVING}|isDead`, false], [`${SEARCHER}|isDead`, false],
  ]);
  const users = { 1: SEARCHER, 2: BODY, 3: LIVING };
  const sent = [], occupants = [], logs = [];
  let respawned = 0;
  const mp = {
    get: (id, k) => props.get(`${id}|${k}`),
    set: (id, k, v) => props.set(`${id}|${k}`, v),
    getUserActor: (u) => users[u] || 0,
    getUserByActor: (a) => Number(Object.keys(users).find((u) => users[u] === a) ?? -1),
    isConnected: () => true,
    getActorCellOrWorld: () => 0x3c,
    getActorPos: (a) => (a === SEARCHER ? [0, 0, 0] : [100, 0, 0]),
    setInventoryOccupant: (t, o) => occupants.push([t, o]),
    sendCustomPacket: (u, p) => sent.push([u, JSON.parse(p)]),
    respawnActor: () => { respawned++; },
    onTakeItem: null,
  };
  const ctx = { svr: mp, gm: { emit() {} } };
  const sys = new SearchSystem((...a) => logs.push(a.join(' ')));
  await sys.initAsync(ctx);
  const lastTo = (u) => sent.filter(([x]) => x === u).map(([, p]) => p).pop();

  // ---- with the gamemode loaded ----
  const lootCalls = [];
  globalThis.__dboLootBody = (target, caster) => { lootCalls.push([target, caster]); return false; };
  sys.customPacket(1, 'searchRequest', { target: BODY }, ctx);
  check('searching a body runs the gamemode body rule', lootCalls.length === 1 && lootCalls[0][0] === BODY && lootCalls[0][1] === SEARCHER, lootCalls);
  check('...and opens no inventory window', occupants.length === 0 && !sent.some(([, p]) => p.customPacketType === 'searchApproved'), sent.map(([, p]) => p.customPacketType));
  check('...so no stack can be picked and nothing is respawned', respawned === 0);
  sys.customPacket(1, 'searchRequest', { target: BODY }, ctx);
  check('a second search goes to the rule again (it says the body was already searched)', lootCalls.length === 2);

  globalThis.__dboLootBody = () => undefined;
  sent.length = 0;
  sys.customPacket(1, 'searchRequest', { target: BODY }, ctx);
  check('a body the rule does not cover opens nothing either', occupants.length === 0 && (lastTo(1) || {}).text === 'There is nothing to search.', lastTo(1));

  globalThis.__dboLootBody = () => { throw new Error('boom'); };
  sent.length = 0;
  sys.customPacket(1, 'searchRequest', { target: BODY }, ctx);
  check('a rule that throws opens nothing and is logged', occupants.length === 0 && logs.some((l) => /body loot failed/.test(l)), logs.slice(-1));

  // ---- living players are unchanged ----
  globalThis.__dboLootBody = (target, caster) => { lootCalls.push([target, caster]); return false; };
  lootCalls.length = 0; sent.length = 0;
  sys.customPacket(1, 'searchRequest', { target: LIVING }, ctx);
  check('a living player is not a body: the rule is not run', lootCalls.length === 0);
  check('...and a non-guard is still refused', /Only guards/.test((lastTo(1) || {}).text || ''), lastTo(1));
  props.set(`${SEARCHER}|private.lawful`, true);
  sent.length = 0;
  sys.customPacket(1, 'searchRequest', { target: LIVING }, ctx);
  check('...while a guard still asks for consent', sent.some(([u, p]) => u === 3 && p.customPacketType === 'searchConsentRequest'), sent.map(([u, p]) => [u, p.customPacketType]));

  // ---- without the gamemode the old body window still works ----
  const sys2 = new SearchSystem(() => {});
  await sys2.initAsync(ctx);
  delete globalThis.__dboLootBody;
  occupants.length = 0; sent.length = 0;
  sys2.customPacket(1, 'searchRequest', { target: BODY }, ctx);
  check('with no gamemode rule loaded a body opens as before', occupants.length === 1 && sent.some(([, p]) => p.customPacketType === 'searchApproved'), sent.map(([, p]) => p.customPacketType));

  fs.rmSync(out, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.log('FAIL the harness threw', e); process.exit(1); });
