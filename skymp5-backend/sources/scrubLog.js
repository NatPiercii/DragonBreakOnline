'use strict'
// Strips from a launcher or client log anything that must not reach a Discord channel: the player's
// Windows account name, their live play-session token, Nexus one-time download keys, bearer headers and IP addresses.
// Applied on the server so a launcher that forgets to redact cannot leak; the launcher redacts too.

const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)'
// Words that put a dotted number in a version, as in "SkyrimSE.exe = 1.5.97.0" or "version 2.2.6.0"
const VERSION_CUE = /(?:\bv|\bver|version|runtime|build|\.exe|\.dll)\W{0,3}$/i
// Skyrim runtimes (1.5.97.0, 1.6.640.0) are shaped like an address and logged without a cue in the report context
const SKYRIM_RUNTIME = /^1\.[4-6]\.\d+\.0$/

// Loopback and 0.0.0.0 say nothing about the player; a LAN address is marked as one so staff can tell the route apart
function ipv4(found, offset, text) {
  const [a, b] = found.split('.').map(Number)
  if (a === 0 || a === 127 || SKYRIM_RUNTIME.test(found) || VERSION_CUE.test(text.slice(Math.max(0, offset - 16), offset))) return found
  const lan = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
  return lan ? '<lan-ip>' : '<ip>'
}

// Global (2000::/3), unique local (fc00::/7) and link-local (fe80::/10, can hold the MAC) IPv6, full or '::' form only
function ipv6(found) {
  const groups = found.split(':')
  const short = found.includes('::')
  const tag = /^f/i.test(found) ? '<lan-ip>' : '<ip>'
  const port = groups[groups.length - 1]
  // A ninth group, or an eighth written beside '::', can only be a port, as in Node's "ECONNREFUSED <addr>:443"
  if (/^\d{1,5}$/.test(port) && (short ? groups.filter(Boolean).length >= 8 : groups.length === 9)) return `${tag}:${port}`
  return short || groups.length === 8 ? tag : found
}

// S3-S10 of the auto report rule file: account names in paths, download keys, credentials, bot tokens, long hex runs
const LOG_RULES = ['S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10']
const RULES = [
  ...require('./scrub-rules.json')
    .filter(rule => LOG_RULES.includes(rule.id))
    .map(rule => [new RegExp(rule.pattern, rule.flags), rule.replacement]),
  // IP addresses by this file's own rules, not S16-S18: loopback and versions stay, LAN addresses are marked
  [new RegExp(`(?<![\\w.])${OCTET}(?:\\.${OCTET}){3}(?!\\w|\\.\\d)`, 'g'), ipv4],
  [/(?<![\w:.])(?:[23][0-9a-f]{3}|f[cd][0-9a-f]{2}|fe[89ab][0-9a-f])(?::[0-9a-f]{0,4}){2,8}(?![\w:])/gi, ipv6],
]

// SkyrimPlatform logs the first 120 characters of every script it runs in the game's UI and every page it loads
// (`[12:34:56:789] JS ...`, `LoadUrl ...`): chat and private messages, character names, the voice room link.
// Launchers up to 2.1.29 upload them, so the server leaves them out as well: of every log, since a pre-release launcher
// (8a9c6c94) sent the platform log as clientLog
const RECORD = /^\[\d\d:\d\d:\d\d:\d{3}\] /
const UI_LINE = /^\[\d\d:\d\d:\d\d:\d{3}\] (?:JS|LoadUrl) /

function dropUiLines(input) {
  // The same step for auto reports is dropUiLines in autoScrub.js (rule S0); a fix to one likely belongs in the other
  const kept = []
  let dropped = 0
  let inUi = false
  for (const line of String(input == null ? '' : input).split('\n')) {
    if (UI_LINE.test(line)) { dropped++; inUi = true; continue }
    // LoadUrl logs the whole URL, newlines included: every line up to the next record belongs to it
    if (inUi && !RECORD.test(line)) { if (line.trim()) dropped++; continue }
    inUi = false
    if (dropped) { kept.push(`[${dropped} UI line(s) left out]`); dropped = 0 }
    kept.push(line)
  }
  if (dropped) kept.push(`[${dropped} UI line(s) left out]`)
  return kept.join('\n')
}

const MAX_BYTES = 180 * 1024   // per file, after scrubbing: Discord renders these as attachments

// Returns the text with secrets removed, how many replacements were made, and whether it was cut short.
function scrub(input, maxBytes = MAX_BYTES) {
  let text = String(input == null ? '' : input).replace(/\r\n/g, '\n')
  let redactions = 0
  for (const [pattern, replacement] of RULES) {
    // A function rule may keep what it finds, so only real changes count
    if (typeof replacement === 'function') {
      text = text.replace(pattern, (...m) => { const out = replacement(...m); if (out !== m[0]) redactions++; return out })
      continue
    }
    const found = text.match(pattern)
    if (found) redactions += found.length
    text = text.replace(pattern, replacement)
  }
  let truncated = false
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    // Keep the END of a log: the failure is at the bottom, the startup banner is not interesting
    const buf = Buffer.from(text, 'utf8').subarray(-maxBytes)
    text = '[earlier lines cut to fit the upload limit]\n' + buf.toString('utf8').replace(/^[^\n]*\n/, '')
    truncated = true
  }
  return { text, redactions, truncated }
}

module.exports = { scrub, dropUiLines, MAX_BYTES }
