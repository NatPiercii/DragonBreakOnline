// Scripted test for CaptureSystem's rope binding (Nate, 2026-09-30; captureSystem.ts on fork branch rope-binding-ts):
// who may tie with rope, the prompt and its 2-minute refusal hold, the rope taken when the knot is tied, no shackles,
// Leave Tied Here / Lead, the slip and the cut (rope only) and the 60 s grace after. Bundle first, then run from this
// folder's parent (run-all.sh does both):
//
//   ./node_modules/.bin/esbuild ts/systems/captureSystem.ts --bundle --platform=node --format=cjs --outfile=<out>
//   node tests/capture-rope-harness.js <out>
//
// A fork without rope binding is skipped, not failed, so run-all stays usable against an older release fork.
'use strict';
const path = require('path');
const { CaptureSystem } = require(path.resolve(process.argv[2]));
const logs = [];
const sys = new CaptureSystem((...x) => logs.push(x.join(' ')));
if (typeof sys.setLeash !== 'function') {
  require('./expect')('capture-rope', 'this captureSystem has no rope binding');
  console.log('SKIP  this fork\'s captureSystem.ts has no rope binding (fork branch rope-binding-ts)');
  process.exit(0);
}
let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

// Timers the harness fires by hand: the consent timeout
const timers = [];
global.setTimeout = (fn) => { timers.push(fn); return timers.length; };
global.clearTimeout = (id) => { if (id) timers[id - 1] = null; };
let clock = Date.UTC(2026, 8, 30, 20, 0);
Date.now = () => clock;

const ROPER = 0xff000020, VICTIM = 0xff000021, GUARD = 0xff000022, FRIEND = 0xff000023;
const MANACLES = 0x0010f00f;
const users = new Map([[ROPER, 1], [VICTIM, 2], [GUARD, 3], [FRIEND, 4]]);
const props = new Map();
const where = new Map([[ROPER, [0, 0, 0]], [VICTIM, [100, 0, 0]], [GUARD, [0, 100, 0]], [FRIEND, [50, 50, 0]]]);
const CELL = 'a764b:BSHeartland.esm';
const packets = [];
const papyrus = [];
const names = new Map([[ROPER, 'Roper'], [VICTIM, 'Victim'], [GUARD, 'Guard'], [FRIEND, 'Friend']]);
const svr = {
  getUserByActor: (a) => (users.has(a) ? users.get(a) : -1),
  getUserActor: (u) => { for (const [a, x] of users) if (x === u) return a; return 0; },
  isConnected: () => true,
  get: (id, p) => (p === 'locationalData' ? { cellOrWorldDesc: CELL, pos: where.get(id), rot: [0, 0, 0] } : props.get(`${id}|${p}`)),
  set: (id, p, v) => props.set(`${id}|${p}`, v),
  sendCustomPacket: (u, s) => packets.push([u, JSON.parse(s)]),
  getActorCellOrWorld: () => CELL,
  getActorPos: (a) => where.get(a),
  getActorName: (a) => names.get(a) || '',
  getDescFromId: (id) => (id >>> 0).toString(16),
  callPapyrusFunction: (kind, cls, method) => { papyrus.push(method); return null; },
};
const ctx = { svr, gm: { on: () => {} } };
sys.manaclesFormId = MANACLES;

// ---- init advertises rope binding, so rope.js and playermenu.js offer the rope entries only on this build ------------
delete globalThis.__dboRopeCapture;
sys.registerHooks(ctx);
check('init sets __dboRopeCapture', globalThis.__dboRopeCapture === true);
check('and registers __dboLeash, __dboBreakFree and __dboUncuff', ['__dboLeash', '__dboBreakFree', '__dboUncuff'].every((k) => typeof globalThis[k] === 'function'));
props.set(`${GUARD}|private.dboLawful`, true);

// rope.js's hooks, counting ropes
const ropes = new Map([[ROPER, 2]]);
const took = [];
const restrainedHook = [];
globalThis.__dboRopeHeld = (a) => (ropes.get(a) || 0) > 0;
globalThis.__dboRopeTake = (a, t) => { if (!(ropes.get(a) > 0)) return false; ropes.set(a, ropes.get(a) - 1); took.push([a, t]); return true; };
globalThis.__dboOnRestrained = (t, c, rope) => restrainedHook.push([t, c, rope]);
globalThis.__dboInstantRestraint = () => false;

const req = (actor, type, content) => sys.customPacket(users.get(actor), type, content, ctx);
const noticesTo = (actor) => packets.filter(([u, p]) => u === users.get(actor) && p.customPacketType === 'captureNotice').map(([, p]) => p.text);
const lastConsent = () => { const hit = packets.filter(([, p]) => p.customPacketType === 'captureConsentRequest').pop(); return hit && hit[1]; };
const reset = () => { packets.length = 0; papyrus.length = 0; took.length = 0; restrainedHook.length = 0; logs.length = 0; };
const free = (a) => { sys.releaseTarget(ctx, a); sys.escapedUntil.delete(a); sys.consentCooldown.clear(); sys.ropeRefusedUntil.clear(); props.set(`${a}|isDead`, false); };

// ---- who may tie ----------------------------------------------------------------------------------------------
const held = globalThis.__dboRopeHeld;
globalThis.__dboRopeHeld = undefined;
reset(); req(ROPER, 'captureRequest', { target: VICTIM });
check('rope binding off (no rope.js hook): only guards may restrain, as before', noticesTo(ROPER).some((t) => /Only guards/.test(t)) && !sys.restraints.has(VICTIM), noticesTo(ROPER));
globalThis.__dboRopeHeld = held;
ropes.set(FRIEND, 0);
reset(); req(FRIEND, 'captureRequest', { target: VICTIM });
check('without a rope: "You need a rope"', noticesTo(FRIEND).some((t) => /need a rope/.test(t)) && !lastConsent(), noticesTo(FRIEND));

// ---- a conscious player is asked, never tied on sight ------------------------------------------------------
reset(); req(ROPER, 'captureRequest', { target: VICTIM });
let c = lastConsent();
check('a conscious player gets the prompt', !!c && /Roper wants to tie your hands with rope\. Allow\?/.test(c.text), c);
check('and is not tied yet, and no rope is taken', !sys.restraints.has(VICTIM) && took.length === 0);
reset(); req(VICTIM, 'captureConsentResult', { requestId: c.requestId, accepted: true });
let r = sys.restraints.get(VICTIM);
check('a yes ties them with rope', r && r.boundHands && r.rope === true && r.captorActorId === ROPER, r);
check('the rope is taken when the knot is tied, from the captor, naming the captive', took.length === 1 && took[0][0] === ROPER && took[0][1] === VICTIM, took);
check('a rope captive wears no shackles', !papyrus.includes('EquipItem') && !r.addedShackle, papyrus);
check('the property says rope', (props.get(`${VICTIM}|private.restrained`) || {}).rope === true);
check('the struggle hook hears it is rope', restrainedHook.length === 1 && restrainedHook[0][2] === true, restrainedHook);
check('the captor is told', noticesTo(ROPER).some((t) => /accepted — tied up/.test(t)), noticesTo(ROPER));
const rs = packets.filter(([u, p]) => u === 2 && p.customPacketType === 'restraintState').pop();
check('the captive is on the tether to the captor', rs && rs[1].leash === ROPER, rs);

// ---- Leave Tied Here / Lead ------------------------------------------------------------------------------------
reset();
check('Leave Tied Here turns the tether off', sys.setLeash(ctx, VICTIM, false) === true);
let st = packets.filter(([u, p]) => u === 2 && p.customPacketType === 'restraintState').pop();
check('the captive\'s client is sent leash 0', st && st[1].leash === 0 && st[1].boundHands === true, st);
check('the property says untethered', (props.get(`${VICTIM}|private.restrained`) || {}).untethered === true);
where.set(ROPER, [5000, 0, 0]);
reset(); sys.followLeashes(ctx);
check('a captor far off does not pull an untethered captive after them', !packets.some(([, p]) => p.customPacketType === 'restraintState') && where.get(VICTIM)[0] === 100 && props.get(`${VICTIM}|locationalData`) === undefined);
check('leaving them twice changes nothing', sys.setLeash(ctx, VICTIM, false) === false);
check('Lead puts the tether back', sys.setLeash(ctx, VICTIM, true) === true);
reset(); sys.followLeashes(ctx);
check('and a captor far off pulls them over again', !!props.get(`${VICTIM}|locationalData`));
props.delete(`${VICTIM}|locationalData`);
where.set(ROPER, [0, 0, 0]);

// ---- untying, carrying ------------------------------------------------------------------------------------------
reset(); req(FRIEND, 'releaseRequest', { target: VICTIM });
check('a stranger cannot untie them through Uncuff', sys.restraints.has(VICTIM) && noticesTo(FRIEND).some((t) => /Only their captor/.test(t)));
reset(); req(FRIEND, 'carryRequest', { target: VICTIM });
check('a stranger cannot carry them', noticesTo(FRIEND).some((t) => /Only guards/.test(t)));
reset(); req(ROPER, 'carryRequest', { target: VICTIM });
check('their rope captor may carry them, as a guard may carry an arrest', !noticesTo(ROPER).some((t) => /Only guards/.test(t)), noticesTo(ROPER));
sys.dropPendingFor(VICTIM);
reset(); req(ROPER, 'releaseRequest', { target: VICTIM });
check('their captor unties them: "You untied"', !sys.restraints.has(VICTIM) && noticesTo(ROPER).some((t) => /You untied Victim/.test(t)), noticesTo(ROPER));
check('untying takes no shackles off (there were none)', !papyrus.includes('UnequipItem'), papyrus);

// ---- a refusal holds 2 minutes; no answer counts the same ----------------------------------------------------------
free(VICTIM);
reset(); req(ROPER, 'captureRequest', { target: VICTIM }); c = lastConsent();
req(VICTIM, 'captureConsentResult', { requestId: c.requestId, accepted: false });
check('a no ties nothing and takes no rope', !sys.restraints.has(VICTIM) && took.length === 0);
clock += 30000;
reset(); req(ROPER, 'captureRequest', { target: VICTIM });
check('asked again 30 s later: "refused you not long ago", no prompt', !lastConsent() && noticesTo(ROPER).some((t) => /refused you not long ago/.test(t)), noticesTo(ROPER));
clock += 91000;
reset(); req(ROPER, 'captureRequest', { target: VICTIM }); c = lastConsent();
check('after 2 minutes they may be asked again', !!c);
reset(); for (const f of timers.splice(0)) if (f) f();
clock += 20000;
reset(); req(ROPER, 'captureRequest', { target: VICTIM });
check('no answer holds the same way', !lastConsent() && noticesTo(ROPER).some((t) => /refused you not long ago/.test(t)), noticesTo(ROPER));
reset(); req(GUARD, 'captureRequest', { target: VICTIM });
check('the hold is per pair: a guard can still ask', !!lastConsent());
sys.dropPendingFor(VICTIM);

// ---- the rope is taken at the knot, not the ask ----------------------------------------------------------------------
free(VICTIM); ropes.set(ROPER, 1);
reset(); req(ROPER, 'captureRequest', { target: VICTIM }); c = lastConsent();
ropes.set(ROPER, 0);   // sold or dropped while the prompt was open
reset(); req(VICTIM, 'captureConsentResult', { requestId: c.requestId, accepted: true });
check('a yes after the rope is gone ties nothing', !sys.restraints.has(VICTIM) && noticesTo(ROPER).some((t) => /no rope left/.test(t)), noticesTo(ROPER));
check('and the captive is told why', noticesTo(VICTIM).some((t) => /had no rope left/.test(t)), noticesTo(VICTIM));

// ---- a downed player is tied at once ----------------------------------------------------------------------------------
free(VICTIM); ropes.set(ROPER, 1); props.set(`${VICTIM}|isDead`, true);
reset(); req(ROPER, 'captureRequest', { target: VICTIM });
r = sys.restraints.get(VICTIM);
check('a downed player is tied at once, no prompt', r && r.rope === true && !lastConsent(), r);
check('and stood up, as a guard\'s arrest does', props.get(`${VICTIM}|isDead`) === false);
check('the last rope is used', ropes.get(ROPER) === 0 && took.length === 1);

// ---- the slip, the cut, and the grace after --------------------------------------------------------------------------
reset();
check('a slip frees a rope captive', sys.breakFree(ctx, VICTIM, 'slip') === true && !sys.restraints.has(VICTIM));
check('the captor hears it slipped', noticesTo(ROPER).some((t) => /slipped out of the rope/.test(t)), noticesTo(ROPER));
check('a rope captive gets the 60 s rope grace', (sys.escapedUntil.get(VICTIM) || 0) - clock === 60000, (sys.escapedUntil.get(VICTIM) || 0) - clock);
ropes.set(ROPER, 1); clock += 30000;
reset(); req(ROPER, 'captureRequest', { target: VICTIM });
check('30 s later they cannot be tied again while standing', !sys.restraints.has(VICTIM) && noticesTo(ROPER).some((t) => /slipped your grasp/.test(t)), noticesTo(ROPER));
free(VICTIM); props.set(`${VICTIM}|isDead`, true);
reset(); req(ROPER, 'captureRequest', { target: VICTIM });
reset();
check('a cut frees a rope captive', sys.breakFree(ctx, VICTIM, 'cut') === true && noticesTo(ROPER).some((t) => /Someone cut Victim free/.test(t)), noticesTo(ROPER));

// ---- guard shackles are untouched -------------------------------------------------------------------------------
free(VICTIM);
reset(); req(GUARD, 'captureRequest', { target: VICTIM }); c = lastConsent();
check('a guard without authority here still asks, with the old words', !!c && /Guard wants to restrain you\. Allow\?/.test(c.text), c);
reset(); req(VICTIM, 'captureConsentResult', { requestId: c.requestId, accepted: true });
r = sys.restraints.get(VICTIM);
check('a guard\'s arrest is not rope and wears shackles', r && !r.rope && papyrus.includes('EquipItem'), [r, papyrus]);
check('no rope is taken for an arrest', took.length === 0);
check('shackles never slip', globalThis.__dboBreakFree(VICTIM, 'slip') === false && sys.restraints.has(VICTIM));
check('shackles are never cut', sys.breakFree(ctx, VICTIM, 'cut') === false && sys.restraints.has(VICTIM));
check('an arrest cannot be left untethered', sys.setLeash(ctx, VICTIM, false) === false);
reset();
check('a struggle still frees an arrest with the 20 s grace', sys.breakFree(ctx, VICTIM, 'struggle') === true && (sys.escapedUntil.get(VICTIM) || 0) - clock === 20000);

// ---- relog: a rope captive is re-tied without shackles ---------------------------------------------------------------
free(VICTIM); props.set(`${VICTIM}|isDead`, true); ropes.set(ROPER, 1);
req(ROPER, 'captureRequest', { target: VICTIM });
sys.setLeash(ctx, VICTIM, false);
reset(); sys.onActorAssigned(ctx, VICTIM);
st = packets.filter(([u, p]) => u === 2 && p.customPacketType === 'restraintState').pop();
check('a relog keeps the rope, left tied, and puts no shackles on', st && st[1].boundHands && st[1].leash === 0 && !papyrus.includes('EquipItem'), [st, papyrus]);

console.log('');
console.log(failures ? `${failures} FAILURES` : 'all checks passed');
process.exit(failures ? 1 : 0);
