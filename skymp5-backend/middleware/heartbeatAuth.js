'use strict'
// Decides whether a heartbeat POST really comes from our game server: a matching X-Auth-Token, or (unless HEARTBEAT_REQUIRE_TOKEN is on) a direct loopback connection

const crypto = require('crypto')
const config = require('../config')

// Headers a proxy adds; a loopback peer that carries one is relaying someone else's request
const FORWARD_HEADERS = ['x-real-ip', 'forwarded', 'cf-connecting-ip', 'true-client-ip', 'via']

// Once the real server has sent a valid token, a tokenless loopback peer (Tailscale userspace, ssh -L) is no longer trusted
let tokenSeen = false

// Hashing first gives equal-length buffers, so neither the content nor the length of the secret leaks through timing
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest()
  const hb = crypto.createHash('sha256').update(String(b)).digest()
  return crypto.timingSafeEqual(ha, hb)
}

function isLoopbackAddress(addr) {
  if (typeof addr !== 'string') return false
  const a = addr.startsWith('::ffff:') ? addr.slice(7) : addr
  return a === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a)
}

// The socket peer, never req.ip: 'trust proxy' would let a loopback proxy substitute the client's claimed address
function isDirectLocal(req) {
  if (!isLoopbackAddress(req.socket?.remoteAddress)) return false
  return !Object.keys(req.headers).some(h => h.startsWith('x-forwarded-') || FORWARD_HEADERS.includes(h))
}

// 'missing' | 'valid' | 'invalid'
function tokenState(req) {
  const sent = req.headers['x-auth-token']
  if (typeof sent !== 'string' || !sent) return 'missing'
  if (!config.masterApiAuthToken) return 'invalid'
  return safeEqual(sent, config.masterApiAuthToken) ? 'valid' : 'invalid'
}

// Returns { ok, via, token } where via is 'token' or 'local' when ok
function authorizeHeartbeat(req) {
  const token = tokenState(req)
  if (token === 'valid') { tokenSeen = true; return { ok: true, via: 'token', token } }
  if (!config.heartbeatRequireToken && !tokenSeen && isDirectLocal(req)) return { ok: true, via: 'local', token }
  return { ok: false, via: null, token }
}

function resetTokenLatch() { tokenSeen = false }

module.exports = { safeEqual, isLoopbackAddress, isDirectLocal, authorizeHeartbeat, resetTokenLatch }
