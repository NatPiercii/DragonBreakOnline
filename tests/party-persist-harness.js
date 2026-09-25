// Scripted test for parties across a server restart: loads the real server\dungeons.js with a mock gamemode api, forms a
// party, "restarts" (drops the in-memory state and loads the module again, as a new server process would) and checks the
// party comes back from parties.json by profile; a stale or broken file restores nothing. No server and no game: run it
// from this folder's parent with
//
//   node tests\party-persist-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const DUNGEONS = path.resolve(__dirname, '..', 'dungeons.js');
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'party-persist-')));

const timers = [];
global.setTimeout = (fn, ms) => { timers.push(fn); return timers.length; };
let now = 1790000000000;
Date.now = () => now;

const A = 0x14, B = 0x15, C = 0x16, A2 = 0x30, B2 = 0x31;
const profile = new Map([[A, 1], [B, 2], [C, 3], [A2, 1], [B2, 2]]);
let online = [A, B, C];
const props = new Map();
const sent = [];
const logs = [];
globalThis.__dboSetParty = (actorId, members) => sent.push({ to: actorId, ids: members.map((m) => m.id) });
let commands = new Map();
const load = () => {
  commands = new Map();
  delete require.cache[DUNGEONS];
  require(DUNGEONS)({
    mp: { get: (id, p) => (p === 'profileId' ? profile.get(id) : props.get(id + '|' + p)), set: (id, p, v) => props.set(id + '|' + p, v), getIdFromDesc: () => 0 },
    log: (...x) => logs.push(x.join(' ')), personal: () => {}, system: () => {}, audit: () => {},
    registerChatCommand: (n, fn) => commands.set(n, fn), onUi: () => {}, openWidget: () => true, closeWidget: () => true,
    sendPacket: () => true, findByName: (n) => ({ a: A, b: B, c: C }[n] || 0), display: (a) => `P${a.toString(16)}`, who: (a) => `P${a.toString(16)}`,
    profileOf: (a) => (profile.has(a) ? profile.get(a) : -1), nameOf: (a) => `P${a.toString(16)}`, onlineActors: () => online.slice(),
    isAdmin: () => false, giveItem: () => true, cfg: {}, every: () => {},
  });
};
// A new server process: nothing in memory survives, only files
const restart = () => {
  delete globalThis.__dboDungeons; delete globalThis.__dboPartiesLoaded; delete globalThis.__dboDungeonsBooted;
  sent.length = 0; logs.length = 0;
  load();
};

let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail !== undefined ? '   ' + detail : ''}`); if (!ok) failures++; };
const leaderOf = (a) => globalThis.__dboPartyLeaderOf(a);
const saved = () => JSON.parse(fs.readFileSync('parties.json', 'utf8'));

load();
commands.get('party')(A, 'invite b');
commands.get('party')(B, 'accept');
check('forming a party writes parties.json', fs.existsSync('parties.json') && saved().parties.length === 1);
check('the file names the members by profile', JSON.stringify(saved().parties[0].members.sort()) === '[1,2]' && saved().parties[0].leader === 1);

// crash and restart: both come back on new actors
restart();
online = [A2, B2];
check('after a restart the party is back (by profile)', leaderOf(A2) === 1 && leaderOf(B2) === 1);
check('the restore is logged', logs.some((l) => /parties: 1 restored/.test(l)), logs.find((l) => /parties/.test(l)));
globalThis.__dboPartyLogin(A2);
check('the returning client is sent its party', sent.some((s) => s.to === A2 && s.ids.includes(A2) && s.ids.includes(B2)));

// a hot reload in the same process does not load the file again (the in-memory parties are newer)
commands.get('leave')(B2);
check('leaving updates the file (a party of one breaks up)', saved().parties.length === 0);
delete require.cache[DUNGEONS]; load();
check('a hot reload does not bring back the party from the file', leaderOf(A2) === null);

// leader handover is saved under the new leader
online = [A, B, C];
commands.get('party')(A, 'invite b'); commands.get('party')(B, 'accept');
commands.get('party')(A, 'invite c'); commands.get('party')(C, 'accept');
commands.get('leave')(A);
check('the new leader is saved', saved().parties.length === 1 && saved().parties[0].leader === 2 && JSON.stringify(saved().parties[0].members.sort()) === '[2,3]');
restart();
check('restored under the new leader', leaderOf(B) === 2 && leaderOf(C) === 2 && leaderOf(A) === null);

// kicked members are gone from the file
commands.get('party')(B, 'kick c');
check('a kick breaks the party of two and is saved', saved().parties.length === 0);

// a stale file is ignored
commands.get('party')(A, 'invite b'); commands.get('party')(B, 'accept');
now += 13 * 3600000;
restart();
check('a file older than 12 hours restores nothing', leaderOf(A) === null && logs.some((l) => /not restored/.test(l)));

// a broken file is ignored and logged
fs.writeFileSync('parties.json', '{not json');
restart();
check('a broken file restores nothing and is logged', leaderOf(A) === null && logs.some((l) => /parties.json unreadable/.test(l)));

// a malformed entry (leader not a member, or alone) is skipped
fs.writeFileSync('parties.json', JSON.stringify({ savedAt: now, parties: [{ leader: 1, members: [2, 3] }, { leader: 1, members: [1] }, { leader: 2, members: [2, 3] }] }));
restart();
check('only the well-formed party is restored', leaderOf(B) === 2 && leaderOf(C) === 2 && leaderOf(A) === null);

// no file at all: nothing, no complaint
fs.unlinkSync('parties.json');
restart();
check('no file: nothing restored, nothing logged about it', leaderOf(A) === null && !logs.some((l) => /parties/.test(l) && /unreadable|restored/.test(l)));

console.log(failures ? `${failures} failure(s)` : 'all passed');
process.exit(failures ? 1 : 0);
