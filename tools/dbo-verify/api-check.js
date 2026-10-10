'use strict'
// MODULE 2 - api-check: can a player download and launch today?
//
// Fully automated, needs no game, no launcher and no Windows. Runs from anywhere with internet,
// so it also works from CI or the server. Every assertion here maps to something that has actually
// broken: a dead API host shipped in 2.1.15, and an unredirected 184 MB zip served off a home
// upload locked players out on 7 Oct.
//
// Usage: node tools/dbo-verify/api-check.js [--json]
const fs = require('fs')
const path = require('path')
const https = require('https')
const { Report } = require('./lib/report')

const BASE = process.env.DBO_API || 'https://dragonbreakonline.com'
const R2_HOST = 'files.dragonbreakonline.com'
// The launcher sends this to opt in to a redirect; without it the backend streams the zip itself.
const REDIRECT_HEADER = { 'X-DBO-Accept-Redirect': '1' }

function req(url, { method = 'GET', headers = {}, range = null, timeout = 20000 } = {}) {
  return new Promise(resolve => {
    const u = new URL(url)
    const h = { ...headers }
    if (range) h.Range = range
    const r = https.request({
      method, hostname: u.hostname, path: u.pathname + u.search, headers: h, timeout,
    }, res => {
      // Read the whole body for GETs: /api/files/version is ~40 KB and truncating it made
      // JSON.parse fail, which the harness then misreported as the endpoint being broken.
      // Cap only as a runaway guard, well above any JSON response here.
      const chunks = []
      let size = 0
      res.on('data', d => { if (size < 4e6) { chunks.push(d); size += d.length } })
      res.on('end', () => resolve({
        status: res.statusCode, headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, headers: {}, body: 'timeout' }) })
    r.on('error', e => resolve({ status: 0, headers: {}, body: e.message }))
    r.end()
  })
}

const json = body => { try { return JSON.parse(body) } catch { return null } }

async function main() {
  const r = new Report('api-check - can a player download and launch?')

  // 1. The launcher's own update feed. A bad downloadUrl here strands every player.
  const ver = await req(`${BASE}/api/version`)
  const v = json(ver.body)
  if (ver.status !== 200 || !v) {
    r.fail('/api/version', `HTTP ${ver.status}`, ver.body.slice(0, 200))
  } else {
    r.pass('/api/version', `launcher ${v.version}, client ${v.clientVersion}, server ${v.serverVersion}`)
    if (!v.downloadUrl || !v.downloadUrl.startsWith('https://')) {
      r.fail('downloadUrl is https', String(v.downloadUrl), 'the launcher refuses a non-https self-update')
    } else {
      r.pass('downloadUrl is https', v.downloadUrl)
      // The installer must actually exist, or every update attempt 404s.
      const head = await req(v.downloadUrl, { method: 'HEAD' })
      const len = Number(head.headers['content-length'] || 0)
      if (head.status === 200 && len > 50e6) r.pass('installer reachable', `${(len / 1e6).toFixed(1)} MB`)
      else r.fail('installer reachable', `HTTP ${head.status}, content-length ${len}`, v.downloadUrl)
    }
  }

  // 2. The client package version feed.
  const fv = await req(`${BASE}/api/files/version`)
  const f = json(fv.body)
  if (fv.status !== 200 || !f) r.fail('/api/files/version', `HTTP ${fv.status}`)
  else {
    r.pass('/api/files/version', `client ${f.version}, zip ${(Number(f.zipSize) / 1e6).toFixed(1)} MB, ${(f.files || []).length} file entries`)
    // The two feeds must agree, or the launcher downloads a package it then thinks is stale.
    if (v && v.clientVersion && f.version && v.clientVersion !== f.version) {
      r.fail('client version agreement', `/api/version says ${v.clientVersion}, /api/files/version says ${f.version}`)
    } else if (v && f) {
      r.pass('client version agreement', String(f.version))
    }
  }

  // 3. The R2 redirect - the fix for the 7 Oct outage. Checked WITH the header.
  const zipRedirect = await req(`${BASE}/api/files/zip`, { method: 'HEAD', headers: REDIRECT_HEADER })
  const loc = zipRedirect.headers.location || ''
  if (zipRedirect.status === 302 && loc.startsWith('https://') && loc.includes(R2_HOST)) {
    r.pass('zip redirects to R2', loc)
  } else {
    r.fail('zip redirects to R2', `HTTP ${zipRedirect.status}, location "${loc}"`,
      'without this every launcher streams 184 MB off the home upload')
  }

  // 4. And WITHOUT the header, which is what every pre-2.1.44 launcher still does. This is not a
  // failure, it is the known fallback - but it must be reported, because the outage risk only
  // decays as players update.
  const zipDirect = await req(`${BASE}/api/files/zip`, { method: 'HEAD' })
  if (zipDirect.status === 200) {
    const mb = (Number(zipDirect.headers['content-length'] || 0) / 1e6).toFixed(1)
    r.pass('legacy path still served', `HTTP 200, ${mb} MB direct from the backend`,
      'expected: old launchers depend on this. It is the remaining outage exposure.')
  } else if (zipDirect.status === 302) {
    r.pass('legacy path redirects too', 'backend now redirects unconditionally')
  } else {
    r.fail('legacy path still served', `HTTP ${zipDirect.status}`, 'pre-2.1.44 launchers cannot fetch the client')
  }

  // 5. R2 must honour Range, or a cut download restarts from zero instead of resuming.
  if (loc.includes(R2_HOST)) {
    const rng = await req(loc, { range: 'bytes=0-1023' })
    const cr = rng.headers['content-range'] || ''
    if (rng.status === 206 && cr.includes('/')) {
      const total = Number(cr.split('/')[1])
      const agrees = !f || !f.zipSize || total === Number(f.zipSize)
      r.add(agrees ? 'PASS' : 'FAIL', 'R2 supports resume', `HTTP 206, ${cr}`,
        agrees ? null : `R2 total ${total} disagrees with /api/files/version zipSize ${f.zipSize}`)
    } else {
      r.fail('R2 supports resume', `HTTP ${rng.status}, content-range "${cr}"`)
    }
  } else {
    r.skip('R2 supports resume', 'no R2 redirect to follow')
  }

  // 6. Server reachability as a player sees it.
  const st = await req(`${BASE}/api/status`)
  const s = json(st.body)
  if (s && s.status === 'online' && s.service === 'active' && s.port_bound) r.pass('/api/status', 'online, service active, port bound')
  else r.fail('/api/status', `HTTP ${st.status}`, st.body.slice(0, 200))

  const sv = await req(`${BASE}/api/servers`)
  const list = json(sv.body)
  if (Array.isArray(list) && list.length) {
    const g = list[0]
    const age = g.lastSeen ? (Date.now() - Date.parse(g.lastSeen)) / 1000 : null
    // A stale heartbeat means the listing is lying about a server that may be down.
    if (age !== null && age > 120) r.fail('server heartbeat fresh', `last seen ${Math.round(age)}s ago`, 'the listing may be showing a dead server')
    else r.pass('server heartbeat fresh', `${g.name}: ${g.online}/${g.maxPlayers} players, last seen ${age === null ? '?' : Math.round(age)}s ago`)
  } else {
    r.fail('/api/servers', `HTTP ${sv.status}`, sv.body.slice(0, 200))
  }

  r.print()
  if (process.argv.includes('--json')) {
    const out = path.join(__dirname, 'out', 'api-check.json')
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, r.json())
    console.log(`\njson: ${out}`)
  }
  process.exit(r.exitCode)
}

main()
