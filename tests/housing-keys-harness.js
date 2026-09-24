// Does a rename keep a property's old keys working, and never hand them to another property?
//
//   node tests\housing-keys-harness.js <bundled housingSystem.js>
//   (bundle with: cd fork\skymp5-server && ./node_modules/.bin/esbuild ts/systems/housingSystem.ts \
//      --bundle --platform=node --format=cjs --outfile=<out>)
//
// Before 2026-09-24 a named key was matched by a name computed from the property's current label and
// its rank by ref id among properties sharing that label. Renaming the lower "X" away made the higher
// one rank 1, so the renamed property's old "Key to the X" opened the other door and locked out its own
// keyholders. Key names are now recorded on the property when cut (rec.issued).
'use strict';
const path = require('path');

const bundle = process.argv[2];
if (!bundle) { console.error('usage: node tests\\housing-keys-harness.js <bundled housingSystem.js>'); process.exit(2); }
const { HousingSystem } = require(path.resolve(bundle));

let fails = 0, checks = 0;
const ok = (label, cond, got) => { checks++; if (!cond) { fails++; console.log(`  FAIL ${label}${got !== undefined ? `: got ${JSON.stringify(got)}` : ''}`); } };

const PROP = 'private.dboHousing';
const A = 0x100, B = 0x200, C = 0x50;
const OWNER = 0xff000014, HOLDER = 0xff000020, USER = 3;
const KEY_BASE = 0xa;
const props = new Map();
const mp = {
  get: (id, key) => {
    if (key === 'profileId') return id === OWNER ? 11 : id === HOLDER ? 12 : 0;
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
// The world is stubbed: no zones, no admins, no teleport partners
sys.holdOf = () => null; sys.isAdmin = () => false; sys.holdRanks = () => []; sys.partnerOf = () => 0;
sys.saveRegistry = () => { };
sys.claimed = [A, B];

// Discover the property key and key base the bundle uses, from its own read()
const recOf = (id) => sys.read(ctx, id);
const legacy = (name) => ({ owner: 11, ownerName: 'Nat', name, locked: true, serial: 1, partner: 0, containers: [] });
const prop = /HOUSING_PROP\s*=\s*"([^"]+)"/.exec(require('fs').readFileSync(path.resolve(bundle), 'utf8'));
const HP = prop ? prop[1] : PROP;
mp.set(A, HP, legacy('X'));
mp.set(B, HP, legacy('X'));
const keyBase = /KEY_BASE_ID\s*=\s*(\d+|0x[0-9a-f]+)/i.exec(require('fs').readFileSync(path.resolve(bundle), 'utf8'));
const KB = keyBase ? Number(keyBase[1]) : KEY_BASE;
const holding = (name) => ({ profileId: 12, admin: false, ranks: [], keys: new Set([name]) });
const opens = (primary, keyName) => sys.hasAccessWith(ctx, primary, recOf(primary), holding(keyName));

// Legacy records: the old names still work before and after the migration
ok('legacy A answers "Key to the X"', opens(A, 'Key to the X'));
ok('legacy B answers "Key to the X, the second"', opens(B, 'Key to the X, the second'));
sys.migrateLegacyKeyNames(ctx);
ok('migration recorded A', JSON.stringify(recOf(A).issued) === '["Key to the X"]', recOf(A).issued);
ok('migration recorded B', JSON.stringify(recOf(B).issued) === '["Key to the X, the second"]', recOf(B).issued);

// The bug: rename A away from X
const rename = (id, name) => { const r = recOf(id); sys.doRename(ctx, USER, id, r, true, false, name); };
rename(A, 'Y');
ok('A still opens with its old key after the rename', opens(A, 'Key to the X'));
ok('A\'s old key does NOT open B', !opens(B, 'Key to the X'), true);
ok('B still opens with its own key', opens(B, 'Key to the X, the second'));

// New keys for A carry the new name; the old ones keep working beside them
const cut = (id) => { const r = recOf(id); sys.doCreateKey(ctx, USER, OWNER, id, r, true); return recOf(id).issued.slice(-1)[0]; };
ok('A cuts "Key to the Y"', cut(A) === 'Key to the Y', recOf(A).issued);
ok('A opens with both names', opens(A, 'Key to the Y') && opens(A, 'Key to the X'));

// A lower-id property named X later does not take either name already out there
sys.claimed.push(C);
mp.set(C, HP, { owner: 11, ownerName: 'Nat', name: 'X', locked: true, serial: 1, partner: 0, containers: [], issued: [] });
ok('C (lower id, also X) cuts the third name', cut(C) === 'Key to the X, the third', recOf(C).issued);
ok('C does not open with A\'s old key', !opens(C, 'Key to the X'));

// Revoking A's keys scraps every name it had issued
const r = recOf(A); sys.doRevokeKeys(ctx, USER, A, r, true, false);
ok('revoke clears A\'s names', recOf(A).issued.length === 0, recOf(A).issued);
ok('A\'s old named key no longer opens it', !opens(A, 'Key to the X') && !opens(A, 'Key to the Y'));
ok('A re-cut is marked recut', /recut/.test(cut(A)), recOf(A).issued);

// Unnamed keys still work by credential suffix
const tag = `(${B.toString(16).toUpperCase()})`;
ok('credential-suffix key opens B', opens(B, `Property Key ${tag}`));

console.log(`${checks - fails}/${checks} checks passed`);
process.exit(fails ? 1 : 0);
