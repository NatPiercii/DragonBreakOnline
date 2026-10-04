// Scripted test for housingSystem.ts key cutting (#bugs 1556227454769565796, 4 Oct): every key cut for a property gets a
// name of its own, so two keys never stack in a pack and each can be told apart; every copy opens its own property only,
// and a revoke scraps them all. It bundles housingSystem.ts with esbuild and cuts keys on a fake mp. Run it from
// skymp5-server with node_modules present:
//
//   node tests/housing-key-copies-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const esbuild = require(path.join(root, 'node_modules', 'esbuild'));
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-housing-'));
const bundle = path.join(out, 'housing.js');

let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

(async () => {
  await esbuild.build({
    entryPoints: [path.join(root, 'ts', 'systems', 'housingSystem.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'error',
  });
  const { HousingSystem, KEY_BASE_ID } = require(bundle);
  const src = fs.readFileSync(bundle, 'utf8');
  const HP = (/HOUSING_PROP\s*=\s*"([^"]+)"/.exec(src) || [])[1];

  const NAMED = 0x100, UNNAMED = 0x200, OTHER = 0x300;
  const OWNER = 0xff000014, USER = 3;
  const props = new Map();
  const mp = {
    get: (id, key) => {
      if (key === 'profileId') return id === OWNER ? 11 : 0;
      const v = props.get(`${id >>> 0}:${key}`);
      return v === undefined ? undefined : JSON.parse(v);
    },
    set: (id, key, value) => props.set(`${id >>> 0}:${key}`, JSON.stringify(value)),
    getUserByActor: (id) => (id === OWNER ? USER : -1),
    getUserActor: (u) => (u === USER ? OWNER : 0),
    isConnected: () => false,
    sendCustomPacket: () => { },
  };
  const ctx = { svr: mp };
  const sys = new HousingSystem(() => { });
  sys.holdOf = () => null; sys.isAdmin = () => false; sys.holdRanks = () => []; sys.partnerOf = () => 0;
  sys.saveRegistry = () => { };
  sys.claimed = [NAMED, UNNAMED, OTHER];
  const record = (name) => ({ owner: 11, ownerName: 'Nat', name, locked: true, serial: 1, partner: 0, containers: [], issued: [] });
  mp.set(NAMED, HP, record('Elions Barrel'));
  mp.set(UNNAMED, HP, record(null));
  mp.set(OTHER, HP, record('Aldemars Barrel'));

  const recOf = (id) => sys.read(ctx, id);
  const cut = (id) => { sys.doCreateKey(ctx, USER, OWNER, id, recOf(id), true); return recOf(id).issued.slice(-1)[0]; };
  const opens = (id, keyName) => sys.hasAccessWith(ctx, id, recOf(id), { profileId: 12, admin: false, ranks: [], keys: new Set([keyName]) });
  const keysHeld = () => ((mp.get(OWNER, 'inventory') || {}).entries || []).filter((e) => (e.baseId >>> 0) === (KEY_BASE_ID >>> 0));

  const n1 = cut(NAMED), n2 = cut(NAMED), n3 = cut(NAMED);
  check('the first key keeps the plain name', n1 === 'Key to the Elions Barrel', n1);
  check('later keys are numbered', n2 === 'Key to the Elions Barrel No. 2' && n3 === 'Key to the Elions Barrel No. 3', [n2, n3]);
  check('every copy opens its property', opens(NAMED, n1) && opens(NAMED, n2) && opens(NAMED, n3));
  check('no copy opens another property', !opens(OTHER, n1) && !opens(OTHER, n2) && !opens(OTHER, n3));

  const u1 = cut(UNNAMED), u2 = cut(UNNAMED);
  check('an unnamed key keeps its credential at the end', u1 === 'Property Key (200)' && u2 === 'Property Key No. 2 (200)', [u1, u2]);
  check('both unnamed copies open it', opens(UNNAMED, u1) && opens(UNNAMED, u2));

  const held = keysHeld();
  check('five keys sit in the pack as five lines, none stacked', held.length === 5 && held.every((e) => e.count === 1), held);

  // A key cut before this change keeps opening, and the next cut steps past its name
  mp.set(OTHER, HP, Object.assign(record('Aldemars Barrel'), { issued: ['Key to the Aldemars Barrel'] }));
  check('an existing key still opens', opens(OTHER, 'Key to the Aldemars Barrel'));
  check('the next cut after an existing key is No. 2', cut(OTHER) === 'Key to the Aldemars Barrel No. 2', recOf(OTHER).issued);

  sys.doRevokeKeys(ctx, USER, NAMED, recOf(NAMED), true, false);
  check('a revoke scraps every copy', !opens(NAMED, n1) && !opens(NAMED, n2) && !opens(NAMED, n3));

  fs.rmSync(out, { recursive: true, force: true });
  console.log(failures ? `${failures} FAILED` : 'all checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
