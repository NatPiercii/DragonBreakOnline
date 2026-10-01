// Scripted packet test for the skinning mini-game in server\gamemode.js. The round builder, the
// blade and the judge are lifted out of gamemode.js by name and run in a sandbox, so this tests the
// real code without booting the whole gamemode (which needs a live mp). Run it from server\ with
//
//   node tests\skinning-harness.js
//
// It covers the honest path (the widget's count and the server's must always agree) and the
// forgeries migration 7 of SERVER_AUTHORITY.md is about: a cut count with no times, times that
// ignore the seam, cuts after the attempt ended, and reports that outrun the server's clock.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const GAMEMODE = path.resolve(__dirname, '..', 'gamemode.js');
const src = fs.readFileSync(GAMEMODE, 'utf8');

// Pull `const <name> = ...;` out of the file: scan from the declaration to the semicolon that closes
// it, keeping track of brackets, strings, template literals and comments.
const declOf = (name) => {
  const start = src.indexOf(`\nconst ${name} = `);
  if (start < 0) throw new Error(`${name} not found in gamemode.js`);
  let i = start + 1;
  let depth = 0;
  let quote = '';
  let line = false;
  let block = false;
  const tmpl = [];
  for (; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (line) { if (c === '\n') line = false; continue; }
    if (block) { if (c === '*' && n === '/') { block = false; i++; } continue; }
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = '';
      else if (quote === '`' && c === '$' && n === '{') { tmpl.push(depth); depth++; quote = ''; i++; }
      continue;
    }
    if (c === '/' && n === '/') { line = true; i++; continue; }
    if (c === '/' && n === '*') { block = true; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === '}') {
      depth--;
      if (tmpl.length && tmpl[tmpl.length - 1] === depth) { tmpl.pop(); quote = '`'; }
    } else if (c === ';' && depth === 0) return src.slice(start + 1, i + 1);
  }
  throw new Error(`${name}: no end found`);
};

// Math.random, seeded, for the rounds (skinRound draws its seed from it) and for the sloppy player: every run judges the
// same rounds, so no check passes or fails on the draw. The blind forgery in 5 wins about 1 round in 20 at the widest
// seam by luck, and asserted on one unseeded round it failed run-all 2 runs in 30 (2026-09-30). reseed() gives each
// section its own sequence, so a check added to one never moves the rounds another sees.
let rngState = 0;
const reseed = (n) => { rngState = Math.imul(0x9e3779b9, n + 1) >>> 0; };
const random = () => {
  rngState = (rngState + 0x6d2b79f5) >>> 0;
  let t = Math.imul(rngState ^ (rngState >>> 15), rngState | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const seededMath = Object.create(Math);
seededMath.random = random;

let virtual = 1000;
// The cases up to "client-judged" are today's server-judged rules: they run with the rollback switch (clientJudged
// false), which so proves it behaves exactly as before. The client-judged cases are at the end.
const MG = require(path.resolve(__dirname, '..', 'minigames.js'));
const sandbox = {
  SKIN_WIDGET_ID: 33,
  SKIN: { cuts: 3, misses: 2, seconds: 15, lagGraceMs: 2500, clockSlackMs: 50, clientJudged: false },
  performance: { now: () => virtual },
  Math: seededMath, JSON, Number, Array, String, Object, Date, MG,
  out: {},
};
const names = ['skinRng', 'bladeAt', 'skinMinMs', 'skinRound', 'skinPacket', 'judgeSkin'];
vm.runInNewContext(names.map(declOf).join('\n') + `\nout = { ${names.join(', ')} };`, sandbox);
const { skinRng, bladeAt, skinRound, skinPacket, judgeSkin } = sandbox.out;

// ---- a player, behaving exactly as the widget does ----------------------------------------------
// aim 1 cuts anywhere in the seam, 0.2 waits for the middle of it, sloppy cuts at random. A hand
// needs a moment between cuts; the widget itself has no stagger.
const play = (w, opt) => {
  const o = Object.assign({ aim: 0.7, sloppy: 0, restMs: 260 }, opt || {});
  const times = [];
  let cuts = 0;
  let slips = 0;
  let ready = 0;
  let at = w.totalMs;
  for (let el = 0; el <= w.totalMs; el += 16) {
    if (cuts >= w.cuts || slips > w.allowed) { at = el; break; }
    if (el < ready) continue;
    const pos = bladeAt(el, w.sweepMs);
    const inSeam = Math.abs(pos - w.seams[cuts]) <= w.width / 2;
    const press = o.sloppy ? random() < o.sloppy : Math.abs(pos - w.seams[cuts]) <= (w.width / 2) * o.aim;
    if (!press) continue;
    times.push(el);
    ready = el + o.restMs;
    if (inSeam) cuts++; else slips++;
    at = el;
  }
  return { times, cuts, slips, at };
};

// The cheapest forgery: the earliest moment the blade is in each seam, one after another
const fastestPossible = (w) => {
  const times = [];
  let t = 0;
  for (let i = 0; i < w.cuts; i++) {
    while (t <= w.totalMs && Math.abs(bladeAt(t, w.sweepMs) - w.seams[i]) > w.width / 2) t++;
    if (t > w.totalMs) return null;
    times.push(t);
    t++;
  }
  return times;
};

// What the blade really puts in a seam for these presses, counted the way the widget counts them
const bladeCount = (w, times) => {
  let cuts = 0;
  let slips = 0;
  for (const t of times) {
    if (cuts >= w.cuts || slips > w.allowed) break;
    if (Math.abs(bladeAt(t, w.sweepMs) - w.seams[cuts]) <= w.width / 2) cuts++; else slips++;
  }
  return { cuts, slips };
};

const judge = (w, times, at, lagMs) => judgeSkin(w, typeof times === 'string' ? times : JSON.stringify(times), at, at + (lagMs === undefined ? 150 : lagMs));
const verdict = (v, w) => (v.bad ? 'refused(' + v.bad + ')' : v.cuts >= w.cuts ? 'win' : 'lose');

let failures = 0;
const check = (name, cond, detail) => {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);
};

// 1. the round the server issues
reseed(1);
const w0 = skinRound(0x14, 2, 0xff001234, 'wolf');
check('round carries one seam per cut and nothing to judge with', w0.seams.length === w0.cuts && w0.seed !== undefined,
  `cuts=${w0.cuts} slips=${w0.allowed} width=${w0.width} sweepMs=${w0.sweepMs} totalMs=${w0.totalMs} seams=${JSON.stringify(w0.seams)}`);
check('every seam sits fully on the hide', w0.seams.every((s) => s >= w0.width / 2 - 1e-9 && s <= 1 - w0.width / 2 + 1e-9), '');
const packet = skinPacket(w0);
check('the packet has no seed, no answer, no verdict', packet.seed === undefined && packet.result === undefined && Array.isArray(packet.seams),
  `keys: ${Object.keys(packet).join(',')}`);
check('the seams are reproducible from the seed in the log', (() => {
  const rand = skinRng(w0.seed);
  return w0.seams.every((s) => Math.abs(Math.round((w0.width / 2 + rand() * (1 - w0.width)) * 10000) / 10000 - s) < 1e-9);
})(), `seed=${w0.seed.toString(16)}`);

// 2. the tier curves still run the right way
reseed(2);
const t0 = skinRound(0x14, 0, 1, 'x');
const t4 = skinRound(0x14, 4, 1, 'x');
check('a better Skinner gets a wider seam and a slower blade', t4.width > t0.width && t4.sweepMs > t0.sweepMs,
  `tier1 width ${t0.width} sweep ${t0.sweepMs}ms -> tier5 width ${t4.width} sweep ${t4.sweepMs}ms`);

// 3. honest attempts: the server's count must equal the widget's, every time
reseed(3);
let mismatch = 0; let wins = 0;
for (let i = 0; i < 60; i++) {
  const w = skinRound(0x14, i % 5, 1, 'wolf');
  const p = i % 3 === 0 ? play(w, { sloppy: 0.05 + (i % 5) * 0.02 }) : play(w, { aim: 0.4 + (i % 6) * 0.1 });
  const v = judge(w, p.times, p.at, 40 + (i % 6) * 50);
  if (v.bad || v.cuts !== p.cuts || v.slips !== p.slips) { mismatch++; console.log('   mismatch:', JSON.stringify(v), `widget ${p.cuts}/${p.slips}`); }
  if (verdict(v, w) === 'win') wins++;
}
check('widget and server agree on every cut, 60 attempts', mismatch === 0, `${wins} of 60 won, ${mismatch} mismatches`);

// 4. the old exploit: report three cuts after 1.5 s and take the pelt
reseed(4);
const w1 = skinRound(0x14, 4, 1, 'wolf');
check('a bare cut count is not a report any more', judge(w1, '3', 1500, 100).bad === 'malformed', '');
check('an empty list wins nothing', verdict(judge(w1, [], 1500, 100), w1) === 'lose', '');

// 5. forged times that ignore the seam. A blind guess lands in a seam now and then, so one round proves nothing either
// way: over a thousand rounds at the widest seam (tier 5), the server credits only the cuts the blade really makes, and
// the forgery wins no more often than luck lets it (about 1 round in 20; a forger who knew the seams would win them all).
reseed(5);
const evenly = [0, 500, 1000, 1500, 2000];
const ROUNDS = 1000;
let blindWins = 0;
let freeCuts = 0;
let sample = null;
for (let i = 0; i < ROUNDS; i++) {
  const w = skinRound(0x14, 4, 1, 'wolf');
  const v = judge(w, evenly, 2000, 100);
  const real = bladeCount(w, evenly);
  if (!v.bad && (v.cuts !== real.cuts || v.slips !== real.slips)) { freeCuts++; sample = sample || { v, real }; }
  if (verdict(v, w) === 'win') blindWins++;
}
check('evenly spaced forgery earns only the cuts the blade really makes, 1000 rounds', freeCuts === 0, sample ? JSON.stringify(sample) : '');
check('...and wins no more often than luck, under 1 round in 10', blindWins / ROUNDS < 0.1, `${blindWins} of ${ROUNDS} won by luck`);

// 6. what a perfect forgery still costs in real time
reseed(6);
const w3 = skinRound(0x14, 0, 1, 'wolf');
const best = fastestPossible(w3);
const v6 = judge(w3, best, best[best.length - 1], 100);
check('a perfectly computed attempt still has to be played out', verdict(v6, w3) === 'win',
  `${best[best.length - 1]} ms of real time for ${w3.cuts} cuts (the old rule asked for 1500 ms and no times at all)`);

// 7. impossible reports
reseed(7);
const w4 = skinRound(0x14, 2, 1, 'wolf');
const good = fastestPossible(w4);
check('more cuts than the attempt allows is refused', judge(w4, Array.from({ length: 12 }, (_, i) => i * 100), 1200, 100).bad === 'flood', '');
check('a cut after the last one it needed is refused', judge(w4, good.concat([good[good.length - 1] + 400]), good[good.length - 1] + 400, 100).bad === 'extra', '');
check('cuts out of order are refused', judge(w4, [good[0] + 500, good[0]], good[0] + 500, 100).bad === 'order', '');
check('fractional time refused', judge(w4, [12.5], 100, 100).bad === 'range', '');
check('negative time refused', judge(w4, [-1], 100, 100).bad === 'range', '');
check('time past the attempt refused', judge(w4, [w4.totalMs + 1], w4.totalMs + 1, 100).bad === 'range', '');
check('garbage payload refused', judge(w4, 'not json', 100, 100).bad === 'malformed', '');
check('a cut later than the report itself is refused', judge(w4, good, good[good.length - 1] - 50, 100).bad === 'submit', '');
check('a report that outruns the server clock is refused', judge(w4, good, good[good.length - 1], -900).bad === 'future', '');
check('a report from ten minutes ago is refused', judge(w4, good, good[good.length - 1], 600000).bad === 'late', '');

// Slow motion is the one cheat the seam check alone cannot see: draw the blade slower than the round
// says and scale the reported times back down. The stretch shows up as lag, so the lag grace is
// exactly how much of it is possible — and an attempt is short, so the grace matters more here than
// in labour. This prints the exposure at the current setting rather than asserting it away.
const human = play(w4, { aim: 0.6 });
check('stretching the attempt past the lag grace is refused', judge(w4, human.times, human.at, sandbox.SKIN.lagGraceMs + 1).bad === 'late', '');
check('inside the grace it is allowed, which is the exposure', judge(w4, human.times, human.at, sandbox.SKIN.lagGraceMs - 1).bad === '',
  `a ${human.at} ms attempt can be drawn out to ${human.at + sandbox.SKIN.lagGraceMs} ms today (${((human.at + sandbox.SKIN.lagGraceMs) / human.at).toFixed(1)}x slower blade) - tighten cfg.skinning.lagGraceMs once a playtest has measured the real lag`);

// 8. the seams really are different every attempt
reseed(8);
const seen = new Set();
for (let i = 0; i < 20; i++) seen.add(JSON.stringify(skinRound(0x14, 2, 1, 'x').seams));
check('every attempt gets its own seam sequence', seen.size === 20, `${seen.size} distinct of 20`);

// ---- client-judged (skinning.clientJudged true; Jake, 2026-09-30): the widget's verdict stands, latency refuses nothing
console.log('');
console.log('client-judged:');
const NET = require(path.join(__dirname, 'lib', 'netsim.js'));
const A = 0x14, B = 0x15, CORPSE = 0xff001234, PELT = 0x3ad6f;
const props = new Map();
const cj = { logs: [], audits: [], said: [], widgets: [], closed: 0, given: [], events: [] };
const SK = { cuts: 3, misses: 2, seconds: 15, lagGraceMs: 2500, clockSlackMs: 50, bonusByTier: [0, 0, 0, 0, 0],
  clientJudged: true, roundTimeoutMs: 120000, firstCutMs: 150, cutGapMs: 80, nearUnits: 400, movedUnits: 200, issueUnits: 1500, slowFlagMs: 5000, replayCheck: 'log' };
const sb = {
  SKIN_WIDGET_ID: 33, SKIN: SK, MG,
  performance: { now: () => virtual },
  Math: seededMath, JSON, Number, Array, String, Object, Date, Map, Set, Infinity, isFinite,
  skinSessions: new Map(), skinSpent: new Map(), skinClosing: new Map(),
  log: (...x) => cj.logs.push(x.join(' ')), display: () => 'Skinner #ABCD', who: () => 'Skinner #ABCD (profile 1)',
  audit: (t) => cj.audits.push(t), personal: (a, t) => cj.said.push(t),
  openWidget: (a, w) => { cj.widgets.push(w); return true; }, closeWidget: () => { cj.closed++; return true; },
  mp: { get: (id, k) => props.get(id + '|' + k), set: (id, k, v) => props.set(id + '|' + k, v) },
  giveItem: (a, id, n) => { cj.given.push([id, n]); return true; },
  recordOf: () => ({ record: { editorId: 'WolfPelt' } }), edidWords: (e, f) => e || f, peltsWorth: () => 5,
  globalThis: { __alduinakMasteryEvent: (k, a) => cj.events.push(k) },
  out: {},
};
const cjNames = ['skinRng', 'bladeAt', 'skinMinMs', 'skinRound', 'skinPacket', 'judgeSkin', 'skinNear', 'skinLimit', 'skinKeepClosing', 'skinIgnored', 'skinClaimOf', 'skinReport', 'skinCancel'];
vm.runInNewContext(cjNames.map(declOf).join('\n') + `\nout = { ${cjNames.join(', ')} };`, sb);
const S = sb.out;
const pos = (id, p) => props.set(id + '|pos', p);
// An attempt as __dboSkin issues it: the skinner beside the body, the body with one pelt, not yet skinned
const issue = (o) => {
  const opt = Object.assign({ tier: 2, me: [0, 0, 0], body: [100, 0, 0], who: A }, o || {});
  virtual += 1000000;
  pos(opt.who, opt.me); pos(CORPSE, opt.body);
  props.set(CORPSE + '|private.dboPelts', [{ baseId: PELT, count: 1 }]); props.set(CORPSE + '|private.dboSkinned', false);
  const r = S.skinRound(opt.who, opt.tier, CORPSE, 'wolf');
  r.issuePos = opt.me.slice(); r.issueDist = Math.hypot(opt.me[0] - opt.body[0], opt.me[1] - opt.body[1], opt.me[2] - opt.body[2]);
  sb.skinSessions.set(opt.who, r);
  return r;
};
// A human hand: no cut in the first 200 ms, a moment between cuts (the widget itself has no stagger)
const playHuman = (w, o) => {
  const opt = Object.assign({ aim: 0.6, react: 200, restMs: 260, sloppy: 0 }, o || {});
  const times = []; let cuts = 0, slips = 0, ready = opt.react, at = w.totalMs;
  for (let el = 0; el <= w.totalMs; el += 16) {
    if (cuts >= w.cuts || slips > w.allowed) { at = el; break; }
    if (el < ready) continue;
    const inSeam = Math.abs(bladeAt(el, w.sweepMs) - w.seams[cuts]) <= w.width / 2;
    const press = opt.sloppy ? random() < opt.sloppy : Math.abs(bladeAt(el, w.sweepMs) - w.seams[cuts]) <= (w.width / 2) * opt.aim;
    if (!press) continue;
    times.push(el); ready = el + opt.restMs; at = el;
    if (inSeam) cuts++; else slips++;
  }
  return { times, cuts, slips, at, win: cuts >= w.cuts };
};
const claimS = (p) => JSON.stringify({ v: 2, win: p.win, hits: p.cuts, slips: p.slips, frames: 600, maxFrameMs: 34 });
const reportS = (r, times, at, lag, claim, who) => {
  virtual = r.startedAt + at + lag;
  cj.logs.length = 0; cj.given.length = 0; cj.widgets.length = 0; cj.said.length = 0; cj.events.length = 0; cj.audits.length = 0;
  const args = [r.nonce, typeof times === 'string' ? times : JSON.stringify(times), at];
  if (claim !== undefined) args.push(claim);
  S.skinReport(who || A, args);
  return { log: cj.logs.join(' | '), given: cj.given.slice(), result: cj.widgets[0], said: cj.said.slice(), audits: cj.audits.slice() };
};
const vOf = (line) => (/skinning (win|lose|refused\([a-z-]+\)|stale-ui|replay|ignored)/.exec(line) || [])[1] || '?';
const jOf = (line) => (/ judge=(\w+)/.exec(line) || [])[1] || '?';
const sOf = (line) => (/ sus=([\w,-]+)/.exec(line) || [])[1] || '';

reseed(20);
let cr = issue(), cp = playHuman(cr);
check('the attempt tells the widget it is the judge', S.skinPacket(cr).judge === 'client');
check('the fastest a hand can win it is computed at issue (min=)', cr.minMs >= 150 && cr.minMs <= cr.totalMs, String(cr.minMs));
let rs;
for (const rtt of NET.REQUIRED) {
  cr = issue(); cp = playHuman(cr, { aim: 0.5 });
  rs = reportS(cr, cp.times, cp.at, rtt, claimS(cp));
  check(`the new widget's win is accepted at ${rtt} ms`, vOf(rs.log) === (cp.win ? 'win' : 'lose') && cp.win && jOf(rs.log) === 'client' && rs.given.length === 1, rs.log);
  cr = issue(); cp = playHuman(cr, { sloppy: 0.2 });
  const lostP = Object.assign({}, cp, { win: false });
  rs = reportS(cr, cp.times, cp.at, rtt, claimS(lostP));
  check(`...and its loss stands at ${rtt} ms`, vOf(rs.log) === 'lose' && rs.given.length === 0, rs.log);
}
{
  const rand = NET.rngOf(21); let changed = 0, n = 0; const seen = [];
  for (const c of NET.matrix()) {
    for (let i = 0; i < 6; i++) {
      cr = issue({ tier: i % 5 }); cp = playHuman(cr, i % 2 ? { sloppy: 0.04 } : { aim: 0.4 + (i % 3) * 0.2 });
      const lag = NET.arrival(cr.startedAt, cp.at, c, rand) - cr.startedAt - cp.at;
      rs = reportS(cr, cp.times, cp.at, lag, claimS(cp));
      n++;
      if (vOf(rs.log) !== (cp.win ? 'win' : 'lose')) { changed++; if (seen.length < 3) seen.push(`${c.name}: ${rs.log}`); }
    }
  }
  check(`no honest verdict changes under ${NET.matrix().length} network conditions`, changed === 0, `${n} attempts${seen.length ? ' | ' + seen.join(' | ') : ''}`);
}
for (const lag of [2500, 3247, 9000, 60000]) {
  cr = issue(); cp = playHuman(cr, { aim: 0.5 });
  rs = reportS(cr, cp.times, cp.at, lag);
  check(`an old widget's cut report ${lag / 1000} s late is judged from its cuts and wins`, vOf(rs.log) === 'win' && jOf(rs.log) === 'legacy' && rs.given.length === 1, rs.log);
}
// Duplicate and foreign nonces
cr = issue(); cp = playHuman(cr, { aim: 0.5 });
rs = reportS(cr, cp.times, cp.at, 400, claimS(cp));
const dupS = reportS(cr, cp.times, cp.at, 900, claimS(cp));
check('a second report for the same attempt pays nothing (replay)', vOf(rs.log) === 'win' && vOf(dupS.log) === 'replay' && dupS.given.length === 0, dupS.log);
cr = issue(); cp = playHuman(cr, { aim: 0.5 });
rs = reportS(Object.assign({}, cr, { nonce: '14-forged' }), cp.times, cp.at, 400, claimS(cp));
check('a report on a nonce this skinner was never issued pays nothing', rs.given.length === 0 && /skinning ignored .*another attempt is live/.test(rs.log), rs.log);
rs = reportS(cr, cp.times, cp.at, 400, claimS(cp), B);
check("another player's report on this skinner's nonce pays nothing", rs.given.length === 0 && /skinning ignored .*no attempt/.test(rs.log), rs.log);
rs = reportS(cr, cp.times, cp.at, 400, claimS(cp));
check('...and the attempt is still there for its own skinner', vOf(rs.log) === 'win' && rs.given.length === 1, rs.log);
// Impossible durations
cr = issue();
{ const quick = [10, 20, 30]; rs = reportS(cr, quick, 30, 120, JSON.stringify({ v: 2, win: true, hits: 3, slips: 0 })); }
check('cuts no hand could make (the first at 10 ms) are refused(fast)', vOf(rs.log) === 'refused(fast)' && rs.given.length === 0, rs.log);
cr = issue(); cp = playHuman(cr, { aim: 0.5 });
rs = reportS(cr, cp.times, cp.at, -cp.at + 50, claimS(cp));
check('a win reaching the server 50 ms after it sent the attempt is refused(fast)', vOf(rs.log) === 'refused(fast)' && rs.given.length === 0, rs.log);
// Caps unchanged: one skinning per body, the pelts it holds, the Skinner credited once
cr = issue(); cp = playHuman(cr, { aim: 0.5 });
rs = reportS(cr, cp.times, cp.at, 2500, claimS(cp));
check('a client-judged win takes the pelt and marks the body skinned', vOf(rs.log) === 'win' && rs.given.length === 1 && rs.given[0][0] === PELT && props.get(CORPSE + '|private.dboSkinned') === true && cj.events.join() === 'skin', rs.log);
{
  const r2 = S.skinRound(A, 2, CORPSE, 'wolf'); r2.issuePos = [0, 0, 0]; r2.issueDist = 100; sb.skinSessions.set(A, r2); r2.startedAt = virtual;
  const p2 = playHuman(r2, { aim: 0.5 });
  rs = reportS(r2, p2.times, p2.at, 400, claimS(p2));
  check('...so a second attempt on the same body wins nothing', vOf(rs.log) === 'lose' && /already-skinned/.test(rs.log) && rs.given.length === 0, rs.log);
}
// Distance: the stale corpse position that cost 9 earned wins, and walking away
cr = issue({ body: [900, 0, 0] }); cp = playHuman(cr, { aim: 0.5 });
rs = reportS(cr, cp.times, cp.at, 400, claimS(cp));
check('a skinner who stood still wins though the server puts the body 900 units off (stale position)', vOf(rs.log) === 'win' && rs.given.length === 1, rs.log);
cr = issue(); cp = playHuman(cr, { aim: 0.5 }); pos(A, [3000, 0, 0]);
rs = reportS(cr, cp.times, cp.at, 400, claimS(cp));
check('a skinner who walked 3000 units away loses (too far)', vOf(rs.log) === 'lose' && /too-far/.test(rs.log) && rs.given.length === 0, rs.log);
// Cleanup, not a deadline
cr = issue(); cp = playHuman(cr, { aim: 0.5 });
rs = reportS(cr, cp.times, cp.at, 100000, claimS(cp));
check('a report 100 s late is still judged', vOf(rs.log) === 'win', rs.log);
cr = issue(); cp = playHuman(cr, { aim: 0.5 });
rs = reportS(cr, cp.times, cp.at, 200000, claimS(cp));
check('a report past the 2 min cleanup is refused(expired)', vOf(rs.log) === 'refused(expired)' && rs.given.length === 0, rs.log);
// Stop overtaking the report, and a Stop from an attempt already replaced
cr = issue(); cp = playHuman(cr, { aim: 0.5 });
virtual = cr.startedAt + cp.at + 20; S.skinCancel(A, [cr.nonce]);
rs = reportS(cr, cp.times, cp.at, 300, claimS(cp));
check('a report that lands after Stop is still judged and paid, its verdict told in chat', vOf(rs.log) === 'win' && /after-cancel/.test(sOf(rs.log)) && rs.given.length === 1 && !rs.result && rs.said.length === 1, rs.log);
cr = issue(); cp = playHuman(cr, { aim: 0.5 });
S.skinCancel(A, ['14-an-older-attempt']);
check('a Stop for an older attempt does not end the live one', sb.skinSessions.get(A) === cr);
rs = reportS(cr, cp.times, cp.at, 300, claimS(cp));
check('...which still wins', vOf(rs.log) === 'win', rs.log);
// Mismatches
cr = issue(); cp = playHuman(cr, { aim: 0.5 });
{ const forged = [1000, 2000, 3000]; rs = reportS(cr, forged, cr.totalMs - 10, 120, JSON.stringify({ v: 2, win: true, hits: 3, slips: 0 })); }
const realCuts = bladeCount(cr, [1000, 2000, 3000]);
check("replayCheck 'log' (default): a claimed win its cuts do not bear out stands, flagged and audited", realCuts.cuts >= cr.cuts || (vOf(rs.log) === 'win' && /mismatch/.test(sOf(rs.log)) && rs.audits.some((t) => /^SKINNING-MISMATCH /.test(t))), rs.log);
SK.replayCheck = 'refuse';
cr = issue();
{ const forged = [1000, 2000, 3000]; rs = reportS(cr, forged, cr.totalMs - 10, 120, JSON.stringify({ v: 2, win: true, hits: 3, slips: 0 })); }
check("replayCheck 'refuse': it is refused", bladeCount(cr, [1000, 2000, 3000]).cuts >= cr.cuts || vOf(rs.log) === 'refused(mismatch)', rs.log);
SK.replayCheck = 'log';
cr = issue(); cp = playHuman(cr, { aim: 0.5 });
rs = reportS(cr, cp.times, cp.at, 120, claimS(Object.assign({}, cp, { win: false })));
check("the widget's own loss stands even when its cuts replay to a win", vOf(rs.log) === 'lose' && /mismatch/.test(sOf(rs.log)) && rs.given.length === 0, rs.log);
// Rollback: clientJudged false refuses on lag exactly as before, and the plain 400-unit rule is back
SK.clientJudged = false;
cr = issue(); cp = playHuman(cr, { aim: 0.5 });
rs = reportS(cr, cp.times, cp.at, 4000, claimS(cp));
check('rollback (clientJudged false): the same 4 s late report is refused(late) again', vOf(rs.log) === 'refused(late)' && rs.given.length === 0 && !/ judge=/.test(rs.log), rs.log);
cr = issue({ body: [900, 0, 0] }); cp = playHuman(cr, { aim: 0.5 });
rs = reportS(cr, cp.times, cp.at, 400, claimS(cp));
check('...and the stale body position loses again (too far)', vOf(rs.log) === 'lose' && /too-far/.test(rs.log), rs.log);
check('...and the widget is not told it judges', S.skinPacket(cr).judge === undefined);
SK.clientJudged = true;

console.log('');
console.log(failures ? `${failures} FAILURES` : 'all checks passed');
process.exit(failures ? 1 : 0);
