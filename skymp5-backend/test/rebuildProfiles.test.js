'use strict'
// scripts/rebuild-profiles.js (8 Oct 2026): the way back from an unreadable profiles.json when there is no backup. It must
// keep every pair it can find and set nextId above every profile id in use, the world's characters included, so the next
// new player can never be given an id that already has characters. It writes only with --write, and never over a good file.

const { test, beforeEach, after, mock } = require('node:test')
const assert = require('node:assert/strict')
const fs     = require('fs')
const os     = require('os')
const path   = require('path')
const { parseArgs, salvage, rebuild } = require('../scripts/rebuild-profiles')
const { problemOf } = require('../sources/profiles')

const tmp   = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-profiles-'))
const DATA  = path.join(tmp, 'data')
const WORLD = path.join(tmp, 'world')
const PROFILES = path.join(DATA, 'profiles.json')
after(() => fs.rmSync(tmp, { recursive: true, force: true }))

const json = value => JSON.stringify(value, null, 2) + '\n'
const OWNER = '100000000000000001', TWO = '100000000000000002', THREE = '100000000000000003', FIVE = '100000000000000005'
const STORE = { nextId: 6, map: { [OWNER]: 1, [TWO]: 2, [THREE]: 3, [FIVE]: 5 } }   // 4 was deleted
const row = (discordId, profileId) => ({ profileId, discordId, username: `u${profileId}`, hwid: null, lastIp: null })
// players.json has lost nobody but the deleted player; THREE signed up last, after the newest copy of profiles.json
const PLAYERS = { [OWNER]: row(OWNER, 1), [TWO]: row(TWO, 2), [THREE]: row(THREE, 3), [FIVE]: row(FIVE, 5) }
// The deleted player 4's character is still in the world, and so is an old character of profile 9 from before a reset
const CHARACTERS = { '1.json': 1, '2.json': 4, '3.json': -1, '4.json': 9, '5.json': 5 }

let lines
const log = line => lines.push(line)
const opts = (...argv) => parseArgs(['--data', DATA, '--state', WORLD, ...argv])
beforeEach(() => {
  fs.rmSync(DATA, { recursive: true, force: true })
  fs.rmSync(WORLD, { recursive: true, force: true })
  fs.mkdirSync(DATA, { recursive: true })
  fs.mkdirSync(path.join(WORLD, 'changeForms'), { recursive: true })
  for (const [name, profileId] of Object.entries(CHARACTERS)) {
    fs.writeFileSync(path.join(WORLD, 'changeForms', name), JSON.stringify({ formDesc: name, isDisabled: false, profileId }, null, 2))
  }
  fs.writeFileSync(path.join(DATA, 'players.json'), json(PLAYERS))
  lines = []
})

test('a truncated profiles.json: the dry run says what it would write and writes nothing', () => {
  const cut = json(STORE).slice(0, 70)
  fs.writeFileSync(PROFILES, cut)
  const { ok, plan } = rebuild(opts(), log)
  assert.equal(ok, true)
  assert.equal(fs.readFileSync(PROFILES, 'utf8'), cut)
  assert.deepEqual(fs.readdirSync(DATA).sort(), ['players.json', 'profiles.json'])
  assert.equal(plan.nextId, 9 + 1 + 100, 'above the deleted-and-reset character of profile 9, plus the margin')
  assert.ok(lines.some(l => /dry run: would write .*4 pairs and nextId 110/.test(l)), lines.join('\n'))
})

test('--write: every pair is kept, nextId is above every id in use, the backend reads the file, and the broken one is kept', () => {
  const cut = json(STORE).slice(0, 70)
  fs.writeFileSync(PROFILES, cut)
  fs.chmodSync(PROFILES, 0o640)
  const { ok } = rebuild(opts('--write'), log)
  assert.equal(ok, true, lines.join('\n'))
  const data = JSON.parse(fs.readFileSync(PROFILES, 'utf8'))
  assert.equal(problemOf(data), null)
  assert.deepEqual(data, { nextId: 110, map: { [OWNER]: 1, [TWO]: 2, [THREE]: 3, [FIVE]: 5 } })
  assert.equal(fs.readFileSync(PROFILES, 'utf8'), json(data), 'the format the file has always had')
  assert.equal(fs.statSync(PROFILES).mode & 0o777, 0o640, 'and its mode')
  const kept = fs.readdirSync(DATA).filter(n => /^profiles\.json\.bad-\d+$/.test(n))
  assert.equal(kept.length, 1)
  assert.equal(fs.readFileSync(path.join(DATA, kept[0]), 'utf8'), cut)
  for (const id of [1, 2, 3, 4, 5, 9]) assert.ok(data.nextId > id, `no new player can be given ${id}`)
})

test('the pairs and nextId a cut file still shows are kept, and a number cut short at its end is not taken', () => {
  const text = json({ nextId: 40, map: { [OWNER]: 1, '100000000000000039': 39, [TWO]: 2 } })
  const cutInNumber = text.slice(0, text.indexOf(': 2') + 2)   // ends in `"<TWO>": ` before its digit
  assert.deepEqual(salvage(text), { pairs: [[OWNER, 1], ['100000000000000039', 39], [TWO, 2]], nextId: 40 })
  assert.deepEqual(salvage(cutInNumber).pairs, [[OWNER, 1], ['100000000000000039', 39]])
  const key39 = '"100000000000000039": '
  assert.deepEqual(salvage(text.slice(0, text.indexOf(key39) + key39.length + 1)), { pairs: [[OWNER, 1]], nextId: 40 }, '39 cut to 3 is not taken')
  fs.writeFileSync(PROFILES, cutInNumber)
  const { ok, plan } = rebuild(opts('--write'), log)
  assert.equal(ok, true, lines.join('\n'))
  assert.equal(plan.nextId, 40 + 100, 'the old nextId (40) is a floor: ids up to 39 were handed out')
  assert.equal(JSON.parse(fs.readFileSync(PROFILES, 'utf8')).map['100000000000000039'], 39, 'a pair only the broken file had')
})

test('an older copy (--from) adds its pairs, its nextId is a floor, and it is never put back as it is', () => {
  fs.writeFileSync(PROFILES, '')
  const older = path.join(tmp, 'profiles-older.json')
  fs.writeFileSync(older, json({ nextId: 30, map: { [OWNER]: 1, [TWO]: 2, '100000000000000029': 29 } }))
  const { ok, plan } = rebuild(opts('--from', older, '--margin', '0', '--write'), log)
  assert.equal(ok, true, lines.join('\n'))
  assert.equal(plan.nextId, 30)
  assert.deepEqual(JSON.parse(fs.readFileSync(PROFILES, 'utf8')).map, { [OWNER]: 1, [TWO]: 2, [THREE]: 3, [FIVE]: 5, '100000000000000029': 29 })
})

test('a Discord id with two profile ids, or a profile id with two Discord ids, is refused and nothing is written', () => {
  fs.writeFileSync(PROFILES, '{')
  const older = path.join(tmp, 'profiles-conflict.json')
  fs.writeFileSync(older, json({ nextId: 8, map: { [THREE]: 7, '100000000000000077': 5 } }))
  const { ok, plan } = rebuild(opts('--from', older, '--write'), log)
  assert.equal(ok, false)
  assert.equal(plan.conflicts.length, 2, plan.conflicts.join('\n'))
  assert.ok(lines.some(l => l.includes(`Discord id ${THREE} has profile ids 3`)), lines.join('\n'))
  assert.ok(lines.some(l => l.includes('profile id 5 is held by Discord ids')), lines.join('\n'))
  assert.equal(fs.readFileSync(PROFILES, 'utf8'), '{')
  assert.deepEqual(fs.readdirSync(DATA).sort(), ['players.json', 'profiles.json'])
})

test('a profiles.json that reads fine is never written over', () => {
  fs.writeFileSync(PROFILES, json(STORE))
  assert.equal(rebuild(opts(), log).ok, true)
  assert.equal(rebuild(opts('--write'), log).ok, false)
  assert.ok(lines.some(l => l.includes('nothing to rebuild')))
  assert.equal(fs.readFileSync(PROFILES, 'utf8'), json(STORE))
  assert.deepEqual(fs.readdirSync(DATA).sort(), ['players.json', 'profiles.json'])
})

test('a missing world folder stops it unless --no-state says so; with no pair found anywhere it refuses', () => {
  fs.writeFileSync(PROFILES, '')
  fs.rmSync(WORLD, { recursive: true })
  assert.throws(() => rebuild(opts('--write'), log), /world folder .* is not there: pass --state <dir>, or --no-state/)
  const { ok, plan } = rebuild(parseArgs(['--data', DATA, '--no-state', '--write']), log)
  assert.equal(ok, true, lines.join('\n'))
  assert.equal(plan.nextId, 5 + 1 + 100)
  fs.rmSync(path.join(DATA, 'players.json'))
  fs.rmSync(PROFILES)
  fs.writeFileSync(PROFILES, '')
  assert.equal(rebuild(parseArgs(['--data', DATA, '--no-state', '--write']), log).ok, false)
  assert.ok(lines.some(l => l.includes('no Discord id -> profile id pair was found')))
})

test('the rebuilt file is saved durably (fsynced before and after the rename)', () => {
  fs.writeFileSync(PROFILES, '')
  const synced = []
  const fsync = fs.fsyncSync
  mock.method(fs, 'fsyncSync', fd => { synced.push(fs.fstatSync(fd).isDirectory() ? 'dir' : 'file'); return fsync(fd) })
  try { assert.equal(rebuild(opts('--write'), log).ok, true) } finally { mock.restoreAll() }
  assert.deepEqual(synced, ['file', 'dir'])
})
