// Novice bosses fit a new party (/bug 1 Oct 23:04: "a dragon priest looking mob was in a novice dungeon - practically 3
// shot me with a shock spell"). Silorn's lich is one fixed level-50 NPC (BSKEncAyleidLich, 6026fd:BSAssets.esm, a dragon
// priest build: 1490 health, Thunderbolt and Chain Lightning), and pickScaled falls back to a placement's lowest option
// when nothing is in band, so Novice handed it to a level-1 party. With expeditions.json storyOptions a boss has its own
// Novice line; Adept and up keep the lich (Nate, 2026-09-28: "with silorn you need to make sure the liche boss always
// spawns"). Balance call for Nate. Claims every expedition through the board with the real data files in a scratch folder.
//   node tests/novice-boss-level-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const SERVER = path.resolve(__dirname, '..');
const DUNGEONS = path.join(SERVER, 'dungeons.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-jake-novice-boss-'));
for (const f of ['expeditions.json', 'dungeon-pools.json', 'loot.json']) if (fs.existsSync(path.join(SERVER, f))) fs.copyFileSync(path.join(SERVER, f), path.join(dir, f));
fs.writeFileSync(path.join(dir, 'dungeons.json'), JSON.stringify({ dungeons: [] }));
process.chdir(dir);
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });
global.setTimeout = () => 0;

const FG = 'f8d:BSHeartland.esm';
const A = 0x14, BOARD = 0x3413a56c;
const LICH = '6026fd:BSAssets.esm';
let LEVEL = 1;
globalThis.__dboCharLevel = () => LEVEL;   // charlevel.js: the party's level, 1-5
const props = new Map([[`${BOARD}|baseDesc`, '6:DragonBreak.esp'], [`${A}|worldOrCellDesc`, FG], [`${A}|pos`, [0, -500, -221]]]);
const ui = new Map(), commands = new Map();
globalThis.__dboDungeons = undefined; globalThis.__dboExpeditionPending = undefined;
require(DUNGEONS)({
  mp: {
    get: (id, p) => (p === 'profileId' ? (id === A ? 1 : -1) : props.get(`${id}|${p}`)),
    set: (id, p, v) => props.set(`${id}|${p}`, v),
    getIdFromDesc: (d) => parseInt(String(d).split(':')[0], 16),
    lookupEspmRecordById: (id) => (id === 6 ? { record: { editorId: 'ExpeditionBoard' } } : { record: null }),
  },
  log: () => {}, personal: () => {}, system: () => {}, audit: () => {},
  registerChatCommand: (n, fn) => commands.set(n, fn), onUi: (n, fn) => { const l = ui.get(n) || []; l.push(fn); ui.set(n, l); },
  openWidget: () => true, closeWidget: () => true, sendPacket: () => true, findByName: () => 0, display: String, who: String,
  profileOf: (a) => (a === A ? 1 : -1), nameOf: () => 'P', onlineActors: () => [A],
  isAdmin: () => false, giveItem: () => true, cfg: {}, every: () => {},
});
const fire = (n, a, args) => (ui.get(n) || []).forEach((f) => f(a, args, 0));
fire('uiCaps', A, ['expeditionBoard']);
let failures = 0;
const check = (label, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

const data = JSON.parse(fs.readFileSync('expeditions.json', 'utf8')).expeditions;
// The level each boss option is listed at, by NPC id, from the data (options and storyOptions)
const listedLevel = new Map();
for (const x of data) for (const z of x.zones || []) for (const n of z.npcs || []) for (const o of [...(n.options || []), ...(n.storyOptions || [])]) listedLevel.set(o[1], Math.max(listedLevel.get(o[1]) || 0, o[0]));
const claim = (x, diff) => {
  props.set(`${A}|worldOrCellDesc`, FG);
  globalThis.__dboDungeonActivate(BOARD, A);
  fire('expeditionPick', A, [x.id]);
  const pend = globalThis.__dboDungeons.pending.get(A);
  if (!pend) return null;
  fire('dungeonClaim', A, [pend.nonce, diff]);
  const lease = globalThis.__dboDungeons.leases.get(x.id);
  if (!lease) return null;
  const bosses = lease.zones.filter((z) => lease.bossZones.has(z.Name)).map((z) => z.NPC[0].id);
  globalThis.__dboDungeons.leases.delete(x.id);
  return bosses;
};
const RUNS = 20;
const silorn = data.find((x) => x.id === 'CYRSilornLocation');
check('Silorn is in the data with its lich as a boss', !!silorn && silorn.zones.some((z) => z.npcs.some((n) => n.boss && n.edid === 'BSKEncAyleidLich')));

// dungeons.js defaults: LEVEL_BANDS tops, Novice's level shift -1, a boss one band up (a raid's bossBandShift 2)
const BAND_TOP = { 1: 6, 2: 9, 3: 14, 4: 21, 5: 25, 6: 30, 7: 40 };
const bandTop = (x, lvl) => BAND_TOP[Math.max(1, Math.min(7, lvl - 1 + (x.kind === 'raid' ? 2 : 1)))];

// 1. Novice (the report: a solo level-1 player): every boss comes from its party's level band or below, never the lich
for (const lvl of [1, 3, 5]) {
  LEVEL = lvl;
  for (const x of data) {
    const top = bandTop(x, lvl);
    let worst = 0; const seen = new Set(); let missing = 0;
    for (let i = 0; i < RUNS; i++) {
      const b = claim(x, 'story');
      if (!b || !b.length) { missing++; continue; }
      for (const id of b) { seen.add(id); worst = Math.max(worst, listedLevel.get(id) || 0); }
    }
    check(`${x.name}, Novice, party level ${lvl}: a boss in every claim`, missing === 0, missing ? { missing } : undefined);
    check(`${x.name}, Novice, party level ${lvl}: no boss listed above its band (${top})`, worst <= top, { worst, bosses: [...seen] });
    check(`${x.name}, Novice, party level ${lvl}: never the level-50 Ayleid Lich`, !seen.has(LICH), [...seen]);
  }
}

// 2. Adept and up: Silorn's lich is still its boss (Nate's "the liche boss always spawns")
LEVEL = 1;
for (const diff of ['normal', 'hard', 'nightmare']) {
  let lich = 0;
  for (let i = 0; i < RUNS; i++) { const b = claim(silorn, diff); if (b && b.includes(LICH)) lich++; }
  check(`Silorn on ${diff}: the Ayleid Lich is its boss in all ${RUNS} claims`, lich === RUNS, { lich });
}

console.log(failures ? `${failures} FAILED` : 'all checks passed');
process.exit(failures ? 1 : 0);
