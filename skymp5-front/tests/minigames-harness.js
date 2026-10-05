// Scripted test for the client-judged mini-game widgets (labour and struggle, skinning, reading, prayer, lockpick, rite).
// Each widget is transpiled on its own and run under a small hook emulator: useState, useRef and useEffect follow React's
// rules (an effect re-runs only when a dep differs by Object.is), and a fake clock drives performance.now, Date.now,
// setInterval, setTimeout and requestAnimationFrame (one frame every 16 ms). Run it from skymp5-front:
//
//   node tests/minigames-harness.js
'use strict';
const fs = require('fs');
const path = require('path');
const ts = require(path.join(__dirname, '..', 'node_modules', 'typescript'));

let failures = 0;
let passes = 0;
const check = (name, ok, got) => {
  if (ok) passes++; else failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`);
};

// ---- fake clock and window ----------------------------------------------------------------------------------------
let now = 1000;
let nextId = 1;
let timers = [];   // { id, at, every, fn }
let frames = [];   // { id, fn }
let listeners = {};
let sent = [];
const clock = {
  setTimeout: (fn, ms) => { const id = nextId++; timers.push({ id, at: now + Math.max(0, ms || 0), every: 0, fn }); return id; },
  setInterval: (fn, ms) => { const id = nextId++; const every = Math.max(1, ms || 1); timers.push({ id, at: now + every, every, fn }); return id; },
  clear: (id) => { timers = timers.filter((t) => t.id !== id); },
};
global.performance = { now: () => now };
const realDateNow = Date.now;
Date.now = () => 1700000000000 + now;
global.window = {
  addEventListener: (ev, fn) => { (listeners[ev] = listeners[ev] || new Set()).add(fn); },
  removeEventListener: (ev, fn) => { if (listeners[ev]) listeners[ev].delete(fn); },
  setTimeout: clock.setTimeout, clearTimeout: clock.clear, setInterval: clock.setInterval, clearInterval: clock.clear,
  requestAnimationFrame: (fn) => { const id = nextId++; frames.push({ id, fn }); return id; },
  cancelAnimationFrame: (id) => { frames = frames.filter((f) => f.id !== id); },
  focus: () => {},
  skyrimPlatform: { sendMessage: (...a) => sent.push(a) },
};
global.setInterval = clock.setInterval;
global.clearInterval = clock.clear;

// ---- hook emulator ------------------------------------------------------------------------------------------------
let host = null;
const R = {
  useState(init) {
    const h = host; const i = h.hi++;
    if (!(i in h.hooks)) h.hooks[i] = { v: typeof init === 'function' ? init() : init };
    const slot = h.hooks[i];
    return [slot.v, (nv) => { const v = typeof nv === 'function' ? nv(slot.v) : nv; if (!Object.is(v, slot.v)) { slot.v = v; h.dirty = true; } }];
  },
  useRef(init) { const h = host; const i = h.hi++; if (!(i in h.hooks)) h.hooks[i] = { current: init }; return h.hooks[i]; },
  useEffect(fn, deps) {
    const h = host; const i = h.hi++; const old = h.hooks[i];
    const changed = !old || !deps || !old.deps || deps.length !== old.deps.length || deps.some((d, k) => !Object.is(d, old.deps[k]));
    if (!old) h.hooks[i] = { deps: null, cleanup: null };
    if (changed) h.pending.push([i, fn, deps]);
  },
  createElement: (t, p, ...c) => ({ t, p: p || {}, c }),
  Fragment: 'Fragment',
};
R.default = R;

const compiled = new Map();
const load = (rel) => {
  const file = path.join(__dirname, '..', 'src', rel);
  if (compiled.has(file)) return compiled.get(file);
  const src = fs.readFileSync(file, 'utf8');
  const out = ts.transpileModule(src, { compilerOptions: { jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, esModuleInterop: true } }).outputText;
  const m = { exports: {} };
  const req = (n) => {
    if (n === 'react') return R;
    if (/\.s?css$/.test(n)) return {};
    if (n.startsWith('.')) return load(path.relative(path.join(__dirname, '..', 'src'), path.resolve(path.dirname(file), n)) + '.ts');
    return require(n);
  };
  new Function('require', 'module', 'exports', out)(req, m, m.exports);
  compiled.set(file, m.exports);
  return m.exports;
};

const mount = (Component, data) => {
  now += 1000;
  timers = []; frames = []; listeners = {}; sent = [];
  const h = { hooks: [], hi: 0, pending: [], dirty: false, tree: null, data };
  const render = () => {
    for (let pass = 0; pass < 20; pass++) {
      host = h; h.hi = 0; h.dirty = false; h.pending = [];
      h.tree = Component({ data: h.data });
      for (const [i, fn, deps] of h.pending) {
        const old = h.hooks[i];
        if (old && old.cleanup) old.cleanup();
        h.hooks[i] = { deps, cleanup: fn() || null };
      }
      if (!h.dirty) return;
    }
    throw new Error('render did not settle');
  };
  const flush = () => { if (h.dirty) render(); };
  const advance = (ms) => {
    for (let k = 0; k < ms; k++) {
      now++;
      const due = timers.filter((t) => t.at <= now).sort((a, b) => a.at - b.at);
      for (const t of due) {
        if (!timers.includes(t)) continue;
        if (t.every) t.at += t.every; else timers = timers.filter((x) => x !== t);
        t.fn(); flush();
      }
      if (now % 16 === 0 && frames.length) {
        const run = frames; frames = [];
        for (const f of run) { f.fn(); flush(); }
      }
    }
  };
  const fire = (ev, props) => { for (const fn of [...(listeners[ev] || [])]) fn(Object.assign({ preventDefault() {}, stopImmediatePropagation() {} }, props)); flush(); };
  const walk = (n, out) => { if (Array.isArray(n)) n.forEach((x) => walk(x, out)); else if (n && typeof n === 'object') { out.push(n); (n.c || []).forEach((x) => walk(x, out)); } return out; };
  const all = () => walk(h.tree, []);
  const byClass = (cls) => all().filter((n) => typeof n.p.className === 'string' && n.p.className.split(' ').includes(cls));
  const text = () => { const out = []; const t = (n) => { if (Array.isArray(n)) n.forEach(t); else if (typeof n === 'string' || typeof n === 'number') out.push(String(n)); else if (n && n.c) n.c.forEach(t); }; t(h.tree); return out.join(''); };
  const click = (node) => { (node.p.onClick || node.p.onMouseDown)(); flush(); };
  const api = {
    get tree() { return h.tree; },
    set: (d) => { h.data = d; render(); },
    advance, fire, byClass, text, click,
    key: (k, code) => fire('keydown', { key: k, code: code || (k === ' ' ? 'Space' : k) }),
    keyUp: (k) => fire('keyup', { key: k, code: k === ' ' ? 'Space' : k }),
    hasClass: (cls) => byClass(cls).length > 0,
  };
  render();
  return api;
};
const last = (key) => { for (let i = sent.length - 1; i >= 0; i--) if (sent[i][0] === key) return sent[i]; return null; };
const count = (key) => sent.filter((s) => s[0] === key).length;
const json = (v) => { try { return JSON.parse(v); } catch (e) { return null; } };
// One game per section: a widget that throws fails its own section and the rest still run
const section = (name, fn) => { try { fn(); } catch (e) { check(`${name}: threw ${e.message}`, false); } };

// ---- labour (mining) --------------------------------------------------------------------------------------------
section('labour', () => {
  const Labour = load('features/labour/index.tsx').default;
  const round = { id: 31, nonce: 'm1', kind: 'mining', title: 'Iron', strikes: 2, band: 8, bands: [50, 50], sweepMs: 1000, totalMs: 10000, hitMs: 250, missMs: 600, judge: 'client' };
  let w = mount(Labour, round);
  w.advance(500); w.key(' ');
  w.advance(1004); w.key(' ');
  const r = last('dbo:labour');
  check('labour: a won round reports nonce, strike times, its own clock and the verdict', r && r[1] === 'm1' && JSON.stringify(json(r[2])) === '[496,1504]' && typeof r[3] === 'number', r);
  check('labour: the verdict argument is {v:1,win:true,hits:2}', r && JSON.stringify(json(r[4])) === '{"v":1,"win":true,"hits":2}', r && r[4]);
  check('labour: judge client shows the win at once', w.text().includes('The seam gives up its ore.') && w.hasClass('labour__bar--win'), w.text());
  check('labour: and offers to stand up', w.text().includes('Stand up'));
  w.set(Object.assign({}, round, { result: 'You take 2 iron ore.', resultKind: 'win' }));
  check('labour: the server text replaces the widget verdict when it lands', w.text().includes('You take 2 iron ore.') && !w.text().includes('The seam gives up its ore.'));
  check('labour: one report only', count('dbo:labour') === 1, count('dbo:labour'));

  w = mount(Labour, Object.assign({}, round, { nonce: 'm1b' }));
  w.advance(500); w.key(' ');
  const crack = w.byClass('labour__mark--hit')[0];
  check('labour: a landed blow cracks the face where the marker stood', crack && Math.abs(parseFloat(crack.p.style.left) - 49.6) < 0.01, crack && crack.p.style);
  w.advance(300); w.key(' ');
  check('labour: a glancing blow only scrapes it, and says so', w.hasClass('labour__mark--miss') && w.text().includes('glances off'), w.text());
  w.advance(708); w.key(' ');
  check('labour: the band and the marker go when the seam splits', w.hasClass('labour__split') && !w.hasClass('labour__band') && !w.hasClass('labour__marker'));

  w = mount(Labour, Object.assign({}, round, { nonce: 'm2' }));
  w.advance(10100);
  const l = last('dbo:labour');
  check('labour: a round run out reports a loss', l && json(l[4]).win === false && json(l[4]).hits === 0, l);
  check('labour: and shows it', w.text().includes('The seam holds.') && w.hasClass('labour__bar--lose'));

  w = mount(Labour, Object.assign({}, round, { nonce: 'm3' }));
  w.advance(300); w.key('Escape'); w.advance(11000);
  check('labour: walk away, then the clock runs out: the cancel only, no report', count('dbo:labourCancel') === 1 && count('dbo:labour') === 0, sent);

  w = mount(Labour, Object.assign({}, round, { nonce: 'm4', judge: undefined }));
  w.advance(500); w.key(' '); w.advance(1004); w.key(' ');
  const s = last('dbo:labour');
  check('labour: a server-judged round still sends the verdict argument (an old server reads three)', s && json(s[4]).win === true);
  check('labour: but shows no verdict of its own', !w.text().includes('The seam gives up its ore.') && !w.hasClass('labour__bar--win'), w.text());

  const strug = { id: 31, nonce: 's1', kind: 'struggle', event: 'struggle', title: 'Bound', strikes: 2, band: 8, bands: [50, 50], sweepMs: 1000, totalMs: 10000, hitMs: 0, missMs: 0, failOnMiss: true, judge: 'client' };
  w = mount(Labour, strug);
  w.advance(100); w.key(' ');
  const st = last('dbo:struggle');
  check('struggle: the first miss ends it as a loss on its own event', st && json(st[4]).win === false && json(st[4]).hits === 0, st);
  check('struggle: and the loss shows at once', w.text().includes('Your grip slips.') && w.hasClass('labour__bar--lose'));
  w = mount(Labour, Object.assign({}, strug, { nonce: 's2' }));
  w.advance(500); w.key(' '); w.advance(1004); w.key(' ');
  check('struggle: a clean round is not shown as freedom: the server still rolls', w.text().includes('Now the knots decide.') && !w.hasClass('labour__bar--win'), w.text());
});

// ---- labour pick rounds ("Read the stone": no timing) ---------------------------------------------------------------
section('labour pick', () => {
  const Labour = load('features/labour/index.tsx').default;
  const steps = [[[20, 40, 0.3], [50, 55, 0.8], [80, 45, 0.2]], [[25, 60, 0.9], [55, 35, 0.4], [85, 50, 0.1]], [[15, 50, 0.2], [45, 50, 0.3], [75, 50, 0.85]]];
  const round = { id: 31, nonce: 'p1', kind: 'mining', title: 'Iron Seam', mode: 'pick', strikes: 2, slips: 1, steps, totalMs: 90000, minPickMs: 150, judge: 'client' };
  let w = mount(Labour, round);
  check('labour pick: no band and no marker, one spot per entry of the blow, keyed 1-3', !w.hasClass('labour__band') && !w.hasClass('labour__marker') && w.byClass('labour__spot').length === 3 && w.text().includes('press 1-3'), w.text());
  w.advance(100); w.key('2', 'Digit2');
  check('labour pick: a pick before the spots have shown is not taken', count('dbo:labour') === 0 && w.byClass('labour__mark--hit').length === 0);
  w.advance(200); w.key('2', 'Digit2');
  check('labour pick: the clearest cue lands the blow where it was struck', w.byClass('labour__mark--hit').length === 1 && w.hasClass('labour__swing--hit') && w.byClass('labour__mark--hit')[0].p.style.top === '55%');
  w.advance(100); w.key('1', 'Digit1');
  check('labour pick: no second pick inside the lock', w.byClass('labour__mark--hit').length === 1);
  w.advance(200); w.key('1', 'Digit1');
  const r = last('dbo:labour');
  check('labour pick: the win reports [[index, ms], ...], its clock and {v:2, mode:pick}', r && r[1] === 'p1' && r[2] === '[[1,300],[0,600]]' && r[3] === 600 && r[4] === '{"v":2,"mode":"pick","win":true,"hits":2,"slips":0}', r);
  check('labour pick: the seam gives up its ore at once', w.text().includes('The seam gives up its ore.') && w.hasClass('labour__split'));

  w = mount(Labour, Object.assign({}, round, { nonce: 'p2' }));
  w.advance(300); w.key('1', 'Digit1'); w.advance(300); w.key('2', 'Digit2');
  const l = last('dbo:labour');
  check('labour pick: a wasted blow past the allowance ends it as a loss', l && l[2] === '[[0,300],[1,600]]' && json(l[4]).win === false && json(l[4]).slips === 2 && w.text().includes('The seam holds.'), l);
  check('labour pick: the strength pips are spent', w.byClass('labour__pip--spent').length === 2);

  w = mount(Labour, Object.assign({}, round, { nonce: 'p3' }));
  w.advance(400); w.key('2', 'Digit2'); w.advance(90000);
  const a = last('dbo:labour');
  check('labour pick: an idle round ends at its limit as a loss, with its own words', a && json(a[4]).win === false && a[3] >= 90000 && w.text().includes('stand idle at the seam'), a);
  w = mount(Labour, Object.assign({}, round, { nonce: 'p4', kind: 'chopping', title: 'Chopping Block' }));
  w.advance(300); w.key(' ');
  check('labour pick: Space strikes nothing in a pick round', count('dbo:labour') === 0 && w.byClass('labour__mark--hit').length === 0);
  w.click(w.byClass('labour__spot')[1]);
  check('labour pick: a click on a spot picks it', w.byClass('labour__mark--hit').length === 1);
  w = mount(Labour, Object.assign({}, round, { nonce: 'p5', kind: 'struggle', event: 'struggle', title: 'Bound Hands', slips: 0, strikeLabel: 'Pull', leaveLabel: 'Give up', hint: 'Pull where the rope gives; one wrong pull and the bonds hold.' }));
  check('labour pick: the struggle draws the rope with its spots, the hint from the server', !w.hasClass('labour__band') && w.byClass('labour__spot').length === 3 && w.text().includes('where the rope gives') && w.text().includes('to pull. Escape to give up'), w.text());
  w.advance(300); w.key('2', 'Digit2'); w.advance(300); w.key('2', 'Digit2');
  const sg = last('dbo:struggle');
  check('labour pick: one wrong pull ends the struggle on its own event as a loss', sg && sg[2] === '[[1,300],[1,600]]' && json(sg[4]).win === false && json(sg[4]).slips === 1 && w.text().includes('Your grip slips.'), sg);
  w = mount(Labour, Object.assign({}, round, { nonce: 'p6', kind: 'struggle', event: 'struggle', slips: 0 }));
  w.advance(300); w.key('2', 'Digit2'); w.advance(300); w.key('1', 'Digit1');
  check('labour pick: a clean struggle still waits on the knots', json(last('dbo:struggle')[4]).win === true && w.text().includes('Now the knots decide.') && !w.hasClass('labour__bar--win'), w.text());
});

// ---- skinning pick attempts --------------------------------------------------------------------------------------
section('skinning pick', () => {
  const Skinning = load('features/skinning/index.tsx').default;
  const steps = [[[20, 40, 0.3], [50, 50, 0.8], [80, 62, 0.2]], [[25, 50, 0.9], [55, 35, 0.4], [85, 64, 0.1]], [[15, 66, 0.2], [45, 38, 0.3], [75, 50, 0.85]], [[30, 50, 0.7], [60, 30, 0.2], [90, 70, 0.1]]];
  const round = { id: 33, nonce: 'q1', name: 'deer', mode: 'pick', cuts: 2, misses: 1, steps, totalMs: 90000, minPickMs: 150, judge: 'client' };
  let w = mount(Skinning, round);
  check('skinning pick: no blade and no seam band, points keyed 1-3', !w.hasClass('skinning__blade') && !w.hasClass('skinning__seam') && w.byClass('skinning__spot').length === 3 && !w.hasClass('skinning__timer'));
  w.advance(300); w.key('2', 'Digit2'); w.advance(300); w.key('3', 'Digit3');
  check('skinning pick: a pick off the seam is a slip and says so', w.hasClass('skinning__mark--slip') && w.text().includes('The blade snags.'), w.text());
  w.advance(300); w.key('3', 'Digit3');
  const r = last('dbo:skinning');
  const v = r && json(r[4]);
  check('skinning pick: the clean attempt reports [[index, ms], ...] and {v:2, mode:pick, win, hits, slips}', r && r[2] === '[[1,300],[2,600],[2,900]]' && r[3] === 900 && v.mode === 'pick' && v.win === true && v.hits === 2 && v.slips === 1, r);
  check('skinning pick: the pelt comes away at once', w.text().includes('The hide comes away clean.') && w.hasClass('skinning__opened'));
  w = mount(Skinning, Object.assign({}, round, { nonce: 'q2' }));
  w.advance(300); w.key('1', 'Digit1'); w.advance(300); w.key('2', 'Digit2');
  check('skinning pick: slips past the allowance tear the hide', json(last('dbo:skinning')[4]).win === false && w.text().includes('The knife slips') && w.hasClass('skinning__mark--rip'));
  w = mount(Skinning, Object.assign({}, round, { nonce: 'q3' }));
  w.advance(90100);
  check('skinning pick: an idle attempt ends at its limit', json(last('dbo:skinning')[4]).win === false && w.text().includes('knife idle'), w.text());
});

// ---- skinning -----------------------------------------------------------------------------------------------------
section('skinning', () => {
  const Skinning = load('features/skinning/index.tsx').default;
  const round = { id: 33, nonce: 'k1', name: 'deer', cuts: 2, misses: 1, seam: 0.2, seams: [0.5, 0.5], sweepMs: 1000, totalMs: 10000, judge: 'client' };
  let w = mount(Skinning, round);
  w.advance(500); w.key(' ', 'Space');
  w.advance(1004); w.key(' ', 'Space');
  const r = last('dbo:skinning');
  const v = r && json(r[4]);
  check('skinning: a clean attempt reports cut times, its clock and {v:2,win:true}', r && r[1] === 'k1' && json(r[2]).length === 2 && v && v.v === 2 && v.win === true && v.hits === 2 && v.slips === 0, r);
  check('skinning: frame health rides along', v && v.frames > 50 && v.maxFrameMs >= 15 && v.maxFrameMs <= 17, v);
  check('skinning: judge client shows the clean hide at once', w.text().includes('The hide comes away clean.') && w.hasClass('skinning__panel--win'));
  check('skinning: the hide is put away and Close offered', !w.hasClass('skinning__hide') && w.text().includes('Close'));
  check('skinning: the clean cuts stay on the lifted pelt', w.byClass('skinning__mark--clean').length === 2 && w.hasClass('skinning__opened'));

  w = mount(Skinning, Object.assign({}, round, { nonce: 'k2' }));
  w.advance(100); w.key(' ', 'Space');
  check('skinning: a slip leaves a tear and the line counts the slips left', w.hasClass('skinning__mark--slip') && w.text().includes('One more slip will tear it.'), w.text());
  w.advance(100); w.key(' ', 'Space');
  const l = last('dbo:skinning');
  check('skinning: slips past the allowance report a loss', l && json(l[4]).win === false && json(l[4]).slips === 2, l);
  check('skinning: and show it', w.text().includes('The knife slips') && w.hasClass('skinning__panel--lose') && w.hasClass('skinning__mark--rip'));

  w = mount(Skinning, Object.assign({}, round, { nonce: 'k3' }));
  w.advance(200); w.key('Escape'); w.advance(11000);
  check('skinning: stop, then the clock runs out: the cancel only, no report', count('dbo:skinningCancel') === 1 && count('dbo:skinning') === 0, sent);
});

// ---- reading ------------------------------------------------------------------------------------------------------
section('reading', () => {
  const Reading = load('features/reading/index.tsx').default;
  const round = { id: 30, nonce: 'b1', title: 'A book', words: ['the', 'end'], seconds: 30, judge: 'client', candleMs: 30000, penaltyMs: 8000 };
  let w = mount(Reading, round);
  const pool = () => w.byClass('reading__word').filter((n) => !n.p.className.includes('placed'));
  w.click(pool()[0]); w.click(pool()[1]);
  w.advance(2000); w.key('Enter');
  const r1 = last('dbo:reading');
  const c1 = r1 && json(r1[3]);
  check('reading: a reading goes with its own candle: elapsed, paused, left, attempts', r1 && r1[2] === '[0,1]' && c1 && c1.v === 2 && Math.abs(c1.elapsedMs - 2000) <= 1 && c1.pausedMs === 0 && Math.abs(c1.leftMs - 28000) <= 1 && c1.attempts === 0 && c1.guttered === false, c1);
  w.advance(1000);
  w.set(Object.assign({}, round, { attempt: 1, feedback: 'Not quite.' }));
  w.click(pool()[1]); w.click(pool()[0]);
  w.advance(1000); w.key('Enter');
  const c2 = json(last('dbo:reading')[3]);
  check('reading: the wait for the verdict is not burnt, the penalty is', Math.abs(c2.elapsedMs - 3000) <= 1 && Math.abs(c2.pausedMs - 1000) <= 1 && Math.abs(c2.leftMs - 19000) <= 1 && c2.attempts === 1, c2);
  w.set(Object.assign({}, round, { attempt: 2, feedback: 'Not quite.' }));
  w.advance(15000);
  const c3 = json(last('dbo:reading')[3]);
  check('reading: when the candle gutters, what is placed goes with guttered', c3.guttered === true && c3.leftMs <= 0 && c3.attempts === 2, c3);
  check('reading: three reports for three readings', count('dbo:reading') === 3, count('dbo:reading'));

  w = mount(Reading, Object.assign({}, round, { nonce: 'b2', judge: undefined, candleMs: undefined, penaltyMs: undefined }));
  w.click(pool()[0]); w.click(pool()[1]); w.key('Enter');
  const old = last('dbo:reading');
  check('reading: a server-judged round sends the order only', old && old.length === 3, old);
});

// ---- prayer -------------------------------------------------------------------------------------------------------
section('prayer', () => {
  const Prayer = load('features/prayer/index.tsx').default;
  const verses = [{ text: 'a', startMs: 0, endMs: 6000 }, { text: 'b', startMs: 6000, endMs: 12000 }, { text: 'c', startMs: 12000, endMs: 18000 }];
  const round = { id: 35, nonce: 'p1', deity: 'Arkay', verses, totalMs: 18000, startOnPress: true, judge: 'client', slackMs: 500, startGraceMs: 1500, waitMs: 60000 };
  let w = mount(Prayer, round);
  w.advance(2000); w.key(' ');
  const st = last('dbo:prayerStart');
  check('prayer: the first press says how long the panel waited for it', st && st[1] === 'p1' && st[2] === 2000, st);
  w.advance(18100);
  const r = last('dbo:prayer');
  const v = r && json(r[4]);
  check('prayer: a full hold reports its spans, at = the round and {win:true, why:held}', r && JSON.stringify(json(r[2])) === '[[0,18000]]' && r[3] === 18000 && v.win === true && v.why === 'held' && v.worst === 0, r);
  check('prayer: durMs is the own clock from the first press, waitMs and blurs ride along', v && v.durMs >= 18000 && v.durMs < 18100 && v.waitMs === 2000 && v.blurs === 0, v);
  check('prayer: judge client shows the held prayer at once', w.text().includes('You hold the three verses.') && w.hasClass('prayer__hold--win') && w.text().includes('Rise'));

  w = mount(Prayer, Object.assign({}, round, { nonce: 'p2' }));
  w.key(' '); w.advance(3000); w.keyUp(' '); w.advance(800); w.key(' '); w.advance(15000);
  const l = json(last('dbo:prayer')[4]);
  check('prayer: a lapse longer than the slack loses, why released', l.win === false && l.why === 'released' && l.worst > 500 && l.worst < 900, l);
  check('prayer: and shows it', w.text().includes('The verses slip away from you.') && w.hasClass('prayer__hold--lose'));

  w = mount(Prayer, Object.assign({}, round, { nonce: 'p3' }));
  w.key(' '); w.advance(5000); w.fire('blur', {}); w.advance(100); w.key(' '); w.advance(13100);
  const b = json(last('dbo:prayer')[4]);
  check('prayer: a focus blip mid-hold is counted', b.blurs === 1 && b.win === true, b);

  w = mount(Prayer, Object.assign({}, round, { nonce: 'p4', waitMs: 5000 }));
  w.advance(6000); w.key(' ');
  check('prayer: past the wait the press starts nothing', count('dbo:prayerStart') === 0 && w.text().includes('The moment has passed.'), sent);

  w = mount(Prayer, Object.assign({}, round, { nonce: 'p5', judge: undefined }));
  w.key(' '); w.advance(18100);
  const s = last('dbo:prayer');
  check('prayer: a server-judged round still sends the verdict argument', s && json(s[4]).win === true);
  check('prayer: but shows no verdict of its own', !w.text().includes('You hold the three verses.') && !w.hasClass('prayer__hold--win'));
});

// ---- lockpick -----------------------------------------------------------------------------------------------------
section('lockpick', () => {
  const Lockpick = load('features/lockpick/index.tsx').default;
  const base = { type: 'lockpick', id: 46, nonce: 'L0', title: 'Chest (Adept lock)', level: 'Adept', riseMs: 450, fallMs: 650, holds: [380, 420, 400], set: [false, false, false], picks: 5, notice: '', noticeKind: '', done: false };
  const primaryDisabled = (w) => !!w.byClass('lockpick__button--primary')[0].p.disabled;
  let w = mount(Lockpick, base);
  const tryOnce = (gap) => { const before = count('dbo:lockpickTry'); w.advance(100); w.key(' '); w.advance(gap || 200); w.key(' '); return count('dbo:lockpickTry') === before + 1; };
  const miss = () => Object.assign({}, base, { notice: 'Too early or too late. The pick holds.', noticeKind: 'miss' });
  check('lockpick (server): try 1 sent', tryOnce());
  w.set(miss());
  check('lockpick (server): try 2 sent after a miss', tryOnce());
  w.set(miss());
  check('lockpick (server): try 3 sent after a second identical miss (the freeze)', tryOnce() && primaryDisabled(w));
  w.advance(5100);
  check('lockpick (server): no answer for 5 s frees the pick and says so', !primaryDisabled(w) && w.text().includes('The lock gives no answer.'));
  check('lockpick (server): nothing of the client path is sent', count('dbo:lockpickResult') === 0);

  const local = Object.assign({}, base, { nonce: 'L1', holds: [400, 400], set: [false, false], picks: 2, judge: 'client', graceMs: 70, snaps: [1, 0, 1, 1, 1, 1], maxTries: 6 });
  w = mount(Lockpick, local);
  w.advance(100); w.key(' '); w.advance(600); w.key(' ');
  check('lockpick (client): a landed set holds at once, no per-try packet', count('dbo:lockpickTry') === 0 && w.hasClass('lockpick__slot--set'));
  w.advance(100); w.key(' '); w.advance(100); w.key(' ');
  check('lockpick (client): a miss on a try the server rolled safe keeps the pick', w.text().includes('The pick holds.') && w.text().includes('Lockpicks: 2'), w.text());
  w.advance(100); w.key(' '); w.advance(600); w.key(' ');
  const r = last('dbo:lockpickResult');
  const tries = r && json(r[3]);
  check('lockpick (client): the last tumbler reports the lock once: win, every try, start and end', r && r[1] === 'L1' && r[2] === 'win' && tries.length === 3 && tries[0][0] === 0 && tries[0][3] === 1 && tries[1][3] === 0 && tries[2][0] === 1 && typeof r[4] === 'number' && r[5] > r[4], r);
  check('lockpick (client): the tries are [tumbler, push, set, landed] on its own clock', tries && tries.every((t) => t.length === 4 && t[2] > t[1]) && tries[0][2] - tries[0][1] === 600);
  check('lockpick (client): the win shows at once', w.text().includes('The Adept lock gives way.') && w.text().includes('Close'));
  w.key(' ');
  check('lockpick (client): a double tap of the set key does not close the lock it just opened', count('dbo:lockpickCancel') === 0);
  w.set(Object.assign({}, local, { done: true, notice: 'The Adept lock gives way.', noticeKind: 'win', set: [true, true] }));
  check('lockpick (client): the server answer does not restart the lock', count('dbo:lockpickResult') === 1 && w.byClass('lockpick__slot--set').length === 2);
  w.key('Escape');
  check('lockpick (client): Escape after the result closes', count('dbo:lockpickCancel') === 1);

  w = mount(Lockpick, Object.assign({}, local, { nonce: 'L2', picks: 1, snaps: [1, 1] }));
  w.advance(100); w.key(' '); w.advance(100); w.key(' ');
  const f = last('dbo:lockpickResult');
  check('lockpick (client): a snapped last pick ends the lock as a fail', f && f[2] === 'fail' && w.text().includes('it was your last'), f);

  w = mount(Lockpick, Object.assign({}, local, { nonce: 'L3', picks: 3, snaps: [1, 1, 1] }));
  w.advance(100); w.key(' '); w.advance(100); w.key(' ');
  check('lockpick (client): a snap shows and takes a pick', w.text().includes('The pick snaps.') && w.text().includes('Lockpicks: 2'));
  w.key('Escape');
  const c = last('dbo:lockpickResult');
  check('lockpick (client): leaving reports cancel with the snapped try, so the pick is taken', c && c[2] === 'cancel' && json(c[3]).length === 1 && count('dbo:lockpickCancel') === 0, c);
  w.key('Escape');
  check('lockpick (client): a second Escape closes', count('dbo:lockpickCancel') === 1);

  w = mount(Lockpick, Object.assign({}, local, { nonce: 'L4', snaps: [0, 0], maxTries: 2 }));
  w.advance(100); w.key(' '); w.advance(100); w.key(' '); w.advance(100); w.key(' '); w.advance(100); w.key(' ');
  const m = last('dbo:lockpickResult');
  check('lockpick (client): the last try the server allowed ends the lock', m && m[2] === 'fail' && json(m[3]).length === 2, m);

  w = mount(Lockpick, Object.assign({}, local, { nonce: 'L5', judge: undefined }));
  w.advance(100); w.key(' '); w.advance(600); w.key(' ');
  check('lockpick: snaps without judge client stay on the per-try path', count('dbo:lockpickTry') === 1 && count('dbo:lockpickResult') === 0);
});

// ---- rite ---------------------------------------------------------------------------------------------------------
section('rite', () => {
  const Rite = load('features/rite/index.tsx').default;
  const round = { id: 39, nonce: 'R', title: 'The Blood Fever', flavor: '', deadly: false, round: 1, rounds: 5, need: 3, hits: 0, misses: 0, period: 1500, zone: [0.5, 0.2], startsIn: 700, result: '' };
  let w = mount(Rite, round);
  w.advance(300); w.key(' ', 'Space');
  check('rite (server): a press in the lead-in sends nothing and keeps the round', count('dbo:riteStrike') === 0 && !w.byClass('rite__button--primary')[0].p.disabled);
  w.advance(780); w.key(' ', 'Space');
  const o = last('dbo:riteStrike');
  check('rite (server): a press after the lead-in sends the bare strike', o && o.length === 2 && o[1] === 'R', o);
  w.advance(8000);
  check('rite (server): no timeout of its own', count('dbo:riteTimeout') === 0);

  const local = Object.assign({}, round, { nonce: 'C', judge: 'client', rnonce: 'r1', graceMs: 100, limitMs: 7000 });
  w = mount(Rite, local);
  w.advance(300); w.key(' ', 'Space');
  check('rite (client): a press in the lead-in sends nothing', count('dbo:riteStrike') === 0);
  w.advance(400 + 375); w.key(' ', 'Space');
  const h = last('dbo:riteStrike');
  check('rite (client): a press on the mark reports round, rnonce, hit, pressMs, atMs and the marker shown', h && h[1] === 'C' && h[2] === 1 && h[3] === 'r1' && h[4] === 'hit' && Math.abs(h[5] - 375) <= 16 && Math.abs(h[6] - 1075) <= 1 && Math.abs(h[7] - 0.5) < 0.03, h);
  check('rite (client): the hit shows at once', w.text().includes('True.') && w.byClass('rite__pip--hit').length === 1);
  w.key(' ', 'Space');
  check('rite (client): one report per round', count('dbo:riteStrike') === 1);
  w.set(Object.assign({}, local, { round: 2, rnonce: 'r2', hits: 1, result: 'True.' }));
  w.advance(700 + 800); w.key(' ', 'Space');
  const m = last('dbo:riteStrike');
  check('rite (client): off the mark is a miss, shown at once', m && m[3] === 'r2' && m[4] === 'miss' && w.text().includes('Missed (off the mark).') && w.byClass('rite__pip--miss').length === 1, m);
  w.set(Object.assign({}, local, { round: 3, rnonce: 'r3', hits: 1, misses: 1, result: 'Missed.' }));
  w.advance(700 + 7050);
  const t = last('dbo:riteTimeout');
  check('rite (client): its own limit sends riteTimeout once', t && t[1] === 'C' && t[2] === 3 && t[3] === 'r3' && count('dbo:riteTimeout') === 1 && w.text().includes('too late'), t);
});

// ---- parity with the server's arithmetic ----------------------------------------------------------------------------
section('parity', () => {
  const J = load('utils/minigameJudge.ts');
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; };
  // server prayer.js judge(), from the first-press check on (origin/server 69a5f55a)
  const serverPrayer = (round, list) => {
    const r = { worst: 0, bad: '' };
    const first = list.length ? Number(list[0][0]) : Infinity;
    if (first > round.startGraceMs) { r.bad = 'slow'; return r; }
    round.verses.forEach((v, i) => {
      const from = i === 0 ? Math.max(v.startMs, first) : v.startMs;
      let inside = 0;
      for (const [down, up] of list) inside += Math.max(0, Math.min(up, v.endMs) - Math.max(down, from));
      r.worst = Math.max(r.worst, (v.endMs - from) - inside);
    });
    if (r.worst > round.slackMs) r.bad = 'released';
    return r;
  };
  const verses = [{ startMs: 0, endMs: 6000 }, { startMs: 6000, endMs: 12000 }, { startMs: 12000, endMs: 18000 }];
  let agree = 0;
  const N = 10000;
  for (let k = 0; k < N; k++) {
    const spans = [];
    let t = Math.floor(rnd() * 2000);
    while (t < 18000 && spans.length < 8) { const up = Math.min(18000, t + Math.floor(rnd() * 9000)); spans.push([t, up]); t = up + Math.floor(rnd() * 900); }
    const round = { verses, slackMs: 500, startGraceMs: 1500 };
    const a = J.prayerVerdict(verses, spans, 500, 1500), b = serverPrayer(round, spans);
    if (a.win === !b.bad && (b.bad ? a.why === b.bad : a.why === 'held') && (b.bad === 'slow' || a.worst === b.worst)) agree++;
  }
  check(`parity: prayer verdict agrees with prayer.js on ${N} random holds`, agree === N, agree);

  const serverMarker = (round, t) => { const ph = (((t % round.period) + round.period) % round.period) / round.period; return ph < 0.5 ? ph * 2 : 2 - ph * 2; };
  agree = 0;
  for (let k = 0; k < N; k++) {
    const period = Math.round(1700 - Math.floor(rnd() * 5) * 150 + rnd() * 200), t = Math.floor(rnd() * 9000) - 200;
    if (J.riteMarkerAt(period, t) === serverMarker({ period }, t)) agree++;
  }
  check(`parity: rite marker agrees with supernatural.js on ${N} random presses`, agree === N, agree);

  agree = 0;
  let hitsGrace = 0, hitsNone = 0;
  for (let k = 0; k < N; k++) {
    const period = 1100 + Math.floor(rnd() * 600), center = 0.2 + rnd() * 0.6, width = 0.1 + rnd() * 0.14, t = Math.floor(rnd() * 7000);
    const inZone = (x) => Math.abs(serverMarker({ period }, x) - center) <= width / 2;
    const none = J.riteHit(period, center, width, t, 0), grace = J.riteHit(period, center, width, t, 100);
    let brute = false; for (let d = -100; d <= 100; d++) if (inZone(t + d)) brute = true;
    if (none === inZone(t) && grace === brute && (!none || grace)) agree++;
    if (none) hitsNone++; if (grace) hitsGrace++;
  }
  check(`parity: rite hit is the zone test at every ms within grace (${N} presses; ${hitsNone} hit with no grace, ${hitsGrace} with 100 ms)`, agree === N, agree);

  agree = 0;
  for (let k = 0; k < N; k++) {
    const hold = 140 + Math.floor(rnd() * 700), push = Math.floor(rnd() * 5000), set = push + Math.floor(rnd() * 1600);
    const held = set - push, server = Number.isFinite(held) && held >= 450 - 70 && held <= 450 + hold + 70;
    if (J.lockpickLanded(push, set, 450, hold, 70) === server) agree++;
  }
  check(`parity: lockpick set agrees with lockpick.js on ${N} random tries`, agree === N, agree);

  // server minigames.js rightOf (origin/labour-pick): the first spot with the strictly clearest cue
  const serverRight = (spots) => spots.reduce((best, s, i) => (s[2] > spots[best][2] ? i : best), 0);
  agree = 0;
  for (let k = 0; k < N; k++) {
    const n = 2 + Math.floor(rnd() * 4);
    const spots = Array.from({ length: n }, () => [rnd() * 100, rnd() * 100, Math.round(rnd() * (k % 3 ? 100 : 4)) / 100]);
    if (J.pickRight(spots) === serverRight(spots)) agree++;
  }
  check(`parity: the pick round's right spot agrees with minigames.js on ${N} random blows (ties included)`, agree === N, agree);
});

// ---- the capabilities the server keys the lockpick and rite rounds on -------------------------------------------------
section('hud', () => {
  const hud = fs.readFileSync(path.join(__dirname, '..', 'src', 'features', 'hud', 'index.tsx'), 'utf8');
  check('hud: dbo:uiCaps carries lockpickLocal and riteJudge', /'lockpickLocal'/.test(hud) && /'riteJudge'/.test(hud));
});

Date.now = realDateNow;
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
