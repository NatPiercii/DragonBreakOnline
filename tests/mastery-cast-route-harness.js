// Does the gameplay's cast route (globalThis.__dboCastSkill, schools.js) decide the one skill a cast credits?
// Nate, 2026-09-30: Alteration is both Priest's and Arcane Arts'. A cast credits Arcane Arts for a mage who chose
// Alteration as a school, Priest otherwise, never both. Without the hook skills.json's spellCastSchools decide, as before.
//
//   node tests/mastery-cast-route-harness.js <bundled masterySystem.js>
//
// A masterySystem from before the hook has nothing to route, which is said and not failed: the gameplay then credits
// the Alteration school meter only and leaves the Wheel's cast credit to Priest.
'use strict';
const fs = require('fs');
const path = require('path');

const bundle = process.argv[2];
if (!bundle) { console.error('usage: node tests/mastery-cast-route-harness.js <bundled masterySystem.js>'); process.exit(2); }
if (!/__dboCastSkill/.test(fs.readFileSync(bundle, 'utf8'))) { require('./expect')('mastery-cast-route', 'this masterySystem has no cast route'); console.log('ok   skipped: this masterySystem has no cast route'); process.exit(0); }
const { MasterySystem } = require(path.resolve(bundle));

let fails = 0;
const ok = (label, cond, got) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${!cond && got !== undefined ? `: got ${JSON.stringify(got)}` : ''}`); if (!cond) fails++; };

const MAGE = 0xff000014, PRIEST = 0xff000015, USER = 7;
const SPELLS = { 0x43324: 'Alteration', 0x12fcd: 'Destruction', 0x12fcc: 'Restoration' };
const props = new Map();
const mp = {
  get: (id, key) => {
    if (key === 'profileId') return id === MAGE || id === PRIEST ? 2 : -1;
    const v = props.get(`${id >>> 0}:${key}`);
    return v === undefined ? undefined : JSON.parse(v);
  },
  set: (id, key, value) => props.set(`${id >>> 0}:${key}`, JSON.stringify(value)),
  getUserByActor: () => USER,
  getUserActor: () => MAGE,
  sendCustomPacket: () => { },
};
const ctx = { svr: mp };
const sys = new MasterySystem(() => { });
sys.spellSchool = (_ctx, spellId) => SPELLS[Number(spellId) >>> 0] || '';
const rules = {
  arcane: { spellSchools: new Set(['Destruction', 'Conjuration', 'Illusion']), gateStations: new Set(), gatePrefixes: [] },
  priest: { spellSchools: new Set(['Restoration', 'Alteration']), gateStations: new Set(), gatePrefixes: [] },
};
const cast = (actorId, spellId) => ({ kind: 'cast', actorId, detail: { spellId, value: 20 } });
const who = (ev) => ['arcane', 'priest'].filter((id) => sys.matches(ctx, id, rules[id], ev));

delete globalThis.__dboCastSkill;
ok('no route: an Alteration cast is Priest\'s, as skills.json says', who(cast(MAGE, 0x43324)).join() === 'priest', who(cast(MAGE, 0x43324)));
ok('no route: a Destruction cast is Arcane Arts\'', who(cast(MAGE, 0x12fcd)).join() === 'arcane');

// schools.js's answer: Arcane Arts for a mage with Alteration as a school, nothing to say otherwise
globalThis.__dboCastSkill = (actorId, school) => (school === 'Alteration' && actorId === MAGE ? 'arcane' : undefined);
ok('routed: the mage\'s Alteration cast credits Arcane Arts only', who(cast(MAGE, 0x43324)).join() === 'arcane', who(cast(MAGE, 0x43324)));
ok('routed: the priest\'s Alteration cast stays Priest\'s', who(cast(PRIEST, 0x43324)).join() === 'priest', who(cast(PRIEST, 0x43324)));
ok('routed: other schools keep skills.json', who(cast(MAGE, 0x12fcc)).join() === 'priest' && who(cast(MAGE, 0x12fcd)).join() === 'arcane');
globalThis.__dboCastSkill = () => { throw new Error('boom'); };
ok('a route that throws falls back to skills.json', who(cast(MAGE, 0x43324)).join() === 'priest');
globalThis.__dboCastSkill = () => 42;
ok('a route that answers something odd falls back too', who(cast(MAGE, 0x43324)).join() === 'priest');

// Through the whole credit: both skills held, one Alteration cast, one skill moves
globalThis.__dboCastSkill = (actorId, school) => (school === 'Alteration' && actorId === MAGE ? 'arcane' : undefined);
sys.points = { pool: 300, capPerSkill: 100, seatAbove: 90, seatCount: 1, expertAbove: 75, expertCount: 3, transferFloor: 25, firstTouchCost: 1,
  bucketBurst: 20, bucketPerHour: 30, dailyCaps: { low: 360, expert: 180, master: 60 }, characterDaily: 1080 };
sys.skills = ['arcane', 'priest'].map((id) => ({ id, category: 'combat', label: id, title: '', description: '', tiers: [], vanillaSkills: [], counts: {}, gates: {} }));
sys.rules = rules;
sys.candidates = new Map([['cast', ['arcane', 'priest']]]);
const held = (a) => mp.set(a, 'private.mastery', { v: 2, order: ['arcane', 'priest'], skills: { arcane: { level: 10, xp: 0, rank: 0 }, priest: { level: 10, xp: 0, rank: 0 } } });
held(MAGE); held(PRIEST);
const xp = (a) => { const r = mp.get(a, 'private.mastery').skills; return [r.arcane.level * 100 + r.arcane.xp, r.priest.level * 100 + r.priest.xp]; };
sys.creditActivity(ctx, cast(MAGE, 0x43324));
ok('credited: the mage\'s Alteration cast raised Arcane Arts and not Priest', xp(MAGE)[0] > 1000 && xp(MAGE)[1] === 1000, xp(MAGE));
sys.creditActivity(ctx, cast(PRIEST, 0x43324));
ok('credited: the priest\'s raised Priest and not Arcane Arts', xp(PRIEST)[1] > 1000 && xp(PRIEST)[0] === 1000, xp(PRIEST));
delete globalThis.__dboCastSkill;

console.log(fails ? `${fails} failure(s)` : 'all checks passed');
process.exit(fails ? 1 : 0);
