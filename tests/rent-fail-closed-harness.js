// claude-jake's review of the rents, A2-1 and A2-2 (2026-09-28, asked again 2026-09-30):
//   A2-2  bed rent (rest.js) and chest rent (business.js) are charged at exactly the price the prompt showed. The owner
//         or staff changing /business rent or re-pricing a chest while a customer's prompt is open changes nothing the
//         customer agreed to; a rented chest cannot be re-priced at all until its rent and grace have run out.
//   A2-1  a rented chest fails CLOSED: with business.enabled false, with business.js failing to load, or with its hook
//         throwing, it opens for its renter and nobody else (it used to open for anyone in all three cases).
// Loads the real rest.js and business.js together against a stub mp, in a scratch directory (both read and write
// housing.json, beds.json and businesses.json in the working directory, so never run it from the live server folder),
// and the gamemode's stand-in (businessFailClosed) out of gamemode.js itself.
//   node tests/rent-fail-closed-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const REST = path.resolve(__dirname, '..', 'rest.js');
const BUSINESS = path.resolve(__dirname, '..', 'business.js');
const GAMEMODE = path.resolve(__dirname, '..', 'gamemode.js');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-rentfc-'));
process.chdir(scratch);

// One inn (Snowstone Rest's cell, as in rest-harness.js) whose front door OWNER holds, with two beds and two chests
const CELL = 0x2936, WORLD = 0x3c, DOOR = 0x4003, OUTDOOR = 0x4006, BED = 0x7ec0f, BED2 = 0x7ec10, BED_BASE = 0x8aa9c;
const CHEST = 0x300, CHEST2 = 0x302, CHEST_BASE = 0x301, LEDGER = 0x310;
const OWNER = 0xff000001, CUST = 0xff000002, CUST2 = 0xff000003, CUST3 = 0xff000004, STRANGER = 0xff000005;
const PROFILE = { [OWNER]: 7, [CUST]: 8, [CUST2]: 9, [CUST3]: 10, [STRANGER]: 11 };
const NAME = { [OWNER]: 'Olaf', [CUST]: 'Cato', [CUST2]: 'Cyra', [CUST3]: 'Corvus', [STRANGER]: 'Stray' };
const props = new Map();
const setp = (id, k, v) => props.set(`${id >>> 0}|${k}`, v);
const desc = (id) => `${id.toString(16)}:Skyrim.esm`;
fs.writeFileSync('beds.json', JSON.stringify({
  beds: { [desc(BED_BASE)]: 'CYRLowerBedSingleR' },
  inns: { [desc(CELL)]: { name: 'Snowstone Rest', hold: 'bruma', group: desc(CELL), rentBedRefs: [], entrance: true } },
}));
fs.writeFileSync('housing.json', JSON.stringify([DOOR]));
setp(DOOR, 'private.housing', { owner: 7, ownerName: 'Olaf', partner: OUTDOOR });
setp(DOOR, 'worldOrCellDesc', desc(CELL)); setp(OUTDOOR, 'worldOrCellDesc', desc(WORLD));
for (const b of [BED, BED2]) { setp(b, 'worldOrCellDesc', desc(CELL)); setp(b, 'baseDesc', desc(BED_BASE)); }
for (const c of [CHEST, CHEST2]) { setp(c, 'worldOrCellDesc', desc(CELL)); setp(c, 'baseDesc', desc(CHEST_BASE)); }
for (const a of Object.keys(PROFILE).map(Number)) { setp(a, 'worldOrCellDesc', desc(CELL)); setp(a, 'profileId', PROFILE[a]); }
const TYPES = { [CELL]: 'CELL', [WORLD]: 'WRLD', [CHEST_BASE]: 'CONT' };
const gold = { [OWNER]: 0, [CUST]: 500, [CUST2]: 500, [CUST3]: 2000, [STRANGER]: 500 };
const treasury = {}, said = [], widgets = [], cmds = {}, ui = {}, showing = new Map();
const mp = {
  get: (id, k) => props.get(`${id >>> 0}|${k}`),
  set: setp,
  getIdFromDesc: (d) => parseInt(String(d).split(':')[0], 16),
  getDescFromId: (id) => (id >>> 0).toString(16),
  lookupEspmRecordById: (id) => (TYPES[id] ? { record: { type: TYPES[id] } } : null),
  getActorsByProfileId: (p) => Object.keys(PROFILE).filter((a) => PROFILE[a] === p).map(Number),
  callPapyrusFunction: () => null,
};
const api = {
  mp, log: () => {}, audit: () => {}, who: (a) => NAME[a], display: (a) => NAME[a],
  personal: (a, t) => said.push([a >>> 0, t]), system: (a, t) => said.push([a >>> 0, t]),
  cfg: { rest: { holdShare: 0.1 }, business: { chestRentPaused: false } },
  // The client: the widget it shows each player now, which a click answers (see click below)
  openWidget: (a, w) => { widgets.push([a >>> 0, w]); showing.set(a >>> 0, w); return true; },
  closeWidget: (a, id) => { const w = showing.get(a >>> 0); if (w && w.id === id) showing.delete(a >>> 0); return true; },
  onUi: (n, f) => { ui[n] = f; }, registerChatCommand: (n, f) => { cmds[n] = f; },
  onlineActors: () => Object.keys(PROFILE).map(Number), every: () => {}, sendPacket: () => true, userOf: (a) => a,
  profileOf: (a) => PROFILE[a] ?? -1,
  findByName: (q) => Number(Object.keys(NAME).find((a) => NAME[a].toLowerCase() === String(q).toLowerCase())) || 0,
  takeGold: (a, n) => { if (gold[a] < n) return false; gold[a] -= n; return true; },
  giveGold: (a, n) => { gold[a] += n; return true; },
  giveItem: (a, base, n) => { if (base !== 0xf || !(a in gold)) return false; gold[a] += n; return true; },
  depositToTreasury: (z, n) => { if (!z) return 0; treasury[z] = (treasury[z] || 0) + n; return n; },
  zoneOfActor: () => 'bruma', zoneById: (id) => ({ id, name: 'Bruma' }), ranksOf: () => [],
  distanceMeters: () => 1, isAdmin: () => false,
};
let fails = 0;
const ok = (c, what, detail) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${!c && detail !== undefined ? ': ' + JSON.stringify(detail) : ''}`); if (!c) fails++; };
const last = (a) => { for (let i = said.length - 1; i >= 0; i--) if (said[i][0] === (a >>> 0)) return said[i][1]; return ''; };
const lastWidget = (a) => { for (let i = widgets.length - 1; i >= 0; i--) if (widgets[i][0] === (a >>> 0)) return widgets[i][1]; return null; };
const labels = (a) => { const w = lastWidget(a); return w && w.actions ? w.actions.map((x) => x.label).join(' | ') : ''; };
// A click on the bed prompt's first button as the front sends it (contextMenu: sendMessage(events.action, action.id)),
// on whatever prompt the player is shown at that moment; nothing when none is shown
const click = (a) => { const w = showing.get(a >>> 0); if (w && w.actions && w.events) ui[w.events.action.replace(/^dbo:/, '')](a, [w.actions[0].id]); };
// A gamemode reload requires each module afresh; their state on globalThis survives it, as it does live
const loadBusiness = (business) => { delete require.cache[BUSINESS]; require(BUSINESS)(Object.assign({}, api, { cfg: Object.assign({}, api.cfg, { business }) })); };
globalThis.__dboBusiness = undefined; globalThis.__dboBusinessPass = undefined; globalThis.__dboRestPending = undefined; globalThis.__dboRestQuoted = undefined;
require(REST)(api);
loadBusiness({ chestRentPaused: false });
const K = DOOR.toString(16);
const chestRec = (c) => globalThis.__dboBusiness.data.businesses[K].chests[c.toString(16)];

cmds.business(OWNER, 'open The Snowstone');
cmds.business(OWNER, 'rent 10');
ok(globalThis.__dboBusinessRent(CELL) === 10, 'setup: the owner opens a business on the inn and sets its bed rent to 10');

// ---- A2-2: a bed is rented at the price its prompt showed -----------------------------------------------------------
globalThis.__dboRestActivate(BED, CUST);
ok(/Rent this bed: 10 gold/.test(labels(CUST)) && lastWidget(CUST).actions[0].id === 'rent:10', 'the bed prompt shows 10 gold, and its button carries it (rent:10)', lastWidget(CUST).actions);
cmds.business(OWNER, 'rent 200');
// The coordinator's review of acf20eac: a DOUBLE-click on the prompt that showed 10, after the owner re-priced to 200.
// acf20eac reopened the prompt in place at 200, so the second click landed on the new button and paid 200 unseen.
click(CUST); click(CUST);
ok(gold[CUST] === 500, 'a double-click on the prompt that showed 10, re-priced to 200 meanwhile, takes nothing (A2-2)', gold[CUST]);
ok(!props.get(`${BED}|private.dboRent`), '...and rents nothing');
ok(!showing.has(CUST) && /now 200 gold. Use the bed again/.test(last(CUST)), '...the prompt closes and says the new price; no button at 200 was ever under the cursor', [showing.get(CUST), last(CUST)]);
// Both clicks sent before the server answered the first: the second carries the old button's price too
ui.restChoose(CUST, ['rent:10']);
ok(gold[CUST] === 500, '...and a second click already on its way (rent:10) takes nothing either', gold[CUST]);
// A forged button cannot underpay: the id must name the bed's rent
globalThis.__dboRestActivate(BED, CUST);
ui.restChoose(CUST, ['rent:1']);
ok(gold[CUST] === 500 && !props.get(`${BED}|private.dboRent`), 'a click naming a price the bed does not rent for takes nothing', gold[CUST]);
globalThis.__dboRestActivate(BED, CUST);
ok(/Rent this bed: 200 gold/.test(labels(CUST)), 'using the bed again shows 200', labels(CUST));
click(CUST);
ok(gold[CUST] === 300 && props.get(`${BED}|private.dboRent`).renter === CUST, 'Rent on the prompt that showed 200 takes exactly 200', gold[CUST]);
ok(/You rent the bed for 200 gold/.test(last(CUST)), '...and says what was paid', last(CUST));
// A cheaper rent is not charged silently either: the customer sees the price they pay
globalThis.__dboRestActivate(BED2, CUST2);
cmds.business(OWNER, 'rent 5');
click(CUST2);
ok(gold[CUST2] === 500 && !showing.has(CUST2), 'a rent lowered while the prompt is open is not taken either: the prompt closes', gold[CUST2]);
// A prompt opened before this change was deployed holds the bed and no price (its button says a bare 'rent')
globalThis.__dboRestPending.set(CUST2, BED2); if (globalThis.__dboRestQuoted) globalThis.__dboRestQuoted.delete(CUST2);
ui.restChoose(CUST2, ['rent']);
ok(gold[CUST2] === 500 && !props.get(`${BED2}|private.dboRent`), 'a prompt with no price on record takes nothing', gold[CUST2]);
globalThis.__dboRestActivate(BED2, CUST2);
click(CUST2);
ok(gold[CUST2] === 495, '...the prompt opened again shows 5, and Rent takes the 5 it showed', gold[CUST2]);

// ---- A2-2: a chest is rented at the price its menu showed -----------------------------------------------------------
cmds.business(OWNER, 'chest 1');
globalThis.__dboBusinessActivate(CHEST, OWNER);
ok(chestRec(CHEST) && chestRec(CHEST).price === 1, 'setup: the owner lists a chest at 1 gold a day');
ok(globalThis.__dboBusinessActivate(CHEST, CUST3) === true && /Rent 7 days: 7 gold/.test(labels(CUST3)), 'the customer is shown 7 gold for 7 days', labels(CUST3));
cmds.business(OWNER, 'chest 200');
globalThis.__dboBusinessActivate(CHEST, OWNER);
ui.bizChoose(CUST3, ['rent7']);
ok(gold[CUST3] === 2000, 'the chest re-priced to 200 a day while the menu is open: the click takes nothing, not 1400 (A2-2)', gold[CUST3]);
ok(!chestRec(CHEST).renter && /price has changed to 200/.test(last(CUST3)), '...rents nothing and says the price changed', last(CUST3));
globalThis.__dboBusinessActivate(CHEST, CUST3);
ok(/Rent 1 day: 200 gold/.test(labels(CUST3)), '...using the chest again shows the new price', labels(CUST3));
ui.bizChoose(CUST3, ['rent1']);
ok(gold[CUST3] === 1800 && chestRec(CHEST).renter === 10, 'renting at the price shown takes exactly 200', gold[CUST3]);
ok(/You pay 200 gold/.test(last(CUST3)), '...and the reply says what was paid', last(CUST3));
cmds.business(OWNER, 'chest 5');
globalThis.__dboBusinessActivate(CHEST, OWNER);
ok(chestRec(CHEST).price === 200 && /It is rented/.test(last(OWNER)), 'a rented chest cannot be re-priced (A2-2)', [chestRec(CHEST).price, last(OWNER)]);
// A menu opened before this change was deployed holds the bare chest id: it cannot pay
cmds.business(OWNER, 'chest 3');
globalThis.__dboBusinessActivate(CHEST2, OWNER);
globalThis.__dboBusiness.pending.set(STRANGER, CHEST2);
ui.bizChoose(STRANGER, ['rent1']);
ok(gold[STRANGER] === 500 && !chestRec(CHEST2).renter, 'a chest menu with no price on record takes nothing', gold[STRANGER]);

// ---- A2-1: business.enabled false keeps a rented chest its renter's ------------------------------------------------
// A menu open when the ledgers are switched off must not rent either
ok(globalThis.__dboBusinessActivate(CHEST2, STRANGER) === true && /Rent 1 day: 3 gold/.test(labels(STRANGER)), 'setup: a customer has the menu of a free chest open');
setp(LEDGER, 'private.dboBizLedger', { claim: K });
loadBusiness({ chestRentPaused: false, enabled: false });
ui.bizChoose(STRANGER, ['rent1']);
ok(gold[STRANGER] === 500 && !chestRec(CHEST2).renter, 'with the ledgers switched off, a menu opened before rents nothing', gold[STRANGER]);
ok(globalThis.__dboBusinessActivate(CHEST, STRANGER) === true, 'ledgers off: a stranger cannot open the rented chest (A2-1, fail closed)');
ok(globalThis.__dboBusinessActivate(CHEST, OWNER) === true, '...nor can the business owner');
ok(globalThis.__dboBusinessActivate(CHEST, CUST) === true, '...nor another customer');
ok(globalThis.__dboBusinessActivate(CHEST, CUST3) === false, '...its renter opens it');
chestRec(CHEST).until = Date.now() - 3600000;
ok(globalThis.__dboBusinessActivate(CHEST, STRANGER) === true && globalThis.__dboBusinessActivate(CHEST, CUST3) === false, '...and in the grace period: still the renter alone');
ok(globalThis.__dboBusinessActivate(CHEST2, STRANGER) === true && globalThis.__dboBusinessActivate(CHEST2, OWNER) === false, "ledgers off: the business's own free chest opens for its owner, not for customers");
ok(globalThis.__dboBusinessActivate(LEDGER, STRANGER) === true && /closed/.test(last(STRANGER)), 'ledgers off: the ledger book stays shut (and on its counter)', last(STRANGER));
loadBusiness({ chestRentPaused: false });
ok(globalThis.__dboBusinessActivate(CHEST, STRANGER) === true && globalThis.__dboBusinessActivate(CHEST, CUST3) === true && /rent ran out/.test(labels(CUST3) + ' ' + (lastWidget(CUST3) || {}).targetName), 'ledgers on again: the renter is offered to pay or empty it, as before');

// ---- A2-1: business.js failing to load, or its hook throwing ---------------------------------------------------------
const gm = fs.readFileSync(GAMEMODE, 'utf8');
const i = gm.indexOf('function businessFailClosed('), j = i >= 0 ? gm.indexOf('\n}\n', i) : -1;
ok(i >= 0 && j > i, 'gamemode.js has a stand-in for business.js (businessFailClosed)');
ok(/business\.js failed to load:[^\n]*globalThis\.__dboBusinessActivate = businessFailClosed;/.test(gm), 'a failed load of business.js installs the stand-in, not null (A2-1)');
ok(/try \{ refused = globalThis\.__dboBusinessActivate\(targetId >>> 0, casterId >>> 0\); \} catch \(e\) \{[^\n]*refused = businessFailClosed\(targetId, casterId\); \}\s*\n\s*if \(refused\) return false;/.test(gm), 'a hook that throws falls back to the stand-in (the engine takes a throw as allowed)');
ok(/\['business', typeof globalThis\.__dboBusinessActivate === 'function' && !globalThis\.__dboBusinessActivate\.failClosed\]/.test(gm), '/selftest reports business as not wired while the stand-in holds');
if (i >= 0 && j > i) {
  const HOUR = 3600000, now = Date.now();
  const grace = { chestGraceHours: 72 };
  const told = [];
  const make = () => new Function('mp', 'personal', 'profileOf', 'cfg', 'fs', 'path', 'log', `${gm.slice(i, j + 2)}\nreturn businessFailClosed;`)(
    mp, (a, t) => told.push(t), (a) => PROFILE[a] ?? -1, { business: grace }, fs, path, () => {});
  const fc = make();
  const records = { businesses: { [K]: { name: 'The Snowstone', owner: 7, chests: {
    [CHEST.toString(16)]: { price: 5, renter: 10, renterName: 'Corvus', until: now + 48 * HOUR },
    [CHEST2.toString(16)]: { price: 3 },
  } } } };
  // business.js never loaded in this process: the records come from businesses.json
  globalThis.__dboBusiness = undefined;
  fs.writeFileSync('businesses.json', JSON.stringify(records));
  ok(fc(CHEST, STRANGER) === true && /rented to someone else/.test(told[told.length - 1] || ''), 'business.js down: a stranger cannot open the rented chest (read from businesses.json)', told);
  ok(fc(CHEST, OWNER) === true, '...nor the business owner');
  ok(fc(CHEST, CUST3) === false, '...its renter opens it');
  ok(fc(CHEST2, OWNER) === true && fc(CHEST2, STRANGER) === true, "...the business's free chest stays shut to everyone until business.js is back");
  ok(fc(0x999, STRANGER) === false, '...a container no business lists is left alone');
  ok(fc(LEDGER, STRANGER) === true, '...the ledger book stays shut');
  records.businesses[K].chests[CHEST.toString(16)].until = now - 70 * HOUR;
  fs.writeFileSync('businesses.json', JSON.stringify(records));
  ok(fc(CHEST, CUST3) === false && fc(CHEST, STRANGER) === true, '...in the grace period, still the renter alone');
  records.businesses[K].chests[CHEST.toString(16)].until = now - 73 * HOUR;
  fs.writeFileSync('businesses.json', JSON.stringify(records));
  ok(fc(CHEST, CUST3) === true && fc(CHEST, STRANGER) === true, '...once rent and grace have run out, it waits for business.js (shut to all)');
  // business.js loaded before and failed on a later reload: its copy in memory is the newer truth
  globalThis.__dboBusiness = { data: { businesses: { [K]: { chests: { [CHEST.toString(16)]: { price: 5, renter: 11, until: now + HOUR } } } } } };
  ok(fc(CHEST, STRANGER) === false && fc(CHEST, CUST3) === true, "...business.js's copy in memory comes before the file");
  // Two door claims in one inn are two businesses, and both can list the chest (the reviewer's finding 1): every record counts
  const two = (r1, r2) => { globalThis.__dboBusiness = { data: { businesses: { a: { chests: { [CHEST.toString(16)]: r1 } }, b: { chests: { [CHEST.toString(16)]: r2 } } } } }; };
  two({ price: 5 }, { price: 5, renter: 10, until: now + HOUR });
  ok(fc(CHEST, CUST3) === false && fc(CHEST, STRANGER) === true, '...a chest two businesses list is held by the one that rents it out');
  two({ price: 5, renter: 11, until: now + HOUR }, { price: 5, renter: 10, until: now + HOUR });
  ok(fc(CHEST, CUST3) === true && fc(CHEST, STRANGER) === true, '...and rented under both to two people, it opens for neither');
} else {
  ok(false, 'the stand-in could not be exercised (not found in gamemode.js)');
}

// ---- A2-1: any hook in the gamemode's activate chain throwing ----------------------------------------------------------
// The real chain out of gamemode.js, run in a sandbox. engine() answers as ScampServerListener.cpp does: a handler that
// throws, or returns nothing, allows the activation. Before this branch a throw in any hook let the activation through.
{
  const vm = require('vm');
  const HOUR = 3600000, now = Date.now();
  // From the throw helpers (when there are any) through the chain and its wrapper, to the door trace
  const chainAt = gm.indexOf('\nmp.onActivate = (targetId, casterId) => {\n  const caster'), helpersAt = gm.indexOf('\nconst activateThrowLogAt = ');
  const from = helpersAt >= 0 && helpersAt < chainAt ? helpersAt : chainAt;
  const to = gm.indexOf('// TEMPORARY door trace', from);
  ok(from >= 0 && to > from, "the gamemode's activate chain is found in gamemode.js");
  const logs = [], told = [];
  const sb = {
    mp: { get: () => undefined, set: () => {} }, cfg: { business: { chestGraceHours: 72 } }, fs, path, Date,
    log: (...x) => logs.push(x.join(' ')), personal: (a, t) => told.push([a >>> 0, t]), system: () => {},
    profileOf: (a) => PROFILE[a] ?? -1, lastPickupDeny: new Map(), treasuryRefused: () => false, distanceMeters: () => 1,
    blockPlacedPickup: () => false, gateOf: () => null, TAMRIEL: '3c',
  };
  sb.globalThis = sb;
  const fcSrc = i >= 0 && j > i ? gm.slice(i, j + 2) : 'function businessFailClosed() { return false; }';
  vm.runInNewContext(`${fcSrc}\n${gm.slice(from, to)}`, sb);
  const engine = (t, c) => { try { const v = sb.mp.onActivate(t, c); return v === undefined ? true : !!v; } catch (e) { return true; } };
  const saidTo = (a) => { for (let k = told.length - 1; k >= 0; k--) if (told[k][0] === (a >>> 0)) return told[k][1]; return ''; };
  const DOORX = 0x5000, boom = () => { throw new Error('a hook bug'); };
  sb.__dboBusiness = { data: { businesses: { [K]: { chests: { [CHEST.toString(16)]: { price: 5, renter: 10, until: now + 48 * HOUR } } } } } };
  sb.__dboPrevActivate = () => true;
  sb.__dboBusinessActivate = fcSrc.startsWith('function businessFailClosed(') ? sb.businessFailClosed : () => false;
  ok(engine(DOORX, STRANGER) === true && engine(CHEST, CUST3) === true, 'with no hook throwing, a door opens and the renter opens the chest');
  ok(engine(CHEST, STRANGER) === false, '...and a stranger is kept out of the rented chest');
  // A hook AHEAD of the business hook throws (raids.js here; any of them)
  sb.__dboRaidActivate = boom;
  ok(engine(CHEST, STRANGER) === false && /rented to someone else/.test(saidTo(STRANGER)), 'a hook ahead of business.js throws: a stranger is still kept out of the rented chest (A2-1)', saidTo(STRANGER));
  ok(engine(CHEST, OWNER) === false, '...and so is the business owner');
  ok(engine(CHEST, CUST3) === false && /went wrong/.test(saidTo(CUST3)), '...its renter is refused too and told to try again: the gates before the chest did not finish', saidTo(CUST3));
  ok(engine(DOORX, CUST) === false && /went wrong/.test(saidTo(CUST)), '...anything else is refused while a hook throws (fail closed), and the player told', saidTo(CUST));
  ok(logs.filter((l) => /the gamemode chain threw/.test(l)).length === 1, '...and it is logged, once per 10 s, not once per E', logs);
  sb.__dboRaidActivate = null;
  // A hook AFTER the business hook throws (the dungeon lease gate here)
  sb.__dboDungeonActivate = boom;
  ok(engine(DOORX, CUST) === false && engine(CHEST, STRANGER) === false, 'a hook after business.js throws: refused as well');
  sb.__dboDungeonActivate = null;
  // The business hook itself throws: the stand-in decides there and the chain goes on
  sb.__dboBusinessActivate = boom;
  ok(engine(CHEST, STRANGER) === false && engine(CHEST, CUST3) === true, 'business.js itself throws: its stand-in keeps the stranger out and lets the renter through the rest of the chain');
  sb.__dboBusinessActivate = null;
  // The fork systems' chain (housing locks, mastery) throwing is theirs to decide: allowed as before, now logged
  sb.__dboPrevActivate = boom;
  ok(engine(DOORX, CUST) === true && logs.some((l) => /the systems chain threw/.test(l)), "the fork systems' chain throwing keeps the fork's own rule (allowed) and is logged", logs);
}

console.log(fails ? `${fails} FAILED` : 'all checks passed');
fs.rmSync(scratch, { recursive: true, force: true });
process.exit(fails ? 1 : 0);
