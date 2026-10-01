// A player who falls in beast form gets the down panel again ~2 s later (server downed.js, beastPanelRetryMs): the first
// one lost the keyboard to the client turning them back (Purr, 2026-10-01: no cursor and no Give up for the whole
// bleed-out). A human death is not sent it twice, and a down that ended first is left alone. Also run over the state the
// live module (origin/server 2233d314) built, as a hot reload would.
// node tests/downed-beast-panel-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const MODULE = path.resolve(__dirname, '..', 'downed.js');
let now = 1790000000000;
Date.now = () => now;

const P = 0xff000001, NEAR = 0xff000002, WOLF = 0xff0000aa, RACE = 0xcdd84;
const props = new Map();
const set = (id, k, v) => props.set(id + '|' + k, v);
const get = (id, k) => props.get(id + '|' + k);
for (const [a, prof, pos] of [[P, 1, [0, 0, 0]], [NEAR, 2, [500, 0, 0]]]) {
  set(a, 'profileId', prof); set(a, 'isDead', false); set(a, 'percentages', { health: 1, stamina: 1, magicka: 1 });
  set(a, 'pos', pos); set(a, 'worldOrCellDesc', 'a764b:BSHeartland.esm'); set(a, 'angle', [0, 0, 0]);
  set(a, 'spawnPoint', { cellOrWorldDesc: 'temple', pos: [1, 2, 3], rot: [0, 0, 0] });
}
set(WOLF, 'profileId', -1);
// Who is in beast form; the inner death chain turns them back, as gamemode.js deathHook does
const beasts = new Set();
globalThis.__dboBeastOriginalRace = (a) => (beasts.has(Number(a) >>> 0) ? RACE : 0);
const innerDeath = (actorId) => { beasts.delete(Number(actorId) >>> 0); return undefined; };
const mp = {
  get: (id, k) => { const v = get(id, k); if (v === undefined && k === 'private.permaDead') return false; return v; },
  set: (id, k, v) => set(id, k, v),
  getIdFromDesc: (d) => parseInt(d, 16), getDescFromId: (id) => (id >>> 0).toString(16),
  callPapyrusFunction: () => true,
  onHitDamageAttempt: () => true, onHitDamage: () => undefined, onDeath: innerDeath, onSpellHit: () => undefined, onSpellCast: () => undefined,
};
const widgets = [], closed = [], timers = {}, ui = {};
let pending = [];
global.setTimeout = (fn, ms) => { pending.push({ fn, ms: Number(ms) || 0 }); return 0; };
const runPending = (upToMs) => { const due = pending.filter((p) => p.ms <= upToMs); pending = pending.filter((p) => p.ms > upToMs); due.forEach((p) => p.fn()); return due.length; };
const api = {
  mp, log: () => {}, personal: () => {}, sendPacket: () => true,
  audit: () => {}, who: String, display: String, profileOf: (a) => Number(get(a, 'profileId')), nameOf: String,
  onlineActors: () => [P, NEAR], every: (n, ms, fn) => { timers[n] = fn; }, registerChatCommand: () => {}, cfg: { downed: { giveUpAfterSeconds: 0 } },
  openWidget: (a, w, focus) => { widgets.push([a, w, focus]); return true; }, closeWidget: (a, id) => { closed.push([a, id]); },
  onUi: (n, fn) => { ui[n] = fn; },
};
const load = (file) => { mp.onDeath = innerDeath; delete require.cache[file]; require(file)(api); };

let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };
const panels = () => widgets.filter((x) => x[0] === P && x[1].type === 'downed');
const die = (beast) => { if (beast) beasts.add(P); set(P, 'isDead', true); mp.onDeath(P, WOLF); };
const wake = () => { set(P, 'isDead', false); timers.downedPanel(); widgets.length = 0; closed.length = 0; pending = []; };

const run = (label) => {
  ui.uiCaps(P, ['downed']);

  die(true);
  check(`${label}: a beast-form death opens the panel at once, with the keyboard`, panels().length === 1 && panels()[0][2] === true);
  check(`${label}: ...and the form is already turned back by the death chain`, !beasts.has(P));
  check(`${label}: ...and a second showing is due in about 2 s`, pending.some((p) => p.ms === 2000));
  runPending(2000);
  check(`${label}: 2 s later the panel is sent again, focused, with the same nonce`, panels().length === 2 && panels()[1][2] === true && panels()[1][1].nonce === panels()[0][1].nonce && panels()[1][1].id === 62);
  wake();

  die(false);
  runPending(2000);
  check(`${label}: a human death opens the panel once only`, panels().length === 1);
  wake();

  die(true);
  ui.downedGiveUp(P, [panels()[0][1].nonce]);
  runPending(2000);
  check(`${label}: Give up within the 2 s: no second panel`, panels().length === 1 && get(P, 'isDead') === false);
  wake();

  die(true);
  globalThis.__dboReviveWith(P, NEAR, 'healing');
  runPending(2000);
  check(`${label}: a revive within the 2 s: no second panel`, panels().length === 1);
  wake();

  die(true);
  set(P, 'isDead', false);
  runPending(2000);
  check(`${label}: back on their feet within the 2 s: no second panel`, panels().length === 1);
  wake();

  die(true);
  const first = panels()[0][1].nonce;
  now += 1000;
  wake(); die(false);
  runPending(2000);
  check(`${label}: a newer down before the 2 s: the old down's retry sends nothing`, panels().length === 1 && panels()[0][1].nonce !== first);
  wake();
};

// Live-then-new: the module on origin/server (2233d314) holds a down, then this one is loaded over the same globalThis
let live = null;
try { live = execFileSync('git', ['show', '2233d314:downed.js'], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', maxBuffer: 16 << 20, stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { live = null; }
globalThis.__dboDownedState = undefined; globalThis.__dboDownedTimersSent = undefined;
if (live) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-downed-'));
  const liveFile = path.join(tmp, 'downed.js');
  fs.writeFileSync(liveFile, live);
  load(liveFile);
  ui.uiCaps(P, ['downed']);
  die(true);
  check('live 2233d314: a beast-form death shows the panel once', panels().length === 1 && !pending.some((p) => p.ms === 2000));
  const held = panels()[0][1].nonce;
  load(MODULE);
  check('hot reload: the down the live module started is still on', typeof globalThis.__dboIsDowned === 'function' && globalThis.__dboIsDowned(P) === true);
  ui.downedGiveUp(P, [held]);
  check('hot reload: its panel\'s Give up still works', get(P, 'isDead') === false);
  wake();
  fs.rmSync(tmp, { recursive: true, force: true });
  run('after the reload');
} else {
  console.log('skip live-then-new: 2233d314 is not in this repository');
  load(MODULE);
  run('new');
}

delete globalThis.__dboBeastOriginalRace;
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
