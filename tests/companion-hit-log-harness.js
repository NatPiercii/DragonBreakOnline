// gamemode.js's companion hit log (#mod-0075, 6 Oct: a Conjure Familiar's bites "do 0 damage"): one line per summon or
// raised corpse hit, at most one a second per companion, with the engine's damage, a refusal by the gameplay, and the
// target's health before and after (onHitDamage). Slices the log out of gamemode.js and drives it with a fake hook.
//   node tests/companion-hit-log-harness.js   (from server/)
'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.resolve(__dirname, '..', 'gamemode.js'), 'utf8');
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got)}`); if (!c) fails++; };
const a = src.indexOf('const companionHitNotes = '), b = src.indexOf('mp.onHitDamageAttempt = hitDamageAttemptLogged;', a);
if (a < 0 || b < 0) { console.log('FAIL the companion hit log is not in gamemode.js'); process.exit(1); }
ok(/try \{ if \(globalThis\.__dboCompanionHitLanded\) globalThis\.__dboCompanionHitLanded\(agg, tgt\); \}/.test(src), 'onHitDamage reports the landed hit');

const OWNER = 0xff000010, FAM = 0xff000500, WOLF = 0xff000600, PLAYER2 = 0xff000020, NPC = 0xff000700;
const props = new Map([[FAM + '|ff_companionOf', OWNER], [FAM + '|baseDesc', '640b5:Skyrim.esm'], [WOLF + '|percentages', { health: 0.8 }]]);
const mp = { get: (id, k) => props.get(id + '|' + k), onHitDamageAttempt: null };
const lines = [];
let now = 1000, verdict = true;
const RealNow = Date.now; Date.now = () => now;
const G = {};
const run = new Function('mp', 'log', 'display', 'profileOf', 'cfg', 'globalThis', 'hitDamageAttemptHook',
  `${src.slice(a, b)}\nmp.onHitDamageAttempt = hitDamageAttemptLogged;`);
run(mp, (t) => lines.push(t), (x) => `A${x.toString(16)}`, (x) => (x === OWNER || x === PLAYER2 ? 1 : -1), {}, G, () => verdict);
const hit = (agg, tgt, dmg, landTo) => {
  const v = mp.onHitDamageAttempt(agg, tgt, 0x1f4, dmg, {});
  if (v !== false && landTo !== undefined) { props.set(tgt + '|percentages', { health: landTo }); G.__dboCompanionHitLanded(agg, tgt); }
  return v;
};
ok(hit(FAM, WOLF, 4.5, 0.7) === true, 'the verdict of the real hook is passed through');
ok(lines.length === 1 && /companion hit Aff000010's 640b5:Skyrim\.esm -> Aff000600: source 1f4 engine 4\.5 landed health 80\.0% -> 70\.0%/.test(lines[0]), 'a landed bite: engine damage and health before and after', lines);
now += 300; hit(FAM, WOLF, 4.5, 0.6); hit(FAM, WOLF, 4.5, 0.5);
ok(lines.length === 1, 'at most one line a second per companion');
now += 1000; hit(FAM, WOLF, 0, 0.5);
ok(lines.length === 2 && /engine 0\.0 landed health 50\.0% -> 50\.0% \(\+2 more hits since the last line\)/.test(lines[1]), 'a zero-damage bite shows as engine 0.0, with the hits held back counted', lines[1]);
now += 1500; verdict = false;
ok(hit(FAM, PLAYER2, 6) === false && /-> Aff000020 \(player\): source 1f4 engine 6\.0 REFUSED by the gameplay/.test(lines[2] || ''), 'a refused bite on a player says so', lines[2]);
verdict = true; now += 1500;
hit(NPC, WOLF, 9, 0.4); hit(OWNER, WOLF, 9, 0.3);
ok(lines.length === 3, 'an ordinary NPC\'s or a player\'s own hit is not logged');
run(mp, (t) => lines.push(t), (x) => `A${x.toString(16)}`, (x) => (x === OWNER ? 1 : -1), { companionHitLog: false }, G, () => true);
now += 1500; hit(FAM, WOLF, 4.5, 0.2);
ok(lines.length === 3, 'companionHitLog false turns it off');
Date.now = RealNow;
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
