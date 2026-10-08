// Scripted packet test for server\labour.js: loads the real module with a mock gamemode api, opens
// rounds, plays them the way the front widget does, and fires the report packet back at it. No
// server and no game: run it from this folder's parent with
//
//   node tests\labour-harness.js
//
// It covers the honest path (the widget's hit count and the server's must always agree), and the
// forgeries migration 7 of SERVER_AUTHORITY.md is about: hit counts with no times, times that
// ignore the band, times packed inside the stagger, replays and slow motion.
'use strict';
const path = require('path');

const SERVER = path.resolve(__dirname, '..');
const LABOUR = path.join(SERVER, 'labour.js');

let virtual = 0;
let nearM = 2;
let pickUi = false;
globalThis.performance = { now: () => virtual };

const ACTOR = 0x14;
const VEIN = 0x1234;
const BLOCK = 0x5678;

// The two base objects an activation lands on, real ones so the form-id check over this repo passes:
// the vanilla iron seam and the vanilla chopping block.
const VEIN_BASE = '10dcc9:Skyrim.esm';  // ACTI MineOreIron01_LReachGrass
const BLOCK_BASE = '7022e:Skyrim.esm';  // FURN WoodChoppingBlock
const props = new Map();
const records = new Map([
  [0x10dcc9, { record: { type: 'ACTI', editorId: 'MineOreIron01_LReachGrass' } }],
  [0x7022e, { record: { type: 'FURN', editorId: 'WoodChoppingBlock' } }],
]);
props.set(VEIN + '|baseDesc', VEIN_BASE);
props.set(BLOCK + '|baseDesc', BLOCK_BASE);

const out = { widgets: [], logs: [], audits: [], items: [], personals: [], events: [] };
const handlers = new Map();

// The skill system's entry point, mocked: a completed round must emit the kind the point system
// actually weighs, with the scale term that kind asks for (skillPoints.weightOf).
globalThis.__alduinakMasteryEvent = (kind, actorId, detail) => out.events.push({ kind, actorId, detail });

const api = {
  mp: {
    getIdFromDesc: (d) => parseInt(String(d).split(':')[0], 16) >>> 0,
    get: (id, prop) => props.get(id + '|' + prop),
    set: (id, prop, v) => props.set(id + '|' + prop, v),
    lookupEspmRecordById: (id) => records.get(id) || null,
  },
  log: (...a) => out.logs.push(a.join(' ')),
  personal: (a, t) => out.personals.push(t),
  audit: (t) => out.audits.push(t),
  display: () => 'Tester #ABCD',
  who: () => 'Tester #ABCD (profile 1)',
  // The cases above are the server-judged rules: they run with the rollback switch, so they also prove clientJudged
  // false behaves exactly as before. The client-judged cases are at the end.
  cfg: { labour: { clientJudged: false, perPlayerNodes: false } },
  distanceMeters: () => nearM,
  openWidget: (a, w) => { out.widgets.push(w); return true; },
  closeWidget: () => true,
  onUi: (ev, fn) => { const l = handlers.get(ev) || []; l.push(fn); handlers.set(ev, l); },
  giveItem: (a, id, n) => { out.items.push([id, n]); return true; },
  skills: require(path.join(SERVER, 'skills.json')),
  // A UI that names 'pickRound' in dbo:uiCaps; off until the pick cases at the end
  hasUiCap: (a, cap) => pickUi && cap === 'pickRound',
};

// gamemode.js rebuilds its ui registry on every reload, so the handlers go with it
const load = () => { delete require.cache[require.resolve(LABOUR)]; handlers.clear(); require(LABOUR)(api); };
const fire = (ev, args, widget) => (handlers.get(ev) || []).forEach((f) => f(ACTOR, args, widget || 33));

const setTier = (skill, rank) => props.set(ACTOR + '|private.mastery', { order: [skill], skills: { [skill]: { rank } } });
const clearRests = () => { props.delete(ACTOR + '|private.minedVeins'); props.delete(ACTOR + '|private.choppedBlocks'); props.delete(VEIN + '|private.dboWorkedUntil'); props.delete(BLOCK + '|private.dboWorkedUntil'); };

// ---- the widget's own rules, so a simulated player behaves exactly like the front ----------------
const markerAt = (ms, sweepMs) => {
  const phase = (ms % (sweepMs * 2)) / sweepMs;
  return phase <= 1 ? phase * 100 : (2 - phase) * 100;
};

// Plays the round the way a human does: ticks at 16 ms and presses on a frame it likes.
// aim 1 presses anywhere inside the band, 0.2 waits for dead centre, sloppy presses at random.
const play = (w, opt) => {
  const o = Object.assign({ aim: 0.8, sloppy: 0, give: false }, opt || {});
  const strikes = [];
  let hits = 0;
  let ready = 0;
  for (let el = 0; el <= w.totalMs; el += 16) {
    if (hits >= w.strikes) return { strikes, hits, at: el };
    if (el < ready) continue;
    const pos = markerAt(el, w.sweepMs);
    const centre = w.bands[hits];
    const inBand = Math.abs(pos - centre) <= w.band;
    const press = o.sloppy ? Math.random() < o.sloppy : Math.abs(pos - centre) <= w.band * o.aim;
    if (!press) continue;
    strikes.push(el);
    ready = el + (inBand ? w.hitMs : w.missMs);
    if (inBand) hits++;
  }
  return { strikes, hits, at: w.totalMs };
};

// The cheapest forgery: the earliest feasible strike for every band, back to back
const fastestPossible = (w) => {
  const strikes = [];
  let ready = 0;
  for (let i = 0; i < w.strikes; i++) {
    let t = ready;
    while (t <= w.totalMs && Math.abs(markerAt(t, w.sweepMs) - w.bands[i]) > w.band) t++;
    if (t > w.totalMs) return null;
    strikes.push(t);
    ready = t + w.hitMs;
  }
  return strikes;
};

const openRound = (kind, tier) => {
  out.widgets.length = 0;
  clearRests();
  setTier(kind === 'mining' ? 'miner' : 'woodcutter', tier);
  const ok = globalThis.__dboLabour(kind === 'mining' ? VEIN : BLOCK, ACTOR);
  return { ok, w: out.widgets[out.widgets.length - 1] };
};

const report = (w, strikes, at, lagMs, start) => {
  virtual = start + at + (lagMs === undefined ? 120 : lagMs);
  out.logs.length = 0; out.items.length = 0; out.audits.length = 0; out.widgets.length = 0; out.events.length = 0;
  fire('labour', [w.nonce, typeof strikes === 'string' ? strikes : JSON.stringify(strikes), at]);
  return { log: out.logs.join(' | '), items: out.items.slice(), audit: out.audits.slice(), result: out.widgets[0], events: out.events.slice() };
};

// ---- cases ---------------------------------------------------------------------------------------
let failures = 0;
const check = (name, cond, detail) => {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);
};
const verdictOf = (line) => (/labour (win|lose|refused\([a-z-]+\)|stale-ui|replay)/.exec(line) || [])[1] || '?';
const hitsOf = (line) => (/ (\d+)\/(\d+) of (\d+) /.exec(line) || []).slice(1).join('/');

load();
console.log('boot:', out.logs.join(' | '));
console.log('');

// 1. the round the server issues
virtual = 1000;
let r = openRound('mining', 2);
let w = r.w;
check('mining round opens', r.ok && w && w.type === 'labour', `strikes=${w.strikes} band=${w.band} sweepMs=${w.sweepMs} totalMs=${w.totalMs} hit/miss=${w.hitMs}/${w.missMs}`);
check('server sends one band centre per strike', Array.isArray(w.bands) && w.bands.length === w.strikes, `bands=${JSON.stringify(w.bands)}`);
check('no answer in the packet', !('result' in w) && w.seed === undefined, 'no seed, no verdict, nothing to roll client-side');

// 2. honest play
let p = play(w, { aim: 0.5 });
let res = report(w, p.strikes, p.at, 120, 1000);
check('honest round wins', verdictOf(res.log) === 'win' && res.items.length === 1, res.log);
// the seam rests for everyone, not only this character (loot review, 2026-09-29)
check('a won round rests the seam itself', (Number(props.get(VEIN + '|private.dboWorkedUntil')) || 0) > Date.now());
{
  const mine = props.get(ACTOR + '|private.minedVeins');
  props.delete(ACTOR + '|private.minedVeins');   // as for another character, with no rest of their own
  out.widgets.length = 0;
  globalThis.__dboLabour(VEIN, ACTOR);
  check('...so another character cannot work it at once', out.widgets.length === 0, String(out.widgets.length));
  props.set(ACTOR + '|private.minedVeins', mine);
}
check('server counts the same hits the widget did', hitsOf(res.log) === `${p.hits}/${w.strikes}/${p.strikes.length}`, `widget ${p.hits}/${w.strikes} in ${p.strikes.length} strikes`);

// 3. honest sloppy play, 40 rounds: the server's count must always equal the widget's
let mismatch = 0; let wins = 0; let played = 0;
for (let i = 0; i < 40; i++) {
  virtual = 100000 + i * 100000;
  const start = virtual;
  const rr = openRound(i % 2 ? 'chopping' : 'mining', i % 5);
  if (!rr.w) continue;
  const pp = play(rr.w, { sloppy: 0.02 + (i % 7) * 0.01 });
  const out2 = report(rr.w, pp.strikes, pp.at, 40 + (i % 5) * 60, start);
  played++;
  if (hitsOf(out2.log) !== `${pp.hits}/${rr.w.strikes}/${pp.strikes.length}`) { mismatch++; console.log('   mismatch:', out2.log, `widget said ${pp.hits}`); }
  if (verdictOf(out2.log) === 'win') wins++;
}
check('widget and server agree on every strike, 40 random rounds', mismatch === 0, `${played} rounds, ${wins} wins, ${mismatch} mismatches`);

// The server must score a strike EXACTLY as the widget does, with no tolerance on either side.
// A band centre is two decimals and a marker position is a float, so a strike on the band edge lands a few ULPs out:
// 45.4 - 38.39999999999999 is 7.000000000000007, a miss against half 7 and a hit against half + 1e-9. The server used
// to carry that 1e-9. One disagreement is not one strike: both sides take the band centre from their OWN running hit
// count and the cooldown from their OWN verdict, so everything after it is scored against a different band - the server
// then either counts a win the player never saw or refuses the whole round as 'cooldown' and the work is lost.
// Measured 2026-09-30: 3 failures in 252 runs of this harness, about 1 in 3,360 rounds.
const EDGE = Math.abs(45.4 - 38.39999999999999);
check('the strike this pins really does sit just outside the band', EDGE > 7 && EDGE - 7 < 1e-12, String(EDGE));
check('...so it is a miss for the widget', !(EDGE <= 7), String(EDGE));
check('...and a hit for any server that keeps a tolerance', EDGE <= 7 + 1e-9, String(EDGE));
// struggle.js draws through the labour widget (type: 'labour'), so its scoring has to match the same front
for (const f of ['labour.js', 'struggle.js', 'gamemode.js']) {
  const src = require('fs').readFileSync(path.join(SERVER, f), 'utf8');
  check(`${f} scores a strike with no tolerance the widget lacks`, !/(round\.half|round\.width \/ 2) \+ 1e-9/.test(src), f);
}

// 4. an interface from before the change reports a hit count
virtual = 2000000; r = openRound('mining', 2); w = r.w;
virtual += 5000;
out.logs.length = 0; out.items.length = 0; out.widgets.length = 0;
fire('labour', [w.nonce, w.strikes]);
check('old widget refused, told to update', verdictOf(out.logs.join()) === 'stale-ui' && out.items.length === 0, out.logs.join(' | '));
check('stale interface costs no rest timer', !props.get(ACTOR + '|private.minedVeins') || !Object.keys(props.get(ACTOR + '|private.minedVeins')).length, '');

// 5. the old exploit: wait strikes*350 ms and claim a perfect round
virtual = 3000000; r = openRound('mining', 4); w = r.w;
res = report(w, [], 0, w.strikes * 350, 3000000);
check('empty report with a perfect claim cannot win', verdictOf(res.log) === 'lose' && res.items.length === 0, res.log);
virtual = 3100000; r = openRound('mining', 4); w = r.w;
res = report(w, JSON.stringify(w.strikes), 0, w.strikes * 350, 3100000);
check('hit count in place of times is refused', ['stale-ui', 'refused(malformed)'].includes(verdictOf(res.log)), res.log);

// 6. forged strike times that ignore the band
virtual = 4000000; r = openRound('mining', 4); w = r.w;
const evenly = Array.from({ length: w.strikes }, (_, i) => i * 350);
res = report(w, evenly, w.strikes * 350, 100, 4000000);
check('evenly spaced forgery is refused or scored as misses', verdictOf(res.log) !== 'win' && res.items.length === 0, res.log);

// 7. the cheapest forgery that can still win, and what it costs in real time
virtual = 5000000; r = openRound('mining', 4); w = r.w;
const best = fastestPossible(w);
res = report(w, best, best[best.length - 1], 100, 5000000);
check('a perfectly computed round still has to be played out in real time', verdictOf(res.log) === 'win', `${best[best.length - 1]} ms for ${w.strikes} strikes (was ${w.strikes * 350} ms under the old rule)`);

// 8. claiming the same strikes sooner than the server watched them happen
virtual = 6000000; r = openRound('mining', 4); w = r.w;
const best2 = fastestPossible(w);
res = report(w, best2, best2[best2.length - 1], -900, 6000000);
check('report that outruns the server clock is refused', verdictOf(res.log) === 'refused(future)', res.log);

// 9. strikes packed inside the cooldown
virtual = 7000000; r = openRound('mining', 4); w = r.w;
const packed = fastestPossible(w).map((t, i) => Math.round(t / 4) + i);
res = report(w, packed, packed[packed.length - 1], 100, 7000000);
check('strikes inside the stagger are refused', verdictOf(res.log) === 'refused(cooldown)', res.log);

// 10. a strike after the round was already won
virtual = 8000000; r = openRound('mining', 4); w = r.w;
const extra = fastestPossible(w); extra.push(extra[extra.length - 1] + 500);
res = report(w, extra, extra[extra.length - 1], 100, 8000000);
check('a strike after the last hit is refused', verdictOf(res.log) === 'refused(extra)', res.log);

// 11. floods and garbage
virtual = 9000000; r = openRound('mining', 4); w = r.w;
res = report(w, Array.from({ length: 400 }, (_, i) => i * 10), 4000, 100, 9000000);
check('flood of strikes refused', verdictOf(res.log) === 'refused(flood)', res.log);
virtual = 9100000; r = openRound('mining', 4); w = r.w;
res = report(w, [1.5, 300], 400, 100, 9100000);
check('fractional times refused', verdictOf(res.log) === 'refused(range)', res.log);
virtual = 9200000; r = openRound('mining', 4); w = r.w;
res = report(w, [-5], 400, 100, 9200000);
check('negative time refused', verdictOf(res.log) === 'refused(range)', res.log);
virtual = 9300000; r = openRound('mining', 4); w = r.w;
res = report(w, [w.totalMs + 1], w.totalMs + 1, 100, 9300000);
check('time past the round refused', verdictOf(res.log) === 'refused(range)', res.log);
virtual = 9400000; r = openRound('mining', 4); w = r.w;
res = report(w, 'not json at all', 400, 100, 9400000);
check('malformed payload refused', verdictOf(res.log) === 'refused(malformed)', res.log);

// 12. a strike claimed after the report went out
virtual = 9500000; r = openRound('mining', 4); w = r.w;
const late = fastestPossible(w);
res = report(w, late, late[late.length - 1] - 100, 200, 9500000);
check('strike later than the report itself refused', verdictOf(res.log) === 'refused(submit)', res.log);

// 13. the round drawn out in real time and the strike times scaled back down (slow motion)
virtual = 9600000; r = openRound('mining', 4); w = r.w;
const okStrikes = fastestPossible(w);
res = report(w, okStrikes, okStrikes[okStrikes.length - 1], 4000, 9600000);
check('widget clock further behind the server than transport allows is refused', verdictOf(res.log) === 'refused(late)', res.log);
// Slow motion is caught by the SAME flat lagGraceMs as transport, so whether it is caught at all
// depends on how long the round happened to take: at half speed the excess equals the round's own
// length, so it only trips the guard once the round runs longer than the grace. This used to be one
// check against a random round and it failed about one run in five. It is now two deterministic
// checks, and the second one records a real hole rather than hiding it.
const LAG_GRACE = 2500;   // labour.js CFG default; the harness passes cfg {} so the defaults apply
virtual = 9650000; r = openRound('mining', 4); w = r.w;
const slowStrikes = fastestPossible(w);
const slowAt = slowStrikes[slowStrikes.length - 1];
// A long round played at half speed: the excess exceeds the grace and it is refused.
res = report(w, slowStrikes, slowAt, LAG_GRACE + 500, 9650000);
check('a sweep played at half speed is refused once the round outlasts the grace',
  verdictOf(res.log) === 'refused(late)', res.log);
// KNOWN GAP: the same cheat on a round shorter than the grace is NOT refused. A 6-strike tier-5
// round finishes in roughly 1800-2400 ms, under the 2500 ms grace, so a player can draw the whole
// sweep out to double length - which makes a timing game trivial - and the guard never fires.
// Catching it needs a proportional test (excess against the round's own length) rather than one
// absolute, and labour.js:36 says to read a playtest's worth of real "lag=" values before tightening
// anything here. There is no latency data yet, so this asserts today's behaviour on purpose: when
// someone does tighten it, this check fails and points at the comment above.
virtual = 9655000; r = openRound('mining', 4); w = r.w;
const shortStrikes = fastestPossible(w);
const shortAt = shortStrikes[shortStrikes.length - 1];
res = report(w, shortStrikes, shortAt, Math.min(shortAt, LAG_GRACE - 100), 9655000);
check('KNOWN GAP: a slowdown that stays under the flat grace still wins',
  verdictOf(res.log) === 'win',
  `${Math.round((1 + Math.min(shortAt, LAG_GRACE - 100) / shortAt) * 100)}% of real time on a ${shortAt} ms round, under the ${LAG_GRACE} ms grace — ${res.log}`);
virtual = 9660000; r = openRound('mining', 4); w = r.w;
const oldStrikes = fastestPossible(w);
res = report(w, oldStrikes, oldStrikes[oldStrikes.length - 1], 600000, 9660000);
check('a report that turns up ten minutes later is refused', verdictOf(res.log) === 'refused(late)', res.log);

// 14. replay of a winning report
virtual = 9700000; r = openRound('mining', 4); w = r.w;
const winStrikes = fastestPossible(w);
res = report(w, winStrikes, winStrikes[winStrikes.length - 1], 100, 9700000);
check('first report pays out', verdictOf(res.log) === 'win' && res.items.length === 1, res.log);
const again = report(w, winStrikes, winStrikes[winStrikes.length - 1], 100, 9700000);
check('replay of the same nonce pays nothing and is logged', verdictOf(again.log) === 'replay' && again.items.length === 0, again.log);

// 15. a gamemode reload in the middle of a round
virtual = 9800000; r = openRound('mining', 3); w = r.w;
load();
const p15 = play(w, { aim: 0.5 });
res = report(w, p15.strikes, p15.at, 120, 9800000);
check('round survives a gamemode reload', verdictOf(res.log) === 'win' && res.items.length === 1, res.log);

// 16. a round whose report never comes back must not lock the seam
virtual = 9900000; r = openRound('mining', 2); w = r.w;
virtual += w.totalMs + 2500 + 1;
out.widgets.length = 0;
const again16 = globalThis.__dboLabour(VEIN, ACTOR);
check('an abandoned round expires and the seam can be worked again', again16 && out.widgets.length === 1 && out.widgets[0].nonce !== w.nonce, `new nonce ${out.widgets.length ? out.widgets[0].nonce : 'none'}`);
virtual = 9950000; r = openRound('mining', 2); w = r.w;
virtual += 5000;
out.widgets.length = 0;
const busy = globalThis.__dboLabour(VEIN, ACTOR);
check('a live round is not restarted by activating again', busy && out.widgets.length === 0, '');

// 17. woodcutting at the top tier
virtual = 10000000; r = openRound('chopping', 4); w = r.w;
check('chopping issues its own longer round', w.strikes === 20 && w.bands.length === 20, `strikes=${w.strikes} band=${w.band}`);
p = play(w, { aim: 0.6 });
res = report(w, p.strikes, p.at, 90, 10000000);
check('chopping round judged the same way', hitsOf(res.log) === `${p.hits}/20/${p.strikes.length}`, res.log);

// 18. the bands really are different every round
const seen = new Set();
for (let i = 0; i < 20; i++) { virtual = 11000000 + i * 100000; const rr = openRound('mining', 2); seen.add(JSON.stringify(rr.w.bands)); }
check('every round gets its own band sequence', seen.size === 20, `${seen.size} distinct of 20`);

// 19. a finished round emits the kind the point system weighs, with the ore band as its value.
// Emitting 'activate' here (flat 0.5) left the ore band in skillPoints.weightOf dead code.
const SKILLS = require(path.join(SERVER, 'skills.json'));
const BY_TIER = (SKILLS.skills.find((k) => k.id === 'miner') || {}).oreByTier || [];
const bandOf = (ore) => BY_TIER.findIndex((t) => (t || []).some((o) => String(o).toLowerCase() === ore));

virtual = 13000000; r = openRound('mining', 4); w = r.w;
p = play(w, { aim: 0.5 });
res = report(w, p.strikes, p.at, 100, 13000000);
const ev = res.events[0] || {};
check('a mined vein emits "mine", not "activate"', verdictOf(res.log) === 'win' && ev.kind === 'mine',
  `kind=${ev.kind} events=${res.events.length}`);
check('the ore band rides along as the weight\'s value', ev.detail && ev.detail.value === bandOf('iron'),
  `value=${ev.detail && ev.detail.value} want ${bandOf('iron')} (iron)`);
check('the vein is still named by its reference', ev.detail && ev.detail.refrId === VEIN, JSON.stringify(ev.detail));

virtual = 13200000; r = openRound('chopping', 0); w = r.w;
p = play(w, { aim: 0.5 });
res = report(w, p.strikes, p.at, 100, 13200000);
const ev2 = res.events[0] || {};
check('a split block emits "chop"', verdictOf(res.log) === 'win' && ev2.kind === 'chop',
  `kind=${ev2.kind} events=${res.events.length}`);

virtual = 13400000; r = openRound('mining', 4); w = r.w;
res = report(w, [1, 2, 3], 3, 100, 13400000);
check('a refused round emits nothing at all', verdictOf(res.log) !== 'win' && res.events.length === 0,
  `${res.events.length} event(s)`);

// A seam's pickaxe marker is refused to players: the vanilla mining script on it paid out ore with no round and no
// skill (Nate on Falcius, 2026-09-28). NPCs keep them for their idles; other furniture is not labour's.
const MARKERS = [
  [0xa001, '613a6:Skyrim.esm', 0x613a6, 'PickaxeMiningFloorMarker'],
  [0xa002, 'e2bc7:Skyrim.esm', 0xe2bc7, 'PickaxeMiningWallMarker'],
  [0xa003, '613a7:Skyrim.esm', 0x613a7, 'PickaxeMiningTableMarker'],
  [0xa004, 'bd15d:Skyrim.esm', 0xbd15d, 'MS02PickaxeMiningFloorMarker'],
  [0xa005, '3a491:Dragonborn.esm', 0x3a491, 'DLC2PickaxeMiningFloorMarker_Stalhrim'],
];
for (const [ref, desc, base, edid] of MARKERS) { records.set(base, { record: { type: 'FURN', editorId: edid } }); props.set(ref + '|baseDesc', desc); }
const NPC = 0xff000123;
props.set(ACTOR + '|profileId', 1);
props.set(NPC + '|profileId', -1);
out.personals.length = 0;
for (const [ref, , , edid] of MARKERS) {
  out.widgets.length = 0; out.items.length = 0;
  const taken = globalThis.__dboLabour(ref, ACTOR);
  check(`a player is refused the ${edid}`, taken === true && out.widgets.length === 0 && out.items.length === 0, `taken=${taken}`);
}
check('the refusal tells the player to strike the seam', out.personals.some((t) => /Strike the seam itself/.test(t)), out.personals.join(' | '));
check('an NPC still uses a pickaxe marker', globalThis.__dboLabour(0xa001, NPC) === false);
records.set(0xe0ba9, { record: { type: 'FURN', editorId: 'BedrollHay01FallForestDirt01F' } }); props.set(0xa010 + '|baseDesc', 'e0ba9:Skyrim.esm');
check('other furniture is not labour\'s', globalThis.__dboLabour(0xa010, ACTOR) === false);
setTier('woodcutter', 0); clearRests(); out.widgets.length = 0;
check('the chopping block still opens a round', globalThis.__dboLabour(BLOCK, ACTOR) === true && out.widgets.length === 1 && out.widgets[0].kind === 'chopping');

// cancelling a round rests the seam like a failed one (loot review, 2026-09-29): no looking at the bands and cancelling
virtual += 60000; r = openRound('mining', 2);
check('a round opens on the seam', r.ok === true && !!r.w);
fire('labourCancel', []);
const restAfterCancel = Number((props.get(ACTOR + '|private.minedVeins') || {})[VEIN.toString(16)]) || 0;
check('cancelling it rests the seam for failRestMinutes', restAfterCancel > Date.now(), String(restAfterCancel));
out.widgets.length = 0;
globalThis.__dboLabour(VEIN, ACTOR);
check('...so it cannot be reopened at once for a new set of bands', out.widgets.length === 0, String(out.widgets.length));

// F2 hides the interface: the widget closes with args ['hidden'], which is not walking away (Worker E, 2026-09-29)
virtual += 60000; r = openRound('mining', 2);
fire('close', ['hidden'], 33);
check('hiding the interface mid-round costs no rest', !Number((props.get(ACTOR + '|private.minedVeins') || {})[VEIN.toString(16)]));
out.widgets.length = 0;
globalThis.__dboLabour(VEIN, ACTOR);
check('...and the seam opens again at once', out.widgets.length === 1, String(out.widgets.length));
fire('close', ['escape'], 33);
check('closing it with Escape still rests the seam', Number((props.get(ACTOR + '|private.minedVeins') || {})[VEIN.toString(16)]) > Date.now());

// one worker per seam: a second is turned away while a round runs, and a win on a seam worked out meanwhile pays
// nothing (economy review, 2026-09-29)
{
  const OTHER = 0x15;
  props.set(OTHER + '|private.mastery', { order: ['miner'], skills: { miner: { rank: 2 } } });
  virtual += 60000; r = openRound('mining', 2);
  check('the first worker opens a round on the seam', r.ok === true && !!r.w);
  out.widgets.length = 0; out.personals.length = 0;
  globalThis.__dboLabour(VEIN, OTHER);
  check('a second worker is turned away while it runs', out.widgets.length === 0 && out.personals.some((t) => /Someone is working this seam/.test(t)), JSON.stringify(out.personals));
  props.set(VEIN + '|private.dboWorkedUntil', Date.now() + 45 * 60000);   // someone else's win landed first
  const pp = play(r.w, { aim: 0.5 });
  const res2 = report(r.w, pp.strikes, pp.at, 120, virtual);
  check('a won round on a seam worked out meanwhile pays nothing', res2.items.length === 0 && /before you finished/.test(JSON.stringify(res2.result || {})), JSON.stringify(res2.result));
  clearRests();
}

// ---- client-judged rounds (labour.clientJudged true): the widget's verdict stands, latency refuses nothing ----------
console.log('');
console.log('client-judged:');
api.cfg = { labour: { clientJudged: true, perPlayerNodes: false } };
load();
const claimOf = (win, hits) => JSON.stringify({ v: 1, win, hits });
const reportC = (w, strikes, at, lagMs, start, claim) => {
  virtual = start + at + (lagMs === undefined ? 120 : lagMs);
  out.logs.length = 0; out.items.length = 0; out.audits.length = 0; out.widgets.length = 0; out.events.length = 0; out.personals.length = 0;
  const args = [w.nonce, typeof strikes === 'string' ? strikes : JSON.stringify(strikes), at];
  if (claim !== undefined) args.push(claim);
  fire('labour', args);
  return { log: out.logs.join(' | '), items: out.items.slice(), result: out.widgets[0], personals: out.personals.slice() };
};
const judgeOf = (line) => (/ judge=(\w+)/.exec(line) || [])[1] || '?';
const susOf = (line) => (/ sus=([\w,-]+)/.exec(line) || [])[1] || '';
let T = 20000000;
const fresh = (kind, tier) => { T += 1000000; virtual = T; nearM = 2; return openRound(kind || 'mining', tier === undefined ? 3 : tier).w; };

w = fresh();
check('the round tells the widget it is the judge', w.judge === 'client', JSON.stringify(w.judge));
check('every round issued is logged with the fastest it can be won', /labour issue .* min=\d+ judge=client seed=/.test(out.logs.join(' | ')), out.logs.slice(-1)[0]);
p = play(w, { aim: 0.5 });
res = reportC(w, p.strikes, p.at, 4000, T, claimOf(true, p.hits));
check('4 s of lag (refused(late) before) wins and pays', verdictOf(res.log) === 'win' && res.items.length === 1 && judgeOf(res.log) === 'client', res.log);

w = fresh(); p = play(w, { aim: 0.5 });
res = reportC(w, p.strikes, p.at, 9000, T, claimOf(true, p.hits));
check('9 s of lag still wins, flagged slow for review', verdictOf(res.log) === 'win' && /slow/.test(susOf(res.log)), res.log);

w = fresh(); p = play(w, { aim: 0.5 });
res = reportC(w, p.strikes, p.at, 4000, T);
check('a 0.3.71 widget (no verdict) is judged from its times with the lag relaxed', verdictOf(res.log) === 'win' && judgeOf(res.log) === 'legacy' && res.items.length === 1, res.log);

// A widget clock a little ahead of the server's (drift, a resend reordering nothing) is only a review flag. Far enough
// ahead that the server saw less time pass than the round's fastest win, it is refused(fast) further down.
w = fresh(); p = play(w, { aim: 0.2 });
res = reportC(w, p.strikes, p.at, -60, T, claimOf(true, p.hits));
check('a widget clock ahead of the server is flagged, not refused', verdictOf(res.log) === 'win' && /future/.test(susOf(res.log)), res.log);

w = fresh(); p = play(w, { aim: 0.5 });
res = reportC(w, p.strikes, p.at, 170000, T, claimOf(true, p.hits));
check('a report nearly three minutes late is still judged', verdictOf(res.log) === 'win', res.log);
w = fresh(); p = play(w, { aim: 0.5 });
res = reportC(w, p.strikes, p.at, 600000, T, claimOf(true, p.hits));
check('a report ten minutes late is refused as expired, nothing paid', verdictOf(res.log) === 'refused(expired)' && res.items.length === 0, res.log);

// A claimed win its own strike times do not bear out (replayCheck 'log', the default): it stands if it took no less than
// the round's exact minimum, flagged and audited; one claimed sooner than that is refused as too fast
w = fresh();
const even = Array.from({ length: w.strikes }, (_, i) => 1000 + i * 700);
const evenAt = Math.max(even[even.length - 1], w.totalMs - 10);
res = reportC(w, even, evenAt, 120, T, claimOf(true, w.strikes));
const auditMismatch = out.audits.some((t) => /^LABOUR-MISMATCH /.test(t));
check("replayCheck 'log' (default): a mismatched win no faster than min= stands, flagged and audited", verdictOf(res.log) === 'win' && /mismatch/.test(susOf(res.log)) && auditMismatch, res.log);
w = fresh();
res = reportC(w, [10], 20, 120, T, claimOf(true, w.strikes));
check('...but one claiming less time than the round\'s fastest win is refused(fast), nothing paid', verdictOf(res.log) === 'refused(fast)' && res.items.length === 0, res.log);

w = fresh(); const fp = fastestPossible(w);
res = reportC(w, fp, fp[fp.length - 1], 120, T, claimOf(true, w.strikes));
check('the fastest possible round still replays to a win (min= is that time)', verdictOf(res.log) === 'win' && new RegExp(` min=${fp[fp.length - 1]} `).test(res.log), res.log);

w = fresh(); p = play(w, { aim: 0.5 });
res = reportC(w, p.strikes, p.at, 120, T, claimOf(false, p.hits - 1));
check("the widget's own loss stands even when the times replay to a win", verdictOf(res.log) === 'lose' && /mismatch/.test(susOf(res.log)) && res.items.length === 0, res.log);

w = fresh(); p = play(w, { aim: 0.5 });
res = reportC(w, p.strikes, p.at, 120, T, 'not json');
check('an unreadable verdict falls back to judging the times', verdictOf(res.log) === 'win' && judgeOf(res.log) === 'legacy', res.log);

w = fresh(); p = play(w, { aim: 0.5 }); nearM = 40;
res = reportC(w, p.strikes, p.at, 120, T, claimOf(true, p.hits));
check('a worker 40 m from the node when the report lands is refused', verdictOf(res.log) === 'refused(far)' && res.items.length === 0, res.log);
w = fresh(); p = play(w, { aim: 0.5 }); nearM = 12;
res = reportC(w, p.strikes, p.at, 120, T, claimOf(true, p.hits));
check('12 m (inside the 15 m radius) is fine', verdictOf(res.log) === 'win', res.log);

w = fresh(); p = play(w, { aim: 0.5 });
res = reportC(w, p.strikes, p.at, 120, T, claimOf(true, p.hits));
const again2 = reportC(w, p.strikes, p.at, 130, T, claimOf(true, p.hits));
check('one report per round: the second is a logged replay and pays nothing', verdictOf(again2.log) === 'replay' && again2.items.length === 0, again2.log);

// Walk away overtaking the report (client -> server is RELIABLE, not ordered)
w = fresh(); p = play(w, { aim: 0.5 });
virtual = T + p.at + 50; fire('labourCancel', [w.nonce]);
const failRest = Number((props.get(ACTOR + '|private.minedVeins') || {})[VEIN.toString(16)]) || 0;
res = reportC(w, p.strikes, p.at, 400, T, claimOf(true, p.hits));
const restAfter = Number((props.get(ACTOR + '|private.minedVeins') || {})[VEIN.toString(16)]) || 0;
check('a report that lands after the Walk away is still judged and paid', verdictOf(res.log) === 'win' && /after-close/.test(susOf(res.log)) && res.items.length === 1, res.log);
check('...its verdict comes as a message, not a widget reopened', !res.result && res.personals.some((t) => /seam gives way/.test(t)), JSON.stringify(res.personals));
check('...and the win replaces the fail rest with the full one', failRest > Date.now() && restAfter - failRest > 20 * 60000, `${failRest} -> ${restAfter}`);

w = fresh(); p = play(w, { aim: 0.5 });
virtual = T + p.at + 20; fire('close', ['hidden'], 33);
res = reportC(w, p.strikes, p.at, 300, T, claimOf(true, p.hits));
check('a report that lands after F2 hid the widget is still judged', verdictOf(res.log) === 'win' && res.items.length === 1, res.log);

w = fresh(); out.logs.length = 0;
globalThis.__dboLabourLeave(ACTOR);
check('a logout ends the round like walking away (rest, logged)', /labour abandon\(logout\)/.test(out.logs.join(' | ')) && Number((props.get(ACTOR + '|private.minedVeins') || {})[VEIN.toString(16)]) > Date.now(), out.logs.join(' | '));

// Activating again during a live round
w = fresh(); out.widgets.length = 0;
virtual = T + 5000; globalThis.__dboLabour(VEIN, ACTOR);
check('activating mid-round is still swallowed while the widget should be up', out.widgets.length === 0, String(out.widgets.length));
virtual = T + w.totalMs + 20000; globalThis.__dboLabour(VEIN, ACTOR);
check('activating after the round length draws the same round again (lost widget)', out.widgets.length === 1 && out.widgets[0].nonce === w.nonce, out.widgets.length ? out.widgets[0].nonce : 'none');
out.widgets.length = 0; out.logs.length = 0;
virtual = T + w.totalMs + 180000 + 1; globalThis.__dboLabour(VEIN, ACTOR);
check('a round unreported for the full timeout expires (logged) and a new one opens', out.widgets.length === 1 && out.widgets[0].nonce !== w.nonce && /labour expired/.test(out.logs.join(' | ')), out.logs.join(' | '));

// The seam is reserved for its worker for the round plus reserveSlackMs, not for the whole timeout
{
  const OTHER = 0x16;
  props.set(OTHER + '|private.mastery', { order: ['miner'], skills: { miner: { rank: 3 } } });
  w = fresh();
  out.widgets.length = 0; out.personals.length = 0;
  globalThis.__dboLabour(VEIN, OTHER);
  check('a second worker is still turned away while the round runs', out.widgets.length === 0 && out.personals.some((t) => /Someone is working this seam/.test(t)), JSON.stringify(out.personals));
  sessions_cleanup: { const s = globalThis.__dboLabourRounds; s.delete(OTHER); }
}

// replayCheck 'refuse': the same mismatched win is refused
api.cfg = { labour: { clientJudged: true, replayCheck: 'refuse', perPlayerNodes: false } };
load();
w = fresh();
const slowEven = Array.from({ length: w.strikes }, (_, i) => 1000 + i * 3000);
res = reportC(w, slowEven, Math.max(slowEven[slowEven.length - 1], w.totalMs - 10), 120, T, claimOf(true, w.strikes));
check("replayCheck 'refuse': a mismatched win is refused, nothing paid", verdictOf(res.log) === 'refused(mismatch)' && res.items.length === 0, res.log);
w = fresh(); p = play(w, { aim: 0.5 });
res = reportC(w, p.strikes, p.at, 2500, T, claimOf(true, p.hits));
check("...and an honest win at 2.5 s of lag still wins under it", verdictOf(res.log) === 'win' && res.items.length === 1, res.log);

// ---- the task's cases, over a fake network (tests/lib/netsim.js) ----------------------------------------------------
const NET = require(path.join(__dirname, 'lib', 'netsim.js'));
api.cfg = { labour: { clientJudged: true, perPlayerNodes: false } };
load();
// The widget's verdict is the replay of its own strikes, so any honest round must get the same verdict at every level
{
  const rand = NET.rngOf(11);
  let changed = 0, rounds = 0, wins = 0; const seen = [];
  for (const c of NET.matrix()) {
    for (let i = 0; i < 8; i++) {
      const kind = i % 2 ? 'chopping' : 'mining';
      w = fresh(kind, i % 5);
      p = play(w, i % 3 === 0 ? { sloppy: 0.03 } : { aim: 0.5 + (i % 4) * 0.1 });
      const want = p.hits >= w.strikes ? 'win' : 'lose';
      const lag = NET.arrival(T, p.at, c, rand) - T - p.at;
      res = reportC(w, p.strikes, p.at, lag, T, claimOf(p.hits >= w.strikes, p.hits));
      rounds++; if (want === 'win') wins++;
      if (verdictOf(res.log) !== want) { changed++; if (seen.length < 3) seen.push(`${c.name}: ${res.log}`); }
    }
  }
  check(`no honest verdict changes under ${NET.matrix().length} network conditions (0 to 2.5 s, jitter, resends, 5 and 10 s spikes, an 8.8 s stall, clock rate +-0.5%)`, changed === 0, `${rounds} rounds, ${wins} wins${seen.length ? ' | ' + seen.join(' | ') : ''}`);
}
// Review LAT-1 (2026-10-01): a worker who leaves as soon as the widget shows the win. The server checks the distance when
// the report lands, so a delayed or resent report finds them further off; the radius grows with that report's own lag.
{
  const rand = NET.rngOf(12);
  let changed = 0, n = 0, beyond = 0; const seen = [];
  for (const c of NET.leaveMatrix()) {
    for (const who of NET.LEAVERS) {
      w = fresh('mining', 3); p = play(w, { aim: 0.5 });
      const t = NET.trip(c, rand);
      const lag = NET.arrivalOf(T, p.at, c, t) - T - p.at;
      nearM = 3 + NET.leftMeters(c, t, who);
      if (nearM > 15) beyond++;
      res = reportC(w, p.strikes, p.at, lag, T, claimOf(p.hits >= w.strikes, p.hits));
      n++;
      if (verdictOf(res.log) !== (p.hits >= w.strikes ? 'win' : 'lose')) { changed++; if (seen.length < 3) seen.push(`${c.name}, ${who.name}: ${res.log}`); }
    }
  }
  check(`a worker who leaves right after the verdict keeps it under ${NET.leaveMatrix().length} network conditions (${beyond} of ${n} past the 15 m radius when the report landed)`, changed === 0 && beyond > 0, `${n} rounds${seen.length ? ' | ' + seen.join(' | ') : ''}`);
}
w = fresh(); p = play(w, { aim: 0.5 }); nearM = 17;
res = reportC(w, p.strikes, p.at, 120, T, claimOf(true, p.hits));
check('the radius grows only with the report\'s own lag: 17 m off at 120 ms (15 m + 1.2 m) is refused(far)', verdictOf(res.log) === 'refused(far)', res.log);
w = fresh(); p = play(w, { aim: 0.5 }); nearM = 17;
res = reportC(w, p.strikes, p.at, 1000, T, claimOf(true, p.hits));
check('...and 17 m off when the report took 1 s (15 m + 10 m) is a win', verdictOf(res.log) === 'win', res.log);
w = fresh(); p = play(w, { aim: 0.5 });
virtual = T + p.at + 300; fire('labourCancel', [w.nonce]);
nearM = Infinity;
res = reportC(w, p.strikes, p.at, 2000, T, claimOf(true, p.hits));
check('a report that lands after a load door took the worker to another cell counts where they were when the close arrived', verdictOf(res.log) === 'win' && res.items.length === 1, res.log);
nearM = 2;
for (const rtt of NET.REQUIRED) {
  w = fresh(); p = play(w, { aim: 0.5 });
  res = reportC(w, p.strikes, p.at, rtt, T, claimOf(true, p.hits));
  check(`the new widget's win is accepted at ${rtt} ms`, verdictOf(res.log) === 'win' && judgeOf(res.log) === 'client' && res.items.length === 1, res.log);
  w = fresh(); p = play(w, { aim: 0.5 });
  const loseAt = Math.min(w.totalMs, p.at + 50);
  res = reportC(w, p.strikes.slice(0, 2), loseAt, rtt, T, claimOf(false, Math.min(2, p.hits)));
  check(`...and its loss stands at ${rtt} ms`, verdictOf(res.log) === 'lose' && res.items.length === 0, res.log);
}
for (const lag of [2500, 4000, 9000, 60000]) {
  w = fresh(); p = play(w, { aim: 0.5 });
  res = reportC(w, p.strikes, p.at, lag, T);
  check(`an old widget's timing report is accepted ${lag / 1000} s late`, verdictOf(res.log) === 'win' && judgeOf(res.log) === 'legacy' && res.items.length === 1, res.log);
}
// Duplicate and foreign nonces
w = fresh(); p = play(w, { aim: 0.5 });
res = reportC(w, p.strikes, p.at, 400, T, claimOf(true, p.hits));
const dup = reportC(w, p.strikes, p.at, 900, T, claimOf(true, p.hits));
check('a second report for the same round pays nothing (replay)', verdictOf(res.log) === 'win' && verdictOf(dup.log) === 'replay' && dup.items.length === 0, dup.log);
w = fresh(); p = play(w, { aim: 0.5 });
res = reportC(Object.assign({}, w, { nonce: '99-forged-nonce' }), p.strikes, p.at, 400, T, claimOf(true, p.hits));
check("a report with a nonce this player was never issued pays nothing", res.items.length === 0 && /labour ignored .*another round is live/.test(res.log), res.log);
{
  const OTHER = 0x17;
  const before = out.items.length;
  out.logs.length = 0;
  (handlers.get('labour') || []).forEach((f) => f(OTHER, [w.nonce, JSON.stringify(p.strikes), p.at, claimOf(true, p.hits)], 33));
  check("another player's report on this player's nonce pays nothing", out.items.length === before && /labour ignored .*no round/.test(out.logs.join(' | ')), out.logs.join(' | '));
  res = reportC(w, p.strikes, p.at, 400, T, claimOf(true, p.hits));
  check('...and the round is still there for its own worker', verdictOf(res.log) === 'win' && res.items.length === 1, res.log);
}
// Impossible durations: sooner than the round's exact fastest win, by the widget's clock or the server's
w = fresh(); { const fp2 = fastestPossible(w);
  res = reportC(w, fp2, fp2[fp2.length - 1], -Math.round(fp2[fp2.length - 1] * 0.5), T, claimOf(true, w.strikes));
  check('a win that reaches the server before the round could have been played is refused(fast)', verdictOf(res.log) === 'refused(fast)' && res.items.length === 0, res.log); }
w = fresh(); { const fp3 = fastestPossible(w);
  res = reportC(w, fp3, fp3[fp3.length - 1], 0, T, claimOf(true, w.strikes));
  check('the fastest possible win itself, sent at 0 ms, is accepted', verdictOf(res.log) === 'win', res.log); }
// Cooldowns and caps unchanged: the vein's own rest, the shared rest, the fail rest and the yield
{
  w = fresh('mining', 3); p = play(w, { aim: 0.5 });
  res = reportC(w, p.strikes, p.at, 2500, T, claimOf(true, p.hits));
  const own = Number((props.get(ACTOR + '|private.minedVeins') || {})[VEIN.toString(16)]) || 0;
  const shared = Number(props.get(VEIN + '|private.dboWorkedUntil')) || 0;
  check('a client-judged win rests the vein 30 min for the worker and for everyone', Math.abs(own - (Date.now() + 30 * 60000)) < 5000 && Math.abs(shared - (Date.now() + 30 * 60000)) < 5000, `${own - Date.now()} / ${shared - Date.now()} ms`);
  check('...and pays the same yield as before (iron: 5 x the tier multiplier, 3 until 4 Oct)', res.items.length === 1 && res.items[0][1] >= 5, JSON.stringify(res.items));
  out.widgets.length = 0;
  globalThis.__dboLabour(VEIN, ACTOR);
  check('...so the vein cannot be worked again at once', out.widgets.length === 0, String(out.widgets.length));
  w = fresh('mining', 3);
  res = reportC(w, [100], 600, 2500, T, claimOf(false, 0));
  const fail = Number((props.get(ACTOR + '|private.minedVeins') || {})[VEIN.toString(16)]) || 0;
  check('a client-judged loss takes the 2 min fail rest, as before', verdictOf(res.log) === 'lose' && Math.abs(fail - (Date.now() + 2 * 60000)) < 5000, `${fail - Date.now()} ms`);
}

// Rollback: clientJudged false refuses on lag exactly as before
api.cfg = { labour: { clientJudged: false, perPlayerNodes: false } };
load();
w = fresh(); p = play(w, { aim: 0.5 });
res = reportC(w, p.strikes, p.at, 4000, T, claimOf(true, p.hits));
check('rollback (clientJudged false): the same 4 s lag is refused(late) again', verdictOf(res.log) === 'refused(late)' && judgeOf(res.log) === 'server', res.log);

// ---- "Read the stone": a UI that names 'pickRound' gets a pick round, every other UI today's timing round --------------
console.log('');
console.log('pick rounds:');
api.cfg = { labour: { clientJudged: true, perPlayerNodes: false } };
load();
{
  const TIMING_KEYS = 'type,id,nonce,kind,title,strikes,band,bands,sweepMs,totalMs,hitMs,missMs,judge';
  const MG = require(path.join(SERVER, 'minigames.js'));
  pickUi = false;
  w = fresh('mining', 2);
  check('a UI without the capability gets exactly the timing round', Object.keys(w).join(',') === TIMING_KEYS, Object.keys(w).join(','));
  p = play(w, { aim: 0.5 });
  res = reportC(w, p.strikes, p.at, 200, T, claimOf(true, p.hits));
  const timingItems = JSON.stringify(res.items);
  check('...which still wins as before', verdictOf(res.log) === 'win' && !/ pick /.test(res.log), res.log);
  pickUi = true;
  const claimP = (win, hits, slips) => JSON.stringify({ v: 2, mode: 'pick', win, hits, slips });
  // wrong[k] wasted blows before the k-th landed one, 500 ms apart
  const picks = (pw, wrong) => { const o = []; let t = 0, k = 0; for (const n of wrong) { for (let i = 0; i < n; i++) { t += 500; o.push([(MG.rightOf(pw.steps[k]) + 1) % pw.steps[k].length, t]); k++; } t += 500; o.push([MG.rightOf(pw.steps[k]), t]); k++; } return o; };
  w = fresh('mining', 2);
  check('a UI with it gets a pick round: a set of spots for every blow it can take, no sweep, no bands', w.mode === 'pick' && w.steps.length === w.strikes + w.slips && w.bands === undefined && w.sweepMs === undefined && w.totalMs === 90000, Object.keys(w).join(','));
  check('four spots at Novice to Adept, three at Expert; more wasted blows allowed with rank', w.steps.every((st) => st.length === 4) && fresh('mining', 3).steps.every((st) => st.length === 3) && fresh('mining', 0).slips === 2 && fresh('mining', 4).slips === 4);
  check('the issue line names the pick round', /labour issue .* pick slips=\d+ spots=\d+ min=\d+/.test(out.logs.join(' | ')), out.logs.slice(-1)[0]);
  w = fresh('mining', 2);
  let l = picks(w, [0, 0, 0, 0, 0, 0]);
  res = reportC(w, l, l[l.length - 1][1], 200, T, claimP(true, 6, 0));
  check('six right picks win and pay exactly what the timing round pays', verdictOf(res.log) === 'win' && JSON.stringify(res.items) === timingItems && / pick slips=0\//.test(res.log), `${res.log} ${JSON.stringify(res.items)} vs ${timingItems}`);
  w = fresh('mining', 2);
  l = picks(w, [1, 0, 1, 0, 1, 0]);
  res = reportC(w, l, l[l.length - 1][1], 200, T, claimP(true, 6, 3));
  check('wasted blows within the allowance still win (3 of 3 at Adept)', verdictOf(res.log) === 'win' && res.items.length === 1, res.log);
  w = fresh('mining', 2);
  l = picks(w, [2, 2]).slice(0, 5);
  res = reportC(w, l, l[l.length - 1][1], 200, T, claimP(false, 1, 4));
  const fail = Number((props.get(ACTOR + '|private.minedVeins') || {})[VEIN.toString(16)]) || 0;
  check('one wasted blow past the allowance loses, with the fail rest', verdictOf(res.log) === 'lose' && res.items.length === 0 && Math.abs(fail - (Date.now() + 2 * 60000)) < 5000, res.log);
  w = fresh('mining', 2);
  res = reportC(w, [[MG.rightOf(w.steps[0]), 3000]], 90000, 200, T, claimP(false, 1, 0));
  check('an idle round ends at its 90 s limit as a loss', verdictOf(res.log) === 'lose' && res.items.length === 0, res.log);
  w = fresh('mining', 2);
  l = picks(w, [0, 0, 0, 0, 0, 0]).concat([[0, 9000]]);
  res = reportC(w, l, 9000, 200, T, claimP(true, 6, 0));
  check('a pick after the last blow is refused(extra)', verdictOf(res.log) === 'refused(extra)' && res.items.length === 0, res.log);
  w = fresh('mining', 2);
  l = w.steps.slice(0, 6).map((st, k) => [MG.rightOf(st), 20 + k * 20]);
  res = reportC(w, l, 140, 200, T, claimP(true, 6, 0));
  check('picks faster than a hand are refused(fast)', verdictOf(res.log) === 'refused(fast)' && res.items.length === 0, res.log);
  w = fresh('mining', 2);
  res = reportC(w, [[9, 500]], 500, 200, T, claimP(false, 0, 1));
  check('a spot that was never drawn is refused(range)', verdictOf(res.log) === 'refused(range)', res.log);
  w = fresh('mining', 2);
  res = reportC(w, JSON.stringify([500, 900]), 900, 200, T, claimP(false, 0, 0));
  check('timing strikes sent for a pick round are refused, not judged as picks', /refused\(range\)/.test(res.log) && res.items.length === 0, res.log);
  w = fresh('mining', 2);
  l = w.steps.slice(0, 3).map((st, k) => [(MG.rightOf(st) + 1) % st.length, 500 + k * 500]);
  res = reportC(w, l, 3000, 200, T, claimP(true, 6, 0));
  check("a claimed win its picks do not bear out is audited (replayCheck 'log')", out.audits.some((t) => /^LABOUR-MISMATCH /.test(t)) && /mismatch/.test(susOf(res.log)), res.log);
  w = fresh('chopping', 1);
  l = picks(w, new Array(w.strikes).fill(0));
  res = reportC(w, l, l[l.length - 1][1], 200, T, claimP(true, w.strikes, 0));
  check('chopping: a pick round splits the log and gives the same firewood (4 at tier 2) and 2 charcoal', verdictOf(res.log) === 'win' && res.items.length === 2 && res.items[0][1] === 4 && res.items[1][1] === 2, `${res.log} ${JSON.stringify(res.items)}`);
  let agree = 0;
  for (let i = 0; i < 200; i++) {
    const rw = fresh(i % 2 ? 'chopping' : 'mining', i % 5);
    const list = []; let hits = 0, slips = 0, t = 0;
    for (let k = 0; hits < rw.strikes && slips <= rw.slips; k++) {
      t += 200 + Math.floor(Math.random() * 900);
      const pick = Math.random() < 0.75 ? MG.rightOf(rw.steps[k]) : Math.floor(Math.random() * rw.steps[k].length);
      list.push([pick, t]);
      if (pick === MG.rightOf(rw.steps[k])) hits++; else slips++;
    }
    const rr = reportC(rw, list, t, 150, T, claimP(hits >= rw.strikes, hits, slips));
    if (verdictOf(rr.log) === (hits >= rw.strikes ? 'win' : 'lose') && !/mismatch/.test(susOf(rr.log))) agree++;
  }
  check('the widget and the server agree on 200 random pick rounds', agree === 200, `${agree}/200`);
  api.cfg = { labour: { clientJudged: true, pick: { enabled: false } } };
  load();
  w = fresh('mining', 2);
  check('labour.pick.enabled false gives every UI the timing round again', Object.keys(w).join(',') === TIMING_KEYS, Object.keys(w).join(','));
  api.cfg = { labour: { clientJudged: true, perPlayerNodes: false } };
  load();
  pickUi = false;
}


// A chopping block placed with the F7 Place tab has a dynamic id: it runs the round too (Nate, 8 Oct), an untagged dynamic ref does not
{
  const PLACED = 0xff00abcd, LOOSE = 0xff00abce;
  props.set(PLACED + '|baseDesc', BLOCK_BASE); props.set(PLACED + '|private.dboPlaced', { base: BLOCK_BASE, kind: 'object' }); props.set(PLACED + '|pos', [1000, 2000, 0]);
  props.set(LOOSE + '|baseDesc', BLOCK_BASE);
  out.widgets.length = 0; clearRests(); setTier('woodcutter', 0);
  check('a placed chopping block is taken by labour (no vanilla chopping)', globalThis.__dboLabour(PLACED, ACTOR) === true);
  check('an untagged dynamic block is left alone', globalThis.__dboLabour(LOOSE, ACTOR) === false);
}

// gatheringSystem.ts paid a seated chopper firewood every 5 s (8 Oct): any chopping-block activation ends its sessions at
// that block, through its seat-close hook, at 1 s and 4 s, before its first strike, whatever labour decided
{
  const timers = [], closed = [], realTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (f, ms) => { timers.push([f, ms]); return 0; };
  api.mp['onPapyrusEvent:SkympOnActivateClose'] = (ref) => closed.push(ref >>> 0);
  setTier('woodcutter', 0); clearRests(); out.widgets.length = 0;
  globalThis.__dboLabour(BLOCK, ACTOR);
  check('a chopping-block round schedules the gathering close at 1 s and 4 s', JSON.stringify(timers.map((t) => t[1])) === '[1000,4000]', timers.map((t) => t[1]));
  timers.splice(0).forEach(([f]) => f());
  check('...which ends the gathering sessions at that block', closed.length === 2 && closed.every((r) => r === (BLOCK >>> 0)), closed);
  props.set(ACTOR + '|private.mastery', { order: [], skills: {} }); closed.length = 0;
  const handled = globalThis.__dboLabour(BLOCK, ACTOR);
  timers.splice(0).forEach(([f]) => f());
  check('...also when labour lets the activation through (no Woodcutter yet)', handled === false && closed.length === 2, JSON.stringify({ handled, closed }));
  delete api.mp['onPapyrusEvent:SkympOnActivateClose'];
  globalThis.__dboLabour(VEIN, ACTOR);
  globalThis.setTimeout = realTimeout;
}

console.log('');
console.log(failures ? `${failures} FAILURES` : 'all checks passed');
process.exit(failures ? 1 : 0);

