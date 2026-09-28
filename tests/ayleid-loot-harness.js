// Ayleid treasure in the expedition ruins (Nate, 2026-09-28: "ayleid weapons and armor found in the ayleid ruins").
// 1. ayleid-loot.json is what the plugins say: tools/ayleid_loot.py is run again against /opt/skyrim-data (skipped when
//    the plugins are not there) and must give the same file; every piece is a playable WEAP or ARMO with a tier.
// 2. The real dungeons.js claims an expedition ruin with 3000 big chests and 1000 boss chests (loot.json empty, so only
//    the Ayleid pool can put anything in them) and the rates and tiers hold.
// 3. An ordinary dungeon gets none of it, Bruma's own Ayleid ruins only with ayleidLoot.ruins "all", and a banned
//    editor id never drops.
//   node tests/ayleid-loot-harness.js   (from server/)
'use strict';
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

// ---- 2. an expedition ruin: rates and tiers ---------------------------------------------------------------------------
{
  const big = chestsOf('a', 3000, 'CYRTreasAyleidChest', RUIN), boss = chestsOf('b', 1000, 'CYRTreasAyleidChestBoss', RUIN);
  const h = load({}, () => {
    fs.writeFileSync('dungeons.json', JSON.stringify({ dungeons: [] }));
    fs.writeFileSync('expeditions.json', JSON.stringify({ expeditions: [{ id: 'Ruin', name: 'Ruin', type: 'ayleid', county: '', cells: [{ desc: RUIN }], chests: big.concat(boss), zones: [],
      entrances: [{ expedition: true, cell: SYNOD, pos: [0, 0, 0], rot: [0, 0, 0], doorPos: [0, 0, 0], insideDesc: 'ef1ad:BSHeartland.esm', insideCell: RUIN, insidePos: [0, 0, 0], insideRot: [0, 0, 0] }] }] }));
  });
  globalThis.__dboDungeonActivate(idOf('boardref'), A); h.fire('expeditionPick', A, ['Ruin']);
  const pend = globalThis.__dboDungeons.pending.get(A);
  if (pend) h.fire('dungeonClaim', A, [pend.nonce, 'hard']);
  const bigPieces = piecesIn(h.props, big), bossPieces = piecesIn(h.props, boss);
  const inBig = bigPieces.filter((l) => l.length).map((l) => l[0]), inBoss = bossPieces.filter((l) => l.length).map((l) => l[0]);
  check('the claim went through and filled the chests', !!pend && big.some((ch) => h.props.get(`${idOf(ch.ref)}|inventory`)));
  check('never more than one Ayleid piece in a chest', bigPieces.concat(bossPieces).every((l) => l.length <= 1));
  check(`a big chest holds one ${(100 * inBig.length / 3000).toFixed(1)}% of the time (15% expected)`, inBig.length >= 3000 * 0.12 && inBig.length <= 3000 * 0.18, inBig.length);
  check(`every boss chest holds one (${inBoss.length}/1000)`, inBoss.length === 1000);
  const t = (list, tier) => share(list, (it) => it.tier === tier);
  check(`big chests: common ${(100 * t(inBig, 'common')).toFixed(0)}% (70), uncommon ${(100 * t(inBig, 'uncommon')).toFixed(0)}% (25), rare ${(100 * t(inBig, 'rare')).toFixed(0)}% (5)`,
    Math.abs(t(inBig, 'common') - 0.70) < 0.08 && Math.abs(t(inBig, 'uncommon') - 0.25) < 0.07 && t(inBig, 'rare') < 0.10);
  check('an ordinary big chest never holds the rarest (Eminent jewellery, the Lich Helmet)', t(inBig, 'rarest') === 0);
  check(`boss chests: common ${(100 * t(inBoss, 'common')).toFixed(0)}% (25), uncommon ${(100 * t(inBoss, 'uncommon')).toFixed(0)}% (40), rare ${(100 * t(inBoss, 'rare')).toFixed(0)}% (25), rarest ${(100 * t(inBoss, 'rarest')).toFixed(0)}% (10)`,
    Math.abs(t(inBoss, 'common') - 0.25) < 0.06 && Math.abs(t(inBoss, 'uncommon') - 0.40) < 0.06 && Math.abs(t(inBoss, 'rare') - 0.25) < 0.06 && Math.abs(t(inBoss, 'rarest') - 0.10) < 0.04);
  check('weapons, clothing and jewellery all turn up', ['weapon', 'apparel', 'jewelry'].every((g) => inBig.concat(inBoss).some((it) => it.group === g)));
  check('the Lich Helmet can come from a boss chest', inBoss.some((it) => it.name === 'BSKArmorAyleidLichHelmet') || inBoss.filter((it) => it.tier === 'rarest').length < 40);
  h.done();
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
  check('...and join in with ayleidLoot.ruins "all"', vAll.pieces.length > 100, vAll.pieces.length);
  const off = run({ ayleidLoot: { enabled: false, ruins: 'all' } }, vil());
  check('ayleidLoot.enabled false turns it off', off.pieces.length === 0);
  const banned = run({ ayleidLoot: { ruins: 'all' }, bannedLoot: 'Ebony|Daedric|Ayleid04$|LichHelmet' }, vil());
  check('a banned editor id (bannedLoot) never drops', banned.pieces.length > 0 && !banned.pieces.some((it) => /Ayleid04$|LichHelmet/.test(it.name)));
}

console.log(failures ? `${failures} FAILED` : 'all checks passed');
process.exit(failures ? 1 : 0);
