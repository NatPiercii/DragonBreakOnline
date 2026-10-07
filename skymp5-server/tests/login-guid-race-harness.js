// Scripted test for the login guid race (7 Oct 2026): a login whose connection dropped during a slow network call must
// not bind its profile to, or send anything to, the player who took the recycled userId. It bundles login.ts and
// spawn.ts with esbuild (settings, metrics, fetch-retry, Discord ban roles and patron tiers stubbed), fakes the native
// server with a connection table (a guid per userId, every client on the relay ip, calls on a free slot throw as the
// native ones do), holds the master api, connection-check or Discord call open while the slot changes hands, then
// checks what reached the new occupant. Normal logins (happy path, not in the guild, bans, offline mode) are checked
// too. Run it from skymp5-server with node_modules present:
//
//   node tests/login-guid-race-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const root = path.resolve(__dirname, '..');
const esbuild = require(path.join(root, 'node_modules', 'esbuild'));
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-jake-loginrace-'));

const stubSources = {
  '../settings': 'module.exports = { Settings: { get: async () => globalThis.__race.settings } };',
  './metricsSystem': 'const c = { inc() {} }; module.exports = { loginsCounter: c, loginErrorsCounter: c };',
  'fetch-retry': 'module.exports = { __esModule: true, default: () => (...a) => globalThis.__race.fetch(...a) };',
  './discordBanSystem': 'module.exports = { hasDiscordBanRole: (g, roles) => roles.includes("BANROLE") };',
  './patronTiers': 'module.exports = { bindRolesToProfile: (r, p) => globalThis.__race.binds.push(p), extraSlotsFor: () => 0, isPriorityPatron: () => false, reservedSlots: () => 0 };',
  './hairCatalog': 'module.exports = { scanModHair: async () => ({ hairs: [] }) };',
  './charCreatorData': 'module.exports = { validateResult: () => ({ ok: false, error: "stub" }) };',
  './nameFilter': 'module.exports = { nameKey: (n) => String(n).toLowerCase() };',
  '../backendFactionApi': 'module.exports = { filterAccessForSlot: (a) => a };',
};
const stubFilter = new RegExp('^(' + Object.keys(stubSources).map((k) => k.replace(/[./-]/g, '\\$&')).join('|') + ')$');
const bundle = (entry, name) => esbuild.build({
  entryPoints: [path.join(root, 'ts', 'systems', entry)],
  bundle: true, platform: 'node', format: 'cjs', outfile: path.join(out, name), logLevel: 'error',
  plugins: [{
    name: 'stubs',
    setup(b) {
      b.onResolve({ filter: stubFilter }, (a) => ({ path: a.path, namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ contents: stubSources[a.path], loader: 'js' }));
    },
  }],
});

let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };
const section = (t) => console.log(`\n-- ${t}`);

// ---- the world: who holds each userId, what the master api and Discord answer ----
const RELAY_IP = '10.10.10.1';
const GUID_A = '1103382095568909368';   // the connection that started the login and dropped
const GUID_B = '999799163284473280';    // the next connection, handed the same userId
const SESSION_OLD = 'o'.repeat(64);     // profile 140
const SESSION_NEW = 'n'.repeat(64);     // profile 1
const ACTOR_140 = 0xff000140, ACTOR_1 = 0xff000001, ACTOR_7 = 0xff000007;
const ACTORS = { 140: [ACTOR_140], 1: [ACTOR_1], 7: [ACTOR_7], 12: [] };
const NAMES = { [ACTOR_140]: 'Profile140 Hero', [ACTOR_1]: 'Profile1 Hero', [ACTOR_7]: 'Profile7 Hero' };

const race = globalThis.__race = { settings: null, fetch: null, binds: [] };
let conns, packets, kicks, assigned, emitted, calls, errors, gates, world;

const need = (u) => {
  if (!conns.has(u)) throw new Error(`User with id ${u} doesn't exist`);
  return conns.get(u);
};
const svr = {
  isConnected: (u) => conns.has(u),
  getUserGuid: (u) => need(u),
  getUserIp: (u) => (need(u), RELAY_IP),
  sendCustomPacket: (u, p) => { const guid = need(u); const body = JSON.parse(p); packets.push({ u, guid, type: body.customPacketType, body }); },
  kick: (u) => { kicks.push({ u, guid: need(u) }); },
  getActorsByProfileId: (pid) => (ACTORS[pid] || []).slice(),
  getActorName: (a) => NAMES[a] || '',
  get: (a, prop) => (prop === 'private.charSlot' ? 0 : undefined),
  set: () => {},
  setEnabled: () => {},
  setUserActor: (u, a) => assigned.push({ u, guid: need(u), actor: a }),
  getUserActor: () => 0,
  lookupEspmRecordById: () => null,
  findFormsByPropertyValue: () => [],
};

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, statusText: String(status), json: async () => body });
race.fetch = async (url) => {
  const u = new URL(url);
  let route = 'other';
  if (u.pathname.endsWith('/connection-check')) route = 'connection-check';
  else if (/\/sessions\/[^/]+$/.test(u.pathname)) route = 'session';
  else if (u.hostname === 'discord.com' && u.pathname.includes('/members/')) route = 'discord-member';
  else if (u.hostname === 'discord.com') route = 'discord-post';
  calls.push(route);
  const gate = gates.get(route);
  if (gate) await gate.promise;
  if (route === 'session') {
    const s = world.sessions[decodeURIComponent(u.pathname.split('/').pop())];
    return s ? json(s.status, s.body) : json(404, {});
  }
  if (route === 'connection-check') return json(200, { allowed: world.connectionAllowed });
  if (route === 'discord-member') {
    const m = world.discord[u.pathname.split('/').pop()];
    return m ? json(m.status, { roles: m.roles }) : json(404, {});
  }
  if (route === 'discord-post') return json(200, {});
  return json(404, {});
};
const hold = (route) => { let release; const promise = new Promise((r) => { release = r; }); gates.set(route, { promise, release }); };
const release = (route) => { const g = gates.get(route); gates.delete(route); if (g) g.release(); };

const turn = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 30; i++) await turn(); await new Promise((r) => setTimeout(r, 5)); for (let i = 0; i < 30; i++) await turn(); };
const until = async (what, pred) => { for (let i = 0; i < 500; i++) { if (pred()) return; await turn(); } throw new Error(`harness: never reached ${what}`); };

const settingsWith = (discordAuth) => ({
  allSettings: { masterApiAuthToken: 't', characterSelect: true, adminProfileIds: [1] },
  discordAuth: discordAuth ? { botToken: 'bot', guilds: [{ guildId: 'G', eventLogChannelId: 'C' }] } : undefined,
  maxPlayers: 100,
  startPoints: [{ pos: [0, 0, 0], angleZ: 0, worldOrCell: '0x3c' }],
});

let Login, Spawn;
let ctx, systems;
const quiet = { log: console.log, error: console.error, warn: console.warn };
const mute = () => {
  const grab = (...a) => errors.push(a.map((x) => (x instanceof Error ? x.message : typeof x === 'string' ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })())).join(' '));
  console.log = () => {}; console.warn = () => {}; console.error = grab;
};
const unmute = () => { console.log = quiet.log; console.error = quiet.error; console.warn = quiet.warn; };

// A fresh server: a new event bus, Spawn then Login as index.ts orders them, empty slots and default answers
const fresh = async ({ discordAuth = true, offlineMode = false } = {}) => {
  conns = new Map(); packets = []; kicks = []; assigned = []; emitted = []; calls = []; errors = []; gates = new Map();
  race.binds = [];
  world = {
    sessions: {
      [SESSION_OLD]: { status: 200, body: { user: { id: 140, discordId: '140140' } } },
      [SESSION_NEW]: { status: 200, body: { user: { id: 1, discordId: '111111' } } },
    },
    connectionAllowed: true,
    discord: { '140140': { status: 200, roles: ['R140'] }, '111111': { status: 200, roles: ['R1'] } },
  };
  race.settings = settingsWith(discordAuth);
  delete svr.onUpdateAppearanceAttempt; delete svr.onUpdateEquipmentAttempt; delete svr._onSpawnAllowed;
  ctx = { svr, gm: new EventEmitter() };
  const spawn = new Spawn(() => {});
  const login = new Login(() => {}, 100, offlineMode ? null : 'http://master.test', 7777, 'KEY', offlineMode);
  await spawn.initAsync(ctx);
  await login.initAsync(ctx);
  // Recorded ahead of spawn's listener, which throws on a free slot and would hide the emit
  ctx.gm.prependListener('spawnAllowed', (...args) => emitted.push({ args, guidNow: conns.get(args[0]) }));
  systems = [spawn, login];
  return { spawn, login };
};
const connect = (u, guid) => { conns.set(u, guid); for (const s of systems) if (s.connect) s.connect(u, ctx); };
// index.ts runs every system's disconnect while the native slot still exists, then the slot is freed
const drop = (u) => { for (const s of systems) if (s.disconnect) s.disconnect(u, ctx); conns.delete(u); };
const packet = (u, type, content) => { for (const s of systems) if (s.customPacket) s.customPacket(u, type, content, ctx); };
const login = (u, session) => packet(u, 'loginWithSkympIo', { gameData: { session } });
const sentTo = (guid) => packets.filter((p) => p.guid === guid);
const kicksOf = (guid) => kicks.filter((k) => k.guid === guid);
const mismatchLines = () => errors.filter((l) => /Guid mismatch|changed guid/.test(l));
const brief = (ps) => ps.map((p) => p.type + (p.body.characters ? ':' + p.body.characters.filter(Boolean).map((c) => c.name).join('/') : ''));

// The stale login on userId 2 (guid A, profile 140) is held at `route`; the slot changes hands to guid B, then the call answers
async function raceCase(name, { route, discordAuth = true, before, emptySlot = false }) {
  await fresh({ discordAuth });
  if (before) before();
  mute();
  connect(2, GUID_A);
  hold(route);
  login(2, SESSION_OLD);
  await until(route, () => calls.includes(route));
  drop(2);
  if (!emptySlot) connect(2, GUID_B);
  release(route);
  await settle();
  unmute();
  const stale = emitted.filter((e) => e.args[1] === 140);
  check(`${name}: no spawnAllowed for the stale login`, stale.length === 0, stale.map((e) => ({ userId: e.args[0], profile: e.args[1], slotNowHeldBy: e.guidNow })));
  if (!emptySlot) {
    check(`${name}: nothing is sent to the new occupant`, sentTo(GUID_B).length === 0 && kicksOf(GUID_B).length === 0, { packets: brief(sentTo(GUID_B)), kicks: kicksOf(GUID_B).length });
  }
  check(`${name}: the stale profile's roles are not bound`, !race.binds.includes(140), race.binds);
  return { mismatch: mismatchLines(), errors: errors.slice() };
}

(async () => {
  await bundle('login.ts', 'login.js');
  await bundle('spawn.ts', 'spawn.js');
  ({ Login } = require(path.join(out, 'login.js')));
  ({ Spawn } = require(path.join(out, 'spawn.js')));

  // ---- the race: the slot changes hands while each network call of the login is in flight ----
  section('race: the userId changes hands after getUserProfile resolved');
  const r1 = await raceCase('held at checkConnectionAllowed, then allowed', { route: 'connection-check' });
  await raceCase('held at checkConnectionAllowed, then refused (ban)', { route: 'connection-check', before: () => { world.connectionAllowed = false; } });
  await raceCase('held at checkConnectionAllowed, Discord gate off', { route: 'connection-check', discordAuth: false });
  const r4 = await raceCase('held at the Discord member fetch, a member (7 Oct)', { route: 'discord-member' });
  await raceCase('held at the Discord member fetch, not in the guild', { route: 'discord-member', before: () => { delete world.discord['140140']; } });
  await raceCase('held at the Discord member fetch, ban role', { route: 'discord-member', before: () => { world.discord['140140'].roles = ['BANROLE']; } });
  await raceCase('held at the Discord member fetch, slot left empty', { route: 'discord-member', emptySlot: true });
  await raceCase('held at checkConnectionAllowed, Discord gate off, slot left empty', { route: 'connection-check', discordAuth: false, emptySlot: true });
  {
    // The slot was empty when the stale login landed; the next connection on it must not inherit that login
    mute();
    connect(2, GUID_B);
    packet(2, 'characterSelectResult', { action: 'play', slot: 0 });
    packet(2, 'characterSelectMenuRequest', {});
    unmute();
    check('...the next connection on that slot cannot enter or list the stale profile\'s characters', assigned.length === 0 && sentTo(GUID_B).length === 0, { assigned: assigned.map((a) => a.actor.toString(16)), packets: brief(sentTo(GUID_B)) });
  }
  check('the stale logins end on the guid check (checkConnectionAllowed)', r1.mismatch.some((l) => /after checkConnectionAllowed/.test(l)), r1.errors);
  check('the stale logins end on the guid check (Discord member fetch)', r4.mismatch.some((l) => /after discordAuth/.test(l)), r4.errors);

  section('race: the userId changes hands while getUserProfile is in flight');
  await raceCase('session lookup answers 404', { route: 'session', before: () => { world.sessions[SESSION_OLD] = { status: 404, body: {} }; } });
  await raceCase('session lookup answers 403 banned', { route: 'session', before: () => { world.sessions[SESSION_OLD] = { status: 403, body: { error: 'banned' } }; } });
  await raceCase('session lookup answers 403 serverLocked (kick)', { route: 'session', before: () => { world.sessions[SESSION_OLD] = { status: 403, body: { error: 'serverLocked' } }; } });
  await raceCase('session lookup answers 200', { route: 'session' });

  // ---- 7 Oct end to end: the new occupant then plays and logs in itself ----
  section('7 Oct end to end: stale login, then the new occupant acts and logs in');
  {
    await fresh();
    mute();
    connect(2, GUID_A);
    hold('discord-member');
    login(2, SESSION_OLD);
    await until('discord-member', () => calls.includes('discord-member'));
    drop(2);
    connect(2, GUID_B);
    release('discord-member');
    await settle();
    packet(2, 'characterSelectResult', { action: 'play', slot: 0 });
    packet(2, 'characterSelectMenuRequest', {});
    login(2, SESSION_NEW);
    await settle();
    unmute();
    const menus = sentTo(GUID_B).filter((p) => p.type === 'characterSelectMenu');
    const names = menus.flatMap((p) => p.body.characters.filter(Boolean).map((c) => c.name));
    check('the new occupant is never shown the stale profile\'s characters', !names.includes('Profile140 Hero'), names);
    check('the new occupant cannot enter the stale profile\'s character', !assigned.some((a) => a.actor === ACTOR_140), assigned.map((a) => ({ ...a, actor: a.actor.toString(16) })));
    check('the only spawnAllowed on the slot is the new occupant\'s own', emitted.every((e) => e.args[1] === 1), emitted.map((e) => [e.args[0], e.args[1], e.guidNow]));
    check('the new occupant\'s own login still works: spawnAllowed for profile 1 on its connection', emitted.some((e) => e.args[1] === 1 && e.guidNow === GUID_B), emitted.map((e) => [e.args[0], e.args[1], e.guidNow]));
    check('...and it is shown its own characters', menus.length >= 1 && names[names.length - 1] === 'Profile1 Hero', names);
  }

  // ---- spawn.ts drops a spawnAllowed whose guid is not the slot's current one ----
  section('spawn.ts: the spawnAllowed listener');
  {
    await fresh();
    mute();
    connect(2, GUID_B);
    svr._onSpawnAllowed(2, 140, ['R140'], '140140', {}, GUID_A);
    packet(2, 'characterSelectResult', { action: 'play', slot: 0 });
    packet(2, 'characterSelectResult', { action: 'delete', slot: 0 });
    packet(2, 'characterSelectMenuRequest', {});
    unmute();
    check('a spawnAllowed carrying another connection\'s guid sends nothing', sentTo(GUID_B).length === 0, brief(sentTo(GUID_B)));
    check('...and leaves no auth behind: select, delete and menu requests do nothing', assigned.length === 0, assigned.map((a) => a.actor.toString(16)));
  }
  {
    await fresh();
    mute();
    let threw = null;
    try { svr._onSpawnAllowed(9, 140, [], '140140', {}, GUID_A); } catch (e) { threw = e.message; }
    connect(9, 'G9');
    packet(9, 'characterSelectResult', { action: 'play', slot: 0 });
    unmute();
    check('a spawnAllowed for a slot that is now empty does not throw, and the next connection there inherits nothing', !threw && assigned.length === 0 && packets.length === 0, { threw, assigned: assigned.map((a) => a.actor.toString(16)), packets: brief(packets) });
  }
  {
    await fresh();
    mute();
    try { svr._onSpawnAllowed(10, 140, ['R140'], '140140', {}); } catch { /* the send to the free slot throws after the auth was stored */ }
    connect(10, 'G10');
    packet(10, 'characterSelectResult', { action: 'play', slot: 0 });
    packet(10, 'characterSelectMenuRequest', {});
    unmute();
    check('auth left on a free slot by an older caller is cleared when the next connection arrives', assigned.length === 0 && sentTo('G10').length === 0, { assigned: assigned.map((a) => a.actor.toString(16)), packets: brief(sentTo('G10')) });
  }
  {
    await fresh();
    connect(3, 'G3');
    svr._onSpawnAllowed(3, 1, ['R1'], '111111', {}, 'G3');
    check('a spawnAllowed with the current guid opens character select', brief(sentTo('G3')).join() === 'characterSelectMenu:Profile1 Hero', brief(sentTo('G3')));
    packet(3, 'characterSelectResult', { action: 'play', slot: 0 });
    check('...and the player enters its own character', assigned.length === 1 && assigned[0].actor === ACTOR_1 && assigned[0].guid === 'G3', assigned.map((a) => a.actor.toString(16)));
    connect(4, 'G4');
    svr._onSpawnAllowed(4, 7, [], undefined, undefined);
    check('a spawnAllowed with no guid (an older caller) still opens character select', brief(sentTo('G4')).join() === 'characterSelectMenu:Profile7 Hero', brief(sentTo('G4')));
  }

  // ---- normal logins are unchanged ----
  section('normal logins');
  {
    await fresh();
    mute();
    connect(5, 'G5');
    login(5, SESSION_NEW);
    await settle();
    unmute();
    const e = emitted[0];
    check('happy path: one spawnAllowed for profile 1 on userId 5', emitted.length === 1 && e.args[0] === 5 && e.args[1] === 1, emitted.map((x) => x.args));
    check('...with the Discord roles, discordId and access', e && JSON.stringify(e.args[2]) === '["R1"]' && e.args[3] === '111111' && e.args[4] && Array.isArray(e.args[4].permissions), e && e.args);
    check('...carrying the guid of the connection that logged in', e && e.args[5] === 'G5', e && e.args);
    check('...roles bound to profile 1', race.binds.join() === '1', race.binds);
    check('...character select opens with its characters', brief(sentTo('G5')).join() === 'characterSelectMenu:Profile1 Hero', brief(sentTo('G5')));
    check('...the login is posted to the Discord event log', calls.includes('discord-post'), calls);
    check('...no guid mismatch is logged', mismatchLines().length === 0, mismatchLines());
  }
  {
    await fresh({ discordAuth: false });
    mute();
    connect(5, 'G5');
    login(5, SESSION_NEW);
    await settle();
    unmute();
    check('happy path with the Discord gate off: spawnAllowed for profile 1', emitted.length === 1 && emitted[0].args[1] === 1, emitted.map((x) => x.args));
    check('...carrying the guid of the connection that logged in', emitted.length === 1 && emitted[0].args[5] === 'G5', emitted.map((x) => x.args));
    check('...and no Discord call', !calls.some((c) => c.startsWith('discord')), calls);
  }
  {
    await fresh();
    delete world.discord['111111'];
    mute();
    connect(5, 'G5');
    login(5, SESSION_NEW);
    await settle();
    unmute();
    check('not in the guild: refused with loginFailedNotInTheDiscordServer', brief(sentTo('G5')).join() === 'loginFailedNotInTheDiscordServer', brief(sentTo('G5')));
    check('...and no spawnAllowed', emitted.length === 0, emitted.map((x) => x.args));
  }
  {
    await fresh();
    world.connectionAllowed = false;
    mute();
    connect(5, 'G5');
    login(5, SESSION_NEW);
    await settle();
    unmute();
    check('banned by the backend connection-check: refused with loginFailedBanned', brief(sentTo('G5')).join() === 'loginFailedBanned', brief(sentTo('G5')));
    check('...no spawnAllowed and no Discord member call', emitted.length === 0 && !calls.includes('discord-member'), { emitted: emitted.length, calls });
  }
  {
    await fresh();
    world.discord['111111'].roles = ['R1', 'BANROLE'];
    mute();
    connect(5, 'G5');
    login(5, SESSION_NEW);
    await settle();
    unmute();
    check('a Discord ban role: refused with loginFailedBanned', brief(sentTo('G5')).join() === 'loginFailedBanned' && emitted.length === 0, { sent: brief(sentTo('G5')), emitted: emitted.length });
  }
  {
    await fresh();
    world.sessions[SESSION_NEW] = { status: 403, body: { error: 'banned' } };
    mute();
    connect(5, 'G5');
    login(5, SESSION_NEW);
    await settle();
    unmute();
    check('a master api ban (403 banned): refused with loginFailedBanned', brief(sentTo('G5')).join() === 'loginFailedBanned' && emitted.length === 0, { sent: brief(sentTo('G5')), emitted: emitted.length });
  }
  {
    await fresh();
    world.sessions[SESSION_NEW] = { status: 403, body: { error: 'serverLocked' } };
    mute();
    connect(5, 'G5');
    login(5, SESSION_NEW);
    await settle();
    unmute();
    check('a master api refusal (403 serverLocked): kicked with the reason', brief(sentTo('G5')).join() === 'kicked' && kicksOf('G5').length === 1 && /closed to players/.test(sentTo('G5')[0].body.reason), { sent: brief(sentTo('G5')), kicks: kicks.length });
  }
  {
    await fresh();
    world.sessions[SESSION_NEW] = { status: 404, body: {} };
    mute();
    connect(5, 'G5');
    login(5, SESSION_NEW);
    await settle();
    unmute();
    check('an unknown session: refused with loginFailedSessionNotFound', brief(sentTo('G5')).join() === 'loginFailedSessionNotFound' && emitted.length === 0, { sent: brief(sentTo('G5')), emitted: emitted.length });
  }
  {
    await fresh({ offlineMode: true });
    mute();
    connect(6, 'G6');
    packet(6, 'loginWithSkympIo', { gameData: { profileId: 7 } });
    connect(8, 'G8');
    packet(8, 'loginWithSkympIo', { gameData: { profileId: 1 } });
    await settle();
    unmute();
    check('offline mode: spawnAllowed by profile id', emitted.some((x) => x.args[0] === 6 && x.args[1] === 7), emitted.map((x) => x.args));
    check('...character select opens', brief(sentTo('G6')).join() === 'characterSelectMenu:Profile7 Hero', brief(sentTo('G6')));
    check('...an admin profile id from a non-loopback ip is still remapped', emitted.some((x) => x.args[0] === 8 && x.args[1] === 1008), emitted.map((x) => x.args));
    check('...and no network call is made', calls.length === 0, calls);
  }

  fs.rmSync(out, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { unmute(); console.log('FAIL the harness threw', e); fs.rmSync(out, { recursive: true, force: true }); process.exit(1); });
