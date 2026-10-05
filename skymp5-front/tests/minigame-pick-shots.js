// Shots of the pick rounds that replaced the other timed mini-games (Nate, 4-5 Oct: no timing): the bound-hands
// struggle, the lock, the prayer, the rite and the reading. Renders each widget in headless Chrome on a fake clock,
// plays a round, screenshots every state at 1280x720 and 1920x1080, checks every spot sits at the server's x and y and
// the right cue is drawn clearest, and checks every report the widget sends against the picks played.
//
//   LD_LIBRARY_PATH=$(cat ~/claude-c-layout/ldpath) node tests/minigame-pick-shots.js [front dir] [out dir]
//
// Writes <out>/<game>/<state>-<w>x<h>.png and <out>/<game>/panel/<state>-<w>x<h>.png. The spots come from
// tests/pick-steps.json, rolled by the server's minigames.js pickSteps; the prayer lines are the server's own.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const buildPage = require('./lib/shotpage');

const FRONT = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const OUTDIR = path.resolve(process.argv[3] || path.join(os.tmpdir(), 'minigame-pick-shots'));
const puppeteer = require(process.env.PUPPETEER_DIR || path.join(process.env.HOME, 'claude-c-layout/node_modules/puppeteer'));
const STEPS = JSON.parse(fs.readFileSync(path.join(__dirname, 'pick-steps.json'), 'utf8'));

const page = buildPage({
  front: FRONT,
  widgets: { labour: 'features/labour/index.tsx', lockpick: 'features/lockpick/index.tsx', prayer: 'features/prayer/index.tsx', rite: 'features/rite/index.tsx', reading: 'features/reading/index.tsx' },
  styles: ['features/labour/styles.scss', 'features/lockpick/styles.scss', 'features/prayer/styles.scss', 'features/rite/styles.scss', 'features/reading/styles.scss'],
});
const rightOf = (spots) => spots.reduce((b, q, i) => (q[2] > spots[b][2] ? i : b), 0);
const wrongOf = (spots) => (rightOf(spots) + 1) % spots.length;

// The prayer as prayer.js rolls it: the true line of each verse, against lines of the other kind's prayers
const PRAYER_AKATOSH = {
  id: 35, nonce: 'pp-a', mode: 'pick', deity: 'Akatosh', kind: 'divine', shrine: 'Shrine of Akatosh', startOnPress: true, judge: 'client',
  sphere: 'Time. Chief of the Divines, the Dragon God whose covenant with Alessia binds the Empire.',
  verses: [{ lines: ['Kneel early and it is over sooner', 'Hear me, for I have walked far to stand here', 'Every thread pulls another'] },
    { lines: ['Dusk and dawn are the same door', 'The scorned do not beg', 'Time turns, and I turn with it'] },
    { lines: ['Keep my name where you can find it again', 'One more, and then one more after that', 'What is known cannot be unknown again'] }],
  right: [1, 2, 0], slips: 2, totalMs: 120000, minPickMs: 300,
};
const PRAYER_MOLAGBAL = Object.assign({}, PRAYER_AKATOSH, {
  nonce: 'pp-m', deity: 'Molag Bal', kind: 'daedra', shrine: 'Shrine of Molag Bal',
  sphere: 'Domination and the enslavement of mortals. The King of Rape; the father of vampires; the reason a black soul gem is black.',
  verses: [{ lines: ['Mercy costs nothing and I have little else', 'Wisdom is slow and I am willing', 'I bring no gold, only the hours of my hands'] },
    { lines: ['Everything that lives belongs to something', 'The dead are counted and none are lost', 'Stand between the weak and the world'] },
    { lines: ['An honest trade leaves both hands full', 'What was given I have not squandered', 'Beauty is not owed to me, but I will look for it'] }],
  right: [2, 0, 1],
});

(async () => {
  const b = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox'] });
  const pg = await b.newPage();
  let failures = 0;
  const note = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const at = async (t) => { await pg.evaluate((v) => { window.__t = v; }, t); await wait(60); };
  const key = async (k) => { await pg.evaluate((kk) => window.dispatchEvent(new KeyboardEvent('keydown', { key: kk, code: /^\d$/.test(kk) ? 'Digit' + kk : kk === ' ' ? 'Space' : kk, bubbles: true })), k); await wait(25); };
  // A frame of a pick's animation held still: timers stopped, every animation the pick began set to ms into itself, then let go
  const holdTimers = () => pg.evaluate(() => { window.__realSetTimeout = window.setTimeout; window.setTimeout = () => 0; });
  const freeze = (ms) => pg.evaluate((m) => { window.__frozen = (window.__frozen && window.__frozen.length ? window.__frozen : document.getAnimations().filter((x) => x.playState !== 'finished')); for (const x of window.__frozen) { x.pause(); x.currentTime = m; } }, ms);
  const release = () => pg.evaluate(() => { for (const x of window.__frozen || []) x.finish(); window.__frozen = []; if (window.__realSetTimeout) window.setTimeout = window.__realSetTimeout; });
  const PANELS = '.labour__bench, .lockpick__plate, .prayer__shrine, .rite__panel, .reading__desk';

  for (const [w, h] of [[1280, 720], [1920, 1080]]) {
    await pg.setViewport({ width: w, height: h });
    await pg.goto('file://' + page.file, { waitUntil: 'load' });
    await pg.evaluate(() => document.fonts.ready);
    const res = `${w}x${h}`;
    let game = '';
    const shot = async (state) => {
      const dir = path.join(OUTDIR, game);
      fs.mkdirSync(path.join(dir, 'panel'), { recursive: true });
      await pg.screenshot({ path: path.join(dir, `${state}-${res}.png`) });
      const box = await pg.evaluate((sel) => { const el = document.querySelector(sel); const r = el && el.getBoundingClientRect(); return r && { x: r.left, y: r.top, width: r.width, height: r.height }; }, PANELS);
      if (box) await pg.screenshot({ path: path.join(dir, 'panel', `${state}-${res}.png`), clip: box });
      return box;
    };
    const open = async (type, data, domain) => {
      await pg.evaluate(() => { window.hide(); window.__sent = []; window.__t = 0; });
      await pg.evaluate((tp, d, dm) => window.show(tp, d, dm), type, data, domain);
      await wait(450);
    };
    // Picks key k at round time t; with frames, holds the animation at each ms and shoots it
    const pickAt = async (t, k, frames) => {
      await at(t);
      if (frames) await holdTimers();
      await key(String(k + 1));
      if (frames) { await wait(30); for (const [ms, name] of frames) { await freeze(ms); await shot(name); } await release(); } else await wait(120);
    };
    const checkSpots = async (label, track, spotSel, spots) => {
      const m = await pg.evaluate((tr, ss) => {
        const t = document.querySelector(tr);
        const r = t.getBoundingClientRect();
        const inner = { x: r.left + t.clientLeft, y: r.top + t.clientTop, w: t.clientWidth, h: t.clientHeight };
        return { inner, list: [...document.querySelectorAll(ss)].map((el) => { const q = el.getBoundingClientRect(); return { cx: q.left + q.width / 2, cy: q.top + q.height / 2, op: Number(getComputedStyle(el.querySelector('svg')).opacity) }; }) };
      }, track, spotSel);
      note(m.list.length === spots.length && spots.every((q, i) => Math.abs(m.list[i].cx - (m.inner.x + q[0] / 100 * m.inner.w)) <= 1 && Math.abs(m.list[i].cy - (m.inner.y + q[1] / 100 * m.inner.h)) <= 1), `${res} ${label}: ${m.list.length} spots at the server's x, y`);
      const r = rightOf(spots);
      note(m.list.every((q, i) => i === r || q.op < m.list[r].op), `${res} ${label}: the right cue drawn clearest (${m.list.map((q) => q.op.toFixed(2)).join(' ')})`);
    };
    const sent = (ev) => pg.evaluate((e) => window.__sent.filter((s) => s[0] === e), ev);
    const height = async (label) => {
      const hgt = await pg.evaluate((sel) => Math.round(document.querySelector(sel).getBoundingClientRect().height), PANELS);
      console.log(`     ${res} ${label}: panel ${hgt} px high`);
    };

    // ---- struggle: pull where the rope gives; one wrong pull and the bonds hold ----
    game = 'struggle';
    const S = { id: 40, nonce: 'ps-' + res, kind: 'struggle', event: 'struggle', mode: 'pick', title: 'Bound Hands',
      hint: 'Pull where the rope gives; one wrong pull and the bonds hold.', strikes: 6, slips: 0, steps: STEPS.struggle,
      totalMs: 60000, minPickMs: 150, strikeLabel: 'Pull', leaveLabel: 'Give up', doneLabel: 'Close', judge: 'client' };
    await open('labour', S);
    await checkSpots('struggle start', '.labour__bar', '.labour__spot', S.steps[0]);
    await shot('start'); await height('struggle');
    let list = [];
    for (let k = 0; k < 6; k++) {
      const t = 500 * (k + 1);
      list.push([rightOf(S.steps[k]), t]);
      await pickAt(t, rightOf(S.steps[k]), k === 0 ? [[200, 'pull'], [700, 'landed']] : k === 2 ? [[700, 'mid']] : null);
    }
    await wait(300); await shot('clean');
    let got = await sent('dbo:struggle');
    note(got.length === 1 && got[0][2] === JSON.stringify(list) && JSON.parse(got[0][4]).win === true, `${res} struggle: a clean round reports ${got[0] ? got[0][2] : 'nothing'}`);
    await pg.evaluate((d) => window.show('labour', d), Object.assign({}, S, { result: 'You wrench your hands free!', resultKind: 'win' })); await wait(80); await shot('free-server');
    await open('labour', Object.assign({}, S, { nonce: 'ps2-' + res }));
    await pickAt(500, rightOf(S.steps[0]));
    await pickAt(1000, wrongOf(S.steps[1]), [[200, 'wrong-pull'], [700, 'lose']]);
    got = await sent('dbo:struggle');
    note(got.length === 1 && got[0][2] === JSON.stringify([[rightOf(S.steps[0]), 500], [wrongOf(S.steps[1]), 1000]]) && JSON.parse(got[0][4]).win === false, `${res} struggle: one wrong pull ends it, ${got[0] ? got[0][2] : 'nothing'}`);
    await open('labour', Object.assign({}, S, { nonce: 'ps3-' + res, steps: STEPS.struggleWatched, hint: 'Someone is watching closely. Pull where the rope gives; one wrong pull and the bonds hold.' }));
    await checkSpots('struggle watched', '.labour__bar', '.labour__spot', STEPS.struggleWatched[0]);
    await shot('watched-start');

    // ---- lock: find where the pins give ----
    game = 'lockpick';
    const L = { type: 'lockpick', id: 46, nonce: 'pl-' + res, title: 'Chest (Adept lock)', level: 'Adept', set: [false, false, false], picks: 3, notice: '', noticeKind: '', done: false, seq: 1,
      judge: 'client', snaps: [0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], maxTries: 12, mode: 'pick', steps: STEPS.lockAdept, totalMs: 180000, minPickMs: 150 };
    await open('lockpick', L, 'aqua');
    await checkSpots('lock start', '.lockpick__keyway', '.lockpick__spot', L.steps[0]);
    await shot('start'); await height('lock');
    await pickAt(500, rightOf(L.steps[0]), [[200, 'probe'], [700, 'set']]);
    await pickAt(1000, wrongOf(L.steps[1]), [[230, 'snap'], [700, 'snapped']]);
    list = [[rightOf(L.steps[0]), 500], [wrongOf(L.steps[1]), 1000]];
    for (let k = 2; k < 5; k++) { list.push([rightOf(L.steps[k]), 500 * (k + 1)]); await pickAt(500 * (k + 1), rightOf(L.steps[k]), k === 3 ? [[700, 'mid']] : null); }
    await wait(300); await shot('open');
    got = await sent('dbo:lockpickResult');
    note(got.length === 1 && got[0][2] === 'win' && got[0][3] === JSON.stringify(list), `${res} lock: picked, ${got[0] ? got[0][3] : 'nothing'}`);
    await open('lockpick', Object.assign({}, L, { nonce: 'pl2-' + res, picks: 1, snaps: L.snaps.map(() => 1) }), 'aqua');
    await pickAt(500, wrongOf(L.steps[0]), [[700, 'last-pick']]);
    got = await sent('dbo:lockpickResult');
    note(got.length === 1 && got[0][2] === 'fail', `${res} lock: the last pick snaps, ${got[0] ? got[0][2] : 'nothing'}`);
    await open('lockpick', Object.assign({}, L, { nonce: 'pl3-' + res, title: 'Door (Master lock)', level: 'Master', set: [false, false, false, false, false], steps: STEPS.lockMaster }), 'aqua');
    await checkSpots('lock master', '.lockpick__keyway', '.lockpick__spot', STEPS.lockMaster[0]);
    await shot('master-start');

    // ---- prayer: speak the verses that belong ----
    game = 'prayer';
    for (const [P, tag, dom] of [[PRAYER_AKATOSH, 'divine', 'aedric'], [PRAYER_MOLAGBAL, 'daedric', 'aedric']]) {
      const pr = Object.assign({}, P, { nonce: P.nonce + res });
      await open('prayer', pr, dom);
      const lines = await pg.evaluate(() => [...document.querySelectorAll('.prayer__line')].map((e) => e.innerText.replace(/^\d+\s*/, '')));
      note(lines.length === 3 && lines.every((l, i) => l === pr.verses[0].lines[i]), `${res} prayer ${tag}: the first verse's three lines as sent`);
      await shot(`${tag}-start`); await height(`prayer ${tag}`);
      list = [];
      if (tag === 'divine') {
        list.push([(pr.right[0] + 1) % 3, 500]); await pickAt(500, (pr.right[0] + 1) % 3, [[200, 'divine-falter'], [700, 'divine-faltered']]);
        list.push([pr.right[0], 1000]); await pickAt(1000, pr.right[0], [[180, 'divine-spoken']]);
        list.push([pr.right[1], 1500]); await pickAt(1500, pr.right[1], [[700, 'divine-mid']]);
        list.push([pr.right[2], 2000]); await pickAt(2000, pr.right[2]);
        await wait(300); await shot('divine-held');
        got = await sent('dbo:prayer');
        note(got.length === 1 && got[0][2] === JSON.stringify(list) && JSON.parse(got[0][4]).win === true && (await sent('dbo:prayerStart')).length === 1, `${res} prayer: spoken, ${got[0] ? got[0][2] : 'nothing'}`);
        await pg.evaluate((d) => window.show('prayer', d, 'aedric'), Object.assign({}, pr, { result: 'You speak the three verses. Akatosh takes note, and no more.', resultKind: 'win' })); await wait(80); await shot('divine-held-server');
      } else {
        for (let k = 0; k < 3; k++) await pickAt(500 * (k + 1), (pr.right[0] + 1 + (k % 2)) % 3);
        await wait(300); await shot('daedric-slipped');
        got = await sent('dbo:prayer');
        note(got.length === 1 && JSON.parse(got[0][4]).win === false && JSON.parse(got[0][4]).slips === 3, `${res} prayer: three faltered lines slip it away`);
      }
    }

    // ---- rite: read the marks of the rite ----
    game = 'rite';
    const R = (round, hits, misses, cue, result) => ({ id: 39, nonce: 'pr-' + res, title: cue === 'trail' ? 'The Great Hunt' : 'The Blood Fever',
      flavor: cue === 'trail' ? 'Hircine hunts you now. Run true, and he may name you his.' : 'Hold to the beat of a heart that is slowing. Strike when the pulse crosses the mark.',
      deadly: cue === 'trail', round, rounds: 5, need: cue === 'trail' ? 4 : 3, hits, misses, result: result || '', judge: 'client', rnonce: 'r' + round,
      mode: 'pick', spots: STEPS.rite[round - 1], cue, minPickMs: 300, limitMs: 90000 });
    await open('rite', R(1, 0, 0, 'pulse'), 'lorkhan');
    await checkSpots('rite fever round 1', '.rite__strip', '.rite__spot', STEPS.rite[0]);
    await shot('fever-start'); await height('rite');
    await pickAt(500, rightOf(STEPS.rite[0]), [[120, 'fever-beat'], [700, 'fever-true']]);
    got = await sent('dbo:riteStrike');
    note(got.length === 1 && got[0][4] === 'pick' && got[0][5] === rightOf(STEPS.rite[0]) && got[0][6] === 500, `${res} rite: [nonce, round, rnonce, pick, index, atMs] = ${JSON.stringify(got[0])}`);
    await pg.evaluate((d) => window.show('rite', d, 'lorkhan'), R(4, 2, 1, 'pulse', 'True.')); await wait(450);
    await checkSpots('rite fever round 4', '.rite__strip', '.rite__spot', STEPS.rite[3]);
    await pickAt(500, wrongOf(STEPS.rite[3]), [[120, 'fever-wrong'], [700, 'fever-missed']]);
    await open('rite', R(5, 2, 2, 'trail'), 'lorkhan');
    await checkSpots('rite hunt round 5', '.rite__strip', '.rite__spot', STEPS.rite[4]);
    await shot('hunt-round5');

    // ---- reading by candle stubs ----
    game = 'reading';
    const words = ['the', 'Heart', 'of', 'Lorkhan', 'lay', 'beneath', 'Red', 'Mountain'];
    const order = [3, 0, 6, 2, 7, 1, 5, 4];
    const D = { id: 30, nonce: 'pd-' + res, title: 'The Real Barenziah', words: order.map((i) => words[i]), judge: 'client', mode: 'pick', stubs: 4, totalMs: 600000, locked: [], attempt: 0 };
    await open('reading', D, 'dragonbreak');
    await shot('start'); await height('reading');
    const cardOf = (word, used) => D.words.findIndex((x, k) => x === word && !used.includes(k));
    const used = [];
    for (const wd of ['the', 'Heart', 'of', 'Lorkhan', 'lay', 'beneath', 'Mountain', 'Red']) used.push(cardOf(wd, used));
    for (const c of used) await pg.evaluate((i) => document.querySelectorAll('.reading__pool .reading__word')[i].click(), c);
    await at(240000);
    await shot('placed');
    await key('Enter');
    got = await sent('dbo:reading');
    note(got.length === 1 && JSON.parse(got[0][3]).v === 3 && JSON.parse(got[0][3]).elapsedMs >= 240000, `${res} reading: four minutes in, the candle still whole, ${got[0] ? got[0][3] : 'nothing'}`);
    await pg.evaluate((d) => window.show('reading', d, 'dragonbreak'), Object.assign({}, D, { attempt: 1, locked: used.slice(0, 6), feedback: 'Not quite. The first 6 words are right. A stub of the candle burns away.' }));
    await wait(120); await shot('wrong');
    await pg.evaluate((d) => window.show('reading', d, 'dragonbreak'), Object.assign({}, D, { attempt: 1, locked: used.slice(0, 6), result: 'You read it through. The words stay with you.', resultKind: 'win' }));
    await wait(80); await shot('read');
    await pg.evaluate((d) => window.show('reading', d, 'dragonbreak'), Object.assign({}, D, { attempt: 5, result: 'The last of the candle gutters. The words swim on the page.', resultKind: 'lose', answer: words.join(' ') }));
    await wait(80); await shot('guttered');
  }
  await b.close();
  page.cleanup();
  console.log(`\n${failures ? failures + ' FAILED' : 'all spot, cue and report checks passed'}; shots in ${OUTDIR}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); page.cleanup(); process.exit(1); });
