'use strict'
/**
 * Writes the vanilla game file lists that src/gamecopy.js builds DragonBreak's own Skyrim copy from. Run once, on a
 * PC that owns the game. It reads the files and copies none of them: only paths, sizes and sha256 hashes leave the PC.
 * Node 18 or newer; no npm install needed.
 *
 * STEAM 1.6.1170 (gives src/vanilla-1.6.1170.json)
 *   1. Steam running, signed in to the account that owns Skyrim Special Edition.
 *   2. Open Steam's console: Win+R, then  steam://open/console
 *   3. Run these three, one at a time (the manifests are in src/downgrade-1.6.1170.json). Steam shows no progress
 *      bar; wait for "Depot download complete" after each. About 15 GB in all.
 *        download_depot 489830 489831 8442952117333549665
 *        download_depot 489830 489832 8042843504692938467
 *        download_depot 489830 489833 1914580699073641964
 *      The files land in <Steam>\steamapps\content\app_489830\depot_<id> (the console prints the folder).
 *      Leave them untouched: no mod manager or launcher may run on them first.
 *   4. In a terminal in skymp5-launcher:
 *        node tools/depot-reference.js "C:\Program Files (x86)\Steam\steamapps\content\app_489830"
 *      It hashes every depot file (a few minutes, never more than one 4 MB chunk in memory), checks the masters
 *      against the 1.6.1170 hashes already in downgrade-1.6.1170.json and SkyrimSE.exe's version, and writes
 *      vanilla-1.6.1170.json to the current folder (--out <file> to put it elsewhere). On any problem it writes
 *      nothing and exits 1.
 *   5. Copy that file over skymp5-launcher/src/vanilla-1.6.1170.json on the server and commit it.
 *   It also prints to stdout, as before, each depot's file list (path and size) and SkyrimSE.exe's sha256 for the
 *   "depots[].files" and "files" entries of downgrade-1.6.1170.json.
 *
 * OTHER STEAM LANGUAGES (gives src/vanilla-1.6.1170-<language>.json; English needs nothing more)
 *   Steam installs a language depot on top of the three base depots for French (489834), Italian (489835), German
 *   (489836), Spanish (489837), Russian (489838), Polish (489839), Traditional Chinese (544860) and Japanese (544861)
 *   (Steam's app info for 489830; listed in downgrade-1.6.1170.json "languageDepots"). Its files replace the base
 *   ones at the same path. Until a language's list exists, players of that language stay on the legacy copy.
 *   1. Find the depot's 1.6.1170 manifest id: SteamDB, https://steamdb.info/depot/<id>/manifests/, the manifest from
 *      the same update as depot 489833's 1914580699073641964 (SkyrimSE.exe 1.6.1170). Put it in downgrade-1.6.1170.json
 *      under languageDepots.<language>.manifest.
 *   2. In Steam's console:  download_depot 489830 <id> <manifest>
 *   3. node tools/depot-reference.js --language <language> "<Steam>\steamapps\content\app_489830"
 *      Writes vanilla-1.6.1170-<language>.json; copy it to skymp5-launcher/src/ on the server and commit it.
 *
 * GOG 1.6.1179 (gives src/vanilla-1.6.1179-gog.json)
 *   1. Install Skyrim Special Edition from GOG Galaxy and use Galaxy's rollback to get 1.6.1179, with no mods and
 *      nothing else run on that folder (a fresh install is best).
 *   2. node tools/depot-reference.js --gog "C:\Program Files (x86)\GOG Galaxy\Games\Skyrim Special Edition"
 *      Same output shape with platform "gog" and no depots, written to vanilla-1.6.1179-gog.json. GOG Galaxy's own
 *      files (goggame-*, webcache.zip, unins*, __redist) are left out; a folder with mod traces (SKSE, ENB or ReShade
 *      DLLs, .esp plugins) is refused.
 *   3. Copy it to skymp5-launcher/src/vanilla-1.6.1179-gog.json on the server and commit it.
 *
 * Output: { build, platform, generatedAt, files: [{ path, size, sha256, depot }] }, path relative to the game folder
 * with forward slashes, exactly where the file lands in the game folder.
 */
const fs = require('fs')
const path = require('path')
const gamecopy = require('../src/gamecopy')
const gameversion = require('../src/gameversion')
const downgrade = require('../src/downgrade')
const REF = require('../src/downgrade-1.6.1170.json')

const USAGE = [
  'usage: node tools/depot-reference.js <Steam>\\steamapps\\content\\app_489830 [--out <file>]',
  '       node tools/depot-reference.js --language <language> <Steam>\\steamapps\\content\\app_489830 [--out <file>]',
  '       node tools/depot-reference.js --gog <GOG Skyrim folder> [--out <file>]',
].join('\n')

// GOG Galaxy's own files in a game folder: not game files, and Galaxy rewrites some of them
const GOG_SKIP = [/^goggame-/i, /^gog\.ico$/i, /^support\.ico$/i, /^webcache\.zip$/i, /^unins\d+\./i, /^__redist\//i, /^__support\//i]
// Signs that a folder is not vanilla: script extenders, graphics injectors, plugins (vanilla SE ships none)
const MOD_TRACES = [/^skse64_/i, /^(dinput8|d3d11|dxgi|d3d9|d3dx9_42|enbseries)\.(dll|ini)$/i, /^enbseries\//i,
  /^reshade/i, /^data\/skse\//i, /\.esp$/i]

function parseArgs(argv) {
  const out = { gog: false, language: null, dir: null, out: null }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--gog') out.gog = true
    else if (argv[i] === '--language') out.language = String(argv[++i] || '').toLowerCase()
    else if (argv[i] === '--out') out.out = argv[++i]
    else if (!out.dir) out.dir = argv[i]
    else return null
  }
  if (out.language !== null && (out.gog || !(REF.languageDepots || {})[out.language])) return null
  return out.dir && (out.out === null || out.out) ? out : null
}

// Regular files below dir, forward-slash paths; links and other entries are a problem, never followed
function listDir(dir, problems) {
  const { files, unsafe } = downgrade.listFiles(dir)
  for (const u of unsafe) problems.push(`${path.join(dir, u)} is a link or not a regular file`)
  return files.map(f => ({ path: f.rel.split(path.sep).join('/'), size: f.size, abs: path.join(dir, f.rel) }))
}

// Streaming sha256 of each file in turn, with a progress line on stderr
async function hashAll(files) {
  const total = files.reduce((n, f) => n + f.size, 0)
  let done = 0
  const line = (i, f) => `\r[${i}/${files.length}] ${Math.round(done / 1048576)} of ${Math.round(total / 1048576)} MB  ${f.path}`.padEnd(100).slice(0, 100)
  for (const [i, f] of files.entries()) {
    process.stderr.write(line(i + 1, f))
    f.sha256 = await gamecopy.hashFile(f.abs, { onBytes: n => { done += n } })
  }
  process.stderr.write('\n')
}

// The 1.6.1170 sizes and hashes downgrade-1.6.1170.json already knows, against the files found
function checkKnown(byKey, problems, { requireAll }) {
  for (const [p, want] of Object.entries(REF.files)) {
    const f = byKey.get(p.toLowerCase())
    if (!f) { if (requireAll && want.required) problems.push(`${p} is missing`); continue }
    if (f.size !== want.size || f.sha256 !== want.sha256) problems.push(`${p} does not match the 1.6.1170 reference`)
  }
}

function checkExe(byKey, want, problems) {
  const exe = byKey.get('skyrimse.exe')
  if (!exe) { problems.push('there is no SkyrimSE.exe'); return }
  const version = gameversion.readPeFileVersion(exe.abs)
  if (version !== want) problems.push(`SkyrimSE.exe is ${version || 'unreadable'}, not ${want}`)
}

function writeList(file, list) {
  gamecopy.loadManifest(list) // the launcher must be able to load what is written: no unsafe or doubled path
  fs.writeFileSync(file, JSON.stringify(list, null, 2) + '\n')
  console.error(`Wrote ${file}: ${list.files.length} files, ${Math.round(list.files.reduce((n, f) => n + f.size, 0) / 1048576)} MB.`)
}

const sortByPath = files => files.sort((a, b) => (a.path.toLowerCase() < b.path.toLowerCase() ? -1 : a.path.toLowerCase() > b.path.toLowerCase() ? 1 : 0))
const entry = f => ({ path: gamecopy.normRel(f.path), size: f.size, sha256: f.sha256, depot: f.depot || null })

async function steam(appDir, outFile) {
  const problems = []
  const byKey = new Map()
  const depots = {}
  for (const d of REF.depots) {
    const dir = path.join(appDir, `depot_${d.id}`)
    if (!fs.existsSync(dir)) { problems.push(`depot_${d.id} is missing (run: download_depot ${REF.app} ${d.id} ${d.manifest})`); continue }
    depots[d.id] = listDir(dir, problems)
    if (!depots[d.id].length) problems.push(`depot_${d.id} is empty`)
    for (const f of depots[d.id]) {
      const key = f.path.toLowerCase()
      // Later depots win, as when downgrade.planInstall lays them over a game folder
      if (byKey.has(key)) console.error(`note: ${f.path} is in depot ${byKey.get(key).depot} and ${d.id}; ${d.id}'s copy is kept`)
      byKey.set(key, { ...f, depot: d.id })
    }
  }
  if (problems.length) return problems
  const files = sortByPath([...byKey.values()])
  await hashAll(files)
  checkKnown(byKey, problems, { requireAll: true })
  checkExe(byKey, REF.exeVersion, problems)
  if (problems.length) return problems

  writeList(outFile, {
    note: 'Every file of Skyrim SE 1.6.1170 on Steam (app 489830): path in the game folder, size, sha256 and depot, ' +
      'hashed from a fresh download_depot output by tools/depot-reference.js. Read by src/gamecopy.js.',
    build: REF.exeVersion,
    platform: 'steam',
    app: REF.app,
    depots: REF.depots.map(d => ({ id: d.id, manifest: d.manifest })),
    generatedAt: new Date().toISOString(),
    files: files.map(entry),
  })
  // The earlier output, for downgrade-1.6.1170.json's depots[].files and files entries
  const exe = byKey.get('skyrimse.exe')
  console.log(JSON.stringify({
    depots: Object.fromEntries(Object.entries(depots).map(([id, list]) => [id, sortByPath(list).map(f => ({ path: f.path, size: f.size }))])),
    files: { [exe.path]: { size: exe.size, sha256: exe.sha256 } },
  }, null, 2))
  return []
}

// One language depot's files: they lie over the base depots' at the same path (gamecopy.mergeLists)
async function language(appDir, lang, outFile) {
  const problems = []
  const d = REF.languageDepots[lang]
  const dir = path.join(appDir, `depot_${d.id}`)
  if (!fs.existsSync(dir)) return [`depot_${d.id} is missing (run: download_depot ${REF.app} ${d.id} <its 1.6.1170 manifest>)`]
  const files = sortByPath(listDir(dir, problems).map(f => ({ ...f, depot: d.id })))
  if (!files.length) problems.push(`depot_${d.id} is empty`)
  if (problems.length) return problems
  await hashAll(files)
  for (const f of files) if (REF.files[f.path]) console.error(`note: ${f.path} is also in the base list; the ${lang} one replaces it`)
  writeList(outFile, {
    note: `The ${lang} files of Skyrim SE 1.6.1170 on Steam (app 489830, language depot ${d.id}${d.manifest ? `, manifest ${d.manifest}` : ''}): ` +
      'path in the game folder, size, sha256 and depot, laid over vanilla-1.6.1170.json. Written by tools/depot-reference.js --language.',
    build: REF.exeVersion,
    platform: 'steam',
    language: lang,
    app: REF.app,
    depots: [{ id: d.id, manifest: d.manifest || null }],
    generatedAt: new Date().toISOString(),
    files: files.map(entry),
  })
  return []
}

async function gog(gameDir, outFile) {
  const problems = []
  const all = listDir(gameDir, problems)
  const skipped = all.filter(f => GOG_SKIP.some(re => re.test(f.path)))
  const files = sortByPath(all.filter(f => !skipped.includes(f)))
  const traces = files.filter(f => MOD_TRACES.some(re => re.test(f.path))).map(f => f.path)
  if (traces.length) problems.push(`this folder has been modded (${traces.slice(0, 8).join(', ')}${traces.length > 8 ? ', ...' : ''}); use a fresh install`)
  if (skipped.length) console.error(`left out (GOG Galaxy's own files): ${skipped.map(f => f.path).join(', ')}`)
  if (problems.length) return problems
  const byKey = new Map(files.map(f => [f.path.toLowerCase(), f]))
  checkExe(byKey, gameversion.GAME_VERSION_GOG, problems)
  if (problems.length) return problems
  await hashAll(files)
  // GOG's masters may legitimately differ from Steam's: reported, not refused
  const differ = []
  checkKnown(byKey, differ, { requireAll: false })
  for (const d of differ) console.error(`note: ${d} (Steam's); fine if GOG ships its own`)

  writeList(outFile, {
    note: 'Every file of Skyrim SE 1.6.1179 on GOG: path in the game folder, size and sha256, hashed from a fresh ' +
      'GOG Galaxy install by tools/depot-reference.js --gog. Read by src/gamecopy.js.',
    build: gameversion.GAME_VERSION_GOG,
    platform: 'gog',
    generatedAt: new Date().toISOString(),
    files: files.map(entry),
  })
  return []
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args) { console.error(USAGE); process.exit(2) }
  const dir = path.resolve(args.dir)
  if (!fs.existsSync(dir)) { console.error(`${dir} does not exist.\n${USAGE}`); process.exit(2) }
  const outFile = path.resolve(args.out || (args.gog ? 'vanilla-1.6.1179-gog.json'
    : args.language ? `vanilla-1.6.1170-${args.language}.json` : 'vanilla-1.6.1170.json'))
  const problems = args.gog ? await gog(dir, outFile) : args.language ? await language(dir, args.language, outFile) : await steam(dir, outFile)
  if (problems.length) {
    console.error(`\nNot written - not a clean ${args.gog ? 'GOG 1.6.1179 folder' : args.language ? `${args.language} 1.6.1170 download` : '1.6.1170 download'}:\n  ${problems.join('\n  ')}`)
    process.exit(1)
  }
}

main().catch(err => { console.error(err && err.stack ? err.stack : err); process.exit(1) })
