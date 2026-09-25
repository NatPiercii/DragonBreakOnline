// combat.js against a mock mp: block chip and stamina, guard breaks, bash, power stagger, Defense resistance.
// node tests/combat-harness.js
const path = require('path');
const cfg = JSON.parse(require('fs').readFileSync(path.join(__dirname, '..', 'gamemode-config.json'), 'utf8'));
const SHIELD = 0x500, SWORD = 0x600;
const RECS = { [SHIELD]: { type: 'ARMO', fields: [{ type: 'BOD2', data: (() => { const d = new Uint8Array(8); new DataView(d.buffer).setUint32(0, 1 << 9, true); return d; })() }] } };
let P, EQ, calls, MAST;
const reset = () => {
  P = { 1: { health: 1, magicka: 1, stamina: 1 }, 2: { health: 1, magicka: 1, stamina: 1 } };
  EQ = { 1: [], 2: [] }; calls = []; MAST = {};
  globalThis.__dboCombat = undefined;
};
reset();
const mp = {
  get: (a, k) => (k === 'percentages' ? P[a] : k === 'equipment' ? { inv: { entries: EQ[a].map((b) => ({ baseId: b, worn: true })) } } : null),
  set: (a, k, v) => { if (k === 'percentages') P[a] = v; },
  getDescFromId: (a) => `${a.toString(16)}:x`,
  callPapyrusFunction: (...args) => calls.push(args),
};
const load = () => require(path.join(__dirname, '..', 'combat.js'))({
  mp, log: () => {}, profileOf: (a) => (a === 1 || a === 2 ? a : -1),
  masteryOf: (a) => MAST[a] || null,
  wornOf: (e) => e.inv.entries.map((x) => ({ baseId: x.baseId })),
  recordOf: (id) => (RECS[id] ? { record: RECS[id] } : null),
  fieldsOf: (lr, t) => ((lr && lr.record.fields) || []).filter((f) => f.type === t),
  weaponSkillOf: (src) => (src === SWORD ? 'blade' : ''), display: String, cfg,
});
let pass = 0, fail = 0;
const ok = (cond, what) => { if (cond) pass++; else { fail++; console.log('FAIL', what); } };
const near = (a, b) => Math.abs(a - b) < 1e-6;
const staggers = () => calls.filter((c) => c[2] === 'SendAnimationEvent').length;
const hit = (flags, mult = 1, dmg = 0) => load().onAttempt(1, 2, SWORD, dmg, Object.assign({ targetMaxHealth: 200, targetMaxStamina: 100 }, flags), mult);

// weapon block: 30 % through, the rest in stamina
reset(); hit({ blocked: true, unblockedDamage: 40 });
ok(near(P[2].health, 1 - 12 / 200), 'weapon block lets 30 % through');
ok(near(P[2].stamina, 1 - 28 / 100), 'weapon block costs the prevented 28 in stamina');
ok(staggers() === 0, 'a light blocked blow staggers nobody');
// shield: 15 % through, half the rest in stamina; Defense Master takes the chip to 0
reset(); EQ[2] = [SHIELD]; hit({ blocked: true, unblockedDamage: 40 });
ok(near(P[2].health, 1 - 6 / 200) && near(P[2].stamina, 1 - 17 / 100), 'shield: 15 % through, half the rest in stamina');
reset(); EQ[2] = [SHIELD]; MAST[2] = { order: ['defense'], skills: { defense: { rank: 4 } } }; hit({ blocked: true, unblockedDamage: 40 });
ok(near(P[2].health, 1), 'Master Defense with a shield takes no chip');
// the skills' multiplier scales the blocked blow too
reset(); hit({ blocked: true, unblockedDamage: 40 }, 1.5);
ok(near(P[2].health, 1 - 18 / 200), 'blocked blow carries the attack multiplier');
// power into a shield: double stamina, no stagger
reset(); EQ[2] = [SHIELD]; hit({ blocked: true, power: true, unblockedDamage: 40 });
ok(near(P[2].stamina, 1 - 34 / 100) && staggers() === 0, 'power into a shield: double stamina, no stagger');
// out of stamina: the guard breaks, a stagger, then blocked blows land in full
reset(); P[2].stamina = 0.1; hit({ blocked: true, unblockedDamage: 40 });
ok(P[2].stamina === 0 && staggers() === 1, 'empty stamina breaks the guard with a stagger');
const h = P[2].health; hit({ blocked: true, unblockedDamage: 40 });
ok(near(P[2].health, h - 40 / 200), 'a broken guard lets the whole blow through');
// bash into a guard: breaks it and staggers; Defense Expert resists the stagger but the guard still breaks
reset(); hit({ blocked: true, bash: true, unblockedDamage: 40 });
ok(staggers() === 1 && globalThis.__dboCombat.get(2).guardBrokenUntil > Date.now(), 'bash breaks a guard and staggers');
reset(); MAST[2] = { order: ['defense'], skills: { defense: { rank: 3 } } }; hit({ blocked: true, bash: true, unblockedDamage: 40 });
ok(staggers() === 0 && globalThis.__dboCombat.get(2).guardBrokenUntil > Date.now(), 'Defense Expert: guard breaks, no stagger');
// unblocked: bash is a quarter and staggers; power staggers; cooldown
reset(); const m = hit({ bash: true, unblockedDamage: 40 }, 1, 40);
ok(m === 0.25 && staggers() === 1, 'unblocked bash: quarter damage and a stagger');
reset(); hit({ power: true, unblockedDamage: 40 }, 1, 40); hit({ power: true, unblockedDamage: 40 }, 1, 40);
ok(staggers() === 1, 'power attack staggers once inside the cooldown');
// Master blade power attack staggers through a weapon block
reset(); MAST[1] = { order: ['blade'], skills: { blade: { rank: 4 } } }; hit({ blocked: true, power: true, unblockedDamage: 40 });
ok(staggers() === 1, 'Master power attack staggers through a weapon block');
// spells, NPC targets, no flags and no maxima change nothing
reset(); ok(load().onAttempt(1, 2, SWORD, 20, { spell: true, power: false }, 1) === 1 && staggers() === 0, 'spells are left alone');
reset(); ok(load().onAttempt(1, 9, SWORD, 20, { power: true }, 1) === 1 && staggers() === 0, 'NPC targets are left alone');
reset(); ok(load().onAttempt(1, 2, SWORD, 20, undefined, 1) === 1, 'no flags, no change');
reset(); load().onAttempt(1, 2, SWORD, 0, { blocked: true, unblockedDamage: 40 }, 1);
ok(near(P[2].health, 1) && near(P[2].stamina, 1), 'no maxima: chip and stamina skipped');
console.log(`${pass}/${pass + fail}`);
process.exitCode = fail ? 1 : 0;
