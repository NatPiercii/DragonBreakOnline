// Scripted test for economy.js's weekly reckoning against deleted characters (review A1-2) and its wage cap and owed
// wages (A1-3). Loads the real economy.js and the real guilds.js (with the real guild-defs.json) against an mp stub that
// throws for a deleted character as the server does ("Form with id .. doesn't exist", WorldState::GetFormAt), in a temp
// working directory. Run it from this folder's parent with
//
//   node tests/economy-reckoning-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ECON = path.resolve(__dirname, '..', 'economy.js');
const GUILDS = path.resolve(__dirname, '..', 'guilds.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'economy-reckoning-'));
fs.copyFileSync(path.resolve(__dirname, '..', 'guild-defs.json'), path.join(dir, 'guild-defs.json'));
process.chdir(dir);
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });

const SUNDAY = Date.UTC(2026, 9, 4, 0, 1);   // the first reckoning the review names
let now = SUNDAY - 3600000;
Date.now = () => now;

// Accounts and characters: 100 the Guildmaster (0x40); 101 a Guardian (0x41); 103 a Guardian whose character 0x43 was
// deleted at character select; 11 Lydia (0x20), who owns the taxed house; 13 a guard of Bruma whose first character 0x23
// was deleted, 0x24 still stands
const chars = { 100: [0x40], 101: [0x41], 103: [0x43], 11: [0x20], 13: [0x23, 0x24] };
const gone = new Set([0x43, 0x23]);
const props = new Map();
const noForm = (id) => { throw new Error(`Form with id ${(id >>> 0).toString(16)} doesn't exist`); };
const mp = {
  get: (id, p) => { if (gone.has(id >>> 0)) noForm(id); if (p === 'type') return 'MpActor'; if (p === 'worldOrCellDesc') return 'tamriel'; if (p === 'pos') return [1, 1, 0]; return props.get(`${id >>> 0}|${p}`); },
  set: (id, p, v) => { if (gone.has(id >>> 0)) noForm(id); props.set(`${id >>> 0}|${p}`, v); },
  // As the server does, an account lists the characters it has now
  getActorsByProfileId: (pid) => (chars[pid] || []).filter((a) => !gone.has(a)).concat((chars[pid] || []).filter((a) => gone.has(a))),
};
for (const [pid, list] of Object.entries(chars)) for (const a of list) if (!gone.has(a)) props.set(`${a}|profileId`, Number(pid));
const bank = (a) => props.get(`${a}|private.bankGold`) || 0;
props.set(`${0x20}|private.bankGold`, 5000);

// The guild's roster, as guilds.json holds it: the Guildmaster, a Guardian, and the deleted Guardian
const GUARDIAN = 2, ASSOCIATE = 7;
fs.writeFileSync('guilds.json', JSON.stringify({ 'fighters-guild': {
  [String(0x40)]: { rank: 0, name: 'Guildmaster', since: 0 },
  [String(0x41)]: { rank: GUARDIAN, name: 'Guardian A', since: 0 },
  [String(0x43)]: { rank: GUARDIAN, name: 'Guardian B', since: 0 },
} }));
const H1 = 0x100;
fs.writeFileSync('housing.json', JSON.stringify([H1]));
// Last week's reckoning ran; the guild taxes the house at 20% of 10,000; Guardians earn 1,000, Bruma's guards 100; the
// county has had 500 come in since last week (1,000 then, 1,500 now), and still owes the guard's account last week's wage
fs.writeFileSync('economy.json', JSON.stringify({
  rates: { 'fighters-guild': 0.2 }, wages: { 'fighters-guild': { Guardian: 1000 }, 'county-bruma': { Guard: 100 } }, values: { [H1]: 10000 },
  owed: { 'county-bruma': { p13: { actor: 0x23, gold: 100, rank: 'Guard' } } }, overdue: {}, reports: {}, assessed: {},
  balanceAfter: { 'county-bruma': 1000 }, lastReckoning: SUNDAY - 7 * 86400000,
}));
const treasuries = { 'fighters-guild': 20000, 'county-bruma': 1500 };
globalThis.__dboTreasury = {
  balance: (f) => treasuries[f] || 0,
  spend: (f, n) => { if ((treasuries[f] || 0) < n) return false; treasuries[f] -= n; return true; },
  deposit: (f, n) => { treasuries[f] = (treasuries[f] || 0) + n; return true; },
};
globalThis.__dboHousing = { recordOf: (r) => (r === H1 ? { owner: 11, ownerName: 'Lydia', partner: 0 } : null), primaryOf: (r) => r, isManager: () => false };
globalThis.__dboRealmTerritoryAt = () => ({ id: 'greenwood', name: 'Greenwood' });
globalThis.__dboRealmOwnerOf = () => 'fighters-guild';
globalThis.__dboRealmLeads = (a, f) => (a === 0x40 && f === 'fighters-guild');
globalThis.__dboRealmLeadsAccount = (pid, f) => (pid === 100 && f === 'fighters-guild');
const replies = [];

const logs = [];
const audits = [];
let auditThrows = false;
const timers = new Map();
const handlers = new Map();
const noop = () => {};
require(GUILDS)({
  mp, log: (...x) => logs.push(x.join(' ')), personal: noop, system: noop, audit: noop, registerChatCommand: noop, onUi: noop,
  openWidget: noop, closeWidget: noop, display: (a) => `P${a.toString(16)}`, who: (a) => `P${a.toString(16)}`, nameOf: (a) => `P${a.toString(16)}`,
  tagOf: () => 'TAG', onlineActors: () => [], isAdmin: () => false, findByName: () => 0, cfg: {}, profileOf: (a) => props.get(`${a}|profileId`),
});
// guilds.js sets its own panel hooks; the stubs go in after it
globalThis.__dboFactionNonceOk = () => true;
globalThis.__dboFactionRefresh = (a, text, ok) => { replies.push({ a, text, ok }); return true; };
require(ECON)({
  mp, log: (...x) => logs.push(x.join(' ')), personal: noop, who: (a) => `P${a.toString(16)}`,
  audit: (t) => { audits.push(t); if (auditThrows && /^ECONOMY /.test(t)) throw new Error('audit channel down'); },
  cfg: { economy: { enabled: true } }, onUi: (ev, f) => handlers.set(ev, f), onlineActors: () => [], every: (n, ms, f) => timers.set(n, f),
  readOfficials: () => ({ bruma: { Count: [1], Guard: [13] } }),
  zoneById: (id) => (id === 'bruma' ? { id: 'bruma', name: 'Bruma' } : null),
});

let failures = 0;
const check = (label, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };
const state = () => globalThis.__dboEconomy.data;
const tick = () => timers.get('economy')();
const failed = () => logs.filter((l) => /reckoning failed/.test(l)).length;

// ---- week 1: a deleted Guardian, a deleted first character of a guard's account ----
now = SUNDAY;
tick();
check('the reckoning ran without throwing', failed() === 0 && state().lastReckoning === SUNDAY, logs.filter((l) => /fail/.test(l)));
check('Lydia paid the tax once: 20% of 10,000', bank(0x20) === 3000, bank(0x20));
check('the Guardian who still exists is paid 1,000 (budget: 75% of 2,000 income = 1,500)', bank(0x41) === 1000 && state().reports['fighters-guild'].wageBudget === 1500, state().reports['fighters-guild']);
check('the deleted Guardian is off the roster and owed nothing', !globalThis.__dboGuildState.members['fighters-guild'][String(0x43)] && !(state().owed['fighters-guild'] || {})['a67'], Object.keys(globalThis.__dboGuildState.members['fighters-guild']));
check('the guild treasury: 20,000 + 2,000 tax - 1,000 wage', treasuries['fighters-guild'] === 21000, treasuries['fighters-guild']);
check('the guard is paid on the account\'s character that exists today, owed wage first', bank(0x24) === 200 && treasuries['county-bruma'] === 1300 && !(state().owed['county-bruma'] || {}).p13, [bank(0x24), treasuries['county-bruma']]);

// The review's loop: ten more minutes change nothing
for (let i = 0; i < 10; i++) { now += 60000; tick(); }
check('ten more minutes charge nothing again and pay nothing again', bank(0x20) === 3000 && bank(0x41) === 1000 && bank(0x24) === 200 && treasuries['fighters-guild'] === 21000 && treasuries['county-bruma'] === 1300);

// ---- week 2: the reckoning throws partway (after the charges, while reporting) ----
now = SUNDAY + 7 * 86400000;
auditThrows = true;
tick();
auditThrows = false;
check('the reckoning failed partway', failed() === 1, logs.filter((l) => /reckoning failed/.test(l)));
check('it was stamped before anything was charged', state().lastReckoning === now);
for (let i = 0; i < 10; i++) { now += 60000; tick(); }
check('a reckoning that threw partway charged exactly once', bank(0x20) === 1000 && bank(0x41) === 2000 && failed() === 1, [bank(0x20), bank(0x41), failed()]);

// ---- weeks 3-6: no income at all (Lydia cannot pay), and the seed is not paid out ----
const seed = treasuries['fighters-guild'];
for (let w = 2; w < 6; w++) { now = SUNDAY + w * 7 * 86400000; tick(); }
check('with no income, four weeks pay no wages from the 22,000 in the treasury', treasuries['fighters-guild'] === seed && bank(0x41) === 2000, [treasuries['fighters-guild'], bank(0x41)]);
// Owed wages add up week by week; paying them later goes through the same income cap, so they cannot drain it either
check('the unpaid wages are owed: four weeks of 1,000', (state().owed['fighters-guild'] || {}).a65 && state().owed['fighters-guild'].a65.gold === 4000, state().owed['fighters-guild']);

// ---- a Guardian demoted to Associate is owed nothing more ----
globalThis.__dboGuildState.members['fighters-guild'][String(0x41)].rank = ASSOCIATE;
now = SUNDAY + 6 * 7 * 86400000; tick();
check('a wage owed for a rank no longer held is dropped', !(state().owed['fighters-guild'] || {}).a65 && logs.some((l) => /dropped 4000 gold owed .* a65 \(Guardian\): no longer holds the rank/.test(l)), state().owed['fighters-guild']);

// ---- the leader forgives what is owed ----
state().owed['fighters-guild'] = { a65: { actor: 0x41, gold: 500, rank: 'Associate' } };
handlers.get('econForgive')(0x41, ['nonce', 'fighters-guild']);
check('only the leader forgives owed wages', /Only the leader/.test(replies[replies.length - 1].text) && state().owed['fighters-guild'].a65);
handlers.get('econForgive')(0x40, ['nonce', 'fighters-guild']);
check('the leader forgives them, and it is audited', /Forgiven: 500/.test(replies[replies.length - 1].text) && !state().owed['fighters-guild'].a65 && audits.some((t) => /forgave 500 gold/.test(t)));

// ---- guilds.js does not empty the rosters when the check itself is broken ----
const saveGet = mp.get;
mp.get = () => { throw new Error('everything fails'); };
globalThis.__dboGuildState.members['county-bruma'] = { 1: { rank: 0 }, 2: { rank: 1 }, 3: { rank: 2 } };
const n = globalThis.__dboGuildPrune();
mp.get = saveGet;
check('a prune where every entry looks deleted removes nothing', n === 0 && Object.keys(globalThis.__dboGuildState.members['county-bruma']).length === 3 && Object.keys(globalThis.__dboGuildState.members['fighters-guild']).length === 2);

console.log('');
console.log(failures ? `${failures} FAILURES` : 'all checks passed');
process.exit(failures ? 1 : 0);
