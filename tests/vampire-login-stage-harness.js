// A thirst stage reached at login must reach the player's client (Silas #LT8Y, 7 Oct 00:40: stage 2 -> 3 four seconds
// before JOIN, then Drain02 stripped from both hands on every equipment report). The world clock runs while a vampire
// is away, so the first slow tick after a login often moves the stage. The client puts back the spell list and hands it
// was sent at character load for its first seconds (remoteServer.ts SPELL_ENFORCE_PASSES), so the new stage's spells
// never reached it, and the login flush 15 s later was skipped because the stage change had already flushed.
// Loads the real supernatural.js against a stub server (AddSpell / RemoveSpell sent only on a change, as
// PapyrusActor.cpp) and a stub client that resets itself to its login state, as the real one does.
// node tests/vampire-login-stage-harness.js   (from server/)
'use strict';
const path = require('path');
const store = new Map();
const learned = new Set();          // the server's learned spells for V
const timers = {}, logs = [];
const noop = () => {};
let now = Date.UTC(2026, 9, 7, 0, 0);
Date.now = () => now;
const GAME_DAY_MS = 4 * 3600000, clockStart = now;
globalThis.__dboClock = { gameDays: () => (now - clockStart) / GAME_DAY_MS, isNight: () => true, isFullMoon: () => false, weatherFor: () => 0 };
globalThis.__dboSuperState = { crown: null, revoke: [] };
let pending = [];
global.setTimeout = (fn, ms) => { pending.push({ at: now + (Number(ms) || 0), fn }); return pending.length; };
const runDue = () => { const due = pending.filter((p) => p.at <= now); pending = pending.filter((p) => p.at > now); due.forEach((p) => p.fn()); };
const idOfDesc = (d) => { const [hex, plugin] = String(d).split(':'); return /^skyrim\.esm$/i.test(plugin) ? parseInt(hex, 16) : 0x1234; };
const descOf = (id) => `${(id >>> 0).toString(16)}:Skyrim.esm`;

// The client: its spell list and hands; a snippet lands at once, the login resets put the load-time state back
const client = { spells: new Set(), left: 0, right: 0 };
const snippet = (method, id, slot) => {
  if (method === 'AddSpell') client.spells.add(id);
  if (method === 'RemoveSpell') client.spells.delete(id);
  if (method === 'EquipSpell') { client.spells.add(id); if (slot === 0) client.left = id; else client.right = id; reportDue = true; }
};
let reportDue = false;
const mp = {
  get: (id, p) => store.get(`${id}|${p}`),
  set: (id, p, v) => { store.set(`${id}|${p}`, v); },
  getDescFromId: descOf,
  getIdFromDesc: idOfDesc,
  callPapyrusFunction: (kind, cls, method, self, args) => {
    const id = idOfDesc(args[0].desc);
    if (method === 'AddSpell') { if (!learned.has(id)) { learned.add(id); snippet(method, id); } }
    if (method === 'RemoveSpell') { if (learned.has(id)) { learned.delete(id); snippet(method, id); } }
    if (method === 'EquipSpell') { learned.add(id); snippet(method, id, args[1]); }
    return null;
  },
  lookupEspmRecordById: () => null,
};
let online = [];
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
const STAGE2 = [DRAIN[2], THRALL[2], SIGHT, SEDUCTION];
const V = 0xff0016a1;
const state = () => store.get(`${V}|private.supernatural`) || {};
store.set(`${V}|worldOrCellDesc`, 'tamriel'); store.set(`${V}|pos`, [0, 0, 0]);
store.set(`${V}|percentages`, { health: 1, magicka: 1, stamina: 1 }); store.set(`${V}|isDead`, false);

// Stage 2 when they logged out, 2.2 game days ago: stage 3 is due at the first tick
now = clockStart + GAME_DAY_MS * 5;
const day = (now - clockStart) / GAME_DAY_MS;
store.set(`${V}|private.supernatural`, { kind: 'vampire', stage: 2, lastFed: day - 2.2, pure: false, spells: STAGE2.slice() });
for (const id of STAGE2) learned.add(id);
store.set(`${V}|equipment`, { inv: { entries: [] }, leftSpell: DRAIN[2], rightSpell: DRAIN[2] });

// The login: the character is sent with the server's spells and hands as they are now
const T0 = now;
const loadList = [...learned], loadHands = { left: DRAIN[2], right: DRAIN[2] };
online = [V];
globalThis.__dboConnectedAt = new Map([[V, T0]]);
globalThis.__dboSuperLogin(V);
const SPAWN_MS = 6000, PASSES = [1, 3, 6, 10, 15, 20].map((s) => SPAWN_MS + s * 1000);
let strips = [], lastReportStrips = null;
const report = () => {
  const eq = { inv: { entries: [] }, leftSpell: client.left, rightSpell: client.right };
  if (typeof globalThis.__dboSuperEquipSeen === 'function') globalThis.__dboSuperEquipSeen(V, eq);
  const stored = { inv: { entries: [] }, leftSpell: 0, rightSpell: 0 };
  const stripped = [];
  for (const k of ['leftSpell', 'rightSpell']) { if (eq[k] && !learned.has(eq[k])) stripped.push(hex(eq[k])); else stored[k] = eq[k]; }
  store.set(`${V}|equipment`, stored);
  strips = strips.concat(stripped.map((s) => [now - T0, s]));
  lastReportStrips = stripped;
};
for (let t = 0; t <= 150000; t += 500) {
  now = T0 + t;
  if (t === SPAWN_MS) { client.spells = new Set(loadList); client.left = loadHands.left; client.right = loadHands.right; }
  if (PASSES.includes(t)) client.spells = new Set(loadList);
  if (t === 30000) load();   // a hot reload in the middle of it changes nothing
  if (t >= 4000 && (t - 4000) % 15000 === 0) timers.superSlow();
  runDue();
  if (t === SPAWN_MS + 2000 || (t > SPAWN_MS + 2000 && (reportDue || t % 30000 === 0))) { reportDue = false; report(); }
}

ok(state().stage === 3, 'the thirst reaches stage 3', state().stage);
ok(client.spells.has(DRAIN[3]), 'the client knows stage 3\'s drain', [...client.spells].map(hex));
ok(!client.spells.has(DRAIN[2]), 'the client no longer lists stage 2\'s drain', [...client.spells].map(hex));
ok(client.left === DRAIN[3] && client.right === DRAIN[3], 'both hands hold stage 3\'s drain', [hex(client.left), hex(client.right)]);
ok(lastReportStrips && lastReportStrips.length === 0, 'the last equipment report strips nothing', lastReportStrips);
ok(!strips.some(([t]) => t > 100000), 'no drain stripped once the client has settled', strips);

// A vampire long in the world still feels the next stage at the very next tick
now = T0 + 150000 + GAME_DAY_MS;
timers.superSlow(); runDue(); report();
ok(state().stage === 4, 'a settled vampire reaches stage 4 at the next tick', state().stage);
ok(client.right === DRAIN[4] && client.spells.has(DRAIN[4]), 'and holds stage 4\'s drain', [hex(client.right), [...client.spells].map(hex)]);

console.log(fail ? `\n${fail} FAILED` : `\nall ${pass} checks passed`);
process.exit(fail ? 1 : 0);
