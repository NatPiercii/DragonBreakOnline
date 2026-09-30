// Scripted test for the Imperial tithe in economy.js's weekly reckoning: the Empire's share of the property tax collected
// on Cyrodiil land goes to the Imperial Legion's treasury; Skyrim's Holds and the Legion's own land pay none; rate 0, a
// treasury that cannot pay (arrears), a Legion treasury that refuses, no Legion at all, and a hot reload. Loads the real
// economy.js and guilds.js (with the real guild-defs.json) in a temp working directory. Run it from this folder's parent:
//
//   node tests/imperial-tithe-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ECON = path.resolve(__dirname, '..', 'economy.js');
const GUILDS = path.resolve(__dirname, '..', 'guilds.js');
const REGIONS = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'regions.json'), 'utf8'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imperial-tithe-'));
fs.copyFileSync(path.resolve(__dirname, '..', 'guild-defs.json'), path.join(dir, 'guild-defs.json'));
process.chdir(dir);
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });

const SUNDAY = Date.UTC(2026, 9, 4, 0, 1);
const WEEK = 7 * 86400000;
let now = SUNDAY - 3600000;
Date.now = () => now;

let failures = 0;
const check = (label, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

// The region data this relies on: Bruma's worldspace is Cyrodiil, Skyrim's is not
const CYR = 'a764b:BSHeartland.esm', TAM = '3c:Skyrim.esm';
check('regions.json puts Beyond Skyrim: Bruma in Cyrodiil and Skyrim.esm in Skyrim', REGIONS.places.plugins['bsheartland.esm'] === 'cyrodiil' && REGIONS.places.plugins['skyrim.esm'] === 'skyrim');

// Homes: two in the County (Bruma, Applewatch), one at Fort Caractacus (the Legion's), one in Whiterun (Skyrim)
const HOUSES = {
  0x101: { owner: 11, world: CYR, pos: [54000, 204000, 0], territory: { id: 'bruma', name: 'Bruma', marker: { world: CYR } }, faction: 'county-bruma' },
  0x102: { owner: 12, world: CYR, pos: [70000, 190000, 0], territory: { id: 'applewatch', name: 'Applewatch', marker: { world: CYR } }, faction: 'county-bruma' },
  0x103: { owner: 13, world: CYR, pos: [65000, 154000, 0], territory: { id: 'fort-caractacus', name: 'Fort Caractacus', marker: { world: CYR } }, faction: 'imperial-legion' },
  0x104: { owner: 14, world: TAM, pos: [1, 1, 0], territory: { id: 'whiterun', name: 'Whiterun', marker: { world: TAM } }, faction: 'hold-whiterun' },
};
const chars = { 11: [0x21], 12: [0x22], 13: [0x23], 14: [0x24] };
const props = new Map();
const mp = {
  get: (id, p) => {
    const h = HOUSES[id >>> 0];
    if (h && p === 'worldOrCellDesc') return h.world;
    if (h && p === 'pos') return h.pos;
    if (p === 'type') return 'MpActor';
    return props.get(`${id >>> 0}|${p}`);
  },
  set: (id, p, v) => props.set(`${id >>> 0}|${p}`, v),
  getActorsByProfileId: (pid) => chars[pid] || [],
};
for (const [pid, list] of Object.entries(chars)) for (const a of list) { props.set(`${a}|profileId`, Number(pid)); props.set(`${a}|private.bankGold`, 100000); }
fs.writeFileSync('housing.json', JSON.stringify(Object.keys(HOUSES).map(Number)));
// The County taxes at 20%, the Legion at 10%, Whiterun at 20%; the Bruma house is assessed at 10,000, the rest at 2,000
fs.writeFileSync('economy.json', JSON.stringify({
  rates: { 'county-bruma': 0.2, 'imperial-legion': 0.1, 'hold-whiterun': 0.2 }, values: { [0x101]: 10000 },
  wages: {}, owed: {}, overdue: {}, reports: {}, assessed: {}, balanceAfter: {}, lastReckoning: SUNDAY - WEEK,
}));

// Treasuries, with switches to make one refuse
const treasuries = { 'county-bruma': 1000, 'imperial-legion': 0, 'hold-whiterun': 1000 };
const refuse = { spend: new Set(), deposit: new Set() };
globalThis.__dboTreasury = {
  keyOf: (f) => (globalThis.__dboGuildInfo(f) ? `faction:${f}` : null),
  balance: (f) => treasuries[f] || 0,
  spend: (f, n) => { if (refuse.spend.has(f) || (treasuries[f] || 0) < n) return false; treasuries[f] -= n; return true; },
  deposit: (f, n) => { if (refuse.deposit.has(f)) return false; treasuries[f] = (treasuries[f] || 0) + n; return true; },
};
globalThis.__dboHousing = { recordOf: (r) => (HOUSES[r] ? { owner: HOUSES[r].owner, ownerName: `Owner ${HOUSES[r].owner}`, partner: 0 } : null), primaryOf: (r) => r, isManager: () => false };
globalThis.__dboRealmTerritoryAt = (world, pos) => { const h = Object.values(HOUSES).find((x) => x.world === world && x.pos === pos); return h ? h.territory : null; };
globalThis.__dboRealmOwnerOf = (tid) => (Object.values(HOUSES).find((x) => x.territory.id === tid) || {}).faction || null;
globalThis.__dboRegions = { placeOf: (d) => ({ province: REGIONS.places.plugins[String(d).split(':')[1].toLowerCase()] || 'skyrim' }) };
// The Count (0x50) leads the County, the General (0x51) the Legion; both are online
const COUNT = 0x50, GENERAL = 0x51;
globalThis.__dboRealmLeads = (a, f) => (a === COUNT && f === 'county-bruma') || (a === GENERAL && f === 'imperial-legion');
globalThis.__dboRealmLeadsAccount = () => false;

const logs = [], audits = [], said = [];
const timers = new Map();
const noop = () => {};
require(GUILDS)({
  mp, log: (...x) => logs.push(x.join(' ')), personal: noop, system: noop, audit: noop, registerChatCommand: noop, onUi: noop,
  openWidget: noop, closeWidget: noop, display: (a) => `P${a.toString(16)}`, who: (a) => `P${a.toString(16)}`, nameOf: (a) => `P${a.toString(16)}`,
  tagOf: () => 'TAG', onlineActors: () => [], isAdmin: () => false, findByName: () => 0, cfg: {}, profileOf: (a) => props.get(`${a}|profileId`),
});
let econCfg = { enabled: true };
const load = () => {
  delete require.cache[ECON];
  return require(ECON)({
    mp, log: (...x) => logs.push(x.join(' ')), personal: (a, t) => said.push([a, t]), who: (a) => `P${a.toString(16)}`,
    audit: (t) => audits.push(t), cfg: { economy: econCfg }, onUi: noop, onlineActors: () => [COUNT, GENERAL],
    every: (n, ms, f) => timers.set(n, f), readOfficials: () => ({}), zoneById: () => null,
  });
};
load();
const state = () => globalThis.__dboEconomy.data;
const tick = () => timers.get('economy')();
const week = (w) => { now = SUNDAY + w * WEEK; said.length = 0; audits.length = 0; tick(); };
const report = (f) => state().reports[f] || {};

// ---- week 1: taxes on Cyrodiil and Skyrim land ----
week(0);
// County: 20% of 10,000 + 20% of 2,000 = 2,400; its tithe 10% = 240. Legion: 10% of 2,000 = 200, untithed. Whiterun: 400.
check('the County collected 2,400 in property tax', report('county-bruma').income === 2400, report('county-bruma'));
check('the County paid an Imperial tithe of 240 (10% of 2,400) to the Legion', report('county-bruma').tithe === 240 && report('county-bruma').titheBase === 2400 && !report('county-bruma').titheOwed, report('county-bruma'));
check("the Legion's treasury: its own 200 tax and the 240 tithe", treasuries['imperial-legion'] === 440 && report('imperial-legion').tithesIn === 240, [treasuries['imperial-legion'], report('imperial-legion')]);
check("the Legion pays no tithe on its own fort", !report('imperial-legion').tithe && !audits.some((t) => /Imperial Legion: Imperial tithe/.test(t)));
check("Whiterun, a Hold of Skyrim, pays none", treasuries['hold-whiterun'] === 1400 && report('hold-whiterun').tithe === undefined, report('hold-whiterun'));
check("the County's treasury: 1,000 + 2,400 - 240", treasuries['county-bruma'] === 3160, treasuries['county-bruma']);
check('the audit log has the tithe line', audits.some((t) => t === 'ECONOMY County of Bruma: Imperial tithe 240 gold to Imperial Legion (10% of 2400 in taxes)'), audits);
check("the Count's reckoning names the tithe", said.some(([a, t]) => a === COUNT && /2400 gold in taxes, 240 gold Imperial tithe to Imperial Legion, 0 gold in wages/.test(t)), said);
check("the General's reckoning names the tithes received", said.some(([a, t]) => a === GENERAL && /200 gold in taxes, 240 gold in Imperial tithes/.test(t)), said);
check('the reckoning does not fail', !logs.some((l) => /fail/.test(l)), logs);

// ---- the same week again: nothing is taken twice ----
for (let i = 0; i < 5; i++) { now += 60000; tick(); }
check('more minutes take no second tithe', treasuries['imperial-legion'] === 440 && treasuries['county-bruma'] === 3160);

// ---- week 2: the County's treasury refuses to pay: the tithe is owed ----
refuse.spend.add('county-bruma');
week(1);
check('a treasury that cannot pay owes the tithe', report('county-bruma').tithe === 0 && report('county-bruma').titheOwed === 240 && state().titheOwed['county-bruma'] === 240, [report('county-bruma'), state().titheOwed]);
check('the arrears are audited and told to the Count', audits.some((t) => /Imperial tithe 0 gold .*; 240 owed/.test(t)) && said.some(([a, t]) => a === COUNT && /0 gold Imperial tithe to Imperial Legion \(240 gold still owed\)/.test(t)), [audits, said]);
refuse.spend.delete('county-bruma');

// ---- week 3: the arrears are paid first, with the week's tithe ----
const legion2 = treasuries['imperial-legion'];
week(2);
check('the next week takes the arrears and the week\'s tithe: 240 + 240', report('county-bruma').tithe === 480 && !report('county-bruma').titheOwed && !('county-bruma' in state().titheOwed) && treasuries['imperial-legion'] === legion2 + 200 + 480, [report('county-bruma'), treasuries['imperial-legion'] - legion2]);
check('the audit says the arrears were in it', audits.some((t) => /Imperial tithe 480 gold to Imperial Legion \(10% of 2400 in taxes, 240 in arrears\)/.test(t)), audits);

// ---- week 4: the Legion's treasury refuses the gold: it goes back and is owed ----
refuse.deposit.add('imperial-legion');
const county4 = treasuries['county-bruma'];
week(3);
check("a refused tithe goes back to the County's treasury and is owed", treasuries['county-bruma'] === county4 + 2400 && report('county-bruma').tithe === 0 && state().titheOwed['county-bruma'] === 240, [treasuries['county-bruma'] - county4, state().titheOwed]);
refuse.deposit.delete('imperial-legion');
delete state().titheOwed['county-bruma'];

// ---- a treasury holding less than the tithe pays what it has ----
{
  const e = load();
  treasuries['county-bruma'] = 0;
  refuse.deposit.add('county-bruma');   // the week's tax cannot land: the owners are refunded, the tithe base is 0
  const before = treasuries['imperial-legion'];
  state().titheOwed['county-bruma'] = 500;
  treasuries['county-bruma'] = 120;
  now = SUNDAY + 4 * WEEK; said.length = 0; audits.length = 0;
  e.reckon();
  refuse.deposit.delete('county-bruma');
  check('an old debt larger than the treasury takes what is there and owes the rest', treasuries['imperial-legion'] - before === 120 + 200 && state().titheOwed['county-bruma'] === 380 && treasuries['county-bruma'] === 0, [treasuries['imperial-legion'] - before, state().titheOwed, treasuries['county-bruma']]);
  delete state().titheOwed['county-bruma'];
  treasuries['county-bruma'] = 1000;
}

// ---- rate 0: the tithe is off ----
econCfg = { enabled: true, titheRate: 0 };
load();
const legion6 = treasuries['imperial-legion'];
state().titheOwed['county-bruma'] = 99;
week(5);
check('titheRate 0 takes no tithe, not even arrears', treasuries['imperial-legion'] === legion6 + 200 && report('county-bruma').tithe === undefined && state().titheOwed['county-bruma'] === 99 && !audits.some((t) => /tithe/.test(t)), [treasuries['imperial-legion'] - legion6, report('county-bruma')]);
check("titheRate 0 leaves the Count's message as before", said.some(([a, t]) => a === COUNT && /2400 gold in taxes, 0 gold in wages/.test(t)), said);
delete state().titheOwed['county-bruma'];

// ---- no such recipient: nothing is taken ----
econCfg = { enabled: true, titheTo: 'no-such-faction' };
load();
const county7 = treasuries['county-bruma'];
week(6);
check('a missing recipient takes nothing and says so in the log', treasuries['county-bruma'] === county7 + 2400 && logs.some((l) => /no treasury for no-such-faction, no Imperial tithe taken/.test(l)), treasuries['county-bruma'] - county7);

// ---- a hot reload keeps the state and runs nothing twice ----
econCfg = { enabled: true };
load();
refuse.spend.add('county-bruma');   // this week's tithe is owed, and saved with the reckoning
week(7);
refuse.spend.delete('county-bruma');
const legion8 = treasuries['imperial-legion'], stamp = state().lastReckoning;
load();
check('a reload keeps the arrears and the stamp', state().titheOwed['county-bruma'] === 240 && state().lastReckoning === stamp, state().titheOwed);
for (let i = 0; i < 5; i++) { now += 60000; tick(); }
check('a reload runs no second reckoning in the same week', treasuries['imperial-legion'] === legion8);
delete globalThis.__dboEconomy;
load();
check('a restart reads the arrears back from economy.json', state().titheOwed['county-bruma'] === 240, state().titheOwed);

console.log('');
console.log(failures ? `${failures} FAILURES` : 'all checks passed');
process.exit(failures ? 1 : 0);
