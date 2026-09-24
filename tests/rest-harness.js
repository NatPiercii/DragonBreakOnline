// Scripted test for server\rest.js: loads the real module with a mock gamemode api and walks the whole loop -
// a bed that is not a bed, a bed in the open, a resident's or innkeeper's bed in an inn, renting at an inn with
// and without an owner (online or not), which claims make an owner, the hold the rent goes to, the lock on a
// rented bed, one bed per player across characters, lying down, sleeping (the kick), another character voiding a
// sleep, a prompt outliving a reload, waking too early and on time, the heal pulse, Well Fed's hunger multiplier and the buffs running out. It then checks
// the real server\beds.json for the inns players can reach. No server and no game: run it from this folder's
// parent with
//
//   node tests\rest-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const REST = path.resolve(__dirname, '..', 'rest.js');
const REAL_BEDS = path.resolve(__dirname, '..', 'beds.json');

// rest.js reads beds.json and housing.json from the working directory; give it fixtures of its own. The ids are
// real records (the pre-commit hook checks them): Snowstone Rest with its innkeeper's rent bed, the innkeeper's
// own bed and a resident's bed; Frostfruit Inn's two-bed rent room; the Four Shields Tavern (owned by a player);
// Jerall View Inn, whose only rent bed is in its basement (one inn); Windpeak Inn in a hold with no treasury;
// Moorside Inn in the older format with no bed list; a third interior standing in for a house; gold as
// something that is not a bed.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rest-harness-'));
process.chdir(dir);
fs.writeFileSync('beds.json', JSON.stringify({
  beds: { '30091:Skyrim.esm': 'CommonBed01', '1899d:Skyrim.esm': 'BedrollHay01', '8aa9c:BSHeartland.esm': 'CYRLowerBedSingleR' },
  inns: {
    '2936:BSHeartland.esm': { name: 'Snowstone Rest', hold: 'bruma', group: '2936:BSHeartland.esm', rentBedRefs: ['7ec0f:BSHeartland.esm'], entrance: true },
    '13870:Skyrim.esm': { name: 'Frostfruit Inn', hold: 'whiterun', group: '13870:Skyrim.esm', rentBedRefs: ['174b0:Skyrim.esm', 'e0adb:Skyrim.esm'], entrance: true },
    '13a7c:Skyrim.esm': { name: 'Four Shields Tavern', hold: 'solitude', group: '13a7c:Skyrim.esm', rentBedRefs: ['13e41:Skyrim.esm'], entrance: true },
    '1114:BSHeartland.esm': { name: 'Jerall View Inn', hold: 'bruma', group: '1114:BSHeartland.esm', rentBedRefs: [], entrance: true },
    '6c14f:BSHeartland.esm': { name: 'Jerall View Inn Basement', hold: 'bruma', group: '1114:BSHeartland.esm', rentBedRefs: ['6efd1:BSHeartland.esm'], entrance: true },
    '13a7f:Skyrim.esm': { name: 'Windpeak Inn', hold: 'dawnstar', group: '13a7f:Skyrim.esm', rentBedRefs: ['13d42:Skyrim.esm'], entrance: true },
    '138ce:Skyrim.esm': { editorId: 'MorthalMoorsideInn', beds: 3 },
  },
}));

let wallClock = 1780000000000;
Date.now = () => wallClock;
const MIN = 60000, HOUR = 3600000;

const ME = 0x14, OTHER = 0x15, INNKEEPER = 0x16, THIRD = 0x17, ME2 = 0x18;
const PROFILE = { [ME]: 101, [ME2]: 101, [OTHER]: 102, [INNKEEPER]: 103, [THIRD]: 104 };
const INN_BED = 0x7ec0f, KEEPER_BED = 0x2a2f, INN_BED2 = 0xe0adb, RESIDENT_BED = 0x29d6, OWNED_INN_BED = 0x13e41, JERALL_BED = 0x1155, BASEMENT_BED = 0x6efd1;
const WINDPEAK_BED = 0x13d42, MOORSIDE_BED = 0x1738d, HOME_BED = 0x3004, WILD_BEDROLL = 0x3005, CHAIR = 0x3006;
const FROSTFRUIT = '13870:Skyrim.esm', INN_CELL = '2936:BSHeartland.esm', OWNED_INN_CELL = '13a7c:Skyrim.esm', JERALL = '1114:BSHeartland.esm', BASEMENT = '6c14f:BSHeartland.esm';
const WINDPEAK = '13a7f:Skyrim.esm', MOORSIDE = '138ce:Skyrim.esm', HOME_CELL = '13a5c:Skyrim.esm', TAMRIEL = '3c:Skyrim.esm';
const HOME_DOOR = 0x4001, HOME_DOOR_OUT = 0x4002, INN_DOOR = 0x4003, JERALL_DOOR = 0x4004, JERALL_DOOR_IN = 0x4005, INN_DOOR_OUT = 0x4006;
const CHEST = 0x3ff0, ROOM_DOOR = 0x3ff1, ROOM_DOOR_IN = 0x3ff2;

const props = new Map();
const put = (id, prop, v) => props.set(id + '|' + prop, v);
const place = (ref, base, cell) => { put(ref, 'baseDesc', base); put(ref, 'worldOrCellDesc', cell); put(ref, 'pos', [0, 0, 0]); };
place(INN_BED, '8aa9c:BSHeartland.esm', INN_CELL);
place(KEEPER_BED, '8aa9c:BSHeartland.esm', INN_CELL);
place(INN_BED2, '30091:Skyrim.esm', FROSTFRUIT);
place(RESIDENT_BED, '8aa9c:BSHeartland.esm', INN_CELL);
place(OWNED_INN_BED, '30091:Skyrim.esm', OWNED_INN_CELL);
place(JERALL_BED, '30091:Skyrim.esm', JERALL);
place(BASEMENT_BED, '30091:Skyrim.esm', BASEMENT);
place(WINDPEAK_BED, '30091:Skyrim.esm', WINDPEAK);
place(MOORSIDE_BED, '30091:Skyrim.esm', MOORSIDE);
place(HOME_BED, '30091:Skyrim.esm', HOME_CELL);
place(WILD_BEDROLL, '1899d:Skyrim.esm', TAMRIEL);
place(CHAIR, 'f:Skyrim.esm', INN_CELL);
place(HOME_DOOR, 'f:Skyrim.esm', TAMRIEL);
place(HOME_DOOR_OUT, 'f:Skyrim.esm', HOME_CELL);
place(INN_DOOR, 'f:Skyrim.esm', OWNED_INN_CELL);
place(JERALL_DOOR, 'f:Skyrim.esm', TAMRIEL);
place(JERALL_DOOR_IN, 'f:Skyrim.esm', JERALL);
place(INN_DOOR_OUT, 'f:Skyrim.esm', TAMRIEL);
place(CHEST, 'f:Skyrim.esm', BASEMENT);
place(ROOM_DOOR, 'f:Skyrim.esm', JERALL);
place(ROOM_DOOR_IN, 'f:Skyrim.esm', BASEMENT);
for (const [a, pid] of Object.entries(PROFILE)) put(Number(a), 'profileId', pid);
// Claims hold profile ids, as housingSystem.ts writes them. I own a house whose exterior door is claimed; its
// partner stands in the house. The innkeeper owns the Four Shields by its inside door, and THIRD holds Jerall
// View Inn by its front door, whose partner is on the main floor. OTHER holds a chest in the Jerall View basement
// and the door between its floors, neither of which makes an inn theirs; both come first in the index.
put(HOME_DOOR, 'private.housing', { owner: 101, ownerName: 'Me', partner: HOME_DOOR_OUT });
put(INN_DOOR, 'private.housing', { owner: 103, ownerName: 'Keeper', partner: INN_DOOR_OUT });
put(JERALL_DOOR, 'private.housing', { owner: 104, ownerName: 'Third', partner: JERALL_DOOR_IN });
put(CHEST, 'private.housing', { owner: 102, ownerName: 'Other', partner: 0 });
put(ROOM_DOOR, 'private.housing', { owner: 102, ownerName: 'Other', partner: ROOM_DOOR_IN });
fs.writeFileSync('housing.json', JSON.stringify([CHEST, ROOM_DOOR, HOME_DOOR, INN_DOOR, JERALL_DOOR]));

const gold = new Map([[ME, 0], [OTHER, 100], [INNKEEPER, 0], [THIRD, 0], [ME2, 0]]);
const online = new Set([ME, OTHER]);
const treasury = new Map();
const out = { widgets: [], closed: 0, personals: [], systems: [], audits: [], logs: [], packets: [], kicks: [] };
const handlers = new Map(), commands = new Map(), timers = new Map();
let distance = 1;
const CELLS = { 0x13870: 'CELL', 0x2936: 'CELL', 0x13a7c: 'CELL', 0x1114: 'CELL', 0x6c14f: 'CELL', 0x13a7f: 'CELL', 0x138ce: 'CELL', 0x13a5c: 'CELL', 0x3c: 'WRLD' };

const api = {
  mp: {
    getIdFromDesc: (d) => parseInt(String(d).split(':')[0], 16) >>> 0,
    getDescFromId: (id) => (id >>> 0).toString(16),
    get: (id, prop) => props.get(id + '|' + prop),
    set: (id, prop, v) => props.set(id + '|' + prop, v),
    kick: (user) => out.kicks.push(user),
    lookupEspmRecordById: (id) => (CELLS[id] ? { record: { type: CELLS[id] } } : null),
    getActorsByProfileId: (pid) => Object.keys(PROFILE).map(Number).filter((a) => PROFILE[a] === pid),
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
  onlineActors: () => [...online],
  every: (name, ms, fn) => timers.set(name, fn),
  sendPacket: (a, p) => { out.packets.push([a, p]); return true; },
  userOf: (a) => a + 1000,
  takeGold: (a, n) => { if ((gold.get(a) || 0) < n) return false; gold.set(a, gold.get(a) - n); return true; },
  // Dawnstar has no treasury in zones.json: the gamemode deposits nothing there.
  depositToTreasury: (zone, n) => { if (!zone || zone === 'dawnstar') return 0; treasury.set(zone, (treasury.get(zone) || 0) + n); return n; },
  giveItem: (a, base, n) => { if (base !== 0xf || !(a in PROFILE)) return false; gold.set(a, (gold.get(a) || 0) + n); return true; },
  zoneOfActor: () => 'whiterun',
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
const rentFor = (ref, a) => { activate(ref, a); ui('restChoose', a, ['rent']); };

// ---- what is and is not a bed that matters ----
check('a chair is not a bed', activate(CHAIR, ME) === false);
check('a bedroll in the open is left to the engine', activate(WILD_BEDROLL, ME) === false);
check("a resident's own bed in an inn stays plain", activate(RESIDENT_BED, ME) === false && out.widgets.length === 0);
check("the innkeeper's own bed stays plain", activate(KEEPER_BED, ME) === false && out.widgets.length === 0);
check("Jerall View's upstairs bed, the innkeepers', stays plain", activate(JERALL_BED, ME) === false && out.widgets.length === 0);
check('boot line counts bed types, inns, the Bruma ones and the beds to rent', out.logs.some((l) => /3 bed types, 7 inn cells \(3 with a door in bruma\), 6 beds to rent/.test(l)), out.logs);

// ---- renting at an inn nobody owns ----
check('a free inn bed opens the rent prompt', activate(INN_BED, ME) === true && actionIds().join() === 'rent', lastWidget());
check('the prompt names the price, the time and the inn', lastWidget().w.actions[0].label === 'Rent this bed: 10 gold for a day' && lastWidget().w.targetName === 'A bed for rent at Snowstone Rest', lastWidget().w);
check('the prompt is a focused context menu answering dbo:restChoose', lastWidget().focus === true && lastWidget().w.type === 'contextMenu' && lastWidget().w.events.action === 'dbo:restChoose');
check('opening the prompt is logged', out.logs.some((l) => /P14 opened the inn prompt for bed 7ec0f at Snowstone Rest/.test(l)));
ui('restChoose', ME, ['rent']);
check('no gold, no bed', /need 10 gold/.test(lastPersonal(ME)) && !props.get(INN_BED + '|private.dboRent'));
check('...and the failed payment is logged', out.logs.some((l) => /P14 could not pay 10 gold for bed 7ec0f/.test(l)));
gold.set(ME, 25);
rentFor(INN_BED, ME);
check('renting takes 10 gold', gold.get(ME) === 15, gold.get(ME));
check("an inn with no owner pays it all to its own hold, not the renter's zone", treasury.get('bruma') === 10 && !treasury.get('whiterun'), [...treasury]);
check('the rent is recorded on the bed for 24 hours', props.get(INN_BED + '|private.dboRent').renter === ME && props.get(INN_BED + '|private.dboRent').until === wallClock + 24 * HOUR);
check('...and on the renter', props.get(ME + '|private.dboRentBed').bed === INN_BED);
check('the rent is audited with the inn and hold', out.audits.some((t) => /^REST P14 rented bed 7ec0f at Snowstone Rest for 10 gold: 0 to no owner, 10 to bruma$/.test(t)), out.audits);
check('after renting the sleep prompt opens', actionIds().join() === 'sleep,lie' && /^Your bed at Snowstone Rest until \d\d:\d\d UTC$/.test(lastWidget().w.targetName), lastWidget().w);

// ---- the lock, and one bed per renter ----
check('someone else is turned away from a rented bed', activate(INN_BED, OTHER) === true && /rented by P14/.test(lastPersonal(OTHER)), lastPersonal(OTHER));
check('...and gets no prompt', lastWidget().a === ME);
check("another inn's rent room is still free to them", activate(INN_BED2, OTHER) === true && actionIds().join() === 'rent');
ui('restChoose', OTHER, ['cancel']);
check('cancel rents nothing', !props.get(INN_BED2 + '|private.dboRent') && gold.get(OTHER) === 100);
const widgetsBefore = out.widgets.length;
check('a renter cannot take a second bed', activate(INN_BED2, ME) === true && /already rent a bed at Snowstone Rest/.test(lastPersonal(ME)) && out.widgets.length === widgetsBefore, lastPersonal(ME));
check('...nor with another character of the same player', activate(INN_BED2, ME2) === true && /already rent a bed at Snowstone Rest/.test(lastPersonal(ME2)) && out.widgets.length === widgetsBefore, lastPersonal(ME2));

// ---- lying down in your own bed ----
activate(INN_BED, ME); ui('restChoose', ME, ['lie']);
check('Lie down lets the next use of the bed through to the engine', /Use the bed again/.test(lastPersonal(ME)) && activate(INN_BED, ME) === false);
check('...once: the use after that opens the prompt again', activate(INN_BED, ME) === true && actionIds().join() === 'sleep,lie');
ui('restChoose', ME, ['cancel']);
check('Lie down is refused on a bed that is not yours', (() => { activate(INN_BED2, OTHER); ui('restChoose', OTHER, ['lie']); return /not your bed/.test(lastPersonal(OTHER)) && activate(INN_BED2, OTHER) === true; })());
ui('restChoose', OTHER, ['cancel']);

// ---- a prompt outlives a gamemode reload ----
activate(INN_BED2, OTHER);
check('the open prompt is kept on globalThis', globalThis.__dboRestPending.get(OTHER) === INN_BED2);
globalThis.__dboRestPending.delete(OTHER);
ui('restChoose', OTHER, ['rent']);
check('a choice with no prompt on record says to use the bed again, and is logged', /Use the bed again/.test(lastPersonal(OTHER)) && gold.get(OTHER) === 100 && out.logs.some((l) => /P15 chose rent with no bed prompt/.test(l)));

// ---- an inn with an owner ----
rentFor(OWNED_INN_BED, OTHER);
check("an offline owner's 90% is held on the claim", gold.get(INNKEEPER) === 0 && props.get(INN_DOOR + '|private.dboRestOwed') === 9, props.get(INN_DOOR + '|private.dboRestOwed'));
check("the hold gets 10%, the inn's hold", treasury.get('solitude') === 1 && treasury.get('bruma') === 10, [...treasury]);
check('the audit says where the owner share went', /: 9 held for Keeper, 1 to solitude$/.test(out.audits[out.audits.length - 1]), out.audits[out.audits.length - 1]);
globalThis.__dboRestLogin(INNKEEPER);
check('...and paid when the owner logs in', gold.get(INNKEEPER) === 9 && props.get(INN_DOOR + '|private.dboRestOwed') === 0 && /took 9 gold in rent/.test(lastPersonal(INNKEEPER)));
check('the owner is turned away from a bed rented in their own inn', activate(OWNED_INN_BED, INNKEEPER) === true && /rented by P15/.test(lastPersonal(INNKEEPER)));
online.add(THIRD);
check('a claim on the front door owns the basement too, and an online owner is paid at once', (() => { gold.set(OTHER, 100); props.set(OTHER + '|private.dboRentBed', null); rentFor(BASEMENT_BED, OTHER); return gold.get(THIRD) === 9 && gold.get(OTHER) === 90; })(), [...gold]);
check('...the front door, not a chest or room door that comes first in the index', !props.get(CHEST + '|private.dboRestOwed') && !props.get(ROOM_DOOR + '|private.dboRestOwed') && gold.get(OTHER) === 90);
check('the owner sleeps free in a free bed of their inn', activate(JERALL_BED, THIRD) === true && actionIds().join() === 'sleep,lie' && lastWidget().w.targetName === 'Your bed');
ui('restChoose', THIRD, ['cancel']);
check('a chest or a room door in an inn does not make it yours', activate(JERALL_BED, OTHER) === false);
ui('restChoose', THIRD, ['cancel']);

// ---- holds and older data ----
props.set(OTHER + '|private.dboRentBed', null);
rentFor(WINDPEAK_BED, OTHER);
check('a hold with no treasury keeps nothing, and the audit says so', /: 0 to no owner, 0 to dawnstar \(no treasury\)$/.test(out.audits[out.audits.length - 1]), out.audits[out.audits.length - 1]);
props.set(OTHER + '|private.dboRentBed', null);
const whiterunBefore = treasury.get('whiterun') || 0;
rentFor(MOORSIDE_BED, OTHER);
check('an inn with no bed list rents any bed, and pays the zone the renter stands in', props.get(MOORSIDE_BED + '|private.dboRent').renter === OTHER && treasury.get('whiterun') === whiterunBefore + 10);

// ---- reach ----
distance = 20;
props.set(ME + '|private.dboRentBed', null);
const meGold = gold.get(ME);
activate(INN_BED2, ME); ui('restChoose', ME, ['rent']);
check('too far away rents nothing', /too far/.test(lastPersonal(ME)) && gold.get(ME) === meGold);
props.set(ME + '|private.dboRentBed', { bed: INN_BED, until: props.get(INN_BED + '|private.dboRent').until });
distance = 1;

// ---- your own house ----
check('a bed in your own house offers sleep, no rent', activate(HOME_BED, ME) === true && actionIds().join() === 'sleep,lie' && lastWidget().w.targetName === 'Your bed');
check("someone else's house bed is left to the engine", activate(HOME_BED, OTHER) === false);
check('my other character owns the house too: the claim is the profile', activate(HOME_BED, ME2) === true && lastWidget().w.targetName === 'Your bed');
ui('restChoose', ME2, ['cancel']);
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
check('the sleep is audited', out.audits.some((t) => /^REST P14 went to sleep in bed 7ec0f at Snowstone Rest$/.test(t)));
check('a stranger cannot sleep in my rented bed through a stale prompt', (() => { props.set(OTHER + '|private.dboSleep', undefined); ui('restClose', OTHER); props.set(OTHER + '|private.dboRentBed', null); activate(INN_BED2, OTHER); ui('restChoose', OTHER, ['sleep']); return out.kicks.length === 1; })());

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
check('playing another character voids the sleep', (() => {
  const rested = props.get(ME + '|private.dboRested').until;
  activate(INN_BED, ME); ui('restChoose', ME, ['sleep']);
  const slept = !!props.get(ME + '|private.dboSleep');
  globalThis.__dboRestLogin(ME2);
  wallClock += 31 * MIN;
  globalThis.__dboRestLogin(ME);
  wallClock -= 31 * MIN;
  return slept && props.get(ME + '|private.dboSleep') === null && props.get(ME + '|private.dboRested').until === rested;
})());

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
check('...and its renter may rent another', activate(INN_BED2, ME) === true && actionIds().join() === 'rent' && lastWidget().a === ME);

// ---- the real beds.json: the inns players can reach under the Bruma region lock ----
const real = JSON.parse(fs.readFileSync(REAL_BEDS, 'utf8'));
const inn = (d) => real.inns[d] || {};
const rents = (d) => (inn(d).rentBedRefs || []).slice().sort().join();
check("Snowstone Rest is an inn renting only its innkeeper's rent bed", rents('2936:BSHeartland.esm') === '7ec0f:BSHeartland.esm', inn('2936:BSHeartland.esm'));
check("...not Erlus's bed downstairs or the resident's", !/2a2f:|29ad:|29d6:/.test(rents('2936:BSHeartland.esm')));
check("Jerall View Inn rents only the basement rent bed, not the innkeepers' upstairs, as one inn", rents('1114:BSHeartland.esm') === '' && rents('6c14f:BSHeartland.esm') === '6efd1:BSHeartland.esm' && inn('6c14f:BSHeartland.esm').group === '1114:BSHeartland.esm' && inn('1114:BSHeartland.esm').group === '1114:BSHeartland.esm');
check('the Restful Watchman rents its rent room, not the room next door', rents('63121:BSHeartland.esm') === '63131:BSHeartland.esm');
check("Aleflow Inn rents the rent bed, not the innkeepers' own", rents('83a75:BSHeartland.esm') === 'b5a71:BSHeartland.esm');
check('every Bruma inn with a door pays the Bruma treasury', ['2936:BSHeartland.esm', '1114:BSHeartland.esm', '6c14f:BSHeartland.esm', '63121:BSHeartland.esm', '83a75:BSHeartland.esm'].every((d) => inn(d).hold === 'bruma' && inn(d).entrance === true && inn(d).province === 'cyrodiil'));
check('the city inns the name rule missed are in', ['1605e:Skyrim.esm', '16a0e:Skyrim.esm', '16789:Skyrim.esm', '16bdf:Skyrim.esm', '13814:Skyrim.esm'].every((d) => rents(d)));
check('inns pay the hold they stand in', inn('13a5c:Skyrim.esm').hold === 'riften' && inn('13870:Skyrim.esm').hold === 'whiterun' && inn('13a5d:Skyrim.esm').hold === 'dawnstar');
check("Skyrim inns rent the room, not the staff's beds", rents('138be:Skyrim.esm') === '1748f:Skyrim.esm' && rents('133c6:Skyrim.esm') === '5eda7:Skyrim.esm' && rents('16dfe:Skyrim.esm') === '7939f:Skyrim.esm' && rents('16789:Skyrim.esm') === '167cc:Skyrim.esm' && rents('13a7c:Skyrim.esm') === '13e41:Skyrim.esm' && rents('13a7f:Skyrim.esm') === '13d42:Skyrim.esm');
check("Frostfruit rents both beds of its rent room, not Mralki's family room", rents('13870:Skyrim.esm') === '174b0:Skyrim.esm,e0adb:Skyrim.esm');
check('cells with no bed to rent are gone', !real.inns['154ae:DragonBreak.esp'] && !real.inns['3b6b0:Gray Fox Cowl.esm'] && !real.inns['12f61e:WindhelmSSE.esp']);
check("a cell of an inn with nothing to rent is kept in the inn's group", rents('27552:Skyrim.esm') === '' && inn('27552:Skyrim.esm').group === '13a5d:Skyrim.esm');
const renting = new Set(Object.values(real.inns).filter((v) => v.rentBedRefs.length).map((v) => v.group));
check('every inn cell rents a bed or belongs to an inn that does', Object.values(real.inns).every((v) => Array.isArray(v.rentBedRefs) && (v.rentBedRefs.length > 0 || renting.has(v.group))));

globalThis.setTimeout = realSetTimeout;
process.chdir(os.tmpdir());
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${checks - failures}/${checks} passed`);
process.exit(failures ? 1 : 0);
