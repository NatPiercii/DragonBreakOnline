'use strict'
// The in-launcher downgrade to Skyrim 1.6.1170 (src/downgrade.js, docs/DOWNGRADE_1_6_1170.md): detection, finding the
// depots Steam downloaded, the install plan and its guards, backup and rollback, restore, and the Steam update setting.
// Real files in temporary folders; the exe version and the hashes are stubbed, and the big masters are sparse files.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const dg = require('../src/downgrade')
const REF = require('../src/downgrade-1.6.1170.json')

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'downgrade-test-'))
const put = (file, text = 'x') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text) }
// A sparse file of the given size: instant, and takes no disk
const sized = (file, size) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.closeSync(fs.openSync(file, 'w')); fs.truncateSync(file, size) }
const read = file => fs.readFileSync(file, 'utf8')
const REF_SHA = new Map(Object.entries(REF.files).map(([p, v]) => [p.toLowerCase(), v.sha256]))
const stubHash = file => {
  const key = Object.keys(REF.files).find(p => file.split(path.sep).join('/').toLowerCase().endsWith(p.toLowerCase()))
  return Promise.resolve(key ? REF_SHA.get(key.toLowerCase()) : 'other')
}
const version = v => () => v

// Three downloaded depots holding the 1.6.1170 masters (sparse, right size), an exe and a few other files
function depots(root, { exe = '1.6.1170.0', skip = [] } = {}) {
  const content = path.join(root, 'steamapps', 'content', 'app_489830')
  const d1 = path.join(content, 'depot_489831')
  for (const [p, v] of Object.entries(REF.files)) if (!skip.includes(p)) sized(path.join(d1, ...p.split('/')), v.size)
  put(path.join(d1, 'Data', 'Skyrim - Textures0.bsa'), 'textures 1170')
  const d2 = path.join(content, 'depot_489832')
  put(path.join(d2, 'Data', 'Skyrim - Interface.bsa'), 'interface 1170')
  put(path.join(d2, 'SkyrimSELauncher.exe'), 'launcher 1170')
  const d3 = path.join(content, 'depot_489833')
  put(path.join(d3, 'SkyrimSE.exe'), `exe ${exe}`)
  return dg.findDepots([root])
}

// A game folder on the newer build: its own exe, masters of other sizes, a BSA and a file the depots do not touch
function game(root) {
  const dir = path.join(root, 'steamapps', 'common', 'Skyrim Special Edition')
  put(path.join(dir, 'SkyrimSE.exe'), 'exe 1.7.104')
  put(path.join(dir, 'SkyrimSELauncher.exe'), 'launcher 1.7.104')
  put(path.join(dir, 'Data', 'Skyrim.esm'), 'skyrim.esm 1.7.104')
  put(path.join(dir, 'Data', 'Skyrim - Interface.bsa'), 'interface 1.7.104')
  put(path.join(dir, 'Data', 'MyMod.esp'), 'a mod')
  return dir
}

const readExe = file => { const m = /^exe (.*)$/.exec(fs.readFileSync(file, 'utf8')); return m ? m[1] : null }

test('Steam roots: the client roots, their libraries and the game\'s own library, once each', () => {
  const root = tmp()
  const steam = path.join(root, 'Steam')
  const lib2 = path.join(root, 'Games', 'SteamLibrary')
  const lib3 = path.join(root, 'Other')
  put(path.join(steam, 'steamapps', 'libraryfolders.vdf'),
    `"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"${steam}"\n\t}\n\t"1"\n\t{\n\t\t"path"\t\t"${lib2}"\n\t}\n}\n`)
  const gameDir = path.join(lib3, 'steamapps', 'common', 'Skyrim Special Edition')
  assert.deepStrictEqual(dg.steamRoots({ clientRoots: [steam, steam], gameDir }), [steam, lib2, lib3])
  assert.deepStrictEqual(dg.parseLibraryFolders('\t\t"path"\t\t"D:\\\\SteamLibrary"'), ['D:\\SteamLibrary'])
  fs.rmSync(root, { recursive: true, force: true })
})

test('a game folder outside steamapps\\common (a Wabbajack Stock Game) has no Steam library and no appmanifest', () => {
  assert.strictEqual(dg.steamLibraryOf(path.join('/x', 'steamapps', 'common', 'Skyrim Special Edition')), path.resolve('/x'))
  assert.strictEqual(dg.acfPathFor(path.join('/x', 'steamapps', 'common', 'Skyrim Special Edition')),
    path.join(path.resolve('/x'), 'steamapps', 'appmanifest_489830.acf'))
  assert.strictEqual(dg.steamLibraryOf(path.join('/modlists', 'Nolvus', 'Stock Game')), null)
  assert.strictEqual(dg.acfPathFor(path.join('/modlists', 'Nolvus', 'Stock Game')), null)
})

test('each depot is found in any of the four layouts, under whichever root holds it', () => {
  const root = tmp()
  const content = path.join(root, 'steamapps', 'content')
  for (const rel of [['app_489830', 'depot_489831'], ['489830', '489831'], ['depot_489831'], ['489831']]) {
    const dir = path.join(content, ...rel)
    fs.mkdirSync(dir, { recursive: true })
    assert.strictEqual(dg.resolveDepot(content, '489831'), dir)
    fs.rmSync(path.join(content, rel[0]), { recursive: true })
  }
  const other = tmp()
  fs.mkdirSync(path.join(other, 'steamapps', 'content', 'app_489830', 'depot_489833'), { recursive: true })
  const found = dg.findDepots([root, other])
  assert.deepStrictEqual(found.map(d => d.dir === null), [true, true, false])
  assert.strictEqual(found[2].command, 'download_depot 489830 489833 1914580699073641964')
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(other, { recursive: true, force: true })
})

test('depot status: waiting, downloading, done once nothing changed for 20 s, and a new file starts the wait again', () => {
  const root = tmp()
  const [d1] = depots(root)
  assert.strictEqual(dg.depotState({ ...d1, dir: null }, null, 0).state, 'waiting')
  let s = dg.depotState(d1, null, 1000)
  assert.strictEqual(s.state, 'downloading')
  assert.ok(s.bytes > 249753412)
  s = dg.depotState(d1, s, 1000 + dg.STABLE_MS - 1)
  assert.strictEqual(s.state, 'downloading')
  s = dg.depotState(d1, s, 1000 + dg.STABLE_MS)
  assert.strictEqual(s.state, 'done')
  put(path.join(d1.dir, 'Data', 'Skyrim - Textures1.bsa'), 'more')
  s = dg.depotState(d1, s, 1000 + dg.STABLE_MS + 5)
  assert.strictEqual(s.state, 'downloading')
  fs.rmSync(root, { recursive: true, force: true })
})

test('depot status: a master still short of its 1.6.1170 size is downloading, then stalled after two quiet minutes', () => {
  const root = tmp()
  const [d1] = depots(root)
  sized(path.join(d1.dir, 'Data', 'Skyrim.esm'), 1000)
  let s = dg.depotState(d1, null, 0)
  s = dg.depotState(d1, s, dg.STABLE_MS + 1)
  assert.strictEqual(s.state, 'downloading')
  s = dg.depotState(d1, s, dg.STALLED_MS)
  assert.strictEqual(s.state, 'stalled')
  fs.rmSync(root, { recursive: true, force: true })
})

test('depot status: the exe depot is done only with a 1.6.1170 SkyrimSE.exe, and says which build it got otherwise', () => {
  const root = tmp()
  let d3 = depots(root)[2]
  let s = dg.depotState(d3, dg.depotState(d3, null, 0, readExe), dg.STABLE_MS, readExe)
  assert.strictEqual(s.state, 'done')
  put(path.join(d3.dir, 'SkyrimSE.exe'), 'exe 1.6.640.0')
  s = dg.depotState(d3, dg.depotState(d3, null, 0, readExe), dg.STABLE_MS, readExe)
  assert.strictEqual(s.state, 'wrong')
  assert.match(s.detail, /1\.6\.640\.0/)
  // A version like 1.6.11700 is not 1.6.1170
  put(path.join(d3.dir, 'SkyrimSE.exe'), 'exe 1.6.11700.0')
  s = dg.depotState(d3, dg.depotState(d3, null, 0, readExe), dg.STABLE_MS, readExe)
  assert.strictEqual(s.state, 'wrong')
  fs.rmSync(root, { recursive: true, force: true })
})

test('the plan: every depot file with its target, replaced files backed up, added files marked', () => {
  const root = tmp()
  const gameDir = game(root)
  const plan = dg.planInstall(depots(root), gameDir, '20260929-160000')
  assert.strictEqual(plan.backupDir, path.join(gameDir, '_DragonBreakDowngrade', '20260929-160000'))
  const byRel = new Map(plan.jobs.map(j => [j.rel.split(path.sep).join('/'), j]))
  assert.strictEqual(byRel.get('SkyrimSE.exe').replaces, true)
  assert.strictEqual(byRel.get('Data/Skyrim.esm').replaces, true)
  assert.strictEqual(byRel.get('Data/Skyrim.esm').backup, path.join(plan.backupDir, 'Data', 'Skyrim.esm'))
  assert.strictEqual(byRel.get('Data/Update.esm').replaces, false)
  assert.strictEqual(plan.replaced, 4)
  assert.strictEqual(plan.added, plan.jobs.length - 4)
  assert.ok(!byRel.has('Data/MyMod.esp'))
  fs.rmSync(root, { recursive: true, force: true })
})

test('the plan refuses, before anything is touched: a missing or empty depot, a link, a folder in a file\'s place', () => {
  const root = tmp()
  const gameDir = game(root)
  let ds = depots(root)
  assert.throws(() => dg.planInstall([ds[0], ds[1], { ...ds[2], dir: null }], gameDir, 's'), /Depot 489833 was not found\. Nothing was changed/)
  fs.rmSync(path.join(ds[2].dir, 'SkyrimSE.exe'))
  assert.throws(() => dg.planInstall(ds, gameDir, 's'), /Depot 489833 is empty/)
  put(path.join(ds[2].dir, 'SkyrimSE.exe'), 'exe 1.6.1170.0')
  fs.mkdirSync(path.join(gameDir, 'SkyrimSELauncher.exe.d'))
  fs.rmSync(path.join(gameDir, 'SkyrimSELauncher.exe'))
  fs.renameSync(path.join(gameDir, 'SkyrimSELauncher.exe.d'), path.join(gameDir, 'SkyrimSELauncher.exe'))
  assert.throws(() => dg.planInstall(ds, gameDir, 's'), /is a folder\. Nothing was changed/)
  fs.rmSync(path.join(gameDir, 'SkyrimSELauncher.exe'), { recursive: true })
  let linked = true
  try { fs.symlinkSync(path.join(root, 'elsewhere'), path.join(ds[1].dir, 'Data', 'link.bsa')) } catch { linked = false }
  if (linked) assert.throws(() => dg.planInstall(ds, gameDir, 's'), /unexpected entries/)
  assert.deepStrictEqual(fs.readdirSync(gameDir).includes('_DragonBreakDowngrade'), false)
  fs.rmSync(root, { recursive: true, force: true })
})

test('safe relative paths: nothing outside the folder, nothing into the backup folder', () => {
  const base = path.resolve('/game')
  assert.strictEqual(dg.safeRelative(base, path.join(base, 'Data', 'Skyrim.esm')), path.join('Data', 'Skyrim.esm'))
  assert.strictEqual(dg.safeRelative(base, path.join(base, '..foo')), '..foo')
  assert.throws(() => dg.safeRelative(base, path.join(base, '..', 'Windows', 'x.dll')), /Unsafe path/)
  assert.throws(() => dg.safeRelative(base, base), /Unsafe path/)
  const root = tmp()
  const gameDir = game(root)
  const ds = depots(root)
  put(path.join(ds[1].dir, '_DragonBreakDowngrade', 'x', 'backup.json'), '{}')
  assert.throws(() => dg.planInstall(ds, gameDir, 's'), /Unsafe path/)
  fs.rmSync(root, { recursive: true, force: true })
})

test('verification: the exe first, then the base masters and every file with a known size or hash', async () => {
  const root = tmp()
  const gameDir = game(root)
  const plan = () => dg.planInstall(dg.findDepots([root]), gameDir, 's')
  depots(root)
  const ok = await dg.verifyPlan(plan(), { readVersion: readExe, hashFile: stubHash })
  assert.strictEqual(ok.version, '1.6.1170.0')
  assert.strictEqual(ok.checked, Object.keys(REF.files).length)

  put(path.join(root, 'steamapps', 'content', 'app_489830', 'depot_489833', 'SkyrimSE.exe'), 'exe 1.7.104.0')
  await assert.rejects(dg.verifyPlan(plan(), { readVersion: readExe, hashFile: stubHash }),
    /SkyrimSE\.exe is 1\.7\.104\.0, not 1\.6\.1170\. Nothing was changed/)
  put(path.join(root, 'steamapps', 'content', 'app_489830', 'depot_489833', 'SkyrimSE.exe'), 'exe 1.6.1170.0')

  const esm = path.join(root, 'steamapps', 'content', 'app_489830', 'depot_489831', 'Data', 'Update.esm')
  fs.rmSync(esm)
  await assert.rejects(dg.verifyPlan(plan(), { readVersion: readExe, hashFile: stubHash }), /Data\/Update\.esm is missing/)
  sized(esm, 5)
  await assert.rejects(dg.verifyPlan(plan(), { readVersion: readExe, hashFile: stubHash }), /Update\.esm is 5 bytes, not 18874041/)
  sized(esm, REF.files['Data/Update.esm'].size)
  const badHash = f => f.endsWith('Dawnguard.esm') ? Promise.resolve('0'.repeat(64)) : stubHash(f)
  await assert.rejects(dg.verifyPlan(plan(), { readVersion: readExe, hashFile: badHash }), /Dawnguard\.esm is not the 1\.6\.1170 file/)
  // Nothing in the game folder moved
  assert.strictEqual(read(path.join(gameDir, 'SkyrimSE.exe')), 'exe 1.7.104')
  fs.rmSync(root, { recursive: true, force: true })
})

test('install: old files move into the backup, depot files replace them, added files are recorded', async () => {
  const root = tmp()
  const gameDir = game(root)
  const plan = dg.planInstall(depots(root), gameDir, '20260929-160000')
  const steps = []
  const res = await dg.runPlan(plan, { onProgress: p => steps.push(p) })
  assert.strictEqual(res.replaced, 4)
  assert.strictEqual(steps.length, plan.jobs.length)
  assert.strictEqual(read(path.join(gameDir, 'SkyrimSE.exe')), 'exe 1.6.1170.0')
  assert.strictEqual(read(path.join(gameDir, 'Data', 'Skyrim - Interface.bsa')), 'interface 1170')
  assert.strictEqual(fs.statSync(path.join(gameDir, 'Data', 'Skyrim.esm')).size, REF.files['Data/Skyrim.esm'].size)
  assert.strictEqual(read(path.join(plan.backupDir, 'SkyrimSE.exe')), 'exe 1.7.104')
  assert.strictEqual(read(path.join(plan.backupDir, 'Data', 'Skyrim.esm')), 'skyrim.esm 1.7.104')
  assert.strictEqual(read(path.join(gameDir, 'Data', 'MyMod.esp')), 'a mod')
  const record = JSON.parse(read(path.join(plan.backupDir, 'backup.json')))
  assert.strictEqual(record.complete, true)
  assert.strictEqual(record.replaced.length, 4)
  assert.ok(record.added.map(r => r.split(path.sep).join('/')).includes('Data/Update.esm'))
  assert.strictEqual(dg.latestBackup(gameDir).dir, plan.backupDir)
  fs.rmSync(root, { recursive: true, force: true })
})

test('install: a copy that fails half-way puts every file back as it was', async () => {
  const root = tmp()
  const gameDir = game(root)
  const plan = dg.planInstall(depots(root), gameDir, '20260929-160000')
  const before = new Map(['SkyrimSE.exe', 'SkyrimSELauncher.exe', 'Data/Skyrim.esm', 'Data/Skyrim - Interface.bsa']
    .map(r => [r, read(path.join(gameDir, ...r.split('/')))]))
  let copies = 0
  const ops = {
    rename: (a, b) => fs.promises.rename(a, b),
    rm: p => fs.promises.rm(p, { force: true }),
    copyFile: (a, b) => {
      // The sixth depot file fails; copies back out of the backup still work
      if (!a.includes('_DragonBreakDowngrade') && ++copies === 6) return Promise.reject(new Error('disk full'))
      return fs.promises.copyFile(a, b)
    },
  }
  await assert.rejects(dg.runPlan(plan, { ops }), /failed \(disk full\)\. Every file was put back as it was\./)
  for (const [r, text] of before) assert.strictEqual(read(path.join(gameDir, ...r.split('/'))), text, r)
  for (const j of plan.jobs.filter(j => !j.replaces)) assert.ok(!fs.existsSync(j.to), `${j.rel} left behind`)
  assert.strictEqual(JSON.parse(read(path.join(plan.backupDir, 'backup.json'))).rolledBack, true)
  assert.strictEqual(dg.latestBackup(gameDir), null)
  fs.rmSync(root, { recursive: true, force: true })
})

test('restore: replaced files come back, added files go, and the spent backup is not offered again', async () => {
  const root = tmp()
  const gameDir = game(root)
  const plan = dg.planInstall(depots(root), gameDir, '20260929-160000')
  await dg.runPlan(plan)
  const back = dg.planRestore(gameDir, dg.latestBackup(gameDir).dir)
  const res = await dg.runRestore(back)
  assert.deepStrictEqual(res.failed, [])
  assert.strictEqual(read(path.join(gameDir, 'SkyrimSE.exe')), 'exe 1.7.104')
  assert.strictEqual(read(path.join(gameDir, 'Data', 'Skyrim.esm')), 'skyrim.esm 1.7.104')
  assert.strictEqual(read(path.join(gameDir, 'Data', 'Skyrim - Interface.bsa')), 'interface 1.7.104')
  assert.ok(!fs.existsSync(path.join(gameDir, 'Data', 'Update.esm')))
  assert.strictEqual(read(path.join(gameDir, 'Data', 'MyMod.esp')), 'a mod')
  assert.strictEqual(dg.latestBackup(gameDir), null)
  fs.rmSync(root, { recursive: true, force: true })
})

test('restore: only the newest backup counts, and a backup record cannot reach outside the game folder', () => {
  const root = tmp()
  const gameDir = game(root)
  const base = path.join(gameDir, '_DragonBreakDowngrade')
  put(path.join(base, '20260901-100000', 'backup.json'), JSON.stringify({ replaced: ['SkyrimSE.exe'], added: [], complete: true }))
  put(path.join(base, '20260929-100000', 'backup.json'), JSON.stringify({ replaced: [], added: [], complete: true, restored: 'x' }))
  assert.strictEqual(dg.latestBackup(gameDir), null)
  fs.rmSync(path.join(base, '20260929-100000'), { recursive: true })
  assert.strictEqual(dg.latestBackup(gameDir).name, '20260901-100000')
  put(path.join(base, '20260930-100000', 'backup.json'), JSON.stringify({ replaced: [path.join('..', '..', 'evil.dll')], added: [] }))
  assert.throws(() => dg.planRestore(gameDir, path.join(base, '20260930-100000')), /Unsafe path/)
  put(path.join(base, '20260930-100000', 'backup.json'), JSON.stringify({ replaced: [], added: [path.join('_DragonBreakDowngrade', 'x')] }))
  assert.throws(() => dg.planRestore(gameDir, path.join(base, '20260930-100000')), /Unsafe path/)
  fs.rmSync(root, { recursive: true, force: true })
})

test('Steam update setting: only AutoUpdateBehavior changes, and a missing key is added inside AppState', () => {
  const acf = '"AppState"\r\n{\r\n\t"appid"\t\t"489830"\r\n\t"AutoUpdateBehavior"\t\t"0"\r\n\t"AllowOtherDownloadsWhileRunning"\t\t"0"\r\n}\r\n'
  const out = dg.setAutoUpdateOnLaunch(acf)
  assert.strictEqual(out.changed, true)
  assert.strictEqual(out.text, acf.replace('"AutoUpdateBehavior"\t\t"0"', '"AutoUpdateBehavior"\t\t"1"'))
  assert.strictEqual(dg.readAutoUpdate(out.text), '1')
  assert.deepStrictEqual(dg.setAutoUpdateOnLaunch(out.text), { text: out.text, changed: false })
  const bare = '"AppState"\n{\n\t"appid"\t\t"489830"\n}\n'
  const added = dg.setAutoUpdateOnLaunch(bare)
  assert.strictEqual(added.text, '"AppState"\n{\n\t"AutoUpdateBehavior"\t\t"1"\n\t"appid"\t\t"489830"\n}\n')
  assert.throws(() => dg.setAutoUpdateOnLaunch('not a manifest'), /not a Steam app manifest/)
})

test('detection: the exe version blocks, newer masters under the 1.6.1170 exe warn, and each edition is handled', () => {
  const root = tmp()
  const gameDir = game(root)
  let a = dg.assess(gameDir, 'Steam', version('1.7.104.0'))
  assert.deepStrictEqual([a.action, a.blocking], ['downgrade', true])
  // 1.7.99: the exe is still 1.6.1170, the masters are not
  a = dg.assess(gameDir, 'Steam', version('1.6.1170.0'))
  assert.deepStrictEqual([a.action, a.blocking, a.newerData], ['downgrade', false, ['Skyrim.esm']])
  sized(path.join(gameDir, 'Data', 'Skyrim.esm'), REF.files['Data/Skyrim.esm'].size)
  assert.strictEqual(dg.assess(gameDir, 'Steam', version('1.6.1170.0')).action, 'none')
  assert.strictEqual(dg.assess(gameDir, 'Steam', version(null)).action, 'none')
  assert.strictEqual(dg.assess(gameDir, 'GOG', version('1.6.1179.0')).action, 'none')
  assert.strictEqual(dg.assess(gameDir, 'GOG', version('1.6.640.0')).action, 'gog')
  assert.strictEqual(dg.assess(gameDir, 'Epic Games', version('1.6.1179.0')).action, 'refuse')
  assert.strictEqual(dg.assess(gameDir, 'Microsoft Store', version('1.6.1130.0')).action, 'refuse')
  fs.rmSync(root, { recursive: true, force: true })
})

test('after the downgrade: SKSE\'s 1.6.1170 runtime and the Address Library table are looked for', () => {
  const root = tmp()
  const runDir = path.join(root, 'skyrim')
  const mods = path.join(root, 'MO2', 'mods')
  assert.deepStrictEqual(dg.runtimeChecks(runDir, { modsDir: mods, mods: [] }), { skse: false, addressLibrary: false })
  put(path.join(runDir, 'skse64_loader.exe'))
  put(path.join(runDir, 'skse64_1_6_1170.dll'))
  put(path.join(mods, 'Address Library for SKSE Plugins', 'SKSE', 'Plugins', 'versionlib-1-6-1170-0.bin'))
  const enabled = dg.enabledMods('# comment\r\n+Address Library for SKSE Plugins\r\n-Old Mod\r\n*DLC: Dawnguard\r\n')
  assert.deepStrictEqual(enabled, ['Address Library for SKSE Plugins'])
  assert.deepStrictEqual(dg.runtimeChecks(runDir, { modsDir: mods, mods: enabled }), { skse: true, addressLibrary: true })
  assert.deepStrictEqual(dg.runtimeChecks(runDir, { modsDir: mods, mods: [] }), { skse: true, addressLibrary: false })
  fs.rmSync(root, { recursive: true, force: true })
})
