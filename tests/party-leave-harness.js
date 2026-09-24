// Scripted test for leaving a party: loads the real server\dungeons.js with a mock gamemode api and checks /leave,
// /party leave and the panel's partyLeave event, leadership passing to the next member, the last member dissolving
// the party, stale invites from a departed leader, and that every panel is resent. Run from this folder's parent with
//
//   node tests\party-leave-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const DUNGEONS = path.resolve(__dirname, '..', 'dungeons.js');
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'party-leave-harness-')));

global.setTimeout = () => 0;

const A = 0x14, B = 0x15, C = 0x16, D = 0x17;
const profile = new Map([[A, 1], [B, 2], [C, 3], [D, 4]]);
const byName = { a: A, b: B, c: C, d: D };
const props = new Map();
const panels = new Map();
const said = [];
globalThis.__dboSetParty = (actorId, members) => panels.set(actorId, members.map((m) => ({ id: m.id, leader: !!m.leader })));

const commands = new Map();
const ui = new Map();
const note = (a, text) => said.push({ to: a, text });
require(DUNGEONS)({
  mp: { get: (id, p) => (p === 'profileId' ? profile.get(id) : props.get(id + '|' + p)), set: (id, p, v) => props.set(id + '|' + p, v), getIdFromDesc: () => 0 },
  log: () => {}, personal: note, system: note, audit: () => {},
  registerChatCommand: (n, fn) => commands.set(n, fn), onUi: (n, fn) => ui.set(n, fn), openWidget: () => true, closeWidget: () => true,
  sendPacket: () => true, findByName: (n) => byName[n] || 0, display: (a) => `P${a.toString(16)}`, who: (a) => `P${a.toString(16)}`,
  profileOf: (a) => (profile.has(a) ? profile.get(a) : -1), nameOf: (a) => `P${a.toString(16)}`, onlineActors: () => [A, B, C, D],
  isAdmin: () => false, giveItem: () => true, cfg: {}, every: () => {},
});

let failures = 0;
const check = (label, ok) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`); if (!ok) failures++; };
const ids = (a) => (panels.get(a) || []).map((m) => m.id).sort();
const leaderShown = (a) => { const l = (panels.get(a) || []).find((m) => m.leader); return l ? l.id : 0; };
const same = (x, y) => x.length === y.length && x.every((v, i) => v === y.slice().sort()[i]);
const heard = (a, re) => said.some((s) => s.to === a && re.test(s.text));
const leaderOf = (a) => globalThis.__dboPartyLeaderOf(a);
const party = (cmd, a, args) => commands.get(cmd)(a, args || '');

check('/leave and the partyLeave ui event are registered', commands.has('leave') && ui.has('partyLeave'));

party('party', A, 'invite b'); party('party', B, 'accept');
party('party', A, 'invite c'); party('party', C, 'accept');
check('party of three led by A', leaderOf(C) === 1 && same(ids(C), [A, B, C]));

// A member leaves: the rest keep the party and see it without them
said.length = 0;
party('leave', C);
check('C is out of the party', leaderOf(C) === null && ids(C).length === 0);
check('A and B still see A and B', same(ids(A), [A, B]) && same(ids(B), [A, B]));
check('C is told and the others hear it', heard(C, /You left the party/) && heard(A, /P16 left the party/));

// The leader leaves a party of three: leadership passes to the longest-standing member
party('party', A, 'invite c'); party('party', C, 'accept');
party('party', A, 'invite d');
said.length = 0;
party('party', A, 'leave');
check('/party leave by the leader hands the party to B', leaderOf(B) === 2 && leaderOf(C) === 2 && leaderOf(A) === null);
check('B and C panels show B as leader', leaderShown(B) === B && leaderShown(C) === B && same(ids(B), [B, C]));
check('A panel is cleared', ids(A).length === 0);
check('B is told they lead', heard(B, /You now lead the party/) && heard(C, /P15 now leads it/));
party('party', D, 'accept');
check("the departed leader's invite no longer works", leaderOf(D) === null && heard(D, /No open invitation/));

// The new leader can invite and kick
party('party', B, 'invite d'); party('party', D, 'accept');
check('new leader B invites D', leaderOf(D) === 2 && same(ids(D), [B, C, D]));
party('party', B, 'kick d');
check('new leader B kicks D', leaderOf(D) === null && same(ids(B), [B, C]));

// The panel button: C leaves through the ui event, leaving B alone, which dissolves the party
said.length = 0;
ui.get('partyLeave')(C, [], 0);
check('last member left: the party is gone', leaderOf(B) === null && leaderOf(C) === null);
check('both panels are cleared', ids(B).length === 0 && ids(C).length === 0);
check('B hears the party broke up', heard(B, /broken up/));
said.length = 0;
party('leave', B);
check('/leave outside a party says so', heard(B, /not in a party/));

console.log(failures ? `${failures} failure(s)` : 'all passed');
process.exit(failures ? 1 : 0);
