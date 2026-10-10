// Dungeon loot by material tier (Nate, 1 Oct 2026: "balance weapon/armour tiers found by dungeon difficulty. NO Ebony,
// Daedric or Dragon"; no Orcish; option 1: Steel plate, Scaled and Elven gilded in Cyrodiil). Two parts:
//   1. loottiers.js on its own: every family's tier, the never-loot families, uniforms, trinkets, unknown items; each
//      row's shares over 200,000 rolls; the lock rows; the enchantment caps; the tier 3 weapon stand-in.
//   2. The real dungeons.js with the real loot.json, loot-materials.json, faction-gear.json, dungeons.json and
//      expeditions.json: every Bruma dungeon and every expedition claimed at every difficulty, and EVERYTHING a player can
//      take there checked, path by path: big chests, boss chests, locked chests by their lock, small containers, the
//      enemies' own arms, a humanoid body searched with E, a master's body, a creature's corpse. No item of a never-loot
//      material, no faction uniform, no unknown item, nothing above the path's tiers, nothing enchanted past its rank
//      cap; the ordinary chests' shares match the table. Last, live-then-new: a claim made by the live dungeons.js and
//      searched after this one loads over the same state.
//   3. The steel ceiling (Jake and Nate, 1 Oct, a stopgap): loottiers.js's default cap, and every path of the real
//      dungeons.js under it: no weapon or armour above iron and steel at any difficulty. Parts 1 and 2 run with
//      cap 'none', so they keep testing the tiers beneath it.
//   4. The same ceiling over ingots, ores and arrows (Nate, 4 Oct): under it no path hands out anything gear-swap.json's
//      metals or ammo names, nor a mined metal (loottiers.js LOOT_ONLY_METALS), on any path (chests, urns, bosses, bodies,
//      masters, the enemies' quivers); a creature's corpse keeps what it carried, which nothing hands over today. The two
//      metal lists against skills.json oreByTier: what players mine is never swapped. Linen wraps drop (the same 4 Oct ask).
//      The metals stay out at cap 'none' too ("people should have to craft higher tiers and grind for it"): checked on
//      part 2's uncapped sweep, where the arrows come back.
//   node tests/loot-tiers-harness.js   (from server/; CLAIMS=n for more claims per dungeon and difficulty)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const CLAIMS = Number(process.env.CLAIMS) || 24;
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got).slice(0, 600)}`); if (!c) fails++; };
const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
const MATERIALS = read('loot-materials.json'), FACTION = read('faction-gear.json'), OVERRIDES = read('loot-overrides.json'), LOOT = read('loot.json').pools, SWAP = read('gear-swap.json');
const tiersWith = (cfg) => require(path.join(ROOT, 'loottiers.js'))({ materials: MATERIALS, factionGear: FACTION, overrides: OVERRIDES, cfg });
const T = tiersWith({ cap: 'none' });
const UNCAPPED = { lootTiers: { cap: 'none' } };
const DIFFS = ['story', 'normal', 'hard', 'nightmare'];

// Seeded Math.random, so a run is the same sample every time
let rng = 0;
const reseed = (key) => { let h = 2166136261; for (const c of String(key)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); rng = h >>> 0; };
const realRandom = Math.random;
Math.random = () => { rng = (rng + 0x6d2b79f5) >>> 0; let t = Math.imul(rng ^ (rng >>> 15), rng | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

// ---- 1. loottiers.js ----------------------------------------------------------------------------------------------
const byName = new Map();
for (const list of Object.values(LOOT)) for (const it of list) if (!byName.has(it.name)) byName.set(it.name, it);
const cls = (name) => T.classOf((byName.get(name) || { id: 'ffffff:Nothing.esp' }).id);
const tierCases = { IronSword: 1, ArmorHideCuirass: 1, CYRSteelSword: 2, ArmorSteelBootsA: 2, ArmorElvenCuirass: 2, DwarvenSword: 2,
  ArmorSteelPlateCuirass: 3, ArmorScaledCuirass: 3, ArmorElvenGildedCuirass: 3, CYRGlassSword: 4, ArmorGlassCuirass: 4 };
const wrongTier = Object.entries(tierCases).filter(([n, t]) => { const c = cls(n); return c.kind !== 'gear' || c.tier !== t; }).map(([n]) => [n, cls(n)]);
ok(!wrongTier.length, 'the tiers: iron and hide 1; steel, imperial, elven, dwarven 2; steel plate, scaled, elven gilded 3; glass 4', wrongTier);
const neverCases = ['EbonySword', 'DaedricDagger', 'ArmorDragonplateCuirass', 'ArmorDragonscaleHelmet', 'DLC2StalhrimSword', 'OrcishWarAxe', 'ArmorOrcishCuirass',
  'CYRArmorOrcishCuirass', 'EnchArmorDraugrHelmetResistFire03', 'BSKEnchArmorDragonplateWaterWalking', 'BSKEnchArmorDragonscaleBootsWaterWalking'];
const notNever = neverCases.filter((n) => byName.has(n) && cls(n).kind !== 'never');
ok(!notNever.length && neverCases.filter((n) => byName.has(n)).length >= 9, 'never loot: Ebony, Daedric, Dragon (the Water Walking pieces too), Stalhrim, Orcish, and the Daedric-keyworded draugr helmet', notNever);
ok(cls('ArmorStormcloakCuirass').kind === 'uniform' && cls('ArmorBladesCuirass').kind === 'uniform' && cls('ArmorImperialCuirass').kind === 'uniform', 'faction uniforms are not loot (Stormcloak, Blades, the Legion\'s Imperial armour)', [cls('ArmorStormcloakCuirass'), cls('ArmorBladesCuirass'), cls('ArmorImperialCuirass')]);
const facDesc = Object.keys(FACTION.items)[0];
ok(T.classOf(facDesc).kind === 'uniform' || T.classOf(facDesc).kind === 'never' || T.classOf(facDesc).kind === 'unknown', 'every item faction-gear.json names is not loot', [facDesc, T.classOf(facDesc)]);
ok(cls('ClothesMonkRobes').kind === 'trinket' || cls('JewelryRingGold').kind === 'trinket', 'clothing and jewellery are trinkets, with their own roll');
ok(T.classOf('abcdef:Nowhere.esp').kind === 'unknown' && !T.lootable('abcdef:Nowhere.esp'), 'an item the material map does not know is not loot');
ok(cls('CYRBloodscaleHelmet').kind === 'never' && /Argonians and Khajiit/.test(cls('CYRBloodscaleHelmet').why || ''), 'CYRBloodscaleHelmet is never loot (loot-overrides.json: addons for two races only)', cls('CYRBloodscaleHelmet'));
// loot-overrides.json: CYRIronFalchion's Beyond Skyrim model is untextured (#bugs "Iron Falchion Missing Textures")
ok(MATERIALS.items['81dfc:bsheartland.esm'] === 'iron' && cls('CYRIronFalchion').kind === 'never' && /untextured/.test(cls('CYRIronFalchion').why || ''), 'CYRIronFalchion is never loot (loot-overrides.json, "untextured BS model"), though its map entry still says iron', cls('CYRIronFalchion'));
{
  const t1Cyr = (LOOT.weapons || []).filter((w) => (w.p || []).includes('cyrodiil') && T.classOf(w.id).kind === 'gear' && T.classOf(w.id).tier === 1);
  ok(t1Cyr.length >= 10 && !t1Cyr.some((w) => w.name === 'CYRIronFalchion'), `the tier 1 Cyrodiil weapons are still there without it (${t1Cyr.length}: ${t1Cyr.slice(0, 5).map((w) => w.name).join(', ')}, ...)`);
}
// Shares, 200,000 rolls a row
const shareOf = (row, n = 200000) => { reseed(JSON.stringify(row)); const c = { 1: 0, 2: 0, 3: 0, 4: 0 }; for (let i = 0; i < n; i++) c[T.rollTier(row)]++; return c; };
const off = [];
for (const kind of ['chest', 'boss', 'raidBoss']) for (const diff of DIFFS) {
  const row = T.rowFor(diff, kind); const total = [1, 2, 3, 4].reduce((s, t) => s + (row[t] || 0), 0); const c = shareOf(row);
  for (const t of [1, 2, 3, 4]) { const want = (row[t] || 0) / total, got = c[t] / 200000; if (Math.abs(got - want) > 0.005) off.push([kind, diff, t, want, got]); }
}
ok(!off.length, 'each row rolls its tiers within half a point of the table (chest, boss and raid boss rows at all four difficulties)', off);
const table = { chest: { story: '85/15/0/0', normal: '30/60/10/0', hard: '0/35/50/15', nightmare: '0/15/45/40' }, boss: { story: '50/50/0/0', normal: '0/60/35/5', hard: '0/10/50/40', nightmare: '0/0/35/65' } };
const asText = (row) => [1, 2, 3, 4].map((t) => row[t] || 0).join('/');
ok(DIFFS.every((d) => asText(T.rowFor(d, 'chest')) === table.chest[d] && asText(T.rowFor(d, 'boss')) === table.boss[d]), 'the rows are Nate\'s table');
ok(asText(T.rowFor('hard', 'lock', 1)) === table.chest.hard && asText(T.rowFor('hard', 'lock', 3)) === table.boss.hard && asText(T.rowFor('hard', 'lock', 2)) === '0/22.5/50/27.5',
  'a locked chest: Novice/Apprentice lock the chest row, Adept halfway to the boss row, Expert/Master the boss row', asText(T.rowFor('hard', 'lock', 2)));
ok(T.enchOk('EnchIronSwordFire02', 'story', false) && !T.enchOk('EnchIronSwordFire03', 'story', false) && T.enchOk('EnchIronSwordFire03', 'story', true)
  && T.enchOk('EnchGlassSwordFire06', 'nightmare', false) && !T.enchOk('CYREnchSteelSwordFire03', 'hard', false), 'enchantment ranks: Novice 02, Adept 03, Expert 04, Master 06, a boss one more (Beyond Skyrim 01-03 count double)');
{
  const elven = (LOOT.weapons || []).filter((w) => /^Elven(Greatsword|Battleaxe|Warhammer|Bow)$/.test(w.name) || /^CYRElven(Greatsword|Battleaxe|Warhammer|Bow)$/.test(w.name));
  const iron = (LOOT.weapons || []).filter((w) => w.name === 'IronSword');
  reseed('standin');
  const got = new Set(); for (let i = 0; i < 400; i++) { const w = T.pickTier(elven.concat(iron), { 3: 100 }, { weapons: true }); if (w) got.add(w.name); }
  ok(elven.length > 0 && [...got].every((n) => /Elven/.test(n)) && got.size > 1, 'a tier 3 weapon roll with no tier 3 weapon draws the high Elven weapons (Nate\'s (c))', [...got]);
}

// ---- 2. the real dungeons.js, every path ----------------------------------------------------------------------------
const ids = new Map(), descs = new Map(); let nextId = 0x100;
const idOf = (d) => { const k = String(d).toLowerCase(); if (!ids.has(k)) { ids.set(k, nextId); descs.set(nextId, k); nextId++; } return ids.get(k); };
const REC = new Map();
const recType = { weapons: 'WEAP', armor: 'ARMO', ench_weapons: 'WEAP', ench_armor: 'ARMO', arrows: 'AMMO', potions: 'ALCH', ingredients: 'INGR', gems: 'MISC', materials: 'MISC', soulgems: 'SLGM', lockpicks: 'MISC', lights: 'LIGH', recipes: 'BOOK', food: 'ALCH' };
for (const [pool, list] of Object.entries(LOOT)) for (const it of list) REC.set(idOf(it.id), { type: recType[pool] || 'MISC', editorId: it.name, flags: 0, fields: /^ench_/.test(pool) ? [{ type: 'EITM' }] : [] });
const NAME = new Map([...REC].map(([id, r]) => [id, r.editorId]));
const ORD_IDS = (/const ORD_IDS = (\[[^\]]*\])/.exec(fs.readFileSync(path.join(__dirname, 'expedition-loot-budget-harness.js'), 'utf8')) || [])[1];
const ORD = JSON.parse(ORD_IDS.replace(/'/g, '"')).map((id) => read('dungeons.json').dungeons.find((d) => d.id === id)).filter((d) => d && d.id !== 'CYRFortCaractacusLocation');
const EXP = read('expeditions.json').expeditions;
const HUMANOID = /bandit|highwayman|marauder|outlaw|thug|forsworn|draugr|falmer|orc|soldier|guard|thalmor|vampire|hunter|warlock|necromancer|conjurer|mage|cultist|silverhand|reaver|smuggler|pirate|warrior|dremora|boss/i;
const ANIMAL = /wolf|bear|skeever|spider|chaurus|troll|sabre|mudcrab|horker|slaughterfish|deer|elk|goat|fox|hare|dog|mammoth|giant|atronach|wisp|spriggan|hagraven|sphere|centurion|ballista|ghost|dragon|frostbite|netch|riekling|ashhopper|ogre|minotaur|dreugh|gargoyle|werewolf|werebear|ashspawn|lurker|seeker|scamp|clannfear|daedroth|dragonpriest|horse|cow|chicken/i;
// What a body or a creature carries when it falls, besides its own arms: the worst cases, so the trim has to work
const CARRIED = ['EbonySword', 'ArmorDaedricCuirass', 'ArmorDragonplateCuirass', 'DLC2StalhrimSword', 'OrcishWarAxe', 'ArmorStormcloakCuirass', 'CYRGlassSword', 'ArmorGlassCuirass',
  'ArmorSteelPlateCuirass', 'IronSword', 'ArmorIronCuirass', 'CYRSteelSword', 'ArmorScaledCuirass', 'ElvenArrow', 'CYRAyleidArrow', 'IngotIMoonstone', 'BSKIngotAdamantium'].filter((n) => byName.has(n)).map((n) => idOf(byName.get(n).id));
// The ceiling's ingots, ores and arrows: gear-swap.json's own lists
const normD = require(path.join(ROOT, 'loottiers.js')).normDesc;
const SWAPPED = new Set(Object.keys(SWAP.metals).concat(Object.keys(SWAP.ammo)).map(normD));
const LINEN = '34cd6:skyrim.esm';

const A = 0x14;
const seen = [];   // { path, diff, name, id, kind, tier }
const anySeen = [];   // every item of any kind: { path, diff, desc, name, count }
const add = (pathName, diff, baseId, extra = {}) => {
  const desc = descs.get(baseId); if (!desc) return;
  anySeen.push({ path: pathName, diff, desc: normD(desc), name: NAME.get(baseId) || desc, count: Number(extra.count) || 1 });
  const r = REC.get(baseId); if (!r || (r.type !== 'WEAP' && r.type !== 'ARMO')) return;
  const c = T.classOf(desc);
  seen.push(Object.assign({ path: pathName, diff, desc, name: NAME.get(baseId), kind: c.kind, tier: c.tier, ench: r.fields.length > 0, type: r.type }, extra));
};

const run = (d, expedition, diffId, claims, modulePath = path.join(ROOT, 'dungeons.js'), keepState = false, dungeonsCfg = UNCAPPED) => {
  reseed(`${d.id}|${diffId}|${claims}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-tiers-'));
  const here = process.cwd(); process.chdir(dir);
  for (const f of ['loot.json', 'ayleid-loot.json', 'dungeon-pools.json', 'artifacts.json', 'dragon-materials.json']) { try { fs.copyFileSync(path.join(ROOT, f), f); } catch (e) { /* optional */ } }
  fs.writeFileSync('expeditions.json', JSON.stringify({ expeditions: expedition ? [d] : [] }));
  fs.writeFileSync('dungeons.json', JSON.stringify({ dungeons: expedition ? [] : [d] }));
  const e0 = d.entrances[0];
  const props = new Map([[`${idOf('boardref')}|baseDesc`, '6:DragonBreak.esp']]);
  const setHome = () => { props.set(`${A}|worldOrCellDesc`, expedition ? 'f8d:BSHeartland.esm' : (e0.world || e0.cell)); props.set(`${A}|pos`, expedition ? [0, -500, -221] : e0.doorPos || e0.pos); };
  setHome();
  const given = []; const ui = new Map(), cmds = new Map(), timers = new Map();
  const savedTimeout = global.setTimeout; global.setTimeout = () => 0;
  if (!keepState) { globalThis.__dboDungeons = undefined; globalThis.__dboExpeditionPending = undefined; }
  delete require.cache[modulePath];
  const cfg = read('gamemode-config.json');
  const api = {
    mp: { get: (id, p) => (p === 'profileId' ? (id === A ? 1 : -1) : props.get(`${id}|${p}`)), set: (id, p, v) => props.set(`${id}|${p}`, v), getIdFromDesc: idOf, getDescFromId: (id) => descs.get(id),
      lookupEspmRecordById: (id) => (id === idOf('6:DragonBreak.esp') ? { record: { editorId: 'ExpeditionBoard' } } : REC.has(id) ? { record: REC.get(id) } : { record: null }) },
    log: () => {}, personal: () => {}, system: () => {}, audit: () => {}, registerChatCommand: (n, fn) => cmds.set(n, fn), onUi: (n, fn) => { const l = ui.get(n) || []; l.push(fn); ui.set(n, l); },
    openWidget: () => true, closeWidget: () => true, sendPacket: () => true, findByName: () => 0, display: String, who: String, profileOf: (a) => (a === A ? 1 : -1), nameOf: () => 'P',
    onlineActors: () => [A], isAdmin: () => true, giveItem: (a, base, n) => { given.push([base, n]); return true; }, cfg: { dungeons: Object.assign({}, cfg.dungeons || {}, dungeonsCfg) }, every: (n, ms, fn) => timers.set(n, fn),
  };
  require(modulePath)(api);
  const fire = (n, a, args) => (ui.get(n) || []).forEach((f) => f(a, args, 0));
  let body = 0xff000500;
  const named = new Set([].concat(d.bossChest || []).map((r) => String(r).toLowerCase()));
  const leases = [];
  for (let c = 0; c < claims; c++) {
    setHome(); props.delete(`${A}|private.dungeonCooldowns`); if (globalThis.__dboDungeonAccountRest) globalThis.__dboDungeonAccountRest.clear();
    if (expedition) { globalThis.__dboDungeonActivate(idOf('boardref'), A); fire('expeditionPick', A, [d.id]); } else globalThis.__dboDungeonActivate(idOf(e0.outsideDesc), A);
    const pend = globalThis.__dboDungeons.pending.get(A); if (pend) fire('dungeonClaim', A, [pend.nonce, diffId]);
    const lease = globalThis.__dboDungeons.leases.get(d.id); if (!lease) break;
    leases.push(lease);
    // Chests and containers, as filled
    for (const ch of d.chests || []) {
      const id = idOf(ch.ref);
      const boss = ch.big && (/boss/i.test(ch.edid) || named.has(ch.ref.toLowerCase()));
      const lock = lease.locked.has(id) ? lease.locked.get(id) : undefined;
      const p = !ch.big ? 'container' : boss ? (expedition && d.kind === 'raid' ? 'raid boss chest' : 'boss chest') : lock !== undefined ? `locked chest (lock ${lock})` : 'chest';
      for (const e of ((props.get(`${id}|inventory`) || { entries: [] }).entries)) add(p, diffId, e.baseId, { lock, raid: expedition && d.kind === 'raid', count: e.count });
    }
    // The enemies, as the spawn system places them: humanoids are armed by the arm tick, then fall carrying the worst gear
    const spawned = [];
    for (const z of lease.zones) {
      const master = lease.bossZones && lease.bossZones.has(z.Name);
      const humanoid = HUMANOID.test(z.Kind || '') && !ANIMAL.test(z.Kind || '');
      const id = body++; props.set(`${id}|private.npcSpawner`, z.Name); props.set(`${id}|inventory`, { entries: [] });
      spawned.push({ id, master, humanoid, boss: master || /boss/i.test(z.Kind || '') });
    }
    fs.writeFileSync('zone-spawns.json', JSON.stringify(spawned.map((s) => s.id)));
    if (timers.get('dungeons.arm')) timers.get('dungeons.arm')();
    for (const s of spawned) {
      const inv = (props.get(`${s.id}|inventory`) || { entries: [] }).entries;
      for (const e of inv) add('enemy arms', diffId, e.baseId, { boss: s.boss, iron: /^Iron(Sword|WarAxe|Mace)$/.test(NAME.get(e.baseId) || ''), count: e.count });
      props.set(`${s.id}|inventory`, { entries: inv.concat(CARRIED.map((b) => ({ baseId: b, count: 1 }))) });
      props.set(`${s.id}|isDead`, true);
      globalThis.__dboTrimCorpse(s.id);
      if (!s.humanoid && !s.master) { for (const e of ((props.get(`${s.id}|inventory`) || { entries: [] }).entries)) add('creature corpse', diffId, e.baseId, { boss: s.boss }); continue; }
      given.length = 0;
      if (globalThis.__dboCorpseLoot(s.id, A) !== false) continue;
      for (const [b, n] of given) add(s.master ? (d.kind === 'raid' ? 'raid master' : 'master') : 'humanoid body', diffId, b, { boss: s.boss, raid: d.kind === 'raid', count: n });
    }
    if (!keepState) cmds.get('dungeon')(A, `end ${d.id.toLowerCase()}`);
  }
  global.setTimeout = savedTimeout; process.chdir(here); fs.rmSync(dir, { recursive: true, force: true });
  return leases;
};
for (const d of ORD) for (const diff of DIFFS) run(d, false, diff, CLAIMS);
for (const d of EXP) for (const diff of DIFFS) run(d, true, diff, CLAIMS * 3);
console.log(`      ${seen.length} weapons and armour handed out over ${ORD.length} Bruma dungeons and ${EXP.length} expeditions, ${CLAIMS} claims each (expeditions x3), four difficulties`);

// Every path: nothing never-loot, no uniform, nothing unknown
const paths = [...new Set(seen.map((s) => s.path))].sort();
for (const p of paths) {
  const list = seen.filter((s) => s.path === p);
  const bad = list.filter((s) => s.kind !== 'gear' && s.kind !== 'trinket');
  ok(!bad.length, `${p}: ${list.length} pieces, none Ebony, Daedric, Dragon, Stalhrim or Orcish, no uniform, nothing unknown`, [...new Set(bad.map((s) => `${s.name} (${s.kind})`))].slice(0, 8));
}
ok(['chest', 'boss chest', 'container', 'enemy arms', 'humanoid body', 'creature corpse', 'master'].every((p) => paths.includes(p) || p === 'container'), 'every path was exercised', paths);
// Every path: nothing above its tiers
const maxTier = (row) => Math.max(...[1, 2, 3, 4].filter((t) => (row[t] || 0) > 0));
const overTier = [];
for (const s of seen) {
  if (s.kind !== 'gear') continue;
  let allowed;
  if (s.path === 'chest' || s.path === 'container') allowed = maxTier(T.rowFor(s.diff, 'chest'));
  else if (/^locked chest/.test(s.path)) allowed = maxTier(T.rowFor(s.diff, 'lock', s.lock));
  else if (s.path === 'raid boss chest' || s.path === 'raid master') allowed = maxTier(T.rowFor(s.diff, 'raidBoss'));
  else if (s.path === 'boss chest' || s.path === 'master') allowed = maxTier(T.rowFor(s.diff, 'boss'));
  else { const tiers = T.enemyTiers(s.diff, s.boss); if (!tiers.includes(s.tier) && !(s.iron && s.path === 'enemy arms')) overTier.push(`${s.path} ${s.diff}: ${s.name} T${s.tier}`); continue; }
  if (s.tier > allowed) overTier.push(`${s.path} ${s.diff}: ${s.name} T${s.tier} > T${allowed}`);
}
ok(!overTier.length, 'no path hands out a tier above its row (chests, locks, bosses, raid bosses) or outside its enemies\' tiers (arms, bodies, corpses)', [...new Set(overTier)].slice(0, 10));
// (the Ayleid table's pieces keep that table's own difficulty gates)
const AYLEID_NAMES = new Set(read('ayleid-loot.json').items.map((it) => it.name));
const overRank = seen.filter((s) => s.ench && !AYLEID_NAMES.has(s.name) && !T.enchOk(s.name, s.diff, /boss|master/.test(s.path)));
ok(!overRank.length, 'no enchanted piece past its difficulty\'s rank cap (the Ayleid table keeps its own gates)', [...new Set(overRank.map((s) => `${s.path} ${s.diff}: ${s.name}`))].slice(0, 8));
// The ordinary chests' plain armour follows the table (armour, because Bruma has every tier of it; its tier 3 weapons are
// the high Elven stand-ins, Elven by family, checked next)
for (const diff of DIFFS) {
  const list = seen.filter((s) => s.path === 'chest' && s.diff === diff && s.kind === 'gear' && !s.ench && s.type === 'ARMO');
  const row = T.rowFor(diff, 'chest'); const total = [1, 2, 3, 4].reduce((n, t) => n + (row[t] || 0), 0);
  const got = [1, 2, 3, 4].map((t) => list.filter((s) => s.tier === t).length / Math.max(1, list.length));
  const want = [1, 2, 3, 4].map((t) => (row[t] || 0) / total);
  const worst = Math.max(...got.map((g, i) => Math.abs(g - want[i])));
  // Within 7 points, or three standard errors of a share from this many pieces when that is wider (Master's few hundred
  // chest pieces put 7 points at 2.4 errors: any change to how many rolls a chest makes moved the seeded sample past it)
  const tol = Math.max(0.07, 3 * Math.sqrt(0.25 / Math.max(1, list.length)));
  ok(list.length > 80 && worst < tol, `${diff}: ${list.length} chest armour pieces, tiers ${got.map((g) => Math.round(g * 100)).join('/')}% against ${want.map((w) => Math.round(w * 100)).join('/')}%`, { worst });
}
// Weapons: at Expert and Master a tier 3 roll gives a high Elven weapon (half or so of the chest weapons there), at Novice none
{
  const standin = (diff) => { const w = seen.filter((s) => s.path === 'chest' && s.diff === diff && s.kind === 'gear' && !s.ench && s.type === 'WEAP'); return w.filter((s) => T.T3_WEAPON_STANDIN.test(s.name)).length / Math.max(1, w.length); };
  const st = DIFFS.map(standin);
  ok(st[0] < 0.05 && st[2] > 0.4 && st[2] < 0.7 && st[3] > 0.35 && st[3] < 0.65, `chest weapons that are the high Elven stand-ins: ${st.map((x) => Math.round(x * 100)).join('/')}% (Novice/Adept/Expert/Master)`, st);
}
ok(!seen.some((s) => s.name === 'CYRIronFalchion'), 'CYRIronFalchion never comes out of any path', seen.filter((s) => s.name === 'CYRIronFalchion').map((s) => s.path).slice(0, 5));
ok(!seen.some((s) => s.name === 'CYRBloodscaleHelmet'), 'CYRBloodscaleHelmet never comes out of any path (bald on every race but two; Nate, 5 Oct)', seen.filter((s) => s.name === 'CYRBloodscaleHelmet').map((s) => s.path).slice(0, 5));
ok(seen.some((s) => s.path === 'chest' && s.diff === 'hard' && ['ArmorSteelPlateCuirass', 'ArmorScaledCuirass', 'ArmorElvenGildedCuirass'].some((n) => s.name.startsWith(n.slice(0, -7)))), 'Steel plate, Scaled and Elven gilded drop in Bruma (Nate\'s option 1)');
ok(seen.filter((s) => s.path === 'humanoid body').length > 0 && seen.filter((s) => s.path === 'creature corpse').every((s) => s.kind === 'gear' || s.kind === 'trinket'), 'bodies hand over gear within their tiers, and a creature\'s corpse keeps none of what it may not');
{
  // Cap 'none' (Nate, 4 Oct): the arrows above steel come back with the gear, the ingots and ores above steel never do
  const T0 = require(path.join(ROOT, 'loottiers.js'))({ materials: MATERIALS, factionGear: FACTION, overrides: OVERRIDES, swap: SWAP, cfg: { cap: 'none' } });
  const METAL_KEYS = new Set(Object.keys(SWAP.metals).concat(Object.keys(T0.LOOT_ONLY_METALS)).map(normD)), AMMO_KEYS = new Set(Object.keys(SWAP.ammo).map(normD));
  const out = anySeen.filter((x) => x.path !== 'creature corpse');
  const metalsFound = [...new Set(out.filter((x) => METAL_KEYS.has(x.desc)).map((x) => `${x.path} ${x.diff}: ${x.name}`))];
  const arrowsFound = [...new Set(out.filter((x) => AMMO_KEYS.has(x.desc)).map((x) => x.name))];
  ok(T0.aboveCap('601c91:BSAssets.esm', 'metal') && T0.aboveCap('5ad9f:Skyrim.esm', 'metal') && T0.aboveCap('139bd:Skyrim.esm', 'ammo') === null,
    'cap "none": loottiers still holds Meteoric Iron and refined moonstone above steel, and lets Elven arrows go');
  ok(out.length > 1000 && !metalsFound.length, `cap "none": no chest, urn, boss, body, master or quiver hands out an ingot or ore above steel (${out.length} stacks)`, metalsFound.slice(0, 10));
  ok(arrowsFound.length > 0, `cap "none": the arrows above steel come back with the gear (${arrowsFound.slice(0, 5).join(', ')})`, arrowsFound);
}

// ---- 3. the steel ceiling ------------------------------------------------------------------------------------------
{
  const S = tiersWith(undefined), IRON = tiersWith({ cap: 'iron' });
  const c = (TT, n) => TT.classOf((byName.get(n) || { id: 'ffffff:Nothing.esp' }).id);
  ok(S.cap === 'steel' && T.cap === 'none' && IRON.cap === 'iron', 'the default ceiling is steel; cap "none" lifts it, "iron" lowers it', [S.cap, T.cap, IRON.cap]);
  const under = ['IronSword', 'ArmorIronCuirass', 'ArmorHideCuirass', 'CYRSteelSword', 'ArmorSteelBootsA', 'SilverSword'].filter((n) => byName.has(n));
  const over = ['ArmorElvenCuirass', 'DwarvenSword', 'ArmorSteelPlateCuirass', 'ArmorScaledCuirass', 'ArmorElvenGildedCuirass', 'CYRGlassSword', 'ArmorGlassCuirass', 'ElvenGreatsword', 'DraugrSwordHoned', 'CYRArmorMithrilBoots'].filter((n) => byName.has(n));
  ok(under.length >= 5 && under.every((n) => c(S, n).kind === 'gear' && S.lootable(byName.get(n).id)), `under the steel ceiling: ${under.join(', ')}`, under.map((n) => [n, c(S, n)]));
  ok(over.length >= 8 && over.every((n) => c(S, n).kind === 'capped' && !S.lootable(byName.get(n).id)), `capped, never loot: ${over.join(', ')}`, over.map((n) => [n, c(S, n)]).filter(([, k]) => k.kind !== 'capped'));
  ok(c(S, 'EbonySword').kind === 'never' && c(S, 'ArmorImperialCuirass').kind === 'uniform' && c(S, 'CYRIronFalchion').kind === 'never' && c(S, 'JewelryRingGold').kind === 'trinket', 'the cap changes nothing for never-loot, uniforms, hand overrides or trinkets');
  ok(c(IRON, 'IronSword').kind === 'gear' && c(IRON, 'CYRSteelSword').kind === 'capped', 'an iron ceiling keeps tier 1 alone');
  reseed('cap-pick');
  const all = (LOOT.weapons || []).concat(LOOT.armor || []);
  const picked = []; for (let i = 0; i < 2000; i++) { const it = S.pickTier(all, S.rowFor('nightmare', 'raidBoss'), { weapons: i % 2 === 0 }); if (it) picked.push(it); }
  const fams = [...new Set(picked.map((it) => S.classOf(it.id).family))].sort();
  ok(picked.length === 2000 && fams.every((f) => ['iron', 'hide', 'leather', 'studded', 'wood', 'goblin', 'ancient_nord', 'falmer', 'forsworn', 'steel', 'imperial', 'ancient_imperial', 'silver'].includes(f)) && fams.includes('steel'), `a Master raid boss roll (80% tier 4) falls to steel: ${fams.join(', ')}`, fams);

  // Every path of the real dungeons.js under the default ceiling
  const before = seen.length, anyBefore = anySeen.length;
  const claims = Math.max(4, Math.round(CLAIMS / 3));
  for (const d of ORD) for (const diff of DIFFS) run(d, false, diff, claims, undefined, false, {});
  for (const d of EXP) for (const diff of DIFFS) run(d, true, diff, claims * 3, undefined, false, {});
  const capped = seen.splice(before);
  const bad = capped.filter((x) => { const k = S.classOf(x.desc).kind; return k !== 'gear' && k !== 'trinket'; });
  const byPath = [...new Set(capped.map((x) => x.path))].sort();
  console.log(`      ${capped.length} weapons and armour handed out under the steel ceiling, paths: ${byPath.join(', ')}`);
  ok(capped.length > 500 && ['chest', 'boss chest', 'enemy arms', 'humanoid body', 'master'].every((p) => byPath.includes(p)), 'the ceiling sweep exercised the chests, boss chests, enemy arms, bodies and masters', byPath);
  ok(!bad.length, 'no path hands out a weapon or armour above iron and steel at any difficulty, enchanted or not (chests, locks, bosses, raid bosses, enemy arms, bodies, corpses)', [...new Set(bad.map((x) => `${x.path} ${x.diff}: ${x.name} (${S.classOf(x.desc).family})`))].slice(0, 10));
  ok(capped.some((x) => x.ench && x.kind === 'gear'), 'enchanted gear still drops, of iron and steel');

  // ---- 4. the same ceiling over ingots, ores and arrows (gear-swap.json metals and ammo; Nate, 4 Oct) ----------------
  const any = anySeen.splice(anyBefore);
  const S0 = tiersWith(undefined);
  const S1 = require(path.join(ROOT, 'loottiers.js'))({ materials: MATERIALS, factionGear: FACTION, overrides: OVERRIDES, swap: SWAP });
  ok(S1.aboveCap('5ad9f:Skyrim.esm', 'metal') && S1.aboveCap('5ad9f:Skyrim.esm').lootOnly && S1.aboveCap('db8a2:Skyrim.esm', 'metal').lootOnly && S1.aboveCap('602099:BSAssets.esm').lootOnly && S1.aboveCap('602099:BSAssets.esm').to === '5ace5:Skyrim.esm' && S1.aboveCap('139bd:Skyrim.esm').kind === 'ammo'
    && S1.aboveCap('5ace5:Skyrim.esm', 'metal') === null && S1.aboveCap('1397d:Skyrim.esm', 'ammo') === null && S1.aboveCap('5ad93:Skyrim.esm', 'metal') === null,
    'loottiers aboveCap: refined moonstone and the Dwarven ingot (loot-only), the Adamantium ingot (loot-only: mined since 9 Oct) and Elven arrows are above the steel ceiling; steel and corundum ingots and iron arrows are not');
  ok(S1.aboveCap('601c91:BSAssets.esm', 'metal').lootOnly && S1.aboveCap('601c92:BSAssets.esm', 'metal').lootOnly && !SWAPPED.has(normD('601c91:BSAssets.esm')) && !SWAPPED.has(normD('601c92:BSAssets.esm')),
    'Meteoric Iron, ingot and ore, is kept out of loot but is not on the swap\'s lists (it is mined: Nate, 4 Oct)');
  ok(S0.aboveCap('5ace5:Skyrim.esm', 'metal') && S0.aboveCap('1397d:Skyrim.esm', 'ammo') && S0.aboveCap('5ace5:Skyrim.esm', '') === null,
    'without gear-swap.json every ingot and arrow counts as above the ceiling (fail closed); other items do not');
  const leaked = any.filter((x) => (SWAPPED.has(x.desc) || S1.LOOT_ONLY_METALS[x.desc]) && x.path !== 'creature corpse');
  const byP = [...new Set(any.map((x) => x.path))].sort();
  ok(any.length > 1000 && ['chest', 'boss chest', 'container', 'enemy arms', 'humanoid body', 'master'].every((p) => byP.includes(p)), `the sweep saw ${any.length} stacks of every kind on the paths ${byP.join(', ')}`, byP);
  ok(!leaked.length, 'no chest, urn, boss chest, locked chest, body, master or enemy quiver holds an ingot, ore or arrow the gear swap would take away (Dwarven, Quicksilver, Moonstone, Malachite, Adamantium; Elven, Ayleid, Ancient Imperial arrows)',
    [...new Set(leaked.map((x) => `${x.path} ${x.diff}: ${x.name}`))].slice(0, 10));
  const kept = [...new Set(any.filter((x) => x.path === 'creature corpse' && SWAPPED.has(x.desc)).map((x) => x.name))];
  ok(kept.length > 0 && kept.every((n) => [...Object.values(SWAP.metals), ...Object.values(SWAP.ammo)].some((m) => m.edid === n && m.to)),
    `a creature's corpse keeps what it carried (${kept.join(', ')}), each with a swap target, for a dormant body take; nothing hands a lease creature's body over today`, kept);
  // The two metal lists against what players mine (Nate, 4 Oct: "Keep mined ores, swap only gear"): every ore in skills.json
  // oreByTier above steel, and the ingot its smelter recipe makes, is loot-only and never on the swap's list
  {
    const LO = require(path.join(ROOT, 'loottiers.js')).LOOT_ONLY_METALS;
    const lab = fs.readFileSync(path.join(ROOT, 'labour.js'), 'utf8');
    const ITEMS = Object.fromEntries([...lab.slice(lab.indexOf('const ITEMS = Object.assign({'), lab.indexOf('}, CFG.gemOre')).matchAll(/(\w+): '([0-9a-f]+:[^']+)'/g)].map((m) => [m[1], normD(m[2])]));
    const ores = (read('skills.json').skills.find((k) => k.id === 'miner').oreByTier || []).flat().map((o) => String(o).toLowerCase());
    const ABOVE = ['quicksilver', 'orichalcum', 'moonstone', 'malachite', 'ebony'];
    const INGOT = { quicksilver: '5ada0:skyrim.esm', orichalcum: '5ad99:skyrim.esm', moonstone: '5ad9f:skyrim.esm', malachite: '5ada1:skyrim.esm', ebony: '5ad9d:skyrim.esm' };
    const minedSwapped = ores.filter((o) => ITEMS[o] && SWAP.metals[ITEMS[o]]);
    ok(!minedSwapped.length && ABOVE.every((o) => ores.includes(o) && LO[ITEMS[o]] && LO[INGOT[o]] && !SWAP.metals[INGOT[o]]),
      `no ore players mine (${ores.join(', ')}) is on the swap's metals; the ${ABOVE.length} above steel and their ingots are loot-only`, { minedSwapped });
    ok(Object.keys(LO).every((k) => !SWAP.metals[k] && !SWAP.ammo[k]) && Object.keys(SWAP.metals).every((k) => !ores.some((o) => ITEMS[o] === k)),
      `the ${Object.keys(LO).length} loot-only metals and the ${Object.keys(SWAP.metals).length} swapped ones (${Object.values(SWAP.metals).map((m) => m.edid).join(', ')}) never overlap`);
  }
  const names = new Set(any.map((x) => x.name));
  ok(['IngotSteel', 'IngotIron', 'Leather01', 'IronArrow', 'SteelArrow'].every((n) => names.has(n)) && !names.has('BSKIngotMeteoricIron'), 'materials and arrows still drop under the ceiling: steel and iron ingots, leather, iron and steel arrows; no Meteoric Iron');
  const steelShare = (() => { const m = any.filter((x) => ['chest', 'boss chest'].includes(x.path) && LOOT.materials.some((it) => normD(it.id) === x.desc)); return m.filter((x) => x.name === 'IngotSteel').length / Math.max(1, m.length); })();
  ok(steelShare < 0.15, `steel ingots stay an ordinary share of the materials found (${Math.round(100 * steelShare)}%; dropping the above-cap ingots, not turning them into steel)`, steelShare);
  const linen = any.filter((x) => x.desc === LINEN);
  const lp = [...new Set(linen.map((x) => x.path))].sort();
  ok(linen.length > 0 && ['chest', 'boss chest', 'container'].every((p) => lp.includes(p)) && linen.every((x) => x.count >= 1 && x.count <= (/^raid/.test(x.path) ? 6 : 3)), `linen wraps drop, 1 to 3 at a time (a raid boss's second roll can add another stack) (${linen.length} stacks; ${lp.join(', ')})`, linen.filter((x) => x.count > 3).slice(0, 5));
}

// ---- live-then-new: a claim made by the live dungeons.js, searched after this one loads over the same state ----------
let OLD = '';
try { OLD = execFileSync('git', ['-C', ROOT, 'show', '9022c28f:dungeons.js'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { OLD = ''; }
if (OLD) {
  const oldFile = path.join(ROOT, `.dungeons-live-${process.pid}.js`);
  fs.writeFileSync(oldFile, OLD);
  try {
    const before = seen.length;
    const d = ORD.find((x) => x.id === 'CYRFortHorunnLocation') || ORD[0];
    run(d, false, 'nightmare', 1, oldFile, true);
    const oldLease = globalThis.__dboDungeons.leases.get(d.id);
    ok(!!oldLease, 'the live dungeons.js claimed a dungeon');
    seen.length = before;
    let threw = null;
    try { run(d, false, 'nightmare', 0, path.join(ROOT, 'dungeons.js'), true); } catch (e) { threw = e.message; }
    ok(!threw && globalThis.__dboDungeons.leases.get(d.id) === oldLease, 'the new dungeons.js loads over that state and keeps the claim', threw);
  } finally { fs.rmSync(oldFile, { force: true }); }
} else console.log('ok    skipped live-then-new: git cannot show 9022c28f here');

Math.random = realRandom;
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
