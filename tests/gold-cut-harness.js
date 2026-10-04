// The gold cut of 4 October (Nate: "we need to decrease the amount of gold people can get from dungeons etc."; branch
// gold-cut-1004). Measured over 68 h of the alpha (2 Oct 00:01 to 4 Oct 20:00 UTC, about 790 player-hours, the hourly
// world backups and the server log) players gained about 85 gold an hour each, and spent about 12: champion bounties
// about 40,000 (554 paid kills at 25-120), dungeon and expedition leases about 25,000 (667 claims), the rest coin purses,
// camp chests and contracts. Every source is a config knob now, set here to cut the faucets to about a quarter.
//   1. gamemode-config.json carries the cut values, and each knob is one its module reads
//   2. wildlife.campGold (new): a camp chest's coin follows the range; a broken range falls back to 8-22; [0, 0] gives none
//   3. dungeons.js, the real module and the real dungeons.json, loot.json and dungeon-pools.json: solo full clears of the
//      Bruma dungeons at each difficulty, old knobs against the config's; about 60% less coin, Novice still pays some,
//      and each difficulty pays more than the one below
//   4. the expected gold per player-hour at the config's knobs, from the measured counts (printed, so a tweak shows its effect)
//   node tests/gold-cut-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${!c && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!c) fails++; };
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const cfg = JSON.parse(read('gamemode-config.json'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-goldcut-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });
const cwd = process.cwd();

// Seeded Math.random, so a run measures the same sample every time
let rngState = 0;
const reseed = (key) => { let h = 2166136261; for (const c of String(key)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); rngState = h >>> 0; };
Math.random = () => {
  rngState = (rngState + 0x6d2b79f5) >>> 0;
  let t = Math.imul(rngState ^ (rngState >>> 15), rngState | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// ---- 1. the knobs ----------------------------------------------------------------------------------------------------
const D = cfg.dungeons || {}, CH = cfg.champions || {}, PU = cfg.coinPurses || {}, W = cfg.wildlife || {};
const range = (r) => Array.isArray(r) && r.length === 2 && Number(r[0]) >= 0 && Number(r[1]) >= Number(r[0]);
ok(D.goldChance > 0 && D.goldChance < 0.35 && D.goldMult > 0 && D.goldMult < 0.3, `dungeons: goldChance ${D.goldChance} (was 0.35), goldMult ${D.goldMult} (was 0.3)`);
ok(D.bodyGoldChance > 0 && D.bodyGoldChance < 0.4 && D.bodyGoldMult > 0 && D.bodyGoldMult < 0.15, `dungeons: bodyGoldChance ${D.bodyGoldChance} (was 0.4), bodyGoldMult ${D.bodyGoldMult} (was 0.15)`);
ok(range(CH.goldReward) && CH.goldReward[1] < 120 && CH.goldReward[0] >= 1, `champions.goldReward ${JSON.stringify(CH.goldReward)} (was 25-120)`);
ok(Number(PU.goldMin) >= 1 && Number(PU.goldMax) >= Number(PU.goldMin) && Number(PU.goldMax) < 30, `coinPurses ${PU.goldMin}-${PU.goldMax} (was 8-30)`);
ok(range(W.campGold) && W.campGold[1] < 22, `wildlife.campGold ${JSON.stringify(W.campGold)} (was 8-22 in code)`);
const dsrc = read('dungeons.js'), gsrc = read('gamemode.js'), csrc = read('champions.js'), wsrc = read('wildlife.js');
ok(/cfg\.dungeons/.test(dsrc) && /Number\(C\.goldChance\)/.test(dsrc) && /Number\(C\.goldMult\)/.test(dsrc) && /C\.bodyGoldChance/.test(dsrc) && /C\.bodyGoldMult/.test(dsrc), 'dungeons.js reads the four from cfg.dungeons');
ok(/cfg\.coinPurses/.test(gsrc) && /PURSE\.goldMin/.test(gsrc) && /PURSE\.goldMax/.test(gsrc), 'gamemode.js reads coinPurses goldMin and goldMax');
ok(/CFG\.goldReward/.test(csrc), 'champions.js reads goldReward');
ok(/C\.campGold/.test(wsrc), 'wildlife.js reads campGold');

// ---- 2. camp chests --------------------------------------------------------------------------------------------------
fs.writeFileSync(path.join(tmp, 'wildlife.json'), JSON.stringify({ placements: [], giantCamps: [{ id: 'DuskThornCamp', name: 'Dusk Thorn Camp', owners: 'goblins', chests: [{ ref: '1234:Test.esp' }] }] }));
fs.writeFileSync(path.join(tmp, 'loot.json'), JSON.stringify({ pools: {} }));
fs.writeFileSync(path.join(tmp, 'artifacts.json'), JSON.stringify({ patterns: [] }));
const CHEST = 0x09001234, PLAYER = 0xff000014;
const campCoin = (wildCfg, n = 300) => {
  const props = new Map(), given = [];
  const mp = {
    get: (id, k) => props.get(`${id}|${k}`), set: (id, k, v) => props.set(`${id}|${k}`, v),
    getIdFromDesc: (d) => { const [h, p] = String(d).split(':'); if (String(p).toLowerCase() !== 'test.esp') throw new Error('no plugin'); return ((0x09 << 24) | parseInt(h, 16)) >>> 0; },
  };
  globalThis.__dboWildFactionAudit = ' (skipped in the harness)';
  process.chdir(tmp);
  try {
    const file = path.join(ROOT, 'wildlife.js'); delete require.cache[file];
    require(file)({ mp, log: () => {}, personal: () => {}, system: () => {}, registerChatCommand: () => {}, giveItem: (a, id, c) => { given.push([id, c]); return true; },
      profileOf: (a) => ((a >>> 0) === PLAYER ? 2 : -1), display: String, who: String, audit: () => {}, isAdmin: () => false, cfg: wildCfg === undefined ? {} : { wildlife: wildCfg }, onlineActors: () => [PLAYER], sendPacket: () => {} });
  } finally { process.chdir(cwd); }
  const coins = [];
  for (let i = 0; i < n; i++) {
    props.delete(`${PLAYER}|private.campLoot`); given.length = 0;
    globalThis.__dboCampChest(CHEST, PLAYER);
    coins.push(given.filter(([id]) => id === 0xf).reduce((s, [, c]) => s + c, 0));
  }
  if (globalThis.__dboOwnedFactionTimer) clearInterval(globalThis.__dboOwnedFactionTimer);
  return { min: Math.min(...coins), max: Math.max(...coins), mean: coins.reduce((s, c) => s + c, 0) / coins.length, zero: coins.filter((c) => c === 0).length };
};
reseed('camp');
const campNow = campCoin({ campGold: W.campGold });
ok(campNow.min >= W.campGold[0] && campNow.max <= W.campGold[1] && campNow.max > campNow.min, `a camp chest hands over ${campNow.min}-${campNow.max} gold at campGold ${JSON.stringify(W.campGold)} (mean ${campNow.mean.toFixed(1)})`, campNow);
const campOld = campCoin(undefined);
ok(campOld.min >= 8 && campOld.max <= 22 && campOld.max >= 20, `without the knob it is 8-22 as before (${campOld.min}-${campOld.max})`, campOld);
const campBroken = campCoin({ campGold: [30, 5] });
ok(campBroken.min >= 8 && campBroken.max <= 22, `a broken range (30-5) falls back to 8-22 (${campBroken.min}-${campBroken.max})`, campBroken);
const campNone = campCoin({ campGold: [0, 0] }, 20);
ok(campNone.zero === 20, '[0, 0] hands over no coin', campNone);

// ---- 3. dungeon clears, old knobs against the config's ---------------------------------------------------------------
const ids = new Map(); const descOf = new Map(); let nextId = 0x100;
const idOf = (d) => { const k = String(d).toLowerCase(); if (!ids.has(k)) { ids.set(k, nextId); descOf.set(nextId, k); nextId++; } return ids.get(k); };
const GOLD = idOf('f:Skyrim.esm');
const loot = JSON.parse(read('loot.json'));
const WEAPONS = (loot.pools.weapons || []).filter((it) => !/Ebony|Daedric/i.test(it.name) && Number(it.value) > 0).map((it) => ({ id: idOf(it.id), name: it.name }));
const WEAPON_REC = new Map(WEAPONS.map((w) => [w.id, { record: { type: 'WEAP', editorId: w.name, flags: 0, fields: [] } }]));
const HUMANOID = /bandit|highwayman|marauder|outlaw|thug|forsworn|draugr|falmer|orc|soldier|guard|thalmor|vampire|hunter|warlock|necromancer|conjurer|mage|cultist|silverhand|reaver|smuggler|pirate|warrior|dremora|boss/i;
const ANIMAL = /wolf|bear|skeever|spider|chaurus|troll|sabre|mudcrab|horker|slaughterfish|deer|elk|goat|fox|hare|dog|mammoth|giant|atronach|wisp|spriggan|hagraven|sphere|centurion|ballista|ghost|dragon|frostbite|netch|riekling|ashhopper|ogre|minotaur|dreugh|gargoyle|werewolf|werebear/i;
const A = 0x14;
// Gold from CLAIMS solo full clears of one ordinary dungeon: every container as it is filled, every humanoid body searched
const clearGold = (d, diffId, dungeonCfg, claims) => {
  reseed(`${d.id}|${diffId}|${claims}`);
  const dir = fs.mkdtempSync(path.join(tmp, 'lease-'));
  process.chdir(dir);
  for (const f of ['loot.json', 'ayleid-loot.json', 'dungeon-pools.json']) fs.copyFileSync(path.join(ROOT, f), f);
  fs.writeFileSync('expeditions.json', JSON.stringify({ expeditions: [] }));
  fs.writeFileSync('dungeons.json', JSON.stringify({ dungeons: [d] }));
  const e0 = d.entrances[0];
  const props = new Map([[`${A}|worldOrCellDesc`, e0.world || e0.cell], [`${A}|pos`, e0.doorPos || e0.pos]]);
  const given = []; const ui = new Map(), cmds = new Map();
  const savedTimeout = global.setTimeout; global.setTimeout = () => 0;
  globalThis.__dboDungeons = undefined; globalThis.__dboExpeditionPending = undefined;
  const file = path.join(ROOT, 'dungeons.js'); delete require.cache[file];
  let gold = 0, n = 0, body = 0xff000500;
  try {
    require(file)({
      mp: { get: (id, p) => (p === 'profileId' ? (id === A ? 1 : -1) : props.get(`${id}|${p}`)), set: (id, p, v) => props.set(`${id}|${p}`, v), getIdFromDesc: idOf, getDescFromId: (id) => descOf.get(id),
        lookupEspmRecordById: (id) => WEAPON_REC.get(id) || { record: null } },
      log: () => {}, personal: () => {}, system: () => {}, audit: () => {}, registerChatCommand: (nm, fn) => cmds.set(nm, fn), onUi: (nm, fn) => { const l = ui.get(nm) || []; l.push(fn); ui.set(nm, l); },
      openWidget: () => true, closeWidget: () => true, sendPacket: () => true, findByName: () => 0, display: String, who: String, profileOf: (a) => (a === A ? 1 : -1), nameOf: () => 'P',
      onlineActors: () => [A], isAdmin: () => true, giveItem: (a, base, c) => { given.push([base, c]); return true; }, cfg: { dungeons: dungeonCfg }, every: () => {},
    });
    const fire = (nm, a, args) => (ui.get(nm) || []).forEach((f) => f(a, args, 0));
    for (let c = 0; c < claims; c++) {
      props.set(`${A}|worldOrCellDesc`, e0.world || e0.cell); props.set(`${A}|pos`, e0.doorPos || e0.pos);
      props.delete(`${A}|private.dungeonCooldowns`); if (globalThis.__dboDungeonAccountRest) globalThis.__dboDungeonAccountRest.clear();
      globalThis.__dboDungeonActivate(idOf(e0.outsideDesc), A);
      const pend = globalThis.__dboDungeons.pending.get(A);
      if (pend) fire('dungeonClaim', A, [pend.nonce, diffId]);
      const lease = globalThis.__dboDungeons.leases.get(d.id);
      if (!lease) break;
      n++;
      for (const ch of d.chests || []) for (const e of ((props.get(`${idOf(ch.ref)}|inventory`) || { entries: [] }).entries)) if (e.baseId === GOLD) gold += e.count;
      for (const z of lease.zones) {
        if (!(HUMANOID.test(z.Kind || '') && !ANIMAL.test(z.Kind || ''))) continue;
        for (let k = 0; k < z.NPC[0].count; k++) {
          const id = body++; props.set(`${id}|private.npcSpawner`, z.Name); props.set(`${id}|isDead`, true);
          props.set(`${id}|inventory`, { entries: [{ baseId: WEAPONS[id % WEAPONS.length].id, count: 1 }] });
          globalThis.__dboTrimCorpse(id);
          given.length = 0;
          if (globalThis.__dboCorpseLoot(id, A) !== false) continue;
          for (const [b, c2] of given) if (b === GOLD) gold += c2;
        }
      }
      cmds.get('dungeon')(A, `end ${d.id.toLowerCase()}`);
    }
  } finally { global.setTimeout = savedTimeout; process.chdir(cwd); }
  return n ? gold / n : 0;
};
// The Bruma dungeons players claimed most in the measured window
const BRUMA = ['CYRBrumaCavernsLocation', 'CYRToadstoolHollowLocation', 'CYRCapstoneCaveLocation', 'CYRFortCutpurseLocation', 'CYRRedRubyCaveLocation', 'CYRUnderpallLocation', 'CYRPlunderedMineLocation'];
const ORD = JSON.parse(read('dungeons.json')).dungeons.filter((d) => BRUMA.includes(d.id) && (d.entrances || []).length);
const OLD = Object.assign({}, D, { goldChance: 0.35, goldMult: 0.3, bodyGoldChance: 0.4, bodyGoldMult: 0.15 });
const DIFFS = [['story', 'Novice'], ['normal', 'Adept'], ['hard', 'Expert'], ['nightmare', 'Master']];
const CLAIMS = Number(process.env.CLAIMS) || 40;
ok(ORD.length >= 5, `${ORD.length} Bruma dungeons to clear`);
const was = {}, now = {};
for (const [id] of DIFFS) {
  was[id] = ORD.reduce((s, d) => s + clearGold(d, id, OLD, CLAIMS), 0) / ORD.length;
  now[id] = ORD.reduce((s, d) => s + clearGold(d, id, D, CLAIMS), 0) / ORD.length;
}
console.log(`      gold per solo full clear, mean of ${ORD.length} Bruma dungeons: ${DIFFS.map(([id, name]) => `${name} ${was[id].toFixed(0)} -> ${now[id].toFixed(0)}`).join(', ')}`);
const wasAll = DIFFS.reduce((s, [id]) => s + was[id], 0), nowAll = DIFFS.reduce((s, [id]) => s + now[id], 0);
ok(nowAll < wasAll * 0.5 && nowAll > wasAll * 0.25, `about 60% less coin across the difficulties (${(100 * (1 - nowAll / wasAll)).toFixed(0)}% less)`);
ok(now.story >= 5, `a Novice clear still pays some coin (${now.story.toFixed(0)})`);
ok(DIFFS.slice(1).every(([id], i) => now[id] > now[DIFFS[i][0]]), `each difficulty pays more than the one below (${DIFFS.map(([id]) => now[id].toFixed(0)).join(' < ')})`);

// ---- 4. gold per player-hour at the config's knobs -------------------------------------------------------------------
// Measured 2 Oct 00:01 to 4 Oct 20:00 UTC: about 790 player-hours (the minute tick's online count). Champions: 554 paid
// kills. Dungeons: 25,000 is half of what 667 claims would pay as full clears (49,000 at the old knobs, by
// expedition-loot-budget-harness), the share the hourly world backups bear out. Purses: at least 2,000 (377 logged
// empty purses; a successful one is not logged). Camps: 828 gold logged from 34 chests. Contracts are paid from a hold
// treasury, so they move gold and mint none (276 logged).
const HOURS = 790;
const mean = (r) => (Number(r[0]) + Number(r[1])) / 2;
const potMean = (r) => Number(r[0]) + Math.max(1, Number(r[1]) - Number(r[0])) / 2 - 0.5;
const dungeonsNow = 25000 * nowAll / wasAll;
const rows = [
  // champions.js: a kill's pot is floor(lo + random x (hi - lo)), shared among the fighters
  ['champion bounties', 554 * potMean([25, 120]), 554 * potMean(CH.goldReward)],
  ['dungeon and expedition leases', 25000, dungeonsNow],
  ['coin purses', 2000, 2000 * mean([PU.goldMin, PU.goldMax]) / 19],
  ['camp chests', 828, 828 * mean(W.campGold) / 15],
  ['contracts (treasury-funded)', 276, 276],
];
for (const [what, w, n] of rows) console.log(`      ${what.padEnd(30)} ${(w / HOURS).toFixed(1).padStart(5)} -> ${(n / HOURS).toFixed(1).padStart(5)} gold per player-hour`);
const wph = rows.reduce((s, r) => s + r[1], 0) / HOURS, nph = rows.reduce((s, r) => s + r[2], 0) / HOURS;
console.log(`      ${'all of them'.padEnd(30)} ${wph.toFixed(1).padStart(5)} -> ${nph.toFixed(1).padStart(5)} gold per player-hour; the /appearance editor (500) is ${(500 / nph).toFixed(0)} h of play, a property's weekly tax at 10% of the default 2,000 value (200) ${(200 / nph).toFixed(0)} h`);
ok(nph < wph * 0.4 && nph > 10, `income about a quarter of before (${nph.toFixed(0)} of ${wph.toFixed(0)} gold per player-hour), and a dungeon run still pays`);

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
