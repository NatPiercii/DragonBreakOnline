// Scripted test for server\lockpick.js (Oblivion-style tumblers). No server and no game: run it from this folder's parent with
//
//   node tests\lockpick-harness.js
//
// It loads the module against a mock mp with a fixed random source and plays locks by sending the widget's reports.
'use strict';
const path = require('path');

const MODULE = path.resolve(__dirname, '..', 'lockpick.js');
// The module's monotonic clock (a client lock's lower bound), under the harness's control
let mono = 1000000;
globalThis.performance = { now: () => mono };
const caps = new Set();
const logs = [];
const A = 0xff000001, DOOR = 0x0a0001, PICK = 0x0000000a;
const props = new Map();
const set = (id, k, v) => props.set(id + '|' + k, v);
const get = (id, k) => props.get(id + '|' + k);
const mp = { get, set, getDescFromId: (id) => (id >>> 0).toString(16) };
let widgets = [];
const ui = {};
const audits = [];
const said = [];
let closes = 0;
const events = [];
globalThis.__alduinakMasteryEvent = (k, a, d) => events.push([k, a, d]);
const load = (cfg) => {
  delete require.cache[require.resolve(MODULE)];
  delete globalThis.__dboLockpick;
  require(MODULE)({
    mp, log: (...x) => logs.push(x.join(' ')), personal: (a, t) => said.push(t), audit: (t) => audits.push(t), who: () => 'P', display: () => 'P',
    openWidget: (a, w) => { widgets.push(w); return true; }, closeWidget: () => { closes++; return true; },
    onUi: (ev, fn) => { ui[ev] = fn; }, cfg, hasUiCap: (a, c) => caps.has(c),
  });
};
const picks = (n) => set(A, 'inventory', { entries: [{ baseId: PICK, count: n }] });
const pickCount = () => ((get(A, 'inventory') || {}).entries || []).reduce((n, e) => n + (e.baseId === PICK ? e.count : 0), 0);
set(A, 'pos', [0, 0, 0]); set(DOOR, 'pos', [100, 0, 0]);
const last = () => widgets[widgets.length - 1];

let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + detail : ''}`); if (!ok) failures++; };

load({});
check('off by default, so old clients keep the dice roll', globalThis.__dboLockpick === null);

const realRandom = Math.random;
let roll = 0.5;
// A hair of drift on every draw, so two locks begun in the same millisecond still get different nonces (the module draws
// a nonce's random part from Math.random); far too small to move a snap roll or a hang time
let drift = 0;
Math.random = () => roll + (drift = (drift + 1e-7) % 1e-4);
load({ lockpick: { enabled: true } });
check('on when switched on', !!globalThis.__dboLockpick);

picks(0);
check('no lockpick, no lock', globalThis.__dboLockpick.begin(A, { target: DOOR, level: 2, label: 'Cell door' }) === false);

picks(3);
let opened = 0;
widgets = [];
globalThis.__dboLockpick.begin(A, { target: DOOR, level: 2, label: 'Cell door', onSuccess: () => { opened++; } });
let w = last();
check('an Adept lock has three tumblers', w.holds.length === 3 && w.set.every((x) => x === false), JSON.stringify(w.holds));
check('a non-Lockpicker gets the base hang time', w.holds[0] === 560 + 0 - 180, w.holds[0]);
check('it is busy while open', globalThis.__dboLockpick.busy(A));

const nonce = w.nonce;
const land = (i) => ui.lockpickTry(A, [nonce, i, 1000, 1000 + w.riseMs + 50]);
ui.lockpickTry(A, [nonce, 1, 1000, 1500]);
check('only the first loose tumbler can be set', last().set[1] === false && last().set[0] === false);
check('...and the stray try is answered, so the widget is not left waiting (it froze on a silent drop)', last() !== w && /loose tumbler/.test(last().notice), last().notice);
land(0);
w = last();
check('a set inside the hang holds the tumbler', w.set[0] === true && w.set[1] === false);

roll = 0.9; // no snap
ui.lockpickTry(A, [nonce, 1, 1000, 1100]);
w = last();
check('too early is a miss, and the pick holds when the roll allows', /pick holds/.test(w.notice) && w.set[0] === true && pickCount() === 3 && !w.done);

roll = 0.1; // snap
ui.lockpickTry(A, [nonce, 1, 1000, 1000 + w.riseMs + w.holds[1] + 500]);
w = last();
check('a snapped pick costs a lockpick and drops the tumblers', pickCount() === 2 && w.set.every((x) => x === false) && /snaps/.test(w.notice) && !w.done);

roll = 0.5;
land(0); w = last(); land(1); w = last(); land(2); w = last();
check('three good sets open the lock', w.done && w.noticeKind === 'win' && opened === 1 && !globalThis.__dboLockpick.busy(A));
check('the Lockpicking skill hears about it', events.some((e) => e[0] === 'lock' && e[2].level === 2) && /picked an Adept cell door/.test(audits[audits.length - 1]));

// the last pick
picks(1);
roll = 0.1;
globalThis.__dboLockpick.begin(A, { target: DOOR, level: 0, label: 'Chest' });
w = last();
ui.lockpickTry(A, [w.nonce, 0, 1000, 1001]);
check('snapping the last pick ends the lock', last().done && last().noticeKind === 'fail' && !globalThis.__dboLockpick.busy(A));

// walking away
picks(2);
roll = 0.5;
globalThis.__dboLockpick.begin(A, { target: DOOR, level: 0, label: 'Chest' });
w = last();
set(A, 'pos', [2000, 0, 0]);
ui.lockpickTry(A, [w.nonce, 0, 1000, 1000 + w.riseMs + 20]);
check('stepping away ends it', last().done && /stepped away/.test(last().notice));
set(A, 'pos', [0, 0, 0]);

// a skilled picker
set(A, 'private.mastery', { order: ['lockpicking'], skills: { lockpicking: { rank: 4 } } });
globalThis.__dboLockpick.begin(A, { target: DOOR, level: 4, label: 'Chest' });
w = last();
check('a Master picker on a Master lock: five tumblers, longer hangs', w.holds.length === 5 && w.holds[0] === 560 + 90 * 5 - 360, w.holds[0]);
ui.lockpickCancel(A, [w.nonce]);
check('leaving ends it', !globalThis.__dboLockpick.busy(A));
set(A, 'private.mastery', null);

// a lock whose client went away (crash, relog) never sends Escape: it must not keep the player busy until a restart
const realNow = Date.now;
let clock = realNow();
Date.now = () => clock;
picks(2);
globalThis.__dboLockpick.begin(A, { target: DOOR, level: 1, label: 'Cell door' });
w = last();
clock += 30000;
check('a lock in play for half a minute still keeps the player busy', globalThis.__dboLockpick.busy(A));
ui.lockpickTry(A, [w.nonce, 0, 1000, 1000 + w.riseMs + 20]);
clock += 45000;
check('a try counts as touching it, so a slow picker is not cut off', globalThis.__dboLockpick.busy(A));
clock += 61000;
check('a lock left a minute with no try is abandoned: the player can pick again', !globalThis.__dboLockpick.busy(A));
check('...and a new lock opens for them', globalThis.__dboLockpick.begin(A, { target: DOOR, level: 0, label: 'Chest' }) === true && last().nonce !== w.nonce);
ui.lockpickCancel(A, [last().nonce]);
Date.now = realNow;

// the pick has to stay in hand: losing the last one mid-lock (dropped, traded, stolen) ends the lock
picks(1);
roll = 0.1; // every mistimed set would snap a pick if there were one
let won = 0;
globalThis.__dboLockpick.begin(A, { target: DOOR, level: 2, label: 'Cell door', onSuccess: () => { won++; } });
w = last();
ui.lockpickTry(A, [w.nonce, 0, 1000, 1000 + w.riseMs + 20]);
check('a first tumbler set with the pick in hand', last().set[0] === true);
picks(0);
ui.lockpickTry(A, [w.nonce, 1, 1000, 1001]);
check('with no pick left a miss does not leave the set tumblers standing', last().done && last().noticeKind === 'fail' && !globalThis.__dboLockpick.busy(A), JSON.stringify({ set: last().set, notice: last().notice }));
ui.lockpickTry(A, [w.nonce, 1, 1000, 1000 + w.riseMs + 20]);
ui.lockpickTry(A, [w.nonce, 2, 1000, 1000 + w.riseMs + 20]);
check('...and the lock cannot then be finished without a pick', won === 0);

// ---- the widget froze (DESIGN.md section 13): every answer must differ from the one before ----
picks(5);
roll = 0.9; // misses never snap
globalThis.__dboLockpick.begin(A, { target: DOOR, level: 2, label: 'Chest' });
w = last();
const notices = [];
for (let k = 0; k < 4; k++) { ui.lockpickTry(A, [w.nonce, 0, 1000, 1001]); notices.push(last().notice); }
check('four misses in a row give four different answers', new Set(notices).size === 4 && /\(2 misses\)/.test(notices[1]), JSON.stringify(notices));
const before = last().notice;
ui.lockpickTry(A, [w.nonce, 2, 1000, 1500]);
const n1 = last().notice;
ui.lockpickTry(A, [w.nonce, 2, 1000, 1500]);
check('two stray tries in a row are answered differently too', n1 !== before && last().notice !== n1, `${before} / ${n1} / ${last().notice}`);
check('...and every answer carries a sequence number for a widget that watches it', typeof last().seq === 'number' && last().seq > 5, String(last().seq));
closes = 0;
ui.close(A, ['escape'], 46);
check('the relay close ends the lock at once (it used to stay busy a minute)', !globalThis.__dboLockpick.busy(A));
ui.lockpickTry(A, [w.nonce, 0, 1000, 1000 + w.riseMs + 20]);
check('a try for a lock that is over closes the waiting window', closes === 1, String(closes));
logs.length = 0;
ui.close(A, ['escape'], 33);
check('a close for another widget is not the lock\'s', closes === 1);

// ---- client-judged locks (lockpick.clientJudged; Jake, 2026-09-30): the widget plays the lock, one report ----
console.log('');
console.log('client-judged:');
const NET = require(path.join(__dirname, 'lib', 'netsim.js'));
caps.add('lockpickLocal');
const RISE = 450, GRACE = 70;
// A lock as the new widget plays it (front minigames-client-judged, FRONT-NOTES.md): push, hold, set, on its own clock;
// tries numbered across the whole lock, a miss on try k snaps the pick when snaps[k] is 1, landed sent as 1 or 0, and
// the lock fails when the last pick snaps or the tries reach maxTries
const playLock = (lw, plan) => {
  const tries = []; let t = 300, set = lw.set.map(() => false), snapped = 0, outcome = 'cancel';
  const picks0 = lw.picks;
  for (const p of plan) {
    if (outcome !== 'cancel') break;
    const k = tries.length;
    const i = set.indexOf(false);
    const held = p === 'hit' ? RISE + Math.floor(lw.holds[i] / 2) : RISE - GRACE - 200;
    tries.push([i, t, t + held, p === 'hit' ? 1 : 0]);
    t += held + 400;
    if (p === 'hit') { set[i] = true; if (set.every(Boolean)) outcome = 'win'; }
    else if (lw.snaps[k]) { snapped++; set = set.map(() => false); if (snapped >= picks0) outcome = 'fail'; }
    if (outcome === 'cancel' && tries.length >= lw.maxTries) outcome = 'fail';
  }
  return { tries, startMs: 0, endMs: t, outcome, snapped };
};
const send = (lw, r, lagMs, outcome, who) => {
  mono = lw._sentAt + (r.endMs - r.startMs) + lagMs;
  (ui.lockpickResult)(who || A, [lw.nonce, outcome || r.outcome, JSON.stringify(r.tries), r.startMs, r.endMs]);
  return logs[logs.length - 1] || '';
};
const beginC = (level, n) => {
  picks(n === undefined ? 3 : n); opened = 0; logs.length = 0;
  globalThis.__dboLockpick.begin(A, { target: DOOR, level, label: 'Chest', onSuccess: () => { opened++; } });
  const lw = last(); lw._sentAt = mono; return lw;
};
roll = 0.9; // no snaps rolled
let lw = beginC(2);
check('a client that names lockpickLocal gets the whole lock to play: judge, grace, the snaps, the try cap', lw.judge === 'client' && lw.graceMs === GRACE && Array.isArray(lw.snaps) && lw.snaps.length === lw.maxTries && lw.maxTries === 200, JSON.stringify({ judge: lw.judge, graceMs: lw.graceMs, n: lw.snaps && lw.snaps.length }));
check('...and its issue is logged', /lockpick issue .* judge=client/.test(logs.join(' | ')), logs.join(' | '));
for (const rtt of NET.REQUIRED) {
  lw = beginC(2);
  const r = playLock(lw, ['hit', 'miss', 'hit', 'hit']);
  const line = send(lw, r, rtt);
  check(`a picked lock is accepted at ${rtt} ms`, /^lockpick win /.test(line) && opened === 1 && !globalThis.__dboLockpick.busy(A), line);
}
{
  const rand = NET.rngOf(31); let changed = 0, n = 0; const seen = [];
  for (const c of NET.matrix()) {
    lw = beginC(1);
    const r = playLock(lw, ['miss', 'hit', 'hit']);
    const line = send(lw, r, NET.arrival(0, 0, c, rand));
    n++; if (!/^lockpick win /.test(line)) { changed++; if (seen.length < 3) seen.push(`${c.name}: ${line}`); }
  }
  check(`no honest verdict changes under ${NET.matrix().length} network conditions`, changed === 0, `${n} locks${seen.length ? ' | ' + seen.join(' | ') : ''}`);
}
// The snaps the server rolled decide the picks, on a cancel too
roll = 0.1; // every miss snaps
lw = beginC(2, 3);
{
  const r = playLock(lw, ['hit', 'miss', 'hit', 'miss']);
  const line = send(lw, r, 400, 'cancel');
  check('a cancel after two snapped picks still takes both picks', /^lockpick cancel /.test(line) && pickCount() === 1 && opened === 0, `${line} picks=${pickCount()}`);
}
lw = beginC(0, 2);
{
  const r = playLock(lw, ['miss', 'miss']);
  const line = send(lw, r, 400);
  check('snapping the last pick fails the lock', /^lockpick fail /.test(line) && pickCount() === 0 && last().noticeKind === 'fail', line);
}
roll = 0.9;
// One report per lock; nonces never issued
lw = beginC(1);
{
  const r = playLock(lw, ['hit', 'hit']);
  send(lw, r, 400);
  const line = send(lw, r, 900);
  check('a second result for the same lock opens nothing (replay)', /lockpick replay/.test(line) && opened === 1, line);
}
lw = beginC(1);
{
  const r = playLock(lw, ['hit', 'hit']);
  const line = send(Object.assign({}, lw, { nonce: 'ff000001-forged' }), r, 400);
  check('a result for a nonce this player was never issued opens nothing', /lockpick ignored .*another lock is live/.test(line) && opened === 0, line);
  const line2 = send(lw, r, 400, undefined, 0xff000002);
  check("another player's result on this lock opens nothing", /lockpick ignored .*no lock/.test(line2) && opened === 0, line2);
  const line3 = send(lw, r, 400);
  check('...and the lock is still there for its own picker', /^lockpick win /.test(line3) && opened === 1, line3);
}
// Impossible durations: a set before the tumbler can reach the top; a lock reported before it could be picked
lw = beginC(1);
{
  const r = { tries: [[0, 100, 150, true], [1, 200, 250, true]], startMs: 0, endMs: 260, outcome: 'win' };
  const line = send(lw, r, 400);
  check('sets that come before a tumbler could rise are refused(fast)', /^lockpick refused\(fast\)/.test(line) && opened === 0, line);
}
lw = beginC(1);
{
  const r = playLock(lw, ['hit', 'hit']);
  mono = lw._sentAt + 100;
  ui.lockpickResult(A, [lw.nonce, 'win', JSON.stringify(r.tries), r.startMs, r.endMs]);
  check('a win the server got 100 ms after it sent the lock is refused(fast)', /^lockpick refused\(fast\)/.test(logs[logs.length - 1]) && opened === 0, logs[logs.length - 1]);
}
// The outcome must be what the tries add up to; the try cap; the pick still in hand
lw = beginC(1);
{
  const r = playLock(lw, ['hit', 'miss']);
  const line = send(lw, r, 400, 'win');
  check('a win the tries do not add up to is refused(inconsistent)', /^lockpick refused\(inconsistent\)/.test(line) && opened === 0, line);
}
lw = beginC(1);
{
  const r = playLock(lw, ['hit', 'hit']);
  picks(0);
  const line = send(lw, r, 400);
  check('a win with no pick left in hand opens nothing', /^lockpick fail /.test(line) && opened === 0, line);
}
// Stepping away, a mismatch, a cancel overtaken by its result, the 10-minute cleanup
lw = beginC(1);
{
  const r = playLock(lw, ['hit', 'hit']);
  set(A, 'pos', [2000, 0, 0]);
  const line = send(lw, r, 400);
  set(A, 'pos', [0, 0, 0]);
  check('a win reported 2000 units from the lock is refused(far)', /^lockpick refused\(far\)/.test(line) && opened === 0, line);
}
lw = beginC(1);
{
  const r = playLock(lw, ['hit', 'hit']);
  r.tries[1] = [1, r.tries[1][1], r.tries[1][1] + 5000, true]; r.endMs = r.tries[1][2] + 10;
  const line = send(lw, r, 400);
  check("replayCheck 'log': a set the hang times do not bear out stands, flagged and audited", /^lockpick win .*sus=mismatch/.test(line) && audits.some((t) => /^LOCKPICK-MISMATCH /.test(t)), line);
}
load({ lockpick: { enabled: true, replayCheck: 'refuse' } });
lw = beginC(1);
{
  const r = playLock(lw, ['hit', 'hit']);
  r.tries[1] = [1, r.tries[1][1], r.tries[1][1] + 5000, 1]; r.endMs = r.tries[1][2] + 10;
  const line = send(lw, r, 400);
  check("replayCheck 'refuse': the same lock is refused(mismatch), not opened", /^lockpick refused\(mismatch\)/.test(line) && opened === 0, line);
}
load({ lockpick: { enabled: true, maxTries: 3 } });
lw = beginC(2);
{
  const r = playLock(lw, ['miss', 'miss', 'miss']);
  const line = send(lw, r, 400);
  check('the tries reaching maxTries fail the lock, as the widget plays it', lw.maxTries === 3 && lw.snaps.length === 3 && r.outcome === 'fail' && /^lockpick fail /.test(line) && opened === 0 && /lock still holds/.test(last().notice), `${line} / ${last().notice}`);
}
load({ lockpick: { enabled: true } });
lw = beginC(1);
{
  const r = playLock(lw, ['hit', 'hit']);
  r.tries[0][3] = 2;
  const line = send(lw, r, 400);
  check('a try whose landed is not 1, 0, true or false is refused(shape)', /^lockpick refused\(shape\)/.test(line) && opened === 0, line);
}
lw = beginC(1);
check('the snaps go to the widget as 0 and 1, one per try', lw.snaps.every((x) => x === 0 || x === 1));
{
  const r = playLock(lw, ['hit', 'hit']);
  ui.lockpickCancel(A, [lw.nonce]);
  check('Leave it ends the lock at once', !globalThis.__dboLockpick.busy(A));
  const line = send(lw, r, 400);
  check('...and a result that lands after it is still judged (sent first, overtaken)', /^lockpick win .*after-close/.test(line) && opened === 1, line);
}
{
  const realNow2 = Date.now; let clock2 = realNow2(); Date.now = () => clock2;
  lw = beginC(1);
  clock2 += 5 * 60000; widgets = [];
  check('a client lock is still live after 5 minutes (its widget does not talk until it ends)', globalThis.__dboLockpick.busy(A));
  check('...and asking for another lock draws it again (a lost window)', widgets.length === 1 && widgets[0].nonce === lw.nonce);
  clock2 += 6 * 60000;
  check('after 10 minutes it is cleaned up', !globalThis.__dboLockpick.busy(A) && /lockpick expired .* no report/.test(logs.join(' | ')), logs.slice(-1)[0]);
  Date.now = realNow2;
}
// Rollback: with the switch off a new lock is played try by try, as before
load({ lockpick: { enabled: true, clientJudged: false } });
lw = beginC(1);
check('rollback (clientJudged false): the lock is played try by try again, whatever the client can do', lw.judge === undefined && lw.snaps === undefined);
ui.lockpickTry(A, [lw.nonce, 0, 1000, 1000 + RISE + 20]);
check('...and a try is judged by the server as before', last().set[0] === true);
ui.lockpickCancel(A, [lw.nonce]);
caps.delete('lockpickLocal');
load({ lockpick: { enabled: true } });
lw = beginC(1);
check('a client without lockpickLocal is played try by try even with the switch on', lw.judge === undefined);
ui.lockpickCancel(A, [lw.nonce]);

Math.random = realRandom;
console.log('');
console.log(failures ? `${failures} FAILURES` : 'all checks passed');
process.exit(failures ? 1 : 0);
