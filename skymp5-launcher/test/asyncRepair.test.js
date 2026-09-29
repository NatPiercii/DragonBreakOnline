'use strict'
// Repair Modlist extracted, copied and hashed every mod archive synchronously in the main process, so the window froze
// for minutes and Windows called it "Not Responding" (Silanth, 2026-09-29: "Repair All crashes the launcher"). These run
// the real functions on real archives with the platform's 7-Zip, and check the event loop keeps turning meanwhile.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { execFileSync } = require('child_process')
const mo2 = require('../src/mo2')

const seven = require('7zip-bin').path7za
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'async-repair-test-'))
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

// An archive with a small text file and a big incompressible one, so extracting it takes a noticeable moment
function makeArchive(dir, bigMb = 48) {
  const src = path.join(dir, 'src')
  fs.mkdirSync(path.join(src, 'Data'), { recursive: true })
  fs.writeFileSync(path.join(src, 'Data', 'small.txt'), 'hello from the archive\r\n')
  fs.writeFileSync(path.join(src, 'Data', 'big.bin'), crypto.randomBytes(bigMb * 1024 * 1024))
  const archive = path.join(dir, 'mod.7z')
  execFileSync(seven, ['a', '-mx=0', archive, '.'], { cwd: src, stdio: 'ignore' })
  return { archive, src }
}

// Counts timer ticks while a promise is pending: a blocked event loop counts none
async function ticksDuring(promise) {
  let ticks = 0
  const timer = setInterval(() => { ticks++ }, 2)
  try { await promise } finally { clearInterval(timer) }
  return ticks
}

test('extractArchive extracts without blocking the event loop', async () => {
  const dir = tmp()
  const { archive, src } = makeArchive(dir)
  const out = path.join(dir, 'out')
  const ticks = await ticksDuring(mo2.extractArchive(archive, out))
  assert.strictEqual(fs.readFileSync(path.join(out, 'Data', 'small.txt'), 'utf8'), 'hello from the archive\r\n')
  assert.strictEqual(sha(path.join(out, 'Data', 'big.bin')), sha(path.join(src, 'Data', 'big.bin')))
  assert.ok(ticks > 0, `the event loop turned ${ticks} time(s) during the extraction`)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('extractArchive rejects on a broken archive and on its timeout, without throwing synchronously', async () => {
  const dir = tmp()
  const bad = path.join(dir, 'bad.7z')
  fs.writeFileSync(bad, 'this is not an archive')
  await assert.rejects(mo2.extractArchive(bad, path.join(dir, 'out1')), /7-Zip exited with code \d+ on bad\.7z/)
  const { archive } = makeArchive(dir, 96)
  await assert.rejects(mo2.extractArchive(archive, path.join(dir, 'out2'), 1), /7-Zip took longer than 0 minutes on mod\.7z/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('verifyArchiveAsync: the right hash, a wrong one, and a missing file', async () => {
  const dir = tmp()
  const { archive } = makeArchive(dir, 8)
  const want = sha(archive)
  assert.strictEqual(await mo2.verifyArchiveAsync(archive, want.toUpperCase()), true)
  assert.strictEqual(await mo2.verifyArchiveAsync(archive, '0'.repeat(64)), false)
  assert.strictEqual(await mo2.verifyArchiveAsync(path.join(dir, 'gone.7z'), want), false)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('extractToCache and applyMod build a mod folder in the background, and a hash mismatch fails that mod only', async () => {
  const root = tmp()
  mo2.setRootProvider(() => root)
  const { archive, src } = makeArchive(root, 8)
  const dir = await mo2.extractToCache(archive, 'a1')
  assert.ok(fs.existsSync(path.join(dir, '.complete')))
  const files = [
    { to: 'small.txt', archive: 'a1', from: 'Data/small.txt', sha256: sha(path.join(src, 'Data', 'small.txt')) },
    { to: 'textures/big.bin', archive: 'a1', from: 'Data/big.bin', sha256: sha(path.join(src, 'Data', 'big.bin')) },
    { to: 'inline.ini', inline: Buffer.from('[General]\r\n').toString('base64') },
  ]
  const r = await mo2.applyMod('Test Mod', files, { a1: dir }, 1, 'h')
  assert.deepStrictEqual(r, { folder: 'Test Mod' })
  const modDir = path.join(root, 'mods', 'Test Mod')
  assert.strictEqual(fs.readFileSync(path.join(modDir, 'small.txt'), 'utf8'), 'hello from the archive\r\n')
  assert.strictEqual(fs.readFileSync(path.join(modDir, 'inline.ini'), 'utf8'), '[General]\r\n')
  const bad = await mo2.applyMod('Bad Mod', [{ ...files[0], sha256: '0'.repeat(64) }], { a1: dir }, 2, 'h')
  assert.match(bad.error, /small\.txt: hash mismatch/)
  assert.ok(!fs.existsSync(path.join(root, 'mods', 'Bad Mod')))
  mo2.setRootProvider(null)
  fs.rmSync(root, { recursive: true, force: true })
})
