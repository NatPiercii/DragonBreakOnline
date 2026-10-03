// Ayleid treasure in the expedition ruins (Nate, 2026-09-28: "ayleid weapons and armor found in the ayleid ruins").
// 1. ayleid-loot.json is what the plugins say: tools/ayleid_loot.py is run again against /opt/skyrim-data (skipped when
//    the plugins are not there) and must give the same file; every piece is a playable WEAP or ARMO with a tier.
// 2. The real dungeons.js claims an expedition ruin at each difficulty (loot.json empty, so only the Ayleid table can put
//    anything in the chests): the rates and tiers of dungeons.ayleidLoot.byDifficulty hold, the low difficulties never
//    give Major or Eminent jewellery or the Lich Helmet, the general pools never hand the pieces out, and potions are
//    measured down against their old rates.
// 3. An ordinary dungeon gets none of it, Bruma's own Ayleid ruins only with ayleidLoot.ruins "all", and a banned
//    editor id never drops.
//   node tests/ayleid-loot-harness.js   (from server/)
'use strict';
// Seeded rolls (mulberry32), so a rate check is the same on every run: an unseeded one missed its threshold now and then
// (10.3% strong against < 10%, 3 Oct). AYLEID_SEED picks another sequence.
{
  let t = (Number(process.env.AYLEID_SEED) || 0x1003) >>> 0;
  Math.random = () => { t = (t + 0x6d2b79f5) >>> 0; let r = Math.imul(t ^ (t >>> 15), 1 | t); r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r; return ((r ^ (r >>> 14)) >>> 0) / 4294967296; };
}
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
let failures = 0;
const check = (label, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${got !== undefined && !ok ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };
const POOL = JSON.parse(fs.readFileSync(path.join(ROOT, 'ayleid-loot.json'), 'utf8')).items;

// ---- 1. the pool is the plugins' own records -------------------------------------------------------------------------
{
  check('the pool holds pieces of every tier', ['common', 'uncommon', 'rare', 'rarest'].every((t) => POOL.some((it) => it.tier === t)), POOL.length);
  check('every piece is a WEAP or ARMO with a plugin id and a group', POOL.every((it) => /^[0-9a-f]+:.+\.es[mp]$/i.test(it.id) && (it.type === 'WEAP' || it.type === 'ARMO') && ['weapon', 'apparel', 'jewelry'].includes(it.group)));
  check('no staff template or quest reward', !POOL.some((it) => /Template|Reward/.test(it.name)));
  check('the rarest are the Eminent jewellery and the Lich Helmet', POOL.filter((it) => it.tier === 'rarest').every((it) => /Ayleid04$/.test(it.name) || it.name === 'BSKArmorAyleidLichHelmet'));
  check('the common are unenchanted', POOL.filter((it) => it.tier === 'common').every((it) => !it.enchanted));
  const DATA = '/opt/skyrim-data';
  let readable = false; try { fs.accessSync(path.join(DATA, 'BSHeartland.esm'), fs.constants.R_OK); readable = true; } catch (e) { /* not on this machine */ }
  if (!readable) console.log('SKIP  re-reading the plugins: /opt/skyrim-data is not readable here');
  else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-ayleid-gen-'));
    fs.copyFileSync(path.join(ROOT, 'admin-items.json'), path.join(dir, 'admin-items.json'));
    const r = spawnSync('python3', [path.join(ROOT, 'tools', 'ayleid_loot.py'), DATA], { cwd: dir, encoding: 'utf8' });
    const again = r.status === 0 ? fs.readFileSync(path.join(dir, 'ayleid-loot.json'), 'utf8') : '';
    check('tools/ayleid_loot.py re-read from the plugins gives the committed file exactly', again === fs.readFileSync(path.join(ROOT, 'ayleid-loot.json'), 'utf8'), r.stderr || r.stdout);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---- the real dungeons.js with a mock gamemode ----------------------------------------------------------------------
const ids = new Map(); let nextId = 0x100;
const idOf = (d) => { const k = String(d).toLowerCase(); if (!ids.has(k)) ids.set(k, nextId++); return ids.get(k); };
const RUIN = 'ef1aa:BSHeartland.esm', SYNOD = '20ff:BSHeartland.esm', CAVE = 'c0ffe:Skyrim.esm', VILVERIN = 'b1111:BSHeartland.esm';
const A = 0x14, BOARD = 0x3413a556;
const load = (cfgDungeons, setup) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-ayleid-'));
  const here = process.cwd();
  process.chdir(dir);
  fs.writeFileSync('loot.json', JSON.stringify({ pools: {} }));
  fs.copyFileSync(path.join(ROOT, 'ayleid-loot.json'), 'ayleid-loot.json');
  setup();
  const props = new Map([[`${idOf('boardref')}|baseDesc`, '6:DragonBreak.esp'], [`${A}|worldOrCellDesc`, SYNOD], [`${A}|pos`, [0, 0, 0]]]);
  const ui = new Map();
  const savedTimeout = global.setTimeout; global.setTimeout = () => 0;
  globalThis.__dboDungeons = undefined; globalThis.__dboExpeditionPending = undefined;
  delete require.cache[path.join(ROOT, 'dungeons.js')];
  require(path.join(ROOT, 'dungeons.js'))({
    mp: { get: (id, p) => (p === 'profileId' ? (id === A ? 1 : -1) : props.get(`${id}|${p}`)), set: (id, p, v) => props.set(`${id}|${p}`, v),
      getIdFromDesc: idOf, lookupEspmRecordById: (id) => (id === idOf('6:DragonBreak.esp') ? { record: { editorId: 'ExpeditionBoard' } } : { record: null }) },
    log: () => {}, personal: () => {}, system: () => {}, audit: () => {}, registerChatCommand: () => {}, onUi: (n, fn) => { const l = ui.get(n) || []; l.push(fn); ui.set(n, l); },
    openWidget: () => true, closeWidget: () => true, sendPacket: () => true, findByName: () => 0, display: String, who: String,
    profileOf: (a) => (a === A ? 1 : -1), nameOf: () => 'P', onlineActors: () => [A], isAdmin: () => false, giveItem: () => true,
    cfg: { dungeons: cfgDungeons }, every: () => {},
  });
  const fire = (n, a, args) => (ui.get(n) || []).forEach((f) => f(a, args, 0));
  const claim = (activateId, diffId) => {
    globalThis.__dboDungeonActivate(activateId, A);
    const pend = globalThis.__dboDungeons.pending.get(A);
    if (pend) fire('dungeonClaim', A, [pend.nonce, diffId]);
    return !!pend;
  };
  const done = () => { global.setTimeout = savedTimeout; process.chdir(here); fs.rmSync(dir, { recursive: true, force: true }); };
  return { props, fire, claim, done };
};
const poolById = new Map(POOL.map((it) => [idOf(it.id), it]));
const piecesIn = (props, chests) => chests.map((ch) => ((props.get(`${idOf(ch.ref)}|inventory`) || { entries: [] }).entries).filter((e) => poolById.has(e.baseId)).map((e) => poolById.get(e.baseId)));
const chestsOf = (prefix, n, edid, cell) => { const out = []; for (let i = 0; i < n; i++) out.push({ ref: `${prefix}${i.toString(16)}:BSHeartland.esm`, edid, cell, pos: [0, 0, 0], big: true }); return out; };
const share = (list, pred) => list.filter(pred).length / Math.max(1, list.length);

// ---- 2. an expedition ruin at each difficulty: rates and tiers ---------------------------------------------------------
// Nate, 2026-09-28 (an Eminent amulet on his first run): by the lease's difficulty. Novice common only, Adept up to
// uncommon, Major (rare) from Expert, Eminent and the Lich Helmet (rarest) from a Master boss chest only.
const claimRuin = (diffId, nBig, nBoss, cfgDungeons = {}, lootFile = null) => {
  const big = chestsOf('a', nBig, 'CYRTreasAyleidChest', RUIN), boss = chestsOf('b', nBoss, 'CYRTreasAyleidChestBoss', RUIN);
  const h = load(cfgDungeons, () => {
    if (lootFile) fs.copyFileSync(lootFile, 'loot.json');
    fs.writeFileSync('dungeons.json', JSON.stringify({ dungeons: [] }));
    fs.writeFileSync('expeditions.json', JSON.stringify({ expeditions: [{ id: 'Ruin', name: 'Ruin', type: 'ayleid', county: '', cells: [{ desc: RUIN }], chests: big.concat(boss), zones: [],
      entrances: [{ expedition: true, cell: SYNOD, pos: [0, 0, 0], rot: [0, 0, 0], doorPos: [0, 0, 0], insideDesc: 'ef1ad:BSHeartland.esm', insideCell: RUIN, insidePos: [0, 0, 0], insideRot: [0, 0, 0] }] }] }));
  });
  globalThis.__dboDungeonActivate(idOf('boardref'), A); h.fire('expeditionPick', A, ['Ruin']);
  const pend = globalThis.__dboDungeons.pending.get(A);
  if (pend) h.fire('dungeonClaim', A, [pend.nonce, diffId]);
  const inv = (ch) => (h.props.get(`${idOf(ch.ref)}|inventory`) || { entries: [] }).entries;
  const r = { claimed: !!pend, big: big.map(inv), boss: boss.map(inv), bigPieces: piecesIn(h.props, big), bossPieces: piecesIn(h.props, boss) };
  h.done();
  return r;
};
const EXPECT = {   // the defaults in dungeons.js (AYLEID_DEFAULTS) and gamemode-config.json dungeons.ayleidLoot.byDifficulty
  story: { chest: 0.03, boss: 0.3, tiers: ['common'] },
  normal: { chest: 0.05, boss: 0.5, tiers: ['common', 'uncommon'] },
  hard: { chest: 0.07, boss: 0.7, tiers: ['common', 'uncommon', 'rare'] },
  nightmare: { chest: 0.09, boss: 0.85, tiers: ['common', 'uncommon', 'rare', 'rarest'] },
};
const cfgDungeons = JSON.parse(fs.readFileSync(path.join(ROOT, 'gamemode-config.json'), 'utf8')).dungeons;
const cfgTable = cfgDungeons.ayleidLoot.byDifficulty;
// Expedition loot is trimmed (dungeons.expeditionLoot, 2026-09-28): every Ayleid chance is ayleidScale as likely
const AS = Number(cfgDungeons.expeditionLoot.ayleidScale);
check('gamemode-config.json carries the per-difficulty table with these rates', Object.keys(EXPECT).every((k) => cfgTable[k] && cfgTable[k].chestChance === EXPECT[k].chest && cfgTable[k].bossChance === EXPECT[k].boss));
for (const [diffId, e] of Object.entries(EXPECT)) {
  const r = claimRuin(diffId, 4000, 2000, { ayleidLoot: { byDifficulty: cfgTable }, expeditionLoot: cfgDungeons.expeditionLoot });
  const inBig = r.bigPieces.filter((l) => l.length).map((l) => l[0]), inBoss = r.bossPieces.filter((l) => l.length).map((l) => l[0]);
  const pb = inBig.length / 4000, pB = inBoss.length / 2000;
  check(`${diffId}: claimed; at most one piece a chest`, r.claimed && r.bigPieces.concat(r.bossPieces).every((l) => l.length <= 1));
  check(`${diffId}: a big chest holds one ${(100 * pb).toFixed(1)}% (${(100 * e.chest * AS).toFixed(1)}), a boss chest ${(100 * pB).toFixed(1)}% (${(100 * e.boss * AS).toFixed(1)})`, Math.abs(pb - e.chest * AS) < 0.012 && Math.abs(pB - e.boss * AS) < 0.04);
  const tiers = [...new Set(inBig.concat(inBoss).map((it) => it.tier))];
  check(`${diffId}: only the tiers ${e.tiers.join(', ')} (got ${tiers.join(', ')})`, tiers.every((t) => e.tiers.includes(t)));
  if (diffId !== 'nightmare') check(`${diffId}: never Eminent jewellery or the Lich Helmet`, !inBig.concat(inBoss).some((it) => /Ayleid04$/.test(it.name) || it.name === 'BSKArmorAyleidLichHelmet'));
  if (diffId === 'story' || diffId === 'normal') check(`${diffId}: never Major jewellery either`, !inBig.concat(inBoss).some((it) => /Ayleid03$/.test(it.name)));
  if (diffId === 'nightmare') check('nightmare: the rarest only from boss chests', !inBig.some((it) => it.tier === 'rarest') && inBoss.some((it) => it.tier === 'rarest'));
}
// The general pools never hand out a table piece: a loot.json full of Ayleid gear yields none at Novice but the table's
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-ayleid-pools-'));
  const f = path.join(dir, 'loot.json');
  fs.writeFileSync(f, JSON.stringify({ pools: { armor: POOL.filter((it) => it.type === 'ARMO').map((it) => ({ id: it.id, name: it.name, value: 0 })),
    ench_armor: POOL.filter((it) => it.type === 'ARMO').map((it) => ({ id: it.id, name: it.name, value: 0 })),
    weapons: POOL.filter((it) => it.type === 'WEAP').map((it) => ({ id: it.id, name: it.name, value: 0 })),
    ench_weapons: POOL.filter((it) => it.type === 'WEAP').map((it) => ({ id: it.id, name: it.name, value: 0 })) } }));
  const r = claimRuin('story', 2000, 1000, { ayleidLoot: { enabled: false } }, f);
  check('general pools full of Ayleid gear hand out none of it (the table is the only source)', r.bigPieces.concat(r.bossPieces).every((l) => l.length === 0));
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- potions (Nate, 2026-09-28: "potions need to be less common") ----------------------------------------------------
// Before: a big chest held potions 44% of the time (0.66 a chest), a boss chest always (2.2), an urn 15%; at Master a
// third of them were strong (rank 4+ or 75/100). Measured here with the real loot.json.
{
  const loot = JSON.parse(fs.readFileSync(path.join(ROOT, 'loot.json'), 'utf8'));
  const potion = new Map((loot.pools.potions || []).map((p) => [idOf(p.id), p.name]));
  const strong = (name) => { const m = /(\d+)$/.exec(name); const n = m ? Number(m[1]) : 1; return (n >= 4 && n < 25) || n >= 75; };
  const r = claimRuin('nightmare', 4000, 2000, { expeditionLoot: cfgDungeons.expeditionLoot }, path.join(ROOT, 'loot.json'));
  // In an expedition the chances are also times the trim (expeditionLoot.scale, bossScale at Master)
  const xs = Number(cfgDungeons.expeditionLoot.scale.nightmare), xb = Number(cfgDungeons.expeditionLoot.bossScale.nightmare);
  const count = (list) => { let chests = 0, n = 0, s = 0; for (const e of list) { const p = e.filter((x) => potion.has(x.baseId)); if (p.length) chests++; for (const x of p) { n += x.count; if (strong(potion.get(x.baseId))) s += x.count; } } return { share: chests / list.length, per: n / list.length, strong: n ? s / n : 0 }; };
  const b = count(r.big), B = count(r.boss);
  check(`potions: a big chest ${(100 * b.share).toFixed(1)}% (was 44%, now 20% x ${xs}), ${b.per.toFixed(2)} a chest (was 0.66)`, Math.abs(b.share - 0.2 * xs) < 0.02 && b.per <= 0.23 * xs);
  check(`potions: a boss chest ${(100 * B.share).toFixed(1)}% (was 100%, now 60% x ${xb}), ${B.per.toFixed(2)} a chest (was 2.2)`, Math.abs(B.share - 0.6 * xb) < 0.04 && B.per <= 0.65 * xb);
  check(`potions at Master: ${(100 * (b.strong)).toFixed(1)}% strong (was 33%)`, b.strong < 0.1 && B.strong < 0.1);
}

// ---- 3. ordinary dungeons, Bruma's Ayleid ruins, and the ban ----------------------------------------------------------
const doorDungeon = (id, name, type, cell, keywords, chests) => ({ id, name, type, keywords, cells: [{ desc: cell }], chests, zones: [],
  entrances: [{ outsideDesc: `${id}-out:Skyrim.esm`, insideDesc: `${id}-in:Skyrim.esm`, world: SYNOD, cell: SYNOD, pos: [0, 0, 0], rot: [0, 0, 0], doorPos: [0, 0, 0], insideCell: cell, insidePos: [0, 0, 0], insideRot: [0, 0, 0] }] });
const run = (cfgDungeons, d) => {
  const h = load(cfgDungeons, () => {
    fs.writeFileSync('dungeons.json', JSON.stringify({ dungeons: [d] }));
    fs.writeFileSync('expeditions.json', JSON.stringify({ expeditions: [] }));
  });
  const claimed = h.claim(idOf(d.entrances[0].outsideDesc), 'nightmare');
  const pieces = piecesIn(h.props, d.chests).flat();
  const filled = d.chests.some((ch) => h.props.get(`${idOf(ch.ref)}|inventory`));
  h.done();
  return { claimed, filled, pieces };
};
{
  const cave = run({}, doorDungeon('CaveX', 'A Cave', 'cave', CAVE, ['LocSetCave'], chestsOf('c', 500, 'TreasBanditChest', CAVE).concat(chestsOf('d', 200, 'TreasBanditChestBoss', CAVE))));
  check('an ordinary dungeon is claimed and filled', cave.claimed && cave.filled);
  check('...and gets no Ayleid treasure', cave.pieces.length === 0, cave.pieces.length);
  const vil = () => doorDungeon('CYRVilverinLocation', 'Vilverin', 'cave', VILVERIN, ['LocSetCave'], chestsOf('e', 500, 'CYRTreasAyleidChest', VILVERIN).concat(chestsOf('f', 100, 'CYRTreasAyleidChestBoss', VILVERIN)));
  const vDefault = run({}, vil());
  check("Bruma's own Ayleid ruins keep their loot by default (ayleidLoot.ruins \"expeditions\")", vDefault.claimed && vDefault.filled && vDefault.pieces.length === 0, vDefault.pieces.length);
  const vAll = run({ ayleidLoot: { ruins: 'all' } }, vil());
  check('...and join in with ayleidLoot.ruins "all"', vAll.pieces.length > 50, vAll.pieces.length);
  const off = run({ ayleidLoot: { enabled: false, ruins: 'all' } }, vil());
  check('ayleidLoot.enabled false turns it off', off.pieces.length === 0);
  const banned = run({ ayleidLoot: { ruins: 'all' }, bannedLoot: 'Ebony|Daedric|Ayleid04$|LichHelmet' }, vil());
  check('a banned editor id (bannedLoot) never drops', banned.pieces.length > 0 && !banned.pieces.some((it) => /Ayleid04$|LichHelmet/.test(it.name)));
}

console.log(failures ? `${failures} FAILED` : 'all checks passed');
process.exit(failures ? 1 : 0);
