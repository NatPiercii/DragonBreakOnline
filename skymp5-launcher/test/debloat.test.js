'use strict'
// Disk use: Vortex's download folder found from its settings, our downloads cleared without touching Vortex's or the
// player's Downloads, crash logs and dumps capped with the newest kept, stale parts and old client zips pruned
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const d = require('../src/debloat')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dbo-launcher-debloat-'))
test.after(() => fs.rmSync(root, { recursive: true, force: true }))
const mk = (...p) => { const dir = path.join(root, ...p); fs.mkdirSync(dir, { recursive: true }); return dir }
const put = (file, data = 'x', ageMs = 0) => {
  fs.writeFileSync(file, data)
  if (ageMs) { const t = new Date(Date.now() - ageMs); fs.utimesSync(file, t, t) }
  return file
}

test('the download pattern is read out of Vortex state bytes, and templates resolve like getDownloadPath', () => {
  const raw = Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from('settings###downloads###path\x13"D:\\\\Vortex Downloads"'),
    Buffer.from('\x00"{USERDATA}\\\\downloads"\x05"not a path"')])
  assert.deepEqual(d.vortexPathCandidates(raw), ['D:\\Vortex Downloads', '{USERDATA}\\downloads'])
  assert.deepEqual(d.vortexPathCandidates(Buffer.from('"C:\\\\Users\\\\Zoë\\\\VD"')), ['C:\\Users\\Zoë\\VD'])
  const ud = path.join(root, 'ud')
  assert.equal(d.resolveVortexPattern('{USERDATA}/dl', ud, 'me'), path.join(ud, 'dl'))
  assert.equal(d.resolveVortexPattern('{username}', ud, 'me'), path.join(ud, 'me'))
})

test("Vortex's folders: the default, plus a moved one only when it carries Vortex's tag", () => {
  const ud = mk('vortex-ud')
  mk('vortex-ud', 'downloads', 'skyrimse')
  const moved = mk('moved')
  mk('moved', 'skyrimse')
  const untagged = mk('untagged')
  mk('untagged', 'skyrimse')
  const readState = () => [moved, untagged, '{USERDATA}\\downloads']
  assert.deepEqual(d.vortexDownloadDirs({ userDataDirs: [ud], readState }), [path.join(ud, 'downloads', 'skyrimse')])
  put(path.join(moved, d.VORTEX_TAG), '{"instance":"x"}')
  assert.deepEqual(d.vortexDownloadDirs({ userDataDirs: [ud, path.join(root, 'missing')], readState }),
    [path.join(moved, 'skyrimse'), path.join(ud, 'downloads', 'skyrimse')])
  assert.deepEqual(d.vortexDownloadDirs({ userDataDirs: [ud], readState: () => { throw new Error('locked') } }),
    [path.join(ud, 'downloads', 'skyrimse')], 'an unreadable state still finds the default')
})

test("clearing our downloads removes archives and .meta only, and a hard link leaves Vortex's file", () => {
  const ours = mk('clear', 'downloads')
  const vortex = mk('clear', 'vortex')
  put(path.join(vortex, 'Linked-1.7z'), 'linked archive')
  fs.linkSync(path.join(vortex, 'Linked-1.7z'), path.join(ours, 'Linked-1.7z'))
  put(path.join(ours, 'Own-2.zip'), '12345')
  put(path.join(ours, 'Own-2.zip.meta'), 'meta')
  put(path.join(ours, 'readme.txt'), 'keep')
  put(path.join(ours, 'skse64_2_02_06.7z'), 'skse')
  const r = d.clearDownloads(ours, [vortex], ['SKSE64_2_02_06.7z'])
  assert.deepEqual(r, { removed: 2, bytes: 5, refused: false })
  assert.deepEqual(fs.readdirSync(ours).sort(), ['readme.txt', 'skse64_2_02_06.7z'])
  assert.equal(fs.readFileSync(path.join(vortex, 'Linked-1.7z'), 'utf8'), 'linked archive')
})

test("nothing is deleted when our folder is, holds or sits in Vortex's or the player's Downloads", () => {
  const userDownloads = mk('home', 'Downloads')
  put(path.join(userDownloads, 'Mine.7z'))
  for (const dir of [userDownloads, path.join(root, 'home')]) {
    assert.equal(d.clearDownloads(dir, [userDownloads]).refused, true)
    assert.equal(d.clearDuplicates(dir, [], [userDownloads]).refused, true)
  }
  const inside = mk('home', 'Downloads', 'sub')
  put(path.join(inside, 'Sub.7z'))
  assert.equal(d.clearDownloads(inside, [userDownloads]).refused, true)
  assert.equal(d.pruneStaleParts(userDownloads, { protect: [userDownloads], maxAgeMs: -1 }), 0)
  assert.ok(fs.existsSync(path.join(userDownloads, 'Mine.7z')) && fs.existsSync(path.join(inside, 'Sub.7z')))
})

test('the one-time cleanup removes only our copies Vortex holds by the same name and size', () => {
  const ours = mk('dupes', 'downloads')
  const vortex = mk('dupes', 'vortex')
  put(path.join(vortex, 'Same-1.7z'), 'same')
  put(path.join(vortex, 'Resized-2.7z'), 'longer here')
  put(path.join(ours, 'Same-1.7z'), 'same')
  put(path.join(ours, 'Resized-2.7z'), 'short')
  put(path.join(ours, 'OnlyOurs-3.7z'), 'ours')
  assert.deepEqual(d.clearDuplicates(ours, [vortex]), { removed: 1, bytes: 4, refused: false })
  assert.deepEqual(fs.readdirSync(ours).sort(), ['OnlyOurs-3.7z', 'Resized-2.7z'])
  assert.deepEqual(fs.readdirSync(vortex).sort(), ['Resized-2.7z', 'Same-1.7z'])
})

test('crash logs and dumps keep the newest 10, or fewer within 200 MB, and always the newest', () => {
  const skse = mk('crash', 'SKSE')
  const mo2 = mk('crash', 'overwrite')
  for (let i = 0; i < 8; i++) put(path.join(skse, `crash-${i}.log`), 'log', (i + 1) * 60_000)
  for (let i = 0; i < 6; i++) put(path.join(mo2, `dump-${i}.dmp`), 'dmp', (i + 1) * 60_000 + 30_000)
  put(path.join(skse, 'skse64.log'), 'not a crash file', 99 * 60_000)
  assert.deepEqual(d.capCrashFiles([skse, mo2]), { kept: 10, removed: 4 })
  assert.deepEqual(fs.readdirSync(skse).sort(), ['crash-0.log', 'crash-1.log', 'crash-2.log', 'crash-3.log', 'crash-4.log', 'skse64.log'])
  assert.deepEqual(fs.readdirSync(mo2).sort(), ['dump-0.dmp', 'dump-1.dmp', 'dump-2.dmp', 'dump-3.dmp', 'dump-4.dmp'])

  const big = mk('crash-big')
  put(path.join(big, 'crash-new.log'), 'x'.repeat(40), 1000)
  put(path.join(big, 'b.dmp'), 'x'.repeat(30), 2000)
  put(path.join(big, 'crash-old.log'), 'x', 3000)
  assert.deepEqual(d.capCrashFiles([big], { maxBytes: 50 }), { kept: 1, removed: 2 }, 'the cap stops at the first file that does not fit')
  assert.deepEqual(fs.readdirSync(big), ['crash-new.log'])
  put(path.join(big, 'huge.dmp'), 'x'.repeat(100), 10)
  assert.deepEqual(d.capCrashFiles([big], { maxBytes: 50 }), { kept: 1, removed: 1 }, 'the newest stays even over the cap')
  assert.deepEqual(fs.readdirSync(big), ['huge.dmp'])
})

test('partial downloads older than a day go; newer ones and other files stay', () => {
  const dir = mk('parts')
  put(path.join(dir, 'Old.7z.part'), 'x', 25 * 3600_000)
  put(path.join(dir, 'New.7z.part'), 'x', 3600_000)
  put(path.join(dir, 'Old.7z'), 'x', 48 * 3600_000)
  assert.equal(d.pruneStaleParts(dir), 1)
  assert.deepEqual(fs.readdirSync(dir).sort(), ['New.7z.part', 'Old.7z'])
})

test('old client zips go after an update; the current one and other temp files stay', () => {
  const tmp = mk('tmp')
  for (const f of ['alduinak-client-0.3.80-1.zip', 'alduinak-client.zip', 'alduinak-client-0.3.81-2.zip', 'alduinak-client-0.3.81-2.zip.part', 'other.zip']) put(path.join(tmp, f))
  assert.equal(d.pruneClientZips(tmp, path.join(tmp, 'alduinak-client-0.3.81-2.zip')), 2)
  assert.deepEqual(fs.readdirSync(tmp).sort(), ['alduinak-client-0.3.81-2.zip', 'alduinak-client-0.3.81-2.zip.part', 'other.zip'])
})
