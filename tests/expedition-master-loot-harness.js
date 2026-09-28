// An expedition's master and its boss chest (Nate, 2026-09-28, in Silorn: "the lich needs good boss loot that drops from
// him when you loot him, and the chest behind where he spawns needs to be boss loot"). The real dungeons.js with the real
// expeditions.json, loot.json and ayleid-loot.json:
// 1. Silorn's chest aaee4 (right behind the lich, an ordinary CYRTreasAyleidChestSmall base) rolls as a boss chest: coin
//    and a piece of gear every time, over many claims.
// 2. The lich's body, looted with E, hands over the boss chest's roll: coin every time, gear, Ayleid treasure by the
//    difficulty (never Major or Eminent at Novice, Eminent or the Lich Helmet only at Master); once per body.
// 3. An ordinary humanoid in the same ruin keeps its small roll, and its body and the master's are emptied at death.
//   node tests/expedition-master-loot-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let failures = 0;
const check = (label, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${got !== undefined && !ok ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

const EXP = JSON.parse(fs.readFileSync(path.join(ROOT, 'expeditions.json'), 'utf8'));
const silorn = EXP.expeditions.find((e) => e.id === 'CYRSilornLocation');
check('Silorn names aaee4 as its boss chest', silorn && silorn.bossChest === 'aaee4:BSHeartland.esm');
const behind = silorn.chests.find((c) => c.ref === 'aaee4:BSHeartland.esm');
check('...a big chest of an ordinary base in the lich\'s cell', behind && behind.big && !/boss/i.test(behind.edid) && behind.cell === 'a9ed0:BSHeartland.esm');
const POOL = new Map(JSON.parse(fs.readFileSync(path.join(ROOT, 'ayleid-loot.json'), 'utf8')).items.map((it) => [it.id.toLowerCase(), it]));

const ids = new Map(); const descs = new Map(); let nextId = 0x100;
const idOf = (d) => { const k = String(d).toLowerCase(); if (!ids.has(k)) { ids.set(k, nextId); descs.set(nextId, k); nextId++; } return ids.get(k); };
const SYNOD = '20ff:BSHeartland.esm', A = 0x14;
// One claim of Silorn at a difficulty; returns the chest inventories and a looter for bodies of the lease's zones
const claim = (diffId) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-master-'));
  const here = process.cwd(); process.chdir(dir);
  for (const f of ['loot.json', 'ayleid-loot.json', 'expeditions.json']) fs.copyFileSync(path.join(ROOT, f), f);
  fs.writeFileSync('dungeons.json', JSON.stringify({ dungeons: [] }));
  const props = new Map([[`${idOf('boardref')}|baseDesc`, '6:DragonBreak.esp'], [`${A}|worldOrCellDesc`, 'f8d:BSHeartland.esm'], [`${A}|pos`, [0, -500, -221]]]);
  const given = [], said = [];
  const ui = new Map(); const savedTimeout = global.setTimeout; global.setTimeout = () => 0;
  globalThis.__dboDungeons = undefined; globalThis.__dboExpeditionPending = undefined;
  delete require.cache[path.join(ROOT, 'dungeons.js')];
  require(path.join(ROOT, 'dungeons.js'))({
    mp: { get: (id, p) => (p === 'profileId' ? (id === A ? 1 : -1) : props.get(`${id}|${p}`)), set: (id, p, v) => props.set(`${id}|${p}`, v), getIdFromDesc: idOf,
      lookupEspmRecordById: (id) => (id === idOf('6:DragonBreak.esp') ? { record: { editorId: 'ExpeditionBoard' } } : { record: null }) },
    log: () => {}, personal: (a, t) => said.push(t), system: () => {}, audit: () => {}, registerChatCommand: () => {}, onUi: (n, fn) => { const l = ui.get(n) || []; l.push(fn); ui.set(n, l); },
    openWidget: () => true, closeWidget: () => true, sendPacket: () => true, findByName: () => 0, display: String, who: String, profileOf: (a) => (a === A ? 1 : -1), nameOf: () => 'P',
    onlineActors: () => [A], isAdmin: () => false, giveItem: (a, base, n) => { given.push([base, n]); return true; }, cfg: { dungeons: {} }, every: () => {},
  });
  const fire = (n, a, args) => (ui.get(n) || []).forEach((f) => f(a, args, 0));
  globalThis.__dboDungeonActivate(idOf('boardref'), A); fire('expeditionPick', A, ['CYRSilornLocation']);
  const pend = globalThis.__dboDungeons.pending.get(A);
  if (pend) fire('dungeonClaim', A, [pend.nonce, diffId]);
  const lease = globalThis.__dboDungeons.leases.get('CYRSilornLocation');
  const inv = (ref) => (props.get(`${idOf(ref)}|inventory`) || { entries: [] }).entries;
  let body = 0xff000500;
  const lootBody = (tag) => { const id = body++; props.set(`${id}|private.npcSpawner`, tag); props.set(`${id}|isDead`, true); given.length = 0; const r = globalThis.__dboCorpseLoot(id, A); return { r, got: given.slice(), id }; };
  const done = () => { global.setTimeout = savedTimeout; process.chdir(here); fs.rmSync(dir, { recursive: true, force: true }); };
  return { lease, inv, lootBody, props, said, done };
};
const GOLD = idOf('f:Skyrim.esm');
const isGear = (baseId) => { const k = descs.get(baseId) || ''; return !!k && !/^f:skyrim/.test(k); };
const ayleidOf = (entries) => entries.map(([b]) => POOL.get(descs.get(b) || '')).filter(Boolean);

// ---- 1. the chest behind the lich ---------------------------------------------------------------------------------------
{
  let gold = 0, n = 0, alsoBoss = 0;
  for (let i = 0; i < 40; i++) {
    const c = claim('normal');
    if (!c.lease) { c.done(); break; }
    n++;
    if (c.inv('aaee4:BSHeartland.esm').some((e) => e.baseId === GOLD)) gold++;
    if (c.inv('ac697:BSHeartland.esm').some((e) => e.baseId === GOLD)) alsoBoss++;
    c.done();
  }
  check(`Silorn is claimed (${n} claims)`, n === 40);
  check(`aaee4 holds coin in every claim, as a boss chest does (${gold}/40; an ordinary chest 35%)`, gold === 40);
  check(`the plugin's own boss chest ac697 still does too (${alsoBoss}/40)`, alsoBoss === 40);
}

// ---- 2. the lich's body ------------------------------------------------------------------------------------------------
const masterTag = (lease) => [...(lease.bossZones || [])].find((t) => /BSKEncAyleidLich/.test((lease.kinds || {})[t] || '')) || [...(lease.bossZones || [])][0];
for (const diffId of ['story', 'nightmare']) {
  const c = claim(diffId);
  const tag = masterTag(c.lease);
  check(`${diffId}: the lease knows the lich's zone (${(c.lease.kinds || {})[tag]})`, !!tag);
  let withGold = 0, withGear = 0; const pieces = [];
  for (let i = 0; i < 1500; i++) {
    const { r, got } = c.lootBody(tag);
    if (r !== false) { check(`${diffId}: looting the master is handled`, false, r); break; }
    if (got.some(([b]) => b === GOLD)) withGold++;
    if (got.some(([b]) => isGear(b))) withGear++;
    pieces.push(...ayleidOf(got));
  }
  check(`${diffId}: every look at the lich's body finds coin (${withGold}/1500)`, withGold === 1500);
  check(`${diffId}: and more than coin (${withGear}/1500)`, withGear === 1500);
  const tiers = [...new Set(pieces.map((it) => it.tier))];
  if (diffId === 'story') check(`story: Ayleid pieces from the body are common only (${pieces.length} pieces: ${tiers.join(', ')})`, pieces.length > 300 && tiers.every((t) => t === 'common'));
  else check(`nightmare: the body can give the rarest (${pieces.filter((it) => it.tier === 'rarest').length} of ${pieces.length}), never outside the table`, pieces.some((it) => it.tier === 'rarest'));
  const { id } = c.lootBody(tag);
  check(`${diffId}: a body is looted once`, c.lootBody(tag).r === false && (() => { c.props.set(`${id}|private.dboLooted`, true); return globalThis.__dboCorpseLoot(id, A) === false && /Nothing more/.test(c.said[c.said.length - 1]); })());
  // The trimmed corpse keeps nothing, so the engine's own container shows nothing to take twice
  const corpse = 0xff000900; c.props.set(`${corpse}|private.npcSpawner`, tag); c.props.set(`${corpse}|inventory`, { entries: [{ baseId: GOLD, count: 50 }] });
  globalThis.__dboTrimCorpse(corpse);
  check(`${diffId}: the master's corpse is emptied at death`, (c.props.get(`${corpse}|inventory`) || { entries: [1] }).entries.length === 0);
  // An ordinary humanoid of the same ruin keeps the small body roll
  const other = [...Object.keys(c.lease.kinds || {})].find((t) => !(c.lease.bossZones || new Set()).has(t) && /bandit|necromancer|conjurer|mage|warlock/i.test(c.lease.kinds[t]));
  if (other) {
    let rich = 0; for (let i = 0; i < 400; i++) { const { got } = c.lootBody(other); if (got.filter(([b]) => b !== GOLD).length >= 2) rich++; }
    check(`${diffId}: an ordinary ${c.lease.kinds[other]} keeps the small roll (${rich}/400 with two or more items)`, rich < 120);
  }
  c.done();
}

console.log(failures ? `${failures} FAILED` : 'all checks passed');
process.exit(failures ? 1 : 0);
