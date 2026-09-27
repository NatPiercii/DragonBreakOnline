'use strict'
// Release queue for the Server panel: what is live, what waits on GitHub and what the next update would ship
// Read only: every git call goes through one guarded wrapper, and no secret file is ever opened

const { AsyncLocalStorage } = require('async_hooks')
const childProcess = require('child_process')
const crypto = require('crypto')
const nodeFs = require('fs')
const os = require('os')
const path = require('path')
const { AREA_ORDER, FORK_PATHS, classifyCommit, isDeployable } = require('./releasePaths')

const GIT_ALLOWED = Object.freeze(['rev-parse', 'rev-list', 'log', 'show', 'diff', 'merge-base', 'cat-file', 'ls-tree',
  'cherry', 'patch-id', 'for-each-ref', 'status', 'merge-tree'])
// Options that write a file, read one outside the object store or run a configured helper
const GIT_REFUSED_RE = /^(?:--output(?:=.*)?|--no-index|--ext-diff|--textconv|--orderfile(?:=.*)?|-O.*)$/
// A path outside the repo, which also turns a two-path diff into diff --no-index
const OUTSIDE_RE = /^\/|(?:^|\/)\.\.(?:\/|$)/
const GIT_TIMEOUT_MS = 5000
// One queue build may take this long in all; after a failure the next waits 1 min, doubling up to 15
const QUEUE_DEADLINE_MS = 20 * 1000
const BACKOFF_FIRST_MS = 60 * 1000
const BACKOFF_MAX_MS = 15 * 60 * 1000
const GIT_MAX_BUFFER = 2 * 1024 * 1024
// Values allowed after --end-of-options: shas, fixed refs, sha:path
const REF_RE = /^\^?(?:[0-9a-f]{7,40}|HEAD|origin\/[\w./-]+|refs\/(?:heads|remotes|tags)\/[\w./*-]*)(?:\^\{(?:commit|tree)\}|:[\w./ -]+)?$/
const SHA_RE = /^[0-9a-f]{40}$/
const SHA256_RE = /^[0-9a-f]{64}$/
const VERSION_RE = /^\d+\.\d+\.\d+$/
const ITEM_ID_RE = /^[a-z]+-\d{8}-[0-9a-f]{4}$/
const ITEM_FILE_RE = /^[a-z]+-\d{8}-[0-9a-f]{4}\.json$/
const MAX_ITEMS = 200
const PAGE_RE = /^[a-z0-9/_-]+\.html$/
const BRANCH_RE = /^[\w./-]{1,100}$/
const SECRET_RE = /^(?:server-settings.*\.json|backend\.env|\.env.*|sessions\.json|site-sessions\.json|auth-states\.json)$/

const MAX_COMMITS = 300
const GROUP_CAP = 200
const LIST_CAP = 300
const CONTENT_MATCH_DEPTH = 100
// The queue key covers what changes between fetches, so the TTL is only a backstop for the rest (the working tree, other gameplay files)
const QUEUE_TTL_MS = 5 * 60 * 1000
const RETRY_SOON_MS = 60 * 1000
const WEB_EVERY_MS = 10 * 60 * 1000
const WEB_MAX_PAGES = 60
const WEB_TIMEOUT_MS = 10 * 1000
// Files are read up to these sizes: the updater log and the jsonl files from their end, deployed gameplay and generated manifests whole
const TAIL_BYTES = 1024 * 1024
const FILE_MAX_BYTES = 1024 * 1024
const DATA_MAX_BYTES = 32 * 1024 * 1024
const WEB_MAX_BYTES = 2 * 1024 * 1024
const REVIEWERS = new Set(['claude-jake', 'jake'])
const REVIEWED = new Set(['GO', 'sameChange', 'live'])
const CLIENT_PATHS = FORK_PATHS.filter(r => r.flags.includes('clientPack')).flatMap(r => r.paths).map(p => p.replace(/\/\*\*$/, ''))
const ITEM_AREAS = { config: 'Manual', plugins: 'Manual', launcher: 'Launcher', native: 'Native client', tools: 'Tools', news: 'Patch notes', website: 'Website', other: 'Manual' }
const ITEM_FIELDS = new Set(['v', 'id', 'area', 'title', 'author', 'createdAt', 'applyBy', 'flags', 'keys', 'ref', 'state', 'appliedIn'])
const ITEM_FLAGS = new Set(['build', 'gameRestart', 'bootOnly', 'hotReload', 'migration', 'backendRestart', 'backendDeps', 'clientPack',
  'clientUpdate', 'nativeBuild', 'launcherRelease', 'websiteInstall', 'news', 'manual'])
const AUTHOR_NAMES = { NatPiercii: 'Nate / claude-nate', Jake: 'Jake', 'claude-jake': 'claude-jake', 'claude-nate': 'claude-nate' }
const AREA_PREFIX_RE = /^(?:website|client|front|server|backend|launcher|docs|tools|gameplay|native|versions|plugins)\s*:\s*/i
const REVIEW_SUFFIX_RE = /\s*\(review(?:\s+of)?\s+[^()]*\)\s*$/i
const DRIFT_ORDER = ['headNotLive', 'lastUpdateUnfinished', 'gameplayOutsideRelease', 'gameplayModified', 'clientOutsideRelease',
  'clientSourceNotOnMain', 'newsOutsideRelease', 'extrasChanged', 'pluginsDiffer', 'configChangedSinceStart', 'versionLabelStale']
// One NUL-separated record per commit; git never puts a NUL inside a field, and --name-only follows the last field
const LOG_FORMAT = '%x00' + ['%H', '%P', '%an', '%ae', '%aI', '%s', '%(trailers:only,unfold,separator=%x1f)', '%b'].join('%x00') + '%x00'
const LOG_FIELDS = 9

// execFile with optional stdin; rejects like execFile, with stdout attached
function runFile(file, args, { input, ...opts }) {
  return new Promise((resolve, reject) => {
    const child = childProcess.execFile(file, args, opts, (err, stdout, stderr) =>
      err ? reject(Object.assign(err, { stdout, stderr })) : resolve({ stdout, stderr }))
    child.stdin.on('error', () => {})
    child.stdin.end(input ?? '')
  })
}

const sha256 = data => crypto.createHash('sha256').update(data).digest('hex')
const blobId = buf => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex')
const short = sha => (sha ? sha.slice(0, 8) : null)
const iso = ms => new Date(ms).toISOString()
const isoOrNull = s => (typeof s === 'string' && !Number.isNaN(Date.parse(s)) ? iso(Date.parse(s)) : null)
const clip = (s, n) => (s.length > n ? s.slice(0, n) : s)
const cleanText = (s, n = 200) => clip(String(s ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim(), n)
const semverCmp = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] }

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
  return JSON.stringify(value ?? null)
}

// The queue's ETag: queueHash plus everything else the page lists, without the build and fetch times
const etags = new WeakMap()
function queueEtag(value) {
  if (!etags.has(value)) etags.set(value, `"q-${sha256(canonical({ ...value, generatedAt: undefined, fetchedAt: undefined })).slice(0, 32)}"`)
  return etags.get(value)
}

function parseTrailers(text) {
  return text.split('\x1f').map(t => { const i = t.indexOf(':'); return i > 0 ? { key: t.slice(0, i).trim().toLowerCase(), value: t.slice(i + 1).trim() } : null }).filter(Boolean)
}

function parseLog(out, side) {
  const t = out.split('\0'), commits = []
  for (let i = 1; i + LOG_FIELDS - 1 < t.length; i += LOG_FIELDS) {
    const [sha, parents, name, email, at, subject, trailers, body, files] = t.slice(i, i + LOG_FIELDS)
    commits.push({ side, sha, parents: parents ? parents.split(' ') : [], name, email, at: isoOrNull(at), subject, trailers: parseTrailers(trailers), body, files: files.split('\n').filter(Boolean) })
  }
  return commits
}

const trailer = (c, key) => c.trailers.findLast(t => t.key === key)?.value || null

function commitTitle(subject) {
  const s = cleanText(subject, 400).replace(AREA_PREFIX_RE, '').replace(REVIEW_SUFFIX_RE, '')
  return clip(s.charAt(0).toUpperCase() + s.slice(1), 120)
}

const isClaude = s => /noreply@anthropic\.com/i.test(s)
const gitAuthor = (name, email) => (isClaude(email) ? 'a Claude session' : AUTHOR_NAMES[name] || cleanText(name, 60) || 'unknown')

function commitAuthor(c) {
  const op = cleanText(trailer(c, 'operator'), 40)
  if (op) return { author: `${op} (trailer)`, authorFrom: 'trailer' }
  if (!isClaude(c.email) && c.trailers.some(t => t.key === 'co-authored-by' && isClaude(t.value))) {
    return { author: `a Claude session (via ${gitAuthor(c.name, c.email)})`, authorFrom: 'coauthor' }
  }
  return { author: gitAuthor(c.name, c.email), authorFrom: 'git' }
}

// How an UPDATE can fail; every one but UNHEALTHY stops before the restart, so the previous build keeps running
const UPDATE_FAILURES = [[/^BUILD FAILED/, 'build'], [/^yarn install FAILED/, 'deps'], [/^CONFIGURE FAILED/, 'configure'], [/^reset failed/, 'reset'], [/^UNHEALTHY/, 'unhealthy']]

// UPDATE, restarting, OK and failure lines of skymp-update.sh (v1, and v2's "OK - now X (backup ...)")
function parseUpdaterLog(text) {
  const updates = []
  let lastRun = null
  for (const line of String(text).split('\n')) {
    const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ) (.*)$/.exec(line)
    if (!m) continue
    const [, at, msg] = m
    const cur = updates.at(-1)
    let u
    if ((u = /^UPDATE ([0-9a-f]{7,40}) -> ([0-9a-f]{7,40})/.exec(msg))) updates.push({ at, from: u[1], to: u[2], restartingAt: null, okAt: null, failed: null })
    else if (msg === 'restarting' && cur && !cur.okAt) cur.restartingAt = at
    else if ((u = /^OK - now ([0-9a-f]{7,40})\b/.exec(msg)) && cur && !cur.okAt && cur.to.startsWith(u[1].slice(0, cur.to.length))) cur.okAt = at
    else if ((u = UPDATE_FAILURES.find(([re]) => re.test(msg))) && cur && !cur.okAt) cur.failed = u[1]
    const result = /^up to date/.test(msg) ? 'upToDate' : /^skipped: deploy hold/.test(msg) ? 'hold' : /^skipped/.test(msg) ? 'skipped'
      : /^deferred/.test(msg) ? 'deferred' : /^OK - now/.test(msg) ? 'updated' : /^(?:BUILD|CONFIGURE|yarn install) FAILED/.test(msg) ? 'buildFailed'
      : /^UNHEALTHY/.test(msg) ? 'unhealthy' : /^fetch failed/.test(msg) ? 'fetchFailed' : null
    if (result) lastRun = { at, result }
  }
  return { updates, lastRun }
}

const sameCommit = (a, b) => !!a && !!b && (a.startsWith(b) || b.startsWith(a))
const beforeRestart = u => !u.okAt && !u.restartingAt && u.failed !== 'unhealthy'

// skymp-update.sh moves HEAD before it builds, so after updates that never restarted the first one's from still runs
function notRestarted(updates, head) {
  const last = updates.at(-1)
  if (!last || !beforeRestart(last) || !(sameCommit(head, last.to) || sameCommit(head, last.from))) return null
  let i = updates.length - 1
  while (i > 0 && beforeRestart(updates[i - 1]) && sameCommit(updates[i - 1].to, updates[i].from)) i--
  return { from: updates[i].from, index: i }
}

// The last line of a deployed dbo-gamemode.js: "// deployed <iso>", optionally with " server@<sha40>"
function stripStamp(buf) {
  const text = buf.toString('latin1')
  const m = /\/\/ deployed (\S+)(?: server@([0-9a-f]{40}))?[ \t]*\r?\n?$/.exec(text)
  return m ? { body: buf.subarray(0, m.index), at: isoOrNull(m[1]), sha: m[2] || null } : { body: buf, at: null, sha: null }
}

function configId(buf) {
  try { const cfg = JSON.parse(buf.toString('utf8')); delete cfg.admins; return sha256(canonical(cfg)) } catch { return `raw:${blobId(buf)}` }
}

function versionConsts(text) {
  const get = name => new RegExp(`const\\s+${name}\\s*=\\s*['"]([^'"]+)['"]`).exec(text || '')?.[1] || null
  return { launcher: get('LATEST_VERSION'), clientLabel: get('CLIENT_VERSION') }
}

function isTrustedVerdict(r) {
  if (!r || r.trusted !== true || r.loginUid !== 0 || r.realUser !== 'root' || !REVIEWERS.has(r.by)) return false
  if (r.verdict !== 'GO' && r.verdict !== 'NO-GO') return false
  // A line without a base would cover every ancestor of its tip
  if (r.repo === 'fork' || r.repo === 'server') return SHA_RE.test(r.tip) && SHA_RE.test(r.base)
  if (r.repo === 'client') return VERSION_RE.test(r.tip)
  if (r.repo === 'item') return ITEM_ID_RE.test(r.tip)
  return false
}

const verdictOf = r => ({ state: r.verdict, by: r.by, at: isoOrNull(r.at) })
const NO_REVIEW = Object.freeze({ state: 'none', by: null, at: null })

const isSecretFile = file => SECRET_RE.test(path.basename(String(file)))

// fn over list, size calls at a time, results in list order
async function inBatches(list, size, fn) {
  const out = []
  for (let i = 0; i < list.length; i += size) out.push(...await Promise.all(list.slice(i, i + size).map(fn)))
  return out
}

function refused(sub) {
  return Object.assign(new Error(`git ${String(sub)} is not allowed`), { code: 'gitNotAllowed' })
}

// The allowlist, none of the refused options, no path outside the repo, and only refs after --end-of-options
function checkGitArgs(args) {
  const sub = args[0]
  if (!GIT_ALLOWED.includes(sub)) throw refused(sub)
  if (args.some(a => typeof a !== 'string' || GIT_REFUSED_RE.test(a) || OUTSIDE_RE.test(a))) throw refused(sub)
  const eoo = args.indexOf('--end-of-options')
  if (eoo !== -1) {
    const end = args.indexOf('--', eoo)
    if (args.slice(eoo + 1, end === -1 ? undefined : end).some(a => !REF_RE.test(a))) throw refused(sub)
  }
  return sub
}

// Only what git needs, so no backend secret reaches the child and no user config is read
function gitEnv() {
  return { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', LANG: 'C', HOME: '/nonexistent', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }
}

// safe.directory lets a non-root backend read the root-owned checkout; no hooks, no transport and no replace refs, whatever the repo config says
const gitArgv = (repo, args) => ['-C', repo, '-c', `safe.directory=${repo}`, '-c', 'core.quotePath=false', '-c', 'core.fsmonitor=false',
  '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.allow=never', '--no-replace-objects', ...args]

// A missing file is normal; any other read error (EACCES as a non-root user) is logged once per file until it clears.
// A stat failure is cleared by the next stat that works; a read failure only by a read that works, since a file can be
// stat-able and still unreadable.
function readErrors(tag) {
  const failing = new Map()
  return {
    note(file, err, stage = 'read') {
      const code = err?.code || 'error'
      if (code === 'ENOENT' || code === 'ENOTDIR') return void failing.delete(file)
      if (failing.get(file)?.code !== code) console.warn(`[${tag}] cannot read ${file}: ${code}`)
      failing.set(file, { code, stage })
    },
    clear(file, stage) {
      if (!stage || failing.get(file)?.stage === stage) failing.delete(file)
    },
    codes: () => [...new Set([...failing.values()].map(f => f.code))].sort(),
  }
}

const canExec = file => { try { nodeFs.accessSync(file, nodeFs.constants.X_OK); return true } catch { return false } }

// nice and ionice, where they are on PATH, so git yields to the game and its build; -t runs git even if the class cannot be set.
// The lowest best-effort IO priority, not the idle class, which can starve git outright while a build keeps the disk busy
function priorityPrefix(pathEnv = process.env.PATH, isExec = canExec) {
  const has = name => String(pathEnv || '').split(':').some(dir => dir && isExec(path.join(dir, name)))
  return [...(has('nice') ? ['nice', '-n', '10'] : []), ...(has('ionice') ? ['ionice', '-c2', '-n7', '-t'] : [])]
}
const PRIORITY = priorityPrefix()

// The checkout as git sees it (absolute, no trailing slash, symlinks resolved), so safe.directory matches it exactly
function repoPath(repo, fsMod = nodeFs) {
  if (!repo) return repo
  const abs = path.resolve(String(repo))
  try { return fsMod.realpathSync(abs) } catch { return abs }
}

// The file and argv of a guarded git call
function gitCommand(repo, args, prefix = PRIORITY) {
  const argv = gitArgv(repo, args)
  return prefix.length ? [prefix[0], [...prefix.slice(1), 'git', ...argv]] : ['git', argv]
}

// The same guarded call, synchronously, for the one read the backend makes while it starts
function gitSync(repo, args, { runSync = childProcess.execFileSync } = {}) {
  if (checkGitArgs(args) === 'merge-tree') throw refused('merge-tree')
  return String(runSync(...gitCommand(repoPath(repo), args), { env: gitEnv(), timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, stdio: ['ignore', 'pipe', 'ignore'] }))
}

function createReleaseQueue({ run = runFile, fs = nodeFs, now = Date.now, fetch = globalThis.fetch, config, services = async () => ({}), deadlineMs = QUEUE_DEADLINE_MS }) {
  const fsp = fs.promises
  const repo = repoPath(config.releaseRepo, fs)
  const control = config.controlDir
  const backendDir = path.join(repo, 'skymp5-backend')
  const gameDir = config.gameServerDir
  const processStart = now() - process.uptime() * 1000
  const memo = new Map()
  const files = new Map()
  // Unknown range tips, each with the FETCH_HEAD mtime it was unknown at
  const unknownAt = new Map()
  const unreadable = readErrors('release-queue')
  let fetchStamp = 0
  // The running queue build's deadline, carried into every git call it starts, including ones still running after it failed
  const buildScope = new AsyncLocalStorage()

  // ---- git ----

  async function git(args, { input, codes = [0] } = {}) {
    const sub = checkGitArgs(args)
    const deadline = buildScope.getStore()?.deadline
    const timeout = deadline == null ? GIT_TIMEOUT_MS : Math.min(GIT_TIMEOUT_MS, Math.floor(deadline - performance.now()))
    if (timeout <= 0) throw Object.assign(new Error(`git ${sub} not started: the queue build ran out of time`), { code: 'unavailable', exitCode: null, timedOut: true })
    const env = gitEnv()
    let scratch = null
    if (sub === 'merge-tree') {
      env.GIT_ALTERNATE_OBJECT_DIRECTORIES = await objectsDir()
      scratch = await fsp.mkdtemp(path.join(config.scratchDir || os.tmpdir(), 'dbo-merge-'))
      env.GIT_OBJECT_DIRECTORY = scratch
    }
    try {
      const { stdout } = await run(...gitCommand(repo, args), { env, input, timeout, maxBuffer: GIT_MAX_BUFFER })
      return { code: 0, stdout: String(stdout) }
    } catch (err) {
      if (Number.isInteger(err.code) && codes.includes(err.code)) return { code: err.code, stdout: String(err.stdout || '') }
      throw Object.assign(new Error(`git ${sub} failed`), { code: 'unavailable', exitCode: err.code ?? null, timedOut: !!err.killed })
    } finally {
      if (scratch) await fsp.rm(scratch, { recursive: true, force: true })
    }
  }

  const gitText = async (...args) => (await git(args)).stdout

  // Answers about immutable commits; a failed lookup is not remembered
  async function remember(key, fn) {
    if (memo.has(key)) return memo.get(key)
    if (memo.size > 20000) memo.clear()
    const p = fn()
    memo.set(key, p)
    try { return await p } catch (err) { memo.delete(key); throw err }
  }

  const gitPath = name => remember(`path:${name}`, async () => (await gitText('rev-parse', '--path-format=absolute', '--git-path', name)).trim())
  const objectsDir = () => gitPath('objects')

  async function resolve(ref) {
    const { code, stdout } = await git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], { codes: [0, 1, 128] })
    return code === 0 && SHA_RE.test(stdout.trim()) ? stdout.trim() : null
  }

  // An unknown commit is no ancestor, and that answer is not remembered
  async function isAncestor(a, b) {
    if (!a || !b) return false
    const key = `anc:${a}:${b}`
    if (memo.has(key)) return memo.get(key)
    const { code } = await git(['merge-base', '--is-ancestor', '--end-of-options', a, b], { codes: [0, 1, 128] })
    if (code !== 128) memo.set(key, code === 0)
    return code === 0
  }

  // Commits of tip not reachable from base, at most 1000; an unknown commit gives none until the next fetch, and a timeout throws
  async function rangeOf(tip, base) {
    const key = `range:${tip}:${base}`
    if (unknownAt.get(key) === fetchStamp) return new Set()
    try {
      return await remember(key, async () => {
        const { code, stdout } = await git(['rev-list', '-n', '1000', '--end-of-options', tip, ...(base ? [`^${base}`] : [])], { codes: [0, 128] })
        if (code !== 0) throw Object.assign(new Error('unknown commit'), { code: 'unknownCommit' })
        return new Set(stdout.split('\n').filter(Boolean))
      })
    } catch (err) {
      if (err.code !== 'unknownCommit') throw err
      if (unknownAt.size > 20000) unknownAt.clear()
      unknownAt.set(key, fetchStamp)
      return new Set()
    }
  }

  // ---- files (never a secret) ----

  function guard(file) {
    if (isSecretFile(file)) throw Object.assign(new Error('refused to open a secret file'), { code: 'secretFile' })
  }

  async function statOf(file) {
    let st
    try { st = await fsp.stat(file) } catch (err) { unreadable.note(file, err, 'stat'); return null }
    unreadable.clear(file, 'stat')
    return st
  }
  const mtimeOf = async file => (await statOf(file))?.mtimeMs || 0

  // length bytes from start, or fewer at the end of the file
  async function readRange(file, start, length) {
    const fh = await fsp.open(file, 'r')
    try {
      const buf = Buffer.alloc(length)
      let got = 0
      for (let n = -1; got < length && n !== 0; got += n) n = (await fh.read(buf, got, length - got, start + got)).bytesRead
      return buf.subarray(0, got)
    } finally { await fh.close() }
  }

  // Read once per change of mtime and size: the whole file up to max bytes, or its last tail bytes from a line start; missing or larger gives null
  async function cachedRead(file, parse, { tail, max = FILE_MAX_BYTES } = {}) {
    guard(file)
    const st = await statOf(file)
    if (!st || !st.isFile()) { files.delete(file); return null }
    const stamp = `${st.mtimeMs}:${st.size}`
    const hit = files.get(file)
    if (hit && hit.stamp === stamp) return hit.value
    if (!tail && st.size > max) { unreadable.note(file, { code: 'EFBIG' }); files.set(file, { stamp, value: null }); return null }
    const start = tail && st.size > tail ? st.size - tail : 0
    let buf
    try { buf = await readRange(file, start, st.size - start) } catch (err) { unreadable.note(file, err); files.delete(file); return null }
    if (start) buf = buf.subarray(buf.indexOf(10) + 1)
    unreadable.clear(file)
    let value = null
    try { value = parse(buf) } catch { value = null }
    files.set(file, { stamp, value })
    return value
  }

  const readJson = (file, opts) => cachedRead(file, buf => JSON.parse(buf.toString('utf8')), opts)
  const readJsonLines = file => cachedRead(file, buf => buf.toString('utf8').split('\n').slice(-20000)
    .map(l => { try { return JSON.parse(l) } catch { return null } }).filter(v => v && typeof v === 'object'), { tail: TAIL_BYTES }).then(v => v || [])

  function hashFile(file) {
    guard(file)
    return new Promise((res, rej) => {
      const h = crypto.createHash('sha256')
      fs.createReadStream(file).on('data', d => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej)
    })
  }

  // sha256 of a regular file, again only when its mtime or size changes; a failed hash is not cached, since a chmod
  // that fixes it moves neither
  async function cachedHash(file) {
    guard(file)
    const key = `hash:${file}`
    const st = await statOf(file)
    if (!st || !st.isFile()) { files.delete(key); return null }
    const stamp = `${st.mtimeMs}:${st.size}`
    const hit = files.get(key)
    if (hit && hit.stamp === stamp) return hit.value
    let value
    try { value = await hashFile(file) } catch (err) { unreadable.note(file, err); files.delete(key); return null }
    unreadable.clear(file)
    files.set(key, { stamp, value })
    return value
  }

  async function listDir(dir) {
    let names
    try { names = await fsp.readdir(dir) } catch (err) { unreadable.note(dir, err); return [] }
    unreadable.clear(dir)
    return names
  }

  // ---- live (2.9) ----

  function validLive(r) {
    if (!r || r.v !== 1 || !SHA_RE.test(r.fork?.sha)) return null
    const s = r.server || {}, c = r.client || {}, n = r.news || {}
    return {
      fork: { sha: r.fork.sha, since: isoOrNull(r.fork.since), how: cleanText(r.fork.how, 20) || null },
      server: { sha: SHA_RE.test(s.sha) ? s.sha : null, since: isoOrNull(s.since), how: cleanText(s.how, 20) || null },
      client: {
        version: VERSION_RE.test(c.version) ? c.version : null, zipSha256: SHA256_RE.test(c.zipSha256) ? c.zipSha256 : null,
        fork: SHA_RE.test(c.fork) ? c.fork : null, how: cleanText(c.how, 20) || null, since: isoOrNull(c.since),
      },
      news: { sha256: SHA256_RE.test(n.sha256) ? n.sha256 : null, since: isoOrNull(n.since) },
      extras: typeof r.extras?.version === 'string' ? { version: cleanText(r.extras.version, 64) } : null,
      relId: typeof r.relId === 'string' && /^(?:rel|manual)-[\w-]{1,60}$/.test(r.relId) ? r.relId : null,
    }
  }

  async function updaterLog() {
    const read = file => cachedRead(file, buf => buf.toString('utf8'), { tail: TAIL_BYTES }).then(t => t || '')
    const [rotated, current] = await Promise.all([read(`${config.updaterLog}.1`), read(config.updaterLog)])
    return parseUpdaterLog(`${rotated}\n${current}`)
  }

  // u is the update that should have installed forkSha: the last one, or the one before a run that never restarted
  function confirmation(log, forkSha, skympSince, u) {
    const last = log.updates.at(-1)
    if (!last) return { confirmed: null, okAt: null, lastUpdate: { from: null, to: null, state: 'unknown', at: null, okAt: null, failed: null } }
    const lastUpdate = { from: last.from, to: last.to, state: last.okAt ? 'ok' : 'unfinished', at: last.at, okAt: last.okAt, failed: last.failed }
    if (!u || !forkSha || !forkSha.startsWith(u.to)) return { confirmed: null, okAt: null, lastUpdate }
    if (!u.okAt) return { confirmed: false, okAt: null, lastUpdate }
    if (skympSince == null) return { confirmed: null, okAt: u.okAt, lastUpdate }
    return { confirmed: skympSince >= Date.parse(u.restartingAt || u.at), okAt: u.okAt, lastUpdate }
  }

  // Top-level deployable files of a server commit, name -> blob id
  function deployableBlobs(sha) {
    return remember(`deploy:${sha}`, async () => {
      const out = await gitText('ls-tree', '-z', '--end-of-options', sha)
      const blobs = new Map()
      for (const entry of out.split('\0')) {
        const m = /^\d+ blob ([0-9a-f]{40})\t(.+)$/.exec(entry)
        if (m && isDeployable(m[2]) && !SECRET_RE.test(m[2]) && /^[\w. -]+$/.test(m[2])) blobs.set(m[2], m[1])
      }
      return blobs
    })
  }

  const blobConfigId = oid => remember(`cfg:${oid}`, async () => configId(Buffer.from(await gitText('cat-file', 'blob', '--end-of-options', oid), 'utf8')))

  // Identity of a live gameplay file: its blob id, with the stamp stripped and gamemode-config.json without admins
  async function liveFileId(name) {
    const file = path.join(gameDir, name === 'gamemode.js' ? 'dbo-gamemode.js' : name)
    return cachedRead(file, buf => {
      if (name === 'gamemode.js') { const s = stripStamp(buf); return { id: blobId(s.body), stampAt: s.at, stampSha: s.sha } }
      if (name === 'gamemode-config.json') return { id: configId(buf) }
      return { id: blobId(buf) }
    }, { max: DATA_MAX_BYTES })
  }

  async function matchesLive(sha, ids) {
    const blobs = await deployableBlobs(sha)
    if (!blobs.has('gamemode.js')) return false
    for (const [name, oid] of blobs) {
      if (!ids.has(name)) ids.set(name, liveFileId(name))
      const live = await ids.get(name)
      if (!live) return false
      if (live.id !== (name === 'gamemode-config.json' ? await blobConfigId(oid) : oid)) return false
    }
    return true
  }

  // Stamp, then the recorded commit, then the newest match; recordMatches compares content, as a docs commit deploys the same files
  async function liveGameplay(serverTip, recordSha) {
    const gm = await liveFileId('gamemode.js')
    if (!gm) return { sha: null, how: 'unknown', deployedAt: null, recordMatches: false }
    const ids = new Map()
    const recordMatches = !!recordSha && await matchesLive(recordSha, ids).catch(() => false)
    const found = (sha, how) => ({ sha, how, deployedAt: gm.stampAt, recordMatches })
    if (gm.stampSha && await matchesLive(gm.stampSha, ids).catch(() => false)) return found(gm.stampSha, 'stamp')
    if (recordMatches) return found(recordSha, 'matched')
    if (!serverTip) return found(null, 'unknown')
    const out = await gitText('rev-list', '--first-parent', '-n', String(CONTENT_MATCH_DEPTH), '--end-of-options', serverTip)
    for (const sha of out.split('\n').filter(Boolean)) if (await matchesLive(sha, ids)) return found(sha, 'matched')
    return found(null, 'modified')
  }

  async function pluginsState(forkSha) {
    const disk = await cachedRead(path.join(config.skyrimDataDir || '/opt/skyrim-data', 'SHA256SUMS'), buf => buf.toString('utf8'))
    const { code, stdout } = await git(['show', '--end-of-options', `${forkSha}:deploy/skyrim-data/SHA256SUMS`], { codes: [0, 128] })
    if (disk == null || code !== 0) return 'unknown'
    const norm = t => t.split('\n').map(l => l.trim()).filter(Boolean).sort().join('\n')
    return norm(disk) === norm(stdout) ? 'match' : 'differ'
  }

  // Backend runtime files changed between the commit the backend started from and the live fork
  async function restartPending(bootSha, forkSha) {
    if (!SHA_RE.test(bootSha || '') || !forkSha) return null
    if (bootSha === forkSha) return false
    return remember(`boot:${bootSha}:${forkSha}`, async () => {
      const out = await gitText('diff', '--no-ext-diff', '--name-only', '-z', '--end-of-options', bootSha, forkSha, '--', 'skymp5-backend/')
      const changed = out.split('\0').filter(Boolean)
      const { flags } = classifyCommit('fork', changed)
      return changed.length > 0 && (flags.includes('backendRestart') || flags.includes('backendDeps'))
    }).catch(() => null)
  }

  async function live(opts = {}) {
    const svc = { backendSince: processStart, ...(await services().catch(() => ({}))), ...opts }
    const record = validLive(await readJson(path.join(control, 'live.json')))
    const [head, mainSha, serverSha, liveRef, log] = await Promise.all([
      resolve('HEAD'), resolve('origin/main'), resolve('origin/server'), resolve('origin/live'), updaterLog(),
    ])
    if (!head) throw Object.assign(new Error('release repo unavailable'), { code: 'unavailable' })
    // Without live.json HEAD is live, unless the last updates failed before the restart
    const pending = record ? null : notRestarted(log.updates, head)
    const running = pending && await resolve(pending.from)
    const forkSha = record?.fork.sha || running || head
    const drift = new Set()
    if (record && head !== forkSha) drift.add('headNotLive')
    const installer = running ? log.updates[pending.index - 1] || null : log.updates.at(-1)
    const { confirmed, okAt, lastUpdate } = confirmation(log, forkSha, svc.skympSince, installer)
    if (lastUpdate.state === 'unfinished') drift.add('lastUpdateUnfinished')

    const forkInfo = (await git(['log', '-1', '--format=%s%x00%cI', '--end-of-options', forkSha], { codes: [0, 128] })).stdout.split('\0')
    const gameplay = await liveGameplay(serverSha, record?.server.sha)
    if (gameplay.how === 'modified') drift.add('gameplayModified')
    else if (record?.server.sha && gameplay.sha && !gameplay.recordMatches) drift.add('gameplayOutsideRelease')

    const [served, disk, newsHash, extras, plugins] = await Promise.all([
      readJson(path.join(backendDir, 'data', 'files-version.json')),
      cachedRead(path.join(backendDir, 'routes', 'version.js'), buf => versionConsts(buf.toString('utf8'))),
      cachedHash(path.join(backendDir, 'data', 'news.live.json')),
      readJson(path.join(backendDir, 'data', 'extra-files.json'), { max: DATA_MAX_BYTES }),
      pluginsState(forkSha),
    ])
    const version = VERSION_RE.test(served?.version) ? served.version : null
    const client = { version, builtAt: isoOrNull(served?.builtAt), fork: record?.client.fork || null, sourceOnMain: null, zipMatches: null }
    if (record?.client.version) {
      if (record.client.zipSha256) client.zipMatches = (await cachedHash(path.join(config.clientFilesDir, config.clientZipName || 'skymp-client.zip'))) === record.client.zipSha256
      if (version !== record.client.version || client.zipMatches === false) drift.add('clientOutsideRelease')
    }
    if (client.fork && mainSha) client.sourceOnMain = await isAncestor(client.fork, mainSha)
    if (client.sourceOnMain === false) drift.add('clientSourceNotOnMain')
    const news = { matches: record ? (record.news.sha256 || null) === (newsHash || null) : null }
    if (news.matches === false) drift.add('newsOutsideRelease')
    if (record && extras && (record.extras ? record.extras.version !== extras.version
      : record.client.since && Date.parse(extras.builtAt) > Date.parse(record.client.since))) drift.add('extrasChanged')
    if (plugins === 'differ') drift.add('pluginsDiffer')
    const settingsAt = await mtimeOf(path.join(gameDir, 'server-settings.json'))
    const envAt = await mtimeOf(config.backendEnvFile || '/opt/dragonbreak/backend.env')
    // Service start times have whole seconds, so a write in that same second is not a change
    const after = (mtime, since) => since != null && mtime >= since + 1000
    if (after(settingsAt, svc.skympSince) || after(envAt, svc.backendSince)) drift.add('configChangedSinceStart')
    if (disk?.clientLabel && version && disk.clientLabel !== version) drift.add('versionLabelStale')

    return {
      source: record ? 'live.json' : 'derived',
      record,
      fork: {
        sha: forkSha, subject: cleanText(forkInfo[0], 120) || null, at: isoOrNull(forkInfo[1]?.trim()), confirmed, headMatches: head === forkSha, head,
        since: record?.fork.since || (confirmed ? isoOrNull(okAt) : null),
      },
      lastUpdate,
      lastRun: log.lastRun,
      server: { sha: gameplay.sha, how: gameplay.how, deployedAt: gameplay.deployedAt, base: record?.server.sha || gameplay.sha },
      client,
      news,
      launcher: disk?.launcher || null,
      clientLabel: disk?.clientLabel || null,
      // Without live.json the backend files on disk are HEAD's, even while a failed build leaves the game on an older commit
      backend: { bootSha: SHA_RE.test(svc.bootSha || '') ? svc.bootSha : null, restartPending: await restartPending(svc.bootSha, record ? forkSha : head) },
      website: web.result ? { matching: web.result.matching, total: web.result.total, checkedAt: web.result.checkedAt } : null,
      plugins,
      githubLive: liveRef ? (liveRef === forkSha ? 'inSync' : 'behind') : 'unknown',
      drift: DRIFT_ORDER.filter(c => drift.has(c)),
      tips: { main: mainSha, server: serverSha },
    }
  }

  // ---- queue sources (2.3) ----

  async function commitsBetween(side, base, tip) {
    if (!tip || !base) return { commits: [], total: 0 }
    const [log, count] = await Promise.all([
      gitText('log', '--topo-order', '-n', String(MAX_COMMITS), '--name-only', `--format=${LOG_FORMAT}`, '--end-of-options', tip, `^${base}`),
      gitText('rev-list', '--count', '--end-of-options', tip, `^${base}`),
    ])
    return { commits: parseLog(log, side), total: Number(count.trim()) || 0 }
  }

  async function loadHeld() {
    const doc = await readJson(path.join(control, 'queue', 'held.json'))
    return (Array.isArray(doc?.ranges) ? doc.ranges : []).filter(r => r && typeof r === 'object').map(r => ({
      repo: r.repo, base: SHA_RE.test(r.base) ? r.base : null, tip: typeof r.tip === 'string' ? r.tip : '', reason: cleanText(r.reason, 200) || 'held',
    })).filter(r => ((r.repo === 'fork' || r.repo === 'server') && SHA_RE.test(r.tip)) || (r.repo === 'client' && VERSION_RE.test(r.tip)) || (r.repo === 'item' && ITEM_ID_RE.test(r.tip)))
  }

  function validItem(doc, name) {
    if (!doc || doc.v !== 1 || !ITEM_ID_RE.test(doc.id) || `${doc.id}.json` !== name) return null
    if (Object.keys(doc).some(k => !ITEM_FIELDS.has(k))) return null
    if (!(doc.area in ITEM_AREAS) || !['queued', 'held', 'applied', 'dropped'].includes(doc.state)) return null
    if (doc.flags != null && (!Array.isArray(doc.flags) || doc.flags.some(f => !ITEM_FLAGS.has(f)))) return null
    if (doc.keys != null && (!Array.isArray(doc.keys) || doc.keys.some(k => typeof k !== 'string' || !/^[\w.-]{1,64}$/.test(k)))) return null
    return {
      id: doc.id, area: doc.area, title: cleanText(doc.title, 120) || doc.id, author: cleanText(doc.author, 60) || null,
      at: isoOrNull(doc.createdAt), applyBy: cleanText(doc.applyBy, 60) || null, flags: [...new Set(doc.flags || [])].sort(),
      keys: doc.keys || [], state: doc.state,
    }
  }

  async function loadItems() {
    const dir = path.join(control, 'queue', 'items')
    const names = (await listDir(dir)).filter(n => ITEM_FILE_RE.test(n)).sort().slice(0, MAX_ITEMS)
    const items = []
    let refusedCount = 0
    for (const name of names) {
      const item = validItem(await readJson(path.join(dir, name)), name)
      if (!item) refusedCount++
      else if (item.state === 'queued' || item.state === 'held') items.push(item)
    }
    return { items, refused: refusedCount }
  }

  function validBuild(doc, version) {
    if (!doc || doc.version !== version || !SHA_RE.test(doc.fork) || !SHA256_RE.test(doc.zipSha256)) return null
    return { version, fork: doc.fork, zipSha256: doc.zipSha256, builtAt: isoOrNull(doc.builtAt), builtBy: cleanText(doc.builtBy, 60) || null, builtOn: cleanText(doc.builtOn, 60) || null }
  }

  // Staged packs (Phase 2 folder first, then the handover folders), newest version first
  async function loadPacks() {
    const found = new Map()
    const sources = [
      [path.join(control, 'staged', 'client'), n => (VERSION_RE.test(n) ? n : null)],
      [config.handoverDir, n => /^client-(\d+\.\d+\.\d+)$/.exec(n)?.[1] || null],
    ]
    for (const [dir, versionOf] of sources) {
      for (const name of (await listDir(dir)).sort()) {
        const version = versionOf(name)
        if (!version || found.has(version)) continue
        const pack = validBuild(await readJson(path.join(dir, name, 'BUILD.json')), version)
        if (pack) found.set(version, pack)
      }
    }
    return [...found.values()].sort((a, b) => semverCmp(b.version, a.version))
  }

  async function packStamps() {
    const out = []
    for (const [dir, re] of [[path.join(control, 'staged', 'client'), VERSION_RE], [config.handoverDir, /^client-\d+\.\d+\.\d+$/]]) {
      out.push(await mtimeOf(dir))
      for (const name of (await listDir(dir)).filter(n => re.test(n)).sort()) out.push(name, await mtimeOf(path.join(dir, name, 'BUILD.json')))
    }
    return out
  }

  async function blockers(liveInfo) {
    const out = []
    if (liveInfo.tips.main && !(await isAncestor(liveInfo.fork.sha, liveInfo.tips.main))) out.push('liveNotOnMain')
    if (await statOf(path.join(control, 'release', 'request.json'))) out.push('openRelease')
    const status = await gitText('status', '--porcelain', '-z', '--untracked-files=no')
    const dirty = status.split('\0').filter(e => /^.. /.test(e)).map(e => e.slice(3))
    if (dirty.length) out.push('dirtyTree')
    return { codes: out, dirty: { count: dirty.length, rolePermissionsOnly: dirty.length > 0 && dirty.every(f => f === 'skymp5-backend/data/role-permissions.json') } }
  }

  // Patch ids of non-merge commits, in batches; a batch over the buffer falls back to one commit at a time
  // --verbatim keeps whitespace, so a copy that differs only in spacing is a different change
  async function patchIds(shas) {
    const todo = [...new Set(shas)].filter(s => !memo.has(`pid:${s}`))
    const one = async batch => {
      const patch = await gitText('log', '-p', '--no-walk=unsorted', '--no-color', '--no-ext-diff', '--no-textconv', '--format=commit %H', '--end-of-options', ...batch)
      const ids = new Map()
      for (const line of (await git(['patch-id', '--verbatim'], { input: patch })).stdout.split('\n')) {
        const [pid, sha] = line.split(' ')
        if (sha) ids.set(sha, pid)
      }
      return ids
    }
    for (let i = 0; i < todo.length; i += 25) {
      const batch = todo.slice(i, i + 25)
      let ids = await one(batch).catch(() => null)
      if (!ids) {
        ids = new Map()
        for (const s of batch) for (const [k, v] of await one([s]).catch(() => new Map())) ids.set(k, v)
      }
      for (const s of batch) memo.set(`pid:${s}`, Promise.resolve(ids.get(s) || null))
    }
    const out = new Map()
    for (const s of shas) out.set(s, await memo.get(`pid:${s}`))
    return out
  }

  // A merge check that times out counts as not clean for this build, is counted in its warnings and is asked again next time
  const cleanMerge = c => remember(`merge:${c.sha}`, async () => {
    if (c.parents.length !== 2) return false
    const { code, stdout } = await git(['merge-tree', '--write-tree', '--end-of-options', ...c.parents], { codes: [0, 1] })
    if (code !== 0) return false
    return stdout.split('\n')[0].trim() === (await gitText('rev-parse', '--verify', '--end-of-options', `${c.sha}^{tree}`)).trim()
  }).catch(err => {
    if (!err.timedOut) throw err
    const scope = buildScope.getStore()
    if (scope) scope.mergeTimeouts = (scope.mergeTimeouts || 0) + 1
    return false
  })

  // Review state of each commit on one side (2.6): latest trusted verdict, clean merges, same change as a GO
  async function reviewCommits(side, commits, liveBase, lines) {
    const byId = new Map(commits.map(c => [c.sha, c]))
    const mine = lines.filter(r => r.repo === side)
    const ranges = await inBatches(mine, 4, r => rangeOf(r.tip, r.base))
    const latest = new Map()
    mine.forEach((r, i) => { for (const sha of ranges[i]) latest.set(sha, r) })
    for (const c of commits) c.review = latest.has(c.sha) ? verdictOf(latest.get(c.sha)) : NO_REVIEW
    const open = commits.filter(c => c.review === NO_REVIEW && c.parents.length === 1)
    if (open.length && mine.some(r => r.verdict === 'GO')) {
      // Newest lines first, so the oldest reviews are the ones left out of the patch-id budget
      const candidates = mine.flatMap((r, i) => [...ranges[i]].reverse().filter(sha => latest.get(sha) === r && r.verdict === 'GO' && !(byId.get(sha)?.parents.length > 1)))
        .reverse().slice(0, 600)
      const ids = await patchIds([...candidates, ...open.map(c => c.sha)])
      const byPatch = new Map()
      for (const sha of candidates) if (ids.get(sha) && !byPatch.has(ids.get(sha))) byPatch.set(ids.get(sha), sha)
      for (const c of open) {
        const same = ids.get(c.sha) && byPatch.get(ids.get(c.sha))
        if (same && same !== c.sha) c.review = { ...verdictOf(latest.get(same)), state: 'sameChange', sameAs: short(same) }
      }
    }
    // Merges last, oldest first, so a parent reviewed as the same change or as a clean merge counts
    for (const c of [...commits].reverse()) {
      if (c.parents.length < 2 || c.review !== NO_REVIEW) continue
      let parentsOk = true
      for (const p of c.parents) {
        const reviewed = byId.has(p) ? REVIEWED.has(byId.get(p).review.state) : await isAncestor(p, liveBase)
        if (!reviewed) { parentsOk = false; break }
      }
      if (parentsOk && await cleanMerge(c)) c.review = { state: 'GO', by: null, at: null, cleanMerge: true }
    }
  }

  async function markHeld(side, commits, held) {
    for (const c of commits) { c.held = false; c.heldReason = null }
    const byId = new Map(commits.map(c => [c.sha, c]))
    for (const r of held.filter(h => h.repo === side)) {
      for (const sha of await rangeOf(r.tip, r.base)) {
        const c = byId.get(sha)
        if (c && !c.held) Object.assign(c, { held: true, heldReason: r.reason })
      }
    }
  }

  // First-parent chain from the tip down to live, oldest first; null when the listing was cut short
  function chainOf(model) {
    const chain = []
    for (let c = model.byId.get(model.tip); c; c = model.byId.get(c.parents[0])) chain.push(c)
    if (model.total > model.commits.length) return null
    return chain.reverse()
  }

  function newlyCovered(model, f, covered) {
    const fresh = new Map(), stack = [f]
    while (stack.length) {
      const c = stack.pop()
      if (covered.has(c.sha) || fresh.has(c.sha)) continue
      fresh.set(c.sha, c)
      for (const p of c.parents) if (model.byId.has(p)) stack.push(model.byId.get(p))
    }
    return [...fresh.values()]
  }

  // Default target (2.8): the last first-parent commit with everything up to it reviewed, not held and not NO-GO
  function walk(model, ok = () => true) {
    const covered = new Set()
    let target = null, stop = null
    for (const f of chainOf(model) || []) {
      const fresh = newlyCovered(model, f, covered)
      stop = fresh.filter(c => c.held || !REVIEWED.has(c.review.state) || !ok(c)).sort((a, b) => model.order.get(a.sha) - model.order.get(b.sha))[0] || null
      if (stop) break
      for (const c of fresh) covered.add(c.sha)
      target = f.sha
    }
    return { target, covered, stop: stop && stopOf(stop) }
  }

  // The earliest commit that stops the walk; merges and docs are not listed, so the page names them from here
  function stopOf(c) {
    const kind = c.parents.length > 1 ? 'merge' : c.cls.area === 'Docs' ? 'docs' : 'commit'
    const reason = c.held ? 'held' : c.review.state === 'NO-GO' ? 'blocked' : REVIEWED.has(c.review.state) ? 'needsFork' : 'notReviewed'
    return { short: short(c.sha), kind, reason }
  }

  // Each commit's first-parent step (the first-parent commit that ships it) and its place in shipping order
  function shipSteps(model) {
    const covered = new Set(), step = new Map(), order = new Map()
    const topo = new Map(model.commits.map((c, i) => [c.sha, i]))
    for (const f of chainOf(model) || []) {
      for (const c of newlyCovered(model, f, covered).sort((a, b) => topo.get(b.sha) - topo.get(a.sha))) {
        covered.add(c.sha)
        step.set(c.sha, f.sha)
        order.set(c.sha, order.size)
      }
    }
    for (const c of [...model.commits].reverse()) if (!order.has(c.sha)) order.set(c.sha, order.size)
    return { step, order }
  }

  async function requiresFork(c) {
    const m = /^([0-9a-f]{7,40})\b/.exec(trailer(c, 'requires-fork') || '')
    return m ? (await resolve(m[1])) || m[1] : null
  }

  function toRow(c, inDefault) {
    return {
      kind: 'commit', repo: c.side, id: c.sha, short: short(c.sha), title: commitTitle(c.subject), ...commitAuthor(c), at: c.at,
      review: c.review, flags: c.cls.flags, warnings: c.cls.warnings, held: c.held, heldReason: c.heldReason, blocked: c.review.state === 'NO-GO',
      inDefault, revertOf: c.revertOf || null, reverted: !!c.reverted, requiresFork: c.requiresFork ? short(c.requiresFork) : null,
      requiresForkMet: c.requiresFork ? !!c.requiresForkMet : null,
    }
  }

  const outsideRow = c => ({ short: short(c.sha), title: commitTitle(c.subject), ...commitAuthor(c), at: c.at })

  async function launcherOutside(mainSha, launcherVersion) {
    let tag = VERSION_RE.test(launcherVersion || '') && await resolve(`refs/tags/launcher-v${launcherVersion}`)
    if (!tag) {
      const newest = (await gitText('for-each-ref', '--sort=-v:refname', '--count=1', '--format=%(objectname)', '--end-of-options', 'refs/tags/launcher-v*')).trim()
      tag = newest && await resolve(newest)
    }
    if (!tag || !mainSha) return null
    const [log, count] = await Promise.all([
      gitText('log', '-n', '50', `--format=${LOG_FORMAT}`, '--end-of-options', mainSha, `^${tag}`, '--', 'skymp5-launcher/'),
      gitText('rev-list', '--count', '--end-of-options', mainSha, `^${tag}`, '--', 'skymp5-launcher/'),
    ])
    const items = parseLog(log, 'fork').map(outsideRow)
    return { area: 'Launcher', why: 'no launcher build has shipped these yet', count: Number(count.trim()) || 0, items }
  }

  // Remote branches with changes on neither main nor server, counted by content with git cherry
  async function branchesNotMerged(mainSha, serverSha) {
    const out = await gitText('for-each-ref', '--format=%(refname:lstrip=3)%00%(objectname)', '--end-of-options', 'refs/remotes/origin/')
    const branches = out.split('\n').map(l => l.split('\0')).filter(([b, sha]) => b && SHA_RE.test(sha) && BRANCH_RE.test(b) && !['HEAD', 'main', 'server', 'live'].includes(b))
    const results = await inBatches(branches, 4, async ([branch, sha]) => {
      const shared = async up => up && (await remember(`base:${up}:${sha}`, async () =>
        (await git(['merge-base', '--end-of-options', up, sha], { codes: [0, 1] })).code === 0))
      const up = (await shared(mainSha)) ? mainSha : (await shared(serverSha)) ? serverSha : null
      if (!up) return null
      const unique = await remember(`cherry:${up}:${sha}`, async () =>
        (await gitText('cherry', '--end-of-options', up, sha)).split('\n').filter(l => l.startsWith('+')).length)
      return unique ? { branch, uniqueCommits: unique, upstream: up === mainSha ? 'main' : 'server', unowned: branch.startsWith('claude/') } : null
    })
    return results.filter(Boolean).slice(0, 50)
  }

  async function versionLines(forkTarget, forkLive, disk, packVersion) {
    if (!forkTarget || forkTarget === forkLive) return []
    const { code, stdout } = await git(['show', '--end-of-options', `${forkTarget}:skymp5-backend/routes/version.js`], { codes: [0, 128] })
    if (code !== 0) return []
    const next = versionConsts(stdout), lines = []
    if (next.launcher && next.launcher !== disk?.launcher) lines.push({ name: 'Launcher prompt', from: disk?.launcher || null, to: next.launcher })
    const stale = !!(packVersion && next.clientLabel && next.clientLabel !== packVersion)
    if (stale || (next.clientLabel && next.clientLabel !== disk?.clientLabel)) lines.push({ name: 'Client label', from: disk?.clientLabel || null, to: next.clientLabel, stale })
    return lines
  }

  // Website pages the default update changes, with their blob ids at live and at the target
  async function websitePlan(forkLive, forkTarget) {
    if (!forkTarget || forkTarget === forkLive) return { live: forkLive, target: forkTarget, pages: [] }
    const changed = await gitText('diff', '--no-ext-diff', '--name-only', '-z', '--diff-filter=ACMR', '--end-of-options', forkLive, forkTarget, '--', 'website/')
    const pages = changed.split('\0').filter(p => p.startsWith('website/')).map(p => p.slice('website/'.length)).filter(p => PAGE_RE.test(p)).slice(0, WEB_MAX_PAGES)
    const blobs = async sha => new Map((await gitText('ls-tree', '-r', '-z', '--end-of-options', sha, '--', 'website/')).split('\0')
      .map(e => /^\d+ blob ([0-9a-f]{40})\twebsite\/(.+)$/.exec(e)).filter(Boolean).map(m => [m[2], m[1]]))
    const [atLive, atTarget] = await Promise.all([blobs(forkLive), blobs(forkTarget)])
    return { live: forkLive, target: forkTarget, pages: pages.map(page => ({ page, live: atLive.get(page) || null, target: atTarget.get(page) || null })) }
  }

  // ---- website check (background, only while the panel is watched) ----

  // The body up to max bytes; a larger page is an error, and the rest is never downloaded
  async function readCapped(res, max) {
    if (Number(res.headers?.get?.('content-length')) > max) throw new Error('page too large')
    const parts = []
    let size = 0
    for await (const chunk of res.body || []) {
      size += chunk.length
      if (size > max) throw new Error('page too large')
      parts.push(chunk)
    }
    return Buffer.concat(parts, size)
  }

  const web = { wantedAt: 0, timer: null, plan: null, result: null, running: null }

  function checkWebsite() {
    if (web.running) return web.running
    const plan = web.plan
    let origin = null
    try { const u = new URL(config.websiteUrl); if (u.protocol === 'https:' || u.protocol === 'http:') origin = u.origin } catch { origin = null }
    if (!plan || !origin || typeof fetch !== 'function') return Promise.resolve(web.result)
    web.running = (async () => {
      const pages = []
      for (const p of plan.pages) {
        let state = 'error'
        try {
          const url = new URL(`/${p.page}`, origin)
          if (url.origin !== origin) throw new Error('off site')
          const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(WEB_TIMEOUT_MS) })
          if (res.ok) {
            const id = blobId(await readCapped(res, WEB_MAX_BYTES))
            state = id === p.target ? 'target' : id === p.live ? 'live' : 'other'
          }
        } catch { state = 'error' }
        pages.push({ page: p.page, state })
      }
      const count = state => pages.filter(p => p.state === state).length
      web.result = { checkedAt: iso(now()), total: pages.length, matching: count('target'), live: count('live'), target: plan.target, pages }
      return web.result
    })().finally(() => { web.running = null })
    return web.running
  }

  function stopWebsite() {
    if (web.timer) clearInterval(web.timer)
    web.timer = null
  }

  function wantWebsite() {
    web.wantedAt = now()
    if (web.plan && (!web.result || web.result.target !== web.plan.target)) checkWebsite().catch(() => {})
    if (web.timer) return
    web.timer = setInterval(() => {
      if (now() - web.wantedAt > WEB_EVERY_MS) return stopWebsite()
      checkWebsite().catch(() => {})
    }, WEB_EVERY_MS)
    web.timer.unref?.()
  }

  // ---- queue (2.3 to 2.8) ----

  async function buildQueue() {
    const generatedAt = iso(now())
    const lv = await live()
    const { main: mainSha, server: serverSha } = lv.tips
    if (!mainSha) throw Object.assign(new Error('origin/main missing'), { code: 'unavailable' })
    const forkLive = lv.fork.sha, serverLive = lv.server.base
    const [fork, server, lines, held, packs, { items, refused }, block, fetchHead] = await Promise.all([
      commitsBetween('fork', forkLive, mainSha), commitsBetween('server', serverLive, serverSha),
      readJsonLines(config.reviewsFile).then(ls => ls.filter(isTrustedVerdict)), loadHeld(), loadPacks(), loadItems(), blockers(lv),
      gitPath('FETCH_HEAD').then(mtimeOf),
    ])
    fetchStamp = fetchHead
    const models = {}
    for (const [side, set, base, tip] of [['fork', fork, forkLive, mainSha], ['server', server, serverLive, serverSha]]) {
      const byId = new Map(set.commits.map(c => [c.sha, c]))
      for (const c of set.commits) {
        c.cls = classifyCommit(side, c.files, { migration: side === 'server' && /^yes$/i.test(trailer(c, 'migration') || '') })
        const rev = /This reverts commit ([0-9a-f]{40})/.exec(c.body || '')
        if (rev) { c.revertOf = short(rev[1]); if (byId.has(rev[1])) { c.reverted = true; byId.get(rev[1]).reverted = true } }
      }
      await reviewCommits(side, set.commits, base, lines)
      await markHeld(side, set.commits, held)
      models[side] = { side, commits: set.commits, byId, tip, base, total: set.total }
      Object.assign(models[side], shipSteps(models[side]))
    }

    const forkWalk = walk(models.fork)
    const forkTarget = forkWalk.target || forkLive
    for (const c of server.commits) {
      c.requiresFork = await requiresFork(c)
      c.requiresForkMet = c.requiresFork ? SHA_RE.test(c.requiresFork) && await isAncestor(c.requiresFork, forkTarget) : true
    }
    const serverWalk = walk(models.server, c => c.requiresForkMet)

    const liveVersion = lv.client.version
    const verdictFor = (repo, tip) => { const r = lines.findLast(l => l.repo === repo && l.tip === tip); return r ? verdictOf(r) : NO_REVIEW }
    const heldExact = (repo, tip) => held.find(h => h.repo === repo && h.tip === tip)
    const waiting = packs.filter(p => !liveVersion || semverCmp(p.version, liveVersion) > 0)
    for (const p of waiting) {
      p.review = verdictFor('client', p.version)
      p.heldReason = heldExact('client', p.version)?.reason || null
      p.containsLive = lv.client.fork ? await isAncestor(lv.client.fork, p.fork) : null
    }
    let defaultPack = null
    for (const p of waiting) {
      if (p.review.state !== 'GO' || p.heldReason || p.containsLive !== true || !(await isAncestor(p.fork, forkTarget))) continue
      const diff = await gitText('diff', '--no-ext-diff', '--name-only', '--end-of-options', p.fork, forkTarget, '--', ...CLIENT_PATHS)
      if (!diff.trim()) { defaultPack = p; break }
    }
    for (const i of items) {
      i.review = verdictFor('item', i.id)
      i.heldReason = i.state === 'held' ? 'held' : heldExact('item', i.id)?.reason || null
    }
    const defaultItems = items.filter(i => i.state === 'queued' && !i.heldReason && i.review.state === 'GO').map(i => i.id)
    const clientChanges = fork.commits.some(c => forkWalk.covered.has(c.sha) && c.cls.flags.includes('clientPack'))

    const groups = new Map(), docs = { count: 0, fork: 0, server: 0 }
    // commits: all waiting per side, merges and docs included, as git rev-list --count gives them
    const counts = { total: 0, reviewed: 0, unreviewed: 0, blocked: 0, held: 0, byArea: {}, commits: { fork: fork.total, server: serverLive && serverSha ? server.total : null } }
    const flagSet = new Set()
    let listed = 0
    const add = (area, row) => {
      counts.total++
      for (const f of row.flags) flagSet.add(f)
      counts.byArea[area] = (counts.byArea[area] || 0) + 1
      if (REVIEWED.has(row.review.state)) counts.reviewed++
      else if (row.review.state === 'NO-GO') counts.blocked++
      else counts.unreviewed++
      if (row.held) counts.held++
      if (!groups.has(area)) groups.set(area, { area, count: 0, items: [] })
      const g = groups.get(area)
      g.count++
      if (g.items.length < GROUP_CAP && listed < LIST_CAP) { g.items.push(row); listed++ }
    }
    for (const p of waiting) {
      const warnings = ['players must restart their launcher']
      if (p.containsLive === false) warnings.push('this pack drops changes that are live')
      if (p.builtOn !== 'skymp') warnings.push('not built on CT 115')
      add('Client', {
        kind: 'pack', id: p.version, short: p.version, title: `Client ${p.version}`, author: p.builtBy, authorFrom: null, at: p.builtAt,
        review: p.review, flags: ['clientUpdate'], warnings, held: !!p.heldReason, heldReason: p.heldReason, blocked: p.review.state === 'NO-GO',
        inDefault: p === defaultPack, fork: short(p.fork),
      })
    }
    const walks = { fork: forkWalk, server: serverWalk }
    for (const side of ['fork', 'server']) {
      const { commits, order } = models[side]
      for (const c of [...commits].sort((a, b) => order.get(a.sha) - order.get(b.sha))) {
        if (c.parents.length > 1) continue
        if (c.cls.area === 'Docs') { docs.count++; docs[side]++; continue }
        add(c.cls.area, toRow(c, walks[side].covered.has(c.sha)))
      }
    }
    for (const i of items) {
      add(ITEM_AREAS[i.area], {
        kind: 'item', id: i.id, short: i.id, title: i.title, author: i.author, authorFrom: null, at: i.at, review: i.review, flags: i.flags,
        warnings: [], held: !!i.heldReason, heldReason: i.heldReason, blocked: i.review.state === 'NO-GO', inDefault: defaultItems.includes(i.id),
        applyBy: i.applyBy, keys: i.keys,
      })
    }
    const rank = a => (AREA_ORDER.includes(a) ? AREA_ORDER.indexOf(a) : AREA_ORDER.length)
    const groupList = [...groups.values()].sort((a, b) => rank(a.area) - rank(b.area))
    const flags = [...flagSet].sort()

    const native = fork.commits.filter(c => c.parents.length === 1 && c.cls.flags.includes('nativeBuild'))
    const outside = [
      await launcherOutside(mainSha, lv.launcher),
      { area: 'Native client', why: 'needs a Windows build; not possible on CT 115 yet', count: native.length, items: native.slice(0, 50).map(outsideRow) },
    ].filter(o => o && o.count)
    const notOnMain = await branchesNotMerged(mainSha, serverSha)
    const heldRanges = held.map(h => ({ repo: h.repo, range: SHA_RE.test(h.tip) ? `${h.base ? short(h.base) : ''}..${short(h.tip)}` : h.tip, reason: h.reason }))
    const versions = await versionLines(forkTarget, forkLive, { launcher: lv.launcher, clientLabel: lv.clientLabel }, defaultPack?.version)
    web.plan = await websitePlan(forkLive, forkTarget).catch(() => null)

    const hash = sha256(canonical({
      tips: { main: mainSha, server: serverSha },
      live: { record: lv.record, fork: forkLive, server: serverLive, client: liveVersion },
      rows: ['fork', 'server'].flatMap(side => models[side].commits.map(c => [side, c.sha, c.review.state, c.held, c.review.state === 'NO-GO'])),
      packs: waiting.map(p => [p.version, p.zipSha256, p.review.state, !!p.heldReason]),
      items: items.map(i => [i.id, i.state, i.review.state, !!i.heldReason]),
      blockers: block.codes,
    }))
    const warnings = []
    if (refused) warnings.push(`${refused} manual item(s) refused: invalid file`)
    if (serverSha && !serverLive) warnings.push('live gameplay matches no recent server commit, so its queue is unknown')
    if (fork.total > fork.commits.length || server.total > server.commits.length) warnings.push(`only the newest ${MAX_COMMITS} commits per branch are listed`)
    const denied = unreadable.codes()
    if (denied.length) warnings.push(`some panel files cannot be read (${denied.join(', ')}), so reviews, holds or live versions may be missing`)
    const mergeTimeouts = buildScope.getStore()?.mergeTimeouts || 0
    if (mergeTimeouts) warnings.push(`${mergeTimeouts} merge check(s) timed out, so those merges show as not reviewed until the next check`)
    const value = {
      v: 1, hash, fetchedAt: fetchHead ? iso(fetchHead) : null, generatedAt,
      live: { fork: forkLive, server: serverLive },
      default: { fork: forkTarget, server: serverWalk.target || serverLive, client: defaultPack?.version || null, items: defaultItems, needsAck: clientChanges && !defaultPack },
      stops: { fork: forkWalk.stop, server: serverWalk.stop },
      counts, flags, drift: lv.drift, blockers: block.codes, dirty: block.dirty,
      groups: groupList, held: heldRanges, docs, outside, notOnMain, versions, warnings,
    }
    return { value, models, forkTarget, live: lv, retrySoon: mergeTimeouts > 0 }
  }

  // One rev-parse, the updater's last UPDATE, the service start and file mtimes: a warm /queue runs one git process.
  // The index covers a checkout, reset or staged change of the live tree; an edit that is never staged moves nothing
  // here, so the dirtyTree blocker can lag by up to QUEUE_TTL_MS (the release tools check the tree themselves).
  async function queueKey() {
    const [refs, fetchHead, index, log, svc] = await Promise.all([
      git(['rev-parse', '--end-of-options', 'HEAD', 'origin/main', 'origin/server'], { codes: [0, 128] }), gitPath('FETCH_HEAD'), gitPath('index'),
      updaterLog(), services().catch(() => ({})),
    ])
    const stamps = await Promise.all([
      path.join(control, 'live.json'), path.join(control, 'queue', 'held.json'), path.join(control, 'queue', 'items'), path.join(control, 'release', 'request.json'),
      config.reviewsFile, fetchHead, path.join(gameDir, 'dbo-gamemode.js'), path.join(gameDir, 'server-settings.json'),
      path.join(backendDir, 'data', 'files-version.json'), path.join(backendDir, 'data', 'news.live.json'), path.join(backendDir, 'data', 'extra-files.json'),
      path.join(backendDir, 'routes', 'version.js'), path.join(config.skyrimDataDir || '/opt/skyrim-data', 'SHA256SUMS'),
      config.clientFilesDir && path.join(config.clientFilesDir, config.clientZipName || 'skymp-client.zip'), config.backendEnvFile || '/opt/dragonbreak/backend.env',
      index,
    ].filter(Boolean).map(mtimeOf))
    return canonical([refs.code, refs.stdout, log.updates.at(-1) || null, svc.skympSince ?? null, stamps, await packStamps(), await itemStamps()])
  }

  // Each manual item's mtime: an item edited in place leaves its folder's mtime alone
  async function itemStamps() {
    const dir = path.join(control, 'queue', 'items')
    const names = (await listDir(dir)).filter(n => ITEM_FILE_RE.test(n)).sort().slice(0, MAX_ITEMS)
    return Promise.all(names.map(async name => [name, await mtimeOf(path.join(dir, name))]))
  }

  let cache = null, inflight = null, failure = null, lastError = null, backoff = 0

  // Single flight; after a failure no build starts until failure.retryAt, and the last queue (or the error) answers meanwhile
  function queue() {
    if (inflight) return inflight
    if (failure && now() < Date.parse(failure.retryAt)) return cache ? Promise.resolve(cache.value) : Promise.reject(lastError)
    inflight = buildScope.run({ deadline: performance.now() + deadlineMs }, async () => {
      const key = await queueKey()
      if (!cache || cache.key !== key || now() - cache.at >= QUEUE_TTL_MS) {
        const built = await buildQueue()
        // A queue with timed-out merge checks is rebuilt within a minute, not after the full TTL
        cache = { key, at: built.retrySoon ? now() - QUEUE_TTL_MS + RETRY_SOON_MS : now(), ...built }
      }
      failure = null
      lastError = null
      backoff = 0
      wantWebsite()
      return cache.value
    }).catch(err => {
      backoff = Math.min(backoff ? backoff * 2 : BACKOFF_FIRST_MS, BACKOFF_MAX_MS)
      failure = { code: err.timedOut ? 'timeout' : 'unavailable', at: iso(now()), retryAt: iso(now() + backoff) }
      lastError = err
      throw err
    }).finally(() => { inflight = null })
    return inflight
  }

  // The last failed refresh, until one succeeds
  const lastFailure = () => failure

  // The last queue without waiting; a stale one starts a refresh in the background
  function peek() {
    if (!cache || now() - cache.at >= QUEUE_TTL_MS) queue().catch(() => {})
    return cache?.value || null
  }

  // The live versions the last queue was built from, without waiting
  const peekLive = () => cache?.live || null

  // "Update up to here" (2.8) from the last built queue
  function upTo(sha) {
    if (!cache || !SHA_RE.test(sha)) return null
    for (const side of ['fork', 'server']) {
      const model = cache.models[side]
      if (model.byId.has(sha)) return { side, target: model.step.get(sha) || null }
    }
    return null
  }

  // ---- history ----

  function releaseRow(r) {
    const at = isoOrNull(r.at)
    if (!at) return null
    const part = key => {
      const from = r.from?.[key], to = (r.to || r.target)?.[key]
      const val = v => (typeof v === 'string' && SHA_RE.test(v) ? short(v) : VERSION_RE.test(v?.version || v) ? v.version || v : null)
      return val(from) || val(to) ? { from: val(from), to: val(to) } : null
    }
    const kind = ['release', 'manual', 'hotfix', 'rollback'].includes(r.kind) ? r.kind : /^manual-/.test(r.relId) ? 'manual' : 'release'
    return {
      at, kind, relId: typeof r.relId === 'string' && /^(?:rel|manual|hotfix)-[\w-]{1,60}$/.test(r.relId) ? r.relId : null,
      by: typeof r.byTag === 'string' && /^[a-z0-9-]{1,40}$/.test(r.byTag) ? r.byTag : null,
      fork: part('fork'), server: part('server'), client: part('client'), state: 'done', outside: false, hotfix: kind === 'hotfix',
    }
  }

  async function history() {
    const [records, log, names, served] = await Promise.all([
      readJsonLines(path.join(control, 'releases.jsonl')), updaterLog(), listDir(config.backupsDir), readJson(path.join(backendDir, 'data', 'files-version.json')),
    ])
    const recorded = records.map(releaseRow).filter(Boolean)
    const rows = [...recorded]
    const near = (part, at) => recorded.some(r => r[part] && Math.abs(Date.parse(r.at) - Date.parse(at)) < 15 * 60 * 1000)
    const add = (part, row) => { if (!near(part, row.at)) rows.push({ relId: null, by: null, fork: null, server: null, client: null, outside: true, hotfix: false, ...row }) }
    for (const u of log.updates) add('fork', { at: iso(Date.parse(u.okAt || u.at)), kind: 'updater', fork: { from: u.from, to: u.to }, state: u.okAt ? 'ok' : 'unfinished' })
    const clientBackups = []
    const stampAt = s => iso(Date.parse(s.replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/, '$1-$2-$3T$4:$5:$6Z')))
    for (const name of names) {
      let m
      if ((m = /^gameplay-(\d{8}T\d{6}Z)$/.exec(name))) add('server', { at: stampAt(m[1]), kind: 'gameplay', state: 'done' })
      else if ((m = /^client-(\d+\.\d+\.\d+)-(\d{8}T\d{6}Z)$/.exec(name))) clientBackups.push({ at: stampAt(m[2]), from: m[1] })
    }
    clientBackups.sort((a, b) => a.at.localeCompare(b.at))
    const servedVersion = VERSION_RE.test(served?.version) ? served.version : null
    clientBackups.forEach((b, i) => add('client', { at: b.at, kind: 'client', client: { from: b.from, to: clientBackups[i + 1]?.from || servedVersion }, state: 'done' }))
    const builtAt = isoOrNull(served?.builtAt)
    if (servedVersion && builtAt && !rows.some(r => r.client?.to === servedVersion)) add('client', { at: builtAt, kind: 'client', client: { from: null, to: servedVersion }, state: 'done' })
    rows.sort((a, b) => a.at.localeCompare(b.at))
    return rows.map((r, i) => ({ n: i + 1, ...r })).reverse()
  }

  // Ten history rows older than row n (numbered from the oldest), newest first
  async function releases(before) {
    const all = await history()
    const n = /^\d{1,6}$/.test(String(before ?? '')) ? Number(before) : Infinity
    const older = all.filter(r => r.n < n)
    return { rows: older.slice(0, 10), more: older.length > 10 }
  }

  return { git, live, queue, peek, peekLive, lastFailure, upTo, releases, history, updaterLog, checkWebsite, stop: stopWebsite }
}

module.exports = { createReleaseQueue, queueEtag, parseUpdaterLog, stripStamp, commitTitle, gitSync, gitCommand, priorityPrefix, runFile, isSecretFile, readErrors, GIT_ALLOWED, QUEUE_TTL_MS }
