'use strict'

// Writes data/extra-files.json (path, size, sha256) for the non-Nexus files in config.extraFilesDir; the launcher syncs from it
// Copy the files in first: the manifest is written last and atomically

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const config = require('../config')

const OUT = path.join(__dirname, '..', 'data', 'extra-files.json')

function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256')
    fs.createReadStream(p).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject)
  })
}

async function listFiles(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) { await listFiles(full, base, out); continue }
    const rel = path.relative(base, full).split(path.sep).join('/')
    // The launcher only writes under Data/
    if (!rel.startsWith('Data/')) throw new Error(`not under Data/: ${rel}`)
    out.push({ path: rel, size: fs.statSync(full).size, sha256: await sha256File(full) })
  }
  return out
}

async function main() {
  const dir = config.extraFilesDir
  if (!fs.existsSync(dir)) throw new Error(`extra files folder not found: ${dir}`)
  const files = (await listFiles(dir)).sort((a, b) => a.path.localeCompare(b.path))
  // Content hash, so it changes exactly when a file does
  const version = crypto.createHash('sha256').update(files.map(f => `${f.path}\0${f.sha256}`).join('\n')).digest('hex').slice(0, 16)
  const manifest = { version, builtAt: new Date().toISOString(), totalSize: files.reduce((s, f) => s + f.size, 0), files }
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT + '.tmp', JSON.stringify(manifest, null, 2) + '\n')
  fs.renameSync(OUT + '.tmp', OUT)
  console.log(`[extra] ${files.length} files, ${(manifest.totalSize / 1048576).toFixed(1)} MB, version ${version} -> ${OUT}`)
}

main().catch(err => { console.error(`[extra] ${err.message}`); process.exit(1) })
