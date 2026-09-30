'use strict'
// Terms of Service and Privacy Policy in the launcher: the texts, the player's acceptance status, and accepting
// The backend serves them at /api/legal and at /api/files/legal; the public proxy forwards /api/files, so that one is used

const fs = require('fs')
const path = require('path')
const { parseMarkdown } = require('./legalMarkdown')

const BASE = '/api/files/legal'
const FALLBACK_DIR = path.join(__dirname, '..', 'assets', 'legal')
const MAX_CHANGES = 20

// Checks the reply's shape and turns both texts into blocks the window renders as DOM (never HTML)
function shapeDocument(d) {
  if (!d || typeof d.version !== 'string' || !d.version || typeof d.terms !== 'string' || typeof d.privacy !== 'string') {
    throw new Error('the legal texts arrived incomplete')
  }
  const changes = Array.isArray(d.changes) ? d.changes.filter(c => typeof c === 'string' && c.trim()).slice(0, MAX_CHANGES) : []
  return {
    version: d.version,
    effective: typeof d.effective === 'string' ? d.effective : '',
    changes,
    terms: parseMarkdown(d.terms),
    privacy: parseMarkdown(d.privacy),
  }
}

// The copy shipped with this launcher, for reading when the server cannot be reached
function readBundled(dir = FALLBACK_DIR) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'legal.json'), 'utf8'))
  const files = manifest.files || {}
  const read = f => fs.readFileSync(path.join(dir, path.basename(String(f))), 'utf8')
  return shapeDocument({ ...manifest, terms: read(files.terms), privacy: read(files.privacy) })
}

function createLegal({ apiUrl, fetchJSON, postJSON, getSession, launcherVersion, log = () => {}, fallbackDir = FALLBACK_DIR }) {
  // accepted | required | notDeployed | error | signedOut | unknown
  let state = 'unknown'

  async function load() {
    try {
      return { source: 'server', ...shapeDocument(await fetchJSON(`${apiUrl}${BASE}`)) }
    } catch (err) {
      log(`[legal] could not load the texts from the server (${err.message}); showing the bundled copy`)
      try { return { source: 'bundled', error: err.message, ...readBundled(fallbackDir) } }
      catch (e) {
        log(`[legal] the bundled copy is unreadable too: ${e.message}`)
        return { source: 'none', error: err.message }
      }
    }
  }

  async function status() {
    const session = getSession()
    if (!session) { state = 'signedOut'; return { state } }
    try {
      const s = await fetchJSON(`${apiUrl}${BASE}/status`, { 'x-session': session })
      if (!s || typeof s.accepted !== 'boolean' || typeof s.version !== 'string') throw new Error('the status reply is malformed')
      state = s.accepted ? 'accepted' : 'required'
      return {
        state,
        version: s.version,
        lastAcceptedVersion: typeof s.lastAcceptedVersion === 'string' ? s.lastAcceptedVersion : null,
        required: s.required === true,
      }
    } catch (err) {
      if (err.statusCode === 401) { state = 'signedOut'; return { state, sessionExpired: true } }
      // A backend without these routes has nothing to accept yet, and cannot refuse anyone for it
      if (err.statusCode === 404) { state = 'notDeployed'; return { state } }
      // Anything else: Play stays on and the game server's own check decides, like the launch check
      state = 'error'
      log(`[legal] status check failed: ${err.message}`)
      return { state, error: err.message }
    }
  }

  async function accept(version) {
    const session = getSession()
    if (!session) return { ok: false, sessionExpired: true }
    try {
      const r = await postJSON(`${apiUrl}${BASE}/accept`, { version, launcherVersion }, { 'x-session': session })
      if (!r || r.accepted !== true || r.version !== version) throw new Error('the server did not confirm it')
      state = 'accepted'
      log(`[legal] accepted the Terms of Service and the Privacy Policy, version ${version}`)
      return { ok: true, at: r.at || null }
    } catch (err) {
      if (err.statusCode === 401) { state = 'signedOut'; return { ok: false, sessionExpired: true } }
      if (err.statusCode === 409) return { ok: false, versionChanged: true }
      log(`[legal] accepting failed: ${err.message}`)
      return { ok: false, error: err.message }
    }
  }

  return {
    load,
    status,
    accept,
    // Only a backend answer of "not accepted" holds a launch back
    blocksLaunch: () => state === 'required',
    reset: () => { state = 'unknown' },
  }
}

module.exports = { createLegal, shapeDocument, readBundled, BASE, FALLBACK_DIR }
