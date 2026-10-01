'use strict'
// Release path tables: the area a changed path belongs to and what shipping it costs; first match wins, the last row catches the rest

// Highest first; a commit takes the highest area among its files
const AREA_ORDER = Object.freeze([
  'Game server', 'Gameplay', 'Native client', 'Client', 'Backend', 'Launcher', 'Website', 'Patch notes', 'Versions', 'Tools', 'Docs',
])

const LINT_DOTFILES = ['.clang-format', '.clang-tidy', '.editorconfig', '.eslintrc*', '.eslintignore', '.prettierrc*', '.prettierignore', '.linelint.yml']

const deepFreeze = rows => Object.freeze(rows.map(row => Object.freeze({ ...row, paths: Object.freeze([...row.paths]), flags: Object.freeze([...row.flags]) })))

// Fork (origin/main) paths
const FORK_PATHS = deepFreeze([
  { paths: ['skymp5-backend/routes/version.js'], area: 'Versions', flags: [], check: 'launcherUrl' },
  { paths: ['skymp5-backend/package.json', 'skymp5-backend/package-lock.json'], area: 'Backend', flags: ['backendRestart', 'backendDeps'] },
  { paths: ['skymp5-backend/data/**'], area: 'Backend', label: 'Backend data', flags: [], warning: 'runtime data lives here' },
  { paths: ['skymp5-backend/public/**'], area: 'Backend', label: 'Backend static', flags: [] },
  { paths: ['skymp5-backend/**'], area: 'Backend', flags: ['backendRestart'] },
  { paths: ['skymp5-client/**', 'skymp5-front/**'], area: 'Client', flags: ['clientPack'] },
  { paths: ['skyrim-platform/**', 'client-deps/**'], area: 'Native client', flags: ['nativeBuild'], warning: 'needs a Windows build; not possible on CT 115 yet' },
  { paths: ['skymp5-launcher/**'], area: 'Launcher', flags: ['launcherRelease'] },
  { paths: ['server-manager/**'], area: 'Tools', flags: [] },
  { paths: ['deploy/skyrim-data/SHA256SUMS'], area: 'Versions', label: 'Plugins record', flags: [] },
  { paths: ['website/**'], area: 'Website', flags: ['websiteInstall'] },
  {
    paths: ['docs/**', '_reviews/**', '**/*.md', '.github/**', '.devcontainer/**', 'CLA.md', 'TERMS.md', 'THIRD_PARTY_LICENSES',
      ...LINT_DOTFILES.map(f => `**/${f}`)],
    area: 'Docs', flags: [],
  },
  { paths: ['**'], area: 'Game server', flags: ['build', 'gameRestart'] },
])

// dev-server.sh deploy-gameplay copies the tracked top-level .js and .json files except these
const RUNTIME_STATE = Object.freeze(['package.json', 'companions.json', 'housing.json', 'jails.json', 'starter-grants.json', 'NPC-Spawns.json'])
const NOT_DEPLOYED = Object.freeze([...RUNTIME_STATE, 'patch-notes.json'])

// Gameplay (origin/server) paths; specific rows come before the deployable catch-all
const SERVER_PATHS = deepFreeze([
  { paths: ['skills.json'], area: 'Gameplay', flags: ['bootOnly'] },
  { paths: ['*migration*.json'], area: 'Gameplay', flags: ['hotReload', 'migration'] },
  { paths: RUNTIME_STATE, area: 'Gameplay', flags: [], warning: 'not deployed (runtime state)' },
  { paths: ['patch-notes.json'], area: 'Patch notes', flags: ['news'] },
  { paths: ['tooling/dbo-monitor/**'], area: 'Tools', flags: ['manual'] },
  { paths: ['**/*.md', '_reviews/**', '**/*.txt', 'tests/**', 'tooling/**'], area: 'Docs', flags: [] },
  { paths: ['*.js', '*.json'], area: 'Gameplay', flags: ['hotReload'] },
  { paths: ['**'], area: 'Gameplay', flags: ['manual'], warning: 'not in the deployable set' },
])

// A commit with a "Migration: yes" trailer counts as this row too
const MIGRATION_TRAILER = { area: 'Gameplay', flags: ['migration'] }

// ** crosses folders and * stays inside one; both match dot names
function globToRegExp(glob) {
  const body = glob.split(/(\*\*\/|\*\*|\*)/).map(part =>
    part === '**/' ? '(?:.*/)?'
      : part === '**' ? '.*'
      : part === '*' ? '[^/]*'
      : part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('')
  return new RegExp(`^${body}$`)
}

function classifier(table) {
  const compiled = table.map(row => ({ row, patterns: row.paths.map(globToRegExp) }))
  return file => {
    const { row } = compiled.find(c => c.patterns.some(re => re.test(String(file))))
    return { area: row.area, label: row.label || row.area, flags: [...row.flags], warning: row.warning || null, check: row.check || null }
  }
}

const classifyFork = classifier(FORK_PATHS)
const classifyServer = classifier(SERVER_PATHS)
const CLASSIFIERS = new Map([['fork', classifyFork], ['server', classifyServer]])

// Flags are the union over the files and the area is the highest; a commit with no files counts as an unknown path
function classifyCommit(side, files, { migration = false } = {}) {
  const classify = CLASSIFIERS.get(side)
  if (!classify) throw new Error(`unknown side: ${side}`)
  const rows = (files.length ? files : ['']).map(classify)
  if (migration) rows.push(MIGRATION_TRAILER)
  const unique = values => [...new Set(values.filter(Boolean))]
  return {
    area: AREA_ORDER.find(area => rows.some(r => r.area === area)),
    flags: unique(rows.flatMap(r => r.flags)).sort(),
    warnings: unique(rows.map(r => r.warning)),
    checks: unique(rows.map(r => r.check)),
  }
}

const isDeployable = file => /^[^/]+\.(js|json)$/.test(file) && !NOT_DEPLOYED.includes(file)

module.exports = { AREA_ORDER, FORK_PATHS, SERVER_PATHS, NOT_DEPLOYED, classifyFork, classifyServer, classifyCommit, isDeployable }
