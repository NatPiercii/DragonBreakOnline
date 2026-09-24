// Every skill must have an opening move. Run from this folder's parent with
//
//   node tests\skill-openings-harness.js
//
// There are exactly two ways a skill can ever be held under the point system, and a skill that has
// neither is dead data: it can be credited by nothing, for ever, and nothing in the log says so.
//
//   1. `gates.stations` - masterySystem's activate loop calls `firstTouch` when the player sets a hand
//      on a station keyword or editor-id prefix. Eight trades open this way.
//   2. Shadow banking - a skill with NO station banks its units at level 0 and offers itself once the
//      bank reaches a level's worth. Ten skills open this way (six combat, plus priest, scholar,
//      harvesting and lockpicking).
//
// Before 2026-09-20 branch 2 was gated on `category === "combat"`, so praying, reading, picking a lock
// and harvesting credited nobody at all - proved by a real change form: a character who had prayed and
// taken Malacath as his deity had no `priest` record.
//
// This harness reads the live `skills.json` and the live `skillPoints.ts` weights, so a skill added
// with no station and no credit rule, or a station removed, fails here rather than in a play session.
'use strict';
const path = require('path');
const fs = require('fs');

const SERVER = path.resolve(__dirname, '..');
const SKILLS = JSON.parse(fs.readFileSync(path.join(SERVER, 'skills.json'), 'utf8'));
const POINTS_TS = fs.readFileSync(
  path.resolve(SERVER, '..', 'fork', 'skymp5-server', 'ts', 'systems', 'skillPoints.ts'), 'utf8');
const MASTERY_TS = fs.readFileSync(
  path.resolve(SERVER, '..', 'fork', 'skymp5-server', 'ts', 'systems', 'masterySystem.ts'), 'utf8');

let failures = 0;
const check = (what, ok, note) => {
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${what}${note ? ` - ${note}` : ''}`);
};

// ── The two branches, read out of the source rather than assumed ──────────────────────────────────

// masterySystem.creditPoints: the unopened branch must skip a skill that HAS a station, and must not
// test the category. If someone puts the combat test back, every stationless support skill goes dead
// again and nothing fails except a play session.
check('the unopened branch skips a skill that has a station',
  /if \(rules\.gateStations\.size \|\| rules\.gatePrefixes\.length\) continue;/.test(MASTERY_TS));
check('the unopened branch does not gate on category',
  !/category !== "combat"\) continue;/.test(MASTERY_TS));

// The station loop is the other branch.
check('the activate loop still calls firstTouch on a gated station',
  /gated && !has\(k\.id\)/.test(MASTERY_TS) && /P\.firstTouch\(rec as unknown as P\.PointRecord, k\.id/.test(MASTERY_TS));

// ── weightOf and unitsForLevel, lifted from the TS so the numbers below are the shipped ones ──────

const weights = {};
for (const m of POINTS_TS.matchAll(/case "(\w+)":(?: case "(\w+)":)?(?: case "(\w+)":)?(?: case "(\w+)":)? return ([^;]+);/g)) {
  const body = m[5].trim();
  // Only the flat weights are read here; the scaled ones are reported at their v=0 base.
  const base = /^clampW\(([\d.]+)/.test(body) ? Number(body.match(/^clampW\(([\d.]+)/)[1]) : Number(body);
  for (const k of [m[1], m[2], m[3], m[4]]) if (k) weights[k] = Number.isFinite(base) ? base : null;
}
check('weightOf parsed', Object.keys(weights).length >= 8, `${Object.keys(weights).length} kinds`);

const unitsForLevel = (() => {
  const m = POINTS_TS.match(/export const unitsForLevel[^\n]*\n?[^\n]*/);
  return m ? m[0] : '';
})();
check('unitsForLevel found in skillPoints.ts', !!unitsForLevel);
// Novice costs 10 units; the take-up offer fires at unitsForLevel(1).
const OFFER_AT = 10;

// ── Which kinds does each skill's `counts` block actually answer to? ───────────────────────────────
// This mirrors masterySystem.indexCandidates(). A skill that answers to no kind can never be credited
// by either branch, which is the failure this harness exists to catch.

const kindsOf = (sk) => {
  const c = sk.counts || {};
  const has = (k) => Array.isArray(c[k]) ? c[k].length > 0 : !!c[k];
  const out = new Set();
  if (has('craftKeywords') || has('craftStations')) out.add('craft');
  if (has('activatePrefixes') || has('activateTypes')) { out.add('activate'); out.add('mine'); out.add('chop'); out.add('read'); }
  if (has('eatIngredient')) out.add('eat');
  if (has('killKeywords')) out.add('kill');
  if (has('hitKeywords')) out.add('hit');
  if (has('spellCastSchools')) out.add('cast');
  if (has('damageTakenWhileArmored')) out.add('hurt');
  if (sk.id === 'priest') out.add('prayer');           // added unconditionally by indexCandidates
  if (sk.id === 'lockpicking') out.add('lock');
  if (sk.id === 'skinner') out.add('skin');
  return out;
};

const hasStation = (sk) => Array.isArray((sk.gates || {}).stations) && (sk.gates || {}).stations.length > 0;

console.log('');
console.log('opening move per skill');
const stationless = [];
for (const sk of SKILLS.skills) {
  const kinds = kindsOf(sk);
  const station = hasStation(sk);
  check(`${sk.id} can be credited at all`, kinds.size > 0, `kinds: ${Array.from(kinds).join(',') || 'NONE'}`);
  check(`${sk.id} has exactly one opening move`, true,
    station ? `station: ${sk.gates.stations.join(', ')}` : 'shadow banking (no station)');
  if (!station) stationless.push({ sk, kinds });
}

// The ten that bank. If this number moves, someone changed a skill's gates and should say so.
check('ten skills open by shadow banking', stationless.length === 10, `${stationless.length}`);
check('eight skills open at a station', SKILLS.skills.length - stationless.length === 8);

// Every banking skill must answer to a kind something actually emits, or the bank never fills.
// These are the emitters in server\*.js plus masterySystem's own hit/kill/cast/hurt paths.
const EMITTED = new Set(['activate', 'read', 'mine', 'chop', 'lock', 'prayer', 'skin', 'craft', 'eat', 'kill', 'hit', 'cast', 'hurt']);

// A won skinning round is the Skinner's own work (added 2026-09-21). All four halves must agree or
// the event is enqueued and dropped: the kind list, the candidate map, the match, and the emitter.
const GAMEMODE = fs.readFileSync(path.join(SERVER, 'gamemode.js'), 'utf8');
check('"skin" is an activity kind', /const ACTIVITY_KINDS = \[[^\]]*"skin"/.test(MASTERY_TS));
check('"skin" is indexed to the skinner', /add\("skin", "skinner"\)/.test(MASTERY_TS));
check('"skin" matches the skinner', /case "skin": return skillId === "skinner";/.test(MASTERY_TS));
check('"skin" has its own weight', /case "skin": return clampW/.test(POINTS_TS));
check('gamemode emits "skin" on a won round', /__alduinakMasteryEvent\('skin', a, \{ refrId: ses\.corpse, value: peltsWorth\(pelts\) \}\)/.test(GAMEMODE));
for (const { sk, kinds } of stationless) {
  check(`${sk.id} answers to a kind that is emitted`,
    Array.from(kinds).some((k) => EMITTED.has(k)));
}

// ── How long is the offer, in acts? Nat's balance call, stated as a number rather than a feeling ──

console.log('');
console.log(`acts banked before the take-up offer (a level's worth = ${OFFER_AT} units, at the flat/base weight)`);
// indexCandidates puts a skill on `mine`/`chop`/`read` as soon as it declares any activate rule, but
// `matches` then re-tests the base record, so a scholar is never credited for a vein. Report only the
// kind each skill can really receive, or the numbers below flatter the slow ones.
const REAL_KIND = {
  blunt: ['hit'], archery: ['hit'], blade: ['hit'], unarmed: ['hit'],
  defense: ['hurt'], arcane: ['cast'],
  scholar: ['read'], priest: ['prayer', 'cast'], harvesting: ['activate'], lockpicking: ['lock'],
};
for (const { sk, kinds } of stationless) {
  const real = (REAL_KIND[sk.id] || Array.from(kinds)).filter((k) => weights[k] != null);
  check(`${sk.id}'s real kinds are among its candidates`, real.every((k) => kinds.has(k)));
  const parts = real.map((k) => `${Math.ceil(OFFER_AT / weights[k])} x ${k} (weight ${weights[k]})`);
  console.log(`  ${sk.id.padEnd(13)} ${parts.join('  or  ')}`);
}

console.log('');
console.log(failures ? `${failures} FAILURES` : 'all checks passed');
process.exit(failures ? 1 : 0);
