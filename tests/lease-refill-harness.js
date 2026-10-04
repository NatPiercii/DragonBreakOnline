// A new claim finds its dungeon stocked (G64E, 4 Oct: back to back Adept claims of Telepe, "no loot from locked chests"
// and every coin purse "emptied not long ago"). Two parts:
//   1. The real dungeons.js, loot.json and expeditions.json: Telepe and Niryastare claimed many times at every
//      difficulty (Novice locks none) with every big chest locked (dungeons.lockedShare 1). A locked chest never opens on nothing: it rolls
//      again, coin last (before the fix an Adept claim's locked chests were empty 28-38% of the time).
//   2. __dboLeaseStartedAt: the claim's start for an actor inside a claimed dungeon, else 0; gamemode.js's coin purse
//      counts a rest set before that start as over.
//   node tests/lease-refill-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got).slice(0, 600)}`); if (!c) fails++; };
const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
const DIFFS = ['story', 'normal', 'hard', 'nightmare'];
let rng = 0;
const reseed = (key) => { let h = 2166136261; for (const c of String(key)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); rng = h >>> 0; };
Math.random = () => { rng = (rng + 0x6d2b79f5) >>> 0; let t = Math.imul(rng ^ (rng >>> 15), rng | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

const LOOT = read('loot.json').pools;
const ids = new Map(), descs = new Map(); let nextId = 0x100;
const idOf = (d) => { const k = String(d).toLowerCase(); if (!ids.has(k)) { ids.set(k, nextId); descs.set(nextId, k); nextId++; } return ids.get(k); };
const REC = new Map();
const recType = { weapons: 'WEAP', armor: 'ARMO', ench_weapons: 'WEAP', ench_armor: 'ARMO', arrows: 'AMMO', potions: 'ALCH', ingredients: 'INGR', gems: 'MISC', materials: 'MISC', soulgems: 'SLGM', lockpicks: 'MISC', lights: 'LIGH', recipes: 'BOOK' };
for (const [pool, list] of Object.entries(LOOT)) for (const it of list) REC.set(idOf(it.id), { type: recType[pool] || 'MISC', editorId: it.name, flags: 0, fields: /^ench_/.test(pool) ? [{ type: 'EITM' }] : [] });
const EXP = read('expeditions.json').expeditions.filter((d) => /Telepe|Niryastare/.test(d.id));
const A = 0x14;
const cfg = read('gamemode-config.json');
const LOCK_ALL = { story: 1, normal: 1, hard: 1, nightmare: 1 };

const tally = {};   // diff -> [locked chests, empty]
let leaseSeen = null, startedFor = { inside: -1, outside: -1 };
for (const d of EXP) for (const diff of DIFFS) {
  reseed(`${d.id}|${diff}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-refill-'));
  const here = process.cwd(); process.chdir(dir);
  for (const f of ['loot.json', 'ayleid-loot.json', 'dungeon-pools.json', 'artifacts.json', 'dragon-materials.json']) { try { fs.copyFileSync(path.join(ROOT, f), f); } catch (e) { /* optional */ } }
  fs.writeFileSync('expeditions.json', JSON.stringify({ expeditions: [d] }));
  fs.writeFileSync('dungeons.json', JSON.stringify({ dungeons: [] }));
  const props = new Map([[`${idOf('boardref')}|baseDesc`, '6:DragonBreak.esp']]);
  const setHome = () => { props.set(`${A}|worldOrCellDesc`, 'f8d:BSHeartland.esm'); props.set(`${A}|pos`, [0, -500, -221]); };
  setHome();
  const ui = new Map(), cmds = new Map();
  const savedTimeout = global.setTimeout; global.setTimeout = () => 0;
  globalThis.__dboDungeons = undefined; globalThis.__dboExpeditionPending = undefined;
  const modulePath = path.join(ROOT, 'dungeons.js');
  delete require.cache[modulePath];
  require(modulePath)({
    mp: { get: (id, p) => (p === 'profileId' ? (id === A ? 1 : -1) : props.get(`${id}|${p}`)), set: (id, p, v) => props.set(`${id}|${p}`, v), getIdFromDesc: idOf, getDescFromId: (id) => descs.get(id),
      lookupEspmRecordById: (id) => (id === idOf('6:DragonBreak.esp') ? { record: { editorId: 'ExpeditionBoard' } } : REC.has(id) ? { record: REC.get(id) } : { record: null }) },
    log: () => {}, personal: () => {}, system: () => {}, audit: () => {}, registerChatCommand: (n, fn) => cmds.set(n, fn), onUi: (n, fn) => { const l = ui.get(n) || []; l.push(fn); ui.set(n, l); },
    openWidget: () => true, closeWidget: () => true, sendPacket: () => true, findByName: () => 0, display: String, who: String, profileOf: (a) => (a === A ? 1 : -1), nameOf: () => 'P',
    onlineActors: () => [A], isAdmin: () => true, giveItem: () => true, cfg: { dungeons: Object.assign({}, cfg.dungeons || {}, { lockedShare: LOCK_ALL }) }, every: () => {},
  });
  const fire = (n, a, args) => (ui.get(n) || []).forEach((f) => f(a, args, 0));
  const named = new Set([].concat(d.bossChest || []).map((r) => String(r).toLowerCase()));
  for (let c = 0; c < 30; c++) {
    setHome(); props.delete(`${A}|private.dungeonCooldowns`); if (globalThis.__dboDungeonAccountRest) globalThis.__dboDungeonAccountRest.clear();
    globalThis.__dboDungeonActivate(idOf('boardref'), A); fire('expeditionPick', A, [d.id]);
    const pend = globalThis.__dboDungeons.pending.get(A); if (pend) fire('dungeonClaim', A, [pend.nonce, diff]);
    const lease = globalThis.__dboDungeons.leases.get(d.id); if (!lease) break;
    for (const ch of d.chests || []) {
      const id = idOf(ch.ref);
      if (!ch.big || /boss/i.test(ch.edid) || named.has(String(ch.ref).toLowerCase()) || !lease.locked.has(id)) continue;
      const t = tally[diff] = tally[diff] || [0, 0]; t[0]++;
      if (!((props.get(`${id}|inventory`) || { entries: [] }).entries || []).length) t[1]++;
    }
    if (!leaseSeen) {
      leaseSeen = lease;
      const started = () => (typeof globalThis.__dboLeaseStartedAt === 'function' ? globalThis.__dboLeaseStartedAt(A) : -1);
      startedFor.outside = started();
      const cell = (d.cells || [])[0];
      props.set(`${A}|worldOrCellDesc`, cell && cell.desc);
      startedFor.inside = started();
    }
    cmds.get('dungeon')(A, `end ${d.id.toLowerCase()}`);
  }
  global.setTimeout = savedTimeout; process.chdir(here); fs.rmSync(dir, { recursive: true, force: true });
}

// ---- 1 -------------------------------------------------------------------------------------------------------------
ok(!tally.story, 'Novice locks no chest (its blurb: no locked chests)', tally.story);
for (const diff of DIFFS.slice(1)) {
  const t = tally[diff] || [0, 0];
  ok(t[0] >= 50 && t[1] === 0, `${diff}: ${t[0]} locked chests over Telepe and Niryastare, none empty`, t);
}

// ---- 2 -------------------------------------------------------------------------------------------------------------
ok(typeof globalThis.__dboLeaseStartedAt === 'function', 'dungeons.js exposes __dboLeaseStartedAt');
ok(leaseSeen && startedFor.inside === leaseSeen.startedAt && startedFor.inside > 0, 'inside a claimed dungeon: the claim\'s start', startedFor);
ok(startedFor.outside === 0, 'outside it: 0', startedFor);
const GM = fs.readFileSync(path.join(ROOT, 'gamemode.js'), 'utf8');
const purse = GM.slice(GM.indexOf('globalThis.__dboCoinPurse = '), GM.indexOf('// ---- Beyond Skyrim activators'));
ok(/__dboLeaseStartedAt\(casterId\)/.test(purse) && /until - PURSE\.restMinutes \* 60000 < leaseAt/.test(purse) && /until > Date\.now\(\) && !emptiedBeforeClaim/.test(purse),
  'gamemode.js: a purse emptied before the claim began is full again for the new party');

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
