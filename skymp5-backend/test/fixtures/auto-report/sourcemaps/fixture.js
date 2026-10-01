'use strict'
// Writes a client and a front source map with known positions, and their meta files, in the §5.4 layout

const fs = require('fs')
const path = require('path')

const CLIENT_BUILD = 'f8cd78971a2b.20260927T101500Z'
const FRONT_BUILD = 'f8cd78971a2b.20260927T101530Z'
const PROBE_LINE = 212

// Bundle line -> [source, original line]; the payload fixtures' frames and sites land on these lines
const CLIENT_LINES = {
  1: ['webpack/bootstrap', 1],
  [PROBE_LINE]: ['./src/errorSink.ts', 40],
  29990: ['./src/services/animDebugService.ts', 22],
  30011: ['./src/services/animDebugService.ts', 31],
  39120: ['./src/services/authService.ts', 355],
  39410: ['./src/services/authService.ts', 449],
  47102: ['./src/services/remoteServer.ts', 113],
  47110: ['./src/services/remoteServer.ts', 120],
  48213: ['./src/services/remoteServer.ts', 640],
  51220: ['./src/services/tickService.ts', 18],
  60001: ['./src/view/formView.ts', 129],
  60010: ['./src/errorSink.ts', 90],
}
// The front bundle is one minified line: column on line 2 -> [source, original line]
const FRONT_COLUMNS = {
  99100: ['./src/features/hud/hud.tsx', 12],
  183200: ['./src/features/party/PartyPanel.tsx', 48],
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
function vlq(value) {
  let v = value < 0 ? (-value << 1) | 1 : value << 1
  let out = ''
  do {
    let digit = v & 31
    v >>>= 5
    if (v) digit |= 32
    out += B64[digit]
  } while (v)
  return out
}

// points: [generated line, generated column, source, original line], all 1-based
function sourceMap(namespace, points) {
  const sources = [...new Set(points.map(p => p[2]))]
  const lines = []
  let prev = { source: 0, line: 0 }
  for (const [line, col, source, origLine] of points.sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    const index = sources.indexOf(source)
    const segs = lines[line - 1] || (lines[line - 1] = { col: 0, text: [] })
    segs.text.push(vlq(col - 1 - segs.col) + vlq(index - prev.source) + vlq(origLine - 1 - prev.line) + vlq(0))
    segs.col = col - 1
    prev = { source: index, line: origLine - 1 }
  }
  const mappings = Array.from({ length: lines.length }, (_, i) => (lines[i] ? lines[i].text.join(',') : '')).join(';')
  return { version: 3, file: 'bundle.js', sources: sources.map(s => `webpack://${namespace}/${s}`), names: [], mappings }
}

function write(dir, kind, build, map, meta) {
  fs.mkdirSync(path.join(dir, kind), { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(dir, kind, `${build}.map`), JSON.stringify(map), { mode: 0o600 })
  fs.writeFileSync(path.join(dir, kind, `${build}.json`), JSON.stringify(meta), { mode: 0o600 })
}

// dir is the sourcemaps folder; clientVersion lets a test archive a build whose version differs from the report
function writeFixtureMaps(dir, { clientVersion = '0.3.44' } = {}) {
  const base = { v: 1, gitSha: 'f8cd78971a2b', dirty: false, builtAt: Date.UTC(2026, 8, 27, 10, 15), bundleBytes: 0, bundleSha256: '' }
  const client = sourceMap('skymp5-client', Object.entries(CLIENT_LINES).map(([line, [src, orig]]) => [Number(line), 1, src, orig]))
  write(dir, 'client', CLIENT_BUILD, client, { ...base, kind: 'client', build: CLIENT_BUILD, clientVersion, probeLine: PROBE_LINE })
  const front = sourceMap('skymp5-front', Object.entries(FRONT_COLUMNS).map(([col, [src, orig]]) => [2, Number(col), src, orig]))
  write(dir, 'front', FRONT_BUILD, front, { ...base, kind: 'front', build: FRONT_BUILD })
  return { client: CLIENT_BUILD, front: FRONT_BUILD }
}

module.exports = { writeFixtureMaps, sourceMap, CLIENT_BUILD, FRONT_BUILD, PROBE_LINE }
