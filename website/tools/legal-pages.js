#!/usr/bin/env node
// Writes website/terms.html and privacy.html from the legal markdown in the guides' style; edit the markdown, never the pages
//   node website/tools/legal-pages.js [--terms terms.md] [--privacy privacy.md]   (default: skymp5-backend/data/legal/)
//   node website/tools/legal-pages.js --check ...   exit 1 unless the pages on disk are exactly what the markdown gives
'use strict'
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { parseMarkdown, plainText } = require('./legal-markdown')

const WEBSITE = path.join(__dirname, '..')
const DEFAULT_SOURCES = path.join(__dirname, '..', '..', 'skymp5-backend', 'data', 'legal')
// Site pages a legal page may link to; the guides' own checker covers the guides
const SITE_PAGES = new Set(['/', '/index.html', '/terms.html', '/privacy.html', '/guides/', '/guides/rules.html'])
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'])

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const esc = s => String(s).replace(/[&<>"']/g, ch => ESC[ch])

const slug = (text, used) => {
  const base = text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'section'
  let id = base
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`
  used.add(id)
  return id
}

function inlineHtml(runs) {
  return runs.map(r => {
    switch (r.t) {
      case 'text': return esc(r.v)
      case 'br': return '<br>'
      case 'code': return `<code>${esc(r.v)}</code>`
      case 'strong': return `<strong>${inlineHtml(r.c)}</strong>`
      case 'em': return `<em>${inlineHtml(r.c)}</em>`
      case 'link': return `<a href="${esc(r.href)}"${/^https?:/i.test(r.href) ? ' rel="noopener noreferrer"' : ''}>${inlineHtml(r.c)}</a>`
      default: return ''
    }
  }).join('')
}

function blocksHtml(blocks, used) {
  return blocks.map(b => {
    switch (b.type) {
      case 'heading': {
        // The page's own title is the hero's h1, so the document's headings start at h2
        const level = Math.min(6, Math.max(2, b.level))
        return `<h${level} id="${slug(plainText(b.inline), used)}">${inlineHtml(b.inline)}</h${level}>`
      }
      case 'paragraph': return `<p>${inlineHtml(b.inline)}</p>`
      case 'hr': return '<hr>'
      case 'code': return `<pre><code>${esc(b.text)}</code></pre>`
      case 'quote': return `<blockquote>${blocksHtml(b.blocks, used)}</blockquote>`
      case 'list': {
        const tag = b.ordered ? 'ol' : 'ul'
        const start = b.ordered && b.start !== 1 ? ` start="${b.start}"` : ''
        const items = b.items.map(item => (item.length === 1 && item[0].type === 'paragraph'
          ? `<li>${inlineHtml(item[0].inline)}</li>` : `<li>${blocksHtml(item, used)}</li>`))
        return `<${tag}${start}>\n${items.join('\n')}\n</${tag}>`
      }
      case 'table': {
        const cls = k => (b.align[k] ? ` class="al-${b.align[k][0]}"` : '')
        const head = b.head.map((c, k) => `<th scope="col"${cls(k)}>${inlineHtml(c)}</th>`).join('')
        const rows = b.rows.map(r => `<tr>${r.map((c, k) => `<td${cls(k)}>${inlineHtml(c)}</td>`).join('')}</tr>`).join('\n')
        return `<div class="g-table"><table>\n<thead><tr>${head}</tr></thead>\n<tbody>\n${rows}\n</tbody>\n</table></div>`
      }
      default: return ''
    }
  }).join('\n')
}

const STYLE = `.gd{--aqua:#8fd3d0;--aqua-dim:#5fb3b3;--gold:#e8d6a0;--line:rgba(143,211,208,.22);--line-soft:rgba(143,211,208,.13);--muted:rgba(215,227,227,.62);--surface:rgba(12,34,38,.94);--text:#d7e3e3;--text-2:#d7e3e3;color-scheme:dark}
.gd *{box-sizing:border-box}
.gd{background:transparent;color:var(--text-2);font-family:'Roboto Condensed','Futura Condensed',sans-serif;font-size:18px;line-height:1.6;margin:0;padding:0 0 64px}
.gd h2,.gd h3,.gd h4{font-family:'Cinzel','Trajan Pro',Georgia,serif;color:var(--text);text-wrap:balance;font-weight:600}
.gd p{margin:0}
.gd a{color:var(--aqua)}
.gd strong{color:var(--text);font-weight:600}
.gd :focus-visible{outline:2px solid var(--gold);outline-offset:2px}
.gd .g-hero{padding-block:28px 22px;display:grid;gap:10px;border-bottom:1px solid var(--line)}
.gd .g-hero p{font-size:20px}
.gd .g-legal{display:grid;gap:14px;max-width:72ch;padding-top:8px;overflow-wrap:anywhere}
.gd .g-legal h2{font-size:clamp(21px,3.2vw,26px);letter-spacing:.02em;margin:30px 0 0;padding-bottom:8px;border-bottom:1px solid var(--line-soft)}
.gd .g-legal h3{font-size:18px;letter-spacing:.04em;color:var(--gold);margin:12px 0 0;padding:0;border:0}
.gd .g-legal h4{font-size:16px;margin:8px 0 0}
.gd .g-legal ul,.gd .g-legal ol{margin:0;padding-left:1.3em;display:grid;gap:5px}
.gd .g-legal li::marker{color:var(--aqua-dim)}
.gd .g-legal code{font-family:Consolas,'Courier New',monospace;font-size:.92em;background:var(--surface);border:1px solid var(--line-soft);border-radius:3px;padding:0 5px}
.gd .g-legal blockquote{margin:0;padding:4px 0 4px 16px;border-left:3px solid var(--line);color:var(--muted)}
.gd .g-legal hr{border:0;border-top:1px solid var(--line);margin:12px 0}
.gd .g-table{overflow-x:auto;border:1px solid var(--line-soft);border-radius:6px}
.gd .g-table table{border-collapse:collapse;width:100%;font-size:16px;line-height:1.45}
.gd .g-table th,.gd .g-table td{padding:9px 14px;text-align:left;vertical-align:top;border-bottom:1px solid var(--line-soft)}
.gd .g-table tr:last-child td{border-bottom:0}
.gd .g-table th{color:var(--text);background:var(--surface);font-weight:600}
.gd .g-table .al-r{text-align:right}
.gd .g-table .al-c{text-align:center}
@media (max-width:520px){.gd{font-size:17px}.gd .g-table th,.gd .g-table td{padding:8px 10px}}`

// The pages and what each is built from; titles come from each document's own # heading
function buildPage(doc, other) {
  const used = new Set()
  const blocks = doc.blocks.slice()
  const titleAt = blocks.findIndex(b => b.type === 'heading' && b.level === 1)
  const fullTitle = titleAt >= 0 ? plainText(blocks[titleAt].inline).trim() : doc.fallbackTitle
  if (titleAt >= 0) blocks.splice(titleAt, 1)
  // The paragraph right under the title (the effective date) leads the page
  const lead = blocks[0] && blocks[0].type === 'paragraph' ? blocks.shift() : null
  const description = [fullTitle, lead ? plainText(lead.inline).trim() : ''].filter(Boolean).join('. ')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<!-- Generated by website/tools/legal-pages.js from ${esc(doc.name)} (sha256 ${doc.sha256}). Edit the markdown and run the tool, never this page. -->
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(doc.shortTitle(fullTitle))} - Dragon Break</title>
<meta name="description" content="${esc(description)}">
<link rel="icon" href="/dbo-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600&family=Roboto+Condensed:wght@300;400;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/dbo.css">
<link rel="stylesheet" href="/guides/guides.css">
<style>
${STYLE}
</style>
</head><body>
<img class="wm" src="/dbo-watermark.png" alt="">
<div class="wrap guide-wrap">
<nav class="crumbs"><a href="/">Dragon Break</a></nav>
<div class="hero"><div class="tag">DragonBreak Online &middot; Legal</div><h1>${esc(doc.shortTitle(fullTitle))}</h1></div>
<main class="gd">
${lead ? `<header class="g-hero">\n  <p>${inlineHtml(lead.inline)}</p>\n</header>\n` : ''}<article class="g-legal">
${blocksHtml(blocks, used)}
</article>
</main>
<nav class="panel others" aria-label="Also read"><h2>Also read</h2><ul><li><a href="${other.href}">${esc(other.label)}</a></li><li><a href="/guides/rules.html">Server Rules</a></li></ul></nav>
<footer>Dragon Break &middot; <a href="/">dragonbreakonline.com</a></footer>
</div>
</body></html>
`
}

function validate(html) {
  const errs = []
  const body = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
  const stack = []
  const tagRx = /<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(\/?)>/g
  let m
  while ((m = tagRx.exec(body))) {
    const name = m[1].toLowerCase()
    if (VOID.has(name) || m[2] === '/') continue
    if (m[0][1] !== '/') { stack.push(name); continue }
    if (stack[stack.length - 1] === name) { stack.pop(); continue }
    errs.push(`</${name}> closes <${stack[stack.length - 1] || 'nothing'}>`)
    const at = stack.lastIndexOf(name)
    if (at >= 0) stack.length = at
  }
  if (stack.length) errs.push(`left open: ${stack.join(' > ')}`)
  const ids = new Set([...body.matchAll(/\sid="([^"]+)"/g)].map(x => x[1]))
  for (const [, href] of body.matchAll(/\shref="([^"]*)"/g)) {
    if (/^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(href) || /^\/[\w./-]+\.(css|png|ico)$/.test(href)) continue
    if (/^(https?:\/\/[^/"]+|mailto:[^@"]+@[^@"]+)/i.test(href)) continue
    if (href.startsWith('#')) { if (!ids.has(href.slice(1))) errs.push(`#${href.slice(1)} has no element`); continue }
    if (!SITE_PAGES.has(href.replace(/#.*$/, ''))) errs.push(`link to ${href} is not a known page`)
  }
  if (/<(script|iframe|object|embed|form)\b/i.test(body) || /<[^>]*\son\w+\s*=/i.test(body) || /<[^>]*=\s*["']?\s*javascript:/i.test(body)) errs.push('active content in the page')
  return errs
}

function main(argv) {
  const arg = name => { const k = argv.indexOf(name); return k >= 0 ? argv[k + 1] : null }
  const check = argv.includes('--check')
  const sources = {
    terms: path.resolve(arg('--terms') || path.join(DEFAULT_SOURCES, 'terms.md')),
    privacy: path.resolve(arg('--privacy') || path.join(DEFAULT_SOURCES, 'privacy.md')),
  }
  const docs = {}
  for (const [key, file] of Object.entries(sources)) {
    const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n')
    docs[key] = {
      name: path.basename(file),
      sha256: crypto.createHash('sha256').update(text, 'utf8').digest('hex'),
      blocks: parseMarkdown(text),
      fallbackTitle: key === 'terms' ? 'Terms of Service' : 'Privacy Policy',
      // "DragonBreak Online Terms of Service" reads as "Terms of Service" under the DragonBreak Online tag
      shortTitle: t => t.replace(/^DragonBreak Online\s+/i, '') || t,
    }
  }
  const titleOf = d => { const h = d.blocks.find(b => b.type === 'heading' && b.level === 1); return d.shortTitle(h ? plainText(h.inline).trim() : d.fallbackTitle) }
  const pages = {
    'terms.html': buildPage(docs.terms, { href: '/privacy.html', label: titleOf(docs.privacy) }),
    'privacy.html': buildPage(docs.privacy, { href: '/terms.html', label: titleOf(docs.terms) }),
  }
  let bad = 0
  for (const [name, html] of Object.entries(pages)) {
    const out = path.join(WEBSITE, name)
    const errs = validate(html)
    if (check) {
      const onDisk = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null
      if (onDisk !== html) errs.push(onDisk == null ? 'missing: run the tool to write it' : 'differs from its markdown: run the tool again')
      errs.push(...(onDisk ? validate(onDisk) : []))
    } else if (!errs.length) {
      fs.writeFileSync(out, html)
    }
    console.log(`${errs.length ? 'FAIL' : 'ok  '}  ${name}${check ? '' : errs.length ? ' (not written)' : ' written'}`)
    for (const e of errs) console.log(`      ${e}`)
    if (errs.length) bad++
  }
  return bad ? 1 : 0
}

if (require.main === module) process.exit(main(process.argv.slice(2)))
module.exports = { buildPage, validate, inlineHtml, blocksHtml, esc }
