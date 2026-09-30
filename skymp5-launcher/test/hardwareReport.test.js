'use strict'
// A problem report carries the machine it happened on, so a crash class can be read against hardware. Through
// 2.1.34 the report sent no RAM, CPU or GPU at all, so "propose minimum specs" had nothing behind it
// (measured 2026-09-30: 21 crashes, no hardware on any of them).
//
// Only the fields that need no extra process are tested here. The GPU and the free space come from a PowerShell
// call in main.js, which needs Windows and Electron - those checks are listed in CRASH_PROMPT_README.md.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { collect, cpuSummary } = require('../src/report')

function emptyInstall() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbo-hw-'))
  fs.writeFileSync(path.join(dir, 'install.log'), 'line one\n')
  return dir
}

test('cpuSummary names the model and the core count', () => {
  const s = cpuSummary()
  assert.match(s, / x \d+ cores$/, s)
  assert.ok(s.length > 10, s)
})

test('cpuSummary carries no path, so there is nothing to redact', () => {
  assert.ok(!/[A-Za-z]:\\|\/home\/|\/Users\//.test(cpuSummary()))
})

test('the payload carries RAM and CPU', () => {
  const dir = emptyInstall()
  const p = collect({ userDataDir: dir, installDir: dir, documentsDir: null, myGamesVariants: [], context: {} })
  assert.equal(typeof p.ramGb, 'number')
  assert.ok(p.ramGb > 0, `ramGb ${p.ramGb}`)
  assert.equal(typeof p.ramFreeGb, 'number')
  assert.ok(p.ramFreeGb >= 0 && p.ramFreeGb <= p.ramGb, `free ${p.ramFreeGb} of ${p.ramGb}`)
  assert.equal(typeof p.cpu, 'string')
  assert.ok(p.cpu.length > 0)
})

test('RAM is whole gigabytes, not bytes', () => {
  const dir = emptyInstall()
  const p = collect({ userDataDir: dir, installDir: dir, documentsDir: null, myGamesVariants: [], context: {} })
  assert.ok(Number.isInteger(p.ramGb), p.ramGb)
  assert.ok(p.ramGb < 4096, `${p.ramGb} looks like MB or bytes, not GB`)
})

test('context still overrides, so main.js can fill freeSpaceGb and gpu', () => {
  const dir = emptyInstall()
  const p = collect({ userDataDir: dir, installDir: dir, documentsDir: null, myGamesVariants: [],
    context: { freeSpaceGb: 123, gpu: 'Test GPU 8 GB+', cpu: 'overridden' } })
  assert.equal(p.freeSpaceGb, 123)
  assert.equal(p.gpu, 'Test GPU 8 GB+')
  assert.equal(p.cpu, 'overridden')
})

// The backend only repeats an allowlist of context fields into Discord (sources/problemReport.js CONTEXT_FIELDS),
// so a field the launcher invents is dropped in silence. This pins the names we are asking for, so a rename here
// cannot quietly stop the hardware arriving.
test('the hardware field names are the ones the backend has to allow', () => {
  const dir = emptyInstall()
  const p = collect({ userDataDir: dir, installDir: dir, documentsDir: null, myGamesVariants: [], context: {} })
  for (const field of ['ramGb', 'ramFreeGb', 'cpu']) {
    assert.ok(Object.prototype.hasOwnProperty.call(p, field), `${field} missing from the payload`)
  }
})
