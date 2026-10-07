'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

// deploy/client-extra/.../userConfigs.json tunes FSMP (Faster HDT-SMP) on every player's machine. FSMP layers it over
// its own shipped configs.json and silently ignores a key it does not know, so a typo would leave the physics budget
// at the default and the fix would do nothing. These are the names, types and clamp ranges read by FSMP's
// GlobalConfig.cpp (upstream DaymareOn/hdtSMP64), checked at the version pinned in the modlist.
const FILE = path.join(__dirname, '..', '..', 'deploy', 'client-extra', 'Data', 'SKSE', 'Plugins',
                       'hdtSkinnedMeshConfigs', 'userConfigs.json')

// section -> key -> [type, lo, hi]; a bool has no range
const SCHEMA = {
  smp: {
    logLevel: ['int', 0, 5],
    disableSMPHairWhenWigEquipped: ['bool'],
    hideSMPHairWhenInvisible: ['bool'],
    clampRotations: ['bool'],
    rotationSpeedLimit: ['num', 0, 100],
    unclampedResets: ['bool'],
    unclampedResetAngle: ['num', 0, 360],
    useRealTime: ['bool'],
    minCullingDistance: ['num', 0, 10000],
    autoAdjustMaxSkeletons: ['bool'],
    maximumActiveSkeletons: ['int', 0, 200],
    budgetMs: ['num', 0.1, 20],
    sampleSize: ['int', 1, 50],
    disable1stPersonViewPhysics: ['bool'],
    skipDeadActors: ['bool'],
    minScreenSizePercent: ['num', 0, 100],
  },
  solver: {
    numIterations: ['int', 4, 128],
    erp: ['num', 0.01, 1],
    'min-fps': ['int', 1, 300],
    maxSubSteps: ['int', 1, 60],
  },
  wind: {
    enabled: ['bool'],
    windStrength: ['num', 0, 1000],
    distanceForNoWind: ['num', 0, 10000],
    distanceForMaxWind: ['num', 0, 10000],
  },
}

test('the FSMP override parses and every key is one FSMP reads', () => {
  const cfg = JSON.parse(fs.readFileSync(FILE, 'utf8'))
  for (const [section, keys] of Object.entries(cfg)) {
    assert.ok(SCHEMA[section], `unknown section "${section}"`)
    for (const [key, value] of Object.entries(keys)) {
      const spec = SCHEMA[section][key]
      assert.ok(spec, `unknown key "${section}.${key}": FSMP would ignore it`)
      const [type, lo, hi] = spec
      if (type === 'bool') assert.strictEqual(typeof value, 'boolean', `${section}.${key} must be a bool`)
      else {
        assert.strictEqual(typeof value, 'number', `${section}.${key} must be a number`)
        if (type === 'int') assert.ok(Number.isInteger(value), `${section}.${key} must be whole`)
        assert.ok(value >= lo && value <= hi, `${section}.${key} = ${value} is outside ${lo}..${hi}, FSMP would clamp it`)
      }
    }
  }
})

test('the override is the shorter physics step the hang needs', () => {
  const cfg = JSON.parse(fs.readFileSync(FILE, 'utf8'))
  // FSMP #427: a long physics step lets a parked worker steal the queued step task and self-deadlock, which is the
  // hdtsmp64 freeze in 9 of 14 stalled-frame reports. Each of these shortens the step, so none may drift back up.
  assert.strictEqual(cfg.smp.skipDeadActors, true, 'corpses pile up in dungeon leases')
  assert.ok(cfg.solver.maxSubSteps <= 1, 'substeps multiply the step time')
  assert.ok(cfg.solver.numIterations <= 8, 'solver iterations are per substep')
  assert.ok(cfg.smp.budgetMs <= 2.0, 'the auto-adjust targets this frame budget')
  assert.ok(cfg.smp.autoAdjustMaxSkeletons === true, 'the skeleton cap must stay automatic')
})
