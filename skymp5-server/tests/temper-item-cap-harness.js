// Scripted test for the per-item temper cap in craftedExtrasSystem.ts (smithing rework, 9 Oct): a temper report is held to
// min(claim, the smith's Wheel-rank cap, globalThis.__dboTemperCap(actor, item)), and a missing, throwing or non-number hook
// leaves today's cap. Bundles craftedExtrasSystem.ts with esbuild (settings stubbed) and sends tempering reports.
//   node tests/temper-item-cap-harness.js   (from skymp5-server, node_modules present)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = path.resolve(__dirname, '..');
const esbuild = require(path.join(root, 'node_modules', 'esbuild'));
const out = fs.mkdtempSync(path.join(fs.existsSync('/dev/shm') ? '/dev/shm' : os.tmpdir(), 'claude-nate-temper-'));
const bundle = path.join(out, 'crafted.js');
process.on('exit', () => { try { fs.rmSync(out, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });
let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

const u32s = (...xs) => { const b = new Uint8Array(4 * xs.length); const v = new DataView(b.buffer); xs.forEach((x, i) => v.setUint32(4 * i, x >>> 0, true)); return b; };
const cnto = (id, n) => { const b = new Uint8Array(8); const v = new DataView(b.buffer); v.setUint32(0, id, true); v.setInt32(4, n, true); return b; };
const records = new Map();
const rec = (id, type, editorId, fields) => records.set(id >>> 0, { record: { type, editorId, fields }, toGlobalRecordId: (x) => x >>> 0 });
const SWORD = 0x00012eb7, INGOT = 0x0005ace4, GRIND = 0x00088108, RECIPE = 0x000c4501, BENCH = 0x000bad0c, BENCH_BASE = 0x000bad0d;
rec(SWORD, 'WEAP', 'IronSword', []);
rec(INGOT, 'MISC', 'IngotIron', []);
rec(GRIND, 'KYWD', 'CraftingSmithingSharpeningWheel', []);
rec(RECIPE, 'COBJ', 'TemperWeaponIronSword', [{ type: 'CNAM', data: u32s(SWORD) }, { type: 'BNAM', data: u32s(GRIND) }, { type: 'CNTO', data: cnto(INGOT, 1) }]);
rec(BENCH_BASE, 'FURN', 'CraftingSmithingSharpeningWheel01', [{ type: 'WBDT', data: new Uint8Array([2, 0]) }, { type: 'KWDA', data: u32s(GRIND) }]);

(async () => {
  await esbuild.build({ entryPoints: [path.join(root, 'ts', 'systems', 'craftedExtrasSystem.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'error',
    plugins: [{ name: 'stubs', setup(b) {
      b.onResolve({ filter: /^\.\.\/settings$/ }, (a) => ({ path: a.path, namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'module.exports = { Settings: { get: async () => globalThis.__craftedSettings } };', loader: 'js' }));
    } }] });
  const { CraftedExtrasSystem } = require(bundle);
  const A = 0xff000014;
  const props = new Map(), sent = [];
  const mp = {
    get: (id, k) => props.get(`${id >>> 0}|${k}`), set: (id, k, v) => props.set(`${id >>> 0}|${k}`, v),
    getUserActor: (u) => (u === 1 ? A : 0), getActorPos: () => [0, 0, 0], getIdFromDesc: () => BENCH_BASE,
    lookupEspmRecordById: (id) => records.get(id >>> 0) || null,
    getEspmRecordIdsByType: (t) => [...records.entries()].filter(([, r]) => r.record.type === t).map(([id]) => id),
    sendCustomPacket: (u, p) => sent.push([u, JSON.parse(p)]),
  };
  props.set(`${BENCH}|worldOrCellDesc`, 'cell'); props.set(`${A}|worldOrCellDesc`, 'cell');
  props.set(`${BENCH}|pos`, [50, 0, 0]); props.set(`${BENCH}|baseDesc`, 'bench');
  props.set(`${A}|private.mastery`, { order: ['blacksmith'], skills: { blacksmith: { rank: 4 } } });   // Wheel cap 16
  globalThis.__craftedSettings = { allSettings: { craftedExtrasRankGates: true }, loadOrder: [] };
  const sys = new CraftedExtrasSystem(() => {});
  const ctx = { svr: mp, gm: { on() {}, emit() {} } };
  await sys.initAsync(ctx);
  let now = 1_000_000; Date.now = () => now;
  // One temper report: a plain sword and an iron ingot in, the client's copy at the claimed health
  const temper = (claim) => {
    props.set(`${A}|inventory`, { entries: [{ baseId: SWORD, count: 1 }, { baseId: INGOT, count: 1 }] });
    sent.length = 0; now += 5000;
    sys.customPacket(1, 'craftedExtras', { workbench: BENCH, gained: [{ baseId: SWORD, count: 1, health: claim }], lost: [{ baseId: SWORD, count: 1 }, { baseId: INGOT, count: 1 }] }, ctx);
    const s = props.get(`${A}|inventory`).entries.find((e) => e.baseId === SWORD);
    return s ? Math.round((s.health || 1) * 10) : null;
  };
  delete globalThis.__dboTemperCap;
  check('no hook: a Legendary claim by a rank-4 smith is held only by the Wheel cap (16)', temper(1.6) === 16, temper(1.6));
  globalThis.__dboTemperCap = (a, id) => (a === A && id === SWORD ? 12 : 16);
  check('the hook caps this item at Superior (12)', temper(1.6) === 12, temper(1.6));
  check('...a lower claim stands (Fine, 11)', temper(1.1) === 11, temper(1.1));
  globalThis.__dboTemperCap = () => 10;
  check('cap 10 (no improvement allowed): the temper is refused and the sword stays plain', temper(1.3) !== 13 && sent.some(([, p]) => p.customPacketType === 'craftedExtrasRefused'), temper(1.3));
  props.set(`${A}|private.mastery`, { order: ['blacksmith'], skills: { blacksmith: { rank: 0 } } });   // Wheel cap 11
  globalThis.__dboTemperCap = () => 16;
  check('the Wheel-rank cap stays the outer limit (rank 0: Fine, 11)', temper(1.6) === 11, temper(1.6));
  props.set(`${A}|private.mastery`, { order: ['blacksmith'], skills: { blacksmith: { rank: 4 } } });
  globalThis.__dboTemperCap = () => { throw new Error('boom'); };
  check('a throwing hook leaves today\'s cap', temper(1.6) === 16, temper(1.6));
  globalThis.__dboTemperCap = () => 'x';
  check('a non-number leaves today\'s cap', temper(1.6) === 16, temper(1.6));
  console.log(failures ? `${failures} FAILED` : 'all checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.log('FAIL', e && e.stack || e); process.exit(1); });
