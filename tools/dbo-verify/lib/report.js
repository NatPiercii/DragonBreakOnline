'use strict'
// Shared pass/fail reporting. Every check reports one of four states, and INVALID is deliberately
// distinct from FAIL: it means the run could not produce a trustworthy answer, which is the thing
// that went wrong on 2026-10-07 when a sandboxed launcher looked like a launcher bug.
const STATES = { PASS: 'PASS', FAIL: 'FAIL', INVALID: 'INVALID', SKIP: 'SKIP' }

class Report {
  constructor(title) {
    this.title = title
    this.rows = []
  }

  add(state, name, detail, evidence) {
    this.rows.push({ state, name, detail, evidence })
    return this
  }

  pass(name, detail, evidence) { return this.add(STATES.PASS, name, detail, evidence) }
  fail(name, detail, evidence) { return this.add(STATES.FAIL, name, detail, evidence) }
  invalid(name, detail, evidence) { return this.add(STATES.INVALID, name, detail, evidence) }
  skip(name, detail, evidence) { return this.add(STATES.SKIP, name, detail, evidence) }

  get counts() {
    const c = { PASS: 0, FAIL: 0, INVALID: 0, SKIP: 0 }
    for (const r of this.rows) c[r.state]++
    return c
  }

  // Exit 0 only when nothing failed AND nothing was invalid. An invalid run is not a pass.
  get exitCode() {
    const c = this.counts
    if (c.INVALID) return 2
    if (c.FAIL) return 1
    return 0
  }

  print() {
    const mark = { PASS: '  ok  ', FAIL: ' FAIL ', INVALID: 'INVALID', SKIP: ' skip ' }
    console.log(`\n=== ${this.title}`)
    for (const r of this.rows) {
      console.log(`[${mark[r.state]}] ${r.name}${r.detail ? ' - ' + r.detail : ''}`)
      if (r.evidence) {
        for (const line of String(r.evidence).split('\n')) console.log(`            ${line}`)
      }
    }
    const c = this.counts
    console.log(`--- ${c.PASS} passed, ${c.FAIL} failed, ${c.INVALID} invalid, ${c.SKIP} skipped`)
    if (c.INVALID) console.log('    INVALID means the result cannot be trusted - fix the environment and re-run.')
    return this
  }

  json() { return JSON.stringify({ title: this.title, rows: this.rows, counts: this.counts }, null, 2) }
}

module.exports = { Report, STATES }
