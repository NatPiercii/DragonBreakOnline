'use strict'
// MODULE 1 - preflight: is this machine fit to produce a trustworthy test result?
//
// This exists because on 2026-10-07 five consecutive "launcher 2.1.37 is broken" results were all
// false: the launcher had been started from an agent shell, which passed its sandbox down to MO2,
// and MO2 reported ERROR_ACCESS_DENIED spawning SKSE while blaming antivirus. An hour went into
// chasing Windows Defender. Everything here is a precondition that, if violated, makes any
// downstream result meaningless - so those report INVALID rather than FAIL.
//
// Usage: node tools/dbo-verify/preflight.js [--json]
const fs = require('fs')
const path = require('path')
const env = require('./lib/env')
const { Report } = require('./lib/report')

function main() {
  const r = new Report('preflight - is this machine fit to test?')

  // 1. Sandbox inheritance. The single highest-value check in the harness.
  const anc = env.launcherAncestry()
  if (!anc.running) {
    r.skip('launcher ancestry', 'launcher not running', 'start it from Windows before a launch test')
  } else if (anc.tainted) {
    r.invalid('launcher ancestry', 'launcher descends from a shell', `${anc.chain}\nA sandboxed ancestor makes MO2 fail to spawn SKSE. Close it and start it from Windows.`)
  } else {
    r.pass('launcher ancestry', 'no shell in the parent chain', anc.chain)
  }

  // 2. Vortex. It deploys into the Steam folder by hardlink and invalidates Steam-folder baselines.
  const v = env.vortexState()
  if (v.running) {
    r.invalid('vortex not running', `${v.running} Vortex process(es) up`, 'Vortex deploys into the Steam folder mid-test; close it including the tray icon')
  } else if (v.contaminated) {
    r.fail('steam folder clean', 'Vortex has deployed into the Steam install', `${v.deploymentManifest.path} written ${v.deploymentManifest.mtime}\nSteam-folder assertions will see Vortex's files, not the launcher's`)
  } else {
    r.pass('steam folder clean', 'no Vortex process and no deployment manifest')
  }

  // 3. Versions. A test is only meaningful against a known build.
  const ver = env.versions()
  if (!ver.launcher) r.fail('launcher installed', 'launcher exe not found', env.redact(env.PATHS.launcherExe))
  else r.pass('launcher installed', `v${ver.launcher}`)

  if (ver.gameCopyExe && ver.steamExe) {
    const same = ver.gameCopyExe === ver.steamExe
    r.add(same ? 'PASS' : 'FAIL', 'game build match', `copy ${ver.gameCopyExe} / steam ${ver.steamExe}`,
      same ? null : 'A mismatch changes which code path the launcher takes')
  } else {
    r.fail('game build match', 'could not read both SkyrimSE.exe versions')
  }

  // 4. Nothing already running that would confuse a launch test.
  const procs = env.processes().filter(p => /SkyrimSE|ModOrganizer/i.test(p.name))
  if (procs.length) r.invalid('clean slate', `${procs.length} game/MO2 process(es) already running`, procs.map(p => `${p.name} pid=${p.pid}`).join('\n'))
  else r.pass('clean slate', 'no game or MO2 process running')

  // 5. Quarantine. Leftovers here are usually artifacts a previous test failed to clean up.
  const q = env.quarantineEntries()
  const artifacts = q.filter(e => /smoketest|dbo-verify|\.bak$/i.test(e.rel))
  if (artifacts.length) r.fail('no stale test artifacts', `${artifacts.length} in Quarantine`, artifacts.map(a => env.redact(a.rel)).join('\n'))
  else r.pass('no stale test artifacts', q.length ? `${q.length} unrelated quarantine entries` : 'quarantine empty')

  // 6. The install log, recorded as a session id so downstream modules can diff correctly.
  const log = env.readInstallLog()
  if (log.exists) r.pass('install log readable', `${log.lines.length} lines`, env.redact(log.sessionId || ''))
  else r.skip('install log readable', 'no install.log yet')

  // 7. Clean depots, used by the verified game copy and by any file-list regeneration.
  const depots = env.fileFacts(env.PATHS.depots)
  if (depots.exists) r.pass('clean 1.6.1170 depots present', env.PATHS.depots)
  else r.skip('clean 1.6.1170 depots present', 'absent - a verified-copy test would need a 15 GB download first')

  r.print()
  if (process.argv.includes('--json')) {
    const out = path.join(__dirname, 'out', 'preflight.json')
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, r.json())
    console.log(`\njson: ${out}`)
  }
  process.exit(r.exitCode)
}

main()
