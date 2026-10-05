// Scripted test for the Scholar reading round in gamemode.js. The round lives inline in the gamemode, so this
// cuts that section out (from "---- Scholar" to "---- dungeons") and runs it against a mock api: the candle
// length, a wrong reading (penalty, locked words, the round goes on), a right one, words judged by text so a
// repeated word may swap, locks that cannot be undone, the deadline, the tier bands and province lines, and a
// stale round expiring. Run it from this folder's parent with
//
//   node tests\reading-harness.js
'use strict';
const fs = require('fs');
const path = require('path');

const SERVER = path.resolve(__dirname, '..');
process.chdir(SERVER); // skills.json and readables.json resolve by cwd, as on the server
const src = fs.readFileSync(path.join(SERVER, 'gamemode.js'), 'utf8');
const start = src.indexOf('// ---- Scholar: books are nodes');
const end = src.indexOf('// ---- dungeons: one-hour leases');
if (start < 0 || end < 0) { console.log('FAIL the reading section markers are gone from gamemode.js'); process.exit(1); }
const section = src.slice(start, end);

let wallClock = 1780000000000;
Date.now = () => wallClock;

const READER = 0x14;
// Any real record will do as a book's base: the mock says every lookup is a BOOK, and only the plugin matters.
const SKYRIM_BOOK = 0x5001, CYRODIIL_BOOK = 0x5002, TOME_BOOK = 0x5003, SKILL_BOOK = 0x5004;
// BOOK DATA byte 0 by base: SpellTomeFlames 9cd51 teaches a spell (0x04), SkillOneHanded1 1afe3 a skill (0x01)
const BOOK_FLAGS = { 0x9cd51: 0x04, 0x1afe3: 0x01 };
const props = new Map([
  [SKYRIM_BOOK + '|baseDesc', 'f:Skyrim.esm'],
  [CYRODIIL_BOOK + '|baseDesc', '61b52:BSHeartland.esm'],
  [TOME_BOOK + '|baseDesc', '9cd51:Skyrim.esm'],
  [SKILL_BOOK + '|baseDesc', '1afe3:Skyrim.esm'],
  [READER + '|private.mastery', { order: ['scholar'], skills: { scholar: { rank: 0 } } }],
]);
const out = { widgets: [], closed: 0, personals: [], events: [], audits: [], logs: [] };
const handlers = new Map();
const everyFns = new Map();
const stubs = {
  mp: {
    get: (id, p) => props.get(id + '|' + p),
    set: (id, p, v) => props.set(id + '|' + p, v),
    getIdFromDesc: (d) => parseInt(String(d).split(':')[0], 16) >>> 0,
    lookupEspmRecordById: (id) => ({ record: { type: 'BOOK', editorId: 'BookTestVolume', fields: [{ type: 'DATA', data: new Uint8Array([BOOK_FLAGS[id] || 0, 0, 0, 0]) }] } }),
  },
  cfg: {},
  fs, path,
  MG: require(path.join(SERVER, 'minigames.js')),
  log: (...x) => out.logs.push(x.join(' ')),
  personal: (a, t) => out.personals.push(t),
  audit: (t) => out.audits.push(t),
  who: () => 'Reader',
  display: () => 'Reader',
  every: (name, ms, fn) => everyFns.set(name, fn),
  openWidget: (a, w, focus) => { out.widgets.push({ w, focus }); if (w && w.result) out.results.push(String(w.result)); return true; },
  closeWidget: () => { out.closed++; return true; },
  onUi: (ev, fn) => { const l = handlers.get(ev) || []; l.push(fn); handlers.set(ev, l); },
  giveItem: (a, id) => { out.given.push(id >>> 0); return true; },
};
out.given = [];
out.results = [];
globalThis.__alduinakMasteryEvent = (kind, a) => out.events.push(kind);
// eslint-disable-next-line no-new-func
const READ = new Function(...Object.keys(stubs), section + '\nreturn READ;')(...Object.values(stubs));
// The cases up to "client-judged" are today's rules, judged by the server's deadline: they run with the rollback switch,
// which so proves reading.clientJudged false behaves exactly as before. The client-judged cases are at the end.
READ.clientJudged = false;

let failures = 0, checks = 0;
const check = (name, ok, detail) => { checks++; if (!ok) { failures++; console.log(`FAIL ${name}${detail !== undefined ? ': ' + JSON.stringify(detail) : ''}`); } else console.log(`ok   ${name}`); };
const ui = (ev, args) => (handlers.get(ev) || []).forEach((fn) => fn(READER, args, 30));
const last = () => out.widgets[out.widgets.length - 1].w;
// The order of cards (indices into the shuffled words) that spells out `sentence`, honouring duplicates.
const solve = (w, sentence) => { const used = new Set(); return sentence.map((s) => { const i = w.words.findIndex((x, k) => x === s && !used.has(k)); used.add(i); return i; }); };
const open = (book) => { ui('readingCancel', []); out.widgets.length = 0; props.delete(READER + '|private.scholarReads'); globalThis.__dboReadBook(book, READER); return last(); };

// ---- the candle ----
let w = open(SKYRIM_BOOK);
const n = w.words.length;
check('a Novice gets 5 to 7 words', n >= 5 && n <= 7, n);
check('the candle is 30 s + 6 s a word', w.seconds === 30 + 6 * n && w.endsInMs === (30 + 6 * n) * 1000, w);
check('the round opens focused, nothing locked', out.widgets[0].focus === true && w.locked.length === 0 && w.attempt === 0);

// A reversed order is wrong unless the line reads the same backwards, which none does.
const reversed = w.words.map((_, i) => i).reverse();
ui('reading', [w.nonce, JSON.stringify(reversed)]);
let v = last();
const wasWrong = !v.result;
check('a wrong reading does not end the round', wasWrong, v);
if (wasWrong) {
  check('...it costs 8 s of candle', v.endsInMs === (30 + 6 * n - 8) * 1000, v.endsInMs);
  check('...it counts the attempt and says so', v.attempt === 1 && /Not quite/.test(v.feedback));
  check('...the locked cards are the right start of what was sent', JSON.stringify(v.locked) === JSON.stringify(reversed.slice(0, v.locked.length)));
  const lockedBefore = v.locked.slice();
  if (lockedBefore.length) {
    const tampered = w.words.map((_, i) => i).filter((i) => i !== lockedBefore[0]).concat([lockedBefore[0]]);
    ui('reading', [w.nonce, JSON.stringify(tampered)]);
    check('an order that moves a locked card is thrown out, not judged', last().result && last().resultKind === 'lose');
  }
}

// ---- a right reading, found by losing once and reading the answer ----
w = open(SKYRIM_BOOK);
wallClock += (w.endsInMs + 10000);
ui('reading', [w.nonce, '[]']);
v = last();
check('past the deadline the round is lost', v.resultKind === 'lose' && typeof v.answer === 'string', v);
check('...and the lost round shows the sentence', v.answer.split(' ').length === w.words.length);
const sentence = v.answer.split(' ');
// Replay: open a fresh round until the same line comes up, then answer it right.
let won = false;
for (let tries = 0; tries < 400 && !won; tries++) {
  wallClock += 3 * 60000;
  w = open(SKYRIM_BOOK);
  if (w.words.slice().sort().join(' ') !== sentence.slice().sort().join(' ')) { ui('readingCancel', [w.nonce]); continue; }
  wallClock += 5000;
  ui('reading', [w.nonce, JSON.stringify(solve(w, sentence))]);
  won = last().resultKind === 'win';
}
check('the right order wins', won);
check('...and credits a read to the Scholar skill', out.events.includes('read'));

// ---- words are judged by text, so the two "Legion" cards are interchangeable ----
const LEGION = 'The Legion marches on roads the Legion built'.split(' ');
props.set(READER + '|private.mastery', { order: ['scholar'], skills: { scholar: { rank: 2 } } });
let swapped = null;
for (let tries = 0; tries < 800 && swapped === null; tries++) {
  wallClock += 3 * 60000;
  w = open(CYRODIIL_BOOK);
  if (w.words.slice().sort().join(' ') !== LEGION.slice().sort().join(' ')) { ui('readingCancel', [w.nonce]); continue; }
  const order = solve(w, LEGION);
  const [x, y] = [LEGION.indexOf('Legion'), LEGION.lastIndexOf('Legion')];
  [order[x], order[y]] = [order[y], order[x]];
  ui('reading', [w.nonce, JSON.stringify(order)]);
  swapped = last().resultKind === 'win';
}
check('swapping two cards of the same word still wins', swapped === true, swapped);

// ---- tiers and provinces ----
props.set(READER + '|private.mastery', { order: ['scholar'], skills: { scholar: { rank: 4 } } });
let masterOk = true;
for (let i = 0; i < 40; i++) { wallClock += 3 * 60000; w = open(SKYRIM_BOOK); ui('readingCancel', [w.nonce]); if (w.words.length < 9 || w.words.length > 12) masterOk = false; }
check('a Master gets 9 to 12 words', masterOk);
const src2 = section;
// Tamriel at large may be read from a book of either province
const cyrLines = eval(src2.match(/const READ_LINES_CYRODIIL = (\[[\s\S]*?\r?\n\]);/)[1])
  .concat(eval(src2.match(/const READ_LINES_TAMRIEL = (\[[\s\S]*?\r?\n\]);/)[1]));
let cyrOk = true;
for (let i = 0; i < 40; i++) {
  wallClock += 3 * 60000; w = open(CYRODIIL_BOOK); ui('readingCancel', [w.nonce]);
  const key = w.words.slice().sort().join(' ');
  if (!cyrLines.some((l) => l.split(' ').sort().join(' ') === key)) cyrOk = false;
}
check('a Cyrodiil book reads a Cyrodiil line or one of Tamriel at large', cyrOk);

// ---- a stale round expires ----
props.set(READER + '|private.mastery', { order: ['scholar'], skills: { scholar: { rank: 0 } } });
wallClock += 3 * 60000;
w = open(SKYRIM_BOOK);
const count = out.widgets.length;
globalThis.__dboReadBook(SKYRIM_BOOK, READER);
check('a live round blocks a second one', out.widgets.length === count);
wallClock += w.endsInMs + 15000;
globalThis.__dboReadBook(SKYRIM_BOOK, READER);
check('an abandoned round expires and the book opens again', out.widgets.length === count + 1 && last().nonce !== w.nonce);

// ---- cancelling a round takes the lost round's cooldown (loot review, 2026-09-29): no cancelling for an easy line ----
{
  wallClock += 31 * 60000;
  const r = open(SKYRIM_BOOK);
  check('a round opens', !!r && !!r.nonce);
  ui('readingCancel', [r.nonce]);
  out.widgets.length = 0; out.personals.length = 0;
  globalThis.__dboReadBook(SKYRIM_BOOK, READER);
  check('after a cancel the same book will not open at once', out.widgets.length === 0 && out.personals.some((t) => /not long ago/.test(t)), out.personals);
  wallClock += 3 * 60000;
  globalThis.__dboReadBook(SKYRIM_BOOK, READER);
  check('...but does after the lost round\'s cooldown', out.widgets.length === 1);
}
// ---- F2 hides the interface (close with args ['hidden']): not walking away, no cooldown (Worker E, 2026-09-29) ----
{
  wallClock += 31 * 60000;
  const r = open(SKYRIM_BOOK);
  ui('close', ['hidden']);
  out.widgets.length = 0;
  globalThis.__dboReadBook(SKYRIM_BOOK, READER);
  check('hiding the interface mid-round costs no cooldown: the book opens again at once', out.widgets.length === 1 && last().nonce !== r.nonce);
  ui('close', ['escape']);
  out.widgets.length = 0; out.personals.length = 0;
  globalThis.__dboReadBook(SKYRIM_BOOK, READER);
  check('closing it with Escape still takes the cooldown', out.widgets.length === 0 && out.personals.some((t) => /not long ago/.test(t)));
}
// ---- copies (loot review, 2026-09-29): never a spell tome or skill book, at most bookDailyCap a day ----
{
  const realRandom = Math.random; Math.random = () => 0; // the same line and order each time, and every find succeeds
  const readThrough = (book) => {
    wallClock += 31 * 60000; let r = open(book);
    wallClock += r.endsInMs + 3000; ui('reading', [r.nonce, '[]']);
    const answer = last().answer.split(' ');
    wallClock += 31 * 60000; r = open(book); wallClock += 1000;
    ui('reading', [r.nonce, JSON.stringify(solve(r, answer))]);
    return last();
  };
  props.set(READER + '|private.mastery', { order: ['scholar'], skills: { scholar: { rank: 0 } } });
  props.delete(READER + '|private.scholarCopies');
  out.given.length = 0;
  const t = readThrough(TOME_BOOK);
  check('a spell tome read through is won', t.resultKind === 'win', t.result);
  check('...but never copied (the Synod sells tomes one a week)', !out.given.includes(0x9cd51), out.given);
  readThrough(SKILL_BOOK);
  check('a skill book is never copied', !out.given.includes(0x1afe3), out.given);
  for (let i = 0; i < 9; i++) readThrough(SKYRIM_BOOK);
  const copies = out.given.filter((id) => id === 0xf).length;
  check('an ordinary book is copied at most 6 times a day', copies === 6, copies);
  const capLines = out.personals.filter((x) => /you can today; more wait for the new day/.test(x));
  check('a reader who reached the day\'s caps is told, each cap once', capLines.length >= 1 && ['books copied', 'scrolls', 'spell tomes'].every((k) => capLines.filter((x) => x.includes(k)).length === 1), capLines);
  check('...in the round\'s result text too', out.results.some((x) => /You read it through\..* you can today/.test(x)), out.results.slice(-1));
  const before = capLines.length;
  readThrough(SKYRIM_BOOK);
  check('...and not again that day', out.personals.filter((x) => /you can today; more wait/.test(x)).length === before);
  check('the audit line stays as it was (the note is not a find)', !out.audits.some((x) => /you can today/.test(x)));
  props.set(READER + '|private.scholarCopies', { day: '2000-01-01', n: 6 }); // yesterday's six
  readThrough(SKYRIM_BOOK);
  check('...and again the next day', out.given.filter((id) => id === 0xf).length === 7);
  props.delete(READER + '|private.scholarCapTold');
  Math.random = realRandom;
}
// ---- client-judged candle (Jake, 2026-09-30): the widget's own clock decides in time; no check lag can fail ----
READ.clientJudged = true;
console.log('client-judged:');
{
  props.set(READER + '|private.mastery', { order: ['scholar'], skills: { scholar: { rank: 0 } } });
  const realRandom = Math.random; Math.random = () => 0;
  wallClock += 31 * 60000; let r = open(SKYRIM_BOOK);
  wallClock += r.endsInMs + 60000; ui('reading', [r.nonce, '[]']);
  const answer = last().answer.split(' ');
  const t = (o) => JSON.stringify(Object.assign({ v: 2, elapsedMs: 9000, pausedMs: 0, leftMs: 40000, attempts: 0, guttered: false }, o));
  const fresh = () => { wallClock += 31 * 60000; return open(SKYRIM_BOOK); };
  check('the round tells the widget it keeps the candle', r.judge === 'client' && r.candleMs === r.seconds * 1000 && r.penaltyMs === 8000, r);
  r = fresh(); wallClock += r.endsInMs + 20000;
  ui('reading', [r.nonce, JSON.stringify(solve(r, answer)), t({ elapsedMs: (r.seconds * 1000) - 2000, leftMs: 2000 })]);
  check('a right reading 20 s past the server deadline wins on the widget clock', last().resultKind === 'win', last().result);
  r = fresh(); wallClock += 30000;
  ui('reading', [r.nonce, JSON.stringify(solve(r, answer)), t({ elapsedMs: (r.seconds * 1000), leftMs: 0, guttered: true })]);
  check('a widget that says its candle guttered loses, whatever the server clock says', last().resultKind === 'lose');
  r = fresh(); wallClock += 30000;
  ui('reading', [r.nonce, JSON.stringify(solve(r, answer)), t({ elapsedMs: 300 })]);
  check('a right reading faster than a person can place the words is refused', last().resultKind === 'lose');
  r = fresh(); wallClock += 300;
  ui('reading', [r.nonce, JSON.stringify(solve(r, answer)), t({ elapsedMs: 9000 })]);
  check('...and so is one the server got sooner than that, whatever the widget claims', last().resultKind === 'lose');
  r = fresh(); wallClock += 10000;
  ui('reading', [r.nonce, JSON.stringify(solve(r, answer)), t({ elapsedMs: (r.seconds * 1000) + 5000, leftMs: 1000 })]);
  check('a report whose own sums say the candle was out is refused', last().resultKind === 'lose');
  // a wrong reading: the widget's leftMs decides whether the penalty ends it, not when it arrived
  r = fresh(); wallClock += r.endsInMs + 5000;
  const wrong = solve(r, answer); [wrong[0], wrong[wrong.length - 1]] = [wrong[wrong.length - 1], wrong[0]];
  ui('reading', [r.nonce, JSON.stringify(wrong), t({ elapsedMs: 20000, leftMs: 8300 })]);
  check('a wrong reading with 8.3 s on the widget candle goes on, though the server deadline is past', !last().result && last().attempt === 1, last());
  const shown = out.widgets.length;
  ui('reading', [r.nonce, JSON.stringify(wrong), t({ elapsedMs: 20010, leftMs: 8290 })]);
  check('...a second send of that same reading is dropped, not judged again', out.widgets.length === shown);
  ui('reading', [r.nonce, JSON.stringify(solve(r, answer)), t({ elapsedMs: 21000, leftMs: 200, attempts: 1 })]);
  check('...and the right reading after it wins', last().resultKind === 'win');
  r = fresh(); wallClock += 5000;
  ui('reading', [r.nonce, JSON.stringify(wrong), t({ elapsedMs: 20000, leftMs: 7900 })]);
  check('a wrong reading with less than the penalty left on the widget candle ends the round', last().resultKind === 'lose');
  r = fresh(); wallClock += 5000;
  ui('reading', [r.nonce, JSON.stringify(solve(r, answer)), t({ attempts: 3 })]);
  check('a report that miscounts the wrong readings is refused', last().resultKind === 'lose');
  // the old widget (no timings): its own candle stops it, so the server deadline is only a loose bound
  r = fresh(); wallClock += r.endsInMs + 3000 + 6000;
  ui('reading', [r.nonce, JSON.stringify(solve(r, answer))]);
  check('an old widget whose right reading lands 9 s past the deadline wins', last().resultKind === 'win');
  r = fresh(); wallClock += r.endsInMs + 31000;
  ui('reading', [r.nonce, JSON.stringify(solve(r, answer))]);
  check('...but not 31 s past it', last().resultKind === 'lose');
  r = fresh(); wallClock += r.endsInMs - 8000 - 300 + 600;
  ui('reading', [r.nonce, JSON.stringify(wrong)]);
  check('an old widget\'s wrong reading near the 8 s mark goes on, with a moment to read the verdict', !last().result && last().endsInMs >= 1000, last());
  ui('readingCancel', [r.nonce]);
  r = fresh(); wallClock += r.endsInMs - 3000;
  ui('reading', [r.nonce, JSON.stringify(wrong)]);
  check('...but one with 3 s left still ends the round, as the rule says', last().resultKind === 'lose');
  // rollback: clientJudged false judges by the server deadline again, timings or not
  READ.clientJudged = false;
  r = fresh(); check('with clientJudged off the widget is not told to keep the candle', r.judge === undefined);
  wallClock += r.endsInMs + 3000;
  ui('reading', [r.nonce, JSON.stringify(solve(r, answer)), t({ elapsedMs: (r.seconds * 1000) - 2000, leftMs: 2000 })]);
  check('...and a right reading past deadline + graceMs loses as before', last().resultKind === 'lose');
  READ.clientJudged = true;
  // an abandoned round is swept with the lost round's cooldown
  r = fresh(); wallClock += (r.seconds * 1000) + 6 * 60000;
  (everyFns.get('readingSweep') || (() => {}))();
  out.widgets.length = 0; out.personals.length = 0;
  globalThis.__dboReadBook(SKYRIM_BOOK, READER);
  check('a round nobody answered is swept and takes the lost round\'s cooldown', out.widgets.length === 0 && out.personals.some((x) => /not long ago/.test(x)), out.personals);
  Math.random = realRandom;
  ui('readingCancel', []);
  for (const k of ['scholarCopies', 'scholarScrolls', 'scholarTomes', 'scholarReads']) props.delete(READER + '|private.' + k);
}
// ---- the task's cases (client-judged), over a fake network (tests/lib/netsim.js) ----
{
  const NET = require(path.join(__dirname, 'lib', 'netsim.js'));
  props.set(READER + '|private.mastery', { order: ['scholar'], skills: { scholar: { rank: 0 } } });
  const realRandom = Math.random; Math.random = () => 0; // the same line and order each time
  for (const k of ['scholarCopies', 'scholarScrolls', 'scholarTomes', 'scholarReads']) props.delete(READER + '|private.' + k);
  let r = (() => { wallClock += 31 * 60000; return open(SKYRIM_BOOK); })();
  wallClock += r.endsInMs + 60000; ui('reading', [r.nonce, '[]']);
  const answer = last().answer.split(' ');
  const t = (o) => JSON.stringify(Object.assign({ v: 2, elapsedMs: 9000, pausedMs: 0, leftMs: 40000, attempts: 0, guttered: false }, o));
  const fresh = () => { wallClock += 31 * 60000; return open(SKYRIM_BOOK); };
  const kindOf = () => last().resultKind || (last().feedback ? 'wrong' : '?');
  const judgeOf = () => (/ judge=(\w+)/.exec(out.logs[out.logs.length - 1] || '') || [])[1] || '?';
  // A right reading that took el ms on the reader's own clock, and a wrong one, at each required level
  for (const rtt of NET.REQUIRED) {
    r = fresh(); const el = 12000;
    wallClock += rtt + el;
    ui('reading', [r.nonce, JSON.stringify(solve(r, answer)), t({ elapsedMs: el, leftMs: r.seconds * 1000 - el })]);
    check(`the new widget's right reading wins at ${rtt} ms`, last().resultKind === 'win' && judgeOf() === 'client', out.logs[out.logs.length - 1]);
    r = fresh();
    const wrong = solve(r, answer); [wrong[0], wrong[wrong.length - 1]] = [wrong[wrong.length - 1], wrong[0]];
    wallClock += rtt + el;
    ui('reading', [r.nonce, JSON.stringify(wrong), t({ elapsedMs: el, leftMs: r.seconds * 1000 - el })]);
    check(`...and a wrong one goes on at ${rtt} ms, costing candle not the round`, !last().result && last().attempt === 1, last());
    ui('readingCancel', [r.nonce]);
  }
  // Every network condition, honest readers: right ones win, a candle that guttered on the reader's own clock loses
  {
    const rand = NET.rngOf(9); let changed = 0, n = 0; const seen = [];
    for (const c of NET.matrix()) {
      for (const guttered of [false, true]) {
        r = fresh();
        const el = guttered ? r.seconds * 1000 : 6000 + Math.floor(rand() * 20000);
        const tr = NET.trip(c, rand);
        wallClock += tr.down + Math.round(el * c.rate) + tr.up + c.stall;
        ui('reading', [r.nonce, JSON.stringify(solve(r, answer)), t({ elapsedMs: el, leftMs: r.seconds * 1000 - el, guttered })]);
        n++;
        if (last().resultKind !== (guttered ? 'lose' : 'win')) { changed++; if (seen.length < 3) seen.push(`${c.name}: ${out.logs[out.logs.length - 1]}`); }
      }
    }
    check(`no honest verdict changes under ${NET.matrix().length} network conditions`, changed === 0, `${n} readings${seen.length ? ' | ' + seen.join(' | ') : ''}`);
  }
  // The old widget (no timings) at high latency: judged by the server's deadline relaxed to 30 s
  for (const late of [2500, 12000, 29000]) {
    r = fresh(); wallClock += r.endsInMs + late;
    ui('reading', [r.nonce, JSON.stringify(solve(r, answer))]);
    check(`an old widget's right reading ${late / 1000} s past the deadline wins`, last().resultKind === 'win' && judgeOf() === 'legacy', out.logs[out.logs.length - 1]);
  }
  // Duplicate and foreign nonces
  r = fresh(); wallClock += 9000;
  ui('reading', [r.nonce, JSON.stringify(solve(r, answer)), t({})]);
  const shown = out.widgets.length, readsAfter = JSON.stringify(props.get(READER + '|private.scholarReads'));
  out.logs.length = 0; wallClock += 6000;
  ui('reading', [r.nonce, JSON.stringify(solve(r, answer)), t({})]);
  check('a second report of a round already judged is ignored: nothing paid, no cooldown moved', out.widgets.length === shown && JSON.stringify(props.get(READER + '|private.scholarReads')) === readsAfter && out.events.filter((e) => e === 'read').length >= 1 && /reading ignored .*no round/.test(out.logs.join(' | ')), out.logs);
  r = fresh(); wallClock += 9000; out.logs.length = 0; wallClock += 6000;
  ui('reading', ['14-forged', JSON.stringify(solve(r, answer)), t({})]);
  check('a report on a nonce this reader was never issued is ignored', !last().result && /reading ignored .*another round is live/.test(out.logs.join(' | ')), out.logs);
  ui('reading', [r.nonce, JSON.stringify(solve(r, answer)), t({})]);
  check('...and the round is still there for its reader', last().resultKind === 'win');
  // Impossible durations
  r = fresh(); wallClock += 9000;
  ui('reading', [r.nonce, JSON.stringify(solve(r, answer)), t({ elapsedMs: 100 })]);
  check('a right reading the widget says took 100 ms is refused(fast)', last().resultKind === 'lose' && /refused\(fast\)/.test(out.logs[out.logs.length - 1]), out.logs[out.logs.length - 1]);
  r = fresh(); wallClock += 200;
  ui('reading', [r.nonce, JSON.stringify(solve(r, answer)), t({ elapsedMs: 9000 })]);
  check('...and one the server got 200 ms after it sent the round, whatever the widget claims', last().resultKind === 'lose' && /refused\(fast\)/.test(out.logs[out.logs.length - 1]), out.logs[out.logs.length - 1]);
  // Cooldowns and caps unchanged: 30 min per book after a win, 2 min after a loss, at most 6 copies a day
  r = fresh(); wallClock += 9000;
  ui('reading', [r.nonce, JSON.stringify(solve(r, answer)), t({})]);
  const winRest = Number((props.get(READER + '|private.scholarReads') || {})[SKYRIM_BOOK.toString(16)]) - wallClock;
  check('a client-judged win rests the book for 30 minutes', last().resultKind === 'win' && Math.abs(winRest - 30 * 60000) < 1000, winRest);
  out.widgets.length = 0; globalThis.__dboReadBook(SKYRIM_BOOK, READER);
  check('...so it will not open again at once', out.widgets.length === 0);
  r = fresh(); wallClock += 9000;
  ui('reading', [r.nonce, JSON.stringify(solve(r, answer)), t({ elapsedMs: r.seconds * 1000, leftMs: 0, guttered: true })]);
  const loseRest = Number((props.get(READER + '|private.scholarReads') || {})[SKYRIM_BOOK.toString(16)]) - wallClock;
  check('a client-judged loss rests it for 2 minutes', last().resultKind === 'lose' && Math.abs(loseRest - 2 * 60000) < 1000, loseRest);
  props.delete(READER + '|private.scholarCopies');
  out.given.length = 0;
  for (let i = 0; i < 9; i++) { r = fresh(); wallClock += 9000; ui('reading', [r.nonce, JSON.stringify(solve(r, answer)), t({})]); }
  check('an ordinary book is still copied at most 6 times a day', out.given.filter((id) => id === 0xf).length === 6, out.given.filter((id) => id === 0xf).length);
  // Reshow: a book touched while a round is open draws that round again (the window was lost), within its life
  r = fresh(); wallClock += 5000; out.widgets.length = 0;
  globalThis.__dboReadBook(SKYRIM_BOOK, READER);
  check('touching a book while a round is open draws the same round again', out.widgets.length === 1 && last().nonce === r.nonce, out.widgets.length);
  ui('readingCancel', [r.nonce]);
  Math.random = realRandom;
  for (const k of ['scholarCopies', 'scholarScrolls', 'scholarTomes', 'scholarReads']) props.delete(READER + '|private.' + k);
}
console.log(`\n${checks - failures}/${checks} passed`);
process.exit(failures ? 1 : 0);
