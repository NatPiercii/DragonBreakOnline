'use strict'
// Discord OAuth2 helpers shared by the launcher, dashboard and website sign-in flows

const https  = require('https')
const config = require('../../config')

// Per-request deadline, generous because DNS on CT 115 has taken ~5 s
const TIMEOUT_MS = 20 * 1000

function authorizeUrl({ redirectUri, state }) {
  const params = new URLSearchParams({
    client_id:     config.discordClientId,
    redirect_uri:  redirectUri,
    response_type: 'code',
    scope:         'identify',
    state,
  })
  return `https://discord.com/api/oauth2/authorize?${params}`
}

// Resolves with the JSON body; rejects on network errors, the deadline, a non-2xx status or a non-JSON body
function requestJson(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: 'discord.com', ...options }, res => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', c => { data += c })
      res.on('error', reject)
      res.on('end', () => {
        let json
        try { json = JSON.parse(data) }
        catch { return reject(new Error(`discord ${options.path} returned a non-JSON body (${res.statusCode})`)) }
        if (res.statusCode < 200 || res.statusCode >= 300 || (json && json.error)) {
          const reason = json && (json.error_description || json.error || json.message)
          return reject(new Error(`discord ${options.path} failed (${res.statusCode})${reason ? `: ${reason}` : ''}`))
        }
        resolve(json)
      })
    })
    const timer = setTimeout(() => req.destroy(new Error(`discord ${options.path} timed out`)), TIMEOUT_MS)
    req.on('close', () => clearTimeout(timer))
    req.on('error', reject)
    req.end(body)
  })
}

function exchangeCode({ code, redirectUri }) {
  const body = new URLSearchParams({
    client_id:     config.discordClientId,
    client_secret: config.discordClientSecret,
    grant_type:    'authorization_code',
    code,
    redirect_uri:  redirectUri,
  }).toString()
  return requestJson({
    path:    '/api/oauth2/token',
    method:  'POST',
    headers: {
      'Content-Type':   'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    },
  }, body)
}

function getUser(accessToken) {
  return requestJson({
    path:    '/api/users/@me',
    method:  'GET',
    headers: { Authorization: `Bearer ${accessToken}` },
  })
}

function avatarUrl(user) {
  return user.avatar
    ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64`
    : null
}

module.exports = { authorizeUrl, exchangeCode, getUser, avatarUrl }
