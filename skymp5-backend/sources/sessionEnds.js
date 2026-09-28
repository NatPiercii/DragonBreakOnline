'use strict'
// How a player's game closed, as their launcher saw it (Jake, 2026-09-26: "we need the client data to report to the
// server to determine if its actual crashing or players quitting"). The server alone cannot tell: a crash, a freeze,
// Alt-F4 and a lost connection all look like a player who went silent, which is all dbo-monitor's "Likely crash" can say.
//
// The launcher sends one small note when SkyrimSE.exe ends (skymp5-launcher/src/crashWatch.js): the outcome, the exit
// code, whether a Crash Logger log appeared, and when the game started and ended. Nothing else leaves the player's PC:
// no logs, no file names, no paths. This is the slim part of Auto Report's crash watcher (docs/auto-report-v1, P5).
//
// Every note is kept in data/session-ends.jsonl (0600, newest 5000). Crashes and abnormal ends are also posted as one
// line in #server-monitor, beside the monitor's own alerts; a normal close is only kept, so a full server does not
// flood the channel.

const fs    = require('fs')
const path  = require('path')
const https = require('https')
const config = require('../config')
const { cleanName, escapeMarkdown } = require('./problemReport')

// SESSION_ENDS_FILE lets a test write somewhere else
const FILE = process.env.SESSION_ENDS_FILE || path.join(__dirname, '..', 'data', 'session-ends.jsonl')
const KEEP = 5000
// #server-monitor, the channel dbo-monitor posts to (its DBO_MONITOR_CHANNEL default)
const MONITOR_CHANNEL = process.env.DISCORD_MONITOR_CHANNEL_ID || '1553093452529532929'
const OUTCOMES = new Set(['crash', 'closed', 'ended'])
const HOUR = 3600 * 1000
// At most this many posts in #server-monitor per window, whoever sends them; past it a note is only kept, so a few
// accounts at their own limit cannot bury the monitor's alerts (post-hoc review A8-4)
const POST_BUDGET = 20
const POST_WINDOW = 10 * 60 * 1000
const recentPosts = []

// A note the launcher sent, checked field by field; anything else is dropped. Returns { note } or { error }.
function parse(body, now = Date.now()) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'expected a JSON object' }
  const { outcome, exitCode, crashLog, startedAt, endedAt, launcherVersion, filesVersion } = body
  if (!OUTCOMES.has(outcome)) return { error: 'outcome must be crash, closed or ended' }
  // An exit code is an unsigned 32-bit number, or null when Windows gave none
  if (exitCode !== null && !(Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 0xFFFFFFFF)) return { error: 'bad exitCode' }
  if (typeof crashLog !== 'boolean') return { error: 'bad crashLog' }
  const time = (v) => Number.isInteger(v) && v > now - 7 * 24 * HOUR && v <= now + 5 * 60 * 1000
  if (!time(startedAt) || !time(endedAt) || endedAt < startedAt) return { error: 'bad startedAt or endedAt' }
  const version = (v) => v === undefined || v === '' || (typeof v === 'string' && /^\d+(\.\d+){1,3}$/.test(v))
  if (!version(launcherVersion) || !version(filesVersion)) return { error: 'bad version' }
  return { note: { outcome, exitCode, crashLog, startedAt, endedAt, launcherVersion: launcherVersion || '', filesVersion: filesVersion || '' } }
}

const hex = (code) => (code === null ? 'none' : '0x' + code.toString(16).toUpperCase().padStart(8, '0'))
const clock = (ms) => new Date(ms).toISOString().slice(11, 16) + ' UTC'
const played = (ms) => {
  const m = Math.round(ms / 60000)
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`
}

// The line staff read. The Discord mention shows the player's Discord name; the post pings nobody. The name is the
// player's own Discord display name, so markdown and masked links in it are escaped (post-hoc review A8-2).
function describe(note, reporter) {
  const name = escapeMarkdown(cleanName(reporter.name))
  const who = reporter.discordId ? `<@${reporter.discordId}> (${name})` : name
  const after = `after ${played(note.endedAt - note.startedAt)} in game`
  if (note.outcome === 'crash') {
    const how = note.crashLog ? 'Crash Logger wrote a log' : 'no crash log'
    return `**Game crashed** (launcher): ${who} at ${clock(note.endedAt)}, ${after}. Exit code ${hex(note.exitCode)}, ${how}.`
  }
  if (note.outcome === 'ended') {
    return `**Game ended abnormally** (launcher): ${who} at ${clock(note.endedAt)}, ${after}. Exit code ${hex(note.exitCode)}, no crash log: killed, froze and closed, or closed by Windows.`
  }
  return `Game closed normally (launcher): ${who} at ${clock(note.endedAt)}, ${after}.`
}

function keep(note, reporter) {
  const line = JSON.stringify({ at: Date.now(), profileId: reporter.profileId, discordId: reporter.discordId, name: reporter.name, ...note })
  let lines = []
  try { lines = fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean) } catch { /* first note */ }
  lines.push(line)
  const tmp = FILE + '.tmp'
  fs.writeFileSync(tmp, lines.slice(-KEEP).join('\n') + '\n', { mode: 0o600 })
  fs.renameSync(tmp, FILE)
}

function postLine(content) {
  if (!config.discordBotToken || !MONITOR_CHANNEL) return Promise.resolve(false)
  const body = JSON.stringify({ content, allowed_mentions: { parse: [] } })
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'discord.com', path: `/api/v10/channels/${MONITOR_CHANNEL}/messages`, method: 'POST', family: 4,
      headers: { Authorization: `Bot ${config.discordBotToken}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => { res.resume(); resolve(res.statusCode >= 200 && res.statusCode < 300) })
    req.setTimeout(10_000, () => req.destroy(new Error('timeout')))
    req.on('error', () => resolve(false))
    req.end(body)
  })
}

// Keeps the note, and posts it unless it was a normal close. Resolves to { status, body } for the route.
async function submit(reporter, body, post = postLine, now = Date.now()) {
  const { note, error } = parse(body, now)
  if (error) return { status: 400, body: { error } }
  try { keep(note, reporter) } catch (e) { return { status: 500, body: { error: 'could not store the note' } } }
  if (note.outcome !== 'closed' && underBudget(now)) await post(describe(note, reporter))
  return { status: 200, body: { ok: true } }
}

function underBudget(now) {
  while (recentPosts.length && recentPosts[0] <= now - POST_WINDOW) recentPosts.shift()
  if (recentPosts.length >= POST_BUDGET) return false
  recentPosts.push(now)
  return true
}

module.exports = { parse, describe, submit, FILE, POST_BUDGET, POST_WINDOW }
