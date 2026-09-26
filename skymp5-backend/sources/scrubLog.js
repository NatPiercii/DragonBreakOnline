'use strict'
// Strips from a launcher or client log anything that must not reach a Discord channel: the player's
// Windows account name, their live play-session token, Nexus one-time download keys, and bearer headers.
// Applied on the server so a launcher that forgets to redact cannot leak; the launcher redacts too.

// S3-S10 of the auto report rule file: account names in paths, download keys, credentials, bot tokens, long hex runs
const LOG_RULES = ['S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10']
const RULES = require('./scrub-rules.json')
  .filter(rule => LOG_RULES.includes(rule.id))
  .map(rule => [new RegExp(rule.pattern, rule.flags), rule.replacement])

const MAX_BYTES = 180 * 1024   // per file, after scrubbing: Discord renders these as attachments

// Returns the text with secrets removed, how many replacements were made, and whether it was cut short.
function scrub(input, maxBytes = MAX_BYTES) {
  let text = String(input == null ? '' : input).replace(/\r\n/g, '\n')
  let redactions = 0
  for (const [pattern, replacement] of RULES) {
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

module.exports = { scrub, MAX_BYTES }
