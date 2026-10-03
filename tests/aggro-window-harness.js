// The dungeon aggro window (Nate, 1 Oct: "aggro is too far for the enemies in dungeons").
//   Part 1, fork skymp5-client view/aggroWindow.ts (the bundle run-all hands over): a hosted copy is held at Aggression 0
//   until a player is within ff_aggroWindow, then gets its aggression back; combat or a server 0 opens it for good.
//   Part 2, the real dungeons.js on stubs: each lease spawn gets ff_aggroWindow from config dungeons.aggroWindow, a hit
//   (globalThis.__dboAggroHit) or a nearby player's report (aggroOpen) sets it to 0 and keeps it there, and the config is
//   read at every pass.
//   node tests/aggro-window-harness.js <bundle of aggroWindow.ts>   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got)}`); if (!c) fails++; };

// ---- part 1: the client's rules ----
const bundle = process.argv[2];
if (!bundle || !fs.existsSync(bundle) || !fs.readFileSync(bundle, 'utf8').includes('nearestPlayer')) {
  require('./expect')('aggro-window', 'this client has no aggro window');
  console.log('ok    skipped part 1: this client has no aggro window');
} else {
  const W = require(path.resolve(bundle));
  const actor = (aggression) => { const a = { v: aggression, sets: [] }; a.get = () => a.v; a.set = (x) => { a.v = x; a.sets.push(x); }; return a; };
  const step = (st, a, window, hosted, nearest, inCombat) => W.apply(st, W.decide(st, window, hosted, nearest, inCombat), a.get, a.set);
  let st = W.newWindowState(); let a = actor(2);
  step(st, a, 1200, true, 3000, false);
  ok(a.v === 0 && st.held && st.restoreTo === 2, 'a hosted copy with no player within 1200 is held at Aggression 0, remembering its 2', [a.v, st]);
  step(st, a, 1200, true, 2500, false);
  ok(a.v === 0 && a.sets.length === 1, '...and stays held without writing again');
  let opened = step(st, a, 1200, true, 1100, false);
  ok(opened && a.v === 2 && !st.held && st.opened, 'a player within 1200 opens it: the 2 comes back, and the open is reported once', [opened, a.v, st]);
  opened = step(st, a, 1200, true, 5000, false);
  ok(!opened && a.v === 2, 'once open it stays open, however far the player goes');
  st = W.newWindowState(); a = actor(2);
  step(st, a, 1200, true, 4000, false);
  opened = step(st, a, 1200, true, 4000, true);
  ok(opened && a.v === 2, 'combat started any other way (it was hit) opens it at any range', [opened, a.v]);
  st = W.newWindowState(); a = actor(1);
  step(st, a, 1200, true, 4000, false);
  step(st, a, 0, true, 4000, false);
  ok(a.v === 1 && !st.held && !st.opened, 'the server setting 0 (woken by a hit or another client) releases it to its record\'s value', [a.v, st]);
  st = W.newWindowState(); a = actor(2);
  step(st, a, 1200, true, 4000, false);
  step(st, a, 1200, false, 4000, false);
  ok(a.v === 2 && !st.held, 'a copy this client no longer hosts is released (the new host holds its own)', [a.v, st]);
  st = W.newWindowState(); a = actor(1);
  step(st, a, 1200, true, 4000, false);
  a.v = 2;   // formView.applyHostility raised it while held
  step(st, a, 1200, true, 4000, false);
  ok(a.v === 0 && st.restoreTo === 2, 'a raise that arrives while held is what it goes back to', [a.v, st]);
  st = W.newWindowState(); a = actor(2);
  step(st, a, 0, true, 100, false); step(st, a, undefined, true, 100, false);
  ok(a.sets.length === 0, 'no window (0 or missing, a 0.3.74 server) touches nothing');
  ok(W.nearestPlayer([0, 0, 0], 5, [{ pos: [100, 0, 0], cell: 6 }, { pos: [900, 0, 0], cell: 5 }]) === 900, 'a player in another cell does not count');
  ok(W.nearestPlayer([0, 0, 0], 5, [{ pos: [300, 400, 0], cell: 0 }]) === 500, 'an unknown cell compares by distance only');
  W.combatStartBudget.sent = 0;
  const line = W.combatStartLine({ remoteId: 0xff000abc, base: 'Bandit', fromPlayer: 1500.4, toTarget: NaN, nearestPlayer: 900, aggression: 2, window: 1200, windowOpen: true, held: false });
  ok(line && line.kind === 'combatStart' && line.remoteId === 'ff000abc' && line.fromPlayer === 1500 && line.toTarget === -1, 'the combatStart line: hex id, whole units, -1 for no target', line);
  for (let i = 0; i < 100; i++) W.combatStartLine({ remoteId: i, base: '', fromPlayer: 0, toTarget: 0, nearestPlayer: 0, aggression: 0, window: 0, windowOpen: true, held: false });
  ok(W.combatStartBudget.sent === W.COMBAT_START_MAX, `at most ${W.COMBAT_START_MAX} combatStart lines a session`, W.combatStartBudget.sent);
}

// ---- part 2: the server ----
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-aggro-'));
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* the OS will */ } });
process.chdir(dir);
fs.writeFileSync('dungeons.json', JSON.stringify({ dungeons: [] }));
const props = new Map(); const sets = []; const logs = []; const timers = {}; const ui = {};
const CELL = '1111:BSHeartland.esm';
const pos = { 0xff000101: [0, 0, 0], 0xff000102: [500, 0, 0], 0xff000103: [800, 0, 0], 0x14: [9000, 0, 0] };
const mp = {
  get: (id, k) => (k === 'pos' ? pos[id >>> 0] : k === 'worldOrCellDesc' ? CELL : k === 'profileId' ? (id === 0x14 ? 3 : -1) : props.get(`${id >>> 0}|${k}`)),
  set: (id, k, v) => { props.set(`${id >>> 0}|${k}`, v); if (k === 'ff_aggroWindow') sets.push([id >>> 0, v]); },
  getIdFromDesc: () => 0, lookupEspmRecordById: () => null,
};
const cfg = { dungeons: {} };
const lease = { id: 'CYRTestMine', name: 'Test Mine', difficulty: 'normal', leader: 1, members: new Set([1]), startedAt: Date.now(), endsAt: Date.now() + 3600000,
  warned: false, lastInsideAt: Date.now(), locked: new Map(), zones: [], seenNpcs: new Set(), deadNpcs: new Set(), bossZones: new Set(), bossIds: new Set(),
  looted: new Set(), unlocked: new Set(), armed: new Set([0xff000101, 0xff000102, 0xff000103]) };
for (const k of Object.keys(globalThis)) if (k.startsWith('__dbo')) delete globalThis[k];
globalThis.__dboDungeons = { leases: new Map([[lease.id, lease]]), parties: new Map(), memberOf: new Map(), invites: new Map(), pending: new Map() };
globalThis.__dboDungeonsBooted = true;
const load = () => require(path.resolve(__dirname, '..', 'dungeons.js'))({
  mp, log: (...x) => logs.push(x.join(' ')), personal: () => {}, system: () => {}, audit: () => {}, registerChatCommand: () => {},
  onUi: (ev, fn) => { ui[ev] = fn; }, openWidget: () => true, closeWidget: () => true, sendPacket: () => true, findByName: () => 0,
  display: () => 'P', who: () => 'P', profileOf: (a) => (a === 0x14 ? 3 : -1), nameOf: () => 'P', onlineActors: () => [0x14], isAdmin: () => false,
  giveItem: () => true, cfg, every: (name, ms, fn) => { timers[name] = fn; },
});
load();
const arm = () => timers['dungeons.arm']();
arm();
ok(props.get(`${0xff000101}|ff_aggroWindow`) === 1200 && props.get(`${0xff000102}|ff_aggroWindow`) === 1200, 'each lease spawn gets ff_aggroWindow 1200 (the default)', sets);
const before = sets.length; arm();
ok(sets.length === before, 'nothing is sent again while it is unchanged');
globalThis.__dboAggroHit(0x14, 0xff000101);
ok(props.get(`${0xff000101}|ff_aggroWindow`) === 0, 'a landed hit wakes the spawn: 0 for every client');
arm();
ok(props.get(`${0xff000101}|ff_aggroWindow`) === 0, '...and the next pass keeps it 0');
ui.aggroOpen(0x14, ['ff000102']);
ok(props.get(`${0xff000102}|ff_aggroWindow`) === 1200, 'a report from a player 8500 units off the spawn is not believed', props.get(`${0xff000102}|ff_aggroWindow`));
pos[0x14] = [2000, 0, 0];
ui.aggroOpen(0x14, ['ff000102']);
ok(props.get(`${0xff000102}|ff_aggroWindow`) === 0, 'a report from a player 1500 units off is believed (within twice the window plus 500, for lag): woken', props.get(`${0xff000102}|ff_aggroWindow`));
globalThis.__dboAggroHit(0x14, 0xff0009ff);
ok(!props.has(`${0xff0009ff}|ff_aggroWindow`), 'a hit on an actor of no lease changes nothing');
cfg.dungeons.aggroWindow = { units: 800 };
arm();
ok(props.get(`${0xff000103}|ff_aggroWindow`) === 800 && props.get(`${0xff000101}|ff_aggroWindow`) === 0, 'a config change is sent at the next pass, and a woken spawn stays 0', [props.get(`${0xff000103}|ff_aggroWindow`), props.get(`${0xff000101}|ff_aggroWindow`)]);
cfg.dungeons.aggroWindow = { enabled: false };
arm();
ok(props.get(`${0xff000103}|ff_aggroWindow`) === 0, 'switched off: 0, so the clients hold nothing');
cfg.dungeons.aggroWindow = { units: 1200 };
delete require.cache[path.resolve(__dirname, '..', 'dungeons.js')];
load(); arm();
ok(props.get(`${0xff000103}|ff_aggroWindow`) === 1200 && props.get(`${0xff000101}|ff_aggroWindow`) === 0 && props.get(`${0xff000102}|ff_aggroWindow`) === 0, 'a hot reload keeps the woken spawns (the lease is on globalThis) and resends the window', [0xff000101, 0xff000102, 0xff000103].map((i) => props.get(`${i}|ff_aggroWindow`)));
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
