// Scripted test for companionPvp.ts and its use in companionService.ts (Nate, 5 Oct: summons and raised corpses fight
// players "in pvp"; the server decides). A player target counts only with the server's pvp mark, a fight the engine picked
// with a player the server has not named is left, the assist scan never picks a player, and an order clears the fallback
// follow's keep-offset (#bugs 2 Oct: a raised bandit ordered onto a player stayed at its owner's side for 30 s with its
// offset on). Drives the real service against a stubbed game. Run from skymp5-client:
//
//   node tests/companion-pvp-harness.js [path to esbuild's package dir]
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const esbuildDir = [process.argv[2], path.resolve(__dirname, '../../skymp5-server/node_modules/esbuild'),
  path.join(os.homedir(), 'dragonbreak/fork/skymp5-server/node_modules/esbuild')].find((p) => p && fs.existsSync(p));
if (!esbuildDir) { console.log('SKIP companion-pvp (no esbuild)'); process.exit(0); }
const esbuild = require(esbuildDir);

let failures = 0;
const check = (name, ok, got) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`);
  if (!ok) failures++;
};

// Remote ids (the server's) and the local ids of their copies here
const S = 0xff000500, B = 0xff000102, C = 0xff000103, WOLF = 0xff000200;
const LOCAL = { [S]: 0xff100500, [B]: 0xff100102, [C]: 0xff100103, [WOLF]: 0xff100200 };
const REMOTE = Object.fromEntries(Object.entries(LOCAL).map(([r, l]) => [l, Number(r)]));
const PLAYERS = new Set([B, C]);

const STUBS = {
  skyrimPlatform: `
    const W = () => globalThis.__cpvp;
    module.exports = {
      Actor: { from: (f) => (f && f.isActor ? f : null) }, ObjectReference: { from: (f) => f || null },
      Quest: { from: () => null }, ReferenceAlias: { from: () => null },
      get storage() { return W().storage; },
    };`,
  clientListener: 'class ClientListener {} module.exports = { ClientListener };',
  customPacketUtil: `module.exports = {
    parseCustomPacket: (e) => { try { return JSON.parse(e.message.contentJsonDump); } catch { return null; } },
    sendCustomPacket: (_c, p) => globalThis.__cpvp.sent.push(p) };`,
  worldCleaner: 'class WorldCleanerService {} module.exports = { WorldCleanerService };',
  worldViewMisc: `
    const W = () => globalThis.__cpvp;
    module.exports = {
      getViewFromStorage: () => W().view,
      isRemoteHostedByMe: () => true,
      isRemotePlayerCharacter: (id) => W().players.has(id),
      localIdToRemoteId: (l) => (l >= 0xff000000 ? (W().remote[l] || 0) : l),
      remoteIdToLocalId: (r) => (r >= 0xff000000 ? (W().local[r] || 0) : r),
    };`,
  ownCompanions: `
    const W = () => globalThis.__cpvp;
    module.exports = { COMPANION_IDS_KEY: 'ownCompanionIds', isOwnCompanion: (id) => (W().storage.ownCompanionIds || []).includes(id),
      isAnyCompanion: (id) => (W().storage.ownCompanionIds || []).includes(id) };`,
  movementApply: 'module.exports = { applyMovement() {}, settleTranslation() {} };',
  objectReferenceEx: 'module.exports = { ObjectReferenceEx: { getWorldOrCell: () => 0x3c } };',
  hostAttempts: 'module.exports = { lastTryHost: {}, tryHost() {} };',
  empty: 'module.exports = {};',
};
const STUB_OF = {
  skyrimPlatform: 'skyrimPlatform', './clientListener': 'clientListener', './customPacketUtil': 'customPacketUtil',
  './worldCleanerService': 'worldCleaner', '../../view/worldViewMisc': 'worldViewMisc', '../../sync/ownCompanions': 'ownCompanions',
  '../../sync/movementApply': 'movementApply', '../../extensions/objectReferenceEx': 'objectReferenceEx',
  '../../view/hostAttempts': 'hostAttempts', '../events/connectionMessage': 'empty', '../messages/customPacketMessage': 'empty',
};

// A fake actor: every call is recorded; position, combat target and distance are plain fields
const makeActor = (W, localId, pos) => {
  const a = {
    isActor: true, localId, pos, combatTarget: null, calls: [],
    getFormID: () => localId, isDead: () => false, is3DLoaded: () => true, isDeleted: () => false, isDisabled: () => false,
    getPositionX: () => a.pos[0], getPositionY: () => a.pos[1], getPositionZ: () => a.pos[2], getAngleZ: () => 0,
    getDistance: (o) => Math.hypot(a.pos[0] - o.pos[0], a.pos[1] - o.pos[1], a.pos[2] - o.pos[2]),
    getCombatTarget: () => a.combatTarget, isInCombat: () => !!a.combatTarget,
    startCombat: (t) => { a.calls.push(['startCombat', t.localId]); a.combatTarget = t; },
    stopCombat: () => { a.calls.push(['stopCombat', a.combatTarget ? a.combatTarget.localId : 0]); a.combatTarget = null; },
    keepOffsetFromActor: () => a.calls.push(['keepOffset']), clearKeepOffsetFromActor: () => a.calls.push(['clearKeepOffset']),
    getActorValue: () => 100, getActorValuePercentage: () => 1, isAIEnabled: () => true, isWeaponDrawn: () => true,
    getBaseObject: () => ({ getName: () => 'Bandit Outlaw', getFormID: () => 0x617c9 }), getDisplayName: () => 'Bandit Outlaw',
    getParentCell: () => null, getWorldSpace: () => null, getCurrentPackage: () => null,
    getFactionReaction: () => 0, isHostileToActor: () => true, getRelationshipRank: () => 0,
    getEquippedWeapon: () => null, getEquippedItemType: () => 0, hasPerk: () => false, placeAtMe: () => null,
  };
  for (const m of ['evaluatePackage', 'removeFromAllFactions', 'setFactionRank', 'setPlayerTeammate', 'ignoreFriendlyHits',
    'setActorValue', 'setDontMove', 'stopCombatAlarm', 'moveTo', 'setPosition']) a[m] = () => {};
  W.forms.set(localId, a);
  return a;
};

async function main() {
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'claude-nate-companion-pvp-'));
  try {
    const outPure = path.join(tmp, 'companionPvp.js');
    await esbuild.build({ entryPoints: [path.resolve(__dirname, '../src/services/services/companionPvp.ts')], bundle: true,
      platform: 'node', format: 'cjs', outfile: outPure, logLevel: 'error' });
    pure(require(outPure));
    const outSvc = path.join(tmp, 'companionService.js');
    await esbuild.build({
      entryPoints: [path.resolve(__dirname, '../src/services/services/companionService.ts')], bundle: true, platform: 'node',
      format: 'cjs', outfile: outSvc, logLevel: 'error',
      plugins: [{ name: 'stubs', setup(b) {
        b.onResolve({ filter: /.*/ }, (a) => (STUB_OF[a.path] ? { path: STUB_OF[a.path], namespace: 'stub' } : undefined));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ contents: STUBS[a.path], loader: 'js' }));
      } }],
    });
    service(outSvc);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
}

function pure(m) {
  const isPlayer = (id) => PLAYERS.has(id);
  check('pure: an NPC target is carried out without the pvp mark', m.orderedTarget({ target: WOLF, pvp: false }, isPlayer) === WOLF);
  check('pure: a player target without the mark is no order', m.orderedTarget({ target: B, pvp: false }, isPlayer) === 0);
  check('pure: a player target with the mark is carried out', m.orderedTarget({ target: B, pvp: true }, isPlayer) === B);
  check('pure: no target is no order', m.orderedTarget({ target: 0, pvp: true }, isPlayer) === 0);
  check('pure: an engine fight with an NPC is never left', !m.leavesPlayerFight(WOLF, { target: 0, pvp: false }, isPlayer));
  check('pure: an engine fight with a player nobody named is left', m.leavesPlayerFight(B, { target: 0, pvp: false }, isPlayer));
  check('pure: ...with a player named without the mark, too', m.leavesPlayerFight(B, { target: B, pvp: false }, isPlayer));
  check('pure: ...with a player other than the named one, too', m.leavesPlayerFight(C, { target: B, pvp: true }, isPlayer));
  check('pure: the named, marked player is fought', !m.leavesPlayerFight(B, { target: B, pvp: true }, isPlayer));
  check('pure: no combat target leaves nothing', !m.leavesPlayerFight(0, { target: 0, pvp: false }, isPlayer));
  check('pure: a raised corpse is ruled like a summon', m.orderedTarget({ target: B, pvp: false, kind: 'reanimated' }, isPlayer) === 0
    && m.leavesPlayerFight(B, { target: 0, pvp: false, kind: 'reanimated' }, isPlayer));
  check('pure: a GM warband follower (kind companion) keeps its player target without the mark', m.orderedTarget({ target: B, pvp: false, kind: 'companion' }, isPlayer) === B);
  check('pure: ...and its engine fights with players are left alone', !m.leavesPlayerFight(C, { target: 0, pvp: false, kind: 'companion' }, isPlayer));
}

function service(bundle) {
  let now = 5_000_000;
  const realNow = Date.now;
  Date.now = () => now;
  const fresh = () => {
    const W = globalThis.__cpvp = { storage: {}, sent: [], forms: new Map(), players: PLAYERS, local: LOCAL, remote: REMOTE, view: null };
    const player = makeActor(W, 0x14, [0, 0, 0]);
    const summon = makeActor(W, LOCAL[S], [100, 0, 0]);
    const b = makeActor(W, LOCAL[B], [400, 0, 0]);
    const c = makeActor(W, LOCAL[C], [0, 400, 0]);
    const wolf = makeActor(W, LOCAL[WOLF], [0, -400, 0]);
    const views = [S, B, C, WOLF].map((r) => ({ getRemoteRefrId: () => r, getLocalRefrId: () => LOCAL[r] }));
    W.view = { getFormViews: () => ({ getFormViewsArrayLength: () => views.length, getNthFormView: (i) => views[i] }) };
    const none = { from: () => null };
    const sp = {
      Game: { getPlayer: () => player, getFormEx: (id) => W.forms.get(id) || null, getFormFromFile: () => null },
      Actor: { from: (f) => (f && f.isActor ? f : null) }, Weapon: { from: (f) => (f && f.weapon ? f : null) },
      Spell: none, Scroll: none, Faction: none, Perk: none,
    };
    const handlers = {};
    const controller = {
      emitter: { on: (n, fn) => { handlers[n] = fn; } }, on: (n, fn) => { handlers[n] = fn; },
      lookupListener: () => ({ sweepBurst() {} }),
    };
    const { CompanionService } = require(bundle);
    new CompanionService(sp, controller);
    const state = (companions) => handlers.customPacketMessage({ message: { contentJsonDump: JSON.stringify({ customPacketType: 'companionState', companions }) } });
    const tick = (n = 1) => { for (let i = 0; i < n; i++) { now += 300; handlers.update(); } };
    return { W, player, summon, b, c, wolf, state, tick, handlers };
  };
  const started = (a, id) => a.calls.some(([m, t]) => m === 'startCombat' && t === id);
  const stopped = (a, id) => a.calls.some(([m, t]) => m === 'stopCombat' && t === id);
  const reports = (W) => W.sent.filter((p) => p.customPacketType === 'dbo' && p.args && p.args[0] && p.args[0].kind === 'companion' && p.args[0].fight);

  // An NPC order is carried out as before
  let t = fresh();
  t.state([{ id: S, target: WOLF }]);
  t.tick(2);
  check('an NPC target is attacked without any pvp mark', started(t.summon, LOCAL[WOLF]), t.summon.calls);

  // A player target from a server without the PvP rules (no mark): never fought
  t = fresh();
  t.state([{ id: S, target: B }]);
  t.tick(4);
  check('a player target without the server\'s pvp mark is never attacked', !started(t.summon, LOCAL[B]), t.summon.calls);
  t.summon.combatTarget = t.b;
  t.tick(1);
  check('...and a fight the engine starts with that player is left', stopped(t.summon, LOCAL[B]) && t.summon.combatTarget === null, t.summon.calls);

  // The marked player is fought, and stays fought
  t = fresh();
  t.state([{ id: S, target: B, pvp: true }]);
  t.tick(4);
  check('a player target the server marked pvp is attacked', started(t.summon, LOCAL[B]), t.summon.calls);
  check('...and that fight is not left', !stopped(t.summon, LOCAL[B]) && t.summon.combatTarget === t.b, t.summon.calls);
  t.summon.combatTarget = t.c;
  t.tick(1);
  check('an engine switch to another player nobody named is left, and the named one taken up again',
    stopped(t.summon, LOCAL[C]) && t.summon.combatTarget === t.b, t.summon.calls);
  t.state([{ id: S, target: 0 }]);
  t.tick(1);
  check('the server dropping the order (the PvP window ended) ends the fight with that player', stopped(t.summon, LOCAL[B]) && t.summon.combatTarget === null, t.summon.calls);
  t.summon.combatTarget = t.b;
  t.tick(1);
  check('...and an engine fight with them afterwards is left', t.summon.combatTarget === null, t.summon.calls);

  // A GM warband follower keeps the old rules
  t = fresh();
  t.state([{ id: S, target: B, kind: 'companion' }]);
  t.tick(2);
  check('a warband follower ordered onto a player by an older server attacks them', started(t.summon, LOCAL[B]), t.summon.calls);
  t.state([{ id: S, target: 0, kind: 'companion' }]);
  t.tick(1);
  t.summon.combatTarget = t.c;
  t.tick(2);
  check('...and an engine fight of its own with a player is not left', t.summon.combatTarget === t.c, t.summon.calls);

  // A raised corpse is ruled like a summon
  t = fresh();
  t.state([{ id: S, target: B, kind: 'reanimated' }]);
  t.tick(3);
  check('a raised corpse ordered onto a player without the mark does not attack', !started(t.summon, LOCAL[B]), t.summon.calls);

  // An engine fight with an NPC is left alone
  t = fresh();
  t.state([{ id: S, target: 0 }]);
  t.tick(2);
  t.summon.combatTarget = t.wolf;
  t.tick(3);
  check('an engine fight with an NPC is not left', !stopped(t.summon, LOCAL[WOLF]) && t.summon.combatTarget === t.wolf, t.summon.calls);

  // The fallback follow's keep-offset is cleared when an order arrives (the 2 Oct raised bandit)
  t = fresh();
  t.state([{ id: S, target: 0 }]);
  t.tick(3);
  const followed = t.summon.calls.some(([m]) => m === 'keepOffset');
  t.summon.calls.length = 0;
  t.state([{ id: S, target: B, pvp: true }]);
  t.tick(1);
  check('a following companion keeps an offset to its owner (no follower alias here)', followed);
  check('...an order clears that offset before the fight starts', t.summon.calls.findIndex(([m]) => m === 'clearKeepOffset') >= 0
    && t.summon.calls.findIndex(([m]) => m === 'clearKeepOffset') < t.summon.calls.findIndex(([m]) => m === 'startCombat'), t.summon.calls);
  now += 6000; t.tick(1);
  const r = reports(t.W).pop();
  check('...and the report says following false, offset cleared, with the order and its mark', r && r.args[0].following === false
    && r.args[0].follow === 'offset cleared for an order' && r.args[0].order === B.toString(16) && r.args[0].orderPvp === true
    && r.args[0].combatPlayer === true, r && r.args[0]);

  // The assist scan never picks a player; it still picks an NPC in a fight with the owner
  t = fresh();
  t.state([{ id: S, target: 0 }]);
  t.b.combatTarget = t.player;
  now += 2000; t.tick(2);
  check('the assist never orders an attack on a player fighting the owner', !t.W.sent.some((p) => p.action === 'attack'), t.W.sent.filter((p) => p.action));
  t.wolf.combatTarget = t.player;
  now += 2000; t.tick(2);
  check('...but still on a wolf fighting the owner', t.W.sent.some((p) => p.action === 'attack' && p.targetId === WOLF), t.W.sent.filter((p) => p.action));

  // The owner's own hit on a player still goes to the server, which decides
  t = fresh();
  t.state([{ id: S, target: 0 }]);
  t.handlers.hit({ aggressor: t.player, target: t.b, source: { weapon: true } });
  check('the owner\'s hit on a player is sent as an attack order for the server to judge', t.W.sent.some((p) => p.action === 'attack' && p.targetId === B), t.W.sent);

  Date.now = realNow;
}

main().catch((e) => { console.error(e); process.exit(1); });
