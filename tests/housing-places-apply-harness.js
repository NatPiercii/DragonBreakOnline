// The place migration applied (fork housingSystem.ts applyPlaces; Nate's N3, 3 Oct), only with housingPlaceMigration
// "apply": every record it will touch is backed up first (and nothing is written if the backup fails); a house's root gets
// its place and the key names its members answered to; each member points at its root; an unlocked chest inside a house is
// marked owner-only; owners and locks stay as they are; a second run changes nothing. "dryrun" (the default) writes nothing.
//   node tests/housing-places-apply-harness.js <bundled housingSystem.js>
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const bundle = process.argv[2];
if (!bundle) { console.error('usage: node tests/housing-places-apply-harness.js <bundled housingSystem.js>'); process.exit(2); }
const { HousingSystem } = require(path.resolve(bundle));
if (typeof HousingSystem.prototype.applyPlaces !== 'function') { require('./expect')('housing-places-apply', 'this housingSystem has no place migration'); console.log('skipped: no place migration in this housingSystem'); process.exit(0); }
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${what}${!c && got !== undefined ? '   ' + JSON.stringify(got).slice(0, 600) : ''}`); if (!c) fails++; };
const H = (n) => (0x08000000 | n) >>> 0;
const WORLD = 'a764b:BSHeartland.esm', FORT = 'b5936:BSHeartland.esm';
const ROOT = H(0xb5c6e), PAIR = H(0xb5eac), CHEST = H(0xb5c86), BARREL = H(0x5c0d6);
const build = () => {
  const props = new Map(), cells = new Map(), writes = [];
  const rec = (owner, name, locked, partner, issued) => ({ owner, ownerName: 'Kojus Animus', name, locked, serial: 2, partner, containers: [], issued });
  const claim = (ref, cell, r, partnerCell) => { props.set(`${ref}:private.housing`, r); cells.set(ref, cell); if (r.partner) { cells.set(r.partner, partnerCell); props.set(`${r.partner}:private.housing`, { primary: ref }); } };
  claim(ROOT, FORT, rec(60, 'Fort Caractacus', true, H(0xb5fe6), ['Key to the Fort Caractacus (recut)']), WORLD);
  claim(PAIR, WORLD, rec(60, null, true, H(0xb5eae), []), FORT);
  claim(CHEST, FORT, rec(60, null, false, 0, []));
  claim(BARREL, WORLD, Object.assign(rec(51, 'Nerevii Barrel', false, 0, []), { ownerName: 'Nerevii' }));
  const descToId = (d) => { const [h, p] = String(d).split(':'); return (/bsheartland/i.test(p) ? 0x08000000 : 0) | parseInt(h, 16); };
  const mp = {
    get: (id, k) => (k === 'worldOrCellDesc' ? cells.get(id >>> 0) : (props.has(`${id >>> 0}:${k}`) ? JSON.parse(JSON.stringify(props.get(`${id >>> 0}:${k}`))) : undefined)),
    set: (id, k, v) => { writes.push([id >>> 0, k]); props.set(`${id >>> 0}:${k}`, JSON.parse(JSON.stringify(v))); },
    getIdFromDesc: descToId,
    lookupEspmRecordById: (id) => ({ record: { type: (id >>> 0) === descToId(WORLD) ? 'WRLD' : 'CELL' } }),
  };
  const logs = [];
  const sys = new HousingSystem((...a) => logs.push(a.join(' ')));
  sys.claimed = [ROOT, PAIR, CHEST, BARREL];
  sys.saveRegistry = () => {};
  return { sys, mp, props, writes, logs, get: (ref) => props.get(`${ref}:private.housing`) };
};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-placesapply-'));
const home = process.cwd();
process.chdir(dir);
try {
  // dryrun (the default): nothing written
  let w = build();
  w.sys.placeMigration = 'dryrun';
  w.sys.dryRunPlaces({ svr: w.mp });
  ok(w.writes.length === 0 && !fs.readdirSync(dir).some((f) => /backup/.test(f)), 'dryrun: no record written, no backup');

  // apply
  w = build();
  w.sys.placeMigration = 'apply';
  const before = JSON.stringify(w.get(ROOT));
  w.sys.dryRunPlaces({ svr: w.mp });
  const backups = fs.readdirSync(dir).filter((f) => /^housing-places-backup-.*\.json$/.test(f));
  ok(backups.length === 1, 'apply: one backup file', backups);
  const bfile = backups.length ? JSON.parse(fs.readFileSync(path.join(dir, backups[0]), 'utf8')) : {};
  const b = bfile.records || {};
  ok(bfile.version === 2 && Array.isArray(bfile.places) && bfile.places[0] && bfile.places[0].root === ROOT.toString(16) && bfile.places[0].owner === 60, '...a version 2 backup naming each place, its owner, members and entrances', bfile.places);
  ok(JSON.stringify(b[ROOT.toString(16)]) === before && b[PAIR.toString(16)] && b[CHEST.toString(16)] && !b[BARREL.toString(16)], '...holding the root and its members as they were, and nothing else', Object.keys(b));
  const root = w.get(ROOT), pair = w.get(PAIR), chest = w.get(CHEST), barrel = w.get(BARREL);
  ok(root.place && JSON.stringify(root.place.cells) === JSON.stringify([FORT]), 'the root gets its place', root.place);
  ok(Array.isArray(root.keyAliases) && root.keyAliases.includes('(80B5EAC-2)'), "...and the member doors' key credentials, so their keys keep working", root.keyAliases);
  ok(!root.keyAliases.includes('(80B5C86-2)'), "...but not the chest's: a chest key must not open the house (review F1)", root.keyAliases);
  ok(pair.memberOf === ROOT && chest.memberOf === ROOT, 'each member points at the root');
  ok(chest.ownerOnly === true && !pair.ownerOnly, 'the unlocked chest inside is marked owner-only, a door is not');
  ok(root.owner === 60 && pair.owner === 60 && chest.owner === 60 && root.locked === true && pair.locked === true && chest.locked === false, 'owners and locks stay as they were (the access rules come next)');
  ok(JSON.stringify(barrel) === JSON.stringify(build().get(BARREL)), "an outdoor chest claim (another owner's) is untouched");
  ok(w.logs.some((l) => /place migration: Kojus Animus \(60\) 80b5c6e "Fort Caractacus" applied: 2 member\(s\)/.test(l)) && w.logs.some((l) => /applied to 1 house\(s\); backup/.test(l)), 'the log says what was applied', w.logs.filter((l) => /migration/.test(l)));

  // a second boot changes nothing
  const n = w.writes.length;
  w.sys.dryRunPlaces({ svr: w.mp });
  ok(w.writes.length === n && w.logs.some((l) => /place migration: nothing to apply/.test(l)), 'a second run writes nothing');

  // a place built since (by a claim) under another root: the plan names a different door, and nothing is re-rooted
  w = build();
  w.sys.placeMigration = 'apply';
  const pr = w.get(PAIR); pr.place = { cells: [FORT], builtAt: 2 }; w.props.set(`${PAIR}:private.housing`, pr);
  const rr = w.get(ROOT); rr.memberOf = PAIR; w.props.set(`${ROOT}:private.housing`, rr);
  const ch = w.get(CHEST); ch.memberOf = PAIR; w.props.set(`${CHEST}:private.housing`, ch);
  w.writes.length = 0;
  w.sys.dryRunPlaces({ svr: w.mp });
  ok(!w.writes.some(([id]) => id === ROOT || id === PAIR || id === CHEST) && !w.get(ROOT).place && w.get(ROOT).memberOf === PAIR, 'a place already built under another door is left as it is (no second root)', w.logs.filter((l) => /migration/.test(l)));
  for (const f of fs.readdirSync(dir).filter((f) => /backup/.test(f))) fs.rmSync(path.join(dir, f));

  // a backup that cannot be written stops the migration
  w = build();
  w.sys.placeMigration = 'apply';
  const realWrite = fs.writeFileSync;
  fs.writeFileSync = (f, ...rest) => { if (/housing-places-backup-/.test(String(f))) throw new Error('disk full'); return realWrite(f, ...rest); };
  try { w.sys.dryRunPlaces({ svr: w.mp }); } finally { fs.writeFileSync = realWrite; }
  ok(!w.get(ROOT).place && !w.get(PAIR).memberOf && w.logs.some((l) => /NOT applied: the backup/.test(l)), 'no backup, no migration: nothing written', w.logs.slice(-1));
  // Staff (gamemode-config.json housingPlaces.staffProfiles, Nate 3 Oct): a staff owner's claims come through byte-identical
  w = build();
  const STAFF_HOUSE = H(0x62169), STAFF_CHEST = H(0x8b4c7), STAFF_OUT = H(0xb452a);
  const DAVIUS = '62131:BSHeartland.esm', CATHEDRAL = '12cb:BSHeartland.esm';
  const staffRec = (name, ownerName, locked, partner) => ({ owner: 4, ownerName, name, locked, serial: 1, partner, containers: [], issued: [] });
  const seed = [[STAFF_HOUSE, DAVIUS, staffRec('House of Davius Phink', 'Davius Phink', true, H(0x62162))], [STAFF_CHEST, CATHEDRAL, staffRec('Chest of Akatosh', 'Akatosh', true, 0)], [STAFF_OUT, WORLD, staffRec('Chest of Akatosh', 'Akatosh', false, 0)]];
  for (const [ref, cell, r] of seed) { w.props.set(`${ref}:private.housing`, JSON.parse(JSON.stringify(r))); w.sys.claimed.push(ref); }
  w.props.set(`${H(0x62162)}:private.housing`, { primary: STAFF_HOUSE });
  const cellsOf = { [STAFF_HOUSE]: DAVIUS, [STAFF_CHEST]: CATHEDRAL, [STAFF_OUT]: WORLD, [H(0x62162)]: WORLD };
  const getCell = w.mp.get;
  w.mp.get = (id, k) => (k === 'worldOrCellDesc' && cellsOf[id >>> 0] ? cellsOf[id >>> 0] : getCell(id, k));
  const before4 = seed.map(([ref]) => JSON.stringify(w.get(ref)));
  fs.writeFileSync('gamemode-config.json', JSON.stringify({ housingPlaces: { staffProfiles: [4] } }));
  for (const f of fs.readdirSync(dir).filter((f) => /backup/.test(f))) fs.rmSync(path.join(dir, f));
  w.sys.placeMigration = 'apply';
  w.writes.length = 0;
  w.sys.dryRunPlaces({ svr: w.mp });
  const after4 = seed.map(([ref]) => JSON.stringify(w.get(ref)));
  ok(JSON.stringify(before4) === JSON.stringify(after4) && !w.writes.some(([id]) => seed.some(([ref]) => ref === id)), "staff: profile 4's three claims, the Davius Phink name included, come through byte-identical", after4);
  const plan4 = JSON.parse(fs.readFileSync('housing-places-plan.json', 'utf8'));
  ok(!plan4.places.some((p) => p.owner === 4) && plan4.overCap.length === 0, '...they are no place and over no cap', plan4.overCap);
  ok(plan4.staffKept.length === 1 && plan4.staffKept[0].owner === 4 && plan4.staffKept[0].claims.length === 3 && /Davius Phink \/ Akatosh|Akatosh \/ Davius Phink/.test(plan4.staffKept[0].ownerName), '...and are listed as left as they are', plan4.staffKept);
  ok(w.logs.some((l) => /staff, left as they are: .*\(4\) 8062169, 808b4c7, 80b452a/.test(l)), '...under their own heading in the log', w.logs.filter((l) => /staff/.test(l)));
  const bk = fs.readdirSync(dir).filter((f) => /backup/.test(f));
  ok(bk.length === 1 && !Object.keys(JSON.parse(fs.readFileSync(path.join(dir, bk[0]), 'utf8')).records).some((k) => ['8062169', '808b4c7', '80b452a'].includes(k)), '...and are not even in the backup (nothing of theirs is touched)');
  fs.rmSync('gamemode-config.json');
} finally {
  process.chdir(home);
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
