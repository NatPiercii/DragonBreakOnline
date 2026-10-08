// A vampire's tells and an appearance edit (supernatural.js __dboTellsRetake, called by appearance.js after a saved edit).
// The tells keep the eyes, skin colour and skin tone they hide (s.look) and give them back on a feed. Before the retake an
// edit saved while they showed was undone by the next feed (Selena #PXVM, 5 Oct), and one that changed the eyes had the
// tells laid over again with the pale skin taken as the mortal one. Loads the real supernatural.js and appearance.js
// against one stub world: a Dark Elf woman turned vampire (DarkElfRaceVampire 8883d), her eyes from her saved look.
//   node tests/super-tells-retake-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'super-tells-retake-'));
process.chdir(dir);
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });

let fails = 0;
const ok = (c, label, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${label}${c || got === undefined ? '' : '   ' + JSON.stringify(got)}`); if (!c) fails++; };

const P = 0xff000222;
const store = new Map();
const said = [];
const ticks = new Map();
const cmds = new Map();
const timers = [];
// Eye head parts (HDPT PNAM 2): her own (210053e1), the one she picks (2006f90), the vampire tell eyes for an elf woman
// (7291e), the werewolf's (401a7)
const EYES = new Set([0x210053e1, 0x2006f90, 0x7291e, 0x401a7, 0xe7aeb, 0x2425e]);
const u32le = (n) => new Uint8Array(new Uint32Array([n]).buffer);
const mp = {
  get: (id, k) => store.get(`${id}|${k}`),
  set: (id, k, v) => { store.set(`${id}|${k}`, v); },
  getIdFromDesc: (desc) => parseInt(String(desc).split(':')[0], 16) >>> 0,
  getDescFromId: (id) => `${(id >>> 0).toString(16)}:Skyrim.esm`,
  callPapyrusFunction: () => null,
  lookupEspmRecordById: (id) => ({ record: { type: 'HDPT', fields: EYES.has(id >>> 0) ? [{ type: 'PNAM', data: u32le(2) }] : [] }, toGlobalRecordId: (l) => l }),
  setRaceMenuOpen: () => {},
  getUserByActor: () => 3,
};
const noop = () => {};
const api = {
  mp, log: noop, audit: noop, personal: (a, t) => said.push(t), system: (a, t) => said.push(t),
  registerChatCommand: (n, f) => cmds.set(n, f), onUi: noop, openWidget: noop, closeWidget: noop, sendPacket: noop,
  display: () => 'Velra', who: () => 'Velra', isAdmin: () => false, findByName: () => 0, onlineActors: () => [P],
  every: (name, ms, fn) => ticks.set(name, fn), profileOf: () => 7, nameOf: () => 'Velra', isWorldspace: () => false,
  needsFeed: noop, hungerOf: () => 0, hasUiCap: () => false, sourceResistsOf: () => new Set(),
  cfg: { appearance: { cost: 500, cooldownHours: 24 } }, userOf: () => 3, later: (fn, ms) => timers.push({ fn, ms }),
};
require(path.join(ROOT, 'supernatural.js'))(api);
require(path.join(ROOT, 'appearance.js'))(api);
ok(typeof globalThis.__dboTellsRetake === 'function', 'supernatural.js exports __dboTellsRetake');

const SP = 'private.supernatural';
const OWN_EYE = 0x210053e1, NEW_EYE = 0x2006f90, TELL = 0x7291e;
const TONE = 'Actors\\Character\\Character Assets\\TintMasks\\SkinTone.dds';
const TONE_ARGB = -4337957;
const mortal = () => ({ raceId: 0x8883d, isFemale: true, name: 'Velra', weight: 100, skinColor: 6189428, hairColor: 2, headTextureSetId: 3,
  headpartIds: [0x5150f, 0x5161c, 0xec1b2, OWN_EYE, 0xe4d7c], options: [0], presets: [0],
  tints: [{ argb: TONE_ARGB, texturePath: TONE, type: 6 }, { argb: 16777215, texturePath: 'Actors\\Character\\Character Assets\\TintMasks\\FemaleUpperEyeSocket.dds', type: 4 }] });
const PALE = [0xe8, 0xe6, 0xec];
const blend = (rgb, t) => [16, 8, 0].reduce((acc, sh, i) => acc | (Math.round(((rgb >> sh) & 0xff) * (1 - t) + PALE[i] * t) << sh), 0);
const pale = (rgb) => blend(Number(rgb) >>> 0, 0.55);
const toneOf = (x) => Number(x.tints.find((t) => /SkinTone/.test(t.texturePath)).argb) >>> 0;
const paleTone = (argb) => (((argb >>> 0) & 0xff000000) | pale((argb >>> 0) & 0xffffff)) >>> 0;
const look = () => store.get(`${P}|appearance`);
const state = () => store.get(`${P}|${SP}`);
const day = () => Date.now() / 86400000 * 6;
const vampire = (stage) => store.set(`${P}|${SP}`, { kind: 'vampire', disease: null, stage, lastFed: stage >= 3 ? day() - 2.5 : day(), pure: false, blessed: false, beastDay: -1, unfed: null, sated: null, spells: [] });
const tick = () => ticks.get('superSlow')();
const feed = () => { const s = state(); s.lastFed = day(); store.set(`${P}|${SP}`, s); tick(); };
const thirst = () => { const s = state(); s.lastFed = day() - 2.5; store.set(`${P}|${SP}`, s); tick(); };
// /appearance, the editor closing with `after` (the engine stores it first), as gamemode.js's hook runs it
const appearance = (edit) => {
  store.set(`${P}|inventory`, { entries: [{ baseId: 0xf, count: 800 }] });
  store.set(`${P}|private.dboAppearanceAt`, 0);
  cmds.get('appearance')(P, '');
  const after = edit(JSON.parse(JSON.stringify(look())));
  store.set(`${P}|appearance`, JSON.parse(JSON.stringify(after)));
  return globalThis.__dboAppearanceEdit.finish(P, after);
};
const fresh = (stage) => { store.clear(); timers.length = 0; said.length = 0; store.set(`${P}|appearance`, mortal()); vampire(stage); };

// 1. The tells show at stage 3
fresh(3); tick();
ok(look().headpartIds.includes(TELL) && !look().headpartIds.includes(OWN_EYE) && look().skinColor === pale(6189428) && toneOf(look()) === paleTone(TONE_ARGB), 'stage 3: the tell eyes and the pallor show');
ok(state().look && state().look.prevEye === OWN_EYE && state().look.prevSkin === 6189428, 'what they hide is kept');

// 2. Edited while they show: new eyes and a new skin colour, paid; then a feed
appearance((x) => Object.assign(x, { skinColor: 0x88b1c6, headpartIds: x.headpartIds.map((h) => (h === TELL ? NEW_EYE : h)) }));
ok(/new look is saved/.test(said.at(-1) || ''), 'the edit is saved', said.at(-1));
ok(look().headpartIds.includes(TELL) && look().skinColor === pale(0x88b1c6), 'the tells go straight back over the new look (one pallor, on the new skin)', look().skinColor.toString(16));
ok(state().look.prevEye === NEW_EYE && state().look.prevSkin === 0x88b1c6 && (Number(state().look.prevTone) >>> 0) === (TONE_ARGB >>> 0), 'the new eyes and skin are what the tells hide now, the untouched tone stays the old one', state().look);
ok(timers.length === 1 && timers[0].ms === 3500, 'the look with the tells is sent again after the settle window');
feed();
ok(look().headpartIds.includes(NEW_EYE) && !look().headpartIds.includes(TELL) && look().skinColor === 0x88b1c6 && toneOf(look()) === (TONE_ARGB >>> 0), 'after a feed: her new eyes and new skin, not the look from before the edit', { eyes: look().headpartIds.map((h) => h.toString(16)), skin: look().skinColor.toString(16) });

// 3. Edited while they show, the tell eyes left alone and only the skin changed: the old eyes stay what they hide
fresh(3); tick();
appearance((x) => Object.assign(x, { skinColor: 0x405060 }));
ok(state().look.prevEye === OWN_EYE && state().look.prevSkin === 0x405060 && look().skinColor === pale(0x405060), 'skin changed, tell eyes untouched: her own eyes stay kept, the new skin under the pallor', state().look);
feed();
ok(look().headpartIds.includes(OWN_EYE) && look().skinColor === 0x405060, 'after a feed: her own eyes and the new skin');

// 4. Edited while they show, nothing the tells touch changed (the hair): no double pallor, the kept look unchanged
fresh(3); tick();
const shown = JSON.parse(JSON.stringify(look()));
appearance((x) => Object.assign(x, { hairColor: 9 }));
ok(look().skinColor === shown.skinColor && toneOf(look()) === toneOf(shown) && look().headpartIds.includes(TELL) && look().hairColor === 9, 'hair only: the same tells, no second pallor', look().skinColor.toString(16));
ok(state().look.prevEye === OWN_EYE && state().look.prevSkin === 6189428 && (Number(state().look.prevTone) >>> 0) === (TONE_ARGB >>> 0), 'what they hide is still her own look', state().look);
feed();
ok(look().skinColor === 6189428 && look().headpartIds.includes(OWN_EYE) && look().hairColor === 9, 'after a feed: her own skin and eyes, the new hair');

// 5. The tone changed in the edit
fresh(3); tick();
appearance((x) => Object.assign(x, { tints: x.tints.map((t) => (/SkinTone/.test(t.texturePath) ? Object.assign({}, t, { argb: 0xff336699 | 0 }) : t)) }));
ok((Number(state().look.prevTone) >>> 0) === 0xff336699 && toneOf(look()) === paleTone(0xff336699), 'a new skin tone is kept under the pallor');
feed();
ok(toneOf(look()) === 0xff336699, 'and given back by a feed');

// 6. Edited before the tells appear: the chosen eyes are what they hide when they come
fresh(1); tick();
ok(!state().look && look().headpartIds.includes(OWN_EYE), 'stage 1: no tells');
appearance((x) => Object.assign(x, { headpartIds: x.headpartIds.map((h) => (h === OWN_EYE ? NEW_EYE : h)) }));
ok(!state().look && look().headpartIds.includes(NEW_EYE) && timers.length === 0, 'the edit is saved as made; nothing to lay, nothing to send again');
thirst();
ok(look().headpartIds.includes(TELL) && state().look.prevEye === NEW_EYE && state().look.prevSkin === 6189428, 'when the thirst shows, the chosen eyes are what the tells hide', state().look);
feed();
ok(look().headpartIds.includes(NEW_EYE), 'and a feed gives back the chosen eyes');

// 7. Edited when the tells are due but not laid yet (between ticks): laid at once over the new look
fresh(3);
appearance((x) => Object.assign(x, { headpartIds: x.headpartIds.map((h) => (h === OWN_EYE ? NEW_EYE : h)) }));
ok(look().headpartIds.includes(TELL) && state().look.prevEye === NEW_EYE && look().skinColor === pale(6189428), 'due but not shown: laid now, over the chosen eyes', state().look);

// 8. Without the look before (a caller that has none): unchanged pallor still counts as unchanged
fresh(3); tick();
store.set(`${P}|appearance`, Object.assign(JSON.parse(JSON.stringify(look())), { hairColor: 5 }));
ok(globalThis.__dboTellsRetake(P) === true && look().skinColor === pale(6189428) && state().look.prevSkin === 6189428, 'no look before: the pallor is recognised, the kept skin stays');

// 9. A werewolf: the eyes only
fresh(1); store.set(`${P}|${SP}`, { kind: 'werewolf', disease: null, stage: 0, beastDay: -1 }); tick();
ok(look().headpartIds.includes(0x401a7) && state().look.prevEye === OWN_EYE && state().look.prevSkin === undefined, 'a werewolf shows gold eyes, the skin is untouched');
appearance((x) => Object.assign(x, { skinColor: 0x405060, headpartIds: x.headpartIds.map((h) => (h === 0x401a7 ? NEW_EYE : h)) }));
ok(look().headpartIds.includes(0x401a7) && state().look.prevEye === NEW_EYE && look().skinColor === 0x405060, 'a werewolf\'s edit: new eyes under the gold, the new skin as chosen', state().look);

// 10. Nothing to do: no curse, or a beast form
fresh(1); store.set(`${P}|${SP}`, { kind: null });
ok(globalThis.__dboTellsRetake(P, mortal()) === false, 'no curse: nothing taken');
fresh(3); tick(); store.set(`${P}|private.beast`, { form: 'werewolf' });
const before = JSON.stringify(look());
ok(globalThis.__dboTellsRetake(P, mortal()) === false && JSON.stringify(look()) === before, 'in a beast form: nothing touched');

// 11. supernatural.js keeps the rest as it was: the slow tick still lays and clears the tells by itself
fresh(3); tick(); const laid = JSON.stringify(look()); tick();
ok(JSON.stringify(look()) === laid, 'a second tick changes nothing (idempotent)');
feed();
ok(JSON.stringify(look()) === JSON.stringify(mortal()), 'a feed gives back exactly the look the tells hid');

// 12. The slow tick leaves the tells alone while the editor is open (review, 8 Oct). A feed that landed then cleared them on
// the server while the client, its menu open, kept them; the editor handed the tells back, they were saved as her own look,
// and no later feed or cure could take them off.
const openEditor = () => {
  store.set(`${P}|inventory`, { entries: [{ baseId: 0xf, count: 800 }] });
  store.set(`${P}|private.dboAppearanceAt`, 0);
  cmds.get('appearance')(P, '');
  return JSON.parse(JSON.stringify(look()));
};
const closeEditor = (after) => { store.set(`${P}|appearance`, JSON.parse(JSON.stringify(after))); return globalThis.__dboAppearanceEdit.finish(P, after); };
fresh(3); tick();
const onOpen = openEditor();
feed();
ok(look().headpartIds.includes(TELL) && state().look && state().look.prevEye === OWN_EYE, 'fed with the editor open: the tick leaves the tells and what they hide as they are');
closeEditor(Object.assign(JSON.parse(JSON.stringify(onOpen)), { hairColor: 9 }));
ok(look().headpartIds.includes(OWN_EYE) && !look().headpartIds.includes(TELL) && look().skinColor === 6189428 && toneOf(look()) === (TONE_ARGB >>> 0) && look().hairColor === 9 && !state().look,
  'the close (the tells handed back, the hair changed): fed, so her own eyes, skin and tone under the new hair', { eyes: look().headpartIds.map((h) => h.toString(16)), skin: look().skinColor.toString(16) });
thirst(); feed();
ok(look().headpartIds.includes(OWN_EYE) && !look().headpartIds.includes(TELL) && look().skinColor === 6189428, 'a later thirst and feed: her own eyes again, the tell eyes never kept as hers');
// The thirst rising while it is open: nothing laid till the close, then laid over the new look
fresh(1); tick();
openEditor();
thirst();
ok(!state().look && look().headpartIds.includes(OWN_EYE), 'thirst with the editor open: no tells laid yet');
closeEditor(Object.assign(JSON.parse(JSON.stringify(look())), { headpartIds: look().headpartIds.map((h) => (h === OWN_EYE ? NEW_EYE : h)) }));
ok(look().headpartIds.includes(TELL) && state().look && state().look.prevEye === NEW_EYE && look().skinColor === pale(6189428), 'the close: the tells laid over the eyes she chose');
tick();
ok(look().headpartIds.includes(TELL) && state().look.prevEye === NEW_EYE, 'and the next tick leaves it so');

// 13. Blood on her face (applyBlood keeps the lip and chin colours from before it, a wash puts them back): a layer she
// recoloured in the editor is hers, so the wash leaves it (review, 8 Oct); one she left keeps its blood till washed
const LIPS = 'Actors\\Character\\Character Assets\\TintMasks\\FemaleLips.dds';
const CHIN = 'Actors\\Character\\Character Assets\\TintMasks\\FemaleChin.dds';
const LIP0 = 0x40b06070 | 0, CHIN0 = 0x10203040, MINE = 0x80aa3355 | 0;
const tintOf = (type) => look().tints.find((t) => t.type === type).argb | 0;
const bloody = () => {
  fresh(1); tick();
  globalThis.__dboSuperAsk.caps.set(P, new Set(['feedPrompt']));
  store.set(`${P}|appearance`, Object.assign(look(), { tints: look().tints.concat([{ argb: LIP0, texturePath: LIPS, type: 1 }, { argb: CHIN0, texturePath: CHIN, type: 11 }]) }));
  cmds.get('curse')(P, 'me bloody');
};
bloody();
ok(state().blood && state().blood.prev.length === 2 && tintOf(1) !== LIP0 && tintOf(11) !== CHIN0, 'the blood is on her lips and chin');
appearance((x) => Object.assign(x, { tints: x.tints.map((t) => (t.type === 1 ? Object.assign({}, t, { argb: MINE }) : t)) }));
ok(/new look is saved/.test(said.at(-1) || '') && state().blood && state().blood.prev.length === 1 && state().blood.prev[0].type === 11, 'lips recoloured in the editor: only the chin is left to wash', state().blood);
cmds.get('curse')(P, 'me wash');
ok(tintOf(1) === MINE && tintOf(11) === CHIN0 && !state().blood, 'the wash: her new lip colour stays, the chin comes clean', { lips: tintOf(1).toString(16), chin: tintOf(11).toString(16) });
bloody();
appearance((x) => Object.assign(x, { hairColor: 9 }));
ok(state().blood && state().blood.prev.length === 2, 'an edit that leaves the blood: both layers still to wash');
cmds.get('curse')(P, 'me wash');
ok(tintOf(1) === LIP0 && tintOf(11) === CHIN0 && look().hairColor === 9, 'and the wash takes it all off, the new hair kept');
bloody();
appearance((x) => Object.assign(x, { tints: x.tints.map((t) => (t.type === 1 || t.type === 11 ? Object.assign({}, t, { argb: MINE }) : t)) }));
ok(!state().blood && tintOf(1) === MINE && tintOf(11) === MINE, 'both recoloured: no blood left, the blood state ends with her colours on');

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
