// gatheringSystem.ts yields chopping and mining to the gameplay's labour.js (8 Oct: seated at a chopping block, a player
// was paid firewood every 5 s without the mini-game, unaudited). Bundles the system with esbuild (settings stubbed) and
// drives its activation hook and strikes on a fake mp. Run it from skymp5-server with node_modules present:
//
//   node tests/gathering-labour-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const esbuild = require(path.join(root, 'node_modules', 'esbuild'));
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-gathering-'));
const bundle = path.join(out, 'gathering.js');
let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

(async () => {
  await esbuild.build({
    entryPoints: [path.join(root, 'ts', 'systems', 'gatheringSystem.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'error',
    plugins: [{ name: 'stubs', setup(b) {
      b.onResolve({ filter: /^\.\.\/settings$/ }, (a) => ({ path: a.path, namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'module.exports = { Settings: { get: async () => ({}) } };', loader: 'js' }));
    } }],
  });
  const { GatheringSystem } = require(bundle);

  const A = 0xff00000d, BLOCK = 0xff000638, FIREWOOD = 0x6f993;
  const adds = [];
  const props = new Map([[`${A}|locationalData`, { cellOrWorldDesc: 'w', pos: [0, 0, 0] }], [`${BLOCK}|worldOrCellDesc`, 'w'], [`${BLOCK}|pos`, [10, 0, 0]]]);
  const mp = {
    get: (id, k) => props.get(`${id >>> 0}|${k}`),
    set: () => {},
    getDescFromId: (id) => (id >>> 0).toString(16),
    getUserByActor: () => 7,
    callPapyrusFunction: (kind, cls, fn, self, args) => { if (fn === 'AddItem') adds.push(args[1]); },
  };
  const ctx = { svr: mp };
  let now = 1_000_000;
  Date.now = () => now;

  const run = async (labour) => {
    if (labour) globalThis.__dboLabour = () => true; else delete globalThis.__dboLabour;
    const sys = new GatheringSystem(() => {});
    Object.assign(sys, {
      isPlayer: () => true, holdsTool: () => true, seatFree: () => true, userOf: () => 7,
      stationOf: () => ({ kind: 'chop', props: { resource: FIREWOOD, resourcecount: 1, maxresourceperactivation: 6 } }),
    });
    mp.onActivate = () => true;           // the gamemode's chain, letting the activation through
    sys.installHooks(ctx);
    adds.length = 0;
    const allowed = mp.onActivate(BLOCK, A);
    for (let i = 0; i < 3; i++) { now += 5001; await sys.updateAsync(ctx); }
    return { allowed, adds: adds.slice(), sessions: sys.sessions.size };
  };

  const without = await run(false);
  check('without labour, a seated player is paid firewood every strike (the old behaviour)', without.adds.length === 3 && without.sessions === 1, without);
  const withLabour = await run(true);
  check('with labour loaded, no chop session starts and nothing is paid', withLabour.adds.length === 0 && withLabour.sessions === 0, withLabour);
  check('...and the gamemode chain still decides the activation', withLabour.allowed === true, withLabour.allowed);

  fs.rmSync(out, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
