'use strict'
// legalMarkdown.js: what the legal texts use comes out as data, and nothing in a document can become markup or a bad link
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { parseMarkdown, parseInline, plainText, safeHref } = require('../src/legalMarkdown')

const text = (runs) => plainText(runs)

test('headings, paragraphs with kept line breaks, lists, bold, italic, code and mail links', () => {
  const b = parseMarkdown('# Title\n\n**Effective date: October 1, 2026**\n\n## 1. Acceptance\n\nLine one\nline two\n\n* **Discord** — login\n* *Skyrim* `/bug`\n\n**Contact:**\n[us@example.com](mailto:us@example.com)\n')
  assert.deepStrictEqual(b.map(x => x.type), ['heading', 'paragraph', 'heading', 'paragraph', 'list', 'paragraph'])
  assert.strictEqual(b[0].level, 1)
  assert.deepStrictEqual(b[1].inline, [{ t: 'strong', c: [{ t: 'text', v: 'Effective date: October 1, 2026' }] }])
  assert.deepStrictEqual(b[3].inline.map(r => r.t), ['text', 'br', 'text'])
  assert.deepStrictEqual(b[4].items[0][0].inline, [{ t: 'strong', c: [{ t: 'text', v: 'Discord' }] }, { t: 'text', v: ' — login' }])
  assert.deepStrictEqual(b[4].items[1][0].inline, [{ t: 'em', c: [{ t: 'text', v: 'Skyrim' }] }, { t: 'text', v: ' ' }, { t: 'code', v: '/bug' }])
  assert.deepStrictEqual(b[5].inline[2], { t: 'link', href: 'mailto:us@example.com', c: [{ t: 'text', v: 'us@example.com' }] })
})

test('a pipe table keeps its alignment, and nested and ordered lists work', () => {
  const [table] = parseMarkdown('| Information | Target retention |\n| ----------- | ---------------: |\n| Backups | 30 days |\n| Bans | as long as \\| needed |\n')
  assert.strictEqual(table.type, 'table')
  assert.deepStrictEqual(table.align, [null, 'right'])
  assert.deepStrictEqual(table.rows.map(r => r.map(text)), [['Backups', '30 days'], ['Bans', 'as long as | needed']])
  const [list] = parseMarkdown('3. three\n4. four\n   * inner\n')
  assert.strictEqual(list.ordered, true)
  assert.strictEqual(list.start, 3)
  assert.strictEqual(list.items[1][1].type, 'list')
})

test('raw HTML stays text and only safe link targets survive', () => {
  const [p] = parseMarkdown('<script>alert(1)</script> <img src=x onerror=alert(1)>')
  assert.deepStrictEqual(p.inline, [{ t: 'text', v: '<script>alert(1)</script> <img src=x onerror=alert(1)>' }])
  const runs = parseInline('[a](javascript:alert(1)) [b](data:text/html,x) [c](//evil.example) [d](https://ok.example/p?q=1) [e](/guides/rules.html) [f](file:///C:/x)', 0)
  assert.deepStrictEqual(runs.filter(r => r.t === 'link').map(r => r.href), ['https://ok.example/p?q=1', '/guides/rules.html'])
  assert.strictEqual(text(runs), 'a b c d e f')
  for (const bad of ['https://x.example/"onmouseover', 'mailto:a@b@c', 'vbscript:x', 'https://user@evil.example', ' ']) assert.strictEqual(safeHref(bad), null, bad)
})

test('snake_case, lone stars and escapes are not emphasis', () => {
  assert.deepStrictEqual(parseInline('auto_report_v1 and 5 * 3 and \\*not\\*', 0), [{ t: 'text', v: 'auto_report_v1 and 5 * 3 and *not*' }])
  assert.deepStrictEqual(parseInline('*a **b** c*', 0), [{ t: 'em', c: [{ t: 'text', v: 'a ' }, { t: 'strong', c: [{ t: 'text', v: 'b' }] }, { t: 'text', v: ' c' }] }])
})

test('CRLF and a BOM read the same as LF', () => {
  const md = fs.readFileSync(path.join(__dirname, '..', 'assets', 'legal', 'terms.md'), 'utf8')
  assert.deepStrictEqual(parseMarkdown(`\uFEFF${md.replace(/\n/g, '\r\n')}`), parseMarkdown(md))
})

test('the website generator reads the documents with this same file', (t) => {
  const other = path.join(__dirname, '..', '..', 'website', 'tools', 'legal-markdown.js')
  if (!fs.existsSync(other)) return t.skip('website/tools/legal-markdown.js is not on this branch')
  assert.strictEqual(fs.readFileSync(other, 'utf8'), fs.readFileSync(path.join(__dirname, '..', 'src', 'legalMarkdown.js'), 'utf8'))
})
