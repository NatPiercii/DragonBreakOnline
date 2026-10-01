// Auto-run after dying (Purr, /bug 30 Sep 16:24) is thought to be a movement key whose key-up was lost while the down
// panel held the keyboard. downed.js asks the client to reopen its input diagnostic when a player falls (dboInputDiag);
// this checks the request goes out once, to the fallen player only, and that 0 switches it off.
//   node tests/downed-inputdiag-harness.js   (from server/)
'use strict';
const path = require('path');
const MODULE = path.resolve(__dirname, '..', 'downed.js');
let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

const run = (downedCfg) => {
  const P = 0xff000001, NEAR = 0xff000002, WOLF = 0xff0000aa;
  const props = new Map();
  const set = (id, k, v) => props.set(id + '|' + k, v);
  const get = (id, k) => props.get(id + '|' + k);
  for (const [a, prof] of [[P, 1], [NEAR, 2]]) {
    set(a, 'profileId', prof); set(a, 'isDead', false); set(a, 'percentages', { health: 1, stamina: 1, magicka: 1 });
    set(a, 'pos', [0, 0, 0]); set(a, 'worldOrCellDesc', 'a764b:BSHeartland.esm'); set(a, 'angle', [0, 0, 0]);
  }
  set(WOLF, 'profileId', -1);
  const mp = {
    get: (id, k) => { const v = get(id, k); if (v === undefined && k === 'private.permaDead') return false; return v; },
    set: (id, k, v) => set(id, k, v),
    getIdFromDesc: (d) => parseInt(d, 16), getDescFromId: (id) => (id >>> 0).toString(16), callPapyrusFunction: () => true,
    onHitDamageAttempt: () => true, onHitDamage: () => undefined, onDeath: () => undefined, onSpellHit: () => undefined, onSpellCast: () => undefined,
  };
  const packets = [];
  global.setTimeout = () => 0;
  globalThis.__dboDownedState = undefined; globalThis.__dboDownedTimersSent = undefined;
  delete require.cache[MODULE];
  require(MODULE)({
    mp, log: () => {}, personal: () => {}, sendPacket: (a, p) => { packets.push([a, p]); return true; },
    audit: () => {}, who: String, display: String, profileOf: (a) => Number(get(a, 'profileId')), nameOf: String,
    onlineActors: () => [P, NEAR], every: () => {}, registerChatCommand: () => {}, cfg: { downed: downedCfg || {} },
    openWidget: () => true, closeWidget: () => {}, onUi: () => {},
  });
  set(P, 'isDead', true); mp.onDeath(P, WOLF);
  return { P, NEAR, diag: packets.filter(([, p]) => p.customPacketType === 'dboInputDiag') };
};

let r = run();
check('a fall asks the fallen player for the input diagnostic, once', r.diag.length === 1 && r.diag[0][0] === r.P, r.diag);
check('for 180 seconds (the bleed-out and two minutes after), reason "down"', r.diag[0] && r.diag[0][1].seconds === 180 && r.diag[0][1].reason === 'down', r.diag[0]);
check('nobody else is asked', !r.diag.some(([a]) => a === r.NEAR));
r = run({ inputDiagSeconds: 0 });
check('downed.inputDiagSeconds 0 opens no diagnostic window: no "down" request', !r.diag.some(([, p]) => p.reason === 'down'), r.diag);
check('...only the crash check\'s one short probe is sent (reason crash-check, 5 s)', r.diag.length === 1 && r.diag[0][0] === r.P && r.diag[0][1].reason === 'crash-check' && r.diag[0][1].seconds === 5, r.diag);
r = run({ inputDiagSeconds: 0, crashForgive: false });
check('...and with crash forgiveness off too, nothing at all', r.diag.length === 0, r.diag);
r = run({ inputDiagSeconds: 60 });
check('the length follows the config', r.diag.length === 1 && r.diag[0][1].seconds === 60, r.diag);
console.log(failures ? `${failures} FAILED` : 'all checks passed');
process.exit(failures ? 1 : 0);
