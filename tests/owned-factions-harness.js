// Camp-mates are allies (wildlife.js ownedFactionTick; Onny at Dusk Thorn Camp, 30 Sep: "the goblins were all fighting
// each other more than fighting me"). The bare BSKEncGoblin* templates' only faction is CreatureFaction, neutral to
// itself, and a Very Aggressive actor attacks neutrals. Each owned-spawn creature of a listed kind gets ff_factions
// (CreatureFaction + CYRGoblinFaction for goblins, + CYRBoarFaction for boars), once per live actor. Runs the real wildlife.js in a scratch folder.
//   node tests/owned-factions-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${what}${!c && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!c) fails++; };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-ownedfac-'));
const cwd = process.cwd();
const PLUGINS = { 'skyrim.esm': 0x00, 'bsheartland.esm': 0x08, 'bsassets.esm': 0x07 };
const idOf = (d) => { const [h, p] = String(d).split(':'); const i = PLUGINS[String(p || '').toLowerCase()]; if (i === undefined) throw new Error('no plugin ' + p); return ((i << 24) | parseInt(h, 16)) >>> 0; };
const props = new Map(), sets = [];
const mp = { get: (id, k) => props.get(`${id}|${k}`), set: (id, k, v) => { props.set(`${id}|${k}`, v); sets.push([id, k, v]); }, getIdFromDesc: idOf };
const GOB1 = 0xff000050, GOB2 = 0xff0000b8, BOAR = 0xff000060, WOLF = 0xff000070, DUNGEON = 0xff000080;
const tag = (id, t) => props.set(`${id}|private.npcSpawner`, t);
tag(GOB1, 'wild:goblin:p154071-dragonbreakonlineedits'); tag(GOB2, 'wild:goblin:p154077-dragonbreakonlineedits');
tag(BOAR, 'wild:boar:p15404f-dragonbreakonlineedits'); tag(WOLF, 'wild:wolf:12'); tag(DUNGEON, 'dungeon:CYRBrumaCavernsLocation:3');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'gamemode-config.json'), 'utf8'));
const load = (c) => {
  process.chdir(dir);
  try {
    delete require.cache[path.join(ROOT, 'wildlife.js')];
    global.setInterval = () => ({ unref() {} }); global.clearInterval = () => {};
    globalThis.__dboWildFactionAudit = ' (skipped)';
    require(path.join(ROOT, 'wildlife.js'))({ mp, log: () => {}, personal: () => {}, system: () => {}, registerChatCommand: () => {}, giveItem: () => true,
      profileOf: () => 1, display: String, who: String, audit: () => {}, isAdmin: () => false, cfg: c, onlineActors: () => [], sendPacket: () => {} });
  } finally { process.chdir(cwd); }
};
try {
  for (const f of ['wildlife.json', 'loot.json', 'artifacts.json']) fs.writeFileSync(path.join(dir, f), f === 'wildlife.json' ? JSON.stringify({ placements: [], giantCamps: [] }) : f === 'loot.json' ? '{"pools":{}}' : '{"patterns":[]}');
  fs.writeFileSync(path.join(dir, 'zone-spawns.json'), JSON.stringify([GOB1, GOB2, BOAR, WOLF, DUNGEON]));
  globalThis.__dboOwnedFactioned = undefined; globalThis.__dboOwnedFactionState = undefined;
  load({ ownedSpawns: cfg.ownedSpawns });
  const tick = () => { process.chdir(dir); try { globalThis.__dboOwnedFactionTick(); } finally { process.chdir(cwd); } };
  tick();
  const fac = (id) => sets.filter(([i, k]) => i === id && k === 'ff_factions');
  const WANT = { f: [[0x13, 0], [0x080877f5, 0]], c: 0 };
  ok(JSON.stringify(fac(GOB1).map((x) => x[2])) === JSON.stringify([WANT]), 'a Dusk Thorn goblin gets CreatureFaction + CYRGoblinFaction', fac(GOB1));
  ok(fac(GOB2).length === 1, 'so does the goblin boss mage: the whole camp shares a faction that is allied to itself');
  ok(JSON.stringify(fac(BOAR).map((x) => x[2])) === JSON.stringify([{ f: [[0x13, 0], [0x0806da79, 0]], c: 0 }]), 'a boar gets CreatureFaction + CYRBoarFaction (GroundedPasta, 30 Sep: four boars fought each other)', fac(BOAR));
  ok(fac(WOLF).length === 0 && fac(DUNGEON).length === 0, 'a wildlife.json wolf and a dungeon spawn are left alone');
  sets.length = 0; tick();
  ok(fac(GOB1).length === 0, 'each live actor is given its factions once, not every tick');
  // the actor dies and its form id is reused by a new goblin: the id left the sidecar in between
  fs.writeFileSync(path.join(dir, 'zone-spawns.json'), JSON.stringify([GOB2])); fs.utimesSync(path.join(dir, 'zone-spawns.json'), new Date(), new Date(Date.now() + 1000)); tick();
  fs.writeFileSync(path.join(dir, 'zone-spawns.json'), JSON.stringify([GOB1, GOB2])); fs.utimesSync(path.join(dir, 'zone-spawns.json'), new Date(), new Date(Date.now() + 2000)); sets.length = 0; tick();
  ok(fac(GOB1).length === 1, 'a form id that left and came back (a respawn) is given the factions again');
  // the sidecar unchanged: no re-read (no tag lookups at all)
  let gets = 0; const realGet = mp.get; mp.get = (id, k) => { gets++; return realGet(id, k); };
  tick();
  ok(gets === 0, 'an unchanged sidecar is not read again', gets);
  mp.get = realGet;
  // a transient failure is retried, not marked done
  const realSet = mp.set; let failOnce = true;
  mp.set = (id, k, v) => { if (k === 'ff_factions' && failOnce) { failOnce = false; throw new Error('transient'); } realSet(id, k, v); };
  const GOB3 = 0xff0000c0; tag(GOB3, 'wild:goblin:p154072-dragonbreakonlineedits');
  fs.writeFileSync(path.join(dir, 'zone-spawns.json'), JSON.stringify([GOB1, GOB2, GOB3])); sets.length = 0;
  fs.utimesSync(path.join(dir, 'zone-spawns.json'), new Date(), new Date(Date.now() + 5000));
  tick();
  ok(fac(GOB3).length === 0, 'the first apply fails (transient)');
  tick();
  ok(fac(GOB3).length === 1, '...and the next tick applies it, although the sidecar did not change');
  mp.set = realSet;
  // config: another kind, a desc that does not resolve, and a list that only partly resolves
  sets.length = 0; globalThis.__dboOwnedFactioned = undefined; globalThis.__dboOwnedFactionState = undefined;
  load({ ownedSpawns: { factions: { boar: ['2e894:Skyrim.esm'], goblin: ['1:NoSuchPlugin.esm'] } } });
  fs.writeFileSync(path.join(dir, 'zone-spawns.json'), JSON.stringify([GOB1, BOAR])); tick();
  ok(fac(BOAR).length === 1 && fac(BOAR)[0][2].f[0][0] === 0x2e894, 'config adds a kind (boars into PreyFaction here)');
  ok(fac(GOB1).length === 0, 'a kind whose factions do not resolve is left as the plugin made it, not stripped');
  sets.length = 0; globalThis.__dboOwnedFactioned = undefined; globalThis.__dboOwnedFactionState = undefined;
  const logs = [];
  process.chdir(dir);
  try {
    delete require.cache[path.join(ROOT, 'wildlife.js')];
    require(path.join(ROOT, 'wildlife.js'))({ mp, log: (...a) => logs.push(a.join(' ')), personal: () => {}, system: () => {}, registerChatCommand: () => {}, giveItem: () => true,
      profileOf: () => 1, display: String, who: String, audit: () => {}, isAdmin: () => false, cfg: { ownedSpawns: { factions: { goblin: ['13:Skyrim.esm', '877f5:NoSuchPlugin.esm'] } } }, onlineActors: () => [], sendPacket: () => {} });
  } finally { process.chdir(cwd); }
  fs.utimesSync(path.join(dir, 'zone-spawns.json'), new Date(), new Date(Date.now() + 9000)); tick();
  ok(fac(GOB1).length === 0, 'a list that only partly resolves is not applied at all (CreatureFaction alone would bring the infighting back)', fac(GOB1));
  ok(logs.some((l) => /ownedSpawns\.factions\.goblin: 877f5:NoSuchPlugin\.esm not in the load order/.test(l)), '...and the missing faction is named in the log', logs);
  ok(Array.isArray(cfg.ownedSpawns.factions.goblin) && cfg.ownedSpawns.factions.goblin.length === 2, 'gamemode-config.json carries the goblin factions');
  ok(JSON.stringify(cfg.ownedSpawns.factions.boar) === JSON.stringify(['13:Skyrim.esm', '6da79:BSHeartland.esm']), 'gamemode-config.json carries the boar factions', cfg.ownedSpawns.factions.boar);
  const kinds = new Set(JSON.parse(fs.readFileSync(path.join(ROOT, 'owned-spawns.json'), 'utf8')).spawns.map((x) => x.kind));
  ok([...kinds].every((k) => cfg.ownedSpawns.factions[k]), 'every creature kind the owned plugins place has its factions', [...kinds]);
  const gm = fs.readFileSync(path.join(ROOT, 'gamemode.js'), 'utf8');
  ok(/makeProp\('ff_factions', true\)/.test(gm), 'ff_factions is a neighbour-visible property, so every watcher applies it');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(fails ? `${fails} FAILED` : 'all checks passed');
process.exit(fails ? 1 : 0);
