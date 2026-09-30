// Whether other players see the Vampire Lord body has to survive a restart and a deploy (2026-09-29: the breaker
// tripped at 15:03, the 17:15 restart read the config again and showed the body to everyone). beastform.js keeps a
// trip or /vlremote in beastform-state.json and reads it before the config; the tracked config starts it off.
// Each "restart" below clears the process globals and loads beastform.js again in the same folder.
//   node tests/vl-remote-persist-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const BEASTFORM = path.resolve(__dirname, '..', 'beastform.js');
const TRACKED = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'gamemode-config.json'), 'utf8'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-persist-'));
process.chdir(dir);
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });

const VL = 0x14, NEAR = 0x15;
const CELL = 'a764b:BSHeartland.esm';
let props, timers, commands, logs;
const api = (cfg) => ({
  mp: {
    getIdFromDesc: (d) => parseInt(String(d).split(':')[0], 16) >>> 0,
    getDescFromId: (id) => `${id.toString(16)}:x`,
    get: (id, p) => props.get(id + '|' + p),
    set: (id, p, v) => props.set(id + '|' + p, v),
    callPapyrusFunction: () => undefined,
    lookupEspmRecordById: () => null,
  },
  log: (...a) => logs.push(a.join(' ')), personal: () => {}, audit: () => {},
  display: (a) => `P${a.toString(16)}`, who: (a) => `P${a.toString(16)}`, sendPacket: () => true,
  registerChatCommand: (n, fn) => commands.set(n, fn), onlineActors: () => [VL, NEAR],
  every: (n, ms, fn) => timers.set(n, fn), findByName: () => 0, redress: () => undefined, isAdmin: () => true, cfg,
});
const reload = (cfg) => { props = props || new Map(); timers = new Map(); commands = new Map(); logs = []; delete require.cache[BEASTFORM]; require(BEASTFORM)(api(cfg)); };
const restart = (cfg) => {
  for (const k of ['__dboVampireLordRemote', '__dboVlRemoteSetBy', '__dboVlSeen', '__dboVlNear', '__dboVlCasts', '__dboVlDrops']) delete globalThis[k];
  props = new Map(); reload(cfg);
};
const on = () => globalThis.__dboVampireLordRemote === true;
const saved = () => { try { return JSON.parse(fs.readFileSync('beastform-state.json', 'utf8')); } catch (e) { return null; } };
let fail = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got)}`); if (!c) fail++; };

// The tracked config starts it off
ok(TRACKED.beastform && TRACKED.beastform.vampireLordRemoteRace === false, 'the tracked gamemode-config.json has beastform.vampireLordRemoteRace false', TRACKED.beastform);
restart(TRACKED);
ok(!on(), 'a fresh process with no state file and the tracked config starts with the body off');
ok(logs.some((l) => /Vampire Lord remote body off/.test(l)), 'and says so in the boot line');
ok(saved() === null, 'reading the config writes no state file');

// Staff turn it on: the file keeps it through a reload and a restart, over the config's off
commands.get('vlremote')(NEAR, 'on');
ok(on() && saved() && saved().vampireLordRemote === true && saved().setBy === 'admin', '/vlremote on turns it on and writes the file', saved());
reload(TRACKED);
ok(on(), 'a hot reload keeps it on');
restart(TRACKED);
ok(on(), 'a restart keeps it on, the file over the config');

// A crash-like drop beside a Vampire Lord trips it: off survives a restart, even under a config that says on
props.set(VL + '|private.beast', { form: 'vampirelord', original: { raceId: 0x13746 }, at: Date.now(), until: 0 });
for (const [a, x] of [[VL, 1000], [NEAR, 1200]]) { props.set(a + '|worldOrCellDesc', CELL); props.set(a + '|pos', [x, 1000, 0]); }
timers.get('beastForms')();
ok(globalThis.__dboVlBreakerDrop(NEAR, false) === true && !on(), 'a drop beside a shown Vampire Lord trips the breaker');
ok(saved() && saved().vampireLordRemote === false && saved().setBy === 'breaker', 'the trip is written to the file', saved());
restart({ beastform: { vampireLordRemoteRace: true } });
ok(!on(), 'a restart after the trip keeps it off, even with a config that says on');
restart({});
ok(!on(), 'and with the old default config');

// /vlremote off is kept the same way
commands.get('vlremote')(NEAR, 'on'); commands.get('vlremote')(NEAR, 'off');
restart({});
ok(!on() && saved().setBy === 'admin', '/vlremote off survives a restart', saved());

// A damaged file falls back to the config instead of throwing
fs.writeFileSync('beastform-state.json', '{not json');
restart(TRACKED);
ok(!on(), 'an unreadable state file falls back to the config (off)');
restart({});
ok(on(), 'and to the code default only when the config says nothing');

console.log(fail ? `${fail} failed` : 'all checks passed');
process.exit(fail ? 1 : 0);
