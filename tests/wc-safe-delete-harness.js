// Scripted test for the world cleaner's delete (fork client-wc-safe-delete): it goes through npcLifetime's safeDelete and
// always the slow way (disabled now, deleted once its 3D is gone), whatever the actor is doing. The cleaner's own delete
// skipped the 3D wait, and a dead server-spawned copy went straight to it (B's npc-lifetime review, 3 Oct).
// Then (client-safedelete-guard, 4 Oct): nothing is queued on a ref already deleted, already handed to Delete() or
// already waiting, and one with no 3D is deleted outright. 0.3.75 queued disableNoWait on a copy FormView.destroy had
// deleted 79 ms earlier (Delete() is latent, so it still read as not deleted), with no 3D, and the Disable task crashed.
//   node tests/wc-safe-delete-harness.js <bundle of skymp5-client/src/view/npcLifetime.ts>
// FORK set: the source checks, and npcLifetimeRuntime.ts bundled with a fake SkyrimPlatform that steps frames.
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
if (L.SAFE_DELETE_MAX_FRAMES !== undefined) {
  check('a deferred delete waits for the 3D to go, at least a few frames', L.deleteDecision(1, false) === 'wait' && L.deleteDecision(L.SAFE_DELETE_MIN_FRAMES, false) === 'delete' && L.deleteDecision(L.SAFE_DELETE_MIN_FRAMES, true) === 'wait');
  check('...and never waits for ever', L.deleteDecision(L.SAFE_DELETE_MAX_FRAMES, true) === 'delete');
} else {
  // client-safedelete-loadwait: the cap gives up (left disabled) instead of deleting; tests/safedelete-loadwait-harness.js
  const step = (p, loaded) => L.deleteDecision(p, loaded, false, L.SAFE_DELETE_STEP_MS);
  check('a deferred delete waits for the 3D to go, at least a few updates', step(L.newPendingDelete(), false).decision === 'wait' && step(L.newPendingDelete(), true).decision === 'wait');
  check('...and never waits for ever: it gives up, leaving the copy disabled', step({ unloadedFrames: 0, waitedMs: L.SAFE_DELETE_GIVE_UP_MS }, true).decision === 'give-up');
}

// ---- the guard: deletePlan and RecentDeletes ----
const hasGuard = typeof L.deletePlan === 'function' && typeof L.RecentDeletes === 'function';
if (!hasGuard) {
  require('./expect')('wc-safe-delete', 'this npcLifetime.ts has no deletePlan yet (fork branch client-safedelete-guard)');
  console.log('SKIP  the guard checks: no deletePlan in this npcLifetime.ts');
} else {
  const facts = (extra) => Object.assign({ handedToDelete: false, queued: false, deleted: false, is3DLoaded: true, state: calm, defer: false }, extra || {});
  check('a calm, loaded copy is deleted at once by the view', L.deletePlan(facts(), now) === 'delete');
  check('a deferred delete of a loaded copy is disabled first', L.deletePlan(facts({ defer: true }), now) === 'defer');
  check('a dead, loaded copy is disabled first', L.deletePlan(facts({ state: { ...calm, dead: true } }), now) === 'defer');
  check('a deferred delete with 3d=false is deleted outright, no Disable', L.deletePlan(facts({ defer: true, is3DLoaded: false, state: { ...calm, is3DLoaded: false } }), now) === 'delete');
  check('...also for a dead copy with no 3D', L.deletePlan(facts({ defer: true, is3DLoaded: false, state: { ...calm, is3DLoaded: false, dead: true } }), now) === 'delete');
  check('a ref handed to Delete() is skipped, deferred or not', L.deletePlan(facts({ handedToDelete: true }), now) === 'skip' && L.deletePlan(facts({ handedToDelete: true, defer: true }), now) === 'skip');
  check('the 0.3.75 crash case (deleted a moment ago, deferred, 3d=false) is skipped', L.deletePlan(facts({ handedToDelete: true, defer: true, is3DLoaded: false }), now) === 'skip');
  check('a ref already waiting (disabled by safeDelete) is skipped', L.deletePlan(facts({ queued: true }), now) === 'skip' && L.deletePlan(facts({ queued: true, defer: true }), now) === 'skip');
  check('a ref that reads as deleted is skipped', L.deletePlan(facts({ deleted: true, defer: true }), now) === 'skip');
  check('a non-actor ref: deleted at once, or disabled first when deferred', L.deletePlan(facts({ state: null }), now) === 'delete' && L.deletePlan(facts({ state: null, defer: true }), now) === 'defer');

  const r = new L.RecentDeletes();
  const id = 0xff001426;
  r.note(id, now);
  check('delete then deferred delete of one ref within one frame: the second is skipped',
    L.deletePlan(facts({ handedToDelete: r.has(id, now + 16), defer: true, is3DLoaded: false }), now + 16) === 'skip');
  check('...and 79 ms later (Johann, 4 Oct 00:10:55)', r.has(id, now + 79));
  check('the mark is short-lived', L.RECENT_DELETE_MS > 0 && L.RECENT_DELETE_MS <= 60000 && r.has(id, now + L.RECENT_DELETE_MS - 1) && !r.has(id, now + L.RECENT_DELETE_MS));
  r.note(id, now);
  r.forget(id);
  check('a new copy placed under a reused id is not marked', !r.has(id, now));
  const small = new L.RecentDeletes(1000, 4);
  for (let i = 0; i < 10; i++) small.note(0xff000000 + i, now);
  check('the set is bounded (the oldest go first)', small.size() === 4 && !small.has(0xff000000, now) && small.has(0xff000009, now), small.size());
}

const FORK = process.env.FORK;
const file = (rel) => FORK && path.join(FORK, rel);
if (!FORK || !fs.existsSync(file('skymp5-client/src/services/services/worldCleanerService.ts'))) {
  require('./expect')('wc-safe-delete', 'the source checks cannot run: FORK is not set');
  console.log('SKIP  the source and runtime checks: FORK is not set');
  finish(3);
}
const wc = fs.readFileSync(file('skymp5-client/src/services/services/worldCleanerService.ts'), 'utf8');
const rt = fs.readFileSync(file('skymp5-client/src/view/npcLifetimeRuntime.ts'), 'utf8');
check('the world cleaner deletes through safeDelete, always deferred', /safeDelete\(actor, \{ defer: true \}\);/.test(wc) && /import \{ (disableOnly, )?(isHandedToDelete, )?safeDelete \} from "\.\.\/\.\.\/view\/npcLifetimeRuntime";/.test(wc));
check('...and has no delete of its own left (no disable().then(delete))', !/\.delete\(\)/.test(wc) && !/disable\(false\)\.then/.test(wc));
if (!hasGuard) {
  check('safeDelete takes the defer option through deleteNow', /export const safeDelete = \(refr: ObjectReference, opts\?: \{ defer\?: boolean \}\)/.test(rt) && /deleteNow\(stateOf\(ac, id\), Date\.now\(\), !!\(opts && opts\.defer\)\)/.test(rt));
  finish(0);
}
check('safeDelete takes the defer option through deletePlan', /export const safeDelete = \(refr: ObjectReference, opts\?: \{ defer\?: boolean \}\)/.test(rt) && /deletePlan\(\{[\s\S]*?defer: !!\(opts && opts\.defer\),[\s\S]*?\}, now\)/.test(rt));
const guardAt = wc.indexOf('if (isHandedToDelete(actorId))');
check('the cleaner leaves an id handed to delete alone, before any call of its own that queues something',
  guardAt > 0 && guardAt < wc.indexOf('actor.disableNoWait(true)') && guardAt < wc.indexOf('actor.disableNoWait(false)') && guardAt < wc.indexOf('safeDelete(actor, { defer: true })'));
const fv = fs.readFileSync(file('skymp5-client/src/view/formView.ts'), 'utf8');
check('FormView clears the mark when it places a copy (dynamic ids are reused)', /noteCopyPlaced\(refr\.getFormID\(\)\);/.test(fv));

// ---- the runtime, frame by frame, with a fake SkyrimPlatform ----
// Delete() is latent: a ref reads as deleted only once the engine has run the task, a frame later (or never, as on 4 Oct).
const os = require('os');
const esbuildDir = [process.env.FORK_SERVER, FORK].filter(Boolean).map((f) => path.join(f, 'skymp5-server', 'node_modules', 'esbuild')).find((p) => fs.existsSync(p))
  || path.join(process.env.HOME, 'dragonbreak', 'fork', 'skymp5-server', 'node_modules', 'esbuild');
const esbuild = require(esbuildDir);
const fakeSp = `
const W = globalThis.__wcFakeWorld;
const Game = { getFormEx: (id) => W.refs.get(id) || null, getPlayer: () => null };
const ObjectReference = { from: (f) => f || null };
const Actor = { from: (f) => (f && f.actor ? f : null) };
const on = (ev, fn) => { if (ev === 'update') W.update.push(fn); };
const Ui = { isMenuOpen: (m) => W.menus.has(m) };
module.exports = { Game, ObjectReference, Actor, Ui, on, writeLogs: (_p, line) => W.log.push(line) };`;
const stubPlugin = {
  name: 'stubs',
  setup(b) {
    b.onResolve({ filter: /^skyrimPlatform$/ }, () => ({ path: 'skyrimPlatform', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: fakeSp, loader: 'js' }));
  },
};
(async () => {
  const W = { refs: new Map(), update: [], log: [], calls: [], tasks: [], menus: new Set() };
  // The runtime counts time outside loading screens (client-safedelete-loadwait): a frame is 16 ms of a fake clock
  let clock = Date.now();
  Date.now = () => clock;
  globalThis.__wcFakeWorld = W;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-wcsd-'));
  const out = path.join(dir, 'rt.js');
  try {
    await esbuild.build({ entryPoints: [file('skymp5-client/src/view/npcLifetimeRuntime.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, plugins: [stubPlugin], logLevel: 'error' });
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`FAIL  bundling npcLifetimeRuntime.ts: ${e.message}`);
    failures++;
    finish(0);
  }
  const R = require(out);
  fs.rmSync(dir, { recursive: true, force: true });
  // A runtime without the guard's exports still runs every scenario and reports its failures
  const handed = (id) => typeof R.isHandedToDelete === 'function' && R.isHandedToDelete(id) === true;
  const placed = (id) => { if (typeof R.noteCopyPlaced === 'function') R.noteCopyPlaced(id); };
  if (typeof R.isHandedToDelete !== 'function' || typeof R.noteCopyPlaced !== 'function') console.log('FAIL  this npcLifetimeRuntime.ts has no isHandedToDelete / noteCopyPlaced'), failures++;
  const mkRef = (id, o) => {
    const ref = Object.assign({ actor: true, loaded: true, deleted: false, disabled: false, dead: false }, o || {});
    Object.assign(ref, {
      getFormID: () => id,
      getBaseObject: () => ({ getFormID: () => 7 }),
      is3DLoaded: () => ref.loaded,
      isDeleted: () => ref.deleted,
      isDisabled: () => ref.disabled,
      isDead: () => ref.dead,
      isBleedingOut: () => false,
      isUnconscious: () => false,
      isInKillMove: () => false,
      // Both are queued for the engine; a call on a ref whose Delete already ran is the crash
      delete: () => { W.calls.push(['delete', id]); W.tasks.push(() => { ref.deleted = ref.landDelete !== false; ref.loaded = false; }); return Promise.resolve(); },
      disableNoWait: () => { W.calls.push(['disableNoWait', id]); W.tasks.push(() => { if (ref.deleted || W.calls.filter((c) => c[0] === 'delete' && c[1] === id).length) W.crashed = id; ref.disabled = true; ref.loaded = false; }); },
    });
    W.refs.set(id, ref);
    return ref;
  };
  const frame = () => { clock += 16; for (const t of W.tasks.splice(0)) t(); for (const fn of W.update) fn(); };
  const callsOn = (id, kind) => W.calls.filter((c) => c[1] === id && (!kind || c[0] === kind)).length;

  // Johann, 4 Oct 00:10:55: FormView.destroy deletes the copy, and the cleaner reaches it in the same frame and 79 ms later
  const a = mkRef(0xff001426, { landDelete: false });
  R.safeDelete(a);
  R.safeDelete(a, { defer: true });
  frame();
  a.loaded = false;
  R.safeDelete(a, { defer: true });
  for (let i = 0; i < 5; i++) frame();
  check('delete then deferred delete of one ref within one frame: one Delete(), no Disable queued', callsOn(a.getFormID(), 'delete') === 1 && callsOn(a.getFormID(), 'disableNoWait') === 0 && !W.crashed, W.calls);
  check('...and the cleaner sees it as handed to delete (it touches nothing on it)', handed(a.getFormID()));
  check('...and the trail says so', W.log.some((l) => / delete-skipped ff001426 /.test(l)), W.log.slice(-4));

  // A deferred delete of a copy with no 3D: deleted outright
  const b = mkRef(0xff001500, { loaded: false });
  R.safeDelete(b, { defer: true });
  for (let i = 0; i < 3; i++) frame();
  check('a deferred delete with 3d=false: one Delete(), no Disable', callsOn(b.getFormID(), 'delete') === 1 && callsOn(b.getFormID(), 'disableNoWait') === 0 && !W.crashed, W.calls.filter((c) => c[1] === b.getFormID()));

  // A loaded copy the cleaner reaches: disabled now, deleted once its 3D is gone; the view's own delete meanwhile adds nothing
  const c = mkRef(0xff001501);
  R.safeDelete(c, { defer: true });
  R.safeDelete(c);
  for (let i = 0; i < 200; i++) frame();
  check('a deferred delete of a loaded copy: one Disable, then one Delete() once its 3D is gone', callsOn(c.getFormID(), 'disableNoWait') === 1 && callsOn(c.getFormID(), 'delete') === 1 && !W.crashed, W.calls.filter((x) => x[1] === c.getFormID()));
  check('...the Disable came first', W.calls.findIndex((x) => x[1] === c.getFormID()) === W.calls.findIndex((x) => x[1] === c.getFormID() && x[0] === 'disableNoWait'));

  // A ref that already reads as deleted, and a new copy placed under a reused id
  const d = mkRef(0xff001502, { deleted: true });
  R.safeDelete(d, { defer: true });
  R.safeDelete(d);
  check('a ref that reads as deleted gets nothing queued', callsOn(d.getFormID()) === 0);
  const e = mkRef(0xff001503);
  R.safeDelete(e);
  placed(e.getFormID());
  const e2 = mkRef(0xff001503);
  R.safeDelete(e2);
  check('a new copy placed under a reused id is deleted again', callsOn(e2.getFormID(), 'delete') === 2 && handed(e2.getFormID()));
  check('no Disable ever ran on a deleted ref', !W.crashed, W.crashed && W.crashed.toString(16));
  finish(0);
})();
