// The weekly property tax (server\economy.js) is taken once per building (Nate, 4 Oct: the building is the property, not
// its doors or what is inside it). Two ways a building shows in housing.json:
// - today (housingPlaceMigration dryrun): one owner's claims into the same interior, each its own record, e.g. Kojus'
//   six door pairs into Fort Caractacus, billed six times on 4 Oct. They are one building, taxed by its assessed claim,
//   else its lowest, and the others' overdue entries go;
// - with the place rules on: a place's members answer the root's record (__dboHousing.primaryOf / recordOf), and are
//   skipped.
// A barrel claimed on its own in the street is still a claim of its own.
//   node tests/economy-places-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ECON = path.resolve(__dirname, '..', 'economy.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-economy-places-'));
process.chdir(dir);
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });

let now = Date.UTC(2026, 8, 26, 12, 0);
Date.now = () => now;
let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? '   ' + JSON.stringify(detail) : ''}`); if (!ok) failures++; };

const FORT = 'b5936:BSHeartland.esm', STREET = 'a764b:BSHeartland.esm';
const descToId = (d) => parseInt(String(d).split(':')[0], 16) >>> 0;
// One week's reckoning over these claims; returns the county's report, Lydia's bank and the overdue table after it
const reckonOnce = ({ registry, recs, cells, primaryOf, values, overdue, bank, isBuilding }) => {
  delete globalThis.__dboEconomy;
  fs.writeFileSync('housing.json', JSON.stringify(registry));
  fs.writeFileSync('economy.json', JSON.stringify({ rates: { 'county-bruma': 0.1 }, wages: {}, values: values || {}, owed: {}, overdue: overdue || {}, reports: {}, assessed: {}, balanceAfter: {} }));
  const props = new Map([[`${0x20}|private.bankGold`, bank]]);
  const mp = {
    get: (id, p) => (p === 'worldOrCellDesc' ? cells[id] : p === 'pos' ? [1, 1, 0] : props.get(id + '|' + p)),
    set: (id, p, v) => props.set(id + '|' + p, v),
    getIdFromDesc: descToId,
    lookupEspmRecordById: (id) => ({ record: { type: id === descToId(STREET) ? 'WRLD' : 'CELL' } }),
    getActorsByProfileId: (pid) => (pid === 60 ? [0x20] : []),
  };
  const P = primaryOf || ((r) => (recs[r] ? r : 0));
  globalThis.__dboHousing = { primaryOf: P, recordOf: (r) => recs[P(r)] || null, isManager: () => false, ...(isBuilding ? { isBuilding } : {}) };
  globalThis.__dboTreasury = { balance: () => 1000, spend: () => true, deposit: () => true };
  globalThis.__dboRealmTerritoryAt = (w) => (w === STREET ? { id: 'applewatch', name: 'Applewatch' } : null);
  globalThis.__dboRealmOwnerOf = () => 'county-bruma';
  globalThis.__dboRealmLeads = () => false;
  globalThis.__dboRealmFactionsLedBy = () => [];
  globalThis.__dboGuildInfo = (f) => (f === 'county-bruma' ? { id: f, name: 'County of Bruma', kind: 'hold', zone: 'bruma' } : null);
  const timers = new Map();
  now = Date.UTC(2026, 8, 26, 12, 0);
  delete require.cache[ECON];
  require(ECON)({
    mp, log: () => {}, personal: () => {}, audit: () => {}, who: (a) => `P${a.toString(16)}`, cfg: { economy: { enabled: true } },
    onUi: () => {}, onlineActors: () => [], every: (n, ms, f) => timers.set(n, f), readOfficials: () => ({}), zoneById: () => null,
  });
  timers.get('economy')();
  now = Date.UTC(2026, 8, 27, 0, 1);
  timers.get('economy')();
  const d = JSON.parse(fs.readFileSync('economy.json', 'utf8'));
  return { r: d.reports['county-bruma'] || {}, bank: props.get(`${0x20}|private.bankGold`), overdue: d.overdue };
};
const rec = (o) => Object.assign({ owner: 60, ownerName: 'Kojus Animus', name: null, partner: 0 }, o);

// Today: Fort Caractacus as live holds it, the root door inside the fort and two of its door pairs from the street, a chest
// inside; and Kojus' barrel in the street
const ROOT = 0x80b5c6e, ROOT_OUT = 0x80b5fe6, D1 = 0x80b5eac, D1_IN = 0x80b5eae, D2 = 0x80b5f55, D2_OUT = 0x80b5fea, CHEST = 0x80b5c86, BARREL = 0x805c0d7;
const cells = { [ROOT]: FORT, [ROOT_OUT]: STREET, [D1]: STREET, [D1_IN]: FORT, [D2]: FORT, [D2_OUT]: STREET, [CHEST]: FORT, [BARREL]: STREET };
const fort = { [ROOT]: rec({ name: 'Fort Caractacus', partner: ROOT_OUT }), [D1]: rec({ partner: D1_IN }), [D2]: rec({ partner: D2_OUT }), [CHEST]: rec({}), [BARREL]: rec({}) };
const registry = [D2, CHEST, BARREL, D1, ROOT];
let o = reckonOnce({ registry, recs: fort, cells, bank: 10000 });
// A chest or an inner door is no property (Nate, 5 Oct): with the housing view's isBuilding, the barrel pays nothing
const buildingsOnly = (r) => r !== BARREL && r !== CHEST;
const ob = reckonOnce({ registry, recs: fort, cells, bank: 10000, isBuilding: buildingsOnly, overdue: { [String(BARREL)]: { weeks: 1, gold: 5 } } });
check('a claimed chest or barrel pays no tax: only the fort is taxed', ob.r.taxed === 1 && ob.bank === 9800, ob.r);
check("...and the barrel's old overdue entry is gone", !ob.overdue[String(BARREL)], ob.overdue);
check('today: the fort is taxed once (10% of 2,000), not once for each door pair; the barrel is its own claim', o.r.taxed === 2 && o.r.income === 400 && o.bank === 9600, o.r);
// Kojus cannot pay: one overdue entry for the fort, last week's per-door entries gone
o = reckonOnce({ registry, recs: fort, cells, bank: 0, overdue: { [String(ROOT)]: { weeks: 1, gold: 200 }, [String(D1)]: { weeks: 1, gold: 200 }, [String(D2)]: { weeks: 1, gold: 200 } } });
check('...overdue, the fort is one entry (its lowest claim, the named root) and the barrel the other', o.r.overdue.length === 2 && o.r.overdue.some((x) => x.ref === ROOT.toString(16)) && o.r.overdue.some((x) => x.ref === BARREL.toString(16)), o.r.overdue);
check("...and the doors' own overdue entries from last week are gone", !o.overdue[String(D1)] && !o.overdue[String(D2)] && o.overdue[String(ROOT)].weeks === 2, o.overdue);
// An official assessed a door rather than the root: that value is the building's
o = reckonOnce({ registry, recs: fort, cells, bank: 10000, values: { [String(D1)]: 5000 } });
check("an assessed door carries the building's value: 500 for the fort, 200 for the barrel", o.r.taxed === 2 && o.r.income === 700, o.r);

// With the place rules on: the members answer the root
const placed = { [ROOT]: rec({ name: 'Fort Caractacus', partner: ROOT_OUT, place: { cells: [FORT], builtAt: 1 } }), [BARREL]: rec({}) };
const rootOf = { [D1]: ROOT, [D2]: ROOT, [CHEST]: ROOT };
o = reckonOnce({ registry, recs: placed, cells, bank: 10000, primaryOf: (r) => rootOf[r] || (placed[r] ? r : 0) });
check('a place: taxed once at its root, its members skipped; the barrel taxed as its own claim', o.r.taxed === 2 && o.r.income === 400 && o.bank === 9600, o.r);

// Two owners' doors into one interior are two buildings
const shared = { [ROOT]: rec({ partner: ROOT_OUT }), [D1]: rec({ owner: 61, ownerName: 'Fink', partner: D1_IN }) };
o = reckonOnce({ registry: [ROOT, D1], recs: shared, cells, bank: 10000 });
check("two owners' doors into one interior are each taxed (Fink, with no bank here, owes his)", o.r.taxed === 1 && o.r.overdue.length === 1 && o.r.overdue[0].owner === 'Fink', o.r);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
