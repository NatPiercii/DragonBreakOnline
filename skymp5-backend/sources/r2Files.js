'use strict'
// Big launcher downloads from Cloudflare R2 instead of the home upload (7 Oct 2026: about 40 launchers pulling the 184 MB
// client zip at once over the 5G upload were cut off mid-way and locked out). data/r2.json lists the versions that are
// uploaded AND verified in the bucket; a download of one of those versions is redirected there, anything else is served
// from disk as before. Deleting data/r2.json, or "enabled": false, turns it off at the next request (no restart).
//
//   data/r2.json  { "enabled": true, "baseUrl": "https://files.dragonbreakonline.com",
//                   "client": { "0.3.80": 184377941 }, "extra": ["0427996da9bfff8a"] }
//   client maps a version to its zip size: a version number can be reused (the 0.3.81 rollback put 0.3.80 back), so the
//   zip goes to R2 only while files-version.json's zipSize still matches what was uploaded.
//   bucket        client/<files-version.json version>/SkyMP-client.zip
//                 extra/<extra-files.json version>/<manifest path, each segment URL-encoded>
//
// Extras: every launcher's downloadToFile follows redirects and checks the sha256 afterwards, so they all get the 302.
// The zip: launchers up to 2.1.43 don't follow redirects there, so only a request with X-DBO-Accept-Redirect: 1 gets one.

const fs   = require('fs')
const path = require('path')

const DATA_DIR = path.join(__dirname, '..', 'data')
const CLIENT_OBJECT = 'SkyMP-client.zip'

function createR2Files({ dataDir = DATA_DIR } = {}) {
  const cache = new Map()
  // A JSON file re-read only when its size or mtime changes; null when missing or unreadable
  function readJson(name) {
    const file = path.join(dataDir, name)
    let st
    try { st = fs.statSync(file) } catch { cache.delete(file); return null }
    const hit = cache.get(file)
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value
    let value = null
    try { value = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { /* half-written or bad: treated as missing */ }
    cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, value, paths: null })
    return value
  }

  function settings() {
    const s = readJson('r2.json')
    if (!s || s.enabled === false) return null
    if (typeof s.baseUrl !== 'string' || !/^https:\/\/[^/]+/i.test(s.baseUrl)) return null
    return {
      baseUrl: s.baseUrl.replace(/\/+$/, ''),
      client:  s.client && typeof s.client === 'object' && !Array.isArray(s.client) ? s.client : {},
      extra:   Array.isArray(s.extra) ? s.extra.map(String) : [],
    }
  }

  // The extra manifest's version and its set of paths, or null
  function extraManifest() {
    const m = readJson('extra-files.json')
    if (!m || typeof m.version !== 'string' || !Array.isArray(m.files)) return null
    const hit = cache.get(path.join(dataDir, 'extra-files.json'))
    if (!hit.paths) hit.paths = new Set(m.files.map(f => f && f.path).filter(p => typeof p === 'string'))
    return { version: m.version, paths: hit.paths }
  }

  const encodePath = p => p.split('/').map(encodeURIComponent).join('/')

  // Mounted at /api/files/extra ahead of express.static: a listed file of a version that is in the bucket goes to R2
  function extraRedirect(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next()
    const s = settings()
    if (!s) return next()
    const m = extraManifest()
    if (!m || !s.extra.includes(m.version)) return next()
    let segs
    try { segs = req.path.split('/').slice(1).map(decodeURIComponent) } catch { return next() }
    if (!segs.length || segs.some(x => x === '' || x === '.' || x === '..')) return next()
    const rel = segs.join('/')
    if (!m.paths.has(rel)) return next()
    res.set('Cache-Control', 'no-store')
    res.redirect(302, `${s.baseUrl}/extra/${encodeURIComponent(m.version)}/${encodePath(rel)}`)
  }

  // The R2 URL of the client zip for this request, or null to serve it from disk
  function clientZipUrl(req) {
    if (req.get('x-dbo-accept-redirect') !== '1') return null
    const s = settings()
    if (!s) return null
    const v = readJson('files-version.json')
    const version = v && typeof v.version === 'string' ? v.version : null
    if (!version || !Object.prototype.hasOwnProperty.call(s.client, version)) return null
    if (!Number.isFinite(v.zipSize) || Number(s.client[version]) !== v.zipSize) return null
    return `${s.baseUrl}/client/${encodeURIComponent(version)}/${CLIENT_OBJECT}`
  }

  return { settings, extraRedirect, clientZipUrl }
}

module.exports = { createR2Files, ...createR2Files() }
