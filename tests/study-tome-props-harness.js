// The spell tomes DLE v10 lays beside the PriestStudy points (SpellTomeHealingHands 0A271E x8, SpellTomeFastHealing
// 0A271D x2 in Markarth; D's gate, 1 Oct) are props: gamemode.js already refuses picking up anything a plugin placed
// (blockPlacedPickup), and its reading round on a placed book never copies a spell tome (__dboReadBook, copyable). Lifts
// both out of gamemode.js and checks them on those refs, so a later change to either cannot hand the tomes out.
//   node tests/study-tome-props-harness.js   (from server/)
'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(path.resolve(__dirname, '..'), 'gamemode.js'), 'utf8');
let failures = 0;
const check = (label, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${got !== undefined && !ok ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

// DLE is 0x34 in the v10 order (refs 3416DB1A etc.); Skyrim.esm bases. BOOK DATA byte 0 0x04: teaches a spell
const tome = (edid) => ({ record: { type: 'BOOK', editorId: edid, fields: [{ type: 'DATA', data: new Uint8Array([0x04, 0, 0, 0]) }] } });
const RECS = { 0x0a271e: tome('SpellTomeHealingHands'), 0x0a271d: tome('SpellTomeFastHealing') };
const REFS = { 0x3416db1a: 0x0a271e, 0x3416daf9: 0x0a271d, 0x3416dafa: 0x0a271d };
const DROPPED = 0xff000a01; // a tome a player dropped: a dynamic ref, still theirs to take
const BASE = Object.assign({ [DROPPED]: 0x0a271e }, REFS);
const mp = { get: (id, k) => (k === 'baseDesc' && BASE[id] ? `${BASE[id].toString(16)}:Skyrim.esm` : undefined), getIdFromDesc: (d) => parseInt(String(d).split(':')[0], 16), lookupEspmRecordById: (id) => RECS[id] || null };

// ---- taking one: the pick-up block ----
const START = '// Nothing placed by a plugin can be picked up', END = "// A hold's treasury chest is paid into at a bank";
const from = src.indexOf(START), to = src.indexOf(END);
check('the pick-up block is found in gamemode.js', from > 0 && to > from);
const srcLine = (head) => { const i = src.indexOf(head); if (i < 0) throw new Error(`gamemode.js has no ${head}`); return src.slice(i, src.indexOf('\n', i)); };
const { restUntil, setRest } = new Function('mp', 'log', `${srcLine('const REST_PROP = ')}\n${srcLine('const restUntil = ')}\n${srcLine('const setRest = ')}\nreturn { restUntil, setRest };`)(mp, () => {});
globalThis.__dboHarvestReady = new Map();
const said = [];
const M = new Function('mp', 'cfg', 'personal', 'restUntil', 'setRest', src.slice(from, to) + '\nreturn { blockPlacedPickup, ITEM_TYPES };')(mp, { harvest: {} }, (a, t) => said.push(t), restUntil, setRest);
const P = 0xff000001;
for (const [ref, base] of Object.entries(REFS)) {
  check(`the ${RECS[base].record.editorId} at ${Number(ref).toString(16).toUpperCase()} cannot be picked up`, M.blockPlacedPickup(Number(ref) >>> 0, P) === true);
}
check('...and the player is told it is not theirs to take', /That is not yours to take/.test(said[0] || ''), said);
check('a spell tome a player dropped (a dynamic ref) can still be picked up', M.blockPlacedPickup(DROPPED, P) === false);

// ---- reading one: the reading round never copies a spell tome ----
const copyLine = srcLine('const copyable = ');
check('the reading round still decides copies by the BOOK flags', /\(bookData\.data\[0\] & 0x07\) === 0/.test(copyLine), copyLine);
const copyable = (rec) => { const bookData = rec.record.fields.find((f) => f && f.type === 'DATA'); return new Function('bookData', 'baseId', `${copyLine}\nreturn copyable;`)(bookData, 0); };
check('a placed Healing Hands or Fast Healing tome read through is never copied', !copyable(RECS[0x0a271e]) && !copyable(RECS[0x0a271d]));
const readStart = src.indexOf('globalThis.__dboReadBook = (targetId, casterId) => {');
check('placed refs only reach the reading round (dynamic refs go to the engine and spells.js\'s tome gate)', readStart > 0 && /if \(!READ\.enabled \|\| targetId >= 0xff000000\) return false;/.test(src.slice(readStart, readStart + 200)));

console.log(failures ? `${failures} FAILED` : 'all checks passed');
process.exit(failures ? 1 : 0);
