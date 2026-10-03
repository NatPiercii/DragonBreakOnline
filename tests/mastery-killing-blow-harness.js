// Archery and every other hit skill (fork masterySystem.ts, #bugs 3 Oct "Archery not leveling"): the blow that kills counts
// as a hit, because whether the target lived is read in onHitDamageAttempt, before the damage lands. A blow to a body that
// was already dead is neither a hit nor a kill. Without an attempt reading (another hook took the event) the old rule holds.
//   node tests/mastery-killing-blow-harness.js <bundled masterySystem.js>
'use strict';
const path = require('path');
const bundle = process.argv[2];
if (!bundle) { console.error('usage: node tests/mastery-killing-blow-harness.js <bundled masterySystem.js>'); process.exit(2); }
const { MasterySystem } = require(path.resolve(bundle));
let fails = 0;
const ok = (label, cond, got) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!cond) fails++; };

const P = 0xff000010, WOLF = 0xff000020, BOW = 0x139a5;
const dead = new Set();
const mp = { get: (id, k) => (k === 'isDead' ? dead.has(id >>> 0) : undefined) };
const ctx = { svr: mp };
const sys = new MasterySystem(() => {});
if (typeof sys.hookNativeEvents !== 'function' || !(sys.aliveAtAttempt instanceof Map)) { console.log('skipped: this masterySystem has no attempt reading'); process.exit(0); }
const inner = [];
mp.onHitDamageAttempt = (...a) => { inner.push(['attempt', ...a]); return undefined; };
mp.onHitDamage = (...a) => { inner.push(['hit', ...a]); return undefined; };
sys.hookNativeEvents(ctx);
const swing = (killing) => {
  const before = sys.events.length;
  if (mp.onHitDamageAttempt(P, WOLF, BOW, 30) === false) return [];
  if (killing) dead.add(WOLF);
  mp.onHitDamage(P, WOLF, BOW, 30);
  return sys.events.slice(before);
};
const hitOf = (evs) => evs.find((e) => e.kind === 'hit');
const killOf = (evs) => evs.find((e) => e.kind === 'kill');

let evs = swing(false);
ok('a hit on a live wolf is recorded alive', hitOf(evs) && hitOf(evs).detail.alive === 1 && !killOf(evs), evs);
ok('the earlier handlers still run', inner.filter((x) => x[0] === 'attempt').length === 1 && inner.filter((x) => x[0] === 'hit').length === 1);
evs = swing(true);
ok('the killing blow is a hit that found the wolf alive', hitOf(evs) && hitOf(evs).detail.alive === 1, evs);
ok('...and a kill', !!killOf(evs) && killOf(evs).detail.victimId === WOLF);
evs = swing(false);
ok('a blow to the body afterwards is recorded dead', hitOf(evs) && hitOf(evs).detail.alive === 0, evs);
ok('...and is no second kill', !killOf(evs));

// matches(): only the alive rule is under test; reach and the combat check are taken as passed
sys.hitReach = () => 1000; sys.combatCounts = () => true;
const rules = { hitKeywords: new Set(['x']), weaponTypes: new Set(), weaponIds: new Set() };
const ev = (detail) => ({ kind: 'hit', actorId: P, detail: Object.assign({ targetId: WOLF, sourceId: BOW }, detail) });
ok('dead now but alive when struck: counts', sys.matches(ctx, 'archery', rules, ev({ alive: 1 })) === true);
ok('dead when struck: does not count', sys.matches(ctx, 'archery', rules, ev({ alive: 0 })) === false);
ok('no reading and dead now: does not count, as before', sys.matches(ctx, 'archery', rules, ev({})) === false);
dead.delete(WOLF);
ok('no reading and alive: counts, as before', sys.matches(ctx, 'archery', rules, ev({})) === true);

// An attempt another handler refused leaves no reading behind
const refusing = new MasterySystem(() => {});
const mp2 = { get: mp.get, onHitDamageAttempt: () => false, onHitDamage: () => undefined };
refusing.hookNativeEvents({ svr: mp2 });
mp2.onHitDamageAttempt(P, WOLF, BOW, 30);
ok('a refused attempt records nothing', refusing.aliveAtAttempt.size === 0);
// The map cannot grow without bound when onHitDamage never follows
for (let i = 0; i < 2000; i++) mp.onHitDamageAttempt(P, 0xff100000 + i, BOW, 1);
ok('readings without a following hit stay bounded', sys.aliveAtAttempt.size <= 513, sys.aliveAtAttempt.size);

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
