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

const out = { widgets: [], logs: [], audits: [], items: [], personals: [] };
const handlers = new Map();

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
  cfg: {},
  openWidget: (a, w) => { out.widgets.push(w); return true; },
  closeWidget: () => true,
  onUi: (ev, fn) => { const l = handlers.get(ev) || []; l.push(fn); handlers.set(ev, l); },
  giveItem: (a, id, n) => { out.items.push([id, n]); return true; },
  skills: require(path.join(SERVER, 'skills.json')),
};

// gamemode.js rebuilds its ui registry on every reload, so the handlers go with it
const load = () => { delete require.cache[require.resolve(LABOUR)]; handlers.clear(); require(LABOUR)(api); };
const fire = (ev, args, widget) => (handlers.get(ev) || []).forEach((f) => f(ACTOR, args, widget || 33));

const setTier = (skill, rank) => props.set(ACTOR + '|private.mastery', { order: [skill], skills: { [skill]: { rank } } });
const clearRests = () => { props.delete(ACTOR + '|private.minedVeins'); props.delete(ACTOR + '|private.choppedBlocks'); };

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
  out.logs.length = 0; out.items.length = 0; out.audits.length = 0; out.widgets.length = 0;
  fire('labour', [w.nonce, typeof strikes === 'string' ? strikes : JSON.stringify(strikes), at]);
  return { log: out.logs.join(' | '), items: out.items.slice(), audit: out.audits.slice(), result: out.widgets[0] };
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
virtual = 9650000; r = openRound('mining', 4); w = r.w;
const slowStrikes = fastestPossible(w);
res = report(w, slowStrikes, slowStrikes[slowStrikes.length - 1], slowStrikes[slowStrikes.length - 1], 9650000);
check('a sweep played at half speed is refused', verdictOf(res.log) === 'refused(late)', res.log);
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

console.log('');
console.log(failures ? `${failures} FAILURES` : 'all checks passed');
process.exit(failures ? 1 : 0);
