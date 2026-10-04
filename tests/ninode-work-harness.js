// Scripted test for fork skymp5-client/src/view/niNodeQueue.ts work slots (queueCopyNiNodeWork, queuePlayerNiNodeWork):
// a call that queues the 3D update itself (skee's CharGen.LoadCharacterPresetEx, racemenuPresetService) takes the turn
// of a plain update, so the one-update-per-frame rule of the tint hook (niNodeQueuePlan.ts) still holds. A plain
// update asked for meanwhile goes out only if the work did not queue one. Bundled from $FORK with a SkyrimPlatform stub.
// Run by run-all, or by hand:
//
//   FORK=<fork worktree> node tests/ninode-work-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const FORK = process.env.FORK || path.resolve(__dirname, '..', '..', 'fork');
const SRC = path.join(FORK, 'skymp5-client', 'src', 'view', 'niNodeQueue.ts');
if (!fs.existsSync(SRC) || !/queueCopyNiNodeWork/.test(fs.readFileSync(SRC, 'utf8'))) {
  require('./expect')('ninode-work', 'this client has no NiNode work slots');
  console.log('ok   skipped: this client has no NiNode work slots');
  process.exit(0);
}
const esbuildDir = [process.env.FORK_SERVER, FORK].filter(Boolean).map((f) => path.join(f, 'skymp5-server', 'node_modules', 'esbuild')).find((p) => fs.existsSync(p))
  || path.join(process.env.HOME, 'dragonbreak', 'fork', 'skymp5-server', 'node_modules', 'esbuild');
const esbuild = require(esbuildDir);

let failures = 0;
const check = (label, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && got !== undefined ? '   ' + JSON.stringify(got).slice(0, 400) : ''}`); if (!ok) failures++; };

// The fake game: actors by form id, the update handlers, and every queueNiNodeUpdate in order with its frame
const W = { actors: {}, handlers: [], sent: [], frame: 0, printed: [] };
globalThis.__niW = W;
const STUB = `
const W = globalThis.__niW;
const actorOf = (id) => {
  const a = W.actors[id >>> 0]; if (!a) return null;
  return { getFormID: () => id >>> 0, is3DLoaded: () => a.loaded, getRace: () => ({ getFormID: () => a.race || 0x13746 }),
    queueNiNodeUpdate: () => W.sent.push({ id: id >>> 0, frame: W.frame, by: 'plain' }) };
};
module.exports = {
  on: (ev, fn) => { if (ev === 'update') W.handlers.push(fn); },
  printConsole: (...x) => W.printed.push(x.join(' ')),
  Game: { getFormEx: (id) => (W.actors[id >>> 0] ? { id } : null), getPlayer: () => actorOf(0x14) },
  Actor: { from: (f) => (f ? actorOf(f.id) : null) },
};`;
const stubPlugin = {
  name: 'stubs',
  setup(b) {
    b.onResolve({ filter: /^skyrimPlatform$/ }, () => ({ path: 'skyrimPlatform', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: STUB, loader: 'js' }));
  },
};

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-ninode-'));
  const out = path.join(dir, 'q.js');
  await esbuild.build({ entryPoints: [SRC], bundle: true, platform: 'node', format: 'cjs', outfile: out, plugins: [stubPlugin], logLevel: 'error' });
  const Q = require(out);
  fs.rmSync(dir, { recursive: true, force: true });

  const tick = (n = 1) => { for (let i = 0; i < n; i++) { W.frame++; W.handlers.forEach((h) => h()); } };
  const C1 = 0xff000a01, C2 = 0xff000a02, C3 = 0xff000a03;
  W.actors = { 0x14: { loaded: true }, [C1]: { loaded: true }, [C2]: { loaded: true }, [C3]: { loaded: true } };
  // A work like the preset load: it queues the update itself and says so
  const work = (log, queue = true) => (actor) => { log.push(actor.getFormID()); if (queue) { W.sent.push({ id: actor.getFormID(), frame: W.frame, by: 'work' }); return true; } return false; };

  // ---- one per frame, work in a copy's turn ----
  let ran = [];
  Q.queueCopyNiNodeUpdate(C1);
  Q.queueCopyNiNodeWork(C2, work(ran));
  tick(4);
  check('a plain copy update and a work go out in separate frames', W.sent.length === 2 && W.sent[0].frame !== W.sent[1].frame, W.sent);
  check('the work ran once, in its own turn, and its update is the only one for that copy', ran.length === 1 && W.sent.filter((s) => s.id === C2).length === 1 && W.sent[1].by === 'work', W.sent);

  // ---- a work that queues nothing ----
  W.sent = []; ran = [];
  Q.queueCopyNiNodeWork(C1, work(ran, false));
  tick(3);
  check('a work that declines, with no plain update asked, sends nothing', ran.length === 1 && W.sent.length === 0, W.sent);
  W.sent = []; ran = [];
  Q.queueCopyNiNodeWork(C1, work(ran, false));
  Q.queueCopyNiNodeUpdate(C1);
  tick(3);
  check('a work that declines while a plain update was asked: the plain one goes out', ran.length === 1 && W.sent.length === 1 && W.sent[0].by === 'plain', W.sent);
  W.sent = []; ran = [];
  Q.queueCopyNiNodeUpdate(C1);
  Q.queueCopyNiNodeWork(C1, work(ran));
  tick(3);
  check('a work that queues covers a plain update asked before it (one update)', ran.length === 1 && W.sent.length === 1 && W.sent[0].by === 'work', W.sent);
  W.sent = [];
  Q.queueCopyNiNodeWork(C1, () => { throw new Error('skee'); });
  Q.queueCopyNiNodeUpdate(C1);
  tick(3);
  check('a work that throws: logged, and the plain update still goes', W.sent.length === 1 && W.sent[0].by === 'plain' && W.printed.some((l) => /work failed/.test(l)), W.sent);

  // ---- copies that are not ready or gone ----
  W.sent = []; ran = [];
  W.actors[C3].loaded = false;
  Q.queueCopyNiNodeWork(C3, work(ran));
  tick(3);
  check('a copy without 3D waits', ran.length === 0 && W.sent.length === 0);
  W.actors[C3].loaded = true;
  tick(2);
  check('and gets its turn once loaded', ran.length === 1 && W.sent.length === 1);
  W.sent = []; ran = [];
  Q.queueCopyNiNodeWork(C3, work(ran));
  delete W.actors[C3];
  tick(3);
  W.actors[C3] = { loaded: true };
  Q.queueCopyNiNodeUpdate(C3);
  tick(3);
  check('a copy gone before its turn drops its work (a later plain update does not run it)', ran.length === 0 && W.sent.length === 1 && W.sent[0].by === 'plain', W.sent);
  W.sent = []; ran = [];
  W.actors[C2].race = 0x000cdd84;
  Q.queueCopyNiNodeWork(C2, work(ran));
  tick(3);
  check('a copy that became a werewolf drops its work', ran.length === 0 && W.sent.length === 0);
  W.actors[C2].race = 0x13746;

  // ---- a destroyed copy drops its work ----
  W.sent = []; ran = [];
  Q.queueCopyNiNodeWork(C1, work(ran));
  Q.dropCopyNiNodeWork(C1);
  tick(3);
  check('work dropped by a destroy never runs on whatever holds the id next', ran.length === 0 && W.sent.length === 0, W.sent);
  W.sent = []; ran = [];
  Q.queueCopyNiNodeWork(C1, work(ran));
  Q.queueCopyNiNodeUpdate(C1);
  Q.dropCopyNiNodeWork(C1);
  tick(3);
  check('a plain update asked for the id still goes (it rebuilds whatever is there, as before)', ran.length === 0 && W.sent.length === 1 && W.sent[0].by === 'plain', W.sent);

  // ---- the player ----
  W.sent = []; ran = [];
  tick(3);
  Q.queuePlayerNiNodeWork(work(ran));
  check('the player\'s work goes out at once when no copy went this frame', ran.length === 1 && W.sent.length === 1 && W.sent[0].id === 0x14);
  W.sent = []; ran = [];
  tick(3);
  Q.queueCopyNiNodeUpdate(C1);
  tick(1);
  const copyFrame = W.frame;
  Q.queuePlayerNiNodeWork(work(ran));
  check('after a copy\'s update this frame, the player\'s work waits', ran.length === 0);
  tick(1);
  check('and runs first thing next frame', ran.length === 1 && W.sent.find((s) => s.id === 0x14).frame === copyFrame + 1, W.sent);
  W.sent = []; ran = [];
  tick(3);
  Q.queuePlayerNiNodeWork(work(ran, false));
  check('a player work that declines sends nothing', ran.length === 1 && W.sent.length === 0);
  W.sent = []; ran = [];
  tick(3);
  Q.queueCopyNiNodeUpdate(C1);
  tick(1);
  Q.queuePlayerNiNodeWork(work(ran, false));
  Q.queuePlayerNiNodeUpdate();
  tick(1);
  check('a waiting player work that declines, with a plain update asked meanwhile: one plain update', ran.length === 1 && W.sent.filter((s) => s.id === 0x14).length === 1 && W.sent.find((s) => s.id === 0x14).by === 'plain', W.sent);
  W.sent = [];
  tick(3);
  Q.queuePlayerNiNodeUpdate();
  check('a plain player update with no work is as before', W.sent.length === 1 && W.sent[0].by === 'plain');

  console.log(failures ? `${failures} FAILED` : 'all passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.log('FAIL harness threw', e.stack); process.exit(1); });
