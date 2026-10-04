// Renders the labour (mining, chopping, struggle) and skinning widgets in headless Chrome on a fake clock, scripts a
// round of each, screenshots every state and checks that the drawn marker and band sit where the sweep function puts
// them at the sampled millisecond. It also records every sendMessage, so two builds can be compared for wire parity.
//
//   LD_LIBRARY_PATH=$(cat ~/claude-c-layout/ldpath) [BASELINE=<old sent.json>] node tests/minigame-shots.js [front dir] [out dir]
//
// Needs puppeteer (PUPPETEER_DIR, default ~/claude-c-layout/node_modules/puppeteer) and esbuild (ESBUILD, default the
// fork's skymp5-server copy). Writes <out>/<kind>-<state>-<w>x<h>.png (and the panel alone in <out>/panel), <out>/sent.json and <out>/layout.json.
// The pick rounds (mode 'pick', no timing) go to <out>/pick: their spots are checked against the server's x and y, the right
// cue against the decoys, and every report against the picks played. Their blows come from tests/pick-steps.json, rolled
// by the server's minigames.js pickSteps.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const FRONT = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const OUTDIR = path.resolve(process.argv[3] || path.join(os.tmpdir(), 'minigame-shots'));
const HOME = process.env.HOME;
const NM = path.join(HOME, 'dragonbreak/fork/skymp5-front/node_modules');
const puppeteer = require(process.env.PUPPETEER_DIR || path.join(HOME, 'claude-c-layout/node_modules/puppeteer'));
const ESBUILD = process.env.ESBUILD || path.join(HOME, 'dragonbreak/fork/skymp5-server/node_modules/.bin/esbuild');
const sass = require(path.join(NM, 'sass'));
fs.mkdirSync(path.join(OUTDIR, 'panel'), { recursive: true });
const TMP = fs.mkdtempSync(path.join(fs.existsSync('/dev/shm') ? '/dev/shm' : os.tmpdir(), 'claude-nate-mgshots-'));

// The fonts are inlined, so the shots use the game's own faces
const inlineFonts = (css, dir) => css.replace(/url\(["']?([^"')]+\.(?:ttf|otf))["']?\)/g, (m, rel) => {
  const f = path.resolve(dir, rel);
  return fs.existsSync(f) ? `url(data:font/ttf;base64,${fs.readFileSync(f).toString('base64')})` : m;
});
const css = ['main.scss', 'constructor.scss', 'features/labour/styles.scss', 'features/skinning/styles.scss']
  .map((f) => inlineFonts(sass.compile(path.join(FRONT, 'src', f), { loadPaths: [path.join(FRONT, 'src'), NM], quietDeps: true, silenceDeprecations: ['import', 'global-builtin', 'slash-div', 'color-functions'] }).css, path.join(FRONT, 'src'))).join('\n');

fs.writeFileSync(path.join(TMP, 'entry.jsx'), `
import React from 'react';
import ReactDOM from 'react-dom';
import '${path.join(FRONT, 'src/utils/UiScale.js')}';
import Labour from '${path.join(FRONT, 'src/features/labour/index.tsx')}';
import Skinning from '${path.join(FRONT, 'src/features/skinning/index.tsx')}';
window.__sent = [];
window.skyrimPlatform = { sendMessage(...a) { window.__sent.push(a); } };
const root = () => document.getElementById('root');
window.show = (type, data) => {
  const C = type === 'skinning' ? Skinning : Labour;
  ReactDOM.render(<div className="dbo-domain" data-domain="bronze"><C data={data} /></div>, root());
};
window.hide = () => ReactDOM.unmountComponentAtNode(root());
`);
execFileSync(ESBUILD, [path.join(TMP, 'entry.jsx'), '--bundle', '--format=iife', '--jsx=transform',
  '--loader:.scss=empty', '--loader:.png=empty', '--loader:.svg=empty', '--loader:.ttf=empty',
  '--define:process.env.NODE_ENV="production"', '--log-level=error', `--outfile=${path.join(TMP, 'bundle.js')}`], { stdio: 'inherit', env: { ...process.env, NODE_PATH: NM } });
// The page's clock is window.__t: the widgets read performance.now(), their timers still tick in real time
const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}
body { background: linear-gradient(180deg, #7d8fa3 0%, #a9b4bd 38%, #5d6650 40%, #3b4434 100%); }
</style><script>window.__t = 0; performance.now = () => window.__t;</script></head>
<body><div id="root"></div><script>${fs.readFileSync(path.join(TMP, 'bundle.js'), 'utf8')}</script></body></html>`;
fs.writeFileSync(path.join(TMP, 'page.html'), html);

// ---- the server's arithmetic (server/labour.js markerAt, server/struggle.js markerOn, gamemode.js bladeAt) ----------
const markerAt = (ms, sweepMs) => { const p = (ms % (sweepMs * 2)) / sweepMs; return p <= 1 ? p * 100 : (2 - p) * 100; };
const markerOn = (ms, sweeps, hitAt) => {
  let phase = 0, from = 0, i = 0;
  for (; i < hitAt.length && hitAt[i] <= ms; i++) { phase += (hitAt[i] - from) / sweeps[Math.min(i, sweeps.length - 1)]; from = hitAt[i]; }
  phase = (phase + (ms - from) / sweeps[Math.min(i, sweeps.length - 1)]) % 2;
  return phase <= 1 ? phase * 100 : (2 - phase) * 100;
};
const bladeAt = (ms, sweepMs) => { const p = (ms % (sweepMs * 2)) / sweepMs; return p <= 1 ? p : 2 - p; };

// The first ms at or after `from` where pos(t) is within `tol` of the centre (or, with far, more than `tol` off it)
const findT = (from, pos, centre, tol, far) => {
  for (let t = from; t < from + 20000; t++) { const d = Math.abs(pos(t) - centre); if (far ? d > tol : d <= tol) return t; }
  throw new Error('no time found');
};

const MINING = { id: 31, nonce: 'shot-m', kind: 'mining', title: 'Iron Seam', strikes: 6, band: 8, bands: [62.4, 21.7, 80.2, 44.9, 12.3, 55.1], sweepMs: 1400, totalMs: 30000, hitMs: 250, missMs: 600, judge: 'client' };
const CHOPPING = { id: 31, nonce: 'shot-c', kind: 'chopping', title: 'Chopping Block', strikes: 4, band: 9, bands: [38.5, 71.2, 25.4, 60.8], sweepMs: 1300, totalMs: 30000, hitMs: 250, missMs: 600, judge: 'client' };
const STRUGGLE = { id: 31, nonce: 'shot-s', kind: 'struggle', event: 'struggle', title: 'Bound Hands',
  hint: 'Pull while the marker is in the gap; one slip and the bonds hold. Space or click.',
  strikes: 5, band: 9, bands: [48.2, 70.5, 30.1, 62.7, 20.4], sweepMs: 1500, sweeps: [1500, 1350, 1215, 1094, 984], failOnMiss: true,
  totalMs: 20000, hitMs: 300, missMs: 300, strikeLabel: 'Pull', leaveLabel: 'Give up', doneLabel: 'Close', judge: 'client' };
const SKINNING = { id: 33, nonce: 'shot-k', name: 'deer', cuts: 3, misses: 2, seam: 0.155, seams: [0.4123, 0.7311, 0.2266], sweepMs: 1000, totalMs: 15000, judge: 'client' };
const RESULTS = {
  mining: ['The seam gives way: 3 Iron Ore.', 'The seam holds. Your arms give out before the rock does.'],
  chopping: ['Split clean: 4 Firewood.', 'The log rolls off the block, still whole.'],
  struggle: ['You slip the knot and your hands come free.', 'The bonds hold. You can struggle again in 2 minutes.'],
  skinning: ['The hide comes away clean: Deer Hide.', 'The knife slips and the hide tears. Try again.'],
};

(async () => {
  const b = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox', '--allow-file-access-from-files'] });
  const pg = await b.newPage();
  const layout = [];
  const sentAll = {};
  let failures = 0;
  const note = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const at = async (t) => { await pg.evaluate((v) => { window.__t = v; }, t); await wait(70); };
  const key = async (k) => { await pg.evaluate((kk) => window.dispatchEvent(new KeyboardEvent('keydown', { key: kk, code: kk === ' ' ? 'Space' : kk, bubbles: true })), k); await wait(25); };

  for (const [w, h] of [[1280, 720], [1920, 1080]]) {
    await pg.setViewport({ width: w, height: h });
    await pg.goto('file://' + path.join(TMP, 'page.html'), { waitUntil: 'load' });
    await pg.evaluate(() => document.fonts.ready);
    const res = `${w}x${h}`;

    // What is drawn now: the track's inner box, the marker's centre and the band's edges, in px
    const measure = async (type) => pg.evaluate((tp) => {
      const q = (s) => document.querySelector(s);
      const sel = tp === 'skinning'
        ? { panel: '.skinning__panel', track: '.skinning__hide', marker: '.skinning__blade', band: '.skinning__seam' }
        : { panel: '.labour__bench', track: '.labour__bar', marker: '.labour__marker', band: '.labour__band' };
      const r = (el) => { if (!el) return null; const x = el.getBoundingClientRect(); return { x: x.left, y: x.top, w: x.width, h: x.height }; };
      const track = q(sel.track);
      const inner = track ? { x: track.getBoundingClientRect().left + track.clientLeft, w: track.clientWidth } : null;
      const m = r(q(sel.marker)), band = r(q(sel.band));
      return { panel: r(q(sel.panel)), track: r(track), inner, markerX: m ? m.x + m.w / 2 : null, band, text: (q(sel.panel) || {}).innerText || '' };
    }, type);
    // The whole screen, and the panel alone for a closer look
    const shot = async (kind, state) => {
      await pg.screenshot({ path: path.join(OUTDIR, `${kind}-${state}-${res}.png`) });
      const box = await pg.evaluate(() => { const el = document.querySelector('.labour__bench, .skinning__panel'); const r = el && el.getBoundingClientRect(); return r && { x: r.left, y: r.top, width: r.width, height: r.height }; });
      if (box) await pg.screenshot({ path: path.join(OUTDIR, 'panel', `${kind}-${state}-${res}.png`), clip: box });
    };
    // The drawn marker against the sweep function, and the band against the server's centre and half width
    const checkAt = async (kind, type, t, expectPct, centrePct, halfPct) => {
      const m = await measure(type);
      if (!m.inner) { note(false, `${res} ${kind} t=${t}: no track drawn`); return m; }
      const want = m.inner.x + (expectPct / 100) * m.inner.w;
      note(Math.abs(m.markerX - want) <= 1, `${res} ${kind} t=${t}: marker at ${(m.markerX - m.inner.x).toFixed(1)} px, sweep says ${(want - m.inner.x).toFixed(1)} px (${expectPct.toFixed(2)}%)`);
      if (centrePct !== undefined && m.band) {
        const l = m.inner.x + ((centrePct - halfPct) / 100) * m.inner.w, wd = (2 * halfPct / 100) * m.inner.w;
        note(Math.abs(m.band.x - l) <= 1 && Math.abs(m.band.w - wd) <= 1.5, `${res} ${kind} t=${t}: band ${(m.band.x - m.inner.x).toFixed(1)}+${m.band.w.toFixed(1)} px, server says ${(l - m.inner.x).toFixed(1)}+${wd.toFixed(1)} px`);
      }
      return m;
    };
    const record = (kind, state, m) => layout.push({ res, kind, state, panel: m.panel, track: m.track, text: m.text.replace(/\s+/g, ' ').trim() });

    // ---- labour kinds: start, mid-round, landed, miss, win (own verdict and the server's text), lose ----
    for (const [kind, round] of [['mining', MINING], ['chopping', CHOPPING], ['struggle', STRUGGLE]]) {
      const hitAt = [];
      const pos = (t) => (round.sweeps ? markerOn(t, round.sweeps, hitAt) : markerAt(t, round.sweepMs));
      const half = round.band;
      const run = async (nonce) => {
        await pg.evaluate(() => { window.hide(); window.__sent = []; window.__t = 0; });
        await pg.evaluate((d) => window.show('labour', d), Object.assign({}, round, { nonce }));
        await wait(60);
        hitAt.length = 0;
      };
      await run(round.nonce + '-a-' + res);
      let t = 250;
      await at(t);
      record(kind, 'start', await checkAt(kind, 'labour', t, pos(t), round.bands[0], half));
      await shot(kind, 'start');
      // Land the first two strikes
      let ready = 0;
      for (let i = 0; i < 2; i++) {
        t = findT(Math.max(t + 1, ready), pos, round.bands[i], half * 0.3);
        await at(t);
        await checkAt(kind, 'labour', t, pos(t), round.bands[i], half);
        await key(' ');
        hitAt.push(t);
        ready = t + round.hitMs;
        if (i === 1) { record(kind, 'landed', await measure('labour')); await shot(kind, 'landed'); }
      }
      // Mid-round: the marker well away from the band
      t = findT(ready + 300, pos, round.bands[2], half + 15, true);
      await at(t);
      record(kind, 'mid', await checkAt(kind, 'labour', t, pos(t), round.bands[2], half));
      await shot(kind, 'mid');
      if (kind !== 'struggle') {
        // A miss, then the rest landed: the win
        await key(' ');
        record(kind, 'miss', await measure('labour'));
        await shot(kind, 'miss');
        ready = t + round.missMs;
        for (let i = 2; i < round.strikes; i++) {
          t = findT(Math.max(t + 1, ready), pos, round.bands[i], half * 0.3);
          await at(t);
          await checkAt(kind, 'labour', t, pos(t), round.bands[i], half);
          await key(' ');
          hitAt.push(t);
          ready = t + round.hitMs;
        }
        await wait(200);
        record(kind, 'win', await measure('labour'));
        await shot(kind, 'win');
        await pg.evaluate((d) => window.show('labour', d), Object.assign({}, round, { nonce: round.nonce + '-a-' + res, result: RESULTS[kind][0], resultKind: 'win' }));
        await wait(60);
        record(kind, 'win-server', await measure('labour'));
        await shot(kind, 'win-server');
      } else {
        // Struggle: three more landed is a clean round (the server still rolls the knots)
        for (let i = 2; i < round.strikes; i++) {
          t = findT(Math.max(t + 1, ready), pos, round.bands[i], half * 0.3);
          await at(t);
          await checkAt(kind, 'labour', t, pos(t), round.bands[i], half);
          await key(' ');
          hitAt.push(t);
          ready = t + round.hitMs;
        }
        await wait(200);
        record(kind, 'win', await measure('labour'));
        await shot(kind, 'win');
        await pg.evaluate((d) => window.show('labour', d), Object.assign({}, round, { nonce: round.nonce + '-a-' + res, result: RESULTS[kind][0], resultKind: 'win' }));
        await wait(60);
        record(kind, 'win-server', await measure('labour'));
        await shot(kind, 'win-server');
      }
      sentAll[`${res} ${kind} win`] = await pg.evaluate(() => window.__sent);

      // A second round: one landed, then a miss (struggle: the miss ends it) or the clock runs out
      await run(round.nonce + '-b-' + res);
      t = findT(300, pos, round.bands[0], half * 0.3);
      await at(t);
      await key(' ');
      hitAt.push(t);
      t = findT(t + round.hitMs + 200, pos, round.bands[1], half + 12, true);
      await at(t);
      await checkAt(kind, 'labour', t, pos(t), round.bands[1], half);
      await key(' ');
      if (kind === 'struggle') {
        record(kind, 'miss', await measure('labour'));
        await shot(kind, 'miss');
        await wait(200);
      } else {
        await at(round.totalMs + 5);
        await wait(150);
      }
      record(kind, 'lose', await measure('labour'));
      await shot(kind, 'lose');
      await pg.evaluate((d) => window.show('labour', d), Object.assign({}, round, { nonce: round.nonce + '-b-' + res, result: RESULTS[kind][1], resultKind: 'lose' }));
      await wait(60);
      record(kind, 'lose-server', await measure('labour'));
      await shot(kind, 'lose-server');
      sentAll[`${res} ${kind} lose`] = await pg.evaluate(() => window.__sent);
    }

    // ---- the vein in other ores: the band must read as well on a pale or a black vein ----
    for (const title of ['Sea Salt Deposit', 'Ebony Seam', 'Moonstone Seam', 'Malachite Seam', 'Geode']) {
      await pg.evaluate(() => { window.hide(); window.__sent = []; window.__t = 0; });
      await pg.evaluate((d) => window.show('labour', d), Object.assign({}, MINING, { nonce: 'ore-' + title + res, title }));
      await wait(60);
      const t = findT(250, (x) => markerAt(x, MINING.sweepMs), MINING.bands[0], MINING.band * 0.5);
      await at(t);
      await checkAt('mining/' + title, 'labour', t, markerAt(t, MINING.sweepMs), MINING.bands[0], MINING.band);
      await shot('ore-' + title.toLowerCase().replace(/\s+/g, '-'), 'start');
    }

    // ---- skinning: start, landed cut, slip, mid, win, server win; a second attempt torn by slips ----
    {
      const round = SKINNING;
      const kind = 'skinning';
      const pos = (t) => bladeAt(t, round.sweepMs) * 100;
      const half = round.seam * 50;
      const run = async (nonce) => {
        await pg.evaluate(() => { window.hide(); window.__sent = []; window.__t = 0; });
        await pg.evaluate((d) => window.show('skinning', d), Object.assign({}, round, { nonce }));
        await wait(60);
      };
      await run(round.nonce + '-a-' + res);
      let t = 250;
      await at(t);
      record(kind, 'start', await checkAt(kind, 'skinning', t, pos(t), round.seams[0] * 100, half));
      await shot(kind, 'start');
      t = findT(t + 1, pos, round.seams[0] * 100, half * 0.3);
      await at(t);
      await checkAt(kind, 'skinning', t, pos(t), round.seams[0] * 100, half);
      await key(' ');
      record(kind, 'landed', await measure('skinning'));
      await shot(kind, 'landed');
      t = findT(t + 200, pos, round.seams[1] * 100, half + 15, true);
      await at(t);
      await checkAt(kind, 'skinning', t, pos(t), round.seams[1] * 100, half);
      await key(' ');
      record(kind, 'miss', await measure('skinning'));
      await shot(kind, 'miss');
      t = findT(t + 300, pos, round.seams[1] * 100, half + 20, true);
      await at(t);
      record(kind, 'mid', await checkAt(kind, 'skinning', t, pos(t), round.seams[1] * 100, half));
      await shot(kind, 'mid');
      for (let i = 1; i < round.cuts; i++) {
        t = findT(t + 1, pos, round.seams[i] * 100, half * 0.3);
        await at(t);
        await checkAt(kind, 'skinning', t, pos(t), round.seams[i] * 100, half);
        await key(' ');
      }
      await wait(200);
      record(kind, 'win', await measure('skinning'));
      await shot(kind, 'win');
      await pg.evaluate((d) => window.show('skinning', d), Object.assign({}, round, { nonce: round.nonce + '-a-' + res, result: RESULTS[kind][0], resultKind: 'win' }));
      await wait(60);
      record(kind, 'win-server', await measure('skinning'));
      await shot(kind, 'win-server');
      sentAll[`${res} ${kind} win`] = await pg.evaluate(() => window.__sent);

      await run(round.nonce + '-b-' + res);
      t = findT(300, pos, round.seams[0] * 100, half * 0.3);
      await at(t);
      await key(' ');
      for (let i = 0; i <= round.misses; i++) {
        t = findT(t + 150, pos, round.seams[1] * 100, half + 12, true);
        await at(t);
        await key(' ');
      }
      await wait(200);
      record(kind, 'lose', await measure('skinning'));
      await shot(kind, 'lose');
      await pg.evaluate((d) => window.show('skinning', d), Object.assign({}, round, { nonce: round.nonce + '-b-' + res, result: RESULTS[kind][1], resultKind: 'lose' }));
      await wait(60);
      record(kind, 'lose-server', await measure('skinning'));
      await shot(kind, 'lose-server');
      sentAll[`${res} ${kind} lose`] = await pg.evaluate(() => window.__sent);

      // Run out of time with one clean cut
      await run(round.nonce + '-c-' + res);
      t = findT(300, pos, round.seams[0] * 100, half * 0.3);
      await at(t);
      await key(' ');
      await at(round.totalMs + 5);
      await wait(150);
      record(kind, 'timeout', await measure('skinning'));
      await shot(kind, 'timeout');
      sentAll[`${res} ${kind} timeout`] = await pg.evaluate(() => window.__sent);
    }

    // ---- pick rounds ("Read the stone", no timing): spots where the server put them, the right cue the clearest ----
    {
      const PICKDIR = path.join(OUTDIR, 'pick');
      fs.mkdirSync(path.join(PICKDIR, 'panel'), { recursive: true });
      const pshot = async (name) => {
        await pg.screenshot({ path: path.join(PICKDIR, `${name}-${res}.png`) });
        const box = await pg.evaluate(() => { const el = document.querySelector('.labour__bench, .skinning__panel'); const r = el && el.getBoundingClientRect(); return r && { x: r.left, y: r.top, width: r.width, height: r.height }; });
        if (box) await pg.screenshot({ path: path.join(PICKDIR, 'panel', `${name}-${res}.png`), clip: box });
      };
      const rightOf = (spots) => spots.reduce((bst, q, i) => (q[2] > spots[bst][2] ? i : bst), 0);
      const checkSpots = async (label, type, spots) => {
        const m = await pg.evaluate((tp) => {
          const track = document.querySelector(tp === 'skinning' ? '.skinning__hide' : '.labour__bar');
          const r = track.getBoundingClientRect();
          const inner = { x: r.left + track.clientLeft, y: r.top + track.clientTop, w: track.clientWidth, h: track.clientHeight };
          const list = [...document.querySelectorAll(tp === 'skinning' ? '.skinning__spot' : '.labour__spot')].map((el) => {
            const q = el.getBoundingClientRect();
            return { cx: q.left + q.width / 2, cy: q.top + q.height / 2, op: Number(getComputedStyle(el.querySelector('svg')).opacity) };
          });
          const panel = document.querySelector(tp === 'skinning' ? '.skinning__panel' : '.labour__bench').getBoundingClientRect();
          return { inner, list, panel: { x: panel.left, y: panel.top, w: panel.width, h: panel.height } };
        }, type);
        layout.push({ res, kind: label, state: 'pick', panel: m.panel, track: { w: m.inner.w, h: m.inner.h }, text: '' });
        const placed = m.list.length === spots.length && spots.every((q, i) => Math.abs(m.list[i].cx - (m.inner.x + q[0] / 100 * m.inner.w)) <= 1 && Math.abs(m.list[i].cy - (m.inner.y + q[1] / 100 * m.inner.h)) <= 1);
        note(placed, `${res} ${label}: ${m.list.length} spots drawn at the server's x, y`);
        const r = rightOf(spots);
        note(m.list.every((q, i) => i === r || q.op < m.list[r].op), `${res} ${label}: the right spot's cue is the clearest drawn (${m.list.map((q) => q.op.toFixed(2)).join(' ')})`);
      };
      const STEPS = JSON.parse(fs.readFileSync(path.join(__dirname, 'pick-steps.json'), 'utf8'));
      const pickKey = async (i) => key(String(i + 1));
      const open = async (type, d) => {
        await pg.evaluate(() => { window.hide(); window.__sent = []; window.__t = 0; });
        await pg.evaluate((tp, dd) => window.show(tp, dd), type, d);
        await wait(450);
      };
      // A frame of the blow's animation, held still: the widget's timers are stopped and every animation the pick began is
      // set to ms into itself, so a slow screenshot cannot miss the swing. Afterwards they finish and the timers come back.
      const holdTimers = () => pg.evaluate(() => { window.__realSetTimeout = window.setTimeout; window.setTimeout = () => 0; });
      const freeze = (ms) => pg.evaluate((m) => {
        const now = document.timeline.currentTime;
        window.__frozen = document.getAnimations().filter((x) => x.startTime === null || now - x.startTime < 1000 * 60 && x.playState !== 'finished');
        for (const x of window.__frozen) { x.pause(); x.currentTime = m; }
      }, ms);
      const release = () => pg.evaluate(() => { for (const x of window.__frozen || []) x.finish(); window.__frozen = []; if (window.__realSetTimeout) window.setTimeout = window.__realSetTimeout; });
      // Plays a list of picks 500 ms apart on the round's clock, shooting held frames after the named ones
      const playPicks = async (type, d, list, shots) => {
        const sentList = [];
        let t = 0;
        for (let k = 0; k < list.length; k++) {
          t += 500;
          await at(t);
          const sh = shots[k];
          if (sh) await holdTimers();
          await pickKey(list[k]);
          sentList.push([list[k], t]);
          if (sh) {
            await wait(30);
            for (const [ms, name] of sh) { await freeze(ms); await pshot(name); }
            await release();
          } else await wait(260);
          const sets = await pg.evaluate(() => document.querySelectorAll('.labour__spots, .skinning__spots').length);
          if (sets > 1) note(false, `${res} ${type} pick ${k + 1}: ${sets} sets of spots on the face at once`);
        }
        return { sentList, t };
      };
      const expectSent = async (label, ev, list, at0, win, hits, slips) => {
        const got = await pg.evaluate(() => window.__sent);
        const r = got.find((g) => g[0] === ev);
        const v = r ? JSON.parse(r[4]) : {};
        note(!!r && r[2] === JSON.stringify(list) && r[3] === at0 && v.mode === 'pick' && v.win === win && v.hits === hits && v.slips === slips, `${res} ${label}: reports ${r ? r[2] : 'nothing'} at ${r ? r[3] : '-'} with ${r ? r[4] : '-'}`);
        sentAll[`${res} pick ${label}`] = got;
      };
      const wrongOf = (spots) => (rightOf(spots) + 1) % spots.length;

      // Mining at Novice: four spots, two wasted blows allowed
      const M = { id: 31, nonce: 'pk-m-' + res, kind: 'mining', title: 'Iron Seam', mode: 'pick', strikes: 6, slips: 2, steps: STEPS.mining0, totalMs: 90000, minPickMs: 150, judge: 'client' };
      await open('labour', M);
      await checkSpots('mining start', 'labour', M.steps[0]);
      await pshot('mining-start');
      let seq = [rightOf(M.steps[0]), wrongOf(M.steps[1]), ...M.steps.slice(2, 7).map(rightOf)];
      let run = await playPicks('labour', M, seq, { 0: [[200, 'mining-strike'], [700, 'mining-landed']], 1: [[200, 'mining-glance'], [700, 'mining-miss']], 2: [[700, 'mining-mid']] });
      await wait(300);
      await pshot('mining-win');
      await expectSent('mining win', 'dbo:labour', run.sentList, run.t, true, 6, 1);
      await pg.evaluate((d) => window.show('labour', d), Object.assign({}, M, { result: 'The seam gives way: 3 Iron Ore.', resultKind: 'win' }));
      await wait(80);
      await pshot('mining-win-server');
      const M2 = Object.assign({}, M, { nonce: 'pk-m2-' + res });
      await open('labour', M2);
      seq = M2.steps.slice(0, 3).map(wrongOf);
      run = await playPicks('labour', M2, seq, { 2: [[700, 'mining-lose']] });
      await expectSent('mining lose', 'dbo:labour', run.sentList, run.t, false, 0, 3);
      await pg.evaluate((d) => window.show('labour', d), Object.assign({}, M2, { result: 'The seam holds. Your arms give out before the rock does.', resultKind: 'lose' }));
      await wait(80);
      await pshot('mining-lose-server');
      const M3 = Object.assign({}, M, { nonce: 'pk-m3-' + res });
      await open('labour', M3);
      run = await playPicks('labour', M3, [rightOf(M3.steps[0])], {});
      await at(90005);
      await wait(150);
      await pshot('mining-idle');
      await expectSent('mining idle', 'dbo:labour', run.sentList, 90005, false, 1, 0);
      const MM = Object.assign({}, M, { nonce: 'pk-mm-' + res, title: 'Ebony Seam', slips: 4, steps: STEPS.mining4 });
      await open('labour', MM);
      await checkSpots('mining master start', 'labour', MM.steps[0]);
      await pshot('mining-master-start');

      // Chopping at Apprentice
      const C = { id: 31, nonce: 'pk-c-' + res, kind: 'chopping', title: 'Chopping Block', mode: 'pick', strikes: 8, slips: 3, steps: STEPS.chop1, totalMs: 90000, minPickMs: 150, judge: 'client' };
      await open('labour', C);
      await checkSpots('chopping start', 'labour', C.steps[0]);
      await pshot('chopping-start');
      run = await playPicks('labour', C, C.steps.slice(0, 8).map(rightOf), { 0: [[200, 'chopping-strike'], [700, 'chopping-landed']], 3: [[700, 'chopping-mid']] });
      await wait(300);
      await pshot('chopping-win');
      await expectSent('chopping win', 'dbo:labour', run.sentList, run.t, true, 8, 0);

      // Skinning at Novice: four points, two slips borne
      const K = { id: 33, nonce: 'pk-k-' + res, name: 'deer', mode: 'pick', cuts: 3, misses: 2, steps: STEPS.skin0, totalMs: 90000, minPickMs: 150, judge: 'client' };
      await open('skinning', K);
      await checkSpots('skinning start', 'skinning', K.steps[0]);
      await pshot('skinning-start');
      seq = [rightOf(K.steps[0]), wrongOf(K.steps[1]), rightOf(K.steps[2]), rightOf(K.steps[3])];
      run = await playPicks('skinning', K, seq, { 0: [[200, 'skinning-stroke'], [700, 'skinning-landed']], 1: [[200, 'skinning-snag'], [700, 'skinning-slip']] });
      await wait(450);
      await pshot('skinning-win');
      await expectSent('skinning win', 'dbo:skinning', run.sentList, run.t, true, 3, 1);
      await pg.evaluate((d) => window.show('skinning', d), Object.assign({}, K, { result: 'The hide comes away clean: Deer Hide.', resultKind: 'win' }));
      await wait(80);
      await pshot('skinning-win-server');
      const K2 = Object.assign({}, K, { nonce: 'pk-k2-' + res });
      await open('skinning', K2);
      run = await playPicks('skinning', K2, K2.steps.slice(0, 3).map(wrongOf), { 2: [[700, 'skinning-lose']] });
      await expectSent('skinning lose', 'dbo:skinning', run.sentList, run.t, false, 0, 3);
      const KM = Object.assign({}, K, { nonce: 'pk-km-' + res, steps: STEPS.skin4 });
      await open('skinning', KM);
      await checkSpots('skinning master start', 'skinning', KM.steps[0]);
      await pshot('skinning-master-start');
    }
  }
  await b.close();
  fs.writeFileSync(path.join(OUTDIR, 'sent.json'), JSON.stringify(sentAll, null, 1));
  // BASELINE=<an older run's sent.json>: every report must match it but the frame count, which follows real time
  if (process.env.BASELINE) {
    const base = JSON.parse(fs.readFileSync(process.env.BASELINE, 'utf8'));
    const strip = (list) => JSON.stringify((list || []).map((a) => a.map((v, i) => (i === 4 && typeof v === 'string' ? v.replace(/"frames":\d+,/, '') : v))));
    for (const k of Object.keys(base)) note(strip(base[k]) === strip(sentAll[k]), `wire: ${k} sends what the baseline sent`);
    note(Object.keys(base).length === Object.keys(sentAll).filter((k) => !/ pick /.test(k)).length, 'wire: the same timing reports as the baseline');
  }
  fs.writeFileSync(path.join(OUTDIR, 'layout.json'), JSON.stringify(layout, null, 1));
  console.log('\nres        kind      state        panel x,y  w x h          track w x h');
  for (const l of layout) {
    const p = l.panel || { x: 0, y: 0, w: 0, h: 0 }, tr = l.track || { w: 0, h: 0 };
    console.log(`${l.res.padEnd(10)} ${l.kind.padEnd(9)} ${l.state.padEnd(12)} ${Math.round(p.x)},${Math.round(p.y)}  ${Math.round(p.w)} x ${Math.round(p.h)}`.padEnd(64) + `${Math.round(tr.w)} x ${Math.round(tr.h)}   ${l.text.slice(0, 90)}`);
  }
  if (process.env.KEEP_PAGE) console.log(`page kept: ${path.join(TMP, "page.html")}`); else fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${failures ? failures + ' FAILED' : 'all marker and band checks passed'}; shots in ${OUTDIR}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); fs.rmSync(TMP, { recursive: true, force: true }); process.exit(1); });
