// What a full clear gives (Nate, 2026-09-28: "you need to trim down the loot given across all expeditions and levels").
// The real dungeons.js with the real expeditions.json, dungeons.json, loot.json, ayleid-loot.json and dungeon-pools.json.
// A solo claim of each expedition at each difficulty, CLAIMS times: every big chest, boss chest and container as it is
// filled, every humanoid body looted with E (one per enemy the claim spawns) and every master. Creatures keep what the
// engine gave them (the corpse trim), which is not measured here. Value: loot.json and ayleid-loot.json item values,
// coin at 1 each.
//   node tests/expedition-loot-budget-harness.js            (from server/): checks the budget, prints the table
//   node tests/expedition-loot-budget-harness.js --table    the table only, no checks (to measure another version)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(process.env.DBO_SERVER_ROOT || path.join(__dirname, '..'));
const TABLE_ONLY = process.argv.includes('--table');
const CLAIMS = Number(process.env.CLAIMS) || 150;
let failures = 0;
const check = (label, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${got !== undefined && !ok ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

const ids = new Map(); const descOf = new Map(); let nextId = 0x100;
const idOf = (d) => { const k = String(d).toLowerCase(); if (!ids.has(k)) { ids.set(k, nextId); descOf.set(nextId, k); nextId++; } return ids.get(k); };
const loot = JSON.parse(fs.readFileSync(path.join(ROOT, 'loot.json'), 'utf8'));
const VALUE = new Map();
for (const list of Object.values(loot.pools)) for (const it of list) VALUE.set(idOf(it.id), Number(it.value) || 0);
const AYLEID = new Map(JSON.parse(fs.readFileSync(path.join(ROOT, 'ayleid-loot.json'), 'utf8')).items.map((it) => [idOf(it.id), it]));
for (const [id, it] of AYLEID) VALUE.set(id, Number(it.value) || 0);
const GOLD = idOf('f:Skyrim.esm');
// Linen wraps (Nate, 4 Oct: "in a reasonable amount"), counted on their own; vanilla's value is 2
const LINEN = idOf('34cd6:Skyrim.esm');
VALUE.set(LINEN, 2);
// A humanoid carries a plain weapon from the pools, so the body's gear roll (2026-09-30) is measured through the real trim
const WEAPONS = (loot.pools.weapons || []).filter((it) => !/Ebony|Daedric/i.test(it.name) && Number(it.value) > 0).map((it) => ({ id: idOf(it.id), desc: it.id, name: it.name, value: Number(it.value) }));
// Spawned foes are armed within their difficulty's material tiers (dungeons.js weaponFor, loottiers.js ENEMY)
const TIERS = require(path.join(ROOT, 'loottiers.js'))({ materials: JSON.parse(fs.readFileSync(path.join(ROOT, 'loot-materials.json'), 'utf8')), factionGear: JSON.parse(fs.readFileSync(path.join(ROOT, 'faction-gear.json'), 'utf8')) });
const armedAt = (diffId) => WEAPONS.filter((w) => { const c = TIERS.classOf(w.desc); return c.kind === 'gear' && TIERS.enemyTiers(diffId, false).includes(c.tier); });
const WEAPON_REC = new Map(WEAPONS.map((w) => [w.id, { record: { type: 'WEAP', editorId: w.name, flags: 0, fields: [] } }]));
const LIGHTS = new Set((loot.pools.lights || []).map((it) => idOf(it.id)));
const HUMANOID = /bandit|highwayman|marauder|outlaw|thug|forsworn|draugr|falmer|orc|soldier|guard|thalmor|vampire|hunter|warlock|necromancer|conjurer|mage|cultist|silverhand|reaver|smuggler|pirate|warrior|dremora|boss/i;
const ANIMAL = /wolf|bear|skeever|spider|chaurus|troll|sabre|mudcrab|horker|slaughterfish|deer|elk|goat|fox|hare|dog|mammoth|giant|atronach|wisp|spriggan|hagraven|sphere|centurion|ballista|ghost|dragon|frostbite|netch|riekling|ashhopper|ogre|minotaur|dreugh|gargoyle|werewolf|werebear|ashspawn|lurker|seeker|scamp|clannfear|daedroth|dragonpriest|horse|cow|chicken/i;

const A = 0x14;
// Math.random, seeded per dungeon, difficulty and claim count. The loot rolls are dungeons.js's own, so an unseeded run
// measured a fresh sample each time, and a band's edge (Telepe at Master, 0.71 against under 0.7) failed run-all 1 run
// in 10 (2026-09-30). Seeded, each measurement is the same sample every run, and one dungeon's draws never move another's.
let rngState = 0;
const reseed = (key) => { let h = 2166136261; for (const c of String(key)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); rngState = h >>> 0; };
Math.random = () => {
  rngState = (rngState + 0x6d2b79f5) >>> 0;
  let t = Math.imul(rngState ^ (rngState >>> 15), rngState | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
// One module load per dungeon and difficulty; claims repeat by ending the lease and clearing the rest period
const measure = (d, diffId, claims = CLAIMS) => {
  reseed(`${d.raw.id}|${diffId}|${claims}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-budget-'));
  const here = process.cwd(); process.chdir(dir);
  for (const f of ['loot.json', 'ayleid-loot.json', 'dungeon-pools.json']) fs.copyFileSync(path.join(ROOT, f), f);
  fs.writeFileSync('expeditions.json', JSON.stringify({ expeditions: d.expedition ? [d.raw] : [] }));
  fs.writeFileSync('dungeons.json', JSON.stringify({ dungeons: d.expedition ? [] : [d.raw] }));
  const e0 = d.raw.entrances[0];
  const props = new Map([[`${idOf('boardref')}|baseDesc`, '6:DragonBreak.esp']]);
  const setHome = () => { props.set(`${A}|worldOrCellDesc`, d.expedition ? 'f8d:BSHeartland.esm' : (e0.world || e0.cell)); props.set(`${A}|pos`, d.expedition ? [0, -500, -221] : e0.doorPos || e0.pos); };
  setHome();
  const given = []; const ui = new Map(), cmds = new Map();
  const savedTimeout = global.setTimeout; global.setTimeout = () => 0;
  globalThis.__dboDungeons = undefined; globalThis.__dboExpeditionPending = undefined;
  delete require.cache[path.join(ROOT, 'dungeons.js')];
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'gamemode-config.json'), 'utf8'));
  require(path.join(ROOT, 'dungeons.js'))({
    mp: { get: (id, p) => (p === 'profileId' ? (id === A ? 1 : -1) : props.get(`${id}|${p}`)), set: (id, p, v) => props.set(`${id}|${p}`, v), getIdFromDesc: idOf, getDescFromId: (id) => descOf.get(id),
      lookupEspmRecordById: (id) => (id === idOf('6:DragonBreak.esp') ? { record: { editorId: 'ExpeditionBoard' } } : WEAPON_REC.get(id) || { record: null }) },
    log: () => {}, personal: () => {}, system: () => {}, audit: () => {}, registerChatCommand: (n, fn) => cmds.set(n, fn), onUi: (n, fn) => { const l = ui.get(n) || []; l.push(fn); ui.set(n, l); },
    openWidget: () => true, closeWidget: () => true, sendPacket: () => true, findByName: () => 0, display: String, who: String, profileOf: (a) => (a === A ? 1 : -1), nameOf: () => 'P',
    onlineActors: () => [A], isAdmin: () => true, giveItem: (a, base, n) => { given.push([base, n]); return true; }, cfg: { dungeons: cfg.dungeons || {} }, every: () => {},
  });
  const fire = (n, a, args) => (ui.get(n) || []).forEach((f) => f(a, args, 0));
  const tot = { claims: 0, items: 0, stacks: 0, gold: 0, value: 0, boss: { n: 0, items: 0, gold: 0, value: 0 }, big: { n: 0, items: 0 }, small: { n: 0, items: 0, empty: 0 }, bodies: { n: 0, items: 0 }, masters: { n: 0, items: 0, gold: 0 }, ayleid: 0, rarest: 0, torchChests: 0, gearBodies: 0 };
  const add = (entries, bucket) => {
    let items = 0, gold = 0;
    for (const [base, n] of entries) {
      if (base === GOLD) { gold += n; tot.gold += n; tot.value += n; continue; }
      items += n; tot.items += n; tot.stacks++; tot.value += (VALUE.get(base) || 0) * n;
      if (base === LINEN) tot.linen = (tot.linen || 0) + n;
      const ay = AYLEID.get(base); if (ay) { tot.ayleid++; if (ay.tier === 'rarest') tot.rarest++; }
    }
    if (bucket) { bucket.n++; bucket.items += items; if (bucket.gold !== undefined) bucket.gold += gold; }
    return { items, gold };
  };
  let body = 0xff000500;
  for (let c = 0; c < claims; c++) {
    setHome(); props.delete(`${A}|private.dungeonCooldowns`); if (globalThis.__dboDungeonAccountRest) globalThis.__dboDungeonAccountRest.clear();
    if (d.expedition) { globalThis.__dboDungeonActivate(idOf('boardref'), A); fire('expeditionPick', A, [d.raw.id]); }
    else globalThis.__dboDungeonActivate(idOf(e0.outsideDesc), A);
    const pend = globalThis.__dboDungeons.pending.get(A);
    if (pend) fire('dungeonClaim', A, [pend.nonce, diffId]);
    const lease = globalThis.__dboDungeons.leases.get(d.raw.id);
    if (!lease) break;
    tot.claims++;
    const named = new Set([].concat(d.raw.bossChest || []).map((r) => String(r).toLowerCase()));
    for (const ch of d.raw.chests || []) {
      const entries = ((props.get(`${idOf(ch.ref)}|inventory`) || { entries: [] }).entries).map((e) => [e.baseId, e.count]);
      const boss = ch.big && (/boss/i.test(ch.edid) || named.has(ch.ref.toLowerCase()));
      const r = add(entries, boss ? tot.boss : ch.big ? tot.big : tot.small);
      if (boss) tot.boss.value += entries.reduce((v, [b, n]) => v + (b === GOLD ? n : (VALUE.get(b) || 0) * n), 0);
      if (!ch.big && !r.items && !r.gold) tot.small.empty++;
      if (ch.big && !boss && entries.some(([b]) => LIGHTS.has(b))) tot.torchChests++;
    }
    for (const z of lease.zones) {
      const master = lease.bossZones && lease.bossZones.has(z.Name);
      const humanoid = HUMANOID.test(z.Kind || '') && !ANIMAL.test(z.Kind || '');
      if (!master && !humanoid) continue;
      for (let k = 0; k < (master ? 1 : z.NPC[0].count); k++) {
        const id = body++; props.set(`${id}|private.npcSpawner`, z.Name); props.set(`${id}|isDead`, true);
        const armed = armedAt(diffId);
        const weapon = armed[id % armed.length];
        props.set(`${id}|inventory`, { entries: [{ baseId: weapon.id, count: 1 }] });
        globalThis.__dboTrimCorpse(id);
        given.length = 0;
        if (globalThis.__dboCorpseLoot(id, A) !== false) continue;
        if (!master && given.some(([b]) => b === weapon.id)) tot.gearBodies++;
        add(given.slice(), master ? tot.masters : tot.bodies);
      }
    }
    cmds.get('dungeon')(A, `end ${d.raw.id.toLowerCase()}`);
  }
  global.setTimeout = savedTimeout; process.chdir(here); fs.rmSync(dir, { recursive: true, force: true });
  const per = (x) => (tot.claims ? x / tot.claims : 0);
  const avg = (b, k) => (b.n ? b[k] / b.n : 0);
  return { claims: tot.claims, linen: per(tot.linen || 0), items: per(tot.items), gold: per(tot.gold), value: per(tot.value), ayleid: per(tot.ayleid), rarest: per(tot.rarest),
    bossChest: { items: avg(tot.boss, 'items'), gold: avg(tot.boss, 'gold'), value: avg(tot.boss, 'value') }, bigChest: avg(tot.big, 'items'),
    small: { items: avg(tot.small, 'items'), empty: tot.small.n ? tot.small.empty / tot.small.n : 0 }, body: avg(tot.bodies, 'items'),
    torch: tot.big.n ? tot.torchChests / tot.big.n : 0, bodyGear: tot.bodies.n ? tot.gearBodies / tot.bodies.n : 0, master: { items: avg(tot.masters, 'items'), gold: avg(tot.masters, 'gold') } };
};

const EXP = JSON.parse(fs.readFileSync(path.join(ROOT, 'expeditions.json'), 'utf8')).expeditions.map((e) => ({ raw: e, expedition: true, name: e.name, kind: e.kind }));
// Every ordinary dungeon a player can reach in the Bruma playtest (an entrance in the Cyrodiil world inside the border
// region 0B0CBCDD of DragonBreak Online Edits, not excluded), plus Echo Cave, which Nate asked about
const ORD_IDS = ['CYRAngaLocation', 'CYRBeastsMawLocation', 'CYRBorealStoneCaveLocation', 'CYRBrumaCavernsLocation', 'CYRCapstoneCaveLocation', 'CYRFingerbowlCaveLocation', 'CYRFortCutpurseLocation', 'CYRFortHorunnLocation', 'CYRFreezewindHollowLocation', 'CYRFrostfireGladeLocation', 'CYRFrozenGrottoLocation', 'CYRGuttedMineLocation', 'CYRHjaltisRefugeLocation', 'CYRLakesideRetreatLocation', 'CYRNorthfringeSanctumLocation', 'CYROutlawEndreCaveLocation', 'CYRPlunderedMineLocation', 'CYRRedRubyCaveLocation', 'CYRRielleLocation', 'CYRSedorLocation', 'CYRSerpentsTrailLocation', 'CYRSilvertoothCaveLocation', 'CYRToadstoolHollowLocation', 'CYRUnderpallLocation', 'CYRUnmarkedCaveLocation', 'CYREchoCaveLocation'];
// A site config dungeons.exclude takes out (Echo Cave, Hjaltis Refuge, Frozen Grotto: nothing to fight, 8 Oct) is no claim to measure
const EXCLUDED = new Set(((JSON.parse(fs.readFileSync(path.join(ROOT, 'gamemode-config.json'), 'utf8')).dungeons || {}).exclude) || []);
const ORD = JSON.parse(fs.readFileSync(path.join(ROOT, 'dungeons.json'), 'utf8')).dungeons.filter((d) => ORD_IDS.includes(d.id) && !EXCLUDED.has(d.id)).map((d) => ({ raw: d, expedition: false, name: d.name, kind: 'ordinary' }));
const DIFFS = ['story', 'normal', 'hard', 'nightmare'];
const rows = [];
const ORD_CLAIMS = Number(process.env.ORD_CLAIMS) || (TABLE_ONLY ? CLAIMS : 60);
// A dungeon of a chest or two is all luck at 60 claims (Boreal Stone Cave, one boss chest, failed the guard about one
// run in two): each ordinary dungeon is claimed until about 600 of its containers have been filled, 600 claims at most
const claimsFor = (d) => (d.expedition ? CLAIMS : Math.max(ORD_CLAIMS, Math.min(600, Math.ceil(600 / Math.max(1, (d.raw.chests || []).length)))));
for (const d of EXP.concat(ORD)) for (const diff of DIFFS) rows.push({ d, diff, m: measure(d, diff, claimsFor(d)) });
const f1 = (x) => x.toFixed(1), f0 = (x) => x.toFixed(0);
console.log(`per solo clear, ${CLAIMS} claims each: items / gold / value | boss chest items, gold, value | big chest items | urn items (empty %) | body items | master items, gold | Ayleid pieces (rarest)`);
for (const { d, diff, m } of rows) console.log(`${(d.name + ' (' + d.kind + ')').padEnd(34)} ${diff.padEnd(9)} ${f1(m.items).padStart(6)} ${f0(m.gold).padStart(6)} ${f0(m.value).padStart(7)} | ${f1(m.bossChest.items).padStart(5)} ${f0(m.bossChest.gold).padStart(4)} ${f0(m.bossChest.value).padStart(5)} | ${f1(m.bigChest).padStart(4)} | ${f1(m.small.items)} (${f0(100 * m.small.empty)}%) | ${f1(m.body)} | ${f1(m.master.items)}, ${f0(m.master.gold)} | ${m.ayleid.toFixed(2)} (${m.rarest.toFixed(3)})`);
const JSON_OUT = process.argv.indexOf('--json');
if (JSON_OUT > 0) fs.writeFileSync(process.argv[JSON_OUT + 1], JSON.stringify(Object.fromEntries(rows.map((r) => [`${r.d.raw.id}|${r.diff}`, r.m])), null, 1) + '\n');
{
  // Linen wraps per solo clear: ordinary dungeons (untrimmed) and expeditions (their trim thins every roll)
  const avgL = (list) => list.reduce((n, r) => n + r.m.linen, 0) / Math.max(1, list.length);
  const ordL = (diff) => avgL(rows.filter((r) => !r.d.expedition && r.diff === diff)), expL = (diff) => avgL(rows.filter((r) => r.d.expedition && r.diff === diff));
  console.log(`linen wraps per solo clear, Novice/Adept/Expert/Master: ordinary ${DIFFS.map((x) => ordL(x).toFixed(2)).join(' / ')}; expeditions ${DIFFS.map((x) => expL(x).toFixed(2)).join(' / ')}`);
  const most = rows.filter((r) => r.diff === 'normal').sort((a, b) => b.m.linen - a.m.linen).slice(0, 3).map((r) => `${r.d.name} ${r.m.linen.toFixed(1)}`);
  console.log(`      the most at Adept: ${most.join(', ')}`);
  if (!TABLE_ONLY) {
    check(`linen wraps: about 2 to 3 per ordinary clear (${DIFFS.map((x) => ordL(x).toFixed(1)).join(', ')}), fewer in a trimmed expedition (${DIFFS.map((x) => expL(x).toFixed(1)).join(', ')})`,
      DIFFS.every((x) => ordL(x) > 1 && ordL(x) < 4.5 && expL(x) > 0.3 && expL(x) < ordL(x) * 1.5));
  }
}
if (TABLE_ONLY) process.exit(0);

// ---- the budget (2026-09-28): fewer things per clear, Novice lowest, ordinary dungeons unchanged ----------------------
// Since the material tiers (loottiers.js, Nate 1 Oct; option A chosen that night): the budget is held in ITEMS per clear,
// about a quarter of the old untrimmed count as before the tiers (0.20-0.34). The VALUE per clear is no longer held to
// half: a boss chest and a master still give a piece every time (Nate, 2026-09-28) and that piece now comes from the
// boss row (glass at Expert and Master), so a clear is worth about 0.82-0.92 of the old untrimmed value (it was
// 0.47-0.59); the expeditions' ordinary chests hold gear half as often (expeditionLoot.gearScale 0.5). The value is only
// kept under the old untrimmed value as a whole.
const BEFORE = JSON.parse(fs.readFileSync(path.join(__dirname, 'expedition-loot-budget-before.json'), 'utf8'));
for (const { d, diff, m } of rows) {
  const b = BEFORE[`${d.raw.id}|${diff}`];
  if (!b) continue;
  // Ordinary dungeons get the same trim (Nate, 2026-09-28: "push it all"). One dungeon's share depends on what it is made
  // of: a cave of sacks and coffins keeps less (urns are now mostly empty), one with several boss chests more (each
  // keeps its coin and piece of gear certain). So the set is held to half below, and each dungeon only to a wide guard.
  if (!d.expedition) continue;
  // One ruin at one difficulty swings a few points with its luck; the set of ruins below holds the band
  check(`${d.name} ${diff}: ${f1(m.items)} items per clear of ${f1(b.items)} (${(m.items / b.items).toFixed(2)}); value ${(m.value / b.value).toFixed(2)} of the old`, m.items < b.items * 0.4 && m.items > b.items * 0.15);
}
for (const diff of DIFFS) {
  const now = EXP.reduce((n, d) => n + rows.find((r) => r.d === d && r.diff === diff).m.value, 0);
  const was = EXP.reduce((n, d) => n + ((BEFORE[`${d.raw.id}|${diff}`] || {}).value || 0), 0);
  const nowItems = EXP.reduce((n, d) => n + rows.find((r) => r.d === d && r.diff === diff).m.items, 0);
  const wasItems = EXP.reduce((n, d) => n + ((BEFORE[`${d.raw.id}|${diff}`] || {}).items || 0), 0);
  check(`all ${EXP.length} expeditions at ${diff}: ${f1(nowItems)} items of ${f1(wasItems)} (${(nowItems / wasItems).toFixed(2)}, about a quarter); value ${f0(now)} of ${f0(was)} (${(now / was).toFixed(2)}, under the old)`,
    nowItems > wasItems * 0.18 && nowItems < wasItems * 0.36 && now < was * 0.95);
}
// The ordinary dungeons' value is held without their coin: coin was cut on purpose on 4 Oct (gold-cut-1004, about 60% less a
// clear; tests/gold-cut-harness.js holds it), and in a small dungeon it was a fifth of the value (Freezewind Hollow 0.75)
const goods = (m) => (Number(m.value) || 0) - (Number(m.gold) || 0);
for (const d of ORD) {
  const now = DIFFS.reduce((n, diff) => n + goods(rows.find((r) => r.d === d && r.diff === diff).m), 0);
  const was = DIFFS.reduce((n, diff) => n + goods(BEFORE[`${d.raw.id}|${diff}`] || {}), 0);
  // Untrimmed again (Nate, 2026-09-30): about the old value, more where bodies outnumber containers (a bandit mine of 15
  // containers gains about 1.9x from its bodies' gear), a little less in torches; the whole set is held tighter below
  if (was > 0) check(`${d.name} (ordinary, ${(d.raw.chests || []).length} containers), all difficulties: ${f0(now)} of ${f0(was)} (${(now / was).toFixed(2)})`, now > was * 0.8 && now < was * 2.5);
}
for (const diff of DIFFS) {
  const now = ORD.reduce((n, d) => n + goods(rows.find((r) => r.d === d && r.diff === diff).m), 0);
  const was = ORD.reduce((n, d) => n + goods(BEFORE[`${d.raw.id}|${diff}`] || {}), 0);
  check(`all ${ORD.length} ordinary dungeons at ${diff}: ${f0(now)} of ${f0(was)} (${(now / was).toFixed(2)}) without coin, the old value again`, now > was * 0.9 && now < was * 1.5);
}
{
  const total = (diff) => ORD.reduce((n, d) => n + rows.find((r) => r.d === d && r.diff === diff).m.value, 0);
  check(`ordinary dungeons: Novice gives the least (${DIFFS.map((x) => f0(total(x))).join(', ')})`, DIFFS.slice(1).every((x) => total('story') < total(x)));
  const avgOf = (list, f) => list.reduce((n, m) => n + f(m), 0) / Math.max(1, list.length);
  // Torches were the most common chest find (groundedpasta, 2026-09-29), and a rare one since Nate's 10 Oct nerf (3% of
  // ordinary big chests, was 12%; 8% times the trim in the ruins, was 35%); a bandit hands over its weapon now and then
  const ordAt = (diff, f) => avgOf(rows.filter((r) => !r.d.expedition && r.diff === diff && (r.d.raw.chests || []).some((c) => c.big)).map((r) => r.m), f);
  const expAt = (diff, f) => avgOf(rows.filter((r) => r.d.expedition && r.diff === diff).map((r) => r.m), f);
  for (const diff of DIFFS) {
    const t = ordAt(diff, (m) => m.torch), te = expAt(diff, (m) => m.torch);
    check(`${diff}: a torch in ${f0(100 * t)}% of ordinary big chests (3% aimed), ${f0(100 * te)}% in the dark ruins (8% x the trim)`, t > 0.01 && t < 0.06 && te > 0.01 && te < 0.07);
    const g = avgOf(rows.filter((r) => !r.d.expedition && r.diff === diff && r.m.body > 0).map((r) => r.m), (m) => m.bodyGear);
    check(`${diff}: ${f0(100 * g)}% of ordinary humanoid bodies hand over their weapon (25% aimed)`, g > 0.18 && g < 0.32);
  }
}
for (const d of EXP) {
  const v = DIFFS.map((diff) => rows.find((r) => r.d === d && r.diff === diff).m.value);
  check(`${d.name}: Novice gives the least (${v.map(f0).join(' < ')})`, v[0] < v[1] && v[0] < v[2] && v[0] < v[3]);
}
const at = (kind, diff) => rows.filter((r) => r.d.expedition && r.d.kind === kind && r.diff === diff).map((r) => r.m);
const mean = (list, f) => list.reduce((s, m) => s + f(m), 0) / Math.max(1, list.length);
for (const diff of DIFFS) {
  const bd = mean(at('boss', diff), (m) => m.bossChest.items), rd = mean(at('raid', diff), (m) => m.bossChest.items);
  check(`${diff}: a boss dungeon's boss chest holds ${f1(bd)} items (4 to 6 aimed; 9 before)`, bd >= 3 && bd <= 6.5);
  check(`${diff}: a raid's holds ${f1(rd)}, about 1.5x (${f1(rd / bd)}x)`, rd / bd > 1.2 && rd / bd < 1.8);
  const bg = mean(at('boss', diff).concat(at('raid', diff)), (m) => m.bigChest);
  check(`${diff}: an ordinary big chest holds ${f1(bg)} items (usually 1-2)`, bg <= 2.2);
  const u = mean(at('boss', diff).concat(at('raid', diff)), (m) => m.small.empty);
  check(`${diff}: urns and sacks are mostly empty (${f0(100 * u)}%)`, u >= 0.55);
}
check('the rarest Ayleid pieces come only at Master', rows.filter((r) => r.d.expedition && r.diff !== 'nightmare').every((r) => r.m.rarest === 0));
console.log(failures ? `${failures} FAILED` : 'all checks passed');
process.exit(failures ? 1 : 0);
