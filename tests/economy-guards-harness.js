// Scripted test for economy.js's guards against a ruler paying the treasury out (release review B2): nobody is paid a
// wage by a treasury their account controls (the Count, a guild leader, a leader's alt), nobody sets the wage of a rank
// they hold, a week's wages take at most wageIncomeShare of the week's income and wageShare of the treasury (the rest is
// owed; review A1-3: before, 25% of the balance, so the seed could be paid out with no income), and a property is assessed at
// most once a week, by at most assessMaxStep times, with its owner told. Run it from this folder's parent with
//
//   node tests\economy-guards-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ECON = path.resolve(__dirname, '..', 'economy.js');
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'economy-guards-harness-')));

let now = Date.UTC(2026, 8, 26, 12, 0); // Saturday
Date.now = () => now;

// One house in Applewatch, owned by Lydia (account 11, character 0x20, online)
const H1 = 0x100;
fs.writeFileSync('housing.json', JSON.stringify([H1]));
const recs = { [H1]: { owner: 11, ownerName: 'Lydia', partner: 0 } };
const props = new Map();
const get = (id, p) => (p === 'worldOrCellDesc' ? 'tamriel' : p === 'pos' ? [1, 1, 0] : props.get(id + '|' + p));
const set = (id, p, v) => props.set(id + '|' + p, v);
// Accounts: 1 the Count (character 0x10), 13 and 14 guards (0x23, 0x24), 100 the guild leader (0x40) whose alt 0x42 is
// also on the roster, 11 Lydia (0x20)
const chars = { 1: [0x10], 11: [0x20], 13: [0x23], 14: [0x24], 100: [0x40, 0x42] };
for (const [pid, list] of Object.entries(chars)) for (const a of list) set(a, 'profileId', Number(pid));
set(0x20, 'private.bankGold', 1000);
const officials = { bruma: { count: [1], guard: [13, 14] } };
const treasuries = { 'county-bruma': 1000, 'fighters-guild': 1000 };
globalThis.__dboTreasury = {
  balance: (f) => treasuries[f] || 0,
  spend: (f, n) => { if ((treasuries[f] || 0) < n) return false; treasuries[f] -= n; return true; },
  deposit: (f, n) => { treasuries[f] = (treasuries[f] || 0) + n; return true; },
};
globalThis.__dboHousing = { recordOf: (r) => recs[r] || null, primaryOf: (r) => (recs[r] ? r : 0), isManager: (a) => a === 0x30 };
globalThis.__dboRealmTerritoryAt = () => ({ id: 'applewatch', name: 'Applewatch' });
globalThis.__dboRealmOwnerOf = () => 'county-bruma';
globalThis.__dboRealmLeads = (a, f) => (a === 0x10 && f === 'county-bruma') || (a === 0x40 && f === 'fighters-guild');
globalThis.__dboRealmLeadsAccount = (pid, f) => (pid === 1 && f === 'county-bruma') || (pid === 100 && f === 'fighters-guild');
globalThis.__dboRealmFactionsLedBy = (a) => (a === 0x10 ? ['county-bruma'] : a === 0x40 ? ['fighters-guild'] : []);
globalThis.__dboGuildInfo = (f) => ({ 'county-bruma': { id: f, name: 'County of Bruma', kind: 'hold', zone: 'bruma' }, 'fighters-guild': { id: f, name: 'Fighters Guild', kind: 'guild', zone: '' } }[f] || null);
globalThis.__dboGuildMembers = (f) => (f === 'fighters-guild' ? [0x40, 0x42, 0x41] : []);
globalThis.__dboGuildsOf = (a) => ({ 0x40: [{ id: 'fighters-guild', title: 'Harbinger', role: 'leader' }], 0x42: [{ id: 'fighters-guild', title: 'Associate' }], 0x41: [{ id: 'fighters-guild', title: 'Associate' }] }[a] || []);
globalThis.__dboGuildRanks = () => ['Harbinger', 'Warden', 'Associate'];
globalThis.__dboFactionNonceOk = () => true;
const replies = [];
globalThis.__dboFactionRefresh = (a, text, ok) => { replies.push({ a, text, ok }); return true; };

const out = { personal: [], audits: [] };
const handlers = new Map(); const timers = new Map();
const api = {
  mp: { get, set, getActorsByProfileId: (pid) => chars[pid] || [] },
  log: () => {}, personal: (a, t) => out.personal.push({ a, t }), audit: (t) => out.audits.push(t), who: (a) => `P${a.toString(16)}`,
  cfg: { economy: { enabled: true } }, onUi: (ev, f) => handlers.set(ev, f), onlineActors: () => [0x10, 0x40, 0x20], every: (n, ms, f) => timers.set(n, f),
  readOfficials: () => JSON.parse(JSON.stringify(officials)), zoneById: (id) => (id === 'bruma' ? { id: 'bruma', name: 'Bruma', officials: ['count', 'steward', 'guard'] } : null),
};
delete globalThis.__dboEconomy;
delete require.cache[ECON];
const econ = require(ECON)(api);

let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail !== undefined ? '   ' + detail : ''}`); if (!ok) failures++; };
const bal = (a) => get(a, 'private.bankGold') || 0;
const ui = (ev, a, ...args) => { replies.length = 0; handlers.get(ev)(a, ['nonce', ...args]); return replies[0] || {}; };
const state = () => globalThis.__dboEconomy.data;

// Nobody sets their own wage
check('the Count cannot set the Count\'s wage', !ui('econWage', 0x10, 'county-bruma', 'count', 500).ok && /nobody sets their own wage/.test(replies[0].text));
check('the Count sets the guards\' wage', ui('econWage', 0x10, 'county-bruma', 'guard', 200).ok);
check('the Count sets a 10% tax', ui('econRate', 0x10, 'county-bruma', 10).ok);
check('the guild leader cannot set the Harbinger\'s wage', !ui('econWage', 0x40, 'fighters-guild', 'Harbinger', 500).ok);
check('the guild leader can set the Associates\' wage, though an alt of theirs is one', ui('econWage', 0x40, 'fighters-guild', 'Associate', 100).ok);

// Nor is paid one: a Count wage that got into the table anyway, and the leader's alt on the roster
state().wages['county-bruma'].count = 300;
state().owed['county-bruma'] = { p1: { actor: 0x10, gold: 300, rank: 'count' } };
check('the payroll leaves out the Count and the leader\'s alt', !econ.payroll('county-bruma').some((p) => p.pid === 1) && !econ.payroll('fighters-guild').some((p) => p.actor === 0x42),
  JSON.stringify(econ.payroll('fighters-guild')));

timers.get('economy')();
now = Date.UTC(2026, 8, 27, 0, 1); // Sunday 00:01: the reckoning
timers.get('economy')();
const r = state().reports;
check('the Count got nothing, neither this week\'s nor what was owed', bal(0x10) === 0 && !(state().owed['county-bruma'] || {}).p1, JSON.stringify(state().owed['county-bruma']));
// The guild has 1,000 and no income this week: no wages at all (A1-3), and the alt is not even owed
check('the leader\'s alt got nothing and is owed nothing; with no income the other Associate is owed, not paid', bal(0x42) === 0 && bal(0x41) === 0 && !(state().owed['fighters-guild'] || {}).a66 && (state().owed['fighters-guild'] || {}).a65 && state().owed['fighters-guild'].a65.gold === 100, JSON.stringify(state().owed['fighters-guild']));

// A week's wages take at most 75% of the week's income (200 of tax: 150 of budget) and 25% of the treasury (1,200: 300);
// two guards at 200 each: neither fits, both are owed
check('neither guard fits the 150 budget: both wages are owed', bal(0x23) + bal(0x24) === 0 && r['county-bruma'].owed === 400 && r['county-bruma'].wageBudget === 150, JSON.stringify(r['county-bruma']));
check('the report says the cap stopped it, and the Count is told', r['county-bruma'].capped === true && out.personal.some((x) => x.a === 0x10 && /at most 75% of the week's income and 25% of the treasury: 150 gold/.test(x.t)));
check('the treasury kept its 1,000 plus 200 of tax', treasuries['county-bruma'] === 1200 && bal(0x20) === 800, `${treasuries['county-bruma']} ${bal(0x20)}`);

// Assessments: once a week, at most twice or half the value, the owner told
check('a first assessment within twice the value (2,000 to 4,000)', ui('econValue', 0x30, H1, 4000).ok);
check('Lydia is told her property was assessed', out.personal.some((x) => x.a === 0x20 && /assessed at 4000 gold \(it was 2000\)/.test(x.t)));
check('not again the same week', !ui('econValue', 0x30, H1, 5000).ok && /again in 7 days/.test(replies[0].text), replies[0] && replies[0].text);
now += 8 * 86400000;
check('a week on, not beyond twice: 10,000 is refused', !ui('econValue', 0x30, H1, 10000).ok && /from 2000 to 8000/.test(replies[0].text), replies[0] && replies[0].text);
check('nor below half: 1,000 is refused', !ui('econValue', 0x30, H1, 1000).ok);
check('8,000 is allowed', ui('econValue', 0x30, H1, 8000).ok);
check('every assessment is audited with the old value', out.audits.some((t) => /assessed property 100 at 8000 gold \(was 4000\)/.test(t)));

console.log(failures ? `${failures} failure(s)` : 'all passed');
process.exit(failures ? 1 : 0);
