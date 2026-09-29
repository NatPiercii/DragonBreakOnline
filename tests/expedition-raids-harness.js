// Boss dungeons and raids (Nate, 2026-09-28: "expeditions need to be classified as Boss dungeons or Raids, each expedition
// needs a boss with boss loot"; "bigger, harder, better"). The real dungeons.js with the real expeditions.json, loot.json,
// ayleid-loot.json and dungeon-pools.json:
// 1. Every expedition has a kind: Silorn and Bawn raids with two or more bosses, Niryastare and Telepe boss dungeons with
//    one; every one has a boss chest.
// 2. The board, the list menu and the claim panel say "Boss dungeon" or "Raid (up to 12)" in the fields they already show.
// 3. A raid's bosses spawn higher leveled variants and bring escorts; its other enemies are more; a boss dungeon has none
//    of that. Only the variant chosen, the counts and the loot change: no actor-value writes.
// 4. A raid's boss chest gives a bigger roll than a boss dungeon's.
// 5. Skill gain: a group past partyMax is halved, but not while its lease is a raid ruin; a boss dungeon refuses a group
//    past bossDungeonMax.
//   node tests/expedition-raids-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let failures = 0;
const check = (label, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${got !== undefined && !ok ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };
const EXP = JSON.parse(fs.readFileSync(path.join(ROOT, 'expeditions.json'), 'utf8')).expeditions;
const byId = new Map(EXP.map((e) => [e.id, e]));
const bossesOf = (e) => e.zones.flatMap((z) => z.npcs.filter((n) => n.boss).map((n) => ({ cell: z.cell, pos: n.pos, ref: n.ref, edid: n.edid })));

// ---- 1. the data ----------------------------------------------------------------------------------------------------------
check('every expedition says boss or raid', EXP.every((e) => e.kind === 'boss' || e.kind === 'raid'), EXP.map((e) => [e.id, e.kind]));
check('Silorn and Bawn are raids', byId.get('CYRSilornLocation').kind === 'raid' && byId.get('CYRBawnLocation').kind === 'raid');
check('Niryastare and Telepe are boss dungeons', byId.get('CYRNiryastareLocation').kind === 'boss' && byId.get('CYRTelepeLocation').kind === 'boss');
check('a raid has two or more bosses, a boss dungeon exactly one', EXP.every((e) => (e.kind === 'raid' ? bossesOf(e).length >= 2 : bossesOf(e).length === 1)), EXP.map((e) => [e.id, bossesOf(e).length]));
const bawnSecond = bossesOf(byId.get('CYRBawnLocation')).find((b) => b.ref === 'bc39f:BSHeartland.esm');
check("Bawn's second boss is bc39f, promoted to an Ayleid champion beside its second boss chest bd0d6", !!bawnSecond && bawnSecond.edid === 'CYRLvlAyleidUndeadBossAny');
for (const e of EXP) {
  const named = new Set([].concat(e.bossChest || []).map((r) => String(r).toLowerCase()));
  const bossChests = e.chests.filter((c) => c.big && (/boss/i.test(c.edid) || named.has(c.ref.toLowerCase())));
  const near = bossesOf(e).map((b) => Math.min(...bossChests.filter((c) => c.cell === b.cell).map((c) => Math.round(Math.hypot(c.pos[0] - b.pos[0], c.pos[1] - b.pos[1], c.pos[2] - b.pos[2]))), Infinity));
  check(`${e.id} has a boss chest (nearest to each boss: ${near.join(', ')} units)`, bossChests.length > 0);
}

// ---- the real dungeons.js with a mock gamemode and a group of nine -------------------------------------------------------
const ids = new Map(); let nextId = 0x100;
const idOf = (d) => { const k = String(d).toLowerCase(); if (!ids.has(k)) ids.set(k, nextId++); return ids.get(k); };
const FG = 'f8d:BSHeartland.esm';
const ACTORS = [0x14, ...Array.from({ length: 8 }, (_, i) => 0xff000020 + i)];
const pidOf = (a) => ACTORS.indexOf(a) + 1 || -1;
const load = (expeditions, cfgDungeons = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-raids-'));
  const here = process.cwd(); process.chdir(dir);
  for (const f of ['loot.json', 'ayleid-loot.json', 'dungeon-pools.json']) fs.copyFileSync(path.join(ROOT, f), f);
  fs.writeFileSync('expeditions.json', JSON.stringify({ expeditions }));
  fs.writeFileSync('dungeons.json', JSON.stringify({ dungeons: [] }));
  const props = new Map([[`${idOf('boardref')}|baseDesc`, '6:DragonBreak.esp']]);
  for (const a of ACTORS) { props.set(`${a}|worldOrCellDesc`, FG); props.set(`${a}|pos`, [0, -500, -221]); }
  const widgets = [], said = []; const ticks = {};
  globalThis.__dboDungeonRest = {};
  const cmds = new Map(), ui = new Map(); const savedTimeout = global.setTimeout; global.setTimeout = () => 0;
  globalThis.__dboDungeons = undefined; globalThis.__dboExpeditionPending = undefined;
  try { fs.unlinkSync(path.resolve('parties.json')); } catch (e) { /* none */ }
  delete require.cache[path.join(ROOT, 'dungeons.js')];
  require(path.join(ROOT, 'dungeons.js'))({
    mp: { get: (id, p) => (p === 'profileId' ? pidOf(id) : props.get(`${id}|${p}`)), set: (id, p, v) => props.set(`${id}|${p}`, v), getIdFromDesc: idOf,
      lookupEspmRecordById: (id) => (id === idOf('6:DragonBreak.esp') ? { record: { editorId: 'ExpeditionBoard' } } : { record: null }) },
    log: () => {}, personal: (a, t) => said.push([a, t]), system: (a, t) => said.push([a, t]), audit: () => {}, registerChatCommand: (n, fn) => cmds.set(n, fn),
    onUi: (n, fn) => { const l = ui.get(n) || []; l.push(fn); ui.set(n, l); }, openWidget: (a, w) => { widgets.push([a, w]); return true; }, closeWidget: () => true, sendPacket: () => true,
    findByName: (n) => ACTORS[Number(String(n).slice(1)) - 1] || 0, display: (a) => `P${pidOf(a)}`, who: String, profileOf: pidOf, nameOf: (a) => `P${pidOf(a)}`,
    onlineActors: () => ACTORS, isAdmin: () => true, giveItem: () => true, cfg: { dungeons: cfgDungeons }, every: (n, ms, fn) => { ticks[n] = fn; },
  });
  const fire = (n, a, args) => (ui.get(n) || []).forEach((f) => f(a, args, 0));
  const group = (size) => { for (let i = 1; i < size; i++) { cmds.get('party')(ACTORS[0], `invite P${i + 1}`); cmds.get('party')(ACTORS[i], 'accept'); } };
  const claim = (id, diffId) => {
    widgets.length = 0;
    globalThis.__dboDungeonActivate(idOf('boardref'), ACTORS[0]);
    fire('uiCaps', ACTORS[0], ['expeditionBoard']);
    globalThis.__dboDungeonActivate(idOf('boardref'), ACTORS[0]);
    fire('expeditionPick', ACTORS[0], [id]);
    const pend = globalThis.__dboDungeons.pending.get(ACTORS[0]);
    if (pend) fire('dungeonClaim', ACTORS[0], [pend.nonce, diffId]);
    return globalThis.__dboDungeons.leases.get(id) || null;
  };
  const xp = (a) => props.get(`${a}|private.partyXpMult`);
  const done = () => { global.setTimeout = savedTimeout; process.chdir(here); fs.rmSync(dir, { recursive: true, force: true }); };
  return { props, widgets, said, cmds, fire, group, claim, xp, done, tick: () => ticks['dungeons.tick'](), place: (a, cell) => props.set(`${a}|worldOrCellDesc`, cell) };
};

// ---- 2. what players see -------------------------------------------------------------------------------------------------
{
  const h = load(EXP);
  h.claim('none', 'normal');   // opens the board (the panel, uiCaps on the second use)
  const board = h.widgets.map((w) => w[1]).find((w) => w.type === 'expeditionBoard');
  const kind = (id) => (board.expeditions.find((x) => x.id === id) || {}).kind;
  check('the board says Raid (up to 12) for Silorn and Bawn', kind('CYRSilornLocation') === 'Raid (up to 12)' && kind('CYRBawnLocation') === 'Raid (up to 12)', board && board.expeditions.map((x) => [x.id, x.kind]));
  check('...and Boss dungeon for Niryastare and Telepe', kind('CYRNiryastareLocation') === 'Boss dungeon' && kind('CYRTelepeLocation') === 'Boss dungeon');
  const menu = h.widgets.map((w) => w[1]).find((w) => w.type === 'contextMenu');
  check('an older client\'s list menu says it too', !!menu && menu.actions.some((x) => /^Silorn, Raid \(up to 12\)/.test(x.label)) && menu.actions.some((x) => /^Telepe, Boss dungeon/.test(x.label)), menu && menu.actions.map((x) => x.label));
  globalThis.__dboDungeonActivate(idOf('boardref'), ACTORS[0]);
  h.fire('expeditionPick', ACTORS[0], ['CYRBawnLocation']);
  const gate = h.widgets.map((w) => w[1]).filter((w) => w.type === 'dungeonGate').pop();
  check('the claim panel says "Ayleid ruin, raid (up to 12)"', !!gate && gate.kind === 'Ayleid ruin, raid (up to 12)', gate && gate.kind);
  h.done();
}

// ---- 3. harder: the same ruin as a raid and as a boss dungeon ------------------------------------------------------------
{
  const levelOf = (e) => { const m = new Map(); for (const z of e.zones) for (const n of z.npcs) for (const [lvl, id] of n.options || []) m.set(String(id).toLowerCase(), lvl); return m; };
  const bawn = byId.get('CYRBawnLocation');
  const asBoss = Object.assign({}, bawn, { kind: 'boss' });
  const lv = levelOf(bawn);
  const run = (e, n) => {
    const out = { bossLvl: 0, escorts: 0, others: 0, claims: 0 };
    for (let i = 0; i < n; i++) {
      const h = load([e]);
      const lease = h.claim(e.id, 'hard');
      if (lease) {
        out.claims++;
        for (const z of lease.zones) {
          if (lease.bossZones.has(z.Name)) out.bossLvl += lv.get(String(z.NPC[0].id).toLowerCase()) || 0;
          else if (z.Escort) out.escorts += z.NPC[0].count;
          else out.others += z.NPC[0].count;
        }
      }
      h.done();
    }
    return out;
  };
  const raid = run(bawn, 20), boss = run(asBoss, 20);
  check(`both claim (${raid.claims}, ${boss.claims} of 20)`, raid.claims === 20 && boss.claims === 20);
  check(`a raid's bosses spawn higher leveled variants (level sum ${raid.bossLvl} against ${boss.bossLvl})`, raid.bossLvl > boss.bossLvl);
  // Expert: 2 escorts a boss, times partyCountMult(1) = 0.7 for one player, so one each; a bigger group brings more
  check(`a raid's bosses bring escorts (${raid.escorts} over 20 solo claims, two bosses), a boss dungeon's none (${boss.escorts})`, raid.escorts >= 20 * 2 && boss.escorts === 0);
  check(`a raid has more of the other enemies (${raid.others} against ${boss.others})`, raid.others > boss.others * 1.1);
}

// ---- 4. better: a raid boss chest against a boss dungeon's ---------------------------------------------------------------
{
  const RUIN = 'ef1aa:BSHeartland.esm';
  const chests = Array.from({ length: 1500 }, (_, i) => ({ ref: `b${i.toString(16)}:BSHeartland.esm`, edid: 'CYRTreasAyleidChestBoss', cell: RUIN, pos: [0, 0, 0], big: true }));
  const ruin = (kind) => ({ id: 'Ruin', name: 'Ruin', type: 'ayleid', kind, county: '', cells: [{ desc: RUIN }], chests, zones: [],
    entrances: [{ expedition: true, cell: FG, pos: [0, 0, 0], rot: [0, 0, 0], doorPos: [0, 0, 0], insideDesc: 'ef1ad:BSHeartland.esm', insideCell: RUIN, insidePos: [0, 0, 0], insideRot: [0, 0, 0] }] });
  const POOL = new Map(JSON.parse(fs.readFileSync(path.join(ROOT, 'ayleid-loot.json'), 'utf8')).items.map((it) => [idOf(it.id), it]));
  const measure = (kind) => {
    const h = load([ruin(kind)]);
    h.claim('Ruin', 'nightmare');
    let items = 0, gold = 0, pieces = 0, rarest = 0;
    for (const c of chests) for (const e of (h.props.get(`${idOf(c.ref)}|inventory`) || { entries: [] }).entries) {
      if (e.baseId === idOf('f:Skyrim.esm')) gold += e.count; else items += e.count;
      const it = POOL.get(e.baseId); if (it) { pieces++; if (it.tier === 'rarest') rarest++; }
    }
    h.done();
    return { items: items / chests.length, gold: gold / chests.length, pieces: pieces / chests.length, rarest: rarest / chests.length };
  };
  const r = measure('raid'), b = measure('boss');
  check(`a raid boss chest holds more (${r.items.toFixed(1)} items, ${r.gold.toFixed(0)} gold) than a boss dungeon's (bossRolls 1.5) (${b.items.toFixed(1)}, ${b.gold.toFixed(0)})`, r.items > b.items * 1.3 && r.gold > b.gold * 1.3);
  check(`...more Ayleid treasure (${r.pieces.toFixed(2)} a chest against ${b.pieces.toFixed(2)}) and more of the rarest (${(100 * r.rarest).toFixed(1)}% against ${(100 * b.rarest).toFixed(1)}%)`, r.pieces > b.pieces && r.rarest > b.rarest * 1.5);
}

// ---- 5. skill gain and group size -----------------------------------------------------------------------------------------
{
  const h = load(EXP);
  h.group(8);
  check('a group of 8 is a raid: skill gain halved', ACTORS.slice(0, 8).every((a) => h.xp(a) === 0.5), ACTORS.slice(0, 8).map(h.xp));
  const lease = h.claim('CYRSilornLocation', 'normal');
  check('it claims Silorn, a raid ruin', !!lease && lease.members.size === 8);
  // Exploit audit 2026-09-29: the lift is for members standing in the ruin, not for the whole party wherever it is
  const RUINCELL = byId.get('CYRSilornLocation').cells[0].desc;
  h.tick();
  check('...outside the ruin a lease holder is still halved', ACTORS.slice(0, 8).every((a) => h.xp(a) === 0.5), ACTORS.slice(0, 8).map(h.xp));
  for (const a of ACTORS.slice(0, 8)) h.place(a, RUINCELL);
  h.tick();
  check('...inside the raid ruin nobody is halved', ACTORS.slice(0, 8).every((a) => h.xp(a) === 1), ACTORS.slice(0, 8).map(h.xp));
  h.place(ACTORS[7], FG); h.tick();
  check('...one who walks out is halved again', h.xp(ACTORS[7]) === 0.5 && ACTORS.slice(0, 7).every((a) => h.xp(a) === 1), ACTORS.slice(0, 8).map(h.xp));
  h.cmds.get('party')(ACTORS[0], 'invite P9'); h.cmds.get('party')(ACTORS[8], 'accept'); h.place(ACTORS[8], RUINCELL); h.tick();
  check('...and one who joins the party after the claim holds no share of the lease: halved', h.xp(ACTORS[8]) === 0.5, ACTORS.map(h.xp));
  h.cmds.get('dungeon')(ACTORS[0], 'end CYRSilornLocation');
  for (const a of ACTORS) h.place(a, FG);
  h.tick();
  check('when the lease ends the raid is halved again', ACTORS.every((a) => h.xp(a) === 0.5), ACTORS.map(h.xp));
  h.said.length = 0;
  const telepe = h.claim('CYRTelepeLocation', 'normal');
  check('a boss dungeon refuses a group of 9 (up to 6)', !telepe && h.said.some(([a, t]) => a === ACTORS[0] && /boss dungeon, built for up to 6; your group is 9/.test(t)), h.said.slice(-2));
  h.done();
  const h2 = load(EXP);
  h2.group(5);
  check('a party of 5 claims Telepe', !!h2.claim('CYRTelepeLocation', 'normal'));
  check('...and a party is never halved', ACTORS.slice(0, 5).every((a) => h2.xp(a) === 1), ACTORS.slice(0, 5).map(h2.xp));
  h2.done();
  const h3 = load(EXP);
  check('anyone may start a raid: one player claims Bawn', !!h3.claim('CYRBawnLocation', 'story'));
  h3.done();
}

console.log(failures ? `${failures} FAILED` : 'all checks passed');
process.exit(failures ? 1 : 0);
