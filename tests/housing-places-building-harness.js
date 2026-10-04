// The building is the property (Nate, 4 Oct; fork housingSystem.ts with housingPlaceMigration "apply"): owning a building
// makes every door and chest inside it the owner's, for locking and access, and none of them counts as a property of its
// own. The one-property cap counts buildings only; a chest or a room door claimed on its own is not one (those stay under
// housingMaxClaims). From any door or chest inside, unclaimed or not, the place-wide actions (name, keys, hand over, give
// up, assign) act on the building, and the gameplay's view (__dboHousing) answers the building; a lock on an inner door or
// chest locks that one alone (it becomes a member), and locking a way in locks every way in but no inner door. Handing
// over or giving up the building moves everything inside with it. Staff claims build nothing. In dryrun nothing changes.
//   node tests/housing-places-building-harness.js <bundled housingSystem.js>
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const bundle = process.argv[2];
if (!bundle) { console.error('usage: node tests/housing-places-building-harness.js <bundled housingSystem.js>'); process.exit(2); }
const { HousingSystem } = require(path.resolve(bundle));
if (typeof HousingSystem.prototype.isBuilding !== 'function') { require('./expect')('housing-places-building', 'this housingSystem counts every claim as a property'); console.log('skipped: no building rule in this housingSystem'); process.exit(0); }
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${what}${!c && got !== undefined ? '   ' + JSON.stringify(got).slice(0, 500) : ''}`); if (!c) fails++; };
const H = (n) => (0x08000000 | n) >>> 0;
const WORLD = 'a764b:BSHeartland.esm', HOUSE = '20f5:BSHeartland.esm', UP = '6e379:BSHeartland.esm', HOUSE2 = '20e9:BSHeartland.esm';
const PUB = '12cb:BSHeartland.esm', ROOM = '5f78d:BSHeartland.esm', STAFF = '62131:BSHeartland.esm';
const REFS = [];
const ref = (id, cell, type, partner) => { REFS.push({ id: H(id), cell, type, partner: partner ? H(partner) : 0 }); return H(id); };
// Viggo's house: a front door and a back door from the street, an inner door upstairs, a chest on each floor
const E1 = ref(0x100, WORLD, 'DOOR', 0x101); ref(0x101, HOUSE, 'DOOR', 0x100);
const E2 = ref(0x102, WORLD, 'DOOR', 0x103), I2 = ref(0x103, HOUSE, 'DOOR', 0x102);
const U1 = ref(0x104, HOUSE, 'DOOR', 0x105); ref(0x105, UP, 'DOOR', 0x104);
const C1 = ref(0x106, HOUSE, 'CONT'), C2 = ref(0x107, UP, 'CONT');
// A door from the house into the shop next door (its own street door): the pair's record half stands in the shop
const HALL2 = '20f6:BSHeartland.esm';
const X1 = ref(0x0f0, HALL2, 'DOOR', 0x0f1); ref(0x0f1, HOUSE, 'DOOR', 0x0f0);
ref(0x0f2, WORLD, 'DOOR', 0x0f3); ref(0x0f3, HALL2, 'DOOR', 0x0f2);
// A second house, two barrels in the street, a room door in a public hall (with its own street door, nobody's), staff's house
const Q1 = ref(0x200, WORLD, 'DOOR', 0x201); ref(0x201, HOUSE2, 'DOOR', 0x200);
const BARREL = ref(0x202, WORLD, 'CONT'), BARREL2 = ref(0x203, WORLD, 'CONT');
ref(0x300, WORLD, 'DOOR', 0x301); ref(0x301, PUB, 'DOOR', 0x300);
const R1 = ref(0x302, PUB, 'DOOR', 0x303); ref(0x303, ROOM, 'DOOR', 0x302);
const S1 = ref(0x400, WORLD, 'DOOR', 0x401); ref(0x401, STAFF, 'DOOR', 0x400);
const Z1 = ref(0x500, WORLD, 'DOOR', 0x501); ref(0x501, '20ea:BSHeartland.esm', 'DOOR', 0x500);   // a house nobody ever claimed
const byId = new Map(REFS.map((r) => [r.id, r]));
const STEWARD = 0xff000041, VIGGO = 0xff000009, STRANGER = 0xff000051, AKATOSH = 0xff000004, WHISPER = 0xff000061;
const PROFILE = { [STEWARD]: 41, [VIGGO]: 9, [STRANGER]: 51, [AKATOSH]: 4, [WHISPER]: 61 };
const USER = { [STEWARD]: 5, [VIGGO]: 2, [STRANGER]: 3, [AKATOSH]: 4, [WHISPER]: 6 };
let props, notices, menus;
const descToId = (d) => parseInt(String(d).split(':')[0], 16) | 0x08000000;
const mp = {
  get: (id, k) => {
    id = id >>> 0;
    if (k === 'profileId') return PROFILE[id] || 0;
    if (k === 'appearance') return { name: 'P' + (PROFILE[id] || 0) };
    if (k === 'inventory') return { entries: [] };
    if (k === 'private.discordRoles') return [];
    if (k === 'worldOrCellDesc') return byId.get(id) ? byId.get(id).cell : undefined;
    const v = props.get(`${id}:${k}`); return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  },
  set: (id, k, v) => props.set(`${id >>> 0}:${k}`, JSON.parse(JSON.stringify(v))),
  getNeighborsByPosition: (cell) => REFS.filter((r) => r.cell === cell).map((r) => r.id),
  getIdFromDesc: descToId,
  lookupEspmRecordById: (id) => ({ record: { type: (id >>> 0) === descToId(WORLD) ? 'WRLD' : 'CELL' } }),
  getUserByActor: (id) => USER[id >>> 0] || -1,
  getUserActor: (u) => Number(Object.keys(USER).find((a) => USER[a] === u) || 0),
  isConnected: () => false,
  sendCustomPacket: (u, raw) => { const p = JSON.parse(raw); if (p.customPacketType === 'propertyNotice') notices.push(p.text); if (p.customPacketType === 'propertyMenu') menus.push(p); },
};
const ctx = { svr: mp };
const build = (mode) => {
  props = new Map(); notices = []; menus = [];
  const sys = new HousingSystem(() => {});
  sys.placeMigration = mode;
  sys.roleCfg = { tierRoles: { senior: [], developer: [], leadgm: [], gm: [] }, adminRoleIds: [], adminProfileIds: [] };
  sys.holdOf = () => 'bruma';
  sys.holdRanks = (c, a) => (a === STEWARD ? [{ hold: 'bruma', rank: 'steward' }] : []);
  sys.saveRegistry = () => {};
  sys.baseTypeOf = (c, id) => (byId.get(id >>> 0) ? byId.get(id >>> 0).type : '');
  sys.partnerOf = (c, id) => (byId.get(id >>> 0) ? byId.get(id >>> 0).partner : 0);
  sys.withinReach = () => true;
  sys.labelOf = () => 'Thing';
  sys.claimed = [];
  return sys;
};
const rec = (r) => props.get(`${r}:private.housing`);
const request = (sys, who, action, target, extra) => { notices.length = 0; sys.onPropertyRequest(ctx, USER[who], Object.assign({ action, target }, extra || {})); sys.lastRequestMs.clear(); return notices.join(' | '); };
// An official claims, then hands it to someone: how property is granted
const grant = (sys, target, to) => { request(sys, STEWARD, 'claim', target); return request(sys, STEWARD, 'transfer', target, { recipient: to }); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-placesbuilding-'));
const home = process.cwd();
process.chdir(dir);
try {
  fs.writeFileSync('gamemode-config.json', JSON.stringify({ housingPlaces: { staffProfiles: [4] } }));
  let sys = build('apply');
  let said = grant(sys, E1, VIGGO);
  ok(rec(E1).owner === 9 && rec(E1).place && JSON.stringify(rec(E1).place.cells) === JSON.stringify([HOUSE, UP]) && rec(E2).memberOf === E1, "Viggo's house is granted as a building: both floors, the back door joined", rec(E1));
  ok(!rec(U1) && !rec(C1) && !rec(C2), '...the inner door and the chests are not claims: they follow the building by cell');
  ok(sys.countPlaces(ctx, 9) === 1, 'the house with its back door counts as one property', sys.countPlaces(ctx, 9));
  // The cap counts buildings only
  said = grant(sys, BARREL, VIGGO);
  ok(rec(BARREL).owner === 9 && sys.countPlaces(ctx, 9) === 1, 'a barrel in the street granted to him is no property: he holds it, and still one property', said);
  said = grant(sys, R1, VIGGO);
  ok(rec(R1).owner === 9 && sys.countPlaces(ctx, 9) === 1, 'a room door in a public hall (no way to the world) is no property either', said);
  said = grant(sys, Q1, VIGGO);
  ok(rec(Q1).owner === 41 && /They already hold a property; one each/.test(said), 'a second house is refused: one property each', said);
  sys.maxClaims = 2;
  said = grant(sys, BARREL2, VIGGO);
  ok(rec(BARREL2).owner === 41 && /They already hold 2 chests and rooms of their own/.test(said), 'chests and rooms claimed on their own stay under housingMaxClaims', said);
  sys.maxClaims = 8;
  request(sys, STEWARD, 'abandon', Q1); request(sys, STEWARD, 'abandon', BARREL2);
  // The gameplay's view: anything inside answers the building
  sys.exposeTenancy(ctx);
  const G = globalThis.__dboHousing;
  ok(G.primaryOf(C2) === E1 && G.recordOf(C2).owner === 9 && G.primaryOf(U1) === E1 && G.primaryOf(I2) === E1, 'the gameplay asks a chest or an inner door upstairs and is answered the building', [G.primaryOf(C2), G.primaryOf(U1)]);
  ok(G.primaryOf(BARREL) === BARREL && G.primaryOf(R1) === R1, '...a claim outside any building answers itself');
  const g = G.grant(Z1, VIGGO);
  ok(/one each/.test(g) && !(rec(Z1) && rec(Z1).owner), 'renting him a house nobody ever claimed is refused too: it is a building', g);
  // Place-wide actions from an unclaimed chest act on the building
  menus.length = 0;
  said = request(sys, VIGGO, 'rename', C2, { name: 'Hux Hall' });
  ok(rec(E1).name === 'Hux Hall' && !rec(C2), 'renaming from the chest upstairs names the building', said);
  ok(menus.length === 1 && menus[0].target === C2 && menus[0].name === 'Hux Hall', '...and the menu that comes back is still on that chest', menus);
  said = request(sys, STEWARD, 'claim', C2);
  ok(!rec(C2) && /part of Hux Hall/.test(said), 'not even an official claims a chest inside it apart', said);
  // The menu at an unclaimed chest answers for that chest
  menus.length = 0;
  sys.sendMenu(ctx, USER[VIGGO], VIGGO, C1);
  const m = menus[0] || {};
  ok(m.target === C1 && m.view === 'owner' && m.name === 'Hux Hall' && m.locked === false && m.place && m.place.root === E1, "the menu at the chest is the building's, aimed at that chest", m);
  // Locks inside: one door or chest alone
  said = request(sys, STRANGER, 'lock', C1);
  ok(!rec(C1) && /no key/.test(said), 'a stranger cannot lock a chest in his house, and nothing is written', said);
  said = request(sys, VIGGO, 'unlock', C1);
  ok(!rec(C1) && /not locked/.test(said), 'unlocking a chest nobody locked writes nothing', said);
  said = request(sys, VIGGO, 'lock', C2);
  ok(rec(C2) && rec(C2).owner === 9 && rec(C2).memberOf === E1 && rec(C2).locked === true && rec(E1).locked === false, 'Viggo locks the chest upstairs: it alone, now a member of the house', rec(C2));
  ok(sys.countPlaces(ctx, 9) === 1 && sys.countLoose(ctx, 9) === 2, '...which counts for nothing: still one property, and the barrel and the room door loose', [sys.countPlaces(ctx, 9), sys.countLoose(ctx, 9)]);
  ok(sys.onActivate(ctx, C2, STRANGER) === false && sys.onActivate(ctx, C1, STRANGER) === false && sys.onActivate(ctx, C1, VIGGO) === true, 'the chests are his: a stranger opens neither, he opens the unlocked one');
  request(sys, VIGGO, 'lock', U1);
  ok(rec(U1) && rec(U1).locked === true && rec(E1).locked === false && rec(E2).locked === false, 'locking the door upstairs locks that door alone');
  ok(G.primaryOf(X1) === E1, "the door into the shop next door is the house's, by its half inside", G.primaryOf(X1));
  request(sys, VIGGO, 'lock', X1);
  ok(rec(X1) && rec(X1).memberOf === E1 && rec(X1).locked === true && JSON.stringify(rec(E1).place.cells) === JSON.stringify([HOUSE, UP]), '...he locks it from the menu (aimed at its record half), and the shop stays out of the house', rec(X1));
  request(sys, VIGGO, 'unlock', X1);
  request(sys, VIGGO, 'unlock', U1);
  request(sys, VIGGO, 'lock', E1);
  ok(rec(E1).locked === true && rec(E2).locked === true && rec(U1).locked === false && rec(C2).locked === true, 'locking the front door locks every way in, not the door upstairs; the chest keeps its own lock', [rec(E2).locked, rec(U1).locked]);
  request(sys, VIGGO, 'unlock', E1);
  ok(rec(E1).locked === false && rec(E2).locked === false, '...and unlocking it unlocks every way in');
  // A faction's hall (gameplay guilds.js __dboHallMember): its members use the house as its owner does, nothing more
  const HALL = typeof HousingSystem.prototype.inHall === 'function';
  if (HALL) {
    ok(sys.onActivate(ctx, C1, WHISPER) === false, 'before the house is a hall, a guild member cannot open its chest');
    globalThis.__dboHallMember = (refs, owner, actor) => refs.includes(E1) && owner === 9 && actor === WHISPER;
    ok(sys.onActivate(ctx, C1, WHISPER) === true && sys.onActivate(ctx, C1, STRANGER) === false, "as the guild's hall: a member opens the chest downstairs, a stranger still cannot");
    said = request(sys, WHISPER, 'lock', C1);
    ok(rec(C1) && rec(C1).locked === true && rec(C1).owner === 9, '...the member locks it (it stays the owner\'s)', said);
    request(sys, WHISPER, 'unlock', C1);
    ok(rec(C1).locked === false, '...and unlocks it');
    said = request(sys, WHISPER, 'transfer', C1, { recipient: WHISPER });
    ok(rec(E1).owner === 9 && /not yours to hand over/.test(said), 'a member cannot hand the hall over', said);
    said = request(sys, WHISPER, 'rename', C1, { name: 'Mine Now' });
    ok(rec(E1).name === 'Hux Hall' && /not yours to name/.test(said), '...nor rename it', said);
    said = request(sys, WHISPER, 'abandon', C2);
    ok(rec(E1).owner === 9 && /not yours to give up/.test(said), '...nor give it up', said);
    delete globalThis.__dboHallMember;
    ok(sys.onActivate(ctx, C1, WHISPER) === false, 'no longer a hall: the member is a stranger again');
  }
  // Handing the building over from the chest downstairs: everything inside goes with it
  said = request(sys, VIGGO, 'transfer', C1, { recipient: STRANGER });
  ok(rec(E1).owner === 51 && rec(E2).owner === 51 && rec(C2).owner === 51 && rec(U1).owner === 51 && rec(X1).owner === 51 && (!rec(C1) || rec(C1).owner === 51), 'handed over from a chest inside: the house, its back door and the locked chest and door go to the buyer', said);
  ok(rec(BARREL).owner === 9 && rec(R1).owner === 9 && sys.countPlaces(ctx, 9) === 0, "...Viggo's barrel and room door stay his; he holds no property now");
  ok(sys.onActivate(ctx, C1, STRANGER) === true && sys.onActivate(ctx, C1, VIGGO) === false, 'the chest nobody claimed opens for the buyer now, not for Viggo');
  said = request(sys, STRANGER, 'abandon', C1);
  ok(rec(E1).owner === 0 && rec(E2).owner === 0 && rec(C2).owner === 0 && rec(U1).owner === 0 && !rec(E1).place, 'giving it up from the chest gives up the building and all inside it', said);
  // Staff claims are left as they are, and staff are over no cap
  props.set(`${S1}:private.housing`, { owner: 4, ownerName: 'Akatosh', name: null, locked: false, serial: 1, partner: H(0x401), containers: [], issued: [] });
  sys.claimed.push(S1);
  sys.ensurePlace(ctx, S1, sys.read(ctx, S1));
  ok(rec(S1).owner === 4 && !rec(S1).place && sys.overCap(ctx, 4, AKATOSH, false, true) === '', "staff's house builds no place, and staff take more than one");

  // Dryrun: nothing of this
  sys = build('dryrun');
  grant(sys, E1, VIGGO);
  sys.exposeTenancy(ctx);
  ok(!rec(E1).place && globalThis.__dboHousing.primaryOf(C2) === C2, 'dryrun: no place, and a chest answers itself');
  said = request(sys, VIGGO, 'lock', C1);
  ok(!rec(C1) && /Claim it first/.test(said), "dryrun: a chest nobody claimed has no lock, as today", said);
  menus.length = 0;
  sys.sendMenu(ctx, USER[VIGGO], VIGGO, C1);
  ok(menus[0] && menus[0].target === C1 && menus[0].owned === false, "dryrun: the chest's menu is today's", menus[0]);

  // The migration plan lists over the cap only owners of two buildings
  sys = build('dryrun');
  const put = (r, o) => { props.set(`${r}:private.housing`, Object.assign({ owner: 0, ownerName: '', name: null, locked: false, serial: 1, partner: 0, containers: [], issued: [] }, o)); sys.claimed.push(r); const p = byId.get(r).partner; if (p) props.set(`${p}:private.housing`, { primary: r }); };
  put(E1, { owner: 9, ownerName: 'Viggo', partner: H(0x101) });
  put(BARREL, { owner: 9, ownerName: 'Viggo' });
  put(R1, { owner: 9, ownerName: 'Viggo', partner: H(0x303) });
  sys.dryRunPlaces(ctx);
  let plan = JSON.parse(fs.readFileSync('housing-places-plan.json', 'utf8'));
  ok(plan.overCap.length === 0 && plan.places.length === 3, 'a house, a barrel and a room door: listed, and over no cap', plan.overCap);
  put(Q1, { owner: 9, ownerName: 'Viggo', partner: H(0x201) });
  sys.dryRunPlaces(ctx);
  plan = JSON.parse(fs.readFileSync('housing-places-plan.json', 'utf8'));
  ok(plan.overCap.length === 1 && plan.overCap[0].owner === 9 && JSON.stringify(plan.overCap[0].places) === JSON.stringify([E1, Q1]), 'two houses: listed for Nate with the two houses only', plan.overCap);
} finally {
  process.chdir(home);
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
