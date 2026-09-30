'use strict'
// Private files written whole: folders 0700, files 0600, never read by anyone else half written

const crypto = require('crypto')
const fs     = require('fs')
const path   = require('path')

// A unique temp name, so two writers never share one, and a crash mid-write never leaves a truncated file; mtimeMs dates the file
function writeAtomic(file, text, mtimeMs) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`
  try {
    fs.writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' })
    fs.renameSync(tmp, file)
  } catch (err) {
    fs.rmSync(tmp, { force: true })
    throw err
  }
  if (mtimeMs !== undefined) fs.utimesSync(file, new Date(), new Date(mtimeMs))
}

// Parsed JSON, or null when the file is missing; a corrupt file is moved aside so no write replaces it; other read errors throw
function readJson(file, isValid) {
  let text
  try { text = fs.readFileSync(file, 'utf8') }
  catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
  let value
  try { value = JSON.parse(text) } catch { value = undefined }
  if (value !== undefined && isValid(value)) return value
  const aside = `${file}.bad-${Date.now()}`
  console.error(`${file} is corrupt, moved to ${path.basename(aside)}`)
  try { fs.renameSync(file, aside) } catch (err) { console.error(`${file} not moved:`, err.message) }
  return null
}

module.exports = { writeAtomic, readJson }
