// Scripted test for the scroll fire fallback (30 Sep 2026: a last scroll's cast never reached the server). The platform
// checks a scroll cast against the caster's hands in a deferred task, after the engine used up and unequipped the last
// scroll, so it drops the cast; SKSE's actionSpellFire is sent before the scroll fires and carries the scroll the hand
// held. This loads the real magicSyncService.ts and scrollFireFallback.ts (transpiled in memory with the client's own
// TypeScript) with stubbed platform and networking, and plays the event orders the engine produces. Run it from
// skymp5-client:
//
//   node tests/scrollfire-harness.js
'use strict';
const fs = require('fs');
const path = require('path');
const ts = require(path.resolve(__dirname, '..', 'node_modules', 'typescript'));
const SRC = path.resolve(__dirname, '..', 'src');

let failures = 0;
let passes = 0;
const check = (name, ok, got) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`);
  if (ok) passes++; else failures++;
};

// ---- loader: transpile a source file and give it stubbed imports -------------------------------------------------------
const transpile = (rel) => ts.transpileModule(fs.readFileSync(path.join(SRC, rel), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, esModuleInterop: true },
  fileName: rel,
}).outputText;
const load = (rel, requireMap) => {
  const module = { exports: {} };
  const req = (spec) => {
    if (!(spec in requireMap)) throw new Error(`${rel}: unexpected import ${spec}`);
    return requireMap[spec];
  };
  new Function('exports', 'require', 'module', transpile(rel))(module.exports, req, module);
  return module.exports;
};

// ---- a fake clock both the service and the tracker read -------------------------------------------------------------------
const clock = { t: 1000000 };
Date.now = () => clock.t;

// ---- the world the stubs read, reset per scenario ---------------------------------------------------------------------------
const PLAYER = 0x14, NPC = 0xff000a01, CLONE = 0xff000b02;
const FIREBOLT_SCROLL = 0x0009cd51, ICESPIKE_SCROLL = 0x0009cd52, FIREBOLT_SPELL = 0x0012fcd0, SWORD = 0x00012eb7;
const BLOCKED_POWER = 0x000E40C3; // PowerNordBattleCry's id on a scroll, to show the fallback meets relaySpellCast's exits
const TYPE = { Spell: 22, ScrollItem: 23, Weapon: 41, Actor: 62 };
const REMOTE = { [PLAYER]: 0xff00d001, [NPC]: 0xff00d0a1, [CLONE]: 0xff00d0b2 };

let world;
class FormStub {
  constructor(id, type) { this.id = id >>> 0; this.type = type; }
  getFormID() { return this.id; }
  getType() { return this.type; }
}
class ActorStub extends FormStub {
  constructor(id) { super(id, TYPE.Actor); this.inv = new Map(); this.dispelled = []; }
  getItemCount(form) { return form ? (this.inv.get(form.getFormID()) || 0) : 0; }
  getAngleX() { return 10; }
  getAngleZ() { return 90; }
  isWeaponDrawn() { return true; }
  getAnimationVariableBool() { return false; }
  getEquippedSpell() { return null; }
  getEquippedItemType() { return 0; }
  dispelSpell(spell) { this.dispelled.push(spell.getFormID()); }
}
const resetWorld = () => {
  world = {
    forms: new Map(),
    hosted: new Set([NPC]),
    serverCasts: new Set(),
    traces: [],
    errors: [],
    notifications: [],
  };
  for (const id of [PLAYER, NPC, CLONE]) world.forms.set(id, new ActorStub(id));
  for (const id of [FIREBOLT_SCROLL, ICESPIKE_SCROLL, BLOCKED_POWER]) world.forms.set(id, new FormStub(id, TYPE.ScrollItem));
  world.forms.set(FIREBOLT_SPELL, new FormStub(FIREBOLT_SPELL, TYPE.Spell));
  world.forms.set(SWORD, new FormStub(SWORD, TYPE.Weapon));
};
const form = (id) => world.forms.get(id >>> 0);
const setCount = (actorId, itemId, n) => form(actorId).inv.set(itemId, n);

const skyrimPlatform = {
  Actor: { from: (f) => (f instanceof ActorStub ? f : null) },
  Game: { getFormEx: (id) => world.forms.get(id >>> 0) || null, getPlayer: () => form(PLAYER) },
  Spell: { from: (f) => (f ? f : null) },
  Debug: { notification: (text) => world.notifications.push(text) },
  printConsole: () => {},
  getAnimationVariablesFromActor: () => ({ booleans: new ArrayBuffer(2), floats: new ArrayBuffer(4), integers: new ArrayBuffer(4) }),
  SpellType: { Left: 0, Right: 1, Voise: 2, Instant: 3 },
  SlotType: { Left: 1, Right: 2, Voice: 3 },
  EquippedItemType: { Staff: 8 },
};
const fallbackModule = load('services/services/scrollFireFallback.ts', {});
const messagesModule = load('messages.ts', {});
const { MagicSyncService } = load('services/services/magicSyncService.ts', {
  'skyrimPlatform': skyrimPlatform,
  // Every actor here is humanoid; tests/beastbody-harness.js covers a beast caster's empty snapshot
  '../../sync/beastRaces': { guardedRaceOf: () => 0 },
  '../../view/worldViewMisc': {
    isHostedByMe: (id) => world.hosted.has(id >>> 0),
    localIdToRemoteId: (id) => REMOTE[id >>> 0] || 0,
  },
  './clientListener': { ClientListener: class ClientListener {} },
  '../../logging': {
    logError: (_svc, ...rest) => world.errors.push(rest.map(String).join(' ')),
    logTrace: (_svc, ...rest) => world.traces.push(rest.map(String).join(' ')),
  },
  './castSelfService': { consumeServerCast: (spellId) => world.serverCasts.delete(spellId) },
  './customPacketUtil': { sendCustomPacket: () => {} },
  './scrollFireFallback': fallbackModule,
  '../../messages': messagesModule,
});
const { ScrollFireTracker, SCROLL_PAIR_MS, SCROLL_WAIT_MS, SCROLL_SUPPRESS_MS } = fallbackModule;
const SPELL_CAST = messagesModule.MsgType.SpellCast;

// ---- one client: a controller that records what the service sends ---------------------------------------------------------
const newClient = () => {
  resetWorld();
  const handlers = {};
  const onceQueue = {};
  const sent = [];
  const controller = {
    on: (name, cb) => { (handlers[name] = handlers[name] || []).push(cb); },
    once: (name, cb) => { (onceQueue[name] = onceQueue[name] || []).push(cb); },
    emitter: { emit: (name, payload) => { if (name === 'sendMessage') sent.push(JSON.parse(JSON.stringify(payload.message))); } },
    lookupListener: () => null,
  };
  const sp = { hooks: { sendAnimationEvent: { add: () => {} } } };
  const service = new MagicSyncService(sp, controller);
  const emit = (name, event) => (handlers[name] || []).forEach((cb) => cb(event));
  const c = {
    service, handlers, sent,
    // The platform's spellCast, as its native builds it
    platformCast: (caster, spell, castingSource = 1) => emit('spellCast', {
      caster: form(caster), spell: form(spell), target: form(caster), isDualCasting: false, castingSource, aimAngle: 0.25, aimHeading: 1.5,
    }),
    // SKSE's actionSpellFire: actor and source captured at event time; slot is SKSE's raw 0 left / 1 right
    spellFire: (actor, source, slot = 1) => emit('actionSpellFire', { actor: form(actor), source: source ? form(source) : null, slot }),
    // SkyrimPlatform's JsTick: 'update' first (with the once queue), then the event tasks of that frame
    update: (ms = 16) => {
      clock.t += ms;
      const q = onceQueue.update || [];
      onceQueue.update = [];
      q.forEach((cb) => cb());
      emit('update');
    },
    idle: (ms) => { for (let spent = 0; spent < ms; spent += 16) c.update(16); },
    casts: () => sent.filter((m) => m.t === SPELL_CAST && !m.data.interruptCast && !m.data.keepAlive),
    stops: () => sent.filter((m) => m.t === SPELL_CAST && m.data.interruptCast),
    trackerSize: () => service.scrollFires.size(),
  };
  return c;
};

// ---- the wiring ----------------------------------------------------------------------------------------------------------
{
  const c = newClient();
  check('the service listens to actionSpellFire and spellCast', (c.handlers.actionSpellFire || []).length === 1 && (c.handlers.spellCast || []).length === 1);
  const src = fs.readFileSync(path.join(SRC, 'services/services/magicSyncService.ts'), 'utf8');
  const relayFire = src.slice(src.indexOf('private relayScrollFire('), src.indexOf('private describeCast('));
  const onFire = src.slice(src.indexOf('private onActionSpellFire('), src.indexOf('private relayDueScrollFires('));
  check('a fire is relayed only through relaySpellCast (every early exit applies)', /this\.relaySpellCast\(event\);/.test(relayFire) &&
    !/sendSpellCast\(|emitter\.emit\(/.test(relayFire + onFire) && /this\.relayScrollFire\(fire\)/.test(onFire));
  check('the scroll form type is the typings\' FormType.ScrollItem', /ScrollItem = 23,/.test(fs.readFileSync(path.resolve(__dirname, '..', 'node_modules/@skyrim-platform/skyrim-platform/index.d.ts'), 'utf8')) &&
    fallbackModule.SCROLL_FORM_TYPE === 23);
}

// ---- 1. a normal cast: the platform reports it, the fire never relays ---------------------------------------------------------
{
  const c = newClient();
  setCount(PLAYER, FIREBOLT_SCROLL, 2);             // one of three used up before the frame's tasks run
  c.spellFire(PLAYER, FIREBOLT_SCROLL, 1);
  check('normal cast: a fire whose scroll is still held waits for the platform', c.casts().length === 0 && c.trackerSize() === 1);
  c.platformCast(PLAYER, FIREBOLT_SCROLL, 1);
  c.idle(SCROLL_WAIT_MS + 200);
  const casts = c.casts();
  check('normal cast: relayed once, by the platform (its aim, not the fallback\'s)', casts.length === 1 && casts[0].data.spell === FIREBOLT_SCROLL &&
    casts[0].data.aimAngle === 0.25 && casts[0].data.caster === REMOTE[PLAYER], casts);
  check('normal cast: nothing left tracked', c.trackerSize() === 0, c.trackerSize());
  check('normal cast: no fallback trace', !world.traces.some((l) => /from its fire/.test(l)), world.traces);
}
{
  const c = newClient();
  setCount(PLAYER, FIREBOLT_SCROLL, 5);
  c.platformCast(PLAYER, FIREBOLT_SCROLL, 1);         // the shipped platform: often no fire event at all
  c.idle(SCROLL_PAIR_MS + 50);
  check('normal cast with no fire event: relayed once, tracking pruned', c.casts().length === 1 && c.trackerSize() === 0, { casts: c.casts().length, size: c.trackerSize() });
}
{
  const c = newClient();
  setCount(PLAYER, FIREBOLT_SPELL, 0);
  c.platformCast(PLAYER, FIREBOLT_SPELL, 1);
  check('a spell cast (not a scroll) is relayed as before and never tracked', c.casts().length === 1 && c.trackerSize() === 0);
}

// ---- 2. the last scroll of a stack: the platform drops it, the fire relays it once ---------------------------------------------
{
  const c = newClient();
  setCount(PLAYER, FIREBOLT_SCROLL, 0);             // used up and unequipped before the frame's tasks run
  c.spellFire(PLAYER, FIREBOLT_SCROLL, 1);
  const now = c.casts();
  check('last of stack: relayed in the same task drain, before the next update (ahead of the equipment update)', now.length === 1, now);
  c.idle(2000);
  const casts = c.casts();
  const d = casts[0] && casts[0].data;
  check('last of stack: relayed exactly once', casts.length === 1, casts.length);
  check('last of stack: a normal cast message (caster, scroll, right hand, no target, not dual)', d && d.caster === REMOTE[PLAYER] &&
    d.spell === FIREBOLT_SCROLL && d.castingSource === 1 && d.target === 0 && d.isDualCasting === false && d.interruptCast === false &&
    d.keepAlive === false && Array.isArray(d.actorAnimationVariables.booleans), d);
  check('last of stack: aim is the caster\'s facing in radians', d && Math.abs(d.aimAngle - 10 * Math.PI / 180) < 1e-9 && Math.abs(d.aimHeading - Math.PI / 2) < 1e-9, d);
  check('last of stack: the cast gets its stop like any relayed cast (stop, not a second cast)', c.stops().length >= 1 && c.stops()[0].data.spell === FIREBOLT_SCROLL, c.stops().length);
  check('last of stack: the relay is traced', world.traces.some((l) => /scroll cast relayed from its fire: caster 14, spell 9cd51/.test(l)), world.traces);
  check('last of stack: tracking cleared after the suppress window', c.trackerSize() === 0, c.trackerSize());
}
{
  const c = newClient();
  setCount(PLAYER, ICESPIKE_SCROLL, 0);
  c.spellFire(PLAYER, ICESPIKE_SCROLL, 0);
  check('last of stack, left hand: castingSource Left', c.casts().length === 1 && c.casts()[0].data.castingSource === 0);
}
{
  const c = newClient();
  setCount(PLAYER, ICESPIKE_SCROLL, 0);
  c.spellFire(PLAYER, ICESPIKE_SCROLL, 0x7ffe1234); // a slot read from stale memory (EventHandler reads it late)
  check('a slot outside 0/1 falls back to the right hand', c.casts().length === 1 && c.casts()[0].data.castingSource === 1);
}
{
  const c = newClient();
  setCount(PLAYER, FIREBOLT_SCROLL, 1);             // the fire's task ran before the scroll was used up
  c.spellFire(PLAYER, FIREBOLT_SCROLL, 1);
  c.update();
  check('scroll used up a frame later: still waiting while held', c.casts().length === 0);
  setCount(PLAYER, FIREBOLT_SCROLL, 0);
  c.update();
  check('scroll used up a frame later, no platform cast: relayed at the next update', c.casts().length === 1);
  c.platformCast(PLAYER, FIREBOLT_SCROLL, 1);
  c.idle(1500);
  check('...and a late platform cast of it is not relayed again', c.casts().length === 1, c.casts().length);
}

// ---- 3. both arrive: one relay whatever the order ----------------------------------------------------------------------------
{
  const c = newClient();
  setCount(PLAYER, FIREBOLT_SCROLL, 0);
  c.spellFire(PLAYER, FIREBOLT_SCROLL, 1);
  c.platformCast(PLAYER, FIREBOLT_SCROLL, 1);
  c.idle(1500);
  check('fire relayed, then the platform\'s cast: one relay', c.casts().length === 1, c.casts().length);
  check('...the platform\'s duplicate is traced, not sent', world.traces.some((l) => /already relayed from its fire/.test(l)));
}
{
  const c = newClient();
  setCount(PLAYER, FIREBOLT_SCROLL, 0);
  c.platformCast(PLAYER, FIREBOLT_SCROLL, 1);
  c.update();
  c.spellFire(PLAYER, FIREBOLT_SCROLL, 1);
  c.idle(1500);
  check('platform\'s cast first, then the fire of the last scroll: one relay (the platform\'s)', c.casts().length === 1 && c.casts()[0].data.aimAngle === 0.25, c.casts());
}
{
  const c = newClient();
  setCount(PLAYER, FIREBOLT_SCROLL, 1);
  c.spellFire(PLAYER, FIREBOLT_SCROLL, 1);
  c.platformCast(PLAYER, FIREBOLT_SCROLL, 1);
  setCount(PLAYER, FIREBOLT_SCROLL, 0);             // used up after the platform already saw it
  c.idle(1500);
  check('fire waiting, platform\'s cast, then the scroll used up: one relay', c.casts().length === 1, c.casts().length);
}
{
  const c = newClient();
  setCount(PLAYER, FIREBOLT_SCROLL, 0);
  c.spellFire(PLAYER, FIREBOLT_SCROLL, 1);
  c.spellFire(PLAYER, FIREBOLT_SCROLL, 1);          // two action events of one cast under the same name
  c.update();
  c.spellFire(PLAYER, FIREBOLT_SCROLL, 1);
  c.idle(1500);
  check('repeated fires of one used-up scroll: one relay', c.casts().length === 1, c.casts().length);
}
{
  const c = newClient();
  setCount(PLAYER, FIREBOLT_SCROLL, 0);
  c.spellFire(PLAYER, FIREBOLT_SCROLL, 1);
  c.idle(SCROLL_SUPPRESS_MS + 100);
  setCount(PLAYER, FIREBOLT_SCROLL, 3);             // bought more; a new cast later is its own
  c.platformCast(PLAYER, FIREBOLT_SCROLL, 1);
  check('after the suppress window a new cast of the same scroll is relayed', c.casts().length === 2, c.casts().length);
}
{
  const c = newClient();
  setCount(PLAYER, FIREBOLT_SCROLL, 3);
  c.spellFire(PLAYER, FIREBOLT_SCROLL, 1); c.platformCast(PLAYER, FIREBOLT_SCROLL, 1); setCount(PLAYER, FIREBOLT_SCROLL, 2);
  c.idle(700);
  c.spellFire(PLAYER, FIREBOLT_SCROLL, 1); c.platformCast(PLAYER, FIREBOLT_SCROLL, 1); setCount(PLAYER, FIREBOLT_SCROLL, 1);
  c.idle(700);
  setCount(PLAYER, FIREBOLT_SCROLL, 0);
  c.spellFire(PLAYER, FIREBOLT_SCROLL, 1);          // the last: the platform drops it
  c.idle(1500);
  check('three casts from a stack of three, the last one by its fire: three relays', c.casts().length === 3, c.casts().length);
}

// ---- 4. fires that are not scroll casts --------------------------------------------------------------------------------------
{
  const c = newClient();
  c.spellFire(PLAYER, FIREBOLT_SPELL, 1);
  c.spellFire(PLAYER, SWORD, 1);
  c.spellFire(PLAYER, null, 1);
  c.idle(1000);
  check('a fire of a spell, a weapon or nothing is ignored', c.casts().length === 0 && c.trackerSize() === 0 && world.errors.length === 0,
    { casts: c.casts().length, size: c.trackerSize(), errors: world.errors });
}
{
  const c = newClient();
  setCount(PLAYER, FIREBOLT_SCROLL, 4);
  c.spellFire(PLAYER, FIREBOLT_SCROLL, 1);          // a begin-cast or draw event under the fire's name: the scroll stays
  c.idle(SCROLL_WAIT_MS + 200);
  check('a fire whose scroll is never used up relays nothing and is forgotten', c.casts().length === 0 && c.trackerSize() === 0, c.trackerSize());
}

// ---- 5. other actors ---------------------------------------------------------------------------------------------------------
{
  const c = newClient();
  setCount(CLONE, FIREBOLT_SCROLL, 0);
  c.spellFire(CLONE, FIREBOLT_SCROLL, 1);
  c.platformCast(CLONE, FIREBOLT_SCROLL, 1);
  c.idle(1000);
  check('another player\'s copy: its fire is ignored and its cast is not ours to relay', c.casts().length === 0 && c.trackerSize() === 0);
}
{
  const c = newClient();
  setCount(NPC, ICESPIKE_SCROLL, 0);
  c.spellFire(NPC, ICESPIKE_SCROLL, 1);
  c.idle(1000);
  const casts = c.casts();
  check('a hosted NPC\'s last scroll: relayed once as the NPC', casts.length === 1 && casts[0].data.caster === REMOTE[NPC], casts);
}

// ---- 6. relaySpellCast's early exits hold for a fire ------------------------------------------------------------------------
{
  const c = newClient();
  setCount(PLAYER, FIREBOLT_SCROLL, 0);
  world.serverCasts.add(FIREBOLT_SCROLL);           // the server asked this client to cast it (castSelfService)
  c.spellFire(PLAYER, FIREBOLT_SCROLL, 1);
  c.idle(1000);
  check('a cast the server asked for (consumeServerCast) is not relayed from its fire', c.casts().length === 0 && !world.serverCasts.has(FIREBOLT_SCROLL));
}
{
  const c = newClient();
  setCount(PLAYER, BLOCKED_POWER, 0);
  c.spellFire(PLAYER, BLOCKED_POWER, 1);
  c.idle(100);
  check('a blocked racial power id is refused on the fire path too (dispelled, player told)', c.casts().length === 0 &&
    form(PLAYER).dispelled.includes(BLOCKED_POWER) && world.notifications.some((n) => /Racial powers are disabled/.test(n)));
}
{
  const c = newClient();
  setCount(PLAYER, FIREBOLT_SCROLL, 0);
  const actor = form(PLAYER);
  actor.getItemCount = () => { throw new Error('native gone'); };
  c.spellFire(PLAYER, FIREBOLT_SCROLL, 1);
  check('a throw in the fire handler is logged, never thrown into the platform', c.casts().length === 0 && world.errors.some((l) => /native gone/.test(l)));
}

// ---- 7. the tracker on its own ----------------------------------------------------------------------------------------------
{
  const t = { now: 0 };
  const tr = new ScrollFireTracker(() => t.now);
  check('tracker: a fire of a used-up scroll relays', tr.onFire(1, 2, true, 'a') === 'relay');
  check('tracker: a second fire of it is ignored', tr.onFire(1, 2, true, 'b') === 'ignore');
  check('tracker: one late platform cast is suppressed, a second passes', tr.onPlatformCast(1, 2) === false && tr.onPlatformCast(1, 2) === true);
  check('tracker: other casters and scrolls are separate keys', tr.onFire(3, 2, true, 'c') === 'relay' && tr.onFire(1, 4, true, 'd') === 'relay');
  t.now += SCROLL_SUPPRESS_MS + 1;
  check('tracker: everything expires', tr.takeDue(() => true).length === 0 && tr.size() === 0, tr.size());
  check('tracker: a platform cast then a fire within the pair window pair up', tr.onPlatformCast(1, 2) === true && tr.onFire(1, 2, true, 'e') === 'ignore');
  tr.onPlatformCast(1, 2);
  t.now += SCROLL_PAIR_MS + 1;
  check('tracker: ...but not after it', tr.onFire(1, 2, true, 'f') === 'relay');
  t.now += SCROLL_SUPPRESS_MS + 1;
  check('tracker: a waiting fire is due when its scroll is gone, once', tr.onFire(1, 2, false, 'g') === 'wait' &&
    tr.takeDue(() => false).length === 0 && JSON.stringify(tr.takeDue(() => true)) === '["g"]' && tr.takeDue(() => true).length === 0);
  t.now += SCROLL_SUPPRESS_MS + 1;
  tr.onFire(1, 2, false, 'h');
  check('tracker: a platform cast resolves a waiting fire', tr.onPlatformCast(1, 2) === true && tr.takeDue(() => true).length === 0);
  tr.onFire(1, 2, false, 'i');
  tr.onFire(1, 2, false, 'j');
  check('tracker: a newer fire replaces a waiting one', JSON.stringify(tr.takeDue(() => true)) === '["j"]');
  t.now += SCROLL_SUPPRESS_MS + 1;
  tr.onFire(1, 2, false, 'k');
  t.now += SCROLL_WAIT_MS + 1;
  check('tracker: a waiting fire expires unrelayed', tr.takeDue(() => true).length === 0 && tr.size() === 0);
  check('tracker: signed and unsigned ids are one key', tr.onFire(0xff000a01 | 0, 2, true, 'l') === 'relay' && tr.onFire(0xff000a01, 2, true, 'm') === 'ignore');
}

console.log(failures ? `\n${failures} FAILED, ${passes} passed` : `\nall ${passes} checks passed`);
process.exit(failures ? 1 : 0);
