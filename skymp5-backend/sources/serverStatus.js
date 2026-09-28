'use strict'
// Server panel status: the game service, players, the updater, what is live and the queue counts
// A request runs only one fixed systemctl show plus file reads; git work stays in the release queue's background refresh

const nodeFs = require('fs')
const path = require('path')
const { createReleaseQueue, gitSync, runFile, isSecretFile, readErrors } = require('./releaseQueue')

const STATUS_TTL_MS = 5 * 1000
const SYSTEMCTL_TIMEOUT_MS = 3000
const SYSTEMCTL_ARGS = Object.freeze(['show', 'skymp', 'skymp-update.service', '--timestamp=unix', '-p', 'ActiveState,SubState,ActiveEnterTimestamp,NRestarts'])
const SYSTEMCTL_ENV = () => ({ PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', LANG: 'C' })
const FRESH_BEAT_MS = 20 * 1000
const SILENT_MS = 60 * 1000
const RESTART_WINDOW_MS = 5 * 60 * 1000
const HISTORY_ROWS = 5
const MAX_CLAIMS = 20
const SHA_RE = /^[0-9a-f]{40}$/
// Resource and operator names as the ops ledger accepts them
const NAME_RE = /^[a-z][a-z0-9-]{1,30}$/
const RUNNING = new Set(['active', 'activating', 'deactivating', 'reloading'])

// Fixed paths of the deploy hold, the owner stop and the updater's markers
const MARKERS = Object.freeze({
  hold: '/opt/skymp-dev-hold',
  stopped: '/opt/skymp-stopped',
  blocked: '/opt/skymp-update-blocked',
  buildFailed: '/opt/skymp-build-failed',
  updaterMode: '/etc/dragonbreak/updater-mode',
  control: '/etc/dragonbreak/server-control',
  updaterDirs: Object.freeze(['/run/dbo-update', '/var/lib/dbo-update']),
})

const isoOrNull = ms => (Number.isFinite(ms) ? new Date(ms).toISOString() : null)

// Age of the last heartbeat; a beat from before the current start says nothing about this run
function beatAgeOf(beat, unit, t) {
  const at = Date.parse(beat?.lastSeen || '')
  return Number.isFinite(at) && (unit?.since == null || at >= unit.since) ? t - at : null
}

// Players online from a fresh beat of the current run, else null
function freshOnline(beat, unit, t) {
  const age = beatAgeOf(beat, unit, t)
  return age != null && age < FRESH_BEAT_MS && Number.isInteger(beat.online) ? beat.online : null
}

// One value per ttl, with concurrent callers sharing a single run
function cachedFor(ttl, now, fn) {
  let hit = null, pending = null
  return () => {
    if (hit && now() - hit.at < ttl) return Promise.resolve(hit.value)
    if (!pending) pending = fn().then(value => { hit = { at: now(), value }; return value }).finally(() => { pending = null })
    return pending
  }
}

// systemctl show prints one block of key=value lines per unit, in the order the units were named
function parseShow(text) {
  const units = [{}]
  for (const line of String(text).split('\n')) {
    if (!line.trim()) { if (Object.keys(units.at(-1)).length) units.push({}); continue }
    const i = line.indexOf('=')
    if (i > 0) units.at(-1)[line.slice(0, i)] = line.slice(i + 1).trim()
  }
  return units.map(u => {
    if (!u.ActiveState) return null
    const since = /^@(\d+)/.exec(u.ActiveEnterTimestamp || '')
    return {
      active: u.ActiveState, sub: u.SubState || null, since: since ? Number(since[1]) * 1000 : null,
      nRestarts: /^\d+$/.test(u.NRestarts || '') ? Number(u.NRestarts) : null,
    }
  })
}

function readBootSha(repo, runSync) {
  try {
    const out = gitSync(repo, ['rev-parse', '--verify', '--end-of-options', 'HEAD'], runSync ? { runSync } : {}).trim()
    return SHA_RE.test(out) ? out : null
  } catch { return null }
}

function createServerStatus({ config, getHeartbeat = () => null, run = runFile, runSync, fs = nodeFs, now = Date.now, markers = MARKERS, queue, queueDeps = {} }) {
  const fsp = fs.promises
  // The commit the backend started from, read once while it starts
  const boot = { since: now() - process.uptime() * 1000, sha: readBootSha(config.releaseRepo, runSync) }
  const restarts = { n: null, risenAt: null }
  const unreadable = readErrors('server-status')

  // Uncached, for the controls; the status shares one read per 5 s
  async function units() {
    try {
      // Only PATH and LANG, so no backend secret reaches the child (as for git)
      const { stdout } = await run('systemctl', [...SYSTEMCTL_ARGS], { env: SYSTEMCTL_ENV(), timeout: SYSTEMCTL_TIMEOUT_MS, maxBuffer: 64 * 1024 })
      const [skymp = null, updater = null] = parseShow(stdout)
      return { skymp, updater }
    } catch { return { skymp: null, updater: null } }
  }
  const systemd = cachedFor(STATUS_TTL_MS, now, units)

  async function services() {
    const { skymp } = await systemd()
    return { skympSince: skymp?.since ?? null, backendSince: boot.since, bootSha: boot.sha }
  }

  const releaseQueue = queue || createReleaseQueue({ config, fs, now, services, ...queueDeps })

  async function exists(file) {
    try { await fsp.stat(file) } catch (err) { unreadable.note(file, err, 'stat'); return false }
    unreadable.clear(file, 'stat')
    return true
  }
  const anyExists = async files => (await Promise.all(files.map(exists))).some(Boolean)

  // The first bytes of a small marker or claim file; missing gives null
  async function head(file, bytes) {
    if (isSecretFile(file)) return null
    let fh = null
    try {
      fh = await fsp.open(file, 'r')
      const buf = Buffer.alloc(bytes)
      const { bytesRead } = await fh.read(buf, 0, bytes, 0)
      unreadable.clear(file)
      return buf.subarray(0, bytesRead).toString('utf8')
    } catch (err) { unreadable.note(file, err); return null } finally { await fh?.close().catch(() => {}) }
  }

  async function updaterState(unit, log) {
    const dirs = marker => markers.updaterDirs.map(d => path.join(d, marker))
    const [hold, blocked, failed, modeWord, building, waiting] = await Promise.all([
      exists(markers.hold), exists(markers.blocked), head(markers.buildFailed, 64), head(markers.updaterMode, 64),
      anyExists(dirs('building')), anyExists(dirs('waiting')),
    ])
    const word = (modeWord || '').trim().toLowerCase()
    const mode = word === 'release' ? 'release' : hold ? 'hold-s0' : word === 'follow-main' ? 'follow-main' : 'none'
    const last = log.updates.at(-1)
    return {
      mode, active: RUNNING.has(unit?.active), building, waiting, hold,
      lastRun: log.lastRun,
      lastUpdate: last ? { from: last.from, to: last.to, state: last.okAt ? 'ok' : 'unfinished', at: last.at, failed: last.failed } : { from: null, to: null, state: 'unknown', at: null, failed: null },
      frozen: mode === 'release' && hold, blocked,
      buildFailedFor: failed == null ? null : /^[0-9a-f]{40}/.exec(failed.trim())?.[0] || 'unknown',
    }
  }

  // The stop marker (written by the backend's Stop or by root); one older than the unit's last start was left by a reboot or a manual start
  async function stopMarker(unit) {
    let st
    try { st = await fsp.stat(markers.stopped) } catch (err) { unreadable.note(markers.stopped, err, 'stat'); return null }
    unreadable.clear(markers.stopped, 'stat')
    let m = null
    try { m = JSON.parse(await head(markers.stopped, 1024)) } catch { /* not JSON: made by hand */ }
    const text = (key, max) => (typeof m?.[key] === 'string' ? m[key].slice(0, max) : null)
    return { by: text('by', 40), reason: text('reason', 200), at: isoOrNull(st.mtimeMs), leftover: unit?.since != null && st.mtimeMs < unit.since }
  }

  // Reachable, down, unresponsive, updating, stopped or starting (control panel 3.2)
  function serviceState(unit, beatAge, stopped, updater) {
    const t = now()
    if (unit?.nRestarts != null) {
      if (restarts.n != null && unit.nRestarts > restarts.n) restarts.risenAt = t
      restarts.n = unit.nRestarts
    }
    const fresh = beatAge != null && beatAge < FRESH_BEAT_MS
    if (updater.building || (updater.active && unit && unit.active !== 'active')) return 'updating'
    if (!unit) return fresh ? 'reachable' : 'down'
    if (unit.active === 'activating' || unit.active === 'reloading') return 'starting'
    if (unit.active !== 'active') return stopped ? 'stopped' : 'down'
    if (fresh) return 'reachable'
    if (restarts.risenAt != null && t - restarts.risenAt < RESTART_WINDOW_MS) return 'unresponsive'
    if (beatAge == null) return unit.since != null && t - unit.since > SILENT_MS ? 'unresponsive' : 'starting'
    return beatAge > SILENT_MS ? 'unresponsive' : 'reachable'
  }

  // Who holds which ledger resource and until when; the purpose line is never read out
  async function claims() {
    let names
    try { names = await fsp.readdir(config.opsClaimsDir) } catch (err) { unreadable.note(config.opsClaimsDir, err); return [] }
    unreadable.clear(config.opsClaimsDir)
    const out = []
    for (const name of names.filter(n => NAME_RE.test(n)).sort().slice(0, MAX_CLAIMS)) {
      const text = await head(path.join(config.opsClaimsDir, name), 4096)
      const field = key => new RegExp(`^${key}=(.*)$`, 'm').exec(text || '')?.[1].trim() || ''
      const operator = field('operator'), expires = Number(field('expires'))
      if (!NAME_RE.test(operator) || !Number.isFinite(expires) || expires * 1000 <= now()) continue
      out.push({ resource: name, operator, until: isoOrNull(expires * 1000) })
    }
    return out
  }

  function liveView(lv) {
    if (!lv) return null
    return {
      source: lv.source,
      fork: {
        sha: lv.fork.sha, subject: lv.fork.subject, at: lv.fork.at, since: lv.fork.since, confirmed: lv.fork.confirmed,
        headMatches: lv.fork.headMatches, head: lv.fork.headMatches ? null : lv.fork.head,
      },
      server: { sha: lv.server.sha, how: lv.server.how, deployedAt: lv.server.deployedAt },
      client: { version: lv.client.version, builtAt: lv.client.builtAt, fork: lv.client.fork, sourceOnMain: lv.client.sourceOnMain, zipMatches: lv.client.zipMatches },
      news: lv.news, launcher: lv.launcher, clientLabel: lv.clientLabel, website: lv.website, plugins: lv.plugins, githubLive: lv.githubLive,
    }
  }

  const queueView = qv => qv && {
    hash: qv.hash, fetchedAt: qv.fetchedAt, generatedAt: qv.generatedAt, counts: qv.counts, flags: qv.flags,
    drift: qv.drift, blockers: qv.blockers, dirty: qv.dirty, needsAck: qv.default.needsAck,
  }

  async function build() {
    const [{ skymp, updater: updaterUnit }, log, history, claimList] = await Promise.all([
      systemd(), releaseQueue.updaterLog().catch(() => ({ updates: [], lastRun: null })), releaseQueue.history().catch(() => []), claims(),
    ])
    const [updater, stopped] = await Promise.all([updaterState(updaterUnit, log), stopMarker(skymp)])
    const beat = getHeartbeat()
    const beatAt = Date.parse(beat?.lastSeen || '')
    const t = now()
    const beatAge = beatAgeOf(beat, skymp, t)
    const state = serviceState(skymp, beatAge, stopped && !stopped.leftover, updater)
    const qv = releaseQueue.peek()
    const lv = releaseQueue.peekLive()
    const failed = releaseQueue.lastFailure?.() || null
    return {
      generatedAt: isoOrNull(t),
      service: { state, sub: skymp?.sub ?? null, since: isoOrNull(skymp?.since), nRestarts: skymp?.nRestarts ?? null },
      stopped,
      players: {
        online: state === 'down' || state === 'stopped' ? 0 : freshOnline(beat, skymp, t),
        max: Number.isInteger(beat?.maxPlayers) ? beat.maxPlayers : config.serverMaxPlayers ?? null,
        heartbeatAt: isoOrNull(beatAt),
      },
      backend: { since: isoOrNull(boot.since), bootSha: boot.sha, restartPending: lv?.backend?.restartPending ?? null },
      updater,
      live: liveView(lv),
      queue: qv || failed ? { ...queueView(qv), unavailable: failed } : null,
      release: { open: null },
      schedules: [],
      history: history.slice(0, HISTORY_ROWS),
      claims: claimList,
    }
  }

  return { get: cachedFor(STATUS_TTL_MS, now, build), services, units, queue: releaseQueue, boot, markers }
}

module.exports = { createServerStatus, parseShow, freshOnline, MARKERS, SYSTEMCTL_ARGS, SYSTEMCTL_ENV, RUNNING }
