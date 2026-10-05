// Scripted test for soulTrapSystem.ts: a weapon hit arms soul trap from the record's own enchantment (EITM) and from the
// copy the attacker holds (a player-made enchantment's effects, or an enchantment kept as extra data), and only the held
// copy counts. It bundles soulTrapSystem.ts with esbuild and drives the OnHit hook and the death poll on a fake mp whose
// records are made up here. Run it from skymp5-server with node_modules present:
//
//   node tests/soul-trap-held-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const esbuild = require(path.join(root, 'node_modules', 'esbuild'));
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-soultrap-'));
const bundle = path.join(out, 'soultrap.js');

let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

const u32s = (...xs) => { const b = new Uint8Array(4 * xs.length); const v = new DataView(b.buffer); xs.forEach((x, i) => v.setUint32(4 * i, x >>> 0, true)); return b; };
const efit = (mag, area, dur) => { const b = new Uint8Array(12); const v = new DataView(b.buffer); v.setFloat32(0, mag, true); v.setUint32(4, area, true); v.setUint32(8, dur, true); return b; };
const acbs = (level) => { const b = new Uint8Array(20); new DataView(b.buffer).setUint16(8, level, true); return b; };
const records = new Map();
const rec = (id, type, fields) => records.set(id >>> 0, { record: { type, fields, flags: 0 }, toGlobalRecordId: (x) => x >>> 0 });

const SOUL_TRAP_CONTACT = 0x0005b452, FIRE_CONTACT = 0x0004605a;
const ENCH_SOUL_TRAP = 0x000d4b6e, ENCH_FIRE = 0x00045f9d;
const IRON_SWORD = 0x00012eb7, SWORD_OF_SOULS = 0x000d4b6f, STEEL_SWORD = 0x00013989;
const PETTY = 0x0002e4e2, PETTY_FILLED = 0x0002e4e3, WOLF_BASE = 0x00023aba;
rec(FIRE_CONTACT, 'MGEF', [{ type: 'DATA', data: new Uint8Array(152) }]);
rec(ENCH_SOUL_TRAP, 'ENCH', [{ type: 'EFID', data: u32s(SOUL_TRAP_CONTACT) }, { type: 'EFIT', data: efit(0, 0, 3) }]);
rec(ENCH_FIRE, 'ENCH', [{ type: 'EFID', data: u32s(FIRE_CONTACT) }, { type: 'EFIT', data: efit(10, 0, 0) }]);
rec(IRON_SWORD, 'WEAP', []);
rec(STEEL_SWORD, 'WEAP', []);
rec(SWORD_OF_SOULS, 'WEAP', [{ type: 'EITM', data: u32s(ENCH_SOUL_TRAP) }]);
rec(PETTY, 'SLGM', [{ type: 'SLCP', data: new Uint8Array([1]) }]);
rec(PETTY_FILLED, 'SLGM', [{ type: 'SLCP', data: new Uint8Array([1]) }, { type: 'SOUL', data: new Uint8Array([1]) }]);
rec(WOLF_BASE, 'NPC_', [{ type: 'ACBS', data: acbs(1) }]);

(async () => {
  await esbuild.build({
    entryPoints: [path.join(root, 'ts', 'systems', 'soulTrapSystem.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'error',
  });
  const { SoulTrapSystem } = require(bundle);

  const A = 0xff000014, T = 0xff000100;
  const props = new Map();
  const descs = new Map([['caster', A], ['target', T]]);
  const desc = (id) => { const d = `d${(id >>> 0).toString(16)}`; descs.set(d, id >>> 0); return { desc: d }; };
  const mp = {
    get: (id, k) => props.get(`${id >>> 0}|${k}`),
    set: (id, k, v) => props.set(`${id >>> 0}|${k}`, v),
    getIdFromDesc: (d) => { if (!descs.has(d)) throw new Error('no desc'); return descs.get(d); },
    lookupEspmRecordById: (id) => records.get(id >>> 0) || null,
    getUserByActor: () => 65535,
    sendCustomPacket: () => {},
  };
  const ctx = { svr: mp, gm: { on() {}, emit() {} } };
  const logs = [];
  let now = 1_000_000;
  const realNow = Date.now;
  Date.now = () => now;

  // One fight: the attacker holds `entries`, hits a level 1 wolf with `weapon`, and the wolf dies `afterMs` later
  const fight = async (weapon, entries, afterMs = 1000) => {
    const sys = new SoulTrapSystem((...x) => logs.push(x.join(' ')));
    await sys.initAsync(ctx);
    props.clear();
    props.set(`${A}|inventory`, { entries: [...entries, { baseId: PETTY, count: 1 }] });
    props.set(`${A}|profileId`, 3);
    props.set(`${T}|type`, 'MpActor');
    props.set(`${T}|isDead`, false);
    props.set(`${T}|templateChain`, [WOLF_BASE]);
    mp['onPapyrusEvent:OnHit'](T, desc(A), desc(weapon), null, false, false, false, false);
    now += afterMs;
    await sys.updateAsync(ctx);
    now += 200;
    props.set(`${T}|isDead`, true);
    await sys.updateAsync(ctx);
    const inv = props.get(`${A}|inventory`).entries;
    return inv.some((e) => e.baseId === PETTY_FILLED);
  };
  const trapEffects = [{ effectId: SOUL_TRAP_CONTACT, magnitude: 0, area: 0, duration: 4, cost: 20 }];

  check('a record enchanted with soul trap still traps (EITM)',
    await fight(SWORD_OF_SOULS, [{ baseId: SWORD_OF_SOULS, count: 1, worn: true }]));
  check('a held player-made soul trap enchantment traps',
    await fight(IRON_SWORD, [{ baseId: IRON_SWORD, count: 1, worn: true, maxCharge: 250, chargePercent: 250, enchantmentEffects: trapEffects }]));
  check('the same enchantment in the left hand traps',
    await fight(IRON_SWORD, [{ baseId: IRON_SWORD, count: 1, wornLeft: true, enchantmentEffects: trapEffects }]));
  check('a soul trap enchantment kept as extra data traps (a swapped copy)',
    await fight(STEEL_SWORD, [{ baseId: STEEL_SWORD, count: 1, worn: true, enchantmentId: ENCH_SOUL_TRAP, maxCharge: 500 }]));
  check('a plain held copy does not trap',
    !(await fight(IRON_SWORD, [{ baseId: IRON_SWORD, count: 1, worn: true }])));
  check('a player-made fire enchantment does not trap',
    !(await fight(IRON_SWORD, [{ baseId: IRON_SWORD, count: 1, worn: true, enchantmentEffects: [{ effectId: FIRE_CONTACT, magnitude: 10, area: 0, duration: 0, cost: 20 }] }])));
  check('an extra-data fire enchantment does not trap',
    !(await fight(STEEL_SWORD, [{ baseId: STEEL_SWORD, count: 1, worn: true, enchantmentId: ENCH_FIRE }])));
  check('only the held copy counts: a soul trap copy in the pack beside a plain held one does not trap',
    !(await fight(IRON_SWORD, [{ baseId: IRON_SWORD, count: 1, worn: true }, { baseId: IRON_SWORD, count: 1, enchantmentEffects: trapEffects }])));
  check('with no copy marked held, a carried soul trap copy of that weapon traps',
    await fight(IRON_SWORD, [{ baseId: IRON_SWORD, count: 1, enchantmentEffects: trapEffects }]));
  check('the trap ends with the effect: a death 5 s after a 4 s soul trap fills nothing',
    !(await fight(IRON_SWORD, [{ baseId: IRON_SWORD, count: 1, worn: true, enchantmentEffects: trapEffects }], 5000)));
  check('another weapon base held does not lend its enchantment',
    !(await fight(IRON_SWORD, [{ baseId: STEEL_SWORD, count: 1, worn: true, enchantmentEffects: trapEffects }])));

  Date.now = realNow;
  fs.rmSync(out, { recursive: true, force: true });
  console.log(failures ? `${failures} FAILED` : 'all passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); fs.rmSync(out, { recursive: true, force: true }); process.exit(1); });
