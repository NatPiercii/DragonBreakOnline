'use strict'
// Token session stores persisted as a JSON array of [token, data] pairs, so restarts don't log everyone out

const crypto = require('crypto')
const fs     = require('fs')
const path   = require('path')

function createStore({ file, ttlMs, label }) {
  // token -> { ...fields, expiresAt }
  const sessions = new Map()

  function load() {
    try {
      const entries = JSON.parse(fs.readFileSync(file, 'utf8'))
      const now     = Date.now()
      for (const [token, data] of entries) {
        if (data.expiresAt > now) sessions.set(token, data)
      }
      console.log(`[${label}] loaded ${sessions.size} active session(s)`)
    } catch { /* file absent on first run */ }
  }

  // Temp file then rename, so a crash mid-write never leaves a truncated store
  function save() {
    const tmp = `${file}.tmp`
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(tmp, JSON.stringify([...sessions.entries()]), { mode: 0o600 })
      fs.renameSync(tmp, file)
    } catch (err) {
      console.error(`[${label}] save failed:`, err.message)
    }
  }

  function create(fields) {
    // Prune expired first
    const now = Date.now()
    for (const [t, d] of sessions) if (d.expiresAt <= now) sessions.delete(t)

    const token = crypto.randomBytes(32).toString('hex')
    sessions.set(token, { ...fields, expiresAt: now + ttlMs })
    save()
    return token
  }

  function validate(token) {
    if (!token) return null
    const data = sessions.get(token)
    if (!data) return null
    if (data.expiresAt < Date.now()) {
      sessions.delete(token)
      save()
      return null
    }
    return data
  }

  function revoke(token) {
    if (sessions.delete(token)) save()
  }

  load()
  return { create, validate, revoke }
}

module.exports = { createStore }
