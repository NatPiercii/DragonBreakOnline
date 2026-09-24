// Does work on a skill the character has not taken up survive the record round trip and reach an offer?
//
//   node tests\mastery-shadow-harness.js <bundled masterySystem.js>
//   (bundle with: cd fork\skymp5-server && ./node_modules/.bin/esbuild ts/systems/masterySystem.ts \
//      --bundle --platform=node --format=cjs --outfile=<out>)
//
// Measured 2026-09-23 on the dev server: no stationless skill on any character had ever banked more
// than one event (shadow 0.5 = one hit), because read() dropped `shadow` and `offered`, and a character
// with no record at all banked nothing. Rule matching is stubbed here; this tests persistence only.
'use strict';
const path = require('path');

const bundle = process.argv[2];
if (!bundle) { console.error('usage: node tests\\mastery-shadow-harness.js <bundled masterySystem.js>'); process.exit(2); }
const { MasterySystem } = require(path.resolve(bundle));

let fails = 0, checks = 0;
const ok = (label, cond, got) => { checks++; if (!cond) { fails++; console.log(`  FAIL ${label}${got !== undefined ? `: got ${JSON.stringify(got)}` : ''}`); } };

const PLAYER = 0xff000014, NPC = 0xff0000aa, USER = 7;
const props = new Map();
const packets = [];
const mp = {
  get: (id, key) => {
    if (key === 'profileId') return id === PLAYER ? 2 : -1;
    const v = props.get(`${id >>> 0}:${key}`);
    return v === undefined ? undefined : JSON.parse(v);   // the real store hands back a fresh copy
  },
  set: (id, key, value) => props.set(`${id >>> 0}:${key}`, JSON.stringify(value)),
  getUserByActor: (id) => (id === PLAYER ? USER : 65535),
  getUserActor: (u) => (u === USER ? PLAYER : 0),
  sendCustomPacket: (u, s) => packets.push(JSON.parse(s)),
};
const ctx = { svr: mp };

const sys = new MasterySystem(() => { });
sys.points = {
  pool: 300, capPerSkill: 100, seatAbove: 90, seatCount: 1, expertAbove: 75, expertCount: 3,
  transferFloor: 25, firstTouchCost: 1, bucketBurst: 20, bucketPerHour: 30,
  dailyCaps: { low: 360, expert: 180, master: 60 }, characterDaily: 1080,
};
sys.skills = [{ id: 'blade', category: 'combat', label: 'Blade', title: '', description: '', tiers: [], vanillaSkills: [], counts: {}, gates: {} }];
sys.rules = { blade: { gateStations: new Set(), gatePrefixes: [] } };
sys.candidates = new Map([['hit', ['blade']]]);
sys.matches = () => true;

const hit = (actorId) => sys.creditActivity(ctx, { kind: 'hit', actorId, detail: { targetId: NPC, sourceId: 0x12eb7 } });
const record = () => mp.get(PLAYER, 'private.mastery') || { skills: {} };
const bank = () => record().skills.blade || {};

// 1. a character with no record at all starts banking
hit(PLAYER);
ok('first hit creates a record', !!mp.get(PLAYER, 'private.mastery'));
ok('first hit banks 0.5', bank().shadow === 0.5, bank());

// 2. the bank grows across reads; 20 hits of 0.5 reach unitsForLevel(1) = 10
for (let i = 1; i < 19; i++) hit(PLAYER);
ok('19 hits bank 9.5', bank().shadow === 9.5, bank().shadow);
ok('no offer before 10 units', !bank().offered);
hit(PLAYER);
ok('20th hit makes the offer', bank().offered === true, bank());
ok('offer notice sent', packets.some((p) => p.customPacketType === 'masteryNotice' && /One-Handed/.test(p.text)));
const menu = packets.filter((p) => p.customPacketType === 'masteryMenu').pop();
ok('menu lists the offer', menu && menu.points.offers.some((o) => o.id === 'blade' && o.banked === 10), menu && menu.points.offers);

// 3. the offer is made once, and the flag survives further work
const notices = packets.filter((p) => p.customPacketType === 'masteryNotice').length;
hit(PLAYER); hit(PLAYER);
ok('offer stays set', bank().offered === true);
ok('no repeated offer notice', packets.filter((p) => p.customPacketType === 'masteryNotice').length === notices);

// 4. taking it up spends the bank
sys.customPacket(USER, 'masteryTakeUp', { skill: 'blade' }, ctx);
const taken = bank();
ok('taken up above level 1', taken.level >= 2, taken);
ok('bank cleared', !taken.shadow && !taken.offered, taken);

// 5. an NPC never gets a record
hit(NPC);
ok('NPC has no record', mp.get(NPC, 'private.mastery') === undefined);

console.log(`${checks - fails}/${checks} checks passed`);
process.exit(fails ? 1 : 0);
