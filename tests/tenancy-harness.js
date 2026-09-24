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
fs.writeFileSync('doors.json', JSON.stringify({ doors: { '5000:Skyrim.esm': 'A house', '5001:Skyrim.esm': 'Somewhere else' } }));
const STEWARD = 1, RENTER = 2, OTHER = 3;
const chars = {
  [STEWARD]: { profile: 10, tag: 'STEW', name: 'Steward', gold: 0, pos: [0, 0, 0] },
  [RENTER]: { profile: 20, tag: 'RENT', name: 'Renter', gold: 1000, pos: [100, 0, 0] },
  [OTHER]: { profile: 30, tag: 'OTHR', name: 'Other', gold: 1000, pos: [50, 0, 0] },
};
const refs = { [DOOR]: { pos: [0, 0, 0], where: 'bruma' }, [FAR_DOOR]: { pos: [9000, 0, 0], where: 'bruma' } };
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
    getIdFromDesc: (d) => parseInt(d, 16),
    get: (id, k) => {
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
check('the steward can take it off the market', /Taken off the market/.test(run(STEWARD, 'unlist')));

process.chdir(home);
fs.rmSync(dir, { recursive: true, force: true });
Date.now = realNow;
delete globalThis.__dboHousing;
console.log('');
console.log(failures ? `${failures} FAILURES` : 'all checks passed');
process.exit(failures ? 1 : 0);
