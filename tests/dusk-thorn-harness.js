// Dusk Thorn Camp and the boars of DragonBreak Online Edits.esp v5 (sha e732e845, 29 Sep): 8 goblins and 13 boars the
// server spawns (the plugin's own ACHRs are to be disabled, as every living placement is), the camp chest on the hourly
// per-player roll, goblins keeping their gear and boars their meat and tusk. Runs the real wildlife.js against the real
// wildlife.json in a scratch folder (loading it writes NPC-Spawns.json) and reads the zones it writes.
//   node tests/dusk-thorn-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${what}${!c && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!c) fails++; };

const W = JSON.parse(fs.readFileSync(path.join(ROOT, 'wildlife.json'), 'utf8'));
const FIRST_NEW = 3184; // placements before this index predate v5; their zone names (wild:<kind>:<n>) must not move
const added = W.placements.slice(FIRST_NEW);
const count = (k) => added.filter((p) => p.kind === k).length;
ok(added.length === 21 && count('boar') === 13 && count('goblin') === 8, 'v5 adds 13 boar and 8 goblin placements at the end of the list', { n: added.length, boar: count('boar'), goblin: count('goblin') });
ok(W.placements.slice(0, FIRST_NEW).every((p) => p.kind !== 'boar' && p.kind !== 'goblin'), 'nothing before them moved: no boar or goblin placement among the older ones');
ok(added.every((p) => /:DragonBreak Online Edits\.esp$/.test(p.src)), 'each comes from one of v5\'s own ACHRs');
// Anchors must already exist, so the zones work whether or not v5 is live yet
ok(added.every((p) => /:BSHeartland\.esm$/.test(p.ref) && p.anchorDist <= 2500), 'every anchor is a BSHeartland ref already in the live order, within 2500 units', added.map((p) => [p.ref, p.anchorDist]));
ok(added.every((p) => p.world === 'a764b:BSHeartland.esm' && !p.noNavmesh && Array.isArray(p.options) && p.options.length), 'all in the Bruma world, on navmesh cells, with a concrete NPC to spawn');
ok(added.filter((p) => p.kind === 'boar').every((p) => p.options[0][1] === '60242e:BSAssets.esm'), 'boars spawn as BSKEncBoar01 (60242e:BSAssets.esm)');
const camp = W.giantCamps.find((c) => c.name === 'Dusk Thorn Camp');
ok(camp && camp.owners === 'goblins' && camp.chests.length === 1 && camp.chests[0].ref === '154079:DragonBreak Online Edits.esp', 'Dusk Thorn Camp is a camp whose chest (154079, CYRTreasGoblinChestMagicBoss) belongs to the goblins', camp);
const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
ok(camp && added.filter((p) => p.kind === 'goblin').every((p) => near(p.pos, camp.chests[0].pos) < 1000), 'the eight goblins stand within 1000 units of the camp chest');

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'gamemode-config.json'), 'utf8'));
ok((cfg.animalBody.keepAllKinds || []).includes('goblin'), 'a goblin body hands over its gear (animalBody.keepAllKinds has goblin)');
ok((cfg.animalBody.addFood || []).some((r) => new RegExp(r.creature).test('BSKEncBoar01') && r.items.length === 2), 'a BSKEncBoar01 body gets boar meat and a tusk (its death item holds none)');

// The real module: zones and the camp chest
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-duskthorn-'));
const cwd = process.cwd();
try {
  for (const f of ['wildlife.json', 'loot.json', 'artifacts.json']) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
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
  const wild = zones.filter((z) => String(z.Name).startsWith('wild:'));
  const mine = wild.filter((z) => /^wild:(boar|goblin):/.test(z.Name));
  ok(mine.length === 21, 'wildlife.js writes 21 wild:boar / wild:goblin zones', mine.length);
  ok(mine.every((z) => Number(z.Name.split(':')[2]) >= FIRST_NEW - 1), 'their numbers come after every older zone\'s, so no older zone is renamed', mine.map((z) => z.Name));
  const goblinZone = mine.find((z) => z.Name.startsWith('wild:goblin:'));
  ok(goblinZone && goblinZone.ID === 'a764b:BSHeartland.esm' && /:BSHeartland\.esm$/.test(goblinZone.Anchor) && goblinZone.NPC[0].count === 1, 'a goblin zone spawns one goblin in the Bruma world from a live anchor', goblinZone);
  const CHEST = idOf('154079:DragonBreak Online Edits.esp');
  ok(globalThis.__dboCampChest(CHEST, 0xff000275) === false && /goblins' chest/.test(said[0] || ''), 'rummaging the Dusk Thorn chest rolls the camp loot as the goblins\' chest', said);
} finally {
  process.chdir(cwd);
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(fails ? `${fails} FAILED` : 'all checks passed');
process.exit(fails ? 1 : 0);
