'use strict'
// Community Shaders can be switched off in Settings (karta.gina, 4 Oct: the game could not create its window with it on
// an older graphics card). The mod stays installed; its modlist.txt line is '-', kept through every reinstall.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const mo2 = require('../src/mo2')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dbo-launcher-cs-'))
mo2.setRootProvider(() => root)
mo2.setLogger(() => {})
test.after(() => fs.rmSync(root, { recursive: true, force: true }))

const CS = 'a4_d9_9d_a4d99d6e-b998-4791-9d90-4ba88e224101'
const mod = (name, rel) => {
  const dir = path.join(mo2.getModsDir(), name)
  fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true })
  fs.writeFileSync(path.join(dir, rel), 'x')
}
mod(CS, 'SKSE/Plugins/CommunityShaders.dll')
mod('Other Mod', 'SKSE/Plugins/Other.dll')
mod('My Own Mod', 'textures/a.dds')
const modlist = () => fs.readFileSync(path.join(mo2.getProfileDir(), 'modlist.txt'), 'utf8')

test('the mod is found by the file only it ships, whatever its folder is called', () => {
  assert.equal(mo2.findModWithFile('SKSE/Plugins/CommunityShaders.dll'), CS)
  assert.equal(mo2.findModWithFile('SKSE/Plugins/Missing.dll'), '')
})

test('no modlist yet: nothing to switch, and the state reads as unknown', () => {
  assert.equal(mo2.setModEnabled(CS, false), false)
  assert.equal(mo2.isModEnabled(CS), null)
})

test('an install writes a switched-off mod as -, the rest as +', () => {
  mo2.setModlistOrder(['Other Mod', CS], new Set([CS]))
  assert.match(modlist(), new RegExp(`^\\+Other Mod\\r$`, 'm'))
  assert.match(modlist(), new RegExp(`^-${CS}\\r$`, 'm'))
  assert.equal(mo2.isModEnabled(CS), false)
  assert.equal(mo2.isModEnabled('Other Mod'), true)
})

test('without the setting every managed mod is on, as before', () => {
  mo2.setModlistOrder(['Other Mod', CS])
  assert.equal(mo2.isModEnabled(CS), true)
  mo2.setModlistOrder(['Other Mod', CS], [])
  assert.equal(mo2.isModEnabled(CS), true)
})

test('the switch flips only that line and keeps the order and the player\'s own mods', () => {
  fs.appendFileSync(path.join(mo2.getProfileDir(), 'modlist.txt'), '+My Own Mod\r\n')
  const before = modlist().split('\r\n').map(l => l.slice(1))
  assert.equal(mo2.setModEnabled(CS, false), true)
  assert.equal(mo2.isModEnabled(CS), false)
  assert.deepEqual(modlist().split('\r\n').map(l => l.slice(1)), before)
  assert.match(modlist(), /^\+My Own Mod\r$/m)
  assert.ok(modlist().endsWith('\r\n') && !modlist().endsWith('\r\n\r\n'))
  assert.equal(mo2.setModEnabled(CS, true), true)
  assert.equal(mo2.isModEnabled(CS), true)
})

test('a mod with no line is reported, not added', () => {
  assert.equal(mo2.setModEnabled('Not Installed', false), false)
  assert.doesNotMatch(modlist(), /Not Installed/)
})

test('main, preload and renderer agree on the switch', () => {
  const src = f => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8')
  const main = src('main.js'), preload = src('preload.js'), renderer = src('renderer/renderer.js')
  const html = src('renderer/index.html')
  for (const ch of ['mods:communityShadersLoad', 'mods:communityShadersSet']) {
    assert.ok(main.includes(`ipcMain.handle('${ch}'`), ch)
    assert.ok(preload.includes(`'${ch}'`), ch)
  }
  assert.ok(renderer.includes('communityShadersLoad()') && renderer.includes('communityShadersSet('))
  assert.ok(html.includes('id="gfx-community-shaders"'))
  // Every install applies the stored setting, by Nexus id, and the switch is refused while MO2 or the game runs
  assert.match(main, /mo2\.setModlistOrder\(order, disabledManagedMods\(manifest\)\)/)
  assert.match(main, /COMMUNITY_SHADERS_NEXUS_ID = 86492/)
  assert.match(main, /communityShadersSet'[\s\S]{0,200}skyrimRunning\(\)/)
})
