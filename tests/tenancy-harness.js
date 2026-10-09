// Scripted test for server\tenancy.js (renting property out at its door). No server and no game: run it from this
// folder's parent with
//
//   node tests\tenancy-harness.js
//
// It loads the module in a scratch folder against a mock housing system, doors, gold and treasury.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const MODULE = path.resolve(__dirname, '..', 'tenancy.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-tenancy-'));
const home = process.cwd();
process.chdir(dir);
let now = 1790000000000;
const realNow = Date.now;
Date.now = () => now;

const DOOR = 0x5000, FAR_DOOR = 0x5001;
fs.writeFileSync('doors.json', JSON.stringify({ doors: { '5000:Skyrim.esm': 'A house', '5001:Skyrim.esm': 'Somewhere else', '5002:Skyrim.esm': 'Newer than the file', '5003:Skyrim.esm': 'Disabled' } }));
// The places tenancy.js reads instead of loading each door (tools/door-positions.py); no door is ever asked of the engine
fs.writeFileSync('doors-pos.json', JSON.stringify({ doors: { '5000:Skyrim.esm': [0, 0, 0, 'Bruma'], '5001:Skyrim.esm': [9000, 0, 0, 'bruma'], 'bad:Skyrim.esm': [1, 2] }, off: ['5003:Skyrim.esm'] }));
const engineCalls = { doorGet: {}, ids: [] };
// The background fallback runs on timers; they are held here and run on demand
const timers = [];
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms) => { timers.push([fn, ms]); return 0; };
const STEWARD = 1, RENTER = 2, OTHER = 3;
const chars = {
  [STEWARD]: { profile: 10, tag: 'STEW', name: 'Steward', gold: 0, pos: [0, 0, 0] },
  [RENTER]: { profile: 20, tag: 'RENT', name: 'Renter', gold: 1000, pos: [100, 0, 0] },
  [OTHER]: { profile: 30, tag: 'OTHR', name: 'Other', gold: 1000, pos: [50, 0, 0] },
};
const refs = { [DOOR]: { pos: [0, 0, 0], where: 'bruma' }, [FAR_DOOR]: { pos: [9000, 0, 0], where: 'bruma' }, 0x5002: { pos: [0, 0, 0], where: 'Elsewhere' }, 0x5003: { pos: [0, 0, 0], where: 'bruma' } };
const houses = { [DOOR]: { owner: 0, ownerName: '' } };
const treasury = {};
const said = [];
let online = [STEWARD, RENTER, OTHER];
globalThis.__dboHousing = {
  primaryOf: (r) => (houses[r] ? r : 0),
  recordOf: (r) => houses[r] || null,
  holdOf: () => 'bruma',
  isManager: (a) => a === STEWARD,
  grant: (r, a) => { houses[r].owner = chars[a].profile; houses[r].ownerName = chars[a].name; return ''; },
  release: (r) => { houses[r].owner = 0; houses[r].ownerName = ''; return true; },
};
const commands = {};
let tick = null;
require(MODULE)({
  mp: {
    getIdFromDesc: (d) => { engineCalls.ids.push(d); return parseInt(d, 16); },
    get: (id, k) => {
      if (refs[id]) engineCalls.doorGet[id.toString(16)] = (engineCalls.doorGet[id.toString(16)] || 0) + 1;
      if (chars[id]) return k === 'pos' ? chars[id].pos : k === 'worldOrCellDesc' ? 'bruma' : undefined;
      if (refs[id]) return k === 'pos' ? refs[id].pos : k === 'worldOrCellDesc' ? refs[id].where : undefined;
      return undefined;
    },
  },
  log: () => {}, personal: (a, t) => said.push([a, t]), audit: () => {}, who: (a) => chars[a].name, display: (a) => chars[a].name,
  tagOf: (a) => chars[a].tag, profileOf: (a) => chars[a].profile, onlineActors: () => online, every: (n, ms, fn) => { tick = fn; },
  registerChatCommand: (n, fn) => { commands[n] = fn; }, cfg: {},
  takeGold: (a, n) => { if (chars[a].gold < n) return false; chars[a].gold -= n; return true; },
  giveGold: (a, n) => { chars[a].gold += n; return true; },
  depositToTreasury: (z, n) => { treasury[z] = (treasury[z] || 0) + n; return n; },
  zoneById: (id) => ({ id, name: 'Bruma' }),
});

let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + detail : ''}`); if (!ok) failures++; };
const run = (a, args) => { said.length = 0; commands.property(a, args); return said.filter((x) => x[0] === a).map((x) => x[1]).join(' | '); };

chars[OTHER].pos = [5000, 0, 0];
check('away from any door you are told to go to it', /Stand at the door/.test(run(OTHER, '')));
chars[OTHER].pos = [50, 0, 0];
check('an empty house is not for rent', /stands empty and is not for rent/.test(run(OTHER, '')));
check('a player cannot list it', /Only the officials/.test(run(RENTER, 'list 100 20')));
let r = run(STEWARD, 'list 100 20');
check('the steward lists it', /Listed for rent: 100 gold deposit and 20/.test(r), r);
check('players see the terms', /100 gold deposit and 20 gold a week/.test(run(RENTER, '')));
r = run(RENTER, 'interest');
check('interest is recorded and the steward is told', /Your name is down/.test(r) && said.some(([a, t]) => a === STEWARD && /asked to rent/.test(t)));
run(OTHER, 'interest');
check('someone with no offer cannot accept', /Nobody has offered you/.test(run(OTHER, 'accept')));
check('an offer names someone who asked', /Offer it to someone who asked/.test(run(STEWARD, 'offer Nobody')));
r = run(STEWARD, 'offer Renter');
check('the steward offers it', /Offered to Renter/.test(r) && said.some(([a, t]) => a === RENTER && /You are offered a property/.test(t)));
r = run(RENTER, 'accept');
check('accepting takes deposit and a week, and grants the house', /It is yours to live in/.test(r) && chars[RENTER].gold === 880 && houses[DOOR].owner === 20 && treasury.bruma === 20, r);
check('the rest of the interest list is cleared', /Let to Renter/.test(run(OTHER, '')));

r = run(RENTER, 'pay 2');
check('rent is paid at the door into the treasury', /Paid 40 gold/.test(r) && treasury.bruma === 60 && chars[RENTER].gold === 840, r);
check('a paid-up tenant cannot be evicted', /Only a tenant behind on rent/.test(run(STEWARD, 'evict')));

now += 4 * 7 * 86400000;
said.length = 0; tick();
check('rent falls due and both sides are told', said.some(([a, t]) => a === RENTER && /overdue/.test(t)) && said.some(([a, t]) => a === STEWARD && /overdue/.test(t)));
check('an overdue tenant cannot walk off with the deposit', /overdue. Pay it/.test(run(RENTER, 'leave')));
r = run(STEWARD, 'grace');
check("a week's grace clears it", /a week's grace/.test(r) && !/OVERDUE/.test((() => { said.length = 0; commands.properties(STEWARD); return said.map((x) => x[1]).join(' '); })()));
now += 8 * 86400000;
tick();
online = [STEWARD, OTHER];
r = run(STEWARD, 'evict');
check('an overdue tenant can be evicted: house back, deposit to the hold', /evicted/.test(r) && houses[DOOR].owner === 0 && treasury.bruma === 160, `${r} ${treasury.bruma}`);

// a clean departure returns the deposit, even to someone offline
online = [STEWARD, RENTER, OTHER];
run(RENTER, 'interest'); run(STEWARD, 'offer Renter'); run(RENTER, 'accept');
const before = chars[RENTER].gold;
r = run(RENTER, 'leave');
check('leaving in good standing returns the deposit', /hand back the keys/.test(r) && chars[RENTER].gold === before + 100 && houses[DOOR].owner === 0, r);
// a tenant who hands the house on and then leaves does not take it back from the new owner (economy review, 2026-09-29)
run(RENTER, 'interest'); run(STEWARD, 'offer Renter'); run(RENTER, 'accept');
check('housing is told the house is rented, so it refuses to hand it on', globalThis.__dboTenancyRented(DOOR) === true && globalThis.__dboTenancyRented(FAR_DOOR) === false);
houses[DOOR].owner = chars[OTHER].profile; houses[DOOR].ownerName = 'Other';   // housing transfer to Other
const beforeSale = chars[RENTER].gold;
r = run(RENTER, 'leave');
check('a tenant who handed the house on cannot take it back from its new owner', houses[DOOR].owner === chars[OTHER].profile, r);
check('...nor get the deposit back for it', chars[RENTER].gold === beforeSale, chars[RENTER].gold - beforeSale);
// a listing that outlived a change of owner does not seize the house
run(RENTER, 'interest'); run(STEWARD, 'offer Renter');
r = run(RENTER, 'accept');
check('an offer on a house someone owns now cannot be accepted', /has an owner now/.test(r) && houses[DOOR].owner === chars[OTHER].profile, r);
houses[DOOR].owner = 0; houses[DOOR].ownerName = '';
check('once the tenancy ends housing may hand the house on again', globalThis.__dboTenancyRented(DOOR) === false);
check('the steward can take it off the market', /Taken off the market/.test(run(STEWARD, 'unlist')));

// The 3.5-minute freeze (5-9 Oct): the doors come from doors-pos.json, never from the engine
const T = globalThis.__dboTenancy;
check('no door in the file is loaded through the engine, nor one listed off', !engineCalls.doorGet['5000'] && !engineCalls.doorGet['5001'] && !engineCalls.doorGet['5003'], JSON.stringify(engineCalls.doorGet));
check('a malformed entry is skipped and the world is compared in lower case', T.doors.filter((d) => d.desc !== '5002:Skyrim.esm').length === 2 && T.doors[0].where === 'bruma');
check('a door missing from the file waits for a timer instead of loading at once', timers.length === 1 && timers[0][1] === 250 && !T.doors.some((d) => d.desc === '5002:Skyrim.esm'), timers.length);
while (timers.length) timers.shift()[0]();
check('...then resolves in the background, with its world in lower case', T.doors.some((d) => d.desc === '5002:Skyrim.esm' && d.where === 'elsewhere' && d.id === 0x5002) && engineCalls.doorGet['5002'] === 2, JSON.stringify(engineCalls.doorGet));
check('only the door found and the background one are resolved to ids', JSON.stringify(engineCalls.ids.sort()) === JSON.stringify(['5000:Skyrim.esm', '5002:Skyrim.esm']), JSON.stringify(engineCalls.ids));
// A missing file places no door and refuses politely, with no engine call
delete globalThis.__dboTenancy;
fs.rmSync('doors-pos.json');
require(MODULE)({ mp: { getIdFromDesc: () => { throw new Error('engine called'); }, get: (id, k) => (chars[id] ? (k === 'pos' ? chars[id].pos : 'bruma') : (() => { throw new Error('engine called'); })()) },
  log: () => {}, personal: (a, t) => said.push([a, t]), audit: () => {}, who: (a) => chars[a].name, display: (a) => chars[a].name,
  tagOf: (a) => chars[a].tag, profileOf: (a) => chars[a].profile, onlineActors: () => online, every: () => {},
  registerChatCommand: (n, fn) => { commands[n] = fn; }, cfg: {}, takeGold: () => false, giveGold: () => false, depositToTreasury: () => 0, zoneById: (id) => ({ id }) });
check('without doors-pos.json no door is found and nothing is loaded', /Stand at the door/.test(run(OTHER, '')));

// The shipped file: every enabled doors.json door, in the form the server reports a world or cell
const shipped = JSON.parse(fs.readFileSync(path.join(home, 'doors-pos.json'), 'utf8')).doors;
const listed = Object.keys(JSON.parse(fs.readFileSync(path.join(home, 'doors.json'), 'utf8')).doors);
const keys = Object.keys(shipped);
check('doors-pos.json places the 3911 doors the live server placed (4049 less 138 initially disabled)', keys.length === 3911, keys.length);
check('...each one a doors.json door', keys.every((k) => listed.includes(k)));
const offList = JSON.parse(fs.readFileSync(path.join(home, 'doors-pos.json'), 'utf8')).off || [];
check('...and the 138 disabled ones listed off, so the background fallback loads nothing on the live server', offList.length === 138 && listed.every((k) => shipped[k] || offList.includes(k)), offList.length);
check('...each a position and a lower-case <hex>:<plugin> world or cell', keys.every((k) => { const p = shipped[k]; return p.length === 4 && p.slice(0, 3).every(Number.isFinite) && /^[0-9a-f]+:[^A-Z]+\.es[mpl]$/.test(p[3]); }));
check('...Beasts Maw\'s door stands in BS Heartland, the world players there report', shipped['8aeef:BSHeartland.esm'] && shipped['8aeef:BSHeartland.esm'][3] === 'a764b:bsheartland.esm');

globalThis.setTimeout = realSetTimeout;
process.chdir(home);
fs.rmSync(dir, { recursive: true, force: true });
Date.now = realNow;
delete globalThis.__dboHousing;
console.log('');
console.log(failures ? `${failures} FAILURES` : 'all checks passed');
process.exit(failures ? 1 : 0);
