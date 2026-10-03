// Onny's vampire suggestion, the client batch's server half (Nate 2026-09-30). Loads the real supernatural.js and
// bloodranks.js against a stub api:
//   - Feed on a player nobody has bound asks them first, in the feedPrompt panel (widget 51); Offer Your Neck starts a
//     willing feed, Resist, closing the panel, no answer or no panel at all is a refusal, and a refusal holds 5 minutes
//   - the standing bite (Dawnguard's paired feed) goes to every client near the feed, only when feedPair is on
//   - blood on the face after a feed, by blood rank and hunger, on the character's own lips and chin tint layers,
//     washed off in water (the client's "swimming"), and gone with the curse
// node tests/vampire-consent-harness.js   (from server/)
'use strict';
const path = require('path');
const store = new Map();
const said = [], packets = [], widgets = [], closed = [], anims = [];
const timers = {}, cmds = {}, ui = {};
let online = [];
const noop = () => {};
let now = Date.UTC(2026, 8, 30, 12, 0);
Date.now = () => now;
const GAME_DAY_MS = 4 * 3600000, clockStart = now;
globalThis.__dboClock = { gameDays: () => (now - clockStart) / GAME_DAY_MS, isNight: () => true, isFullMoon: () => false, weatherFor: () => 0 };
const realRandom = Math.random;
let dice = 0;   // Math.random answers this
Math.random = () => dice;
const pending = [];
global.setTimeout = (fn, ms) => { pending.push({ at: now + ms, fn }); return pending.length; };
const DESCS = { 'e6a8:dawnguard.esm': 0x0200e6a8 };
const mp = {
  get: (id, p) => store.get(`${id}|${p}`),
  set: (id, p, v) => { store.set(`${id}|${p}`, v); },
  getDescFromId: (id) => `${id.toString(16)}:x`,
  getIdFromDesc: (d) => DESCS[String(d).toLowerCase()] || 0x1234,
  callPapyrusFunction: (kind, cls, method, self, args) => { if (method === 'SendAnimationEvent') anims.push([parseInt(String(args[0].desc), 16), args[1]]); return null; },
  lookupEspmRecordById: () => null,
};
const makeApi = (cfg) => ({
  mp, log: noop, audit: noop, personal: (a, t) => said.push({ a, t }), registerChatCommand: (n, f) => { cmds[n] = f; },
  onUi: (n, f) => { (ui[n] = ui[n] || []).push(f); }, openWidget: (a, w) => widgets.push([a, w]), closeWidget: (a, id) => closed.push([a, id]),
  display: String, who: String, sendPacket: (a, p) => { packets.push([a, p]); return true; },
  isAdmin: () => true, findByName: () => null, onlineActors: () => online, every: (n, ms, fn) => { timers[n] = fn; }, profileOf: (a) => (a < 100 ? a : -1),
  nameOf: (a) => `P${a}`, isWorldspace: () => true, needsFeed: noop, hungerOf: () => 0, cfg,
});
const load = (cfg) => {
  for (const k of Object.keys(ui)) delete ui[k];
  for (const f of ['supernatural.js', 'bloodranks.js']) delete require.cache[path.resolve(__dirname, '..', f)];
  require(path.resolve(__dirname, '..', 'supernatural.js'))(makeApi(cfg));
  require(path.resolve(__dirname, '..', 'bloodranks.js'))(makeApi(cfg));
};
const fire = (event, a, args, widgetId) => (ui[event] || []).forEach((f) => f(a, args || [], widgetId || 0));
load({});

let fail = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got).slice(0, 300)}`); if (!c) fail++; };
const V = 7, T = 8, B = 9, FAR = 10, W2 = 11;
const state = (a) => store.get(`${a}|private.supernatural`) || {};
const heard = (a, re) => said.some((s) => s.a === a && re.test(s.t));
const at = (a, x) => { store.set(`${a}|worldOrCellDesc`, 'tamriel'); store.set(`${a}|pos`, [x, 0, 0]); };
const tints = () => [
  { argb: -8824000, texturePath: 'TintMasks\\SkinTone.dds', type: 6 },
  { argb: -13424870, texturePath: 'TintMasks\\MaleHeadNord_Lips.dds', type: 1 },
  { argb: 16777215, texturePath: 'TintMasks\\MaleHeadHuman_Chin.dds', type: 11 },
  { argb: 16777215, texturePath: 'TintMasks\\MaleHeadDirt_01.dds', type: 14 },
];
for (const a of [V, T, B, FAR, W2]) {
  at(a, a === FAR ? 20000 : 0);
  store.set(`${a}|isDead`, false);
  store.set(`${a}|percentages`, { health: 1, magicka: 1, stamina: 1 });
  store.set(`${a}|appearance`, { raceId: 0x13746, isFemale: false, headpartIds: [], tints: tints() });
}
store.set(`${V}|private.supernatural`, { kind: 'vampire', stage: 3, lastFed: -1, pure: false });
store.set(`${W2}|private.supernatural`, { kind: 'vampire', stage: 1, lastFed: 0 });
online = [V, T, B, FAR, W2];
const feedTick = (ms) => { for (let t = 0; t < ms; t += 500) { now += 500; timers.superFeed(); } };
const nameFor = (viewer, x) => (x === V ? 'Stranger' : `P${x}`);
fire('uiCaps', T, ['robPrompt', 'feedPrompt']);
fire('uiCaps', V, ['feedPrompt']);   // the vampire's client can wash blood off (VampireFeedService)

// ---- the menu --------------------------------------------------------------------------------------------------
const entries = (a, t) => globalThis.__dboSuperMenuEntries(a, t).map((e) => e.id).join(',');
ok(entries(V, T) === 'super:feed', 'a Fledgling sees Feed on a free person', entries(V, T));
ok(entries(V, W2) === '', 'but not on another vampire (dead blood)');
store.set(`${B}|isDead`, true); ok(entries(V, B) === '', 'nor on the dead (E feeds on bodies)'); store.set(`${B}|isDead`, false);
store.set(`${V}|private.bloodRanks`, { blood: 300, fedOn: {} });
ok(entries(V, T) === 'super:feed,super:feedlong', 'a Nightstalker also sees Feed Deeply', entries(V, T));
store.set(`${V}|private.bloodRanks`, { blood: 0, fedOn: {} });

// ---- asking, and a willing feed ----------------------------------------------------------------------------------
globalThis.__dboSuperMenuAction(V, 'super:feed', T, nameFor);
const w = widgets.find(([a, x]) => a === T && x.type === 'feedPrompt');
ok(!!w && w[1].id === 51 && w[1].vampire === 'Stranger' && w[1].deep === false && w[1].infectPercent === 5 && w[1].seconds === 20,
  'the person is asked in the feedPrompt panel, naming the vampire as they know them', w && w[1]);
ok(heard(V, /You ask P8 for their blood\. They have 20 seconds/), 'the vampire is told they asked');
fire('feedAnswer', T, ['wrong-nonce', 'submit']);
ok(!Object.keys(store).length || globalThis.__dboSuperFeeds.size === 0, 'an answer with another nonce does nothing');
dice = 0.99;   // no infection
fire('feedAnswer', T, [w[1].nonce, 'submit']);
ok(closed.some(([a, id]) => a === T && id === 51) && heard(T, /You offer your neck/), 'Offer Your Neck closes the panel');
ok(globalThis.__dboSuperFeeds.get(V) && globalThis.__dboSuperFeeds.get(V).willing === true, 'and starts a willing feed');
ok(heard(T, /(Stranger|Someone) drinks from your neck/), 'the willing hear it gently, and an unmet vampire stays a Stranger (feed names fix)');
ok(!packets.some(([, p]) => p.customPacketType === 'dboFeedPair'), 'no standing bite while feedPair is off (the default)');
feedTick(6000);
ok(globalThis.__dboSuperFeeds.has(V), 'a willing feed holds though nobody bound them');
feedTick(6000);
ok(!globalThis.__dboSuperFeeds.has(V) && Math.abs(store.get(`${T}|percentages`).health - 0.75) < 1e-9, 'twelve seconds later the Fledgling has drunk', store.get(`${T}|percentages`));
ok(globalThis.__dboSuperMenuAction(V, 'super:feed', T, nameFor) && heard(V, /no blood left to give/), 'and the same person gives blood once a game day');

// ---- refusals -----------------------------------------------------------------------------------------------------
fire('uiCaps', B, ['feedPrompt']);
now += 61000;
widgets.length = 0;
globalThis.__dboSuperMenuAction(V, 'super:feed', B, nameFor);
const wb = widgets.find(([a]) => a === B)[1];
fire('feedAnswer', B, [wb.nonce, 'resist']);
ok(heard(V, /P9 refuses you/) && heard(B, /Be ready for a fight/) && packets.some(([a, p]) => a === V && /resists/.test(p.text || '')), 'Resist tells both, with a banner for the vampire');
now += 61000;
said.length = 0;
globalThis.__dboSuperMenuAction(V, 'super:feed', B, nameFor);
ok(heard(V, /refused you not long ago/), 'a refusal holds: asking again within 5 minutes is turned away');
now += 5 * 60000;
widgets.length = 0;
globalThis.__dboSuperMenuAction(V, 'super:feed', B, nameFor);
ok(widgets.length === 1, 'after 5 minutes they can be asked again');
said.length = 0;
now += 21000; timers.superAsk();
ok(heard(V, /does not answer\. They stand their ground/) && heard(B, /did not answer/), 'no answer in 20 s is a refusal');
now += 5 * 60000 + 61000;
widgets.length = 0;
globalThis.__dboSuperMenuAction(V, 'super:feed', B, nameFor);
said.length = 0;
fire('close', B, [], 51);
ok(heard(V, /refuses you/), 'closing the panel is a refusal');
now += 61000;
said.length = 0;
globalThis.__dboSuperMenuAction(V, 'super:feed', FAR, nameFor);
ok(heard(V, /too far from P10/), 'someone out of reach cannot be asked');
store.set(`${FAR}|pos`, [10, 0, 0]);
said.length = 0;
globalThis.__dboSuperMenuAction(V, 'super:feed', FAR, nameFor);
ok(heard(V, /P10 cannot answer you now/), 'a UI without the feedPrompt panel counts as a refusal at once');
said.length = 0;
globalThis.__dboSuperMenuAction(V, 'super:feed', FAR, nameFor);
ok(heard(V, /asked too recently|refused you not long ago/), 'and a vampire asks at most once a minute');

// ---- a bound captive is still fed on at once --------------------------------------------------------------------
now += 61000;
store.set(`${W2}|private.supernatural`, { kind: null });
store.set(`${W2}|private.restrained`, { boundHands: true });
widgets.length = 0;
globalThis.__dboSuperMenuAction(V, 'super:feed', W2, nameFor);
ok(widgets.length === 0 && globalThis.__dboSuperFeeds.has(V), 'a bound captive is not asked');
feedTick(12500);

// ---- /feedpair switches the standing bite for a staff test, until a restart --------------------------------------
now += 61000;
store.set(`${B}|percentages`, { health: 1, magicka: 1, stamina: 1 });
cmds.feedpair(V, 'on');
ok(globalThis.__dboFeedPairOn === true && heard(V, /standing feeding bite .* is ON/), '/feedpair on switches the standing bite on');
cmds.feedpair(V, 'off');
ok(globalThis.__dboFeedPairOn === false && heard(V, /is off/), '/feedpair off switches it off again');
delete globalThis.__dboFeedPairOn;

// ---- the standing bite, when switched on --------------------------------------------------------------------------
load({ supernatural: { feedPair: { enabled: true } } });
fire('uiCaps', T, ['feedPrompt']);
store.set(`${FAR}|pos`, [20000, 0, 0]);
now += GAME_DAY_MS * 2;
store.set(`${T}|percentages`, { health: 1, magicka: 1, stamina: 1 });
packets.length = 0; widgets.length = 0;
globalThis.__dboSuperMenuAction(V, 'super:feed', T, nameFor);
fire('feedAnswer', T, [widgets.find(([a]) => a === T)[1].nonce, 'submit']);
const pairs = packets.filter(([, p]) => p.customPacketType === 'dboFeedPair');
ok(pairs.length === 4 && pairs.every(([, p]) => p.feeder === V && p.victim === T && p.idle === 0x0200e6a8), 'feedPair on: the bite goes to the feeder, the victim and each client in reach', pairs.map(([a]) => a));
ok(!pairs.some(([a]) => a === FAR), 'but not to a client 20,000 units off');
feedTick(12500);

// ---- blood on the face --------------------------------------------------------------------------------------------
const lipsOf = (a) => store.get(`${a}|appearance`).tints.find((x) => x.type === 1).argb;
const chinOf = (a) => store.get(`${a}|appearance`).tints.find((x) => x.type === 11).argb;
ok(!!state(V).blood, 'a Fledgling is bloodied by every feed (odds 1), whatever the dice');
fire('swimming', V);
ok(!state(V).blood && lipsOf(V) === -13424870, 'washed before the next check');
const C2 = 12; at(C2, 0); store.set(`${C2}|isDead`, false); store.set(`${C2}|percentages`, { health: 1, magicka: 1, stamina: 1 });
store.set(`${C2}|private.restrained`, { boundHands: true }); online.push(C2);
store.set(`${V}|private.supernatural`, Object.assign({}, state(V), { stage: 3 }));
dice = 0.5; packets.length = 0;
globalThis.__dboSuperMenuAction(V, 'super:feed', C2, nameFor);
feedTick(12500);
ok(lipsOf(V) === (0xc0500808 | 0) && chinOf(V) === (0x90400606 | 0), 'a Fledgling who fed is bloody: lips and chin darkened', [lipsOf(V), chinOf(V)]);
ok(state(V).blood && state(V).blood.prev.length === 2 && packets.some(([a, p]) => a === V && p.customPacketType === 'dboBloody' && p.on === true), 'the old colours are kept, and the client watches for water');
ok(heard(V, /Blood smears your mouth and chin/), 'the vampire is told');
ok(store.get(`${V}|appearance`).tints.find((x) => x.type === 6).argb === -8824000, 'the skin tone is left alone');
said.length = 0; packets.length = 0;
fire('swimming', V);
ok(lipsOf(V) === -13424870 && chinOf(V) === 16777215 && !state(V).blood, 'water washes it off: the lips and chin are as they were');
ok(packets.some(([a, p]) => a === V && p.customPacketType === 'dboBloody' && p.on === false) && heard(V, /water runs red/), 'the client stops watching, and the vampire is told');
fire('swimming', V);
ok(said.filter((s) => /water runs red/.test(s.t)).length === 1, 'swimming with a clean face does nothing');
// Worker B's review: a face changed between the feed and the wash (RaceMenu, a reroll) must not lose the originals
const BL = 0xc0500808 | 0, BC = 0x90400606 | 0;
const bloodyWith = (prevList, tintList) => {
  store.set(`${V}|private.supernatural`, Object.assign({}, state(V), { blood: { prev: prevList, at: now } }));
  store.set(`${V}|appearance`, { raceId: 0x13746, isFemale: false, headpartIds: [], tints: tintList });
};
const P_LIPS = { texturePath: 'TintMasks\\MaleHeadNord_Lips.dds', type: 1, argb: -13424870 };
const P_CHIN = { texturePath: 'TintMasks\\MaleHeadHuman_Chin.dds', type: 11, argb: 16777215 };
bloodyWith([P_LIPS, P_CHIN], [{ texturePath: 'TintMasks\\MaleHeadImperial_Lips.dds', type: 1, argb: BL }, { texturePath: 'TintMasks\\MaleHeadHuman_Chin.dds', type: 11, argb: BC }]);
fire('swimming', V);
ok(lipsOf(V) === -13424870 && chinOf(V) === 16777215 && !state(V).blood, 'a changed lips mask still gets its original colour back (matched by type and the blood colour)');
bloodyWith([P_LIPS, P_CHIN], [{ texturePath: 'TintMasks\\FemaleHeadBreton_Lips.dds', type: 1, argb: -5000000 }, { texturePath: 'TintMasks\\FemaleHeadHuman_Chin.dds', type: 11, argb: 0 }]);
const before = JSON.stringify(store.get(`${V}|appearance`));
fire('swimming', V);
ok(!state(V).blood && JSON.stringify(store.get(`${V}|appearance`)) === before, 'a new face with no blood on it is left as it is, and the blood state ends');
bloodyWith([P_LIPS, P_CHIN], [{ texturePath: 'TintMasks\\MaleHeadNord_Lips.dds', type: 1, argb: BL }, { texturePath: 'TintMasks\\MaleHeadDirt_01.dds', type: 14, argb: BC }]);
fire('swimming', V);
ok(lipsOf(V) === -13424870 && state(V).blood && state(V).blood.prev.length === 1 && state(V).blood.prev[0].type === 11,
  'what cannot be put back while blood is still on the face is kept for the next wash, not thrown away', state(V).blood);
said.length = 0;
fire('swimming', V);
ok(!heard(V, /water runs red/), 'a partial wash does not say the water runs clear');
// Worker B: an appearance that cannot be read is not a clean face
store.set(`${V}|private.supernatural`, Object.assign({}, state(V), { blood: { prev: [P_LIPS, P_CHIN], at: now } }));
store.delete(`${V}|appearance`);
fire('swimming', V);
ok(state(V).blood && state(V).blood.prev.length === 2, 'an appearance that cannot be read keeps every original for the next wash', state(V).blood);
store.set(`${V}|appearance`, { raceId: 0x13746, isFemale: false, headpartIds: [], tints: [Object.assign({}, P_LIPS, { argb: BL }), Object.assign({}, P_CHIN, { argb: BC })] });
fire('swimming', V);
ok(!state(V).blood && lipsOf(V) === -13424870 && chinOf(V) === 16777215, 'and the next wash, with the appearance back, puts them all back');
// Worker B: the colours are the ones this blood put on, not today's config
store.set(`${V}|private.supernatural`, Object.assign({}, state(V), { blood: { prev: [Object.assign({}, P_LIPS, { applied: 0x11223344 })], at: now } }));
store.set(`${V}|appearance`, { raceId: 0x13746, isFemale: false, headpartIds: [], tints: [{ texturePath: 'TintMasks\\MaleHeadImperial_Lips.dds', type: 1, argb: 0x11223344 }, P_CHIN] });
fire('swimming', V);
ok(!state(V).blood && lipsOf(V) === -13424870, 'blood put on with an older colour still washes off after the config changed');
store.set(`${V}|private.supernatural`, Object.assign({}, state(V), { blood: null }));
store.set(`${V}|appearance`, { raceId: 0x13746, isFemale: false, headpartIds: [], tints: tints() });
// A client without the feeding service could never wash it off: no blood for it
fire('uiCaps', V, ['robPrompt']);
store.set(`${V}|private.supernatural`, Object.assign({}, state(V), { stage: 3, blood: null }));
const C4 = 19; at(C4, 0); store.set(`${C4}|isDead`, false); store.set(`${C4}|percentages`, { health: 1, magicka: 1, stamina: 1 });
store.set(`${C4}|private.restrained`, { boundHands: true }); online.push(C4);
dice = 0;
globalThis.__dboSuperMenuAction(V, 'super:feed', C4, nameFor);
feedTick(13000);
ok(!state(V).blood && lipsOf(V) === -13424870, 'a vampire on an older client (no feedPrompt) is never bloodied');
fire('uiCaps', V, ['feedPrompt']);
// Rank and hunger
const odds = (blood, stage, roll) => {
  store.set(`${V}|private.bloodRanks`, { blood, fedOn: {} });
  store.set(`${V}|private.supernatural`, Object.assign({}, state(V), { stage, blood: null }));
  store.set(`${V}|appearance`, { raceId: 0x13746, isFemale: false, headpartIds: [], tints: tints() });
  const cap = 20 + odds.n++; at(cap, 0); store.set(`${cap}|isDead`, false); store.set(`${cap}|percentages`, { health: 1, magicka: 1, stamina: 1 });
  store.set(`${cap}|private.restrained`, { boundHands: true }); online.push(cap);
  dice = roll;
  globalThis.__dboSuperMenuAction(V, 'super:feed', cap, nameFor);
  feedTick(13000);
  return !!state(V).blood;
};
odds.n = 0;
ok(odds(1500, 1, 0.01) === false, 'a well-fed Master Vampire never bloodies themselves (fed odds 0)');
ok(odds(1500, 3, 0.05) === true && odds(1500, 3, 0.2) === false, 'a hungry one does at 10%');
ok(odds(100, 1, 0.3) === true && odds(100, 1, 0.5) === false, 'a well-fed Vampire (rank 1) at 40%');
// A race with no lips or chin layer is dirtied instead
store.set(`${V}|private.bloodRanks`, { blood: 0, fedOn: {} });
store.set(`${V}|private.supernatural`, Object.assign({}, state(V), { blood: null }));
store.set(`${V}|appearance`, { raceId: 0x13740, isFemale: false, headpartIds: [], tints: [{ argb: 0, texturePath: 'TintMasks\\ArgonianDirt.dds', type: 14 }] });
cmds.curse(V, 'me bloody');
ok(store.get(`${V}|appearance`).tints[0].argb === (0x90400606 | 0), '/curse bloody: an Argonian with only a dirt layer gets the dirt darkened');
said.length = 0;
cmds.curse(V, 'me bloody');
ok(heard(V, /bloody already/), 'and bloodying twice does nothing');
globalThis.__dboSuperLogin(V);
ok(packets.filter(([a, p]) => a === V && p.customPacketType === 'dboBloody' && p.on === true).length >= 1, 'logging in bloody has the client watch for water again');
cmds.curse(V, 'me cure');
ok(!state(V).blood && store.get(`${V}|appearance`).tints[0].argb === 0, 'the cure washes the blood with the curse');

Math.random = realRandom;
console.log(fail ? `${fail} failed` : 'all checks passed');
process.exit(fail ? 1 : 0);
