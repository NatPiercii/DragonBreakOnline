'use strict'
// crashWatch keeps the client's dbo-diag log at a crash (report.saveCrashDiag), because the next launch starts it
// afresh; a report sent after a relaunch carries the crashed session's copy as well (crash map 3 Oct: the NPC trail)
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { collect, saveCrashDiag } = require('../src/report')

const inData = (dir) => path.join(dir, 'Data', 'Platform', 'Logs', 'dbo-diag-logs.txt')
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crashdiag-test-'))
  const userData = path.join(root, 'userData'); fs.mkdirSync(userData)
  fs.writeFileSync(path.join(userData, 'install.log'), 'launcher line\n')
  const game = path.join(root, 'game'); fs.mkdirSync(game)
  return { userData, game }
}
const write = (file, text, at) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); const t = new Date(at); fs.utimesSync(file, t, t) }

test('a crash keeps a copy of the diag log, and a report after a relaunch carries it', () => {
  const { userData, game } = setup()
  const crashAt = Date.now() - 10 * 60000
  write(inData(game), 'npc 21:41:30.100 hostStart ff00154d base=8ad32\n', crashAt - 1000)
  const saved = saveCrashDiag({ userDataDir: userData, gameDirs: [game], endedAt: crashAt })
  assert.ok(saved && fs.existsSync(saved))
  write(inData(game), 'fresh session line\n', Date.now() - 1000)   // the player played again
  const files = collect({ userDataDir: userData, gameDirs: [game], installDir: '' })
  assert.match(files.clientLog, /fresh session line/)
  assert.match(files.clientLog, /client diagnostics of the crashed session/)
  assert.match(files.clientLog, /hostStart ff00154d/)
})

test('a report sent before any relaunch is not doubled', () => {
  const { userData, game } = setup()
  const crashAt = Date.now() - 60000
  write(inData(game), 'the crashed session\n', crashAt - 500)
  saveCrashDiag({ userDataDir: userData, gameDirs: [game], endedAt: crashAt })
  const files = collect({ userDataDir: userData, gameDirs: [game], installDir: '' })
  assert.doesNotMatch(files.clientLog, /of the crashed session/)
})

test('copies older than a day are not sent, and only the newest five are kept', () => {
  const { userData, game } = setup()
  write(inData(game), 'x\n', Date.now() - 3 * 86400000)
  for (let i = 0; i < 7; i++) saveCrashDiag({ userDataDir: userData, gameDirs: [game], endedAt: Date.now() - (2 * 86400000 + i * 1000) })
  assert.strictEqual(fs.readdirSync(path.join(userData, 'crash-diag')).length, 5)
  write(inData(game), 'today\n', Date.now())
  const files = collect({ userDataDir: userData, gameDirs: [game], installDir: '' })
  assert.doesNotMatch(files.clientLog, /of the crashed session/)
})

test('no diag log, nothing saved', () => {
  const { userData, game } = setup()
  assert.strictEqual(saveCrashDiag({ userDataDir: userData, gameDirs: [game] }), null)
})
