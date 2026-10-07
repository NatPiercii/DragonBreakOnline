'use strict'
// A tiny client package for the per-file tests: its files, the files-version.json that lists them, a zip of them
// (written by Python's zipfile, so a test can also build a zip with a '..' name or a symlink), and a verified copy

const { execFileSync } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { listSha256 } = require('../../sources/clientFiles')

const sha256 = b => crypto.createHash('sha256').update(b).digest('hex')

// 1000 bytes that differ along the file, so a Range answer shows which bytes it holds
const RANGE_BODY = Buffer.from(Array.from({ length: 1000 }, (_, i) => String.fromCharCode(48 + (i % 43))).join(''))

const FILES = {
  'Data/DragonBreak.esp': Buffer.from('main plugin bytes'),
  'Data/a b [x].esp': Buffer.from('a plugin with a space and brackets'),
  'Data/Platform/Plugins/skymp5-client.js': RANGE_BODY,
  'd3dx9_42.dll': Buffer.from('preloader'),
}

// files-version.json for these files (or others), with the zip size when a zip is given
function versionJson(version, files = FILES, zipFile = null) {
  return {
    version,
    builtAt: '2026-10-07T00:00:00.000Z',
    fileCount: 0,
    zipSize: zipFile ? fs.statSync(zipFile).size : 1234,
    files: Object.entries(files).map(([p, b]) => ({ path: p, size: b.length, sha256: sha256(b) })),
  }
}

// entries: [{ name, data }] or [{ name, symlinkTo }]; written in this order
function makeZip(file, entries) {
  const py = `
import json, sys, zipfile
entries = json.load(sys.stdin)
with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as z:
    for e in entries:
        if 'symlinkTo' in e:
            i = zipfile.ZipInfo(e['name'])
            i.create_system = 3
            i.external_attr = (0o120777 << 16)
            z.writestr(i, e['symlinkTo'])
        else:
            z.writestr(e['name'], bytes.fromhex(e['hex']))
`
  const input = JSON.stringify(entries.map(e => (e.symlinkTo ? e : { name: e.name, hex: Buffer.from(e.data).toString('hex') })))
  fs.mkdirSync(path.dirname(file), { recursive: true })
  execFileSync('python3', ['-c', py, file], { input })
  return file
}

const zipOf = (file, files = FILES) => makeZip(file, Object.entries(files).map(([name, data]) => ({ name, data })))

// A verified unpacked copy as unpack-client.js leaves it, written directly
function writeVerifiedCopy(clientFilesDir, v, files = FILES, marker = {}) {
  const dir = path.join(clientFilesDir, 'unpacked', v.version)
  for (const [p, b] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true })
    fs.writeFileSync(path.join(dir, p), b)
  }
  const list = v.files
  fs.writeFileSync(path.join(dir, '.verified'), JSON.stringify({
    version: v.version, zipSha256: '0'.repeat(64), zipSize: v.zipSize, fileCount: list.length, listSha256: listSha256(list),
    verifiedAt: new Date().toISOString(), ...marker,
  }))
  return dir
}

module.exports = { FILES, RANGE_BODY, sha256, versionJson, makeZip, zipOf, writeVerifiedCopy }
