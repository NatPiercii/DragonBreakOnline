// The owner's Rooms and chests (fork housingSystem.ts placeMenu / roomsOf / doRoom; Nate's N3, 3 Oct), only with
// housingPlaceMigration "apply": the property menu of a place carries, for its owner and the managers, the place's inner
// doors and chests (not its ways out, each pair once, named from the plugin); the owner assigns one to a person, takes it
// back, or shares a chest with the household; aiming at a chest inside opens the place's menu with that chest first; a
// person aiming at a room assigned to them is told so; anywhere inside the place is near enough to manage it.
//   node tests/housing-places-rooms-harness.js <bundled housingSystem.js>
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const bundle = process.argv[2];
if (!bundle) { console.error('usage: node tests/housing-places-rooms-harness.js <bundled housingSystem.js>'); process.exit(2); }
const { HousingSystem } = require(path.resolve(bundle));
if (typeof HousingSystem.prototype.roomsOf !== 'function') { require('./expect')('housing-places-rooms', 'this housingSystem has no Rooms and chests'); console.log('skipped: no Rooms and chests in this housingSystem'); process.exit(0); }
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${what}${!c && got !== undefined ? '   ' + JSON.stringify(got).slice(0, 700) : ''}`); if (!c) fails++; };
const H = (n) => (0x08000000 | n) >>> 0;
const WORLD = 'a764b:BSHeartland.esm', HOUSE = '67652:BSHeartland.esm', BASEMENT = '67653:BSHeartland.esm';
const REFS = [];
const ref = (id, cell, type, partner, base) => { REFS.push({ id: H(id), cell, type, partner: partner ? H(partner) : 0, base }); return H(id); };
const E1 = ref(0x100, WORLD, 'DOOR', 0x101, 0x900), I1 = ref(0x101, HOUSE, 'DOOR', 0x100, 0x900);
const E2 = ref(0x102, WORLD, 'DOOR', 0x103, 0x900), I2 = ref(0x103, HOUSE, 'DOOR', 0x102, 0x900);
const B1 = ref(0x104, HOUSE, 'DOOR', 0x105, 0x901), B2 = ref(0x105, BASEMENT, 'DOOR', 0x104, 0x901);
const BED = ref(0x106, HOUSE, 'DOOR', 0, 0x902);
const C1 = ref(0x10a, HOUSE, 'CONT', 0, 0x903), C2 = ref(0x10b, BASEMENT, 'CONT', 0, 0x903), C3 = ref(0x10c, HOUSE, 'CONT', 0, 0x904);
const byId = new Map(REFS.map((r) => [r.id, r]));
// Base records: a localized chest name (string table), a plain FULL, an editor id only
const STRINGS = { [H(0x903)]: 'Strongbox', [H(0x67653)]: 'Valerio Cellar' };
const BASES = { [H(0x901)]: { editorId: 'CellarTrapdoor01', fields: [] }, [H(0x902)]: { editorId: 'X', fields: [{ type: 'FULL', data: Uint8Array.from(Buffer.from('Bedroom Door\0')) }] }, [H(0x903)]: { editorId: 'Y', fields: [{ type: 'FULL', data: Uint8Array.from([1, 0, 0, 0]) }] }, [H(0x904)]: { editorId: 'WardrobeTall01', fields: [] }, [H(0x900)]: { editorId: 'HouseDoor', fields: [] } };
const OWNER = 0xff000002, TENANT = 0xff000009, STRANGER = 0xff000051, KEYGUEST = 0xff000063;
const PROFILE = { [OWNER]: 2, [TENANT]: 9, [STRANGER]: 51, [KEYGUEST]: 63 };
const USER = { [OWNER]: 1, [TENANT]: 2, [STRANGER]: 3, [KEYGUEST]: 4 };
const NAMES = { [OWNER]: 'Augustine Valerio', [TENANT]: 'Tavia', [STRANGER]: 'Stranger', [KEYGUEST]: 'Guest' };
const where = { [OWNER]: { cell: WORLD, pos: [0, 0, 0] } };
let props = new Map(), sent = [];
const descToId = (d) => parseInt(String(d).split(':')[0], 16) | 0x08000000;
const le = (n) => Uint8Array.from([n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255]);
let keys = [];
const mp = {
  get: (id, k) => {
    id = id >>> 0;
    if (k === 'profileId') return PROFILE[id] || 0;
    if (k === 'appearance') return { name: NAMES[id] || 'Someone' };
    if (k === 'inventory') return { entries: id === KEYGUEST ? keys : [] };
    if (k === 'private.discordRoles') return [];
    if (k === 'worldOrCellDesc') return byId.get(id) ? byId.get(id).cell : where[id] ? where[id].cell : undefined;
    if (k === 'pos') return where[id] ? where[id].pos : (byId.get(id) ? (byId.get(id).cell === WORLD ? [0, 0, 0] : [9000, 9000, 0]) : undefined);
    const v = props.get(`${id}:${k}`); return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  },
  set: (id, k, v) => props.set(`${id >>> 0}:${k}`, JSON.parse(JSON.stringify(v))),
  getNeighborsByPosition: (cell) => REFS.filter((r) => r.cell === cell).map((r) => r.id),
  getIdFromDesc: descToId,
  getLocalizedString: (id) => STRINGS[id >>> 0],
  lookupEspmRecordById: (id) => {
    id = id >>> 0;
    const r = byId.get(id);
    if (r) return { record: { type: 'REFR', fields: [{ type: 'NAME', data: le(r.base) }] }, toGlobalRecordId: (l) => (0x08000000 | l) >>> 0 };
    if (BASES[id]) return { record: Object.assign({ type: 'CONT' }, BASES[id]) };
    return { record: { type: id === descToId(WORLD) ? 'WRLD' : 'CELL', fields: [] } };
  },
  getUserByActor: (id) => USER[id >>> 0] || -1,
  getUserActor: (u) => Number(Object.keys(USER).find((a) => USER[a] === u) || 0),
  isConnected: () => false,
  sendCustomPacket: (u, raw) => sent.push([u, JSON.parse(raw)]),
};
const ctx = { svr: mp };
const sys = new HousingSystem(() => {});
sys.placeMigration = 'apply';
sys.roleCfg = { tierRoles: { senior: [], developer: [], leadgm: [], gm: [] }, adminRoleIds: [], adminProfileIds: [] };
sys.holdOf = () => 'bruma'; sys.holdRanks = () => [];
sys.saveRegistry = () => {};
sys.baseTypeOf = (c, id) => (byId.get(id >>> 0) ? byId.get(id >>> 0).type : '');
sys.partnerOf = (c, id) => (byId.get(id >>> 0) ? byId.get(id >>> 0).partner : 0);
sys.claimed = [];
const rec = (r) => props.get(`${r}:private.housing`);
// With the building rule (Nate, 4 Oct) the menu at a door or chest inside answers for what was aimed at, else for the root
const AIMED = typeof HousingSystem.prototype.isBuilding === 'function';
const menuFor = (who, target) => { sent.length = 0; sys.sendMenu(ctx, USER[who], who, target); const m = sent.find(([, p]) => p.customPacketType === 'propertyMenu'); return m ? m[1] : null; };
const request = (who, action, target, extra) => { sent.length = 0; sys.lastRequestMs.clear(); sys.onPropertyRequest(ctx, USER[who], Object.assign({ action, target }, extra || {})); return sent.filter(([, p]) => p.customPacketType === 'propertyNotice').map(([u, p]) => `${u}:${p.text}`).join(' | '); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-placesrooms-'));
const home = process.cwd();
process.chdir(dir);
try {
  fs.writeFileSync('gamemode-config.json', JSON.stringify({ housingPlaces: { staffProfiles: [] } }));
  sys.openClaims = true;
  request(OWNER, 'claim', E1);
  ok(rec(E1) && rec(E1).owner === 2 && rec(E1).place, 'Augustine holds the house as a place');
  request(OWNER, 'rename', E1, { name: 'Valerio Residence' });
  let m = menuFor(OWNER, E1);
  const rooms = (m && m.place && m.place.rooms) || [];
  const labels = rooms.map((r) => r.label);
  ok(m && m.place && m.place.root === E1 && m.place.name === 'Valerio Residence', "the owner's menu carries the place", m && m.place);
  ok(!rooms.some((r) => [E1, I1, E2, I2].includes(r.ref)), '...without its ways out (front and back door)', rooms);
  ok(rooms.filter((r) => r.ref === B1 || r.ref === B2).length === 1, '...the cellar door pair once', rooms);
  ok(JSON.stringify(labels) === JSON.stringify(['Bedroom Door', 'Cellar Trapdoor to Valerio Cellar', 'Strongbox', 'Strongbox 2', 'Wardrobe Tall']), 'labels: the plain FULL, an editor id spelled out (no trailing number) with where the door goes, the localized name numbered when repeated', labels);
  ok(rooms.every((r) => r.assigned === null && r.shared === false && r.other === null), '...none assigned yet');
  // Assign the strongbox upstairs to Tavia
  let said = request(OWNER, 'assign', E1, { ref: C1, recipient: TENANT });
  ok(rec(E1).assigned && rec(E1).assigned[C1.toString(16)].profile === 9 && /Strongbox is Tavia's now/.test(said) && /2:Strongbox in Valerio Residence is yours to use/.test(said), "assigning the strongbox to Tavia: recorded, and both are told", said);
  ok(sys.onActivate(ctx, C1, TENANT) === true && sys.onActivate(ctx, C1, STRANGER) === false && sys.onActivate(ctx, C1, OWNER) === true, '...it opens for Tavia and Augustine, not a stranger');
  m = menuFor(TENANT, C1);
  ok(m && m.assignedToYou === true && m.place === null && m.placeName === 'Valerio Residence' && m.target === (AIMED ? C1 : E1), "Tavia aiming at it: the place's menu, telling her it is hers, without the owner's panel", m);
  // Share the cellar strongbox
  said = request(OWNER, 'share', E1, { ref: C2 });
  ok((rec(E1).shared || []).includes(C2.toString(16)) && /shared with everyone who has a key/.test(said), 'sharing the cellar strongbox', said);
  keys = [{ baseId: 0xdb0e2, count: 1, name: `Property Key (${E1.toString(16).toUpperCase()})` }];
  ok(sys.onActivate(ctx, C2, KEYGUEST) === true && sys.onActivate(ctx, C3, KEYGUEST) === false, '...a guest with a key opens the shared one, not the wardrobe');
  said = request(OWNER, 'share', E1, { ref: BED });
  ok(/Only a chest is shared/.test(said), 'a door cannot be shared', said);
  said = request(OWNER, 'unassign', E1, { ref: C1 });
  ok(!rec(E1).assigned && sys.onActivate(ctx, C1, TENANT) === false, 'taking the strongbox back: Tavia no longer opens it', said);
  said = request(OWNER, 'unshare', E1, { ref: C2 });
  ok(!rec(E1).shared && sys.onActivate(ctx, C2, KEYGUEST) === false, 'unsharing the cellar strongbox', said);
  said = request(OWNER, 'assign', E1, { ref: E2, recipient: TENANT });
  ok(/not one of this property's rooms/.test(said), 'a way out is no room to assign', said);
  said = request(STRANGER, 'assign', E1, { ref: C1, recipient: STRANGER });
  ok(!rec(E1).assigned, 'a stranger cannot assign anything', said);
  // Aiming at the wardrobe inside opens the place's menu, the wardrobe first
  m = menuFor(OWNER, C3);
  ok(m && m.target === (AIMED ? C3 : E1) && m.place && m.place.here === C3 && m.place.rooms[0].ref === C3, "the owner aiming at the wardrobe: the place's menu with it first", m && m.place);
  // In the cellar, far from the front door, Augustine may still manage it
  where[OWNER] = { cell: BASEMENT, pos: [9000, 9000, 0] };
  said = request(OWNER, 'assign', E1, { ref: C2, recipient: TENANT });
  ok(rec(E1).assigned && rec(E1).assigned[C2.toString(16)], 'from the cellar, far from the front door, the owner still assigns', said);
  where[STRANGER] = { cell: WORLD, pos: [99999, 0, 0] };
  said = request(STRANGER, 'unassign', E1, { ref: C2 });
  ok(/too far away/.test(said), '...a stranger far outside is too far away', said);
  // A hand-over clears the old owner's assignments
  request(OWNER, 'transfer', E1, { recipient: STRANGER });
  ok(rec(E1).owner === 51 && !rec(E1).assigned && !rec(E1).shared, "handing the place over: the old owner's assignments do not come with it", rec(E1));
  // dryrun: no place part in the menu
  sys.placeMigration = 'dryrun';
  m = menuFor(STRANGER, E1);
  ok(m && m.place === undefined && m.placeName === undefined, 'dryrun: the menu is as before', m);
} finally {
  process.chdir(home);
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
