'use strict'
/**
 * Writes the 1.6.1170 reference list for src/downgrade-1.6.1170.json from a real depot download, once, on a PC.
 *
 *   node tools/depot-reference.js "C:\Program Files (x86)\Steam\steamapps\content\app_489830"
 *
 * Run it after the three download_depot commands have finished. It prints, for each depot, every file's path (relative
 * to the depot folder, forward slashes) and size, plus SkyrimSE.exe's sha256, as JSON to paste into the reference
 * file's "depots[].files" and "files" entries. It reads the files and copies none of them: only names, sizes and one
 * hash leave the PC. The masters' hashes are checked against the reference already there, so a wrong download shows.
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const REF = require('../src/downgrade-1.6.1170.json')

const appDir = process.argv[2]
if (!appDir) {
  console.error('usage: node tools/depot-reference.js <Steam>\\steamapps\\content\\app_489830')
  process.exit(2)
}

const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

function walk(dir, sub = '') {
  const out = []
  for (const e of fs.readdirSync(path.join(dir, sub), { withFileTypes: true })) {
    const rel = sub ? `${sub}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...walk(dir, rel))
    else if (e.isFile()) out.push({ path: rel, size: fs.statSync(path.join(dir, rel)).size })
  }
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

const result = { depots: {}, files: {} }
const problems = []
for (const d of REF.depots) {
  const dir = path.join(appDir, `depot_${d.id}`)
  if (!fs.existsSync(dir)) { problems.push(`depot_${d.id} is missing`); continue }
  result.depots[d.id] = walk(dir)
  for (const f of result.depots[d.id]) {
    const want = REF.files[f.path]
    if (f.path.toLowerCase() === 'skyrimse.exe') result.files[f.path] = { size: f.size, sha256: sha256(path.join(dir, f.path)) }
    else if (want && (want.size !== f.size || sha256(path.join(dir, f.path)) !== want.sha256)) problems.push(`${f.path} does not match the reference`)
  }
}
console.log(JSON.stringify(result, null, 2))
if (problems.length) {
  console.error(`\nNot a clean 1.6.1170 download: ${problems.join('; ')}`)
  process.exit(1)
}
