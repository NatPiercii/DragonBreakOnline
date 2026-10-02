'use strict'
/**
 * DragonBreak's own clean copy of Skyrim SE 1.6.1170 (GOG: 1.6.1179) in <base>\skyrim, built only from files whose
 * size and sha256 match a vanilla list (vanilla-1.6.1170.json, written on a PC by tools/depot-reference.js).
 * Design: /opt/dragonbreak-handover/isolated-launcher/RESEARCH-20261002.md, section 4.
 *
 *   classify  a Steam or GOG folder against the list: each listed file matches, is changed or is missing; anything
 *             else in that folder is an extra and is never copied
 *   plan      matching files come from that folder, the rest from Steam's download_depot output when its copy has the
 *             right hash; what neither has is the list the player must still download
 *   run       copies (or, for a depot file on the same drive, moves) each file into the copy, hashing as it goes,
 *             under a temporary name that becomes the real one only once size and sha256 are right
 *   record    <copy>\dragonbreak-game.json: the build, the source, and each file's size, mtime, file id and sha256
 *   drift     before PLAY: size, mtime and file id against the record; only a file that differs is hashed again.
 *             Unknown root DLLs (dinput8, d3d11, dxgi...) are listed too
 *   repair    copies back only files whose hash matches, from the record's source first, then a depot folder
 *
 * The source folders are only read; a depot file may be moved into the copy, never changed. Nothing is written
 * outside the copy: every listed or recorded path is checked, and a folder inside the copy that is a link (a junction
 * into the Steam folder, say) is refused rather than written through. Files are always replaced by a rename, so a
 * hard link someone made to another install is cut, never written through.
 *
 * fs, crypto and path only, so the tests run it on temporary folders; main.js supplies the dialogs and the progress UI.
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const fsp = fs.promises

const RECORD_FILE = 'dragonbreak-game.json'
const RECORD_FORMAT = 1
const TEMP_SUFFIX = '.dbpart'
const SET_ASIDE_DIR = '_DragonBreakSetAside'
const CHUNK = 4 * 1024 * 1024
const SHA256 = /^[0-9a-f]{64}$/
// Names Windows maps to devices, with or without an extension
const WIN_DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/i
const BUNDLED = { steam: './vanilla-1.6.1170.json', gog: './vanilla-1.6.1179-gog.json' }

const keyOf = rel => rel.toLowerCase()
// The default link policy for the copy: no link is followed or written through
const noLinks = () => false
const isInside = (root, p) => { const r = path.relative(root, p); return !!r && r !== '..' && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r) }
const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
const isAbort = (err, signal) => !!(signal && signal.aborted) || (err && err.name === 'AbortError')
const checkAbort = signal => { if (signal) signal.throwIfAborted() }

/**
 * A listed path as forward-slash segments relative to the game folder, or an error for anything that could leave it
 * or alias another name on Windows: '..', '.', empty segments, a leading slash, a drive or stream colon, characters
 * Windows refuses, trailing dots or spaces (Windows drops them) and device names.
 */
function normRel(p) {
  const bad = () => new Error(`Unsafe path in the game file list: ${JSON.stringify(p)}`)
  if (typeof p !== 'string' || !p) throw bad()
  const parts = p.replace(/\\/g, '/').split('/')
  for (const s of parts) {
    if (!s || s === '.' || s === '..' || /[<>:"|?*\x00-\x1f]/.test(s) || /[. ]$/.test(s) || WIN_DEVICE.test(s)) throw bad()
  }
  return parts.join('/')
}

// root joined with a checked relative path; throws if the result is not strictly inside root
function safeJoin(root, rel) {
  const base = path.resolve(root)
  const full = path.resolve(base, ...normRel(rel).split('/'))
  const back = path.relative(base, full)
  if (!back || back === '..' || back.startsWith(`..${path.sep}`) || path.isAbsolute(back)) throw new Error(`Unsafe path: ${rel}`)
  return full
}

function checkEntry(f, what) {
  const rel = normRel(f && f.path)
  const key = keyOf(rel)
  if (key === RECORD_FILE || key.endsWith(TEMP_SUFFIX) || key.split('/')[0] === SET_ASIDE_DIR.toLowerCase()) {
    throw new Error(`Reserved path in the ${what}: ${rel}`)
  }
  if (!Number.isSafeInteger(f.size) || f.size < 0) throw new Error(`Bad size for ${rel} in the ${what}`)
  const sha256 = String(f.sha256 || '').toLowerCase()
  if (!SHA256.test(sha256)) throw new Error(`Bad sha256 for ${rel} in the ${what}`)
  return { rel, key, sha256 }
}

/**
 * The vanilla list ({ build, platform, generatedAt, files: [{ path, size, sha256, depot }] }, as an object or JSON
 * text) as a Map keyed by lower-case path, so lookups ignore case the way Windows does. omit drops paths the launcher
 * manages itself (Skyrim.ccc, which it empties). Throws on an unsafe path, a path listed twice or a bad size or hash.
 */
function loadManifest(json, { omit = [] } = {}) {
  const m = typeof json === 'string' ? JSON.parse(json) : json
  if (!m || !Array.isArray(m.files)) throw new Error('Not a game file list (it has no files array).')
  const skip = new Set(omit.map(p => keyOf(normRel(p))))
  const files = new Map()
  for (const f of m.files) {
    const { rel, key, sha256 } = checkEntry(f, 'game file list')
    if (files.has(key)) throw new Error(`Listed twice in the game file list: ${rel}`)
    files.set(key, { path: rel, key, size: f.size, sha256, depot: f.depot == null ? null : String(f.depot) })
  }
  for (const k of skip) files.delete(k)
  const bytes = [...files.values()].reduce((n, f) => n + f.size, 0)
  return {
    build: m.build || null, platform: m.platform || null, language: m.language || null, generatedAt: m.generatedAt || null,
    files, bytes, ready: files.size > 0,
  }
}

/**
 * A base list with a language's list laid over it: Steam installs a language depot (French 489834, German 489836...)
 * on top of the three base depots, and its file replaces the base one at the same path. Paths compare without case.
 */
function mergeLists(base, overlay) {
  const byKey = new Map()
  for (const f of base.files || []) byKey.set(String(f.path).replace(/\\/g, '/').toLowerCase(), f)
  for (const f of overlay.files || []) byKey.set(String(f.path).replace(/\\/g, '/').toLowerCase(), f)
  return { ...base, language: overlay.language || null, files: [...byKey.values()] }
}

/**
 * The list shipped in src for 'steam' or 'gog', or null when that file is not there; ready is false for a placeholder.
 * opts.language (Steam): English is the base depots alone; another language needs its own list
 * (vanilla-1.6.1170-<language>.json, from tools/depot-reference.js --language), and without it the list is not ready,
 * so that player stays on the legacy copy rather than getting English files.
 */
function bundledManifest(platform = 'steam', opts = {}) {
  const file = BUNDLED[platform]
  if (!file) return null
  let json
  try { json = require(file) } catch { return null }
  const language = String(opts.language || 'english').toLowerCase()
  if (platform === 'steam' && language !== 'english') {
    let overlay = null
    if (/^[a-z]+$/.test(language)) { try { overlay = require(`./vanilla-1.6.1170-${language}.json`) } catch { /* not generated yet */ } }
    if (!overlay || !Array.isArray(overlay.files) || !overlay.files.length) {
      return { ...loadManifest({ ...json, files: [] }, opts), language, ready: false, missingLanguage: language }
    }
    json = mergeLists(json, { ...overlay, language })
  }
  return loadManifest(json, opts)
}

// size, mtime, file id and link count; null when there is nothing to read. lstat: a link is reported, not followed
async function fileInfo(p, { lstat = false } = {}) {
  let st
  try { st = await (lstat ? fsp.lstat(p, { bigint: true }) : fsp.stat(p, { bigint: true })) } catch { return null }
  return {
    isFile: st.isFile(),
    isDir: st.isDirectory(),
    isLink: st.isSymbolicLink(),
    size: Number(st.size),
    mtimeMs: Number(st.mtimeMs),
    // NTFS file ids pass 2^53, so they are kept as text; 0 means the file system gave none
    ino: st.ino ? String(st.ino) : null,
    nlink: Number(st.nlink),
  }
}

async function rmFile(p) {
  try { await fsp.rm(p, { force: true }) } catch { /* the next run removes it before writing */ }
}

/** sha256 of a file, read in chunks so a 1.5 GB archive never sits in memory */
async function hashFile(file, { signal, onBytes, chunkSize = CHUNK } = {}) {
  const fh = await fsp.open(file, 'r')
  try {
    const h = crypto.createHash('sha256')
    const buf = Buffer.allocUnsafe(chunkSize)
    for (;;) {
      checkAbort(signal)
      const { bytesRead } = await fh.read(buf, 0, buf.length, null)
      if (!bytesRead) break
      h.update(buf.subarray(0, bytesRead))
      if (onBytes) onBytes(bytesRead)
    }
    return h.digest('hex')
  } finally {
    await fh.close().catch(() => {})
  }
}

const tag = (err, side) => {
  if (err && typeof err === 'object' && !err.side) err.side = side
  return err
}

// Copies from to to, hashing the bytes as they pass; errors say whether reading (source) or writing (dest) failed
async function copyHashed(from, to, { signal, onBytes, chunkSize = CHUNK } = {}) {
  let src, dst
  try { src = await fsp.open(from, 'r') } catch (err) { throw tag(err, 'source') }
  try {
    try { dst = await fsp.open(to, 'w') } catch (err) { throw tag(err, 'dest') }
    const h = crypto.createHash('sha256')
    const buf = Buffer.allocUnsafe(chunkSize)
    let size = 0
    for (;;) {
      checkAbort(signal)
      let n
      try { n = (await src.read(buf, 0, buf.length, null)).bytesRead } catch (err) { throw tag(err, 'source') }
      if (!n) break
      h.update(buf.subarray(0, n))
      try {
        for (let off = 0; off < n;) off += (await dst.write(buf, off, n - off, null)).bytesWritten
      } catch (err) { throw tag(err, 'dest') }
      size += n
      if (onBytes) onBytes(n)
    }
    try { await dst.sync() } catch (err) { throw tag(err, 'dest') }
    return { size, sha256: h.digest('hex') }
  } finally {
    await src.close().catch(() => {})
    if (dst) await dst.close().catch(() => {})
  }
}

// Every file below root by lower-case relative path. Links in a source folder are followed (a Data folder moved to
// another drive with a junction), each real folder once. followLinks false (the copy itself): a link, to a folder or
// a file, is followed only when allowLink(its real path) says so (main.js: anything but the Skyrim folder and the
// Steam libraries), so a junction from the copy into the Steam folder cannot pass for the copy's own files
async function walkFiles(root, { followLinks = true, allowLink = noLinks } = {}) {
  const out = new Map()
  const seen = new Set()
  const visit = async (dir, prefix) => {
    // Each real folder once (a link loop ends); where real paths cannot be read, the path itself stands in
    const real = await fsp.realpath(dir).catch(() => path.resolve(dir))
    const rk = process.platform === 'win32' ? real.toLowerCase() : real
    if (seen.has(rk)) return
    seen.add(rk)
    let entries
    try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name
      const abs = path.join(dir, e.name)
      let isDir = e.isDirectory()
      let isFile = e.isFile()
      if (e.isSymbolicLink()) {
        if (!followLinks) {
          const real = await fsp.realpath(abs).catch(() => null)
          if (!real || !allowLink(real)) continue
        }
        const info = await fileInfo(abs)
        if (!info) continue
        isDir = info.isDir
        isFile = info.isFile
      }
      if (isDir) await visit(abs, rel)
      else if (isFile && !out.has(keyOf(rel))) out.set(keyOf(rel), { rel, abs })
    }
  }
  await visit(path.resolve(root), '')
  return out
}

// root/rel ignoring case segment by segment (exact on Windows anyway; Linux tests need the lookup), or null
async function resolveCi(root, rel) {
  let cur = path.resolve(root)
  for (const seg of normRel(rel).split('/')) {
    const exact = path.join(cur, seg)
    if (await fileInfo(exact, { lstat: true })) { cur = exact; continue }
    let names
    try { names = await fsp.readdir(cur) } catch { return null }
    const hit = names.find(n => n.toLowerCase() === seg.toLowerCase())
    if (!hit) return null
    cur = path.join(cur, hit)
  }
  return cur
}

async function fileIn(root, rel) {
  const abs = await resolveCi(root, rel)
  const info = abs ? await fileInfo(abs) : null
  return info && info.isFile ? { abs, ...info } : null
}

/**
 * A listed file's copy in Steam's download_depot output. depotDir is the app_489830 folder (depot_<id> below it, or
 * <id>) or a { depotId: folder } map, as downgrade.findDepots gives.
 */
async function depotFile(depotDir, e) {
  const roots = []
  if (depotDir && typeof depotDir === 'object') {
    if (e.depot) { if (depotDir[e.depot]) roots.push(depotDir[e.depot]) } else roots.push(...Object.values(depotDir).filter(Boolean))
  } else if (depotDir) {
    if (e.depot) roots.push(path.join(depotDir, `depot_${e.depot}`), path.join(depotDir, e.depot))
    else {
      try {
        for (const n of await fsp.readdir(depotDir)) if (/^depot_\d+$/i.test(n)) roots.push(path.join(depotDir, n))
      } catch { /* no depot folder */ }
    }
  }
  for (const r of roots) {
    const hit = await fileIn(r, e.path)
    if (hit) return hit
  }
  return null
}

/**
 * Each listed file in srcDir: 'match', 'changed' (reason 'size' or 'sha256') or 'missing', plus the extras (files not
 * on the list, by their own path), which nothing here ever copies. Sizes are compared first; a file is hashed only
 * when its size is right. hash: false compares sizes only (verified: false), leaving the sha256 to run, which reads
 * each file once while copying; a wrong one then falls back to the depot.
 */
async function classify(srcDir, manifest, {
  hash = hashFile, signal, onProgress = () => {}, followLinks = true, confine = false, allowLink = noLinks,
} = {}) {
  const root = path.resolve(srcDir)
  const found = await walkFiles(root, { followLinks, allowLink })
  // confine (the copy itself): a file whose real path is neither under the folder's real path nor an allowed link
  // target counts as missing. A real path that cannot be worked out (RAM disks, some virtual volumes) is not held
  // against the file: the walk already left out links, and build checks every listed folder with lstat
  const realRoot = confine ? await fsp.realpath(root).catch(() => null) : null
  if (realRoot) {
    for (const [k, v] of [...found]) {
      const real = await fsp.realpath(v.abs).catch(() => null)
      if (real && !isInside(realRoot, real) && !allowLink(real)) found.delete(k)
    }
  }
  const files = []
  const counts = { match: 0, changed: 0, missing: 0 }
  const total = manifest.files.size
  let index = 0
  let doneBytes = 0
  for (const e of manifest.files.values()) {
    checkAbort(signal)
    index++
    const hit = found.get(e.key)
    const info = hit ? await fileInfo(hit.abs) : null
    let state = 'match'
    let reason = null
    if (!info || !info.isFile) state = 'missing'
    else if (info.size !== e.size) { state = 'changed'; reason = 'size' }
    else if (hash) {
      onProgress({ step: 'hash', index, total, file: e.path, doneBytes, totalBytes: manifest.bytes })
      const onBytes = n => { doneBytes += n; onProgress({ step: 'hash', index, total, file: e.path, doneBytes, totalBytes: manifest.bytes }) }
      if ((await hash(hit.abs, { signal, onBytes })) !== e.sha256) { state = 'changed'; reason = 'sha256' }
    }
    counts[state]++
    files.push({
      ...e, state, reason, verified: state === 'match' && !!hash,
      from: info ? hit.abs : null, mtimeMs: info ? info.mtimeMs : null, ino: info ? info.ino : null,
    })
  }
  const extras = [...found].filter(([k]) => !manifest.files.has(k)).map(([, v]) => v.rel).sort()
  return { srcDir: root, files, extras, counts }
}

/**
 * The copy jobs: a matching file comes from the source folder; a changed or missing one from the depot output when
 * its file there has the right size and sha256 (hash: false leaves that to run). A file neither can give is
 * unresolved: the player must download it (depotsNeeded says which download_depot commands). move: false copies
 * depot files instead of moving them.
 */
async function plan(classification, { depotDir = null, hash = hashFile, move = true, signal, onProgress = () => {} } = {}) {
  const jobs = []
  const unresolved = []
  const total = classification.files.length
  for (const [i, f] of classification.files.entries()) {
    checkAbort(signal)
    const sources = []
    if (f.state === 'match') sources.push({ kind: 'source', from: f.from, move: false })
    const cand = depotDir ? await depotFile(depotDir, f) : null
    let depotState = cand ? 'ok' : 'absent'
    if (cand && cand.size !== f.size) depotState = 'wrong'
    else if (cand && f.state !== 'match' && hash) {
      onProgress({ step: 'hash-depot', index: i + 1, total, file: f.path })
      if ((await hash(cand.abs, { signal })) !== f.sha256) depotState = 'wrong'
    }
    // A matching source keeps the depot copy as a fallback; run checks every byte either way
    if (depotState === 'ok') sources.push({ kind: 'depot', from: cand.abs, move })
    const job = { path: f.path, key: f.key, size: f.size, sha256: f.sha256, depot: f.depot, sources }
    if (sources.length) jobs.push(job)
    else unresolved.push({ path: f.path, size: f.size, depot: f.depot, state: f.state, depotFile: depotState })
  }
  const depotsNeeded = [...new Set(unresolved.map(u => u.depot).filter(Boolean))].sort()
  return { jobs, unresolved, depotsNeeded, bytes: jobs.reduce((n, j) => n + j.size, 0) }
}

// The real path of the copy's root, made if needed (the path itself where real paths cannot be read)
async function openRoot(destDir) {
  await fsp.mkdir(destDir, { recursive: true })
  return fsp.realpath(destDir).catch(() => path.resolve(destDir))
}

// rel's full path in the copy, its folders made one by one; a folder that is a file, or a link whose real path the
// policy does not allow, is refused
async function targetIn(root, rel, okDirs, allowLink = noLinks) {
  const parts = normRel(rel).split('/')
  let cur = root
  let sub = ''
  for (const seg of parts.slice(0, -1)) {
    cur = path.join(cur, seg)
    sub = sub ? `${sub}/${seg}` : seg
    if (okDirs.has(sub)) continue
    let info = await fileInfo(cur, { lstat: true })
    if (!info) {
      try { await fsp.mkdir(cur) } catch (err) { if (err.code !== 'EEXIST') throw err }
      info = await fileInfo(cur, { lstat: true })
    }
    let ok = !!info && info.isDir && !info.isLink
    if (info && info.isLink) {
      const real = await fsp.realpath(cur).catch(() => null)
      const target = real ? await fileInfo(real) : null
      ok = !!real && !!target && target.isDir && allowLink(real)
    }
    if (!ok) throw new Error(`${sub} in the game copy is a link or a file, not a folder; nothing is written through it.`)
    okDirs.add(sub)
  }
  return safeJoin(root, parts.join('/'))
}

// Puts tmp under its real name. Windows will not replace a read-only file (made writable first), and a virus scanner
// can hold a just-written file for a moment, so a refused rename is tried a few more times
async function replaceFile(tmp, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      await fsp.rename(tmp, to)
      return
    } catch (err) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(err.code) || attempt >= 4) throw err
      if (attempt === 0) await fsp.chmod(to, 0o666).catch(() => {})
      await new Promise(r => setTimeout(r, 50 * 2 ** attempt))
    }
  }
}

// One source into tmp: { ok, how, size, sha256 } or { ok: false, why } when the source cannot be read. Throws on an
// abort or a write error, with tmp gone and a moved depot file back where it was
async function place(src, tmp, { signal, chunkSize, onBytes }) {
  if (src.move) {
    let moved = false
    try { await fsp.rename(src.from, tmp); moved = true } catch { /* another drive or held open: copy instead */ }
    if (moved) {
      try {
        const sha256 = await hashFile(tmp, { signal, chunkSize, onBytes })
        const info = await fileInfo(tmp)
        return { ok: true, how: 'moved', size: info ? info.size : -1, sha256 }
      } catch (err) {
        await fsp.rename(tmp, src.from).catch(() => {})
        if (isAbort(err, signal)) throw err
        return { ok: false, why: err.code || err.message }
      }
    }
  }
  try {
    return { ok: true, how: 'copied', ...(await copyHashed(src.from, tmp, { signal, chunkSize, onBytes })) }
  } catch (err) {
    await rmFile(tmp)
    if (isAbort(err, signal) || err.side === 'dest') throw err
    return { ok: false, why: err.code || err.message }
  }
}

// Undoes place: a moved depot file goes back (if that fails it stays as the part file, which the next run deletes
// before writing), a copy is deleted
async function unplace(src, tmp, how) {
  if (how === 'moved') await fsp.rename(tmp, src.from).catch(() => {})
  else await rmFile(tmp)
}

/**
 * Writes each job ({ path, size, sha256, sources: [{ kind, from, move }] }) into destDir. Each source is tried in
 * order until one gives the right size and sha256; a file none can give is listed in failed and the run goes on.
 * Bytes go to <name>.dbpart and get the real name only once checked. An abort (signal) or a write error stops the
 * run and throws, with no temporary file left and a moved depot file put back.
 * onProgress({ step: 'copy', index, total, file, fileBytes, fileSize, doneBytes, totalBytes }).
 */
async function run(jobs, destDir, { onProgress = () => {}, signal, chunkSize = CHUNK, allowLink = noLinks } = {}) {
  for (const j of jobs) normRel(j.path)
  const root = await openRoot(destDir)
  const okDirs = new Set()
  const totalBytes = jobs.reduce((n, j) => n + j.size, 0)
  let doneBytes = 0
  const written = []
  const failed = []
  for (const [i, job] of jobs.entries()) {
    checkAbort(signal)
    const rel = normRel(job.path)
    const to = await targetIn(root, rel, okDirs, allowLink)
    const tmp = to + TEMP_SUFFIX
    await rmFile(tmp)
    const report = fileBytes => onProgress({
      step: 'copy', index: i + 1, total: jobs.length, file: rel, fileBytes, fileSize: job.size,
      doneBytes: doneBytes + Math.min(fileBytes, job.size), totalBytes,
    })
    report(0)
    const tried = []
    let placed = null
    for (const src of job.sources || []) {
      let fileBytes = 0
      const r = await place(src, tmp, { signal, chunkSize, onBytes: n => { fileBytes += n; report(fileBytes) } })
      if (r.ok && r.size === job.size && r.sha256 === job.sha256) { placed = { src, ...r }; break }
      if (r.ok) await unplace(src, tmp, r.how)
      tried.push(`${src.kind}: ${r.ok ? (r.size !== job.size ? 'wrong size' : 'sha256 differs') : r.why}`)
    }
    doneBytes += job.size
    if (!placed) {
      failed.push({ path: rel, size: job.size, depot: job.depot || null, tried })
      continue
    }
    try {
      await replaceFile(tmp, to)
    } catch (err) {
      await unplace(placed.src, tmp, placed.how)
      throw err
    }
    const info = await fileInfo(to)
    written.push({
      path: rel, size: info.size, mtimeMs: info.mtimeMs, ino: info.ino, sha256: placed.sha256,
      source: placed.src.kind, how: placed.how,
    })
  }
  return { written, failed, bytes: totalBytes }
}

function normRecordFile(f) {
  const { rel, sha256 } = checkEntry(f, 'record')
  const out = { path: rel, size: f.size, mtimeMs: Number(f.mtimeMs), sha256 }
  if (f.ino) out.ino = String(f.ino)
  return out
}

/**
 * The record of a finished copy. files: run's written entries, plus classify(destDir) matches for files a previous
 * run already put there (both carry path, size, mtimeMs, ino and sha256). Only verified files belong here.
 */
function makeRecord({ manifest, files, source = null, depotDir = null, now = new Date() }) {
  return {
    format: RECORD_FORMAT,
    build: manifest.build,
    platform: manifest.platform,
    language: manifest.language || null,
    source: { dir: source, depotDir: typeof depotDir === 'string' ? depotDir : null },
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    files: files.map(normRecordFile).sort(byPath),
  }
}

// <destDir>\dragonbreak-game.json, written whole through a temporary file
async function writeRecord(destDir, record) {
  const files = record.files.map(normRecordFile)
  const file = path.join(path.resolve(destDir), RECORD_FILE)
  await fsp.writeFile(file + TEMP_SUFFIX, JSON.stringify({ ...record, files }, null, 2) + '\n')
  await replaceFile(file + TEMP_SUFFIX, file)
  return file
}

// The record, or null when there is none or it is unreadable, of another format or holds an unsafe path
async function readRecord(destDir) {
  let rec
  try { rec = JSON.parse(await fsp.readFile(path.join(path.resolve(destDir), RECORD_FILE), 'utf8')) } catch { return null }
  if (!rec || rec.format !== RECORD_FORMAT || !Array.isArray(rec.files)) return null
  try { return { ...rec, files: rec.files.map(normRecordFile) } } catch { return null }
}

/**
 * What has changed in the copy since the record, fast: a file whose size, mtime and file id are as recorded is taken
 * as is; any other is hashed. Returns
 *   changed        listed files whose content is wrong
 *   missing        listed files that are gone
 *   linked         listed files that are links or have other hard links (an in-place write elsewhere would change ours)
 *   extraRootDlls  .dll files in the copy's root that are neither listed nor on allowRootDlls (our SKSE and preloader
 *                  DLLs) - dinput8.dll, d3d11.dll, dxgi.dll and the like
 *   touched        files hashed again and still right (new mtime or id): repair updates their record entries
 * The list compared against is the manifest when it has files, else the record itself.
 */
async function drift(destDir, record, manifest = null, {
  allowRootDlls = [], hash = hashFile, signal, onProgress = () => {}, allowLink = noLinks,
} = {}) {
  const root = path.resolve(destDir)
  const rec = new Map(((record && record.files) || []).map(f => [keyOf(f.path), f]))
  const expected = manifest && manifest.files.size
    ? [...manifest.files.values()]
    : [...rec.values()].map(f => ({ path: f.path, key: keyOf(f.path), size: f.size, sha256: f.sha256 }))
  const out = { ok: true, changed: [], missing: [], linked: [], extraRootDlls: [], touched: [], checked: 0, rehashed: 0 }
  // Folders on the listed paths that are links the policy refuses, by lstat: works where real paths cannot be read
  const badDirs = await linkedFolders(root, expected.map(e => e.path), { allowLink })
  const underBadDir = rel => badDirs.some(d => keyOf(rel).startsWith(`${keyOf(d)}/`))
  const realRoot = await fsp.realpath(root).catch(() => null)
  for (const [i, e] of expected.entries()) {
    checkAbort(signal)
    out.checked++
    const file = safeJoin(root, e.path)
    const info = await fileInfo(file, { lstat: true })
    const r = rec.get(e.key)
    if (!info || !(info.isFile || info.isLink)) { out.missing.push(e.path); continue }
    if (info.isLink || info.nlink > 1) { out.linked.push(e.path); continue }
    // A folder above it that is a link (a junction from the copy's Data into the Steam folder) shows in lstat and in
    // the real path. A real path that cannot be worked out (RAM disks, some virtual volumes) counts as unknown, not
    // as linked, so such a copy is not copied again on every PLAY
    if (underBadDir(e.path)) { out.linked.push(e.path); continue }
    const real = realRoot ? await fsp.realpath(file).catch(() => null) : null
    if (real && !isInside(realRoot, real) && !allowLink(real)) { out.linked.push(e.path); continue }
    if (info.size !== e.size) { out.changed.push(e.path); continue }
    if (r && r.sha256 === e.sha256 && r.size === info.size && r.mtimeMs === info.mtimeMs &&
        (!r.ino || !info.ino || r.ino === info.ino)) continue
    onProgress({ step: 'rehash', index: i + 1, total: expected.length, file: e.path })
    out.rehashed++
    let sha
    try { sha = await hash(file, { signal }) } catch (err) { if (isAbort(err, signal)) throw err; sha = null }
    if (sha === e.sha256) out.touched.push({ path: e.path, size: info.size, mtimeMs: info.mtimeMs, ino: info.ino, sha256: sha })
    else out.changed.push(e.path)
  }
  const known = new Set(expected.map(e => e.key))
  const allow = new Set(allowRootDlls.map(n => n.toLowerCase()))
  let entries = []
  try { entries = await fsp.readdir(root, { withFileTypes: true }) } catch { /* no copy */ }
  for (const d of entries) {
    const l = d.name.toLowerCase()
    if (!d.isDirectory() && l.endsWith('.dll') && !known.has(l) && !allow.has(l)) out.extraRootDlls.push(d.name)
  }
  out.extraRootDlls.sort()
  out.ok = !out.changed.length && !out.missing.length && !out.linked.length && !out.extraRootDlls.length
  return out
}

// Moves root DLLs into <copy>\_DragonBreakSetAside\<stamp>\ (the game only loads DLLs beside the exe)
async function setAsideDlls(destDir, names, now = new Date()) {
  if (!names.length) return []
  const root = await openRoot(destDir)
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  const moved = []
  for (const name of names) {
    const rel = normRel(name)
    if (rel.includes('/')) throw new Error(`Not a root file: ${name}`)
    const to = await targetIn(root, `${SET_ASIDE_DIR}/${stamp}/${rel}`, new Set())
    try { await fsp.rename(path.join(root, rel), to); moved.push(rel) } catch { /* gone already, or held open by a running game */ }
  }
  return moved
}

/**
 * Puts the copy right again after drift. Every changed, missing or linked file is copied from the first source whose
 * file has the right sha256 (checked while copying): sources is a list of { dir, kind: 'source' | 'depot' }, by
 * default the record's own source then its depot folder. A file no source has right stays unresolved; nothing
 * unverified is ever written. Unknown root DLLs are set aside: setAside true takes every one drift listed, a list of
 * names only those, false none. The record is updated for the repaired and touched files and written back.
 */
async function repair(destDir, driftResult, sources, {
  record, manifest = null, signal, onProgress = () => {}, chunkSize = CHUNK, setAside = true, now = new Date(), allowLink = noLinks,
} = {}) {
  if (!record) throw new Error('repair needs the copy\'s record')
  const root = path.resolve(destDir)
  const recFiles = new Map(record.files.map(f => [keyOf(f.path), f]))
  const lookup = rel => (manifest && manifest.files.get(keyOf(rel))) || recFiles.get(keyOf(rel)) || null
  const from = sources && sources.length
    ? sources.map(s => (typeof s === 'string' ? { dir: s, kind: 'source' } : s))
    : [{ dir: record.source && record.source.dir, kind: 'source' }, { dir: record.source && record.source.depotDir, kind: 'depot' }]
  const list = from.filter(s => s.dir)
  const jobs = []
  const unresolved = []
  for (const rel of [...driftResult.changed, ...driftResult.missing, ...(driftResult.linked || [])]) {
    checkAbort(signal)
    const e = lookup(rel)
    if (!e) { unresolved.push({ path: rel, why: 'not on the game file list' }); continue }
    const srcs = []
    for (const s of list) {
      const c = s.kind === 'depot' ? await depotFile(s.dir, e) : await fileIn(s.dir, e.path)
      if (c && c.size === e.size) srcs.push({ kind: s.kind, from: c.abs, move: false })
    }
    if (srcs.length) jobs.push({ path: e.path, size: e.size, sha256: e.sha256, depot: e.depot || null, sources: srcs })
    else unresolved.push({ path: e.path, size: e.size, depot: e.depot || null, why: 'no source has this file at the right size' })
  }
  const res = await run(jobs, root, { onProgress, signal, chunkSize, allowLink })
  for (const f of res.failed) unresolved.push({ path: f.path, size: f.size, depot: f.depot, why: f.tried.join('; ') })
  const extra = driftResult.extraRootDlls || []
  const pick = Array.isArray(setAside) ? new Set(setAside.map(n => n.toLowerCase())) : null
  const names = setAside === true ? extra : pick ? extra.filter(n => pick.has(n.toLowerCase())) : []
  const setAsideDone = await setAsideDlls(root, names, now)
  const files = new Map(record.files.map(f => [keyOf(f.path), f]))
  for (const f of [...res.written, ...(driftResult.touched || [])]) files.set(keyOf(f.path), normRecordFile(f))
  const updated = { ...record, updatedAt: now.toISOString(), files: [...files.values()].sort(byPath) }
  await writeRecord(root, updated)
  return { ok: unresolved.length === 0, repaired: res.written.map(f => f.path), unresolved, setAside: setAsideDone, record: updated }
}

// The device id of p or its nearest existing parent folder, or null
async function deviceOf(p) {
  let cur = path.resolve(p)
  for (;;) {
    try { return String((await fsp.stat(cur, { bigint: true })).dev) } catch { /* not made yet */ }
    const up = path.dirname(cur)
    if (up === cur) return null
    cur = up
  }
}

/**
 * Bytes a run still has to write: the size of every job, except depot files that a move puts in place on the same
 * drive. largest is the biggest single file (its temporary copy and the old file exist together for a moment).
 */
async function bytesNeeded(jobs, destDir) {
  const dest = await deviceOf(destDir)
  let bytes = 0
  let largest = 0
  for (const j of jobs) {
    const first = (j.sources || [])[0]
    if (first && first.move && dest !== null && (await deviceOf(first.from)) === dest) continue
    bytes += j.size
    largest = Math.max(largest, j.size)
  }
  return { bytes, largest, files: jobs.length }
}

/**
 * A quick estimate for the setup screen, without hashing: the bytes of listed files the copy does not yet hold at the
 * right size, less those a depot folder on the copy's drive holds (they are moved in, not copied).
 */
async function estimateBytes(manifest, destDir, { depotDir = null } = {}) {
  const dest = await deviceOf(destDir)
  let bytes = 0
  for (const e of manifest.files.values()) {
    const have = await fileInfo(safeJoin(destDir, e.path))
    if (have && have.isFile && have.size === e.size) continue
    const d = depotDir ? await depotFile(depotDir, e) : null
    if (d && d.size === e.size && dest !== null && (await deviceOf(d.abs)) === dest) continue
    bytes += e.size
  }
  return { bytes, total: manifest.bytes }
}

/**
 * Builds or completes the copy in one go. Listed files already in destDir with the right sha256 stay (a resumed run,
 * or a copy an older launcher made by file name); the rest come from srcDir (sizes first, the sha256 checked while
 * copying) or from the depot output. Nothing is copied while a file is unresolved, so the player hears about the
 * downloads first, or while checkSpace(need) returns a refusal text. A file whose source turns out wrong while copying
 * ends up in failed, with the depots that hold it. On success the record is written.
 * Returns { ok, kept, written, unresolved, failed, depotsNeeded, need, error?, record? }.
 */
async function build(srcDir, destDir, {
  manifest, depotDir = null, move = true, checkSpace = null, signal, onProgress = () => {}, now = new Date(), allowLink = noLinks,
} = {}) {
  if (!manifest || !manifest.ready) throw new Error('There is no game file list to build the copy from.')
  const destExists = !!(await fileInfo(destDir))
  if (destExists) {
    const linked = await linkedFolders(destDir, [...manifest.files.values()].map(e => e.path), { allowLink })
    if (linked.length) throw new Error(`${linked[0]} in the game copy is a link to another folder; nothing is read or written through it. Remove the link, then try again.`)
  }
  const have = destExists
    ? await classify(destDir, manifest, { signal, onProgress: p => onProgress({ ...p, step: 'check' }), followLinks: false, confine: true, allowLink })
    : { files: [] }
  const keep = have.files.filter(f => f.state === 'match')
  // A file moved in from the depot output whose run stopped (the launcher closed) is left as <name>.dbpart: kept if
  // it is the right file, since the depot no longer has it
  for (const e of have.files.filter(f => f.state !== 'match')) {
    const adopted = await adoptPart(destDir, e, { signal })
    if (adopted) keep.push(adopted)
  }
  const kept = new Set(keep.map(f => f.key))
  const restFiles = new Map([...manifest.files].filter(([k]) => !kept.has(k)))
  const rest = { ...manifest, files: restFiles, bytes: [...restFiles.values()].reduce((n, f) => n + f.size, 0) }
  const fromSource = !!(srcDir && (await fileInfo(srcDir)))
  const cls = fromSource
    ? await classify(srcDir, rest, { hash: false, signal })
    : { files: [...restFiles.values()].map(e => ({ ...e, state: 'missing', reason: null, verified: false, from: null, mtimeMs: null, ino: null })) }
  const p = await plan(cls, { depotDir, hash: false, move, signal })
  const out = { ok: false, kept: keep.length, written: 0, unresolved: p.unresolved, failed: [], depotsNeeded: p.depotsNeeded, need: null }
  if (p.unresolved.length) return out
  out.need = await bytesNeeded(p.jobs, destDir)
  if (checkSpace) {
    const refusal = await checkSpace(out.need)
    if (refusal) return { ...out, error: refusal }
  }
  const res = await run(p.jobs, destDir, { signal, onProgress, allowLink })
  out.written = res.written.length
  if (res.failed.length) {
    return { ...out, failed: res.failed, depotsNeeded: [...new Set(res.failed.map(f => f.depot).filter(Boolean))].sort() }
  }
  const record = makeRecord({
    manifest, files: [...keep, ...res.written], source: fromSource ? path.resolve(srcDir) : null, depotDir, now,
  })
  await writeRecord(destDir, record)
  return { ...out, ok: true, record }
}

// Folders on the listed paths that exist in the copy as links (junctions, symlinks), relative, or none
async function linkedFolders(destDir, rels, { allowLink = noLinks } = {}) {
  const dirs = new Set()
  for (const rel of rels) {
    const parts = normRel(rel).split('/')
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'))
  }
  const out = []
  for (const d of [...dirs].sort()) {
    const abs = safeJoin(destDir, d)
    const info = await fileInfo(abs, { lstat: true })
    if (!info) continue
    if (info.isLink) {
      const real = await fsp.realpath(abs).catch(() => null)
      const target = real ? await fileInfo(real) : null
      if (real && target && target.isDir && allowLink(real)) continue
      out.push(d)
    } else if (!info.isDir) out.push(d)
  }
  return out
}

// <listed file>.dbpart with the listed size and sha256 becomes the file; returns the kept entry, or null
async function adoptPart(destDir, e, { signal } = {}) {
  const to = safeJoin(destDir, e.path)
  const tmp = to + TEMP_SUFFIX
  const info = await fileInfo(tmp, { lstat: true })
  if (!info || !info.isFile || info.size !== e.size) return null
  if ((await hashFile(tmp, { signal })) !== e.sha256) return null
  await replaceFile(tmp, to)
  const now = await fileInfo(to)
  return { ...e, state: 'match', verified: true, from: to, mtimeMs: now.mtimeMs, ino: now.ino }
}

// Free bytes on the drive holding dir (or its nearest existing parent), or null where the platform cannot tell
async function freeBytes(dir) {
  if (!fsp.statfs) return null
  let cur = path.resolve(dir)
  for (;;) {
    try { const s = await fsp.statfs(cur); return s.bavail * s.bsize } catch { /* not made yet */ }
    const up = path.dirname(cur)
    if (up === cur) return null
    cur = up
  }
}

module.exports = {
  RECORD_FILE, RECORD_FORMAT, TEMP_SUFFIX, SET_ASIDE_DIR,
  normRel, safeJoin, loadManifest, mergeLists, bundledManifest, hashFile, classify, plan, run, linkedFolders,
  makeRecord, writeRecord, readRecord, drift, repair, setAsideDlls, bytesNeeded, estimateBytes, freeBytes, build,
}
