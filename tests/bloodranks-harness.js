// Scripted test for server\bloodranks.js (vampire ranks) with a mock gamemode api: blood from a corpse, a living captive
// and a player this vampire slew; the farming rules for players (once per victim account per day, never a partymate or
// its own account, a slain one only if this vampire slew them); companions and non-vampires give nothing; rank-ups; the
// numbers each rank sets (night damage, sun, thirst); a reset; /blood. Run it from this folder's parent with
//
//   node tests\bloodranks-harness.js
'use strict';
const path = require('path');
const BLOOD = path.resolve(__dirname, '..', 'bloodranks.js');

let now = Date.UTC(2026, 8, 27, 12, 0);
Date.now = () => now;
const VAMP = 0xff000010, OTHER = 0xff000011, ALT = 0xff000012, PAL = 0xff000013, NPC = 0xff0000a0, PET = 0xff0000a1;
const props = new Map();
const get = (id, p) => props.get(id + '|' + p);
const set = (id, p, v) => props.set(id + '|' + p, v);
const profiles = { [VAMP]: 1, [OTHER]: 2, [ALT]: 1, [PAL]: 3 };
set(PET, 'private.dboCompanion', { owner: OTHER });
let night = true;
globalThis.__dboClock = { isNight: () => night };
globalThis.__dboSuperKind = (a) => (a === VAMP ? 'vampire' : null);
globalThis.__dboPartyLeaderOf = (a) => ({ [VAMP]: 'l', [PAL]: 'l' }[a] || null);
const said = []; const audits = []; const packets = []; const commands = new Map();
const api = {
  mp: { get, set }, log: () => {}, personal: (a, t) => said.push({ a, t }), audit: (t) => audits.push(t), who: (a) => `P${a.toString(16)}`,
  sendPacket: (a, p) => packets.push({ a, p }), profileOf: (a) => (profiles[a] === undefined ? -1 : profiles[a]),
  registerChatCommand: (n, fn) => commands.set(n, fn), cfg: {},
};
delete require.cache[BLOOD];
const blood = require(BLOOD)(api);

let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail !== undefined ? '   ' + detail : ''}`); if (!ok) failures++; };
const total = () => (get(VAMP, 'private.bloodRanks') || {}).blood || 0;
const last = (a) => { const x = said.filter((s) => s.a === a); return (x[x.length - 1] || {}).t || ''; };

check('a new vampire is a Fledgling, with no bonus', blood.rankOf(VAMP) === 0 && globalThis.__dboBloodDamageMult(VAMP) === 1 && globalThis.__dboBloodSunMult(VAMP) === 1);
globalThis.__dboBloodFed(VAMP, NPC, true, 0);
check('a fresh humanoid corpse: 5', total() === 5);
globalThis.__dboBloodFed(VAMP, NPC, false, 0);
check('a living npc gives nothing (only people held captive count)', total() === 5);
globalThis.__dboBloodFed(VAMP, PET, true, 0);
check('a companion gives nothing', total() === 5);
globalThis.__dboBloodFed(OTHER, NPC, true, 0);
check('someone who is not a vampire earns nothing', !get(OTHER, 'private.bloodRanks'));
globalThis.__dboBloodFed(VAMP, OTHER, false, 0);
check('a living captive: 20', total() === 25);
globalThis.__dboBloodFed(VAMP, OTHER, false, 0);
check('the same victim again the same day gives nothing', total() === 25 && /too recently/.test(last(VAMP)));
globalThis.__dboBloodFed(VAMP, ALT, false, 0);
check('its own account gives nothing', total() === 25 && /not another person/.test(last(VAMP)));
globalThis.__dboBloodFed(VAMP, PAL, false, 0);
check('a partymate gives nothing', total() === 25 && /ride with you/.test(last(VAMP)));
now += 25 * 3600000;
globalThis.__dboBloodFed(VAMP, OTHER, true, PAL);
check('a player someone else slew gives nothing', total() === 25 && /did not bring them down/.test(last(VAMP)));
globalThis.__dboBloodFed(VAMP, OTHER, true, VAMP);
check('a player this vampire slew: 30', total() === 55);
set(VAMP, 'private.bloodRanks', Object.assign(get(VAMP, 'private.bloodRanks'), { blood: 95 }));
now += 25 * 3600000;
globalThis.__dboBloodFed(VAMP, OTHER, false, 0);
check('100 blood makes a Vampire, and says so', blood.rankOf(VAMP) === 1 && said.some((s) => s.a === VAMP && /You are a Vampire now/.test(s.t)) && packets.some((x) => x.p.customPacketType === 'dboBanner') && audits.some((t) => /rose to Vampire/.test(t)));
check('a Vampire: 2% heavier at night, the sun 10% softer, thirst 10% slower', globalThis.__dboBloodDamageMult(VAMP) === 1.02 && globalThis.__dboBloodSunMult(VAMP) === 0.9 && globalThis.__dboBloodThirstRate(VAMP) === 0.9);
night = false;
check('by day the damage bonus is gone', globalThis.__dboBloodDamageMult(VAMP) === 1);
night = true;
check('others get no bonus', globalThis.__dboBloodDamageMult(OTHER) === 1);
set(VAMP, 'private.bloodRanks', { blood: 1500, fedOn: {} });
check('a Master Vampire: x1.1 at night, sun x0.6, thirst x0.6', globalThis.__dboBloodDamageMult(VAMP) === 1.1 && globalThis.__dboBloodSunMult(VAMP) === 0.6 && globalThis.__dboBloodThirstRate(VAMP) === 0.6);
check('weaker than the Great Hunt\'s Elder (x1.2 in beast form)', globalThis.__dboBloodDamageMult(VAMP) < 1.2);
globalThis.__dboBloodReset(VAMP);
check('a cure starts the next vampire as a Fledgling', blood.rankOf(VAMP) === 0 && total() === 0);

said.length = 0;
commands.get('blood')(OTHER);
check('/blood is for vampires', /Only the blood of a vampire/.test(last(OTHER)));
said.length = 0;
commands.get('blood')(VAMP);
check('/blood shows the rank, the blood and the next rank', /Fledgling, with 0 blood/.test(said[0].t) && /Vampire at 100 blood/.test(said[2].t), JSON.stringify(said.map((s) => s.t)));

console.log(failures ? `${failures} failure(s)` : 'all passed');
process.exit(failures ? 1 : 0);
