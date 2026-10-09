// The journal's Profile buttons (Nate, 9 Oct: "build all four"): Report a problem, Call a GM, Unstuck and the level
// points. journal.js journalAction [nonce, action, text] runs /bug's report or the chat command's own handler through
// gamemode.js __dboRunCommand, so refusals, cooldowns and replies are the command's; the reply lands in the footer and the
// tab is drawn again. Loads the real journal.js, and the real __dboRunCommand and personal() sliced out of gamemode.js.
//   node tests/journal-actions-harness.js   (from server/)
'use strict';
const fs = require('fs');
const path = require('path');
process.chdir(path.resolve(__dirname, '..'));
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got).slice(0, 600)}`); if (!c) fails++; };

let now = 1_900_000_000_000;
Date.now = () => now;
const pending = [];
global.setTimeout = (fn, ms) => { pending.push({ fn, at: now + (Number(ms) || 0) }); return 0; };
const runDue = () => { for (let i = 0; i < pending.length;) { if (pending[i].at <= now) pending.splice(i, 1)[0].fn(); else i++; } };
const later = (ms) => { now += ms; runDue(); };

// ---- gamemode.js: the command runner and personal()'s capture, as written there ----
const gm = fs.readFileSync('gamemode.js', 'utf8');
const personalLine = gm.match(/^const personal = \(actorId, text\) => .*$/m)[0];
const runner = gm.slice(gm.indexOf('globalThis.__dboRunCommand = '), gm.indexOf('// An old name that still reaches its command.'));
const chat = [];
const commands = new Map();
const admins = new Set();
new Function('commands', 'isAdmin', 'log', 'noteTold', 'deliver', `${personalLine.replace('const personal', 'globalThis.__gmPersonal')}\n${runner}`)(
  commands, (a) => admins.has(a), () => {}, () => {}, (a, t) => chat.push([a, t]));
const personal = globalThis.__gmPersonal;
const A = 0xff000030, STAFF = 0xff000031;
let unstuckAt = 0, points = 2, gmCalls = [];
commands.set('unstuck', { fn: (a) => { if (now - unstuckAt < 30 * 60000) return personal(a, '/unstuck is ready again in 30 minutes.'); unstuckAt = now; personal(a, 'You find your way back to safety.'); } });
commands.set('level', { fn: (a, args) => { const [stat, n] = String(args).split(' '); if (points < 1) return personal(a, 'You have no points to spend.'); points -= Number(n) || 1; personal(a, `+10 ${stat}.${points ? ` ${points} more to spend.` : ''}`); } });
commands.set('gm', { fn: (a, args) => { gmCalls.push(args); personal(a, 'A GM has been called.'); } });
commands.set('kick', { fn: () => personal(A, 'kicked'), admin: true });
ok(JSON.stringify(globalThis.__dboRunCommand(A, 'unstuck', '')) === JSON.stringify(['You find your way back to safety.']) && chat.length === 1,
  '__dboRunCommand runs the command\'s own handler and hands back what it told the player (who still gets it in chat)');
ok(globalThis.__dboRunCommand(A, 'kick', 'x') === null, '...a staff command from a player is refused, as in chat');
ok(globalThis.__dboRunCommand(A, 'nosuch', '') === null, '...an unknown command is nothing');
unstuckAt = 0;

// ---- journal.js ----
const props = new Map([[`${A}|appearance`, { name: 'Aela', raceId: 0x13746 }]]);
const mp = { get: (a, k) => props.get(`${a}|${k}`), set: (a, k, v) => props.set(`${a}|${k}`, v), getIdFromDesc: (d) => parseInt(String(d), 16) >>> 0,
  getDescFromId: (id) => String(id), lookupEspmRecordById: () => null, callPapyrusFunction: () => {} };
globalThis.__dboJournalDoc = { of: () => ({}), touch: () => {} };
globalThis.__dboClock = { summary: () => ({ hour: 12, day: 1, month: 'Morning Star', year: 211, phaseName: '' }) };
globalThis.__dboCharLevelPending = () => points;
const reports = [];
globalThis.__dboBugReport = (a, text) => { reports.push(text); return { ok: true, text: 'Your report is sent. Thank you.' }; };
delete globalThis.__dboJournal; delete globalThis.__dboJournalSections;
const widgets = [], ui = new Map();
const SKILLS = JSON.parse(fs.readFileSync('skills.json', 'utf8'));
require(path.resolve('journal.js'))({ mp, log: () => {}, personal: () => {}, display: String, who: String, openWidget: (a, w) => { widgets.push(w); return true; },
  closeWidget: () => true, onUi: (ev, fn) => ui.set(ev, (ui.get(ev) || []).concat(fn)), every: () => {}, onlineActors: () => [A], isAdmin: () => false,
  nameOf: (a) => (props.get(`${a}|appearance`) || {}).name, sendPacket: () => {}, cfg: {}, skills: SKILLS.skills, hasCap: () => true });
const fire = (ev, a, args) => (ui.get(ev) || []).forEach((fn) => fn(a, args, 50));
const last = () => widgets[widgets.length - 1];
ok(globalThis.__dboJournalOpenTab(A, 'profile') !== false && last().profile && last().profile.levelPoints === 2, 'the Profile tab says how many level points wait (for its +1 buttons)', last() && last().profile && last().profile.levelPoints);
const act = (action, text) => { later(4000); const w = last(); fire('journalAction', A, [w.nonce, action, text]); later(4000); return last(); };

let w = act('level:health');
ok(points === 1 && w.result === '+10 health. 1 more to spend.' && w.resultKind === 'ok' && w.profile.levelPoints === 1, '+1 Health spends one point through /level, says so, and the tab shows the new count', [w.result, w.profile && w.profile.levelPoints]);
w = act('level:stamina'); w = act('level:magicka');
ok(points === 0 && w.result === 'You have no points to spend.', '...and /level\'s own refusal when none are left', w.result);
w = act('unstuck');
ok(w.result === 'You find your way back to safety.' && w.tab === 'profile', 'Unstuck runs /unstuck', w.result);
w = act('unstuck');
ok(/ready again in 30 minutes/.test(w.result), '...with its cooldown, unchanged', w.result);
w = act('gm', 'stuck in a wall at the inn');
ok(gmCalls[0] === 'call stuck in a wall at the inn' && w.result === 'A GM has been called.', 'Call a GM sends the text through /gm call (staff get a call too, not the usage)', gmCalls);
w = act('gm', '  ');
ok(gmCalls.length === 1 && /Say what you need/.test(w.result) && w.resultKind === 'refused', '...and needs something to say');
w = act('report', 'the wolf near me is floating');
ok(reports[0] === 'the wolf near me is floating' && /report is sent/.test(w.result), 'Report a problem is /bug\'s report (debugsnap.js)', reports);
w = act('kick', 'x');
ok(w.resultKind === 'refused' && /Unknown action/.test(w.result), 'nothing but these actions can be run from the journal', w.result);
const n = widgets.length; fire('journalAction', A, ['stale', 'unstuck']); later(4000);
ok(widgets.length === n, 'a stale nonce does nothing');
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
