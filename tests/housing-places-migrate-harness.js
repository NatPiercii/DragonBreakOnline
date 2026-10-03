// The place migration against a world with real cells (fork housingSystem.ts refinePlaces / applyPlaces / restorePlaces;
// the L2 review's F1, F2, S2, S3, S4): a house's cells follow placeCellsFrom (a neighbouring building with its own street
// door is left out, and the owner's claims there stay their own); an interior two owners' houses open onto is nobody's
// place and both are listed, not applied; the plan names the unclaimed chests that become owner-only, the inner doors and
// the entrances that join; a chest key is no alias of the house; apply waits for every claim to be readable and, on the
// last try, applies nothing; the backup holds every record apply writes, the joined entrances and both halves of each
// pair included; housingPlaceRestore puts it back once, and is refused with apply on.
//   node tests/housing-places-migrate-harness.js <bundled housingSystem.js>
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const bundle = process.argv[2];
if (!bundle) { console.error('usage: node tests/housing-places-migrate-harness.js <bundled housingSystem.js>'); process.exit(2); }
const { HousingSystem } = require(path.resolve(bundle));
if (typeof HousingSystem.prototype.refinePlaces !== 'function') { require('./expect')('housing-places-migrate', 'this housingSystem has no refined migration'); console.log('skipped: no refined migration in this housingSystem'); process.exit(0); }
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${what}${!c && got !== undefined ? '   ' + JSON.stringify(got).slice(0, 700) : ''}`); if (!c) fails++; };
const H = (n) => (0x08000000 | n) >>> 0;
const hx = (n) => (n >>> 0).toString(16);
const WORLD = 'a764b:BSHeartland.esm', HOUSE = '67652:BSHeartland.esm', SHOP = '67660:BSHeartland.esm', SHARED = '67670:BSHeartland.esm';
const REFS = [];
const ref = (id, cell, type, partner) => { REFS.push({ id: H(id), cell, type, partner: partner ? H(partner) : 0 }); return H(id); };
// Augustine's house: front door (claimed), a back door nobody claimed, a strongbox she claimed, two loose chests, an inner door
const E1 = ref(0x100, WORLD, 'DOOR', 0x101), I1 = ref(0x101, HOUSE, 'DOOR', 0x100);
const E2 = ref(0x102, WORLD, 'DOOR', 0x103), I2 = ref(0x103, HOUSE, 'DOOR', 0x102);
const BOX = ref(0x110, HOUSE, 'CONT'), LOOSE1 = ref(0x111, HOUSE, 'CONT'), LOOSE2 = ref(0x112, HOUSE, 'CONT'), INNER = ref(0x113, HOUSE, 'DOOR');
// ...and a claimed door from her house into the shop next door, which has its own street door; her chest in the shop
const S1 = ref(0x120, HOUSE, 'DOOR', 0x121), S2 = ref(0x121, SHOP, 'DOOR', 0x120), SW1 = ref(0x122, SHOP, 'DOOR', 0x123), SW2 = ref(0x123, WORLD, 'DOOR', 0x122);
const SHOPBOX = ref(0x124, SHOP, 'CONT');
// Two owners each hold a street door into one interior
const A1 = ref(0x200, WORLD, 'DOOR', 0x201), A2 = ref(0x201, SHARED, 'DOOR', 0x200), B1 = ref(0x202, WORLD, 'DOOR', 0x203), B2 = ref(0x203, SHARED, 'DOOR', 0x202);
const SHAREDBOX = ref(0x204, SHARED, 'CONT');
const byId = new Map(REFS.map((r) => [r.id, r]));
let props, logs, unreadableIds = new Set();
const descToId = (d) => parseInt(String(d).split(':')[0], 16) | 0x08000000;
const mp = {
  get: (id, k) => {
    id = id >>> 0;
    if (k === 'worldOrCellDesc') return byId.get(id) ? byId.get(id).cell : undefined;
    if (k === 'inventory') return { entries: [] };
    if (k === 'profileId') return 0;
    if (k === 'private.housing' && unreadableIds.has(id)) return undefined;
    const v = props.get(`${id}:${k}`); return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  },
  set: (id, k, v) => props.set(`${id >>> 0}:${k}`, JSON.parse(JSON.stringify(v))),
  getNeighborsByPosition: (cell) => REFS.filter((r) => r.cell === cell).map((r) => r.id),
  getIdFromDesc: descToId,
  lookupEspmRecordById: (id) => ({ record: { type: (id >>> 0) === descToId(WORLD) ? 'WRLD' : 'CELL', fields: [] } }),
  getUserByActor: () => -1, getUserActor: () => 0, isConnected: () => false, sendCustomPacket: () => {},
};
const ctx = { svr: mp };
const base = (o) => Object.assign({ owner: 2, ownerName: 'Augustine', name: null, locked: false, serial: 2, partner: 0, containers: [], issued: [] }, o);
const put = (r, rec) => { props.set(`${r}:private.housing`, rec); if (rec.partner) props.set(`${rec.partner}:private.housing`, { primary: r }); };
const build = (mode) => {
  props = new Map(); logs = []; unreadableIds = new Set();
  put(E1, base({ name: 'Valerio Residence', locked: true, partner: I1, issued: ['Key to the Valerio Residence'] }));
  put(BOX, base({ issued: ['Key to the Strongbox'] }));
  put(S1, base({ partner: S2, issued: ['Key to the Shop Door'] }));
  put(SHOPBOX, base({}));
  put(A1, base({ owner: 5, ownerName: 'Aldemar', partner: A2 }));
  put(B1, base({ owner: 6, ownerName: 'Elion', partner: B2 }));
  const sys = new HousingSystem((...a) => logs.push(a.join(' ')));
  sys.placeMigration = mode;
  sys.saveRegistry = () => {};
  sys.baseTypeOf = (c, id) => (byId.get(id >>> 0) ? byId.get(id >>> 0).type : '');
  sys.partnerOf = (c, id) => (byId.get(id >>> 0) ? byId.get(id >>> 0).partner : 0);
  sys.holdOf = () => null; sys.holdRanks = () => []; sys.isAdmin = () => false;
  sys.claimed = [E1, BOX, S1, SHOPBOX, A1, B1];
  return sys;
};
const rec = (r) => props.get(`${r}:private.housing`);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-placesmigrate-'));
const home = process.cwd();
process.chdir(dir);
const plan = () => JSON.parse(fs.readFileSync('housing-places-plan.json', 'utf8'));
const backups = () => fs.readdirSync(dir).filter((f) => /^housing-places-backup-.*\.json$/.test(f));
// Each scenario starts with no backup or marker left from the one before (two applies in one millisecond share a name)
const clean = () => { for (const f of fs.readdirSync(dir)) if (/^housing-places-backup-/.test(f)) fs.rmSync(path.join(dir, f)); };
try {
  fs.writeFileSync('tenancy.json', JSON.stringify({ listings: { [hx(S1)]: { door: hx(S1) } }, owed: [] }));
  // dryrun: the refined plan, nothing written
  let sys = build('dryrun');
  const before = JSON.stringify([...props]);
  ok(sys.dryRunPlaces(ctx) === true && JSON.stringify([...props]) === before, 'dryrun: the plan is written, no record changes');
  let p = plan();
  const d = (root) => p.details.find((x) => x.root === root);
  ok(d(E1) && JSON.stringify(d(E1).cells) === JSON.stringify([HOUSE]), "Augustine's house: its own interior, not the shop next door (it has its own street door)", d(E1));
  ok(d(E1).members.includes(BOX) && d(E1).members.includes(S1) && d(E1).outside.includes(SHOPBOX) && d(E1).skippedCells.some((c) => c.cell === SHOP), '...the door into the shop and her strongbox are members; her chest in the shop stays a claim of its own; the shop is listed as left out', d(E1));
  ok(JSON.stringify(d(E1).entrances) === JSON.stringify([E2]), '...the unclaimed back door is listed as joining', d(E1).entrances);
  ok(JSON.stringify(d(E1).unclaimedChests.sort()) === JSON.stringify([LOOSE1, LOOSE2].sort()) && d(E1).innerDoors.includes(INNER), '...the two unclaimed chests that become owner-only and the inner door are listed (review S4)', d(E1));
  ok(d(A1) && d(B1) && /shared with another owner/.test(d(A1).notApplied) && /shared with another owner/.test(d(B1).notApplied) && d(A1).cells.length === 0 && d(B1).cells.length === 0, 'two owners\' street doors into one interior: neither gets it, both are listed as not applied (review F2)', [d(A1), d(B1)]);
  ok(logs.some((l) => /unclaimed chests becoming owner-only=2/.test(l)) && logs.some((l) => /NOT APPLIED: its interior is shared/.test(l)), '...and the log says so');
  ok(p.tenancyListingsOnMembers.length === 1 && p.tenancyListingsOnMembers[0].door === hx(S1), "the tenancy listing at a door that becomes a member is flagged for Nate", p.tenancyListingsOnMembers);

  // apply on a partial read: wait, and on the last try apply nothing
  sys = build('apply');
  unreadableIds.add(BOX);
  const before2 = JSON.stringify([...props]);
  ok(sys.dryRunPlaces(ctx, false) === false && JSON.stringify([...props]) === before2, 'apply with a claim still unreadable: not done yet, nothing written (review S2)');
  ok(sys.dryRunPlaces(ctx, true) === true && JSON.stringify([...props]) === before2 && backups().length === 0 && logs.some((l) => /NOT applied: 1 of 6 claims are still unreadable/.test(l)), '...on the last try: the plan is written, nothing applied, no backup', logs.slice(-2));
  ok(plan().unreadable.includes(hx(BOX)), '...the plan names the unreadable claim');

  // apply
  sys = build('apply');
  const was = {}; for (const r of [E1, I1, E2, I2, BOX, S1, S2]) was[hx(r)] = props.has(`${r}:private.housing`) ? JSON.parse(JSON.stringify(rec(r))) : null;
  sys.dryRunPlaces(ctx, false);
  ok(rec(E1).place && JSON.stringify(rec(E1).place.cells) === JSON.stringify([HOUSE]) && rec(BOX).memberOf === E1 && rec(S1).memberOf === E1 && !rec(SHOPBOX).memberOf, 'apply: the house, its strongbox and shop door are linked; the chest in the shop is not');
  ok(rec(E2) && rec(E2).owner === 2 && rec(E2).memberOf === E1 && rec(I2).primary === E2, '...the back door joined');
  ok(rec(E1).keyAliases.includes('Key to the Shop Door') && !rec(E1).keyAliases.includes('Key to the Strongbox') && !rec(E1).keyAliases.some((a) => a.endsWith(`(${hx(BOX).toUpperCase()}-2)`)), "...the shop door's key names come over, the strongbox's do not (review F1)", rec(E1).keyAliases);
  ok(!rec(A1).place && !rec(B1).place && !rec(A1).memberOf, '...the shared interior: nothing applied to either owner');
  const files = backups();
  const b = files.length === 1 ? JSON.parse(fs.readFileSync(files[0], 'utf8')).records : {};
  ok([E1, I1, E2, I2, BOX, S1, S2].every((r) => Object.prototype.hasOwnProperty.call(b, hx(r))) && b[hx(E2)] === null && b[hx(I2)] === null, 'the backup holds every record apply writes, the joined back door and both halves of each pair included (review S3)', Object.keys(b));
  ok(JSON.stringify(b[hx(E1)]) === JSON.stringify(was[hx(E1)]) && JSON.stringify(b[hx(BOX)]) === JSON.stringify(was[hx(BOX)]), '...as they were before');

  // restore (review R1): only the migration's own fields go; what happened since stands
  // Since the apply: the house is handed to Elion (6) and re-keyed; the strongbox renamed
  const r = rec(E1); r.owner = 6; r.ownerName = 'Elion'; r.serial = 5; r.issued = []; props.set(`${E1}:private.housing`, r);
  const bx = rec(BOX); bx.owner = 6; bx.name = 'Elion Box'; props.set(`${BOX}:private.housing`, bx);
  sys.restorePlaces(ctx, files[0]);
  ok(!!rec(E1).place && logs.some((l) => /restore refused: set housingPlaceMigration/.test(l)), 'restore with apply still on is refused (the place stays)');
  sys.placeMigration = 'dryrun';
  sys.restorePlaces(ctx, files[0]);
  const root = rec(E1);
  ok(root.owner === 6 && root.serial === 5 && root.issued.length === 0 && !root.place && !root.keyAliases && !root.assigned, 'the buyer keeps the house at its new serial; only the place fields are gone', root);
  ok(sys.hasAccessWith(ctx, E1, sys.read(ctx, E1), { profileId: 0, admin: false, ranks: [], keys: new Set(['Key to the Valerio Residence']) }) === false, "...so the key the re-key retired stays dead");
  ok(rec(BOX).owner === 6 && rec(BOX).name === 'Elion Box' && !rec(BOX).memberOf && JSON.stringify(rec(S1).issued) === JSON.stringify(['Key to the Shop Door']) && !rec(S1).memberOf, 'members keep what happened since; memberOf goes', [rec(BOX), rec(S1)]);
  ok(rec(E2).owner === 0 && !rec(E2).memberOf && rec(E2).serial > 1, "...the joined back door, still Augustine's and the root's, is unclaimed again with its serial moved on", rec(E2));
  const marker = JSON.parse(fs.readFileSync(files[0] + '.restored', 'utf8'));
  ok(marker.state === 'done' && marker.changed.some((c) => c.ref === hx(E1) && c.was.owner === 2 && c.now.owner === 6 && c.now.serial === 5) && marker.changed.some((c) => c.ref === hx(BOX)), 'every ref whose owner or serial changed since the backup is listed in the marker and the log', marker.changed);
  ok(logs.some((l) => new RegExp(`${hx(E1)} changed since the backup \\(owner 2 -> 6, serial 2 -> 5\\)`).test(l)), '...the log too', logs.filter((l) => /restore/.test(l)));
  const n = logs.length;
  sys.restorePlaces(ctx, files[0]);
  ok(logs.slice(n).some((l) => /was restored already/.test(l)), '...so a second boot does not restore it again');
  sys.restorePlaces(ctx, '../etc/passwd');
  ok(logs.some((l) => /is not a migration backup's name/.test(l)), 'only a migration backup by name is restored');

  // A joined entrance still the place's: back to a stub, its far half pointing at it again
  clean();
  sys = build('apply');
  sys.dryRunPlaces(ctx, false);
  const f2 = backups().filter((f) => !fs.existsSync(f + '.restored'));
  sys.placeMigration = 'dryrun';
  sys.restorePlaces(ctx, f2[0]);
  ok(rec(E2).owner === 0 && rec(E2).partner === I2 && rec(I2).primary === E2 && sys.primaryOf(ctx, I2) === E2, 'a joined entrance still the place\'s goes back unclaimed, the pair whole (its far half points at it)', [rec(E2), rec(I2)]);
  ok(rec(E1).owner === 2 && !rec(E1).place && !rec(BOX).memberOf, '...and the place is undone');

  // A joined entrance that changed hands since stays with who holds it, listed
  clean();
  sys = build('apply');
  sys.dryRunPlaces(ctx, false);
  const f3 = backups().filter((f) => !fs.existsSync(f + '.restored'));
  const e = rec(E2); e.owner = 9; e.ownerName = 'Tavia'; delete e.memberOf; props.set(`${E2}:private.housing`, e);
  sys.placeMigration = 'dryrun';
  sys.restorePlaces(ctx, f3[0]);
  ok(rec(E2).owner === 9 && JSON.parse(fs.readFileSync(f3[0] + '.restored', 'utf8')).changed.some((c) => c.ref === hx(E2) && c.now.owner === 9), "a joined entrance someone else holds now is left with them, and listed", rec(E2));

  // Fail closed: the marker cannot be written, so nothing is restored, now or next boot
  clean();
  sys = build('apply');
  sys.dryRunPlaces(ctx, false);
  const f4 = backups().filter((f) => !fs.existsSync(f + '.restored'));
  sys.placeMigration = 'dryrun';
  const realWrite = fs.writeFileSync;
  fs.writeFileSync = (f, ...rest) => { if (/\.restored$/.test(String(f))) throw new Error('read-only'); return realWrite(f, ...rest); };
  try {
    sys.restorePlaces(ctx, f4[0]);
    ok(!!rec(E1).place && rec(BOX).memberOf === E1 && logs.some((l) => /PLACE RESTORE NOT DONE: the marker .* could not be written/.test(l)), 'a marker that cannot be written: loudly logged, nothing restored', logs.slice(-1));
    sys.restorePlaces(ctx, f4[0]);
    ok(!!rec(E1).place, '...and the next boot restores nothing either while it cannot be written');
  } finally { fs.writeFileSync = realWrite; }
  // A staff profile's street door into the same interior (staff houses are left out of the plan, review round 2)
  clean();
  fs.writeFileSync('gamemode-config.json', JSON.stringify({ housingPlaces: { staffProfiles: [4] } }));
  sys = build('apply');
  const X1 = H(0x130), X2 = H(0x131);
  REFS.push({ id: X1, cell: WORLD, type: 'DOOR', partner: X2 }, { id: X2, cell: HOUSE, type: 'DOOR', partner: X1 });
  byId.set(X1, REFS[REFS.length - 2]); byId.set(X2, REFS[REFS.length - 1]);
  put(X1, base({ owner: 4, ownerName: 'Akatosh', partner: X2 }));
  sys.claimed.push(X1);
  sys.dryRunPlaces(ctx, false);
  const ds = plan().details.find((x) => x.root === E1);
  ok(ds && /shared with another owner/.test(ds.notApplied) && ds.skippedCells.some((c) => /Akatosh's door/.test(c.why)) && !rec(E1).place, "a house whose interior a staff door also opens onto is not applied, and the plan says whose door", ds);
} finally {
  process.chdir(home);
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
