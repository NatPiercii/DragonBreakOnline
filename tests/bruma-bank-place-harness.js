// The Bruma bank (CYRBrumaBank, 130040:DragonBreak Online Edits.esp) counts as Bruma everywhere, not only in the region
// lock (Nate, 2026-09-30: "BrumaBank, is it a part of Bruma?"):
//   provinces  regions.js placeOf: Cyrodiil (regions-overrides.json places), where it fell to defaultPlace Skyrim
//   zone       gamemode.js zoneOfActor: Bruma (zone-cells.json, hot-reloadable; zones.json is untouched because the
//              fork's zones.ts reads it only at boot), where it fell to wherever the player last stood outside
//   doors      doors.json names its two load doors: "Bruma" from inside, "Bank of Bruma" from outside
// Each is checked live-then-new: the version before the change first (pinned to 17777668, the last server tree without
// it; origin/server carries it since release-1006), then this branch's over the same globalThis state, as a hot reload
// (or the overrides file's save) would do it on the live server.
//   node tests/bruma-bank-place-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const SERVER = path.resolve(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruma-bank-place-'));
process.chdir(dir);
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });

let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got)}`); if (!c) fails++; };
const BANK = '130040:DragonBreak Online Edits.esp';
const BRUMA = 'a764b:BSHeartland.esm';
const JERALL_INN = '6c3d7:BSHeartland.esm';        // any BSHeartland interior
const WHITERUN = '3c:Skyrim.esm';
// The tree before the change, when git can show it; else the before-checks are skipped and the rest run new-only. A
// before tree that already holds the change (BEFORE pointed at a later commit) is skipped the same way, and says so.
const BEFORE = process.env.BANK_BEFORE || '17777668';
const show = (f) => { try { return execFileSync('git', ['-C', SERVER, 'show', `${BEFORE}:${f}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { return null; } };
const beforeHasIt = /130040:DragonBreak Online Edits\.esp/i.test(show('regions-overrides.json') || '') || /zoneOfCell/.test(show('gamemode.js') || '');
if (beforeHasIt) console.log(`ok    skipped the before-checks: ${BEFORE} already holds the bank change`);
const before = (f) => (beforeHasIt ? null : show(f));

// ---- provinces: regions.js ----
fs.copyFileSync(path.join(SERVER, 'regions.json'), path.join(dir, 'regions.json'));
const mp = { get: () => undefined, set: () => {}, getIdFromDesc: () => 0, getDescFromId: () => '', lookupEspmRecordById: () => null };
const REGIONS = path.join(SERVER, 'regions.js');
const loadRegions = () => { delete require.cache[REGIONS]; require(REGIONS)({ mp, log: () => {}, personal: () => {}, audit: () => {}, who: String, cfg: { regions: { defaultPlace: 'skyrim' } }, registerChatCommand: () => {}, isAdmin: () => false, sendPacket: () => {} }); return globalThis.__dboRegions; };
const realNow = Date.now; let now = realNow(); Date.now = () => now;
const oldOvr = before('regions-overrides.json');
delete globalThis.__dboRegionsState;
// Since the PC's regions.json rebuild (9 Oct, the smithing records) regions.json itself tags the bank Cyrodiil, so the
// old overrides no longer leave it to the default: the before-check then says what the data says
const regionsTagsBank = /"130040:DragonBreak Online Edits\.esp"/i.test(JSON.stringify((JSON.parse(fs.readFileSync(path.join(SERVER, 'regions.json'), 'utf8')).places || {}).cells || {}));
if (oldOvr) {
  fs.writeFileSync('regions-overrides.json', oldOvr);
  const R = loadRegions();
  const p = R.placeOf(BANK);
  if (regionsTagsBank) ok(p.province === 'cyrodiil' && p.source === 'cell', 'before the change: regions.json itself now tags the bank Cyrodiil (the 9 Oct rebuild)', p);
  else ok(p.province === 'skyrim' && p.source === 'default', 'before the change the bank falls to the default province, Skyrim', p);
}
// The new overrides file is saved over it: regions.js re-reads it within 2 s, no reload
fs.writeFileSync('regions-overrides.json', fs.readFileSync(path.join(SERVER, 'regions-overrides.json')));
fs.utimesSync('regions-overrides.json', new Date(), new Date(realNow() + 5000));
now += 3000;
let R = globalThis.__dboRegions || loadRegions();
let p = R.placeOf(BANK);
ok(p.province === 'cyrodiil' && p.source === 'override', 'once the overrides file is saved the bank is Cyrodiil, without a reload', p);
R = loadRegions();                                   // and a hot reload over the same state
p = R.placeOf(BANK);
ok(p.province === 'cyrodiil' && p.source === 'override', '...and after a hot reload over that state', p);
ok(R.placeOf(BANK.toLowerCase()).province === 'cyrodiil', 'the key matches whatever case the desc comes in');
ok(R.placeOf(JERALL_INN).province === 'cyrodiil' && R.placeOf(BRUMA).province === 'cyrodiil', 'Bruma itself and its other interiors are unchanged (Cyrodiil)');
ok(R.placeOf('1f2c8:Skyrim.esm').province === 'skyrim' && R.placeOf('12345:DragonBreak Online Edits.esp').province === 'skyrim', 'Skyrim cells, and other interiors of the same plugin, are unchanged');
Date.now = realNow;

// ---- the zone: gamemode.js zoneOfActor ----
const gm = fs.readFileSync(path.join(SERVER, 'gamemode.js'), 'utf8');
const slice = (src) => {
  const a0 = src.indexOf('// Tamriel and its city worldspaces share one coordinate frame');
  const b0 = src.indexOf('// ---- /unstuck', a0);
  return a0 >= 0 && b0 > a0 ? src.slice(a0, b0) : null;
};
const zonesOf = (src) => JSON.parse(src);
const props = new Map();
const zoneFns = (code, ZONES) => new Function('ZONES', 'mp', 'normPlace', 'recordOf', 'every', 'onlineActors', 'fs', 'path', 'log',
  `${code}\nreturn { zoneOfActor, zoneAtPlace };`)(
  ZONES,
  { get: (a, k) => props.get(`${a}|${k}`), set: (a, k, v) => props.set(`${a}|${k}`, v), getIdFromDesc: (d) => d },
  (d) => { const s = String(d || ''); const i = s.indexOf(':'); return i < 0 ? s.toLowerCase() : (parseInt(s.slice(0, i), 16).toString(16) + ':' + s.slice(i + 1).toLowerCase()); },
  // Only worldspaces are WRLD records here
  (d) => ({ record: { type: [BRUMA, WHITERUN, '6ade1:BSHeartland.esm'].map((x) => x.toLowerCase()).includes(String(d).toLowerCase()) ? 'WRLD' : 'CELL' } }),
  () => {}, () => [], fs, path, () => {});
const A = 0xff000014, B = 0xff000015;
const put = (a, world, pos, last) => { props.set(`${a}|worldOrCellDesc`, world); props.set(`${a}|pos`, pos); props.set(`${a}|private.lastOutside`, last); };
const oldGm = before('gamemode.js'), oldZones = before('zones.json');
if (oldGm && oldZones && slice(oldGm)) {
  const Z0 = zoneFns(slice(oldGm), zonesOf(oldZones));
  put(A, BANK, [0, 0, 0], { world: WHITERUN, pos: [20000, -10000, 0] });
  put(B, BANK, [0, 0, 0], null);
  ok(Z0.zoneOfActor(A) === 'whiterun' && Z0.zoneOfActor(B) === null, 'before the change the bank takes the zone of where you last stood outside (Whiterun here), or none', [Z0.zoneOfActor(A), Z0.zoneOfActor(B)]);
}
fs.copyFileSync(path.join(SERVER, 'zone-cells.json'), path.join(dir, 'zone-cells.json'));
const code = slice(gm);
ok(!!code, 'the zone block is where the harness expects it in gamemode.js');
const Z = zoneFns(code, zonesOf(fs.readFileSync(path.join(SERVER, 'zones.json'), 'utf8')));
put(A, BANK, [0, 0, 0], { world: WHITERUN, pos: [20000, -10000, 0] });
put(B, BANK, [0, 0, 0], null);
ok(Z.zoneOfActor(A) === 'bruma' && Z.zoneOfActor(B) === 'bruma', 'in the bank you are in Bruma, wherever you last stood outside', [Z.zoneOfActor(A), Z.zoneOfActor(B)]);
ok(Z.zoneAtPlace(BANK, [0, 0, 0]) === 'bruma', 'zoneAtPlace names the bank Bruma too');
put(A, BRUMA, [55000, 200000, 0], null);
ok(Z.zoneOfActor(A) === 'bruma', 'Bruma outdoors is unchanged');
put(A, JERALL_INN, [0, 0, 0], null);
ok(Z.zoneOfActor(A) === 'bruma', "Bruma's other interiors are unchanged (by their plugin)");
put(A, WHITERUN, [20000, -10000, 0], null);
ok(Z.zoneOfActor(A) === 'whiterun', 'a Tamriel position still goes to its nearest hold');
put(A, '12345:DragonBreak Online Edits.esp', [0, 0, 0], { world: WHITERUN, pos: [20000, -10000, 0] });
ok(Z.zoneOfActor(A) === 'whiterun', 'another interior of the same plugin still falls back to where you last stood outside');

// ---- the doors ----
const doors = JSON.parse(fs.readFileSync(path.join(SERVER, 'doors.json'), 'utf8')).doors;
ok(doors['1300aa:DragonBreak Online Edits.esp'] === 'Bruma', 'the bank door inside reads "Bruma" (it leads out to Bruma)');
ok(doors['1300d7:DragonBreak Online Edits.esp'] === 'Bank of Bruma', 'the bank door in Bruma reads "Bank of Bruma" (the cell\'s own name)');
const oldDoors = before('doors.json');
if (oldDoors) {
  const o = JSON.parse(oldDoors).doors;
  const added = Object.keys(doors).filter((k) => !(k in o));
  // Names of existing doors may change later (door-names-harness.js owns them); the bank change added exactly its two
  ok(['1300aa:DragonBreak Online Edits.esp', '1300d7:DragonBreak Online Edits.esp'].every((k) => added.includes(k)) && Object.keys(o).every((k) => k in doors), 'the bank change added its two doors to doors.json and removed none', { added: added.slice(0, 5) });
}
ok(JSON.parse(fs.readFileSync(path.join(SERVER, 'zone-cells.json'), 'utf8'))[BANK] === 'bruma', 'zone-cells.json gives the bank cell to Bruma');
if (oldZones) ok(fs.readFileSync(path.join(SERVER, 'zones.json'), 'utf8') === oldZones, 'zones.json is unchanged since before the change (restart-only: the fork reads it at boot)');
// A zone-cells.json that is missing or broken leaves the old fallback, and says so
fs.writeFileSync(path.join(dir, 'zone-cells.json'), '{ broken');
const logs = [];
const Zb = new Function('ZONES', 'mp', 'normPlace', 'recordOf', 'every', 'onlineActors', 'fs', 'path', 'log', `${code}\nreturn { zoneOfActor };`)(
  zonesOf(fs.readFileSync(path.join(SERVER, 'zones.json'), 'utf8')), { get: (a, k) => props.get(`${a}|${k}`), set: () => {} },
  (d) => String(d).toLowerCase(), () => ({ record: { type: 'CELL' } }), () => {}, () => [], fs, path, (...x) => logs.push(x.join(' ')));
put(B, BANK, [0, 0, 0], null);
ok(Zb.zoneOfActor(B) === null && logs.some((l) => /zone-cells.json unreadable/.test(l)), 'a broken zone-cells.json is logged and changes nothing else');

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
