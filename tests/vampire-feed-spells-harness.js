// A meal must never leave a vampire without spells (Viggo, 2026-10-01: "vampiric drain disappears whenever i try to
// equip it"). feed() set stage 1 but synced the spells only on a first meal, so a stage 4 vampire who fed kept the stage 4
// list on record while the login flush unlearned it all, and nothing learned stage 1's: every drain he equipped was
// stripped. Also a Vampire Lord's spell left in the hands after the form (beastform.js) is taken back once, not stripped
// from every equipment update. Loads the real supernatural.js and beastform.js; learned spells are tracked from the
// AddSpell / RemoveSpell calls they make.
// node tests/vampire-feed-spells-harness.js   (from server/)
'use strict';
const path = require('path');
const store = new Map();
const learned = new Map();   // actor -> Set of learned spell ids
const calls = [], logs = [];
const timers = {};
let online = [];
const noop = () => {};
let now = Date.UTC(2026, 9, 1, 18, 0);
Date.now = () => now;
const GAME_DAY_MS = 4 * 3600000, clockStart = now;
globalThis.__dboClock = { gameDays: () => (now - clockStart) / GAME_DAY_MS, isNight: () => true, isFullMoon: () => false, weatherFor: () => 0 };
globalThis.__dboSuperState = { crown: null, revoke: [] };
let pending = [];
global.setTimeout = (fn, ms) => { pending.push({ at: now + (Number(ms) || 0), fn }); return pending.length; };
const runDue = () => { const due = pending.filter((p) => p.at <= now); pending = pending.filter((p) => p.at > now); due.forEach((p) => p.fn()); };
const idOfDesc = (d) => { const [hex, plugin] = String(d).split(':'); return /^skyrim\.esm$/i.test(plugin) ? parseInt(hex, 16) : /^dawnguard\.esm$/i.test(plugin) ? (0x02000000 | parseInt(hex, 16)) >>> 0 : 0x1234; };
const descOf = (id) => ((id >>> 24) === 2 ? `${(id & 0xffffff).toString(16)}:Dawnguard.esm` : `${(id >>> 0).toString(16)}:Skyrim.esm`);
const mp = {
  get: (id, p) => store.get(`${id}|${p}`),
  set: (id, p, v) => { store.set(`${id}|${p}`, v); },
  getDescFromId: descOf,
  getIdFromDesc: idOfDesc,
  callPapyrusFunction: (kind, cls, method, self, args) => {
    const a = self && self.desc ? parseInt(String(self.desc).split(':')[0], 16) >>> 0 : 0;
    if (method === 'AddSpell' || method === 'RemoveSpell' || method === 'EquipSpell') {
      const id = idOfDesc(args[0].desc);
      calls.push([method, id, a]);
      const set = learned.get(a) || new Set(); learned.set(a, set);
      if (method === 'AddSpell') set.add(id);
      if (method === 'RemoveSpell') set.delete(id);
      if (method === 'EquipSpell') { set.add(id); const eq = store.get(`${a}|equipment`) || {}; eq[args[1] === 0 ? 'leftSpell' : 'rightSpell'] = id; store.set(`${a}|equipment`, eq); }
    }
    return null;
  },
  lookupEspmRecordById: () => null,
};
const api = {
  mp, log: (...x) => logs.push(x.join(' ')), audit: noop, personal: noop, registerChatCommand: noop, onUi: noop, openWidget: noop, closeWidget: noop,
  sendPacket: noop, display: String, who: String, isAdmin: () => true, findByName: () => null, onlineActors: () => online,
  every: (n, ms, fn) => { timers[n] = fn; }, profileOf: (a) => (a < 0xff000100 ? 1 : -1), nameOf: String, isWorldspace: () => true, needsFeed: noop, hungerOf: () => 0, cfg: {},
  redress: noop, findAnyByName: () => 0,
};
for (const f of ['supernatural.js', 'beastform.js']) delete require.cache[path.resolve(__dirname, '..', f)];
require(path.resolve(__dirname, '..', 'supernatural.js'))(api);
require(path.resolve(__dirname, '..', 'beastform.js'))(api);

let fail = 0, pass = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got)}`); if (c) pass++; else fail++; };
const hex = (x) => (x >>> 0).toString(16);
const DRAIN = [0, 0x8d5bf, 0x8d5c0, 0x8d5c1, 0x8d5c2], THRALL = [0, 0xed0a4, 0xed0a5, 0xed0a6, 0xed0a7];
const SIGHT = 0xc4de1, SEDUCTION = 0xc4de2, EMBRACE = 0x88821;
const STAGE1 = [DRAIN[1], THRALL[1], SIGHT], STAGE4 = [DRAIN[4], THRALL[4], SIGHT, SEDUCTION, EMBRACE];
const V = 0xff000007, BODY = 0xff00000a;
const state = () => store.get(`${V}|private.supernatural`) || {};
const holds = (ids) => ids.every((id) => (learned.get(V) || new Set()).has(id));
const holdsNone = (ids) => ids.every((id) => !(learned.get(V) || new Set()).has(id));
const place = (a) => { store.set(`${a}|worldOrCellDesc`, 'tamriel'); store.set(`${a}|pos`, [0, 0, 0]); store.set(`${a}|percentages`, { health: 1, magicka: 1, stamina: 1 }); };
place(V); place(BODY);
store.set(`${V}|isDead`, false);
globalThis.__dboConnectedAt = new Map([[V, now - 3600000]]);
online = [V];
const feedTick = (ms) => { for (let t = 0; t < ms; t += 500) { now += 500; timers.superFeed(); runDue(); } };
const feedOnABody = () => {
  store.set(`${BODY}|isDead`, true);
  globalThis.__dboSuperDeath(BODY, V);
  ok(globalThis.__dboSuperActivate(BODY, V) === true, 'the feed starts');
  feedTick(31000);
};

// ---- 1. stage 4, a meal: stage 1's spells learned and in hand, stage 4's gone ----------------------------------------
store.set(`${V}|private.supernatural`, { kind: 'vampire', stage: 4, lastFed: 0, pure: true, spells: STAGE4.slice() });
learned.set(V, new Set(STAGE4));
store.set(`${V}|equipment`, { inv: { entries: [] }, rightSpell: DRAIN[4], leftSpell: 0 });
now = clockStart + GAME_DAY_MS * 3.5;
feedOnABody();
ok(state().stage === 1, 'a meal brings the thirst back to stage 1', state().stage);
ok(holds(STAGE1), 'stage 1\'s spells are learned', [...(learned.get(V) || [])].map(hex));
ok(holdsNone([DRAIN[4], THRALL[4], SEDUCTION, EMBRACE]), 'stage 4\'s are unlearned', [...(learned.get(V) || [])].map(hex));
ok((store.get(`${V}|equipment`) || {}).rightSpell === DRAIN[1], 'the drain in the right hand is now Drain 01', hex((store.get(`${V}|equipment`) || {}).rightSpell));
ok(JSON.stringify(state().spells.slice().sort()) === JSON.stringify(STAGE1.slice().sort()), 'the record lists stage 1', state().spells.map(hex));

// ---- 2. ...and the login flush after it leaves them ------------------------------------------------------------------
globalThis.__dboSuperLogin(V);
now += 16000; runDue();
ok(holds(STAGE1), 'after a relog\'s flush stage 1\'s spells are still learned', [...(learned.get(V) || [])].map(hex));

// ---- 3. Viggo's exact state: stage 1 on record with the stage 4 list, nothing learned --------------------------------
now += 90000;   // past the login settle window (vampireSpellSettleSeconds)
store.set(`${V}|private.supernatural`, { kind: 'vampire', stage: 1, lastFed: (now - clockStart) / GAME_DAY_MS, pure: true, spells: STAGE4.slice() });
learned.set(V, new Set());
store.set(`${V}|equipment`, { inv: { entries: [] }, rightSpell: 0, leftSpell: 0 });
timers.superSlow();
ok(holds(STAGE1), 'a drifted record is repaired by the next tick: stage 1\'s spells learned', [...(learned.get(V) || [])].map(hex));
ok(JSON.stringify(state().spells.slice().sort()) === JSON.stringify(STAGE1.slice().sort()), '...and the record set right', state().spells.map(hex));
calls.length = 0;
timers.superSlow();
ok(!calls.length, 'a record that matches makes no Papyrus calls on the next tick', calls.map(([m, i]) => `${m} ${hex(i)}`));

// ---- 4. a first meal still wakes the gifts ---------------------------------------------------------------------------
const W = 0xff000008, BODY2 = 0xff00000b;
place(W); place(BODY2); store.set(`${W}|isDead`, false); online = [V, W];
store.set(`${W}|private.supernatural`, { kind: 'vampire', stage: 1, lastFed: (now - clockStart) / GAME_DAY_MS, pure: false, unfed: { played: 0, wither: 0 }, spells: [] });
store.set(`${BODY2}|isDead`, true);
globalThis.__dboSuperDeath(BODY2, W);
globalThis.__dboSuperActivate(BODY2, W);
for (let t = 0; t < 31000; t += 500) { now += 500; timers.superFeed(); runDue(); }
const ws = store.get(`${W}|private.supernatural`) || {};
ok(!ws.unfed && STAGE1.every((id) => (learned.get(W) || new Set()).has(id)), 'a turned vampire\'s first meal wakes the stage 1 gifts, as before', ws);

// ---- 5. a Vampire Lord spell left in the hands after the form: taken back once, quietly ------------------------------
const RAISE_DEAD = 0x02013ecb;
store.set(`${V}|private.beast`, null);
calls.length = 0; logs.length = 0;
for (let i = 0; i < 26; i++) globalThis.__dboBeastStaleSpells(V, { leftSpell: RAISE_DEAD, rightSpell: DRAIN[1] });
const took = calls.filter(([m, id]) => id === RAISE_DEAD);
ok(took.length === 2 && took[0][0] === 'AddSpell' && took[1][0] === 'RemoveSpell', 'Raise Dead held after the form is learned and unlearned once (the removal reaches the client)', took.map(([m]) => m));
ok(logs.filter((l) => /took 2013ecb back out of/.test(l)).length === 1, 'one log line for it, not one per equipment update', logs);
ok(!calls.some(([, id]) => id === DRAIN[1]), 'the vampire\'s own drain in the other hand is left alone');
store.set(`${0xff000009}|private.beast`, { form: 'vampirelord', original: { raceId: 1 } });
calls.length = 0;
globalThis.__dboBeastStaleSpells(0xff000009, { leftSpell: RAISE_DEAD });
ok(!calls.length, 'a Vampire Lord still in the form keeps his spells');

console.log(fail ? `\n${fail} FAILED` : `\nall ${pass} checks passed`);
process.exit(fail ? 1 : 0);
