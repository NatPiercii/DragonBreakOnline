// inventory.ts: a souled gem the player already holds is left alone by the 5 s server apply (Barush #C9TM, 10 Oct: the
// lesser soul gem notice came and went forever). InventoryApi.cpp reads ExtraSoul through GetType(), so the held gem's
// soul comes back as 0x9C (ExtraDataType::kSoul), never the server's level. Run from skymp5-client:
//
//   node tests/soulgem-apply-harness.js [path to esbuild's package dir]
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const esbuildDir = [process.argv[2], path.resolve(__dirname, '../../skymp5-server/node_modules/esbuild'),
  path.join(os.homedir(), 'dragonbreak/fork/skymp5-server/node_modules/esbuild')].find((p) => p && fs.existsSync(p));
if (!esbuildDir) { console.log('SKIP soulgem-apply (no esbuild)'); process.exit(0); }
const esbuild = require(esbuildDir);

let failures = 0;
const check = (name, ok, got) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`);
  if (!ok) failures++;
};

const LESSER_GEM = 0x2e4e4, PETTY_GEM = 0x2e4e2, IRON_SWORD = 0x12eb7, K_SOUL = 0x9c;

// A fake game: one player whose container changes are what the engine holds; addItemEx lands at once
const PLATFORM = `
const g = globalThis.__soul;
class Form { constructor(id) { this.id = id; } getFormID() { return this.id; } getType() { return g.types[this.id] || 52; }
  getName() { return g.names[this.id] || 'Item'; } isPlayable() { return true; } }
class ObjectReference extends Form { getBaseObject() { return new Form(7); } removeAllItems() {} getItemCount() { return 0; }
  removeItem() {} }
class Actor extends ObjectReference { static from(r) { return r instanceof Actor ? r : null; } isEquipped() { return false; } }
const nil = { from: () => null };
module.exports = {
  Form, ObjectReference, Actor, Ammo: nil, Weapon: nil, Enchantment: nil, Potion: nil,
  FormType: { Misc: 32, Potion: 46, Ingredient: 30, Weapon: 41, SoulGem: 52 },
  Game: { getFormEx: (id) => new Form(id), getPlayer: () => g.player },
  storage: {},
  printConsole() {},
  once() {},
  createEnchantment: undefined,
  getContainer: () => [],
  getExtraContainerChanges: () => g.held.map((h) => ({ baseId: h.baseId, countDelta: h.count,
    extendDataList: h.extras ? [h.extras] : [] })),
  TESModPlatform: {
    resetContainer() {}, pushWornState() {},
    addItemEx(refr, item, countDelta, health, ench, maxCharge, rmOnUnequip, charge, name, soul) {
      g.calls.push({ baseId: item.getFormID(), countDelta, soul });
      // PapyrusTESModPlatform.cpp writes an ExtraSoul only for 1..5; InventoryApi.cpp then reads it back as g.readSoul
      const extras = [{ type: 'TextDisplayData', name }];
      if (soul > 0 && soul <= 5) extras.push({ type: 'Soul', soul: g.readSoul(soul) });
      if (countDelta > 0) g.held.push({ baseId: item.getFormID(), count: countDelta, extras });
      else {
        const i = g.held.findIndex((h) => h.baseId === item.getFormID());
        if (i >= 0 && (g.held[i].count += countDelta) <= 0) g.held.splice(i, 1);
      }
    },
  },
};`;
const STUBS = {
  skyrimPlatform: PLATFORM,
  appearance: 'module.exports = { baseIsPlayers: () => false };',
  niNodeQueue: 'module.exports = { queueCopyNiNodeUpdate() {}, queuePlayerNiNodeUpdate() {} };',
};
const STUB_OF = { skyrimPlatform: 'skyrimPlatform', './appearance': 'appearance', '../view/niNodeQueue': 'niNodeQueue' };

async function main() {
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'claude-nate-soulgem-'));
  const out = path.join(tmp, 'inventory.js');
  try {
    await esbuild.build({
      entryPoints: [path.resolve(__dirname, '../src/sync/inventory.ts')], bundle: true, platform: 'node', format: 'cjs',
      outfile: out, logLevel: 'error',
      plugins: [{ name: 'stubs', setup(b) {
        b.onResolve({ filter: /.*/ }, (a) => (STUB_OF[a.path] ? { path: STUB_OF[a.path], namespace: 'stub' } : undefined));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ contents: STUBS[a.path], loader: 'js' }));
      } }],
    });
    globalThis.__soul = { held: [], calls: [], names: { [LESSER_GEM]: 'Lesser Soul Gem' }, types: { [IRON_SWORD]: 41 } };
    run(require(out));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function run({ applyInventory, getDiff, getInventory, soulsMatch }) {
  const g = globalThis.__soul;
  const refr = { getFormID: () => 0x14, getBaseObject: () => ({ getFormID: () => 7 }), removeAllItems() {}, getItemCount: () => 0,
    removeItem() {} };
  const server = { entries: [{ baseId: LESSER_GEM, count: 1, soul: 1 }] };
  const reset = (readSoul, held = []) => { g.held = held.map((h) => ({ ...h })); g.calls = []; g.readSoul = readSoul; };
  const apply = () => { g.calls = []; applyInventory(refr, server, false, true); return g.calls; };

  // The live platform: every held soul reads as 0x9C
  reset(() => K_SOUL);
  const first = apply();
  check('the first apply adds the souled gem once', first.length === 1 && first[0].countDelta === 1 && first[0].soul === 1, first);
  check('the platform reads the held gem\'s soul as the kSoul type id', getInventory(refr).entries[0].soul === K_SOUL,
    getInventory(refr).entries);
  const second = apply();
  check('a second apply leaves the gem alone (no remove, no add, no notice)', second.length === 0, second);
  const third = apply();
  check('...and every apply after it', third.length === 0, third);
  check('the server-vs-local diff is empty', getDiff(server, getInventory(refr), true, 'apply').entries.length === 0,
    getDiff(server, getInventory(refr), true, 'apply').entries);
  check('...in exact mode too (craft and drop reports see no change)',
    getDiff(server, getInventory(refr), true, 'exact').entries.length === 0);

  // A platform that reads the real level (GetContainedSoul) still matches by level
  reset((s) => s);
  apply();
  check('a platform that reads the level: second apply changes nothing', apply().length === 0, g.calls);

  // An empty held gem is not a souled one
  reset(() => K_SOUL, [{ baseId: LESSER_GEM, count: 1 }]);
  const fromEmpty = apply();
  check('an empty held gem is swapped for the server\'s souled one', fromEmpty.length === 2 &&
    fromEmpty.some((c) => c.countDelta === -1) && fromEmpty.some((c) => c.countDelta === 1 && c.soul === 1), fromEmpty);
  check('...then left alone', apply().length === 0, g.calls);

  // The server emptying the gem (a soul used) takes the souled copy and gives back an empty one
  const emptyServer = { entries: [{ baseId: LESSER_GEM, count: 1 }] };
  g.calls = []; applyInventory(refr, emptyServer, false, true);
  check('a soul the server spent swaps the souled gem for an empty one', g.calls.length === 2, g.calls);

  // Two souled gems and a plain sword: counts still drive the diff
  reset(() => K_SOUL);
  server.entries = [{ baseId: LESSER_GEM, count: 2, soul: 1 }, { baseId: PETTY_GEM, count: 1, soul: 1 }, { baseId: IRON_SWORD, count: 1 }];
  apply();
  check('three entries applied, then nothing on the next pass', apply().length === 0, g.calls);
  server.entries[0].count = 1;
  const used = apply();
  check('one souled gem fewer on the server removes exactly one', used.length === 1 && used[0].countDelta === -1 &&
    used[0].baseId === LESSER_GEM, used);

  check('soulsMatch: equal levels', soulsMatch(1, 1) && soulsMatch(undefined, 0));
  check('soulsMatch: an unreadable level matches any soul', soulsMatch(1, K_SOUL) && soulsMatch(K_SOUL, 5));
  check('soulsMatch: never an empty gem', !soulsMatch(0, K_SOUL) && !soulsMatch(K_SOUL, undefined) && !soulsMatch(0, 1));
  check('soulsMatch: two readable levels must agree', !soulsMatch(1, 2));

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
