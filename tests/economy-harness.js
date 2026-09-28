// Scripted test for server\economy.js with a mock gamemode api: the weekly property tax at the land owner's rate (0 to
// 30%) taken from the owner's bank accounts into the faction's treasury, overdue tax when they cannot pay, a steward's
// assessed value, wages by rank for a hold (its officials) and a guild (its roster) paid into bank accounts, wages the
// treasury cannot pay owed and paid first next week, the reckoning once a week, and only leaders setting rates and wages.
// Run it from this folder's parent with
//
//   node tests\economy-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ECON = path.resolve(__dirname, '..', 'economy.js');
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'economy-harness-')));

let now = Date.UTC(2026, 8, 26, 12, 0); // Saturday
Date.now = () => now;

// Three houses: two in Applewatch (Bruma's land), one in Greenwood (taken by the Fighters Guild)
const H1 = 0x100, H2 = 0x101, H3 = 0x102, H1_OUT = 0x200;
fs.writeFileSync('housing.json', JSON.stringify([H1, H2, H3]));
const recs = { [H1]: { owner: 11, ownerName: 'Lydia', partner: H1_OUT }, [H2]: { owner: 12, ownerName: 'Brelyna', partner: 0 }, [H3]: { owner: 11, ownerName: 'Lydia', partner: 0 } };
const places = { [H1]: ['interior', [0, 0, 0]], [H1_OUT]: ['tamriel', [1, 1, 0]], [H2]: ['tamriel', [2, 2, 0]], [H3]: ['tamriel', [9, 9, 0]] };
const props = new Map();
const get = (id, p) => (p === 'worldOrCellDesc' ? (places[id] || [])[0] : p === 'pos' ? (places[id] || [])[1] : props.get(id + '|' + p));
const set = (id, p, v) => props.set(id + '|' + p, v);
// Characters: account 11 has characters 0x20 and 0x21; account 12 has 0x22; officials of Bruma: guard profile 13 (char 0x23)
const chars = { 11: [0x20, 0x21], 12: [0x22], 13: [0x23] };
set(0x20, 'private.bankGold', 100); set(0x21, 'private.bankGold', 300); set(0x22, 'private.bankGold', 10);
let officials = { bruma: { count: [1], guard: [13] } };
const treasuries = { 'county-bruma': 1000, 'fighters-guild': 50 };
globalThis.__dboTreasury = {
  balance: (f) => treasuries[f] || 0,
  spend: (f, n) => { if ((treasuries[f] || 0) < n) return false; treasuries[f] -= n; return true; },
  deposit: (f, n) => { treasuries[f] = (treasuries[f] || 0) + n; return true; },
};
globalThis.__dboHousing = { recordOf: (r) => recs[r] || null, primaryOf: (r) => (recs[r] ? r : 0), isManager: (a, r) => a === 0x30 };
globalThis.__dboRealmTerritoryAt = (w, p) => (w === 'tamriel' ? (p[0] < 5 ? { id: 'applewatch', name: 'Applewatch' } : { id: 'greenwood', name: 'Greenwood' }) : null);
globalThis.__dboRealmOwnerOf = (t) => (t === 'applewatch' ? 'county-bruma' : 'fighters-guild');
globalThis.__dboRealmLeads = (a, f) => (a === 1 && f === 'county-bruma') || (a === 100 && f === 'fighters-guild');
globalThis.__dboRealmFactionsLedBy = (a) => (a === 1 ? ['county-bruma'] : a === 100 ? ['fighters-guild'] : []);
globalThis.__dboGuildInfo = (f) => ({ 'county-bruma': { id: f, name: 'County of Bruma', kind: 'hold', zone: 'bruma' }, 'fighters-guild': { id: f, name: 'Fighters Guild', kind: 'guild', zone: '' } }[f] || null);
globalThis.__dboGuildMembers = (f) => (f === 'fighters-guild' ? [0x40, 0x41] : []);
globalThis.__dboGuildsOf = (a) => (a === 0x40 ? [{ id: 'fighters-guild', title: 'Warden' }] : a === 0x41 ? [{ id: 'fighters-guild', title: 'Associate' }] : []);
globalThis.__dboGuildRanks = () => ['Harbinger', 'Warden', 'Associate'];
let nonceOk = true;
globalThis.__dboFactionNonceOk = () => nonceOk;
const replies = [];
globalThis.__dboFactionRefresh = (a, text, ok) => { replies.push({ a, text, ok }); return true; };

const out = { personal: [], audits: [] };
const handlers = new Map(); const timers = new Map();
const api = {
  mp: { get, set, getActorsByProfileId: (pid) => chars[pid] || [] },
  log: () => {}, personal: (a, t) => out.personal.push({ a, t }), audit: (t) => out.audits.push(t), who: (a) => `P${a.toString(16)}`, cfg: { economy: { enabled: true } },
  onUi: (ev, f) => handlers.set(ev, f), onlineActors: () => [1, 100, 0x20], every: (n, ms, f) => timers.set(n, f),
  readOfficials: () => JSON.parse(JSON.stringify(officials)), zoneById: (id) => (id === 'bruma' ? { id: 'bruma', name: 'Bruma', officials: ['count', 'steward', 'guard'] } : null),
};
let econ;
const load = () => { handlers.clear(); delete require.cache[ECON]; econ = require(ECON)(api); };

// Off by default (review B2): no reckoning runs, so nothing is charged or paid
api.cfg = {};
load();
timers.get('economy')();
const offRan = fs.existsSync('economy.json') && !!JSON.parse(fs.readFileSync('economy.json', 'utf8')).lastReckoning;
// The flow below predates the B2 guards (economy-guards-harness.js): a wage cap as large as the treasury and a wider
// assessment step keep its numbers
api.cfg = { economy: { enabled: true, wageShare: 1, assessMaxStep: 3 } };
load();

let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail !== undefined ? '   ' + detail : ''}`); if (!ok) failures++; };
check('with economy.enabled off (the default) no reckoning runs', !offRan && globalThis.__dboEconomyView(1).enabled === true);
const bal = (a) => get(a, 'private.bankGold') || 0;
const ui = (ev, a, ...args) => { replies.length = 0; handlers.get(ev)(a, ['nonce', ...args]); return replies[0] || {}; };

// Settings
check('a non-leader cannot set the tax rate', !ui('econRate', 100, 'county-bruma', 10).ok);
check('the rate is at most 30%', !ui('econRate', 1, 'county-bruma', 31).ok && /0% to 30%/.test(replies[0].text));
check('the Count sets 10%', ui('econRate', 1, 'county-bruma', 10).ok);
check('the guild leader sets 20% on its land', ui('econRate', 100, 'fighters-guild', 20).ok);
check('the Count sets the guard\'s wage', ui('econWage', 1, 'county-bruma', 'guard', 50).ok);
check('the guild leader sets wages by rank title', ui('econWage', 100, 'fighters-guild', 'Warden', 40).ok && ui('econWage', 100, 'fighters-guild', 'Associate', 30).ok);
check('only a property\'s manager assesses it', !ui('econValue', 0x99, H2, 5000).ok && ui('econValue', 0x30, H2, 5000).ok);
nonceOk = false;
check('a stale panel is ignored', ui('econRate', 1, 'county-bruma', 0).text === undefined);
nonceOk = true;

// The first minute only sets the clock; the reckoning waits for Sunday 00:00 UTC
timers.get('economy')();
check('no reckoning straight away', !out.audits.some((t) => /^ECONOMY County/.test(t)));
now = Date.UTC(2026, 8, 27, 0, 1); // Sunday 00:01
timers.get('economy')();
const r = JSON.parse(fs.readFileSync('economy.json', 'utf8')).reports;

// Taxes
check('H1 (interior door) is taxed by its outdoor door in Applewatch: 10% of 2,000 from Lydia\'s richest character', bal(0x21) === 100 && bal(0x20) === 100, `${bal(0x20)} ${bal(0x21)}`);
check('H2 is assessed at 5,000: 500 due, Brelyna has 10, so it is overdue and nothing is taken', bal(0x22) === 10 && r['county-bruma'].overdue.length === 1 && r['county-bruma'].overdue[0].weeks === 1);
check('H3 in Greenwood owes the Fighters Guild 20% of 2,000 = 400; Lydia has 200 left across her characters, so it is overdue and nothing is taken',
  r['fighters-guild'].income === 0 && r['fighters-guild'].overdue.length === 1 && r['fighters-guild'].overdue[0].gold === 400 && bal(0x20) + bal(0x21) === 200);
check('the treasury received the tax (200 in, 50 out for the guard)', treasuries['county-bruma'] === 1000 + 200 - 50, treasuries['county-bruma']);
check('the guard was paid into his bank account', bal(0x23) === 50);

// Wages the treasury cannot pay are owed
// The guild took no tax this week (Lydia could not pay), so its 50 gold pays no wages (A1-3): both are owed
check('with no income the guild pays no wages: both are owed', r['fighters-guild'].wagesPaid === 0 && r['fighters-guild'].owed === 70 && bal(0x40) === 0 && bal(0x41) === 0, JSON.stringify(r['fighters-guild']));
check('the Count and the guild leader are told the week\'s reckoning', out.personal.some((x) => x.a === 1 && /reckoning for County of Bruma/.test(x.t)) && out.personal.some((x) => x.a === 100 && /reckoning for Fighters Guild/.test(x.t)));
check('Lydia, online, is told her Greenwood tax is overdue; Brelyna is offline and told nothing', out.personal.some((x) => x.a === 0x20 && /400 gold to Fighters Guild .* overdue/.test(x.t)) && !out.personal.some((x) => x.a === 0x22));

// Not twice in a week; owed wages first next week
const auditsBefore = out.audits.length;
now += 3600000; timers.get('economy')();
check('the reckoning runs once a week', out.audits.length === auditsBefore);
treasuries['fighters-guild'] = 1000;
now = Date.UTC(2026, 9, 4, 0, 1); timers.get('economy')();
const r2 = JSON.parse(fs.readFileSync('economy.json', 'utf8')).reports;
check('next week the owed wage is paid first, then the week\'s', bal(0x41) === 60 && r2['fighters-guild'].owed === 0, `${bal(0x41)}`);
check('an overdue property counts its weeks', r2['county-bruma'].overdue[0].weeks === 2 && r2['county-bruma'].overdue[0].gold === 1000);

// The view
const v = globalThis.__dboEconomyView(1);
check('the Count\'s panel shows the rate, the wages and the hold\'s ranks', v.factions.length === 1 && v.factions[0].rate === 0.1 && v.factions[0].wages.guard === 50 && v.factions[0].ranks.join(',') === 'count,steward,guard' && v.maxTaxRate === 0.3);
check('a guild leader\'s panel shows its rank titles', globalThis.__dboEconomyView(100).factions[0].ranks.join(',') === 'Harbinger,Warden,Associate');

// A hot reload keeps it all
load();
check('after a reload the settings stand', globalThis.__dboEconomyView(1).factions[0].rate === 0.1);

console.log(failures ? `${failures} failure(s)` : 'all passed');
process.exit(failures ? 1 : 0);
