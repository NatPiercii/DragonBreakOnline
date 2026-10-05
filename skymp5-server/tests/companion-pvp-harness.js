// Scripted test for the PvP rules of companionSystem.ts (Nate, 5 Oct: a summon or a raised corpse fights another player
// only when PvP allows that fight). A player, or a companion fighting for one, is a valid target only while that player
// and the owner fought each other within the window (a player's own blow on the other player or the other's companion)
// and the gameplay's rule globalThis.__dboCompanionMayFight agrees; a companion's own blows never open or extend the
// window, and its hit on a player outside the rules is refused. PvE targets are unchanged. It bundles companionSystem.ts
// with esbuild (settings and placement stubbed) on a fake mp. Run it from skymp5-server with node_modules present:
//
//   node tests/companion-pvp-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const esbuild = require(path.join(root, 'node_modules', 'esbuild'));
const out = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'claude-nate-companion-pvp-'));
const bundle = path.join(out, 'companion.js');

let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

// Players use the Player base (0x7) and a profile id; NPCs a base of their own and none
const A = 0xff000101, B = 0xff000102, C = 0xff000103, WOLF = 0xff000200;
const PLAYER_BASE = 0x7, WOLF_BASE = 0x23aba, SUMMON_BASE = 0x640b5;
const SWORD = 0x12eb7;

(async () => {
  await esbuild.build({
    entryPoints: [path.join(root, 'ts', 'systems', 'companionSystem.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'error',
    plugins: [{
      name: 'stubs',
      setup(b) {
        b.onResolve({ filter: /^\.\.\/settings$|^\.\/npcPlacement$|^\.\.\/scampNative$/ }, (a) => ({ path: a.path, namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({
          contents: a.path === '../settings'
            ? 'module.exports = { Settings: { get: async () => ({ allSettings: globalThis.__pvpSettings || {} }) } };'
            : a.path === './npcPlacement'
              ? 'module.exports = { HOSTILE_PROP: "ff_hostile", placeNpc: (...x) => globalThis.__pvpPlace(...x), placeAtMe: () => 0 };'
              : 'module.exports = {};',
          loader: 'js',
        }));
      },
    }],
  });
  const { CompanionSystem } = require(bundle);

  let now = 1_000_000;
  const realNow = Date.now;
  Date.now = () => now;
  const props = new Map();
  const get = (id, k) => props.get(`${id >>> 0}|${k}`);
  const set = (id, k, v) => props.set(`${id >>> 0}|${k}`, v);
  const users = new Map([[A, 1], [B, 2], [C, 3]]);
  const online = new Set([1, 2, 3]);
  const sent = [];
  const logs = [];
  const descOf = (id) => `${(id >>> 0).toString(16)}:Skyrim.esm`;
  const mp = {
    get: (id, k) => { const v = get(id, k); if (v === undefined && k === 'profileId') return -1; if (v === undefined) throw new Error(`no ${k} on ${id.toString(16)}`); return v; },
    set,
    getUserByActor: (id) => (users.has(id >>> 0) ? users.get(id >>> 0) : -1),
    isConnected: (u) => online.has(u),
    getUserActor: (u) => [...users].find(([, x]) => x === u)?.[0] ?? 0,
    getActorCellOrWorld: () => 0x3c,
    getActorPos: (id) => get(id, 'pos') || [0, 0, 0],
    getDescFromId: descOf,
    getIdFromDesc: (d) => parseInt(String(d), 16) >>> 0,
    lookupEspmRecordById: (id) => ({ record: { type: (id >>> 0) === SWORD ? 'WEAP' : 'NPC_' } }),
    makeProperty: () => {},
    destroyActor: (id) => props.set(`${id >>> 0}|gone`, true),
    sendCustomPacket: (u, p) => sent.push([u, JSON.parse(p)]),
  };
  const actor = (id, base, profile, pos) => {
    set(id, 'baseDesc', descOf(base)); set(id, 'isDead', false); set(id, 'pos', pos);
    set(id, 'worldOrCellDesc', '3c:Skyrim.esm'); set(id, 'angle', [0, 0, 0]);
    if (profile >= 0) set(id, 'profileId', profile);
  };
  actor(A, PLAYER_BASE, 11, [0, 0, 0]); actor(B, PLAYER_BASE, 12, [300, 0, 0]); actor(C, PLAYER_BASE, 13, [0, 300, 0]);
  actor(WOLF, WOLF_BASE, -1, [0, -300, 0]);
  let nextId = 0xff000500;
  globalThis.__pvpPlace = (_mp, ownerId, baseDesc, loc) => { const id = nextId++; actor(id, parseInt(baseDesc, 16), -1, loc.pos); return id; };

  const ctx = { svr: mp, gm: { on() {}, once() {}, emit() {} } };
  const realTimeout = global.setTimeout;
  const tick = async (sys) => { global.setTimeout = (fn) => { fn(); return 0; }; try { await sys.updateAsync(); } finally { global.setTimeout = realTimeout; } };
  const hit = (agg, tgt, dmg = 10) => mp.onHitDamageAttempt(agg, tgt, SWORD, dmg, {});
  const order = (sys, user, targetId) => sys.customPacket(user, 'companionCommand', { action: 'attack', targetId }, ctx);
  const lastState = (user) => { for (let i = sent.length - 1; i >= 0; i--) if (sent[i][0] === user && sent[i][1].customPacketType === 'companionState') return sent[i][1]; return null; };
  const targetOf = (sys, id) => sys.info(id)?.targetId ?? -1;
  const hookCalls = [];
  const allow = (verdict) => { globalThis.__dboCompanionMayFight = (o, p) => { hookCalls.push([o, p]); return typeof verdict === 'function' ? verdict(o, p) : verdict; }; };

  // A fresh system, its hit hook installed on mp, A owning a summon S and B owning a summon T
  const boot = async (settings) => {
    globalThis.__pvpSettings = settings || {};
    delete mp.onHitDamageAttempt; delete mp.onHostAttempt;
    for (const u of [1, 2, 3]) online.add(u);
    for (const id of [A, B, C]) set(id, 'isDead', false);
    process.chdir(out);
    const sys = new CompanionSystem((...x) => logs.push(x.join(' ')));
    await sys.initAsync(ctx);
    const S = sys.spawn(A, SUMMON_BASE, { kind: 'summon' });
    const T = sys.spawn(B, SUMMON_BASE, { kind: 'summon' });
    sent.length = 0; hookCalls.length = 0;
    return { sys, S, T };
  };

  // ---- PvE is unchanged ----
  delete globalThis.__dboCompanionMayFight;
  let { sys, S, T } = await boot();
  check('PvE: the owner\'s hit on a wolf is the attack order, with no PvP rule in place', hit(A, WOLF) === true && targetOf(sys, S) === WOLF, targetOf(sys, S));
  check('PvE: ...and the state says it is no PvP target', lastState(1)?.companions?.[0]?.pvp === false, lastState(1));
  check('PvE: a summon\'s blow on the wolf lands', hit(S, WOLF) === true);
  check('PvE: the PvP rule is never asked about a wolf', hookCalls.length === 0, hookCalls);
  check('a companion still never damages its owner', hit(S, A) === false);

  // ---- no gameplay rule: no player is ever fair game ----
  ({ sys, S, T } = await boot());
  check('no rule: the owner\'s hit on a player lands (PvP itself is the gameplay\'s business)', hit(A, B) === true);
  check('no rule: ...but the summon is not ordered onto that player', targetOf(sys, S) === 0, targetOf(sys, S));
  order(sys, 1, B);
  check('no rule: the client\'s attack order on that player is refused', targetOf(sys, S) === 0, targetOf(sys, S));
  check('no rule: the summon\'s own blow on that player is refused', hit(S, B) === false);
  check('no rule: the victim\'s summon does not turn on the attacker either', targetOf(sys, T) === 0, targetOf(sys, T));

  // ---- the rule allows it: fights only while the two players are fighting ----
  ({ sys, S, T } = await boot());
  allow(true);
  order(sys, 1, B);
  check('a client order on a player nobody fought is refused, rule or not', targetOf(sys, S) === 0, targetOf(sys, S));
  check('...and the summon\'s blow on them is refused', hit(S, B) === false);
  check('the owner\'s hit on a player orders the summon onto them', hit(A, B) === true && targetOf(sys, S) === B, targetOf(sys, S));
  check('...the state marks it a PvP target', lastState(1)?.companions?.find((c) => c.id === S)?.pvp === true, lastState(1));
  check('...the rule was asked as (owner, player)', hookCalls.some(([o, p]) => o === A && p === B), hookCalls);
  check('...the victim\'s summon defends them against the attacker', targetOf(sys, T) === A, targetOf(sys, T));
  check('...and the victim\'s state marks that a PvP target too', lastState(2)?.companions?.find((c) => c.id === T)?.pvp === true, lastState(2));
  check('the summon\'s blow on that player lands inside the window', hit(S, B) === true);
  check('the summon may fight what fights for that player (their summon)', hit(S, T) === true);
  check('a third player nobody fought stays off limits', hit(S, C) === false);
  order(sys, 1, C);
  check('...and an order on them is refused', targetOf(sys, S) === B, targetOf(sys, S));
  // The summon keeps hitting for 30 s; that never extends the window, so it lapses 60 s after the owner's own blow
  now += 30000; hit(S, B); now += 29000; hit(S, B);
  await tick(sys);
  check('59 s after the owner\'s blow the order holds', targetOf(sys, S) === B, targetOf(sys, S));
  now += 1500;
  await tick(sys);
  check('past 60 s the order is dropped though the summon kept striking', targetOf(sys, S) === 0, targetOf(sys, S));
  check('...and the owner\'s client is told', lastState(1)?.companions?.find((c) => c.id === S)?.target === 0, lastState(1));
  check('...and its blows on that player are refused from then on', hit(S, B) === false);

  // ---- defending: the other player started it ----
  ({ sys, S, T } = await boot());
  allow(true);
  check('a player\'s hit on the owner lands', hit(B, A) === true);
  check('...and the owner\'s summon turns on them', targetOf(sys, S) === B, targetOf(sys, S));
  ({ sys, S, T } = await boot());
  allow(true);
  hit(B, S);
  order(sys, 1, B);
  check('a player who struck the summon may be ordered upon', targetOf(sys, S) === B, targetOf(sys, S));
  ({ sys, S, T } = await boot());
  allow(true);
  hit(A, T);
  order(sys, 1, T);
  check('striking another player\'s summon opens the fight with that player: its summon may be ordered upon', targetOf(sys, S) === T, targetOf(sys, S));
  check('...and the state marks it a PvP target', lastState(1)?.companions?.find((c) => c.id === S)?.pvp === true, lastState(1));

  // ---- a companion never opens a fight with a player ----
  ({ sys, S, T } = await boot());
  allow(true);
  check('a summon\'s blow on a player nobody fought is refused', hit(S, B) === false);
  hit(S, B); hit(T, A);
  order(sys, 1, B);
  check('...and companions\' blows open no window', targetOf(sys, S) === 0, targetOf(sys, S));
  hit(A, B, 0);
  order(sys, 1, B);
  check('a blow without damage (a probe, a ward) opens no window', targetOf(sys, S) === 0, targetOf(sys, S));

  // ---- the rule says no (party, safe ground, jail ...), or fails ----
  ({ sys, S, T } = await boot());
  allow((o, p) => !(p === C || o === C));
  hit(A, C);
  check('the rule refusing the pair: no order onto that player', targetOf(sys, S) === 0, targetOf(sys, S));
  check('...and the summon\'s blow on them is refused', hit(S, C) === false);
  hit(A, B);
  check('...while another fight the rule allows goes on', targetOf(sys, S) === B, targetOf(sys, S));
  globalThis.__dboCompanionMayFight = () => 'yes';
  await tick(sys);
  check('a rule answering anything but true drops the order at the next check', targetOf(sys, S) === 0, targetOf(sys, S));
  globalThis.__dboCompanionMayFight = () => { throw new Error('boom'); };
  hit(A, B);
  check('a rule that throws refuses', targetOf(sys, S) === 0 && hit(S, B) === false, targetOf(sys, S));
  check('...and the failure is logged', logs.some((l) => l.includes('__dboCompanionMayFight failed')), logs.slice(-3));

  // ---- downed, offline ----
  ({ sys, S, T } = await boot());
  allow(true);
  hit(A, B);
  set(B, 'isDead', true);
  await tick(sys);
  check('a downed (dead) player is dropped as a target', targetOf(sys, S) === 0, targetOf(sys, S));
  check('...and cannot be struck by the summon', hit(S, B) === false);
  set(B, 'isDead', false);
  hit(A, B);
  online.delete(2);
  await tick(sys);
  check('a player who logged out is dropped as a target', targetOf(sys, S) === 0, targetOf(sys, S));
  check('...and their body cannot be struck by the summon', hit(S, B) === false);

  // ---- the window is configurable ----
  ({ sys, S, T } = await boot({ companionPvpHostileSeconds: 10 }));
  allow(true);
  hit(A, B);
  now += 11000;
  await tick(sys);
  check('companionPvpHostileSeconds shortens the window', targetOf(sys, S) === 0, targetOf(sys, S));

  Date.now = realNow;
  delete globalThis.__dboCompanionMayFight;
  try { fs.rmSync(out, { recursive: true, force: true }); } catch (e) { /* temp */ }
  console.log(failures ? `${failures} FAILED` : 'all passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
