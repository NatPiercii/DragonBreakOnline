// Scripted test for the enchantment caps in craftedExtrasSystem.ts (2026-09-30): an accepted player enchantment is
// clamped to the enchanter's share of the strongest base game player enchantment of that effect (Skyrim.esm, Update and
// the DLC, the EnchWeapon, EnchArmor and EnchRobes families), never a mod's; an effect from a mod is capped by its own
// plugin's families (Beyond Skyrim's BSKEnchArmorWaterWalking), and effects on the Alchemy and Enchanting skills are
// refused. It bundles craftedExtrasSystem.ts with esbuild (settings stubbed) and sends enchanting reports on
// a fake mp whose records are made up here (numbers modelled on the base game's). Run it from skymp5-server with
// node_modules present:
//
//   node tests/crafted-enchant-cap-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const esbuild = require(path.join(root, 'node_modules', 'esbuild'));
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-crafted-'));
const bundle = path.join(out, 'crafted.js');

let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

// ---- records ----
const f32 = (x) => { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, x, true); return b; };
const u32s = (...xs) => { const b = new Uint8Array(4 * xs.length); const v = new DataView(b.buffer); xs.forEach((x, i) => v.setUint32(4 * i, x >>> 0, true)); return b; };
const efit = (mag, area = 0, dur = 0) => { const b = new Uint8Array(12); const v = new DataView(b.buffer); v.setFloat32(0, mag, true); v.setUint32(4, area, true); v.setUint32(8, dur, true); return b; };
// ENIT: cost, flags, cast type, amount, delivery, enchant type (6 = enchantment), charge time, base, worn restrictions
const enit = (weapon) => u32s(0, 0, weapon ? 1 : 0, 0, weapon ? 1 : 0, 6, 0, 0, 0);
const mgefData = (av, baseCost = 1) => { const b = new Uint8Array(152); const v = new DataView(b.buffer); v.setFloat32(4, baseCost, true); v.setInt32(68, av, true); return b; };
const records = new Map();
const rec = (id, type, editorId, fields) => records.set(id >>> 0, { record: { type, editorId, fields }, toGlobalRecordId: (x) => x >>> 0 });
const ench = (id, editorId, weapon, effects) => rec(id, 'ENCH', editorId,
  [{ type: 'ENIT', data: enit(weapon) }, ...effects.flatMap(([e, m, a, d]) => [{ type: 'EFID', data: u32s(e) }, { type: 'EFIT', data: efit(m, a, d) }])]);

const FORTIFY_HEALTH = 0x000493aa, FIRE_DAMAGE = 0x0004605a, FORTIFY_ALCHEMY = 0x0008b65c, ROBES_ENCHANTING = 0x00109632;
const FORTIFY_ALCHEMY_POTION = 0x0003eb18, TRAP_FIRE = 0x0010a0a0, HORSE_HEALTH = 0x01005000, MOD_EFFECT = 0x31000800;
rec(FORTIFY_HEALTH, 'MGEF', 'EnchFortifyHealthConstantSelf', [{ type: 'DATA', data: mgefData(24) }]);
rec(FIRE_DAMAGE, 'MGEF', 'EnchFireDamageFFContact', [{ type: 'DATA', data: mgefData(24) }]);
rec(FORTIFY_ALCHEMY, 'MGEF', 'EnchFortifyAlchemyConstantSelf', [{ type: 'DATA', data: mgefData(106) }]);
rec(ROBES_ENCHANTING, 'MGEF', 'EnchRobesFortifyEnchantingConstantSelf', [{ type: 'DATA', data: mgefData(23) }]);
rec(FORTIFY_ALCHEMY_POTION, 'MGEF', 'AlchFortifyAlchemy', [{ type: 'DATA', data: mgefData(145) }]);
rec(TRAP_FIRE, 'MGEF', 'TrapRuneFireFFLocation06', [{ type: 'DATA', data: mgefData(24) }]);
rec(HORSE_HEALTH, 'MGEF', 'CCHorseArmorEnchFortifyHealthConstantSelf', [{ type: 'DATA', data: mgefData(24) }]);
rec(MOD_EFFECT, 'MGEF', 'ModOnlyEffect', [{ type: 'DATA', data: mgefData(24) }]);
// A light plugin (0xFE, slot 0x602) like BSAssets: water walking with its own armor family; one effect has no family, one
// is carried only by another plugin's family
const BS_WATER_WALKING = 0xfe602514, BS_NO_FAMILY = 0xfe602520, BS_ELSEWHERE = 0xfe602530;
rec(BS_WATER_WALKING, 'MGEF', 'BSKEnchWaterWalkingConstantSelf', [{ type: 'DATA', data: mgefData(0) }]);
rec(BS_NO_FAMILY, 'MGEF', 'BSKSomeSpellEffect', [{ type: 'DATA', data: mgefData(24) }]);
rec(BS_ELSEWHERE, 'MGEF', 'BSKOtherEffect', [{ type: 'DATA', data: mgefData(24) }]);
// The base game's player families (Skyrim.esm 0x00, Dawnguard 0x02)
ench(0x0004950a, 'EnchArmorFortifyHealth01', false, [[FORTIFY_HEALTH, 20]]);
ench(0x0004950f, 'EnchArmorFortifyHealth06', false, [[FORTIFY_HEALTH, 70]]);
ench(0x00045f9d, 'EnchWeaponFireDamage06', true, [[FIRE_DAMAGE, 30]]);
ench(0x0008b65d, 'EnchArmorFortifyAlchemy06', false, [[FORTIFY_ALCHEMY, 25]]);
ench(0x02010000, 'EnchRobesFortifyEnchanting06', false, [[ROBES_ENCHANTING, 25]]);
ench(0x00108000, 'EnchArmorFortifyAlchemyPotionLike', false, [[FORTIFY_ALCHEMY_POTION, 25]]);
// Base game, but not a player family: a trap rune, a Creation Club horse armor
ench(0x0010a0a1, 'TrapFireRune', true, [[TRAP_FIRE, 120]]);
ench(0x01005001, 'CCHorseArmorEnchFortifyHealth', false, [[HORSE_HEALTH, 1000], [FORTIFY_HEALTH, 1000]]);
// Mods (top byte past the base game): a test ring, a mod family, a mod-only effect
ench(0x2a000801, 'EnchArmorFortifyHealth07', false, [[FORTIFY_HEALTH, 5000]]);
ench(0x31000801, 'EnchWeaponModFire', true, [[FIRE_DAMAGE, 500], [MOD_EFFECT, 90]]);
ench(0xfe602515, 'BSKEnchArmorWaterWalking', false, [[BS_WATER_WALKING, 1, 0, 0]]);
ench(0xfe602516, 'BSKEnchArmorWaterWalking02', false, [[BS_WATER_WALKING, 1, 0, 0], [FORTIFY_HEALTH, 900]]);
ench(0xfe602517, 'BSKWaterWalkingTrap', false, [[BS_NO_FAMILY, 500]]);
ench(0xfe603001, 'BSKEnchArmorOther', false, [[BS_ELSEWHERE, 500]]);

const RING = 0x0001cb34, SWORD = 0x00012eb7, GEM = 0x0002e4ff, BENCH = 0x000bad0c, BENCH_BASE = 0x000bad0d;
rec(RING, 'ARMO', 'JewelryRingGold', []);
rec(SWORD, 'WEAP', 'IronSword', []);
rec(GEM, 'SLGM', 'SoulGemGrandFilled', [{ type: 'SOUL', data: new Uint8Array([5]) }]);
rec(BENCH_BASE, 'FURN', 'ArcaneEnchanter', [{ type: 'WBDT', data: new Uint8Array([3, 0]) }]);

const LOAD_ORDER = ['Skyrim.esm', 'Update.esm', 'Dawnguard.esm', 'HearthFires.esm', 'Dragonborn.esm', 'ccBGSSSE001-Fish.esm']
  .map((n) => `/opt/skyrim-data/${n}`);

(async () => {
  await esbuild.build({
    entryPoints: [path.join(root, 'ts', 'systems', 'craftedExtrasSystem.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'error',
    plugins: [{
      name: 'stubs',
      setup(b) {
        b.onResolve({ filter: /^\.\.\/settings$/ }, (a) => ({ path: a.path, namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: 'module.exports = { Settings: { get: async () => globalThis.__craftedSettings } };', loader: 'js',
        }));
      },
    }],
  });
  const { CraftedExtrasSystem } = require(bundle);

  const A = 0xff000014;
  const props = new Map();
  const sent = [];
  const logs = [];
  const mp = {
    get: (id, k) => props.get(`${id >>> 0}|${k}`),
    set: (id, k, v) => props.set(`${id >>> 0}|${k}`, v),
    getUserActor: (u) => (u === 1 ? A : 0),
    getActorPos: () => [0, 0, 0],
    getIdFromDesc: () => BENCH_BASE,
    lookupEspmRecordById: (id) => records.get(id >>> 0) || null,
    getEspmRecordIdsByType: (t) => [...records.entries()].filter(([, r]) => r.record.type === t).map(([id]) => id),
    sendCustomPacket: (u, p) => sent.push([u, JSON.parse(p)]),
  };
  props.set(`${BENCH}|worldOrCellDesc`, 'cell'); props.set(`${A}|worldOrCellDesc`, 'cell');
  props.set(`${BENCH}|pos`, [50, 0, 0]); props.set(`${BENCH}|baseDesc`, 'bench');
  const ctx = { svr: mp, gm: { on() {}, emit() {} } };

  let now = 1_000_000;
  const realNow = Date.now;
  Date.now = () => now;
  const boot = async (loadOrder, rankGates = true) => {
    globalThis.__craftedSettings = { allSettings: { craftedExtrasRankGates: rankGates }, loadOrder };
    const sys = new CraftedExtrasSystem((...x) => logs.push(x.join(' ')));
    await sys.initAsync(Object.assign({}, ctx, { svr: Object.assign({}, mp) }));
    return sys;
  };
  const setRank = (rank) => props.set(`${A}|private.mastery`, { order: ['enchanter'], skills: { enchanter: { rank } } });
  // One enchanting report: a fresh plain item and a grand soul, the client's copy carrying these effects
  const enchant = (sys, item, effects) => {
    props.set(`${A}|inventory`, { entries: [{ baseId: item, count: 1 }, { baseId: GEM, count: 1 }] });
    sent.length = 0;
    now += 1000;
    const g = { baseId: item, count: 1, enchantmentEffects: effects.map(([effectId, magnitude, duration]) => ({ effectId, magnitude, area: 0, duration: duration || 0, cost: 50 })) };
    if (item === SWORD) Object.assign(g, { maxCharge: 3000, chargePercent: 3000 });
    sys.customPacket(1, 'craftedExtras', { workbench: BENCH, gained: [g], lost: [{ baseId: item, count: 1 }, { baseId: GEM, count: 1 }] }, ctx);
    const inv = props.get(`${A}|inventory`).entries;
    const made = inv.find((e) => e.baseId === item && e.enchantmentEffects);
    return { made, refused: sent.some(([, p]) => p.customPacketType === 'craftedExtrasRefused'), gemLeft: inv.some((e) => e.baseId === GEM) };
  };
  const mag = (r, id) => (r.made ? (r.made.enchantmentEffects.find((e) => e.effectId === id) || {}).magnitude : undefined);

  // ---- the caps ----
  let sys = await boot(LOAD_ORDER);
  setRank(4);
  let r = enchant(sys, RING, [[FORTIFY_HEALTH, 60]]);
  check('an ordinary Fortify Health 60 ring is accepted as made', mag(r, FORTIFY_HEALTH) === 60 && !r.refused && !r.gemLeft, r.made);
  r = enchant(sys, RING, [[FORTIFY_HEALTH, 1e6]]);
  check('a Master\'s Fortify Health 1,000,000 is stored at twice the base game\'s strongest (70 x 2), not a mod ring\'s 5000', mag(r, FORTIFY_HEALTH) === 140, mag(r, FORTIFY_HEALTH));
  r = enchant(sys, SWORD, [[FIRE_DAMAGE, 1e6]]);
  check('a weapon\'s Fire Damage 1,000,000 is stored at 30 x 2, not a mod weapon\'s 500 or a trap rune\'s', mag(r, FIRE_DAMAGE) === 60, mag(r, FIRE_DAMAGE));
  r = enchant(sys, RING, [[FORTIFY_ALCHEMY, 10]]);
  check('Fortify Alchemy on an item is refused (the item keeps its old state, the soul is not spent)', !r.made && r.refused && r.gemLeft);
  r = enchant(sys, RING, [[ROBES_ENCHANTING, 10]]);
  check('Fortify Enchanting on an item is refused', !r.made && r.refused);
  r = enchant(sys, RING, [[FORTIFY_ALCHEMY_POTION, 10]]);
  check('...and so is any effect on the Alchemy skill (the potion effect\'s actor value)', !r.made && r.refused);
  r = enchant(sys, RING, [[FORTIFY_HEALTH, 50], [FORTIFY_ALCHEMY, 10]]);
  check('a second effect of Fortify Alchemy refuses the whole enchantment', !r.made && r.refused);
  r = enchant(sys, SWORD, [[MOD_EFFECT, 1e6]]);
  check('an effect from a mod is capped by its own plugin\'s family (90 x 2)', mag(r, MOD_EFFECT) === 180 && !r.refused, mag(r, MOD_EFFECT));
  r = enchant(sys, RING, [[BS_WATER_WALKING, 1]]);
  check('a Beyond Skyrim Water Walking ring is accepted as made', mag(r, BS_WATER_WALKING) === 1 && !r.refused, r.made);
  r = enchant(sys, RING, [[BS_WATER_WALKING, 1e6], [FORTIFY_HEALTH, 1e6]]);
  check('...capped at its family\'s 1 x 2, and the mod family\'s Fortify Health 900 does not raise the base cap of 140',
    mag(r, BS_WATER_WALKING) === 2 && mag(r, FORTIFY_HEALTH) === 140, r.made);
  r = enchant(sys, SWORD, [[BS_WATER_WALKING, 1]]);
  check('an armor-only mod effect on a weapon is refused', !r.made && r.refused);
  r = enchant(sys, RING, [[BS_NO_FAMILY, 10]]);
  check('a mod effect with no player family (only a trap carries it) is refused', !r.made && r.refused);
  r = enchant(sys, RING, [[BS_ELSEWHERE, 10]]);
  check('a mod effect carried only by another plugin\'s family is refused', !r.made && r.refused);
  r = enchant(sys, RING, [[HORSE_HEALTH, 900]]);
  check('a base game effect outside the player families (Creation Club horse armor) is refused', !r.made && r.refused);
  check('each refused effect is logged once', logs.filter((l) => /refused an enchantment with armor effect fe602520/.test(l)).length === 1, logs.filter((l) => /refused/.test(l)));
  check('the caps log names the base game files', logs.some((l) => /enchantment effects known from 5 base game files, 2 of them from their own mod's families/.test(l)), logs.filter((l) => /known/.test(l)));

  // ---- the loop: every cycle the client's magnitude grows, the stored one plateaus at the cap ----
  for (const [rank, share] of [[0, 0.5], [2, 1], [4, 2]]) {
    setRank(rank);
    const stored = [];
    let m = 20;
    for (let cycle = 0; cycle < 12; cycle++) {
      m *= 1.9;
      stored.push(mag(enchant(sys, RING, [[FORTIFY_HEALTH, m]]), FORTIFY_HEALTH));
      stored.push(mag(enchant(sys, SWORD, [[FIRE_DAMAGE, m]]), FIRE_DAMAGE));
    }
    const health = stored.filter((_, i) => i % 2 === 0), fire = stored.filter((_, i) => i % 2 === 1);
    check(`12 cycles at rank ${rank}: Fortify Health plateaus at ${70 * share}, Fire Damage at ${30 * share}`,
      Math.max(...health) === 70 * share && health.slice(-6).every((x) => x === 70 * share) && Math.max(...fire) === 30 * share && fire.slice(-6).every((x) => x === 30 * share), { health, fire });
  }

  // ---- a load order that does not start with the base game refuses every enchantment ----
  sys = await boot(['/opt/skyrim-data/Some Mod.esm', ...LOAD_ORDER]);
  setRank(4);
  r = enchant(sys, RING, [[FORTIFY_HEALTH, 50]]);
  check('with no base game at the head of the load order nothing sets a cap, so enchanting is refused', !r.made && r.refused);
  sys = await boot(undefined);
  setRank(4);
  r = enchant(sys, RING, [[FORTIFY_HEALTH, 1e6]]);
  check('with no load order to read, the five base game files are assumed to lead it', mag(r, FORTIFY_HEALTH) === 140, mag(r, FORTIFY_HEALTH));
  sys = await boot(LOAD_ORDER.map((p) => p.replace(/\//g, '\\\\').toUpperCase()));
  setRank(4);
  r = enchant(sys, RING, [[FORTIFY_HEALTH, 50]]);
  check('Windows paths and any letter case are read', mag(r, FORTIFY_HEALTH) === 50);

  Date.now = realNow;
  fs.rmSync(out, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
