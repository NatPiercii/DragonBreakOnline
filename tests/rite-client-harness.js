// The rite judged on the player's machine (supernatural.js; Jake, 2026-09-30, DESIGN.md section 4.6 in
// /opt/dragonbreak-handover/minigames-client-judged). Loads the real supernatural.js against a stub api with its clocks
// and timers under the harness's control, opens Molag Bal's Embrace with /rite, and strikes the way each widget does:
// a client that names 'riteJudge' reports its own press time and verdict; today's widget sends only "struck" and is
// judged by when that arrives. Fake network: tests/lib/netsim.js.
//   node tests/rite-client-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const NET = require(path.join(__dirname, 'lib', 'netsim.js'));
// supernatural.js keeps the Blood Crown in supernatural.json in the working directory: run in a temp dir
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rite-client-'));
const MODULE = path.resolve(__dirname, '..', 'supernatural.js');
process.chdir(dir);
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });

// Both clocks the module reads, and its timers, belong to the harness: Date.now (the rite's startsAt, the old widget's
// arrival judging) and performance.now (the new widget's lower bound) move together; a timer fires only when run.
let clock = 1780000000000, mono = 5000000;
const realNow = Date.now;
Date.now = () => clock;
globalThis.performance = { now: () => mono };
const advance = (ms) => { clock += ms; mono += ms; };
const pending = new Map(); let timerSeq = 0;
globalThis.setTimeout = (fn, ms) => { const id = ++timerSeq; pending.set(id, { fn, at: clock + ms, ms }); return id; };
globalThis.clearTimeout = (id) => { pending.delete(id); };
const fireDue = () => { for (const [id, t] of [...pending]) if (t.at <= clock) { pending.delete(id); t.fn(); } };

const store = new Map();
const logs = [], audits = [], said = [], widgets = [];
const cmds = {}, ui = {}, timers = {};
const caps = new Set();
const mp = {
  get: (id, p) => store.get(`${id}|${p}`),
  set: (id, p, v) => { store.set(`${id}|${p}`, v); },
  getDescFromId: (id) => `${id.toString(16)}:x`, getIdFromDesc: () => 0x1234, callPapyrusFunction: () => null, lookupEspmRecordById: () => null,
};
let cfg = {};
const load = () => {
  delete require.cache[MODULE];
  require(MODULE)({
    mp, log: (...x) => logs.push(x.join(' ')), audit: (t) => audits.push(t), personal: (a, t) => said.push(t), registerChatCommand: (n, f) => { cmds[n] = f; },
    onUi: (n, f) => { ui[n] = f; }, openWidget: (a, w) => { widgets.push(w); return true; }, closeWidget: () => true, sendPacket: () => {}, display: String, who: String,
    isAdmin: () => false, findByName: () => null, onlineActors: () => [], every: (n, ms, fn) => { timers[n] = fn; }, profileOf: (a) => a,
    nameOf: String, isWorldspace: () => true, needsFeed: () => {}, hungerOf: () => 0, cfg, hasUiCap: (a, c) => caps.has(c),
  });
};
load();

let fail = 0;
const ok = (c, what, got) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${what}${got !== undefined ? '   ' + (typeof got === 'string' ? got : JSON.stringify(got)) : ''}`); if (!c) fail++; };
const A = 7;
const rite = () => globalThis.__dboRites.get(A);
const lastW = () => widgets[widgets.length - 1];
const roundLines = () => logs.filter((l) => /supernatural: rite .* round \d\/\d/.test(l));
const lastRound = () => roundLines().slice(-1)[0] || '';
// Molag Bal's Embrace, from the shrine, as rite-disconnect-harness opens it
const begin = () => {
  store.clear(); globalThis.__dboRites.clear(); pending.clear(); widgets.length = 0;
  store.set(`${A}|isDead`, false);
  globalThis.__dboPrayerLastShrine = new Map([[A, { deityId: 'molagbal', at: Date.now() }]]);
  cmds.rite(A, ''); cmds.rite(A, 'confirm');
  return rite();
};
const markerAt = (rd, t) => { const ph = (((t % rd.period) + rd.period) % rd.period) / rd.period; return ph < 0.5 ? ph * 2 : 2 - ph * 2; };
// A press time on the widget's clock (ms after the marker began) that sits on the zone's centre line, and one far off it
const centreAt = (rd) => { for (let t = 300; t < 7000; t++) if (Math.abs(markerAt(rd, t) - rd.center) < 0.004) return t; return -1; };
const offAt = (rd) => { for (let t = 300; t < 7000; t++) if (Math.abs(markerAt(rd, t) - rd.center) > rd.width / 2 + 0.25) return t; return -1; };
// The new widget: the round packet takes `down` to arrive, the marker starts startsIn later, the player presses at press
// (widget ms), the report takes `up` back. It says hit or miss itself.
const strikeNew = (r, press, opt) => {
  const o = Object.assign({ down: 0, up: 0, claim: undefined, round: r.round + 1, rnonce: r.current.rnonce }, opt || {});
  const rd = r.current;
  const claim = o.claim !== undefined ? o.claim : Math.abs(markerAt(rd, press) - rd.center) <= rd.width / 2 ? 'hit' : 'miss';
  const sent = rd.sentAt;
  const t = sent + o.down + 700 + press + o.up;
  advance(t - mono);
  // atMs: ms since the round's packet arrived (the marker starts startsIn = 700 ms after it)
  ui.riteStrike(A, [r.nonce, o.round, o.rnonce, claim, press, 700 + press, markerAt(rd, press)]);
};
// Today's widget: it only says "struck"; the server judges by arrival. Its marker starts when its packet arrives + startsIn.
const strikeOld = (r, press, rtt) => {
  const rd = r.current;
  const t = (rd.startsAt) + rtt / 2 + press + rtt / 2;
  advance(t - clock);
  ui.riteStrike(A, [r.nonce]);
};

// ---- the config merge (a prerequisite) ----
cfg = { supernatural: { rite: { clientJudged: false } } };
load();
let r = begin();
ok(!!r && r.current && r.current.period > 0, 'a partial rite override keeps rounds, need and leadMs (merged key by key)', r && r.current);
ok(lastW().rounds === 5 && lastW().need === 4, '...the widget is told 5 rounds, 4 needed', { rounds: lastW().rounds, need: lastW().need });
globalThis.__dboRites.clear();

// ---- the new widget (riteJudge): it judges, lag never decides ----
cfg = {}; load();
caps.add('riteJudge');
r = begin();
ok(r.client === true && lastW().judge === 'client' && typeof lastW().rnonce === 'string' && lastW().graceMs === 100 && lastW().limitMs === 7000, 'a client that names riteJudge is told it judges, with the round nonce, grace and limit', { judge: lastW().judge, rnonce: lastW().rnonce, graceMs: lastW().graceMs });
ok(/began Molag Bal's Embrace judge=client/.test(logs.join(' | ')), '...and the rite says who judges');
for (const rtt of NET.REQUIRED) {
  r = begin();
  const p = centreAt(r.current);
  strikeNew(r, p, { down: rtt / 2, up: rtt / 2 });
  ok(/round 1\/5 hit/.test(lastRound()) && / judge=client/.test(lastRound()) && new RegExp(` lag=${rtt}( |$)`).test(lastRound()) && rite().hits === 1, `a strike on the centre line is a hit at ${rtt} ms (and its lag is logged as ${rtt})`, lastRound());
  const q = offAt(rite().current);
  strikeNew(rite(), q, { down: rtt / 2, up: rtt / 2 });
  ok(/round 2\/5 miss \(off the mark\)/.test(lastRound()) && rite().misses === 1, `...and one far off it a miss at ${rtt} ms`, lastRound());
}
{
  const rand = NET.rngOf(41); let changed = 0, n = 0; const seen = [];
  for (const c of NET.matrix()) {
    r = begin();
    const p = centreAt(r.current);
    const tr = NET.trip(c, rand);
    strikeNew(r, Math.round(p * c.rate), { down: tr.down, up: tr.up + c.stall });
    n++;
    if (!/round 1\/5 hit/.test(lastRound())) { changed++; if (seen.length < 3) seen.push(`${c.name}: ${lastRound()}`); }
  }
  ok(changed === 0, `no centre-line strike is lost under ${NET.matrix().length} network conditions (0 to 2.5 s, jitter, resends, spikes, a stall)`, `${n} strikes${seen.length ? ' | ' + seen.join(' | ') : ''}`);
}
// No deadline on the server's clock: a strike reported 30 s after its round is still the widget's verdict
r = begin();
{ const p = centreAt(r.current); strikeNew(r, p, { up: 30000 }); }
ok(/round 1\/5 hit/.test(lastRound()) && /sus=slow/.test(lastRound()), 'a strike whose report sat 30 s on the way is still a hit, flagged slow', lastRound());
// The widget's own limit ran out: it says so itself
r = begin();
advance(7700 + 400);
ui.riteTimeout(A, [r.nonce, 1, r.current.rnonce, 7000]);
ok(/round 1\/5 miss \(too late\)/.test(lastRound()), "the widget's own 7 s ran out: a miss, by its clock", lastRound());
// A round the widget never reports is cleaned up after minutes, not seconds
r = begin();
advance(7700 + 2600); fireDue();
ok(rite().round === 0, 'no arrival timer: nothing happens to an unreported round after 10 s');
advance(130000); fireDue();
ok(/round 1\/5 miss \(silent\)/.test(lastRound()), '...it is a miss after the 2 min cleanup', lastRound());
// One report per round; a report for another round or another nonce
r = begin();
{
  const p = centreAt(r.current);
  const rn = r.current.rnonce;
  strikeNew(r, p);
  const before = rite().round;
  ui.riteStrike(A, [r.nonce, 1, rn, 'hit', p, p, 0.5]);
  ok(rite().round === before && rite().hits === 1, 'a second report for a round already judged changes nothing', { round: rite().round, hits: rite().hits });
  ui.riteStrike(A, [r.nonce, 2, 'forged', 'hit', p, p, 0.5]);
  ok(rite().round === before, 'a report naming a round nonce never issued changes nothing');
  ui.riteStrike(A, ['7-other-rite', 2, rite().current.rnonce, 'hit', p, p, 0.5]);
  ok(rite().round === before, "a report on another rite's nonce changes nothing");
}
// Impossible: a press outside the round on the widget's clock, or a report the server got sooner than the round could
// be played
r = begin();
strikeNew(r, -50, { claim: 'hit' });
ok(/round 1\/5 miss \(out of time\)/.test(lastRound()), 'a press before the marker moved is a miss (out of time)', lastRound());
strikeNew(rite(), 9000, { claim: 'hit' });
ok(/round 2\/5 miss \(out of time\)/.test(lastRound()), 'a press after the round ended on the widget\'s clock is a miss', lastRound());
r = begin();
{
  const p = centreAt(r.current);
  advance(r.current.sentAt + 200 - mono);
  ui.riteStrike(A, [r.nonce, r.round + 1, r.current.rnonce, 'hit', p, p, 0.5]);
}
ok(/round 1\/5 miss \(too fast\)/.test(lastRound()), 'a hit the server got 200 ms after it sent the round, claiming a later press, is a miss (too fast)', lastRound());
// Mismatch: a claimed hit the press time does not bear out
r = begin();
{ const q = offAt(r.current); strikeNew(r, q, { claim: 'hit' }); }
ok(/round 1\/5 hit/.test(lastRound()) && /sus=mismatch/.test(lastRound()) && audits.some((t) => /^RITE-MISMATCH /.test(t)), "replayCheck 'log': a claimed hit the press does not bear out stands, flagged and audited", lastRound());
cfg = { supernatural: { rite: { replayCheck: 'refuse' } } }; load();
r = begin();
{ const q = offAt(r.current); strikeNew(r, q, { claim: 'hit' }); }
ok(/round 1\/5 miss/.test(lastRound()), "replayCheck 'refuse': it is scored as the replay says, a miss", lastRound());
cfg = {}; load();
// Rewards, penalties and rests unchanged: winning makes a pure-blood; losing takes the shrine's day and rolls permadeath
r = begin();
for (let i = 0; i < 4 && rite(); i++) strikeNew(rite(), centreAt(rite().current));
const st = store.get(`${A}|private.supernatural`) || {};
ok(!rite() && st.kind === 'vampire' && st.pure === true, 'four client-judged hits: Molag Bal makes a pure-blood, as before', st);
const rnd = Math.random;
r = begin();
Math.random = () => 0; // every permadeath roll lands
for (let i = 0; i < 5 && rite(); i++) { const rr = rite(); strikeNew(rr, offAt(rr.current)); }
Math.random = rnd;
ok(!rite() && Number(store.get(`${A}|private.riteFailedAt`)) > 0 && store.get(`${A}|private.permaDead`) === true, 'two client-judged misses too many: the shrine waits a day and the permadeath roll still runs', { failedAt: store.get(`${A}|private.riteFailedAt`), perma: store.get(`${A}|private.permaDead`) });
store.set(`${A}|private.permaDead`, false);

// ---- today's widget (no riteJudge): judged by arrival, with the continuous window ----
caps.delete('riteJudge');
r = begin();
ok(r.client === false && lastW().judge === undefined, 'a client without riteJudge is not told it judges');
ok(/judge=legacy/.test(logs.join(' | ')), '...and the rite says it is judged by arrival');
for (const rtt of [0, 150, 400]) {
  r = begin();
  strikeOld(r, centreAt(r.current), rtt);
  ok(/round 1\/5 hit/.test(lastRound()) && /judge=legacy/.test(lastRound()), `an old widget's press on the centre line is a hit at ${rtt} ms`, lastRound());
}
// The live failure: 400 ms of lag on a fast round put the arrival outside every one of the three samples
{
  let oldHits = 0, newHits = 0, n = 0;
  for (let i = 0; i < 40; i++) {
    for (const mode of ['server', 'legacy']) {
      cfg = mode === 'server' ? { supernatural: { rite: { clientJudged: false } } } : {}; load();
      r = begin();
      for (let k = 0; k < i % 4; k++) r.current = Object.assign({}, r.current, { period: 1100 + (i * 37) % 600 });
      const p = centreAt(r.current);
      strikeOld(r, p, 400);
      if (/round 1\/5 hit/.test(lastRound())) { if (mode === 'server') oldHits++; else newHits++; }
    }
    n++;
  }
  ok(newHits === n && newHits >= oldHits, `at 400 ms the continuous window hits every centre-line press (${newHits}/${n}; the three samples hit ${oldHits}/${n})`);
}
cfg = {}; load();
r = begin();
advance(7700 + 2000); fireDue();
ok(rite() && rite().round === 0, "an old widget's round now waits 2.5 s longer before it is too late");
advance(600); fireDue();
ok(/round 1\/5 miss \(too late\)/.test(lastRound()), '...then it is too late, as before', lastRound());

// ---- rollback: today's judging ----
cfg = { supernatural: { rite: { clientJudged: false } } }; load();
caps.add('riteJudge');
r = begin();
ok(r.client === false && lastW().judge === undefined, 'rollback (clientJudged false): even a riteJudge client is judged by arrival');
advance(7700 + 1); fireDue();
ok(/round 1\/5 miss \(too late\)/.test(lastRound()) && /judge=server/.test(logs.join(' | ')), '...with the 7.7 s timer of before', lastRound());
r = begin();
{
  const rd = r.current;
  // A press 140 ms off the centre line on the late side, arriving 400 ms late: the three samples miss what the window hits
  let p = -1; for (let t = 300; t < 6000; t++) { if (Math.abs(markerAt(rd, t) - rd.center) < 0.004) { p = t; break; } }
  strikeOld(r, p, 400);
}
ok(/marker [\d.]+\/[\d.]+\/[\d.]+ judge=server/.test(lastRound()), '...and the three-sample check logs its three markers as before', lastRound());

Date.now = realNow;
console.log('');
console.log(fail ? `${fail} FAILURES` : 'all checks passed');
process.exit(fail ? 1 : 0);
