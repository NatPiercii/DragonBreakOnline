'use strict'
// Strips from a launcher or client log anything that must not reach a Discord channel: the player's
// Windows account name, their live play-session token, Nexus one-time download keys, and bearer headers.
// Applied on the server so a launcher that forgets to redact cannot leak; the launcher redacts too.

const RULES = [
  // Windows and unix account names inside paths
  [/([A-Za-z]:[\\/]Users[\\/])[^\\/\r\n"'<>|]+/gi, '$1<user>'],
  [/(\/(?:home|Users)\/)[^/\r\n"'<>|]+/g, '$1<user>'],
  // Nexus one-time download links: the key is live for minutes and grants downloads as that account
  [/((?:key|nmm_key)=)[A-Za-z0-9._~-]{6,}/gi, '$1<redacted>'],
  [/((?:expires|user_id)=)\d+/gi, '$1<redacted>'],
  // Authorization headers and anything labelled like a credential
  [/(Bearer\s+)[A-Za-z0-9._-]{10,}/gi, '$1<redacted>'],
  [/((?:session|sessionToken|token|secret|password|passwd|api[_-]?key|apikey|auth)["'\s:=]{1,4})[A-Za-z0-9._-]{10,}/gi, '$1<redacted>'],
  // A Discord bot token has a recognisable three-part shape; never let one through whatever it is labelled
  [/\b[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{25,}\b/g, '<token-redacted>'],
  // Long hex runs are hwids, session tokens and file hashes. Keep a short prefix so hashes stay comparable.
  [/\b([0-9a-f]{8})[0-9a-f]{24,120}\b/gi, '$1<redacted>'],
]

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
