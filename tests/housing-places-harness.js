// The place migration dry run (fork housingSystem.ts dryRunPlaces + housingPlaces.ts planPlaces; Nate's N3, 3 Oct): each
// owner's claims behind one exterior door become one place, a lone chest is a place of its own, owners left with more than
// one place are listed for Nate (nothing taken), and the open chests inside a house are named (they become owner-only).
// Dry run only: no record is written. Built from the live claims of 3 Oct (Fort Caractacus, Akatosh, two chests sharing a
// room).
//   node tests/housing-places-harness.js <bundled housingSystem.js>
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const bundle = process.argv[2];
if (!bundle) { console.error('usage: node tests/housing-places-harness.js <bundled housingSystem.js>'); process.exit(2); }
const { HousingSystem } = require(path.resolve(bundle));
if (typeof HousingSystem.prototype.dryRunPlaces !== 'function') { require('./expect')('housing-places', 'this housingSystem has no place dry run'); console.log('skipped: no place dry run in this housingSystem'); process.exit(0); }
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${what}${!c && got !== undefined ? '   ' + JSON.stringify(got).slice(0, 600) : ''}`); if (!c) fails++; };

const H = (n) => (0x08000000 | n) >>> 0;   // BSHeartland.esm
const WORLD = 'a764b:BSHeartland.esm', FORT = 'b5936:BSHeartland.esm', DAVIUS = '62131:BSHeartland.esm', CATHEDRAL = '12cb:BSHeartland.esm', ROOM = '6ff7d:BSHeartland.esm';
const props = new Map();
const writes = [];
const cells = new Map();
const rec = (owner, ownerName, name, locked, partner) => ({ owner, ownerName, name, locked, serial: 2, partner, containers: [], issued: [] });
const claims = [];
const claim = (ref, cell, r, partnerCell) => { claims.push(ref); props.set(`${ref}:private.housing`, r); cells.set(ref, cell); if (r.partner) { cells.set(r.partner, partnerCell); props.set(`${r.partner}:private.housing`, { primary: ref }); } };
// Fort Caractacus: Kojus (60), six door pairs into the fort, one unlocked chest inside
claim(H(0xb5c6e), FORT, rec(60, 'Kojus Animus', 'Fort Caractacus', true, H(0xb5fe6)), WORLD);
claim(H(0xb5eac), WORLD, rec(60, 'Kojus Animus', null, true, H(0xb5eae)), FORT);
claim(H(0xb5ead), WORLD, rec(60, 'Kojus Animus', null, true, H(0xb5eb5)), FORT);
claim(H(0xb5f3e), FORT, rec(60, 'Kojus Animus', null, false, H(0xb5fe7)), WORLD);
claim(H(0xb5f55), FORT, rec(60, 'Kojus Animus', null, true, H(0xb5fea)), WORLD);
claim(H(0xb5f56), FORT, rec(60, 'Kojus Animus', null, true, H(0xb5fe9)), WORLD);
claim(H(0xb5c86), FORT, rec(60, 'Kojus Animus', null, false, 0));
// Akatosh (4): a house, a chest in the cathedral, an outdoor chest
claim(H(0x62169), DAVIUS, rec(4, 'Davius Phink', 'House of Davius Phink', true, H(0x62162)), WORLD);
claim(H(0x8b4c7), CATHEDRAL, rec(4, 'Akatosh', 'Chest of Akatosh', true, 0));
claim(H(0xb452a), WORLD, rec(4, 'Akatosh', 'Chest of Akatosh', false, 0));
// Two owners' chests in one room with no claimed door: each its own place
claim(H(0x7586e), ROOM, rec(35, 'Aldemar Vauclaire', null, true, 0));
claim(H(0x7586f), ROOM, rec(49, 'Elion', null, true, 0));
// A door pair between two interiors (a guild hall and its cellar), with no way to the world: no house, no place cells
const HALL = '20e9:BSHeartland.esm', CELLAR = '20ff:BSHeartland.esm';
claim(H(0x2f44), HALL, rec(77, 'Tavia', null, true, H(0x2f45)), CELLAR);
// An ownerless stub in the fort is no claim
claim(H(0xb5e59), FORT, rec(0, '', null, false, 0));
const descToId = (d) => { const [h, p] = String(d).split(':'); return (/bsheartland/i.test(p) ? 0x08000000 : 0) | parseInt(h, 16); };
const mp = {
  get: (id, k) => (k === 'worldOrCellDesc' ? cells.get(id >>> 0) : props.get(`${id >>> 0}:${k}`)),
  set: (id, k, v) => { writes.push([id, k]); props.set(`${id >>> 0}:${k}`, v); },
  getIdFromDesc: descToId,
  lookupEspmRecordById: (id) => ({ record: { type: (id >>> 0) === descToId(WORLD) ? 'WRLD' : 'CELL' } }),
};
const logs = [];
const sys = new HousingSystem((...a) => logs.push(a.join(' ')));
sys.claimed = claims.slice();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-places-'));
const home = process.cwd();
process.chdir(dir);
const done = sys.dryRunPlaces({ svr: mp });
const planFile = path.join(dir, 'housing-places-plan.json');
const plan = fs.existsSync(planFile) ? JSON.parse(fs.readFileSync(planFile, 'utf8')) : { places: [], overCap: [] };
process.chdir(home);
const place = (root) => plan.places.find((p) => p.root === H(root));
ok(done === true && writes.length === 0, 'the dry run finishes and writes no record', writes);
ok(plan.places.length === 7, '13 owned claims make 7 places (the stub is no claim)', plan.places.map((p) => p.root.toString(16)));
ok(place(0x2f44) && place(0x2f44).kind === 'interior door' && place(0x2f44).cells.length === 0 && place(0x2f44).openChests.length === 0, 'a door pair between two interiors is an "interior door": no place cells, so nothing in the shared building changes', place(0x2f44));
const fort = place(0xb5c6e);
ok(fort && fort.kind === 'house' && fort.name === 'Fort Caractacus' && fort.members.length === 6 && JSON.stringify(fort.cells) === JSON.stringify([FORT]), 'Fort Caractacus: one house rooted at the named door, its 5 other door pairs and the chest as members', fort);
ok(fort && JSON.stringify(fort.openChests) === JSON.stringify([H(0xb5c86)]), "...and its unlocked chest b5c86 is named: it becomes owner-only", fort && fort.openChests);
ok(place(0x62169) && place(0x62169).kind === 'house', "Akatosh's house is a house");
ok(place(0x8b4c7) && place(0x8b4c7).kind === 'interior chest' && place(0xb452a) && place(0xb452a).kind === 'outdoor chest', '...the cathedral chest and the outdoor chest are places of their own');
ok(place(0xb452a) && place(0xb452a).openChests.length === 0, 'an unlocked outdoor chest claim keeps its state (only chests inside a house become owner-only)');
ok(place(0x7586e) && place(0x7586f) && place(0x7586e).owner === 35 && place(0x7586f).owner === 49, 'two owners\' chests in one room stay two places, one each');
ok(plan.overCap.length === 1 && plan.overCap[0].owner === 4 && plan.overCap[0].places.length === 3, 'Akatosh is listed with 3 places for Nate; nobody else is', plan.overCap);
ok(logs.some((l) => /place plan \(dry run, nothing changed\): 13 owned claims -> 7 places/.test(l)) && logs.some((l) => /Davius Phink \/ Akatosh \(4\) would hold 3 places .*kept, for Nate to decide/.test(l)), 'the plan is in the log', logs.slice(0, 3));
ok(logs.some((l) => /Fort Caractacus" .*open chests becoming owner-only=80b5c86/.test(l)), '...with the chest that changes named');
// Not readable yet (right after boot): no plan, try again later
const sys2 = new HousingSystem(() => {});
sys2.claimed = [H(0x123)];
ok(sys2.dryRunPlaces({ svr: { get: () => undefined, set: () => {}, getIdFromDesc: () => 0, lookupEspmRecordById: () => null } }) === false, 'with no claim readable yet it reports not done, to try again');
// Records keep the place fields through read()
props.set(`${H(0x999)}:private.housing`, Object.assign(rec(7, 'X', null, false, 0), { place: { cells: [FORT], builtAt: 5 }, assigned: { 'b5c86': { profile: 9, name: 'Y' } }, keyAliases: ['Key to the Fort'] }));
const r = sys.read({ svr: mp }, H(0x999));
ok(r && r.place && r.place.cells[0] === FORT && r.assigned && r.assigned.b5c86.profile === 9 && r.keyAliases[0] === 'Key to the Fort', 'read() keeps place, assigned and keyAliases, so a later write does not drop them', r);
const r2 = sys.read({ svr: mp }, H(0xb5c6e));
ok(r2 && !('place' in r2) && !('assigned' in r2), '...and adds nothing to a record without them');
fs.rmSync(dir, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
