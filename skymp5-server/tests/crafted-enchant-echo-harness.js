// Scripted test for an accepted enchantment refused half a second later (7 Oct, Jon Grey: "enchanted with a size 1 soul"
// then "refused (item)" for the same item, and the player told "That item cannot take an enchantment"). The server stored
// the enchantment held to the Novice share (Absorb Stamina's fixed 1 second floored to 0); the client, still in the
// Crafting Menu, saw its own copy differ from the server's and reported it again, and that report met an item already
// enchanted. It bundles craftedExtrasSystem.ts with esbuild (settings stubbed), records modelled on Skyrim.esm. Run it from
// skymp5-server with node_modules present:
//
//   node tests/crafted-enchant-echo-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const esbuild = require(path.join(root, 'node_modules', 'esbuild'));
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-jake-b-crafted-'));
const bundle = path.join(out, 'crafted.js');

let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

// ---- records (Skyrim.esm values) ----
const u32s = (...xs) => { const b = new Uint8Array(4 * xs.length); const v = new DataView(b.buffer); xs.forEach((x, i) => v.setUint32(4 * i, x >>> 0, true)); return b; };
const efit = (mag, area = 0, dur = 0) => { const b = new Uint8Array(12); const v = new DataView(b.buffer); v.setFloat32(0, mag, true); v.setUint32(4, area, true); v.setUint32(8, dur, true); return b; };
const enit = (weapon, baseEnch = 0) => u32s(0, 0, weapon ? 1 : 0, 0, weapon ? 1 : 0, 6, 0, baseEnch, 0);
// MGEF DATA: flags at 0, base cost at 4, primary actor value at 68
const mgefData = (flags, baseCost, av) => { const b = new Uint8Array(152); const v = new DataView(b.buffer); v.setUint32(0, flags, true); v.setFloat32(4, baseCost, true); v.setInt32(68, av, true); return b; };
const records = new Map();
const rec = (id, type, editorId, fields) => records.set(id >>> 0, { record: { type, editorId, fields }, toGlobalRecordId: (x) => x >>> 0 });
const ench = (id, editorId, effects, baseEnch = 0) => rec(id, 'ENCH', editorId,
  [{ type: 'ENIT', data: enit(true, baseEnch) }, ...effects.flatMap(([e, m, a, d]) => [{ type: 'EFID', data: u32s(e) }, { type: 'EFIT', data: efit(m, a, d) }])]);

// EnchAbsorbStaminaFFContact (power affects magnitude), EnchParalysisFFContact (power affects duration), EnchFireDamageFFContact
const ABSORB_STAMINA = 0x000aa157, PARALYSIS = 0x000acbb6, FIRE_DAMAGE = 0x0004605a;
rec(ABSORB_STAMINA, 'MGEF', 'EnchAbsorbStaminaFFContact', [{ type: 'DATA', data: mgefData(0x10201805, 22, 26) }]);
rec(PARALYSIS, 'MGEF', 'EnchParalysisFFContact', [{ type: 'DATA', data: mgefData(0x401403, 200, 53) }]);
rec(FIRE_DAMAGE, 'MGEF', 'EnchFireDamageFFContact', [{ type: 'DATA', data: mgefData(0x10220805, 0.9, 24) }]);
ench(0x0010fb92, 'EnchWeaponAbsorbStaminaBase', [[ABSORB_STAMINA, 10, 0, 1]]);
ench(0x000aa165, 'EnchWeaponAbsorbStamina06', [[ABSORB_STAMINA, 30, 0, 1]], 0x0010fb92);
ench(0x0010fb98, 'EnchWeaponParalysisBase', [[PARALYSIS, 0, 0, 2]]);
ench(0x000acbbc, 'EnchWeaponParalysis06', [[PARALYSIS, 0, 0, 6]], 0x0010fb98);
ench(0x00045c35, 'EnchWeaponFireDamage06', [[FIRE_DAMAGE, 30, 0, 0]], 0x0010fb95);

const DAGGER = 0x000cade9, SWORD = 0x00013987, PETTY = 0x0002e4e3, BENCH = 0x000bad0c, BENCH_BASE = 0x000bad0d;
rec(DAGGER, 'WEAP', 'SteelDagger', []);
rec(SWORD, 'WEAP', 'SteelSword', []);
rec(PETTY, 'SLGM', 'SoulGemPettyFilled', [{ type: 'SOUL', data: new Uint8Array([1]) }]);
rec(BENCH_BASE, 'FURN', 'ArcaneEnchanter', [{ type: 'WBDT', data: new Uint8Array([3, 0]) }]);

const LOAD_ORDER = ['Skyrim.esm', 'Update.esm', 'Dawnguard.esm', 'HearthFires.esm', 'Dragonborn.esm'].map((n) => `/opt/skyrim-data/${n}`);
// The client's sameEffects (skymp5-client/src/sync/inventory.ts): what decides whether it reports the item again
const sameFloat = (a, b) => Math.abs(a - b) <= 1e-3 * Math.max(1, Math.abs(a));
const clientSameEffects = (a, b) => { const x = a || [], y = b || []; return x.length === y.length && x.every((e, i) =>
  e.effectId === y[i].effectId && e.area === y[i].area && e.duration === y[i].duration && sameFloat(e.magnitude, y[i].magnitude)); };

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

  const A = 0xff002071;
  const props = new Map();
  const sent = [];
  const logs = [];
  const mp = {
    get: (id, k) => props.get(`${id >>> 0}|${k}`),
    set: (id, k, v) => props.set(`${id >>> 0}|${k}`, JSON.parse(JSON.stringify(v))),
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
  // The settings are read at boot, so turning the rank gates off is a new system
  const boot = async (rankGates) => {
    globalThis.__craftedSettings = { allSettings: { craftedExtrasRankGates: rankGates }, loadOrder: LOAD_ORDER };
    const s = new CraftedExtrasSystem((...x) => logs.push(x.join(' ')));
    await s.initAsync(ctx);
    return s;
  };
  let sys = await boot(true);
  // Jon Grey's Enchanter rank on 7 Oct: Novice (rank 0, a share of 0.5)
  props.set(`${A}|private.mastery`, { order: ['enchanter'], skills: { enchanter: { rank: 0 } } });

  const inventory = () => props.get(`${A}|inventory`).entries;
  const report = (gained, lost) => {
    sent.length = 0;
    logs.length = 0;
    now += 61000;
    sys.customPacket(1, 'craftedExtras', { workbench: BENCH, gained, lost }, ctx);
  };
  const notice = () => { const n = sent.find(([, p]) => p.customPacketType === 'notification'); return n ? n[1].text : ''; };
  const revertIds = () => { const r = sent.find(([, p]) => p.customPacketType === 'craftedExtrasRefused'); return r ? r[1].baseIds : []; };
  const effect = (effectId, magnitude, duration, cost = 50) => ({ effectId, magnitude, area: 0, duration, cost });
  // The client's copy right after the Enchanting menu made it, and its report: the plain item and a petty soul gone
  const enchant = (item, effects) => {
    props.set(`${A}|inventory`, { entries: [{ baseId: item, count: 1 }, { baseId: PETTY, count: 1 }] });
    const local = { baseId: item, count: 1, enchantmentEffects: effects, maxCharge: 250, chargePercent: 250, name: 'Thorns' };
    report([local], [{ baseId: item, count: 1 }, { baseId: PETTY, count: 1 }]);
    return local;
  };
  // What the client does about 0.3 s after the server's SetInventory while the menu holds its apply: report again any
  // copy that differs from the server's, with the server's copy as the one it no longer has
  const echo = (local) => {
    const server = inventory().find((e) => e.baseId === local.baseId);
    const differs = !clientSameEffects(server.enchantmentEffects, local.enchantmentEffects);
    if (differs) report([local], [{ ...server }]);
    return { differs, server };
  };

  // ---- 7 Oct: a Novice puts Absorb Stamina 10 (1 second, as the base game makes it) on a steel dagger ----
  let local = enchant(DAGGER, [effect(ABSORB_STAMINA, 10, 1)]);
  let stored = inventory().find((e) => e.baseId === DAGGER);
  check('the enchantment is accepted and the petty soul spent', !!(stored && stored.enchantmentEffects) && !inventory().some((e) => e.baseId === PETTY), stored);
  check('Absorb Stamina keeps its fixed 1 second: the Novice share caps its magnitude (15), never floors its duration to 0',
    stored.enchantmentEffects[0].duration === 1 && stored.enchantmentEffects[0].magnitude === 10, stored.enchantmentEffects);
  let e = echo(local);
  check('the client\'s copy matches the server\'s, so it has nothing to report again', !e.differs, e.server.enchantmentEffects);
  check('no "refused (item)" follows the accepted enchantment', !logs.some((l) => /refused \(item\)/.test(l)), logs);
  check('the player is not told "That item cannot take an enchantment"', !/cannot take an enchantment/.test(notice()), notice());

  // ---- a power-scaled duration is still held to the rank (Paralysis 6 s at a 0.5 share is 3 s) ----
  enchant(SWORD, [effect(PARALYSIS, 0, 6)]);
  stored = inventory().find((e) => e.baseId === SWORD);
  check('Paralysis, whose duration enchanting power scales, is still held to the Novice share (3 of 6 seconds)',
    stored.enchantmentEffects[0].duration === 3, stored.enchantmentEffects);

  // ---- a claim above the rank is held, and the client's stronger copy reported again is that same enchantment ----
  local = enchant(DAGGER, [effect(ABSORB_STAMINA, 25, 1)]);
  stored = inventory().find((e) => e.baseId === DAGGER);
  check('Absorb Stamina 25 from a Novice is stored at 15 (30 x 0.5)', stored.enchantmentEffects[0].magnitude === 15, stored.enchantmentEffects);
  e = echo(local);
  check('the client sees its 25 differ from the server\'s 15 and reports it again', e.differs);
  check('that report is not refused as an item that cannot take an enchantment', !logs.some((l) => /refused \(item\)/.test(l)) && !/cannot take an enchantment/.test(notice()), { logs, notice: notice() });
  check('the client is told to take the server\'s copy (craftedExtrasRefused names the dagger)', revertIds().includes(DAGGER), revertIds());
  check('the player is told the enchantment was held to their Enchanter rank', /Enchanter rank/.test(notice()), notice());
  const daggers = inventory().filter((x) => x.baseId === DAGGER);
  check('the server keeps exactly its one held copy', daggers.length === 1 && daggers[0].count === 1 && daggers[0].enchantmentEffects[0].magnitude === 15, daggers);
  check('the log names the held copy', logs.some((l) => /ff002071: kept the held enchantment cade9/.test(l)), logs);

  // ---- a different enchantment on an item the server has enchanted is still refused ----
  const server = { ...inventory().find((x) => x.baseId === DAGGER) };
  props.set(`${A}|inventory`, { entries: [server, { baseId: PETTY, count: 1 }] });
  report([{ ...server, enchantmentEffects: [effect(FIRE_DAMAGE, 10, 0)] }], [{ ...server }, { baseId: PETTY, count: 1 }]);
  check('a second, different enchantment on the enchanted dagger is refused with "cannot take an enchantment"',
    logs.some((l) => /refused \(item\) cade9/.test(l)) && /cannot take an enchantment/.test(notice()), { logs, notice: notice() });
  report([{ ...server, enchantmentEffects: [effect(ABSORB_STAMINA, 15, 1), effect(FIRE_DAMAGE, 10, 0)] }], [{ ...server }, { baseId: PETTY, count: 1 }]);
  check('...and so is the same effect with a second one added', logs.some((l) => /refused \(item\) cade9/.test(l)), logs);
  check('neither changed the server\'s copy or spent the soul', inventory().filter((x) => x.baseId === DAGGER).length === 1 &&
    inventory().find((x) => x.baseId === DAGGER).enchantmentEffects.length === 1 && inventory().some((x) => x.baseId === PETTY), inventory());

  // ---- a fixed duration claimed far too long is still capped: the base game's 1 second, or the rank's share of it ----
  const absorbFor = (label) => {
    enchant(DAGGER, [effect(ABSORB_STAMINA, 10, 100)]);
    const d = inventory().find((x) => x.baseId === DAGGER);
    return d && d.enchantmentEffects ? d.enchantmentEffects[0].duration : label;
  };
  let dur = absorbFor('none stored');
  check('a Novice\'s 100 second Absorb Stamina is stored at the base game\'s 1 second', dur === 1, dur);
  props.set(`${A}|private.mastery`, { order: ['enchanter'], skills: { enchanter: { rank: 4 } } });
  dur = absorbFor('none stored');
  check('a Master\'s is stored at 2 seconds (1 x 2)', dur === 2, dur);
  props.set(`${A}|private.mastery`, { order: ['enchanter'], skills: { enchanter: { rank: 0 } } });
  sys = await boot(false);
  dur = absorbFor('none stored');
  check('with the rank gates off a Novice\'s is stored at 2 seconds too (1 x 2)', dur === 2, dur);

  Date.now = realNow;
  fs.rmSync(out, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
