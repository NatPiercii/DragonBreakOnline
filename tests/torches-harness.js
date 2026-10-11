// Torches (Nate, 2026-09-28: the expedition ruins are too dark): a carryable torch placed in the world can be taken on a
// timer (gamemode.js blockPlacedPickup, lifted out of the file), expedition and dungeon chests hold a torch only rarely and
// one at most (the real dungeons.js, a claimed ruin with 1000 big chests, and a raid's boss chests), and the F7 item spawner lists the torch, the Draught of
// Revival and its recipe (admin-items.json).
//   node tests/torches-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let failures = 0;
const check = (label, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${got !== undefined && !ok ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

// ---- 1. picking a torch up (the pick-up block of gamemode.js) --------------------------------------------------------
{
  const src = fs.readFileSync(path.join(ROOT, 'gamemode.js'), 'utf8');
  const START = '// Nothing placed by a plugin can be picked up';
  const END = "// A hold's treasury chest is paid into at a bank";
  const from = src.indexOf(START), to = src.indexOf(END);
  check('the pick-up block is found in gamemode.js', from > 0 && to > from);
  const light = (flags) => { const d = new Uint8Array(48); new DataView(d.buffer).setUint32(12, flags, true); return { record: { type: 'LIGH', editorId: 'x', fields: [{ type: 'DATA', data: d }] } }; };
  const RECS = { 0x1d4ec: light(11), 0x2000: light(1), 0x3000: { record: { type: 'MISC', editorId: 'Goblet01', fields: [] } }, 0x4000: { record: { type: 'MISC', editorId: 'HangingRabbit01', fields: [] } } };
  const BASE = { 0x08000001: 0x1d4ec, 0x08000002: 0x2000, 0x08000003: 0x3000, 0x08000004: 0x4000, 0x08000005: 0x1d4ec };
  const said = [];
  const mp = { get: (id, k) => (k === 'baseDesc' && BASE[id] ? `${BASE[id].toString(16)}:Skyrim.esm` : undefined), getIdFromDesc: (d) => parseInt(String(d).split(':')[0], 16), lookupEspmRecordById: (id) => RECS[id] || null };
  globalThis.__dboHarvestReady = new Map();
  // The rest on the reference (restUntil, setRest) is declared with the coin purses, below this section
  const srcLine = (head) => { const i = src.indexOf(head); if (i < 0) throw new Error(`gamemode.js has no ${head}`); return src.slice(i, src.indexOf('\n', i)); };
  const { restUntil, setRest } = new Function('mp', 'log', `${srcLine('const REST_PROP = ')}\n${srcLine('const restUntil = ')}\n${srcLine('const setRest = ')}\nreturn { restUntil, setRest };`)(mp, () => {});
  const M = new Function('mp', 'cfg', 'personal', 'restUntil', 'setRest', src.slice(from, to) + '\nreturn { blockPlacedPickup, carryableLight, TORCH_MINUTES };')(
    mp, { harvest: {} }, (a, t) => said.push(t), restUntil, setRest);
  const P = 0xff000001;
  check('Torch01 (DATA flags 11, 0x2 Can Be Carried) is a carryable light', M.carryableLight(RECS[0x1d4ec]) === true);
  check('a light without 0x2 (a sconce, a candle) is not', M.carryableLight(RECS[0x2000]) === false);
  check('a torch lying in the world can be taken', M.blockPlacedPickup(0x08000001, P) === false);
  check('...and then not again for a while', M.blockPlacedPickup(0x08000001, P) === true && /took this torch not long ago/.test(said[said.length - 1]), said[said.length - 1]);
  const ready = globalThis.__dboHarvestReady.get(0x08000001) - Date.now();
  check('...120 minutes by default (harvest.torchMinutes)', M.TORCH_MINUTES === 120 && ready > 119 * 60000 && ready <= 120 * 60000);
  check('another torch has its own timer', M.blockPlacedPickup(0x08000005, P) === false);
  // The refusal line is throttled per player, so a second player hears it
  check('a fixed light stays where it is', M.blockPlacedPickup(0x08000002, 0xff000002) === true && /not yours to take/.test(said[said.length - 1]), said[said.length - 1]);
  check('decoration stays refused', M.blockPlacedPickup(0x08000003, P) === true);
  check('a harvestable still works on its own timer', M.blockPlacedPickup(0x08000004, P) === false && globalThis.__dboHarvestReady.get(0x08000004) - Date.now() <= 60 * 60000);
  check("a player's dropped torch (ff id) is not this rule's business", M.blockPlacedPickup(0xff000100, P) === false);
}

// ---- 2. torches in expedition and dungeon chests (the real dungeons.js) ---------------------------------------------
// Nate, 10 Oct: "nerf the torches in the loot pool": a rare find, one a chest at most (dungeons.js defaults 0.03 / 0.08,
// were 0.12 / 0.35 with 1 or 2 a chest)
const claimRuin = (kind, chests, rand) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-torches-'));
  const here = process.cwd();
  process.chdir(dir);
  const realLoot = JSON.parse(fs.readFileSync(path.join(ROOT, 'loot.json'), 'utf8'));
  fs.writeFileSync('loot.json', JSON.stringify(realLoot));
  const RUIN = 'ef1aa:BSHeartland.esm', SYNOD = '20ff:BSHeartland.esm';
  fs.writeFileSync('dungeons.json', JSON.stringify({ dungeons: [] }));
  fs.writeFileSync('expeditions.json', JSON.stringify({ expeditions: [{ id: 'Ruin', name: 'Ruin', type: 'ayleid', kind, county: '', cells: [{ desc: RUIN }], chests: chests.map((ch) => Object.assign({ cell: RUIN, pos: [0, 0, 0], big: true }, ch)), zones: [],
    entrances: [{ expedition: true, cell: SYNOD, pos: [0, 0, 0], rot: [0, 0, 0], doorPos: [0, 0, 0], insideDesc: 'ef1ad:BSHeartland.esm', insideCell: RUIN, insidePos: [0, 0, 0], insideRot: [0, 0, 0] }] }] }));
  const A = 0x14, BOARD = 0x3413a556;
  const props = new Map([[`${BOARD}|baseDesc`, '6:DragonBreak.esp'], [`${A}|worldOrCellDesc`, SYNOD], [`${A}|pos`, [0, 0, 0]]]);
  const ui = new Map();
  const savedTimeout = global.setTimeout; global.setTimeout = () => 0;
  globalThis.__dboDungeons = undefined; globalThis.__dboExpeditionPending = undefined;
  delete require.cache[path.join(ROOT, 'dungeons.js')];
  require(path.join(ROOT, 'dungeons.js'))({
    mp: { get: (id, p) => (p === 'profileId' ? (id === A ? 1 : -1) : props.get(`${id}|${p}`)), set: (id, p, v) => props.set(`${id}|${p}`, v),
      getIdFromDesc: (d) => parseInt(String(d).split(':')[0], 16), lookupEspmRecordById: (id) => (id === 6 ? { record: { editorId: 'ExpeditionBoard' } } : { record: null }) },
    log: () => {}, personal: () => {}, system: () => {}, audit: () => {}, registerChatCommand: () => {}, onUi: (n, fn) => { const l = ui.get(n) || []; l.push(fn); ui.set(n, l); },
    openWidget: () => true, closeWidget: () => true, sendPacket: () => true, findByName: () => 0, display: String, who: String,
    profileOf: (a) => (a === A ? 1 : -1), nameOf: () => 'P', onlineActors: () => [A], isAdmin: () => false, giveItem: () => true, cfg: {}, every: () => {},
  });
  const fire = (n, a, args) => (ui.get(n) || []).forEach((f) => f(a, args, 0));
  globalThis.__dboDungeonActivate(BOARD, A);
  fire('expeditionPick', A, ['Ruin']);
  const pend = globalThis.__dboDungeons.pending.get(A);
  const rnd0 = Math.random; if (rand) Math.random = rand;
  try { if (pend) fire('dungeonClaim', A, [pend.nonce, 'normal']); } finally { Math.random = rnd0; }
  const torchesIn = chests.map((ch) => { const inv = props.get(`${parseInt(ch.ref, 16)}|inventory`); const t = inv && inv.entries.find((e) => e.baseId === 0x1d4ec); return { filled: !!inv, n: t ? t.count : 0 }; });
  global.setTimeout = savedTimeout;
  process.chdir(here);
  fs.rmSync(dir, { recursive: true, force: true });
  return torchesIn;
};
{
  const realLoot = JSON.parse(fs.readFileSync(path.join(ROOT, 'loot.json'), 'utf8'));
  check('loot.json has a lights pool with the vanilla torch', (realLoot.pools.lights || []).some((it) => it.id === '1d4ec:Skyrim.esm'));
  const cfgD = JSON.parse(fs.readFileSync(path.join(ROOT, 'gamemode-config.json'), 'utf8')).dungeons || {};
  check('gamemode-config.json: torchChance 0.03 and expeditionTorchChance 0.08 (were 0.12 and 0.35)', cfgD.torchChance === 0.03 && cfgD.expeditionTorchChance === 0.08, { torchChance: cfgD.torchChance, expeditionTorchChance: cfgD.expeditionTorchChance });
  const chests = []; for (let i = 0; i < 1000; i++) chests.push({ ref: `${(0x90000 + i).toString(16)}:BSHeartland.esm`, edid: 'CYRTreasAyleidChest' });
  const got = claimRuin('', chests);
  const withTorch = got.filter((c) => c.n > 0).length, torches = got.reduce((n, c) => n + c.n, 0);
  check('a claimed ruin fills its chests', got.some((c) => c.filled));
  // An expedition's chances are times its trim (dungeons.expeditionLoot.scale; Adept 0.45 by default): 8% x 0.45
  check(`torches are rare: ${withTorch} of 1000 expedition chests (3.6% expected; was 16%)`, withTorch >= 15 && withTorch <= 60, { withTorch });
  check('...one torch a chest, never two', torches === withTorch, { withTorch, torches });
  // A raid boss chest rolls 1.5 boss rolls; with every roll landing (Math.random 0) both rolls hold a torch, and the
  // chest still gets one
  const boss = []; for (let i = 0; i < 20; i++) boss.push({ ref: `${(0x95000 + i).toString(16)}:BSHeartland.esm`, edid: 'CYRTreasAyleidBossChest' });
  const raid = claimRuin('raid', boss, () => 0);
  check(`a raid boss chest whose two rolls both land holds one torch (${raid.map((c) => c.n).join(',')})`, raid.every((c) => c.filled && c.n === 1), raid);
}

// ---- 3. the F7 item spawner --------------------------------------------------------------------------------------------
{
  const cats = JSON.parse(fs.readFileSync(path.join(ROOT, 'admin-items.json'), 'utf8')).categories;
  const cat = (id) => cats.find((c) => c.id === id) || { items: [] };
  const has = (id, desc) => cat(id).items.some((it) => String(it[0]).toLowerCase() === desc.toLowerCase());
  check('a Lights category lists the torch (Torch01, 1d4ec:Skyrim.esm)', has('Lights', '1d4ec:Skyrim.esm'));
  check('Potions lists the Draught of Revival (12ae16, ALCH)', has('Potions', '12ae16:DragonBreak Online Edits.esp'));
  check('Books lists its recipe (12ae17, a BOOK)', has('Books', '12ae17:DragonBreak Online Edits.esp'));
  const once = (c, d) => cat(c).items.filter((it) => String(it[0]).toLowerCase() === d.toLowerCase()).length === 1;
  check('each is listed once', once('Lights', '1d4ec:Skyrim.esm') && once('Potions', '12ae16:DragonBreak Online Edits.esp') && once('Books', '12ae17:DragonBreak Online Edits.esp'));
}

console.log(failures ? `${failures} FAILED` : 'all checks passed');
process.exit(failures ? 1 : 0);
