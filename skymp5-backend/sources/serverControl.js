'use strict'
// Owner controls for the game server at 0 players (Phase 1b): Start, Stop (stays stopped) and Restart through systemd.
// An action holds the game-server claim in the ops ledger from before the change until systemd shows the result.
// Every command is execFile with a fixed argv; user text reaches only the ledger's reason arguments, each as one element.

const nodeFs = require('fs')
const path = require('path')
const { runFile } = require('./releaseQueue')
const { freshOnline, MARKERS, SYSTEMCTL_ENV, RUNNING } = require('./serverStatus')
const { UNSAFE_CHARS } = require('./problemReport')
const discordAudit = require('./discord/audit')

const OPS = '/opt/dragonbreak-ops/ops'
// The ledger operator for these actions; it must match the ledger's ^[a-z][a-z0-9-]{1,30}$
const OPERATOR = 'site-owner'
const RESOURCE = 'game-server'
const CLAIM_MIN = 15
const ACTIONS = Object.freeze(['start', 'stop', 'restart'])
const SYSTEMCTL = Object.freeze({
  start: Object.freeze(['--no-block', 'start', 'skymp.service']),
  stop: Object.freeze(['--no-block', 'stop', 'skymp.service']),
  restart: Object.freeze(['--no-block', 'restart', 'skymp.service']),
})
const CONFIRM = Object.freeze({ start: 'START', stop: 'STOP', restart: 'RESTART' })
const VERB = Object.freeze({ start: 'Start', stop: 'Stop (stays stopped)', restart: 'Restart' })
const OUTCOME = Object.freeze({ done: 'done', failed: 'FAILED', unconfirmed: 'not confirmed within 2 minutes' })
const BODY_KEYS = new Set(['requestId', 'reason', 'confirm'])
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const HELD_RE = /^HELD: \S+ is claimed by ([a-z][a-z0-9-]{1,30}) until (\S+)/m
// The report cleaner's characters plus C1 controls and the Arabic letter mark
const UNSAFE_RE = new RegExp(`[${UNSAFE_CHARS}\\x80-\\x9f\\u061c]`, 'g')
const REASON_MIN = 5
const REASON_MAX = 200
const RUN_TIMEOUT_MS = 20 * 1000
const POLL_MS = 3000
const POLLS = 40
const JOBS_KEPT = 50
const RECENT_JOB_MS = 10 * 60 * 1000
const NOT_OWNER_AUDIT_MS = 60 * 1000
const DOWN = new Set(['inactive', 'failed'])
// The unit as the cached status sees it, for the buttons only; a POST asks systemd and the heartbeat again
const UNIT_OF = Object.freeze({ reachable: 'active', unresponsive: 'active', down: 'inactive', stopped: 'inactive', starting: 'activating' })

const iso = ms => new Date(ms).toISOString()
const clean = (value, max = Infinity) => [...String(value ?? '').normalize('NFC').replace(UNSAFE_RE, ' ').replace(/\s+/g, ' ').trim()].slice(0, max).join('').trim()

function cleanReason(value) {
  if (typeof value !== 'string') return null
  const reason = clean(value)
  const n = [...reason].length
  return n >= REASON_MIN && n <= REASON_MAX ? reason : null
}

// The body's requestId and reason, or the code that refuses it
function parseRequest(action, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !BODY_KEYS.has(k))) return { error: 'badRequest' }
  if (typeof body.requestId !== 'string' || !UUID_RE.test(body.requestId)) return { error: 'badRequest' }
  const reason = cleanReason(body.reason)
  if (!reason) return { error: 'badReason' }
  if (typeof body.confirm !== 'string' || body.confirm.trim() !== CONFIRM[action]) return { error: 'badConfirm' }
  return { requestId: body.requestId.toLowerCase(), reason }
}

// Why an action cannot run with this unit, updater and player count; null when it can
function refusal(action, { unit, updating, online }) {
  if (updating) return 'updating'
  if (!unit) return 'unavailable'
  const down = DOWN.has(unit.active)
  if (!down && unit.active !== 'active') return 'changing'
  if (action === 'start') return down ? null : 'alreadyRunning'
  if (down) return action === 'stop' ? 'notRunning' : 'useStart'
  if (online == null) return 'playersUnknown'
  return online > 0 ? 'playersOnline' : null
}

// Who stopped the server and why, from the marker a Start clears
function markerNote(text) {
  let m = null
  try { m = JSON.parse(text) } catch { /* a marker written by hand */ }
  if (!m || typeof m !== 'object') return 'cleared the stopped marker'
  return `cleared the stopped marker (${clean(m.by, 40) || '?'}, ${clean(m.at, 30) || '?'}: ${clean(m.reason, REASON_MAX)})`
}

function createServerControl({
  status, getHeartbeat = () => null, run = runFile, fs = nodeFs, now = Date.now,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)), audit = discordAudit, opsPath = OPS,
}) {
  const fsp = fs.promises
  const markers = status.markers || MARKERS
  const jobs = new Map()
  const notOwnerAt = new Map()
  let current = null, last = null
  const childOpts = () => ({ env: SYSTEMCTL_ENV(), timeout: RUN_TIMEOUT_MS, maxBuffer: 64 * 1024 })
  const rollback = {
    start: 'Stop on the website dashboard, or systemctl stop skymp',
    stop: `Start on the website dashboard, or rm ${markers.stopped} && systemctl start skymp`,
    restart: 'Nothing to undo; if it stays down, Start on the website dashboard or systemctl start skymp',
  }

  function say(text) {
    try { audit.log(`WEB ${text}`) } catch (err) { console.error('[server-control] audit failed:', err.message) }
  }

  // off, dry-run or on, read on every request so switching needs no restart; missing or anything else is off
  async function setting() {
    try {
      const word = (await fsp.readFile(markers.control, 'utf8')).trim().toLowerCase()
      return word === 'on' || word === 'dry-run' ? word : 'off'
    } catch { return 'off' }
  }

  // One ledger call: its exit code and output, never a throw
  async function ops(args) {
    try {
      const { stdout } = await run(opsPath, args, childOpts())
      return { code: 0, stdout: String(stdout || '') }
    } catch (err) { return { code: Number.isInteger(err.code) ? err.code : -1, stdout: String(err.stdout || '') } }
  }

  async function release() {
    if ((await ops(['release', RESOURCE, OPERATOR])).code !== 0) console.error('[server-control] ops release failed; the claim expires by itself')
  }

  const exists = file => fsp.stat(file).then(() => true, () => false)

  async function readState() {
    const [{ skymp, updater }, building] = await Promise.all([
      status.units(), Promise.all(markers.updaterDirs.map(d => exists(path.join(d, 'building')))),
    ])
    return { unit: skymp, updating: RUNNING.has(updater?.active) || building.some(Boolean), online: freshOnline(getHeartbeat(), skymp, now()) }
  }

  async function readMarker() {
    try { return await fsp.readFile(markers.stopped, 'utf8') } catch (err) { if (err.code === 'ENOENT') return null; throw err }
  }

  async function writeMarker(text) {
    const tmp = `${markers.stopped}.tmp-${process.pid}`
    await fsp.writeFile(tmp, text, { mode: 0o644 })
    await fsp.chmod(tmp, 0o644)
    await fsp.rename(tmp, markers.stopped)
  }

  const restoreMarker = prev => (prev == null ? fsp.rm(markers.stopped, { force: true }) : writeMarker(prev))

  const view = job => ({
    id: job.id, action: job.action, state: job.state, dryRun: job.dryRun, by: job.by, reason: job.reason,
    requestedAt: iso(job.requestedAt), finishedAt: job.finishedAt ? iso(job.finishedAt) : null,
  })

  function finish(job, state) {
    job.state = state
    job.finishedAt = now()
    last = job
  }

  // Polls systemd until the action shows its result: done, failed, or unconfirmed after POLLS polls
  async function follow(job) {
    const issued = Math.floor(job.issuedAt / 1000) * 1000
    let restarts = null
    for (let i = 0; i < POLLS; i++) {
      await wait(POLL_MS)
      const { skymp: unit } = await status.units()
      if (!unit) continue
      if (job.action === 'stop') {
        if (DOWN.has(unit.active)) return 'done'
        continue
      }
      if (unit.active === 'failed') return 'failed'
      if (unit.since == null || unit.since < issued) continue
      if (restarts != null && unit.nRestarts > restarts) return 'failed'
      restarts ??= unit.nRestarts
      if (unit.active === 'active' && freshOnline(getHeartbeat(), unit, now()) != null) return 'done'
    }
    return 'unconfirmed'
  }

  async function attempt(entry, action, { requestId, reason, by, discordId }) {
    const who = `${by} (${discordId})`
    const refuse = (code, error, extra = {}) => {
      say(`${action} refused for ${who}: ${error}`)
      return { status: code, body: { error, ...extra } }
    }
    const mode = await setting()
    if (mode === 'off') return refuse(503, 'controlsOff')
    if (current) return refuse(409, 'busy')
    const job = { id: requestId, action, state: 'checking', dryRun: mode === 'dry-run', by, reason, requestedAt: now(), finishedAt: null, issuedAt: null }
    current = job
    let claimed = false, following = false
    try {
      const state = await readState()
      const why = refusal(action, state)
      if (why) return refuse(why === 'unavailable' ? 503 : 409, why)
      if (job.dryRun) {
        entry.job = job
        finish(job, 'done')
        say(`${action} (dry run, nothing ran) by ${who}: ${reason}`)
        return { status: 202, body: { job: view(job) } }
      }

      const purpose = `${VERB[action]} from the website dashboard by ${by}: ${reason}`
      const claim = await ops(['claim', RESOURCE, OPERATOR, purpose, String(CLAIM_MIN)])
      if (claim.code === 2) return refuse(409, 'claimed', { holder: HELD_RE.exec(claim.stdout)?.[1] || null })
      if (claim.code !== 0) return refuse(503, 'ledgerUnavailable')
      claimed = true
      const prev = action === 'restart' ? null : await readMarker()
      const note = action === 'start' && prev != null ? `; ${markerNote(prev)}` : ''
      if ((await ops(['log', OPERATOR, `${purpose}${note}`, rollback[action]])).code !== 0) return refuse(503, 'ledgerUnavailable')

      // A player who joined since the first check calls it off
      if (action !== 'start') {
        const online = freshOnline(getHeartbeat(), state.unit, now())
        if (online !== 0) {
          await ops(['log', OPERATOR, `Called off: ${VERB[action]} from the website dashboard, a player joined before it ran`, 'Nothing to roll back'])
          return refuse(409, online == null ? 'playersUnknown' : 'playersOnline')
        }
      }

      entry.job = job
      job.state = 'running'
      job.issuedAt = now()
      say(`${action} requested by ${who}: ${reason}`)
      try {
        if (action === 'stop') await writeMarker(`${JSON.stringify({ by: `${by} (website)`, reason, at: iso(job.issuedAt) })}\n`)
        if (action === 'start' && prev != null) await fsp.rm(markers.stopped, { force: true })
        await run('systemctl', [...SYSTEMCTL[action]], childOpts())
      } catch (err) {
        console.error(`[server-control] ${action} failed:`, err.message)
        if (action !== 'restart') await restoreMarker(prev).catch(e => console.error('[server-control] marker not restored:', e.message))
        finish(job, 'failed')
        say(`${action} by ${who} FAILED before systemd took it`)
        return { status: 502, body: { error: 'actionFailed', job: view(job) } }
      }

      following = true
      follow(job)
        .catch(err => { console.error('[server-control] follow failed:', err.message); return 'unconfirmed' })
        .then(outcome => {
          finish(job, outcome)
          say(`${action} by ${who} ${OUTCOME[outcome]}`)
          return release()
        })
        .catch(err => console.error('[server-control] after the action:', err.message))
        .finally(() => { current = null })
      return { status: 202, body: { job: view(job) } }
    } finally {
      if (!following) {
        if (claimed) await release()
        current = null
      }
    }
  }

  // One action per requestId: a repeat gets the same job and never runs a second action
  async function perform(action, { requestId: rawId, reason: text, by, discordId }) {
    const reason = cleanReason(text)
    if (!reason) return { status: 400, body: { error: 'badReason' } }
    const requestId = String(rawId).toLowerCase()
    const known = jobs.get(requestId)
    if (known) {
      const first = await known.promise
      return known.job ? { status: 200, body: { job: view(known.job) } } : first
    }
    const entry = { job: null, promise: null }
    jobs.set(requestId, entry)
    for (const id of jobs.keys()) { if (jobs.size <= JOBS_KEPT) break; jobs.delete(id) }
    const name = clean(by, 32) || 'owner'
    entry.promise = attempt(entry, action, { requestId, reason, by: name, discordId: String(discordId) })
      .catch(err => {
        console.error('[server-control] action error:', err.message)
        return { status: 503, body: { error: 'unavailable' } }
      })
      // A refusal is not remembered, so the same dialog can try again once the cause clears
      .then(result => { if (!entry.job) jobs.delete(requestId); return result })
    return entry.promise
  }

  const known = requestId => typeof requestId === 'string' && jobs.has(requestId.toLowerCase())

  function job(id) {
    const entry = typeof id === 'string' && UUID_RE.test(id) ? jobs.get(id.toLowerCase()) : null
    return entry?.job ? view(entry.job) : null
  }

  // A refused non-Owner is audited at most once a minute per account
  function notOwner(by, discordId) {
    const t = now()
    if (t - (notOwnerAt.get(discordId) || 0) < NOT_OWNER_AUDIT_MS) return
    if (notOwnerAt.size > 1000) notOwnerAt.clear()
    notOwnerAt.set(discordId, t)
    say(`control refused for ${clean(by, 32) || '?'} (${discordId}): not an Owner`)
  }

  // What the page offers this viewer, from the cached status
  function controlsFor(s, { owner, setting: mode }) {
    const state = s.service?.state
    const heldBy = (s.claims || []).some(c => c.resource === RESOURCE && c.operator !== OPERATOR)
    const gate = !owner ? 'notOwner' : mode === 'off' ? 'controlsOff' : current ? 'busy' : heldBy ? 'claimed' : null
    const seen = { unit: UNIT_OF[state] ? { active: UNIT_OF[state] } : null, updating: state === 'updating', online: s.players?.online ?? null }
    const why = Object.fromEntries(ACTIONS.map(a => [a, gate || refusal(a, seen)]))
    const shown = current?.state === 'running' ? current : last
    return {
      mode: 'zeroPlayers', update: 'notYet', setting: mode, owner,
      canStart: !why.start, canStop: !why.stop, canRestart: !why.restart,
      why: gate || (DOWN.has(seen.unit?.active) ? why.start : why.stop),
      job: shown && (shown.state === 'running' || now() - shown.finishedAt < RECENT_JOB_MS) ? view(shown) : null,
    }
  }

  return { perform, known, job, notOwner, controlsFor, setting }
}

module.exports = { createServerControl, parseRequest, cleanReason, refusal, ACTIONS, SYSTEMCTL, CONFIRM, OPERATOR, RESOURCE, OPS, CLAIM_MIN }
