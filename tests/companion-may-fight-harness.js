// globalThis.__dboCompanionMayFight (downed.js), the gameplay's part of the PvP rule for companions (fork companionSystem.ts,
// Nate 5 Oct: a summon or raised corpse fights another player only when PvP allows it): never the same party, a downed or
// kneeling player, a jail sentence still to serve, someone bound, carried or held, a logged-out body, an ethereal beast
// form or safe ground; pvp.companions false switches it off; anything unreadable refuses.
// node tests/companion-may-fight-harness.js   (from server/)
'use strict';
const path = require('path');
const MODULE = path.resolve(__dirname, '..', 'downed.js');
let now = 1790000000000;
Date.now = () => now;

const A = 0xff000001, B = 0xff000002, C = 0xff000003, WOLF = 0xff0000aa, SUMMON = 0xff0000bb;
const props = new Map();
const set = (id, k, v) => props.set(id + '|' + k, v);
const get = (id, k) => props.get(id + '|' + k);
for (const [a, prof] of [[A, 1], [B, 2], [C, 3]]) {
  set(a, 'profileId', prof); set(a, 'isDead', false); set(a, 'percentages', { health: 1, stamina: 1, magicka: 1 });
  set(a, 'pos', [0, 0, 0]); set(a, 'worldOrCellDesc', 'a764b:BSHeartland.esm'); set(a, 'angle', [0, 0, 0]);
}
set(WOLF, 'profileId', -1); set(SUMMON, 'profileId', -1); set(SUMMON, 'ff_companionOf', A);
const parties = new Map();
globalThis.__dboPartyLeaderOf = (a) => (parties.has(Number(a) >>> 0) ? parties.get(Number(a) >>> 0) : null);
const mp = {
  get: (id, k) => { const v = get(id, k); if (v === undefined && k === 'private.permaDead') return false; return v; },
  set: (id, k, v) => set(id, k, v),
  getIdFromDesc: (d) => parseInt(d, 16), getDescFromId: (id) => (id >>> 0).toString(16),
  callPapyrusFunction: () => true,
  onHitDamageAttempt: () => true, onHitDamage: () => undefined, onDeath: () => undefined, onSpellHit: () => undefined, onSpellCast: () => undefined,
};
global.setTimeout = () => 0;
const cfg = { downed: {}, pvp: { damageMult: 1.25 } };
const api = {
  mp, log: () => {}, personal: () => {}, sendPacket: () => true,
  audit: () => {}, who: String, display: String, profileOf: (a) => Number(get(a, 'profileId')), nameOf: String,
  onlineActors: () => [A, B, C], every: () => {}, registerChatCommand: () => {}, cfg,
  openWidget: () => true, closeWidget: () => {}, onUi: () => {},
};
delete require.cache[MODULE];
require(MODULE)(api);
const may = globalThis.__dboCompanionMayFight;
const S = globalThis.__dboDownedState;

let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

check('the hook is provided', typeof may === 'function');
check('two players outside every rule may fight', may(A, B) === true);
check('...ids given as strings are read as actor ids', may(String(A), String(B)) === true);
check('never the owner themselves', may(A, A) === false);
check('never an NPC as the "player"', may(A, WOLF) === false);
check('never another player\'s companion as the "player" (the fork passes its owner)', may(A, SUMMON) === false);
check('nothing to read: refuses', may(0, B) === false && may(A, undefined) === false);

parties.set(A, A); parties.set(B, A);
check('never the same party', may(A, B) === false && may(B, A) === false);
check('...another party is fair game', may(A, C) === true);
parties.clear();

S.downed.set(B, { at: now, by: A }); set(B, 'isDead', true);
check('never a downed player', may(A, B) === false);
check('...nor while the owner is down', may(B, A) === false);
S.downed.delete(B); set(B, 'isDead', false);
check('up again: fair game', may(A, B) === true);
S.recovering.set(B, { at: now, until: now + 5000 });
check('never one kneeling after a revive', may(A, B) === false);
S.recovering.delete(B);

set(B, 'private.dboSentence', { door: 1, cell: 'x', totalMs: 600000, servedMs: 0 });
check('never a player with a jail sentence to serve', may(A, B) === false);
check('...nor for a jailed owner', may(B, A) === false);
set(B, 'private.dboSentence', null);
check('sentence ended: fair game', may(A, B) === true);

for (const r of [{ boundHands: true }, { carried: true }, { captorActorId: C }]) {
  set(B, 'private.restrained', r);
  check(`never someone ${Object.keys(r)[0]}`, may(A, B) === false);
}
set(B, 'private.restrained', null);

globalThis.__dboOfflineBodyProtected = (t) => t === B;
check('never a protected logged-out body', may(A, B) === false);
delete globalThis.__dboOfflineBodyProtected;
globalThis.__dboBeastEthereal = (t) => t === B;
check('never an ethereal beast form', may(A, B) === false);
delete globalThis.__dboBeastEthereal;
globalThis.__dboPvpSafeGround = (o, t) => t === B;
check('never on safe ground, once a module provides it', may(A, B) === false && may(A, C) === true);
globalThis.__dboPvpSafeGround = () => { throw new Error('boom'); };
check('a failing check refuses', may(A, B) === false);
delete globalThis.__dboPvpSafeGround;

cfg.pvp.companions = false;
check('pvp.companions false keeps every companion out of PvP', may(A, B) === false);
delete cfg.pvp.companions;
check('...and only that', may(A, B) === true);

console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
