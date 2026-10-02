'use strict'
// Config files a plugin or MCM rewrites itself stay out of the install size gate and the verify; binaries and archives do not
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const mo2 = require('../src/mo2')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rewritten-config-test-'))
mo2.setRootProvider(() => root)
mo2.setLogger(() => {})

const MOD = {
  name: 'Actor Limit Fix - Anniversary Edition',
  files: [
    { to: 'SKSE/Plugins/ActorLimitFix.dll', size: 5637 },
    { to: 'SKSE/Plugins/ActorLimitFix.json', size: 861 },
    { to: 'ActorLimitFix.bsa', size: 4000 },
  ],
}
const dir = path.join(root, 'mods', MOD.name)
const put = (rel, size) => {
  const file = path.join(dir, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, Buffer.alloc(size))
}
function install() {
  fs.rmSync(dir, { recursive: true, force: true })
  for (const f of MOD.files) put(f.to, f.size)
}

test('which files count as rewritten config', () => {
  for (const rel of ['SKSE/Plugins/ActorLimitFix.json', 'SKSE/Plugins/ActorLimitFix.log', 'SKSE/Plugins/EngineFixes_SNCT.ini', 'skse\\plugins\\EngineFixes.toml',
    'MCM/Config/TrueDirectionalMovement/settings.ini', 'MCM/Settings/TrueDirectionalMovement.ini', 'SKSE/Plugins/x/y.yaml']) {
    assert.ok(mo2.isRewrittenConfig(rel), rel)
  }
  for (const rel of ['SKSE/Plugins/ActorLimitFix.dll', 'SKSE/Plugins/ActorLimitFix.pdb', 'ActorLimitFix.log', 'ActorLimitFix.bsa', 'ActorLimitFix.esp', 'DPA_DISTR.ini',
    'meshes/actors/x.nif', 'MapMarkers/BSAssets.json', 'Interface/Translations/x_ENGLISH.txt']) {
    assert.ok(!mo2.isRewrittenConfig(rel), rel)
  }
})

test('a plugin rewriting its JSON does not make the mod look damaged', () => {
  install()
  put('SKSE/Plugins/ActorLimitFix.json', 861 + 331)
  put('MCM/Settings/ActorLimitFix.ini', 120)          // MCM saved the player's settings
  put('SKSE/Plugins/ActorLimitFix.log', 333)          // the plugin's own runtime log (Jake's PC, 2 Oct): not damage
  const check = mo2.modSizeCheck(MOD)
  assert.strictEqual(check.actual, check.expected)
  assert.strictEqual(check.expected, 5637 + 4000)
  assert.strictEqual(check.skipped, 1)
})

test('a missing or quarantined DLL still does', () => {
  install()
  fs.rmSync(path.join(dir, 'SKSE', 'Plugins', 'ActorLimitFix.dll'))
  const gone = mo2.modSizeCheck(MOD)
  assert.notStrictEqual(gone.actual, gone.expected)
  install()
  put('SKSE/Plugins/ActorLimitFix.dll', 0)             // an AV emptied it
  const emptied = mo2.modSizeCheck(MOD)
  assert.notStrictEqual(emptied.actual, emptied.expected)
})

test('a damaged archive still does', () => {
  install()
  put('ActorLimitFix.bsa', 3000)
  const check = mo2.modSizeCheck(MOD)
  assert.notStrictEqual(check.actual, check.expected)
  fs.rmSync(root, { recursive: true, force: true })
})
