// Scripted test for server\armourswap.js (changing armour mid-fight takes time). No server and no game: run it from
// this folder's parent with
//
//   node tests\armourswap-harness.js
'use strict';
const path = require('path');
const MODULE = path.resolve(__dirname, '..', 'armourswap.js');
let now = 1790000000000;
const realNow = Date.now;
Date.now = () => now;

// BOD2: slot mask, then armour type (0 light, 1 heavy, 2 clothing); slot 32 body = bit 2, slot 39 shield = bit 9
const bod2 = (slots, type) => { const b = new Uint8Array(8); const dv = new DataView(b.buffer); dv.setUint32(0, slots, true); dv.setUint32(4, type, true); return b; };
const ITEMS = { 0x100: bod2(1 << 2, 1), 0x101: bod2(1 << 3, 1), 0x200: bod2(1 << 2, 0), 0x300: bod2(1 << 2, 2), 0x301: bod2(1 << 6, 2), 0x400: bod2(1 << 9, 1) };
const HEAVY_CUIRASS = 0x100, HEAVY_GAUNTLETS = 0x101, LIGHT_CUIRASS = 0x200, ROBE = 0x300, RING = 0x301, SHIELD = 0x400, SWORD = 0x500;
const PLAYER = 1, BANDIT = 2, NPC = 0xff000001;
const packets = [], said = [];
const props = {};
const sw = require(MODULE)({
  mp: { get: (id, k) => props[`${id}:${k}`] },
  log: () => {}, personal: (a, t) => said.push([a, t]), sendPacket: (a, p) => packets.push([a, p]), display: (a) => `#${a}`,
  profileOf: (a) => (a === NPC ? -1 : a * 10),
  armorPieceOf: (id) => (ITEMS[id] ? { rating: 10, heavy: new DataView(ITEMS[id].buffer).getUint32(4, true) === 1 } : null),
  recordOf: (id) => (ITEMS[id] ? { record: { type: 'ARMO', fields: [{ type: 'BOD2', data: ITEMS[id] }] } } : id === SWORD ? { record: { type: 'WEAP', fields: [] } } : null),
  fieldsOf: (r, t) => ((r && r.record.fields) || []).filter((f) => f.type === t),
  cfg: {},
});

let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + detail : ''}`); if (!ok) failures++; };
const wear = (...ids) => ids.map((baseId) => ({ baseId }));

check('pieces cost by kind; shields and weapons are free', sw.secondsFor(HEAVY_CUIRASS) === 5 && sw.secondsFor(LIGHT_CUIRASS) === 3 && sw.secondsFor(ROBE) === 2 && sw.secondsFor(RING) === 2 && sw.secondsFor(SHIELD) === 0 && sw.secondsFor(SWORD) === 0);

sw.onEquip(BANDIT, wear(HEAVY_CUIRASS, HEAVY_GAUNTLETS, SWORD), true);
check('out of combat a full strip is free', sw.onEquip(BANDIT, wear(SWORD), false) === 0 && !packets.length);
sw.onEquip(BANDIT, wear(HEAVY_CUIRASS, HEAVY_GAUNTLETS, SWORD), false);

sw.onHit(BANDIT, NPC);
check('a blow against an NPC counts as combat, and weapon and shield swaps stay free', sw.onEquip(BANDIT, wear(HEAVY_CUIRASS, HEAVY_GAUNTLETS, SHIELD), false) === 0);
const t = sw.onEquip(BANDIT, wear(SHIELD), false);
check('stripping heavy armour in a fight costs its time, and the client is slowed', t === 10 && packets.some(([a, p]) => a === BANDIT && p.customPacketType === 'dboStatus' && p.speedMult === -50 && p.seconds === 10), t);
check('meanwhile their blows are refused, with a note', sw.busy(BANDIT) && said.some(([a, x]) => a === BANDIT && /still fastening/.test(x)));
now += 4000;
check('a ring put on halfway adds to the time instead of cutting it short', sw.onEquip(BANDIT, wear(SHIELD, RING), false) === 8);
now += 8500;
check('once done they can fight again', !sw.busy(BANDIT));

now += 5 * 60000;
check('the fight is over after 20 s without a blow', sw.onEquip(BANDIT, wear(HEAVY_CUIRASS, SHIELD), false) === 0);

sw.onEquip(PLAYER, wear(LIGHT_CUIRASS), false);
sw.onHit(NPC, PLAYER);
check('taking a blow counts as combat too', sw.onEquip(PLAYER, wear(), false) === 3);
now += 60000;
sw.onHit(NPC, PLAYER);
check("the server's own dressing (login, re-dress) is never charged", sw.onEquip(PLAYER, wear(LIGHT_CUIRASS), true) === 0);
props[`${PLAYER}:private.beast`] = { form: 'werewolf' };
check('turning into a beast mid-fight is not charged', sw.onEquip(PLAYER, wear(), false) === 0);
delete props[`${PLAYER}:private.beast`];
check('nor turning back soon after', sw.onEquip(PLAYER, wear(LIGHT_CUIRASS), false) === 0);
now += 16000; sw.onHit(NPC, PLAYER);
check('the cap holds a full strip to 30 s', (() => { sw.onEquip(PLAYER, wear(HEAVY_CUIRASS, HEAVY_GAUNTLETS, ROBE, RING, 0x200), false); return sw.onEquip(PLAYER, wear(), false) <= 30; })());

Date.now = realNow;
delete globalThis.__dboArmourSwap;
console.log('');
console.log(failures ? `${failures} FAILURES` : 'all checks passed');
process.exit(failures ? 1 : 0);
