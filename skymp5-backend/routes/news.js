const router = require('express').Router()
const fs     = require('fs')
const path   = require('path')

// Patch notes published by dev-server.sh deploy-news (untracked) win over the tracked default
const LIVE_FILE    = path.join(__dirname, '..', 'data', 'news.live.json')
const DEFAULT_FILE = path.join(__dirname, '..', 'data', 'news.json')
const MAX_ITEMS    = 20

let cache = { file: '', mtimeMs: 0, items: [] }

function loadNews() {
  for (const file of [LIVE_FILE, DEFAULT_FILE]) {
    let stat
    try { stat = fs.statSync(file) } catch { continue }
    if (cache.file === file && cache.mtimeMs === stat.mtimeMs) return cache.items
    try {
      const items = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (!Array.isArray(items)) throw new Error('not an array')
      cache = { file, mtimeMs: stat.mtimeMs, items }
      return items
    } catch (err) {
      console.error(`[news] ${path.basename(file)} unreadable: ${err.message}`)
    }
  }
  return cache.items
}

router.get('/', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`
  const items = loadNews().slice(0, MAX_ITEMS).map(item => ({
    ...item,
    image: item.image
      ? /^https?:\/\//i.test(item.image) ? item.image : `${base}${item.image}`
      : null,
  }))
  res.json(items)
})

module.exports = router
