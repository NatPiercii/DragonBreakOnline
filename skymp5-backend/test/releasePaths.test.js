'use strict'
// Release path tables: every row, first-match order, deny-by-default and commit-level classification

const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  AREA_ORDER, FORK_PATHS, SERVER_PATHS, NOT_DEPLOYED, classifyFork, classifyServer, classifyCommit, isDeployable,
} = require('../sources/releasePaths')

const GAME = { area: 'Game server', label: 'Game server', flags: ['build', 'gameRestart'] }

function expectRow(classify, file, { area, label = area, flags, warning = null, check = null }) {
  assert.deepEqual(classify(file), { area, label, flags, warning, check }, file)
}

test('fork: every row of the table', () => {
  const rows = [
    ['skymp5-backend/routes/version.js', { area: 'Versions', flags: [], check: 'launcherUrl' }],
    ['skymp5-backend/package.json', { area: 'Backend', flags: ['backendRestart', 'backendDeps'] }],
    ['skymp5-backend/package-lock.json', { area: 'Backend', flags: ['backendRestart', 'backendDeps'] }],
    ['skymp5-backend/data/news.live.json', { area: 'Backend', label: 'Backend data', flags: [], warning: 'runtime data lives here' }],
    ['skymp5-backend/data/.gitkeep', { area: 'Backend', label: 'Backend data', flags: [], warning: 'runtime data lives here' }],
    ['skymp5-backend/public/index.html', { area: 'Backend', label: 'Backend static', flags: [] }],
    ['skymp5-backend/routes/site-staff.js', { area: 'Backend', flags: ['backendRestart'] }],
    ['skymp5-backend/.env.example', { area: 'Backend', flags: ['backendRestart'] }],
    ['skymp5-client/src/services/services/voiceService.ts', { area: 'Client', flags: ['clientPack'] }],
    ['skymp5-front/src/utils/VoiceManager.js', { area: 'Client', flags: ['clientPack'] }],
    ['skyrim-platform/src/platform_se/skyrim_platform/Main.cpp', { area: 'Native client', flags: ['nativeBuild'], warning: 'needs a Windows build; not possible on CT 115 yet' }],
    ['client-deps/x/y.dll', { area: 'Native client', flags: ['nativeBuild'], warning: 'needs a Windows build; not possible on CT 115 yet' }],
    ['skymp5-launcher/src/main.ts', { area: 'Launcher', flags: ['launcherRelease'] }],
    ['server-manager/Run.bat', { area: 'Tools', flags: [] }],
    ['deploy/skyrim-data/SHA256SUMS', { area: 'Versions', label: 'Plugins record', flags: [] }],
    ['website/guides/religion.html', { area: 'Website', flags: ['websiteInstall'] }],
    ['docs/release.md', { area: 'Docs', flags: [] }],
    ['docs/diagram.png', { area: 'Docs', flags: [] }],
    ['_reviews/wn4cpt3m5/notes', { area: 'Docs', flags: [] }],
    ['skymp5-server/README.md', { area: 'Docs', flags: [] }],
    ['.github/workflows/build.yml', { area: 'Docs', flags: [] }],
    ['.devcontainer/devcontainer.json', { area: 'Docs', flags: [] }],
    ['CLA.md', { area: 'Docs', flags: [] }],
    ['TERMS.md', { area: 'Docs', flags: [] }],
    ['THIRD_PARTY_LICENSES', { area: 'Docs', flags: [] }],
    ['.clang-format', { area: 'Docs', flags: [] }],
    ['.editorconfig', { area: 'Docs', flags: [] }],
    ['.linelint.yml', { area: 'Docs', flags: [] }],
    ['.prettierrc.json', { area: 'Docs', flags: [] }],
    ['.prettierignore', { area: 'Docs', flags: [] }],
    ['skymp5-server/.eslintrc.js', { area: 'Docs', flags: [] }],
    ['skymp5-server/ts/index.ts', GAME],
  ]
  for (const [file, want] of rows) expectRow(classifyFork, file, want)
})

test('fork: the first matching row wins', () => {
  expectRow(classifyFork, 'skymp5-backend/routes/version.js', { area: 'Versions', flags: [], check: 'launcherUrl' })
  expectRow(classifyFork, 'skymp5-backend/README.md', { area: 'Backend', flags: ['backendRestart'] })
  expectRow(classifyFork, 'skymp5-backend/data/README.md', { area: 'Backend', label: 'Backend data', flags: [], warning: 'runtime data lives here' })
  expectRow(classifyFork, 'skymp5-front/.eslintrc.js', { area: 'Client', flags: ['clientPack'] })
  expectRow(classifyFork, 'skymp5-client/README.md', { area: 'Client', flags: ['clientPack'] })
  expectRow(classifyFork, 'website/README.md', { area: 'Website', flags: ['websiteInstall'] })
  expectRow(classifyFork, 'deploy/skyrim-data/other.txt', GAME)
  expectRow(classifyFork, 'deploy/SHA256SUMS', GAME)
})

test('fork: scripts/merge-files.js is a backend restart', () => {
  expectRow(classifyFork, 'skymp5-backend/scripts/merge-files.js', { area: 'Backend', flags: ['backendRestart'] })
})

test('fork: server-manager and backend public files carry no flags', () => {
  assert.deepEqual(classifyFork('server-manager/src/main.js').flags, [])
  assert.deepEqual(classifyFork('skymp5-backend/public/dashboard.js').flags, [])
})

test('fork: unknown paths are a game restart', () => {
  for (const file of [
    'deploy/dev-server.sh', 'unit/RespawnTest.cpp', 'misc/tool.py', 'CMakeLists.txt', 'cmake/x.cmake', 'vcpkg.json',
    'overlay_ports/a/portfile.cmake', 'libespm/src/a.cpp', 'papyrus-vm/a.cpp', 'serialization/a.h', 'savefile/a.cpp',
    'viet/a.h', 'server-plugins/a.js', 'dragonbreak-gamemode/index.js', 'skymp5-functions-lib/a.ts', 'build.sh',
    '.gitmodules', '.gitignore', 'dev/x', 'skymp5-scripts/a.psc', 'a-folder-nobody-has-made-yet/x', 'README.MD',
  ]) expectRow(classifyFork, file, GAME)
})

test('fork: the 25 Sep restarts shipped nothing the server runs', () => {
  assert.equal(classifyCommit('fork', ['skymp5-backend/routes/version.js']).area, 'Versions')
  assert.deepEqual(classifyCommit('fork', ['website/guides/religion.html']).flags, ['websiteInstall'])
  assert.deepEqual(classifyCommit('fork', ['skymp5-client/src/services/services/voiceService.ts', 'skymp5-front/src/utils/VoiceManager.js']).flags, ['clientPack'])
})

test('server: every row of the table', () => {
  const rows = [
    ['combat.js', { area: 'Gameplay', flags: ['hotReload'] }],
    ['gamemode.js', { area: 'Gameplay', flags: ['hotReload'] }],
    ['gamemode-config.json', { area: 'Gameplay', flags: ['hotReload'] }],
    ['skills.json', { area: 'Gameplay', flags: ['bootOnly'] }],
    ['2026-09-guild-migration.json', { area: 'Gameplay', flags: ['hotReload', 'migration'] }],
    ['package.json', { area: 'Gameplay', flags: [], warning: 'not deployed (runtime state)' }],
    ['companions.json', { area: 'Gameplay', flags: [], warning: 'not deployed (runtime state)' }],
    ['housing.json', { area: 'Gameplay', flags: [], warning: 'not deployed (runtime state)' }],
    ['jails.json', { area: 'Gameplay', flags: [], warning: 'not deployed (runtime state)' }],
    ['starter-grants.json', { area: 'Gameplay', flags: [], warning: 'not deployed (runtime state)' }],
    ['NPC-Spawns.json', { area: 'Gameplay', flags: [], warning: 'not deployed (runtime state)' }],
    ['patch-notes.json', { area: 'Patch notes', flags: ['news'] }],
    ['tooling/dbo-monitor/monitor.py', { area: 'Tools', flags: ['manual'] }],
    ['CHECKLIST.md', { area: 'Docs', flags: [] }],
    ['notes/design.md', { area: 'Docs', flags: [] }],
    ['_reviews/b02fb394.txt', { area: 'Docs', flags: [] }],
    ['todo.txt', { area: 'Docs', flags: [] }],
    ['tests/combat-harness.js', { area: 'Docs', flags: [] }],
    ['tooling/ops/dev-server.sh', { area: 'Docs', flags: [] }],
  ]
  for (const [file, want] of rows) expectRow(classifyServer, file, want)
})

test('server: skills.json is boot only', () => {
  assert.deepEqual(classifyCommit('server', ['skills.json']).flags, ['bootOnly'])
})

test('server: unknown paths are flagged and never hidden', () => {
  for (const file of ['lib/helper.js', 'data/items.json', 'install.sh', '.gitignore']) {
    expectRow(classifyServer, file, { area: 'Gameplay', flags: ['manual'], warning: 'not in the deployable set' })
  }
})

test('the deployable set mirrors dev-server.sh deploy-gameplay', () => {
  for (const file of ['combat.js', 'gamemode.js', 'gamemode-config.json', 'skills.json']) assert.ok(isDeployable(file), file)
  for (const file of [...NOT_DEPLOYED, 'tests/a.js', 'lib/a.json', 'README.md']) assert.ok(!isDeployable(file), file)
  assert.ok(NOT_DEPLOYED.includes('patch-notes.json'))
})

test('commit: flags are the union and the area is the highest', () => {
  assert.deepEqual(classifyCommit('fork', ['docs/a.md', 'website/index.html', 'skymp5-backend/server.js']), {
    area: 'Backend', flags: ['backendRestart', 'websiteInstall'], warnings: [], checks: [],
  })
  assert.deepEqual(classifyCommit('fork', ['skymp5-client/a.ts', 'skymp5-server/ts/a.ts', 'skymp5-backend/routes/version.js']), {
    area: 'Game server', flags: ['build', 'clientPack', 'gameRestart'], warnings: [], checks: ['launcherUrl'],
  })
  assert.deepEqual(classifyCommit('fork', ['skyrim-platform/a.cpp', 'skymp5-launcher/a.ts']), {
    area: 'Native client', flags: ['launcherRelease', 'nativeBuild'], warnings: ['needs a Windows build; not possible on CT 115 yet'], checks: [],
  })
  assert.equal(classifyCommit('fork', ['docs/a.md', 'CLA.md']).area, 'Docs')
  assert.deepEqual(classifyCommit('server', ['combat.js', 'gamemode-config.json', 'tests/combat-harness.js']), {
    area: 'Gameplay', flags: ['hotReload'], warnings: [], checks: [],
  })
  assert.deepEqual(classifyCommit('server', ['CHECKLIST.md']), { area: 'Docs', flags: [], warnings: [], checks: [] })
})

test('commit: a Migration trailer adds the migration flag', () => {
  assert.deepEqual(classifyCommit('server', ['combat.js'], { migration: true }).flags, ['hotReload', 'migration'])
  assert.deepEqual(classifyCommit('server', ['tests/a.js'], { migration: true }), {
    area: 'Gameplay', flags: ['migration'], warnings: [], checks: [],
  })
})

test('commit: no files counts as an unknown path, and an unknown side throws', () => {
  assert.deepEqual(classifyCommit('fork', []).flags, ['build', 'gameRestart'])
  assert.deepEqual(classifyCommit('server', []).flags, ['manual'])
  assert.throws(() => classifyCommit('client', ['a']), /unknown side/)
  assert.throws(() => classifyCommit('constructor', ['a']), /unknown side/)
})

test('tables are frozen JSON data and every area is ranked', () => {
  for (const table of [FORK_PATHS, SERVER_PATHS]) {
    assert.deepEqual(JSON.parse(JSON.stringify(table)), table)
    assert.ok(Object.isFrozen(table) && table.every(r => Object.isFrozen(r) && Object.isFrozen(r.paths) && Object.isFrozen(r.flags)))
    assert.deepEqual(table.at(-1).paths, ['**'])
    for (const row of table) assert.ok(AREA_ORDER.includes(row.area), row.area)
  }
  const forkOrder = ['Game server', 'Native client', 'Client', 'Backend', 'Launcher', 'Website', 'Versions', 'Tools', 'Docs']
  assert.deepEqual(AREA_ORDER.filter(a => forkOrder.includes(a)), forkOrder)
  assert.deepEqual(AREA_ORDER.filter(a => ['Gameplay', 'Patch notes', 'Tools', 'Docs'].includes(a)), ['Gameplay', 'Patch notes', 'Tools', 'Docs'])
  assert.throws(() => FORK_PATHS[0].flags.push('x'))
})

test('a returned result is a copy, so callers cannot change the table', () => {
  classifyFork('skymp5-backend/server.js').flags.push('gameRestart')
  assert.deepEqual(classifyFork('skymp5-backend/server.js').flags, ['backendRestart'])
})

test('glob characters in a path are matched literally', () => {
  expectRow(classifyFork, 'website/a+b(1).html', { area: 'Website', flags: ['websiteInstall'] })
  expectRow(classifyFork, 'docsX/a', GAME)
  expectRow(classifyFork, 'skymp5-backendX/a.js', GAME)
  expectRow(classifyServer, 'a.jsx', { area: 'Gameplay', flags: ['manual'], warning: 'not in the deployable set' })
})
