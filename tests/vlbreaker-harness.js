// Scripted test for the Vampire Lord crash breaker in server\beastform.js, per Lord since 5 Oct. The old breaker hid every
// Lord from everyone on one drop, which once named the body for a watcher who crashed twice more that day without one. Now
// the body goes only to 0.3.77 clients ('beastBody'), and breakerDrops (2) drops by watchers shown one Lord's body within
// breakerWindowSeconds turn off that Lord's body alone (private.vlBodyOff, kept on the character) until /vlremote clear.
// This walks crash-like drops beside a Lord, a menu quit, a drop far away, one in another cell, the Lord's own drop, a
// stale sighting, the reload and restart, /vlremote clear, and /vlremote off as the switch for everyone. Run it from
// this folder's parent with
//
//   TMPDIR=$(mktemp -d /dev/shm/claude-nate-XXXX) node tests/vlbreaker-harness.js
'use strict';
const path = require('path');
const BEASTFORM = path.resolve(__dirname, '..', 'beastform.js');
// /vlremote writes beastform-state.json into the working folder: run in a scratch one, so no run reads another's
const scratch = require('fs').mkdtempSync(path.join(require('os').tmpdir(), 'vl-'));
process.chdir(scratch);
process.on('exit', () => { try { require('fs').rmSync(scratch, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });

const VL = 0x14, NEAR = 0x15, FAR = 0x16, ELSEWHERE = 0x17, NEAR2 = 0x18;
const VL_RACE = 0x283a;
const CELL = 'a764b:BSHeartland.esm', OTHER_CELL = '3c:Skyrim.esm';

let clock = Date.UTC(2026, 9, 5, 12, 0, 0);
Date.now = () => clock;
let props, online, out, timers, commands, admins;
const reset = () => {
  props = new Map(); online = new Set([VL, NEAR, FAR, ELSEWHERE, NEAR2]); timers = new Map(); commands = new Map();
  admins = new Set([ELSEWHERE]);
  out = { logs: [], audits: [], personals: [], packets: [] };
  props.set(VL + '|worldOrCellDesc', CELL);        props.set(VL + '|pos', [1000, 1000, 0]);
  props.set(NEAR + '|worldOrCellDesc', CELL);      props.set(NEAR + '|pos', [1200, 1000, 0]);
  props.set(NEAR2 + '|worldOrCellDesc', CELL);     props.set(NEAR2 + '|pos', [1000, 1300, 0]);
  props.set(FAR + '|worldOrCellDesc', CELL);       props.set(FAR + '|pos', [90000, 90000, 0]);
  props.set(ELSEWHERE + '|worldOrCellDesc', OTHER_CELL); props.set(ELSEWHERE + '|pos', [1000, 1000, 0]);
};
const api = {
  mp: {
    getIdFromDesc: (d) => parseInt(String(d).split(':')[0], 16) >>> 0,
    getDescFromId: (id) => `${id.toString(16)}:x`,
    get: (id, prop) => props.get(id + '|' + prop),
    set: (id, prop, v) => props.set(id + '|' + prop, v),
    callPapyrusFunction: () => undefined,
    lookupEspmRecordById: () => null,
  },
  log: (...a) => out.logs.push(a.join(' ')),
  personal: (a, t) => out.personals.push([a, t]),
  audit: (t) => out.audits.push(t),
  display: (a) => `P${a.toString(16)}`,
  who: (a) => `P${a.toString(16)}`,
  sendPacket: (a, p) => { out.packets.push([a, p]); return true; },
  registerChatCommand: (n, fn) => commands.set(n, fn),
  onlineActors: () => [...online],
  every: (n, ms, fn) => timers.set(n, fn),
  findByName: (n) => (n === 'P14' ? VL : 0),
  redress: () => undefined,
  isAdmin: (a) => admins.has(a),
  cfg: {},
  hasUiCap: (a, c) => c === 'beastBody' && a !== FAR,   // FAR is on an old client
};

let checks = 0, failures = 0;
const check = (name, ok, extra) => {
  checks++;
  if (ok) { console.log(`ok   ${name}`); return; }
  failures++;
  console.log(`FAIL ${name}${extra !== undefined ? ': ' + JSON.stringify(extra) : ''}`);
};

const GLOBALS = ['__dboVampireLordRemote', '__dboVlRemoteSetBy', '__dboBeastBody', '__dboBeastNear', '__dboBeastCasts', '__dboBeastDrops', '__dboBeastDropLog'];
const load = () => { delete require.cache[BEASTFORM]; require(BEASTFORM)(api); };
const tick = (n = 1) => { for (let i = 0; i < n; i++) { clock += 1000; timers.get('beastForms')(); } };
const listTo = (v) => { const l = out.packets.filter(([a, p]) => a === v && p.customPacketType === 'dboBeastBody').pop(); return l ? l[1].bodies : null; };
const listed = (v) => (listTo(v) || []).some((b) => b.id === VL && b.race === VL_RACE);
const lastLine = () => out.logs.filter((l) => /^vlwatch:/.test(l)).pop() || '';
const drop = (a, journal) => globalThis.__dboVlBreakerDrop(a, journal);
// A new server with one Vampire Lord risen through tryTransform, watched for a few seconds
const fresh = () => {
  reset();
  for (const k of GLOBALS) delete globalThis[k];
  try { require('fs').rmSync('beastform-state.json', { force: true }); } catch (e) { /* none */ }
  load();
  props.set(VL + '|appearance', { raceId: 0x13746, name: 'real', headpartIds: [1], tints: [], options: [], presets: [] });
  props.set(VL + '|inventory', { entries: [] });
  props.set(VL + '|private.vampireLordGrant', true);
  globalThis.__dboBeastTransform(VL, 'vampirelord', true);
  tick(5);
};

// ---- the body ----
fresh();
check('the Vampire Lord body is on by default', globalThis.__dboVampireLordRemote === true);
check('the boot line says so', out.logs.some((l) => /Vampire Lord remote body ON/.test(l)), out.logs.filter((l) => /beastform on/.test(l)));
check('the appearance keeps the mortal race, named Vampire Lord', props.get(VL + '|appearance').raceId === 0x13746 && props.get(VL + '|appearance').name === 'Vampire Lord');
check('a 0.3.77 watcher is sent the Lord\'s body', listed(NEAR) && listed(ELSEWHERE), [listTo(NEAR)]);
check('an old client is sent nothing (the fallback named Vampire Lord)', listTo(FAR) === null);

// ---- one drop is not proof; the second trips it, for this Lord alone ----
check('a first crash-like drop beside the Lord trips nothing', drop(NEAR, false) === false && !props.get(VL + '|private.vlBodyOff') && listed(ELSEWHERE));
check('...and is logged as drop 1 of 2 with its distance', /^vlwatch: P15 dropped near P14, drop 1 of 2 in 600 s: 200 units away/.test(lastLine()), lastLine());
check('the second drop beside it trips the breaker', drop(NEAR2, false) === true);
check('...turning off this Lord\'s body, on the character', props.get(VL + '|private.vlBodyOff') && props.get(VL + '|private.vlBodyOff').by === 'breaker');
check('...not the body for everyone (the switch stays on)', globalThis.__dboVampireLordRemote === true);
check('...and every watcher gets a list without it, so they rebuild it human', !listed(ELSEWHERE), listTo(ELSEWHERE));
check('...and it is audited for the monitor', out.audits.some((t) => /^VLBREAKER tripped: P15, P18 dropped near P14 at a764b:BSHeartland.esm$/.test(t)), out.audits);
check('...and staff are told, players are not', out.personals.some(([a, t]) => a === ELSEWHERE && /Vampire Lord body of P14 turned itself off/.test(t)) && !out.personals.some(([a, t]) => a !== ELSEWHERE && /turned itself off/.test(t)), out.personals);
tick(3);   // NEAR rejoined beside it
check('a drop beside a Lord already off is logged, not counted', drop(NEAR, false) === false && /not counted: .*breaker off/.test(lastLine()), lastLine());

// ---- what must NOT count ----
fresh();
check('a quit through the menu is not counted', drop(NEAR, true) === false && drop(NEAR2, true) === false && !props.get(VL + '|private.vlBodyOff') && /quit through the menu/.test(lastLine()));
fresh();
check('a drop far away is not near', drop(FAR, false) === false && !out.logs.some((l) => /^vlwatch: P16/.test(l)));
fresh();
check('a drop in another cell is not near', drop(ELSEWHERE, false) === false && !out.logs.some((l) => /^vlwatch: P17/.test(l)));
fresh();
check("the Lord's own drop is not evidence against itself", drop(VL, false) === false && !out.logs.some((l) => /^vlwatch: P14 dropped/.test(l)));
fresh();
props.set(FAR + '|pos', [1100, 1000, 0]); tick(3);
check('an old client\'s drop beside it is the control, not counted', drop(FAR, false) === false && /^vlwatch: P16 dropped near P14, not counted: .*\(old client\)/.test(lastLine()), lastLine());
fresh();
props.set(NEAR + '|pos', [90000, 1000, 0]); props.set(NEAR2 + '|pos', [90000, 1300, 0]);
tick(121);
check('a sighting older than the window is not near', drop(NEAR, false) === false && drop(NEAR2, false) === false && !out.logs.some((l) => /^vlwatch: P1[58] dropped/.test(l)));

// ---- two drops too far apart ----
fresh();
drop(NEAR, false);
clock += 11 * 60 * 1000; tick(3);
check('a second drop 11 min after the first starts the count again', drop(NEAR2, false) === false && /drop 1 of 2/.test(lastLine()), lastLine());

// ---- the trip survives a reload and a restart, until /vlremote clear ----
fresh();
drop(NEAR, false); drop(NEAR2, false);
load(); tick();
check('a hot reload keeps the Lord off', !globalThis.__dboBeastBodyShown(VL));
for (const k of GLOBALS) delete globalThis[k];
load(); tick(31);
check('a restart keeps the Lord off (it is on the character)', !globalThis.__dboBeastBodyShown(VL) && globalThis.__dboVampireLordRemote === true);
out.personals.length = 0;
commands.get('vlremote')(ELSEWHERE, '');
check('/vlremote says who the breaker turned off', out.personals.some(([, t]) => /Turned off by the breaker \(online\): P14/.test(t)), out.personals);
commands.get('vlremote')(ELSEWHERE, 'clear P14');
check('/vlremote clear shows it again at once', !props.get(VL + '|private.vlBodyOff') && listed(ELSEWHERE), listTo(ELSEWHERE));

// ---- /vlremote off is the switch for everyone ----
commands.get('vlremote')(ELSEWHERE, 'off');
check('/vlremote off hides every Lord at once', globalThis.__dboVampireLordRemote === false && !listed(ELSEWHERE));
load();
check('...and a hot reload keeps it off', globalThis.__dboVampireLordRemote === false && out.logs.filter((l) => /beastform on/.test(l)).pop().includes('Vampire Lord remote body off'));
commands.get('vlremote')(ELSEWHERE, 'on');
check('/vlremote on shows them again', globalThis.__dboVampireLordRemote === true && listed(ELSEWHERE));

// ---- a value merely seeded from config must not outlive the config that set it ----
fresh();
globalThis.__dboVampireLordRemote = false;   // an older process seeded false; nobody decided it
delete globalThis.__dboVlRemoteSetBy;
load();
check('a stale seed is re-seeded from config on reload', globalThis.__dboVampireLordRemote === true);

console.log(`\n${checks - failures}/${checks} passed`);
process.exit(failures ? 1 : 0);
