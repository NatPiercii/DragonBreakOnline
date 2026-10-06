// Who may arrest (playermenu.js isLawful / __dboInstantRestraint, Nate 6 Oct): zone officials as before (not a Court Mage),
// plus an allegiance's leaders, officers and sergeants and a hold's guards by rank title, read from guilds.js; a plain
// member or a Citizen is not lawful, and the 15 s refresh picks up a rank change without a relog. Real guilds.js,
// playermenu.js and guild-defs.json, stub api, in a temp folder.
//
//   node tests/lawful-factions-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const GUILDS = path.join(ROOT, 'guilds.js');
const MENU = path.join(ROOT, 'playermenu.js');
if (!/lawfulByFaction/.test(fs.readFileSync(MENU, 'utf8'))) { require('./expect')('lawful-factions', 'playermenu.js has no faction arrest'); console.log('ok   skipped: playermenu.js has no faction arrest'); process.exit(0); }
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'gamemode-config.json'), 'utf8'));
const dir = fs.mkdtempSync(path.join(fs.existsSync('/dev/shm') ? '/dev/shm' : os.tmpdir(), 'claude-nate-lawful-'));
fs.copyFileSync(path.join(ROOT, 'guild-defs.json'), path.join(dir, 'guild-defs.json'));
process.chdir(dir);

let fails = 0;
const ok = (label, cond, got) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${!cond && got !== undefined ? `: got ${JSON.stringify(got)}` : ''}`); if (!cond) fails++; };

const OFFICER = 0x30, SOLDIER = 0x31, STORMLEAD = 0x32, GUARD = 0x33, CITIZEN = 0x34, MAGE = 0x35, JARLGUARD = 0x36, CAPTAIN = 0x37, TARGET = 0x38;
const names = { [OFFICER]: 'Legate', [SOLDIER]: 'Soldier', [STORMLEAD]: 'Ulfrich', [GUARD]: 'Guard', [CITIZEN]: 'Citizen', [MAGE]: 'Wizard',
  [JARLGUARD]: 'Official Guard', [CAPTAIN]: 'Captain', [TARGET]: 'Target' };
const props = new Map();
const timers = {};
const zoneRanks = { [MAGE]: [{ zone: 'whiterun', rank: 'courtmage' }], [JARLGUARD]: [{ zone: 'whiterun', rank: 'guard' }] };
const api = {
  mp: { get: (id, k) => props.get(`${id}|${k}`), set: (id, k, v) => props.set(`${id}|${k}`, v), getIdFromDesc: () => 0 },
  log: () => {}, personal: () => {}, system: () => {}, audit: () => {}, sendPacket: () => {},
  registerChatCommand: () => {}, onUi: () => {}, openWidget: () => {}, closeWidget: () => {},
  display: (a) => names[a], nameOf: (a) => names[a] || 'Stranger', tagOf: (a) => `T${a.toString(16)}`,
  onlineActors: () => Object.keys(names).map(Number), isAdmin: () => false, isLeadStaff: () => false,
  findByName: () => 0, findAnyByName: () => 0, who: (a) => names[a], cfg: CFG, profileOf: (a) => a,
  ranksOf: (pid) => zoneRanks[pid] || [], giveItem: () => {}, makeProp: () => {}, runCommand: () => {},
  every: (name, ms, fn) => { timers[name] = { ms, fn }; },
};
fs.writeFileSync(path.join(dir, 'guilds.json'), '{}');
require(GUILDS)(api);
let menuOk = true;
try { require(MENU)(api); } catch (e) { menuOk = false; console.log(e.stack); }
ok('playermenu.js loads against the stub', menuOk);

const M = globalThis.__dboGuildState.members;
const rankOf = (fid, title) => globalThis.__dboGuildRankList(fid).findIndex((r) => r.title === title);
const put = (fid, a, title) => { M[fid] = M[fid] || {}; M[fid][String(a)] = { rank: rankOf(fid, title), name: names[a], tag: `T${a.toString(16)}`, since: 1 }; };
put('imperial-legion', OFFICER, 'Legate');
put('imperial-legion', SOLDIER, 'Legionnaire');
put('stormcloaks', STORMLEAD, 'General');
names[CAPTAIN + 0x10] = 'General'; put('imperial-legion', CAPTAIN + 0x10, 'General');
put('hold-whiterun', GUARD, 'Guard');
put('hold-whiterun', CITIZEN, 'Citizen');
put('county-bruma', CAPTAIN, 'Guard Captain');

const tick = () => timers.lawful.fn();
const lawful = (a) => props.get(`${a}|private.dboLawful`) === true;
ok('the lawful refresh runs every 15 s', timers.lawful && timers.lawful.ms === 15000);
tick();
ok('a Legion officer (Legate) is lawful', lawful(OFFICER));
ok('a Legion soldier (Legionnaire, member) is not', !lawful(SOLDIER));
ok('a Stormcloak leader is lawful', lawful(STORMLEAD));
ok('a hold Guard is lawful', lawful(GUARD));
ok('a Guard Captain of Bruma is lawful', lawful(CAPTAIN));
ok('a hold Citizen is not', !lawful(CITIZEN));
ok('a Court Mage (zone rank) is still not', !lawful(MAGE));
ok('a zone-official guard is still lawful', lawful(JARLGUARD));
ok('instant restraint: a Legion officer cuffs at once', globalThis.__dboInstantRestraint(OFFICER, TARGET) === true);
ok('instant restraint: a Legion soldier does not', globalThis.__dboInstantRestraint(SOLDIER, TARGET) === false);
ok('instant restraint: a hold Guard cuffs at once', globalThis.__dboInstantRestraint(GUARD, TARGET) === true);

// A rank change, no relog: the next refresh sees it
let r = globalThis.__dboGuildSetRank(CAPTAIN + 0x10, 'imperial-legion', SOLDIER, rankOf('imperial-legion', 'Centurion'));
ok('the General promotes the soldier to Centurion (sergeant)', !r.error, r);
tick();
ok('the next refresh makes the Centurion lawful', lawful(SOLDIER));
r = globalThis.__dboGuildSetRank(CAPTAIN + 0x10, 'imperial-legion', SOLDIER, rankOf('imperial-legion', 'Auxiliary'));
tick();
ok('demoted to Auxiliary, the next refresh takes it away', !r.error && !lawful(SOLDIER), r);
delete M['hold-whiterun'][String(GUARD)];
tick();
ok('a Guard who leaves the hold is not lawful at the next refresh', !lawful(GUARD));

fs.rmSync(dir, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : 'all ok');
process.exit(fails ? 1 : 0);
