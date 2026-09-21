'use strict'
// Website sign-in sessions: cookie tokens issued by routes/site-auth.js, persisted to data/site-sessions.json

const path            = require('path')
const config          = require('../config')
const { createStore } = require('./sessionStore')

module.exports = createStore({
  file:  path.join(__dirname, '..', 'data', 'site-sessions.json'),
  ttlMs: config.siteSessionTtlHours * 60 * 60 * 1000,
  label: 'site-sessions',
})
