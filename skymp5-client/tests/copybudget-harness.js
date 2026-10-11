// Scripted test for copyBudget.ts and its wiring in npcLifetimeRuntime.ts: a burst of NPC copy spawns, deletes, host-start
// settles and world-cleaner disables runs a few a frame, in order, none dropped; a queued delete wins over a later spawn of
// the same remote id; own companions and the player's own copies never wait; trail lines carry f=<frame>. Run from skymp5-client:
//
//   node tests/copybudget-harness.js [path to esbuild's package dir]
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const esbuildDir = [process.argv[2], path.resolve(__dirname, '../../skymp5-server/node_modules/esbuild'),
  path.join(os.homedir(), 'dragonbreak/fork/skymp5-server/node_modules/esbuild')].find((p) => p && fs.existsSync(p));
if (!esbuildDir) { console.log('SKIP copybudget (no esbuild)'); process.exit(0); }
const esbuild = require(esbuildDir);

let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

// A fake engine: refs by id, the "tick" and "update" handlers, and the lines writeLogs got
const SP_STUB = `
const forms = new Map();
const handlers = { tick: [], update: [] };
const lines = [];
const calls = [];
const mk = (id, o) => {
  const r = Object.assign({ deleted: false, disabled: false, loaded: true, dead: false, actor: true }, o || {});
  r.getFormID = () => id;
  r.isDeleted = () => r.deleted;
  r.isDisabled = () => r.disabled;
  r.is3DLoaded = () => r.loaded && !r.disabled;
  r.isDead = () => r.dead;
  r.isBleedingOut = () => false; r.isUnconscious = () => false; r.isInKillMove = () => false;
  r.getBaseObject = () => ({ getFormID: () => 7 });
  r.delete = () => { r.deleted = true; calls.push(['delete', id]); };
  r.disableNoWait = () => { r.disabled = true; calls.push(['disable', id]); };
  r.setPosition = () => calls.push(['reseat', id]);
  r.getPositionX = () => 0; r.getPositionY = () => 0; r.getPositionZ = () => 0;
  forms.set(id, r);
  return r;
};
module.exports = {
  __fake: { forms, handlers, lines, calls, mk },
  Game: { getFormEx: (id) => forms.get(id) || null },
  ObjectReference: { from: (x) => x || null },
  Actor: { from: (x) => (x && x.actor ? x : null) },
  Ui: { isMenuOpen: () => false },
  on: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); },
  writeLogs: (_plugin, line) => lines.push(line),
};`;

async function bundle(tmp, entry, name, plugins) {
  const out = path.join(tmp, name);
  await esbuild.build({ entryPoints: [path.resolve(__dirname, entry)], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'error', plugins });
  return require(out);
}

function pure({ FrameBudget, SpawnLine, WorkQueue, COPY_WORK_PER_FRAME, SPAWN_ASK_STALE_FRAMES }) {
  check('the budget is about 2-3 of each kind a frame', COPY_WORK_PER_FRAME.spawn === 3 && COPY_WORK_PER_FRAME.hoststart === 3 && COPY_WORK_PER_FRAME.delete === 2 && COPY_WORK_PER_FRAME.disable === 2);
  const b = new FrameBudget();
  check('a frame takes 3 spawns, then refuses', b.take('spawn', 1) && b.take('spawn', 1) && b.take('spawn', 1) && !b.take('spawn', 1));
  check('another kind has its own budget in the same frame', b.take('delete', 1) && b.take('delete', 1) && !b.take('delete', 1));
  check('the next frame starts fresh', b.left('spawn', 2) === 3 && b.left('delete', 2) === 2);
  b.force('spawn', 3); b.force('spawn', 3); b.force('spawn', 3); b.force('spawn', 3);
  check('forced work counts against the frame and never goes negative', b.usedIn('spawn', 3) === 4 && b.left('spawn', 3) === 0);

  // 30 views asking every frame, as FormView.update does
  const line = new SpawnLine();
  const budget = new FrameBudget();
  const views = Array.from({ length: 30 }, (_, i) => 0xff000100 + i);
  const grantedAt = new Map();
  let maxInFrame = 0;
  for (let f = 1; f <= 20; f++) {
    let n = 0;
    for (const v of views) if (!grantedAt.has(v) && line.ask(v, f, budget)) { grantedAt.set(v, f); n++; }
    maxInFrame = Math.max(maxInFrame, n);
  }
  check('30 copies arriving at once are all placed, none dropped', grantedAt.size === 30, grantedAt.size);
  check('no frame places more than 3', maxInFrame === 3, maxInFrame);
  check('they are placed in 10 frames (about 0.2 s)', Math.max(...grantedAt.values()) === 10, Math.max(...grantedAt.values()));
  const order = views.slice().sort((a, b2) => grantedAt.get(a) - grantedAt.get(b2) || a - b2);
  check('in the order the views first asked', order.every((v, i) => v === views[i]));

  // A view ahead in line that asks later in the frame still gets its place
  const l2 = new SpawnLine(); const b2 = new FrameBudget();
  ['a', 'b', 'c', 'd'].forEach((k, i) => l2.ask(100 + i, 1, b2, true));
  const got = [103, 102, 101, 100].map((k) => l2.ask(k, 2, b2));
  check('the first three in line are granted whatever order they ask in, the fourth waits', JSON.stringify(got) === '[false,true,true,true]', got);
  check('the fourth is granted next frame', l2.ask(103, 3, b2) === true);

  const l3 = new SpawnLine(); const b3 = new FrameBudget();
  [1, 2, 3, 4].forEach((k) => l3.ask(k, 1, b3, true));
  let f = 2;
  for (; f < 2 + SPAWN_ASK_STALE_FRAMES + 2; f++) l3.ask(4, f, b3, true);
  check('views that stopped asking leave the line', l3.ask(4, f, b3) === true && l3.size() === 0);
  const l4 = new SpawnLine(); const b4 = new FrameBudget();
  check('a blocked view is refused but keeps its place', l4.ask(9, 1, b4, true) === false && l4.ask(8, 1, b4, true) === false && l4.ask(9, 2, b4) === true);

  const q = new WorkQueue(); const qb = new FrameBudget(); const ran = [];
  const res = [1, 2, 3, 4].map((id) => q.submit('delete', id, 0, 1, qb, () => ran.push(id)));
  check('push work runs at once while the frame has room, then queues', JSON.stringify(res) === '["ran","ran","queued","queued"]' && JSON.stringify(ran) === '[1,2]', res);
  check('the same work on the same id is not queued twice', q.submit('delete', 3, 0, 1, qb, () => ran.push(33)) === 'dup');
  check('with deletes waiting, a new one queues behind them even in a fresh frame', q.submit('delete', 5, 0, 2, qb, () => ran.push(5)) === 'queued');
  check('a disable is not held up by waiting deletes', q.submit('disable', 6, 0, 2, qb, () => ran.push(6)) === 'ran');
  q.drain(2, qb);
  check('drain runs the oldest first, within the budget', JSON.stringify(ran) === '[1,2,6,3,4]', ran);
  check('cancel removes waiting work', q.cancel('delete', 5) && q.size() === 0);
  q.submit('hoststart', 7, 7, 3, qb, () => {}); q.submit('hoststart', 8, 8, 3, qb, () => {}); q.submit('hoststart', 9, 9, 3, qb, () => {});
  q.submit('delete', 10, 77, 3, qb, () => {}); q.submit('delete', 11, 77, 3, qb, () => {}); q.submit('delete', 12, 77, 3, qb, () => {});
  check('hasTag finds a queued delete by its remote id', q.hasTag('delete', 77) && !q.hasTag('delete', 78) && !q.hasTag('delete', 0));
  let bad = 0; q.submit('disable', 13, 0, 4, qb, () => { throw new Error('x'); });
  q.submit('disable', 14, 0, 4, qb, () => {}); q.submit('disable', 15, 0, 4, qb, () => { bad++; });
  q.drain(5, qb);
  check('one failing item never stops the rest', bad === 1);
}

function runtime(rt, fake) {
  const { forms, handlers, lines, calls, mk } = fake;
  let frame = 0;
  // 100 ms a frame, so safeDelete's 2 s settle passes in 20 frames
  let clock = 1_800_000_000_000;
  Date.now = () => clock;
  const step = () => { frame++; clock += 100; handlers.tick.forEach((h) => h()); handlers.update.forEach((h) => h()); };
  const deletesIn = () => calls.filter((c) => c[0] === 'delete').length;
  step();

  // A doorway: 30 copies destroyed in one frame
  const ids = Array.from({ length: 30 }, (_, i) => 0xff001000 + i);
  ids.forEach((id) => mk(id));
  calls.length = 0;
  ids.forEach((id) => rt.safeDelete(forms.get(id), { tag: 0x50000 + id }));
  check('30 deletes in one frame: 2 run now', deletesIn() === 2, deletesIn());
  check('the rest are handed to delete (nothing else touches them)', ids.slice(2).every((id) => rt.isHandedToDelete(id)));
  let perFrame = [], before = deletesIn();
  for (let i = 0; i < 20; i++) { step(); perFrame.push(deletesIn() - before); before = deletesIn(); }
  check('the queue drains 2 a frame', perFrame.slice(0, 14).every((n) => n === 2) && perFrame.slice(14).every((n) => n === 0), perFrame);
  check('every copy is deleted, none dropped', ids.every((id) => forms.get(id).deleted) && deletesIn() === 30);
  check('a queued delete writes a delete-queued line with its wait count', lines.some((l) => /delete-queued ff001002 base=7 waiting=\d+ f=\d+$/.test(l)));
  check('every trail line ends with f=<frame>', lines.length > 0 && lines.every((l) => / f=\d+$/.test(l)));
  const fr = (l) => +l.match(/ f=(\d+)$/)[1];
  const delFrames = lines.filter((l) => / delete ff/.test(l)).map(fr);
  const byFrame = delFrames.reduce((m, f) => ((m[f] = (m[f] || 0) + 1), m), {});
  check('no frame in the trail shows more than 2 deletes', Object.values(byFrame).every((n) => n <= 2), byFrame);

  // A queued delete wins over a later spawn of the same remote id
  step();
  const a = 0xff002000, b = 0xff002001, c = 0xff002002, d = 0xff002003;
  [a, b, c, d].forEach((id) => mk(id));
  rt.safeDelete(forms.get(a), { tag: 0x60001 });
  rt.safeDelete(forms.get(b), { tag: 0x60002 });
  rt.safeDelete(forms.get(c), { tag: 0x60003 });
  check('its delete waits in the queue', !forms.get(c).deleted && rt.isHandedToDelete(c));
  check('the view of the same remote id may not place its new copy yet', rt.maySpawnCopy(0x60003, false) === false);
  check('another view may', rt.maySpawnCopy(0x60099, false) === true);
  rt.safeDelete(forms.get(c), { tag: 0x60003 });
  step();
  check('the old copy is deleted first', forms.get(c).deleted);
  check('then the new copy may be placed', rt.maySpawnCopy(0x60003, false) === true);

  // World-cleaner disables: queued too; a delete wins over a queued disable
  step();
  const plug = Array.from({ length: 6 }, (_, i) => 0x0010a000 + i);
  plug.forEach((id) => mk(id));
  calls.length = 0;
  plug.forEach((id) => rt.disableOnly(forms.get(id)));
  check('6 disables in one frame: 2 run now', calls.filter((x) => x[0] === 'disable').length === 2);
  check('a queued disable counts as handed over (the cleaner skips it)', rt.isHandedToDelete(plug[5]));
  rt.safeDelete(forms.get(plug[5]));
  step(); step(); step();
  check('the other disables run in later frames', plug.slice(0, 5).every((id) => forms.get(id).disabled));
  check('the delete replaced the queued disable on the same ref', forms.get(plug[5]).deleted && !calls.some((x) => x[0] === 'disable' && x[1] === plug[5]));

  // Host-start settles
  step();
  const settled = [];
  for (let i = 0; i < 20; i++) rt.hostStartSettle(0x70000 + i, false, () => settled.push(frame));
  check('20 host grants in one frame: 3 settle now', settled.length === 3);
  for (let i = 0; i < 10; i++) step();
  const perHs = settled.reduce((m, f) => ((m[f] = (m[f] || 0) + 1), m), {});
  check('the rest settle 3 a frame, all of them', settled.length === 20 && Object.values(perHs).every((n) => n <= 3), perHs);

  // Own companions and the player's own copies never wait
  step();
  const own = [];
  for (let i = 0; i < 5; i++) rt.hostStartSettle(0x80000 + i, false, () => {});
  rt.hostStartSettle(0x81000, true, () => own.push('hs'));
  for (let i = 0; i < 4; i++) rt.maySpawnCopy(0x90000 + i, false);
  check('an own copy is placed at once with the frame full', rt.maySpawnCopy(0x91000, true) === true);
  const e = 0xff003000; mk(e);
  for (let i = 0; i < 3; i++) { const x = 0xff003100 + i; mk(x); rt.safeDelete(forms.get(x)); }
  rt.safeDelete(forms.get(e), { urgent: true });
  check('an urgent delete and settle run at once with the frame full', forms.get(e).deleted && own.length === 1);
  for (let i = 0; i < 5; i++) step();

  // A deferred delete's final Delete() also waits for room
  step();
  const ded = Array.from({ length: 5 }, (_, i) => 0xff004000 + i);
  ded.forEach((id) => mk(id, { dead: true }));
  ded.forEach((id) => rt.safeDelete(forms.get(id)));
  for (let i = 0; i < 5; i++) step();
  check('dead copies are disabled first (deferred), a few a frame', ded.every((id) => forms.get(id).disabled && !forms.get(id).deleted));
  calls.length = 0;
  const finals = [];
  for (let i = 0; i < 40; i++) { step(); finals.push(calls.filter((x) => x[0] === 'delete').length); calls.length = 0; }
  check('their final deletes come at most 2 a frame, all five', finals.every((n) => n <= 2) && ded.every((id) => forms.get(id).deleted), finals);
}

function wiring() {
  const src = (p) => fs.readFileSync(path.resolve(__dirname, '../src', p), 'utf8');
  const fv = src('view/formView.ts'), rs = src('services/services/remoteServer.ts'), rt = src('view/npcLifetimeRuntime.ts');
  check('formView asks before it destroys and places a copy', /if \(respawnRequired && !maySpawnCopy\(this\.remoteRefrId \|\| 0, ownCopy\)\) \{\s*return;\s*\}\s*if \(respawnRequired\) \{\s*this\.destroy\(\);/.test(fv));
  check('formView counts own companions and the player\'s own copy as urgent', /const ownCopy = !this\.remoteRefrId \|\| isOwnCompanion\(this\.remoteRefrId\) \|\| !!model\.isMyClone;/.test(fv));
  check('formView tags its delete with the remote id', /safeDelete\(refr, \{ tag: remoteRefrId \|\| 0, urgent: urgentDelete \}\)/.test(fv));
  check('HostStart\'s settle goes through the budget, own companions urgent', /once\('update', \(\) => hostStartSettle\(target, isOwnCompanion\(target\), \(\) => \{/.test(rs));
  check('a settle on a copy being deleted is dropped', /if \(isHandedToDelete\(ac\.getFormID\(\)\)\) \{ noteActorCall\("hoststart-dropped"/.test(rs));
  check('the frame counter runs on tick', /on\("tick", \(\) => \{ frame\+\+; \}\);/.test(rt));
  check('reseats are still one a frame', /noteActorCall\("reseat", r\.id\);[\s\S]{0,140}break;/.test(rt));
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'claude-nate-copybudget-'));
  try {
    pure(await bundle(tmp, '../src/view/copyBudget.ts', 'copyBudget.js'));
    const stub = [{ name: 'sp', setup(b) {
      b.onResolve({ filter: /^skyrimPlatform$/ }, () => ({ path: 'sp', namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: SP_STUB, loader: 'js' }));
    } }];
    const rtOut = path.join(tmp, 'rt.js');
    await esbuild.build({ entryPoints: [path.join(tmp, 'entry.js')].map((p) => (fs.writeFileSync(p,
      `module.exports = Object.assign({}, require(${JSON.stringify(path.resolve(__dirname, '../src/view/npcLifetimeRuntime.ts'))}), { fake: require('skyrimPlatform').__fake });`), p)),
      bundle: true, platform: 'node', format: 'cjs', outfile: rtOut, logLevel: 'error', plugins: stub });
    const rt = require(rtOut);
    runtime(rt, rt.fake);
    wiring();
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log(failures ? `${failures} FAILED` : 'all passed');
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
