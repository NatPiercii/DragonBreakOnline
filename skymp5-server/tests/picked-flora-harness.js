// Scripted test for picked flora (bug triage, 9 Oct: Nell farmed Harvesting XP at one plant on 7 Oct 19:14). masterySystem
// credited "activate" and rolled the bonus yield on every onActivate of a FLOR or TREE, picked or not, while the engine
// gives nothing from a plant until it regrows. It now asks ObjectReference.IsHarvested (a server-side read, registered in
// PapyrusObjectReference) first; onActivate runs before ProcessActivate marks the plant harvested, so the first pick
// still counts. Bundles masterySystem.ts with esbuild (settings and the espm scan stubbed) against a fake mp.
// Run it from skymp5-server with node_modules present:
//
//   node tests/picked-flora-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const esbuild = require(path.join(root, 'node_modules', 'esbuild'));
const out = fs.mkdtempSync(path.join(fs.existsSync('/dev/shm') ? '/dev/shm' : os.tmpdir(), 'claude-nate-pickedflora-'));
process.on('exit', () => { try { fs.rmSync(out, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });

let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

const stubs = {
  name: 'stubs',
  setup(b) {
    b.onResolve({ filter: /^(\.\.\/settings|\.\/espmEditorIds|\.\.\/scampNative)$/ }, (a) => ({ path: a.path, namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({
      contents: a.path === '../settings'
        ? 'module.exports = { Settings: { get: async () => ({ allSettings: {}, dataDir: ".", loadOrder: [] }) } };'
        : a.path === './espmEditorIds'
          ? 'module.exports = { isEditorId: (s) => !s.includes(":"), resolveEditorIds: async () => ({ resolved: new Map(), unresolved: [], scannedMs: 0 }) };'
          : 'module.exports = {};',
      loader: 'js',
    }));
  },
};

const PLANT_BASE = 0xf00, TREE_BASE = 0xf01, CHEST_BASE = 0xf02, NIRNROOT = 0x59b86;
const PLANT = 0x10001, TREE = 0x10002, CHEST = 0x10003, PLAYER = 0xff000100;
const u32 = (v) => { const a = new Uint8Array(4); new DataView(a.buffer).setUint32(0, v, true); return a; };

(async () => {
  await esbuild.build({ entryPoints: [path.join(root, 'ts', 'systems', 'masterySystem.ts')], bundle: true, platform: 'node', format: 'cjs',
    outfile: path.join(out, 'mastery.js'), logLevel: 'error', plugins: [stubs], external: ['*.node'] });
  process.chdir(out);
  fs.writeFileSync('skills.json', JSON.stringify({ pointSystem: { enabled: true }, skills: [{ id: 'harvesting', label: 'Harvesting', counts: { activateTypes: ['FLOR', 'TREE'] }, gates: {} }] }));
  fs.writeFileSync('gamemode-config.json', JSON.stringify({ mastery: {} }));

  const records = new Map([
    [PLANT_BASE, { type: 'FLOR', editorId: 'Nirnroot01', fields: [{ type: 'PFIG', data: u32(NIRNROOT) }] }],
    [TREE_BASE, { type: 'TREE', editorId: 'TreeReachTreeStump01', fields: [{ type: 'PFIG', data: u32(NIRNROOT) }] }],
    [CHEST_BASE, { type: 'CONT', editorId: 'TreasBanditChest', fields: [] }],
  ]);
  const forms = new Map([
    [PLANT, { baseDesc: 'f00:Skyrim.esm' }], [TREE, { baseDesc: 'f01:Skyrim.esm' }], [CHEST, { baseDesc: 'f02:Skyrim.esm' }],
    [PLAYER, { profileId: 1, inventory: { entries: [] }, 'private.mastery': { v: 2, skills: { harvesting: { level: 95, rank: 4, xp: 0, lock: 'raise', lastPointAt: 0, granted: [] } }, order: ['harvesting'] } }],
  ]);
  const harvested = new Set();
  const papyrus = [];
  const mp = {
    lookupEspmRecordById: (id) => (records.has(id) ? { record: records.get(id), toGlobalRecordId: (x) => x } : { record: null }),
    get: (id, prop) => { const f = forms.get(id); if (!f) throw new Error('no form'); return f[prop]; },
    set: (id, prop, v) => { forms.get(id)[prop] = v; },
    getIdFromDesc: (desc) => parseInt(String(desc).split(':')[0], 16) >>> 0,
    getDescFromId: (id) => (id >>> 0).toString(16),
    getUserByActor: () => 65535,
    sendCustomPacket: () => {},
    callPapyrusFunction: (kind, cls, fn, self, args) => {
      papyrus.push([kind, cls, fn, self && self.desc]);
      if (cls === 'ObjectReference' && fn === 'IsHarvested') return harvested.has(parseInt(self.desc, 16));
      return undefined;
    },
  };
  const { MasterySystem } = require(path.join(out, 'mastery.js'));
  const sys = new MasterySystem(() => {});
  await sys.initAsync({ svr: mp, gm: { on: () => {} } });
  const events = [];
  sys.enqueue = (kind, actorId, detail) => events.push({ kind, actorId, detail });
  const roots = () => (forms.get(PLAYER).inventory.entries.find((e) => e.baseId === NIRNROOT) || { count: 0 }).count;
  // The engine's side: a pick that went through marks the plant harvested, as ProcessActivate does after the hook
  const use = (ref) => { events.length = 0; const v = mp.onActivate(ref, PLAYER); if (v !== false && ref !== CHEST) harvested.add(ref); return v; };

  check('masterySystem hooks onActivate', typeof mp.onActivate === 'function');
  let v = use(PLANT);
  check('a fresh plant: the pick goes through and credits activate', v !== false && events.some((e) => e.kind === 'activate' && e.detail.refrId === PLANT), events);
  check('...and the Master Harvester\'s bonus yield lands (rank 4: chance 1, x2)', roots() === 1, roots());
  check('...the harvested state was read through ObjectReference.IsHarvested on the plant', papyrus.some((p) => p[0] === 'method' && p[1] === 'ObjectReference' && p[2] === 'IsHarvested' && p[3] === PLANT.toString(16)), papyrus);
  for (let i = 0; i < 5; i++) v = use(PLANT);
  check('the same plant, picked: no activate credit however often it is used', !events.some((e) => e.kind === 'activate'), events);
  check('...no bonus yield either (the farm was items as well as points)', roots() === 1, roots());
  check('...and the activation is not refused (the engine itself gives nothing)', v !== false);
  harvested.delete(PLANT);
  use(PLANT);
  check('regrown: it credits again', events.some((e) => e.kind === 'activate'));
  use(TREE); use(TREE);
  check('a picked TREE (a harvestable stump or shrub) is treated the same', !events.some((e) => e.kind === 'activate'), events);
  use(CHEST);
  check('anything but a plant still credits as before (no IsHarvested asked)', events.some((e) => e.kind === 'activate') && !papyrus.some((p) => p[3] === CHEST.toString(16)));
  mp.callPapyrusFunction = () => { throw new Error('not loaded'); };
  use(PLANT);
  check('a failed read keeps the old behaviour (credit), never an error', events.some((e) => e.kind === 'activate'));

  console.log(failures ? `${failures} FAILED` : 'all checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.log('FAIL', e && e.stack || e); process.exit(1); });
