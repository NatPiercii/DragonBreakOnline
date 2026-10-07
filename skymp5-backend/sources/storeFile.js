'use strict'
// The player stores (profiles.json, players.json, master-api's sessions.json) are read fail closed and written whole.
// A missing file is a first run. A file that exists but cannot be read or parsed, or is not the shape its store writes,
// throws with a loud log line: it is never taken for an empty store (7 Oct 2026), because an empty profiles.json gives
// the next new player profile id 1, the owner's. A save writes a temp file in the same folder, fsyncs it, renames it
// over the file and fsyncs the folder, so a crash or a full disk leaves the old file or the new one, never half of one.

const crypto = require('crypto')
const fs     = require('fs')
const path   = require('path')

// The error a store read throws, logged once as it is made
function storeError(file, why) {
  const err = new Error(`${file} ${why}; it is not read as an empty store. Repair it or restore it from a backup`)
  err.code = 'ESTOREUNREADABLE'
  console.error(`[store] FAIL CLOSED: ${err.message}`)
  return err
}

// The parsed file, or null when it does not exist; problemOf(value) returns null for a good value, else what is wrong with it
function readStore(file, problemOf) {
  let text
  try { text = fs.readFileSync(file, 'utf8') }
  catch (err) {
    if (err.code === 'ENOENT') return null
    throw storeError(file, `cannot be read (${err.code || err.message})`)
  }
  let value
  try { value = JSON.parse(text) }
  catch { throw storeError(file, `is not valid JSON (${Buffer.byteLength(text)} bytes)`) }
  const problem = problemOf(value)
  if (problem) throw storeError(file, problem)
  return value
}

// true when the file exists; any error but a missing file throws, so an unknown state is never read as "not there"
function storeExists(file) {
  try { fs.statSync(file); return true }
  catch (err) {
    if (err.code === 'ENOENT') return false
    throw storeError(file, `cannot be checked (${err.code || err.message})`)
  }
}

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

// Atomic replace. mode forces the new file's permission bits; without it an existing file keeps its own (and its owner,
// when the backend runs as root), and a new one gets 0666 less the umask, as fs.writeFileSync made them before
function replaceFile(file, text, { mode } = {}) {
  const dir = path.dirname(file)
  let old = null
  try { old = fs.statSync(file) } catch (err) { if (err.code !== 'ENOENT') throw err }
  const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`
  let fd = null
  try {
    fd = fs.openSync(tmp, 'wx', mode !== undefined ? mode : 0o666)
    if (mode !== undefined) fs.fchmodSync(fd, mode)
    else if (old) fs.fchmodSync(fd, old.mode & 0o777)
    if (old && process.geteuid && process.geteuid() === 0 && (old.uid !== 0 || old.gid !== 0)) fs.fchownSync(fd, old.uid, old.gid)
    fs.writeFileSync(fd, text)
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = null
    fs.renameSync(tmp, file)
  } catch (err) {
    if (fd !== null) try { fs.closeSync(fd) } catch { /* already failing */ }
    try { fs.rmSync(tmp, { force: true }) } catch { /* the first error is the one to report */ }
    throw err
  }
  syncDir(dir)
}

// Makes the rename itself durable. Windows (the server manager loads these modules there) cannot open a folder to fsync it
function syncDir(dir) {
  if (process.platform === 'win32') return
  const fd = fs.openSync(dir, 'r')
  try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}

module.exports = { readStore, storeExists, storeError, replaceFile, isPlainObject }
