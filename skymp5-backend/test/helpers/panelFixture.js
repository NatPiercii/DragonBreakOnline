'use strict'
// A small release repo, control folder, ledger claims and updater markers for the Server panel tests, all under one mkdtemp folder

const { execFileSync } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { priorityPrefix, runFile } = require('../../sources/releaseQueue')

const SECRET_RE = /^(?:server-settings.*\.json|backend\.env|\.env.*|sessions\.json|site-sessions\.json|auth-states\.json)$/
const PURPOSE = 'restart for the combat fix, do not share'
const VERSION_JS = (launcher, client) => `const LATEST_VERSION = '${launcher}'\nconst CLIENT_VERSION = '${client}'\n`
const NEWS = '[{"title":"Hello"}]'
const ZIP = 'zip bytes'
const SUMS = `${'1'.repeat(64)}  DragonBreak.esp\n`
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex')

// System folders that must never appear in a response
const PATH_RE = /\/(?:opt|var|etc|home)\//

// The argv every guarded git call starts with, and the subcommand after it
const gitPrefix = repo => ['-C', repo, '-c', `safe.directory=${repo}`, '-c', 'core.quotePath=false', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.allow=never', '--no-replace-objects']
const gitSub = args => args[args.indexOf('--no-replace-objects') + 1]
// A guarded call's whole command line, under nice and ionice where this box has them
const gitLine = (repo, ...args) => [...priorityPrefix(), 'git', ...gitPrefix(repo), ...args]

function write(dir, files) {
  for (const [f, content] of Object.entries(files)) {
    const p = path.join(dir, f)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content)
  }
}

// The module's own runner, so stdin input (patch-id) reaches git
const realRun = runFile

// systemctl show output for skymp then skymp-update.service, in systemd's own key order
function showOutput(skymp = {}, updater = {}) {
  const unit = u => ['NRestarts', 'ActiveState', 'SubState', 'ActiveEnterTimestamp'].map(k => `${k}=${u[k] ?? ''}`).join('\n')
  return `${unit({ NRestarts: 0, ActiveState: 'active', SubState: 'running', ...skymp })}\n\n${unit({ NRestarts: 0, ActiveState: 'inactive', SubState: 'dead', ...updater })}\n`
}

function createPanelFixture(prefix = 'dbo-panel-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const repo = path.join(root, 'repo')
  let tick = Date.parse('2026-09-20T00:00:00Z') / 1000
  const env = () => {
    tick += 60
    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')))
    return {
      ...base, GIT_AUTHOR_NAME: 'NatPiercii', GIT_AUTHOR_EMAIL: 'nate@example.com', GIT_COMMITTER_NAME: 'NatPiercii', GIT_COMMITTER_EMAIL: 'nate@example.com',
      GIT_AUTHOR_DATE: `${tick} +0000`, GIT_COMMITTER_DATE: `${tick} +0000`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    }
  }
  const g = (...args) => execFileSync('git', ['-C', repo, ...args], { env: env(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const commit = (files, message) => {
    write(repo, files)
    g('add', '-A')
    g('commit', '-q', '--allow-empty', '-m', message)
    return g('rev-parse', 'HEAD')
  }

  fs.mkdirSync(repo)
  g('init', '-q', '-b', 'main')
  const S = {}
  S.A = commit({
    'README.md': 'fork\n', 'skymp5-backend/server.js': 'server\n', 'skymp5-backend/routes/a.js': 'a1\n',
    'skymp5-backend/routes/version.js': VERSION_JS('2.1.29', '0.3.46'), 'deploy/skyrim-data/SHA256SUMS': SUMS, 'website/index.html': 'index\n',
  }, 'backend: first')
  S.B = commit({
    'skymp5-backend/data/y.json': '{}\n', 'skymp5-backend/public/p.css': 'p\n', 'docs/n.md': 'notes\n',
    'skymp5-backend/routes/version.js': VERSION_JS('2.1.30', '0.3.46'),
  }, 'docs: notes, data and the launcher prompt')
  S.C = commit({ 'skymp5-backend/routes/a.js': 'a2\n' }, 'backend: <img src=x onerror=alert(1)> change a route')
  g('checkout', '-q', '--orphan', 'srv')
  g('rm', '-rfq', '.')
  S.S0 = commit({ 'gamemode.js': 'module.exports = 1\n', 'combat.js': 'c1\n' }, 'gamemode: first')
  S.S1 = commit({ 'combat.js': 'c2\n' }, 'combat: one stagger per attacker every 3 s')
  g('checkout', '-q', 'main')
  g('update-ref', 'refs/remotes/origin/main', S.C)
  g('update-ref', 'refs/remotes/origin/server', S.S1)
  fs.writeFileSync(path.join(repo, '.git', 'FETCH_HEAD'), `${S.C}\t\tbranch 'main'\n`)
  write(repo, {
    'skymp5-backend/data/files-version.json': JSON.stringify({ version: '0.3.46', builtAt: '2026-09-25T20:00:00.000Z' }),
    'skymp5-backend/data/news.live.json': NEWS,
    'skymp5-backend/data/sessions.json': 'SECRET', 'skymp5-backend/data/site-sessions.json': 'SECRET', 'skymp5-backend/data/auth-states.json': 'SECRET',
    'skymp5-backend/.env': 'SECRET=1\n',
  })

  const gameServerDir = path.join(root, 'server')
  write(gameServerDir, {
    'dbo-gamemode.js': 'module.exports = 1\n// deployed 2026-09-26T02:29:19Z\n', 'gamemode.js': 'placeholder\n', 'combat.js': 'c1\n',
    'server-settings.json': 'SECRET', 'server-settings-dump.json': 'SECRET',
  })
  const expires = Math.floor(Date.now() / 1000) + 3600
  write(root, {
    'client-files/skymp-client.zip': ZIP, 'skyrim-data/SHA256SUMS': SUMS, 'backend.env': 'SECRET=1\n',
    'backups/gameplay-20260925T010000Z/combat.js': 'old', 'backups/client-0.3.45-20260925T020000Z/files-version.json': '{}',
    'claims/game-server': `operator=claude-jake\npurpose=${PURPOSE}\nsince=${expires - 600}\nexpires=${expires}\n`,
    'claims/updater': `operator=claude-nate\npurpose=${PURPOSE}\nsince=1\nexpires=2\n`,
    'claims/website': `operator=Not A Name\npurpose=${PURPOSE}\nsince=1\nexpires=${expires}\n`,
    'claims/Bad.Name': `operator=claude-jake\npurpose=${PURPOSE}\nexpires=${expires}\n`,
    'claims/backend.tmp': `operator=claude-jake\npurpose=${PURPOSE}\nexpires=${expires}\n`,
  })

  const config = {
    releaseRepo: repo, controlDir: path.join(root, 'control'), reviewsFile: path.join(root, 'reviews.jsonl'), opsClaimsDir: path.join(root, 'claims'),
    updaterLog: path.join(root, 'update.log'), backupsDir: path.join(root, 'backups'), handoverDir: path.join(root, 'handover'),
    gameServerDir, clientFilesDir: path.join(root, 'client-files'), clientZipName: 'skymp-client.zip', scratchDir: root,
    skyrimDataDir: path.join(root, 'skyrim-data'), backendEnvFile: path.join(root, 'backend.env'), websiteUrl: 'https://site.example', serverMaxPlayers: 100,
  }
  write(config.controlDir, {
    'live.json': JSON.stringify({
      v: 1, fork: { sha: S.B, since: '2026-09-25T23:48:55Z', how: 'updater' }, server: { sha: S.S0, how: 'matched', since: '2026-09-26T02:29:19Z' },
      client: { version: '0.3.46', zipSha256: sha256(ZIP), fork: S.A, how: 'direct', since: '2026-09-26T00:00:00Z' },
      news: { sha256: sha256(NEWS), since: null }, website: { fork: null, since: null }, relId: null, byTag: 'claude-jake', backupId: null,
    }),
    'releases.jsonl': JSON.stringify({ at: '2026-09-25T03:05:00Z', relId: 'manual-20260925T030500Z', kind: 'manual', byTag: 'claude-jake', from: { server: S.S0 }, to: { server: S.S0 } }) + '\n',
  })
  fs.writeFileSync(config.updaterLog, [
    `2026-09-25T23:45:02Z UPDATE ${S.A.slice(0, 8)} -> ${S.B.slice(0, 8)}`,
    '2026-09-25T23:48:34Z restarting',
    `2026-09-25T23:48:55Z OK - now ${S.B.slice(0, 8)}, udp/7777 bound`,
    `2026-09-26T07:00:00Z up to date (${S.B.slice(0, 8)})`,
  ].join('\n') + '\n')

  const markerRoot = path.join(root, 'markers')
  const markers = {
    hold: path.join(markerRoot, 'opt', 'skymp-dev-hold'), stopped: path.join(markerRoot, 'opt', 'skymp-stopped'),
    blocked: path.join(markerRoot, 'opt', 'skymp-update-blocked'), buildFailed: path.join(markerRoot, 'opt', 'skymp-build-failed'),
    updaterMode: path.join(markerRoot, 'etc', 'dragonbreak', 'updater-mode'),
    control: path.join(markerRoot, 'etc', 'dragonbreak', 'server-control'),
    updaterDirs: [path.join(markerRoot, 'run', 'dbo-update'), path.join(markerRoot, 'var', 'lib', 'dbo-update')],
  }

  return { root, repo, S, config, markers, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

module.exports = { createPanelFixture, showOutput, realRun, write, gitPrefix, gitSub, gitLine, SECRET_RE, PURPOSE, PATH_RE }
