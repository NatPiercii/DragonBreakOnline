'use strict'
// Report a Problem carries the client's dbo-diag log (writeLogs: page/input and remote Vampire Lord diagnostics),
// from the folder the game ran from or MO2's overwrite, capped from the end and redacted like the other logs
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { collect } = require('../src/report')

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diaglog-test-'))
  const userData = path.join(root, 'userData')
  fs.mkdirSync(userData)
  fs.writeFileSync(path.join(userData, 'install.log'), 'launcher line\n')
  const steam = path.join(root, 'Skyrim Special Edition')
  const copy = path.join(root, 'DragonBreak', 'game')
  const mo2 = path.join(root, 'MO2')
  for (const d of [steam, copy, mo2]) fs.mkdirSync(d, { recursive: true })
  return { root, userData, steam, copy, mo2 }
}

function writeDiag(file, text, secondsAgo) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
  const t = new Date(Date.now() - secondsAgo * 1000)
  fs.utimesSync(file, t, t)
}

const inData = (dir) => path.join(dir, 'Data', 'Platform', 'Logs', 'dbo-diag-logs.txt')
const inOverwrite = (mo2) => path.join(mo2, 'overwrite', 'Platform', 'Logs', 'dbo-diag-logs.txt')

const run = (s, extra = {}) => collect({
  userDataDir: s.userData, installDir: s.steam, documentsDir: path.join(s.root, 'Documents'),
  mo2Root: s.mo2, gameDirs: [s.copy], ...extra,
})

test('the diag log in the isolated game copy goes into clientLog, ahead of the install listing', () => {
  const s = setup()
  writeDiag(inData(s.copy), 'vl-anim 18:02:32.100Z ff000014 (local ff000812) #41 BeginCastLeft\n', 60)
  const out = run(s)
  assert.match(out.clientLog, /^== client diagnostics \(.*game.*dbo-diag-logs\.txt, written 1 min before this report\) ==\n/)
  assert.match(out.clientLog, /#41 BeginCastLeft\n\n== install directory ==/)
})

test('under MO2 the overwrite copy is found (overwrite stands for Data, so no Data folder in the path)', () => {
  const s = setup()
  writeDiag(inData(s.copy), 'old run beside the game\n', 3600)
  writeDiag(inOverwrite(s.mo2), 'vl-anim this session under MO2\n', 5)
  const out = run(s)
  assert.match(out.clientLog, /overwrite.Platform.Logs.dbo-diag-logs\.txt, written 0 min before this report, newest of 2\)/)
  assert.match(out.clientLog, /this session under MO2/)
  assert.doesNotMatch(out.clientLog, /old run beside the game/)
})

test('the original Steam folder is still tried when there is no copy', () => {
  const s = setup()
  writeDiag(inData(s.steam), 'page heartbeat STOPPED\n', 10)
  const out = run(s, { gameDirs: [] })
  assert.match(out.clientLog, /page heartbeat STOPPED/)
})

test('a long log keeps its end, capped, cut on a line boundary', () => {
  const s = setup()
  const lines = []
  for (let i = 0; i < 4000; i++) lines.push(`vl-anim 18:02:${String(i % 60).padStart(2, '0')}.000Z ff000014 (local ff000812) #${i} event${i}`)
  writeDiag(inData(s.copy), lines.join('\n') + '\n', 1)
  const out = run(s)
  const diag = out.clientLog.split('\n\n== install directory ==')[0]
  assert.ok(Buffer.byteLength(diag) < 49 * 1024, `diag part is ${Buffer.byteLength(diag)} bytes`)
  assert.match(diag, /\n\[earlier lines cut\]\nvl-anim /)
  assert.match(diag, /#3999 event3999$/)
  assert.doesNotMatch(diag, /#0 event0\b/)
})

test('it is redacted like the other logs', () => {
  const s = setup()
  writeDiag(inData(s.copy), 'session=abcdefghijklmnopqrstuvwxyz0123\nBearer abcdefghijklmnopqrstuvwxyz\n', 1)
  const out = run(s)
  assert.doesNotMatch(out.clientLog, /abcdefghijklmnopqrstuvwxyz/)
  assert.match(out.clientLog, /<redacted>/)
})

test('no diag log: clientLog is only the install listing, as before', () => {
  const s = setup()
  const out = run(s)
  assert.match(out.clientLog, /^== install directory ==/)
})
