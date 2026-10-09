// Nate's Moranda and Sancre Tor Ruins (DLE 12393628, 8 Oct): Moranda is a lease dungeon with the Ayleid lich as its boss;
// Sancre Tor Ruins is the world dungeon, one respawning minotaur area whose chests are camp loot; ovens are Cook stations.
//   node tests/moranda-sancretor-harness.js   (from server/)
'use strict';
const fs = require('fs');
const path = require('path');
const SERVER = path.resolve(__dirname, '..');
process.chdir(SERVER);
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got)}`); if (!c) fails++; };
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const DLE = 'DragonBreak Online Edits.esp';

// ---- Sancre Tor Ruins: one area around its map marker -------------------------------------------------------------
const owned = read('owned-spawns.json');
const ST = `1833e2:${DLE}`;
const st = owned.spawns.filter((s) => s.group === ST);
const near = owned.spawns.filter((s) => s.kind === 'minotaur' && Math.hypot(s.pos[0] + 94.6, s.pos[1] - 195815) < 6000);
ok(st.length === 21 && st.every((s) => s.kind === 'minotaur'), 'Sancre Tor Ruins spawns 21 minotaurs', st.length);
ok(st.filter((s) => s.edid === 'CYREncMinotaur02Lord').length === 3, '...three of them Minotaur Lords');
ok(near.every((s) => s.group === ST), 'every minotaur in its six cells belongs to the one area (no per-cell camps)', near.filter((s) => s.group !== ST).map((s) => s.src));
const camp = owned.camps.find((c) => c.group === ST);
ok(camp && camp.name === 'Sancre Tor Ruins' && camp.chests.length === 8, 'its camp holds all 8 chests', camp && camp.chests.length);
ok(camp && camp.chests.filter((c) => /RuinsChestBoss/.test(c.edid)).length === 3, '...three of them the ruin\'s boss chests');
const chestRefs = owned.camps.flatMap((c) => c.chests.map((x) => x.ref));
ok(chestRefs.length === new Set(chestRefs).size, 'no chest is in two camps');
ok(!owned.spawns.some((s) => /^17e[01]/.test(s.src)), 'Moranda\'s interior actors are not open-world spawns (its lease spawns them)');

// ---- camp-mates: minotaurs are allies, as goblins are ---------------------------------------------------------------
const facs = read('gamemode-config.json').ownedSpawns.factions;
ok(JSON.stringify(facs.minotaur) === JSON.stringify(['3e093:Skyrim.esm', '8bb70:BSHeartland.esm']), 'minotaur spawns get CYRMinotaurFaction (allied to itself), so the area does not fight itself');

// ---- ovens are Cook stations ----------------------------------------------------------------------------------------
const cook = read('skills.json').skills.find((k) => k.id === 'cook');
ok(cook.gates.stations.includes('BYOHCraftingOven') && !cook.gates.stations.includes('BYOHOven'), 'ovens gate by their keyword BYOHCraftingOven (BYOHOven matched no record, so any oven was open to all)');
ok(cook.counts.craftKeywords.includes('BYOHCraftingOven'), '...and baking still counts for Cook');

// ---- Moranda: a lease through its own door, the lich its boss -----------------------------------------------------
const os = require('os');
const dj = read('dungeons.json').dungeons;
const mor = dj.find((d) => d.id === 'CYRAyleidRuinMorandaLocation');
ok(mor && mor.name === 'Moranda' && mor.type === 'ayleid', 'Moranda is a dungeon (an Ayleid ruin)', mor && [mor.name, mor.type]);
const ent = mor.entrances[0];
ok(ent.outsideDesc === `17e115:${DLE}` && ent.insideDesc === `17e116:${DLE}` && ent.insideCell === `17e0bc:${DLE}`, 'its entrance is Nat\'s door pair into CYRAyleidRuinMoranda');
const npcs = mor.zones.flatMap((z) => z.npcs);
const refs = new Set(npcs.map((n) => n.ref.split(':')[0]));
ok(npcs.length === 10 && ['17e11a', '17e11b', '17e11d', '17e16c', '18dbec', '18dbed', '18dbee', '18dbef', '18dbf0', '18dbf1'].every((r) => refs.has(r)), 'its 10 living placements are enemies: Nat\'s Ayleid undead and the lich (DLE 0d765a53; the two bandits are Starts Dead bodies)', [...refs]);
ok(!['17e0d8', '17e118', '17e119', '17e11e', '17e11f'].some((r) => refs.has(r)), '...and none of the five generic skeletons Nat removed');
const lich = npcs.find((n) => n.edid === 'BSKEncAyleidLich');
ok(lich && lich.boss === true && lich.ref === `17e16c:${DLE}` && Array.isArray(lich.storyOptions), 'the Ayleid lich is its boss, with a Novice line of its own');
ok(mor.chests.filter((c) => /ChestBoss/.test(c.edid)).some((c) => Math.hypot(c.pos[0] - lich.pos[0], c.pos[1] - lich.pos[1]) < 700), 'a boss chest stands beside the lich');
const replaced = read('tooling/ck-mcp/actors_server_replaced.json').refs;
ok(['17E117', '17E11A', '17E11B', '17E11D', '17E137', '17E16C', '18DBEC', '18DBED', '18DBEE', '18DBEF', '18DBF0', '18DBF1'].every((r) => replaced.includes(`${DLE}:${r}`)) && !['17E0D8', '17E118', '17E119', '17E11E', '17E11F'].some((r) => replaced.includes(`${DLE}:${r}`)), 'the generator keeps Moranda\'s 12 disabled actors as placements, not the 5 removed');
ok(read('tooling/ck-mcp/dungeons_extra.json').cells.includes('CYRAyleidRuinMoranda'), '...and lists its cell (it has no location of its own)');

const dir = fs.mkdtempSync(path.join(fs.existsSync('/dev/shm') ? '/dev/shm' : os.tmpdir(), 'claude-nate-moranda-h-'));
for (const f of ['dungeons.json', 'dungeon-pools.json', 'loot.json']) if (fs.existsSync(f)) fs.copyFileSync(f, path.join(dir, f));
fs.writeFileSync(path.join(dir, 'expeditions.json'), JSON.stringify({ expeditions: [] }));
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });
process.chdir(dir);
global.setTimeout = () => 0;
const A = 0x14, DOOR = 0x17e115, LICH = '6026fd:BSAssets.esm';
globalThis.__dboCharLevel = () => 1;
const props = new Map([[`${A}|worldOrCellDesc`, ent.world], [`${A}|pos`, ent.doorPos], [`${A}|profileId`, 1]]);
const ui = new Map();
require(path.join(SERVER, 'dungeons.js'))({
  mp: { get: (id, p) => props.get(`${id}|${p}`), set: (id, p, v) => props.set(`${id}|${p}`, v),
    getIdFromDesc: (d) => parseInt(String(d).split(':')[0], 16), lookupEspmRecordById: () => ({ record: null }) },
  log: () => {}, personal: () => {}, system: () => {}, audit: () => {}, registerChatCommand: () => {},
  onUi: (n, fn) => { const l = ui.get(n) || []; l.push(fn); ui.set(n, l); },
  openWidget: () => true, closeWidget: () => true, sendPacket: () => true, findByName: () => 0, display: String, who: String,
  profileOf: (a) => (a === A ? 1 : -1), nameOf: () => 'P', onlineActors: () => [A], isAdmin: () => false, giveItem: () => true, cfg: {}, every: () => {},
});
const fire = (n, a, args) => (ui.get(n) || []).forEach((f) => f(a, args, 0));
const claim = (diff) => {
  globalThis.__dboDungeonActivate(DOOR, A);
  const pend = globalThis.__dboDungeons.pending.get(A);
  if (!pend) return null;
  fire('dungeonClaim', A, [pend.nonce, diff]);
  const lease = globalThis.__dboDungeons.leases.get(mor.id);
  if (!lease) return null;
  globalThis.__dboDungeons.leases.delete(mor.id);
  return { bosses: lease.zones.filter((z) => lease.bossZones.has(z.Name)).map((z) => z.NPC[0].id), total: lease.totalNpcs };
};
for (const diff of ['normal', 'hard', 'nightmare']) {
  let lich = 0, got = null;
  for (let i = 0; i < 10; i++) { got = claim(diff); if (got && got.bosses.includes(LICH)) lich++; }
  ok(lich === 10, `Moranda on ${diff}: claimed through its door, the Ayleid lich is the boss every time`, got);
}
let novice = null; for (let i = 0; i < 10; i++) { const g = claim('story'); if (g && g.bosses.includes(LICH)) novice = g; }
const g = claim('story');
ok(g && g.bosses.length === 1 && !novice, 'Moranda on Novice: a boss from the lich\'s Novice line, never the level-50 lich', g);
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
