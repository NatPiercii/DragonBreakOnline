// A vampire's client that still holds a stage spell the server took back must get this stage's spell in that hand
// (Donn #TR28, 8 Oct 01:53: Drain02 stripped from his hand after a meal at stage 2; Fabian #SJ2E, 7 Oct 17:43-17:50:
// Drain04 stripped four times after a meal at stage 4). The strip empties the hand the server stores, and swapHands
// reads only that, so no later stage change or meal ever swapped the hand the client really had.
// Loads the real supernatural.js against a stub server (AddSpell / RemoveSpell sent only on a change, as
// PapyrusActor.cpp) and a stub client.
// node tests/vampire-stale-hand-harness.js   (from server/)
'use strict';
const path = require('path');
const store = new Map();
const learned = new Map();          // actor -> the server's learned spells
const clients = new Map();          // actor -> { spells, left, right }
const calls = [], logs = [];
const timers = {};
const noop = () => {};
let now = Date.UTC(2026, 9, 8, 2, 0);
Date.now = () => now;
const GAME_DAY_MS = 4 * 3600000, clockStart = now - GAME_DAY_MS * 10;
globalThis.__dboClock = { gameDays: () => (now - clockStart) / GAME_DAY_MS, isNight: () => true, isFullMoon: () => false, weatherFor: () => 0 };
globalThis.__dboSuperState = { crown: null, revoke: [] };
let pending = [];
global.setTimeout = (fn, ms) => { pending.push({ at: now + (Number(ms) || 0), fn }); return pending.length; };
const runDue = () => { const due = pending.filter((p) => p.at <= now); pending = pending.filter((p) => p.at > now); due.forEach((p) => p.fn()); };
const idOfDesc = (d) => { const [hex, plugin] = String(d).split(':'); return /^skyrim\.esm$/i.test(plugin) ? parseInt(hex, 16) : 0x1234; };
const descOf = (id) => `${(id >>> 0).toString(16)}:Skyrim.esm`;
const clientOf = (a) => { if (!clients.has(a)) clients.set(a, { spells: new Set(), left: 0, right: 0 }); return clients.get(a); };
const learnedOf = (a) => { if (!learned.has(a)) learned.set(a, new Set()); return learned.get(a); };
const mp = {
  get: (id, p) => store.get(`${id}|${p}`),
  set: (id, p, v) => { store.set(`${id}|${p}`, v); },
  getDescFromId: descOf,
  getIdFromDesc: idOfDesc,
  callPapyrusFunction: (kind, cls, method, self, args) => {
    const a = parseInt(String(self.desc).split(':')[0], 16) >>> 0;
    const id = idOfDesc(args[0].desc);
    const srv = learnedOf(a), c = clientOf(a);
    calls.push([method, id, a]);
    if (method === 'AddSpell' && !srv.has(id)) { srv.add(id); c.spells.add(id); }
    if (method === 'RemoveSpell' && srv.has(id)) { srv.delete(id); c.spells.delete(id); }
    if (method === 'EquipSpell') { srv.add(id); c.spells.add(id); if (args[1] === 0) c.left = id; else c.right = id; }
    return null;
  },
  lookupEspmRecordById: () => null,
};
const online = [];
const api = {
  mp, log: (...x) => logs.push(x.join(' ')), audit: noop, personal: noop, registerChatCommand: noop, onUi: noop, openWidget: noop, closeWidget: noop,
  sendPacket: noop, display: (a) => `#${(a >>> 0).toString(16)}`, who: String, isAdmin: () => false, findByName: () => null, onlineActors: () => online,
  every: (n, ms, fn) => { timers[n] = fn; }, profileOf: () => 1, nameOf: String, isWorldspace: () => true, needsFeed: noop, hungerOf: () => 0, cfg: {},
  redress: noop, findAnyByName: () => 0,
};
const MODULE = path.resolve(__dirname, '..', 'supernatural.js');
const load = () => { delete require.cache[MODULE]; require(MODULE)(api); };
load();

let fail = 0, pass = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got)}`); if (c) pass++; else fail++; };
const hex = (x) => (x >>> 0).toString(16);
const DRAIN = [0, 0x8d5bf, 0x8d5c0, 0x8d5c1, 0x8d5c2], THRALL = [0, 0xed0a4, 0xed0a5, 0xed0a6, 0xed0a7];
const SIGHT = 0xc4de1, SEDUCTION = 0xc4de2;
const STAGE1 = [DRAIN[1], THRALL[1], SIGHT], STAGE2 = [DRAIN[2], THRALL[2], SIGHT, SEDUCTION];
const day = () => (now - clockStart) / GAME_DAY_MS;
// The client reports its hands; the server strips what it has not learned and stores the rest, as ActionListener.cpp
const report = (a) => {
  const c = clientOf(a);
  const eq = { inv: { entries: [] }, leftSpell: c.left, rightSpell: c.right };
  globalThis.__dboSuperEquipSeen(a, eq);
  const stored = { inv: { entries: [] }, leftSpell: 0, rightSpell: 0 }, stripped = [];
  for (const k of ['leftSpell', 'rightSpell']) { if (eq[k] && !learnedOf(a).has(eq[k])) stripped.push(hex(eq[k])); else stored[k] = eq[k]; }
  store.set(`${a}|equipment`, stored);
  return stripped;
};
const wait = (ms) => { for (let t = 0; t < ms; t += 250) { now += 250; runDue(); } };
const setup = (a, rec, serverSpells, clientSpells, left, right) => {
  online.push(a);
  store.set(`${a}|isDead`, false);
  store.set(`${a}|private.supernatural`, rec);
  learned.set(a, new Set(serverSpells));
  clients.set(a, { spells: new Set(clientSpells), left, right });
  store.set(`${a}|equipment`, { inv: { entries: [] }, leftSpell: 0, rightSpell: 0 });
};

// ---- 1. Donn: fed at stage 2, the client still holds Drain02 in the right hand ----------------------------------------
const D = 0xff0005e2;
setup(D, { kind: 'vampire', stage: 1, lastFed: day(), pure: false, spells: STAGE1.slice() }, STAGE1, [...STAGE1, DRAIN[2]], 0, DRAIN[2]);
ok(report(D).join() === hex(DRAIN[2]), 'the stale drain is stripped from the report, as live');
wait(2000);
ok(clientOf(D).right === DRAIN[1], 'within 2 s the right hand holds this stage\'s drain', hex(clientOf(D).right));
ok(!clientOf(D).spells.has(DRAIN[2]), 'the stale drain is off the client\'s list', [...clientOf(D).spells].map(hex));
ok(report(D).length === 0, 'the next report strips nothing');
ok(STAGE1.every((id) => learnedOf(D).has(id)) && !learnedOf(D).has(DRAIN[2]), 'the server still holds exactly stage 1', [...learnedOf(D)].map(hex));
ok(logs.some((l) => /#ff0005e2 .*VampireDrain02|8d5c0/.test(l)), 'a log line names it', logs.slice(-3));

// ---- 2. a hotkey puts it back at once: not healed again inside a minute, even across a reload -------------------------
calls.length = 0;
clientOf(D).spells.add(DRAIN[2]); clientOf(D).right = DRAIN[2];
load();
report(D); wait(2000);
ok(!calls.length, 'a second stale report inside a minute makes no calls', calls.map(([m, i]) => `${m} ${hex(i)}`));
wait(60000);
report(D); wait(2000);
ok(clientOf(D).right === DRAIN[1], 'a minute later it is healed again', hex(clientOf(D).right));

// ---- 3. this stage's spells in hand: nothing to do --------------------------------------------------------------------
calls.length = 0;
report(D); wait(2000);
ok(!calls.length, 'a hand holding this stage\'s drain makes no calls', calls.map(([m, i]) => `${m} ${hex(i)}`));

// ---- 4. Raise Thrall of another stage in the left hand ----------------------------------------------------------------
const T = 0xff000cff;
setup(T, { kind: 'vampire', stage: 2, lastFed: day() - 1.2, pure: false, spells: STAGE2.slice() }, STAGE2, [...STAGE2, THRALL[4]], THRALL[4], DRAIN[2]);
report(T); wait(2000);
ok(clientOf(T).left === THRALL[2] && clientOf(T).right === DRAIN[2], 'the left hand gets this stage\'s Raise Thrall, the right is left alone', [hex(clientOf(T).left), hex(clientOf(T).right)]);

// ---- 4b. Silas: the same stale drain in both hands, both swapped at once ---------------------------------------------
const S = 0xff0016a1;
setup(S, { kind: 'vampire', stage: 3, lastFed: day() - 2.2, pure: false, spells: [DRAIN[3], THRALL[3], SIGHT, SEDUCTION] }, [DRAIN[3], THRALL[3], SIGHT, SEDUCTION], [DRAIN[2], THRALL[2], SIGHT, SEDUCTION], DRAIN[2], DRAIN[2]);
ok(report(S).length === 2, 'both hands stripped, as live');
wait(2000);
ok(clientOf(S).left === DRAIN[3] && clientOf(S).right === DRAIN[3], 'both hands hold this stage\'s drain', [hex(clientOf(S).left), hex(clientOf(S).right)]);

// ---- 5. an unfed vampire and a cured one have no stage spells: the stale one is only taken back -----------------------
const U = 0xff000101, X = 0xff000102;
setup(U, { kind: 'vampire', stage: 1, lastFed: day(), pure: false, unfed: { played: 0, wither: 0 }, spells: [] }, [], [DRAIN[1]], 0, DRAIN[1]);
setup(X, { kind: null, stage: 0, spells: [] }, [], [DRAIN[3]], DRAIN[3], 0);
calls.length = 0;
report(U); report(X); wait(2000);
ok(!clientOf(U).spells.has(DRAIN[1]) && !clientOf(X).spells.has(DRAIN[3]), 'both are taken off the client\'s list', [[...clientOf(U).spells].map(hex), [...clientOf(X).spells].map(hex)]);
ok(!calls.some(([m]) => m === 'EquipSpell'), 'and nothing is equipped in their place', calls.map(([m, i]) => `${m} ${hex(i)}`));

// ---- 6. a Vampire Lord in the form is left to beastform.js ------------------------------------------------------------
const L = 0xff000103;
setup(L, { kind: 'vampire', stage: 1, lastFed: day(), pure: true, spells: STAGE1.slice() }, STAGE1, [DRAIN[3]], 0, DRAIN[3]);
store.set(`${L}|private.beast`, { form: 'vampirelord', original: { raceId: 1 } });
calls.length = 0;
report(L); wait(2000);
ok(!calls.length, 'nothing is done while in the Vampire Lord form', calls.map(([m, i]) => `${m} ${hex(i)}`));

console.log(fail ? `\n${fail} FAILED` : `\nall ${pass} checks passed`);
process.exit(fail ? 1 : 0);
