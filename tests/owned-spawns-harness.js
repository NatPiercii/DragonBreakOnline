// Owned spawns (tools/spawns/owned_spawns.py -> owned-spawns.json -> wildlife.js): every creature a DragonBreak-owned
// plugin places Initially Disabled is spawned by the server as its own wild zone (Nate, 30 Sep, creatures only). The
// first list is DLE v5's 8 Dusk Thorn goblins and 13 boars with the camp chest. Runs the real wildlife.js against the real
// wildlife.json and owned-spawns.json in a scratch folder (loading it writes NPC-Spawns.json) and reads the zones.
//   node tests/owned-spawns-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${what}${!c && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!c) fails++; };

const W = JSON.parse(fs.readFileSync(path.join(ROOT, 'wildlife.json'), 'utf8'));
const O = JSON.parse(fs.readFileSync(path.join(ROOT, 'owned-spawns.json'), 'utf8'));
const count = (k) => O.spawns.filter((s) => s.kind === k).length;
ok(O.spawns.length === 45 && count('goblin') === 8 && count('boar') === 13 && count('minotaur') === 24, 'owned-spawns.json lists the 8 goblins and 13 boars of DLE v5, and the 24 minotaurs of Sancre Tor Ruins and Minotaur\'s Rest (DLE 12393628)', { n: O.spawns.length, goblin: count('goblin'), boar: count('boar'), minotaur: count('minotaur') });
ok(W.placements.every((p) => p.kind !== 'goblin' && p.kind !== 'boar') && !W.giantCamps.some((c) => c.name === 'Dusk Thorn Camp'), 'wildlife.json no longer carries them by hand (3,184 generated placements, 13 giant camps)', { n: W.placements.length, camps: W.giantCamps.length });
ok(O.spawns.every((s) => /:DragonBreak Online Edits\.esp$/.test(s.src) && /^3c/.test(s.loadId)), 'each comes from a DLE ACHR (load-order id 3Cxxxxxx)');
// Sancre Tor Ruins and Minotaur's Rest are nearly all Nat's own placements, so the nearest untouched ref can be 6.6 km off; placeNpc re-enables after the move
ok(O.spawns.every((s) => /:BSHeartland\.esm$/.test(s.ref) && s.anchorDist <= (s.kind === 'minotaur' ? 7000 : 2500)), 'every anchor is a Beyond Skyrim ref no plugin of ours touches, within 2500 units (7000 for the minotaurs\' ruins)', O.spawns.filter((s) => s.anchorDist > 2500).map((s) => [s.ref, s.anchorDist, s.group]));
ok(O.spawns.every((s) => s.world === 'a764b:BSHeartland.esm' && !s.interior && Number.isFinite(s.heading) && s.options.length), 'all outdoors in the Bruma world, each with a heading and a concrete NPC');
const camp = (O.camps || []).find((c) => c.owners === 'goblins');
ok(O.camps.length === 3 && camp.name === 'Dusk Thorn Camp' && camp.owners === 'goblins' && camp.chests[0].ref === '154079:DragonBreak Online Edits.esp', 'three camps; the goblins\' is Dusk Thorn Camp, named from its map marker, with chest 154079', O.camps.map((c) => c.name));
ok(O.groups.find((g) => g.name === 'Dusk Thorn Camp').spawns === 8, 'the eight goblins group under the camp\'s marker');
ok(O.skipped && O.skipped.dungeon.length === 38 && O.skipped.person.length >= 1, 'the generator left the 38 dungeon actors (Vilverin\'s 28 and Moranda\'s, now a dungeon) to dungeons.js and listed placed people instead of spawning them', { dungeon: O.skipped.dungeon.length, person: O.skipped.person.length });

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'gamemode-config.json'), 'utf8'));
ok((cfg.animalBody.keepAllKinds || []).includes('goblin'), 'a goblin body hands over its gear (animalBody.keepAllKinds has goblin)');
ok((cfg.animalBody.addFood || []).some((r) => new RegExp(r.creature).test('BSKEncBoar01') && r.items.length === 2), 'a BSKEncBoar01 body gets boar meat and a tusk (its death item holds none)');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-owned-'));
const cwd = process.cwd();
try {
  for (const f of ['wildlife.json', 'owned-spawns.json', 'loot.json', 'artifacts.json']) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  const PLUGINS = { 'skyrim.esm': 0x00, 'bsheartland.esm': 0x08, 'bsassets.esm': 0x07, 'dragonbreak online edits.esp': 0x3c, 'dragonbreak.esp': 0x3b };
  const idOf = (d) => { const [h, p] = String(d).split(':'); const i = PLUGINS[String(p || '').toLowerCase()]; return i === undefined ? 0x7f000000 | (parseInt(h, 16) & 0xffffff) : ((i << 24) | (parseInt(h, 16) & 0xffffff)) >>> 0; };
  const props = new Map(), said = [];
  global.setInterval = () => ({ unref() {} }); global.clearInterval = () => {};
  globalThis.__dboWildFactionAudit = ' (skipped in the harness)';
  process.chdir(dir);
  require(path.join(ROOT, 'wildlife.js'))({ mp: { get: (id, k) => props.get(`${id}|${k}`), set: (id, k, v) => props.set(`${id}|${k}`, v), getIdFromDesc: idOf },
    log: () => {}, personal: (a, t) => said.push(t), system: () => {}, registerChatCommand: () => {}, giveItem: () => true, profileOf: () => 1,
    display: String, who: String, audit: () => {}, isAdmin: () => false, cfg: { wildlife: cfg.wildlife || {} }, onlineActors: () => [], sendPacket: () => {} });
  const zones = JSON.parse(fs.readFileSync(path.join(dir, 'NPC-Spawns.json'), 'utf8')).zones;
  const owned = zones.filter((z) => /^wild:[^:]+:p[0-9a-f]+-/.test(z.Name));
  const numbered = zones.filter((z) => /^wild:[^:]+:\d+$/.test(z.Name));
  ok(owned.length === 45, 'wildlife.js writes 45 owned-spawn zones', owned.length);
  ok(numbered.length > 3000 && numbered.every((z) => Number(z.Name.split(':')[2]) < W.placements.length), 'the generated wildlife zones keep their numbered names', numbered.length);
  const g = owned.find((z) => z.Name === 'wild:goblin:p154077-dragonbreakonlineedits');
  const src = O.spawns.find((s) => s.src === '154077:DragonBreak Online Edits.esp');
  ok(g && g.ID === 'a764b:BSHeartland.esm' && g.Anchor === src.ref && g.Heading === src.heading && g.NPC[0].id === '602661:BSAssets.esm' && g.NPC[0].count === 1,
    'the goblin boss mage (154077) spawns as itself at its own spot and heading, from its anchor', { g, src });
  ok(new Set(owned.map((z) => z.Name)).size === 45, 'every owned zone has its own name');
  const CHEST = idOf('154079:DragonBreak Online Edits.esp');
  ok(globalThis.__dboCampChest(CHEST, 0xff000275) === false && /goblins' chest/.test(said[0] || ''), 'the Dusk Thorn chest rolls the hourly camp loot as the goblins\' chest', said);
  // Nate 9 Oct: ownedSpawns.replace puts Cyrodiil undead in the minotaurs' spots (Sancre Tor, Minotaur's Rest)
  const minoSrc = O.spawns.filter((x) => x.kind === 'minotaur');
  delete require.cache[require.resolve(path.join(ROOT, 'wildlife.js'))];
  require(path.join(ROOT, 'wildlife.js'))({ mp: { get: (id, k) => props.get(`${id}|${k}`), set: (id, k, v) => props.set(`${id}|${k}`, v), getIdFromDesc: idOf },
    log: () => {}, personal: (a, t) => said.push(t), system: () => {}, registerChatCommand: () => {}, giveItem: () => true, profileOf: () => 1,
    display: String, who: String, audit: () => {}, isAdmin: () => false, cfg: { wildlife: cfg.wildlife || {}, ownedSpawns: cfg.ownedSpawns }, onlineActors: () => [], sendPacket: () => {} });
  const z2 = JSON.parse(fs.readFileSync(path.join(dir, 'NPC-Spawns.json'), 'utf8')).zones.filter((z) => /^wild:[^:]+:p[0-9a-f]+-/.test(z.Name));
  const rep = cfg.ownedSpawns.replace.minotaur;
  const undead = z2.filter((z) => z.Name.startsWith('wild:undead:'));
  ok(z2.length === 45 && !z2.some((z) => z.Name.startsWith('wild:minotaur:')) && undead.length === minoSrc.length && minoSrc.length > 0,
    'every minotaur spot becomes an undead zone, the rest unchanged', { all: z2.length, undead: undead.length, mino: minoSrc.length });
  const kinds = new Set(undead.map((z) => z.NPC[0].id));
  ok(kinds.size >= 3, 'the spots get a mix of undead, not one base', [...kinds]);
  ok(undead.every((z) => { const sp = minoSrc.find((x) => z.Name.endsWith(`:p${x.src.split(':')[0]}-dragonbreakonlineedits`)); return sp && rep.bases[sp.base].some(([, d]) => d === z.NPC[0].id) && z.Hostile === true && z.NPC[0].count === rep.count; }),
    'each undead zone spawns one of its spot\'s replacements (a Lord spot a level-25 zombie) and attacks on sight, as many as replace.count');
} finally {
  process.chdir(cwd);
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(fails ? `${fails} FAILED` : 'all checks passed');
process.exit(fails ? 1 : 0);
