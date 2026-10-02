'use strict'
// Isolated launcher phase 2 (src/isolation.js, gamecopy.build, mo2.ensureInstance): the feature gate, the game path in
// isolated mode, which folder decides the version gates, what the legacy repair may take from the Skyrim folder, the
// setup text and free-space check, the Skyrim Version panel's state, the Creations catalog, and the verified build.
// Real files in temporary folders; exe versions are stubbed.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const iso = require('../src/isolation')
const gc = require('../src/gamecopy')
const gameversion = require('../src/gameversion')
const mo2 = require('../src/mo2')

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'isolation-test-'))
const put = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data) }
const sized = (file, size) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.closeSync(fs.openSync(file, 'w')); fs.truncateSync(file, size) }
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex')
const at = (root, rel) => path.join(root, ...rel.split('/'))
const read = file => fs.readFileSync(file)
// readPeFileVersion stub: the fake exe's text after "exe "
const readExe = file => { try { const m = /^exe (\S+)/.exec(fs.readFileSync(file, 'utf8')); return m ? m[1] : null } catch { return null } }

// A Skyrim folder whose data has the 1.6.1170 sizes gameversion.checkGameData looks at (sparse files)
function skyrimFolder(root, exe = '1.6.1170.0') {
  const dir = path.join(root, 'Skyrim Special Edition')
  put(path.join(dir, 'SkyrimSE.exe'), `exe ${exe}`)
  for (const [name, size] of gameversion.DATA_SIZES_1170) sized(path.join(dir, 'Data', name), size)
  return dir
}

// ---------------------------------------------------------------------------------------------------- the gate

test('the gate: verified only with isolation on and a list that has files; GOG, Epic and the placeholder stay legacy', () => {
  const ready = { ready: true, files: new Map([['a', {}]]) }
  assert.strictEqual(iso.copyMode({ isolated: true, manifest: ready }), 'verified')
  assert.strictEqual(iso.copyMode({ isolated: false, manifest: ready }), 'legacy')
  assert.strictEqual(iso.copyMode({ isolated: true, manifest: null }), 'legacy')
  // The shipped Steam list is still the placeholder: legacy, as today
  const steam = iso.manifestFor('Steam')
  assert.strictEqual(steam.ready, false)
  assert.strictEqual(iso.copyMode({ isolated: true, manifest: steam }), 'legacy')
  // No GOG list ships yet; Epic and the Microsoft Store never have one
  assert.strictEqual(iso.manifestFor('GOG'), null)
  assert.strictEqual(iso.manifestFor('Epic Games'), null)
  assert.strictEqual(iso.manifestFor('Microsoft Store'), null)
  // A list for the edition turns it on, without Skyrim.ccc (the launcher keeps it empty)
  const load = (platform, opts) => gc.loadManifest({ build: platform, files: [
    { path: 'SkyrimSE.exe', size: 1, sha256: 'a'.repeat(64) }, { path: 'Skyrim.ccc', size: 1, sha256: 'b'.repeat(64) }] }, opts)
  const m = iso.manifestFor('GOG', load)
  assert.strictEqual(m.build, 'gog')
  assert.deepStrictEqual([...m.files.keys()], ['skyrimse.exe'])
  assert.strictEqual(iso.copyMode({ isolated: true, manifest: m }), 'verified')
})

test('a copy is ready with its record, the legacy marker or both masters; an interrupted one (exe only) is not', () => {
  const root = tmp()
  assert.strictEqual(iso.copyReady(null), false)
  put(path.join(root, 'SkyrimSE.exe'), 'exe')
  assert.strictEqual(iso.copyReady(root), false)
  put(path.join(root, gc.RECORD_FILE), '{}')
  assert.strictEqual(iso.copyReady(root), true)
  fs.rmSync(path.join(root, gc.RECORD_FILE))
  put(path.join(root, iso.COPY_MARKER), '{}')
  assert.strictEqual(iso.copyReady(root), true)
  fs.rmSync(path.join(root, iso.COPY_MARKER))
  put(path.join(root, 'Data', 'Skyrim.esm'), 'm')
  assert.strictEqual(iso.copyReady(root), false)
  put(path.join(root, 'Data', 'Update.esm'), 'm')
  assert.strictEqual(iso.copyReady(root), true)
  fs.rmSync(root, { recursive: true, force: true })
})

test('isolated mode never falls back to the Skyrim folder, and says so', () => {
  const p = { copyDir: 'C:\\DragonBreak\\skyrim', skyrimPath: 'C:\\Steam\\Skyrim' }
  assert.strictEqual(iso.gamePathFor({ ...p, isolated: true, copyReady: true }), p.copyDir)
  assert.strictEqual(iso.gamePathFor({ ...p, isolated: true, copyReady: false }), null)
  assert.strictEqual(iso.gamePathFor({ ...p, isolated: false, copyReady: true }), p.skyrimPath)
  assert.strictEqual(iso.gamePathFor({ ...p, isolated: false, copyReady: false, skyrimPath: '' }), null)
  assert.match(iso.noGamePathError(true), /game copy is not set up yet.*never plays from your Steam/)
  assert.strictEqual(iso.noGamePathError(false), 'Skyrim path not configured.')
})

test('version gates: our copy decides once it is ready; before that the Skyrim folder (legacy) or nothing (verified)', () => {
  const p = { copyDir: '/copy', skyrimPath: '/steam' }
  assert.strictEqual(iso.versionGateDir({ ...p, isolated: true, copyReady: true, mode: 'legacy' }), '/copy')
  assert.strictEqual(iso.versionGateDir({ ...p, isolated: true, copyReady: true, mode: 'verified' }), '/copy')
  assert.strictEqual(iso.versionGateDir({ ...p, isolated: true, copyReady: false, mode: 'legacy' }), '/steam')
  assert.strictEqual(iso.versionGateDir({ ...p, isolated: true, copyReady: false, mode: 'verified' }), null)
  assert.strictEqual(iso.versionGateDir({ ...p, isolated: false, copyReady: true, mode: 'legacy' }), '/steam')
})

test('a changed Steam exe does not block a good copy: the gate folder is the copy, and its assessment is clean', () => {
  const root = tmp()
  const steam = skyrimFolder(path.join(root, 'Steam'), '1.6.640.0')      // another server's downgrade
  const copy = skyrimFolder(path.join(root, 'DragonBreak'))
  const dir = iso.versionGateDir({ isolated: true, copyReady: true, copyDir: copy, skyrimPath: steam, mode: 'legacy' })
  const downgrade = require('../src/downgrade')
  assert.strictEqual(downgrade.assess(dir, 'Steam', readExe).blocking, false)
  assert.strictEqual(downgrade.assess(steam, 'Steam', readExe).blocking, true, 'Steam itself would have blocked PLAY')
  fs.rmSync(root, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------------------- the legacy repair

test('vetFile: the exe must be the target build; a file with a known sha256 must have it; others pass', async () => {
  const root = tmp()
  const good = Buffer.from('TES4 the 1.6.1170 master')
  const known = new Map([['data/skyrim.esm', { path: 'Data/Skyrim.esm', size: good.length, sha256: sha(good) }]])
  const opts = { edition: 'Steam', readVersion: readExe, known }
  put(path.join(root, 'SkyrimSE.exe'), 'exe 1.6.1170.0')
  assert.deepStrictEqual(await iso.vetFile('SkyrimSE.exe', path.join(root, 'SkyrimSE.exe'), opts), { ok: true })
  put(path.join(root, 'SkyrimSE.exe'), 'exe 1.7.104.0')
  const exeVet = await iso.vetFile('SkyrimSE.exe', path.join(root, 'SkyrimSE.exe'), opts)
  assert.match(exeVet.why, /1\.7\.104\.0, not 1\.6\.1170\.0/)
  assert.strictEqual(exeVet.kind, 'exe')
  put(path.join(root, 'SkyrimSE.exe'), 'not a PE')
  const unread = await iso.vetFile('SkyrimSE.exe', path.join(root, 'SkyrimSE.exe'), opts)
  assert.deepStrictEqual([unread.ok, unread.kind, unread.unreadable], [false, 'exe', true])
  assert.match(unread.why, /could not be read/)
  put(path.join(root, 'SkyrimSE.exe'), 'exe 1.6.1179.0')
  assert.strictEqual((await iso.vetFile('SkyrimSE.exe', path.join(root, 'SkyrimSE.exe'), { ...opts, edition: 'GOG' })).ok, true)

  put(path.join(root, 'Data', 'Skyrim.esm'), good)
  assert.strictEqual((await iso.vetFile('Data\\Skyrim.esm', path.join(root, 'Data', 'Skyrim.esm'), opts)).ok, true)
  const cleaned = Buffer.from(good)
  cleaned[0] = 'X'.charCodeAt(0)
  put(path.join(root, 'Data', 'Skyrim.esm'), cleaned)
  const dataVet = await iso.vetFile('Data/Skyrim.esm', path.join(root, 'Data', 'Skyrim.esm'), opts)
  assert.deepStrictEqual([dataVet.kind, /sha256/.test(dataVet.why)], ['data', true])
  put(path.join(root, 'Data', 'Skyrim.esm'), 'short')
  assert.match((await iso.vetFile('Data/Skyrim.esm', path.join(root, 'Data', 'Skyrim.esm'), opts)).why, /size/)
  // GOG's 1.6.1179 files are not listed: only the exe is checked there
  assert.strictEqual((await iso.vetFile('Data/Skyrim.esm', path.join(root, 'Data', 'Skyrim.esm'), { ...opts, edition: 'GOG' })).ok, true)
  put(path.join(root, 'Data', 'Skyrim - Textures0.bsa'), 'any')
  assert.strictEqual((await iso.vetFile('Data/Skyrim - Textures0.bsa', path.join(root, 'Data', 'Skyrim - Textures0.bsa'), opts)).ok, true)
  // The real list: the 11 known 1.6.1170 hashes from downgrade-1.6.1170.json
  assert.strictEqual(iso.KNOWN_FILES.size, 11)
  fs.rmSync(root, { recursive: true, force: true })
})

test('legacy repair: a trusted folder gives its files; an updated one gives nothing and the copy keeps its own', async () => {
  const root = tmp()
  const good = Buffer.from('TES4 dawnguard master 1170')
  const known = new Map([['data/dawnguard.esm', { path: 'Data/Dawnguard.esm', size: good.length, sha256: sha(good) }]])
  const steam = skyrimFolder(path.join(root, 'Steam'))
  const copy = path.join(root, 'copy')
  put(path.join(copy, 'SkyrimSE.exe'), 'exe 1.6.1170.0')
  put(path.join(copy, 'Data', 'Skyrim - Textures0.bsa'), 'copy textures')
  put(path.join(steam, 'Data', 'Skyrim - Textures0.bsa'), 'steam textures, other size')
  put(path.join(steam, 'Data', 'Dawnguard.esm'), good)
  const job = rel => ({ rel, from: at(steam, rel), to: at(copy, rel) })
  const opts = { srcDir: steam, edition: 'Steam', readVersion: readExe, known }

  // Trusted 1.6.1170 folder: the right files come across, a wrong known master does not
  let r = await iso.legacyRepairPlan([job('Data/Skyrim - Textures0.bsa'), job('Data/Dawnguard.esm')], opts)
  assert.strictEqual(r.trusted.ok, true)
  assert.deepStrictEqual(r.copy.map(j => j.rel), ['Data/Skyrim - Textures0.bsa', 'Data/Dawnguard.esm'])
  const wrong = Buffer.from(good)
  wrong[0] = 'Z'.charCodeAt(0)
  put(path.join(steam, 'Data', 'Dawnguard.esm'), wrong)
  r = await iso.legacyRepairPlan([job('Data/Dawnguard.esm')], opts)
  assert.deepStrictEqual(r.copy, [])
  assert.deepStrictEqual(r.broken.map(b => b.rel), ['Data/Dawnguard.esm'], 'missing from the copy and wrong in Steam')
  put(path.join(copy, 'Data', 'Dawnguard.esm'), good)
  r = await iso.legacyRepairPlan([job('Data/Dawnguard.esm')], opts)
  assert.deepStrictEqual(r.keep.map(k => k.rel), ['Data/Dawnguard.esm'], 'the copy keeps its right file')

  // Another launcher updated Steam's exe: nothing is taken from that folder, the copy keeps what it has
  put(path.join(steam, 'SkyrimSE.exe'), 'exe 1.7.104.0')
  r = await iso.legacyRepairPlan([job('SkyrimSE.exe'), job('Data/Skyrim - Textures0.bsa'), job('Data/Dragonborn.esm')], opts)
  assert.strictEqual(r.trusted.ok, false)
  assert.deepStrictEqual(r.copy, [])
  assert.deepStrictEqual(r.keep.map(k => k.rel), ['SkyrimSE.exe', 'Data/Skyrim - Textures0.bsa'])
  assert.deepStrictEqual(r.broken.map(b => b.rel), ['Data/Dragonborn.esm'])
  // An optional fallback file with no good source is skipped, not broken
  r = await iso.legacyRepairPlan([{ ...job('Data/ccBGSSSE001-Fish.bsa'), optional: true }], opts)
  assert.deepStrictEqual([r.broken.length, r.skipped.length], [0, 1])

  // Newer data with the 1.6.1170 exe (Steam 1.7.99+): not a source either
  put(path.join(steam, 'SkyrimSE.exe'), 'exe 1.6.1170.0')
  sized(path.join(steam, 'Data', 'Skyrim.esm'), 1000)
  assert.match(iso.trustSource(steam, 'Steam', { readVersion: readExe }).why, /newer game data/)
  fs.rmSync(root, { recursive: true, force: true })
})

test('legacy copy, no list yet: a cleaned master is tolerated, but never replaces the copy\'s file; the exe stays strict', async () => {
  const root = tmp()
  const good = Buffer.from('TES4 dawnguard master 1170')
  const known = new Map([['data/dawnguard.esm', { path: 'Data/Dawnguard.esm', size: good.length, sha256: sha(good) }]])
  const steam = skyrimFolder(path.join(root, 'Steam'))
  const copy = path.join(root, 'copy')
  put(path.join(copy, 'SkyrimSE.exe'), 'exe 1.6.1170.0')
  const cleaned = Buffer.from('TES4 dawnguard cleaned by SSEEdit')
  put(path.join(steam, 'Data', 'Dawnguard.esm'), cleaned)
  const job = rel => ({ rel, from: at(steam, rel), to: at(copy, rel) })
  const opts = { srcDir: steam, edition: 'Steam', readVersion: readExe, known, tolerateData: true }

  // Missing from the copy: copied from Steam as before, with the warning naming it
  let r = await iso.legacyRepairPlan([job('Data/Dawnguard.esm')], opts)
  assert.deepStrictEqual([r.copy.map(j => j.rel), r.warned.map(j => j.rel), r.broken], [['Data/Dawnguard.esm'], ['Data/Dawnguard.esm'], []])
  assert.strictEqual(iso.changedDataWarning(r.warned.map(j => j.rel)),
    'Your Steam copy has a changed Dawnguard.esm; DragonBreak will use it until its own clean copy is available.')
  // The copy has its own file (right, or itself a cleaned one from setup): never replaced by Steam's known-wrong one
  put(path.join(copy, 'Data', 'Dawnguard.esm'), 'TES4 the copy\'s own, other size')
  r = await iso.legacyRepairPlan([job('Data/Dawnguard.esm')], opts)
  assert.deepStrictEqual([r.copy, r.keep.map(k => k.rel), r.broken], [[], ['Data/Dawnguard.esm'], []])
  // Strict without the tolerance (what the verified path would do): that missing file is broken, not copied
  fs.rmSync(path.join(copy, 'Data', 'Dawnguard.esm'))
  r = await iso.legacyRepairPlan([job('Data/Dawnguard.esm')], { ...opts, tolerateData: false })
  assert.deepStrictEqual([r.copy, r.broken.map(b => b.rel)], [[], ['Data/Dawnguard.esm']])
  // Steam's exe on another build: nothing comes from that folder; a cleaned master already in the copy stays, but a
  // missing exe has no source and is broken
  put(path.join(steam, 'SkyrimSE.exe'), 'exe 1.6.640.0')
  put(path.join(copy, 'Data', 'Dawnguard.esm'), cleaned)
  fs.rmSync(path.join(copy, 'SkyrimSE.exe'))
  r = await iso.legacyRepairPlan([job('SkyrimSE.exe'), job('Data/Dawnguard.esm')], opts)
  assert.deepStrictEqual([r.copy, r.keep.map(k => k.rel), r.broken.map(b => b.rel)], [[], ['Data/Dawnguard.esm'], ['SkyrimSE.exe']])
  // Several files are named once each in one sentence
  assert.match(iso.changedDataWarning(['Data\\Update.esm', 'Data/Dawnguard.esm', 'Data/Update.esm']), /a changed Update\.esm and Dawnguard\.esm;/)
  assert.strictEqual(iso.changedDataWarning([]), null)
  fs.rmSync(root, { recursive: true, force: true })
})

test('review legacy.js: an untrusted folder\'s extra file is skipped unless the game needs it; an unreadable exe is said plainly', async () => {
  const root = tmp()
  const steam = path.join(root, 'steam')
  const copy = path.join(root, 'copy')
  put(path.join(steam, 'SkyrimSE.exe'), 'x')
  put(path.join(steam, 'Data', 'Video', 'NewIntro.bik'), 'new')
  put(path.join(steam, 'Data', 'Skyrim.esm'), 'm')
  fs.mkdirSync(path.join(copy, 'Data'), { recursive: true })
  const job = rel => ({ rel: path.join(...rel.split('/')), from: at(steam, rel), to: at(copy, rel), optional: false })
  // Steam's exe was changed by another launcher (1.6.640); the copy lacks a video Steam has: nothing to block on
  let r = await iso.legacyRepairPlan([job('Data/Video/NewIntro.bik')], { srcDir: steam, edition: 'Steam', readVersion: () => '1.6.640.0', tolerateData: true })
  assert.deepStrictEqual([r.copy.length, r.keep.length, r.broken.length, r.skipped.length], [0, 0, 0, 1])
  // A required master missing from the copy still blocks (no right source for it)
  r = await iso.legacyRepairPlan([job('Data/Skyrim.esm')], { srcDir: steam, edition: 'Steam', readVersion: () => '1.6.640.0', tolerateData: true })
  assert.deepStrictEqual(r.broken.map(b => b.rel), [path.join('Data', 'Skyrim.esm')])
  assert.strictEqual(iso.requiredFile('SkyrimSE.exe'), true)
  assert.strictEqual(iso.requiredFile('Data/Video/NewIntro.bik'), false)
  // An unreadable exe: flagged, so the launcher says so instead of sending the player to a panel that sees no problem
  const v = await iso.vetFile('SkyrimSE.exe', path.join(steam, 'SkyrimSE.exe'), { edition: 'Steam', readVersion: () => null })
  assert.deepStrictEqual([v.ok, v.kind, v.unreadable], [false, 'exe', true])
  assert.strictEqual(iso.trustSource(steam, 'Steam', { readVersion: () => null }).unreadable, true)
  // The copy's own exe that cannot be read is kept, as checkGameVersion and downgrade.assess accept it
  put(path.join(copy, 'SkyrimSE.exe'), 'x')
  r = await iso.legacyRepairPlan([job('SkyrimSE.exe')], { srcDir: steam, edition: 'Steam', readVersion: () => null, tolerateData: true })
  assert.deepStrictEqual([r.keep.length, r.broken.length], [1, 0])
  fs.rmSync(root, { recursive: true, force: true })
})

test('a copy whose Data (or a folder the launcher writes into) is a link is refused', () => {
  const root = tmp()
  const copy = path.join(root, 'copy')
  const steamData = path.join(root, 'steam', 'Data')
  fs.mkdirSync(steamData, { recursive: true })
  fs.mkdirSync(copy, { recursive: true })
  assert.strictEqual(iso.copyLinkProblem(copy), null)
  assert.strictEqual(iso.copyLinkProblem(path.join(root, 'nothing')), null)
  fs.symlinkSync(steamData, path.join(copy, 'Data'), 'dir')
  assert.match(iso.copyLinkProblem(copy), /^Data in the DragonBreak game copy .* is a link to another folder/)
  fs.rmSync(path.join(copy, 'Data'))
  fs.mkdirSync(path.join(copy, 'Data'))
  fs.mkdirSync(path.join(root, 'elsewhere'))
  fs.symlinkSync(path.join(root, 'elsewhere'), path.join(copy, 'Data', 'Platform'), 'dir')
  assert.match(iso.copyLinkProblem(copy), /^Data\\Platform in the DragonBreak game copy/)
  fs.rmSync(root, { recursive: true, force: true })
})

test('the language Steam installed: its appmanifest, else the voice archive; a language without its own list stays legacy', () => {
  const root = tmp()
  const game = path.join(root, 'steamapps', 'common', 'Skyrim Special Edition')
  fs.mkdirSync(path.join(game, 'Data'), { recursive: true })
  assert.strictEqual(iso.steamLanguage(game), 'english')
  put(path.join(game, 'Data', 'Skyrim - Voices_en0.bsa'), 'v')
  put(path.join(game, 'Data', 'Skyrim - Voices_de0.bsa'), 'v')
  assert.strictEqual(iso.steamLanguage(game), 'german', 'the localized voices beside the English ones')
  put(path.join(root, 'steamapps', 'appmanifest_489830.acf'),
    '"AppState"\n{\n\t"UserConfig"\n\t{\n\t\t"language"\t\t"french"\n\t}\n\t"MountedConfig"\n\t{\n\t\t"language"\t\t"polish"\n\t}\n}\n')
  assert.strictEqual(iso.steamLanguage(game), 'polish', 'what is mounted wins over what was asked for')
  // English is the base depots alone; German has no list of its own yet, so it is not ready (legacy copy)
  const base = { build: '1.6.1170.0', platform: 'steam', files: [{ path: 'SkyrimSE.exe', size: 1, sha256: 'a'.repeat(64) }] }
  const load = (platform, opts) => (opts.language === 'english' ? gc.loadManifest(base, opts) : { ...gc.loadManifest({ ...base, files: [] }), ready: false, missingLanguage: opts.language })
  assert.strictEqual(iso.manifestFor('Steam', load, { language: 'english' }).ready, true)
  const de = iso.manifestFor('Steam', load, { language: 'german' })
  assert.deepStrictEqual([de.ready, de.missingLanguage], [false, 'german'])
  assert.strictEqual(iso.copyMode({ isolated: true, manifest: de }), 'legacy')
  // The shipped lists: no language list exists yet
  const real = gc.bundledManifest('steam', { language: 'german' })
  assert.deepStrictEqual([real.ready, real.missingLanguage], [false, 'german'])
  fs.rmSync(root, { recursive: true, force: true })
})

test('migration: a 2.1.36 copy with cleaned masters keeps playing with a warning while the clean files are pending', () => {
  const pending = { success: false, needDepots: true, files: ['Data/Update.esm', 'Data/Dawnguard.esm'], error: 'download them' }
  const r = iso.migrationResult(pending, { playable: true })
  assert.strictEqual(r.ok, true, 'not blocked')
  assert.match(r.warning, /still has 2 changed Skyrim file\(s\) \(Update\.esm, Dawnguard\.esm\)\. It keeps playing with them/)
  // A copy that never played (incomplete) is not let through, and other failures still stop the pass
  assert.deepStrictEqual(iso.migrationResult(pending, { playable: false }), { ok: false, error: 'download them' })
  assert.strictEqual(iso.migrationResult({ success: false, error: 'Not enough free space' }, { playable: true }).ok, false)
  assert.deepStrictEqual(iso.migrationResult({ success: true, copied: 3 }, { playable: true }), { ok: true, warning: null, repaired: 3 })
})

// ---------------------------------------------------------------------------------------------- what the player sees

test('the setup text and the free-space check', () => {
  assert.strictEqual(iso.setupText({ dir: 'C:\\DragonBreak\\skyrim', edition: 'Steam', totalBytes: 16 * 1024 ** 3 }),
    'DragonBreak keeps its own Skyrim 1.6.1170 in C:\\DragonBreak\\skyrim (about 16 GB). Your Steam Skyrim and other servers are not changed.')
  assert.match(iso.setupText({ dir: 'D:\\DB\\skyrim', edition: 'GOG', totalBytes: 0 }), /Skyrim 1\.6\.1179 in D:\\DB\\skyrim \(about 16 GB\)\. Your GOG Skyrim/)
  const GB = 1024 ** 3
  assert.deepStrictEqual(iso.spaceCheck({ needed: 15 * GB, free: 40 * GB }).enough, true)
  const short = iso.spaceCheck({ needed: 15 * GB, free: 15 * GB })
  assert.strictEqual(short.enough, false, 'the 512 MB margin counts')
  assert.match(short.text, /15\.0 GB needed, 15\.0 GB free/)
  assert.strictEqual(iso.spaceCheck({ needed: GB, free: null }).enough, true)
})

test('the install base: the field, else stored, else C:\\DragonBreak, nested under DragonBreak unless it is one', () => {
  const no = () => false
  assert.strictEqual(iso.resolveBase({ override: '  /games ', stored: '/x', fallback: '/fb', exists: no }), path.join('/games', 'DragonBreak'))
  assert.strictEqual(iso.resolveBase({ override: '', stored: '/x/DragonBreak', fallback: '/fb', exists: no }), '/x/DragonBreak')
  assert.strictEqual(iso.resolveBase({ override: null, stored: '', fallback: '/mine', exists: p => p === path.join('/mine', 'alduinak-instance.txt') }), '/mine')
})

test('the Skyrim Version panel: legacy as before; verified fills the copy and leaves Steam alone', () => {
  const steamOld = { action: 'downgrade', blocking: true }
  const steamOk = { action: 'none', blocking: false }
  // Legacy: a ready, right copy needs nothing from a changed Steam folder: no in-place downgrade is offered
  assert.deepStrictEqual(iso.panelState({ mode: 'legacy', isolated: true, copyReady: true, steam: steamOld, copy: steamOk }),
    { action: 'none', blocking: false, copyOwn: true, copyBuild: null, copyWrong: false })
  // Without a ready copy (or with isolation off) the Steam folder's own state, as before
  assert.deepStrictEqual(iso.panelState({ mode: 'legacy', isolated: true, copyReady: false, steam: steamOld, copy: null }),
    { action: 'downgrade', blocking: true, copyOwn: false, copyBuild: null, copyWrong: false })
  assert.strictEqual(iso.panelState({ mode: 'legacy', isolated: false, copyReady: true, steam: steamOld, copy: steamOk }).action, 'downgrade')
  // copyWrong when only the copy is off
  assert.strictEqual(iso.panelState({ mode: 'legacy', isolated: true, copyReady: true, steam: steamOk, copy: steamOld }).copyWrong, true)
  // Verified: a ready copy needs nothing from Steam, whatever Steam's build
  assert.deepStrictEqual(iso.panelState({ mode: 'verified', isolated: true, copyReady: true, steam: steamOld }),
    { action: 'none', blocking: false, copyOwn: true, copyBuild: null, copyWrong: false })
  // A build short of files shows the depot steps, even when Steam's exe is right (a cleaned master, say)
  const p = iso.panelState({ mode: 'verified', isolated: true, copyReady: false, steam: steamOk, needs: { files: ['Data/Skyrim.esm'], count: 1 } })
  assert.deepStrictEqual([p.action, p.copyBuild.count], ['downgrade', 1])
  // No copy yet and Steam on another build: the depot steps, which fill the copy
  assert.strictEqual(iso.panelState({ mode: 'verified', isolated: true, copyReady: false, steam: steamOld }).copyBuild.count, 0)
})

test('only known injector and loader DLLs are moved out of the copy; other unknown DLLs are left and reported', () => {
  assert.deepStrictEqual(iso.dllsToSetAside(['dxgi.dll', 'DINPUT8.dll', 'tbb.dll', 'MyClient.dll']), ['dxgi.dll', 'DINPUT8.dll'])
})

// ------------------------------------------------------------------------------------------ the Creations catalog

test('the Creations catalog goes aside for a launch and back after it, and the player\'s own is never lost', () => {
  const local = tmp()
  const p = iso.catalogPaths(local)
  assert.deepStrictEqual(iso.moveCatalogAside(local, null), { moved: null, mark: null }, 'nothing to move')
  assert.strictEqual(iso.restoreCatalog(local, null), null, 'nothing we moved')
  put(p.catalog, 'player catalog CSV2_1234')
  let r = iso.moveCatalogAside(local, null)
  assert.strictEqual(r.moved, 'moved')
  const mark = r.mark
  assert.ok(!fs.existsSync(p.catalog) && iso.catalogAside(local, mark))
  // Our game wrote a fresh one meanwhile, and a second launch moves that one: the player's stays where it is
  put(p.catalog, 'written by our session')
  r = iso.moveCatalogAside(local, mark)
  assert.deepStrictEqual([r.moved, r.mark], ['session', mark])
  assert.strictEqual(read(p.kept).toString(), 'player catalog CSV2_1234')
  // After the game: the player's is back; one our game wrote is kept beside it
  put(p.catalog, 'written again')
  assert.strictEqual(iso.restoreCatalog(local, mark), 'restored')
  assert.strictEqual(read(p.catalog).toString(), 'player catalog CSV2_1234')
  assert.strictEqual(read(p.session).toString(), 'written again')
  assert.strictEqual(iso.catalogAside(local, mark), false)
  assert.strictEqual(iso.restoreCatalog(local, mark), 'gone')
  // An empty catalog is left alone
  put(p.catalog, '')
  assert.strictEqual(iso.moveCatalogAside(local, null).moved, null)
  fs.rmSync(local, { recursive: true, force: true })
})

test('a .dbo-disabled left by launcher 2.1.36 is never put back over the player\'s newer catalog', () => {
  const local = tmp()
  const p = iso.catalogPaths(local)
  put(p.kept, 'old catalog moved by 2.1.36')
  put(p.catalog, 'the player\'s newer catalog, longer')
  // Nothing of ours is aside (no mark): the start of this launcher restores nothing
  assert.strictEqual(iso.restoreCatalog(local, null), null)
  assert.strictEqual(iso.restoreCatalog(local, { size: 1, mtimeMs: 1 }), 'stale', 'only the file we moved goes back')
  assert.strictEqual(read(p.catalog).toString(), 'the player\'s newer catalog, longer')
  // A launch moves the current one aside with a fresh mark; the 2.1.36 file is kept as .dbo-old, never restored
  const r = iso.moveCatalogAside(local, null)
  assert.strictEqual(r.moved, 'moved')
  assert.strictEqual(read(p.old).toString(), 'old catalog moved by 2.1.36')
  assert.strictEqual(iso.restoreCatalog(local, r.mark), 'restored')
  assert.strictEqual(read(p.catalog).toString(), 'the player\'s newer catalog, longer')
  // An unmarked one goes back at start only when the player has no catalog at all
  put(p.kept, 'old catalog moved by 2.1.36')
  assert.strictEqual(iso.restoreOrphanCatalog(local), null, 'a current catalog is never replaced')
  fs.rmSync(p.catalog)
  assert.strictEqual(iso.restoreOrphanCatalog(local), 'restored')
  assert.strictEqual(read(p.catalog).toString(), 'old catalog moved by 2.1.36')
  fs.rmSync(local, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------------------- MO2 profile inis

test('mo2.ensureInstance writes our own skyrimcustom.ini once, so MO2 never copies in the player\'s', () => {
  const root = tmp()
  mo2.setRootProvider(() => root)
  mo2.setLogger(() => {})
  const game = path.join(root, 'skyrim')
  fs.mkdirSync(game, { recursive: true })
  mo2.ensureInstance(game, [])
  const custom = path.join(mo2.getProfileDir(), 'skyrimcustom.ini')
  assert.match(fs.readFileSync(custom, 'utf8'), /^; DragonBreak profile SkyrimCustom\.ini/)
  fs.writeFileSync(custom, '[Display]\r\nfGamma=1.2\r\n')
  mo2.ensureInstance(game, [])
  assert.strictEqual(fs.readFileSync(custom, 'utf8'), '[Display]\r\nfGamma=1.2\r\n', 'edits made in MO2 stay')
  fs.rmSync(root, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------------------- the verified build

const VANILLA = {
  'SkyrimSE.exe': ['489833', Buffer.from('MZ exe 1.6.1170.0 build')],
  'steam_api64.dll': ['489831', Buffer.from('steam api')],
  'Data/Skyrim.esm': ['489831', Buffer.from('TES4 Skyrim.esm 1.6.1170 ssssssssss')],
  'Data/Update.esm': ['489831', Buffer.from('TES4 Update.esm 1.6.1170 uuuu')],
  'Data/Skyrim - Interface.bsa': ['489832', Buffer.from('BSA interface 1.6.1170')],
}
const PATHS = Object.keys(VANILLA)
const MANIFEST = gc.loadManifest({
  build: '1.6.1170.0', platform: 'steam',
  files: PATHS.map(p => ({ path: p, size: VANILLA[p][1].length, sha256: sha(VANILLA[p][1]), depot: VANILLA[p][0] })),
})
const steamFolder = root => { const d = path.join(root, 'steam'); for (const p of PATHS) put(at(d, p), VANILLA[p][1]); return d }
const depotTree = (root, rels) => {
  const app = path.join(root, 'app_489830')
  for (const p of rels) put(at(path.join(app, `depot_${VANILLA[p][0]}`), p), VANILLA[p][1])
  return app
}

test('build: a clean Steam folder gives a full copy with its record, and the copy then shows no drift', async () => {
  const root = tmp()
  const steam = steamFolder(root)
  const dest = path.join(root, 'copy')
  const est = await gc.estimateBytes(MANIFEST, dest)
  assert.strictEqual(est.bytes, MANIFEST.bytes)
  const r = await gc.build(steam, dest, { manifest: MANIFEST })
  assert.deepStrictEqual([r.ok, r.kept, r.written], [true, 0, PATHS.length])
  for (const p of PATHS) assert.deepStrictEqual(read(at(dest, p)), VANILLA[p][1])
  const rec = await gc.readRecord(dest)
  assert.strictEqual(rec.source.dir, path.resolve(steam))
  assert.strictEqual((await gc.drift(dest, rec, MANIFEST)).ok, true)
  assert.strictEqual((await gc.estimateBytes(MANIFEST, dest)).bytes, 0)
  fs.rmSync(root, { recursive: true, force: true })
})

test('build: a copy made by an older launcher is checked by hash; right files stay, wrong ones are replaced', async () => {
  const root = tmp()
  const steam = steamFolder(root)
  const dest = path.join(root, 'copy')
  for (const p of PATHS) put(at(dest, p), VANILLA[p][1])
  put(at(dest, 'Data/Update.esm'), 'TES4 Update.esm 1.7.99 xxxxx')   // carried in by the old size repair
  put(at(dest, iso.COPY_MARKER), '{}')
  const r = await gc.build(steam, dest, { manifest: MANIFEST })
  assert.deepStrictEqual([r.ok, r.kept, r.written], [true, PATHS.length - 1, 1])
  assert.deepStrictEqual(read(at(dest, 'Data/Update.esm')), VANILLA['Data/Update.esm'][1])
  fs.rmSync(root, { recursive: true, force: true })
})

test('build: files Steam lacks stop it before anything is copied, then the depots fill the copy without touching Steam', async () => {
  const root = tmp()
  const steam = steamFolder(root)
  put(at(steam, 'SkyrimSE.exe'), 'MZ exe 1.7.104.0 updated by Steam')
  const dest = path.join(root, 'copy')
  const r1 = await gc.build(steam, dest, { manifest: MANIFEST })
  assert.strictEqual(r1.ok, false)
  assert.deepStrictEqual(r1.unresolved.map(u => u.path), ['SkyrimSE.exe'])
  assert.deepStrictEqual(r1.depotsNeeded, ['489833'])
  assert.ok(!fs.existsSync(dest), 'nothing copied before the player has the downloads')

  const depot = depotTree(root, ['SkyrimSE.exe'])
  const r2 = await gc.build(steam, dest, { manifest: MANIFEST, depotDir: depot })
  assert.strictEqual(r2.ok, true)
  assert.deepStrictEqual(read(at(dest, 'SkyrimSE.exe')), VANILLA['SkyrimSE.exe'][1])
  assert.strictEqual(read(at(steam, 'SkyrimSE.exe')).toString(), 'MZ exe 1.7.104.0 updated by Steam', 'Steam is untouched')
  assert.ok(!fs.existsSync(at(depot, 'depot_489833/SkyrimSE.exe')), 'the depot file was moved in')
  fs.rmSync(root, { recursive: true, force: true })
})

test('build: a same-size wrong file found while copying fails with its depot; the rerun keeps what was copied', async () => {
  const root = tmp()
  const steam = steamFolder(root)
  const cleaned = Buffer.from(VANILLA['Data/Skyrim.esm'][1])
  cleaned[cleaned.length - 1] = 'C'.charCodeAt(0)
  put(at(steam, 'Data/Skyrim.esm'), cleaned)
  const dest = path.join(root, 'copy')
  const r1 = await gc.build(steam, dest, { manifest: MANIFEST })
  assert.strictEqual(r1.ok, false)
  assert.deepStrictEqual([r1.failed.map(f => f.path), r1.depotsNeeded, r1.written], [['Data/Skyrim.esm'], ['489831'], PATHS.length - 1])
  assert.ok(!fs.existsSync(at(dest, 'Data/Skyrim.esm')))
  assert.strictEqual(await gc.readRecord(dest), null, 'no record for an incomplete copy')
  const r2 = await gc.build(steam, dest, { manifest: MANIFEST, depotDir: depotTree(root, ['Data/Skyrim.esm']) })
  assert.deepStrictEqual([r2.ok, r2.kept, r2.written], [true, PATHS.length - 1, 1])
  fs.rmSync(root, { recursive: true, force: true })
})

test('build: the space check refuses before anything is written; no Skyrim folder at all works from the depots', async () => {
  const root = tmp()
  const steam = steamFolder(root)
  const dest = path.join(root, 'copy')
  let asked = null
  const r = await gc.build(steam, dest, { manifest: MANIFEST, checkSpace: need => { asked = need; return 'Not enough free space' } })
  assert.deepStrictEqual([r.ok, r.error, asked.bytes], [false, 'Not enough free space', MANIFEST.bytes])
  assert.ok(!fs.existsSync(dest))
  const r2 = await gc.build(null, dest, { manifest: MANIFEST, depotDir: depotTree(root, PATHS) })
  assert.strictEqual(r2.ok, true)
  assert.strictEqual((await gc.readRecord(dest)).source.dir, null)
  await assert.rejects(gc.build(steam, dest, { manifest: gc.loadManifest({ files: [] }) }), /no game file list/)
  fs.rmSync(root, { recursive: true, force: true })
})

test('repair sets aside only the DLL names it is given', async () => {
  const root = tmp()
  const steam = steamFolder(root)
  const dest = path.join(root, 'copy')
  await gc.build(steam, dest, { manifest: MANIFEST })
  put(at(dest, 'dxgi.dll'), 'ReShade')
  put(at(dest, 'MyClient.dll'), 'a client package DLL')
  const rec = await gc.readRecord(dest)
  const d = await gc.drift(dest, rec, MANIFEST)
  assert.deepStrictEqual(d.extraRootDlls, ['MyClient.dll', 'dxgi.dll'])
  const r = await gc.repair(dest, d, [], { record: rec, manifest: MANIFEST, setAside: iso.dllsToSetAside(d.extraRootDlls) })
  assert.deepStrictEqual(r.setAside, ['dxgi.dll'])
  assert.ok(fs.existsSync(at(dest, 'MyClient.dll')) && !fs.existsSync(at(dest, 'dxgi.dll')))
  fs.rmSync(root, { recursive: true, force: true })
})
