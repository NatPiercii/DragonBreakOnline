// Scripted test for fork skymp5-client/src/view/npcLifetime.ts: when the client may delete, re-seat or animate an NPC
// copy (crash-wave-1001 ANALYSIS.md §7: copies deleted or re-seated while dead or ragdolling, relayed Ragdolls on bodies
// havok still held, a burst of host grants after a cell load, ghost copies asking to be hosted once a second).
// Bundle it first, then run from this folder's parent:
//
//   ../fork/skymp5-server/node_modules/.bin/esbuild ../fork/skymp5-client/src/view/npcLifetime.ts --bundle --platform=node --format=cjs --outfile=<out>
//   node tests/npc-lifetime-plan-harness.js <out>
'use strict';
const path = require('path');
const L = require(path.resolve(process.argv[2]));
let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };
const T = 1_790_000_000_000;
const calm = (extra) => Object.assign({ is3DLoaded: true, dead: false, bleedingOut: false, unconscious: false, inKillMove: false, ragdolledAt: 0 }, extra || {});

// ---- (a) safe delete ----
check('a calm copy is not risky to touch', !L.isRiskyToTouch(calm(), T));
for (const k of ['dead', 'bleedingOut', 'unconscious', 'inKillMove']) check(`a copy that is ${k} is risky`, L.isRiskyToTouch(calm({ [k]: true }), T));
check('a copy ragdolled a second ago is risky', L.isRiskyToTouch(calm({ ragdolledAt: T - 1000 }), T));
check('...and no longer after the ragdoll hold', !L.isRiskyToTouch(calm({ ragdolledAt: T - L.RAGDOLL_HOLD_MS - 1 }), T));
if (L.SAFE_DELETE_MAX_FRAMES !== undefined) {
  // 0.3.76 and older: a frame cap that deletes whatever the 3D (client-safedelete-loadwait replaces it)
  check('a disabled copy waits at least the minimum frames, even unloaded', L.deleteDecision(1, false) === 'wait' && L.deleteDecision(L.SAFE_DELETE_MIN_FRAMES - 1, false) === 'wait');
  check('...is deleted once its 3D is gone after the minimum', L.deleteDecision(L.SAFE_DELETE_MIN_FRAMES, false) === 'delete');
  check('...waits while its 3D is still loaded', L.deleteDecision(10, true) === 'wait');
  check('...and is deleted at the maximum whatever its 3D', L.deleteDecision(L.SAFE_DELETE_MAX_FRAMES, true) === 'delete');
} else {
  // client-safedelete-loadwait: unloaded for the min updates and the settle time, never forced; tests/safedelete-loadwait-harness.js
  const run = (n, loaded, screen, step) => { let p = L.newPendingDelete(), d = 'wait'; for (let i = 0; i < n && d === 'wait'; i++) ({ decision: d, next: p } = L.deleteDecision(p, loaded, screen, step)); return d; };
  check('a disabled copy waits at least the minimum updates, even unloaded', run(L.SAFE_DELETE_MIN_FRAMES - 1, false, false, 1000) === 'wait');
  check('...is deleted once its 3D is gone after the minimum and the settle time', run(L.SAFE_DELETE_MIN_FRAMES + Math.ceil(L.SAFE_DELETE_SETTLE_MS / 16), false, false, 16) === 'delete');
  check('...waits while its 3D is still loaded', run(10, true, false, 16) === 'wait');
  check('...and is never deleted while loaded: at the give-up time it is left disabled', run(Math.ceil(L.SAFE_DELETE_GIVE_UP_MS / 16) + 1, true, false, 16) === 'give-up');
}

// ---- (b) the HostStart re-seat ----
check('a loaded, calm copy born long ago is re-seated now', L.reseatDecision(calm(), T - 10000, T, T) === 'now');
check('a copy with no recorded birth (an old one) is re-seated now', L.reseatDecision(calm(), 0, T, T) === 'now');
check('a copy loaded under two seconds waits', L.reseatDecision(calm(), T - 500, T, T) === 'later');
check('...and goes at two seconds', L.reseatDecision(calm(), T - 500, T, T + 1500) === 'now');
check('an unloaded copy waits', L.reseatDecision(calm({ is3DLoaded: false }), 0, T, T + 1000) === 'later');
check('a dead copy is never re-seated: it waits, then is dropped', L.reseatDecision(calm({ dead: true }), 0, T, T + 1000) === 'later'
  && L.reseatDecision(calm({ dead: true }), 0, T, T + L.RESEAT_GIVE_UP_MS) === 'skip');
check('a ragdolling copy waits for the ragdoll to end', L.reseatDecision(calm({ ragdolledAt: T }), 0, T, T + 1000) === 'later'
  && L.reseatDecision(calm({ ragdolledAt: T }), 0, T, T + L.RAGDOLL_HOLD_MS + 1) === 'now');

// ---- (c) the settle window, and relayed Ragdolls ----
check('a copy not yet spawned is settling', L.isSettling(0, T));
check('a copy spawned a second ago is settling', L.isSettling(T - 1000, T));
check('...and not at 1.5 s', !L.isSettling(T - L.NPC_SETTLE_MS, T));
check('a relayed Ragdoll reaches a calm, loaded copy', !L.dropRelayedRagdoll(calm(), T));
check('...but not an unloaded one', L.dropRelayedRagdoll(calm({ is3DLoaded: false }), T));
check('...nor a dead one', L.dropRelayedRagdoll(calm({ dead: true }), T));
check('...nor one already ragdolled', L.dropRelayedRagdoll(calm({ ragdolledAt: T - 500 }), T));

// ---- (d) host attempts nobody answers ----
const b = new L.HostAttemptBackoff();
const R = 0xff000286;
let sent = 0;
for (let t = T; t < T + 60 * 60000; t += 1000) if (b.due(R, t)) { b.sent(R, t); sent++; }
check(`an hour of a ghost copy: ${sent} attempts instead of 3600`, sent > 200 && sent < 260, sent);
check('the backoff counts the unanswered attempts', b.unanswered(R) === sent);
b.answered(R);
check('a HostStart resets it: the next attempt is due at once', b.due(R, T) && b.unanswered(R) === 0);
const c = new L.HostAttemptBackoff();
c.sent(7, T);
check('the second attempt waits a second', !c.due(7, T + 999) && c.due(7, T + 1000));
check('other copies are not slowed by one ghost', c.due(8, T));

// ---- (e) the trail ----
const tr = new L.ActorTrail(3);
['a', 'b', 'c', 'd'].forEach((x) => tr.push(x));
check('the trail keeps the newest calls, newest last', JSON.stringify(tr.all()) === '["b","c","d"]', tr.all());
check('the default trail holds 20', L.TRAIL_SIZE === 20);
const line = L.trailLine(Date.parse('2026-10-01T21:46:20.123Z'), 'delete', 0xff00156b, 0x0808747f, 'after 4 frames');
check('a trail line names the time, the call, the copy and its base', line === 'npc 21:46:20.123 delete ff00156b base=808747f after 4 frames', line);
const lb = new L.LineBudget(3, 5);
const took = [T, T, T, T, T + 1000, T + 1000, T + 1000].map((t) => lb.take(t));
check('the budget allows its lines a second and its total a session', JSON.stringify(took) === '[true,true,true,false,true,true,false]' && lb.dropped === 2, took);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
