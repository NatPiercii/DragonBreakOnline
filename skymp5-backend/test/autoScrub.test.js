'use strict'
// Auto report scrub engine against the shared rule file and the golden cases every engine must pass

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { performance } = require('perf_hooks')

const { scrub, compileContext, dropUiLines, RULES } = require('../sources/autoScrub')
const scrubLog = require('../sources/scrubLog')
const RULE_FILE = require('../sources/scrub-rules.json')
const CASES = require('./fixtures/auto-report/scrub-cases.json')

const DEFAULT_CONTEXT = compileContext(CASES.context)
const run = (c, ctx = c.context ? compileContext(c.context) : DEFAULT_CONTEXT) =>
  scrub(c.input, { field: c.field, kind: c.kind, type: c.type, cap: c.cap }, ctx)

// Best of three, so one scheduler hiccup does not fail the run
function fastest(fn) {
  let best = Infinity
  for (let i = 0; i < 3; i++) {
    const start = performance.now()
    fn()
    best = Math.min(best, performance.now() - start)
  }
  return best
}

test('rule file: S0-S21 in order, every rule has the contract shape and compiles', () => {
  const ids = RULE_FILE.map(r => r.id)
  assert.deepEqual(ids, ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10', 'S11', 'S12', 'S13', 'S14',
                         'S15', 'S16', 'S17', 'S18', 'S19', 'S20a', 'S20b', 'S21'])
  for (const rule of RULE_FILE) {
    assert.deepEqual(Object.keys(rule), ['id', 'pattern', 'flags', 'replacement', 'fields'], rule.id)
    assert.ok(Array.isArray(rule.fields) && rule.fields.length, rule.id)
    if (rule.pattern === null) continue
    assert.ok(rule.flags.includes('g'), rule.id)
    assert.doesNotThrow(() => new RegExp(rule.pattern, rule.flags), rule.id)
  }
  assert.deepEqual(RULE_FILE.filter(r => r.pattern === null).map(r => r.id), ['S0', 'S1', 'S2', 'S21'])
  assert.deepEqual(RULE_FILE.find(r => r.id === 'S0').fields, ['gameLog'])
  assert.deepEqual(RULE_FILE.find(r => r.id === 'S21').fields, ['message', 'trail.err'])
})

for (const c of CASES.cases) {
  test(`golden case: ${c.id}`, () => {
    const out = run(c).text
    assert.equal(out, c.expect)
    for (const gone of c.absent || []) assert.ok(!out.toLowerCase().includes(gone.toLowerCase()), `"${gone}" left in ${out}`)
  })
}

test('the manual report scrubber uses S3-S10 of the rule file and its own IP rules, no other auto rule', () => {
  // Its IP rules keep loopback and mark LAN addresses, where S16 would give <ip> for both
  const text = 'C:\\Users\\Jake\\x Bearer abcdefghijklmnop a.b@example.org 192.168.1.20 127.0.0.1'
  assert.equal(scrubLog.scrub(text).text, 'C:\\Users\\<user>\\x Bearer <redacted> a.b@example.org <lan-ip> 127.0.0.1')
})

test('cuts: pre-cut bounds the rules, head or tail is kept, truncation is reported', () => {
  const long = 'word '.repeat(1000) + '192.168.1.20'
  const head = scrub(long, { field: 'message', cap: 1000 })
  assert.equal(head.text, 'word '.repeat(200))
  assert.equal(head.truncated, true)
  const tail = scrub('[10:00:00:000] word\n'.repeat(100) + '[10:00:01:000] 192.168.1.20', { field: 'gameLog', cap: 100 })
  assert.deepEqual(tail, { text: '[10:00:00:000] word\n'.repeat(4) + '[10:00:01:000] <ip>', truncated: true })
  assert.equal(scrub('short', { field: 'message', cap: 1000 }).truncated, false)
  // A secret split by the pre-cut is dropped rather than left half redacted
  assert.deepEqual(scrub('a'.repeat(8) + ' ' + '0123456789abcdef'.repeat(4), { field: 'message', cap: 30 }),
    { text: 'aaaaaaaa ', truncated: true })
  assert.deepEqual(scrub('0123456789abcdef'.repeat(4) + ' tail', { field: 'message', cap: 30, keep: 'tail' }),
    { text: ' tail', truncated: true })
  // A value that only fits after scrubbing is not truncated: lengths are measured after the rules
  assert.deepEqual(scrub(`${'b'.repeat(10)} 0123456789abcdef0123456789abcdef`, { field: 'message', cap: 40 }),
    { text: `${'b'.repeat(10)} 01234567<redacted>`, truncated: false })
})

test('gameLog: lines are cut to 500 after the rules, and the tail cut keeps whole lines', () => {
  const long = `[10:00:00:000] ${'e'.repeat(600)}`
  assert.deepEqual(scrub(`${long}\n[10:00:00:001] ok`, { field: 'gameLog' }),
    { text: `${long.slice(0, 500)}\n[10:00:00:001] ok`, truncated: true })
  // A long run the rules shorten below 500 is not cut
  assert.deepEqual(scrub(`[10:00:00:000] ${'a.b@example.org '.repeat(40)}`, { field: 'gameLog' }),
    { text: `[10:00:00:000] ${'<email> '.repeat(40)}`, truncated: false })
  assert.equal(scrub(`[10:00:00:000] ${'e'.repeat(484)}\ud83d\ude00`, { field: 'gameLog' }).text.length, 499)
  // A cut that lands on a line boundary drops nothing more
  assert.deepEqual(scrub('[10:00:00:000] one\n[10:00:00:001] two', { field: 'gameLog', cap: 18 }),
    { text: '[10:00:00:001] two', truncated: true })
  assert.deepEqual(scrub('[10:00:00:000] one\n[10:00:00:001] two', { field: 'gameLog', cap: 17 }), { text: '', truncated: true })
})

test('non-string input is scrubbed as text and never throws', () => {
  assert.equal(scrub(null, { field: 'message' }).text, '')
  assert.equal(scrub(undefined, { field: 'message' }).text, '')
  assert.equal(scrub(12, { field: 'message' }).text, '12')
})

test('context values that are not strings are ignored', () => {
  const ctx = compileContext({ names: { user: [null, 5, { a: 1 }, 'jake'] }, folders: { game: 7 } })
  assert.equal(scrub('jake 5', { field: 'message' }, ctx).text, '<user> 5')
})

test(`timing: every rule under ${CASES.timing.ruleMs} ms on ${CASES.timing.chars} characters of adversarial input`, () => {
  const ctx = compileContext({
    ...CASES.context,
    names: { ...CASES.context.names, user: ['aaa', 'a'.repeat(40), 'class', '1.1.1'], player: ['a a', '""a'] },
  })
  const literal = [['S1', ctx.S1], ['S2', ctx.S2]]
  for (const unit of CASES.timing.units) {
    const text = unit.repeat(Math.ceil(CASES.timing.chars / unit.length)).slice(0, CASES.timing.chars)
    for (const rule of RULES.filter(r => r.re)) {
      const ms = fastest(() => text.replace(rule.re, rule.replacement))
      assert.ok(ms < CASES.timing.ruleMs, `${rule.id} took ${ms.toFixed(1)} ms on runs of ${JSON.stringify(unit)}`)
    }
    for (const [id, compiled] of literal) {
      const ms = fastest(() => text.replace(compiled.re, compiled.replace))
      assert.ok(ms < CASES.timing.ruleMs, `${id} took ${ms.toFixed(1)} ms on runs of ${JSON.stringify(unit)}`)
    }
    const s0 = fastest(() => dropUiLines(text))
    assert.ok(s0 < CASES.timing.ruleMs, `S0 took ${s0.toFixed(1)} ms on runs of ${JSON.stringify(unit)}`)
    const s21 = fastest(() => scrub(text, { field: 'message', type: 'SyntaxError' }))
    assert.ok(s21 < CASES.timing.ruleMs * 4, `the whole pipeline took ${s21.toFixed(1)} ms on runs of ${JSON.stringify(unit)}`)
  }
})
