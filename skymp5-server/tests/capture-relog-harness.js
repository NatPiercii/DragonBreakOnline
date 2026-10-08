// Scripted test for captureSystem.ts and a captive who relogs while their captor reconnects (8 Oct, "Cuffs disappeared
// after relog"): the captor's disconnect freed every captive, an offline one too, so a captive who logged out came back
// free though the captor was online again when they returned. It bundles captureSystem.ts with esbuild (settings stubbed),
// loads the bundle twice (a second process load must behave the same) and drives disconnect and userAssignActor against
// a fake mp. Run it from skymp5-server with node_modules present:
//
//   node tests/capture-relog-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const esbuild = require(path.join(root, 'node_modules', 'esbuild'));
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-jake-c-bug-cuffs-relog-'));
const bundle = path.join(out, 'capture.js');
const SHACKLES = 0x10e039;
const stubs = {
  '../settings': `module.exports = { Settings: { get: async () => ({ manaclesFormId: ${SHACKLES}, allSettings: {} }) } };`,
};

let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${got !== undefined && !ok ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

const CAPTOR = 0xff000a45, CAPTIVE = 0xff000f51, OTHER = 0xff000505;
const CAPTOR_USER = 25, CAPTIVE_USER = 20, OTHER_USER = 7;

// A fake world: users map actor -> user while that player is in their body; props hold mp properties
const world = () => {
  const users = new Map([[CAPTOR, CAPTOR_USER], [CAPTIVE, CAPTIVE_USER], [OTHER, OTHER_USER]]);
  const props = new Map();
  const packets = [], papyrus = [], logs = [], listeners = new Map();
  const here = { cellOrWorldDesc: 'a764b:BSHeartland.esm', pos: [0, 0, 0], rot: [0, 0, 0] };
  const svr = {
    getUserByActor: (a) => (users.has(a) ? users.get(a) : 0xffff),
    getUserActor: (u) => { for (const [a, x] of users) if (x === u) return a; return 0; },
    isConnected: (u) => [...users.values()].includes(u),
    get: (id, p) => (p === 'locationalData' ? here : p === 'isDead' ? false : props.get(`${id}|${p}`)),
    set: (id, p, v) => props.set(`${id}|${p}`, v),
    sendCustomPacket: (u, s) => packets.push([u, JSON.parse(s)]),
    callPapyrusFunction: (kind, cls, fn, self, args) => papyrus.push([fn, self.desc, args[0].desc]),
    getDescFromId: (id) => id,
    getActorName: (a) => a.toString(16),
    getActorCellOrWorld: () => 0x3c,
    getActorPos: () => [0, 0, 0],
  };
  const gm = {
    on: (ev, f) => { if (!listeners.has(ev)) listeners.set(ev, []); listeners.get(ev).push(f); },
    emit: (ev, ...a) => (listeners.get(ev) || []).forEach((f) => f(...a)),
  };
  return { users, props, packets, papyrus, logs, listeners, ctx: { svr, gm } };
};

// What the server does when a player's connection closes: systems see the user's actor, then the mapping goes
const disconnect = (w, sys, actor) => { sys.disconnect(w.users.get(actor), w.ctx); w.users.delete(actor); };
const reconnect = (w, actor, user) => { w.users.set(actor, user); w.ctx.gm.emit('userAssignActor', user, actor); };
const restrained = (w, a) => w.props.get(`${a}|private.restrained`);
const lastState = (w, user) => w.packets.filter(([u, p]) => u === user && p.customPacketType === 'restraintState').pop();
const shacklesEquipped = (w, a) => w.papyrus.some(([fn, self, item]) => fn === 'EquipItem' && self === a && item === SHACKLES);
const shacklesRemoved = (w, a) => w.papyrus.some(([fn, self, item]) => fn === 'UnequipItem' && self === a && item === SHACKLES);

const bindAndLeave = async (CaptureSystem, rope = false) => {
  const w = world();
  const sys = new CaptureSystem((...x) => w.logs.push(x.join(' ')));
  await sys.initAsync(w.ctx);
  sys.applyCapture(w.ctx, CAPTIVE, CAPTOR, rope);
  disconnect(w, sys, CAPTIVE);
  w.packets.length = 0; w.papyrus.length = 0;
  return { w, sys };
};

const run = async (CaptureSystem, tag) => {
  console.log(`-- ${tag}`);
  {
    // Onny, 8 Oct: bound 01:56, logged out 01:57; the captor dropped 02:11:48 and was back 6 s later; Onny returned 02:54
    const { w, sys } = await bindAndLeave(CaptureSystem);
    disconnect(w, sys, CAPTOR);
    check('an offline captive keeps their restraint when the captor drops', sys.restraints.has(CAPTIVE) && restrained(w, CAPTIVE)?.boundHands === true, [...sys.restraints.keys()]);
    check('their shackles are not taken off while they are away', !shacklesRemoved(w, CAPTIVE), w.papyrus);
    reconnect(w, CAPTOR, 26);
    reconnect(w, CAPTIVE, 21);
    check('back with the captor online, the captive is bound again', sys.restraints.get(CAPTIVE)?.boundHands === true && restrained(w, CAPTIVE)?.boundHands === true);
    check('the captive client is told it is bound and led by the captor', lastState(w, 21)?.[1].boundHands === true && lastState(w, 21)?.[1].leash === CAPTOR, lastState(w, 21));
    check('the shackles go back on', shacklesEquipped(w, CAPTIVE), w.papyrus);
  }
  {
    // The captor really left: the 29 Sep rule still lets the captive go when they return (cd73c66e)
    const { w, sys } = await bindAndLeave(CaptureSystem);
    disconnect(w, sys, CAPTOR);
    reconnect(w, CAPTIVE, 21);
    check('back with the captor gone, the captive is let go', !sys.restraints.has(CAPTIVE) && !restrained(w, CAPTIVE));
    check('their client is told they are free', lastState(w, 21)?.[1].boundHands === false, lastState(w, 21));
    check('the shackles come off', shacklesRemoved(w, CAPTIVE), w.papyrus);
  }
  {
    // The captive's own relog while the captor stays online (never an escape)
    const { w, sys } = await bindAndLeave(CaptureSystem);
    reconnect(w, CAPTIVE, 21);
    check('a captive who relogs alone comes back bound', restrained(w, CAPTIVE)?.boundHands === true && shacklesEquipped(w, CAPTIVE));
  }
  {
    // A captive online when the captor drops is let go at once, as before
    const w = world();
    const sys = new CaptureSystem((...x) => w.logs.push(x.join(' ')));
    await sys.initAsync(w.ctx);
    sys.applyCapture(w.ctx, CAPTIVE, CAPTOR);
    disconnect(w, sys, CAPTOR);
    check('an online captive is freed when the captor disconnects', !sys.restraints.has(CAPTIVE) && lastState(w, CAPTIVE_USER)?.[1].boundHands === false);
  }
  {
    // Rope: an offline rope captive stays tied and is never handed shackles
    const { w, sys } = await bindAndLeave(CaptureSystem, true);
    disconnect(w, sys, CAPTOR);
    reconnect(w, CAPTOR, 26);
    reconnect(w, CAPTIVE, 21);
    check('a rope captive comes back tied', restrained(w, CAPTIVE)?.rope === true && restrained(w, CAPTIVE)?.boundHands === true);
    check('a rope captive gets no shackles', !shacklesEquipped(w, CAPTIVE), w.papyrus);
  }
  {
    // One listener per system and plain hook assignments: a second load replaces the hooks, nothing stacks
    const w = world();
    const sys = new CaptureSystem(() => {});
    await sys.initAsync(w.ctx);
    check('one userAssignActor listener per system', (w.listeners.get('userAssignActor') || []).length === 1);
    check('the gamemode hooks belong to the newest system', typeof globalThis.__dboBreakFree === 'function' && globalThis.__dboRopeCapture === true);
  }
};

(async () => {
  await esbuild.build({
    entryPoints: [path.join(root, 'ts', 'systems', 'captureSystem.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'error',
    plugins: [{
      name: 'stubs',
      setup(b) {
        b.onResolve({ filter: /^\.\.\/settings$/ }, (a) => ({ path: a.path, namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ contents: stubs[a.path], loader: 'js' }));
      },
    }],
  });
  const first = require(bundle).CaptureSystem;
  await run(first, 'first load');
  const hookAfterFirst = globalThis.__dboBreakFree;
  delete require.cache[require.resolve(bundle)];
  const second = require(bundle).CaptureSystem;
  check('the second load is a fresh module', second !== first);
  await run(second, 'second load');
  check('the second load replaced the hooks instead of adding to them', globalThis.__dboBreakFree !== hookAfterFirst);
  fs.rmSync(out, { recursive: true, force: true });
  console.log('');
  console.log(failures ? `${failures} FAILURES` : 'all checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); fs.rmSync(out, { recursive: true, force: true }); process.exit(1); });
