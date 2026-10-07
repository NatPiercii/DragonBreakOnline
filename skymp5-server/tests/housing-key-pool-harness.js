// Scripted test for one key record per lock (houseKeys.ts with housingSystem.ts; krizzlepop #fac-0093, 7 Oct: keys to the
// fort and the house "all kinda stack in my inventory so i cant give a house key to anyone"). With house-keys.json listing
// KEYM records, each lock's keys are cut on a record of its own, copies of one lock share it, a used-up pool falls back to
// the vanilla key, names still decide access, a revoke still scraps them, and keys cut on the vanilla key move to their
// lock's record at login. Without the file nothing changes. Bundles both files with esbuild on a fake mp.
//
//   node tests/housing-key-pool-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const esbuild = require(path.join(root, 'node_modules', 'esbuild'));
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-keypool-'));
let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

(async () => {
  for (const [name, entry] of [['housing', 'housingSystem.ts'], ['keys', 'houseKeys.ts']]) {
    await esbuild.build({ entryPoints: [path.join(root, 'ts', 'systems', entry)], bundle: true, platform: 'node', format: 'cjs', outfile: path.join(out, name + '.js'), logLevel: 'error' });
  }
  const { HousingSystem, KEY_BASE_ID } = require(path.join(out, 'housing.js'));
  const K = require(path.join(out, 'keys.js'));
  const src = fs.readFileSync(path.join(out, 'housing.js'), 'utf8');
  const HP = (/HOUSING_PROP\s*=\s*"([^"]+)"/.exec(src) || [])[1];

  // The pure allocator
  check('allocateKeyBase keeps a lock\'s own pool record', K.allocateKeyBase(0x2002, new Set([0x2001]), [0x2001, 0x2002]) === 0x2002);
  check('...gives the first free one to a lock without', K.allocateKeyBase(undefined, new Set([0x2001]), [0x2001, 0x2002]) === 0x2002);
  check('...and the vanilla key when all are taken or the pool is empty', K.allocateKeyBase(undefined, new Set([0x2001]), [0x2001]) === 0xdb0e2 && K.allocateKeyBase(undefined, new Set(), []) === 0xdb0e2);

  const P1 = 0x0a001001, P2 = 0x0a001002, P3 = 0x0a001003, MISC = 0x0a001004;
  const RECS = { [P1]: 'KEYM', [P2]: 'KEYM', [P3]: 'KEYM', [MISC]: 'MISC' };
  const NAMED = 0x100, OTHER = 0x300, THIRD = 0x400, FOURTH = 0x500;
  const OWNER = 0xff000014, USER = 3;
  const props = new Map();
  const mp = {
    get: (id, key) => { if (key === 'profileId') return id === OWNER ? 11 : 0; const v = props.get(`${id >>> 0}:${key}`); return v === undefined ? undefined : JSON.parse(v); },
    set: (id, key, value) => props.set(`${id >>> 0}:${key}`, JSON.stringify(value)),
    getUserByActor: (id) => (id === OWNER ? USER : -1),
    getUserActor: (u) => (u === USER ? OWNER : 0),
    isConnected: (u) => u === USER,
    sendCustomPacket: () => { },
    getIdFromDesc: (d) => parseInt(String(d).split(':')[0], 16) >>> 0,
    lookupEspmRecordById: (id) => (RECS[id] ? { record: { type: RECS[id] } } : null),
  };
  const ctx = { svr: mp };
  const sys = new HousingSystem(() => { });
  sys.holdOf = () => null; sys.isAdmin = () => false; sys.holdRanks = () => []; sys.partnerOf = () => 0; sys.saveRegistry = () => { };
  sys.claimed = [NAMED, OTHER, THIRD, FOURTH];
  const record = (name) => ({ owner: 11, ownerName: 'Nat', name, locked: true, serial: 1, partner: 0, containers: [], issued: [] });
  for (const [id, n] of [[NAMED, 'Fort'], [OTHER, 'House'], [THIRD, 'Shop'], [FOURTH, 'Barn']]) mp.set(id, HP, record(n));
  const recOf = (id) => sys.read(ctx, id);
  const cut = (id) => { sys.doCreateKey(ctx, USER, OWNER, id, recOf(id), true); return recOf(id).issued.slice(-1)[0]; };
  const keys = () => ((mp.get(OWNER, 'inventory') || {}).entries || []).filter((e) => K.isPropertyKeyBase(e.baseId));
  const baseOf = (name) => (keys().find((e) => e.name === name) || {}).baseId;

  const cwd = process.cwd(); process.chdir(out);
  const before = cut(NAMED);
  check('without house-keys.json a key is cut on the vanilla key, as before', baseOf(before) === KEY_BASE_ID, baseOf(before));

  fs.writeFileSync('house-keys.json', JSON.stringify({ pool: [`${P1.toString(16)}:DragonBreak Online Edits.esp`, `${MISC.toString(16)}:DragonBreak Online Edits.esp`, `${P2.toString(16)}:DragonBreak Online Edits.esp`, `${P3.toString(16)}:DragonBreak Online Edits.esp`, 'nonsense'] }));
  check('the pool keeps KEYM records only, in file order', JSON.stringify(K.refreshKeyPool(mp)) === JSON.stringify([P1, P2, P3]), K.refreshKeyPool(mp));

  const h1 = cut(OTHER), h2 = cut(OTHER), s1 = cut(THIRD);
  check('a lock\'s first key takes a pool record of its own', baseOf(h1) === P2 || baseOf(h1) === P1, baseOf(h1));
  check('copies of one lock share its record', baseOf(h2) === baseOf(h1));
  check('another lock\'s key is on another record', baseOf(s1) !== baseOf(h1) && K.keyPool().includes(baseOf(s1)), [baseOf(s1), baseOf(h1)]);
  check('the record is kept on the lock', recOf(OTHER).keyBase === baseOf(h1) && recOf(THIRD).keyBase === baseOf(s1));

  // Login: the Fort key cut on the vanilla key moves to the Fort's own record; a key no lock knows stays
  const inv = mp.get(OWNER, 'inventory');
  inv.entries.push({ baseId: KEY_BASE_ID, count: 1, name: 'Key to a burned house (DEAD)' });
  mp.set(OWNER, 'inventory', inv);
  sys.migrateKeys(ctx, OWNER);
  check('at login a vanilla-record key moves to its lock\'s own record', K.keyPool().includes(baseOf(before)) && recOf(NAMED).keyBase === baseOf(before), baseOf(before));
  check('a key no lock answers to is left alone', baseOf('Key to a burned house (DEAD)') === KEY_BASE_ID);
  const used = new Set([recOf(NAMED).keyBase, recOf(OTHER).keyBase, recOf(THIRD).keyBase]);
  check('three locks hold three different records', used.size === 3 && [...used].every((b) => K.keyPool().includes(b)), [...used]);
  const again = JSON.stringify(mp.get(OWNER, 'inventory'));
  sys.migrateKeys(ctx, OWNER);
  check('a second login changes nothing', JSON.stringify(mp.get(OWNER, 'inventory')) === again);

  const b1 = cut(FOURTH);
  check('a used-up pool falls back to the vanilla key', baseOf(b1) === KEY_BASE_ID && recOf(FOURTH).keyBase === undefined, baseOf(b1));

  const access = sys.viewerAccess(ctx, OWNER);
  check('pool keys are read as keys for access', [h1, h2, s1, before].every((n) => access.keys.has(n)), [...access.keys]);
  const opens = (id, name) => sys.hasAccessWith(ctx, id, recOf(id), { profileId: 12, admin: false, ranks: [], keys: new Set([name]) });
  check('each key opens its own lock and no other', opens(OTHER, h1) && opens(THIRD, s1) && !opens(OTHER, s1) && !opens(THIRD, h1));

  sys.doRevokeKeys(ctx, USER, OTHER, recOf(OTHER), true, false);
  check('a revoke takes the lock\'s pool keys out of the pack', !keys().some((e) => e.name === h1 || e.name === h2) && keys().some((e) => e.name === s1), keys().map((e) => e.name));
  check('...and the lock keeps its record', recOf(OTHER).keyBase === [...used].find((b) => b === recOf(OTHER).keyBase));
  process.chdir(cwd);

  fs.rmSync(out, { recursive: true, force: true });
  console.log(failures ? `${failures} FAILED` : 'all checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
