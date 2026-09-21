const router = require('express').Router()
const http   = require('http')
const fs     = require('fs')
const path   = require('path')
const config = require('../config')

function metricsAuthHeader() {
  const { metricsUser: user, metricsPassword: password } = config
  if (user && password) {
    return { Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` }
  }
  return {}
}

function fetchRaw(host, port) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        hostname: host,
        port,
        path:     '/metrics',
        timeout:  5000,
        headers:  metricsAuthHeader(),
      },
      res => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume()
          reject(new Error(`HTTP ${res.statusCode}`))
          return
        }
        let raw = ''
        res.on('data', c => { raw += c })
        res.on('end', () => resolve(raw))
      }
    )
    req.on('error',   reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}

function parsePrometheus(raw) {
  const result = {}
  for (const line of raw.split('\n')) {
    if (line.startsWith('#') || !line.trim()) continue
    const m = line.match(/^(skymp_\S+)\s+([\d.e+\-]+)/)
    if (m) result[m[1]] = parseFloat(m[2])
  }
  return result
}

// World stats written each minute by the gamemode (server\worldstats.js), sent as ready-to-draw sections
const WORLD_STATS_FILE = process.env.WORLD_STATS_FILE
  || path.join(__dirname, '..', '..', 'build', 'dist', 'server', 'server-stats.json')
const STALE_MS = 5 * 60000

function worldSections() {
  let w
  try { w = JSON.parse(fs.readFileSync(WORLD_STATS_FILE, 'utf8')) } catch { return null }
  const n = v => Number(v || 0).toLocaleString('en-US')
  const age = Date.now() - Date.parse(w.updatedAt || 0)
  const gold = w.gold || {}
  const races = Array.isArray(w.races) ? w.races : []
  const top = races.reduce((m, r) => Math.max(m, r.count), 0) || 1
  return {
    updatedAt: w.updatedAt,
    stale: !(age < STALE_MS),
    sections: [
      { type: 'cards', cards: [
        { label: 'Online Now', value: n(w.online), sub: `Peak today ${n(w.peakToday)}` },
        { label: 'Characters', value: n(w.characters), sub: `${n(w.players)} players` },
        { label: 'Gold Held by Players', value: n(gold.total), sub: `${n(gold.carried)} carried, ${n(gold.stored)} in storage` },
      ] },
      { type: 'board', title: 'Races of the Realm', rows: races.map((r, i) => ({ rank: i + 1, label: r.race, value: n(r.count), share: r.count / top })) },
    ],
  }
}

router.get('/', async (_req, res) => {
  const world = worldSections()
  const { skyrimServerHost: host, skympUiPort: port } = config
  let metrics = null, error = null
  try { metrics = parsePrometheus(await fetchRaw(host, port)) } catch (err) { error = err.message }
  if (!metrics && !world) return res.json({ ok: false, error })
  res.json({ ok: true, metrics: metrics || {}, world })
})

module.exports = router
