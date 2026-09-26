'use strict'
// Release queue against fixture repos: the git wrapper, live cross-checks, content match, reviews, targets, queueHash and history

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { execFile, execFileSync } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { createReleaseQueue, parseUpdaterLog, stripStamp, commitTitle, gitSync } = require('../sources/releaseQueue')

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex')
const short = s => s.slice(0, 8)
const SECRET_RE = /^(?:server-settings.*\.json|backend\.env|\.env.*|sessions\.json|site-sessions\.json|auth-states\.json)$/
const CO_AUTHOR = '\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
const VERSION_JS = (launcher, client) => `const LATEST_VERSION = '${launcher}'\nconst CLIENT_VERSION = '${client}'\n`
const NEWS = '[{"title":"Hello"}]'
const ZIP = 'zip bytes'
const RACES = '<h1>Races</h1>\n'
const SUMS = `${'1'.repeat(64)}  DragonBreak.esp\n`

let root, repo, liveDir, S = {}, seq = 0
let tick = Date.parse('2026-09-20T00:00:00Z') / 1000

function fixtureEnv() {
  tick += 60
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')))
  return {
    ...env, GIT_AUTHOR_NAME: 'NatPiercii', GIT_AUTHOR_EMAIL: 'nate@example.com', GIT_COMMITTER_NAME: 'NatPiercii',
    GIT_COMMITTER_EMAIL: 'nate@example.com', GIT_AUTHOR_DATE: `${tick} +0000`, GIT_COMMITTER_DATE: `${tick} +0000`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  }
}
const realRun = (file, args, opts) => new Promise((resolve, reject) =>
  execFile(file, args, opts, (err, stdout) => (err ? reject(Object.assign(err, { stdout })) : resolve({ stdout }))))
const g = (...args) => execFileSync('git', ['-C', repo, ...args], { env: fixtureEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

function write(dir, files) {
  for (const [f, content] of Object.entries(files)) {
    const p = path.join(dir, f)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content)
  }
}

function commit(files, message) {
  write(repo, files)
  g('add', '-A')
  g('commit', '-q', '--allow-empty', '-m', message)
  return g('rev-parse', 'HEAD')
}

function countObjects() {
  let n = 0
  const walk = dir => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) e.isDirectory() ? walk(path.join(dir, e.name)) : n++ }
  walk(path.join(repo, '.git', 'objects'))
  return n
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dbo-release-queue-'))
  repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  g('init', '-q', '-b', 'main')
  S.PREV = commit({
    'README.md': 'fork\n', 'skymp5-backend/server.js': 'server\n', 'skymp5-backend/routes/version.js': VERSION_JS('2.1.29', '0.3.46'),
    'skymp5-backend/data/role-permissions.json': '{}\n', 'skymp5-backend/shared.js': 'base\n', 'skymp5-client/src/a.ts': 'a1\n',
    'website/index.html': 'index\n', 'deploy/skyrim-data/SHA256SUMS': SUMS, 'skymp5-server/cpp/a.cpp': 'a1\n',
  }, 'backend: first')
  S.LIVE = commit({ 'skymp5-backend/routes/first.js': 'first\n' }, 'backend: first route')
  g('tag', 'launcher-v2.1.29', S.LIVE)

  g('checkout', '-q', '-b', 'side', S.LIVE)
  S.P = commit({ 'skymp5-backend/routes/login.js': 'login\n' }, `backend: fix the login${CO_AUTHOR}`)
  g('checkout', '-q', '-b', 'pending', S.LIVE)
  commit({ 'skymp5-client/src/p1.ts': 'p1\n' }, 'client: pending one')
  S.U2 = commit({ 'skymp5-client/src/p2.ts': 'p2\n' }, 'client: pending two')
  g('checkout', '-q', '-b', 'claude/x', S.LIVE)
  S.X1 = commit({ 'misc/x.txt': 'x\n' }, 'misc: unowned')

  g('checkout', '-q', '-b', 'next', S.LIVE)
  S.A = commit({ 'skymp5-backend/routes/status.js': 'status\n' }, 'backend: add a status route\n\nOperator: claude-nate')
  S.B = commit({ 'docs/b.md': 'notes\n' }, 'docs: notes')
  g('checkout', '-q', '-b', 'feat', S.A)
  S.F1 = commit({ 'skymp5-client/src/a.ts': 'a2\n' }, 'client: the interact key answers a trade request (review of 1234abcd)')
  S.F2 = commit({ 'website/guides/races.html': RACES, 'website/Bad Page.html': 'bad\n' }, 'website: races guide')
  g('checkout', '-q', 'next')
  g('merge', '--no-ff', '-q', '-m', 'Merge branch feat', 'feat')
  S.M1 = g('rev-parse', 'HEAD')
  S.C = commit({ 'skymp5-server/cpp/a.cpp': 'a2\n' }, 'server: tune the tick')
  g('revert', '--no-edit', S.C)
  S.D = g('rev-parse', 'HEAD')
  g('cherry-pick', S.P)
  S.Pp = g('rev-parse', 'HEAD')
  S.E = commit({ 'skymp5-backend/routes/version.js': VERSION_JS('2.1.30', '0.3.46') }, 'backend: launcher 2.1.30')
  S.L = commit({ 'skymp5-launcher/src/main.ts': 'l2\n' }, 'launcher: remember the window')
  S.N = commit({ 'skyrim-platform/src/x.cpp': 'n\n' }, 'skyrim-platform: faster hook')
  g('checkout', '-q', '-b', 'conf', S.N)
  S.H = commit({ 'skymp5-backend/shared.js': 'from conf\n' }, 'backend: shared from conf')
  g('checkout', '-q', 'next')
  S.G = commit({ 'skymp5-backend/shared.js': 'from next\n' }, 'backend: shared from next')
  try { g('merge', '-q', 'conf') } catch { /* the conflict is resolved by hand below */ }
  write(repo, { 'skymp5-backend/shared.js': 'resolved\n' })
  g('add', '-A')
  g('commit', '-q', '-m', 'Merge branch conf')
  S.M2 = g('rev-parse', 'HEAD')

  g('checkout', '-q', '--orphan', 'srv')
  g('rm', '-rfq', '.')
  S.CONFIG = { admins: ['repo-admin'], x: 1, y: { b: 2, a: 1 } }
  S.S0 = commit({
    'gamemode.js': 'module.exports = 1\n', 'combat.js': 'c1\n', 'gamemode-config.json': JSON.stringify(S.CONFIG, null, 2) + '\n',
    'skills.json': '{}\n', 'housing.json': '[]\n', 'README.md': 'r\n', 'tests/t.js': 't\n', 'server-settings.json': '{"secret":true}\n',
  }, 'gamemode: first')
  S.S1 = commit({ 'combat.js': 'c2\n' }, `combat: one stagger per attacker every 3 s (review SCH-2)${CO_AUTHOR}`)
  S.S2 = commit({ 'CHECKLIST.md': 'x\n' }, 'CHECKLIST: notes')
  S.S3 = commit({ 'gamemode.js': 'module.exports = 2\n' }, `gamemode: needs the new tick\n\nRequires-Fork: ${S.C}`)
  g('checkout', '-q', 'main')

  for (const [ref, sha] of Object.entries({ main: S.M2, server: S.S3, side: S.P, pending: S.U2, 'claude/x': S.X1, live: S.LIVE })) {
    g('update-ref', `refs/remotes/origin/${ref}`, sha)
  }
  fs.writeFileSync(path.join(repo, '.git', 'FETCH_HEAD'), `${S.M2}\t\tbranch 'main'\n`)
  write(repo, {
    'skymp5-backend/data/files-version.json': JSON.stringify({ version: '0.3.46', builtAt: '2026-09-25T20:00:00.000Z' }),
    'skymp5-backend/data/news.live.json': NEWS,
    'skymp5-backend/data/extra-files.json': JSON.stringify({ version: 'abc', builtAt: '2026-09-25T19:00:00.000Z' }),
    'skymp5-backend/data/sessions.json': 'SECRET', 'skymp5-backend/data/site-sessions.json': 'SECRET', 'skymp5-backend/data/auth-states.json': 'SECRET',
  })

  liveDir = path.join(root, 'server')
  resetLiveGameplay()
  write(root, {
    'client-files/skymp-client.zip': ZIP, 'skyrim-data/SHA256SUMS': SUMS, 'backend.env': 'SECRET=1\n',
    'backups/gameplay-20260925T010000Z/combat.js': 'old', 'backups/gameplay-20260925T030000Z/combat.js': 'old',
    'backups/client-0.3.45-20260925T020000Z/files-version.json': '{}',
  })
})

after(() => fs.rmSync(root, { recursive: true, force: true }))

function resetLiveGameplay(extra = {}) {
  fs.rmSync(liveDir, { recursive: true, force: true })
  write(liveDir, {
    'dbo-gamemode.js': 'module.exports = 1\n// deployed 2026-09-26T02:29:19Z\n', 'gamemode.js': 'placeholder\n', 'combat.js': 'c1\n',
    'gamemode-config.json': JSON.stringify({ y: { a: 1, b: 2 }, x: 1, admins: ['live-admin'] }), 'skills.json': '{}\n',
    'housing.json': '[{"live":true}]', 'server-settings.json': 'SECRET', 'server-settings-dump.json': 'SECRET', ...extra,
  })
}

const LOG_25_SEP = live8 => [
  '2026-09-25T23:40:01Z up to date (82acceef)',
  `2026-09-25T23:45:02Z UPDATE 82acceef -> ${live8}`,
  '2026-09-25T23:45:02Z building',
  '[125/125] Linking CXX shared library skymp5-server/scam_native.node',
  '2026-09-25T23:48:34Z restarting',
  `2026-09-25T23:48:55Z OK - now ${live8}, udp/7777 bound`,
  `2026-09-25T23:50:03Z up to date (${live8})`,
].join('\n') + '\n'
const SKYMP_ACTIVE = Date.parse('2026-09-25T23:48:35Z')

// A fresh control folder, reviews file and log per queue, so tests never share state
function newQueue({ reviews = [], held = null, liveJson = null, log = LOG_25_SEP(short(S.LIVE)), svc = {}, config = {}, ...deps } = {}) {
  const n = ++seq
  const cfg = {
    releaseRepo: repo, controlDir: path.join(root, `control-${n}`), reviewsFile: path.join(root, `reviews-${n}.jsonl`),
    opsClaimsDir: path.join(root, 'claims'), updaterLog: path.join(root, `update-${n}.log`), backupsDir: path.join(root, 'backups'),
    handoverDir: path.join(root, `handover-${n}`), gameServerDir: liveDir, clientFilesDir: path.join(root, 'client-files'),
    clientZipName: 'skymp-client.zip', scratchDir: root, skyrimDataDir: path.join(root, 'skyrim-data'),
    backendEnvFile: path.join(root, 'backend.env'), websiteUrl: 'https://site.example', ...config,
  }
  fs.mkdirSync(cfg.controlDir, { recursive: true })
  if (reviews.length) fs.writeFileSync(cfg.reviewsFile, reviews.map(r => JSON.stringify(r)).join('\n') + '\n')
  if (held) write(cfg.controlDir, { 'queue/held.json': JSON.stringify({ v: 1, ranges: held }) })
  if (liveJson) write(cfg.controlDir, { 'live.json': JSON.stringify(liveJson) })
  if (log != null) fs.writeFileSync(cfg.updaterLog, log)
  const services = async () => ({ skympSince: Date.now() + 3600e3, backendSince: Date.now() + 3600e3, ...svc })
  const q = createReleaseQueue({ config: cfg, services, fetch: async () => { throw new Error('offline') }, ...deps })
  return { q, cfg }
}

const verdict = (verdictWord, tip, base = S.LIVE, extra = {}) => ({
  at: '2026-09-26T07:00:00Z', by: 'claude-jake', realUser: 'root', loginUid: 0, trusted: true, repo: 'fork', base, tip, verdict: verdictWord, note: '', ...extra,
})
const go = (tip, base, extra) => verdict('GO', tip, base, extra)
const rows = qv => qv.groups.flatMap(gr => gr.items)
const row = (qv, sha) => rows(qv).find(r => r.id === sha)

async function withQueue(opts, fn) {
  const { q, cfg } = newQueue(opts)
  try { return await fn(q, cfg) } finally { q.stop() }
}

// ---- the git wrapper ----

test('wrapper: fetch, pull, push and anything off the allowlist throw before git runs', async () => {
  const calls = []
  const { q } = newQueue({ run: async (...a) => { calls.push(a); return { stdout: '' } } })
  for (const args of [['fetch'], ['pull'], ['push'], ['config', 'x'], ['gc'], ['update-ref', 'HEAD', S.LIVE], ['checkout', 'main'],
    ['remote', 'update'], ['hash-object', '-w', '--stdin-paths'], ['hash-object', 'x'], ['log', '--output=/tmp/x'],
    ['log', '--end-of-options', '--upload-pack=x'], ['rev-parse', '--end-of-options', 'main; rm -rf /'], [], [42]]) {
    await assert.rejects(q.git(args), { code: 'gitNotAllowed' }, JSON.stringify(args))
  }
  assert.equal(calls.length, 0)
})

test('wrapper: the synchronous form keeps the same guard and refuses merge-tree', () => {
  const calls = []
  const runSync = (...a) => { calls.push(a); return 'ok\n' }
  for (const args of [['fetch'], ['pull'], ['push'], ['config', 'x'], ['log', '--output=/tmp/x'], ['rev-parse', '--end-of-options', 'main; rm -rf /'],
    ['merge-tree', '--write-tree', '--end-of-options', S.B, S.F2]]) {
    assert.throws(() => gitSync(repo, args, { runSync }), { code: 'gitNotAllowed' }, JSON.stringify(args))
  }
  assert.equal(calls.length, 0)
  assert.equal(gitSync(repo, ['rev-parse', '--verify', '--end-of-options', 'HEAD'], { runSync }), 'ok\n')
  const [[file, args, opts]] = calls
  assert.equal(file, 'git')
  assert.deepEqual(args, ['-C', repo, '-c', 'core.quotePath=false', 'rev-parse', '--verify', '--end-of-options', 'HEAD'])
  assert.deepEqual([opts.timeout, opts.maxBuffer, opts.env.GIT_OPTIONAL_LOCKS, opts.env.GIT_TERMINAL_PROMPT], [5000, 2 * 1024 * 1024, '0', '0'])
})

test('wrapper: fixed argv, clean env, 5 s timeout and 2 MB buffer', async () => {
  const calls = []
  process.env.GIT_DIR = '/elsewhere'
  try {
    const { q } = newQueue({ run: async (file, args, opts) => { calls.push({ file, args, opts }); return { stdout: 'ok\n' } } })
    assert.equal((await q.git(['rev-parse', '--end-of-options', 'HEAD'])).stdout, 'ok\n')
  } finally { delete process.env.GIT_DIR }
  const [{ file, args, opts }] = calls
  assert.equal(file, 'git')
  assert.deepEqual(args.slice(0, 4), ['-C', repo, '-c', 'core.quotePath=false'])
  assert.equal(opts.env.GIT_OPTIONAL_LOCKS, '0')
  assert.equal(opts.env.GIT_TERMINAL_PROMPT, '0')
  assert.equal(opts.env.GIT_DIR, undefined)
  assert.equal(opts.timeout, 5000)
  assert.equal(opts.maxBuffer, 2 * 1024 * 1024)
})

test('wrapper: a timeout or a missing repo is reported as unavailable', async () => {
  const { q } = newQueue({ run: async () => { throw Object.assign(new Error('killed'), { killed: true, code: null }) } })
  await assert.rejects(q.git(['status']), { code: 'unavailable', timedOut: true })
  const missing = newQueue({ config: { releaseRepo: path.join(root, 'no-repo') } }).q
  await assert.rejects(missing.queue(), { code: 'unavailable' })
})

test('wrapper: merge-tree writes only into a scratch object folder that is removed afterwards', async () => {
  const seen = []
  const { q } = newQueue({
    run: (file, args, opts) => {
      if (args.includes('merge-tree')) seen.push({ objects: opts.env.GIT_OBJECT_DIRECTORY, alternates: opts.env.GIT_ALTERNATE_OBJECT_DIRECTORIES, existed: fs.existsSync(opts.env.GIT_OBJECT_DIRECTORY) })
      return realRun(file, args, opts)
    },
  })
  const objects = countObjects()
  const { code } = await q.git(['merge-tree', '--write-tree', '--end-of-options', S.B, S.F2], { codes: [0, 1] })
  assert.equal(code, 0)
  assert.equal(seen.length, 1)
  assert.ok(seen[0].existed && seen[0].objects.startsWith(root))
  assert.equal(seen[0].alternates, path.join(repo, '.git', 'objects'))
  assert.equal(fs.existsSync(seen[0].objects), false)
  assert.equal(countObjects(), objects)
})

// ---- pure helpers ----

test('titles drop a known area prefix and a trailing review note', () => {
  assert.equal(commitTitle('client: the interact key answers a trade request (review of 1234abcd)'), 'The interact key answers a trade request')
  assert.equal(commitTitle('combat: one stagger per attacker every 3 s (review SCH-2)'), 'Combat: one stagger per attacker every 3 s')
  assert.equal(commitTitle('x'.repeat(300)).length, 120)
  assert.equal(commitTitle('website: a\u0007b'), 'A b')
})

test('the deploy stamp is stripped, with or without a sha', () => {
  assert.deepEqual(stripStamp(Buffer.from('a\n// deployed 2026-09-26T02:29:19Z\n')).body.toString(), 'a\n')
  const s = stripStamp(Buffer.from(`a\n// deployed 2026-09-26T02:29:19Z server@${'b'.repeat(40)}\n`))
  assert.equal(s.sha, 'b'.repeat(40))
  assert.equal(s.at, '2026-09-26T02:29:19.000Z')
  assert.equal(stripStamp(Buffer.from('a\n')).body.toString(), 'a\n')
})

test('updater log: update, restart and OK lines are paired', () => {
  const log = parseUpdaterLog(LOG_25_SEP('f8cd7897') + '2026-09-26T00:00:00Z UPDATE f8cd7897 -> 11111111\n2026-09-26T00:01:00Z BUILD FAILED - service left running on the previous build\n')
  assert.deepEqual(log.updates[0], { at: '2026-09-25T23:45:02Z', from: '82acceef', to: 'f8cd7897', restartingAt: '2026-09-25T23:48:34Z', okAt: '2026-09-25T23:48:55Z', failed: null })
  assert.equal(log.updates[1].okAt, null)
  assert.equal(log.updates[1].failed, 'build')
  assert.deepEqual(log.lastRun, { at: '2026-09-26T00:01:00Z', result: 'buildFailed' })
})

// ---- live (2.9) ----

test('live: the 25 Sep log excerpt confirms the live fork', async () => {
  await withQueue({ svc: { skympSince: SKYMP_ACTIVE } }, async q => {
    const lv = await q.live()
    assert.equal(lv.source, 'derived')
    assert.equal(lv.fork.sha, S.LIVE)
    assert.equal(lv.fork.confirmed, true)
    assert.equal(lv.fork.since, '2026-09-25T23:48:55.000Z')
    assert.deepEqual(lv.lastUpdate, { from: '82acceef', to: short(S.LIVE), state: 'ok', at: '2026-09-25T23:45:02Z', okAt: '2026-09-25T23:48:55Z', failed: null })
    assert.equal(lv.githubLive, 'inSync')
  })
  await withQueue({ svc: { skympSince: Date.parse('2026-09-25T23:48:30Z') } }, async q => assert.equal((await q.live()).fork.confirmed, false))
})

test('live: an UPDATE with no OK is unfinished', async () => {
  const log = `2026-09-25T23:45:02Z UPDATE 82acceef -> ${short(S.LIVE)}\n2026-09-25T23:45:02Z building\n2026-09-25T23:50:00Z BUILD FAILED - service left running on the previous build\n`
  await withQueue({ log }, async q => {
    const lv = await q.live()
    assert.equal(lv.lastUpdate.state, 'unfinished')
    assert.equal(lv.fork.confirmed, false)
    assert.ok(lv.drift.includes('lastUpdateUnfinished'))
  })
})

test('live: a rotated log falls back to the .1 file, then to live.json alone', async () => {
  const quiet = `2026-09-26T07:00:00Z up to date (${short(S.LIVE)})\n`
  await withQueue({ log: quiet }, async q => {
    const lv = await q.live()
    assert.equal(lv.lastUpdate.state, 'unknown')
    assert.equal(lv.fork.confirmed, null)
    assert.deepEqual(lv.lastRun, { at: '2026-09-26T07:00:00Z', result: 'upToDate' })
  })
  await withQueue({ log: quiet }, async (q, cfg) => {
    fs.writeFileSync(`${cfg.updaterLog}.1`, LOG_25_SEP(short(S.LIVE)))
    assert.equal((await q.live()).fork.confirmed, true)
  })
})

test('live: HEAD that differs from live.json is drift', async () => {
  await withQueue({ liveJson: consistentLive({ fork: { sha: S.A, since: '2026-09-26T00:00:00Z', how: 'manual' } }) }, async q => {
    const lv = await q.live()
    assert.equal(lv.source, 'live.json')
    assert.equal(lv.fork.sha, S.A)
    assert.equal(lv.fork.headMatches, false)
    assert.ok(lv.drift.includes('headNotLive'))
  })
})

function consistentLive(over = {}) {
  return {
    v: 1, fork: { sha: S.LIVE, since: '2026-09-25T23:48:55Z', how: 'updater' },
    server: { sha: S.S0, how: 'matched', since: '2026-09-26T02:29:19Z' },
    client: { version: '0.3.46', zipSha256: sha256(ZIP), fork: S.LIVE, how: 'direct', since: '2026-09-26T00:00:00Z' },
    news: { sha256: sha256(NEWS), since: null }, website: { fork: null, since: null }, relId: null, byTag: 'claude-jake', backupId: null, ...over,
  }
}

test('live: a consistent live.json gives no drift; each L5 check is reported', async () => {
  await withQueue({ liveJson: consistentLive() }, async q => {
    const lv = await q.live()
    assert.deepEqual(lv.drift, [])
    assert.equal(lv.plugins, 'match')
    assert.equal(lv.client.zipMatches, true)
    assert.equal(lv.client.sourceOnMain, true)
    assert.equal(lv.news.matches, true)
    assert.deepEqual(lv.server, { sha: S.S0, how: 'matched', deployedAt: '2026-09-26T02:29:19.000Z', base: S.S0 })
  })
  const drifted = consistentLive({
    server: { sha: S.S1, how: 'release', since: null },
    client: { version: '0.3.45', zipSha256: sha256('other'), fork: S.P, how: 'release', since: '2026-09-25T18:00:00Z' },
    news: { sha256: sha256('older news'), since: null },
  })
  await withQueue({ liveJson: drifted, svc: { skympSince: Date.parse('2026-01-01T00:00:00Z'), backendSince: Date.parse('2026-01-01T00:00:00Z') } }, async q => {
    const sums = path.join(root, 'skyrim-data', 'SHA256SUMS')
    fs.writeFileSync(sums, `${'2'.repeat(64)}  DragonBreak.esp\n`)
    try {
      const lv = await q.live()
      assert.deepEqual(lv.drift, ['gameplayOutsideRelease', 'clientOutsideRelease', 'clientSourceNotOnMain', 'newsOutsideRelease', 'extrasChanged', 'pluginsDiffer', 'configChangedSinceStart'])
      assert.equal(lv.client.zipMatches, false)
    } finally { fs.writeFileSync(sums, SUMS) }
  })
})

test('live: a config file written in the same second the service started is not drift', async () => {
  const envAt = fs.statSync(path.join(root, 'backend.env')).mtimeMs
  const since = Math.floor(envAt / 1000) * 1000
  await withQueue({ svc: { backendSince: since } }, async q => assert.equal((await q.live()).drift.includes('configChangedSinceStart'), false))
  await withQueue({ svc: { backendSince: since - 1000 } }, async q => assert.ok((await q.live()).drift.includes('configChangedSinceStart')))
})

test('live: the CLIENT_VERSION label that differs from the served client is drift', async () => {
  const served = path.join(repo, 'skymp5-backend/data/files-version.json')
  fs.writeFileSync(served, JSON.stringify({ version: '0.3.47', builtAt: '2026-09-26T07:27:14.843Z' }))
  try {
    await withQueue({}, async q => {
      const lv = await q.live()
      assert.equal(lv.client.version, '0.3.47')
      assert.equal(lv.clientLabel, '0.3.46')
      assert.ok(lv.drift.includes('versionLabelStale'))
    })
  } finally { fs.writeFileSync(served, JSON.stringify({ version: '0.3.46', builtAt: '2026-09-25T20:00:00.000Z' })) }
})

// ---- content match ----

test('content match: stamp stripped and admins ignored give matched', async () => {
  await withQueue({}, async q => assert.deepEqual((await q.live()).server, { sha: S.S0, how: 'matched', deployedAt: '2026-09-26T02:29:19.000Z', base: S.S0 }))
})

test('content match: a stamp with a verified sha, and one that does not verify', async () => {
  try {
    resetLiveGameplay({ 'dbo-gamemode.js': `module.exports = 1\n// deployed 2026-09-26T02:29:19Z server@${S.S0}\n` })
    await withQueue({}, async q => assert.equal((await q.live()).server.how, 'stamp'))
    resetLiveGameplay({ 'dbo-gamemode.js': `module.exports = 1\n// deployed 2026-09-26T02:29:19Z server@${S.S1}\n` })
    await withQueue({}, async q => assert.deepEqual([(await q.live()).server.how, (await q.live()).server.sha], ['matched', S.S0]))
  } finally { resetLiveGameplay() }
})

test('content match: a dirty deploy or another config value gives modified', async () => {
  try {
    resetLiveGameplay({ 'combat.js': 'hand edit\n' })
    await withQueue({}, async q => {
      const lv = await q.live()
      assert.equal(lv.server.how, 'modified')
      assert.ok(lv.drift.includes('gameplayModified'))
      const qv = await q.queue()
      assert.equal(qv.live.server, null)
      assert.ok(qv.warnings.some(w => /gameplay/.test(w)))
    })
    resetLiveGameplay({ 'gamemode-config.json': JSON.stringify({ ...S.CONFIG, x: 2 }) })
    await withQueue({}, async q => assert.equal((await q.live()).server.how, 'modified'))
  } finally { resetLiveGameplay() }
})

// ---- the queue ----

test('queue: rows, areas, titles, authors, reverts, docs and merges from the fixture', async () => {
  await withQueue({}, async q => {
    const qv = await q.queue()
    assert.equal(qv.v, 1)
    assert.deepEqual(qv.live, { fork: S.LIVE, server: S.S0 })
    assert.equal(qv.fetchedAt !== null, true)
    const areas = Object.fromEntries(qv.groups.map(gr => [gr.area, gr.items.map(r => r.short)]))
    assert.deepEqual(areas, {
      'Game server': [short(S.C), short(S.D)], Gameplay: [short(S.S1), short(S.S3)], 'Native client': [short(S.N)], Client: [short(S.F1)],
      Backend: [short(S.A), short(S.Pp), short(S.G), short(S.H)], Launcher: [short(S.L)], Website: [short(S.F2)], Versions: [short(S.E)],
    })
    assert.deepEqual(qv.groups.map(gr => gr.area), ['Game server', 'Gameplay', 'Native client', 'Client', 'Backend', 'Launcher', 'Website', 'Versions'])
    assert.equal(qv.docs.count, 2)
    assert.equal(qv.counts.total, 13)
    assert.equal(qv.counts.unreviewed, 13)
    assert.equal(row(qv, S.M1), undefined)
    assert.deepEqual(row(qv, S.A).flags, ['backendRestart'])
    assert.equal(row(qv, S.A).author, 'claude-nate (trailer)')
    assert.equal(row(qv, S.A).authorFrom, 'trailer')
    assert.equal(row(qv, S.F1).title, 'The interact key answers a trade request')
    assert.equal(row(qv, S.F1).author, 'Nate / claude-nate')
    assert.equal(row(qv, S.S1).title, 'Combat: one stagger per attacker every 3 s')
    assert.equal(row(qv, S.S1).author, 'a Claude session (via Nate / claude-nate)')
    assert.equal(row(qv, S.D).revertOf, short(S.C))
    assert.equal(row(qv, S.C).reverted, true)
    assert.equal(row(qv, S.S3).requiresFork, short(S.C))
    assert.deepEqual(qv.flags, ['backendRestart', 'build', 'clientPack', 'gameRestart', 'hotReload', 'launcherRelease', 'nativeBuild', 'websiteInstall'])
    assert.deepEqual(qv.default, { fork: S.LIVE, server: S.S0, client: null, items: [], needsAck: false })
    assert.deepEqual(qv.blockers, [])
    assert.deepEqual(qv.versions, [])
  })
})

test('queue: outside this update and branches merged by content', async () => {
  await withQueue({}, async q => {
    const qv = await q.queue()
    const launcher = qv.outside.find(o => o.area === 'Launcher')
    assert.deepEqual([launcher.count, launcher.items.map(i => i.short)], [1, [short(S.L)]])
    assert.equal(qv.outside.find(o => o.area === 'Native client').count, 1)
    assert.deepEqual(qv.notOnMain, [
      { branch: 'claude/x', uniqueCommits: 1, upstream: 'main', unowned: true },
      { branch: 'pending', uniqueCommits: 2, upstream: 'main', unowned: false },
    ])
  })
})

test('reviews: only trusted lines by claude-jake or jake count', async () => {
  const untrusted = [
    go(S.M2, S.LIVE, { trusted: false }), go(S.M2, S.LIVE, { loginUid: 1001, realUser: 'nate' }), go(S.M2, S.LIVE, { realUser: 'nate' }),
    go(S.M2, S.LIVE, { by: 'claude-nate' }), go(S.M2, S.LIVE, { loginUid: '0' }), go('main', S.LIVE),
  ]
  await withQueue({ reviews: untrusted }, async q => {
    const qv = await q.queue()
    assert.equal(qv.counts.reviewed, 0)
    assert.equal(qv.default.fork, S.LIVE)
  })
  await withQueue({ reviews: [...untrusted, go(S.M2, S.LIVE, { by: 'jake' })] }, async q => {
    const qv = await q.queue()
    assert.equal(qv.default.fork, S.M2)
    assert.equal(row(qv, S.A).review.by, 'jake')
  })
})

test('targets: the default stops at the first unreviewed commit', async () => {
  await withQueue({ reviews: [go(S.B)] }, async q => {
    const qv = await q.queue()
    assert.equal(qv.default.fork, S.B)
    assert.equal(qv.stops.fork, short(S.M1))
    assert.equal(row(qv, S.A).inDefault, true)
    assert.equal(row(qv, S.F1).inDefault, false)
  })
})

test('reviews: a later NO-GO overrides a GO, and a later GO on a descendant clears it', async () => {
  await withQueue({ reviews: [go(S.M2), verdict('NO-GO', S.A)] }, async q => {
    const qv = await q.queue()
    assert.equal(row(qv, S.A).review.state, 'NO-GO')
    assert.equal(row(qv, S.A).blocked, true)
    assert.equal(qv.counts.blocked, 1)
    assert.equal(qv.default.fork, S.LIVE)
  })
  await withQueue({ reviews: [go(S.M2), verdict('NO-GO', S.A), go(S.B)] }, async q => {
    const qv = await q.queue()
    assert.equal(row(qv, S.A).review.state, 'GO')
    assert.equal(qv.default.fork, S.M2)
  })
})

test('reviews: a clean merge of reviewed parents counts, a conflict-resolved one does not, and no object is written', async () => {
  const objects = countObjects()
  await withQueue({ reviews: [go(S.B), go(S.F2, S.A)] }, async q => {
    const qv = await q.queue()
    assert.equal(qv.default.fork, S.M1)
    assert.equal(qv.stops.fork, short(S.C))
  })
  await withQueue({ reviews: [go(S.G), go(S.H, S.N)] }, async q => {
    const qv = await q.queue()
    assert.equal(qv.default.fork, S.G)
    assert.equal(qv.stops.fork, short(S.M2))
  })
  assert.equal(countObjects(), objects)
  assert.deepEqual(fs.readdirSync(root).filter(n => n.startsWith('dbo-merge-')), [])
})

test('reviews: a copy with the same patch id carries the GO', async () => {
  await withQueue({ reviews: [go(S.D), go(S.P, S.LIVE)] }, async q => {
    const qv = await q.queue()
    assert.deepEqual(row(qv, S.Pp).review, { state: 'sameChange', by: 'claude-jake', at: '2026-09-26T07:00:00.000Z', sameAs: short(S.P) })
    assert.equal(qv.default.fork, S.Pp)
  })
})

test('targets: a held range stops the default', async () => {
  await withQueue({ reviews: [go(S.M2)], held: [{ repo: 'fork', base: S.M1, tip: S.C, reason: 'pending Jake and Nat' }] }, async q => {
    const qv = await q.queue()
    assert.equal(row(qv, S.C).held, true)
    assert.equal(row(qv, S.C).heldReason, 'pending Jake and Nat')
    assert.equal(qv.default.fork, S.M1)
    assert.deepEqual(qv.held, [{ repo: 'fork', range: `${short(S.M1)}..${short(S.C)}`, reason: 'pending Jake and Nat' }])
  })
})

test('targets: Requires-Fork stops the gameplay walk until the fork target contains it', async () => {
  const server = go(S.S3, S.S0, { repo: 'server' })
  await withQueue({ reviews: [server] }, async q => {
    const qv = await q.queue()
    assert.equal(row(qv, S.S3).requiresForkMet, false)
    assert.equal(qv.default.server, S.S2)
  })
  await withQueue({ reviews: [server, go(S.M2)] }, async q => {
    const qv = await q.queue()
    assert.equal(row(qv, S.S3).requiresForkMet, true)
    assert.equal(qv.default.server, S.S3)
  })
})

test('targets: up to here on a side-branch commit selects its merge', async () => {
  await withQueue({}, async q => {
    await q.queue()
    assert.deepEqual(q.upTo(S.F1), { side: 'fork', target: S.M1 })
    assert.deepEqual(q.upTo(S.C), { side: 'fork', target: S.C })
    assert.deepEqual(q.upTo(S.S1), { side: 'server', target: S.S1 })
    assert.equal(q.upTo(S.P), null)
    assert.equal(q.upTo('main'), null)
  })
})

test('packs, manual items, versions and the missing-pack tick', async () => {
  const pack = { version: '0.3.47', fork: S.M1, zipSha256: 'a'.repeat(64), builtAt: '2026-09-26T07:27:14Z', builtBy: 'claude-nate', builtOn: 'skymp' }
  const item = { v: 1, id: 'cfg-20260926-a1b2', area: 'config', title: 'Raise maxPlayers', author: 'claude-jake', createdAt: '2026-09-26T07:00:00Z', applyBy: 'claude-nate', flags: ['gameRestart'], keys: ['maxPlayers'], ref: { path: '/opt/dragonbreak-handover/x/', sha256: 'b'.repeat(64) }, state: 'queued', appliedIn: null }
  const setup = cfg => {
    write(cfg.controlDir, {
      'queue/items/cfg-20260926-a1b2.json': JSON.stringify(item),
      'queue/items/cfg-20260926-b2c3.json': JSON.stringify({ ...item, id: 'cfg-20260926-b2c3', value: 'secret' }),
    })
    write(cfg.handoverDir, { 'client-0.3.47/BUILD.json': JSON.stringify(pack), 'client-0.3.46/BUILD.json': JSON.stringify({ ...pack, version: '0.3.46' }) })
  }
  await withQueue({ reviews: [go(S.M2)], liveJson: consistentLive() }, async (q, cfg) => {
    setup(cfg)
    const qv = await q.queue()
    assert.equal(qv.default.client, null)
    assert.equal(qv.default.needsAck, true)
    assert.deepEqual(qv.default.items, [])
    const packRow = row(qv, '0.3.47')
    assert.deepEqual([packRow.kind, packRow.flags, packRow.warnings], ['pack', ['clientUpdate'], ['players must restart their launcher']])
    assert.equal(row(qv, '0.3.46'), undefined)
    assert.equal(row(qv, 'cfg-20260926-b2c3'), undefined)
    assert.ok(qv.warnings.some(w => /refused/.test(w)))
    assert.deepEqual(qv.versions, [{ name: 'Launcher prompt', from: '2.1.29', to: '2.1.30' }])
    assert.doesNotMatch(JSON.stringify(qv), /\/opt\//)
  })
  const reviews = [go(S.M2), go('0.3.47', null, { repo: 'client' }), go('cfg-20260926-a1b2', null, { repo: 'item' })]
  await withQueue({ reviews, liveJson: consistentLive() }, async (q, cfg) => {
    setup(cfg)
    const qv = await q.queue()
    assert.equal(qv.default.client, '0.3.47')
    assert.equal(qv.default.needsAck, false)
    assert.deepEqual(qv.default.items, ['cfg-20260926-a1b2'])
    assert.equal(row(qv, '0.3.47').inDefault, true)
    assert.deepEqual(qv.versions, [{ name: 'Launcher prompt', from: '2.1.29', to: '2.1.30' }, { name: 'Client label', from: '0.3.46', to: '0.3.46', stale: true }])
  })
})

test('blockers: dirty tree, live not on main and an open release', async () => {
  const perms = path.join(repo, 'skymp5-backend/data/role-permissions.json')
  try {
    fs.writeFileSync(perms, '{"edited":true}\n')
    await withQueue({}, async q => {
      const qv = await q.queue()
      assert.deepEqual(qv.blockers, ['dirtyTree'])
      assert.deepEqual(qv.dirty, { count: 1, rolePermissionsOnly: true })
    })
    fs.writeFileSync(path.join(repo, 'README.md'), 'edited\n')
    await withQueue({}, async q => assert.deepEqual((await q.queue()).dirty, { count: 2, rolePermissionsOnly: false }))
  } finally { g('checkout', '--', '.') }
  await withQueue({ liveJson: consistentLive({ fork: { sha: S.P, since: null, how: 'manual' } }) }, async (q, cfg) => {
    write(cfg.controlDir, { 'release/request.json': '{}' })
    assert.deepEqual((await q.queue()).blockers, ['liveNotOnMain', 'openRelease'])
  })
})

test('queueHash: stable, and changed by a new tip, a verdict or a hold', async () => {
  let clock = Date.parse('2026-09-26T08:00:00Z')
  const { q, cfg } = newQueue({ now: () => clock })
  try {
    const first = (await q.queue()).hash
    assert.match(first, /^[0-9a-f]{64}$/)
    assert.equal((await withQueue({}, q2 => q2.queue())).hash, first)
    clock += 31e3
    assert.equal((await q.queue()).hash, first)

    const extra = g('commit-tree', '-p', S.M2, '-m', 'backend: late push', `${S.M2}^{tree}`)
    g('update-ref', 'refs/remotes/origin/main', extra)
    try { assert.notEqual((await q.queue()).hash, first) } finally { g('update-ref', 'refs/remotes/origin/main', S.M2) }
    assert.equal((await q.queue()).hash, first)

    fs.writeFileSync(cfg.reviewsFile, JSON.stringify(go(S.A)) + '\n')
    const reviewed = (await q.queue()).hash
    assert.notEqual(reviewed, first)
    write(cfg.controlDir, { 'queue/held.json': JSON.stringify({ v: 1, ranges: [{ repo: 'fork', base: S.LIVE, tip: S.B, reason: 'wait' }] }) })
    assert.notEqual((await q.queue()).hash, reviewed)
  } finally { q.stop() }
})

test('queue: a 30 s single-flight cache', async () => {
  let clock = Date.parse('2026-09-26T08:00:00Z'), logs = 0
  const { q } = newQueue({ now: () => clock, run: (file, args, opts) => { if (args[4] === 'log') logs++; return realRun(file, args, opts) } })
  try {
    const [a, b] = await Promise.all([q.queue(), q.queue()])
    assert.equal(a, b)
    const afterFirst = logs
    clock += 10e3
    assert.equal(await q.queue(), a)
    assert.equal(logs, afterFirst)
    clock += 25e3
    assert.notEqual(await q.queue(), a)
    assert.ok(logs > afterFirst)
    assert.equal(q.peek().hash, a.hash)
  } finally { q.stop() }
})

test('website check: only valid pages are fetched, and the result is counted', async () => {
  const urls = []
  const fetch = async url => { urls.push(String(url)); return { ok: true, arrayBuffer: async () => Buffer.from(RACES) } }
  await withQueue({ reviews: [go(S.M2)], fetch }, async q => {
    await q.queue()
    const result = await q.checkWebsite()
    assert.deepEqual([...new Set(urls)], ['https://site.example/guides/races.html'])
    assert.deepEqual([result.total, result.matching, result.live], [1, 1, 0])
    assert.deepEqual(result.pages, [{ page: 'guides/races.html', state: 'target' }])
    assert.deepEqual((await q.live()).website, { matching: 1, total: 1, checkedAt: result.checkedAt })
  })
})

test('history: releases, updater runs and backups, newest first, ten per page', async () => {
  await withQueue({}, async (q, cfg) => {
    write(cfg.controlDir, { 'releases.jsonl': JSON.stringify({ at: '2026-09-25T03:05:00Z', relId: 'manual-20260925T030500Z', kind: 'manual', byTag: 'claude-jake', from: { server: S.S0 }, to: { server: S.S1 } }) + '\n' })
    const all = await q.history()
    assert.deepEqual(all.map(r => r.kind), ['updater', 'manual', 'client', 'gameplay'])
    assert.deepEqual(all.map(r => r.n), [4, 3, 2, 1])
    assert.deepEqual(all[1], { n: 3, at: '2026-09-25T03:05:00.000Z', kind: 'manual', relId: 'manual-20260925T030500Z', by: 'claude-jake', fork: null, server: { from: short(S.S0), to: short(S.S1) }, client: null, state: 'done', outside: false, hotfix: false })
    assert.deepEqual(all[2].client, { from: '0.3.45', to: '0.3.46' })
    assert.equal(all[0].outside, true)
    assert.deepEqual((await q.releases('4')).rows.map(r => r.n), [3, 2, 1])
    assert.equal((await q.releases()).more, false)
  })
  const names = Array.from({ length: 14 }, (_, i) => `gameplay-202609${String(i + 10).padStart(2, '0')}T000000Z`)
  await withQueue({ log: '', config: { backupsDir: path.join(root, 'many') } }, async q => {
    for (const n of names) fs.mkdirSync(path.join(root, 'many', n), { recursive: true })
    const page = await q.releases()
    assert.equal(page.rows.length, 10)
    assert.equal(page.more, true)
    assert.equal(page.rows[0].n, 15)
    assert.deepEqual((await q.releases(String(page.rows.at(-1).n))).rows.map(r => r.n), [5, 4, 3, 2, 1])
  })
})

test('security: no secret file is ever opened, and no response carries a file path', async () => {
  const opened = []
  const note = (name, file) => { if (typeof file === 'string') opened.push(`${name} ${file}`) }
  const promises = new Proxy(fs.promises, {
    get: (t, k) => (typeof t[k] === 'function' ? (...a) => { if (['open', 'readFile', 'readdir', 'opendir'].includes(k)) note(k, a[0]); return t[k](...a) } : t[k]),
  })
  const spy = new Proxy(fs, {
    get: (t, k) => (k === 'promises' ? promises : typeof t[k] === 'function' ? (...a) => {
      if (['open', 'openSync', 'readFile', 'readFileSync', 'createReadStream', 'readdirSync', 'opendirSync'].includes(k)) note(k, a[0])
      return t[k](...a)
    } : t[k]),
  })
  const fetch = async () => ({ ok: true, arrayBuffer: async () => Buffer.from(RACES) })
  const svc = { skympSince: Date.parse('2026-01-01T00:00:00Z'), backendSince: Date.parse('2026-01-01T00:00:00Z') }
  await withQueue({ fs: spy, fetch, svc, reviews: [go(S.M2)], liveJson: consistentLive() }, async q => {
    const out = [await q.live(), await q.queue(), await q.checkWebsite(), await q.releases()]
    assert.ok(opened.length > 5)
    assert.deepEqual(opened.filter(o => SECRET_RE.test(path.basename(o.split(' ')[1]))), [])
    assert.ok((await q.live()).drift.includes('configChangedSinceStart'))
    const text = JSON.stringify(out)
    assert.equal(text.includes(root), false)
    assert.doesNotMatch(text, /\/(?:opt|var|etc|home)\//)
  })
})
