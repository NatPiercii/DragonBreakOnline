'use strict'
// The client package one file at a time, for launcher 2.1.44's per-file update (Jake, 7 Oct 2026: a one-file release
// made about 40 launchers pull the whole 184 MB zip at once over the home upload and locked players out).
//
//   GET /api/files/client/<path, each segment URL-encoded>?v=<files-version.json version>
//     404  v is not the current version, the path is not EXACTLY one of files-version.json's files (case-sensitive), or
//          no verified copy exists. The launcher treats any non-2xx as "use the zip", so a 404 is always safe.
//     302  to R2 (Cache-Control: no-store) when the request has X-DBO-Accept-Redirect: 1 and data/r2.json "clientFiles"
//          lists this version with files-version.json's zip size (sources/r2Files.js, scripts/publish-client-r2.sh)
//     200  from <clientFilesDir>/unpacked/<version>/<path> (Range gives 206) when that folder's .verified marker is for
//          exactly this file list (scripts/unpack-client.js writes it at release time; nothing is ever unpacked here)
//
//   GET /api/files/version, with the optional data/client-files.json switch "omitExtras": true, leaves out the files
//   data/extra-files.json also lists (Data/*.esp that the extra-files sync owns); default off. docs/per-file-client.md.
//
//   Every answer of the route, the limiter's 429 included, carries Cache-Control: no-store. Cloudflare in front of the API
//   caches by file extension (.js, .png, .svg, .bin, ...) when the origin says nothing: a 404 from the minutes between the
//   zip swap and unpack-client.js, or a 200 of a version number later reused for a rebuild, would otherwise be served from
//   the edge after the disk copy, the marker or a kill switch changed.
//
//   data/client-files.json (optional; read again whenever it changes, no restart)
//     { "perFile": false }    every /api/files/client/* answers 404, so every launcher downloads the zip as before
//     { "omitExtras": true }  /api/files/version leaves out what extra-files.json lists (outside Data/Platform, Data/SKSE)

const crypto = require('crypto')
const fs     = require('fs')
const path   = require('path')
const { rateLimit, ipKeyGenerator } = require('express-rate-limit')
const { visitorIp } = require('./visitorIp')

const DATA_DIR = path.join(__dirname, '..', 'data')
const UNPACKED_DIR = 'unpacked'
const MARKER = '.verified'
const ROUTE_PREFIX = '/client/'
// The route as a RegExp without groups: Express then decodes no parameter, so a malformed escape is this module's 404
// rather than Express's 400, and the raw path is decoded here one segment at a time
const FILE_ROUTE = /^\/client\/.*/

const NOT_BUILT  = { error: 'File package not found. Run `npm run merge` on the server first.' }
const NOT_SERVED = { error: 'Not served one by one. Use /api/files/zip.' }

// Every request reaches the backend through the same proxy hop, so limits are keyed by Cloudflare's visitor address
const visitorKey = req => ipKeyGenerator(visitorIp(req) || req.ip)

// A version usable as one folder name (and one URL segment)
const safeVersion = v => typeof v === 'string' && /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/.test(v)

// A package path as files-version.json lists it: forward slashes, no empty, '.' or '..' segment, no backslash, NUL or
// other control character
function safeRelPath(p) {
  if (typeof p !== 'string' || p.length === 0 || p.length > 1024) return false
  if (/[\\\u0000-\u001f\u007f]/.test(p)) return false
  return p.split('/').every(s => s !== '' && s !== '.' && s !== '..')
}

// The listed files a per-file copy can hold: entries with a safe path, a size and a sha256
function listedFiles(v) {
  return (v && Array.isArray(v.files) ? v.files : [])
    .filter(f => f && safeRelPath(f.path) && Number.isSafeInteger(f.size) && f.size >= 0 && /^[0-9a-f]{64}$/i.test(String(f.sha256)))
}

// Fingerprint of a file list: the same paths, sizes and sha256s mean the same unpacked files whatever the zip's bytes, so
// a version number reused for a rebuilt package (the 0.3.81 rollback put 0.3.80 back) never matches an old copy
function listSha256(files) {
  const rows = files.map(f => `${f.path}\0${f.size}\0${String(f.sha256).toLowerCase()}`).sort()
  return crypto.createHash('sha256').update(rows.join('\n')).digest('hex')
}

// The package path a request names, or null: each raw segment decoded once, and none may decode to '', '.', '..' or
// hold a slash (%2F), backslash, NUL or other control character
function requestedPath(reqPath) {
  if (typeof reqPath !== 'string' || !reqPath.startsWith(ROUTE_PREFIX)) return null
  const segs = []
  for (const raw of reqPath.slice(ROUTE_PREFIX.length).split('/')) {
    let s
    try { s = decodeURIComponent(raw) } catch { return null }
    if (s === '' || s === '.' || s === '..' || /[/\\\u0000-\u001f\u007f]/.test(s)) return null
    segs.push(s)
  }
  return segs.length ? segs.join('/') : null
}

// The marker unpack-client.js writes matches this package
const markerMatches = (m, pkg) => !!m && m.version === pkg.version && m.listSha256 === pkg.listSha256 && m.fileCount === pkg.files.length

function createClientFiles({ dataDir = DATA_DIR, clientFilesDir, r2 = null, windowMs = 15 * 60 * 1000, limit = 1500 } = {}) {
  if (!clientFilesDir) throw new Error('clientFilesDir is required')
  const versionFile = path.join(dataDir, 'files-version.json')
  const unpackedRoot = path.join(clientFilesDir, UNPACKED_DIR)

  // JSON re-read only when its size or mtime changes; derive(value) is kept with it. null when missing or unreadable.
  const cache = new Map()
  function cached(file, derive = v => v) {
    let st
    try { st = fs.statSync(file) } catch { cache.delete(file); return null }
    const hit = cache.get(file)
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.derived
    let value = null
    try { value = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { /* half-written or bad: treated as missing */ }
    const derived = value === null ? null : derive(value)
    cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, derived })
    return derived
  }

  function switches() {
    const s = cached(path.join(dataDir, 'client-files.json'))
    const o = s && typeof s === 'object' && !Array.isArray(s) ? s : {}
    return { perFile: o.perFile !== false, omitExtras: o.omitExtras === true }
  }

  // The current package: version, zip size, the servable files, their paths and the list fingerprint
  function currentPackage() {
    return cached(versionFile, v => {
      if (!v || !safeVersion(v.version)) return null
      const files = listedFiles(v)
      return { version: v.version, zipSize: v.zipSize, files, paths: new Set(files.map(f => f.path)), listSha256: listSha256(files) }
    })
  }

  // The unpacked folder of this package when its marker matches, else null
  function verifiedDir(pkg) {
    const dir = path.join(unpackedRoot, pkg.version)
    return markerMatches(cached(path.join(dir, MARKER)), pkg) ? dir : null
  }

  // Lower-case paths extra-files.json lists, or an empty set
  function extraPaths() {
    return cached(path.join(dataDir, 'extra-files.json'), m => new Set(
      (Array.isArray(m && m.files) ? m.files : []).map(f => f && f.path).filter(p => typeof p === 'string').map(p => p.toLowerCase()),
    )) || new Set()
  }

  // Launchers 2.1.43 and 2.1.44 move files the list does not name out of Data/Platform/{Plugins,UI,Distribution,Modules}
  // and the platform DLLs out of Data/SKSE/Plugins (selfRepair.strayFiles), so nothing under those is ever left out
  const omittable = l => l.startsWith('data/') && !l.startsWith('data/platform/') && !l.startsWith('data/skse/')

  // files-version.json as published: unchanged unless "omitExtras" is on
  function publishedVersion(v) {
    if (!switches().omitExtras || !v || !Array.isArray(v.files)) return v
    const owned = extraPaths()
    if (!owned.size) return v
    const files = v.files.filter(f => !(f && typeof f.path === 'string' && omittable(f.path.toLowerCase()) && owned.has(f.path.toLowerCase())))
    return { ...v, files, omittedExtras: v.files.length - files.length }
  }

  // GET /api/files/version: read fresh every time, as before (do NOT use require(); it caches the module)
  function versionHandler(_req, res) {
    if (!fs.existsSync(versionFile)) return res.status(404).json(NOT_BUILT)
    let v
    try { v = JSON.parse(fs.readFileSync(versionFile, 'utf8')) } catch { return res.status(500).json({ error: 'Could not read version file.' }) }
    res.json(publishedVersion(v))
  }

  // One client update is up to ~300 small files (plus resumes and queue retries) per launcher; the zip has its own limiter
  const fileLimiter = rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: visitorKey,
    message: { error: 'Too many file requests. Please try again later.' },
    handler: (_req, res, _next, options) => { res.set('Cache-Control', 'no-store'); res.status(options.statusCode).json(options.message) },
  })

  // GET /api/files/client/*: never unpacks anything; R2, a verified copy on disk, or 404 (the launcher then uses the zip)
  function fileHandler(req, res) {
    // Never kept by Cloudflare or any other cache: every answer here depends on files that change at release time
    res.set('Cache-Control', 'no-store')
    if (!switches().perFile) return res.status(404).json(NOT_SERVED)
    const pkg = currentPackage()
    if (!pkg) return res.status(404).json(NOT_BUILT)
    if (typeof req.query.v !== 'string' || req.query.v !== pkg.version) return res.status(404).json(NOT_SERVED)
    const rel = requestedPath(req.path)
    if (!rel || !pkg.paths.has(rel)) return res.status(404).json(NOT_SERVED)

    const r2Url = r2 ? r2.clientFileUrl(req, rel, pkg.version) : null
    if (r2Url) return res.redirect(302, r2Url)

    const dir = verifiedDir(pkg)
    if (!dir) return res.status(404).json(NOT_SERVED)
    const full = path.join(dir, ...rel.split('/'))
    if (!full.startsWith(dir + path.sep)) return res.status(404).json(NOT_SERVED)
    res.sendFile(full, {
      headers: { 'Content-Type': 'application/octet-stream' },
      cacheControl: false, // keeps the no-store set above (send only writes its own when this is on)
      dotfiles: 'allow',
    }, err => { if (err && !res.headersSent) res.status(err.status || 500).end(); else if (err) res.destroy() })
  }

  return { versionHandler, fileHandler, fileLimiter, currentPackage, verifiedDir, publishedVersion, switches }
}

module.exports = {
  createClientFiles, visitorKey, safeVersion, safeRelPath, listedFiles, listSha256, requestedPath, markerMatches,
  FILE_ROUTE, UNPACKED_DIR, MARKER,
}
