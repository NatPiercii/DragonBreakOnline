// Whether other players see a werewolf's beast body (2026-09-30: a werewolf's howls crashed three watchers; every relayed
// cast or stop of a beast writes a humanoid animation-variable snapshot into the watcher's beast-race copy). beastform.js
// keeps /wwremote in beastform-state.json beside /vlremote's key, read before the config; the default stays on (today's
// look) until staff turn it off as the mitigation. Each "restart" clears the process globals and loads beastform.js again.
//   node tests/ww-remote-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const BEASTFORM = path.join(ROOT, 'beastform.js');
const TRACKED = JSON.parse(fs.readFileSync(path.join(ROOT, 'gamemode-config.json'), 'utf8'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-remote-'));
process.chdir(dir);
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });

const WOLF = 0x14, WATCHER = 0x15;
const HUMAN = 0x13746, WEREWOLF_RACE = 0xcdd84, VL_RACE = 0x283a;
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
  registerChatCommand: (n, fn) => commands.set(n, fn), onlineActors: () => [WOLF, WATCHER],
  every: (n, ms, fn) => timers.set(n, fn), findByName: () => 0, redress: () => undefined, isAdmin: () => true, cfg,
});
const reload = (cfg) => { props = props || new Map(); timers = new Map(); commands = new Map(); logs = []; delete require.cache[BEASTFORM]; require(BEASTFORM)(api(cfg)); };
const restart = (cfg) => {
  for (const k of ['__dboVampireLordRemote', '__dboVlRemoteSetBy', '__dboWerewolfRemote', '__dboWwRemoteSetBy', '__dboVlSeen', '__dboVlNear', '__dboVlCasts', '__dboVlDrops']) delete globalThis[k];
  props = new Map(); reload(cfg);
};
const fresh = () => {
  props.set(WOLF + '|private.beast', null);
  props.set(WOLF + '|isDead', false);
  props.set(WOLF + '|appearance', { raceId: HUMAN, name: 'Wolf', headpartIds: [1, 2], tints: [], options: [], presets: [] });
  props.set(WOLF + '|inventory', { entries: [] });
  for (const [a, x] of [[WOLF, 1000], [WATCHER, 1200]]) { props.set(a + '|worldOrCellDesc', CELL); props.set(a + '|pos', [x, 1000, 0]); }
};
const change = (form) => { fresh(); return globalThis.__dboBeastTransform(WOLF, form, true); };
const raceShown = () => Number((props.get(WOLF + '|appearance') || {}).raceId) >>> 0;
const on = () => globalThis.__dboWerewolfRemote !== false;
const saved = () => { try { return JSON.parse(fs.readFileSync('beastform-state.json', 'utf8')); } catch (e) { return null; } };
let fail = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got)}`); if (!c) fail++; };

// ---- defaults: the tracked config shows the werewolf body again (Nate, 5 Oct; off from 30 Sep as the crash mitigation) ----
ok(TRACKED.beastform && TRACKED.beastform.werewolfRemoteRace === true, 'the tracked gamemode-config.json has beastform.werewolfRemoteRace true (Nate, 5 Oct)', TRACKED.beastform);
ok(TRACKED.beastform.vampireLordRemoteRace === false, '...and the Vampire Lord body stays off');
restart(TRACKED);
ok(on(), 'a fresh process with no state file starts with the werewolf body on');
ok(logs.some((l) => /werewolf remote body ON/.test(l)), 'and says so in the boot line', logs.filter((l) => /beastform on/.test(l)));
ok(saved() === null, 'reading the config writes no state file');
ok(change('werewolf') === true && raceShown() === WEREWOLF_RACE, 'on: a werewolf shows the beast race to other players', raceShown().toString(16));
ok((props.get(WOLF + '|appearance') || {}).name === 'Werewolf' && globalThis.__dboBeastName(WOLF) === 'Werewolf', '...named Werewolf, never their own name', props.get(WOLF + '|appearance'));
globalThis.__dboBeastRevert(WOLF, 'test');
ok((props.get(WOLF + '|appearance') || {}).name === 'Wolf' && raceShown() === HUMAN && globalThis.__dboBeastName(WOLF) === '', 'the revert puts the real name and race back', props.get(WOLF + '|appearance'));
restart({ beastform: { werewolfRemoteRace: false } });
ok(!on(), 'config off: the werewolf body is off');
ok(change('werewolf') === true && raceShown() === HUMAN && (props.get(WOLF + '|appearance') || {}).name === 'Werewolf', 'off: a werewolf keeps its human appearance for other players, but is still named Werewolf', props.get(WOLF + '|appearance'));
restart({});
ok(on(), 'the code default is on when the config says nothing');
ok(change('werewolf') === true && raceShown() === WEREWOLF_RACE, 'on: a werewolf shows the beast race to other players', raceShown().toString(16));

// ---- /wwremote off: the mitigation ------------------------------------------------------------------------------------
commands.get('vlremote')(WATCHER, 'on');
commands.get('wwremote')(WATCHER, 'off');
ok(!on() && saved() && saved().werewolfRemote === false && saved().werewolfSetBy === 'admin', '/wwremote off turns it off and writes the file', saved());
ok(saved().vampireLordRemote === true && saved().setBy === 'admin', 'and keeps /vlremote\'s key in the same file', saved());
ok(change('werewolf') === true && raceShown() === HUMAN, 'off: a werewolf keeps its human appearance for other players', raceShown().toString(16));
ok(props.get(WOLF + '|private.beast') && props.get(WOLF + '|private.beast').form === 'werewolf', '...while the change itself still happens (the server state says werewolf)');
ok(change('vampirelord') === true && raceShown() === VL_RACE && (props.get(WOLF + '|appearance') || {}).name === 'Vampire Lord', 'the werewolf switch does not touch the Vampire Lord body; a Vampire Lord is named so', props.get(WOLF + '|appearance'));
reload(TRACKED);
ok(!on(), 'a hot reload keeps it off');
restart(TRACKED);
ok(!on(), 'a restart keeps it off');
ok(logs.some((l) => /werewolf remote body off \(admin\)/.test(l)), 'and the boot line says who set it', logs.filter((l) => /beastform on/.test(l)));
commands.get('vlremote')(WATCHER, 'off');
ok(change('vampirelord') === true && raceShown() === HUMAN && (props.get(WOLF + '|appearance') || {}).name === 'Vampire Lord', 'Vampire Lord body off: the human copy is still named Vampire Lord', props.get(WOLF + '|appearance'));
ok(saved().werewolfRemote === false && saved().vampireLordRemote === false, '/vlremote writes keep the werewolf key', saved());

// ---- back on (Nate's two-client test) -----------------------------------------------------------------------------------
commands.get('wwremote')(WATCHER, 'on');
restart(TRACKED);
ok(on() && change('werewolf') === true && raceShown() === WEREWOLF_RACE, '/wwremote on survives a restart and shows the body again');

// ---- a damaged file falls back to the config ------------------------------------------------------------------------------
fs.writeFileSync('beastform-state.json', '{not json');
restart({ beastform: { werewolfRemoteRace: false } });
ok(!on(), 'an unreadable state file falls back to the config (off here)');
restart(TRACKED);
ok(on(), '...and to the tracked config (on)');

// ---- wiring --------------------------------------------------------------------------------------------------------
const gm = fs.readFileSync(path.join(ROOT, 'gamemode.js'), 'utf8');
ok(/const LEAD_ONLY = new Set\(\[[^\]]*'wwremote'/.test(gm), '/wwremote is Lead GM and above (gamemode.js LEAD_ONLY)');
ok(/items: \[[^\]]*'wwremote'/.test(gm), 'and listed in the staff help beside /vlremote');

const pm = fs.readFileSync(path.join(ROOT, 'playermenu.js'), 'utf8');
ok(/const nameFor = \(viewer, a\) => beastName\(a\) \|\|/.test(pm), 'playermenu nameFor names a beast after its form for every viewer, before masks and introductions');
ok(/if \(beastName\(a\)\) return personal\(a, 'You cannot handle a mask in this form\.'\);\s*\n\s*if \(isMasked\(a\)\) unmask/.test(pm), 'a mask cannot go on or off in a beast form (it would write a human name over the beast\'s)');
ok(/if \(beastNamed\) \{ if \(!prev\) continue; now\.name = prev\.name; \}/.test(gm), 'the rename watch does not audit a beast name as a rename');
ok(/globalThis\.__dboBeastRevert\(a, 'login'\)/.test(gm) && /globalThis\.__dboBeastRevert\(a, 'logout'\)/.test(gm) && /globalThis\.__dboBeastRevert\(actorId, 'death'\)/.test(gm), 'the real name comes back on login, logout and death (each reverts the form)');

console.log(fail ? `${fail} failed` : 'all checks passed');
process.exit(fail ? 1 : 0);
