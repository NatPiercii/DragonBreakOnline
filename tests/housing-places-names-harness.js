// A place's name shows on every door of it (fork housingSystem.ts decorRefs / doorName; Nate's N3, 3 Oct): the refDecor
// list gives each member door pair the place's name, so a rename reaches every door; doorName (gamemode.js dboDoorName)
// answers the property's name only on the door that stands in the world and leads in, and "" for the door out, a door
// between interiors and an unnamed claim, so their prompts keep the destination's name.
//   node tests/housing-places-names-harness.js <bundled housingSystem.js>
'use strict';
const path = require('path');
const bundle = process.argv[2];
if (!bundle) { console.error('usage: node tests/housing-places-names-harness.js <bundled housingSystem.js>'); process.exit(2); }
const { HousingSystem } = require(path.resolve(bundle));
if (typeof HousingSystem.prototype.doorName !== 'function') { require('./expect')('housing-places-names', 'this housingSystem has no place door names'); console.log('skipped: no place door names in this housingSystem'); process.exit(0); }
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${what}${!c && got !== undefined ? '   ' + JSON.stringify(got).slice(0, 500) : ''}`); if (!c) fails++; };
const H = (n) => (0x08000000 | n) >>> 0;
const WORLD = 'a764b:BSHeartland.esm', FORT = 'b5936:BSHeartland.esm', CELLAR = 'b5937:BSHeartland.esm';
const CELL = {}, PARTNER = {}, TYPE = {};
const pair = (a, ca, b, cb) => { CELL[H(a)] = ca; CELL[H(b)] = cb; PARTNER[H(a)] = H(b); PARTNER[H(b)] = H(a); TYPE[H(a)] = TYPE[H(b)] = 'DOOR'; };
pair(0xb5c6e, FORT, 0xb5fe6, WORLD);   // root: its primary is the inside half
pair(0xb5eac, WORLD, 0xb5eae, FORT);   // a member: its primary is the outside half
pair(0xb5f55, FORT, 0xb5fea, WORLD);   // another member
pair(0xb6100, FORT, 0xb6101, CELLAR);  // a member between two interiors
pair(0x67657, WORLD, 0x67658, '67652:BSHeartland.esm'); // someone's unnamed house
const ROOT = H(0xb5c6e), M1 = H(0xb5eac), M2 = H(0xb5f55), M3 = H(0xb6100), PLAIN = H(0x67657);
const props = new Map(), notices = [];
const descToId = (d) => parseInt(String(d).split(':')[0], 16) | 0x08000000;
const mp = {
  get: (id, k) => {
    id = id >>> 0;
    if (k === 'worldOrCellDesc') return CELL[id];
    if (k === 'profileId') return id === 0xff000060 ? 60 : 0;
    if (k === 'inventory') return { entries: [] };
    const v = props.get(`${id}:${k}`); return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  },
  set: (id, k, v) => props.set(`${id >>> 0}:${k}`, JSON.parse(JSON.stringify(v))),
  getIdFromDesc: descToId,
  lookupEspmRecordById: (id) => ({ record: { type: (id >>> 0) === descToId(WORLD) ? 'WRLD' : 'CELL' } }),
  getUserByActor: () => 1, getUserActor: () => 0xff000060, isConnected: () => false,
  sendCustomPacket: (u, raw) => { const p = JSON.parse(raw); if (p.customPacketType === 'propertyNotice') notices.push(p.text); },
};
const ctx = { svr: mp };
const base = (o) => Object.assign({ owner: 60, ownerName: 'Kojus Animus', name: null, locked: true, serial: 2, partner: 0, containers: [], issued: [] }, o);
const put = (ref, r) => { props.set(`${ref}:private.housing`, r); if (r.partner) props.set(`${r.partner}:private.housing`, { primary: ref }); };
put(ROOT, base({ name: 'Fort Caractacus', partner: H(0xb5fe6), place: { cells: [FORT, CELLAR], builtAt: 1 } }));
put(M1, base({ partner: H(0xb5eae), memberOf: ROOT }));
put(M2, base({ partner: H(0xb5fea), memberOf: ROOT, name: 'Old Gate' }));
put(M3, base({ partner: H(0xb6101), memberOf: ROOT }));
put(PLAIN, base({ owner: 2, ownerName: 'Augustine', partner: H(0x67658) }));
const sys = new HousingSystem(() => {});
sys.placeMigration = 'apply';
sys.saveRegistry = () => {};
sys.baseTypeOf = (c, id) => TYPE[id >>> 0] || '';
sys.partnerOf = (c, id) => PARTNER[id >>> 0] || 0;
sys.holdOf = () => null; sys.holdRanks = () => []; sys.isAdmin = () => false;
sys.claimed = [ROOT, M1, M2, M3, PLAIN];
const decor = () => new Map(sys.decorRefs(ctx).map((d) => [d.refId, d.name]));
let d = decor();
ok([ROOT, H(0xb5fe6), M1, H(0xb5eae), M2, H(0xb5fea), M3, H(0xb6101)].every((r) => d.get(r) === 'Fort Caractacus'), 'every door of the place, both halves of each pair, carries the place\'s name (a member\'s own old name gives way)', [...d]);
ok(d.get(PLAIN) === null, "another owner's unnamed house keeps no name");
// Rename from a member door: the root is renamed and every door shows it
sys.lastRequestMs.clear();
sys.withinReach = () => true;
sys.sendMenu = () => {};
sys.onPropertyRequest(ctx, 1, { action: 'rename', target: M1, name: 'Caractacus Hold' });
d = decor();
ok(props.get(`${ROOT}:private.housing`).name === 'Caractacus Hold' && [M1, H(0xb5eae), M2, M3, H(0xb5fe6)].every((r) => d.get(r) === 'Caractacus Hold'), 'a rename from any door renames the place and reaches every door pair', [...d]);
ok(/All 4 of its doors show it/.test(notices.join()), '...and the owner is told it shows on all four', notices);
// doorName for the prompt
ok(sys.doorName(ctx, H(0xb5fe6)) === 'Caractacus Hold' && sys.doorName(ctx, M1) === 'Caractacus Hold' && sys.doorName(ctx, H(0xb5fea)) === 'Caractacus Hold', 'the prompt on each door outside, leading in, reads the place\'s name');
ok(sys.doorName(ctx, ROOT) === '' && sys.doorName(ctx, H(0xb5eae)) === '' && sys.doorName(ctx, H(0xb5f55)) === '', '...the doors inside, leading out, keep the destination ("")');
ok(sys.doorName(ctx, M3) === '' && sys.doorName(ctx, H(0xb6101)) === '', '...as do the doors between the fort and its cellar');
ok(sys.doorName(ctx, PLAIN) === '' && sys.doorName(ctx, H(0x12345)) === '', 'an unnamed claim and an unclaimed ref answer ""');
const p = props.get(`${PLAIN}:private.housing`); p.name = 'Valerio Residence'; props.set(`${PLAIN}:private.housing`, p);
ok(sys.doorName(ctx, PLAIN) === 'Valerio Residence' && sys.doorName(ctx, H(0x67658)) === '', 'a plain named house reads its name outside only (with apply)');
sys.placeMigration = 'dryrun';
ok(sys.doorName(ctx, H(0xb5fe6)) === '' && sys.doorName(ctx, PLAIN) === '', 'dryrun: doorName answers "" everywhere, so every prompt reads as today (review F3)');
{ const dd = decor(); ok(dd.get(M2) === 'Old Gate' && dd.get(M1) === null && dd.get(ROOT) === 'Caractacus Hold', 'dryrun: members show their own names in refDecor, as before the place rules', [...dd]); }
sys.placeMigration = 'apply';
sys.exposeTenancy(ctx);
ok(globalThis.__dboHousing.doorName(H(0xb5fe6)) === 'Caractacus Hold' && globalThis.__dboHousing.doorName('junk') === '', '__dboHousing.doorName gives the same for gamemode.js, and "" for junk');
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
