// Whether other players see the Vampire Lord body has to survive a restart and a deploy (2026-09-29: the 17:15 restart
// read the config again and undid an off). beastform.js keeps /vlremote in beastform-state.json and reads it before the
// config; the tracked config has it on (Nate, 5 Oct). A breaker trip is per Lord on the character since 5 Oct, so it
// writes nothing here, and a blanket trip the old breaker saved no longer hides every Lord.
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
  hasUiCap: (a, c) => c === 'beastBody' && a === NEAR,
});
const reload = (cfg) => { props = props || new Map(); timers = new Map(); commands = new Map(); logs = []; delete require.cache[BEASTFORM]; require(BEASTFORM)(api(cfg)); };
let keepWorld = false;
const restart = (cfg) => {
  for (const k of ['__dboVampireLordRemote', '__dboVlRemoteSetBy', '__dboBeastBody', '__dboBeastNear', '__dboBeastCasts', '__dboBeastDrops', '__dboBeastDropLog']) delete globalThis[k];
  if (!keepWorld) props = new Map();
  reload(cfg);
};
const on = () => globalThis.__dboVampireLordRemote === true;
const saved = () => { try { return JSON.parse(fs.readFileSync('beastform-state.json', 'utf8')); } catch (e) { return null; } };
let fail = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got)}`); if (!c) fail++; };

// The tracked config has it on
ok(TRACKED.beastform && TRACKED.beastform.vampireLordRemoteRace === true, 'the tracked gamemode-config.json has beastform.vampireLordRemoteRace true (Nate, 5 Oct)', TRACKED.beastform);
restart(TRACKED);
ok(on(), 'a fresh process with no state file and the tracked config starts with the body on');
ok(logs.some((l) => /Vampire Lord remote body ON/.test(l)), 'and says so in the boot line');
ok(saved() === null, 'reading the config writes no state file');

// Staff turn it off: the file keeps it through a reload and a restart, over the config's on
commands.get('vlremote')(NEAR, 'off');
ok(!on() && saved() && saved().vampireLordRemote === false && saved().setBy === 'admin', '/vlremote off turns it off and writes the file', saved());
reload(TRACKED);
ok(!on(), 'a hot reload keeps it off');
restart(TRACKED);
ok(!on(), 'a restart keeps it off, the file over the config');
ok(logs.some((l) => /Vampire Lord remote body off/.test(l)), 'and the boot line says off');
commands.get('vlremote')(NEAR, 'on');
restart({ beastform: { vampireLordRemoteRace: false } });
ok(on() && saved().setBy === 'admin', '/vlremote on survives a restart, over a config that says off', saved());

// Two crash-like drops beside a shown Lord trip its own body: nothing goes to the file, the switch stays on
fs.rmSync('beastform-state.json', { force: true });
restart(TRACKED);
props.set(VL + '|private.beast', { form: 'vampirelord', original: { raceId: 0x13746 }, at: Date.now(), until: 0 });
for (const [a, x] of [[VL, 1000], [NEAR, 1200]]) { props.set(a + '|worldOrCellDesc', CELL); props.set(a + '|pos', [x, 1000, 0]); }
timers.get('beastForms')();
ok(globalThis.__dboVlBreakerDrop(NEAR, false) === false, 'one drop beside a shown Lord trips nothing');
timers.get('beastForms')();
ok(globalThis.__dboVlBreakerDrop(NEAR, false) === true && on(), 'the second trips that Lord alone; the body stays on for everyone');
ok(saved() === null && props.get(VL + '|private.vlBodyOff'), 'the trip is on the character, not in the file', saved());
keepWorld = true;
restart(TRACKED);
keepWorld = false;
ok(on() && !globalThis.__dboBeastBodyShown(VL), 'a restart keeps that Lord off and the others on');

// A blanket trip the old breaker saved does not hide every Lord after the update; an admin's off does
fs.writeFileSync('beastform-state.json', JSON.stringify({ vampireLordRemote: false, setBy: 'breaker', at: '2026-09-29T15:03:33Z' }));
restart(TRACKED);
ok(on(), 'an old breaker entry in the file is not read as a choice (the config decides)');
commands.get('vlremote')(NEAR, 'off');
restart(TRACKED);
ok(!on(), '...but an admin off still is');

// A damaged file falls back to the config instead of throwing
fs.writeFileSync('beastform-state.json', '{not json');
restart({ beastform: { vampireLordRemoteRace: false } });
ok(!on(), 'an unreadable state file falls back to the config (off here)');
restart({});
ok(on(), 'and to the code default (on) when the config says nothing');

console.log(fail ? `${fail} failed` : 'all checks passed');
process.exit(fail ? 1 : 0);
