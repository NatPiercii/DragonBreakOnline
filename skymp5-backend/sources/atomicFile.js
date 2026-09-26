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

module.exports = { writeAtomic }
