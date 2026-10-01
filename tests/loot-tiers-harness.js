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
const MATERIALS = read('loot-materials.json'), FACTION = read('faction-gear.json'), LOOT = read('loot.json').pools;
const T = require(path.join(ROOT, 'loottiers.js'))({ materials: MATERIALS, factionGear: FACTION });
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
  'ArmorSteelPlateCuirass', 'IronSword', 'ArmorIronCuirass', 'CYRSteelSword', 'ArmorScaledCuirass'].filter((n) => byName.has(n)).map((n) => idOf(byName.get(n).id));

const A = 0x14;
const seen = [];   // { path, diff, name, id, kind, tier }
const add = (pathName, diff, baseId, extra = {}) => {
  const desc = descs.get(baseId); if (!desc) return;
  const r = REC.get(baseId); if (!r || (r.type !== 'WEAP' && r.type !== 'ARMO')) return;
  const c = T.classOf(desc);
  seen.push(Object.assign({ path: pathName, diff, name: NAME.get(baseId), kind: c.kind, tier: c.tier, ench: r.fields.length > 0, type: r.type }, extra));
};

const run = (d, expedition, diffId, claims, modulePath = path.join(ROOT, 'dungeons.js'), keepState = false) => {
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
    onlineActors: () => [A], isAdmin: () => true, giveItem: (a, base, n) => { given.push([base, n]); return true; }, cfg: { dungeons: cfg.dungeons || {} }, every: (n, ms, fn) => timers.set(n, fn),
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
      for (const e of ((props.get(`${id}|inventory`) || { entries: [] }).entries)) add(p, diffId, e.baseId, { lock, raid: expedition && d.kind === 'raid' });
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
      for (const e of inv) add('enemy arms', diffId, e.baseId, { boss: s.boss, iron: /^Iron(Sword|WarAxe|Mace)$/.test(NAME.get(e.baseId) || '') });
      props.set(`${s.id}|inventory`, { entries: inv.concat(CARRIED.map((b) => ({ baseId: b, count: 1 }))) });
      props.set(`${s.id}|isDead`, true);
      globalThis.__dboTrimCorpse(s.id);
      if (!s.humanoid && !s.master) { for (const e of ((props.get(`${s.id}|inventory`) || { entries: [] }).entries)) add('creature corpse', diffId, e.baseId, { boss: s.boss }); continue; }
      given.length = 0;
      if (globalThis.__dboCorpseLoot(s.id, A) !== false) continue;
      for (const [b] of given) add(s.master ? (d.kind === 'raid' ? 'raid master' : 'master') : 'humanoid body', diffId, b, { boss: s.boss, raid: d.kind === 'raid' });
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
  ok(list.length > 80 && worst < 0.07, `${diff}: ${list.length} chest armour pieces, tiers ${got.map((g) => Math.round(g * 100)).join('/')}% against ${want.map((w) => Math.round(w * 100)).join('/')}%`, { worst });
}
// Weapons: at Expert and Master a tier 3 roll gives a high Elven weapon (half or so of the chest weapons there), at Novice none
{
  const standin = (diff) => { const w = seen.filter((s) => s.path === 'chest' && s.diff === diff && s.kind === 'gear' && !s.ench && s.type === 'WEAP'); return w.filter((s) => T.T3_WEAPON_STANDIN.test(s.name)).length / Math.max(1, w.length); };
  const st = DIFFS.map(standin);
  ok(st[0] < 0.05 && st[2] > 0.4 && st[2] < 0.7 && st[3] > 0.35 && st[3] < 0.65, `chest weapons that are the high Elven stand-ins: ${st.map((x) => Math.round(x * 100)).join('/')}% (Novice/Adept/Expert/Master)`, st);
}
ok(seen.some((s) => s.path === 'chest' && s.diff === 'hard' && ['ArmorSteelPlateCuirass', 'ArmorScaledCuirass', 'ArmorElvenGildedCuirass'].some((n) => s.name.startsWith(n.slice(0, -7)))), 'Steel plate, Scaled and Elven gilded drop in Bruma (Nate\'s option 1)');
ok(seen.filter((s) => s.path === 'humanoid body').length > 0 && seen.filter((s) => s.path === 'creature corpse').every((s) => s.kind === 'gear' || s.kind === 'trinket'), 'bodies hand over gear within their tiers, and a creature\'s corpse keeps none of what it may not');

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
