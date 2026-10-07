'use strict'
// Big launcher downloads from Cloudflare R2 instead of the home upload (7 Oct 2026: about 40 launchers pulling the 184 MB
// client zip at once over the 5G upload were cut off mid-way and locked out). data/r2.json lists the versions that are
// uploaded AND verified in the bucket; a download of one of those versions is redirected there, anything else is served
// from disk as before. Deleting data/r2.json, or "enabled": false, turns it off at the next request (no restart).
//
//   data/r2.json  { "enabled": true, "baseUrl": "https://files.dragonbreakonline.com",
//                   "client": { "0.3.80": 184377941 }, "clientFiles": { "0.3.80": 184377941 },
//                   "extra": ["0427996da9bfff8a"] }
//   client maps a version to its zip size: a version number can be reused (the 0.3.81 rollback put 0.3.80 back), so the
//   zip goes to R2 only while files-version.json's zipSize still matches what was uploaded.
//   clientFiles is the same for the package's files one by one (scripts/publish-client-r2.sh adds a version only after
//   checking every file from the public side; docs/per-file-client.md).
//   bucket        client/<files-version.json version>/SkyMP-client.zip
//                 client/<files-version.json version>/files/<package path, each segment URL-encoded>
//                 extra/<extra-files.json version>/<manifest path, each segment URL-encoded>
//
// Extras: every launcher's downloadToFile follows redirects and checks the sha256 afterwards, so they all get the 302.
// The zip and the client's single files: launchers up to 2.1.43 don't follow redirects there, so only a request with
// X-DBO-Accept-Redirect: 1 gets one (2.1.44 sends it, follows https redirects only and checks every file's sha256).

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
    const versionMap = m => (m && typeof m === 'object' && !Array.isArray(m) ? m : {})
    return {
      baseUrl:     s.baseUrl.replace(/\/+$/, ''),
      client:      versionMap(s.client),
      clientFiles: versionMap(s.clientFiles),
      extra:       Array.isArray(s.extra) ? s.extra.map(String) : [],
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

  // The R2 folder of the current client package when the request asks for redirects and versions (a map in r2.json:
  // version -> zip size) lists files-version.json's version with the same zip size; else null.
  // expected: the version the caller checked the request against; any other current version gives null.
  function clientBase(req, listKey, expected) {
    if (req.get('x-dbo-accept-redirect') !== '1') return null
    const s = settings()
    if (!s) return null
    const v = readJson('files-version.json')
    const version = v && typeof v.version === 'string' ? v.version : null
    if (!version || (expected !== undefined && version !== expected)) return null
    const listed = s[listKey]
    if (!Object.prototype.hasOwnProperty.call(listed, version)) return null
    if (!Number.isFinite(v.zipSize) || Number(listed[version]) !== v.zipSize) return null
    return `${s.baseUrl}/client/${encodeURIComponent(version)}`
  }

  // The R2 URL of the client zip for this request, or null to serve it from disk
  function clientZipUrl(req) {
    const base = clientBase(req, 'client')
    return base && `${base}/${CLIENT_OBJECT}`
  }

  // The R2 URL of one file of client package <version> (rel: its listed path), or null to serve it from disk. The caller
  // has checked that rel is listed and that version is the request's; a package swapped in meanwhile gives null.
  function clientFileUrl(req, rel, version) {
    const base = clientBase(req, 'clientFiles', version)
    return base && `${base}/files/${encodePath(rel)}`
  }

  return { settings, extraRedirect, clientZipUrl, clientFileUrl }
}

module.exports = { createR2Files, ...createR2Files() }
