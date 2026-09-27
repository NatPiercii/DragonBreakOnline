// The down-state panel and the timers others see (server downed.js, client widget 'downed' + downedTimerService).
// node tests/downed-panel-harness.js   (from server/)
'use strict';
const path = require('path');
const MODULE = path.resolve(__dirname, '..', 'downed.js');
let now = 1790000000000;
Date.now = () => now;

const P = 0xff000001, NEAR = 0xff000002, FAR = 0xff000003, WOLF = 0xff0000aa;
const props = new Map();
const set = (id, k, v) => props.set(id + '|' + k, v);
const get = (id, k) => props.get(id + '|' + k);
for (const [a, prof, pos] of [[P, 1, [0, 0, 0]], [NEAR, 2, [500, 0, 0]], [FAR, 3, [90000, 0, 0]]]) {
  set(a, 'profileId', prof); set(a, 'isDead', false); set(a, 'percentages', { health: 1, stamina: 1, magicka: 1 });
  set(a, 'pos', pos); set(a, 'worldOrCellDesc', 'a764b:BSHeartland.esm'); set(a, 'angle', [0, 0, 0]);
  set(a, 'spawnPoint', { cellOrWorldDesc: 'temple', pos: [1, 2, 3], rot: [0, 0, 0] });
}
set(WOLF, 'profileId', -1);
const mp = {
  get: (id, k) => { const v = get(id, k); if (v === undefined && k === 'private.permaDead') return false; return v; },
  set: (id, k, v) => set(id, k, v),
  getIdFromDesc: (d) => parseInt(d, 16), getDescFromId: (id) => (id >>> 0).toString(16),
  callPapyrusFunction: (k, c, fn, self, args) => { if (fn === 'SendAnimationEvent') anims.push([parseInt(args[0].desc, 16), args[1]]); return true; },
  onHitDamageAttempt: () => true, onHitDamage: () => undefined, onDeath: () => undefined, onSpellHit: () => undefined, onSpellCast: () => undefined,
};
const widgets = [], closed = [], packets = [], timers = {}, ui = {}, anims = [];
const pending = []; global.setTimeout = (fn, ms) => { pending.push(fn); return 0; };
globalThis.__dboDownedState = undefined; globalThis.__dboDownedTimersSent = undefined;
require(MODULE)({
  mp, log: () => {}, personal: () => {}, sendPacket: (a, p) => { packets.push([a, p]); return true; },
  audit: () => {}, who: String, display: String, profileOf: (a) => Number(get(a, 'profileId')), nameOf: String,
  onlineActors: () => [P, NEAR, FAR], every: (n, ms, fn) => { timers[n] = fn; }, registerChatCommand: () => {}, cfg: {},
  openWidget: (a, w, focus) => { widgets.push([a, w, focus]); return true; }, closeWidget: (a, id) => { closed.push([a, id]); },
  onUi: (n, fn) => { ui[n] = fn; },
});
let failures = 0;
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) failures++; };
const lastTimers = (a) => { for (let i = packets.length - 1; i >= 0; i--) if (packets[i][0] === a && packets[i][1].customPacketType === 'dboDowned') return packets[i][1].list; return null; };
const die = () => { set(P, 'isDead', true); mp.onDeath(P, WOLF); };

// A client that never said it draws the panel keeps the banner, and no widget takes its keyboard
die();
check('an old client gets the banner, not a panel', !widgets.length && packets.some((x) => x[0] === P && x[1].customPacketType === 'dboBanner'));
set(P, 'isDead', false); timers.downedPanel(); packets.length = 0; closed.length = 0;
ui.uiCaps(P, ['bank', 'robPrompt', 'downed']);

die();
const w = widgets.find((x) => x[0] === P && x[1].type === 'downed');
check('going down opens the panel, with the keyboard', !!w && w[2] === true && w[1].id === 62);
check('it counts the full bleed-out and says who can raise you', w && w[1].seconds === 60 && /healing magic or a Draught of Revival/.test(w[1].text) && w[1].title === "You're down!");
check('a player nearby is sent the timer', JSON.stringify(lastTimers(NEAR)) === JSON.stringify([{ id: P, seconds: 60 }]));
check('a player far away is not', lastTimers(FAR) === null);
check('the downed player is not sent their own', lastTimers(P) === null);

now += 20000; timers.downedPanel();
ui.downedGiveUp(P, ['wrong-nonce']);
check('a stale Give up does nothing', get(P, 'isDead') === true && !closed.length);
ui.downedGiveUp(P, [w[1].nonce]);
check('Give up wakes them at the temple', get(P, 'isDead') === false && JSON.stringify(get(P, 'locationalData')) === JSON.stringify(get(P, 'spawnPoint')));
check('and closes the panel', closed.some((c) => c[0] === P && c[1] === 62));
check('and clears the timer near them', JSON.stringify(lastTimers(NEAR)) === '[]');

// The engine's own respawn at the end of the bleed-out closes the panel within a second
closed.length = 0; die();
now += 61000; set(P, 'isDead', false); timers.downedPanel();
check('the engine respawn closes the panel', closed.some((c) => c[0] === P && c[1] === 62));

// A revive closes it too
closed.length = 0; die();
globalThis.__dboReviveWith && globalThis.__dboReviveWith(P, NEAR, 'healing');
check('a revive closes the panel', get(P, 'isDead') === false && closed.some((c) => c[0] === P && c[1] === 62));

// Recovery after a revive: kneel, heal slowly, untouchable and harmless, then stand
anims.length = 0; packets.length = 0;
set(P, 'isDead', false); timers.downedPanel(); die();
globalThis.__dboReviveWith(P, NEAR, 'healing');
const hp = () => get(P, 'percentages').health;
check('a revived player starts nearly empty', Math.abs(hp() - 0.01) < 1e-9);
check('their controls are held, quietly', packets.some((x) => x[0] === P && x[1].customPacketType === 'dboParalyse' && x[1].seconds === 15 && x[1].quiet === true));
pending.splice(0).forEach((f) => f());
check('they kneel', anims.some((x) => x[0] === P && x[1] === 'BleedOutStart'));
check('nobody can hurt them while they kneel', mp.onHitDamageAttempt(NEAR, P, 0x1f4, 20) === false);
check('and they cannot attack', mp.onHitDamageAttempt(P, NEAR, 0x1f4, 20) === false);
now += 7500; timers.downedRecovery();
check('health climbs half way in half the time', Math.abs(hp() - (0.01 + 0.24 * 0.5)) < 0.01);
now += 8000; timers.downedRecovery();
check('at the end they stand at the revive health', anims.some((x) => x[0] === P && x[1] === 'BleedOutStop') && Math.abs(hp() - 0.25) < 1e-9);
check('and are back in the fight', mp.onHitDamageAttempt(NEAR, P, 0x1f4, 20) !== false);

console.log(failures ? `${failures} FAILED` : 'all checks passed');
process.exit(failures ? 1 : 0);
