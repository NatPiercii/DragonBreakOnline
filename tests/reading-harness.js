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
const SKYRIM_BOOK = 0x5001, CYRODIIL_BOOK = 0x5002;
const props = new Map([
  [SKYRIM_BOOK + '|baseDesc', 'f:Skyrim.esm'],
  [CYRODIIL_BOOK + '|baseDesc', '61b52:BSHeartland.esm'],
  [READER + '|private.mastery', { order: ['scholar'], skills: { scholar: { rank: 0 } } }],
]);
const out = { widgets: [], closed: 0, personals: [], events: [], audits: [] };
const handlers = new Map();
const stubs = {
  mp: {
    get: (id, p) => props.get(id + '|' + p),
    set: (id, p, v) => props.set(id + '|' + p, v),
    getIdFromDesc: (d) => parseInt(String(d).split(':')[0], 16) >>> 0,
    lookupEspmRecordById: () => ({ record: { type: 'BOOK', editorId: 'BookTestVolume' } }),
  },
  cfg: {},
  fs, path,
  log: () => {},
  personal: (a, t) => out.personals.push(t),
  audit: (t) => out.audits.push(t),
  who: () => 'Reader',
  openWidget: (a, w, focus) => { out.widgets.push({ w, focus }); return true; },
  closeWidget: () => { out.closed++; return true; },
  onUi: (ev, fn) => { const l = handlers.get(ev) || []; l.push(fn); handlers.set(ev, l); },
  giveItem: () => true,
};
globalThis.__alduinakMasteryEvent = (kind, a) => out.events.push(kind);
// eslint-disable-next-line no-new-func
new Function(...Object.keys(stubs), section + '\nreturn null;')(...Object.values(stubs));

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
const cyrLines = eval(src2.match(/const READ_LINES_CYRODIIL = (\[[\s\S]*?\r?\n\]);/)[1]);
let cyrOk = true;
for (let i = 0; i < 40; i++) {
  wallClock += 3 * 60000; w = open(CYRODIIL_BOOK); ui('readingCancel', [w.nonce]);
  const key = w.words.slice().sort().join(' ');
  if (!cyrLines.some((l) => l.split(' ').sort().join(' ') === key)) cyrOk = false;
}
check('a Cyrodiil book reads a Cyrodiil line', cyrOk);

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

console.log(`\n${checks - failures}/${checks} passed`);
process.exit(failures ? 1 : 0);
