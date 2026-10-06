'use strict'
// installProgress: downloads running at once all count towards the bar, and a finished one stops counting as partial.
const test = require('node:test')
const assert = require('node:assert')
const { createTracker } = require('../src/renderer/installProgress')

test('two downloads half done count as half of the download bytes, and finishing one counts it whole', () => {
  const t = createTracker()
  t.begin('mo2')
  t.plan({ archives: [{ id: 'a', size: 100 }, { id: 'b', size: 100 }], installBytes: 0 })
  t.step('download', { index: 0, total: 2 })
  const at = () => t.snapshot().overall
  const start = at()
  t.file('a', 50, 100, 'a')
  const oneHalf = at()
  t.file('b', 50, 100, 'b')
  const bothHalf = at()
  assert.ok(oneHalf > start && bothHalf > oneHalf, `${start} ${oneHalf} ${bothHalf}`)
  t.acquired('a')
  const aDone = at()
  t.file('b', 50, 100, 'b')
  assert.ok(aDone > bothHalf && Math.abs(at() - aDone) < 1e-9, 'a done counts whole, once')
})
