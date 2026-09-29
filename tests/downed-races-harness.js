// The unexpected paths through server\downed.js (overnight review, 2026-09-29): a Priest's heal that landed on someone
// alive, a Draught poured from out of reach or with bound hands, and a body raised while its player is away. Run it from
// this folder's parent with
//
//   node tests/downed-races-harness.js
'use strict';
const path = require('path');

const MODULE = path.resolve(__dirname, '..', 'downed.js');
let now = 1790000000000;
Date.now = () => now;

// P falls; PRIEST is a Priest of tier 4; ALLY stands alive; HELPER carries a Draught of Revival
const P = 0xff000001, PRIEST = 0xff000002, ALLY = 0xff000003, HELPER = 0xff000004;
const HEAL_OTHER = 0x12fd2, POTION = 0x12ae16;
const CELL = 'a764b:BSHeartland.esm';
const props = new Map();
const set = (id, k, v) => props.set(id + '|' + k, v);
const get = (id, k) => props.get(id + '|' + k);
const place = (a, pos) => set(a, 'pos', pos);
const reset = () => {
  props.clear();
  for (const [a, prof] of [[P, 1], [PRIEST, 2], [ALLY, 3], [HELPER, 4]]) {
    set(a, 'profileId', prof); set(a, 'isDead', false); set(a, 'percentages', { health: 1, stamina: 1, magicka: 1 });
    set(a, 'pos', [0, 0, 0]); set(a, 'worldOrCellDesc', CELL); set(a, 'angle', [0, 0, 0]);
    set(a, 'spawnPoint', { cellOrWorldDesc: 'temple', pos: [1, 2, 3], rot: [0, 0, 0] });
    set(a, 'inventory', { entries: [] });
  }
  set(PRIEST, 'private.mastery', { order: ['priest'], skills: { priest: { rank: 3 } } });
  set(HELPER, 'inventory', { entries: [{ baseId: POTION, count: 2 }] });
  const S = globalThis.__dboDownedState;
  if (S) { S.downed.clear(); S.fought.clear(); S.recovering.clear(); for (const t of S.pendingCast.values()) clearTimeout(t); S.pendingCast.clear(); if (S.castStop) S.castStop.clear(); }
  pending.length = 0; audits.length = 0; activated.length = 0;
  online = [P, PRIEST, ALLY, HELPER];
};

const pending = [];
global.setTimeout = (fn) => { pending.push(fn); return pending.length; };
global.clearTimeout = (h) => { if (h) pending[h - 1] = null; };
const runTimers = () => { const fns = pending.splice(0); for (const fn of fns) if (fn) fn(); };

const activated = [];
const mp = {
  get: (id, k) => { const v = get(id, k); if (v === undefined && k === 'private.permaDead') return false; return v; },
  set: (id, k, v) => set(id, k, v),
  getIdFromDesc: (d) => parseInt(d, 16),
  getDescFromId: (id) => (id >>> 0).toString(16),
  lookupEspmRecordById: () => null,
  callPapyrusFunction: () => true,
  onHitDamageAttempt: () => true, onHitDamage: () => undefined, onDeath: () => undefined,
  onSpellHit: () => undefined, onSpellCast: () => undefined, onEatItem: () => undefined,
  // The gamemode's own activate (reach, bound hands, body search) sits inside downed.js's wrappers
  onActivate: (t, a) => { activated.push([t >>> 0, a >>> 0]); return true; },
};
const audits = [], timers = {};
let online = [];
require(MODULE)({
  mp, log: () => {}, personal: () => {}, sendPacket: () => true, onUi: () => {}, openWidget: () => {}, closeWidget: () => {},
  audit: (t) => audits.push(t), who: (a) => 'P' + (a >>> 0).toString(16), display: (a) => 'P' + (a >>> 0).toString(16),
  profileOf: (a) => Number(get(a, 'profileId')), nameOf: (a) => 'P' + (a >>> 0).toString(16),
  onlineActors: () => online.slice(), every: (n, ms, fn) => { timers[n] = fn; }, registerChatCommand: () => {},
  cfg: { downed: {} },
});

let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + detail : ''}`); if (!ok) failures++; };
const down = (a) => { set(a, 'isDead', true); mp.onDeath(a, 0); };
const raised = (a) => get(a, 'isDead') === false && audits.some((t) => t.startsWith(`REVIVE P${(a >>> 0).toString(16)} `));
const potions = (a) => (get(a, 'inventory').entries.find((e) => e.baseId === POTION) || { count: 0 }).count;

// ---- 1. the Priest's by-aim fallback --------------------------------------------------------------------------------
// The Priest faces +y. A heal whose hit never arrives raises the nearest fallen in front: the fallback as designed.
reset(); place(P, [0, 1200, 0]); down(P);
mp.onSpellCast(PRIEST, HEAL_OTHER); runTimers();
check('a heal with no hit raises the fallen in front, by aim', raised(P), audits.join(' | '));

// The heal landed on a living ally 7 m out; the fallen lie 17 m out behind them. A projectile stops at what it hits.
reset(); place(ALLY, [0, 500, 0]); place(P, [0, 1200, 0]); down(P);
mp.onSpellCast(PRIEST, HEAL_OTHER); mp.onSpellHit(PRIEST, ALLY, HEAL_OTHER); runTimers();
check('a heal that landed on a living ally does not also raise a fallen body beyond them', !raised(P) && get(P, 'isDead') === true, audits.join(' | '));

// A body nearer than the ally may have been passed through (why the fallback exists): still raised
reset(); place(P, [0, 300, 0]); place(ALLY, [0, 500, 0]); down(P);
mp.onSpellCast(PRIEST, HEAL_OTHER); mp.onSpellHit(PRIEST, ALLY, HEAL_OTHER); runTimers();
check('a fallen body nearer than the healed ally is still raised by aim', raised(P), audits.join(' | '));

// A new cast starts afresh: the last cast's stop does not shorten it
reset(); place(ALLY, [0, 500, 0]); place(P, [0, 1200, 0]); down(P);
mp.onSpellCast(PRIEST, HEAL_OTHER); mp.onSpellHit(PRIEST, ALLY, HEAL_OTHER); runTimers();
place(ALLY, [5000, 0, 0]);
mp.onSpellCast(PRIEST, HEAL_OTHER); runTimers();
check('the next heal, which hit nothing, raises them', raised(P), audits.join(' | '));

console.log(failures ? `${failures} failure(s)` : 'all checks passed');
process.exit(failures ? 1 : 0);
