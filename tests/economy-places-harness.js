// The weekly property tax (server\economy.js) on a building the housing system has made a place (fork housingSystem.ts,
// housingPlaceMigration "apply"): the building is taxed once, at its root. Its other doors and its chests are in
// housing.json too, and the housing view answers the root's record for each (__dboHousing.primaryOf / recordOf), so
// before the rule each of them was taxed as a property of its own (Nate, 4 Oct: the building is the property, not what is
// inside it). A chest claimed on its own outside any building is still its own claim.
//   node tests/economy-places-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ECON = path.resolve(__dirname, '..', 'economy.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-economy-places-'));
process.chdir(dir);
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });

let now = Date.UTC(2026, 8, 26, 12, 0); // Saturday
Date.now = () => now;

// Lydia's house: its root (the front door), a back door and a chest inside, members of the place; a barrel of hers outside
const ROOT = 0x100, ROOT_OUT = 0x200, BACK = 0x101, BACK_OUT = 0x201, CHEST = 0x102, BARREL = 0x103;
fs.writeFileSync('housing.json', JSON.stringify([ROOT, BACK, CHEST, BARREL]));
const root = { owner: 11, ownerName: 'Lydia', partner: ROOT_OUT, place: { cells: ['interior'], builtAt: 1 } };
const recs = { [ROOT]: root, [BARREL]: { owner: 11, ownerName: 'Lydia', partner: 0 } };
const rootOf = { [BACK]: ROOT, [CHEST]: ROOT };
const places = { [ROOT]: ['interior', [0, 0, 0]], [ROOT_OUT]: ['tamriel', [1, 1, 0]], [BACK]: ['tamriel', [1, 2, 0]], [BACK_OUT]: ['interior', [0, 0, 0]], [CHEST]: ['interior', [0, 0, 0]], [BARREL]: ['tamriel', [2, 2, 0]] };
const props = new Map();
const get = (id, p) => (p === 'worldOrCellDesc' ? (places[id] || [])[0] : p === 'pos' ? (places[id] || [])[1] : props.get(id + '|' + p));
const set = (id, p, v) => props.set(id + '|' + p, v);
set(0x20, 'private.bankGold', 10000);
const treasuries = { 'county-bruma': 1000 };
globalThis.__dboTreasury = {
  balance: (f) => treasuries[f] || 0,
  spend: (f, n) => { if ((treasuries[f] || 0) < n) return false; treasuries[f] -= n; return true; },
  deposit: (f, n) => { treasuries[f] = (treasuries[f] || 0) + n; return true; },
};
// As the fork answers with the place rules on: a member stands for its root
const primaryOf = (r) => rootOf[r] || (recs[r] ? r : 0);
globalThis.__dboHousing = { primaryOf, recordOf: (r) => recs[primaryOf(r)] || null, isManager: () => false };
globalThis.__dboRealmTerritoryAt = (w) => (w === 'tamriel' ? { id: 'applewatch', name: 'Applewatch' } : null);
globalThis.__dboRealmOwnerOf = () => 'county-bruma';
globalThis.__dboRealmLeads = () => false;
globalThis.__dboRealmFactionsLedBy = () => [];
globalThis.__dboGuildInfo = (f) => (f === 'county-bruma' ? { id: f, name: 'County of Bruma', kind: 'hold', zone: 'bruma' } : null);
globalThis.__dboFactionNonceOk = () => true;
globalThis.__dboFactionRefresh = () => true;
fs.writeFileSync('economy.json', JSON.stringify({ rates: { 'county-bruma': 0.1 }, wages: {}, values: {}, owed: {}, overdue: {}, reports: {}, assessed: {}, balanceAfter: {} }));

const timers = new Map();
const audits = [];
require(ECON)({
  mp: { get, set, getActorsByProfileId: (pid) => (pid === 11 ? [0x20] : []) },
  log: () => {}, personal: () => {}, audit: (t) => audits.push(t), who: (a) => `P${a.toString(16)}`, cfg: { economy: { enabled: true } },
  onUi: () => {}, onlineActors: () => [], every: (n, ms, f) => timers.set(n, f),
  readOfficials: () => ({}), zoneById: () => null,
});

let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? '   ' + JSON.stringify(detail) : ''}`); if (!ok) failures++; };
timers.get('economy')();
now = Date.UTC(2026, 8, 27, 0, 1); // Sunday 00:01
timers.get('economy')();
const r = JSON.parse(fs.readFileSync('economy.json', 'utf8')).reports['county-bruma'] || {};
check('the house is taxed once (10% of the default 2,000), not once more for its back door and its chest', r.taxed === 2 && r.income === 400, r);
check("...the other tax is Lydia's barrel in the street, a claim of its own", (props.get(0x20 + '|private.bankGold') || 0) === 10000 - 400, props.get(0x20 + '|private.bankGold'));
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
