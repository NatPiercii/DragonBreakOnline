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

let virtual = 1000;
const sandbox = {
  SKIN_WIDGET_ID: 33,
  SKIN: { cuts: 3, misses: 2, seconds: 15, lagGraceMs: 2500, clockSlackMs: 50 },
  performance: { now: () => virtual },
  Math, JSON, Number, Array, String, Object, Date,
  out: {},
};
const names = ['skinRng', 'bladeAt', 'skinRound', 'skinPacket', 'judgeSkin'];
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
    const press = o.sloppy ? Math.random() < o.sloppy : Math.abs(pos - w.seams[cuts]) <= (w.width / 2) * o.aim;
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

const judge = (w, times, at, lagMs) => judgeSkin(w, typeof times === 'string' ? times : JSON.stringify(times), at, at + (lagMs === undefined ? 150 : lagMs));
const verdict = (v, w) => (v.bad ? 'refused(' + v.bad + ')' : v.cuts >= w.cuts ? 'win' : 'lose');

let failures = 0;
const check = (name, cond, detail) => {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);
};

// 1. the round the server issues
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
const t0 = skinRound(0x14, 0, 1, 'x');
const t4 = skinRound(0x14, 4, 1, 'x');
check('a better Skinner gets a wider seam and a slower blade', t4.width > t0.width && t4.sweepMs > t0.sweepMs,
  `tier1 width ${t0.width} sweep ${t0.sweepMs}ms -> tier5 width ${t4.width} sweep ${t4.sweepMs}ms`);

// 3. honest attempts: the server's count must equal the widget's, every time
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
const w1 = skinRound(0x14, 4, 1, 'wolf');
check('a bare cut count is not a report any more', judge(w1, '3', 1500, 100).bad === 'malformed', '');
check('an empty list wins nothing', verdict(judge(w1, [], 1500, 100), w1) === 'lose', '');

// 5. forged times that ignore the seam
const w2 = skinRound(0x14, 4, 1, 'wolf');
const evenly = [0, 500, 1000, 1500, 2000];
const v5 = judge(w2, evenly, 2000, 100);
check('evenly spaced forgery is refused or slips out', verdict(v5, w2) !== 'win', `${JSON.stringify(v5)}`);

// 6. what a perfect forgery still costs in real time
const w3 = skinRound(0x14, 0, 1, 'wolf');
const best = fastestPossible(w3);
const v6 = judge(w3, best, best[best.length - 1], 100);
check('a perfectly computed attempt still has to be played out', verdict(v6, w3) === 'win',
  `${best[best.length - 1]} ms of real time for ${w3.cuts} cuts (the old rule asked for 1500 ms and no times at all)`);

// 7. impossible reports
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
const seen = new Set();
for (let i = 0; i < 20; i++) seen.add(JSON.stringify(skinRound(0x14, 2, 1, 'x').seams));
check('every attempt gets its own seam sequence', seen.size === 20, `${seen.size} distinct of 20`);

console.log('');
console.log(failures ? `${failures} FAILURES` : 'all checks passed');
process.exit(failures ? 1 : 0);
