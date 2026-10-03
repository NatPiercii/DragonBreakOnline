// A whole place counts as one property (fork housingSystem.ts ensurePlace / carryPlace / release; Nate's N3, 3 Oct), only
// with housingPlaceMigration "apply": a door from the world into an interior, once claimed, becomes a place holding the
// interior and the rooms reachable only through it (not another building, not a dungeon complex); its other entrances join
// it, locked as it is; nothing inside can be claimed apart; handing over, naming, keys and giving up act on the whole place
// from any of its doors; locking one door locks them all; giving it up gives up every member. Staff claims build nothing.
//   node tests/housing-places-build-harness.js <bundled housingSystem.js>
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const bundle = process.argv[2];
if (!bundle) { console.error('usage: node tests/housing-places-build-harness.js <bundled housingSystem.js>'); process.exit(2); }
const { HousingSystem } = require(path.resolve(bundle));
if (typeof HousingSystem.prototype.ensurePlace !== 'function') { require('./expect')('housing-places-build', 'this housingSystem builds no places'); console.log('skipped: no place building in this housingSystem'); process.exit(0); }
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${what}${!c && got !== undefined ? '   ' + JSON.stringify(got).slice(0, 500) : ''}`); if (!c) fails++; };
const H = (n) => (0x08000000 | n) >>> 0;
const WORLD = 'a764b:BSHeartland.esm', HOUSE = '67652:BSHeartland.esm', BASEMENT = '67653:BSHeartland.esm', HALL = '20e9:BSHeartland.esm';
const D = ['d1:BSHeartland.esm', 'd2:BSHeartland.esm', 'd3:BSHeartland.esm', 'd4:BSHeartland.esm', 'd5:BSHeartland.esm', 'd6:BSHeartland.esm'];
// refs: [id, cell, type, partner]
const REFS = [];
const ref = (id, cell, type, partner) => { REFS.push({ id: H(id), cell, type, partner: partner ? H(partner) : 0 }); return H(id); };
const E1 = ref(0x100, WORLD, 'DOOR', 0x101), I1 = ref(0x101, HOUSE, 'DOOR', 0x100);   // the front door
const E2 = ref(0x102, WORLD, 'DOOR', 0x103), I2 = ref(0x103, HOUSE, 'DOOR', 0x102);   // a back door, unclaimed
const B1 = ref(0x104, HOUSE, 'DOOR', 0x105), B2 = ref(0x105, BASEMENT, 'DOOR', 0x104); // to the cellar
const X1 = ref(0x106, HOUSE, 'DOOR', 0x107), X2 = ref(0x107, HALL, 'DOOR', 0x106);     // into a hall with its own street door
const W1 = ref(0x108, HALL, 'DOOR', 0x109), W2 = ref(0x109, WORLD, 'DOOR', 0x108);
const C1 = ref(0x10a, HOUSE, 'CONT'), C2 = ref(0x10b, BASEMENT, 'CONT'), C3 = ref(0x10c, HALL, 'CONT');
// A fort above a five-level dungeon: the walk keeps the fort's first interior only
const F1 = ref(0x200, WORLD, 'DOOR', 0x201), F2 = ref(0x201, D[0], 'DOOR', 0x200);
for (let i = 0; i < 5; i++) { ref(0x210 + 2 * i, D[i], 'DOOR', 0x211 + 2 * i); ref(0x211 + 2 * i, D[i + 1], 'DOOR', 0x210 + 2 * i); }
// Staff's house
const S1 = ref(0x300, WORLD, 'DOOR', 0x301), S2 = ref(0x301, '62131:BSHeartland.esm', 'DOOR', 0x300);
// An interior two street doors open onto (review G): one is Tavia's (77), one nobody's; and one shared with staff (4)
const SHARED = '67670:BSHeartland.esm', STAFFHALL = '67680:BSHeartland.esm';
const T1 = ref(0x400, WORLD, 'DOOR', 0x401), T2 = ref(0x401, SHARED, 'DOOR', 0x400), U1 = ref(0x402, WORLD, 'DOOR', 0x403), U2 = ref(0x403, SHARED, 'DOOR', 0x402);
const SHAREDBOX = ref(0x404, SHARED, 'CONT');
const K1 = ref(0x410, WORLD, 'DOOR', 0x411), K2 = ref(0x411, STAFFHALL, 'DOOR', 0x410), V1 = ref(0x412, WORLD, 'DOOR', 0x413), V2 = ref(0x413, STAFFHALL, 'DOOR', 0x412);
const byId = new Map(REFS.map((r) => [r.id, r]));
const STEWARD = 0xff000041, NEWBIE = 0xff000009, STRANGER = 0xff000051, AKATOSH = 0xff000004;
const PROFILE = { [STEWARD]: 41, [NEWBIE]: 9, [STRANGER]: 51, [AKATOSH]: 4 };
const USER = { [STEWARD]: 5, [NEWBIE]: 2, [STRANGER]: 3, [AKATOSH]: 4 };
let props, notices, logs;
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
  sendCustomPacket: (u, raw) => { const p = JSON.parse(raw); if (p.customPacketType === 'propertyNotice') notices.push(p.text); },
};
const ctx = { svr: mp };
const build = (mode) => {
  props = new Map(); notices = []; logs = [];
  const sys = new HousingSystem((...a) => logs.push(a.join(' ')));
  sys.placeMigration = mode;
  sys.roleCfg = { tierRoles: { senior: [], developer: [], leadgm: [], gm: [] }, adminRoleIds: [], adminProfileIds: [] };
  sys.holdOf = () => 'bruma';
  sys.holdRanks = (c, a) => (a === STEWARD ? [{ hold: 'bruma', rank: 'steward' }] : []);
  sys.saveRegistry = () => {};
  sys.baseTypeOf = (c, id) => (byId.get(id >>> 0) ? byId.get(id >>> 0).type : '');
  sys.partnerOf = (c, id) => (byId.get(id >>> 0) ? byId.get(id >>> 0).partner : 0);
  sys.withinReach = () => true;
  sys.sendMenu = () => {};
  sys.claimed = [];
  return sys;
};
const rec = (r) => props.get(`${r}:private.housing`);
const request = (sys, who, action, target, extra) => { notices.length = 0; sys.onPropertyRequest(ctx, USER[who], Object.assign({ action, target }, extra || {})); sys.lastRequestMs.clear(); return notices.join(' | '); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-placesbuild-'));
const home = process.cwd();
process.chdir(dir);
try {
  fs.writeFileSync('gamemode-config.json', JSON.stringify({ housingPlaces: { staffProfiles: [4] } }));
  let sys = build('apply');
  let said = request(sys, STEWARD, 'claim', E1);
  const root = rec(E1);
  ok(root && root.owner === 41 && root.place && JSON.stringify(root.place.cells) === JSON.stringify([HOUSE, BASEMENT]), 'the claimed front door becomes a place: the house and its cellar, not the hall with its own street door', root && root.place);
  ok(/with everything behind its doors/.test(said), '...and the claimer is told so', said);
  ok(rec(E2) && rec(E2).memberOf === E1 && rec(E2).owner === 41 && rec(I2).primary === E2, 'the unclaimed back door joins it as a member pair');
  ok(!rec(W1) && !rec(W2) && !rec(X1) && !rec(B1), 'the hall door and the inner doors are not claimed (they follow the place by cell)');
  said = request(sys, STEWARD, 'claim', C1);
  ok(!rec(C1) && /part of .*its owner assigns it/.test(said), 'a chest inside the place cannot be claimed apart', said);
  said = request(sys, STEWARD, 'claim', C3);
  ok(rec(C3) && rec(C3).owner === 41, '...a chest in the hall (another building) still can', said);
  request(sys, STEWARD, 'abandon', C3);
  // Lock from the back door: every door of the place locks
  request(sys, STEWARD, 'lock', E2);
  ok(rec(E1).locked === true && rec(E2).locked === true, 'locking the back door locks the front door too');
  // Rename from the back door: the root is named
  request(sys, STEWARD, 'rename', I2, { name: 'Valerio Residence' });
  ok(rec(E1).name === 'Valerio Residence' && !rec(E2).name, 'renaming from the back door names the place (its root)');
  // Hand it over from the back door: the whole place goes, re-keyed
  const serialBefore = rec(E2).serial;
  said = request(sys, STEWARD, 'transfer', E2, { recipient: NEWBIE });
  ok(rec(E1).owner === 9 && rec(E2).owner === 9 && rec(E2).memberOf === E1 && rec(E2).serial > serialBefore, 'handing over from the back door hands over the whole place, every door re-keyed', [rec(E1), rec(E2)]);
  // Give it up: every member goes
  said = request(sys, NEWBIE, 'abandon', E2);
  ok(rec(E1).owner === 0 && !rec(E1).place && rec(E2).owner === 0 && !rec(E2).memberOf, 'giving it up from any door gives up the whole place', [rec(E1), rec(E2)]);
  ok(sys.placeIndex(ctx).size === 0, '...and no cell answers to it any more');

  // A fort above a dungeon complex keeps its first interior only
  sys = build('apply');
  request(sys, STEWARD, 'claim', F1);
  ok(rec(F1) && rec(F1).place && JSON.stringify(rec(F1).place.cells) === JSON.stringify([D[0]]), 'a door into a five-level complex keeps only the first interior', rec(F1) && rec(F1).place);
  // Staff: nothing is built
  sys = build('apply');
  sys.openClaims = true;
  request(sys, AKATOSH, 'claim', S1);
  ok(rec(S1) && rec(S1).owner === 4 && !rec(S1).place, "a staff profile's claim stays a plain claim");
  // dryrun: a plain claim, as today
  sys = build('dryrun');
  request(sys, STEWARD, 'claim', E1);
  ok(rec(E1) && rec(E1).owner === 41 && !rec(E1).place && !rec(E2), 'dryrun: the claim builds no place and claims no other door');
  // Review G: an interior another owner's street door also opens onto is nobody's place, whoever claims or receives it
  sys = build('apply');
  props.set(`${T1}:private.housing`, { owner: 77, ownerName: 'Tavia', name: null, locked: false, serial: 1, partner: T2, containers: [], issued: [] });
  props.set(`${T2}:private.housing`, { primary: T1 });
  sys.claimed.push(T1);
  said = request(sys, STEWARD, 'claim', U1);
  ok(rec(U1) && rec(U1).owner === 41 && !rec(U1).place && !/everything behind/.test(said), "claiming the other street door into Tavia's interior: a plain claim, no place", [rec(U1), said]);
  request(sys, STEWARD, 'transfer', U1, { recipient: NEWBIE });
  ok(rec(U1).owner === 9 && !rec(U1).place && sys.placeIndex(ctx).size === 0 && logs.some((l) => /builds no place: 67670.* also behind Tavia's door/.test(l)), '...handed over: still no place, and the log names whose door it is', logs.filter((l) => /builds no place/.test(l)));
  ok(sys.onActivate(ctx, SHAREDBOX, STRANGER) === true, "...so the chest in the shared interior is nobody's to lock away");
  props.set(`${K1}:private.housing`, { owner: 4, ownerName: 'Akatosh', name: null, locked: false, serial: 1, partner: K2, containers: [], issued: [] });
  props.set(`${K2}:private.housing`, { primary: K1 });
  sys.claimed.push(K1);
  request(sys, STEWARD, 'claim', V1);
  ok(rec(V1) && !rec(V1).place, "an interior a staff profile's door opens onto counts as another owner's too");
  // The tenancy grant builds the place too
  sys = build('apply');
  sys.exposeTenancy(ctx);
  ok(globalThis.__dboHousing.grant(E1, NEWBIE) === '' && rec(E1).owner === 9 && rec(E1).place && rec(E2).memberOf === E1 && rec(E2).owner === 9, 'a tenancy grant of the front door grants the whole place');
  ok(globalThis.__dboHousing.primaryOf(E2) === E1 && globalThis.__dboHousing.primaryOf(I2) === E1 && globalThis.__dboHousing.recordOf(E2).name === rec(E1).name, '...and for tenancy any door of it stands for the whole place (a listing at the back door rents the house)');
  ok(globalThis.__dboHousing.release(E2) === true && rec(E1).owner === 0 && rec(E2).owner === 0, '...so an eviction at the back door frees all of it');
} finally {
  process.chdir(home);
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
