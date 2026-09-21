'use strict'
// Dashboard session store: short-lived tokens issued after Discord OAuth, persisted to data/dashboard-sessions.json so restarts don't log everyone out

const path            = require('path')
const { createStore } = require('./sessionStore')

const store = createStore({
  file:  path.join(__dirname, '..', 'data', 'dashboard-sessions.json'),
  ttlMs: 24 * 60 * 60 * 1000,  // 24 h
  label: 'dashboard-sessions',
})

function create(discordId, username, avatar, roles = [], permissions = []) {
  return store.create({ discordId, username, avatar, roles, permissions })
}

module.exports = { create, validate: store.validate, revoke: store.revoke }
