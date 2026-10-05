// Scripted test for fork client-safedelete-loadwait (client 0.3.77): the client never deletes an NPC copy while its 3D is
// still loaded or while a loading screen (Loading Menu, Fader Menu) is open, and the world cleaner only disables plugin-placed
// actors. Nate, 4 Oct 07:35:41Z, client 0.3.76: Play on a character parked in Baan Malur (Solstheim), a crash 6 s later in
// the Fader Menu inside havok's post-simulation step (bhkCharRigidBodyController of a plugin-placed Character, Polvyn
// Pomero 0x092492B6, through a garbage vtable). The cleaner swept the cell's living plugin actors one per update in the
// fade (update runs while the Fader Menu is open: 148k input-diag samples show it, none ever with the Loading Menu), each
// disableNoWait'd and then deleted after at most 60 frames whatever its 3D: half a second at 120 fps.
//   node tests/safedelete-loadwait-harness.js <bundle of skymp5-client/src/view/npcLifetime.ts>
// FORK set: the source checks, and npcLifetimeRuntime.ts bundled with a fake SkyrimPlatform that steps frames on a fake clock.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require(path.resolve(process.argv[2]));
let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };
const finish = (skipped) => { console.log(failures ? `${failures} FAILED` : skipped ? `all checks run passed, ${skipped} SKIPPED (see above)` : 'all checks passed'); process.exit(failures ? 1 : 0); };
if (L.SAFE_DELETE_GIVE_UP_MS === undefined || typeof L.newPendingDelete !== 'function') {
  require('./expect')('safedelete-loadwait', 'this npcLifetime.ts still has the frame cap (fork branch client-safedelete-loadwait)');
  console.log('SKIP  every check: no SAFE_DELETE_GIVE_UP_MS in this npcLifetime.ts');
  finish(25);
}

// ---- the rules, pure ----
// Runs updates until a decision other than wait; returns the decision, the updates taken and the last state
const run = (n, loadedAt, screenAt, stepMs) => {
  let p = L.newPendingDelete();
  for (let i = 0; i < n; i++) {
    const r = L.deleteDecision(p, loadedAt(i), screenAt(i), stepMs);
    p = r.next;
    if (r.decision !== 'wait') return { decision: r.decision, at: i + 1, p };
  }
  return { decision: 'wait', at: n, p };
};
const always = (v) => () => v;
check('the constants: at least 3 unloaded updates, a settle of 1 s or more, a give-up of 10 s or more, a step cap',
  L.SAFE_DELETE_MIN_FRAMES >= 3 && L.SAFE_DELETE_SETTLE_MS >= 1000 && L.SAFE_DELETE_GIVE_UP_MS >= 10000 && L.SAFE_DELETE_STEP_MS > 0 && L.SAFE_DELETE_STEP_MS <= 250);
check('the 60-frame cap is gone', L.SAFE_DELETE_MAX_FRAMES === undefined);
let r = run(60, always(true), always(false), 8);
check('0.3.76 deleted a loaded copy at 60 updates (0.5 s at 120 fps): now it waits', r.decision === 'wait', r);
r = run(20000, always(false), always(true), 16);
check('during a loading screen nothing is deleted, however long, and nothing counts', r.decision === 'wait' && r.p.waitedMs === 0 && r.p.unloadedFrames === 0, r);
r = run(20000, always(true), always(false), 16);
check('a copy whose 3D stays loaded is never deleted: it gives up at the give-up time (left disabled)', r.decision === 'give-up' && r.at === Math.ceil(L.SAFE_DELETE_GIVE_UP_MS / 16), r);
r = run(20000, always(false), always(false), 16);
check('an unloaded copy is deleted at the settle time, not before', r.decision === 'delete' && r.at === Math.ceil(L.SAFE_DELETE_SETTLE_MS / 16), r);
r = run(20000, always(false), always(false), 1000);
check('...and slow frames count the step cap at most each', r.decision === 'delete' && r.at === Math.ceil(L.SAFE_DELETE_SETTLE_MS / L.SAFE_DELETE_STEP_MS), r);
{
  let q = { unloadedFrames: 0, waitedMs: L.SAFE_DELETE_SETTLE_MS * 2 }, ds = [];
  for (let i = 0; i < L.SAFE_DELETE_MIN_FRAMES; i++) { const x = L.deleteDecision(q, false, false, 16); ds.push(x.decision); q = x.next; }
  check('past the settle time it still waits for the minimum unloaded updates in a row', ds.slice(0, -1).every((x) => x === 'wait') && ds[ds.length - 1] === 'delete', ds);
}
r = run(1, always(false), always(false), 60000);
check('the first update after a long load counts the step cap, not the load', r.decision === 'wait' && r.p.waitedMs === L.SAFE_DELETE_STEP_MS, r);
check('a negative or missing step counts nothing', L.deleteDecision(L.newPendingDelete(), false, false, -50).next.waitedMs === 0 && L.deleteDecision(L.newPendingDelete(), false, false, NaN).next.waitedMs === 0);
// unloaded, then one loaded read: the run starts again
let p = { unloadedFrames: 2, waitedMs: L.SAFE_DELETE_SETTLE_MS };
p = L.deleteDecision(p, true, false, 16).next;
check('a loaded read breaks the unloaded run', p.unloadedFrames === 0);
let d = L.deleteDecision(p, false, false, 16);
check('...so the next unloaded read does not delete yet', d.decision === 'wait' && d.next.unloadedFrames === 1, d);
p = { unloadedFrames: 5, waitedMs: 5000 };
d = L.deleteDecision(p, false, true, 16);
check('a loading screen also restarts the unloaded run, and keeps the time waited', d.decision === 'wait' && d.next.unloadedFrames === 0 && d.next.waitedMs === 5000, d);
// Baan Malur: 2 s of Fader Menu at 120 fps after the load with the bodies still loaded, then the 3D goes 0.3 s after the fade
const fps = 8; const fader = 2000 / fps; const gone = fader + 300 / fps;
r = run(20000, (i) => i < gone, (i) => i < fader, fps);
check('Baan Malur: nothing is deleted in the fade, and a body is deleted only after its 3D has gone and the settle time has passed',
  r.decision === 'delete' && r.at > gone && r.at * fps - 2000 >= L.SAFE_DELETE_SETTLE_MS, r);

// deletePlan during a loading screen
const calm = { is3DLoaded: true, dead: false, bleedingOut: false, unconscious: false, inKillMove: false, ragdolledAt: 0 };
const facts = (extra) => Object.assign({ handedToDelete: false, queued: false, deleted: false, is3DLoaded: true, state: calm, defer: false, loadingScreen: false }, extra || {});
const now = 100000;
check('outside a loading screen the view still deletes a calm copy at once (unchanged)', L.deletePlan(facts(), now) === 'delete');
check('...and a copy with no 3D outright (unchanged)', L.deletePlan(facts({ is3DLoaded: false, defer: true }), now) === 'delete');
check('during a loading screen a calm copy is disabled first, never deleted at once', L.deletePlan(facts({ loadingScreen: true }), now) === 'defer');
check('...and so is one with no 3D (its 3D may still be on its way in)', L.deletePlan(facts({ loadingScreen: true, is3DLoaded: false }), now) === 'defer');
check('...while a ref handed to Delete(), queued or deleted is still skipped first (the 0.3.76 guard)',
  ['handedToDelete', 'queued', 'deleted'].every((k) => L.deletePlan(facts({ loadingScreen: true, [k]: true }), now) === 'skip'));

const FORK = process.env.FORK;
const file = (rel) => FORK && path.join(FORK, rel);
if (!FORK || !fs.existsSync(file('skymp5-client/src/services/services/worldCleanerService.ts'))) {
  require('./expect')('safedelete-loadwait', 'the source checks cannot run: FORK is not set');
  console.log('SKIP  the source and runtime checks: FORK is not set');
  finish(10);
}

// ---- the sources ----
const wc = fs.readFileSync(file('skymp5-client/src/services/services/worldCleanerService.ts'), 'utf8');
const rt = fs.readFileSync(file('skymp5-client/src/view/npcLifetimeRuntime.ts'), 'utf8');
const pluginAt = wc.search(/if \(actorId < 0xff000000\) \{\s*disableOnly\(actor\);\s*return;\s*\}/);
check('the world cleaner only disables a plugin-placed actor, before its safeDelete of a server spawn',
  pluginAt > 0 && pluginAt < wc.indexOf('safeDelete(actor, { defer: true })') && pluginAt > wc.indexOf('if (isHandedToDelete(actorId))'));
check('the runtime reads both loading screens', /isMenuOpen\("Loading Menu"\)/.test(rt) && /isMenuOpen\("Fader Menu"\)/.test(rt));
const src = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? src(path.join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : []);
check('no client source still uses the frame cap', !src(file('skymp5-client/src')).some((f) => /SAFE_DELETE_MAX_FRAMES/.test(fs.readFileSync(f, 'utf8'))));

// ---- the runtime, frame by frame, with a fake SkyrimPlatform and clock ----
const esbuildDir = [process.env.FORK_SERVER, FORK].filter(Boolean).map((f) => path.join(f, 'skymp5-server', 'node_modules', 'esbuild')).find((x) => fs.existsSync(x))
  || path.join(process.env.HOME, 'dragonbreak', 'fork', 'skymp5-server', 'node_modules', 'esbuild');
const esbuild = require(esbuildDir);
const fakeSp = `
const W = globalThis.__sdlwFakeWorld;
const Game = { getFormEx: (id) => W.refs.get(id) || null, getPlayer: () => null };
const ObjectReference = { from: (f) => f || null };
const Actor = { from: (f) => (f && f.actor ? f : null) };
const Ui = { isMenuOpen: (m) => { if (W.menuThrows) throw new Error('not in update'); return W.menus.has(m); } };
const on = (ev, fn) => { if (ev === 'update') W.update.push(fn); };
module.exports = { Game, ObjectReference, Actor, Ui, on, writeLogs: (_p, line) => W.log.push(line) };`;
const stubPlugin = {
  name: 'stubs',
  setup(b) {
    b.onResolve({ filter: /^skyrimPlatform$/ }, () => ({ path: 'skyrimPlatform', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: fakeSp, loader: 'js' }));
  },
};
(async () => {
  const W = { refs: new Map(), update: [], log: [], calls: [], tasks: [], menus: new Set(), menuThrows: false };
  globalThis.__sdlwFakeWorld = W;
  let clock = 1_790_000_000_000;
  Date.now = () => clock;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-sdlw-'));
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
  if (typeof R.disableOnly !== 'function') { console.log('FAIL  this npcLifetimeRuntime.ts has no disableOnly'); failures++; finish(0); }
  const mkRef = (id, o) => {
    const ref = Object.assign({ actor: true, loaded: true, deleted: false, disabled: false, dead: false, unloadOnDisable: true }, o || {});
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
      // A Delete() while the body is loaded or a loading screen is open is the crash this branch is about
      delete: () => { W.calls.push(['delete', id, clock]); if (ref.loaded || W.menus.size) W.crashed = id; W.tasks.push(() => { ref.deleted = true; ref.loaded = false; }); return Promise.resolve(); },
      disableNoWait: () => { W.calls.push(['disableNoWait', id, clock]); W.tasks.push(() => { ref.disabled = true; if (ref.unloadOnDisable) ref.loaded = false; }); },
    });
    W.refs.set(id, ref);
    return ref;
  };
  const frame = (ms) => { clock += ms || 8; for (const t of W.tasks.splice(0)) t(); for (const fn of W.update) fn(); };
  const frames = (n, ms) => { for (let i = 0; i < n; i++) frame(ms); };
  const callsOn = (id, kind) => W.calls.filter((c) => c[1] === id && (!kind || c[0] === kind));

  // Polvyn Pomero, a plugin-placed living NPC the cleaner reaches in the fade after the load
  W.menus.add('Fader Menu');
  const polvyn = mkRef(0x092492b6);
  R.disableOnly(polvyn);
  check('a plugin-placed actor is disabled at once and marked: the cleaner touches nothing more on it', callsOn(polvyn.getFormID(), 'disableNoWait').length === 1 && R.isHandedToDelete(polvyn.getFormID()));
  R.disableOnly(polvyn);
  frame();
  R.disableOnly(polvyn);
  check('...a second sweep before isDisabled reads true queues no second Disable', callsOn(polvyn.getFormID(), 'disableNoWait').length === 1);
  frames(250);
  W.menus.clear();
  frames(60 * 125);
  check('...and it is never deleted (60 s of updates, in and after the fade)', callsOn(polvyn.getFormID(), 'delete').length === 0);
  const gone = mkRef(0x09249300, { deleted: true });
  R.disableOnly(gone);
  check('disableOnly queues nothing on a ref that reads as deleted', callsOn(gone.getFormID()).length === 0);

  // A server spawn the cleaner reaches in the fade: disabled now, deleted only after the fade and the settle time
  W.menus.add('Fader Menu');
  const spawn = mkRef(0xff0016a0);
  R.safeDelete(spawn, { defer: true });
  const t0 = clock;
  frames(Math.ceil(5000 / 8));
  check('a deferred delete during the Fader Menu: disabled, and not deleted while the fade lasts (5 s)', callsOn(spawn.getFormID(), 'disableNoWait').length === 1 && callsOn(spawn.getFormID(), 'delete').length === 0);
  W.menus.clear();
  const closedAt = clock;
  frames(Math.ceil(5000 / 8));
  const del = callsOn(spawn.getFormID(), 'delete');
  check('...deleted once, after the fade closed and the settle time passed, with no 3D', del.length === 1 && del[0][2] - closedAt >= L.SAFE_DELETE_SETTLE_MS && !W.crashed, { del, closedAt, t0 });

  // The view's own delete of a calm, loaded copy during the fade: not at once
  W.menus.add('Fader Menu');
  const viewCopy = mkRef(0xff0016a1);
  R.safeDelete(viewCopy);
  check('the view deleting a calm copy during the fade disables it instead', callsOn(viewCopy.getFormID(), 'delete').length === 0 && callsOn(viewCopy.getFormID(), 'disableNoWait').length === 1);
  W.menus.clear();
  frames(Math.ceil(4000 / 8));
  check('...and deletes it after the fade', callsOn(viewCopy.getFormID(), 'delete').length === 1 && !W.crashed);

  // A body havok keeps: its 3D never unloads. 0.3.76 deleted it at 60 frames; now it is left disabled
  const stuck = mkRef(0xff0016a2, { unloadOnDisable: false });
  R.safeDelete(stuck, { defer: true });
  frames(Math.ceil((L.SAFE_DELETE_GIVE_UP_MS + 2000) / 8));
  check('a copy whose 3D never goes is never deleted', callsOn(stuck.getFormID(), 'delete').length === 0 && !W.crashed);
  check('...and is let go at the give-up time with a trail line', W.log.some((l) => / delete-abandoned ff0016a2 /.test(l)) && !R.isHandedToDelete(stuck.getFormID()), W.log.slice(-3));

  // The Loading Menu: no update runs, then the first one sees the whole load as its step
  const loadCopy = mkRef(0xff0016a3);
  R.safeDelete(loadCopy, { defer: true });
  frame();
  clock += 30000;   // a 30 s load with no updates
  frames(3);
  check('the first updates after a 30 s load count only the step cap: no delete yet', callsOn(loadCopy.getFormID(), 'delete').length === 0);
  frames(Math.ceil(L.SAFE_DELETE_SETTLE_MS / 8));
  check('...it goes after the settle time', callsOn(loadCopy.getFormID(), 'delete').length === 1 && !W.crashed);

  // A menu check that throws counts as a loading screen
  W.menuThrows = true;
  const blind = mkRef(0xff0016a4);
  R.safeDelete(blind);
  frames(Math.ceil(5000 / 8));
  check('an unreadable menu state counts as a loading screen: disabled, never deleted', callsOn(blind.getFormID(), 'delete').length === 0 && callsOn(blind.getFormID(), 'disableNoWait').length === 1);
  W.menuThrows = false;
  frames(Math.ceil(3000 / 8));
  check('...and deleted once the menus read again', callsOn(blind.getFormID(), 'delete').length === 1 && !W.crashed);
  check('no Delete() ever ran on a loaded body or during a loading screen', !W.crashed, W.crashed && W.crashed.toString(16));
  finish(0);
})();
