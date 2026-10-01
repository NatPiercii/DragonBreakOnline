// Onny's vampire suggestion, the server batch (Nate 2026-09-30: game hours, no permadeath). Loads the real supernatural.js
// and bloodranks.js against a stub api and world clock, and lifts gamemode.js's needs rates and food handling:
//   - a vampire the fever turned has no gifts until the first meal, and withers after 6 game hours of play without one
//     (10% of health and stamina recovery a game hour, to 70%), counted like incubation, lifted by blood
//   - food gives a vampire a quarter, a tenth when thirsty
//   - feeding takes seconds by blood rank; it breaks when the feeder moves off or is struck, or the captive slips free
//   - Feed Deeply from Nightstalker: twice as long, faster recovery for 6 game hours, a longer thirst hold, 1.5x blood,
//     and the captive blacks out
//   - the feeding idles: the cannibal kneel on a body, the bedroll feed on a downed player, SpecialFeeding for a werewolf
// node tests/vampire-feeding-harness.js   (from server/)
'use strict';
const fs = require('fs');
const path = require('path');
const store = new Map();
const said = [], anims = [], banners = [], refreshed = [];
const timers = {}, cmds = {};
let online = [];
const noop = () => {};
let now = Date.UTC(2026, 8, 30, 12, 0);
Date.now = () => now;
// The world clock: a game day every 4 real hours
const GAME_DAY_MS = 4 * 3600000, clockStart = now;
globalThis.__dboClock = { gameDays: () => (now - clockStart) / GAME_DAY_MS, isNight: () => true, isFullMoon: () => false, weatherFor: () => 0 };
// Timers the module sets (the blackout's wake-up) run when the test says so
const pending = [];
const realSetTimeout = setTimeout;
global.setTimeout = (fn, ms) => { pending.push({ at: now + ms, fn }); return pending.length; };
const runDue = () => { for (const p of pending.splice(0)) { if (p.at <= now) p.fn(); else pending.push(p); } };
const mp = {
  get: (id, p) => store.get(`${id}|${p}`),
  set: (id, p, v) => { store.set(`${id}|${p}`, v); },
  getDescFromId: (id) => `${id.toString(16)}:x`, getIdFromDesc: () => 0x1234,
  callPapyrusFunction: (kind, cls, method, self, args) => { if (method === 'SendAnimationEvent') anims.push([parseInt(String(args[0].desc), 16), args[1]]); return null; },
  lookupEspmRecordById: () => null,
};
const api = {
  mp, log: noop, audit: noop, personal: (a, t) => said.push({ a, t }), registerChatCommand: (n, f) => { cmds[n] = f; },
  onUi: noop, openWidget: noop, closeWidget: noop, display: String, who: String,
  sendPacket: (a, p) => { if (p.customPacketType === 'dboBanner') banners.push([a, p.text, p.seconds]); return true; },
  isAdmin: () => true, findByName: () => null, onlineActors: () => online, every: (n, ms, fn) => { timers[n] = fn; }, profileOf: (a) => (a < 100 ? a : -1),
  nameOf: (a) => `P${a}`, isWorldspace: () => true, needsFeed: noop, hungerOf: () => 0, cfg: {},
};
globalThis.__dboNeedsRefresh = (a) => refreshed.push(a);
for (const f of ['supernatural.js', 'bloodranks.js']) delete require.cache[path.resolve(__dirname, '..', f)];
require(path.resolve(__dirname, '..', 'supernatural.js'))(api);
require(path.resolve(__dirname, '..', 'bloodranks.js'))(api);

let fail = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got)}`); if (!c) fail++; };
const V = 7, W = 8, CAPTIVE = 9, BODY = 10, DOWNED = 11;
const state = (a) => store.get(`${a}|private.supernatural`) || {};
const heard = (a, re) => said.some((s) => s.a === a && re.test(s.t));
const at = (a, x) => { store.set(`${a}|worldOrCellDesc`, 'tamriel'); store.set(`${a}|pos`, [x, 0, 0]); };
for (const a of [V, W, CAPTIVE, BODY, DOWNED]) { at(a, 0); store.set(`${a}|isDead`, false); store.set(`${a}|percentages`, { health: 1, magicka: 1, stamina: 1 }); }
globalThis.__dboConnectedAt = new Map([[V, now - 3600000]]);
online = [V, W, CAPTIVE, DOWNED];
// Play with one 15 s tick at a time; the feed timer runs every 500 ms
const play = (realMs) => { for (let t = 0; t < realMs; t += 15000) { now += 15000; timers.superSlow(); } };
const feedTick = (ms) => { for (let t = 0; t < ms; t += 500) { now += 500; timers.superFeed(); } };
const rate = (a, av) => globalThis.__dboSuperRateMult(a, av || 'HealRateMult');
const gameHoursPlayed = (a) => ((state(a).unfed || {}).played || 0) * 24;

// ---- the first meal ------------------------------------------------------------------------------------------
store.set(`${V}|private.supernatural`, { kind: null, disease: null });
cmds.curse(V, 'me vampire');
ok(state(V).kind === 'vampire' && state(V).unfed && state(V).unfed.played === 0, 'a vampire the fever turned starts not yet fed', state(V));
ok(Array.isArray(state(V).spells) && state(V).spells.length === 0, 'and without the vampire spells', state(V).spells);
ok(heard(V, /gifts sleep until you have fed.*6 hours/), 'and is told to find blood within 6 hours');
play(15000); play(15000);
ok(state(V).spells.length === 0, 'the stage tick does not hand the spells out while unfed', state(V).spells);
ok(globalThis.__dboSuperFoodMult(V) === 0.1, 'food gives an unfed vampire a tenth', globalThis.__dboSuperFoodMult(V));
ok(globalThis.__dboSuperFoodMult(CAPTIVE) === 1, 'and a mortal all of it');
// A game hour is 10 real minutes
play(50 * 60000);
ok(Math.abs(gameHoursPlayed(V) - 5) < 0.1 && heard(V, /hunger sharpens/), 'five game hours played: the warning', gameHoursPlayed(V));
play(10 * 60000);
ok(rate(V) === 1 && !(state(V).unfed.wither > 0), 'six game hours: no withering yet', state(V).unfed);
play(10 * 60000);
ok(rate(V) === 0.9 && rate(V, 'StaminaRateMult') === 0.9 && heard(V, /begins to wither.*10% slower/), 'seven: health and stamina recover 10% slower', rate(V));
ok(rate(V, 'MagickaRateMult') === 1, 'magicka is not the needs system\'s to set');
ok(refreshed.includes(V), 'and the needs system is asked to re-apply the rates');
online = [W, CAPTIVE, DOWNED];
now += 10 * 3600000;   // ten hours logged out
online = [V, W, CAPTIVE, DOWNED];
play(15000);
ok(rate(V) === 0.9, 'hours logged out count nothing', rate(V));
play(60 * 60000);
ok(Math.abs(rate(V) - 0.3) < 1e-9 && heard(V, /withering deepens.*70%/), 'thirteen game hours: 70%', rate(V));
play(60 * 60000);
ok(Math.abs(rate(V) - 0.3) < 1e-9, 'and never more than 70%', rate(V));
ok(heard(CAPTIVE, /stares at your throat/), 'those close by see a starving vampire\'s hunger');
said.length = 0; cmds.curse(V, 'me status');
ok(heard(V, /not yet fed \(\d+\.\d of 6 game hours played, withering 70%\)/), '/curse status shows the first-meal clock');

// ---- feeding on a body takes time, by blood rank ----------------------------------------------------------------
store.set(`${BODY}|isDead`, true);
globalThis.__dboSuperDeath(BODY, V);
anims.length = 0; banners.length = 0; refreshed.length = 0;
ok(globalThis.__dboSuperActivate(BODY, V) === true, 'E on a fresh body starts a feed (the loot window stays shut)');
ok(anims.some(([a, ev]) => a === V && ev === 'IdleCannibalFeedCrouching'), 'the feeder kneels over it (IdleCannibalFeedCrouching)', anims);
ok(banners.some(([a, t, s]) => a === V && /Feeding/.test(t) && s === 12), 'a Fledgling is told it takes 12 seconds', banners);
ok(globalThis.__dboSuperActivate(BODY, V) === true && banners.length === 1, 'a second E on the same body keeps the feed (no second feed, no loot window)', banners);
feedTick(11000);
ok(state(V).unfed, 'eleven seconds in, not yet fed');
feedTick(1000);
ok(!state(V).unfed && state(V).spells.length > 0, 'twelve seconds: fed, and the gifts wake', state(V));
ok(rate(V) === 1 && refreshed.includes(V), 'the withering lifts at once', rate(V));
ok(heard(V, /Blood, at last/), 'and says so');
ok(anims.some(([a, ev]) => a === V && ev === 'IdleForceDefaultState'), 'the feeder stands up at the end');
ok(globalThis.__dboSuperFoodMult(V) === 0.25, 'a fed vampire gets a quarter of what food gives', globalThis.__dboSuperFoodMult(V));
ok(globalThis.__dboSuperActivate(BODY, V) === false, 'a body is fed on once');

// ---- a feed breaks when the feeder moves off or is struck -----------------------------------------------------
const BODY2 = 12; at(BODY2, 0); store.set(`${BODY2}|isDead`, true); globalThis.__dboSuperDeath(BODY2, 0);
ok(globalThis.__dboSuperActivate(BODY2, V) === true, 'another body');
feedTick(2000);
at(V, 1000);
feedTick(500);
ok(heard(V, /feeding is broken: you moved away/), 'walking off breaks it');
at(V, 0);
ok(globalThis.__dboSuperActivate(BODY2, V) === true, 'and the body can be fed on again');
feedTick(1000);
store.set(`${V}|percentages`, { health: 0.8, magicka: 1, stamina: 1 });
feedTick(500);
ok(heard(V, /feeding is broken: you were struck/), 'a hit breaks it');
store.set(`${V}|percentages`, { health: 1, magicka: 1, stamina: 1 });

// ---- a downed player is fed on as a body, with the bedroll feed ----------------------------------------------
store.set(`${DOWNED}|isDead`, true); globalThis.__dboSuperDeath(DOWNED, V);
globalThis.__dboIsDowned = (a) => a === DOWNED;
anims.length = 0;
ok(globalThis.__dboSuperActivate(DOWNED, V) === true, 'E on a downed player starts a feed');
ok(anims.some(([a, ev]) => a === V && ev === 'VampireFeedingBedRollLeft'), 'bending over them (VampireFeedingBedRollLeft)', anims);
ok(heard(DOWNED, /bends over you and drinks/), 'and they are told');
feedTick(12500);
ok(store.get(`${DOWNED}|percentages`).health === 1, 'a downed player loses no blood to it');

// ---- a bound captive: Feed, and Feed Deeply from Nightstalker ------------------------------------------------
store.set(`${CAPTIVE}|private.restrained`, { boundHands: true });
const entries = () => globalThis.__dboSuperMenuEntries(V, CAPTIVE).map((e) => e.id);
ok(JSON.stringify(entries()) === '["super:feed"]', 'a Fledgling is offered Feed only', entries());
ok(globalThis.__dboSuperMenuAction(V, 'super:feedlong', CAPTIVE) === true && heard(V, /too young/), 'and refused Feed Deeply');
store.set(`${V}|private.bloodRanks`, { blood: 300, fedOn: {} });
ok(JSON.stringify(entries()) === '["super:feed","super:feedlong"]', 'a Nightstalker is offered Feed Deeply too', entries());
ok(JSON.stringify(globalThis.__dboSuperMenuEntries(V, W).map((e) => e.id)) === '["super:feed","super:feedlong"]', 'someone free is offered the same (they are asked first: vampire-consent-harness)');
anims.length = 0; banners.length = 0;
globalThis.__dboSuperMenuAction(V, 'super:feedlong', CAPTIVE);
ok(banners.some(([a, t, s]) => a === V && /deeply/.test(t) && s === 16), 'a Nightstalker\'s deep feed takes 16 seconds (8 x 2)', banners);
ok(!anims.some(([a]) => a === V), 'a standing captive gets no pose (the standing bite is a paired animation)', anims);
ok(heard(CAPTIVE, /sinks their teeth/), 'the captive is told');
feedTick(15500);
ok(store.get(`${CAPTIVE}|percentages`).health === 1, 'fifteen and a half seconds: nothing taken yet');
feedTick(500);
ok(Math.abs(store.get(`${CAPTIVE}|percentages`).health - 0.5) < 1e-9, 'sixteen: half their health taken', store.get(`${CAPTIVE}|percentages`));
ok(anims.some(([a, ev]) => a === CAPTIVE && ev === 'BleedOutStart') && heard(CAPTIVE, /world goes dark/), 'and they black out');
ok(Math.abs(rate(V) - 1.25) < 1e-9, 'a deep feed mends 25% faster', rate(V));
ok(state(V).lastFed > globalThis.__dboClock.gameDays(), 'and holds the thirst off longer', state(V).lastFed);
ok((store.get(`${V}|private.bloodRanks`) || {}).blood === 330, 'and gives 1.5x the blood (20 -> 30)', store.get(`${V}|private.bloodRanks`));
now += 20000; runDue();
ok(anims.some(([a, ev]) => a === CAPTIVE && ev === 'BleedOutStop') && heard(CAPTIVE, /come to/), 'twenty seconds later they come to');
globalThis.__dboSuperMenuAction(V, 'super:feed', CAPTIVE);
ok(heard(V, /no blood left to give/), 'a captive gives blood once a game day');
// A deep feed's lift ends after 6 game hours
play(61 * 60000);
ok(rate(V) === 1 && heard(V, /rush of the deep feed fades/), 'six game hours later the lift fades', rate(V));

// ---- a captive who slips free breaks the feed --------------------------------------------------------------
const C2 = 13; at(C2, 0); store.set(`${C2}|isDead`, false); store.set(`${C2}|percentages`, { health: 1, magicka: 1, stamina: 1 });
store.set(`${C2}|private.restrained`, { boundHands: true }); online.push(C2);
globalThis.__dboSuperMenuAction(V, 'super:feed', C2);
feedTick(2000);
store.set(`${C2}|private.restrained`, null);
feedTick(500);
ok(heard(V, /feeding is broken: they slipped free/) && store.get(`${C2}|percentages`).health === 1, 'a captive who slips free keeps their blood');

// ---- stage 3 thirst: food a tenth again --------------------------------------------------------------------
store.set(`${V}|private.supernatural`, Object.assign({}, state(V), { stage: 3 }));
ok(globalThis.__dboSuperFoodMult(V) === 0.1, 'a thirsty vampire (stage 3) gets a tenth of what food gives');

// ---- a werewolf in beast form feeds with its own idle -------------------------------------------------------
store.set(`${W}|private.supernatural`, { kind: 'werewolf' });
store.set(`${W}|private.beast`, { form: 'werewolf', until: now + 120000 });
const BODY3 = 14; at(BODY3, 0); store.set(`${BODY3}|isDead`, true); globalThis.__dboSuperDeath(BODY3, W);
anims.length = 0;
ok(globalThis.__dboSuperActivate(BODY3, W) === true, 'a werewolf in beast form starts feeding');
ok(anims.some(([a, ev]) => a === W && ev === 'SpecialFeeding'), 'with SpecialFeeding', anims);
feedTick(5000);
ok(heard(W, /The beast holds you/), 'five seconds: fed');
ok(!anims.some(([a, ev]) => a === W && ev === 'IdleForceDefaultState'), 'the werewolf graph is left to end its own idle');

// ---- pure-bloods and the cure ------------------------------------------------------------------------------
const PB = 15; at(PB, 0); store.set(`${PB}|isDead`, false); online.push(PB);
store.set(`${PB}|private.supernatural`, { kind: null });
globalThis.__dboSuperCrownHolder && cmds.curse(PB, 'me purevampire');
ok(state(PB).kind === 'vampire' && !state(PB).unfed, 'a pure-blood is fed from the start', state(PB));
store.set(`${V}|private.supernatural`, Object.assign({}, state(V), { unfed: { played: 1, wither: 0.7 } }));
cmds.curse(V, 'me cure');
ok(!state(V).kind && !state(V).unfed && rate(V) === 1, 'a cure ends the withering', state(V));

// ---- gamemode.js: the needs rates multiply in the vampire's share, and food is cut --------------------------
const gm = fs.readFileSync(path.resolve(__dirname, '..', 'gamemode.js'), 'utf8');
const lift = (from, to) => { const i = gm.indexOf(from), j = gm.indexOf(to, i); if (i < 0 || j < 0) throw new Error(`gamemode.js: ${from} not found`); return gm.slice(i, j); };
const sets = [];
const needsSrc = lift('const applyNeedsStage = ', '// downed.js asks for this');
const applyNeedsStage = new Function('globalThis', 'stageFor', 'NEEDS_AV', 'NEEDS_RATE_BASE', 'NEEDS_REAPPLY_MS', 'setActorValue', 'log', 'display', 'system',
  `${needsSrc}\nreturn applyNeedsStage;`)(
  { __dboSuperRateMult: (a, av) => (av === 'HealRateMult' ? 0.3 : 1), __dboChillRateMult: () => 0.5 },
  () => ({ name: 'Hungry', healRateMult: -50, staminaRateMult: -35 }), { staminaRateMult: 'StaminaRateMult', healRateMult: 'HealRateMult' }, 100, 600000,
  (a, av, v) => { sets.push([av, v]); return true; }, noop, String, noop);
applyNeedsStage(V, { hunger: 60, stage: '', applied: {} }, false, true);
ok(JSON.stringify(sets) === '[["StaminaRateMult",33],["HealRateMult",8]]', 'gamemode multiplies the hunger stage, the chill and the blood: (100-50) x 0.5 x 0.3 = 8', sets);
const eatSrc = lift('const vampireAteAt = ', 'const creditMeal = ');
const credited = [], ash = [];
const onEat = new Function('globalThis', 'NEEDS', 'foodKindOf', 'startMeal', 'creditMeal', 'system',
  `${eatSrc}\nreturn onEat;`)(
  { __dboSuperFoodMult: (a) => (a === V ? 0.25 : 1) }, { enabled: true, restore: { meal: 40 }, mealTime: false }, () => 'meal', () => false,
  (a, items) => credited.push([a, items[0].restore]), (a, t) => ash.push([a, t]));
onEat(V, 0x100); onEat(V, 0x100); onEat(CAPTIVE, 0x100);
ok(JSON.stringify(credited) === JSON.stringify([[V, 10], [V, 10], [CAPTIVE, 40]]), 'a vampire\'s meal counts a quarter (40 -> 10), a mortal\'s all of it', credited);
ok(ash.length === 1 && /ash/.test(ash[0][1]), 'the vampire is told once, not for every bite', ash);

global.setTimeout = realSetTimeout;
console.log(fail ? `${fail} failed` : 'all checks passed');
process.exit(fail ? 1 : 0);
