// Scripted test for the admin paths that reach a userId after a wait (7 Oct login race follow-up): an in-game ban kicks
// the target only if the target's connection still holds its userId when the backend answers, and the shout lesson sent
// 15 s after an actor assignment goes only to that same character. It bundles adminSystem.ts with esbuild (settings,
// NPC spawns, mastery and the ban store stubbed), fakes the native server with a connection table, holds the ban POST
// open while the slot changes hands and runs the 15 s timer by hand. Run it from skymp5-server with node_modules present:
//
//   node tests/admin-reused-slot-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const root = path.resolve(__dirname, '..');
const esbuild = require(path.join(root, 'node_modules', 'esbuild'));
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-jake-adminslot-'));

const stubSources = {
  '../settings': 'module.exports = { Settings: { get: async () => globalThis.__admin.settings } };',
  './npcSpawnSystem': 'module.exports = { NpcSpawnSystem: class {} };',
  './masterySystem': 'module.exports = { MasterySystem: class {}, MAX_GRANT: 0 };',
  './adminBans': 'module.exports = { AdminBans: class { list() { return []; } } };',
};
const stubFilter = new RegExp('^(' + Object.keys(stubSources).map((k) => k.replace(/[./-]/g, '\\$&')).join('|') + ')$');

let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

const ADMIN_ACTOR = 0xff0000ad, TARGET_ACTOR = 0xff000077, SHOUT_ACTOR = 0xff000055;
let conns, actorOf, props, packets, kicks, enabled, fetches, gate;
const reset = () => { conns = new Map(); actorOf = new Map(); props = {}; packets = []; kicks = []; enabled = []; fetches = []; gate = null; };
const need = (u) => {
  if (!conns.has(u)) throw new Error(`User with id ${u} doesn't exist`);
  return conns.get(u);
};
const mp = {
  isConnected: (u) => conns.has(u),
  getUserGuid: (u) => need(u),
  getUserActor: (u) => actorOf.get(u) || 0,
  sendCustomPacket: (u, p) => { const guid = need(u); packets.push({ u, guid, body: JSON.parse(p) }); },
  kick: (u) => { kicks.push({ u, guid: need(u) }); },
  setEnabled: (a, on) => enabled.push([a, on]),
  get: (a, prop) => (props[a] || {})[prop],
  set: (a, prop, v) => { (props[a] = props[a] || {})[prop] = v; },
  getIdFromDesc: () => 0,
};
const connect = (u, guid, actor) => { conns.set(u, guid); if (actor) actorOf.set(u, actor); };
const drop = (u) => { conns.delete(u); actorOf.delete(u); };
const to = (guid) => packets.filter((p) => p.guid === guid).map((p) => p.body.customPacketType);
const turn = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 30; i++) await turn(); };

globalThis.__admin = {
  settings: { name: 'test', master: 'http://master.test', masterKey: 'KEY', allSettings: { masterApiAuthToken: 't' } },
};
globalThis.fetch = async (url, opts) => {
  fetches.push([opts && opts.method, url]);
  if (gate) await gate.promise;
  return { ok: true, status: 200, json: async () => ({}) };
};
const hold = () => { let release; const promise = new Promise((r) => { release = r; }); gate = { promise, release }; };
const release = () => { const g = gate; gate = null; g.release(); };

(async () => {
  await esbuild.build({
    entryPoints: [path.join(root, 'ts', 'systems', 'adminSystem.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile: path.join(out, 'admin.js'), logLevel: 'error',
    plugins: [{
      name: 'stubs',
      setup(b) {
        b.onResolve({ filter: stubFilter }, (a) => ({ path: a.path, namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ contents: stubSources[a.path], loader: 'js' }));
      },
    }],
  });
  const cwd = process.cwd();
  process.chdir(out);
  fs.writeFileSync(path.join(out, 'admin-powers.json'), JSON.stringify({ spells: [], shouts: [{ shout: 'S', name: 'Shout', words: ['a', 'b', 'c'] }], werewolf: '' }));
  const { AdminSystem } = require(path.join(out, 'admin.js'));
  const target = { userId: 7, actorId: TARGET_ACTOR, profileId: 77, name: 'Target' };

  // ---- an in-game ban answered after the target's slot changed hands ----
  {
    reset();
    const admin = new AdminSystem(() => {}, {}, {});
    const ctx = { svr: mp, gm: new EventEmitter() };
    await admin.initAsync(ctx);
    connect(3, 'G-ADMIN', ADMIN_ACTOR);
    connect(7, 'G-TARGET', TARGET_ACTOR);
    hold();
    admin.banViaBackend(mp, ctx, 3, ADMIN_ACTOR, target, 1, 'senior');
    await settle();
    check('the ban POST is made', fetches.length === 1 && /\/ban$/.test(fetches[0][1]), fetches);
    drop(7);
    connect(7, 'G-INNOCENT');
    release();
    await settle();
    check('a player who took the banned target\'s userId is not kicked as banned', to('G-INNOCENT').length === 0 && kicks.length === 0, { packets: to('G-INNOCENT'), kicks });
    check('...the banned character is still disabled', enabled.some(([a, on]) => a === TARGET_ACTOR && on === false), enabled);
    check('...and the admin is told the ban went through', packets.some((p) => p.guid === 'G-ADMIN' && /Banned Target/.test(JSON.stringify(p.body))), packets.map((p) => [p.guid, p.body]));
  }
  {
    reset();
    const admin = new AdminSystem(() => {}, {}, {});
    const ctx = { svr: mp, gm: new EventEmitter() };
    await admin.initAsync(ctx);
    connect(3, 'G-ADMIN', ADMIN_ACTOR);
    connect(7, 'G-TARGET', TARGET_ACTOR);
    admin.banViaBackend(mp, ctx, 3, ADMIN_ACTOR, target, 1, 'senior');
    await settle();
    check('a target still on its connection is kicked with the ban reason', to('G-TARGET').join() === 'kicked' && kicks.length === 1 && kicks[0].guid === 'G-TARGET' && /banned/.test(packets.find((p) => p.guid === 'G-TARGET').body.reason), { packets: to('G-TARGET'), kicks });
  }

  // ---- the shout lesson 15 s after an actor assignment ----
  const timers = [];
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms, ...a) => (ms === 15000 ? (timers.push(fn), 0) : realSetTimeout(fn, ms, ...a));
  {
    reset();
    const admin = new AdminSystem(() => {}, {}, {});
    const ctx = { svr: mp, gm: new EventEmitter() };
    await admin.initAsync(ctx);
    props[SHOUT_ACTOR] = { 'private.dboAllShouts': true, profileId: 5 };
    connect(4, 'G-SHOUTER', SHOUT_ACTOR);
    ctx.gm.emit('userAssignActor', 4, SHOUT_ACTOR);
    check('a character given all shouts gets a lesson queued', timers.length === 1, timers.length);
    drop(4);
    connect(4, 'G-OTHER');
    timers.splice(0).forEach((fn) => fn());
    check('the lesson is not sent to the next player on that userId', to('G-OTHER').length === 0, to('G-OTHER'));

    connect(6, 'G-SHOUTER2', SHOUT_ACTOR);
    ctx.gm.emit('userAssignActor', 6, SHOUT_ACTOR);
    timers.splice(0).forEach((fn) => fn());
    check('the lesson still reaches the character it was queued for', to('G-SHOUTER2').join() === 'dboTeachShouts', to('G-SHOUTER2'));
  }
  global.setTimeout = realSetTimeout;

  process.chdir(cwd);
  fs.rmSync(out, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.log('FAIL the harness threw', e); fs.rmSync(out, { recursive: true, force: true }); process.exit(1); });
