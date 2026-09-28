// The Scholar game's lines (gamemode.js READ_LINES, READ_LINES_CYRODIIL, READ_LINES_TAMRIEL): every one splits into
// cards cleanly (single spaces, no commas or full stops that would ride on a card), none repeats, and every Scholar
// tier finds plenty of lines of its length in each province, Tamriel at large counted in (Nate, 2026-09-28: more lines).
//   node tests/reading-lines-harness.js
'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.resolve(__dirname, '..', 'gamemode.js'), 'utf8');
let fails = 0;
const ok = (c, what) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}`); if (!c) fails++; };
const grab = (name) => eval(src.match(new RegExp(`const ${name} = (\\[[\\s\\S]*?\\r?\\n\\]);`))[1]);
const lists = { skyrim: grab('READ_LINES'), cyrodiil: grab('READ_LINES_CYRODIIL'), tamriel: grab('READ_LINES_TAMRIEL') };
const bands = eval(src.match(/wordsByTier: (\[\[[\d, [\]]*\]\])/)[1]);
const all = [].concat(...Object.values(lists));
const bad = all.filter((l) => typeof l !== 'string' || l !== l.trim() || / {2}/.test(l) || /[^A-Za-z' -]/.test(l));
ok(bad.length === 0, `every line is words, spaces, apostrophes and hyphens only${bad.length ? ': ' + bad.join(' | ') : ''}`);
const seen = new Set(); const dup = all.filter((l) => { const k = l.toLowerCase(); if (seen.has(k)) return true; seen.add(k); return false; });
ok(dup.length === 0, `no line appears twice${dup.length ? ': ' + dup.join(' | ') : ''}`);
const long = all.filter((l) => { const n = l.split(' ').length; return n < bands[0][0] || n > bands[bands.length - 1][1]; });
ok(long.length === 0, `every line fits some tier (${bands[0][0]} to ${bands[bands.length - 1][1]} words)${long.length ? ': ' + long.join(' | ') : ''}`);
for (const prov of ['skyrim', 'cyrodiil']) {
  const pool = lists[prov].concat(lists.tamriel);
  const counts = bands.map((b) => pool.filter((l) => { const n = l.split(' ').length; return n >= b[0] && n <= b[1]; }).length);
  ok(counts.every((c) => c >= 20), `a ${prov} book has at least 20 lines at every tier: ${counts.join(' / ')}`);
}
ok(lists.tamriel.length >= 30, `${lists.tamriel.length} lines of Tamriel at large`);
console.log(fails ? `${fails} failure(s)` : 'all checks passed');
process.exit(fails ? 1 : 0);
