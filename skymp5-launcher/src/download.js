'use strict'
// One resilient download for every big file (Jake, 7 Oct: the 0.3.81 outage, where ~40 launchers pulled the 184 MB zip
// at once and every cut download started again from 0). It follows redirects (the backend sends files to R2), resumes a
// partial file with Range, waits in line when the server answers 503 with Retry-After, and retries a cut connection.
// The partial download lives beside the target as <dest>.part and is renamed into place only when complete.

const fs = require('fs')
const http = require('http')
const https = require('https')

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

class HttpError extends Error {
  constructor(status) { super(`HTTP ${status}`); this.statusCode = status }
}

// One request: resolves { done } on a complete body, { queued: seconds } on 503, { redirect: url } on 3xx
function attempt(url, part, { headers, onProgress, validate, timeoutMs }) {
  return new Promise((resolve, reject) => {
    try { validate(url) } catch (err) { return reject(err) }
    let have = 0
    try { have = fs.statSync(part).size } catch { /* nothing yet */ }
    const h = Object.assign({}, headers)
    if (have > 0) h.Range = `bytes=${have}-`
    const mod = url.startsWith('https') ? https : http
    let out = null
    let settled = false
    const done = (fn, v) => { if (settled) return; settled = true; if (out && !out.destroyed) out.end(() => fn(v)); else fn(v) }
    const req = mod.get(url, { headers: h }, res => {
      const s = res.statusCode
      if (s >= 300 && s < 400 && res.headers.location) { res.resume(); return done(resolve, { redirect: new URL(res.headers.location, url).toString() }) }
      if (s === 503) { res.resume(); const ra = parseInt(res.headers['retry-after'] || '30', 10); return done(resolve, { queued: Number.isFinite(ra) ? ra : 30 }) }
      // The server ignored the range or the part is stale: start over
      if (s === 416) { res.resume(); try { fs.unlinkSync(part) } catch {} return done(resolve, { restart: true }) }
      if (s !== 200 && s !== 206) { res.resume(); return done(reject, new HttpError(s)) }
      const append = s === 206 && have > 0
      if (!append) have = 0
      const len = parseInt(res.headers['content-length'] || '0', 10)
      const total = len > 0 ? len + have : 0
      let received = have
      out = fs.createWriteStream(part, { flags: append ? 'a' : 'w' })
      res.on('data', c => { received += c.length; if (onProgress) onProgress(received, total) })
      res.pipe(out)
      out.on('error', err => done(reject, err))
      res.on('error', err => done(reject, err))
      res.on('aborted', () => done(reject, new Error('Download interrupted')))
      res.on('end', () => { if (!res.aborted) done(resolve, { done: true, total, received }) })
    })
    req.on('error', err => done(reject, err))
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('Download timed out')) })
  })
}

/**
 * Downloads url into dest. Options: headers, onProgress(received, total), onQueued(seconds, waitedSeconds),
 * validate(url) (throws to refuse a url), retries (cut connections), maxQueueSeconds, timeoutMs, signal (AbortSignal),
 * wait (for tests). Resolves dest.
 */
async function download(url, dest, opts = {}) {
  const o = Object.assign({ headers: {}, validate: () => {}, retries: 6, maxQueueSeconds: 30 * 60, timeoutMs: 60_000, wait: sleep }, opts)
  const part = `${dest}.part`
  let current = url
  let redirects = 0
  let cuts = 0
  let queued = 0
  for (;;) {
    if (o.signal && o.signal.aborted) throw new Error('Cancelled')
    let r
    try {
      r = await attempt(current, part, o)
    } catch (err) {
      if (err instanceof HttpError) { try { fs.unlinkSync(part) } catch {} throw err }
      if (++cuts > o.retries) throw err
      await o.wait(Math.min(15_000, 1000 * 2 ** (cuts - 1)))
      continue
    }
    if (r.redirect) { if (++redirects > 5) throw new Error('Too many redirects'); current = r.redirect; continue }
    if (r.restart) continue
    if (r.queued !== undefined) {
      const s = Math.max(1, Math.min(60, r.queued))
      queued += s
      if (queued > o.maxQueueSeconds) throw new Error('The download server stayed busy; try again in a few minutes')
      if (o.onQueued) o.onQueued(s, queued)
      await o.wait(s * 1000)
      // A redirect target may be what was busy; ask the original url again
      current = url
      redirects = 0
      continue
    }
    if (r.total && r.received !== r.total) { if (++cuts > o.retries) throw new Error('Download interrupted'); continue }
    try { fs.rmSync(dest, { force: true }) } catch {}
    fs.renameSync(part, dest)
    return dest
  }
}

module.exports = { download, HttpError }
