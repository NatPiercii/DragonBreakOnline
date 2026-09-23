// Scripted test for server\rest.js: loads the real module with a mock gamemode api and walks the whole loop -
// a bed that is not a bed, a bed in the open, renting at an inn with and without an owner, the lock on a
// rented bed, sleeping (the kick), waking too early and on time, the heal pulse, Well Fed's hunger multiplier
// and the buffs running out. No server and no game: run it from this folder's parent with
//
//   node tests\rest-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const REST = path.resolve(__dirname, '..', 'rest.js');

// rest.js reads beds.json and housing.json from the working directory; give it fixtures of its own. The ids are
// real records (the pre-commit hook checks them): CommonBed01, BedrollHay01, two inn cells, a third interior
// standing in for a house, and gold as something that is not a bed.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rest-harness-'));
process.chdir(dir);
fs.writeFileSync('beds.json', JSON.stringify({
  beds: { '30091:Skyrim.esm': 'CommonBed01', '1899d:Skyrim.esm': 'BedrollHay01' },
  inns: { '13a7f:Skyrim.esm': { editorId: 'TestInn', beds: 2 }, '13a7c:Skyrim.esm': { editorId: 'OwnedInn', beds: 1 } },
}));

let wallClock = 1780000000000;
Date.now = () => wallClock;
const MIN = 60000, HOUR = 3600000;

const ME = 0x14, OTHER = 0x15, INNKEEPER = 0x16;
const INN_BED = 0x3001, INN_BED2 = 0x3002, OWNED_INN_BED = 0x3003, HOME_BED = 0x3004, WILD_BEDROLL = 0x3005, CHAIR = 0x3006;
const INN_CELL = '13a7f:Skyrim.esm', OWNED_INN_CELL = '13a7c:Skyrim.esm', HOME_CELL = '13a5c:Skyrim.esm', TAMRIEL = '3c:Skyrim.esm';
const HOME_DOOR = 0x4001, HOME_DOOR_OUT = 0x4002, INN_DOOR = 0x4003;

const props = new Map();
const put = (id, prop, v) => props.set(id + '|' + prop, v);
const place = (ref, base, cell) => { put(ref, 'baseDesc', base); put(ref, 'worldOrCellDesc', cell); put(ref, 'pos', [0, 0, 0]); };
place(INN_BED, '30091:Skyrim.esm', INN_CELL);
place(INN_BED2, '30091:Skyrim.esm', INN_CELL);
place(OWNED_INN_BED, '30091:Skyrim.esm', OWNED_INN_CELL);
place(HOME_BED, '30091:Skyrim.esm', HOME_CELL);
place(WILD_BEDROLL, '1899d:Skyrim.esm', TAMRIEL);
place(CHAIR, 'f:Skyrim.esm', INN_CELL);
place(HOME_DOOR, 'f:Skyrim.esm', TAMRIEL);
place(HOME_DOOR_OUT, 'f:Skyrim.esm', HOME_CELL);
place(INN_DOOR, 'f:Skyrim.esm', OWNED_INN_CELL);
// I own a house whose exterior door is claimed; its partner stands in the house. The innkeeper owns the second inn.
put(HOME_DOOR, 'private.housing', { owner: ME, partner: HOME_DOOR_OUT });
put(INN_DOOR, 'private.housing', { owner: INNKEEPER, partner: 0 });
fs.writeFileSync('housing.json', JSON.stringify([HOME_DOOR, INN_DOOR]));

const gold = new Map([[ME, 0], [OTHER, 100], [INNKEEPER, 0]]);
const treasury = new Map();
const out = { widgets: [], closed: 0, personals: [], systems: [], audits: [], logs: [], packets: [], kicks: [] };
const handlers = new Map(), commands = new Map(), timers = new Map();
let distance = 1;

const api = {
  mp: {
    getIdFromDesc: (d) => parseInt(String(d).split(':')[0], 16) >>> 0,
    getDescFromId: (id) => (id >>> 0).toString(16),
    get: (id, prop) => props.get(id + '|' + prop),
    set: (id, prop, v) => props.set(id + '|' + prop, v),
    kick: (user) => out.kicks.push(user),
    // The inns and the house are interior cells; Tamriel is a worldspace.
    lookupEspmRecordById: (id) => ({ 0x13a7f: 'CELL', 0x13a7c: 'CELL', 0x13a5c: 'CELL', 0x3c: 'WRLD' }[id] ? { record: { type: { 0x13a7f: 'CELL', 0x13a7c: 'CELL', 0x13a5c: 'CELL', 0x3c: 'WRLD' }[id] } } : null),
  },
  log: (...a) => out.logs.push(a.join(' ')),
  personal: (a, t) => out.personals.push([a, t]),
  system: (a, t) => out.systems.push([a, t]),
  audit: (t) => out.audits.push(t),
  display: (a) => `P${a.toString(16)}`,
  who: (a) => `P${a.toString(16)}`,
  cfg: {},
  openWidget: (a, w, focus) => { out.widgets.push({ a, w, focus }); return true; },
  closeWidget: () => { out.closed++; return true; },
  onUi: (ev, fn) => { const l = handlers.get(ev) || []; l.push(fn); handlers.set(ev, l); },
  registerChatCommand: (name, fn) => commands.set(name, fn),
  onlineActors: () => [ME, OTHER],
  every: (name, ms, fn) => timers.set(name, fn),
  sendPacket: (a, p) => { out.packets.push([a, p]); return true; },
  userOf: (a) => a + 1000,
  takeGold: (a, n) => { if ((gold.get(a) || 0) < n) return false; gold.set(a, gold.get(a) - n); return true; },
  depositToTreasury: (zone, n) => { if (!zone) return 0; treasury.set(zone, (treasury.get(zone) || 0) + n); return n; },
  giveItem: (a, base, n) => { if (base !== 0xf) return false; gold.set(a, (gold.get(a) || 0) + n); return true; },
  zoneOfActor: () => 'bruma',
  distanceMeters: () => distance,
};

// setTimeout is only used for the delayed kick; run it at once.
const realSetTimeout = setTimeout;
globalThis.setTimeout = (fn) => { fn(); return 0; };

require(REST)(api);

let failures = 0, checks = 0;
const check = (name, ok, detail) => { checks++; if (!ok) { failures++; console.log(`FAIL ${name}${detail !== undefined ? ': ' + JSON.stringify(detail) : ''}`); } else console.log(`ok   ${name}`); };
const ui = (ev, a, args, widget) => (handlers.get(ev) || []).forEach((fn) => fn(a, args || [], widget));
const activate = (ref, a) => globalThis.__dboRestActivate(ref, a);
const lastWidget = () => out.widgets[out.widgets.length - 1];
const lastPersonal = (a) => { const l = out.personals.filter((p) => p[0] === a); return l.length ? l[l.length - 1][1] : ''; };
const actionIds = () => lastWidget().w.actions.map((x) => x.id);

// ---- what is and is not a bed that matters ----
check('a chair is not a bed', activate(CHAIR, ME) === false);
check('a bedroll in the open is left to the engine', activate(WILD_BEDROLL, ME) === false);
check('boot line counts 2 bed types and 2 inns', out.logs.some((l) => /2 bed types, 2 inn cells/.test(l)), out.logs);

// ---- renting at an inn nobody owns ----
check('a free inn bed opens the rent prompt', activate(INN_BED, ME) === true && actionIds().join() === 'rent', lastWidget());
check('the prompt is a focused context menu answering dbo:restChoose', lastWidget().focus === true && lastWidget().w.type === 'contextMenu' && lastWidget().w.events.action === 'dbo:restChoose');
ui('restChoose', ME, ['rent']);
check('no gold, no bed', /need 10 gold/.test(lastPersonal(ME)) && !props.get(INN_BED + '|private.dboRent'));
gold.set(ME, 25);
activate(INN_BED, ME); ui('restChoose', ME, ['rent']);
check('renting takes 10 gold', gold.get(ME) === 15, gold.get(ME));
check('an inn with no owner pays it all to the hold', treasury.get('bruma') === 10, [...treasury]);
check('the rent is recorded on the bed for 24 hours', props.get(INN_BED + '|private.dboRent').renter === ME && props.get(INN_BED + '|private.dboRent').until === wallClock + 24 * HOUR);
check('after renting the sleep prompt opens', actionIds().join() === 'sleep' && /^Your bed until \d\d:\d\d UTC$/.test(lastWidget().w.targetName));

// ---- the lock ----
check('someone else is turned away from a rented bed', activate(INN_BED, OTHER) === true && /rented by P14/.test(lastPersonal(OTHER)), lastPersonal(OTHER));
check('...and gets no prompt', lastWidget().a === ME);
check('the next bed over is still free to them', activate(INN_BED2, OTHER) === true && actionIds().join() === 'rent');
ui('restChoose', OTHER, ['cancel']);
check('cancel rents nothing', !props.get(INN_BED2 + '|private.dboRent') && gold.get(OTHER) === 100);

// ---- an inn with an owner ----
activate(OWNED_INN_BED, OTHER); ui('restChoose', OTHER, ['rent']);
check('the innkeeper gets 90%', gold.get(INNKEEPER) === 9, gold.get(INNKEEPER));
check('the hold gets 10%', treasury.get('bruma') === 11, [...treasury]);

// ---- reach ----
distance = 20;
activate(INN_BED2, ME); ui('restChoose', ME, ['rent']);
check('too far away rents nothing', /too far/.test(lastPersonal(ME)) && gold.get(ME) === 15);
distance = 1;

// ---- your own house ----
check('a bed in your own house offers sleep, no rent', activate(HOME_BED, ME) === true && actionIds().join() === 'sleep' && lastWidget().w.targetName === 'Your bed');
check("someone else's house bed is left to the engine", activate(HOME_BED, OTHER) === false);
ui('restChoose', ME, ['cancel']);

// ---- sleeping ----
globalThis.__dboPvpAt = new Map([[ME, wallClock - 10000]]);
activate(INN_BED, ME); ui('restChoose', ME, ['sleep']);
check('no sleeping in a fight', /middle of a fight/.test(lastPersonal(ME)) && out.kicks.length === 0);
globalThis.__dboPvpAt = new Map();
activate(INN_BED, ME); ui('restChoose', ME, ['sleep']);
check('sleeping records the time and bed', props.get(ME + '|private.dboSleep').at === wallClock && props.get(ME + '|private.dboSleep').bed === INN_BED);
check('the client is told why before the kick', out.packets.some(([a, p]) => a === ME && p.customPacketType === 'kicked' && /30 minutes/.test(p.reason)));
check('the player is kicked', out.kicks.length === 1 && out.kicks[0] === ME + 1000, out.kicks);
check('a stranger cannot sleep in my rented bed through a stale prompt', (() => { props.set(OTHER + '|private.dboSleep', undefined); activate(INN_BED2, OTHER); ui('restChoose', OTHER, ['sleep']); return out.kicks.length === 1; })());

// ---- waking too early ----
wallClock += 10 * MIN;
globalThis.__dboRestLogin(ME);
check('ten minutes is not enough', /only 10 minutes/.test(lastPersonal(ME)) && !props.get(ME + '|private.dboRested'));
check('the sleep is spent either way', props.get(ME + '|private.dboSleep') === null);

// ---- waking on time ----
activate(INN_BED, ME); ui('restChoose', ME, ['sleep']);
wallClock += 31 * MIN;
globalThis.__dboRestLogin(ME);
check('31 minutes wakes Well Rested for 2 hours', props.get(ME + '|private.dboRested').until === wallClock + 2 * HOUR);
check('...and Well Fed for 2 hours', props.get(ME + '|private.dboWellFed').until === wallClock + 2 * HOUR);
check('the player is told', out.systems.some(([a, t]) => a === ME && /Well Rested and Well Fed/.test(t)));
check('a login with no sleep does nothing', (() => { const n = out.systems.length; globalThis.__dboRestLogin(OTHER); return out.systems.length === n; })());

// ---- the buffs at work ----
check('Well Fed halves hunger', globalThis.__dboRestHungerMult(ME) === 0.5 && globalThis.__dboRestHungerMult(OTHER) === 1);
props.set(ME + '|percentages', { health: 0.5, magicka: 1, stamina: 1 });
props.set(OTHER + '|percentages', { health: 0.5, magicka: 1, stamina: 1 });
timers.get('rest')();
check('the pulse heals 0.4%/s x 5 s = 2%', Math.abs(props.get(ME + '|percentages').health - 0.52) < 1e-9, props.get(ME + '|percentages'));
check('...and only the rested', props.get(OTHER + '|percentages').health === 0.5);
check('magicka and stamina are untouched', props.get(ME + '|percentages').magicka === 1 && props.get(ME + '|percentages').stamina === 1);
props.set(ME + '|percentages', { health: 0.999, magicka: 1, stamina: 1 });
timers.get('rest')();
check('never past full', props.get(ME + '|percentages').health === 1);
props.set(ME + '|percentages', { health: 0.5, magicka: 1, stamina: 1 });
globalThis.__dboPvpAt = new Map([[ME, wallClock - 5000]]);
timers.get('rest')();
check('no extra heal in PvP', props.get(ME + '|percentages').health === 0.5);
globalThis.__dboPvpAt = new Map();
commands.get('rest')(ME);
check('/rest reports time left', /Well Rested: 2h 0m left\. Well Fed: 2h 0m left\./.test(lastPersonal(ME)), lastPersonal(ME));

// ---- running out ----
wallClock += 2 * HOUR + MIN;
timers.get('rest')();
check('both end with a notice', /no longer Well Rested/.test(out.personals.filter((p) => p[0] === ME).map((p) => p[1]).join('|')) && /no longer Well Fed/.test(lastPersonal(ME)));
check('...and stop working', globalThis.__dboRestHungerMult(ME) === 1 && props.get(ME + '|percentages').health === 0.5);

// ---- the rent runs out ----
wallClock += 22 * HOUR;
check('an expired rent frees the bed', activate(INN_BED, OTHER) === true && actionIds().join() === 'rent');

globalThis.setTimeout = realSetTimeout;
process.chdir(os.tmpdir());
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${checks - failures}/${checks} passed`);
process.exit(failures ? 1 : 0);
