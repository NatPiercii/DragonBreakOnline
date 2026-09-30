'use strict'
// Auto report signatures (docs/auto-report-v1.md §6, design §4.2); a signature sent by a client is never read

const crypto = require('crypto')
const { cut, RULES } = require('./autoScrub')
const { probeOffset, PATTERNS } = require('./autoSchema')
const { cleanName } = require('./problemReport')

const MSG_MAX = 200
const TITLE_MAX = 100
const JS_FRAMES = 4
const CRASH_FRAMES = 3
const PREFIX = '(Auto Report)'

const SYSTEM_MODULE = /^(?:ntdll|kernelbase|kernel32|ucrtbase|vcruntime\w*|msvcp\w*)(?:\.dll)?$/i
const OUR_MODULES = ['skyrimplatform.dll', 'skyrimplatformimpl.dll', 'mpclientplugin.dll', 'libnode.dll', 'libcef.dll']
const GAME_MODULE = 'skyrimse.exe'
const DROPPED_SOURCE = /(?:^|\/)(?:errorSink\.ts$|webpack\/bootstrap)/
const TYPE = PATTERNS.type.source.slice(1, -1)
const TRAIL_ERR = new RegExp(`^(?:(on|once|hook|http|uncaught|rejection|window|promise|boundary) (${TYPE})(?:: ([\\s\\S]*))?`
  + `|logged ([A-Za-z0-9_$]{1,64})(?:: (${TYPE}): ([\\s\\S]*))?)$`)

// normMsg steps 1 to 8 in order (§6); step 9 is in normMsg
const PATH_CHARS = String.raw`[^\s'"()|]*`
const NORM_STEPS = [
  [/\(reading '[\s\S]*/g, '(reading <s>)'],
  [/(?<![\p{L}\p{N}_])'[^'\n]*'|"[^"\n]*"|`[^`\n]*`/gu, '<s>'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>'],
  [/0x[0-9a-f]+/gi, '<hex>'],
  [/\b(?=[a-f]*\d)[0-9a-f]{8}\b/gi, '<form>'],
  [/\b(?=[a-f]*\d)[0-9a-f]{6,}\b/gi, '<hex>'],
  [/\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s'"()]*/gi, '<url>'],
  [new RegExp(String.raw`\b[A-Za-z]:[\\/]${PATH_CHARS}|\\\\[\w.$-]+[\\/]${PATH_CHARS}|<(?:game|docs)>(?:[\\/]${PATH_CHARS})?`, 'g'), '<path>'],
  [/(?<![\w.<>\\/-])\.{0,2}\/[\w.$@+-]+(?:\/[\w.$@+-]+)+/g, '<path>'],
  [/(?<![\w.\\/-])(?:[\w.$@+-]+[\\/])+[\w$@+-]+\.[A-Za-z][A-Za-z0-9]{0,7}\b/g, '<path>'],
  [/\b\d+(?:\.\d+)*\b/g, '<n>'],
  [RULES.find(rule => rule.id === 'S14').re, '<player>'],
  [/<@!?(?:\d{1,21}|<hex>|<n>)>|<discord>/g, '<player>'],
]

function normMsg(message) {
  let text = String(message || '')
  for (const [re, token] of NORM_STEPS) text = text.replace(re, token)
  return cut(text.replace(/\s+/g, ' ').trim(), MSG_MAX)
}

// Numeric, so 0.3.9 < 0.3.40; missing parts count as 0 (the launcher's compareVersions)
function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number)
  const pb = String(b).split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0)
    if (diff !== 0) return Math.sign(diff)
  }
  return 0
}

const title = (...parts) => cleanName([PREFIX, ...parts.filter(Boolean)].join(' '), TITLE_MAX)
const inFn = fn => fn && `in ${fn}`
const hexCode = code => `0x${code.toString(16).toUpperCase().padStart(8, '0')}`

// Top frames after the drops, as { source, fn, bundle, resolved, raw }; a bundle frame that does not resolve has source null
function keyFrames(e, map, offset) {
  const bundleFile = e.source === 'client' ? null : 'build.js'
  const out = []
  for (const f of e.frames) {
    if (out.length === JS_FRAMES) break
    if ((f.fn && f.fn.startsWith('__dbo')) || (f.file && f.file.startsWith('node:internal'))) continue
    const fn = f.fn || '?'
    if (f.file !== bundleFile) {
      out.push({ source: f.file === '<injected>' ? 'injected' : f.file, fn, bundle: false })
      continue
    }
    const pos = map && map.lookup ? map.lookup(f.line - offset, f.col) : null
    if (pos && DROPPED_SOURCE.test(pos.source)) continue
    out.push({ source: pos ? pos.source : null, fn, bundle: true, resolved: !!pos, raw: f })
  }
  return out
}

// script-error and ui-error; maps[source] is { meta, lookup } for an archived build, else the build is unknown
function errorSignature(report, maps) {
  const e = report.error
  const map = maps[e.source] || null
  const held = map ? [] : ['unknown-build']
  const offset = e.source === 'client' ? probeOffset(report, map && map.meta) : 0
  const msg = normMsg(e.message)
  const frames = keyFrames(e, map, offset)
  const shown = frames.map(f => `${f.source || '?'}:${f.fn}`)
  const base = { type: e.type, normMsg: msg, held, frames: shown }
  if (!frames.length) {
    const site = e.site && map && map.lookup ? map.lookup(e.site.line - offset, e.site.col) : null
    const where = e.event ? `${e.event} handler` : e.service || e.where
    return { ...base, parts: ['v1', e.source, e.where, e.event || '', site ? site.source : '?', e.type, msg], title: title(e.type, inFn(where)) }
  }
  const top = frames[0]
  if (top.source === 'injected') {
    return { ...base, frames: shown.slice(0, 1), parts: ['v1', 'front', e.type, msg, `injected:${top.fn}`], title: title(e.type, inFn(top.fn)) }
  }
  const named = top.fn !== '?' ? top.fn : top.source && top.source.split('/').pop()
  const bundle = frames.filter(f => f.bundle)
  if (bundle.length && !bundle.some(f => f.resolved)) {
    if (map) held.push('unresolved')
    if (e.source === 'front') {
      const { raw } = bundle[0]
      const first = `${bundle[0].fn}@${raw.line}:${raw.col}`
      return { ...base, parts: ['v1', 'front', e.type, msg, first, report.build.front || '?'], title: title(e.type, inFn(named)) }
    }
  }
  return { ...base, parts: ['v1', e.source, e.type, msg, shown.join(',')], title: title(e.type, inFn(named)) }
}

// js-fatal: the last err trail entry, otherwise v1|js-fatal
function fatalSignature(report) {
  const last = report.trail.entries.filter(entry => entry.k === 'err').pop()
  const m = last && TRAIL_ERR.exec(last.d)
  if (!m) return { type: null, normMsg: '', parts: ['v1', 'js-fatal'], title: title('Fatal exit') }
  const type = m[2] || m[5] || '?'
  const msg = normMsg(m[1] ? m[3] : m[6])
  return { type, normMsg: msg, parts: ['v1', 'err', m[1] || `logged:${m[4]}`, type, msg], title: title('Fatal exit after', type) }
}

const isSystem = module => typeof module === 'string' && SYSTEM_MODULE.test(module)
const isOurs = module => OUR_MODULES.includes(module.toLowerCase())
const isThirdParty = module => !!module && !isOurs(module) && module.toLowerCase() !== GAME_MODULE

// Symbol, then Address Library id, then offset with the version it belongs to; never an absolute address
function crashFrame(f, versions, withVersion = true) {
  if (!f || !f.module) return '?'
  if (isThirdParty(f.module)) return f.module
  if (f.symbol) return `${f.module}+${f.symbol}`
  if (f.alid !== null && f.alid !== undefined) return `${f.module}+alid:${f.alid}`
  if (!f.offset) return f.module
  if (!withVersion) return `${f.module}+${f.offset}`
  const version = f.module.toLowerCase() === GAME_MODULE ? versions.game : versions.files
  return `${f.module}+${f.offset}@${version || '?'}`
}

function crashSignature(report) {
  const c = report.crash
  const versions = report.versions || {}
  const stack = c.frames.filter(f => !isSystem(f.module))
  const fromStack = isSystem(c.faultModule)
  const fault = fromStack ? stack[0] || null
    : { module: c.faultModule, offset: c.faultOffset, symbol: c.faultSymbol, alid: c.faultAlid }
  const faultKey = crashFrame(fault, versions)
  const at = crashFrame(fault, versions, false)
  const base = { type: c.exception, normMsg: '', title: title('Crash', c.exception, at) }
  if (fault && isThirdParty(fault.module)) return { ...base, frames: [faultKey], parts: ['v1', 'crash', c.exception, fault.module] }
  let rest = fromStack ? stack.slice(1) : stack
  if (rest.length && crashFrame(rest[0], versions) === faultKey) rest = rest.slice(1)
  const top = rest.slice(0, CRASH_FRAMES).map(f => crashFrame(f, versions))
  return { ...base, frames: [faultKey, ...top], parts: ['v1', 'crash', c.exception, faultKey, top.join(',')] }
}

function exitSignature(report) {
  const { code, event } = report.exit
  const module = event && event.id === 1000 && event.module ? event.module : 'unknown'
  const exit = code === null ? '?' : hexCode(code)
  return { type: exit, normMsg: '', parts: ['v1', 'crash', `exit:${exit}`, module], title: title('Crash', exit, module === 'unknown' ? '' : module) }
}

const SIGNERS = {
  'script-error': errorSignature,
  'ui-error': errorSignature,
  'js-fatal': fatalSignature,
  freeze: () => ({ type: null, normMsg: '', parts: ['v1', 'freeze'], title: title('Freeze') }),
  crash: crashSignature,
  'crash-nolog': exitSignature,
  'crash-on-quit': report => {
    const module = report.crash.faultModule || '?'
    return { type: report.crash.exception, normMsg: '', parts: ['v1', 'crash-on-quit', module], title: title('Crash on quit', module) }
  },
}

// { id, canonical, title, type, normMsg, frames, held }; held lists why a new group would wait for a second player
function signature(report, maps = {}) {
  const { parts, ...sig } = SIGNERS[report.kind](report, maps)
  const canonical = parts.join('|')
  const id = `S${crypto.createHash('sha1').update(canonical).digest('hex').slice(0, 10)}`
  return { id, canonical, frames: [], held: [], ...sig }
}

module.exports = { signature, normMsg, compareVersions }
