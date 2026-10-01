// Fork skymp5-client view/niNodeQueuePlan.ts + niNodeQueue.ts (client-tint-queue): one NiNode update a frame, never a
// copy's beside the player's own, copies only while their 3D is loaded. SkyrimPlatform's tint hook keeps one queued
// actor id, so two updates in a frame could put one face's paint on another (athny, #bugs 1555092839627755561).
// Part 1 runs the plan bundle run-all hands over; part 2 bundles niNodeQueue.ts itself (FORK, FORK_SERVER) against fake
// natives that expire with their frame, and part 3 reads the call sites.
//   node tests/ni-node-queue-harness.js <bundle of niNodeQueuePlan.ts>   (FORK and FORK_SERVER set for parts 2 and 3)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { execFileSync } = require('child_process');
let failures = 0;
const check = (label, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

// ---- 1. the plan ----
const { NiNodeQueuePlan } = require(path.resolve(process.argv[2]));
let p = new NiNodeQueuePlan();
const loaded = (map) => (id) => (id in map ? map[id] : null);
p.request(0xff000101); p.request(0xff000102); p.request(0xff000101);
check('a copy asked twice waits once', p.waiting === 2);
check('one copy a frame', p.next(10, loaded({ [0xff000101]: true, [0xff000102]: true })) === 0xff000101 && p.next(10, loaded({ [0xff000102]: true })) === 0);
check('...the next one the frame after', p.next(11, loaded({ [0xff000102]: true })) === 0xff000102 && p.waiting === 0);
p = new NiNodeQueuePlan();
p.request(0xff000201);
check('a copy whose 3D is not loaded waits', p.next(5, loaded({ [0xff000201]: false })) === 0 && p.waiting === 1);
check('...and goes once it is', p.next(6, loaded({ [0xff000201]: true })) === 0xff000201);
p.request(0xff000202);
check('a copy that is gone is dropped', p.next(7, loaded({})) === 0 && p.waiting === 0);
p = new NiNodeQueuePlan();
p.request(0xff000301);
p.playerQueued(20);
check('no copy in the frame the player\'s own went out', p.next(20, loaded({ [0xff000301]: true })) === 0);
check('...nor the frame after', p.next(21, loaded({ [0xff000301]: true })) === 0);
check('...two frames on it goes', p.next(22, loaded({ [0xff000301]: true })) === 0xff000301);
check('the player\'s own waits a frame only when a copy went out this frame', p.copySentIn(22) === true && p.copySentIn(23) === false);
p.forget(0xff000301);
check('forget drops a waiting copy', p.waiting === 0);
p = new NiNodeQueuePlan();
p.request(0xff000401);
p.wantPlayer();
check('while the player\'s own waits, no copy goes', p.playerWaiting === true && p.next(30, loaded({ [0xff000401]: true })) === 0);
p.playerQueued(31);
check('...it is cleared when the player\'s goes', p.playerWaiting === false);

// ---- 2. niNodeQueue.ts against fake natives that expire with their frame ----
const FORK = process.env.FORK, FORK_SERVER = process.env.FORK_SERVER;
const src = FORK && path.join(FORK, 'skymp5-client/src/view/niNodeQueue.ts');
const esbuild = FORK_SERVER && path.join(FORK_SERVER, 'skymp5-server/node_modules/.bin/esbuild');
if (!src || !fs.existsSync(src) || !esbuild || !fs.existsSync(esbuild)) console.log('skip  parts 2-3: no FORK with niNodeQueue.ts or no esbuild in FORK_SERVER');
else {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-ninode-')), 'q.js');
  execFileSync(esbuild, [src, '--bundle', '--platform=node', '--format=cjs', '--external:skyrimPlatform', `--outfile=${out}`, '--log-level=error']);
  let frame = 0;
  const listeners = [], onceListeners = [], sent = [];
  const world = new Map(); // formId -> { loaded, race }
  const native = (id) => {
    const born = frame;
    const live = () => { if (frame !== born) throw new Error(`native object of ${id.toString(16)} used in frame ${frame}, made in ${born}`); };
    return {
      getFormID: () => { live(); return id; },
      is3DLoaded: () => { live(); return world.get(id).loaded; },
      getRace: () => { live(); const r = world.get(id).race; return { getFormID: () => { live(); return r; } }; },
      queueNiNodeUpdate: () => { live(); sent.push([id, frame]); },
    };
  };
  const fake = {
    Actor: { from: (x) => x || null },
    Game: { getFormEx: (id) => (world.has(id) ? native(id) : null), getPlayer: () => native(0x14) },
    on: (ev, fn) => { if (ev === 'update') listeners.push(fn); },
    once: (ev, fn) => { if (ev === 'update') onceListeners.push(fn); },
  };
  const load = Module._load;
  Module._load = function (req, ...rest) { return req === 'skyrimPlatform' ? fake : load.call(this, req, ...rest); };
  const Q = require(out);
  Module._load = load;
  const tick = () => { frame++; listeners.forEach((f) => f()); const o = onceListeners.splice(0); o.forEach((f) => f()); };
  world.set(0x14, { loaded: true, race: 0x13746 });
  world.set(0xff000a01, { loaded: true, race: 0x13746 });
  world.set(0xff000a02, { loaded: false, race: 0x13746 });
  world.set(0xff000a03, { loaded: true, race: 0x000cdd84 }); // a werewolf copy
  world.set(0xff000a04, { loaded: true, race: 0x13746 });
  Q.queueCopyNiNodeUpdate(0xff000a01); Q.queueCopyNiNodeUpdate(0xff000a02); Q.queueCopyNiNodeUpdate(0xff000a03); Q.queueCopyNiNodeUpdate(0xff000a04);
  check('nothing goes out before a frame runs', sent.length === 0);
  let threw = null;
  try { for (let i = 0; i < 6; i++) tick(); } catch (e) { threw = e.message; }
  check('no native object is used outside the frame it was looked up in', threw === null, threw);
  const frames = sent.map(([, f]) => f);
  check('at most one update a frame', new Set(frames).size === frames.length, sent);
  check('the loaded copies go out, one per frame', sent.map(([id]) => id).join() === [0xff000a01, 0xff000a04].join(), sent.map(([id, f]) => [id.toString(16), f]));
  check('the werewolf copy is never rebuilt', !sent.some(([id]) => id === 0xff000a03));
  check('the unloaded copy waits', !sent.some(([id]) => id === 0xff000a02));
  world.get(0xff000a02).loaded = true; tick();
  check('...and goes once loaded', sent.some(([id]) => id === 0xff000a02));
  // the player's own head
  tick(); // a frame with nothing waiting
  sent.length = 0;
  world.set(0xff000a05, { loaded: true, race: 0x13746 });
  Q.queueCopyNiNodeUpdate(0xff000a05);
  Q.queuePlayerNiNodeUpdate();
  check('the player\'s own update goes out at once', sent.length === 1 && sent[0][0] === 0x14, sent);
  tick();
  check('no copy in the frame after the player\'s', !sent.some(([id]) => id === 0xff000a05));
  for (let i = 0; i < 5 && !sent.some(([id]) => id === 0xff000a05); i++) tick();
  check('...then the copy', sent.some(([id]) => id === 0xff000a05));
  const copyFrame = sent.find(([id]) => id === 0xff000a05)[1];
  sent.length = 0;
  Q.queuePlayerNiNodeUpdate();
  check('the player\'s own waits a frame when a copy went out this frame', sent.length === 0 && frame === copyFrame);
  tick();
  check('...and goes the next frame, alone', sent.length === 1 && sent[0][0] === 0x14 && sent[0][1] === copyFrame + 1, sent);
  // F's case (review N1): two loaded copies queued, the player asks right after A went out; the player goes before B,
  // whatever order SkyrimPlatform runs the frame's "update" callbacks in
  for (let i = 0; i < 3; i++) tick();
  sent.length = 0;
  world.set(0xff000b01, { loaded: true, race: 0x13746 }); world.set(0xff000b02, { loaded: true, race: 0x13746 });
  Q.queueCopyNiNodeUpdate(0xff000b01); Q.queueCopyNiNodeUpdate(0xff000b02);
  tick();
  check('F: copy A goes first', sent.length === 1 && sent[0][0] === 0xff000b01, sent);
  Q.queuePlayerNiNodeUpdate();
  for (let i = 0; i < 6; i++) tick();
  const order = sent.map(([id]) => id);
  const at = (id) => (sent.find(([x]) => x === id) || [0, -1])[1];
  check('F: the player goes the very next frame, before copy B', order.join() === [0xff000b01, 0x14, 0xff000b02].join() && at(0x14) === at(0xff000b01) + 1, sent.map(([id, f]) => [id.toString(16), f]));
  check('F: B waits two frames after the player\'s', at(0xff000b02) - at(0x14) >= 2, sent.map(([id, f]) => [id.toString(16), f]));

  // ---- 3. the call sites ----
  const read = (rel) => fs.readFileSync(path.join(FORK, 'skymp5-client/src', rel), 'utf8');
  const all = execFileSync('grep', ['-rln', 'queueNiNodeUpdate()', path.join(FORK, 'skymp5-client/src')], { encoding: 'utf8' }).trim().split('\n').map((f) => path.relative(path.join(FORK, 'skymp5-client/src'), f));
  check('only niNodeQueue.ts calls the engine\'s queueNiNodeUpdate()', all.join() === 'view/niNodeQueue.ts', all);
  const fv = read('view/formView.ts');
  const gate = fv.slice(fv.indexOf('if (isOnScreen != this.isOnScreen) {'), fv.indexOf('if (model.equipment) {'));
  check('formView: the same on-screen, not-a-beast, 5 s gate queues the copy', /if \(isOnScreen && !this\.isBeastCopy\(model\) && Date\.now\(\) - this\.lastNiNodeUpdateMs >= FormView\.niNodeUpdateMinIntervalMs\) \{\s*this\.lastNiNodeUpdateMs = Date\.now\(\);\s*queueCopyNiNodeUpdate\(actor\.getFormID\(\)\);/.test(gate), gate.slice(0, 400));
  check('formView: the nametag block is untouched', /const isVisibleByPlayer = !model\.movement\?\.isSneaking/.test(fv) && /this\.textNameId = createText\(textXPos, textYPos, this\.createdTagName, \[1, 1, 1, 0\.8\]\);/.test(fv));
  const inv = read('sync/inventory.ts');
  check('inventory: the player\'s own goes as the player\'s, a copy\'s through the queue', /if \(ac\.getFormID\(\) === 0x14\) queuePlayerNiNodeUpdate\(\);\s*else queueCopyNiNodeUpdate\(ac\.getFormID\(\)\);/.test(inv));
  check('appearance: the player\'s new look through queuePlayerNiNodeUpdate', /applyTints\(null, appearance\);\s*queuePlayerNiNodeUpdate\(\);/.test(read('sync/appearance.ts')));
}

console.log(failures ? `${failures} FAILED` : 'all checks passed');
process.exit(failures ? 1 : 0);
