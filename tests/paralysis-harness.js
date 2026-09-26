// Scripted test for the paralysis branch of onSpellHit in gamemode.js (review GP-1, GP-4, GP-8). The branch lives
// inline in the gamemode, so this cuts it out (from "// Runes (Ash Rune)" to "// Equipment trace") and runs it
// against fake records: a paralysis scroll holds a player once and is not sent again while the hold runs; a dead,
// ethereal or self target and a caster with bound hands are refused, as ApplyParalysis refuses them; a spell the C++
// holds on the server blocks a scroll's hold meanwhile; a scroll that also harms health still holds on the client; a
// rune's paralysis comes from its explosion; the holds survive a hot reload. Run it from this folder's parent with
//
//   node tests\paralysis-harness.js
'use strict';
const fs = require('fs');
const path = require('path');

const SERVER = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(SERVER, 'gamemode.js'), 'utf8');
const start = src.indexOf('// Runes (Ash Rune) carry their paralysis');
const end = src.indexOf('// Equipment trace:');
if (start < 0 || end < 0 || end < start) { console.log('FAIL the paralysis section markers are gone from gamemode.js'); process.exit(1); }
const section = src.slice(start, end);

let now = 1790000000000;
Date.now = () => now;

// Fake records. Field bytes are little endian, as in the plugins; toGlobalRecordId is the identity here.
const bytes = (size, writes) => {
  const b = new Uint8Array(size); const v = new DataView(b.buffer);
  for (const [off, val] of writes) v.setUint32(off, val >>> 0, true);
  return b;
};
const records = new Map();
const add = (id, type, editorId, fields) => records.set(id, { record: { type, editorId, fields }, toGlobalRecordId: (x) => x });
const MGEF_PARALYSIS = 0x100, MGEF_DAMAGE = 0x101, MGEF_RUNE = 0x102, EXPL_RUNE = 0x103, ENCH_RUNE = 0x104;
add(MGEF_PARALYSIS, 'MGEF', 'AlchParalysis', [{ type: 'DATA', data: bytes(0x98, [[0, 0x1], [0x40, 21], [0x44, 0xffffffff]]) }]);
add(MGEF_DAMAGE, 'MGEF', 'DamageHealth', [{ type: 'DATA', data: bytes(0x98, [[0, 0x5], [0x40, 0], [0x44, 24]]) }]);
add(MGEF_RUNE, 'MGEF', 'RuneEffect', [{ type: 'DATA', data: bytes(0x98, [[0, 0], [0x40, 0], [0x44, 0xffffffff], [0x4c, EXPL_RUNE]]) }]);
add(EXPL_RUNE, 'EXPL', 'RuneExplosion', [{ type: 'EITM', data: bytes(4, [[0, ENCH_RUNE]]) }]);
add(ENCH_RUNE, 'ENCH', 'RuneEnchantment', [{ type: 'EFID', data: bytes(4, [[0, MGEF_PARALYSIS]]) }, { type: 'EFIT', data: bytes(12, [[8, 5]]) }]);
const effect = (mgef, seconds) => [{ type: 'EFID', data: bytes(4, [[0, mgef]]) }, { type: 'EFIT', data: bytes(12, [[8, seconds]]) }];
const SCROLL = 0x200, HARM_SCROLL = 0x201, PARALYZE = 0x202, RUNE = 0x203, FIREBOLT = 0x204;
add(SCROLL, 'SCRL', 'ScrollParalyze', effect(MGEF_PARALYSIS, 10));
add(HARM_SCROLL, 'SCRL', 'ScrollHarmParalyze', [...effect(MGEF_PARALYSIS, 6), ...effect(MGEF_DAMAGE, 1)]);
add(PARALYZE, 'SPEL', 'Paralyze', effect(MGEF_PARALYSIS, 10));
add(RUNE, 'SPEL', 'AshRune', effect(MGEF_RUNE, 0));
add(FIREBOLT, 'SPEL', 'Firebolt', effect(MGEF_DAMAGE, 1));

const CASTER = 0x14, VICTIM = 0x15, OTHER = 0x16, NPC = 0xff000123;
const props = new Map();
const sent = [];
const staggers = [];
const mp = {
  get: (id, p) => props.get(id + '|' + p),
  lookupEspmRecordById: (id) => records.get(id >>> 0) || null,
};
const recordOf = (id) => { try { const r = mp.lookupEspmRecordById(id >>> 0); return r && r.record ? r : null; } catch (e) { return null; } };
const stubs = {
  mp, recordOf,
  sendPacket: (to, packet) => { sent.push({ to, ...packet }); return true; },
  log: () => {}, display: (a) => `P${a.toString(16)}`,
  profileOf: (a) => (a === NPC ? -1 : 1),
  combat: { onSpellHit: (a, t, s) => staggers.push({ a, t, s }) },
};
const load = () => {
  mp.onSpellHit = undefined;
  new Function(...Object.keys(stubs), section)(...Object.values(stubs));
  return mp.onSpellHit;
};

let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail !== undefined ? '   ' + detail : ''}`); if (!ok) failures++; };
const hit = (spell, agg = CASTER, tgt = VICTIM) => { sent.length = 0; mp.onSpellHit(agg, tgt, spell); return sent.filter((p) => p.customPacketType === 'dboParalyse'); };
const reset = () => { globalThis.__dboParalysedUntil && globalThis.__dboParalysedUntil.clear(); props.clear(); now += 60000; };

load();

// A paralysis scroll holds a player once for its duration
let got = hit(SCROLL);
check('a paralysis scroll sends one hold to the victim', got.length === 1 && got[0].to === VICTIM && got[0].seconds === 10, JSON.stringify(got));
now += 2000;
check('a second scroll hit while held sends nothing', hit(SCROLL).length === 0);
now += 8001;
check('after the hold ends a new hit holds again', hit(SCROLL).length === 1);
check('every hit still reaches the stagger rules', staggers.length === 3 && staggers.every((s) => s.s === SCROLL));

// The refusals ApplyParalysis makes
reset();
props.set(VICTIM + '|isDead', true);
check('a dead (or downed) player is not held', hit(SCROLL).length === 0);
props.set(VICTIM + '|isDead', false);
check('and a refused hit records no hold: the next live hit holds', hit(SCROLL).length === 1);
reset();
check('the caster is never held by its own scroll', hit(SCROLL, CASTER, CASTER).length === 0);
globalThis.__dboBeastEthereal = (a) => a === VICTIM;
check('an ethereal beast form is not held', hit(SCROLL).length === 0);
delete globalThis.__dboBeastEthereal;
props.set(CASTER + '|private.restrained', { boundHands: true });
check('a caster with bound hands holds nobody', hit(SCROLL).length === 0);
props.delete(CASTER + '|private.restrained');
check('holds are per target', hit(SCROLL).length === 1 && hit(SCROLL, CASTER, OTHER).length === 1);

// A spell the C++ holds on the server (Paralyze): no packet, but a scroll cannot hold on top of it
reset();
check('a paralysis spell sends no packet (the C++ replays it)', hit(PARALYZE).length === 0);
now += 5000;
check('a scroll during the server-held paralysis is refused, as the C++ refuses it', hit(SCROLL).length === 0);
now += 5001;
check('after it ends the scroll holds', hit(SCROLL).length === 1);

// A scroll that also harms health: the C++ does not hold it, the client still does
reset();
got = hit(HARM_SCROLL);
check('a scroll that harms health still holds on the client', got.length === 1 && got[0].seconds === 6, JSON.stringify(got));

// A rune: the paralysis is on its explosion's enchantment
reset();
got = hit(RUNE);
check("a rune holds for its explosion's paralysis", got.length === 1 && got[0].seconds === 5, JSON.stringify(got));
check('a spell without paralysis holds nobody', hit(FIREBOLT, CASTER, OTHER).length === 0);

// NPC targets: no packet (their host's engine applies it), but the hold is still tracked
reset();
check('an NPC is sent nothing', hit(SCROLL, CASTER, NPC).length === 0);
check('and is tracked as held', ((globalThis.__dboParalysedUntil && globalThis.__dboParalysedUntil.get(NPC)) || 0) > now);

// A hot reload keeps the holds, like the C++ map
reset();
hit(SCROLL);
load();
now += 1000;
check('after a hot reload a held player is still refused', hit(SCROLL).length === 0);
check('the reload wraps the same chain once', typeof mp.onSpellHit === 'function' && mp.onSpellHit.__dbo === true);

// GP-4: the Force Rune scroll staggers like the spell
const cfg = JSON.parse(fs.readFileSync(path.join(SERVER, 'gamemode-config.json'), 'utf8'));
const stagger = ((cfg.combat || {}).staggerSpells) || [];
check('combat.staggerSpells lists the Force Rune spell and its scroll', stagger.includes('CYRForceRune') && stagger.includes('CYRForceRuneScroll'), JSON.stringify(stagger));

console.log(failures ? `${failures} failure(s)` : 'all passed');
process.exit(failures ? 1 : 0);
