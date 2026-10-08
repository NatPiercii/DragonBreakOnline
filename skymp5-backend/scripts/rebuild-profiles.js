'use strict'

// Rebuilds data/profiles.json when it cannot be read and there is no good copy (8 Oct 2026: nothing on CT 115 backs it
// up). The backend will not start on an unreadable profiles.json, and refuses a missing one while players.json exists,
// because a store started over, or an older copy put back as it is, hands out profile ids that already have characters.
// This keeps every Discord id -> profile id pair it can find and sets nextId above every profile id in use anywhere it
// can look, plus a margin for ids it cannot see. Stop the backend first, and run it at idle priority (it reads the world):
//
//   ionice -c3 nice -n 19 node scripts/rebuild-profiles.js [options]           a dry run: says what it would write
//   ionice -c3 nice -n 19 node scripts/rebuild-profiles.js [options] --write   writes it; the broken file is kept beside it
//
//   --data <dir>      the backend's data folder (default: the one next to this script)
//   --players <file>  another players.json to take pairs from, such as one moved aside (repeatable). <data>/players.json
//                     is always read when it is there
//   --from <file>     a copy of profiles.json from anywhere (repeatable): its pairs, and its nextId as a floor. A copy is
//                     never put back as it is, since it is older than the ids handed out after it
//   --state <dir>     the game's world folder: every profileId in <dir>/changeForms/*.json is an id in use, so a deleted
//                     player whose characters are still in the world keeps their id out of reach (default /opt/skymp-state/world)
//   --no-state        do not read the world (then only the margin covers ids that only characters still hold)
//   --margin <n>      ids skipped above the highest one in use (default 100; an id is only a number, a gap costs nothing)
//
// Pairs also come from the unreadable profiles.json itself, as far as its text can be trusted (a file cut short keeps
// its start, nextId first). A Discord id with two profile ids, or a profile id with two Discord ids, stops it: fix or
// leave out the source that is wrong and run it again.

const fs   = require('fs')
const path = require('path')
const { replaceFile } = require('../sources/storeFile')
const { problemOf }   = require('../sources/profiles')

const DEFAULT_DATA  = path.join(__dirname, '..', 'data')
const DEFAULT_STATE = '/opt/skymp-state/world'
const isProfileId   = value => Number.isSafeInteger(value) && value > 0

function parseArgs(argv) {
  const opts = { data: DEFAULT_DATA, players: [], from: [], state: DEFAULT_STATE, margin: 100, write: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`)
      return argv[++i]
    }
    if (arg === '--data') opts.data = path.resolve(value())
    else if (arg === '--players') opts.players.push(path.resolve(value()))
    else if (arg === '--from') opts.from.push(path.resolve(value()))
    else if (arg === '--state') opts.state = path.resolve(value())
    else if (arg === '--no-state') opts.state = null
    else if (arg === '--margin') {
      opts.margin = Number(value())
      if (!Number.isSafeInteger(opts.margin) || opts.margin < 0) throw new Error('--margin takes a whole number, 0 or more')
    }
    else if (arg === '--write') opts.write = true
    else throw new Error(`unknown option ${arg}`)
  }
  return opts
}

// Pairs a cut or damaged profiles.json still shows: "<discord id>": <profile id> followed by a comma or a closing
// brace, so a number cut short at the end of the text is not taken; nextId only when a comma follows it
function salvage(text) {
  const pairs = []
  for (const m of text.matchAll(/"(\d{5,25})"\s*:\s*(\d+)\s*[,}]/g)) {
    const profileId = Number(m[2])
    if (isProfileId(profileId)) pairs.push([m[1], profileId])
  }
  const next = /"nextId"\s*:\s*(\d+)\s*,/.exec(text)
  const nextId = next && isProfileId(Number(next[1])) ? Number(next[1]) : null
  return { pairs, nextId }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

// The highest profileId any character in the world holds, and how many files hold one
function scanWorld(stateDir) {
  const dir = path.join(stateDir, 'changeForms')
  let max = 0, holders = 0, files = 0
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    files++
    let text
    try { text = fs.readFileSync(path.join(dir, name), 'utf8') } catch { continue }
    let held = false
    for (const m of text.matchAll(/"profileId"\s*:\s*(\d+)/g)) {
      const id = Number(m[1])
      if (!isProfileId(id)) continue
      held = true
      if (id > max) max = id
    }
    if (held) holders++
  }
  return { dir, files, holders, max }
}

// What a rebuild would write, from what it can find; nothing is written here
function plan(opts) {
  const target = path.join(opts.data, 'profiles.json')
  const notes = []
  const byDiscord = new Map()   // discord id -> Map(profile id -> [sources])
  const byProfile = new Map()   // profile id -> Map(discord id -> [sources])
  const add = (discordId, profileId, source) => {
    discordId = String(discordId).trim()
    if (!discordId || !isProfileId(profileId)) return
    if (!byDiscord.has(discordId)) byDiscord.set(discordId, new Map())
    if (!byProfile.has(profileId)) byProfile.set(profileId, new Map())
    const a = byDiscord.get(discordId), b = byProfile.get(profileId)
    a.set(profileId, [...(a.get(profileId) || []), source])
    b.set(discordId, [...(b.get(discordId) || []), source])
  }
  let floor = 0          // the highest id known to be handed out
  let floorFrom = 'none'
  const raise = (id, from) => { if (id > floor) { floor = id; floorFrom = from } }
  const counts = []

  // The current file: fine (nothing to rebuild), missing, or unreadable (salvage what it shows)
  let current = 'missing'
  let text = null
  try { text = fs.readFileSync(target, 'utf8') }
  catch (err) { if (err.code !== 'ENOENT') current = `unreadable (${err.code || err.message})` }
  if (text !== null) {
    let problem
    try { problem = problemOf(JSON.parse(text)) } catch { problem = `is not valid JSON (${Buffer.byteLength(text)} bytes)` }
    current = problem ? `unreadable (${problem})` : 'reads fine'
    if (problem) {
      const found = salvage(text)
      for (const [discordId, profileId] of found.pairs) { add(discordId, profileId, 'the unreadable profiles.json'); raise(profileId, 'the unreadable profiles.json') }
      if (found.nextId) raise(found.nextId - 1, 'the unreadable profiles.json\'s nextId')
      counts.push(`${found.pairs.length} salvaged from the unreadable file${found.nextId ? `, whose nextId was ${found.nextId}` : ''}`)
    }
  }

  const playerFiles = [path.join(opts.data, 'players.json'), ...opts.players]
  for (const file of playerFiles) {
    let rows
    try { rows = readJson(file) }
    catch (err) {
      if (err.code === 'ENOENT' && file === playerFiles[0]) { notes.push(`${file} is not there`); continue }
      throw new Error(`${file} cannot be read (${err.code || err.message}); repair it or leave it out`)
    }
    if (!rows || typeof rows !== 'object' || Array.isArray(rows)) throw new Error(`${file} is not a players.json`)
    let n = 0
    for (const [discordId, row] of Object.entries(rows)) {
      const profileId = Number(row && row.profileId)
      if (!isProfileId(profileId)) continue
      add(discordId, profileId, file)   // players.js keys its records by Discord id
      raise(profileId, file)
      n++
    }
    counts.push(`${n} from ${file}`)
  }

  for (const file of opts.from) {
    let copy
    try { copy = readJson(file) }
    catch (err) { throw new Error(`${file} cannot be read (${err.code || err.message}); repair it or leave it out`) }
    if (!copy || typeof copy !== 'object' || !copy.map || typeof copy.map !== 'object') throw new Error(`${file} is not a profiles.json`)
    let n = 0
    for (const [discordId, profileId] of Object.entries(copy.map)) {
      if (!isProfileId(profileId)) continue
      add(discordId, profileId, file)
      raise(profileId, file)
      n++
    }
    if (isProfileId(copy.nextId)) raise(copy.nextId - 1, `${file}'s nextId`)
    counts.push(`${n} from ${file}${isProfileId(copy.nextId) ? ` (nextId ${copy.nextId})` : ''}`)
  }

  let world = null
  if (opts.state) {
    if (!fs.existsSync(path.join(opts.state, 'changeForms'))) {
      throw new Error(`the world folder ${path.join(opts.state, 'changeForms')} is not there: pass --state <dir>, or --no-state to rely on the margin alone`)
    }
    world = scanWorld(opts.state)
    raise(world.max, `a character in ${world.dir}`)
  } else {
    notes.push('the world was not read (--no-state): only the margin keeps ids that only characters hold out of reach')
  }

  const conflicts = []
  for (const [discordId, ids] of byDiscord) {
    if (ids.size > 1) conflicts.push(`Discord id ${discordId} has profile ids ${[...ids].map(([id, from]) => `${id} (${from.join(', ')})`).join(' and ')}`)
  }
  for (const [profileId, ids] of byProfile) {
    if (ids.size > 1) conflicts.push(`profile id ${profileId} is held by Discord ids ${[...ids].map(([id, from]) => `${id} (${from.join(', ')})`).join(' and ')}`)
  }

  const map = {}
  for (const [discordId, ids] of [...byDiscord].sort((a, b) => [...a[1].keys()][0] - [...b[1].keys()][0])) {
    map[discordId] = [...ids.keys()][0]
  }
  const nextId = floor + 1 + opts.margin
  return { target, current, counts, notes, world, conflicts, map, pairs: Object.keys(map).length, floor, floorFrom, nextId }
}

function rebuild(opts, log = console.log) {
  const p = plan(opts)
  log(`profiles.json: ${p.target} ${p.current}`)
  log(`pairs: ${p.counts.join('; ') || 'none'}`)
  for (const note of p.notes) log(`note: ${note}`)
  if (p.world) log(`world: ${p.world.holders} of ${p.world.files} records in ${p.world.dir} hold a profile id, the highest ${p.world.max}`)
  log(`highest profile id in use: ${p.floor} (${p.floorFrom}); nextId ${p.nextId} = ${p.floor} + 1 + margin ${opts.margin}`)
  if (p.conflicts.length) {
    for (const c of p.conflicts) log(`conflict: ${c}`)
    log('refused: fix or leave out the source that is wrong, then run this again')
    return { ok: false, plan: p }
  }
  if (p.current === 'reads fine') {
    log('nothing to rebuild: profiles.json reads fine, and the backend starts on it')
    return { ok: !opts.write, plan: p }
  }
  if (!p.pairs) {
    log('refused: no Discord id -> profile id pair was found anywhere, so every player would lose their characters. Pass --players or --from')
    return { ok: false, plan: p }
  }
  const data = { nextId: p.nextId, map: p.map }
  const problem = problemOf(data)
  if (problem) { log(`refused: the rebuilt store ${problem}`); return { ok: false, plan: p } }
  if (!opts.write) {
    log(`dry run: would write ${p.target} with ${p.pairs} pairs and nextId ${p.nextId}. Run again with --write`)
    return { ok: true, plan: p }
  }
  let mode
  try { mode = fs.statSync(p.target).mode & 0o777 } catch { /* missing */ }
  if (p.current !== 'missing') {
    const aside = `${p.target}.bad-${Date.now()}`
    fs.renameSync(p.target, aside)
    log(`kept the unreadable file as ${aside}`)
  }
  replaceFile(p.target, JSON.stringify(data, null, 2) + '\n', { durable: true, mode })
  const check = problemOf(readJson(p.target))
  if (check) throw new Error(`${p.target} was written but does not read back: ${check}`)
  log(`wrote ${p.target}: ${p.pairs} pairs, nextId ${p.nextId}. Start the backend; its log should show no FAIL CLOSED line`)
  return { ok: true, plan: p }
}

if (require.main === module) {
  let result
  try { result = rebuild(parseArgs(process.argv.slice(2))) }
  catch (err) { console.error(`rebuild-profiles: ${err.message}`); process.exit(1) }
  process.exit(result.ok ? 0 : 1)
}

module.exports = { parseArgs, salvage, scanWorld, plan, rebuild }
