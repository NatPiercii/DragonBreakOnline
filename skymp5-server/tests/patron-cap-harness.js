// Scripted test for the public player cap with patron places on top (Jake, 4 Oct 2026): maxPlayers (100) is the cap
// everyone sees and everyone may fill; patron-tiers.json reservedSlots more are opened in the native layer
// (scampNative.ts) and only priority patrons and staff may take them (spawn.ts admit). It bundles both files with
// esbuild, stubs the native addon and kickUtil, and runs in a temp folder holding a test patron-tiers.json.
// Run it from skymp5-server with node_modules present:
//
//   node tests/patron-cap-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const root = path.resolve(__dirname, '..');
const esbuild = require(path.join(root, 'node_modules', 'esbuild'));
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-patroncap-'));

let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

const kicked = [];
let nativeSettings = null;
const realLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req.endsWith('/scam_native.node')) {
    return { ScampServer: class { constructor(json) { nativeSettings = JSON.parse(json); } _setSelf() {} } };
  }
  return realLoad.call(this, req, ...rest);
};

const stubs = {
  name: 'stubs',
  setup(b) {
    b.onResolve({ filter: /^\.\/kickUtil$/ }, (a) => ({ path: 'kick', namespace: 'stub' }));
    b.onResolve({ filter: /^\.\/(hairCatalog|charCreatorData|nameFilter)$|^\.\.\/(settings|backendFactionApi)$/ }, (a) => ({ path: a.path, namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({
      contents: a.path === 'kick'
        ? 'module.exports = { kickWithReason: (mp, u, r) => globalThis.__kicked.push(u) };'
        : 'module.exports = new Proxy({}, { get: () => () => ({}) });',
      loader: 'js',
    }));
  },
};

(async () => {
  globalThis.__kicked = kicked;
  for (const [name, entry] of [['native', 'scampNative.ts'], ['spawn', 'systems/spawn.ts']]) {
    await esbuild.build({ entryPoints: [path.join(root, 'ts', entry)], bundle: true, platform: 'node', format: 'cjs',
      outfile: path.join(out, name + '.js'), logLevel: 'error', plugins: [stubs], external: ['*.node'] });
  }
  const cwd = process.cwd();
  process.chdir(out);
  const PRIORITY = '111', STAFF = '222', PLAIN = '333';
  const writeTiers = (reservedSlots) => fs.writeFileSync(path.join(out, 'patron-tiers.json'), JSON.stringify({
    tiers: [{ id: 'grandchampion', roleId: PRIORITY, extraSlots: 4, priority: true }, { id: 'traveler', roleId: PLAIN, extraSlots: 1 }],
    bonuses: [], reservedSlots,
  }));
  writeTiers(20);

  const { createScampServer } = require(path.join(out, 'native.js'));
  createScampServer({ maxPlayers: 100, port: 7777, name: 'x' });
  check('native layer opens 100 + 20 reserved', nativeSettings.maxPlayers === 120, nativeSettings.maxPlayers);
  createScampServer({ maxPlayers: 990, port: 7777 });
  check('native cap stays within the 1000 the C++ allows', nativeSettings.maxPlayers === 1000, nativeSettings.maxPlayers);

  const { Spawn } = require(path.join(out, 'spawn.js'));
  const s = new Spawn(() => {});
  let online = 0;
  const mp = { isConnected: (u) => { if (u < online) return true; throw new Error('free'); } };
  s.settingsObject = { maxPlayers: 100, allSettings: { adminRoleIds: [STAFF] } };
  const ctx = { svr: mp };
  const admit = (userId, roles) => s.admit(ctx, userId, roles);

  online = 99; check('a regular player takes place 100', admit(500, []) === true);
  online = 100; check('a regular player is refused at 100 online', admit(500, [PLAIN]) === false);
  check('the refused player is kicked', kicked.includes(500), kicked);
  check('a Grand Champion gets in at 100 online', admit(501, [PRIORITY]) === true);
  check('staff get in at 100 online', admit(502, [STAFF]) === true);
  online = 119; check('a Grand Champion gets in at 119 online (native layer ends at 120)', admit(503, [PRIORITY]) === true);

  writeTiers(0);
  await new Promise((r) => setTimeout(r, 20));
  fs.utimesSync(path.join(out, 'patron-tiers.json'), new Date(), new Date(Date.now() + 5000));
  createScampServer({ maxPlayers: 100, port: 7777 });
  check('with no reserve the native cap is the public cap', nativeSettings.maxPlayers === 100, nativeSettings.maxPlayers);

  process.chdir(cwd);
  fs.rmSync(out, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
