// Scripted test for the Beyond Skyrim activators in gamemode.js (error review 2026-09-26 item 11): a wisp stalk gives
// Wisp Stalk by Harvesting tier and then rests for everyone, an unskilled hand gets the skill's unskilled chance, other
// activators pass through; an Ayleid well restores magicka and is spent until the world clock's next midnight. The
// section is cut out of gamemode.js (from its banner to the world containers banner) and run with stubs. Run it from
// this folder's parent with
//
//   node tests\bsactivators-harness.js
'use strict';
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.resolve(__dirname, '..', 'gamemode.js'), 'utf8');
const start = src.indexOf('// ---- Beyond Skyrim activators the server runs itself');
const end = src.indexOf('// ---- world containers outside dungeons hold nothing');
if (start < 0 || end < start) { console.log('FAIL the section markers are gone from gamemode.js'); process.exit(1); }

const STALK = 0x07079800, STALK2 = 0x07079801, WELL = 0x020d6a3a, BARREL = 0x00012345;
const ME = 0xff000014, NOVICE = 0xff000015;
const WISP_ITEM = 0x07601924;
const bases = { [STALK]: '6025b4:BSAssets.esm', [STALK2]: '6025b3:BSAssets.esm', [WELL]: '61b5b:BSHeartland.esm', [BARREL]: '12345:Skyrim.esm' };
const props = new Map();
const mp = {
  get: (id, p) => (p === 'baseDesc' ? bases[id] : props.get(id + '|' + p)),
  set: (id, p, v) => props.set(id + '|' + p, v),
  getIdFromDesc: (d) => (d === '601924:BSAssets.esm' ? WISP_ITEM : d === '61b66:BSHeartland.esm' ? 0x02061b66 : 0),
};
const said = []; const audits = []; const given = []; const events = [];
const personal = (a, t) => said.push({ a, t });
const giveItem = (a, id, n) => { given.push({ a, id, n }); return true; };
const tiers = { [ME]: 4, [NOVICE]: -1 };
const harvestingTier = (a) => tiers[a];
const HARVESTING = { yieldChanceByTier: [0.6, 0.7, 0.8, 0.9, 1], yieldMultiplierByTier: [1, 1.25, 1.5, 1.75, 2], unskilled: { yieldChance: 0.25, yieldMultiplier: 0.5 } };
let day = 10.5;
globalThis.__dboClock = { gameDays: () => day };
globalThis.__alduinakMasteryEvent = (kind, a, d) => events.push({ kind, a, d });
delete globalThis.__dboWispRest; delete globalThis.__dboWellSpent;
const packets = [];
new Function('mp', 'personal', 'log', 'audit', 'who', 'cfg', 'giveItem', 'harvestingTier', 'HARVESTING', 'sendPacket', 'profileOf', src.slice(start, end))(
  mp, personal, () => {}, (t) => audits.push(t), (a) => `P${a.toString(16)}`, {}, giveItem, harvestingTier, HARVESTING, (a, p) => packets.push({ a, p }), (a) => (a === ME || a === NOVICE ? 1 : -1));

let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail !== undefined ? '   ' + detail : ''}`); if (!ok) failures++; };
const last = () => (said[said.length - 1] || {}).t;
let now = 1_000_000; const realNow = Date.now; Date.now = () => now;
const rnd = Math.random;

check('an npc gets nothing from a stalk or a well (review WISP-1)', globalThis.__dboWispStalk(STALK, 0xff0000aa) === false && globalThis.__dboAyleidWell(WELL, 0xff0000aa) === false);
check('another activator passes through', globalThis.__dboWispStalk(BARREL, ME) === false && globalThis.__dboAyleidWell(BARREL, ME) === false);
Math.random = () => 0.5;
check('a master harvester picks a wisp stalk: double yield', globalThis.__dboWispStalk(STALK, ME) === true && given[0].id === WISP_ITEM && given[0].n === 2 && /harvest 2 Wisp Stalks/.test(last()));
check('the harvest counts toward Harvesting', events.length === 1 && events[0].d.refrId === STALK);
check('the stalk then rests for everyone', globalThis.__dboWispStalk(STALK, NOVICE) === true && given.length === 1 && /has been picked/.test(last()));
now += 6 * 3600000 + 1;
Math.random = () => 0.2;
check('after six hours it can be picked again; an unskilled hand has a 25% chance and gets one', globalThis.__dboWispStalk(STALK, NOVICE) === true && given.length === 2 && given[1].n === 1 && /harvest Wisp Stalk\./.test(last()));
Math.random = () => 0.3;
check('and past that chance it crumbles, and still rests', globalThis.__dboWispStalk(STALK2, NOVICE) === true && given.length === 2 && /crumbles/.test(last()) && globalThis.__dboWispStalk(STALK2, ME) === true && given.length === 2);

// Ayleid wells
mp.set(ME, 'percentages', { health: 0.8, magicka: 0.1, stamina: 0.5 });
check('an Ayleid well restores magicka and keeps health and stamina', globalThis.__dboAyleidWell(WELL, ME) === true && JSON.stringify(mp.get(ME, 'percentages')) === JSON.stringify({ health: 0.8, magicka: 1, stamina: 0.5 }));
check('it is audited', /^WELL Pff000014 drew on the Ayleid well 20d6a3a/.test(audits[0] || ''));
check('and the player\'s client is asked to cast Boon of the Ayleids on them', packets.length === 1 && packets[0].a === ME && packets[0].p.customPacketType === 'dboCastSelf' && packets[0].p.spell === 0x02061b66);
mp.set(NOVICE, 'percentages', { health: 1, magicka: 0, stamina: 1 });
now += 2000; // one message per player every 1.5 s
check('then it is spent for everyone until midnight', globalThis.__dboAyleidWell(WELL, NOVICE) === true && mp.get(NOVICE, 'percentages').magicka === 0 && /At midnight/.test(last()));
day = 10.99;
check('a spent well asks for no cast', packets.length === 1);
check('still spent before midnight', globalThis.__dboAyleidWell(WELL, NOVICE) === true && mp.get(NOVICE, 'percentages').magicka === 0);
day = 11.01;
check('after the world clock passes midnight it gives again', globalThis.__dboAyleidWell(WELL, NOVICE) === true && mp.get(NOVICE, 'percentages').magicka === 1);

Math.random = rnd; Date.now = realNow;
console.log(failures ? `${failures} failure(s)` : 'all passed');
process.exit(failures ? 1 : 0);
