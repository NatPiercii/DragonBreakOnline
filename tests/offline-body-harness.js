// A logged-out player's body cannot be harmed (Nate, 2026-09-30). Onny's body was downed and killed after he left,
// twice, and he woke naked. The exception is logging out mid-fight: a blow in the last combatLogSeconds before the
// logout leaves the body open. Part 1 lifts gamemode.js's gate and runs it against a stub mp. Part 2 loads downed.js,
// whose hit wrapper runs before the gamemode's, and checks a downed logged-out body cannot be finished.
//   node tests/offline-body-harness.js   (from server/)
'use strict';
const fs = require('fs');
const path = require('path');
let fail = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got)}`); if (!c) fail++; };
let now = 1790000000000;
Date.now = () => now;

// ---- part 1: the gate ----
const src = fs.readFileSync(path.resolve(__dirname, '..', 'gamemode.js'), 'utf8');
const i = src.indexOf('const OFFLINE_BODY = '), j = src.indexOf('\n};\n', src.indexOf('const refuseOfflineBody = '));
if (i < 0 || j < 0) { console.log('FAIL gamemode.js has no offline-body gate'); process.exit(1); }
const PLAYER = 0xff000010, BODY = 0xff000020, WOLF = 0xff0000aa;
const users = new Map([[PLAYER, 1]]);          // BODY's player has left
const profiles = new Map([[PLAYER, 5], [BODY, 21]]);
const said = [], logs = [];
const lift = (cfg) => {
  const G = {};
  const combatAt = new Map();
  const api = new Function('globalThis', 'cfg', 'combatAt', 'profileOf', 'userOf', 'display', 'personal', 'log',
    `${src.slice(i, j + 3)}\nreturn { gate: offlineBodyProtected, refuse: refuseOfflineBody, note: globalThis.__dboNoteLogout, logoutAt };`)(
    G, cfg, combatAt, (a) => (profiles.has(a) ? profiles.get(a) : -1), (a) => (users.has(a) ? users.get(a) : -1), String,
    (a, t) => said.push([a, t]), (...x) => logs.push(x.join(' ')));
  return Object.assign(api, { combatAt, G });
};
let g = lift({});
ok(g.gate(WOLF) === false, 'a creature is not a protected body');
ok(g.gate(PLAYER) === false, 'a player who is playing is not protected');
ok(g.gate(BODY) === true, 'a logged-out body is protected, even with no logout on record (after a restart)');

g.combatAt.set(BODY, now - 60000); g.note(BODY);
ok(g.gate(BODY) === true, 'logging out a minute after a fight leaves the body protected');

now += 1000; g.combatAt.set(BODY, now - 10000); g.note(BODY);
ok(g.gate(BODY) === false, 'logging out 10 s after a blow leaves the body open (combat logging)');
ok(logs.some((l) => /logged out within 30 s of a fight/.test(l)), 'and that is logged');
g.combatAt.set(BODY, now + 5000);
ok(g.gate(BODY) === false, 'blows on the body afterwards do not change the decision');

g = lift({ offlineBody: { combatLogSeconds: 0 } });
g.combatAt.set(BODY, now - 1000); g.note(BODY);
ok(g.gate(BODY) === true, 'combatLogSeconds 0 makes every logged-out body safe');

said.length = 0;
g.refuse(PLAYER, BODY); g.refuse(PLAYER, BODY);
ok(said.length === 1 && /stepped out of the world\. Their body cannot be harmed\./.test(said[0][1]), 'the attacker is told once, not per swing', said);
now += 6000; g.refuse(PLAYER, BODY);
ok(said.length === 2, 'and again after a few seconds');
said.length = 0; g.refuse(WOLF, BODY);
ok(said.length === 0, 'a creature is told nothing');

// The hook refuses before any combat bookkeeping or damage bonus, and records the logout
const hook = src.slice(src.indexOf('const hitDamageAttemptHook ='), src.indexOf('hitDamageAttemptHook.__dbo'));
const gateAt = hook.indexOf('offlineBodyProtected(tgt)');
ok(gateAt > 0 && gateAt < hook.indexOf('// 1. Refuse attack') && gateAt < hook.indexOf('combatAt.set('), 'the hit hook refuses a protected body before the combat stamps and every other rule');
ok(/globalThis\.__dboHandlers\.disconnect = [\s\S]{0,300}__dboNoteLogout\(a\)/.test(src), 'the disconnect handler records the logout');

// ---- part 2: downed.js cannot finish a downed logged-out body ----
const props = new Map();
const set = (id, k, v) => props.set(`${id}|${k}`, v), get = (id, k) => props.get(`${id}|${k}`);
const P = 0xff000001, KILLER = 0xff000002;
for (const [a, prof] of [[P, 1], [KILLER, 2]]) {
  set(a, 'profileId', prof); set(a, 'isDead', false); set(a, 'percentages', { health: 1, stamina: 1, magicka: 1 });
  set(a, 'pos', [0, 0, 0]); set(a, 'worldOrCellDesc', 'a764b:BSHeartland.esm'); set(a, 'angle', [0, 0, 0]);
  set(a, 'spawnPoint', { cellOrWorldDesc: 'temple', pos: [1, 2, 3], rot: [0, 0, 0] });
}
let innerCalls = 0;
const mp = {
  get: (id, k) => { const v = get(id, k); if (v === undefined && k === 'private.permaDead') return false; return v; },
  set, getIdFromDesc: (d) => parseInt(d, 16), getDescFromId: (id) => (id >>> 0).toString(16), callPapyrusFunction: () => true,
  onHitDamageAttempt: () => { innerCalls++; return true; }, onHitDamage: () => undefined, onDeath: () => undefined, onSpellHit: () => undefined, onSpellCast: () => undefined,
};
global.setTimeout = () => 0;
globalThis.__dboDownedState = undefined; globalThis.__dboDownedTimersSent = undefined;
const timers = {};
require(path.resolve(__dirname, '..', 'downed.js'))({
  mp, log: () => {}, personal: () => {}, sendPacket: () => true, audit: () => {}, who: String, display: String,
  profileOf: (a) => Number(get(a, 'profileId')), nameOf: String, onlineActors: () => [P, KILLER],
  every: (n, ms, fn) => { timers[n] = fn; }, registerChatCommand: () => {}, cfg: { downed: { finishGraceSeconds: 0, finishWeaponOnly: false } },
  openWidget: () => true, closeWidget: () => {}, onUi: () => {},
});
set(P, 'isDead', true); mp.onDeath(P, KILLER);
now += 10000;
let offline = true;
globalThis.__dboOfflineBodyProtected = (t) => offline && t === P;
const res = mp.onHitDamageAttempt(KILLER, P, 0x12eb7, 20);
ok(res === false && get(P, 'isDead') === true && JSON.stringify(get(P, 'locationalData')) !== JSON.stringify(get(P, 'spawnPoint')), 'a downed logged-out body cannot be finished', { res, dead: get(P, 'isDead') });
ok(innerCalls === 1, "the gamemode's hook still hears it, so the attacker is told");
offline = false;
const res2 = mp.onHitDamageAttempt(KILLER, P, 0x12eb7, 20);
ok(res2 === false && get(P, 'isDead') === false, 'the same blow on a body whose player is playing finishes them as before', { res2, dead: get(P, 'isDead') });

console.log(fail ? `${fail} failed` : 'all checks passed');
process.exit(fail ? 1 : 0);
