// The reading's tome pick (gamemode.js scholarTomePick): a tome of the rank the reading's roll chose (Nate and Swag, 17 Oct),
// no known or carried tome, the reader's own schools weighted (Nate, 10 Oct); the college rank's cap (spells.js
// __dboSpellsReadRankCap, 11 Oct): Expert and Master only for a Senior rank, and the restricted arts (__dboSpellsReadRestricted).
// Lifts the function out of gamemode.js with stubs.
//   node tests/scholar-tome-pick-harness.js   (from server/)
'use strict';
const fs = require('fs'); const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'gamemode.js'), 'utf8');
const start = src.indexOf('const scholarTomePick = '); const end = src.indexOf('const masteryOf = ', start);
let fails = 0; const ok = (l, c, g) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${l}${!c && g !== undefined ? `: got ${JSON.stringify(g)}` : ''}`); if (!c) fails++; };
ok('scholarTomePick is in gamemode.js', start > 0 && end > start);
const TOMES = [
  { id: 'Skyrim.esm:0000A1', school: 'Illusion', rank: 0 }, { id: 'Skyrim.esm:0000A2', school: 'Restoration', rank: 0 },
  { id: 'Skyrim.esm:0000A3', school: 'Destruction', rank: 1 }, { id: 'Skyrim.esm:0000A4', school: 'Alteration', rank: 2 },
  { id: 'Skyrim.esm:0000A5', school: 'Conjuration', rank: 3 }, { id: 'Skyrim.esm:0000A6', school: 'Destruction', rank: 4 },
];
const SPELL = { 0xa1: 0x1a1, 0xa2: 0x1a2, 0xa3: 0x1a3, 0xa4: 0x1a4, 0xa5: 0x1a5, 0xa6: 0x1a6 };
let inv = [], known = [], order = ['priest'], level = 0;
const mp = { get: (a, k) => (k === 'inventory' ? { entries: inv } : null), getIdFromDesc: (d) => parseInt(d.split(':')[0], 16) };
globalThis.__dboSpellsKnown = () => known.map((id) => ({ id }));
globalThis.__dboSpellsTomeSpell = (b) => SPELL[b] || 0;
// The college rank's cap: 3 (a Senior) for the Scholar-tier checks, then the gate's own cases below
let collegeCap = 3, restrictedBooks = new Set();
globalThis.__dboSpellsReadRankCap = () => collegeCap;
globalThis.__dboSpellsReadRestricted = (a, id) => restrictedBooks.has(id);
const SKILLS_DEF = { skills: [{ id: 'arcane', vanillaSkills: ['Destruction', 'Conjuration', 'Illusion'] }, { id: 'priest', vanillaSkills: ['Restoration', 'Alteration'] }] };
const make = (READ) => new Function('mp', 'READABLES', 'READ', 'SKILLS_DEF', 'masteryOf', `${src.slice(start, end)}; return scholarTomePick;`)(mp, { tomes: TOMES }, READ, SKILLS_DEF, () => ({ order, skills: { scholar: { level } } }));
const pick = make({ tomeSchoolWeight: 3 });
const draw = (rank, n = 4000) => { const c = {}; for (let i = 0; i < n; i++) { const t = pick(1, rank); const k = t ? t.id.slice(-2) : 'none'; c[k] = (c[k] || 0) + 1; } return c; };
let c = draw(0); ok('rank 0: Novice tomes only', !c.A3 && !c.A4 && !c.A5 && !c.A6 && c.A1 > 0 && c.A2 > 0, c);
c = draw(1); ok('rank 1: the Apprentice tome only', c.A3 === 4000, c);
c = draw(2); ok('rank 2: the Adept tome only', c.A4 === 4000, c);
c = draw(3); ok('rank 3: the Expert tome, for a Senior', c.A5 === 4000, c);
c = draw(4); ok('rank 4: the Master tome, for a Senior', c.A6 === 4000, c);
c = draw(0); ok('a Priest draws Restoration about 3x as often as Illusion', c.A2 > 2 * c.A1, c);
known = [0x1a2]; c = draw(0); ok('a known spell is never handed out', !c.A2 && c.A1 > 0, c);
known = []; inv = [{ baseId: 0xa1, count: 1 }]; c = draw(0); ok('a carried tome is never handed out', !c.A1 && c.A2 > 0, c);
known = [0x1a2]; inv = [{ baseId: 0xa1, count: 1 }]; ok('nothing left of the rank: null', pick(1, 0) === null);
known = []; inv = [];
// ---- the college rank gate (Nate, 11 Oct; floor Adept since 14 Oct) ----
collegeCap = 2; ok('gate: below Senior (cap Adept) no Expert tome', pick(1, 3) === null);
ok('gate: ...nor a Master tome', pick(1, 4) === null);
c = draw(2); ok('gate: ...but Adept still', c.A4 === 4000, c);
collegeCap = 0; ok('gate: a cap of Novice gives no Apprentice tome', pick(1, 1) === null && draw(0).A1 > 0);
collegeCap = 1; delete globalThis.__dboSpellsReadRankCap; ok('gate: without spells.js the cap is Apprentice', pick(1, 2) === null && draw(1).A3 === 4000);
globalThis.__dboSpellsReadRankCap = () => collegeCap;
collegeCap = 3; restrictedBooks = new Set([0xa2]); c = draw(0); ok('gate: a restricted art (for one below Senior) is passed over', !c.A2 && c.A1 > 0, c);
restrictedBooks = new Set([0xa1, 0xa2]); ok('gate: nothing allowed left: null', pick(1, 0) === null);
restrictedBooks = new Set();
console.log(fails ? `${fails} FAILED` : 'all checks passed'); process.exit(fails ? 1 : 0);
