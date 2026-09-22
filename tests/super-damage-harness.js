// Proves the fire-on-a-vampire / silver-on-a-werewolf extra damage in gamemode.js actually reaches the target.
//
// Why this exists: superBonusDamage() read and wrote the health property as a bare identifier
// (mp.get(tgt, percentages) instead of mp.get(tgt, 'percentages')). That is a ReferenceError, and the
// function's own try/catch swallowed it and returned 0, so the weakness never applied and nothing was
// ever logged. Nobody had been cursed yet, so no play session could have shown it. This harness lifts
// the real function out of gamemode.js and runs it against a stub mp, so a repeat cannot ship silently.
//
// Run: node tests\super-damage-harness.js   (from server\)
'use strict';

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.resolve(__dirname, '..', 'gamemode.js'), 'utf8');

// Lift `const superBonusDamage = (...) => { ... };` out of the file by its own indentation
const lift = (name) => {
  const lines = SRC.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(`const ${name} = `));
  if (start < 0) throw new Error(`${name} is no longer declared at the top level of gamemode.js`);
  const end = lines.findIndex((l, i) => i > start && l === '};');
  if (end < 0) throw new Error(`could not find the end of ${name}`);
  return lines.slice(start, end + 1).join('\n');
};

let failures = 0;
const check = (what, got, want) => {
  const ok = Math.abs(Number(got) - Number(want)) < 1e-9;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}: got ${got}, want ${want}`);
};
const checkTrue = (what, got) => { if (!got) failures++; console.log(`${got ? 'ok  ' : 'FAIL'}  ${what}`); };

const source = lift('superBonusDamage');

// The bug, stated as a test: the property name must be a string, never a bare identifier
checkTrue('superBonusDamage names the health property as a string',
  /mp\.get\(tgt, 'percentages'\)/.test(source) && /mp\.set\(tgt, 'percentages',/.test(source));
checkTrue('superBonusDamage has no bare `percentages` identifier left',
  !/[(,]\s*percentages\s*[,)]/.test(source));

// A stub actor store; health is a 0..1 fraction, as the engine reports it
const makeMp = (health) => {
  const store = { percentages: { health, magicka: 0.8, stamina: 0.9 } };
  return {
    store,
    get: (id, prop) => {
      if (typeof prop !== 'string') throw new Error(`mp.get called with a ${typeof prop} property`);
      return store[prop];
    },
    set: (id, prop, value) => {
      if (typeof prop !== 'string') throw new Error(`mp.set called with a ${typeof prop} property`);
      store[prop] = value;
    },
  };
};

// The hit under test is always aggressor 1 hitting target 2; the pending record may name someone else
const run = (mp, pending, damage) => {
  globalThis.__dboSuperPending = pending;
  // eslint-disable-next-line no-new-func
  const fn = new Function('mp', `${source}\nreturn superBonusDamage;`)(mp);
  return fn(1, 2, 0, damage);
};

// 1. A x1.5 hit that took 10% of health takes another 5%, and reports 50% of the engine's damage as extra
{
  const mp = makeMp(0.9);                                    // the engine already applied its 0.10
  const extra = run(mp, { agg: 1, tgt: 2, mult: 1.5, health: 1.0 }, 20);
  check('x1.5 leaves health at', mp.store.percentages.health, 0.85);
  check('x1.5 reports extra damage', extra, 10);
  check('x1.5 leaves magicka alone', mp.store.percentages.magicka, 0.8);
}

// 2. A x2 hit doubles the engine's damage
{
  const mp = makeMp(0.75);
  const extra = run(mp, { agg: 1, tgt: 2, mult: 2, health: 1.0 }, 40);
  check('x2 leaves health at', mp.store.percentages.health, 0.5);
  check('x2 reports extra damage', extra, 40);
}

// 3. Health never goes below the 0.01 floor, and the extra is scaled to what was really taken
{
  const mp = makeMp(0.05);
  const extra = run(mp, { agg: 1, tgt: 2, mult: 3, health: 0.10 }, 10);
  check('a lethal multiplier stops at the floor', mp.store.percentages.health, 0.01);
  check('and reports only the damage it really dealt', extra, 8);
}

// 4. No pending record, a foreign pending record, or no damage: nothing happens
{
  const mp = makeMp(0.9);
  check('no pending record', run(mp, null, 20), 0);
  check('health untouched', mp.store.percentages.health, 0.9);
  check('pending for another aggressor', run(mp, { agg: 99, tgt: 2, mult: 2, health: 1.0 }, 20), 0);
  check('pending for another target', run(mp, { agg: 1, tgt: 99, mult: 2, health: 1.0 }, 20), 0);
  check('zero damage', run(mp, { agg: 1, tgt: 2, mult: 2, health: 1.0 }, 0), 0);
  check('still untouched', mp.store.percentages.health, 0.9);
}

// 5. The engine's hit healed or was blocked (no health lost): nothing extra
{
  const mp = makeMp(1.0);
  check('blocked hit', run(mp, { agg: 1, tgt: 2, mult: 2, health: 1.0 }, 20), 0);
  check('blocked hit leaves health', mp.store.percentages.health, 1.0);
}

// 6. The pending record is always consumed, so it can never apply twice
{
  const mp = makeMp(0.9);
  run(mp, { agg: 1, tgt: 2, mult: 2, health: 1.0 }, 20);
  checkTrue('the pending record is cleared after use', globalThis.__dboSuperPending === null);
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
