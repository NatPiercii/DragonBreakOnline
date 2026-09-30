'use strict'
// Auto report switch: AUTO_REPORTS and the limits in config.js, the 503 kill switch, and the GET /api/version block

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')

// Never read a real .env
require.cache[require.resolve('dotenv')] = { exports: { config: () => ({}) } }
const AUTO_ENV = Object.keys(process.env).filter(k => k.startsWith('AUTO_REPORT'))
for (const key of AUTO_ENV) delete process.env[key]

const express = require('express')
const config = require('../config')
const autoReport = require('../sources/autoReport')
const versionRoute = require('../routes/version')
const clientVersions = require('../sources/clientVersions')

const CONFIG_PATH = require.resolve('../config')

// config.js snapshots the env at load, so each case loads a private copy
function configWith(env) {
  const saved = require.cache[CONFIG_PATH]
  const keys = Object.keys(env)
  const old = keys.map(k => process.env[k])
  try {
    for (const k of keys) process.env[k] = env[k]
    delete require.cache[CONFIG_PATH]
    return require(CONFIG_PATH)
  } finally {
    keys.forEach((k, i) => (old[i] === undefined ? delete process.env[k] : (process.env[k] = old[i])))
    require.cache[CONFIG_PATH] = saved
  }
}

let server, base

before(async () => {
  const app = express()
  app.post('/report', autoReport.killSwitch, (_req, res) => res.status(202).json({ ok: true }))
  app.use('/api/version', versionRoute)
  server = http.createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})

after(() => server.close())

function request(method, url) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, agent: false }, res => {
      let text = ''
      res.on('data', c => { text += c })
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(text) }))
    })
    req.on('error', reject)
    req.end()
  })
}

test('AUTO_REPORTS: off unless it says collect or on', () => {
  assert.equal(config.autoReports, 'off')
  for (const [value, mode] of [['collect', 'collect'], [' ON ', 'on'], ['Collect', 'collect'], ['yes', 'off'], ['true', 'off'], ['', 'off']]) {
    assert.equal(configWith({ AUTO_REPORTS: value }).autoReports, mode, JSON.stringify(value))
  }
})

test('defaults: data dir, pause, crash watch and limits', () => {
  assert.equal(config.autoReportDir, path.join(__dirname, '..', 'data', 'auto'))
  assert.equal(config.autoReportPauseSec, 3600)
  assert.equal(config.autoReportCrashWatch, false)
  assert.deepEqual(config.autoReportLimits, {
    ipPer10Min: 60, unverifiedPer10Min: 120, profilePer10Min: 20, profilePerDay: 100, profileBytesPerDay: 2 * 1024 * 1024,
    newSignaturesPerHour: 5, newSignaturesPerDay: 15, muteNewSignaturesPerHour: 15, muteInvalidPerHour: 20,
  })
})

test('numbers from the env: positive whole numbers only, anything else keeps the default', () => {
  const custom = configWith({ AUTO_REPORT_DIR: '/tmp/auto-test', AUTO_REPORT_PAUSE_SEC: '120', AUTO_REPORT_PROFILE_PER_DAY: '5',
                              AUTO_REPORT_CRASH_WATCH: 'true' })
  assert.equal(custom.autoReportDir, '/tmp/auto-test')
  assert.equal(custom.autoReportPauseSec, 120)
  assert.equal(custom.autoReportLimits.profilePerDay, 5)
  assert.equal(custom.autoReportCrashWatch, true)
  for (const bad of ['0', '-5', '1.5', 'ten', '1e400', ' ']) {
    assert.equal(configWith({ AUTO_REPORT_PAUSE_SEC: bad }).autoReportPauseSec, 3600, JSON.stringify(bad))
  }
})

test('kill switch: off answers 503 paused with pauseSec and stops the chain', async (t) => {
  t.after(() => { config.autoReports = 'off'; config.autoReportPauseSec = 3600 })
  assert.deepEqual(await request('POST', `${base}/report`), { status: 503, json: { error: 'paused', pauseSec: 3600 } })
  config.autoReportPauseSec = 60
  assert.deepEqual((await request('POST', `${base}/report`)).json, { error: 'paused', pauseSec: 60 })
})

test('kill switch: collect and on pass the request on', async (t) => {
  t.after(() => { config.autoReports = 'off' })
  for (const mode of ['collect', 'on']) {
    config.autoReports = mode
    assert.deepEqual(await request('POST', `${base}/report`), { status: 202, json: { ok: true } }, mode)
  }
})

test('GET /api/version carries the switch for the launcher', async (t) => {
  t.after(() => { config.autoReports = 'off'; config.autoReportCrashWatch = false })
  const res = await request('GET', `${base}/api/version`)
  assert.equal(res.status, 200)
  assert.deepEqual(res.json.autoReport, { mode: 'off', crashWatch: false, contract: [1] })
  assert.ok(res.json.clientVersion)
  config.autoReports = 'collect'
  config.autoReportCrashWatch = true
  assert.deepEqual((await request('GET', `${base}/api/version`)).json.autoReport, { mode: 'collect', crashWatch: true, contract: [1] })
})

test('known client versions: the current release and the 10 newest archived builds, re-read after a minute', async (t) => {
  const saved = config.autoSourceMapDir
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-versions-'))
  t.after(() => { config.autoSourceMapDir = saved; fs.rmSync(tmp, { recursive: true, force: true }) })
  config.autoSourceMapDir = tmp
  const dir = path.join(tmp, 'client')
  fs.mkdirSync(dir)
  const archive = (name, meta) => fs.writeFileSync(path.join(dir, name), typeof meta === 'string' ? meta : JSON.stringify(meta))
  for (let patch = 30; patch <= 41; patch++) archive(`b${patch}.json`, { clientVersion: `0.3.${patch}` })
  archive('twin.json', { clientVersion: '0.3.41' })
  archive('forged.json', { clientVersion: '0.3.99-beta' })
  archive('broken.json', '{')
  archive('b50.map', '{}')
  const current = versionRoute.readConst('CLIENT_VERSION', null)
  const expected = new Set([current, ...Array.from({ length: 10 }, (_, i) => `0.3.${41 - i}`)])
  const now = Date.now()
  assert.deepEqual(await clientVersions.known(now), expected)
  assert.equal(await clientVersions.isKnown('0.3.31'), false)
  assert.equal(await clientVersions.isKnown(current), true)
  archive('b42.json', { clientVersion: '0.3.42' })
  assert.equal((await clientVersions.known(now + 1000)).has('0.3.42'), false)
  assert.equal((await clientVersions.known(now + 60 * 1000)).has('0.3.42'), true)
})
