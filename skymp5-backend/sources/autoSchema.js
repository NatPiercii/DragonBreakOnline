'use strict'
// Auto report payload validation (docs/auto-report-v1.md §2.12): the stored record is built from known keys only

const { scrub, compileContext, clean } = require('./autoScrub')

const CONTRACT_VERSIONS = [1]
const MAX_PROBLEMS = 10
const MAX_INVALID_PATHS = 20
const MAX_COUNT = 10_000_000
const DAY_MS = 24 * 60 * 60 * 1000
const EARLIEST_TIME = Date.UTC(2025, 0, 1)
const DBO_WINDOW_MS = 60 * 1000
const TOO_OLD_MS = 7 * DAY_MS

const CAPS = { message: 1000, componentStack: 2000, trail: 160, clientGameLog: 16 * 1024, launcherGameLog: 32 * 1024 }
const SECTION_CAPS = {
  header: 4 * 1024, callStack: 24 * 1024, registers: 4 * 1024, relevantObjects: 16 * 1024,
  modules: 32 * 1024, sksePlugins: 8 * 1024, plugins: 32 * 1024, systemSpecs: 4 * 1024,
}
// §2.4 filters the backend runs again: registers keep `<REG> (<type>)`, relevantObjects keeps no name and no quoted string but File
const REGISTER_LINE = /^\s*([A-Z][A-Z0-9]{1,5})\s+(?:0x[0-9A-Fa-f]{1,16}\s+)?\(([^()"\n]{1,80})\)/
const NAME_VALUE = /\b((?:Full )?Name[ \t]*:[ \t]*)[^\n]*/gi
const QUOTED = /(\bFile:[ \t]*"[^"\n]*")|"[^"\n]*"?/g
const SECTION_FILTERS = {
  registers: text => text.split('\n').map(line => REGISTER_LINE.exec(line)).filter(Boolean)
    .map(([, reg, type]) => `${reg} (${type})`).join('\n'),
  relevantObjects: text => text.replace(NAME_VALUE, '$1<name>').replace(QUOTED, (_m, file) => file || '""'),
}
const TRAIL_MAX = 56
const ERROR_FRAMES_MAX = 12
const CRASH_FRAMES_MAX = 24

const PATTERNS = {
  reportId: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  version: /^\d{1,10}(?:\.\d{1,10}){1,3}$/,
  files: /^[0-9A-Za-z][0-9A-Za-z.-]{0,31}$/,
  os: /^[\w .()-]{1,40}$/,
  build: /^[0-9a-f]{12}(?:-dirty)?\.\d{8}T\d{6}Z$/,
  type: /^(?:[A-Za-z_$][A-Za-z0-9_$.]{0,63}|NonError:[a-z]{1,9})$/,
  event: /^[A-Za-z][A-Za-z0-9]{0,39}$/,
  service: /^[A-Za-z0-9_$]{1,64}$/,
  fn: /^[A-Za-z0-9_$.<>[\] ]{1,128}$/,
  file: /^(?:<injected>|node:[\w./-]{1,120}|[\w.$ ()+-]{1,128})$/,
  hex: /^[0-9a-f]{1,8}$/,
  module: /^[A-Za-z0-9_. ()+-]{1,64}$/,
  offset: /^0x[0-9A-F]{1,16}$/,
  symbol: /^[\x20-\x7e]{1,200}$/,
  exception: /^(?:EXCEPTION_[A-Z_]{3,40}|0x[0-9A-F]{8})$/,
  exceptionCode: /^0x[0-9A-F]{8}$/,
  logName: /^crash-[0-9_-]{1,40}\.log$/,
  crashLoggerVersion: /^[\w.-]{1,32}$/,
  componentLine: /^at [A-Za-z_$][A-Za-z0-9_$.]{0,63}(?: \(build\.js:[1-9]\d{0,7}:[1-9]\d{0,7}\))?$/,
}

// consent: 'errors' needs consent.errors true, a list names the allowed consent.crash values
const KINDS = {
  'script-error':  { sender: 'client', source: 'client', consent: 'errors' },
  'ui-error':      { sender: 'client', source: 'front', consent: 'errors' },
  'js-fatal':      { sender: 'launcher', consent: 'errors' },
  freeze:          { sender: 'launcher', consent: 'errors' },
  crash:           { sender: 'launcher', consent: ['always', 'once'], crash: true, sections: true },
  'crash-nolog':   { sender: 'launcher', consent: ['always', 'once'] },
  'crash-on-quit': { sender: 'launcher', consent: ['always'], crash: true, trailMax: 10, noLogs: true },
}
const WHERE = { client: ['on', 'once', 'hook', 'logged', 'http', 'uncaught', 'rejection'], front: ['window', 'promise', 'boundary'] }
const SITE_WHERE = ['on', 'once', 'hook']
const HOOKS = ['sendAnimationEvent', 'sendPapyrusEvent']
const DETECTED_BY = ['wait', 'poll', 'next-start']
const TRAIL_SOURCES = ['memory', 'file', 'file-prev', 'none']
const DBO_KINDS = ['net', 'send', 'recv']

// Trail `d` grammar per kind (§3.1.4 client, §3.2.3 server)
const DESC = String.raw`[0-9a-f]{1,8}(?::[^:\r\n]{1,64}?\.es[lmp])?`
const NAME = String.raw`[\p{L}\p{N} '.,:()-]{1,40}`
const TOK = String.raw`[A-Za-z0-9_:.-]{1,40}`
const TYPE = PATTERNS.type.source.slice(1, -1)
const SVC = String.raw`[A-Za-z0-9_$]{1,64}`
// Rule R: an FF-range form (player-made or player-named) is the hex only, never with a name
const NAMED = String.raw`(?!ff[0-9a-f]{6} )${DESC}(?: ${NAME})?`
const TGT = String.raw`(?:self|player [0-9a-f]{1,8}|npc ${DESC}|${NAMED})`
const REASON = String.raw`[A-Za-z0-9_-]{1,32}`
const STGT = String.raw`(?:player [0-9a-f]{1,8}|npc ${DESC}|${DESC})`
const grammar = table => Object.fromEntries(Object.entries(table).map(([k, re]) => [k, new RegExp(`^(?:${re})$`, 'u')]))
const CLIENT_TRAIL = grammar({
  net: String.raw`connecting|connected|disconnected|login ok|login denied [A-Za-z]{1,32}|reconnect \d{1,4}|exit (?:quit|kick|auth)|menu-quit`,
  send: String.raw`CustomPacket (?:dbo ${TOK}|chat(?: /[a-z]{1,16})?|${TOK})|ConsoleCommand [A-Za-z]{1,24}|[A-Z][A-Za-z0-9]{1,39}(?: ${TGT})?`,
  recv: String.raw`SpSnippet [A-Za-z0-9_]{1,40}\.[A-Za-z0-9_]{1,40}|CustomPacket ${TOK}|[A-Z][A-Za-z0-9]{1,39}`,
  menu: String.raw`(?:open|close) [A-Za-z0-9 _/]{1,40}`,
  world: String.raw`enter (?:ws|cell) ${NAMED}|teleport ${DESC}|loadGame`,
  act: String.raw`(?:activate|open|read|eat|use|equip|unequip|drop|take|craft|cast|hit|shoot) ${TGT}`,
  life: String.raw`death|downed|revived|respawn|ragdoll`,
  inv: String.raw`(?:add|remove) ${DESC} x\d{1,6}|set \d{1,5} entries`,
  ui: String.raw`front-loaded|reload|(?:widget open|widget close|focus|dbo) ${TOK}`,
  err: String.raw`(?:on|once|hook|http|uncaught|rejection|window|promise|boundary) ${TYPE}(?:: .{0,100})?|logged ${SVC}(?:: ${TYPE}: .{0,80})?`,
  fatal: String.raw`(?:uncaught|rejection) ${TYPE}`,
  hb: 'c?',
})
const SERVER_TRAIL = grammar({
  net: 'connect|disconnect',
  act: String.raw`activate ${STGT} (?:ok|refused(?::${REASON})?)`,
  hit: String.raw`refused ${REASON} ${STGT}`,
  life: String.raw`death(?: by ${STGT})?|downed|collapsed|revived`,
  spell: String.raw`cast ${DESC}`,
  inv: String.raw`take ${DESC} x\d{1,6}|(?:eat|read|craft|alchemy) ${DESC}|refused ${REASON} ${DESC}`,
  equip: String.raw`(?:equip|unequip) ${DESC}`,
  console: String.raw`[A-Za-z]{1,24}|\?`,
  chat: String.raw`chat|pm|/[a-z]{1,16}|/\?`,
  pkt: String.raw`dbo ${TOK}|${TOK}`,
  widget: String.raw`(?:open|close) ${TOK}`,
  world: DESC,
})

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const get = (o, k) => (isObject(o) && own(o, k) ? o[k] : undefined)
const intIn = (min, max) => v => Number.isSafeInteger(v) && v >= min && v <= max
const isUint = intIn(0, Number.MAX_SAFE_INTEGER)
const isCount = intIn(1, MAX_COUNT)
const isBool = v => typeof v === 'boolean'
const isString = v => typeof v === 'string'
const oneOf = list => v => list.includes(v)
const matches = re => v => typeof v === 'string' && re.test(v)
// Parsers return the value to store, or undefined when it is invalid
const check = ok => v => (ok(v) ? v : undefined)
// Pattern-checked text that a scrub rule would change is invalid, so it never reaches a signature or a title
const plain = re => v => matches(re)(v) && scrub(v, { field: 'symbol' }).text === v
const position = v => (isCount(get(v, 'line')) && isCount(get(v, 'col')) ? { line: v.line, col: v.col } : undefined)
const setIf = (out, key, value) => { if (value !== undefined) out[key] = value }

function createState() {
  return { problems: [], flags: new Set(), invalid: [] }
}
const problem = (st, path, why) => st.problems.push(`${path}: ${why}`)
function invalid(st, path) {
  st.flags.add('invalidField')
  if (st.invalid.length < MAX_INVALID_PATHS) st.invalid.push(path)
}

// Required: missing or invalid refuses the report
function need(st, obj, key, path, parse) {
  const raw = get(obj, key)
  const value = raw === undefined ? undefined : parse(raw)
  if (value === undefined) problem(st, path, raw === undefined ? 'missing' : 'invalid')
  return value
}
// Optional: absent stays absent, invalid is removed and flagged; nullOk keeps an explicit null
function may(st, obj, key, path, parse, nullOk = false) {
  const raw = get(obj, key)
  if (raw === undefined || (raw === null && nullOk)) return raw
  const value = parse(raw)
  if (value === undefined) invalid(st, path)
  return value
}
// Required key whose value may be null: missing refuses, invalid becomes null and is flagged
function nullable(st, obj, key, path, parse) {
  if (get(obj, key) === undefined) {
    problem(st, path, 'missing')
    return null
  }
  return may(st, obj, key, path, parse, true) ?? null
}
// Optional and nullable, stored as null when absent or invalid
const loose = (st, obj, key, path, parse) => may(st, obj, key, path, parse, true) ?? null
function list(st, obj, key, path, max) {
  const raw = get(obj, key)
  if (raw === undefined) problem(st, path, 'missing')
  else if (!Array.isArray(raw)) problem(st, path, 'must be an array')
  else if (raw.length > max) problem(st, path, `more than ${max}`)
  else return raw
  return undefined
}

function eventRule(where) {
  if (where === 'on' || where === 'once') return matches(PATTERNS.event)
  if (where === 'hook') return oneOf(HOOKS)
  if (where === 'http') return oneOf(['get', 'post'])
  return () => false
}

function readVersions(st, v, meta) {
  const version = check(matches(PATTERNS.version))
  const out = {}
  setIf(out, 'client', meta.sender === 'client'
    ? need(st, v, 'client', 'versions.client', version) : may(st, v, 'client', 'versions.client', version))
  setIf(out, 'files', may(st, v, 'files', 'versions.files', check(matches(PATTERNS.files))))
  setIf(out, 'launcher', may(st, v, 'launcher', 'versions.launcher', version))
  setIf(out, 'game', may(st, v, 'game', 'versions.game', version))
  if (meta.sender === 'launcher') setIf(out, 'os', may(st, v, 'os', 'versions.os', check(plain(PATTERNS.os))))
  return out
}

function readBuild(st, body, kind, meta) {
  const build = check(matches(PATTERNS.build))
  if (meta.sender === 'launcher') {
    const b = may(st, body, 'build', 'build', check(isObject))
    if (!b) return undefined
    const out = {}
    setIf(out, 'client', may(st, b, 'client', 'build.client', build))
    return out
  }
  const b = need(st, body, 'build', 'build', check(isObject))
  if (!b) return undefined
  const out = {}
  if (kind === 'script-error') out.client = need(st, b, 'client', 'build.client', build)
  else setIf(out, 'client', may(st, b, 'client', 'build.client', build))
  if (kind === 'ui-error') {
    if (get(b, 'front') === null) out.front = null
    else out.front = need(st, b, 'front', 'build.front', build)
  } else setIf(out, 'front', may(st, b, 'front', 'build.front', build, true))
  setIf(out, 'probe', may(st, b, 'probe', 'build.probe', position, true))
  return out
}

function readSession(st, body) {
  const s = may(st, body, 'session', 'session', check(isObject))
  if (!s) return undefined
  const out = {}
  setIf(out, 'start', may(st, s, 'start', 'session.start', check(isUint)))
  setIf(out, 'uptimeSec', may(st, s, 'uptimeSec', 'session.uptimeSec', check(isUint)))
  setIf(out, 'connected', may(st, s, 'connected', 'session.connected', check(isBool)))
  setIf(out, 'actorId', may(st, s, 'actorId', 'session.actorId', check(matches(PATTERNS.hex)), true))
  return out
}

function errorFrame(st, f, path) {
  const line = get(f, 'line')
  const col = get(f, 'col')
  if (!isCount(line) || !isCount(col)) {
    invalid(st, path)
    return null
  }
  return {
    fn: loose(st, f, 'fn', `${path}.fn`, check(matches(PATTERNS.fn))),
    line,
    col,
    file: loose(st, f, 'file', `${path}.file`, check(matches(PATTERNS.file))),
  }
}

// Keeps only `at <Name>` and `at <Name> (build.js:<line>:<col>)` lines; the text is scrubbed later with the other free text
function componentNames(st, text) {
  const lines = text.slice(0, CAPS.componentStack * 2).split('\n').map(l => l.trim()).filter(Boolean)
  const kept = lines.filter(l => PATTERNS.componentLine.test(l))
  if (kept.length < lines.length) invalid(st, 'error.componentStack')
  return kept.length ? kept.join('\n') : null
}

function readError(st, e, meta) {
  const out = {}
  out.source = need(st, e, 'source', 'error.source', check(v => v === meta.source))
  const where = need(st, e, 'where', 'error.where', check(oneOf(WHERE[meta.source])))
  out.where = where
  out.event = nullable(st, e, 'event', 'error.event', check(eventRule(where)))
  out.service = loose(st, e, 'service', 'error.service', check(matches(PATTERNS.service)))
  if (out.service !== null && where !== 'logged') {
    invalid(st, 'error.service')
    out.service = null
  }
  const handled = need(st, e, 'handled', 'error.handled', check(isBool))
  out.handled = where === 'logged'
  if (handled !== undefined && handled !== out.handled) invalid(st, 'error.handled')
  out.type = need(st, e, 'type', 'error.type', check(matches(PATTERNS.type)))
  out.message = need(st, e, 'message', 'error.message', check(isString))
  const frames = list(st, e, 'frames', 'error.frames', ERROR_FRAMES_MAX)
  out.frames = frames ? frames.map((f, i) => errorFrame(st, f, `error.frames[${i}]`)).filter(Boolean) : []
  out.site = nullable(st, e, 'site', 'error.site', position)
  if (out.site && !SITE_WHERE.includes(where)) {
    invalid(st, 'error.site')
    out.site = null
  }
  let stack = loose(st, e, 'componentStack', 'error.componentStack', check(isString))
  if (stack !== null && where !== 'boundary') {
    invalid(st, 'error.componentStack')
    stack = null
  }
  if (where === 'boundary') out.componentStack = stack === null ? null : componentNames(st, stack)
  out.count = need(st, e, 'count', 'error.count', check(isCount))
  return out
}

function windowsEvent(st, v) {
  const id = get(v, 'id')
  if (id !== 1000 && id !== 1002) return undefined
  return {
    id,
    module: loose(st, v, 'module', 'exit.event.module', check(matches(PATTERNS.module))),
    moduleVersion: loose(st, v, 'moduleVersion', 'exit.event.moduleVersion', check(matches(PATTERNS.version))),
    exceptionCode: loose(st, v, 'exceptionCode', 'exit.event.exceptionCode', check(matches(PATTERNS.exceptionCode))),
    offset: loose(st, v, 'offset', 'exit.event.offset', check(matches(PATTERNS.offset))),
  }
}

function readExit(st, x, kind) {
  const out = {
    at: need(st, x, 'at', 'exit.at', check(isUint)),
    code: nullable(st, x, 'code', 'exit.code', check(intIn(0, 0xFFFFFFFF))),
    detectedBy: need(st, x, 'detectedBy', 'exit.detectedBy', check(oneOf(DETECTED_BY))),
    gamePid: nullable(st, x, 'gamePid', 'exit.gamePid', check(isUint)),
    lastHeartbeatAt: nullable(st, x, 'lastHeartbeatAt', 'exit.lastHeartbeatAt', check(isUint)),
    quitMarker: need(st, x, 'quitMarker', 'exit.quitMarker', check(isBool)),
    event: nullable(st, x, 'event', 'exit.event', v => windowsEvent(st, v)),
  }
  if (kind === 'freeze' && out.lastHeartbeatAt === null && out.event?.id !== 1002) {
    problem(st, 'exit.lastHeartbeatAt', 'required for freeze without event 1002')
  }
  if (kind === 'crash-nolog' && out.code === null && out.event === null) {
    problem(st, 'exit.event', 'required for crash-nolog without an exit code')
  }
  return out
}

function crashFrame(st, f, path) {
  if (!isObject(f)) {
    invalid(st, path)
    return null
  }
  return {
    module: loose(st, f, 'module', `${path}.module`, check(matches(PATTERNS.module))),
    offset: loose(st, f, 'offset', `${path}.offset`, check(matches(PATTERNS.offset))),
    symbol: loose(st, f, 'symbol', `${path}.symbol`, check(plain(PATTERNS.symbol))),
    alid: loose(st, f, 'alid', `${path}.alid`, check(isUint)),
  }
}

function readCrash(st, c, meta) {
  const out = { crashAt: need(st, c, 'crashAt', 'crash.crashAt', check(isUint)) }
  setIf(out, 'logName', may(st, c, 'logName', 'crash.logName', check(matches(PATTERNS.logName))))
  setIf(out, 'crashLoggerVersion', may(st, c, 'crashLoggerVersion', 'crash.crashLoggerVersion', check(matches(PATTERNS.crashLoggerVersion))))
  out.exception = need(st, c, 'exception', 'crash.exception', check(matches(PATTERNS.exception)))
  out.faultModule = nullable(st, c, 'faultModule', 'crash.faultModule', check(matches(PATTERNS.module)))
  out.faultOffset = nullable(st, c, 'faultOffset', 'crash.faultOffset', check(matches(PATTERNS.offset)))
  if (out.faultModule === null && out.faultOffset !== null) {
    invalid(st, 'crash.faultOffset')
    out.faultOffset = null
  }
  out.faultSymbol = nullable(st, c, 'faultSymbol', 'crash.faultSymbol', check(plain(PATTERNS.symbol)))
  out.faultAlid = nullable(st, c, 'faultAlid', 'crash.faultAlid', check(isUint))
  out.hasOurDll = need(st, c, 'hasOurDll', 'crash.hasOurDll', check(isBool))
  const frames = list(st, c, 'frames', 'crash.frames', CRASH_FRAMES_MAX)
  out.frames = frames ? frames.map((f, i) => crashFrame(st, f, `crash.frames[${i}]`)).filter(Boolean) : []
  if (meta.sections) {
    const s = may(st, c, 'sections', 'crash.sections', check(isObject))
    if (s) {
      out.sections = {}
      for (const key of Object.keys(SECTION_CAPS)) setIf(out.sections, key, may(st, s, key, `crash.sections.${key}`, check(isString)))
    }
  }
  return out
}

function trailEntry(e, run) {
  const t = get(e, 't')
  const s = get(e, 's')
  const k = get(e, 'k')
  const d = get(e, 'd')
  const n = get(e, 'n')
  if (!isUint(t) || !isString(d) || k === 'hb' || !isString(k) || !own(CLIENT_TRAIL, k)) return null
  if ((s !== undefined && !isUint(s)) || (n !== undefined && !intIn(2, MAX_COUNT)(n))) return null
  const text = run(d, { field: 'trail', kind: k, cap: CAPS.trail })
  if (!CLIENT_TRAIL[k].test(text)) return null
  const out = { t }
  setIf(out, 's', s)
  out.k = k
  out.d = text
  setIf(out, 'n', n)
  return out
}

// Keeps the newest entries up to the kind's limit; entries left out or failing the grammar count in `dropped`
function scrubTrail(st, trail, max, run) {
  const time = e => (isUint(get(e, 't')) ? e.t : -1)
  let raw = [...trail.entries].sort((a, b) => time(a) - time(b))
  let dropped = trail.dropped
  if (raw.length > max) {
    dropped += raw.length - max
    raw = raw.slice(-max)
    st.flags.add('truncated')
  }
  const entries = []
  for (const e of raw) {
    const entry = trailEntry(e, run)
    if (entry) entries.push(entry)
    else dropped++
  }
  return { source: trail.source, entries, dropped }
}

function scrubRecord(st, r, meta, ctx) {
  const run = (text, opts) => {
    const res = scrub(text, opts, ctx)
    if (res.truncated) st.flags.add('truncated')
    return res.text
  }
  if (r.error) {
    r.error.message = run(r.error.message, { field: 'message', type: r.error.type, cap: CAPS.message })
    if (r.error.componentStack) r.error.componentStack = run(r.error.componentStack, { field: 'componentStack', cap: CAPS.componentStack })
  }
  if (r.logs) {
    const cap = meta.sender === 'client' ? CAPS.clientGameLog : CAPS.launcherGameLog
    r.logs.gameLog = run(r.logs.gameLog, { field: 'gameLog', cap })
  }
  if (r.crash && r.crash.sections) {
    for (const [key, text] of Object.entries(r.crash.sections)) {
      const filter = SECTION_FILTERS[key]
      r.crash.sections[key] = run(filter ? filter(clean(text)) : text, { field: 'crashSection', cap: SECTION_CAPS[key] })
    }
  }
  r.trail = scrubTrail(st, r.trail, meta.trailMax || TRAIL_MAX, run)
}

function consentRefused(meta, consent) {
  if (!isCount(get(consent, 'noticeVersion'))) return true
  if (meta.consent === 'errors') return get(consent, 'errors') !== true
  return !meta.consent.includes(get(consent, 'crash'))
}

const refuse = json => ({ ok: false, status: 422, json })

// scrubContext holds the S1 and S2 values (§2.11), for example { names: { discord: [session.username] } }
function validate(body, { receivedAt = Date.now(), scrubContext } = {}) {
  if (!isObject(body)) return refuse({ error: 'schema', problems: ['body: must be a JSON object'] })
  const version = get(body, 'contractVersion')
  if (Number.isSafeInteger(version) && !CONTRACT_VERSIONS.includes(version)) {
    return refuse({ error: 'contractVersion', supported: CONTRACT_VERSIONS })
  }
  const st = createState()
  const schemaError = () => refuse({ error: 'schema', problems: st.problems.slice(0, MAX_PROBLEMS) })
  const r = {}
  r.contractVersion = need(st, body, 'contractVersion', 'contractVersion', check(oneOf(CONTRACT_VERSIONS)))
  r.reportId = need(st, body, 'reportId', 'reportId', check(matches(PATTERNS.reportId)))
  r.kind = need(st, body, 'kind', 'kind', check(k => isString(k) && own(KINDS, k)))
  r.sender = need(st, body, 'sender', 'sender', check(oneOf(['client', 'launcher'])))
  r.clientAt = need(st, body, 'clientAt', 'clientAt', check(isUint))
  r.sentAt = need(st, body, 'sentAt', 'sentAt', check(isUint))
  r.attempt = need(st, body, 'attempt', 'attempt', check(intIn(1, 5)))
  r.queued = need(st, body, 'queued', 'queued', check(isBool))
  const consent = need(st, body, 'consent', 'consent', check(isObject))
  const errorsConsent = consent && need(st, consent, 'errors', 'consent.errors', check(isBool))
  const versions = need(st, body, 'versions', 'versions', check(isObject))
  const meta = r.kind && KINDS[r.kind]
  if (!meta) return schemaError()
  if (r.sender && r.sender !== meta.sender) problem(st, 'sender', 'does not match the kind')

  r.consent = { noticeVersion: get(consent, 'noticeVersion'), errors: errorsConsent }
  if (meta.consent !== 'errors') r.consent.crash = get(consent, 'crash')
  if (versions) r.versions = readVersions(st, versions, meta)
  setIf(r, 'build', readBuild(st, body, r.kind, meta))
  setIf(r, 'session', readSession(st, body))
  if (meta.sender === 'client') {
    const e = need(st, body, 'error', 'error', check(isObject))
    if (e) r.error = readError(st, e, meta)
  } else {
    const x = need(st, body, 'exit', 'exit', check(isObject))
    if (x) r.exit = readExit(st, x, r.kind)
  }
  if (meta.crash) {
    const c = need(st, body, 'crash', 'crash', check(isObject))
    if (c) r.crash = readCrash(st, c, meta)
  }
  const trail = need(st, body, 'trail', 'trail', check(isObject))
  if (trail) {
    r.trail = {
      source: need(st, trail, 'source', 'trail.source', check(oneOf(TRAIL_SOURCES))),
      entries: list(st, trail, 'entries', 'trail.entries', Infinity),
      dropped: may(st, trail, 'dropped', 'trail.dropped', check(intIn(0, MAX_COUNT))) ?? 0,
    }
  }
  if (!meta.noLogs) {
    const logs = may(st, body, 'logs', 'logs', check(isObject))
    const gameLog = logs && may(st, logs, 'gameLog', 'logs.gameLog', check(isString))
    if (gameLog) r.logs = { gameLog }
  }
  if (st.problems.length) return schemaError()
  if (consentRefused(meta, consent)) return refuse({ error: 'consent' })

  const times = [r.clientAt, r.sentAt, r.exit?.at, r.exit?.lastHeartbeatAt, r.crash?.crashAt, r.session?.start]
  if (times.some(t => t != null && (t < EARLIEST_TIME || t > receivedAt + DAY_MS))) st.flags.add('clockSuspect')
  scrubRecord(st, r, meta, compileContext(scrubContext))
  return { ok: true, report: r, flags: [...st.flags], invalid: st.invalid }
}

// §2.9: lines to subtract from client bundle positions; 0 without a probe or an archived probeLine
function probeOffset(report, meta) {
  const probe = report.build && report.build.probe
  return probe && meta && isCount(meta.probeLine) ? probe.line - meta.probeLine : 0
}

// §2.12 checks against the archived client meta: a version mismatch is suspect, positions moved below line 1 go
function checkBuild(result, meta) {
  if (!meta) return
  const { report } = result
  const st = { flags: new Set(result.flags), invalid: result.invalid }
  if (meta.clientVersion && report.versions.client && meta.clientVersion !== report.versions.client) st.flags.add('suspect')
  const e = report.error
  if (e && e.source === 'client') {
    const offset = probeOffset(report, meta)
    const below = (pos, path) => {
      if (pos.line - offset >= 1) return false
      invalid(st, path)
      return true
    }
    e.frames = e.frames.filter((f, i) => f.file !== null || !below(f, `error.frames[${i}]`))
    if (e.site && below(e.site, 'error.site')) e.site = null
  }
  result.flags = [...st.flags]
}

// §2.12: why a valid report is stored as metadata only, or null
function ignoreReason(report) {
  if (report.kind === 'ui-error' && report.error.message === 'Script error.') return 'opaque'
  if (KINDS[report.kind].sender !== 'launcher') return null
  const at = report.crash ? report.crash.crashAt : report.exit.at
  const nearby = report.trail.entries.some(e => DBO_KINDS.includes(e.k) && e.t >= at - DBO_WINDOW_MS && e.t <= at)
  if (!nearby) return 'no-dbo-trail'
  // Both times are on the sender's clock, so the skew cancels
  if (report.sentAt - at > TOO_OLD_MS) return 'too-old'
  return null
}

module.exports = {
  validate, ignoreReason, probeOffset, checkBuild, CONTRACT_VERSIONS, KINDS, CAPS, SECTION_CAPS, PATTERNS,
  trailGrammar: { client: CLIENT_TRAIL, server: SERVER_TRAIL },
}
