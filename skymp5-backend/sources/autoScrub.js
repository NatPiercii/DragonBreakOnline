'use strict'
// Auto report scrub engine (docs/auto-report-v1.md §2.11) for scrub-rules.json; S0, S1, S2 and S21 are code

const RULES = require('./scrub-rules.json').map(rule => ({
  ...rule,
  re: rule.pattern === null ? null : new RegExp(rule.pattern, rule.flags),
}))

const INVISIBLE = /[\x00-\x08\x0b-\x1f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g
const PRE_CUT = 1.25
const LINE_CAP = 500
const FOLDER_MIN = 6
const NAME_MIN = 3
const NAME_DENY = new Set(['user', 'admin', 'administrator', 'owner', 'pc', 'desktop', 'laptop', 'windows', 'skyrim',
                           'steam', 'games', 'data', 'default', 'public', 'guest'])
const TOKENS = { game: '<game>', docs: '<docs>', user: '<user>', pc: '<pc>', discord: '<discord>', player: '<player>' }

const S21_FORMS = [
  ['Unexpected token', 'Unexpected token in JSON'],
  ['Unexpected end of JSON input', 'Unexpected end of JSON input'],
  ['Unterminated string', 'Unterminated string in JSON'],
  ['Bad control character', 'Bad control character in JSON'],
  ['Expected', 'Expected token in JSON'],
]
// SkyrimPlatform's log line prefix (main.cpp:120), and the game UI records S0 drops
const LOG_STAMP = /^\[\d\d:\d\d:\d\d:\d{3}\] /
const UI_RECORD = /^\[\d\d:\d\d:\d\d:\d{3}\] (?:JS|LoadUrl) /
// The message part of a trail err entry that reports a SyntaxError
const TRAIL_SYNTAX_ERROR = /^((?:on|once|hook|http|uncaught|rejection|window|promise|boundary) SyntaxError: |logged [A-Za-z0-9_$]{1,64}: SyntaxError: )([\s\S]*)$/

const escapeRegExp = s => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
const list = value => (Array.isArray(value) ? value : value == null ? [] : [value]).filter(v => typeof v === 'string')

// Step 1: CRLF to LF, then control and bidi characters out
function clean(input) {
  return String(input == null ? '' : input).replace(/\r\n/g, '\n').replace(INVISIBLE, '')
}

// Cuts to n code units from the head or the tail without splitting a surrogate pair
function cut(text, n, keep) {
  if (text.length <= n) return text
  if (keep === 'tail') {
    let start = text.length - n
    if (/[\udc00-\udfff]/.test(text[start])) start++
    return text.slice(start)
  }
  let end = n
  if (end > 0 && /[\ud800-\udbff]/.test(text[end - 1])) end--
  return text.slice(0, end)
}

// Keeps whole lines from the tail: the partial first line left by the cut goes
function cutLines(text, n) {
  const kept = cut(text, n, 'tail')
  if (text[text.length - kept.length - 1] === '\n') return kept
  const nl = kept.indexOf('\n')
  return nl === -1 ? '' : kept.slice(nl + 1)
}

// One case-insensitive alternation, longest literal first, each literal in its own group so the replacer knows its token
function literalRule(items) {
  const seen = new Set()
  const unique = items.filter(item => !seen.has(item.key) && seen.add(item.key))
  if (!unique.length) return null
  unique.sort((a, b) => b.length - a.length)
  const re = new RegExp(unique.map(item => `(${item.pattern})`).join('|'), 'giu')
  return { re, replace: (...args) => unique[args.slice(1, unique.length + 1).findIndex(g => g !== undefined)].token }
}

// S1: folders as escaped literals, either slash style (doubled too, as in JSON text)
function folderRule(folders = {}) {
  const items = []
  for (const kind of ['game', 'docs']) {
    for (const raw of list(folders[kind])) {
      const folder = raw.trim().replace(/[\\/]+$/, '')
      if (folder.length < FOLDER_MIN) continue
      const parts = folder.split(/[\\/]+/).filter(Boolean).map(escapeRegExp)
      items.push({ key: parts.join('/').toLowerCase(), length: folder.length, token: TOKENS[kind], pattern: parts.join('[\\\\/]{1,2}') })
    }
  }
  return literalRule(items)
}

// S2: Windows user and computer names, the Discord username, character names
function nameRule(names = {}) {
  const items = []
  for (const kind of ['user', 'pc', 'discord', 'player']) {
    for (const raw of list(names[kind])) {
      const name = raw.trim()
      if (name.length < NAME_MIN || NAME_DENY.has(name.toLowerCase())) continue
      const pattern = name.length === NAME_MIN
        ? `(?<![\\p{L}\\p{N}_])${escapeRegExp(name)}(?![\\p{L}\\p{N}_])` : escapeRegExp(name)
      items.push({ key: name.toLowerCase(), length: name.length, token: TOKENS[kind], pattern })
    }
  }
  return literalRule(items)
}

// Compiles the per-report values once: { folders: {game, docs}, names: {user, pc, discord, player} }, each a string or list
function compileContext(context = {}) {
  return { S1: folderRule(context.folders), S2: nameRule(context.names) }
}
const NO_CONTEXT = compileContext()

// S0: text before the first stamped line goes, and each run of UI records with their continuation lines becomes a count
function dropUiLines(text) {
  const kept = []
  let started = false
  let dropping = false
  let dropped = 0
  for (const line of text.split('\n')) {
    if (LOG_STAMP.test(line)) {
      started = true
      dropping = UI_RECORD.test(line)
    }
    if (!started) continue
    if (dropping) { dropped++; continue }
    if (dropped) { kept.push(`[${dropped} UI line(s) left out]`); dropped = 0 }
    kept.push(line)
  }
  if (dropped) kept.push(`[${dropped} UI line(s) left out]`)
  return kept.join('\n')
}

function jsonParseForm(message) {
  if (!message.includes('JSON')) return message
  const form = S21_FORMS.find(([prefix]) => message.startsWith(prefix))
  return form ? form[1] : 'Invalid JSON'
}

const CODE_RULES = {
  S0: dropUiLines,
  S1: (text, _opts, ctx) => (ctx.S1 ? text.replace(ctx.S1.re, ctx.S1.replace) : text),
  S2: (text, _opts, ctx) => (ctx.S2 ? text.replace(ctx.S2.re, ctx.S2.replace) : text),
  S21: (text, { field, type }) => {
    if (field === 'message') return type === 'SyntaxError' ? jsonParseForm(text) : text
    const m = TRAIL_SYNTAX_ERROR.exec(text)
    return m ? m[1] + jsonParseForm(m[2]) : text
  },
}
for (const rule of RULES) {
  if (!rule.re && !CODE_RULES[rule.id]) throw new Error(`scrub-rules.json: no code for rule ${rule.id}`)
}

const applies = (rule, field, kind) => rule.fields.includes('*') || rule.fields.includes(field)
  || (kind !== undefined && rule.fields.includes(`${field}.${kind}`))

// field is message, componentStack, trail (with kind), gameLog or crashSection; gameLog keeps its tail in whole lines of at most 500
function scrub(input, { field, kind, type, cap = Infinity, keep = field === 'gameLog' ? 'tail' : 'head' } = {}, ctx = NO_CONTEXT) {
  let text = clean(input)
  let truncated = false
  const preCut = Math.floor(cap * PRE_CUT)
  if (text.length > preCut) {
    // The word split by the pre-cut goes too, so a secret cut in half cannot slip past its rule
    text = cut(text, preCut, keep).replace(keep === 'tail' ? /^\S{1,256}/ : /\S{1,256}$/, '')
    truncated = true
  }
  for (const rule of RULES) {
    if (!applies(rule, field, kind)) continue
    text = rule.re ? text.replace(rule.re, rule.replacement) : CODE_RULES[rule.id](text, { field, kind, type }, ctx)
  }
  if (field === 'gameLog') {
    const lines = text.split('\n')
    if (lines.some(line => line.length > LINE_CAP)) {
      text = lines.map(line => cut(line, LINE_CAP)).join('\n')
      truncated = true
    }
  }
  if (text.length > cap) {
    text = field === 'gameLog' ? cutLines(text, cap) : cut(text, cap, keep)
    truncated = true
  }
  return { text, truncated }
}

module.exports = { scrub, compileContext, clean, cut, dropUiLines, RULES }
