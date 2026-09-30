// Scripted test for the login checks in login.ts (2026-09-30): the session must be a plain token, a master api
// profile without a discordId is refused while discordAuth is on, one login attempt per connection, and the logged
// gameData is cut short. It bundles login.ts with esbuild (settings, metrics, fetch-retry and the kick helper stubbed),
// fakes the master api and Discord with a recording fetch, and drives customPacket. Run it from skymp5-server with
// node_modules present:
//
//   node tests/login-hardening-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const esbuild = require(path.join(root, 'node_modules', 'esbuild'));
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-login-'));
const bundle = path.join(out, 'login.js');

const stubs = {
  '../settings': 'module.exports = { Settings: { get: async () => globalThis.__loginSettings } };',
  './metricsSystem': 'const c = { inc() {} }; module.exports = { loginsCounter: c, loginErrorsCounter: c };',
  'fetch-retry': 'module.exports = { __esModule: true, default: () => (...a) => globalThis.__loginFetch(...a) };',
  './kickUtil': 'module.exports = { kickWithReason: (mp, userId, reason) => globalThis.__loginKicks.push([userId, reason]) };',
  './discordBanSystem': 'module.exports = { hasDiscordBanRole: (g, roles) => roles.includes("ban") };',
};
const built = esbuild.build({
  entryPoints: [path.join(root, 'ts', 'systems', 'login.ts')],
  bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'error',
  plugins: [{
    name: 'stubs',
    setup(b) {
      b.onResolve({ filter: /^(\.\.\/settings|\.\/metricsSystem|fetch-retry|\.\/kickUtil|\.\/discordBanSystem)$/ }, (a) => ({ path: a.path, namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ contents: stubs[a.path], loader: 'js' }));
    },
  }],
});
let Login;

let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };
const tick = () => new Promise((r) => setTimeout(r, 20));

// ---- a fake master api and Discord ----
const SESSION = 'a'.repeat(64);
const calls = [];
globalThis.__loginKicks = [];
globalThis.__loginFetch = async (url, opts) => {
  calls.push([opts && opts.method || 'GET', url]);
  const u = new URL(url);
  const json = (status, body) => ({ ok: status < 300, status, statusText: String(status), json: async () => body });
  if (u.pathname.endsWith('/connection-check')) return json(200, { allowed: true });
  // The two master routes that answer with a user, the way express matches them (a segment never holds a slash)
  let m = u.pathname.match(/^\/api\/servers\/KEY\/sessions\/([^/]+)\/balance$/);
  if (m) return decodeURIComponent(m[1]) === SESSION ? json(200, { user: { id: 7, balance: 0 } }) : json(404, {});
  m = u.pathname.match(/^\/api\/servers\/KEY\/sessions\/([^/]+)$/);
  if (m) return decodeURIComponent(m[1]) === SESSION ? json(200, { user: { id: 7, discordId: '555' } }) : json(404, {});
  if (u.hostname === 'discord.com' && u.pathname.includes('/members/')) return json(404, {});   // not in the guild
  if (u.hostname === 'discord.com') return json(200, {});
  return json(404, {});
};
globalThis.__loginSettings = {
  allSettings: { masterApiAuthToken: 't' },
  discordAuth: { botToken: 'bot', guilds: [{ guildId: 'G', eventLogChannelId: 'C' }] },
};

const logs = [];
const sent = [];
const emitted = [];
const svr = {
  getUserIp: () => '203.0.113.9',
  getUserGuid: () => 'guid',
  isConnected: () => true,
  sendCustomPacket: (u, p) => sent.push([u, JSON.parse(p).customPacketType]),
  getActorsByProfileId: () => [],
};
const gm = { emit: (...a) => emitted.push(a[0]) };
const ctx = { svr, gm };
const quiet = { log: console.log, error: console.error };

(async () => {
  await built;
  ({ Login } = require(bundle));
  const login = new Login((...a) => logs.push(a.join(' ')), 100, 'http://master.test', 7777, 'KEY', false);
  await login.initAsync(ctx);
  console.log = () => {}; console.error = () => {};
  const run = async (userId, gameData) => { login.customPacket(userId, 'loginWithSkympIo', { gameData }, ctx); await tick(); };
  const done = () => { console.log = quiet.log; console.error = quiet.error; };

  // ---- a session that is more than one path segment ----
  await run(1, { session: `${SESSION}/balance` });
  done();
  check('a session with a slash is refused before any request is made', calls.length === 0, calls);
  check('...and the client is told the session was not found', sent.some(([u, t]) => u === 1 && t === 'loginFailedSessionNotFound'), sent);
  check('...and it never reaches spawnAllowed', !emitted.includes('spawnAllowed'), emitted);
  console.log = () => {}; console.error = () => {};

  for (const bad of ['../../x', `${SESSION}?x=1`, `${SESSION}#x`, 'short', 'x'.repeat(300), 12345, { toString: 1 }, ['a']]) {
    calls.length = 0; sent.length = 0;
    login.disconnect(2); login.connect(2);
    await run(2, { session: bad });
    if (calls.length) { done(); check(`a malformed session makes no request: ${String(typeof bad === 'object' ? JSON.stringify(bad) : bad).slice(0, 30)}`, false, calls); console.log = () => {}; }
  }
  done();
  check('traversal, query, fragment, too short, too long and non-string sessions all make no request', true);
  console.log = () => {}; console.error = () => {};

  // ---- a profile without a Discord id is refused while discordAuth is on ----
  const noDiscord = new Login(() => {}, 100, 'http://master.test', 7777, 'KEY', false);
  await noDiscord.initAsync(ctx);
  const realFetch = globalThis.__loginFetch;
  globalThis.__loginFetch = async (url, opts) => {
    if (/\/sessions\/[^/]+$/.test(new URL(url).pathname)) { calls.push(['GET', url]); return { ok: true, status: 200, json: async () => ({ user: { id: 7, balance: 0 } }) }; }
    return realFetch(url, opts);
  };
  calls.length = 0; sent.length = 0; emitted.length = 0;
  noDiscord.customPacket(3, 'loginWithSkympIo', { gameData: { session: SESSION } }, ctx); await tick();
  globalThis.__loginFetch = realFetch;
  done();
  check('a master api profile with no discordId is refused while discordAuth is on', !emitted.includes('spawnAllowed'), emitted);
  check('...as not in the Discord server', sent.some(([u, t]) => u === 3 && t === 'loginFailedNotInTheDiscordServer'), sent);
  check('...before any Discord call is made', !calls.some(([, u]) => u.includes('discord.com')), calls);
  console.log = () => {}; console.error = () => {};

  // ---- the session goes into the URL encoded ----
  calls.length = 0;
  const l2 = new Login(() => {}, 100, 'http://master.test', 7777, 'KEY', false);
  await l2.initAsync(ctx);
  l2.customPacket(4, 'loginWithSkympIo', { gameData: { session: SESSION } }, ctx); await tick();
  done();
  check('a well-formed session reaches the session route', calls.some(([, u]) => u === `http://master.test/api/servers/KEY/sessions/${SESSION}`), calls);
  check('...then the Discord membership check runs', calls.some(([, u]) => u.includes('/guilds/G/members/555')), calls);
  check('...and a non-member is refused', sent.some(([u, t]) => u === 4 && t === 'loginFailedNotInTheDiscordServer'), sent);
  console.log = () => {}; console.error = () => {};

  // ---- one attempt per connection ----
  calls.length = 0;
  for (let i = 0; i < 50; i++) l2.customPacket(4, 'loginWithSkympIo', { gameData: { session: SESSION } }, ctx);
  await tick();
  done();
  check('50 more login packets on the same connection make no request at all', calls.length === 0, calls.length);
  console.log = () => {}; console.error = () => {};
  l2.disconnect(4); l2.connect(4);
  calls.length = 0;
  l2.customPacket(4, 'loginWithSkympIo', { gameData: { session: SESSION } }, ctx); await tick();
  done();
  check('a new connection on the reused slot gets its attempt', calls.length > 0, calls.length);
  calls.length = 0;
  l2.customPacket(5, 'loginWithSkympIo', { gameData: { session: SESSION } }, ctx); await tick();
  check('the guard is per connection: another slot logs in normally', calls.length > 0, calls.length);
  check('other packet types are left alone', (() => { l2.customPacket(6, 'somethingElse', {}, ctx); l2.customPacket(6, 'loginWithSkympIo', { gameData: { session: SESSION } }, ctx); return true; })());

  // ---- the logs are cut ----
  const logs3 = [];
  const l3 = new Login((...a) => logs3.push(a.join(' ')), 100, 'http://master.test', 7777, 'KEY', false);
  await l3.initAsync(ctx);
  logs3.length = 0;
  l3.customPacket(8, 'loginWithSkympIo', { gameData: { nothing: 'y'.repeat(100000) } }, ctx);
  check('a huge gameData with no credentials is logged cut short', logs3.length === 1 && logs3[0].length < 400, logs3.map((l) => l.length));
  l3.customPacket(9, 'loginWithSkympIo', { gameData: { session: 'x\n[fake] line'.padEnd(40, 'z') } }, ctx);
  check('a refused session is logged on one line', logs3.every((l) => !l.includes('\n')), logs3[logs3.length - 1]);

  // ---- offline mode keeps working ----
  const off = new Login(() => {}, 100, null, 7777, 'KEY', true);
  await off.initAsync(ctx);
  emitted.length = 0;
  off.customPacket(10, 'loginWithSkympIo', { gameData: { profileId: 12 } }, ctx);
  check('offline mode still logs in by profile id', emitted.includes('spawnAllowed'), emitted);

  // ---- the session never reaches a log whole (review follow-up) ----
  {
    const lines = [];
    const grab = (...a) => lines.push(a.map((x) => (typeof x === 'string' ? x : (() => { try { return JSON.stringify(x); } catch (e) { return String(x); } })())).join(' '));
    const TOKEN = 'b'.repeat(64);
    const saved = { log: console.log, error: console.error };
    console.log = grab; console.error = grab;
    const l4 = new Login(grab, 100, 'http://master.test', 7777, 'KEY', false);
    await l4.initAsync(ctx);
    l4.customPacket(11, 'loginWithSkympIo', { gameData: { session: TOKEN } }, ctx); await tick();        // not found: the error line
    l4.customPacket(12, 'loginWithSkympIo', { gameData: { session: `${TOKEN}/balance` } }, ctx); await tick(); // not a token
    l4.customPacket(13, 'loginWithSkympIo', { gameData: { session: `${TOKEN}\n[fake]` } }, ctx); await tick();
    console.log = saved.log; console.error = saved.error;
    const all = lines.join('\n');
    check('a failed login\'s error line still names the attempt', /Error logging in client:/.test(all), lines.filter((l) => /Error logging/.test(l)));
    check('...but no log line carries the whole session', !all.includes(TOKEN) && !all.includes('b'.repeat(7)), lines.filter((l) => l.includes('bbbbbbb')));
    check('...only its first 6 characters and its length', /bbbbbb\.\.\. \(64 chars\)/.test(all) && /bbbbbb\.\.\. \(72 chars\)/.test(all), lines.filter((l) => /chars\)/.test(l)));
  }

  // ---- the balance system encodes the session in its URLs ----
  {
    const urls = [];
    await esbuild.build({
      entryPoints: [path.join(root, 'ts', 'systems', 'masterApiBalanceSystem.ts')],
      bundle: true, platform: 'node', format: 'cjs', outfile: path.join(out, 'balance.js'), logLevel: 'error',
      plugins: [{
        name: 'stubs',
        setup(b) {
          b.onResolve({ filter: /^(axios|\.\.\/settings)$/ }, (a) => ({ path: a.path, namespace: 'stub' }));
          b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ loader: 'js', contents: a.path === 'axios'
            ? 'module.exports = { __esModule: true, default: { get: async (u) => { globalThis.__balanceUrls.push(u); return { data: { user: { id: 1, balance: 5 } } }; }, post: async (u) => { globalThis.__balanceUrls.push(u); return { data: { balanceSpent: 1, success: true } }; } } };'
            : 'module.exports = { Settings: { get: async () => ({ allSettings: { masterApiAuthToken: "t" } }) } };' }));
        },
      }],
    });
    globalThis.__balanceUrls = urls;
    const { MasterApiBalanceSystem } = require(path.join(out, 'balance.js'));
    const bal = new MasterApiBalanceSystem(() => {}, 10, 'http://master.test', 7777, 'KEY', false);
    await bal['getUserBalanceImpl']('a/b?c');
    await bal['makeUserMasterApiPurchaseImpl']('a/b?c', 1);
    check('the balance and purchase URLs carry the session as one encoded segment', urls[0] === 'http://master.test/api/servers/KEY/sessions/a%2Fb%3Fc/balance' && urls[1] === 'http://master.test/api/servers/KEY/sessions/a%2Fb%3Fc/purchase', urls);
  }

  fs.rmSync(out, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.log = quiet.log; console.log('FAIL the harness threw', e); process.exit(1); });
