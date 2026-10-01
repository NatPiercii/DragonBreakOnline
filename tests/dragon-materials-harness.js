// Dragon bone and scales come only from a slain dragon (Nate, 2026-09-30: "Dragon bone and scale crafting items can only
// be picked up from killing a dragon"). dragon-materials.json names them, and every other way to get one is closed:
//   loot pools and the Ayleid table (dungeons.js, wildlife.js: the same filter as artifacts.json, on exact editor ids,
//     so Dragonbone and Dragonscale gear stays in the pools);
//   salvage (salvage.js, the real salvage.json: 319 entries gave them back; now the other materials only, counted as before);
//   crafting (regions.js: Immersive Armors' IAB* breakdown recipes make them; refused, the chain never credited);
//   taking one out of a container the plugins fill with them (gamemode.js take hook: JK's dragon chest, the QA chests);
// while a dragon's body, a player's own chest, and staff grants (marked DRAGON MATERIAL in the audit log) still work.
//   node tests/dragon-materials-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const SERVER = path.resolve(__dirname, '..');
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got)}`); if (!c) fails++; };
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(path.join(SERVER, f), 'utf8')); } catch (e) { return fb; } };
const BONE = '3ada4:Skyrim.esm', SCALES = '3ada3:Skyrim.esm';

// ---- the data ----
const DM = readJson('dragon-materials.json', null);
ok(!!DM, 'dragon-materials.json exists');
const mats = ((DM && DM.materials) || []).map((d) => d.toLowerCase());
ok(mats.includes(BONE.toLowerCase()) && mats.includes(SCALES.toLowerCase()), 'it names DragonBone (3ada4) and DragonScales (3ada3)', mats);
ok(JSON.stringify((DM && DM.editorIds) || []) === JSON.stringify(['DragonBone', 'DragonScales']), 'and their editor ids');

// ---- loot pools: the ARTIFACT filter of dungeons.js and wildlife.js, lifted and run ----
const lift = (file, name = 'ARTIFACT') => {
  const src = fs.readFileSync(path.join(SERVER, file), 'utf8');
  const i = src.indexOf(`const ${name} = (() => {`), j = src.indexOf('})();', i);
  if (i < 0 || j < 0) return null;
  try { return new Function('readJson', 'log', `${src.slice(i, j + 5)}\nreturn ${name};`)(readJson, () => {}); } catch (e) { return null; }
};
// dungeons.js keeps the two apart: its pools refuse both (DRAGON_LOOT), while what a corpse keeps is trimmed by ARTIFACT
// alone, so a dragon slain in a dungeon keeps its bones and scales (Worker D's review)
{
  const src = fs.readFileSync(path.join(SERVER, 'dungeons.js'), 'utf8');
  const art = lift('dungeons.js');
  ok(!!art && !art.test('DragonBone') && !art.test('DragonScales'), "dungeons.js: a corpse's trim (ARTIFACT) keeps a dragon's bones and scales");
  ok((src.match(/DRAGON_LOOT\.test\(/g) || []).length === 3 && /ARTIFACT\.test\(it\.name\) \|\| DRAGON_LOOT\.test\(it\.name\)/.test(src)
    && /!DRAGON_LOOT\.test\(String\(it\.name \|\| ''\)\) && !BANNED_LOOT/.test(src) && /!ARTIFACT\.test\(String\(it\.name \|\| ''\)\) && !DRAGON_LOOT\.test\(String\(it\.name \|\| ''\)\)[^\n]*\);\n  const AYLEID_NAMES/.test(src),
    'dungeons.js: lootOk, every pool and the Ayleid table ask DRAGON_LOOT');
}
for (const [file, name] of [['dungeons.js', 'DRAGON_LOOT'], ['wildlife.js', 'ARTIFACT']]) {
  const rx = lift(file, name);
  ok(!!rx, `${file}: the never-loot filter builds`);
  if (!rx) continue;
  ok(rx.test('DragonBone') && rx.test('DragonScales'), `${file}: DragonBone and DragonScales are never loot`);
  ok(!rx.test('DragonboneSword') && !rx.test('ArmorDragonscaleCuirass') && !rx.test('DLC1DragonboneWarAxe') && !rx.test('MGRDragonHeartScales'),
    `${file}: Dragonbone and Dragonscale gear (and the College's heart scales) are not caught`);
  ok((name === 'ARTIFACT' ? rx : lift(file)).test('ClavicusVileMask'), `${file}: artifacts are still never loot`);
}
// No pool carries one past the filter today
const poolNames = [];
for (const [, list] of Object.entries(readJson('loot.json', { pools: {} }).pools || {})) for (const it of list || []) poolNames.push(String(it.name || ''));
for (const it of readJson('ayleid-loot.json', { items: [] }).items || []) poolNames.push(String(it.name || ''));
const dl = lift('dungeons.js', 'DRAGON_LOOT');
ok(!!dl && poolNames.filter((n) => dl.test(n) && /^Dragon(Bone|Scales)$/i.test(n)).length === poolNames.filter((n) => /^Dragon(Bone|Scales)$/i.test(n)).length,
  `every DragonBone/DragonScales in loot.json and ayleid-loot.json (${poolNames.filter((n) => /^Dragon(Bone|Scales)$/i.test(n)).length} today) is filtered`);

// ---- salvage: the real salvage.json through salvage.js's yieldOf ----
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-dragonmat-'));
process.on('exit', () => { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });
process.chdir(scratch);
for (const f of ['salvage.json', 'dragon-materials.json', 'regions.json', 'regions-overrides.json', 'skills.json', 'spell-tomes.json']) {
  try { fs.copyFileSync(path.join(SERVER, f), f); } catch (e) { /* dragon-materials.json is missing on the old code */ }
}
const SALVAGE = readJson('salvage.json', { items: {} }).items || {};
const byId = new Map(), byDesc = new Map();
let next = 0x10000;
const idFor = (d) => { const k = String(d).toLowerCase(); if (!byDesc.has(k)) { byDesc.set(k, next); byId.set(next, d); next++; } return byDesc.get(k); };
const salvageApi = {
  mp: { get: () => null, set: () => {}, getDescFromId: (id) => byId.get(id) || '', getIdFromDesc: idFor },
  log: () => {}, personal: () => {}, who: String, cfg: {}, openWidget: () => {}, closeWidget: () => {}, onUi: () => {},
  masteryOf: () => null, recordOf: () => null, fieldsOf: () => [], giveItem: () => true, itemName: () => '', distanceMeters: () => 0,
};
globalThis.__dboSalvage = undefined;
const SV = require(path.join(SERVER, 'salvage.js'))(salvageApi);
const isDragon = (d) => [BONE, SCALES].map((x) => x.toLowerCase()).includes(String(d).toLowerCase());
let withDragon = 0, stillDragon = 0, keptOthers = 0, emptied = 0, changedOthers = 0;
for (const [item, [station, tier, list]] of Object.entries(SALVAGE)) {
  if (!list.some(([d]) => isDragon(d))) continue;
  withDragon++;
  const y = SV.yieldOf(idFor(item), { id: station }, 4) || [];
  if (y.some(([d]) => isDragon(d))) stillDragon++;
  if (!y.length) emptied++; else keptOthers++;
  // The other materials come back as before: the same share, the main-material minimum only where it always was
  const share = 0.75;
  const want = list.map(([d, n], i) => [d, i === 0 && n >= 1 ? Math.max(1, Math.floor(n * share)) : Math.floor(n * share)]).filter(([d, n]) => n > 0 && !isDragon(d));
  if (JSON.stringify(want) !== JSON.stringify(y)) changedOthers++;
}
ok(withDragon > 300, `salvage.json has dragon gear to break down (${withDragon} entries)`);
ok(stillDragon === 0, 'breaking dragon gear down never gives dragon bone or scales', { stillDragon });
ok(changedOthers === 0, 'it gives its other materials back exactly as before (a Master smith, 75 %)', { changedOthers });
ok(keptOthers > 0, `dragon gear still breaks down into its leather and metal (${keptOthers} of ${withDragon})`, { emptied });
const plain = Object.entries(SALVAGE).find(([, [, , l]]) => !l.some(([d]) => isDragon(d)));
ok(!!plain && JSON.stringify(SV.yieldOf(idFor(plain[0]), { id: plain[1][0] }, 4)) === JSON.stringify(plain[1][2].map(([d, n], i) => [d, i === 0 && n >= 1 ? Math.max(1, Math.floor(n * 0.75)) : Math.floor(n * 0.75)]).filter(([, n]) => n > 0)),
  'other gear breaks down as before');

// ---- crafting: regions.js's craft hook refuses any recipe that makes one ----
const PLUGINS = { 'skyrim.esm': 0x00, 'hothtrooper44_armorcompilation.esp': 0x60, 'bsheartland.esm': 0x0b };
const BYI = Object.fromEntries(Object.entries(PLUGINS).map(([k, v]) => [v, k]));
const cid = (d) => { const [h, p] = String(d).split(':'); const i = PLUGINS[String(p).toLowerCase()]; if (i === undefined) throw new Error('no plugin ' + p); return ((i << 24) | parseInt(h, 16)) >>> 0; };
const cdesc = (id) => `${(id & 0xffffff).toString(16)}:${BYI[id >>> 24] === 'skyrim.esm' ? 'Skyrim.esm' : BYI[id >>> 24] === 'bsheartland.esm' ? 'BSHeartland.esm' : 'Hothtrooper44_ArmorCompilation.esp'}`;
const props = new Map(), said = [], audits = [], credits = [];
const cmp = {
  getIdFromDesc: cid, getDescFromId: cdesc, get: (id, p) => props.get(id + '|' + p), set: (id, p, v) => props.set(id + '|' + p, v),
  lookupEspmRecordById: () => null, callPapyrusFunction: () => null,
};
cmp.onCraft = (a, item, n, recipe) => { credits.push(recipe); return undefined; };
delete globalThis.__dboPrevCraft;
const SMITH = 0xff000014;
props.set(SMITH + '|worldOrCellDesc', 'a764b:BSHeartland.esm'); props.set(SMITH + '|pos', [0, 0, 0]);
try {
  require(path.join(SERVER, 'regions.js'))({
    mp: cmp, log: () => {}, personal: (a, t) => said.push(t), audit: (t) => audits.push(t), who: (a) => `P${a.toString(16)}`,
    cfg: { regions: { craft: true, failOpen: true, defaultPlace: 'cyrodiil' } }, registerChatCommand: () => {}, isAdmin: () => false,
    sendPacket: () => true, openWidget: () => true, closeWidget: () => true, onUi: () => {}, onlineActors: () => [SMITH], every: () => {},
    distanceMeters: () => 0, takeGold: () => false, giveItem: () => true, depositToTreasury: (z, n) => n,
  });
} catch (e) { ok(false, 'regions.js loads', e.message); }
const IAB_BOOTS = '4de9d:Hothtrooper44_ArmorCompilation.esp';   // IABAlduinBoots: Alduin boots broken back down
ok(cmp.onCraft(SMITH, cid(SCALES), 1, cid(IAB_BOOTS)) === false, 'a breakdown recipe that makes DragonScales is refused');
ok(cmp.onCraft(SMITH, cid(BONE), 1, cid(IAB_BOOTS)) === false, 'and one that makes DragonBone');
ok(!credits.includes(cid(IAB_BOOTS)), 'a refused craft earns no mastery credit (the chain never runs)');
ok(said.some((t) => /only from a slain dragon/.test(t)) && audits.some((t) => /DRAGON MATERIAL craft refused/.test(t)), 'the player is told why, and it is audited', { said, audits });
credits.length = 0;
const IRON_RECIPE = 'a30c3:Skyrim.esm', IRON = '5ace4:Skyrim.esm';
ok(cmp.onCraft(SMITH, cid(IRON), 1, cid(IRON_RECIPE)) !== false && credits.includes(cid(IRON_RECIPE)), 'an iron ingot is still crafted, and credited');
const DSCALE_CUIRASS = '13961:Skyrim.esm', DSCALE_RECIPE = 'dca14:Skyrim.esm';
// (The province gate may still refuse it: Dragonscale is Skyrim's work and this smith stands in Bruma. The dragon rule
// itself never does: only a recipe that makes a dragon material is its business.)
said.length = 0; audits.length = 0;
cmp.onCraft(SMITH, cid(DSCALE_CUIRASS), 1, cid(DSCALE_RECIPE));
ok(!audits.some((t) => /DRAGON MATERIAL/.test(t)) && !said.some((t) => /slain dragon/.test(t)), 'crafting Dragonscale armour from dragon scales is not the dragon rule\'s to refuse', { said, audits });

// ---- containers and bodies: gamemode.js's take guard, lifted and run ----
const gsrc = fs.readFileSync(path.join(SERVER, 'gamemode.js'), 'utf8');
const gi = gsrc.indexOf('const DRAGON = (() => {'), gj = gsrc.indexOf('globalThis.__dboDragonMaterial = isDragonMaterial;');
ok(gi > 0 && gj > gi, 'gamemode.js has the dragon take guard');
const normPlace = (d) => { const s = String(d || ''); const i = s.indexOf(':'); if (i < 0) return s.toLowerCase(); const n = parseInt(s.slice(0, i), 16); return (Number.isFinite(n) ? n.toString(16) : s.slice(0, i).toLowerCase()) + ':' + s.slice(i + 1).toLowerCase(); };
const gprops = new Map(), gsaid = [], gaudit = [];
const gmp = { get: (id, k) => gprops.get(id + '|' + k), getDescFromId: cdesc };
let G = null;
if (gi > 0 && gj > gi) {
  G = new Function('fs', 'path', 'mp', 'normPlace', 'personal', 'audit', 'who', 'log', 'globalThis',
    `${gsrc.slice(gi, gj)}\nreturn { dragonTakeRefused, isDragonMaterialDesc };`)(fs, path, gmp, normPlace, (a, t) => gsaid.push(t), (t) => gaudit.push(t), (a) => `P${a.toString(16)}`, () => {}, {});
}
const JK_CHEST = 0x0a001234, QA_CHEST = 0x0a001235, HOUSE_CHEST = 0x0a001236, DRAGON_BODY = 0xff000700, PLAYER = 0xff000014;
gprops.set(JK_CHEST + '|baseDesc', '24c79:JKs Skyrim.esp');
gprops.set(QA_CHEST + '|baseDesc', 'c2cdc:Skyrim.esm');
gprops.set(HOUSE_CHEST + '|baseDesc', '10cd5:Skyrim.esm');
gprops.set(DRAGON_BODY + '|baseDesc', '1ca03:Skyrim.esm');
if (G) {
  ok(G.dragonTakeRefused(JK_CHEST, PLAYER, cid(BONE)) === true, "DragonBone never comes out of JK's dragon chest (it would refill on every reloot)");
  ok(G.dragonTakeRefused(QA_CHEST, PLAYER, cid(SCALES)) === true, 'nor DragonScales out of the QA chest');
  ok(G.dragonTakeRefused(JK_CHEST, PLAYER, cid(IRON)) === false, 'anything else in those chests is taken as usual');
  ok(G.dragonTakeRefused(DRAGON_BODY, PLAYER, cid(BONE)) === false && G.dragonTakeRefused(DRAGON_BODY, PLAYER, cid(SCALES)) === false, "a slain dragon's body gives both");
  ok(G.dragonTakeRefused(HOUSE_CHEST, PLAYER, cid(BONE)) === false, "a player's own chest gives back the bones they put in it");
  ok(gsaid.some((t) => /only from a slain dragon/.test(t)) && gaudit.some((t) => /DRAGON MATERIAL take refused/.test(t)), 'a refused take is told and audited');
  ok(G.isDragonMaterialDesc('0003ADA4:Skyrim.esm') && G.isDragonMaterialDesc('3ada3:skyrim.esm') && !G.isDragonMaterialDesc('13961:Skyrim.esm'), 'descs match in any padding and case');
}
ok(/dragonTakeRefused\(Number\(sourceId\) >>> 0, Number\(actorId\) >>> 0, Number\(baseId\) >>> 0\)\) return false/.test(gsrc), 'the take hook asks the guard before the rest of the chain');

// ---- staff grants stay allowed, marked in the audit ----
ok(/admin panel: \$\{content\.action\} \$\{extra\}\$\{dragon\}/.test(gsrc) && /DRAGON MATERIAL \(staff grant\)/.test(gsrc), 'an F7 spawn of one is audited as a DRAGON MATERIAL staff grant');
ok(/const consoleForm = [\s\S]{0,600}isDragonMaterialDesc\(desc\)/.test(gsrc), 'so is a console AddItem of one');

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
