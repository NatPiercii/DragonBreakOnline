// Scripted test for the party panel across a crash: loads the real server\dungeons.js with a mock gamemode api,
// forms a party of two, drops one member (crash), brings the same profile back on a new actor and checks that
// both clients are sent a dboParty list naming the new actor. No server and no game: run it from this folder's parent with
//
//   node tests\party-reconnect-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const DUNGEONS = path.resolve(__dirname, '..', 'dungeons.js');
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'party-harness-')));

const timers = [];
global.setTimeout = (fn, ms) => { timers.push(fn); return timers.length; };
const runTimers = () => { while (timers.length) timers.shift()(); };

const A = 0x14, B = 0x15, A2 = 0x30;
const profile = new Map([[A, 1], [B, 2], [A2, 1]]);
let online = [A, B];
const props = new Map();
const sent = [];
globalThis.__dboSetParty = (actorId, members) => sent.push({ to: actorId, ids: members.map((m) => m.id) });

const commands = new Map();
require(DUNGEONS)({
  mp: { get: (id, p) => (p === 'profileId' ? profile.get(id) : props.get(id + '|' + p)), set: (id, p, v) => props.set(id + '|' + p, v), getIdFromDesc: () => 0 },
  log: () => {}, personal: () => {}, system: () => {}, audit: () => {},
  registerChatCommand: (n, fn) => commands.set(n, fn), onUi: () => {}, openWidget: () => true, closeWidget: () => true,
  sendPacket: () => true, findByName: (n) => ({ a: A, b: B }[n] || 0), display: (a) => `P${a.toString(16)}`, who: (a) => `P${a.toString(16)}`,
  profileOf: (a) => (profile.has(a) ? profile.get(a) : -1), nameOf: (a) => `P${a.toString(16)}`, onlineActors: () => online.slice(),
  isAdmin: () => false, giveItem: () => true, cfg: {}, every: () => {},
});

let failures = 0;
const check = (label, ok) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`); if (!ok) failures++; };
const lastTo = (actor) => { for (let i = sent.length - 1; i >= 0; i--) if (sent[i].to === actor) return sent[i].ids; return null; };
const same = (x, y) => !!x && x.length === y.length && x.every((v) => y.includes(v));

commands.get('party')(A, 'invite b');
commands.get('party')(B, 'accept');
check('party formed: A sees A and B', same(lastTo(A), [A, B]));
check('party formed: B sees A and B', same(lastTo(B), [A, B]));

// A crashes: the gamemode's disconnect handler calls __dboPartyLogout while A is still listed online
sent.length = 0;
globalThis.__dboPartyLogout(A);
online = [B];
runTimers();
check('after the crash B sees only B', same(lastTo(B), [B]));

// A logs back in on a new actor; the gamemode's login block calls __dboPartyLogin
sent.length = 0;
online = [A2, B];
globalThis.__dboPartyLogin(A2);
check('returning client is sent the party (A2 and B)', same(lastTo(A2), [A2, B]));
check('B is sent the new actor id (A2 and B)', same(lastTo(B), [A2, B]));

// A player with no party gets an empty list, so a client that switched character drops the old panel
sent.length = 0;
profile.set(0x40, 9); online = [A2, B, 0x40];
globalThis.__dboPartyLogin(0x40);
check('no party: an empty list is sent', same(lastTo(0x40), []));

console.log(failures ? `${failures} failure(s)` : 'all passed');
process.exit(failures ? 1 : 0);
