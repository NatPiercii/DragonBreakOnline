'use strict'
// New players on 2.1.34 pressed Install, saw "Not Responding" and closed the launcher mid-install (Veltrius, thedirthawk,
// 2026-09-30). 2.1.36 shows a progress bar weighted by bytes, warns to keep the launcher open, and refuses a second
// install while one runs. These check the progress maths, the words on screen, and that the main process guards
// every install request, not only the buttons.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const P = require('../src/renderer/installProgress')

const GB = 1024 ** 3, MB = 1024 ** 2

test('a big archive moves the overall bar far more than a small one', () => {
  const run = (acquire) => {
    const t = P.createTracker()
    t.begin('mo2')
    t.plan({ archives: [{ id: 'big', size: 2.5 * GB }, { id: 'small', size: 1 * MB }], installBytes: 3 * GB })
    t.step('download', { index: 0, total: 2 })
    const before = t.snapshot().overall
    t.acquired(acquire)
    return t.snapshot().overall - before
  }
  const big = run('big'), small = run('small')
  assert.ok(big > 0.4, `the 2.5 GB archive moves the bar ${big}`)
  assert.ok(small < 0.001, `the 1 MB archive barely moves it ${small}`)
  assert.ok(big > small * 1000)
})

test('a download in flight counts by the bytes that have arrived, and a finished one clears the file bar', () => {
  const t = P.createTracker()
  t.begin('mo2')
  t.plan({ archives: [{ id: 'a', size: 100 * MB }], installBytes: 100 * MB })
  t.step('download', { index: 0, total: 1 })
  const start = t.snapshot().overall
  t.file('A.7z', 50 * MB, 100 * MB, 'a')
  const half = t.snapshot()
  assert.ok(Math.abs((half.overall - start) - 0.93 / 3) < 1e-9, `half the download is a third of the bytes band (downloads count double): ${half.overall - start}`)
  assert.deepStrictEqual(half.file, { name: 'A.7z', done: 50 * MB, total: 100 * MB })
  t.acquired('a')
  assert.strictEqual(t.snapshot().file, null)
  assert.ok(Math.abs(t.snapshot().overall - (0.05 + 0.93 * 2 / 3)) < 1e-9)
})

test('a downloaded byte counts twice an installed one, so the bar moves roughly with time', () => {
  assert.strictEqual(P.DOWNLOAD_WEIGHT, 2)
  const t = P.createTracker()
  t.begin('mo2')
  t.plan({ archives: [{ id: 'a', size: 16 * GB }], installBytes: 29 * GB })
  t.step('download', { index: 0, total: 1 })
  t.acquired('a')
  assert.ok(Math.abs(t.snapshot().overall - (0.05 + 0.93 * 32 / 61)) < 1e-9, 'the downloads fill 32 of the 61 weighted parts')
})

test('a whole MO2 install only ever moves the bar forward, and ends full', () => {
  const t = P.createTracker()
  const seen = []
  const look = () => seen.push(t.snapshot().overall)
  t.begin('mo2'); look()
  t.step('prepare', { index: 1, total: 2 }); look()
  for (let i = 10; i <= 90; i += 10) { t.step('verify', { index: i, total: 90 }); look() }
  const archives = Array.from({ length: 5 }, (_, i) => ({ id: `x${i}`, size: (i + 1) * 300 * MB }))
  t.plan({ archives, installBytes: 4 * GB })
  t.step('download', { index: 0, total: 5 }); look()
  for (const [k, a] of archives.slice(0, 3).entries()) {
    for (let r = 0; r <= a.size; r += a.size / 4) { t.file(`${a.id}.7z`, r, a.size, a.id); look() }
    t.acquired(a.id); t.step('download', { index: k + 1, total: 5 }); look()
  }
  t.step('wait', { index: 0, total: 2 }); t.waiting({ page: 1, pages: 2, name: 'x3.7z' }); look()
  t.file('x3.7z', 200 * MB, 1200 * MB, 'x3'); look()
  t.acquired('x3'); t.acquired('x4'); t.step('wait', { index: 2, total: 2 }); look()
  for (let i = 0; i < 4; i++) { t.step('install', { index: i, total: 4 }); look(); t.installed(1 * GB); t.step('install', { index: i + 1, total: 4 }); look() }
  t.step('finish'); look()
  t.step('finish', { index: 1, total: 1 }); look()
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] >= seen[i - 1] - 1e-12, `step ${i}: ${seen[i - 1]} -> ${seen[i]}`)
  assert.ok(seen[0] === 0 && Math.abs(seen[seen.length - 1] - 1) < 1e-12, `from ${seen[0]} to ${seen[seen.length - 1]}`)
  assert.ok(Math.abs(seen[11] - 0.05) < 1e-12, 'verifying ends at 5%')
})

test('a direct client install fills its bands by bytes, then by files unpacked', () => {
  const t = P.createTracker()
  t.begin('client')
  t.step('client')
  t.file('The client files', 30 * MB, 60 * MB)
  assert.ok(Math.abs(t.snapshot().overall - (0.02 + 0.38 * 0.5)) < 1e-9)
  t.step('unpack', { index: 50, total: 100 })
  assert.ok(Math.abs(t.snapshot().overall - (0.4 + 0.1 * 0.5)) < 1e-9)
  assert.strictEqual(t.snapshot().stepNo, 3)
  assert.strictEqual(t.snapshot().stepCount, 5)
})

// N5 (3 Oct): "98% downloaded". In 2.1.36 the client flow had no step after unpack, so the whole DragonBreak files
// check and download (about 1 GB on a Repair Client Files) ran with the bar on 98%, and the panel closed there.
test('a direct client install shows the DragonBreak files on the bar and ends full, never parked on 98%', () => {
  const t = P.createTracker()
  const seen = []
  const look = () => seen.push(t.snapshot().overall)
  t.begin('client'); look()
  t.step('client'); look()
  for (let r = 0; r <= 180 * MB; r += 45 * MB) { t.file('The client files', r, 180 * MB); look() }
  t.step('unpack'); look()
  for (let i = 1; i <= 287; i += 31) { t.step('unpack', { index: i, total: 287 }); look() }
  t.step('unpack', { index: 287, total: 287 }); look()
  const afterUnpack = seen[seen.length - 1]
  t.step('extras', { index: 0, total: 897 }); look()
  for (let i = 100; i <= 897; i += 100) { t.step('extras', { index: i, total: 897 }); look() }
  t.step('extras', { index: 897, total: 897 }); look()
  const checked = seen[seen.length - 1]
  for (let r = 0; r <= 900 * MB; r += 150 * MB) { t.file('DragonBreak.bsa (1/3)', r, 900 * MB); look() }
  const downloaded = seen[seen.length - 1]
  assert.strictEqual(P.describe(t.snapshot()).title, 'Step 4 of 5: Updating the DragonBreak files (897 of 897 files)')
  t.step('finish', { index: 1, total: 1 }); look()
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] >= seen[i - 1] - 1e-12, `step ${i}: ${seen[i - 1]} -> ${seen[i]}`)
  assert.ok(Math.abs(afterUnpack - 0.5) < 1e-12, `unpacking ends at 50%, not 98%: ${afterUnpack}`)
  assert.ok(Math.abs(checked - 0.6) < 1e-12, `checking the DragonBreak files ends at 60%: ${checked}`)
  assert.ok(Math.abs(downloaded - 0.98) < 1e-12, `their download fills 60% to 98%: ${downloaded}`)
  assert.ok(Math.abs(seen[seen.length - 1] - 1) < 1e-12, 'and the bar ends full')
})

test('an install of no known shape shows a working bar, or its own count when it has one', () => {
  const t = P.createTracker()
  t.begin('other')
  t.detail('Checking SKSE…')
  const d = P.describe(t.snapshot())
  assert.strictEqual(d.overall, null)
  assert.strictEqual(d.percent, '')
  assert.strictEqual(d.fileLine, 'Checking SKSE…')
  t.step('copy', { index: 5 * GB, total: 20 * GB })
  const c = P.describe(t.snapshot())
  assert.strictEqual(c.percent, '25%')
  assert.strictEqual(c.title, 'Copying the game files', 'no raw byte counts in the title')
})

test('what the player reads at each phase', () => {
  const t = P.createTracker()
  t.begin('mo2')
  t.plan({ archives: [{ id: 'a', size: 40 * MB }], installBytes: 40 * MB })
  t.step('wait', { index: 12, total: 90 })
  t.waiting({ page: 13, pages: 90, name: 'SkyUI_5_2_SE-12604-5-2SE.7z' })
  let d = P.describe(t.snapshot())
  assert.strictEqual(d.title, 'Step 3 of 5: Downloading from Nexus (12 of 90 pages)')
  assert.strictEqual(d.waiting, 'Waiting for you: click "Slow download" on the Nexus page that just opened (page 13 of 90). File: SkyUI_5_2_SE-12604-5-2SE.7z')
  t.file('SkyUI_5_2_SE-12604-5-2SE.7z', 12.3 * MB, 40 * MB, 'a')
  d = P.describe(t.snapshot())
  assert.strictEqual(d.waiting, '', 'no "waiting for you" once the file is coming in')
  assert.strictEqual(d.fileLine, 'SkyUI_5_2_SE-12604-5-2SE.7z: 12.3 / 40.0 MB')
  assert.ok(Math.abs(d.fileFraction - 12.3 / 40) < 1e-9)
  t.step('install', { index: 3, total: 90 })
  assert.strictEqual(P.describe(t.snapshot()).title, 'Step 4 of 5: Unpacking and installing mods (3 of 90 mods)')
  t.end()
  assert.strictEqual(P.describe(t.snapshot()), null, 'no panel once the install ends')
})

test('the warning says to keep the launcher open, not to press Install again, and to choose Wait', () => {
  assert.strictEqual(P.BANNER, "Installing. The first install downloads about 16 GB and needs about 65 GB of free space. Keep the launcher open, and don't close it or press Install again. It carries on even if Windows says Not Responding: choose Wait.")
})

test('the gate refuses a second install until the first ends', () => {
  const g = P.createGate()
  assert.strictEqual(g.refusal(), '')
  assert.deepStrictEqual(g.begin('the modpack'), { ok: true })
  const again = g.begin('the client files')
  assert.strictEqual(again.ok, false)
  assert.match(again.error, /already running \(the modpack\)/)
  assert.strictEqual(g.running(), 'the modpack', 'the refused request changes nothing')
  g.end()
  assert.deepStrictEqual(g.begin('the client files'), { ok: true })
})

// ---- main.js: every install request goes through the gate, whatever sent it ----
const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8')
const handler = (name) => {
  const at = main.search(new RegExp(`ipcMain\\.(handle|on)\\('${name.replace(/[:]/g, '\\$&')}'`))
  assert.ok(at >= 0, `${name} is handled in main.js`)
  return main.slice(at, main.indexOf('\n})\n', at))
}

test('main.js keeps one install gate and no loose install flag', () => {
  assert.doesNotMatch(main, /\blet installing\b|\binstalling = (true|false)/)
  assert.match(main, /const installGate {2}= installProgress\.createGate\(\)/)
})

test('a second install:start is refused in the main process and told to the window', () => {
  const body = handler('install:start')
  assert.match(body, /const gate = beginInstall\(/)
  assert.match(body, /if \(!gate\.ok\) \{[\s\S]*?send\('install:complete', \{ success: false/)
})

test('every other install step begins through the gate or refuses while one runs', () => {
  for (const name of ['game:createIsolated', 'install:mo2only', 'install:check']) assert.match(handler(name), /const gate = beginInstall\(/, name)
  for (const name of ['install:skse', 'install:uninstall', 'extras:disable', 'extras:enable', 'app:installUpdate']) {
    assert.match(handler(name), /if \(installGate\.running\(\)\) return \{ (success|ok): false, error: installGate\.refusal\(\) \}/, name)
  }
  for (const fn of ['async function guardLaunch(', 'async function exclusive(']) {
    const at = main.indexOf(fn)
    assert.match(main.slice(at, at + 400), /if \(installGate\.running\(\)\) return \{ (success|ok): false, error: installGate\.refusal\(\) \}/, fn)
  }
})

test('closing the window mid-install asks first, and only an explicit Close anyway closes it', () => {
  const at = main.indexOf("win.on('close'")
  assert.ok(at >= 0)
  const body = main.slice(at, main.indexOf('\n  })\n', at))
  assert.match(body, /if \(!installGate\.running\(\)\) return/)
  assert.match(body, /message: 'An install is running\. Close anyway\?'/)
  assert.match(body, /if \(choice !== 1\) e\.preventDefault\(\)/)
})

test('the client flow draws the DragonBreak files and closes on a full bar, whether or not the zip was downloaded', () => {
  const at = main.indexOf('async function installClientFilesCore(')
  const core = main.slice(at, main.indexOf('\n}\n', at))
  assert.match(core, /const directRun = installTrack\.kind\(\) === 'client'[\s\S]*?if \(!needsDownload\) \{/, 'directRun is known before the up-to-date path')
  assert.strictEqual((core.match(/syncExtraFiles\(skyrimPath, (false|force), directRun\)/g) || []).length, 2, 'both paths draw the extras')
  assert.strictEqual((core.match(/if \(directRun\) installStep\('finish', \{ index: 1, total: 1 \}\)/g) || []).length, 2, 'both paths end on a full bar')
  const sync = main.slice(main.indexOf('async function syncExtraFiles('), main.indexOf('async function installClientFilesCore('))
  assert.match(sync, /if \(track\) installStep\('extras', \{ index: 0, total: files\.length \}\)/)
  assert.match(sync, /if \(track\) installTrack\.step\('extras', \{ index: i \+ 1, total: files\.length \}\)/)
  assert.match(sync, /if \(track\) installTrack\.file\(`\$\{f\.path\.split\('\/'\)\.pop\(\)\} \(\$\{i \+ 1\}\/\$\{stale\.length\}\)`, doneBytes \+ received, totalBytes\)/)
})

test('the Nexus wait names the one page and file it waits for, not every remaining file', () => {
  assert.match(main, /Waiting for you: click "Slow download" on the Nexus page that just opened \(page \$\{w\.page\} of \$\{w\.pages\}\): \$\{w\.name\}/)
  const mo2 = fs.readFileSync(path.join(__dirname, '..', 'src', 'mo2.js'), 'utf8')
  assert.doesNotMatch(mo2, /Waiting for downloads: \$\{remaining\.join/)
})

test('the settings an install reads cannot be changed while it runs, but the others still save', () => {
  const body = handler('settings:save')
  // The install-critical keys are named in one place and refused with the gate's own message
  assert.match(main, /const INSTALL_SETTINGS = \['skyrimPath', 'baseDirPath', 'archiveDir', 'mo2Enabled', 'isolatedGame'\]/)
  assert.match(body, /if \(installGate\.running\(\)\) \{/)
  assert.match(body, /const blocked = INSTALL_SETTINGS\.filter\(k => k in clean\)/)
  assert.match(body, /error: installGate\.refusal\(\)/)
  // The rest of the payload is still written, so changing the server while installing keeps working
  assert.match(body, /for \(const k of blocked\) delete clean\[k\]\s*\n\s*if \(Object\.keys\(clean\)\.length\) store\.set\(clean\)/)
  // activeServerIndex is deliberately NOT install-critical
  assert.doesNotMatch(main, /const INSTALL_SETTINGS = \[[^\]]*activeServerIndex/)
})

test('the install banner asks for the peak free space, not the end state', () => {
  // 60.5 GiB is what is left AFTER the install; during it each mod is built aside before the swap, so the peak is
  // higher and a player with exactly 60 GB free can run out near the end (Worker F's W1)
  assert.match(P.BANNER, /needs about 65 GB of free space/)
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'renderer.js'), 'utf8')
  assert.match(renderer, /about 65 GB free: the game copy, MO2, the mods and their downloads/)
  assert.doesNotMatch(P.BANNER, /60 GB/)
  assert.doesNotMatch(renderer, /about 60 GB free/)
})

// ---- the window must not tell the player a refused save succeeded -------------------------------------------------
const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'renderer.js'), 'utf8')

test('an install locks its own settings, both Browse buttons and Save, with the busy title', () => {
  const at = renderer.indexOf('const INSTALL_LOCKED')
  assert.ok(at >= 0, 'the locked set is named in one place')
  const set = renderer.slice(at, renderer.indexOf(']', at))
  for (const f of ['fieldSkyrimPath', 'fieldBaseDir', 'fieldArchiveDir', 'fieldMo2Enabled', 'fieldIsolated']) {
    assert.match(set, new RegExp(f), `${f} is locked while an install runs`)
  }
  for (const b of ['btn-browse', 'btn-browse-base', 'btn-save']) {
    assert.match(set, new RegExp(b.replace(/-/g, '-')), `${b} is locked while an install runs`)
  }
  const lock = renderer.slice(renderer.indexOf('function setInstallLock'), renderer.indexOf('for (const b of [btnConnect'))
  assert.match(lock, /for \(const el of INSTALL_LOCKED\(\)\)/)
  assert.match(lock, /el\.disabled = true/)
  assert.match(lock, /el\.title = IP\.BUSY_TITLE/)
  assert.match(lock, /el\.disabled = false/, 'and they are released when the install ends')
})

test('a refused save says so and puts the stored values back', () => {
  const at = renderer.indexOf("document.getElementById('btn-save').addEventListener")
  assert.ok(at >= 0, 'the Save handler is in renderer.js')
  const body = renderer.slice(at, renderer.indexOf('\n})', at))
  assert.match(body, /const saved = await window\.electronAPI\.saveSettings\(data\)/, 'the result is kept, not discarded')
  assert.match(body, /if \(saved && saved\.ok === false\)/)
  assert.match(body, /await loadSettings\(\)/, 'the blocked fields are restored from settings:load')
  assert.match(body, /Not saved: an install is running/)
  // "Saved!" must not be reachable on the refusal path
  const refusal = body.slice(body.indexOf('saved.ok === false'))
  assert.ok(refusal.indexOf('return') < refusal.indexOf("'Saved!'") || refusal.indexOf("'Saved!'") === -1,
    'the refusal path returns before the Saved! message')
})
