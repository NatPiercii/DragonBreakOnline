// Scripted test for Death's Chill in server\downed.js. No server and no game: run it from this folder's parent with
//
//   node tests\death-chill-harness.js
//
// It loads downed.js against a mock mp, drives its timers by hand and checks who gets the chill, what it does to
// stamina, magicka and healing, how it counts down, and who can lift it.
'use strict';
const path = require('path');

const MODULE = path.resolve(__dirname, '..', 'downed.js');
let now = 1790000000000;
const realNow = Date.now;
Date.now = () => now;

const P = 0xff000001, PRIEST = 0xff000002, NOVICE = 0xff000003, WOLF = 0xff0000aa;
const props = new Map();
const set = (id, k, v) => props.set(id + '|' + k, v);
const get = (id, k) => props.get(id + '|' + k);
for (const [a, prof] of [[P, 1], [PRIEST, 2], [NOVICE, 3]]) {
  set(a, 'profileId', prof); set(a, 'isDead', false); set(a, 'percentages', { health: 1, stamina: 1, magicka: 1 });
  set(a, 'pos', [0, 0, 0]); set(a, 'worldOrCellDesc', 'a764b:BSHeartland.esm'); set(a, 'angle', [0, 0, 0]);
  set(a, 'spawnPoint', { cellOrWorldDesc: 'temple', pos: [1, 2, 3], rot: [0, 0, 0] });
}
set(WOLF, 'profileId', -1);
set(PRIEST, 'private.mastery', { order: ['priest'], skills: { priest: { rank: 2 } } }); // tier 3
set(NOVICE, 'private.mastery', { order: ['priest'], skills: { priest: { rank: 0 } } }); // tier 1
const HEAL_OTHER = 0x12fd2, GRAND = 0xb62ee;
const papyrus = [];
const mp = {
  get: (id, k) => { const v = get(id, k); if (v === undefined && k === 'private.permaDead') return false; return v; },
  set: (id, k, v) => set(id, k, v),
  getIdFromDesc: (d) => parseInt(d, 16),
  getDescFromId: (id) => (id >>> 0).toString(16),
  callPapyrusFunction: (kind, cls, fn, self, args) => { papyrus.push([fn, parseInt(self.desc, 16), args[0].desc, args[1]]); return true; },
  onHitDamageAttempt: () => true, onHitDamage: () => undefined, onDeath: () => undefined,
  onSpellHit: () => undefined, onSpellCast: () => undefined,
};
const out = { banners: [], audits: [], personal: [] };
const timers = {};
const commands = {};
require(MODULE)({
  mp, log: () => {}, personal: (a, t) => out.personal.push([a, t]),
  sendPacket: (a, p) => { if (p.customPacketType === 'dboBanner') out.banners.push([a, p.text]); return true; },
  audit: (t) => out.audits.push(t), who: (a) => 'P' + (a >>> 0).toString(16), display: (a) => 'P' + (a >>> 0).toString(16),
  profileOf: (a) => Number(get(a, 'profileId')), nameOf: (a) => 'P' + (a >>> 0).toString(16),
  onlineActors: () => [P, PRIEST, NOVICE], every: (n, ms, fn) => { timers[n] = fn; },
  registerChatCommand: (n, fn) => { commands[n] = fn; }, cfg: {},
});

let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + detail : ''}`); if (!ok) failures++; };
const pct = () => get(P, 'percentages');
const left = () => globalThis.__dboDeathChillLeft(P);
const tick = (ms) => { now += ms; timers.deathChill(); };
const die = () => { set(P, 'isDead', true); mp.onDeath(P, WOLF); };
const clear = () => { globalThis.__dboDownedState.chilled.clear(); set(P, 'private.dboDeathChill', { leftMs: 0 }); set(P, 'isDead', false); set(P, 'percentages', { health: 1, stamina: 1, magicka: 1 }); };

// raised in the field: no chill
die();
globalThis.__dboReviveWith(P, PRIEST, 'healing');
timers.downedDelay();
check('a player raised in the field gets no chill', !left());

// the engine's own respawn after the bleedout
die();
set(P, 'isDead', false);
timers.downedDelay();
check('waking at the temple by the bleedout brings the chill', left() === 20 * 60000);
check('with a banner in lore terms', out.banners.some(([a, t]) => a === P && /chill of the grave/.test(t)));

tick(1000);
check('stamina and magicka drop to their caps at once', Math.abs(pct().stamina - 0.7) < 1e-9 && Math.abs(pct().magicka - 0.2) < 1e-9, JSON.stringify(pct()));

set(P, 'percentages', { health: 0.5, stamina: 0.2, magicka: 0.1 });
tick(1000);
set(P, 'percentages', { health: 0.7, stamina: 0.4, magicka: 0.2 });
tick(1000);
// health was 0.25 after the earlier revive: 0.25 -> 0.5 keeps 0.375, then 0.375 -> 0.7 keeps 0.5375
check('healing, potions included, keeps half', Math.abs(pct().health - 0.5375) < 1e-9, pct().health);
check('stamina keeps 40% of what came back', Math.abs(pct().stamina - 0.28) < 1e-9, pct().stamina);
check('magicka keeps 70% of what came back', Math.abs(pct().magicka - 0.17) < 1e-9, pct().magicka);
set(P, 'percentages', { health: 0.3, stamina: 0.1, magicka: 0.05 });
tick(1000);
check('losses are never slowed', pct().health === 0.3 && pct().stamina === 0.1 && pct().magicka === 0.05);

const before = left();
now += 60 * 60000; // a long stall or a reload
tick(1000);
check('a long gap burns at most a few seconds', before - left() <= 5000 + 1000, before - left());

// cures
mp.onSpellHit(NOVICE, P, HEAL_OTHER);
check('a tier 1 priest cannot lift it', left() > 0 && out.banners.some(([a, t]) => a === NOVICE && /tier 2/.test(t)));
mp.onSpellHit(P, P, HEAL_OTHER);
check('nobody lifts their own chill', left() > 0);
mp.onSpellHit(PRIEST, P, HEAL_OTHER);
check("a tier 3 priest's healing lifts it", !left() && out.audits.some((t) => /lifted by Pff000002/.test(t)));

// /respawn and Grand Healing
clear(); die();
commands.respawn(P);
check('/respawn wakes at the temple with the chill', left() === 20 * 60000 && get(P, 'locationalData').cellOrWorldDesc === 'temple');
mp.onSpellCast(PRIEST, GRAND);
check('Grand Healing lifts it from those close by', !left());

// running out
clear(); die(); commands.respawn(P);
for (let i = 0; i < 20 * 60 + 5; i++) tick(1000);
check('it passes after 20 minutes of play', !left() && out.banners.some(([a, t]) => a === P && /leaves you/.test(t)));
commands.chill(P);
check('/chill says when you are free of it', /free of the chill/.test(out.personal[out.personal.length - 1][1]));

// permanent death is not a temple wake
clear(); set(P, 'private.permaDead', true); die(); commands.respawn(P);
check('a permanently dead character gets no chill', !left());

// the Active Effects marker: off by default (no Papyrus call was made above), on once the record is configured
check('with no marker configured, no ability is added or removed', !papyrus.length, JSON.stringify(papyrus));
delete require.cache[MODULE];
require(MODULE)({
  mp, log: () => {}, personal: (a, t) => out.personal.push([a, t]),
  sendPacket: (a, p) => { if (p.customPacketType === 'dboBanner') out.banners.push([a, p.text]); return true; },
  audit: (t) => out.audits.push(t), who: (a) => 'P' + (a >>> 0).toString(16), display: (a) => 'P' + (a >>> 0).toString(16),
  profileOf: (a) => Number(get(a, 'profileId')), nameOf: (a) => 'P' + (a >>> 0).toString(16),
  onlineActors: () => [P, PRIEST, NOVICE], every: (n, ms, fn) => { timers[n] = fn; },
  registerChatCommand: (n, fn) => { commands[n] = fn; }, cfg: { downed: { chillMarkerSpell: 'abcd:DragonBreak Online Edits.esp' } },
});
set(P, 'private.permaDead', false); clear(); die(); commands.respawn(P); tick(1000);
check('the chill adds the marker ability, silently', papyrus.some((c) => c[0] === 'AddSpell' && c[1] === P && c[2] === 'abcd' && c[3] === false), JSON.stringify(papyrus));
const adds = papyrus.filter((c) => c[0] === 'AddSpell').length;
tick(1000);
check('...once, not every second', papyrus.filter((c) => c[0] === 'AddSpell').length === adds);
for (let i = 0; i < 21 * 60; i++) tick(1000);
check('and takes it away when the chill passes', papyrus.some((c) => c[0] === 'RemoveSpell' && c[1] === P && c[2] === 'abcd') && !left());

Date.now = realNow;
console.log('');
console.log(failures ? `${failures} FAILURES` : 'all checks passed');
process.exit(failures ? 1 : 0);
