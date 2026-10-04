// The place cap (fork housingSystem.ts overCap; Nate's N3, 3 Oct), only with housingPlaceMigration "apply": one place per
// player, a place being a house with its doors and chests (members are not counted); since 4 Oct (Nate) a chest or room door
// claimed on its own is no property (housingMaxClaims limits those). A hand-over, a grant
// (tenancy) or an open claim to someone who already holds one is refused; nothing they hold is taken. Staff are exempt:
// the profiles in gamemode-config.json housingPlaces.staffProfiles, and anyone online with an admin tier. Officials who
// claim to hand a property on are not capped at the claim. Without "apply" the old per-claim limit stands.
//   node tests/housing-places-cap-harness.js <bundled housingSystem.js>
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const bundle = process.argv[2];
if (!bundle) { console.error('usage: node tests/housing-places-cap-harness.js <bundled housingSystem.js>'); process.exit(2); }
const { HousingSystem } = require(path.resolve(bundle));
if (typeof HousingSystem.prototype.overCap !== 'function') { require('./expect')('housing-places-cap', 'this housingSystem has no place cap'); console.log('skipped: no place cap in this housingSystem'); process.exit(0); }
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${what}${!c && got !== undefined ? '   ' + JSON.stringify(got).slice(0, 400) : ''}`); if (!c) fails++; };
const H = (n) => (0x08000000 | n) >>> 0;
const HOUSE = H(0x67657), HOUSE_DOOR = H(0x6800a), CHEST_IN = H(0x6800b), BARREL = H(0x5c0d6), NEW_DOOR = H(0x62169), NEW_CHEST = H(0x7586e);
const OWNER = 0xff000002, NEWBIE = 0xff000009, AKATOSH = 0xff000004, GM = 0xff000021, STEWARD = 0xff000041, OVER = 0xff000060;
const PROFILE = { [OWNER]: 2, [NEWBIE]: 9, [AKATOSH]: 4, [GM]: 21, [STEWARD]: 41, [OVER]: 60 };
const ROLES = { [GM]: ['role-gm'] };
const USER = { [OWNER]: 1, [NEWBIE]: 2, [AKATOSH]: 3, [GM]: 4, [STEWARD]: 5, [OVER]: 6 };
const BUILDING = typeof HousingSystem.prototype.isBuilding === 'function';
const LOOSE_CHEST = H(0x99003);
const ENTRANCES = new Set([NEW_DOOR, NEW_CHEST, BARREL, H(0x5c0d7), H(0x8b4c7), H(0xb452a), H(0x6216a), H(0x99001), H(0x99002)]);
const props = new Map();
const notices = [];
const mp = {
  get: (id, k) => {
    if (k === 'profileId') return PROFILE[id >>> 0] || 0;
    if (k === 'private.discordRoles') return ROLES[id >>> 0] || [];
    if (k === 'appearance') return { name: 'P' + (PROFILE[id >>> 0] || 0) };
    if (k === 'inventory') return { entries: [] };
    const v = props.get(`${id >>> 0}:${k}`); return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  },
  set: (id, k, v) => props.set(`${id >>> 0}:${k}`, JSON.parse(JSON.stringify(v))),
  getUserByActor: (id) => USER[id >>> 0] || -1,
  getUserActor: (u) => Number(Object.keys(USER).find((a) => USER[a] === u) || 0),
  isConnected: () => false,
  sendCustomPacket: (u, raw) => { const p = JSON.parse(raw); if (p.customPacketType === 'propertyNotice') notices.push([u, p.text]); },
};
const ctx = { svr: mp };
const base = (o) => Object.assign({ owner: 0, ownerName: '', name: null, locked: false, serial: 1, partner: 0, containers: [], issued: [] }, o);
const seed = () => {
  props.clear();
  // Augustine (2) holds one house with a member door and a member chest
  props.set(`${HOUSE}:private.housing`, base({ owner: 2, ownerName: 'Augustine', name: 'Valerio Residence', place: { cells: ['67652:BSHeartland.esm'], builtAt: 1 } }));
  props.set(`${HOUSE_DOOR}:private.housing`, base({ owner: 2, ownerName: 'Augustine', memberOf: HOUSE }));
  props.set(`${CHEST_IN}:private.housing`, base({ owner: 2, ownerName: 'Augustine', memberOf: HOUSE }));
  // Kojus-like (60): two places already, over the cap
  props.set(`${BARREL}:private.housing`, base({ owner: 60, ownerName: 'Over' }));
  props.set(`${H(0x5c0d7)}:private.housing`, base({ owner: 60, ownerName: 'Over' }));
  // Akatosh (4, staff by the config list): three claims
  for (const r of [H(0x8b4c7), H(0xb452a), H(0x6216a)]) props.set(`${r}:private.housing`, base({ owner: 4, ownerName: 'Akatosh' }));
};
const build = (mode) => {
  const sys = new HousingSystem(() => {});
  sys.placeMigration = mode;
  sys.roleCfg = { tierRoles: { senior: [], developer: [], leadgm: ['role-leadgm'], gm: ['role-gm'] }, adminRoleIds: [], adminProfileIds: [] };
  sys.holdOf = () => 'bruma';
  sys.holdRanks = (c, a) => (a === STEWARD ? [{ hold: 'bruma', rank: 'steward' }] : []);
  sys.saveRegistry = () => {};
  sys.primaryOf = (c, id) => id >>> 0;
  sys.partnerOf = () => 0;
  sys.withinReach = () => true; sys.nearProperty = () => true;
  sys.claimed = [HOUSE, HOUSE_DOOR, CHEST_IN, BARREL, H(0x5c0d7), H(0x8b4c7), H(0xb452a), H(0x6216a)];
  // With the building rule (Nate, 4 Oct) only buildings count: here the claims below stand for doors into houses
  if (BUILDING) sys.isEntrance = (c, p) => ENTRANCES.has(p >>> 0);
  return sys;
};
const rec = (ref) => props.get(`${ref}:private.housing`);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-placescap-'));
const home = process.cwd();
process.chdir(dir);
try {
  fs.writeFileSync('gamemode-config.json', JSON.stringify({ housingPlaces: { staffProfiles: [4] } }));
  const transfer = (sys, from, ref, to) => { notices.length = 0; const r = sys.read(ctx, ref) || base({}); sys.doTransfer(ctx, USER[from], ref, r, true, false, to); return notices.map((n) => n[1]).join(' | '); };

  seed();
  let sys = build('apply');
  ok(sys.countPlaces(ctx, 2) === 1, "Augustine's house with its member door and chest counts as one place", sys.countPlaces(ctx, 2));
  props.set(`${NEW_DOOR}:private.housing`, base({ owner: 41, ownerName: 'Steward' }));
  sys.claimed.push(NEW_DOOR);
  let said = transfer(sys, STEWARD, NEW_DOOR, OWNER);
  ok(rec(NEW_DOOR).owner === 41 && /They already hold a property; one each/.test(said), 'a hand-over to someone who holds a place is refused', said);
  said = transfer(sys, STEWARD, NEW_DOOR, NEWBIE);
  ok(rec(NEW_DOOR).owner === 9 && /Handed to/.test(said), '...to someone who holds none it goes through', said);
  ok(sys.overCap(ctx, 60, OVER, false) !== '' && rec(BARREL).owner === 60 && rec(H(0x5c0d7)).owner === 60, 'an owner over the cap keeps both places and can take no new one');
  ok(sys.overCap(ctx, 4, AKATOSH, false) === '' && sys.countPlaces(ctx, 4) === 3, 'staff (profile 4 in housingPlaces.staffProfiles) are exempt with their 3 claims');
  ok(sys.overCap(ctx, 21, GM, false) === '' , 'anyone online with an admin tier is exempt too (the gear swap reads the same roles)');
  fs.writeFileSync('gamemode-config.json', JSON.stringify({ housingPlaces: { staffProfiles: [] } }));
  ok(sys.overCap(ctx, 4, 0, false) !== '', 'a profile struck from the list is capped again (read when asked, no restart)');
  fs.writeFileSync('gamemode-config.json', JSON.stringify({ housingPlaces: { staffProfiles: [4] } }));
  // The tenancy grant
  props.set(`${NEW_CHEST}:private.housing`, base({}));
  sys.claimed.push(NEW_CHEST);
  sys.exposeTenancy(ctx);
  ok(/one each/.test(globalThis.__dboHousing.grant(NEW_CHEST, OWNER)) && rec(NEW_CHEST).owner === 0, 'a tenancy grant to someone who holds a place is refused');
  ok(globalThis.__dboHousing.grant(NEW_CHEST, AKATOSH) === '' && rec(NEW_CHEST).owner === 4, '...and allowed for staff');
  // Claims: an official is not capped when claiming to hand on; an open claim is
  sys.openClaims = true;
  notices.length = 0;
  const free = H(0x99001); sys.claimed.push(free);
  sys.sendMenu = () => {};
  sys.doClaim(ctx, USER[STEWARD], STEWARD, free, base({}), true);
  ok(rec(free) && rec(free).owner === 41, 'the Steward claims although they already hold one (it is theirs to hand on)', notices);
  const free2 = H(0x99002);
  notices.length = 0;
  sys.doClaim(ctx, USER[OWNER], OWNER, free2, base({}), false);
  ok(!rec(free2) && /You already hold a property; one each/.test(notices.map((n) => n[1]).join()), 'an open claim by someone who holds a place is refused', notices);
  if (BUILDING) {
    notices.length = 0;
    sys.doClaim(ctx, USER[OWNER], OWNER, LOOSE_CHEST, base({}), false);
    ok(rec(LOOSE_CHEST) && rec(LOOSE_CHEST).owner === 2 && sys.countPlaces(ctx, 2) === 1, '...but a chest is no property: she claims it and still holds one', notices);
  }

  // Without "apply": the old limit of housingMaxClaims (8)
  seed();
  sys = build('dryrun');
  props.set(`${NEW_DOOR}:private.housing`, base({ owner: 41, ownerName: 'Steward' }));
  sys.claimed.push(NEW_DOOR);
  said = transfer(sys, STEWARD, NEW_DOOR, OWNER);
  ok(rec(NEW_DOOR).owner === 2, 'dryrun: no place cap, the old per-claim limit only (Augustine gets a second)', said);
  sys.maxClaims = 1;
  sys.exposeTenancy(ctx);
  const g = globalThis.__dboHousing.grant(NEW_CHEST, OWNER);
  ok(g === 'They already hold 1 properties.', "dryrun: a tenancy grant past housingMaxClaims refuses with today's text (review F3)", g);
} finally {
  process.chdir(home);
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
