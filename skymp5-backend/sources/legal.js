'use strict'
// Terms of Service and Privacy Policy: the current version (data/legal), who accepted which version, and the play gate
// Acceptances are appended to data/legal-acceptances.jsonl (0600), one line per (discordId, version), never rewritten

const crypto = require('crypto')
const fs     = require('fs')
const path   = require('path')
const config = require('../config')

const LEGAL_DIR = process.env.LEGAL_DIR || path.join(__dirname, '..', 'data', 'legal')
const ACCEPTANCES_FILE = process.env.LEGAL_ACCEPTANCES_FILE || path.join(__dirname, '..', 'data', 'legal-acceptances.jsonl')
const HASHES_FILE = 'hashes.json'
const MAX_TEXT_BYTES = 256 * 1024

const NOT_ACCEPTED_MESSAGE = "Please accept the Terms of Service in the launcher. Update the launcher if you don't see them."
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._-]{0,31}$/
const LAUNCHER_VERSION_RE = /^\d{1,4}(?:\.\d{1,4}){1,3}(?:-[0-9A-Za-z.]{1,20})?$/

// Line endings and a BOM are not a change: a Windows checkout turns LF into CRLF
const normalizeText = s => String(s).replace(/^﻿/, '').replace(/\r\n?/g, '\n')
const sha256 = s => crypto.createHash('sha256').update(normalizeText(s), 'utf8').digest('hex')

function validateManifest(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error('legal.json is not an object')
  if (typeof m.version !== 'string' || !VERSION_RE.test(m.version)) throw new Error('legal.json: version must be a short id like 2026-10-01')
  if (typeof m.effective !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(m.effective)) throw new Error('legal.json: effective must be YYYY-MM-DD')
  if (!Array.isArray(m.changes) || m.changes.length < 1 || m.changes.length > 20 ||
      !m.changes.every(c => typeof c === 'string' && c.trim() && c.length <= 300)) {
    throw new Error('legal.json: changes must be 1 to 20 short lines')
  }
  const files = m.files && typeof m.files === 'object' ? m.files : {}
  for (const key of ['terms', 'privacy']) {
    const f = files[key]
    if (typeof f !== 'string' || path.basename(f) !== f || !/^[\w.-]+\.md$/.test(f)) throw new Error(`legal.json: files.${key} must be a .md file beside it`)
  }
  return { version: m.version, effective: m.effective, changes: m.changes.map(c => c.trim()), files: { terms: files.terms, privacy: files.privacy } }
}

function readManifest(dir = LEGAL_DIR) {
  return validateManifest(JSON.parse(fs.readFileSync(path.join(dir, 'legal.json'), 'utf8')))
}

function readText(file) {
  const buf = fs.readFileSync(file)
  if (buf.length > MAX_TEXT_BYTES) throw new Error(`${path.basename(file)} is larger than ${MAX_TEXT_BYTES} bytes`)
  const text = normalizeText(buf.toString('utf8'))
  if (!text.trim()) throw new Error(`${path.basename(file)} is empty`)
  return text
}

const stamp = file => { const s = fs.statSync(file); return `${s.size}:${s.mtimeMs}:${s.ino}` }
let docCache = null

// The current documents, re-read only when legal.json or a text changes on disk; throws when any is missing or malformed
function currentDocument(dir = LEGAL_DIR) {
  const manifestFile = path.join(dir, 'legal.json')
  const manifest = readManifest(dir)
  const files = [manifest.files.terms, manifest.files.privacy].map(f => path.join(dir, f))
  const key = [dir, manifestFile, ...files].map((f, i) => (i ? stamp(f) : f)).join('|')
  if (docCache && docCache.key === key) return docCache.doc
  const doc = Object.freeze({
    version: manifest.version,
    effective: manifest.effective,
    changes: Object.freeze(manifest.changes),
    terms: readText(files[0]),
    privacy: readText(files[1]),
  })
  docCache = { key, doc }
  return doc
}

// Hashes of the current texts, as scripts/legal-record.js stores them in hashes.json
function documentHashes(dir = LEGAL_DIR) {
  const manifest = readManifest(dir)
  const hashes = {}
  for (const f of [manifest.files.terms, manifest.files.privacy]) hashes[f] = sha256(fs.readFileSync(path.join(dir, f), 'utf8'))
  return { version: manifest.version, hashes }
}

function recordedHashes(dir = LEGAL_DIR) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, HASHES_FILE), 'utf8')) }
  catch (e) { if (e.code === 'ENOENT') return {}; throw e }
}

// Acceptances, indexed by discordId then version; the first line for a pair is the one kept
let index = null

function addToIndex(byUser, record) {
  let versions = byUser.get(record.discordId)
  if (!versions) byUser.set(record.discordId, versions = new Map())
  if (!versions.has(record.version)) versions.set(record.version, record)
}

function loadAcceptances() {
  let key
  try { key = stamp(ACCEPTANCES_FILE) }
  catch (e) {
    if (e.code !== 'ENOENT') throw e
    index = { key: 'none', byUser: new Map() }
    return index
  }
  if (index && index.key === key) return index
  const byUser = new Map()
  for (const line of fs.readFileSync(ACCEPTANCES_FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let r
    try { r = JSON.parse(line) } catch { continue }   // a line torn by a crash is skipped
    if (r && typeof r.discordId === 'string' && typeof r.version === 'string') addToIndex(byUser, r)
  }
  index = { key, byUser }
  return index
}

function acceptanceOf(discordId, version) {
  const versions = loadAcceptances().byUser.get(String(discordId))
  return (versions && versions.get(version)) || null
}

function lastAcceptance(discordId) {
  const versions = loadAcceptances().byUser.get(String(discordId))
  if (!versions || !versions.size) return null
  return [...versions.values()].reduce((a, b) => (String(b.at) > String(a.at) ? b : a))
}

// A torn last line (no newline) must not swallow the next record
function endsWithNewline(file) {
  const fd = fs.openSync(file, 'r')
  try {
    const { size } = fs.fstatSync(fd)
    if (!size) return true
    const b = Buffer.alloc(1)
    fs.readSync(fd, b, 0, 1, size - 1)
    return b[0] === 0x0a
  } finally { fs.closeSync(fd) }
}

// Records that discordId accepted version; a second call for the same pair returns the first record unchanged
function accept({ discordId, profileId, version, launcherVersion }, now = new Date()) {
  const id = String(discordId || '')
  if (!id) throw new Error('discordId is required')
  if (typeof version !== 'string' || !VERSION_RE.test(version)) throw new Error('bad version')
  const idx = loadAcceptances()
  const existing = acceptanceOf(id, version)
  if (existing) return { created: false, record: existing }
  const record = {
    discordId: id,
    profileId: Number.isSafeInteger(profileId) ? profileId : null,
    version,
    at: now.toISOString(),
    launcherVersion: typeof launcherVersion === 'string' && LAUNCHER_VERSION_RE.test(launcherVersion) ? launcherVersion : null,
  }
  fs.mkdirSync(path.dirname(ACCEPTANCES_FILE), { recursive: true })
  let prefix = ''
  try {
    fs.chmodSync(ACCEPTANCES_FILE, 0o600)
    if (!endsWithNewline(ACCEPTANCES_FILE)) prefix = '\n'
  } catch (e) { if (e.code !== 'ENOENT') throw e }
  fs.appendFileSync(ACCEPTANCES_FILE, `${prefix}${JSON.stringify(record)}\n`, { mode: 0o600 })
  addToIndex(idx.byUser, record)
  idx.key = stamp(ACCEPTANCES_FILE)
  return { created: true, record }
}

function status(discordId, doc = currentDocument()) {
  const current = acceptanceOf(discordId, doc.version)
  const last = lastAcceptance(discordId)
  return {
    accepted: !!current,
    version: doc.version,
    acceptedAt: current ? current.at : null,
    lastAcceptedVersion: last ? last.version : null,
    required: config.legalRequired === true,
  }
}

// The play gate (LEGAL_REQUIRED): refuses only a player known not to have accepted; it fails open when the files cannot be read
function gate(discordId) {
  if (config.legalRequired !== true) return { ok: true }
  let doc, accepted
  try {
    doc = currentDocument()
    accepted = !!acceptanceOf(discordId, doc.version)
  } catch (err) {
    console.error(`[legal] gate left open: ${err.message}`)
    return { ok: true }
  }
  return accepted ? { ok: true } : { ok: false, error: 'legalNotAccepted', message: NOT_ACCEPTED_MESSAGE, version: doc.version }
}

module.exports = {
  currentDocument, documentHashes, recordedHashes, validateManifest, accept, status, gate, acceptanceOf, lastAcceptance,
  sha256, normalizeText, NOT_ACCEPTED_MESSAGE, VERSION_RE, LEGAL_DIR, ACCEPTANCES_FILE, HASHES_FILE,
  resetCache: () => { docCache = null; index = null },
}
