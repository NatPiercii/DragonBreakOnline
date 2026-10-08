'use strict'
// Archives the player already has: found by hash in Vortex's downloads (or a chosen folder) and used where they are;
// the download wait says which files are in and counts a growing
// partial download as activity; one Nexus page at a time for the rest.
const test = require('node:test')
const assert = require('node:assert')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const mo2 = require('../src/mo2')
const { createGuide, nexusFilePage } = require('../src/nxm')

const sha = buf => crypto.createHash('sha256').update(buf).digest('hex')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dbo-launcher-archives-'))
mo2.setRootProvider(() => root)
mo2.setLogger(() => {})
const downloads = mo2.getDownloadsDir()
const vortex = path.join(root, 'Vortex', 'downloads', 'skyrimse')
fs.mkdirSync(downloads, { recursive: true })
fs.mkdirSync(vortex, { recursive: true })
test.after(() => fs.rmSync(root, { recursive: true, force: true }))

const A = Buffer.from('archive A '.repeat(100)), B = Buffer.from('archive B '.repeat(120))
fs.writeFileSync(path.join(vortex, 'Mod A-123-1-0.7z'), A)
fs.writeFileSync(path.join(vortex, 'notes.txt'), 'not an archive')

test('an archive Vortex already downloaded is found by its hash, and only by it', async () => {
  assert.equal(await mo2.findArchiveByHash(sha(A), A.length), null, 'not without the other folder')
  assert.equal(await mo2.findArchiveByHash(sha(A), A.length, [vortex]), path.join(vortex, 'Mod A-123-1-0.7z'))
  assert.equal(await mo2.findArchiveByHash(sha(B), B.length, [vortex]), null)
  assert.equal(await mo2.findArchiveByHash(sha(A), A.length + 1, [vortex]), null, 'the size must match first')
  assert.equal(await mo2.findArchiveByHash(sha(A), A.length, [path.join(root, 'missing')]), null)
})

test('the wait says which files are in, and a growing partial download keeps it alive', async () => {
  const wanted = [{ name: 'Mod B', hash: sha(B), size: B.length }, { name: 'Mod A', hash: sha(A), size: A.length }]
  if (!fs.existsSync(path.join(downloads, 'Mod A-123-1-0.7z'))) fs.writeFileSync(path.join(downloads, 'Mod A-123-1-0.7z'), A)
  const seen = []
  const part = path.join(downloads, 'Mod B-9-1-0.7z.unfinished')
  fs.writeFileSync(part, B.subarray(0, 100))
  let step = 0
  const paths = await mo2.waitForDownloads(wanted, (done, total, message, found) => {
    seen.push(found.slice())
    step++
    if (step === 2) fs.appendFileSync(part, B.subarray(100, 200))
    if (step === 4) fs.renameSync(part, path.join(downloads, 'Mod B-9-1-0.7z')) // an nxm download finishing
    if (step === 4) fs.writeFileSync(part, Buffer.alloc(0))
    if (step === 5) { fs.rmSync(part); fs.writeFileSync(path.join(downloads, 'Mod B-9-1-0.7z'), B) }
  }, undefined, 20, 400)
  assert.deepEqual(seen[0], [false, false], 'a file counts once its size has held for a scan')
  assert.ok(seen.some(f => !f[0] && f[1]), 'Mod A (linked in) is in before Mod B arrives')
  assert.deepEqual(seen.at(-1), [true, true])
  assert.equal(paths[0], path.join(downloads, 'Mod B-9-1-0.7z'))
})

test('a Mod Manager Download page, the one Vortex opens for free accounts', () => {
  assert.equal(nexusFilePage(266, 4567), 'https://www.nexusmods.com/skyrimspecialedition/mods/266?tab=files&file_id=4567&nmm=1')
  assert.equal(nexusFilePage('266" onload', '1'), 'https://www.nexusmods.com/skyrimspecialedition/mods/NaN?tab=files&file_id=1&nmm=1')
})

test('one Nexus page at a time: the next opens only when another file arrives', () => {
  const items = ['A', 'B', 'C'].map((n, i) => ({ name: n, source: { modId: 10 + i, fileId: 100 + i } }))
  const opened = [], said = []
  const next = createGuide(items, { open: u => opened.push(u), say: m => said.push(m) })
  assert.equal(next([false, false, false]), 0)
  assert.equal(next([false, false, false]), null, 'nothing new arrived: no second page')
  assert.equal(next([false, false, false]), null)
  assert.equal(next([true, false, false]), 1)
  assert.equal(next([true, false, true]), null, 'C came some other way; B is already open')
  assert.deepEqual(opened, [nexusFilePage(10, 100), nexusFilePage(11, 101)])
  assert.match(said[1], /^Nexus page 2 of 3: B\. Click "Slow download"/)
})

test('a slow download still being written keeps the wait alive past its timeout', async () => {
  const C = Buffer.from('archive C '.repeat(300))
  const part = path.join(downloads, 'Mod C-7-1-0.7z.unfinished')
  fs.writeFileSync(part, C.subarray(0, 10))
  let ticks = 0, grown = 10
  const started = Date.now()
  const paths = await mo2.waitForDownloads([{ name: 'Mod C', hash: sha(C), size: C.length }], () => {
    ticks++
    if (Date.now() - started < 250) { grown += 10; fs.appendFileSync(part, C.subarray(grown - 10, grown)) }
    else if (fs.existsSync(part)) { fs.rmSync(part); fs.writeFileSync(path.join(downloads, 'Mod C-7-1-0.7z'), C) }
  }, undefined, 10, 100)
  assert.ok(Date.now() - started > 250, 'it waited longer than the 100 ms timeout')
  assert.equal(paths[0], path.join(downloads, 'Mod C-7-1-0.7z'))
})
