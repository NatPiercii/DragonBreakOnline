'use strict'
// crashWatch: how the launcher tells a crash from a normal close. The process commands, the clock and the waits are
// fakes, so this runs anywhere, Windows or not.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { watchGame, parsePid, parseExitCode, classify, crashLogSince } = require('../src/crashWatch')

test('the pid comes from tasklist\'s CSV row, and no row means no game', () => {
  assert.strictEqual(parsePid('"SkyrimSE.exe","14520","Console","1","2,301,112 K"\r\n'), 14520)
  assert.strictEqual(parsePid('INFO: No tasks are running which match the specified criteria.\r\n'), 0)
  assert.strictEqual(parsePid(''), 0)
})

test('PowerShell\'s signed exit code is read unsigned', () => {
  assert.strictEqual(parseExitCode('-1073741819\r\n'), 0xC0000005)
  assert.strictEqual(parseExitCode('0\r\n'), 0)
  assert.strictEqual(parseExitCode('1'), 1)
  assert.strictEqual(parseExitCode('Get-Process : Cannot find a process'), null)
  assert.strictEqual(parseExitCode(''), null)
})

test('a crash log or an exception code is a crash; 0 is a normal close; anything else ended some other way', () => {
  assert.strictEqual(classify(0xC0000005, false), 'crash')
  assert.strictEqual(classify(0, true), 'crash')
  assert.strictEqual(classify(0, false), 'closed')
  assert.strictEqual(classify(1, false), 'ended')
  assert.strictEqual(classify(null, true), 'crash')
})

// A fake machine: tasklist finds the game after `findAfter` polls; PowerShell returns `exitOut`
function fakeRun({ findAfter = 0, exitOut = '0', exitErr = null, onExit = () => {} }) {
  let polls = 0
  return async (file) => {
    if (file === 'tasklist') return ++polls > findAfter ? '"SkyrimSE.exe","4242","Console","1","1 K"' : 'INFO: No tasks'
    if (exitErr) throw new Error(exitErr)
    onExit()
    return exitOut
  }
}
function fakeClock() { let t = 1_000_000; return { now: () => t, wait: async (ms) => { t += ms } } }
const dirWith = () => fs.mkdtempSync(path.join(os.tmpdir(), 'crashwatch-'))

test('a normal close is reported as closed, with the exit code and times', async () => {
  const sent = []; const clock = fakeClock(); const dir = dirWith()
  const note = await watchGame({ run: fakeRun({ findAfter: 2, exitOut: '0' }), send: async n => sent.push(n), crashDirs: [dir], launchedAt: Date.now(), ...clock })
  assert.strictEqual(note.outcome, 'closed')
  assert.strictEqual(note.exitCode, 0)
  assert.strictEqual(note.crashLog, false)
  assert.ok(note.startedAt <= note.endedAt)
  assert.deepStrictEqual(sent, [note])
  assert.deepStrictEqual(Object.keys(note).sort(), ['crashLog', 'endedAt', 'exitCode', 'outcome', 'startedAt'], 'nothing else leaves the machine')
})

test('an access violation is a crash', async () => {
  const sent = []; const clock = fakeClock(); const dir = dirWith()
  const note = await watchGame({ run: fakeRun({ exitOut: '-1073741819' }), send: async n => sent.push(n), crashDirs: [dir], launchedAt: Date.now(), ...clock })
  assert.strictEqual(note.outcome, 'crash')
  assert.strictEqual(sent.length, 1)
})

test('a Crash Logger log written during the session makes it a crash even with exit code 0', async () => {
  const sent = []; const clock = fakeClock(); const dir = dirWith()
  const launchedAt = Date.now() - 1000
  const run = fakeRun({ exitOut: '0', onExit: () => fs.writeFileSync(path.join(dir, 'crash-2026-09-28-03-10-00.log'), 'Unhandled exception') })
  const note = await watchGame({ run, send: async n => sent.push(n), crashDirs: [dir], launchedAt, ...clock })
  assert.strictEqual(note.outcome, 'crash')
  assert.strictEqual(note.crashLog, true)
})

test('an old crash log from before the launch does not count', async () => {
  const dir = dirWith()
  const old = path.join(dir, 'crash-2026-09-20-10-00-00.log')
  fs.writeFileSync(old, 'old')
  const past = (Date.now() - 3600e3) / 1000
  fs.utimesSync(old, past, past)
  assert.strictEqual(crashLogSince([dir], Date.now() - 60e3), '')
  const sent = []; const clock = fakeClock()
  const note = await watchGame({ run: fakeRun({ exitOut: '1' }), send: async n => sent.push(n), crashDirs: [dir], launchedAt: Date.now(), ...clock })
  assert.strictEqual(note.outcome, 'ended')
})

test('if the game never starts, or the exit code cannot be read and there is no crash log, nothing is sent', async () => {
  const sent = []; const dir = dirWith()
  assert.strictEqual(await watchGame({ run: fakeRun({ findAfter: 1e9 }), send: async n => sent.push(n), crashDirs: [dir], ...fakeClock() }), null)
  assert.strictEqual(await watchGame({ run: fakeRun({ exitErr: 'powershell missing' }), send: async n => sent.push(n), crashDirs: [dir], ...fakeClock() }), null)
  assert.strictEqual(sent.length, 0)
})

test('a failed send is logged, never thrown', async () => {
  const logs = []; const dir = dirWith()
  const note = await watchGame({ run: fakeRun({ exitOut: '0' }), send: async () => { throw Object.assign(new Error('offline'), { statusCode: 503 }) }, crashDirs: [dir], log: l => logs.push(l), ...fakeClock() })
  assert.strictEqual(note.outcome, 'closed')
  assert.ok(logs.some(l => /could not send: 503 offline/.test(l)), logs.join('\n'))
})
