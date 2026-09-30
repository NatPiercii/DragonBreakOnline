'use strict'
// Strict Markdown reader for the Terms of Service and the Privacy Policy: returns data (blocks of inline runs), never HTML
// Links keep only http(s), mailto, site-relative and #anchor targets; raw HTML stays text; one line break stays a break
// Same file as skymp5-launcher/src/legalMarkdown.js and website/tools/legal-markdown.js: keep the two identical
// Blocks: heading {level, inline}, paragraph {inline}, list {ordered, start, items}, quote {blocks}, hr, code {text}, table {align, head, rows}
// Inlines: text {v}, code {v}, br, strong {c}, em {c}, link {href, c}

const MAX_INPUT = 512 * 1024
const MAX_DEPTH = 8

const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const BULLET = /^( {0,3})([*+-])[ \t]+(\S.*)$/
const ORDERED = /^( {0,3})(\d{1,9})([.)])[ \t]+(\S.*)$/
const FENCE = /^ {0,3}(`{3,}|~{3,})/
const QUOTE = /^ {0,3}> ?(.*)$/
const TABLE_SEP = /^ {0,3}\|?(?:[ \t]*:?-+:?[ \t]*\|)*[ \t]*:?-+:?[ \t]*\|?[ \t]*$/
const PUNCT = /[!-/:-@[-`{-~]/

const leadingSpaces = line => line.length - line.trimStart().length

function parseMarkdown(src) {
  const text = String(src == null ? '' : src).replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ')
  if (text.length > MAX_INPUT) throw new Error('the document is too large')
  return parseBlocks(text.split('\n'), 0)
}

function splitRow(line) {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  const cells = []
  let cur = ''
  for (let k = 0; k < s.length; k++) {
    if (s[k] === '\\' && s[k + 1] === '|') { cur += '|'; k++; continue }
    if (s[k] === '|') { cells.push(cur.trim()); cur = ''; continue }
    cur += s[k]
  }
  cells.push(cur.trim())
  return cells
}

function tableAt(lines, i) {
  if (i + 1 >= lines.length || !lines[i].includes('|') || !TABLE_SEP.test(lines[i + 1]) || !lines[i + 1].includes('|')) return null
  const head = splitRow(lines[i])
  const seps = splitRow(lines[i + 1])
  if (head.length !== seps.length) return null
  return { head, seps }
}

// Whether line i starts a block that ends a paragraph running above it; an ordered list does so only from 1
function startsBlock(lines, i) {
  const l = lines[i]
  const ordered = ORDERED.exec(l)
  return HEADING.test(l) || HR.test(l) || FENCE.test(l) || QUOTE.test(l) || BULLET.test(l) ||
    (ordered && ordered[2] === '1') || !!tableAt(lines, i)
}

function parseBlocks(lines, depth) {
  if (depth > MAX_DEPTH) return [{ type: 'paragraph', inline: [{ t: 'text', v: lines.join(' ').trim() }] }]
  const blocks = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }
    let m
    if ((m = FENCE.exec(line))) {
      const fence = m[1]
      const close = new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}[ \\t]*$`)
      const body = []
      i++
      while (i < lines.length && !close.test(lines[i])) body.push(lines[i++])
      i++
      blocks.push({ type: 'code', text: body.join('\n') })
      continue
    }
    if ((m = HEADING.exec(line))) {
      blocks.push({ type: 'heading', level: m[1].length, inline: parseInline((m[2] || '').trim(), 0) })
      i++
      continue
    }
    if (HR.test(line)) { blocks.push({ type: 'hr' }); i++; continue }
    if (QUOTE.test(line)) {
      const body = []
      while (i < lines.length && lines[i].trim() && (m = QUOTE.exec(lines[i]))) { body.push(m[1]); i++ }
      blocks.push({ type: 'quote', blocks: parseBlocks(body, depth + 1) })
      continue
    }
    if (BULLET.test(line) || ORDERED.test(line)) { i = parseList(lines, i, depth, blocks); continue }
    const table = tableAt(lines, i)
    if (table) { i = parseTable(lines, i, table, blocks); continue }
    const para = [line.trim()]
    i++
    while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) para.push(lines[i++].trim())
    blocks.push({ type: 'paragraph', inline: joinLines(para) })
  }
  return blocks
}

function joinLines(para) {
  const out = []
  para.forEach((l, k) => {
    if (k) out.push({ t: 'br' })
    out.push(...parseInline(l, 0))
  })
  return out
}

function parseList(lines, i, depth, blocks) {
  const ordered = !BULLET.test(lines[i])
  const RE = ordered ? ORDERED : BULLET
  const start = ordered ? parseInt(RE.exec(lines[i])[2], 10) : null
  const items = []
  while (i < lines.length) {
    const m = RE.exec(lines[i])
    if (!m || HR.test(lines[i])) break
    const indent = m[1].length
    const content = ordered ? m[4] : m[3]
    // Lines indented past the marker belong to the item (up to the content column, and at least 2 spaces in)
    const need = Math.min(lines[i].length - content.length, indent + 2)
    const body = [content]
    i++
    while (i < lines.length) {
      const l = lines[i]
      if (!l.trim()) {
        let j = i
        while (j < lines.length && !lines[j].trim()) j++
        if (j < lines.length && leadingSpaces(lines[j]) >= need) { for (; i < j; i++) body.push(''); continue }
        break
      }
      if (leadingSpaces(l) >= need) { body.push(l.slice(need)); i++; continue }
      if (!startsBlock(lines, i) && !ORDERED.test(l)) { body.push(l.trim()); i++; continue }
      break
    }
    items.push(parseBlocks(body, depth + 1))
    // Blank lines between two items of the same list keep the list going
    let j = i
    while (j < lines.length && !lines[j].trim()) j++
    if (j > i && j < lines.length && RE.test(lines[j]) && !HR.test(lines[j]) && leadingSpaces(lines[j]) <= indent + 1) i = j
  }
  blocks.push({ type: 'list', ordered, start, items })
  return i
}

function parseTable(lines, i, { head, seps }, blocks) {
  const align = seps.map(s => (s.startsWith(':') && s.endsWith(':') ? 'center' : s.endsWith(':') ? 'right' : s.startsWith(':') ? 'left' : null))
  const width = head.length
  const fit = cells => Array.from({ length: width }, (_, k) => parseInline(cells[k] || '', 0))
  const rows = []
  i += 2
  while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(fit(splitRow(lines[i++])))
  blocks.push({ type: 'table', align, head: fit(head), rows })
  return i
}

// Link targets a document may use; anything else (javascript:, data:, file:, protocol-relative) is dropped
function safeHref(raw) {
  const href = String(raw || '').trim().replace(/\\([!-/:-@[-`{-~])/g, '$1')
  if (!href || href.length > 2048 || /[\s<>"'`\\\u0000-\u001f\u007f]/.test(href)) return null
  if (/^https?:\/\/[^/?#@]+(?:[/?#]|$)/i.test(href)) return href
  if (/^mailto:[^@/?#:]+@[^@/?#:]+$/i.test(href)) return href
  if (/^\/(?![/\\])/.test(href) || /^#[\w-]+$/.test(href)) return href
  return null
}

function readLink(s, i) {
  let depth = 0
  let k = i
  for (; k < s.length; k++) {
    if (s[k] === '\\') { k++; continue }
    if (s[k] === '[') depth++
    else if (s[k] === ']' && --depth === 0) break
  }
  if (k >= s.length || s[k + 1] !== '(') return null
  const m = /^\([ \t]*(<[^<>\n]*>|[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)(?:[ \t]+("[^"]*"|'[^']*'))?[ \t]*\)/.exec(s.slice(k + 1))
  if (!m) return null
  const href = m[1].startsWith('<') ? m[1].slice(1, -1) : m[1]
  return { label: s.slice(i + 1, k), href, end: k + 1 + m[0].length }
}

function readEmphasis(s, i) {
  const c = s[i]
  const n = s[i + 1] === c ? 2 : 1
  const open = i + n
  const after = s[open]
  if (!after || /\s/.test(after) || after === c) return null
  if (c === '_' && i > 0 && /[A-Za-z0-9]/.test(s[i - 1])) return null
  const marker = c.repeat(n)
  let k = open
  while ((k = s.indexOf(marker, k + 1)) !== -1) {
    // Looking for a single * or _: a doubled one inside belongs to a nested **bold**, so step over the whole run
    if (n === 1 && s[k + 1] === c) { while (s[k + 1] === c) k++; continue }
    if (/\s/.test(s[k - 1]) || s[k - 1] === '\\') continue
    if (c === '_' && /[A-Za-z0-9]/.test(s[k + n] || '')) continue
    return { strong: n === 2, inner: s.slice(open, k), end: k + n }
  }
  return null
}

function parseInline(s, depth) {
  const out = []
  let text = ''
  const flush = () => { if (text) { out.push({ t: 'text', v: text }); text = '' } }
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (c === '\\' && i + 1 < s.length && PUNCT.test(s[i + 1])) { text += s[i + 1]; i += 2; continue }
    if (c === '`') {
      let n = 0
      while (s[i + n] === '`') n++
      let end = -1
      for (let k = i + n; (k = s.indexOf('`'.repeat(n), k)) !== -1; k += n) {
        if (s[k - 1] !== '`' && s[k + n] !== '`') { end = k; break }
        while (s[k] === '`') k++
        k -= n
      }
      if (end >= 0) {
        flush()
        let v = s.slice(i + n, end)
        if (v.length > 2 && v.startsWith(' ') && v.endsWith(' ') && v.trim()) v = v.slice(1, -1)
        out.push({ t: 'code', v })
        i = end + n
        continue
      }
      text += '`'.repeat(n)
      i += n
      continue
    }
    if (c === '[' && depth < MAX_DEPTH) {
      const link = readLink(s, i)
      if (link) {
        flush()
        const href = safeHref(link.href)
        const children = parseInline(link.label, depth + 1)
        if (href) out.push({ t: 'link', href, c: children })
        else out.push(...children)
        i = link.end
        continue
      }
    }
    if (c === '<') {
      const m = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(s.slice(i))
      const href = m && safeHref(m[1])
      if (href) { flush(); out.push({ t: 'link', href, c: [{ t: 'text', v: m[1] }] }); i += m[0].length; continue }
    }
    if ((c === '*' || c === '_') && depth < MAX_DEPTH) {
      const em = readEmphasis(s, i)
      if (em) { flush(); out.push({ t: em.strong ? 'strong' : 'em', c: parseInline(em.inner, depth + 1) }); i = em.end; continue }
    }
    text += c
    i++
  }
  flush()
  return out
}

// The words of a run of inlines, for titles, anchors and search
function plainText(runs) {
  return (runs || []).map(r => (r.t === 'br' ? ' ' : r.c ? plainText(r.c) : r.v || '')).join('')
}

module.exports = { parseMarkdown, parseInline, plainText, safeHref }
