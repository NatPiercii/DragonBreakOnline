// Scripted test for craftService.ts: the craft report bundled at a furniture is sent when an item arrives (as before), and
// one nothing arrived to close (a disenchant) is sent with no result once the Crafting Menu has been closed a moment or the
// player has left that furniture (C2, 0.3.77). Run from skymp5-client:
//
//   node tests/craftflush-harness.js [path to esbuild's package dir]
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const esbuildDir = [process.argv[2], path.resolve(__dirname, '../../skymp5-server/node_modules/esbuild'),
  path.join(os.homedir(), 'dragonbreak/fork/skymp5-server/node_modules/esbuild')].find((p) => p && fs.existsSync(p));
if (!esbuildDir) { console.log('SKIP craftflush (no esbuild)'); process.exit(0); }
const esbuild = require(esbuildDir);

let failures = 0;
const check = (name, ok, got) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`);
  if (!ok) failures++;
};

const STUBS = {
  skyrimPlatform: 'module.exports = {};',
  clientListener: 'class ClientListener {} module.exports = { ClientListener };',
  worldViewMisc: 'module.exports = { localIdToRemoteId: (id) => (id === 0xbad ? 0 : (id | 0xff000000) >>> 0) };',
  logging: 'module.exports = { logTrace() {}, logError: (...a) => globalThis.__craft.errors.push(a.join(" ")) };',
  messages: 'module.exports = { MsgType: { CraftItem: "CraftItem" } };',
};
const STUB_OF = { skyrimPlatform: 'skyrimPlatform', './clientListener': 'clientListener', '../../view/worldViewMisc': 'worldViewMisc',
  '../../logging': 'logging', '../../messages': 'messages' };

async function main() {
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'claude-nate-craftflush-'));
  const out = path.join(tmp, 'craftService.js');
  try {
    await esbuild.build({
      entryPoints: [path.resolve(__dirname, '../src/services/services/craftService.ts')], bundle: true, platform: 'node', format: 'cjs',
      outfile: out, logLevel: 'error',
      plugins: [{ name: 'stubs', setup(b) {
        b.onResolve({ filter: /.*/ }, (a) => (STUB_OF[a.path] ? { path: STUB_OF[a.path], namespace: 'stub' } : undefined));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ contents: STUBS[a.path], loader: 'js' }));
      } }],
    });
    run(require(out));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function run({ CraftService }) {
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    const make = () => {
      const handlers = {};
      const sent = [];
      const world = { seat: 0 };
      globalThis.__craft = { errors: [] };
      const player = { getFurnitureReference: () => (world.seat ? { getFormID: () => world.seat } : null) };
      const sp = { Game: { getPlayer: () => player } };
      const controller = { on: (name, fn) => { handlers[name] = fn; }, emitter: { emit: (name, m) => { if (name === 'sendMessage') sent.push(m.message); } } };
      new CraftService(sp, controller);
      const form = (id) => (id ? { getFormID: () => id } : undefined);
      const leave = (baseId, n = 1) => handlers.containerChanged({ oldContainer: form(0x14), newContainer: undefined, baseObj: form(baseId), numItems: n });
      const arrive = (baseId, n = 1) => handlers.containerChanged({ oldContainer: undefined, newContainer: form(0x14), baseObj: form(baseId), numItems: n });
      const tick = (ms) => { now += ms; handlers.update(); };
      const close = (name = 'Crafting Menu') => handlers.menuClose({ name });
      return { handlers, sent, world, leave, arrive, tick, close };
    };

    // ---- a craft closed by its result, unchanged -----------------------------------------------------------------
    {
      const t = make(); t.world.seat = 0x10a01;
      t.leave(0x5ace4, 2); t.arrive(0x1397e);
      check('a smithing craft is sent when its result arrives', t.sent.length === 1 && t.sent[0].data.resultObjectId === 0x1397e, t.sent);
      check('...with the inputs and the workbench', t.sent[0].data.workbench === (0xff010a01 >>> 0) && t.sent[0].data.craftInputObjects.entries[0].count === 2, t.sent[0]);
      t.close(); t.tick(1000);
      check('...and nothing more after the menu closes', t.sent.length === 1, t.sent.length);
    }
    // ---- a disenchant: the item goes, nothing comes back ---------------------------------------------------------
    {
      const t = make(); t.world.seat = 0x10b02;
      t.leave(0x13989);
      t.tick(1000);
      check('a disenchant is not sent while the menu is still open', t.sent.length === 0, t.sent.length);
      t.close(); t.tick(300);
      check('...nor in the first moment after the menu closes', t.sent.length === 0, t.sent.length);
      t.tick(300);
      check('...but once the menu has been closed half a second, with no result', t.sent.length === 1 && t.sent[0].data.resultObjectId === 0, t.sent);
      check('...naming the disenchanted item', t.sent[0].data.craftInputObjects.entries[0].baseId === 0x13989, t.sent[0]);
      t.tick(1000);
      check('...and only once', t.sent.length === 1, t.sent.length);
    }
    // ---- an item still on its way after the close closes the report the usual way --------------------------------
    {
      const t = make(); t.world.seat = 0x10c03;
      t.leave(0x5ace4); t.close(); t.tick(100); t.arrive(0x1397e); t.tick(1000);
      check('a result arriving just after the close is sent with its result, once', t.sent.length === 1 && t.sent[0].data.resultObjectId === 0x1397e, t.sent);
    }
    // ---- leaving the furniture without a menu close seen -----------------------------------------------------------
    {
      const t = make(); t.world.seat = 0x10d04;
      t.leave(0x13989); t.tick(1000);
      check('still seated with the menu open: nothing sent', t.sent.length === 0, t.sent.length);
      t.world.seat = 0; t.tick(300);
      check('leaving the furniture sends the leftover report with no result', t.sent.length === 1 && t.sent[0].data.resultObjectId === 0, t.sent);
      check('...for that furniture', t.sent[0].data.workbench === (0xff010d04 >>> 0), t.sent[0]);
    }
    // ---- other menus and empty streaks -----------------------------------------------------------------------------
    {
      const t = make(); t.world.seat = 0x10e05;
      t.leave(0x13989); t.close('InventoryMenu'); t.tick(1000);
      check('another menu closing sends nothing', t.sent.length === 0, t.sent.length);
      t.close(); t.tick(300); t.tick(300);
      check('the Crafting Menu closing does', t.sent.length === 1, t.sent.length);
    }
    {
      const t = make(); t.world.seat = 0;
      t.leave(0x13989); t.close(); t.tick(1000);
      check('an item leaving while seated nowhere is not bundled or sent', t.sent.length === 0, t.sent.length);
    }
    {
      const t = make(); t.world.seat = 0xbad;
      t.leave(0x13989); t.close(); t.tick(300); t.tick(300);
      check('a furniture with no remote id sends nothing and logs it', t.sent.length === 0 && globalThis.__craft.errors.length === 1, globalThis.__craft.errors);
      t.tick(1000);
      check('...and is not retried every update', globalThis.__craft.errors.length === 1, globalThis.__craft.errors.length);
    }
  } finally {
    Date.now = realNow;
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exitCode = failures ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exit(1); });
