// masterySystem's F3 journal hooks (design f3-hub-design.md 3.2, piece H6): __alduinakMasteryMenu gives the Skills tab
// the K menu's own object (lore and tierLore included), __alduinakMasteryAction runs the K menu's four actions and
// answers { ok, text } instead of sending a masteryNotice and a masteryMenu, and masteryInfoRequest { preferJournal }
// answers { journal: true } when the journal took the Skills tab, the full menu otherwise.
//
//   node tests/mastery-journal-harness.js <bundled masterySystem.js>
//
// A masterySystem without the hooks has nothing to test, which is said and not failed.
'use strict';
const fs = require('fs');
const path = require('path');

const bundle = process.argv[2];
if (!bundle) { console.error('usage: node tests/mastery-journal-harness.js <bundled masterySystem.js>'); process.exit(2); }
const SRC = fs.readFileSync(bundle, 'utf8');
if (!/__alduinakMasteryMenu/.test(SRC)) { require('./expect')('mastery-journal', 'this masterySystem has no journal hooks'); console.log('ok   skipped: this masterySystem has no journal hooks'); process.exit(0); }
const { MasterySystem } = require(path.resolve(bundle));

let fails = 0;
const ok = (label, cond, got) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${!cond && got !== undefined ? `: got ${JSON.stringify(got)}` : ''}`); if (!cond) fails++; };

const PLAYER = 0xff000014, USER = 7;
const props = new Map();
let packets = [];
const mp = {
  get: (id, key) => {
    if (key === 'profileId') return (id >>> 0) === PLAYER ? 2 : -1;
    if (key === 'inventory') return { entries: [] };
    const v = props.get(`${id >>> 0}:${key}`);
    return v === undefined ? undefined : JSON.parse(v);
  },
  set: (id, key, value) => props.set(`${id >>> 0}:${key}`, JSON.stringify(value)),
  getUserByActor: (a) => ((a >>> 0) === PLAYER ? USER : 65535),
  getUserActor: (u) => (u === USER ? PLAYER : 0),
  sendCustomPacket: (u, s) => packets.push(JSON.parse(s)),
};
const ctx = { svr: mp };
const sys = new MasterySystem(() => { });
sys.points = { pool: 300, capPerSkill: 100, seatAbove: 90, seatCount: 1, expertAbove: 75, expertCount: 3, transferFloor: 25, firstTouchCost: 1,
  bucketBurst: 20, bucketPerHour: 30, dailyCaps: { low: 360, expert: 180, master: 60 }, characterDaily: 1080 };
const LORE = 'The shield-wall of the Nords, the Legion\'s testudo: the art of standing where others fall.';
sys.skills = ['defense', 'blacksmith', 'oneHanded'].map((id) => ({ id, category: 'combat', label: id, title: '', description: 'rules', tiers: ['a', 'b', 'c', 'd', 'e'],
  vanillaSkills: [], counts: {}, gates: {}, craftWeight: null, lore: id === 'defense' ? LORE : '', tierLore: id === 'defense' ? ['t0', 't1', 't2', 't3', 't4'] : [] }));
sys.rules = {};
mp.set(PLAYER, 'private.mastery', { v: 2, order: ['defense'], skills: { defense: { level: 30, xp: 0, rank: 1, granted: [], lastPointAt: 0, lock: 'raise' },
  oneHanded: { level: 0, xp: 0, rank: 0, granted: [], offered: true, shadow: 2 } } });
const saved = {};
for (const k of ['__alduinakMasteryMenu', '__alduinakMasteryAction', '__dboJournalOpenTab']) saved[k] = globalThis[k];
sys.registerJournalHooks(ctx);

// ---- the menu object --------------------------------------------------------------------------------------------
const menu = globalThis.__alduinakMasteryMenu(PLAYER);
ok('the menu object has the skills, chosen and the pool', menu && Array.isArray(menu.skills) && menu.skills.length === 3 && Array.isArray(menu.chosen) && menu.points && menu.points.pool === 300, menu && Object.keys(menu));
ok('it is the K menu\'s object, without a packet type', menu && !('customPacketType' in menu) && Array.isArray(menu.tierNames));
const def = menu && menu.skills.find((k) => k.id === 'defense');
ok('a skill carries its lore and tierLore', def && def.lore === LORE && def.tierLore.length === 5 && def.tierLore[3] === 't3', def);
const bs = menu && menu.skills.find((k) => k.id === 'blacksmith');
ok('a skill without lore carries empty ones', bs && bs.lore === '' && Array.isArray(bs.tierLore) && bs.tierLore.length === 0, bs);
ok('the held skill and the standing offer are listed', menu && menu.points.held.some((h) => h.id === 'defense' && h.level === 30) && menu.points.offers.some((o) => o.id === 'oneHanded'), menu && menu.points);
ok('reading the menu sends nothing', packets.length === 0, packets);
ok('no actor, no menu', globalThis.__alduinakMasteryMenu(0) === null);

// ---- actions ------------------------------------------------------------------------------------------------------
packets = [];
let r = globalThis.__alduinakMasteryAction(PLAYER, 'lock', { skill: 'defense', lock: 'hold' });
ok('lock: ok, and the record holds it', r.ok === true && mp.get(PLAYER, 'private.mastery').skills.defense.lock === 'hold', r);
ok('lock: no masteryMenu and no masteryNotice went to the client', packets.length === 0, packets);
r = globalThis.__alduinakMasteryAction(PLAYER, 'lock', { skill: 'defense', lock: 'sideways' });
ok('a bad lock changes nothing', r.ok === false && mp.get(PLAYER, 'private.mastery').skills.defense.lock === 'hold', r);
r = globalThis.__alduinakMasteryAction(PLAYER, 'takeUp', { skill: 'oneHanded' });
const after = mp.get(PLAYER, 'private.mastery').skills.oneHanded;
ok('takeUp of an offered skill: ok, and its text is kept for the result line', r.ok === true && after.level >= 1 && /You take up oneHanded/.test(r.text), [r, after]);
ok('takeUp: nothing was sent to the client', packets.length === 0, packets);
r = globalThis.__alduinakMasteryAction(PLAYER, 'takeUp', { skill: 'blacksmith' });
ok('takeUp with no offer standing: refused', r.ok === false, r);
r = globalThis.__alduinakMasteryAction(PLAYER, 'drop', { skill: 'defense' });
ok('drop away from a standing stone: refused, with the stone\'s words', r.ok === false && /standing stone/.test(r.text) && mp.get(PLAYER, 'private.mastery').skills.defense.level === 30, r);
ok('unknown op: refused', globalThis.__alduinakMasteryAction(PLAYER, 'explode', { skill: 'defense' }).ok === false);
ok('unknown skill: refused', globalThis.__alduinakMasteryAction(PLAYER, 'lock', { skill: 'weaving', lock: 'hold' }).ok === false);
ok('an actor with no user: refused', globalThis.__alduinakMasteryAction(0xff0000aa, 'lock', { skill: 'defense', lock: 'raise' }).ok === false);
ok('after an action, notices reach the client again', (() => { packets = []; sys.notice(ctx, USER, 'x'); return packets.length === 1 && packets[0].customPacketType === 'masteryNotice'; })(), packets);

// ---- K with preferJournal ---------------------------------------------------------------------------------------
const opened = [];
globalThis.__dboJournalOpenTab = (a, tab) => { opened.push([a >>> 0, tab]); return true; };
packets = [];
sys.customPacket(USER, 'masteryInfoRequest', { customPacketType: 'masteryInfoRequest', preferJournal: true }, ctx);
ok('preferJournal + a journal that takes it: { journal: true } and the Skills tab opens', packets.length === 1 && packets[0].customPacketType === 'masteryMenu' && packets[0].journal === true && !packets[0].skills && opened.length === 1 && opened[0][1] === 'skills', [packets, opened]);
packets = [];
sys.customPacket(USER, 'masteryInfoRequest', { customPacketType: 'masteryInfoRequest' }, ctx);
ok('an old client (no flag): the full menu, the journal is not asked', packets.length === 1 && Array.isArray(packets[0].skills) && !packets[0].journal && opened.length === 1, [packets, opened]);
globalThis.__dboJournalOpenTab = () => false;
packets = [];
sys.customPacket(USER, 'masteryInfoRequest', { customPacketType: 'masteryInfoRequest', preferJournal: true }, ctx);
ok('preferJournal but the journal declines (old front): the full menu', packets.length === 1 && Array.isArray(packets[0].skills) && !packets[0].journal, packets);
globalThis.__dboJournalOpenTab = () => { throw new Error('boom'); };
packets = [];
sys.customPacket(USER, 'masteryInfoRequest', { customPacketType: 'masteryInfoRequest', preferJournal: true }, ctx);
ok('a journal that throws: the full menu', packets.length === 1 && Array.isArray(packets[0].skills), packets);
delete globalThis.__dboJournalOpenTab;
packets = [];
sys.customPacket(USER, 'masteryInfoRequest', { customPacketType: 'masteryInfoRequest', preferJournal: true }, ctx);
ok('no journal module: the full menu', packets.length === 1 && Array.isArray(packets[0].skills), packets);

for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete globalThis[k]; else globalThis[k] = v; }
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
