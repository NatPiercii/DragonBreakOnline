'use strict'
// Automatic error and crash reports (docs/auto-report-v1.md): POST /api/files/report with x-report-kind: auto

const config = require('../config')
const { CONTRACT_VERSIONS } = require('./autoSchema')

// AUTO_REPORTS=off answers before any other work; senders drop the report and wait pauseSec
function killSwitch(_req, res, next) {
  if (config.autoReports !== 'off') return next()
  res.status(503).json({ error: 'paused', pauseSec: config.autoReportPauseSec })
}

// The autoReport block of GET /api/version, which the launcher reads before sending anything
function versionInfo() {
  return { mode: config.autoReports, crashWatch: config.autoReportCrashWatch, contract: CONTRACT_VERSIONS }
}

module.exports = { killSwitch, versionInfo }
