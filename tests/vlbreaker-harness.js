// Scripted test for the Vampire Lord crash breaker in server\beastform.js. The remote Vampire Lord body is on by
// default, so a crash beside one has to turn it off by itself: this walks a crash-like drop near a Vampire Lord,
// a menu quit (which must not trip it), a drop far away and a drop in another cell, the fallback appearance the
// trip restores, and the state surviving a gamemode reload. No server and no game: run it from this folder's
// parent with
//
//   node tests\vlbreaker-harness.js
'use strict';
const path = require('path');
const BEASTFORM = path.resolve(__dirname, '..', 'beastform.js');

const VL = 0x14, NEAR = 0x15, FAR = 0x16, ELSEWHERE = 0x17;
const CELL = 'a764b:BSHeartland.esm', OTHER_CELL = '3c:Skyrim.esm';

let props, online, out, timers, commands, admins;
const reset = () => {
  props = new Map(); online = new Set([VL, NEAR, FAR, ELSEWHERE]); timers = new Map(); commands = new Map();
  admins = new Set([ELSEWHERE]);
  out = { logs: [], audits: [], personals: [], packets: [] };
  props.set(VL + '|worldOrCellDesc', CELL);        props.set(VL + '|pos', [1000, 1000, 0]);
  props.set(NEAR + '|worldOrCellDesc', CELL);      props.set(NEAR + '|pos', [1200, 1000, 0]);
  props.set(FAR + '|worldOrCellDesc', CELL);       props.set(FAR + '|pos', [90000, 90000, 0]);
  props.set(ELSEWHERE + '|worldOrCellDesc', OTHER_CELL); props.set(ELSEWHERE + '|pos', [1000, 1000, 0]);
};
const api = {
  mp: {
    getIdFromDesc: (d) => parseInt(String(d).split(':')[0], 16) >>> 0,
    get: (id, prop) => props.get(id + '|' + prop),
    set: (id, prop, v) => props.set(id + '|' + prop, v),
    callPapyrusFunction: () => undefined,
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
  findByName: () => 0,
  redress: () => undefined,
  isAdmin: (a) => admins.has(a),
  cfg: {},
};

let checks = 0, failures = 0;
const check = (name, ok, extra) => {
  checks++;
  if (ok) { console.log(`ok   ${name}`); return; }
  failures++;
  console.log(`FAIL ${name}${extra !== undefined ? ': ' + JSON.stringify(extra) : ''}`);
};

// A Vampire Lord already transformed, with the real appearance kept the way tryTransform keeps it
const asVampireLord = (a) => {
  props.set(a + '|private.beast', { form: 'vampirelord', original: { raceId: 0x13746, name: 'real' }, at: Date.now(), until: 0 });
};
const load = () => { delete require.cache[BEASTFORM]; require(BEASTFORM)(api); };
const fresh = () => {
  reset();
  delete globalThis.__dboVampireLordRemote; delete globalThis.__dboVlSeen; delete globalThis.__dboVlRemoteSetBy;
  load();
  asVampireLord(VL);
  timers.get('beastForms')();   // the tick records the sighting
};

// ---- the flag itself ----
fresh();
check('the remote Vampire Lord body is on by default', globalThis.__dboVampireLordRemote === true);
check('the boot line says so', out.logs.some((l) => /Vampire Lord remote body ON/.test(l)), out.logs.filter((l) => /beastform on/.test(l)));
check('a shown Vampire Lord is recorded for the breaker', globalThis.__dboVlSeen.has(VL));

// ---- a crash-like drop beside one trips it ----
const tripped = globalThis.__dboVlBreakerDrop(NEAR, false);
check('a drop with the Journal closed beside a Vampire Lord trips the breaker', tripped === true);
check('...and the remote body is off', globalThis.__dboVampireLordRemote === false);
check('...and the Vampire Lord is put back to the real appearance', props.get(VL + '|appearance') && props.get(VL + '|appearance').name === 'real', props.get(VL + '|appearance'));
check('...and it is audited for the monitor', out.audits.some((t) => /^VLBREAKER tripped: P15 dropped near P14 at a764b:BSHeartland.esm$/.test(t)), out.audits);
check('...and staff are told, players are not', out.personals.some(([a, t]) => a === ELSEWHERE && /turned itself off/.test(t)) && !out.personals.some(([a]) => a === NEAR), out.personals);
check('...and the sightings are cleared so nothing trips twice', globalThis.__dboVlSeen.size === 0);
check('an already-off breaker does not trip again', globalThis.__dboVlBreakerDrop(NEAR, false) === false);

// ---- what must NOT trip it ----
fresh();
check('a quit through the menu does not trip it', globalThis.__dboVlBreakerDrop(NEAR, true) === false && globalThis.__dboVampireLordRemote === true);
check('...and the Vampire Lord keeps its beast body', props.get(VL + '|appearance') === undefined);

fresh();
check('a drop far away does not trip it', globalThis.__dboVlBreakerDrop(FAR, false) === false && globalThis.__dboVampireLordRemote === true);

fresh();
check('a drop in another cell does not trip it', globalThis.__dboVlBreakerDrop(ELSEWHERE, false) === false && globalThis.__dboVampireLordRemote === true);

fresh();
check("the Vampire Lord's own drop is not evidence against itself", globalThis.__dboVlBreakerDrop(VL, false) === false && globalThis.__dboVampireLordRemote === true);

// ---- a stale sighting is forgotten ----
fresh();
globalThis.__dboVlSeen.set(VL, { cell: CELL, pos: [1000, 1000, 0], at: Date.now() - 600000 });
check('a sighting older than the window does not trip it', globalThis.__dboVlBreakerDrop(NEAR, false) === false && globalThis.__dboVampireLordRemote === true);

// ---- the state survives a gamemode reload ----
fresh();
globalThis.__dboVlBreakerDrop(NEAR, false);
check('the breaker tripped before the reload', globalThis.__dboVampireLordRemote === false);
load();
check('...and a hot reload does not turn the remote body back on', globalThis.__dboVampireLordRemote === false);
check('...and the boot line says off', out.logs.filter((l) => /beastform on/.test(l)).pop().includes('remote body off'));

// ---- a value merely seeded from config must not outlive the config that set it ----
fresh();
globalThis.__dboVampireLordRemote = false;   // an older process seeded false; nobody decided it
delete globalThis.__dboVlRemoteSetBy;
load();
check('a stale seed is re-seeded from config on reload', globalThis.__dboVampireLordRemote === true);
fresh();
globalThis.__dboVlBreakerDrop(NEAR, false);
load();
check('...but a breaker trip is not undone by a reload', globalThis.__dboVampireLordRemote === false);

// ---- an admin can turn it back on ----
commands.get('vlremote')(ELSEWHERE, 'on');
check('/vlremote on arms it again', globalThis.__dboVampireLordRemote === true);

console.log(`\n${checks - failures}/${checks} passed`);
process.exit(failures ? 1 : 0);
