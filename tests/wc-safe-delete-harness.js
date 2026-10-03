// Scripted test for the world cleaner's delete (fork client-wc-safe-delete): it goes through npcLifetime's safeDelete and
// always the slow way (disabled now, deleted once its 3D is gone), whatever the actor is doing. The cleaner's own delete
// skipped the 3D wait, and a dead server-spawned copy went straight to it (B's npc-lifetime review, 3 Oct).
//   node tests/wc-safe-delete-harness.js <bundle of skymp5-client/src/view/npcLifetime.ts>   (FORK for the source checks)
'use strict';
const fs = require('fs');
const path = require('path');
const L = require(path.resolve(process.argv[2]));
let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };
const finish = (skipped) => { console.log(failures ? `${failures} FAILED` : skipped ? `all checks run passed, ${skipped} SKIPPED (see above)` : 'all checks passed'); process.exit(failures ? 1 : 0); };
if (typeof L.deleteNow !== 'function') {
  require('./expect')('wc-safe-delete', 'this npcLifetime.ts has no deleteNow yet (fork branch client-wc-safe-delete)');
  console.log('SKIP  every check: no deleteNow in this npcLifetime.ts');
  finish(9);
}
const calm = { is3DLoaded: true, dead: false, bleedingOut: false, unconscious: false, inKillMove: false, ragdolledAt: 0 };
const now = 100000;
check('a calm copy may still be deleted at once by the view (FormView.destroy, unchanged)', L.deleteNow(calm, now, false) === true);
check('a deferred delete never runs at once, even for a calm actor', L.deleteNow(calm, now, true) === false);
check('a dead copy is never deleted at once (the server-spawned body the cleaner reached)', L.deleteNow({ ...calm, dead: true }, now, false) === false);
check('...nor a downed, bleeding-out or ragdolling one', L.deleteNow({ ...calm, bleedingOut: true }, now, false) === false && L.deleteNow({ ...calm, ragdolledAt: now - 100 }, now, false) === false);
check('a deferred delete waits for the 3D to go, at least a few frames', L.deleteDecision(1, false) === 'wait' && L.deleteDecision(L.SAFE_DELETE_MIN_FRAMES, false) === 'delete' && L.deleteDecision(L.SAFE_DELETE_MIN_FRAMES, true) === 'wait');
check('...and never waits for ever', L.deleteDecision(L.SAFE_DELETE_MAX_FRAMES, true) === 'delete');

const FORK = process.env.FORK;
const file = (rel) => FORK && path.join(FORK, rel);
if (!FORK || !fs.existsSync(file('skymp5-client/src/services/services/worldCleanerService.ts'))) {
  require('./expect')('wc-safe-delete', 'the source checks cannot run: FORK is not set');
  console.log('SKIP  3 source checks: FORK is not set');
  finish(3);
}
const wc = fs.readFileSync(file('skymp5-client/src/services/services/worldCleanerService.ts'), 'utf8');
const rt = fs.readFileSync(file('skymp5-client/src/view/npcLifetimeRuntime.ts'), 'utf8');
check('the world cleaner deletes through safeDelete, always deferred', /safeDelete\(actor, \{ defer: true \}\);/.test(wc) && /import \{ safeDelete \} from "\.\.\/\.\.\/view\/npcLifetimeRuntime";/.test(wc));
check('...and has no delete of its own left (no disable().then(delete))', !/\.delete\(\)/.test(wc) && !/disable\(false\)\.then/.test(wc));
check('safeDelete takes the defer option through deleteNow', /export const safeDelete = \(refr: ObjectReference, opts\?: \{ defer\?: boolean \}\)/.test(rt) && /deleteNow\(stateOf\(ac, id\), Date\.now\(\), !!\(opts && opts\.defer\)\)/.test(rt));
finish(0);
