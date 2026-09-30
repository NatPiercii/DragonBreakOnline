// A stage change must never leave the previous stage's drain in a vampire's hand (Onny, 2026-09-29: "temporarily lost
// vampiric drain when equipping it"). ActionListener.cpp OnUpdateEquipment strips a hand spell the server does not hold
// as learned ("stripping unlearned spell") and removes it on the client, so the order on a change has to be: learn
// the new stage's spell, put it into each hand that holds its old-stage spell (Actor.EquipSpell, aiSource 0 left,
// 1 right), and only then drop the old one. The same at login, when flushStageSpells takes stale spells back.
// Loads the real supernatural.js and records every Papyrus call it makes, in order.
// node tests/vampire-drain-swap-harness.js   (from server/)
'use strict';
const path = require('path');
const store = new Map();
const calls = [];
const timers = {};
let online = [];
const noop = () => {};
let now = Date.UTC(2026, 8, 30, 12, 0);
Date.now = () => now;
const GAME_DAY_MS = 4 * 3600000, clockStart = now;
globalThis.__dboClock = { gameDays: () => (now - clockStart) / GAME_DAY_MS, isNight: () => true, isFullMoon: () => false, weatherFor: () => 0 };
globalThis.__dboSuperState = { crown: null, revoke: [] };
const pending = [];
global.setTimeout = (fn, ms) => { pending.push({ at: now + ms, fn }); return pending.length; };
// Skyrim.esm is load order 0, so a Skyrim.esm desc's id is its local id
const idOfDesc = (d) => { const [hex, plugin] = String(d).split(':'); return /^skyrim\.esm$/i.test(plugin) ? parseInt(hex, 16) : 0x1234; };
const mp = {
  get: (id, p) => store.get(`${id}|${p}`),
  set: (id, p, v) => { store.set(`${id}|${p}`, v); },
  getDescFromId: (id) => `${(id >>> 0).toString(16)}:Skyrim.esm`,
  getIdFromDesc: idOfDesc,
  callPapyrusFunction: (kind, cls, method, self, args) => {
    if (method === 'AddSpell' || method === 'RemoveSpell' || method === 'EquipSpell') calls.push([method, idOfDesc(args[0].desc), args[1]]);
    return null;
  },
  lookupEspmRecordById: () => null,
};
const api = {
  mp, log: noop, audit: noop, personal: noop, registerChatCommand: noop, onUi: noop, openWidget: noop, closeWidget: noop,
  sendPacket: noop, display: String, who: String, isAdmin: () => true, findByName: () => null, onlineActors: () => online,
  every: (n, ms, fn) => { timers[n] = fn; }, profileOf: (a) => a, nameOf: String, isWorldspace: () => false, needsFeed: noop, hungerOf: () => 0, cfg: {},
};
require(path.resolve(__dirname, '..', 'supernatural.js'))(api);

let fail = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got)}`); if (!c) fail++; };
const hex = (x) => (x >>> 0).toString(16);
const DRAIN = [0, 0x8d5bf, 0x8d5c0, 0x8d5c1, 0x8d5c2], THRALL = [0, 0xed0a4, 0xed0a5, 0xed0a6, 0xed0a7];
const SIGHT = 0xc4de1, SEDUCTION = 0xc4de2, FLAMES = 0x12fcd;
const at = (method, id, slot) => calls.findIndex(([m, i, s]) => m === method && i === id && (slot === undefined || s === slot));
const V = 7;
store.set(`${V}|isDead`, false);
online = [V];

// ---- a stage change, the old drain in the right hand and the old thrall in the left ------------------------------
store.set(`${V}|private.supernatural`, { kind: 'vampire', stage: 1, lastFed: 0.01, pure: false, spells: [DRAIN[1], THRALL[1], SIGHT] });
store.set(`${V}|equipment`, { inv: { entries: [] }, rightSpell: DRAIN[1], leftSpell: THRALL[1] });
now = clockStart + GAME_DAY_MS * 1.1;   // a game day unfed: stage 2
calls.length = 0;
timers.superSlow();
ok((store.get(`${V}|private.supernatural`) || {}).stage === 2, 'a game day unfed: stage 2');
const learn = at('AddSpell', DRAIN[2]), equipR = at('EquipSpell', DRAIN[2], 1), dropOld = at('RemoveSpell', DRAIN[1]);
ok(learn >= 0 && dropOld >= 0 && learn < dropOld, 'the new drain is learned before the old one is dropped', calls.map(([m, i, s]) => `${m} ${hex(i)}${s !== undefined ? ' ' + s : ''}`));
ok(equipR >= 0 && equipR < dropOld, 'and put into the right hand, which held the old drain, before the old one goes', calls.map(([m, i, s]) => `${m} ${hex(i)}${s !== undefined ? ' ' + s : ''}`));
const equipL = at('EquipSpell', THRALL[2], 0);
ok(equipL >= 0 && equipL < at('RemoveSpell', THRALL[1]), "the left hand's old thrall becomes the new one the same way");
ok(at('AddSpell', SEDUCTION) >= 0 && at('EquipSpell', SEDUCTION) < 0, 'a new spell nobody held is learned, not equipped');
ok(at('EquipSpell', SIGHT) < 0 && at('RemoveSpell', SIGHT) < 0, "a spell both stages have (Vampire's Sight) is left alone");

// ---- a hand holding anything else is left alone -------------------------------------------------------------------
store.set(`${V}|private.supernatural`, { kind: 'vampire', stage: 2, lastFed: 0.01, pure: false, spells: [DRAIN[2], THRALL[2], SIGHT, SEDUCTION] });
store.set(`${V}|equipment`, { inv: { entries: [] }, rightSpell: FLAMES, leftSpell: 0 });
now = clockStart + GAME_DAY_MS * 2.1;   // stage 3
calls.length = 0;
timers.superSlow();
ok(!calls.some(([m]) => m === 'EquipSpell'), 'Flames in the right hand and an empty left hand get no drain pushed into them', calls);

// ---- login: a stale drain from an earlier stage in the hand --------------------------------------------------------
// Onny at 23:46:54: server stage 2, his client still held Drain01. flushStageSpells learns and unlearns every stage
// spell outside the current stage to take it back; the hand must get the current drain first.
store.set(`${V}|private.supernatural`, { kind: 'vampire', stage: 2, lastFed: now, pure: false, spells: [DRAIN[2], THRALL[2], SIGHT, SEDUCTION] });
store.set(`${V}|equipment`, { inv: { entries: [] }, rightSpell: DRAIN[1], leftSpell: 0 });
calls.length = 0;
globalThis.__dboSuperLogin(V);
now += 16000;
for (const p of pending.splice(0)) if (p.at <= now) p.fn();
const swap = at('EquipSpell', DRAIN[2], 1);
const take = calls.findIndex(([m, i]) => m === 'RemoveSpell' && i === DRAIN[1]);
ok(swap >= 0 && take >= 0 && swap < take, "at login the stale Drain01 in the right hand is replaced by stage 2's drain before it is taken back",
  calls.map(([m, i, s]) => `${m} ${hex(i)}${s !== undefined ? ' ' + s : ''}`));

console.log(fail ? `${fail} failed` : 'all checks passed');
process.exit(fail ? 1 : 0);
