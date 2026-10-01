'use strict'

/**
 * Archives a build's source map, or a DLL drop's PDBs, into the backend data folder (docs/auto-report-v1.md §5.4).
 * The build pipeline runs it after each webpack run and before any packaging step; any failure exits 1:
 *   node scripts/archive-symbols.js client --build <id> --bundle <dir>/skymp5-client.js --map <dir>/skymp5-client.js.map --client-version <v>
 *   node scripts/archive-symbols.js front  --build <id> --bundle <dir>/build.js --map <dir>/build.js.map
 *   node scripts/archive-symbols.js pdb    --files-version <v> --pdb-dir <dir> --dll-dir <dir>
 * client and front check the sidecar <bundle name without .js>.build.json, then delete the map and the sidecar from the build output.
 * --store may only name the default. No .env is loaded and nothing read is ever printed.
 */

const crypto = require('crypto')
const fs     = require('fs')
const path   = require('path')
const { SourceMap } = require('module')
const { PATTERNS } = require('../sources/autoSchema')
const { writeAtomic } = require('../sources/atomicFile')

const STORE = '/opt/alduinak/skymp5-backend/data'
const BUNDLES = { client: 'skymp5-client.js', front: 'build.js' }
const FLAGS = {
  client: ['build', 'bundle', 'map', 'client-version'],
  front: ['build', 'bundle', 'map'],
  pdb: ['files-version', 'pdb-dir', 'dll-dir'],
}
const PROBE_MARKER = '__DBO_STACK_PROBE__'
const MAP_COMMENT = /[#@][ \t]*sourceMappingURL[ \t]*=/
const MB = 1024 * 1024
const MAX_BYTES = { sidecar: 4096, index: MB, bundle: 64 * MB, map: 256 * MB, image: 512 * MB, pdb: 1024 * MB }
const IMAGE_NAME = /^(.+)\.(?:dll|exe)(?:\.hidden)?$/i
const SYMBOL_FILE = /\.(?:map|pdb)$/i
const PACKAGED_BUNDLE = /(?:^|\/)Platform\/(?:Plugins\/skymp5-client|UI\/build)\.js$/
const MSF_MAGIC = Buffer.from('Microsoft C/C++ MSF 7.00\r\n\x1aDS\0\0\0', 'latin1')
const MSF_BLOCK_SIZES = [512, 1024, 2048, 4096]
const MSF_DIR_MAX = 16 * MB
const WALK_MAX_DEPTH = 8
const WALK_MAX_ENTRIES = 20000

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const count = (text, ch) => text.split(ch).length - 1
const camel = flag => flag.replace(/-([a-z])/g, (_, c) => c.toUpperCase())

// The bytes of a regular file; a symlink, folder or device is refused and a FIFO never blocks
function readRegular(file, maxBytes) {
  let fd
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK) }
  catch (err) { throw new Error(`${file}: ${{ ELOOP: 'is a symlink', ENOENT: 'not found' }[err.code] || err.code || err.message}`) }
  try {
    const st = fs.fstatSync(fd)
    if (!st.isFile()) throw new Error(`${file}: not a regular file`)
    if (st.size > maxBytes) throw new Error(`${file}: over ${maxBytes} bytes`)
    return fs.readFileSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

// The parse error would quote the file, which the pipeline user may not be allowed to read
function parseJson(bytes, file) {
  try { return JSON.parse(bytes.toString('utf8')) }
  catch { throw new Error(`${file}: not valid JSON`) }
}

function buildTime(build) {
  const [, y, mo, d, h, mi, s] = /\.(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(build).map(Number)
  return Date.UTC(y, mo - 1, d, h, mi, s)
}

// The 1-based bundle line holding the probe marker, counted as the map counts lines
function probeLine(text, bundle) {
  const at = text.indexOf(PROBE_MARKER)
  if (at < 0 || text.includes(PROBE_MARKER, at + 1)) throw new Error(`${bundle}: must hold ${PROBE_MARKER} exactly once`)
  return count(text.slice(0, at), '\n') + 1
}

// The backend's parser must load it, and it must not map more lines than the bundle has
function checkMap(map, bundleLines, file) {
  if (!map || map.version !== 3 || typeof map.mappings !== 'string' || !Array.isArray(map.sources) || !map.sources.length) {
    throw new Error(`${file}: not a source map`)
  }
  if (count(map.mappings, ';') + 1 > bundleLines) throw new Error(`${file}: maps more lines than the bundle has`)
  try { new SourceMap(map) }
  catch { throw new Error(`${file}: does not load as a source map`) }
}

// client or front; returns the meta file written next to the archived map
function archiveBundle(kind, { build, bundle, map, clientVersion, store }) {
  if (!PATTERNS.build.test(build || '')) throw new Error(`--build ${build} is not a build id`)
  if (kind === 'client' && !PATTERNS.version.test(clientVersion || '')) throw new Error(`--client-version ${clientVersion} is not a version`)
  if (path.basename(bundle) !== BUNDLES[kind]) throw new Error(`--bundle must be a ${BUNDLES[kind]}`)
  if (path.resolve(map) !== path.resolve(`${bundle}.map`)) throw new Error(`--map must be ${BUNDLES[kind]}.map next to the bundle`)
  const sidecar = path.join(path.dirname(bundle), `${path.basename(bundle, '.js')}.build.json`)
  const stamp = parseJson(readRegular(sidecar, MAX_BYTES.sidecar), sidecar)
  if (!stamp || stamp.build !== build) throw new Error(`${sidecar}: names another build`)
  if (kind === 'client' && stamp.clientVersion !== clientVersion) throw new Error(`${sidecar}: names another client version`)

  const code = readRegular(bundle, MAX_BYTES.bundle)
  const text = code.toString('utf8')
  if (MAP_COMMENT.test(text)) throw new Error(`${bundle}: has a sourceMappingURL comment or an inline map`)
  const mapBytes = readRegular(map, MAX_BYTES.map)
  checkMap(parseJson(mapBytes, map), count(text, '\n') + 1, map)
  const meta = {
    v: 1, kind, build, gitSha: build.slice(0, 12), dirty: build.includes('-dirty'), builtAt: buildTime(build),
    ...(kind === 'client' && { clientVersion }),
    bundleBytes: code.length, bundleSha256: sha256(code),
    ...(kind === 'client' && { probeLine: probeLine(text, bundle) }),
  }

  const dir = path.join(store, 'sourcemaps', kind)
  const files = ['map', 'json'].map(ext => path.join(dir, `${build}.${ext}`))
  if (files.some(file => fs.existsSync(file))) throw new Error(`${kind} build ${build} is already archived`)
  // The map goes first: the backend treats a build as known once its meta file exists
  writeAtomic(files[0], mapBytes)
  writeAtomic(files[1], JSON.stringify(meta))
  for (const file of [map, sidecar]) {
    try { fs.unlinkSync(file) }
    catch (err) { throw new Error(`archived, but ${file} could not be removed from the build output: ${err.code || err.message}`) }
  }
  return meta
}

// { timestamp, guid, age } from a PE image's CodeView (RSDS) debug record, or null
function peInfo(b) {
  try {
    const pe = b.readUInt32LE(0x3c)
    if (b.toString('latin1', 0, 2) !== 'MZ' || b.readUInt32LE(pe) !== 0x4550) return null
    const sections = b.readUInt16LE(pe + 6)
    const opt = pe + 24
    const optSize = b.readUInt16LE(pe + 20)
    const dirsAt = { 0x10b: 96, 0x20b: 112 }[b.readUInt16LE(opt)]
    if (!dirsAt || dirsAt + 56 > optSize || b.readUInt32LE(opt + dirsAt - 4) < 7) return null
    const debugRva = b.readUInt32LE(opt + dirsAt + 48)
    const debugSize = b.readUInt32LE(opt + dirsAt + 52)
    let table = -1
    for (let i = 0; i < sections && table < 0; i++) {
      const s = opt + optSize + i * 40
      const va = b.readUInt32LE(s + 12)
      if (debugRva >= va && debugRva < va + Math.max(b.readUInt32LE(s + 8), b.readUInt32LE(s + 16))) table = b.readUInt32LE(s + 20) + debugRva - va
    }
    for (let at = table; table >= 0 && at + 28 <= table + debugSize; at += 28) {
      const cv = b.readUInt32LE(at + 24)
      if (b.readUInt32LE(at + 12) === 2 && b.toString('latin1', cv, cv + 4) === 'RSDS') {
        return { timestamp: b.readUInt32LE(pe + 8), age: b.readUInt32LE(cv + 20), guid: b.subarray(cv + 4, cv + 20) }
      }
    }
  } catch { /* truncated or malformed */ }
  return null
}

// { guid, age } from a PDB's info stream (MSF 7.0 stream 1), or null
function pdbInfo(b) {
  try {
    const size = b.readUInt32LE(32)
    const dirBytes = b.readUInt32LE(44)
    if (!b.subarray(0, 32).equals(MSF_MAGIC) || !MSF_BLOCK_SIZES.includes(size) || dirBytes > Math.min(b.length, MSF_DIR_MAX)) return null
    const blockMap = b.readUInt32LE(52) * size
    const dir = Buffer.concat(Array.from({ length: Math.ceil(dirBytes / size) }, (_, i) => {
      const at = b.readUInt32LE(blockMap + i * 4) * size
      return b.subarray(at, at + size)
    }))
    const streams = dir.readUInt32LE(0)
    const bytes = i => (dir.readUInt32LE(4 + i * 4) === 0xffffffff ? 0 : dir.readUInt32LE(4 + i * 4))
    if (streams < 2 || bytes(1) < 28) return null
    const info = dir.readUInt32LE(4 + streams * 4 + Math.ceil(bytes(0) / size) * 4) * size
    if (info + 28 > b.length) return null
    return { age: b.readUInt32LE(info + 8), guid: b.subarray(info + 12, info + 28) }
  } catch { /* truncated or malformed */ }
  return null
}

// The symbol-server key: the GUID as Windows prints it without dashes, then the age in hex
const guidAge = (g, age) => [
  g.readUInt32LE(0).toString(16).padStart(8, '0'), g.readUInt16LE(4).toString(16).padStart(4, '0'),
  g.readUInt16LE(6).toString(16).padStart(4, '0'), g.subarray(8, 16).toString('hex'), age.toString(16),
].join('').toUpperCase()

// Lower-case base name -> image paths under dir, for the wanted names only; symlinks are skipped and the walk is bounded
function findImages(dir, wanted) {
  const found = new Map()
  let entries = 0
  const walk = (at, depth) => {
    for (const e of fs.readdirSync(at, { withFileTypes: true })) {
      if (++entries > WALK_MAX_ENTRIES) throw new Error(`${dir}: more than ${WALK_MAX_ENTRIES} entries`)
      const full = path.join(at, e.name)
      const m = e.isFile() && IMAGE_NAME.exec(e.name)
      if (e.isDirectory() && depth < WALK_MAX_DEPTH) walk(full, depth + 1)
      else if (m && wanted.has(m[1].toLowerCase())) found.set(m[1].toLowerCase(), [...(found.get(m[1].toLowerCase()) || []), full])
    }
  }
  walk(dir, 0)
  return found
}

// The index entry of the image whose CodeView GUID is the PDB's
function matchImage(name, pdb, candidates) {
  for (const file of candidates.sort()) {
    const bytes = readRegular(file, MAX_BYTES.image)
    const pe = peInfo(bytes)
    if (!pe || !pe.guid.equals(pdb.guid)) continue
    return {
      pdb: name, image: path.basename(file).replace(/\.hidden$/i, ''), imageSha256: sha256(bytes), imageBytes: bytes.length,
      peTimestamp: pe.timestamp, pdbGuidAge: guidAge(pe.guid, pe.age),
    }
  }
  throw new Error(`${name}: ${candidates.length ? 'no image in --dll-dir carries its GUID' : 'no .dll or .exe of that name in --dll-dir'}`)
}

const sameFiles = (a, b) => JSON.stringify(a.map(f => [f.pdb, f.imageSha256, f.pdbGuidAge])) === JSON.stringify(b.map(f => [f.pdb, f.imageSha256, f.pdbGuidAge]))

// Returns the index; a second run with the same images is a no-op, with other images it is refused
function archivePdbs({ filesVersion, pdbDir, dllDir, store }) {
  if (!PATTERNS.files.test(filesVersion || '')) throw new Error(`--files-version ${filesVersion} is not a files version`)
  const names = fs.readdirSync(pdbDir, { withFileTypes: true }).filter(e => e.isFile() && /\.pdb$/i.test(e.name)).map(e => e.name).sort()
  if (!names.length) throw new Error(`${pdbDir}: no .pdb file`)
  const images = findImages(dllDir, new Set(names.map(name => name.slice(0, -4).toLowerCase())))
  const root = path.join(store, 'symbols')
  const target = path.join(root, filesVersion)
  const existing = fs.existsSync(target) ? parseJson(readRegular(path.join(target, 'index.json'), MAX_BYTES.index), target) : null
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  const tmp = existing ? null : fs.mkdtempSync(path.join(root, `.tmp-${filesVersion}-`))
  try {
    const files = names.map(name => {
      const bytes = readRegular(path.join(pdbDir, name), MAX_BYTES.pdb)
      const pdb = pdbInfo(bytes)
      if (!pdb) throw new Error(`${name}: not an MSF 7.0 PDB`)
      const entry = matchImage(name, pdb, images.get(name.slice(0, -4).toLowerCase()) || [])
      if (tmp) fs.writeFileSync(path.join(tmp, name), bytes, { mode: 0o600, flag: 'wx' })
      return entry
    })
    if (existing) {
      if (!Array.isArray(existing.files) || !sameFiles(existing.files, files)) throw new Error(`symbols ${filesVersion} are already archived from other images`)
      return { ...existing, already: true }
    }
    const index = { v: 1, filesVersion, archivedAt: Date.now(), files }
    fs.writeFileSync(path.join(tmp, 'index.json'), JSON.stringify(index), { mode: 0o600, flag: 'wx' })
    fs.renameSync(tmp, target)
    return index
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  }
}

// Relative paths of source maps, PDBs and bundles still carrying a map under dir, which must never reach a client package
function findSymbolFiles(dir, base = dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    const rel = path.relative(base, full).split(path.sep).join('/')
    if (e.isDirectory()) findSymbolFiles(full, base, out)
    else if (SYMBOL_FILE.test(e.name)) out.push(rel)
    else if (PACKAGED_BUNDLE.test(rel) && MAP_COMMENT.test(fs.readFileSync(full, 'latin1'))) out.push(rel)
  }
  return out
}

function parseArgs(argv) {
  const [mode, ...rest] = argv
  if (!FLAGS[mode]) throw new Error('usage: archive-symbols.js client|front|pdb --<flag> <value>..., see the head of this file')
  const opts = {}
  for (let i = 0; i < rest.length; i += 2) {
    const flag = /^--([a-z-]+)$/.exec(rest[i])
    const name = flag && flag[1]
    if (!name || !(name === 'store' || FLAGS[mode].includes(name)) || rest[i + 1] === undefined || camel(name) in opts) {
      throw new Error(`unexpected argument ${rest[i]}`)
    }
    opts[camel(name)] = rest[i + 1]
  }
  const missing = FLAGS[mode].filter(name => !(camel(name) in opts))
  if (missing.length) throw new Error(`missing --${missing.join(', --')}`)
  return { mode, opts }
}

// Returns the exit code
function main(argv) {
  try {
    const { mode, opts } = parseArgs(argv)
    const store = path.resolve(opts.store || STORE)
    if (store !== STORE) throw new Error(`--store must be ${STORE}`)
    if (!fs.existsSync(store) || !fs.statSync(store).isDirectory()) throw new Error(`${store} is not a folder`)
    if (mode === 'pdb') {
      const index = archivePdbs({ ...opts, store })
      const list = index.files.map(f => `${f.pdb} (${f.image})`).join(', ')
      console.log(`[archive-symbols] symbols ${index.filesVersion}: ${index.already ? 'already archived from the same images' : `archived ${list}`}`)
    } else {
      const meta = archiveBundle(mode, { ...opts, store })
      const probe = meta.probeLine ? `, probe line ${meta.probeLine}` : ''
      console.log(`[archive-symbols] ${mode} ${meta.build}: map archived${probe}; the map and its sidecar were removed from the build output`)
    }
    return 0
  } catch (err) {
    console.error(`[archive-symbols] ${err.message}`)
    return 1
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2))

module.exports = { main, archiveBundle, archivePdbs, findSymbolFiles, peInfo, pdbInfo, STORE }
