'use strict'

// Records the sha256 of terms.md and privacy.md for the version in data/legal/legal.json (data/legal/hashes.json)
// A version is recorded once: changed text needs a new version and new "changes" lines, so every player is asked again
//   npm run legal-record

const fs = require('fs')
const path = require('path')

const legal = require('../sources/legal')

function record(dir = legal.LEGAL_DIR) {
  const { version, hashes } = legal.documentHashes(dir)
  const recorded = legal.recordedHashes(dir)
  const had = recorded[version]
  if (had && JSON.stringify(had) === JSON.stringify(hashes)) return { ok: true, message: `version ${version} is already recorded with these texts` }
  if (had) {
    const changed = Object.keys(hashes).filter(f => had[f] !== hashes[f])
    return { ok: false, message: `version ${version} was recorded with other text (${changed.join(', ')} changed). Give legal.json a new version and "changes" lines, then run this again.` }
  }
  recorded[version] = hashes
  fs.writeFileSync(path.join(dir, legal.HASHES_FILE), JSON.stringify(recorded, null, 2) + '\n')
  return { ok: true, message: `recorded version ${version}: ${Object.entries(hashes).map(([f, h]) => `${f} ${h.slice(0, 12)}`).join(', ')}` }
}

if (require.main === module) {
  const result = record(process.argv[2] ? path.resolve(process.argv[2]) : undefined)
  console.log(result.message)
  process.exit(result.ok ? 0 : 1)
}

module.exports = { record }
