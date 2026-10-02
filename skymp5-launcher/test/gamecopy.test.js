'use strict'
// DragonBreak's own Skyrim copy (src/gamecopy.js): built only from files whose size and sha256 match the vanilla list,
// the rest from the depot output, checked afterwards only against its own record. Real files in temporary folders,
// with a tiny fake list; the Steam folder is never written to.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const gc = require('../src/gamecopy')

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gamecopy-test-'))
const put = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data) }
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex')
const at = (root, rel) => path.join(root, ...rel.split('/'))
const read = file => fs.readFileSync(file)
const exists = file => fs.existsSync(file)
// Every file below dir, relative, forward slashes
const listAll = dir => {
  const out = []
  const walk = sub => {
    for (const e of fs.readdirSync(path.join(dir, sub), { withFileTypes: true })) {
      const rel = sub ? `${sub}/${e.name}` : e.name
      if (e.isDirectory()) walk(rel)
      else out.push(rel)
    }
  }
  if (exists(dir)) walk('')
  return out.sort()
}

// The fake 1.6.1170 game: path -> [depot, bytes]
const VANILLA = {
  'SkyrimSE.exe': ['489833', Buffer.from('MZ exe 1.6.1170.0 ' + 'e'.repeat(40))],
  'steam_api64.dll': ['489831', Buffer.from('steam api 1.6.1170')],
  'Skyrim_Default.ini': ['489831', Buffer.from('[General]\nsLanguage=ENGLISH\n')],
  'Data/Skyrim.esm': ['489831', Buffer.from('TES4 Skyrim.esm 1.6.1170 ' + 's'.repeat(60))],
  'Data/Update.esm': ['489831', Buffer.from('TES4 Update.esm 1.6.1170 ' + 'u'.repeat(30))],
  'Data/Skyrim - Interface.bsa': ['489832', Buffer.from('BSA interface 1.6.1170')],
  'Data/Video/BGS_Logo.bik': ['489831', Buffer.from('BIK logo')],
}
const PATHS = Object.keys(VANILLA)
const MANIFEST = {
  build: '1.6.1170.0',
  platform: 'steam',
  generatedAt: '2026-10-02T00:00:00.000Z',
  files: PATHS.map(p => ({ path: p, size: VANILLA[p][1].length, sha256: sha(VANILLA[p][1]), depot: VANILLA[p][0] })),
}
const TOTAL = PATHS.reduce((n, p) => n + VANILLA[p][1].length, 0)

function steamFolder(root) {
  const dir = path.join(root, 'Steam', 'steamapps', 'common', 'Skyrim Special Edition')
  for (const p of PATHS) put(at(dir, p), VANILLA[p][1])
  return dir
}

// Another server's launcher was here: another exe, a cleaned master (same size, other bytes), its DLL and a plugin
function modSteam(dir) {
  put(at(dir, 'SkyrimSE.exe'), 'MZ exe 1.6.640.0 downgraded by someone else')
  const esm = Buffer.from(VANILLA['Data/Skyrim.esm'][1])
  esm[esm.length - 1] = 'C'.charCodeAt(0)
  put(at(dir, 'Data/Skyrim.esm'), esm)
  put(at(dir, 'dinput8.dll'), 'another server\'s loader')
  put(at(dir, 'Data/MyMod.esp'), 'TES4 a mod')
}

// Steam's download_depot output for the given files, under <root>/app_489830/depot_<id>/
function depotTree(root, rels, { lowerCase = false } = {}) {
  const app = path.join(root, 'Steam', 'steamapps', 'content', 'app_489830')
  for (const p of rels) put(at(path.join(app, `depot_${VANILLA[p][0]}`), lowerCase ? p.toLowerCase() : p), VANILLA[p][1])
  return app
}

async function freshCopy(root) {
  const steam = steamFolder(root)
  const m = gc.loadManifest(MANIFEST)
  const p = await gc.plan(await gc.classify(steam, m))
  const dest = path.join(root, 'DragonBreak', 'skyrim')
  const res = await gc.run(p.jobs, dest)
  const rec = gc.makeRecord({ manifest: m, files: res.written, source: steam })
  await gc.writeRecord(dest, rec)
  return { steam, dest, m, rec: await gc.readRecord(dest) }
}

test('a clean Steam folder: every file matches, is copied and recorded, and the copy then shows no drift', async () => {
  const root = tmp()
  const steam = steamFolder(root)
  const before = listAll(steam)
  const m = gc.loadManifest(JSON.stringify(MANIFEST))
  assert.strictEqual(m.files.size, PATHS.length)
  assert.strictEqual(m.bytes, TOTAL)
  const cls = await gc.classify(steam, m)
  assert.deepStrictEqual(cls.counts, { match: PATHS.length, changed: 0, missing: 0 })
  assert.deepStrictEqual(cls.extras, [])
  assert.ok(cls.files.every(f => f.verified))
  const p = await gc.plan(cls)
  assert.deepStrictEqual(p.unresolved, [])
  assert.ok(p.jobs.every(j => j.sources.length === 1 && j.sources[0].kind === 'source'))
  assert.deepStrictEqual(await gc.bytesNeeded(p.jobs, path.join(root, 'DragonBreak', 'skyrim')), { bytes: TOTAL, largest: VANILLA['Data/Skyrim.esm'][1].length, files: PATHS.length })

  const dest = path.join(root, 'DragonBreak', 'skyrim')
  const steps = []
  const res = await gc.run(p.jobs, dest, { onProgress: e => steps.push(e) })
  assert.deepStrictEqual(res.failed, [])
  assert.strictEqual(res.written.length, PATHS.length)
  assert.ok(res.written.every(w => w.source === 'source' && w.how === 'copied'))
  for (const p2 of PATHS) assert.deepStrictEqual(read(at(dest, p2)), VANILLA[p2][1], p2)
  assert.strictEqual(steps[steps.length - 1].doneBytes, TOTAL)
  assert.deepStrictEqual(listAll(steam), before, 'the Steam folder is only read')

  const rec = gc.makeRecord({ manifest: m, files: res.written, source: steam })
  await gc.writeRecord(dest, rec)
  const back = await gc.readRecord(dest)
  assert.strictEqual(back.build, '1.6.1170.0')
  assert.strictEqual(back.source.dir, steam)
  assert.deepStrictEqual(back.files.map(f => f.path), [...PATHS].sort())
  assert.ok(back.files.every(f => typeof f.mtimeMs === 'number' && /^[0-9a-f]{64}$/.test(f.sha256)))
  assert.deepStrictEqual(listAll(dest), [...PATHS, gc.RECORD_FILE].sort())

  let hashed = 0
  const d = await gc.drift(dest, back, m, { hash: (f, o) => { hashed++; return gc.hashFile(f, o) } })
  assert.strictEqual(d.ok, true)
  assert.strictEqual(hashed, 0, 'an untouched copy is checked by size, mtime and file id alone')
  assert.deepStrictEqual([d.changed, d.missing, d.linked, d.extraRootDlls], [[], [], [], []])
  fs.rmSync(root, { recursive: true, force: true })
})

test('names are matched without regard to case, the way Windows finds them', async () => {
  const root = tmp()
  const steam = steamFolder(root)
  fs.renameSync(path.join(steam, 'Data'), path.join(steam, 'data'))
  fs.renameSync(path.join(steam, 'data', 'Skyrim.esm'), path.join(steam, 'data', 'SKYRIM.ESM'))
  const m = gc.loadManifest(MANIFEST)
  const cls = await gc.classify(steam, m)
  assert.deepStrictEqual(cls.counts, { match: PATHS.length, changed: 0, missing: 0 })
  const dest = path.join(root, 'copy')
  await gc.run((await gc.plan(cls)).jobs, dest)
  assert.deepStrictEqual(read(at(dest, 'Data/Skyrim.esm')), VANILLA['Data/Skyrim.esm'][1], 'the copy uses the list\'s own names')
  fs.rmSync(root, { recursive: true, force: true })
})

test('a modded Steam folder: the changed exe and the cleaned master come from the depot, extras are never copied', async () => {
  const root = tmp()
  const steam = steamFolder(root)
  modSteam(steam)
  const steamBefore = new Map(listAll(steam).map(p => [p, sha(read(at(steam, p)))]))
  const depot = depotTree(root, ['SkyrimSE.exe', 'Data/Skyrim.esm'], { lowerCase: true })
  const m = gc.loadManifest(MANIFEST)

  const cls = await gc.classify(steam, m)
  assert.deepStrictEqual(cls.counts, { match: PATHS.length - 2, changed: 2, missing: 0 })
  const state = Object.fromEntries(cls.files.map(f => [f.path, `${f.state}${f.reason ? `:${f.reason}` : ''}`]))
  assert.strictEqual(state['SkyrimSE.exe'], 'changed:size')
  assert.strictEqual(state['Data/Skyrim.esm'], 'changed:sha256', 'same size, other bytes: caught by the hash')
  assert.deepStrictEqual(cls.extras, ['Data/MyMod.esp', 'dinput8.dll'])

  const p = await gc.plan(cls, { depotDir: depot })
  assert.deepStrictEqual(p.unresolved, [])
  const kinds = Object.fromEntries(p.jobs.map(j => [j.path, j.sources.map(s => s.kind).join('+')]))
  assert.strictEqual(kinds['SkyrimSE.exe'], 'depot')
  assert.strictEqual(kinds['Data/Skyrim.esm'], 'depot')
  assert.strictEqual(kinds['Data/Update.esm'], 'source')
  const dest = path.join(root, 'DragonBreak', 'skyrim')
  const need = await gc.bytesNeeded(p.jobs, dest)
  assert.strictEqual(need.bytes, TOTAL - VANILLA['SkyrimSE.exe'][1].length - VANILLA['Data/Skyrim.esm'][1].length,
    'depot files moved on the same drive take no extra space')

  const res = await gc.run(p.jobs, dest)
  assert.deepStrictEqual(res.failed, [])
  const how = Object.fromEntries(res.written.map(w => [w.path, `${w.source}/${w.how}`]))
  assert.strictEqual(how['SkyrimSE.exe'], 'depot/moved')
  assert.strictEqual(how['Data/Skyrim.esm'], 'depot/moved')
  for (const p2 of PATHS) assert.deepStrictEqual(read(at(dest, p2)), VANILLA[p2][1], p2)
  assert.ok(!exists(at(dest, 'dinput8.dll')) && !exists(at(dest, 'Data/MyMod.esp')), 'extras stay out of the copy')
  assert.deepStrictEqual(new Map(listAll(steam).map(p2 => [p2, sha(read(at(steam, p2)))])), steamBefore, 'Steam is untouched')
  assert.deepStrictEqual(listAll(depot), [], 'the depot files were moved, not copied')
  fs.rmSync(root, { recursive: true, force: true })
})

test('no depot, or a depot file with the wrong bytes: those files are unresolved, with the depots to download', async () => {
  const root = tmp()
  const steam = steamFolder(root)
  modSteam(steam)
  const m = gc.loadManifest(MANIFEST)
  const cls = await gc.classify(steam, m)

  const none = await gc.plan(cls)
  assert.deepStrictEqual(none.unresolved.map(u => u.path).sort(), ['Data/Skyrim.esm', 'SkyrimSE.exe'])
  assert.deepStrictEqual(none.depotsNeeded, ['489831', '489833'])
  assert.strictEqual(none.jobs.length, PATHS.length - 2)
  assert.ok(none.unresolved.every(u => u.depotFile === 'absent'))

  // A depot folder whose Skyrim.esm is the right size but not the 1.6.1170 bytes
  const depot = depotTree(root, ['SkyrimSE.exe'])
  const bad = Buffer.from(VANILLA['Data/Skyrim.esm'][1])
  bad[0] = 'X'.charCodeAt(0)
  put(at(depot, 'depot_489831/Data/Skyrim.esm'), bad)
  const some = await gc.plan(cls, { depotDir: depot })
  assert.deepStrictEqual(some.unresolved.map(u => [u.path, u.depotFile]), [['Data/Skyrim.esm', 'wrong']])
  assert.deepStrictEqual(some.depotsNeeded, ['489831'])

  const dest = path.join(root, 'copy')
  const res = await gc.run(some.jobs, dest)
  assert.deepStrictEqual(res.failed, [])
  assert.ok(!exists(at(dest, 'Data/Skyrim.esm')), 'nothing unverified is written')
  assert.deepStrictEqual(read(at(depot, 'depot_489831/Data/Skyrim.esm')), bad, 'a rejected depot file is left alone')
  fs.rmSync(root, { recursive: true, force: true })
})

test('sizes only, then run checks the hash while copying: a wrong source file falls back to the depot', async () => {
  const root = tmp()
  const steam = steamFolder(root)
  modSteam(steam)
  const depot = depotTree(root, ['SkyrimSE.exe', 'Data/Skyrim.esm'])
  const m = gc.loadManifest(MANIFEST)
  const cls = await gc.classify(steam, m, { hash: false })
  const esm = cls.files.find(f => f.path === 'Data/Skyrim.esm')
  assert.deepStrictEqual([esm.state, esm.verified], ['match', false])
  const p = await gc.plan(cls, { depotDir: depot, hash: false })
  assert.deepStrictEqual(p.jobs.find(j => j.path === 'Data/Skyrim.esm').sources.map(s => s.kind), ['source', 'depot'])
  const dest = path.join(root, 'copy')
  const res = await gc.run(p.jobs, dest)
  assert.deepStrictEqual(res.failed, [])
  assert.strictEqual(res.written.find(w => w.path === 'Data/Skyrim.esm').source, 'depot')
  assert.deepStrictEqual(read(at(dest, 'Data/Skyrim.esm')), VANILLA['Data/Skyrim.esm'][1])
  assert.ok(!listAll(dest).some(f => f.endsWith(gc.TEMP_SUFFIX)))

  // Without a depot the file is reported failed, never written
  const res2 = await gc.run([{ ...p.jobs.find(j => j.path === 'Data/Skyrim.esm'), sources: [{ kind: 'source', from: at(steam, 'Data/Skyrim.esm') }] }], path.join(root, 'copy2'))
  assert.deepStrictEqual(res2.failed.map(f => [f.path, f.tried]), [['Data/Skyrim.esm', ['source: sha256 differs']]])
  assert.deepStrictEqual(listAll(path.join(root, 'copy2')), [])
  fs.rmSync(root, { recursive: true, force: true })
})

test('drift: an in-place overwrite and a dropped dxgi.dll are found; repair restores from the recorded source', async () => {
  const root = tmp()
  const { steam, dest, m, rec } = await freshCopy(root)
  // Another tool rewrites Update.esm in place (same size, same file id) a little later
  const file = at(dest, 'Data/Update.esm')
  const other = Buffer.from(VANILLA['Data/Update.esm'][1])
  other[5] = 'Z'.charCodeAt(0)
  fs.writeFileSync(file, other)
  const later = new Date(Date.now() + 5000)
  fs.utimesSync(file, later, later)
  put(at(dest, 'dxgi.dll'), 'ReShade')
  put(at(dest, 'skse64_1_6_1170.dll'), 'our SKSE')

  const d = await gc.drift(dest, rec, m, { allowRootDlls: ['SKSE64_1_6_1170.dll'] })
  assert.strictEqual(d.ok, false)
  assert.deepStrictEqual(d.changed, ['Data/Update.esm'])
  assert.deepStrictEqual(d.extraRootDlls, ['dxgi.dll'], 'our own SKSE DLL is on the allowlist; steam_api64.dll is on the list')
  assert.deepStrictEqual([d.missing, d.linked], [[], []])
  assert.strictEqual(d.rehashed, 1)

  const r = await gc.repair(dest, d, [], { record: rec, manifest: m })
  assert.strictEqual(r.ok, true)
  assert.deepStrictEqual(r.repaired, ['Data/Update.esm'])
  assert.deepStrictEqual(r.setAside, ['dxgi.dll'])
  assert.deepStrictEqual(read(file), VANILLA['Data/Update.esm'][1])
  assert.ok(!exists(at(dest, 'dxgi.dll')) && exists(at(dest, 'skse64_1_6_1170.dll')))
  assert.ok(listAll(path.join(dest, gc.SET_ASIDE_DIR)).some(f => f.endsWith('/dxgi.dll')))
  assert.deepStrictEqual(read(at(steam, 'Data/Update.esm')), VANILLA['Data/Update.esm'][1], 'the source is only read')

  const again = await gc.drift(dest, await gc.readRecord(dest), m, { allowRootDlls: ['skse64_1_6_1170.dll'] })
  assert.strictEqual(again.ok, true)
  assert.strictEqual(again.rehashed, 0, 'the record now holds the repaired file')
  fs.rmSync(root, { recursive: true, force: true })
})

test('repair copies only hash-matching files: a changed source is refused, a depot with the right file is used', async () => {
  const root = tmp()
  const { steam, dest, m, rec } = await freshCopy(root)
  fs.rmSync(at(dest, 'SkyrimSE.exe'))
  // Since the copy was made, another launcher downgraded Steam's exe to a file of the same size
  const exe = Buffer.from(VANILLA['SkyrimSE.exe'][1])
  exe[3] = '!'.charCodeAt(0)
  put(at(steam, 'SkyrimSE.exe'), exe)
  const d = await gc.drift(dest, rec, m)
  assert.deepStrictEqual(d.missing, ['SkyrimSE.exe'])

  const r1 = await gc.repair(dest, d, [], { record: rec, manifest: m })
  assert.strictEqual(r1.ok, false)
  assert.deepStrictEqual(r1.unresolved.map(u => [u.path, u.why]), [['SkyrimSE.exe', 'source: sha256 differs']])
  assert.ok(!exists(at(dest, 'SkyrimSE.exe')), 'the wrong exe is never written')

  const depot = depotTree(root, ['SkyrimSE.exe'])
  const r2 = await gc.repair(dest, d, [{ dir: steam, kind: 'source' }, { dir: depot, kind: 'depot' }], { record: rec, manifest: m })
  assert.strictEqual(r2.ok, true)
  assert.deepStrictEqual(read(at(dest, 'SkyrimSE.exe')), VANILLA['SkyrimSE.exe'][1])
  assert.ok(exists(at(depot, 'depot_489833/SkyrimSE.exe')), 'repair copies, the depot keeps its file')
  fs.rmSync(root, { recursive: true, force: true })
})

test('a file hard-linked to another install is reported and repair cuts the link', async () => {
  const root = tmp()
  const { steam, dest, m, rec } = await freshCopy(root)
  fs.rmSync(at(dest, 'steam_api64.dll'))
  fs.linkSync(at(steam, 'steam_api64.dll'), at(dest, 'steam_api64.dll'))
  const d = await gc.drift(dest, rec, m)
  assert.deepStrictEqual(d.linked, ['steam_api64.dll'])
  const r = await gc.repair(dest, d, [], { record: rec, manifest: m })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(fs.statSync(at(dest, 'steam_api64.dll')).nlink, 1)
  assert.strictEqual(fs.statSync(at(steam, 'steam_api64.dll')).nlink, 1)
  assert.deepStrictEqual(read(at(steam, 'steam_api64.dll')), VANILLA['steam_api64.dll'][1])
  fs.rmSync(root, { recursive: true, force: true })
})

test('paths that could leave the copy are refused: in the list, in a job, in the record, and through a link', async () => {
  const entry = p => ({ build: 'x', files: [{ path: p, size: 1, sha256: 'a'.repeat(64) }] })
  for (const p of ['../x', 'Data/../../x', '..\\x', 'Data\\..\\..\\x', '/etc/passwd', 'C:\\Windows\\x', 'C:/x',
    '\\\\server\\share\\x', 'Data//x', './x', 'Data/Skyrim.esm:stream', 'con.txt', 'Data/x.', '', gc.RECORD_FILE]) {
    assert.throws(() => gc.loadManifest(entry(p)), /Unsafe path|Reserved path/, JSON.stringify(p))
  }
  assert.throws(() => gc.loadManifest({ files: [MANIFEST.files[0], { ...MANIFEST.files[0], path: 'skyrimse.EXE' }] }), /Listed twice/)
  assert.throws(() => gc.loadManifest({ files: [{ path: 'a', size: -1, sha256: 'a'.repeat(64) }] }), /Bad size/)

  const root = tmp()
  const dest = path.join(root, 'copy')
  const src = path.join(root, 'src.bin')
  put(src, 'x')
  await assert.rejects(gc.run([{ path: '../x', size: 1, sha256: sha(Buffer.from('x')), sources: [{ kind: 'source', from: src }] }], dest), /Unsafe path/)
  assert.ok(!exists(path.join(root, 'x')))

  put(path.join(dest, gc.RECORD_FILE), JSON.stringify({ format: 1, files: [{ path: '../x', size: 1, mtimeMs: 0, sha256: 'a'.repeat(64) }] }))
  assert.strictEqual(await gc.readRecord(dest), null)

  // The copy's Data folder made into a link to another install: nothing is written through it
  const outside = path.join(root, 'other-install-Data')
  fs.mkdirSync(outside)
  fs.symlinkSync(outside, path.join(dest, 'Data'), 'dir')
  const job = { path: 'Data/Update.esm', size: 1, sha256: sha(Buffer.from('x')), sources: [{ kind: 'source', from: src }] }
  await assert.rejects(gc.run([job], dest), /is a link or a file/)
  assert.deepStrictEqual(fs.readdirSync(outside), [])
  fs.rmSync(root, { recursive: true, force: true })
})

test('an abort mid-file leaves no half-written file under its real name, and a moved depot file goes back', async () => {
  const root = tmp()
  const big = Buffer.alloc(3 * 1024 * 1024, 7)
  const small = Buffer.from('small file')
  const srcDir = path.join(root, 'src')
  put(path.join(srcDir, 'small.txt'), small)
  put(path.join(srcDir, 'Data', 'big.bsa'), big)
  const jobs = [
    { path: 'small.txt', size: small.length, sha256: sha(small), sources: [{ kind: 'source', from: path.join(srcDir, 'small.txt') }] },
    { path: 'Data/big.bsa', size: big.length, sha256: sha(big), sources: [{ kind: 'source', from: path.join(srcDir, 'Data', 'big.bsa') }] },
  ]
  const dest = path.join(root, 'copy')
  const ac = new AbortController()
  let seen = 0
  const onProgress = e => { if (e.file === 'Data/big.bsa' && e.fileBytes > 0) { seen = e.fileBytes; ac.abort() } }
  await assert.rejects(gc.run(jobs, dest, { onProgress, signal: ac.signal, chunkSize: 64 * 1024 }), { name: 'AbortError' })
  assert.ok(seen > 0 && seen < big.length, 'aborted part-way through the file')
  assert.deepStrictEqual(listAll(dest), ['small.txt'], 'the finished file stays; no part file, no half file')

  // A depot file being moved in: back in the depot, whole, after the abort
  const depotFile = path.join(root, 'depot_489831', 'Data', 'big.bsa')
  put(depotFile, big)
  const ac2 = new AbortController()
  const moveJob = { ...jobs[1], sources: [{ kind: 'depot', from: depotFile, move: true }] }
  await assert.rejects(gc.run([moveJob], path.join(root, 'copy2'), {
    signal: ac2.signal, chunkSize: 64 * 1024, onProgress: e => { if (e.fileBytes > 0) ac2.abort() },
  }), { name: 'AbortError' })
  assert.deepStrictEqual(read(depotFile), big)
  assert.deepStrictEqual(listAll(path.join(root, 'copy2')), [])
  fs.rmSync(root, { recursive: true, force: true })
})

test('the shipped 1.6.1170 list: 45 entries without Skyrim.ccc, the masters and the exe at their known sizes, no unsafe path', () => {
  const json = require('../src/vanilla-1.6.1170.json')
  const REF = require('../src/downgrade-1.6.1170.json')
  assert.deepStrictEqual([json.build, json.platform], ['1.6.1170.0', 'steam'])
  assert.strictEqual(json.files.length, 46)
  // Every path is safe (loadManifest throws on any that is not) and listed once, from the three base depots
  for (const f of json.files) assert.strictEqual(gc.normRel(f.path), f.path)
  assert.ok(json.files.every(f => ['489831', '489832', '489833'].includes(String(f.depot))))
  const m = gc.bundledManifest('steam', { omit: ['Skyrim.ccc'] })
  assert.deepStrictEqual([m.ready, m.files.size, m.language], [true, 45, null])
  assert.strictEqual(m.files.has('skyrim.ccc'), false)
  for (const master of ['Skyrim.esm', 'Update.esm', 'Dawnguard.esm', 'HearthFires.esm', 'Dragonborn.esm']) {
    const e = m.files.get(`data/${master.toLowerCase()}`)
    assert.ok(e, master)
    assert.deepStrictEqual([e.size, e.sha256], [REF.files[`Data/${master}`].size, REF.files[`Data/${master}`].sha256], master)
  }
  // Every file with a known 1.6.1170 hash has it in the list too
  for (const [p, want] of Object.entries(REF.files)) {
    const e = m.files.get(p.toLowerCase())
    if (e) assert.deepStrictEqual([e.size, e.sha256], [want.size, want.sha256], p)
  }
  const exe = m.files.get('skyrimse.exe')
  assert.ok(exe && exe.size > 1000000 && exe.depot === '489833')
  assert.ok(m.bytes > 15e9 && m.bytes < 17e9, `about 16 GB (${m.bytes})`)
  // omit drops files the launcher manages itself
  assert.strictEqual(gc.loadManifest(MANIFEST, { omit: ['skyrim_default.ini'] }).files.has('skyrim_default.ini'), false)
})

test('useBundledLists stands in for the shipped lists (tests only): an empty list is not ready, a missing one is null', () => {
  try {
    gc.useBundledLists({ steam: { build: '1.6.1170.0', platform: 'steam', files: [] } })
    assert.deepStrictEqual([gc.bundledManifest('steam').ready, gc.bundledManifest('gog')], [false, null])
    gc.useBundledLists({ steam: MANIFEST, 'steam:german': { language: 'german', files: [{ path: 'Data/Skyrim - Voices_de0.bsa', size: 3, sha256: 'd'.repeat(64), depot: '489836' }] } })
    assert.strictEqual(gc.bundledManifest('steam').files.size, PATHS.length)
    assert.strictEqual(gc.bundledManifest('steam', { language: 'german' }).files.size, PATHS.length + 1)
    assert.strictEqual(gc.bundledManifest('steam', { language: 'french' }).ready, false)
  } finally {
    gc.useBundledLists(null)
  }
  assert.strictEqual(gc.bundledManifest('steam').ready, true, 'back to the shipped list')
})

test('review junction.js: a copy whose Data is a junction into Steam is refused, nothing is written through it', async () => {
  const root = tmp()
  const steam = steamFolder(root)
  const dest = path.join(root, 'DragonBreak', 'skyrim')
  put(at(dest, 'SkyrimSE.exe'), VANILLA['SkyrimSE.exe'][1])
  fs.symlinkSync(path.join(steam, 'Data'), path.join(dest, 'Data'), 'dir')
  const m = gc.loadManifest(MANIFEST)
  await assert.rejects(gc.build(steam, dest, { manifest: m }), /Data in the game copy is a link to another folder/)
  assert.strictEqual(await gc.readRecord(dest), null, 'no record: the copy is not taken as complete')
  assert.deepStrictEqual(await gc.linkedFolders(dest, PATHS), ['Data'])
  // Walking the copy never follows the link: its files are not the copy's
  const cls = await gc.classify(dest, m, { followLinks: false, confine: true })
  assert.deepStrictEqual(cls.counts, { match: 1, changed: 0, missing: PATHS.length - 1 })
  assert.ok(!fs.readdirSync(path.join(steam, 'Data')).some(n => n.endsWith(gc.TEMP_SUFFIX)), 'nothing written into Steam')
  fs.rmSync(root, { recursive: true, force: true })
})

test('review junction.js: a Data junction made after the record shows in drift as linked', async () => {
  const root = tmp()
  const { steam, dest, m, rec } = await freshCopy(root)
  fs.rmSync(path.join(dest, 'Data'), { recursive: true })
  fs.symlinkSync(path.join(steam, 'Data'), path.join(dest, 'Data'), 'dir')
  const d = await gc.drift(dest, rec, m)
  assert.strictEqual(d.ok, false)
  assert.deepStrictEqual(d.linked.sort(), PATHS.filter(p => p.startsWith('Data/')).sort())
  await assert.rejects(gc.repair(dest, d, [], { record: rec, manifest: m }), /is a link or a file/)
  fs.rmSync(root, { recursive: true, force: true })
})

test('review junction.js: a depot file moved in when the launcher closed (left as .dbpart) is kept on the next build', async () => {
  const root = tmp()
  const depot = depotTree(root, PATHS)
  const dest = path.join(root, 'copy')
  fs.mkdirSync(path.join(dest, 'Data'), { recursive: true })
  fs.renameSync(at(depot, 'depot_489831/Data/Skyrim.esm'), at(dest, 'Data/Skyrim.esm' + gc.TEMP_SUFFIX))
  // A half-written copy of another file is no use and goes
  put(at(dest, 'Data/Update.esm' + gc.TEMP_SUFFIX), 'TES4 Upd')
  const m = gc.loadManifest(MANIFEST)
  const r = await gc.build(null, dest, { manifest: m, depotDir: depot })
  assert.strictEqual(r.ok, true, JSON.stringify(r.unresolved))
  assert.strictEqual(r.kept, 1)
  for (const p of PATHS) assert.deepStrictEqual(read(at(dest, p)), VANILLA[p][1], p)
  assert.ok(!listAll(dest).some(f => f.endsWith(gc.TEMP_SUFFIX)))
  fs.rmSync(root, { recursive: true, force: true })
})

test('a language list lies over the base list: its files replace the base ones at the same path', () => {
  const base = { build: '1.6.1170.0', platform: 'steam', files: [
    { path: 'Data/Skyrim - Interface.bsa', size: 1, sha256: 'a'.repeat(64), depot: '489832' },
    { path: 'SkyrimSE.exe', size: 2, sha256: 'b'.repeat(64), depot: '489833' }] }
  const fr = { language: 'french', files: [
    { path: 'data/skyrim - interface.bsa', size: 3, sha256: 'c'.repeat(64), depot: '489834' },
    { path: 'Data/Skyrim - Voices_fr0.bsa', size: 4, sha256: 'd'.repeat(64), depot: '489834' }] }
  const m = gc.loadManifest(gc.mergeLists(base, fr))
  assert.strictEqual(m.language, 'french')
  assert.strictEqual(m.files.size, 3)
  assert.deepStrictEqual([m.files.get('data/skyrim - interface.bsa').depot, m.files.get('skyrimse.exe').depot], ['489834', '489833'])
  // The shipped Steam list without a language list for it is not ready (that player stays on the legacy copy)
  assert.strictEqual(gc.bundledManifest('steam', { language: 'french' }).ready, false)
  assert.strictEqual(gc.bundledManifest('steam', { language: 'english' }).language, null)
})

test('a copy whose Data was moved to another drive with a junction is built, checked and repaired through it', async () => {
  const root = tmp()
  const steam = steamFolder(root)
  const dest = path.join(root, 'DragonBreak', 'skyrim')
  const otherDrive = path.join(root, 'D', 'SkyrimCopyData')
  fs.mkdirSync(otherDrive, { recursive: true })
  fs.mkdirSync(dest, { recursive: true })
  fs.symlinkSync(otherDrive, path.join(dest, 'Data'), 'dir')
  const m = gc.loadManifest(MANIFEST)
  // The policy main.js passes: anything but the Skyrim folder and the Steam libraries
  const allowLink = real => !fs.realpathSync(real).startsWith(fs.realpathSync(path.join(root, 'Steam')))
  const r = await gc.build(steam, dest, { manifest: m, allowLink })
  assert.strictEqual(r.ok, true)
  assert.deepStrictEqual(read(path.join(otherDrive, 'Skyrim.esm')), VANILLA['Data/Skyrim.esm'][1], 'written through the allowed link')
  const rec = await gc.readRecord(dest)
  let d = await gc.drift(dest, rec, m, { allowLink })
  assert.strictEqual(d.ok, true)
  put(path.join(otherDrive, 'Update.esm'), Buffer.alloc(VANILLA['Data/Update.esm'][1].length, 1))
  d = await gc.drift(dest, rec, m, { allowLink })
  assert.deepStrictEqual(d.changed, ['Data/Update.esm'])
  const rep = await gc.repair(dest, d, [], { record: rec, manifest: m, allowLink })
  assert.strictEqual(rep.ok, true)
  assert.deepStrictEqual(read(path.join(otherDrive, 'Update.esm')), VANILLA['Data/Update.esm'][1])
  // Without the policy the same copy is refused, as a link into Steam always is
  await assert.rejects(gc.build(steam, dest, { manifest: m }), /link to another folder/)
  fs.rmSync(root, { recursive: true, force: true })
})

test('where real paths cannot be read (RAM disks, some virtual volumes) the copy is not taken as linked or missing', async () => {
  const root = tmp()
  const { steam, dest, m, rec } = await freshCopy(root)
  const realpath = fs.promises.realpath
  fs.promises.realpath = async () => { throw Object.assign(new Error('EISDIR: illegal operation on a directory, realpath'), { code: 'EISDIR' }) }
  try {
    const d = await gc.drift(dest, rec, m)
    assert.deepStrictEqual([d.ok, d.linked, d.missing], [true, [], []])
    const cls = await gc.classify(dest, m, { followLinks: false, confine: true })
    assert.deepStrictEqual(cls.counts, { match: PATHS.length, changed: 0, missing: 0 })
    const r = await gc.build(steam, dest, { manifest: m })
    assert.deepStrictEqual([r.ok, r.kept, r.written], [true, PATHS.length, 0], 'nothing copied again')
    // The lstat check still catches a real junction
    fs.rmSync(path.join(dest, 'Data'), { recursive: true })
    fs.symlinkSync(path.join(steam, 'Data'), path.join(dest, 'Data'), 'dir')
    const d2 = await gc.drift(dest, rec, m)
    assert.ok(d2.linked.length > 0)
  } finally {
    fs.promises.realpath = realpath
  }
  fs.rmSync(root, { recursive: true, force: true })
})

// Listed files a mod manager often deploys over (isolation.OPTIONAL_IN_COPY passes the same list in the launcher)
const OPTIONAL = ['Data/Video/BGS_Logo.bik', 'SkyrimSELauncher.exe', 'installscript.vdf', 'Low.ini', 'Medium.ini', 'High.ini',
  'Ultra.ini', 'Skyrim_Default.ini', 'Skyrim.ini', 'Skyrim/SkyrimPrefs.ini']
const LAUNCHER = Buffer.from('MZ SkyrimSELauncher 1.6.1170')
const withLauncher = () => gc.loadManifest({ ...MANIFEST, files: [...MANIFEST.files,
  { path: 'SkyrimSELauncher.exe', size: LAUNCHER.length, sha256: sha(LAUNCHER), depot: '489832' }] }, { optional: OPTIONAL })

test('an intro-skip BGS_Logo.bik in an old copy and in Steam is kept as it is: no depot, no drift', async () => {
  const root = tmp()
  const steam = steamFolder(root)
  put(at(steam, 'SkyrimSELauncher.exe'), LAUNCHER)
  const introSkip = Buffer.from('tiny intro-skip bik')
  put(at(steam, 'Data/Video/BGS_Logo.bik'), introSkip)
  // A copy launcher 2.1.36 made by name: the same intro-skip video
  const dest = path.join(root, 'copy')
  for (const p of PATHS) put(at(dest, p), VANILLA[p][1])
  put(at(dest, 'SkyrimSELauncher.exe'), LAUNCHER)
  put(at(dest, 'Data/Video/BGS_Logo.bik'), introSkip)
  const m = withLauncher()
  assert.strictEqual(m.files.get('data/video/bgs_logo.bik').optional, true)
  assert.strictEqual(m.files.get('skyrimse.exe').optional, false)
  const r = await gc.build(steam, dest, { manifest: m })
  assert.strictEqual(r.ok, true, JSON.stringify(r.unresolved))
  assert.deepStrictEqual([r.depotsNeeded, r.optionalKept, r.written], [[], ['Data/Video/BGS_Logo.bik'], 0])
  assert.deepStrictEqual(read(at(dest, 'Data/Video/BGS_Logo.bik')), introSkip, 'the copy keeps its own')
  const d = await gc.drift(dest, await gc.readRecord(dest), m)
  assert.strictEqual(d.ok, true, 'never drift worth a warning')
  fs.rmSync(root, { recursive: true, force: true })
})

test('skse64_loader renamed to SkyrimSELauncher.exe in Steam: left out quietly, never a depot; strict files stay strict', async () => {
  const root = tmp()
  const steam = steamFolder(root)
  put(at(steam, 'SkyrimSELauncher.exe'), 'skse64_loader.exe renamed by a mod manager')
  const dest = path.join(root, 'copy')
  const m = withLauncher()
  let r = await gc.build(steam, dest, { manifest: m })
  assert.strictEqual(r.ok, true)
  assert.deepStrictEqual(r.depotsNeeded, [])
  assert.deepStrictEqual(r.optionalSkipped.map(o => o.path), ['SkyrimSELauncher.exe'])
  assert.ok(!fs.existsSync(at(dest, 'SkyrimSELauncher.exe')))
  // Same size, other bytes: found while copying, still skipped rather than failed
  fs.rmSync(dest, { recursive: true, force: true })
  const same = Buffer.from(LAUNCHER)
  same[0] = 'X'.charCodeAt(0)
  put(at(steam, 'SkyrimSELauncher.exe'), same)
  r = await gc.build(steam, dest, { manifest: m })
  assert.deepStrictEqual([r.ok, r.failed, r.optionalSkipped.map(o => o.path)], [true, [], ['SkyrimSELauncher.exe']])
  // A matching one is copied when the copy lacks it
  fs.rmSync(dest, { recursive: true, force: true })
  put(at(steam, 'SkyrimSELauncher.exe'), LAUNCHER)
  r = await gc.build(steam, dest, { manifest: m })
  assert.deepStrictEqual(read(at(dest, 'SkyrimSELauncher.exe')), LAUNCHER)
  // A strict file (steam_api64.dll) with other bytes still asks for its depot
  fs.rmSync(dest, { recursive: true, force: true })
  put(at(steam, 'steam_api64.dll'), 'a modded steam api, other size')
  r = await gc.build(steam, dest, { manifest: m })
  assert.deepStrictEqual([r.ok, r.unresolved.map(u => u.path), r.depotsNeeded], [false, ['steam_api64.dll'], ['489831']])
  fs.rmSync(root, { recursive: true, force: true })
})
