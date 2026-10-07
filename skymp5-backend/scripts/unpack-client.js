#!/usr/bin/env node
'use strict'
// Unpacks the client zip for the per-file route (sources/clientFiles.js). Run at release time, after the zip and
// files-version.json are swapped in (docs/per-file-client.md); a request never unpacks anything.
//
//   1. the zip's entry names are checked (no '..', absolute path, backslash or duplicate; every listed file present)
//   2. unzip into <out>/.tmp-<version>; every entry must be a plain file or folder (no links)
//   3. EVERY listed file's size and sha256 is checked against files-version.json
//   4. the marker <out>/.tmp-<version>/.verified is written, then the folder is renamed to <out>/<version> in one step
//   5. only the current version and the one verified before it are kept (plus the live version when unpacking a staged one)
// Any mismatch exits 1 and removes the temp folder; whatever was in <out> before is left as it was.
//
//   node scripts/unpack-client.js [--zip <zip>] [--version-file <files-version.json>] [--out <dir named "unpacked">]
//                                 [--keep 2] [--min-free-mb 2048] [--force]
//   node scripts/unpack-client.js --check [--version-file ...] [--out ...]
//       exit 0 and print the marker summary (JSON) when <out>/<version> is verified for this file list, else exit 1
//   node scripts/unpack-client.js --files [--version-file ...] [--out ...]
//       as --check, then one line per listed file: <size> TAB client/<version>/files/<URL-encoded path> TAB <path>
//
// Defaults are the live ones: the zip in CLIENT_FILES_DIR (else ../build/client-files), data/files-version.json,
// <client files dir>/unpacked. Uses the unzip command (no npm dependency). Exit 0 done, 1 failed, 2 usage.

const crypto = require('crypto')
const fs     = require('fs')
const path   = require('path')
const { spawn } = require('child_process')
const { safeVersion, safeRelPath, listedFiles, listSha256, markerMatches, UNPACKED_DIR, MARKER } = require('../sources/clientFiles')

const BACKEND = path.join(__dirname, '..')
// The same default as config.clientFilesDir, without loading config (and its .env)
const CLIENT_FILES_DIR = process.env.CLIENT_FILES_DIR || path.join(BACKEND, '..', 'build', 'client-files')
const LIVE_VERSION_FILE = path.join(BACKEND, 'data', 'files-version.json')
const ZIP_NAME = 'skymp-client.zip'

class Failure extends Error {}
const fail = msg => { throw new Failure(msg) }

function parseArgs(argv) {
  const o = {
    zip: path.join(CLIENT_FILES_DIR, ZIP_NAME), versionFile: LIVE_VERSION_FILE, out: path.join(CLIENT_FILES_DIR, UNPACKED_DIR),
    liveVersionFile: LIVE_VERSION_FILE, keep: 2, minFreeMb: 2048, force: false, mode: 'unpack',
  }
  const value = (i, name) => { if (i + 1 >= argv.length) throw new Failure(`${name} needs a value`); return argv[i + 1] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--zip') o.zip = value(i++, a)
    else if (a === '--version-file') o.versionFile = value(i++, a)
    else if (a === '--live-version-file') o.liveVersionFile = value(i++, a)
    else if (a === '--out') o.out = value(i++, a)
    else if (a === '--keep') o.keep = Number(value(i++, a))
    else if (a === '--min-free-mb') o.minFreeMb = Number(value(i++, a))
    else if (a === '--force') o.force = true
    else if (a === '--check') o.mode = 'check'
    else if (a === '--files') o.mode = 'files'
    else throw new Failure(`unknown argument ${a}`)
  }
  if (!Number.isInteger(o.keep) || o.keep < 1) throw new Failure('--keep must be 1 or more')
  if (!Number.isFinite(o.minFreeMb) || o.minFreeMb < 0) throw new Failure('--min-free-mb must be 0 or more')
  for (const k of ['zip', 'versionFile', 'out', 'liveVersionFile']) o[k] = path.resolve(o[k])
  // Old versions are deleted from this folder, so it must be the per-file folder and nothing else
  if (path.basename(o.out) !== UNPACKED_DIR) throw new Failure(`--out must be a folder named ${UNPACKED_DIR} (got ${o.out})`)
  return o
}

// files-version.json: version, zip size and the listed files; anything unusable stops the run
function readPackage(file) {
  let v
  try { v = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (err) { fail(`cannot read ${file}: ${err.message}`) }
  if (!safeVersion(v.version)) fail(`${file}: version ${JSON.stringify(v.version)} is not usable as a folder name`)
  const all = Array.isArray(v.files) ? v.files : []
  const files = listedFiles(v)
  if (!files.length) fail(`${file} lists no files`)
  if (files.length !== all.length) fail(`${file}: ${all.length - files.length} file entr(y/ies) without a safe path, size or sha256`)
  if (new Set(files.map(f => f.path)).size !== files.length) fail(`${file} lists a path twice`)
  return { version: v.version, zipSize: Number.isSafeInteger(v.zipSize) ? v.zipSize : null, files, listSha256: listSha256(files) }
}

function readMarker(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8')) } catch { return null }
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256')
    fs.createReadStream(file).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject)
  })
}

// Runs a command; resolves stdout, rejects with stderr on a non-zero exit (unzip's 1 is "warnings": also a failure)
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const out = []
    const err = []
    p.stdout.on('data', d => out.push(d))
    p.stderr.on('data', d => err.push(d))
    p.on('error', e => reject(new Failure(`${cmd}: ${e.message}`)))
    p.on('close', code => {
      if (code === 0) return resolve(Buffer.concat(out).toString('utf8'))
      reject(new Failure(`${cmd} exited ${code}: ${Buffer.concat(err).toString('utf8').trim().slice(0, 500)}`))
    })
  })
}

// The zip's entries: names checked before anything is written; returns the file names and the unpacked total size
async function zipEntries(zip, pkg) {
  const names = (await run('unzip', ['-Z1', zip])).split('\n').filter(n => n !== '')
  const files = []
  const seen = new Set()
  for (const n of names) {
    if (n.startsWith('/') || n.includes('\\') || /^[A-Za-z]:/.test(n)) fail(`zip entry ${JSON.stringify(n)} is not a relative forward-slash path`)
    const rel = n.endsWith('/') ? n.slice(0, -1) : n
    if (!safeRelPath(rel)) fail(`zip entry ${JSON.stringify(n)} is not a safe path`)
    if (n.endsWith('/')) continue
    if (seen.has(rel)) fail(`zip entry ${rel} appears twice`)
    seen.add(rel)
    files.push(rel)
  }
  const missing = pkg.files.filter(f => !seen.has(f.path)).map(f => f.path)
  if (missing.length) fail(`the zip lacks ${missing.length} listed file(s): ${missing.slice(0, 10).join(', ')}`)
  const summary = (await run('unzip', ['-l', zip])).trim().split('\n').pop()
  const m = /^\s*(\d+)\s+\d+\s+files?\s*$/.exec(summary)
  if (!m) fail(`cannot read the zip's unpacked size from ${JSON.stringify(summary)}`)
  return { files, unpackedBytes: Number(m[1]) }
}

// Every entry under dir: plain files and folders only (a link could point anywhere); folders 755, files 644
function plainTree(dir, rel = '', out = []) {
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name
    const full = path.join(dir, r)
    const st = fs.lstatSync(full)
    if (st.isDirectory()) { fs.chmodSync(full, 0o755); plainTree(dir, r, out) }
    else if (st.isFile()) { fs.chmodSync(full, 0o644); out.push(r) }
    else fail(`${r} in the zip is not a plain file or folder`)
  }
  return out
}

async function verifyFiles(dir, files) {
  const bad = []
  for (const f of files) {
    const full = path.join(dir, ...f.path.split('/'))
    let st
    try { st = fs.lstatSync(full) } catch { bad.push(`${f.path} (missing)`); continue }
    if (!st.isFile()) { bad.push(`${f.path} (not a file)`); continue }
    if (st.size !== f.size) { bad.push(`${f.path} (size ${st.size}, listed ${f.size})`); continue }
    const sha = await sha256File(full)
    if (sha !== String(f.sha256).toLowerCase()) bad.push(`${f.path} (sha256 ${sha.slice(0, 12)}, listed ${String(f.sha256).slice(0, 12)})`)
  }
  return bad
}

function writeFileAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, text, { mode: 0o644, flag: 'w' })
  fs.renameSync(tmp, file)
}

// One run at a time per folder; a lock left by a dead process is taken over
function takeLock(out) {
  const lock = path.join(out, '.lock')
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx' })
      return () => { try { if (fs.readFileSync(lock, 'utf8') === String(process.pid)) fs.unlinkSync(lock) } catch {} }
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      const pid = Number(fs.readFileSync(lock, 'utf8'))
      let alive = false
      try { process.kill(pid, 0); alive = true } catch (e) { alive = e.code === 'EPERM' }
      if (alive && pid > 0) fail(`another unpack (pid ${pid}) holds ${lock}`)
      fs.rmSync(lock, { force: true })
    }
  }
  fail(`cannot take ${lock}`)
}

// Keeps the current version, the live one (when this run unpacked a staged package) and the newest other verified ones
// up to keep in all; deletes other version folders and leftovers of interrupted runs
function prune(out, keepVersions, keep, log) {
  const others = []
  for (const e of fs.readdirSync(out, { withFileTypes: true })) {
    if (e.name === '.lock') continue
    const full = path.join(out, e.name)
    if (e.name.startsWith('.tmp-') || e.name.startsWith('.old-')) { fs.rmSync(full, { recursive: true, force: true }); log(`removed leftover ${e.name}`); continue }
    if (!e.isDirectory() || keepVersions.includes(e.name)) continue
    const m = readMarker(full)
    const at = m && m.version === e.name ? Date.parse(m.verifiedAt) : NaN
    others.push({ name: e.name, full, at: Number.isFinite(at) ? at : -1 })
  }
  others.sort((a, b) => b.at - a.at)
  const room = Math.max(0, keep - keepVersions.length)
  for (const o of others.slice(room).concat(others.slice(0, room).filter(o => o.at < 0))) {
    fs.rmSync(o.full, { recursive: true, force: true })
    log(`removed old version ${o.name}`)
  }
}

function summary(dir, marker) {
  const { version, zipSize, zipSha256, fileCount, totalBytes, listSha256: list, verifiedAt } = marker
  return { version, dir, zipSize, zipSha256, fileCount, totalBytes, listSha256: list, verifiedAt }
}

async function unpack(o, log = m => console.log(`[unpack] ${m}`)) {
  const pkg = readPackage(o.versionFile)
  const final = path.join(o.out, pkg.version)
  const tmp = path.join(o.out, `.tmp-${pkg.version}`)
  fs.mkdirSync(o.out, { recursive: true, mode: 0o755 })
  const unlock = takeLock(o.out)
  try {
    let st
    try { st = fs.statSync(o.zip) } catch (err) { fail(`cannot read ${o.zip}: ${err.message}`) }
    if (pkg.zipSize !== null && st.size !== pkg.zipSize) fail(`the zip is ${st.size} bytes but files-version.json says ${pkg.zipSize}: not the same release`)
    const zipSha256 = await sha256File(o.zip)
    const keepVersions = [pkg.version]
    try {
      const live = JSON.parse(fs.readFileSync(o.liveVersionFile, 'utf8')).version
      if (safeVersion(live) && live !== pkg.version) keepVersions.push(live)
    } catch { /* no live list: nothing more to keep */ }

    const existing = readMarker(final)
    if (!o.force && markerMatches(existing, pkg) && existing.zipSha256 === zipSha256) {
      log(`${pkg.version} is already unpacked and verified (${existing.fileCount} files)`)
      prune(o.out, keepVersions, o.keep, log)
      return summary(final, existing)
    }

    const { files: entries, unpackedBytes } = await zipEntries(o.zip, pkg)
    const free = (() => { const s = fs.statfsSync(o.out); return s.bavail * s.bsize })()
    const need = unpackedBytes + o.minFreeMb * 1048576
    if (free < need) fail(`${(free / 1048576).toFixed(0)} MB free; unpacking needs ${(unpackedBytes / 1048576).toFixed(0)} MB plus ${o.minFreeMb} MB to spare`)

    fs.rmSync(tmp, { recursive: true, force: true })
    fs.mkdirSync(tmp, { mode: 0o755 })
    try {
      log(`unzipping ${pkg.version} (${entries.length} files, ${(unpackedBytes / 1048576).toFixed(1)} MB) into ${tmp}`)
      await run('unzip', ['-qq', '-n', o.zip, '-d', tmp])
      const onDisk = plainTree(tmp)
      const bad = await verifyFiles(tmp, pkg.files)
      if (bad.length) fail(`${bad.length} listed file(s) do not match files-version.json: ${bad.slice(0, 10).join('; ')}`)
      const listed = new Set(pkg.files.map(f => f.path))
      const unlisted = onDisk.filter(p => !listed.has(p))
      if (unlisted.length) log(`note: ${unlisted.length} file(s) in the zip are not listed and are never served: ${unlisted.slice(0, 10).join(', ')}`)
      const marker = {
        version: pkg.version, zipSha256, zipSize: st.size, fileCount: pkg.files.length,
        totalBytes: pkg.files.reduce((n, f) => n + f.size, 0), listSha256: pkg.listSha256, unlisted: unlisted.length,
        verifiedAt: new Date().toISOString(),
      }
      writeFileAtomic(path.join(tmp, MARKER), JSON.stringify(marker, null, 1) + '\n')
      fs.chmodSync(tmp, 0o755)
      if (fs.existsSync(final)) {
        // The same version number with other content: the old folder goes aside for the one rename, then away
        const old = path.join(o.out, `.old-${pkg.version}-${process.pid}`)
        fs.renameSync(final, old)
        try { fs.renameSync(tmp, final) } catch (err) { fs.renameSync(old, final); throw err }
        fs.rmSync(old, { recursive: true, force: true })
      } else {
        fs.renameSync(tmp, final)
      }
      log(`${pkg.version} verified: ${marker.fileCount} files, ${(marker.totalBytes / 1048576).toFixed(1)} MB -> ${final}`)
      prune(o.out, keepVersions, o.keep, log)
      return summary(final, marker)
    } catch (err) {
      fs.rmSync(tmp, { recursive: true, force: true })
      throw err
    }
  } finally {
    unlock()
  }
}

// --check / --files: the version in files-version.json is unpacked and its marker matches the list
function check(o) {
  const pkg = readPackage(o.versionFile)
  const dir = path.join(o.out, pkg.version)
  const m = readMarker(dir)
  if (!markerMatches(m, pkg)) fail(`${dir} is not a verified copy of ${pkg.version} (run unpack-client.js)`)
  return { pkg, info: summary(dir, m) }
}

async function main(argv = process.argv.slice(2)) {
  let o
  try { o = parseArgs(argv) } catch (err) { console.error(`[unpack] ${err.message}`); return 2 }
  try {
    if (o.mode === 'unpack') {
      console.log(JSON.stringify(await unpack(o)))
    } else {
      const { pkg, info } = check(o)
      if (o.mode === 'check') console.log(JSON.stringify(info))
      else {
        const v = encodeURIComponent(pkg.version)
        const lines = pkg.files.map(f => `${f.size}\tclient/${v}/files/${f.path.split('/').map(encodeURIComponent).join('/')}\t${f.path}`)
        process.stdout.write(lines.join('\n') + '\n')
      }
    }
    return 0
  } catch (err) {
    console.error(`[unpack] FAILED: ${err instanceof Failure ? err.message : err.stack || err}`)
    return 1
  }
}

if (require.main === module) main().then(code => { process.exitCode = code })

module.exports = { main, unpack, check, parseArgs, readPackage }
