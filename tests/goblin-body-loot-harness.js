// A lease's goblins are searched with E like any humanoid (#bugs 1555083068547797072, Purr #7DJT 1 Oct 2026: "goblins dont
// seem to drop loot"). dungeons.js isHumanoidTag read the zone's kind against HUMANOID, which had no "goblin": only a goblin
// boss or guard kind matched, so an ordinary goblin's body was neither emptied at death nor searched (only wild:* bodies
// are searched otherwise). The real dungeons.js with the real expeditions.json and loot.json, claim set up as
// expedition-master-loot-harness.js does; goblin zones are added to the live lease:
// 1. every goblin kind in dungeons.json and dungeon-pools.json counts as humanoid now, and no animal kind does;
// 2. E on a goblin's body hands over the body roll a bandit's gets, once; its corpse is emptied at death like a bandit's;
// 3. a wolf of the same lease is still not searched (null: the engine's own body), and a bandit still is.
//   node tests/goblin-body-loot-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let failures = 0;
const check = (label, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${got !== undefined && !ok ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

// ---- 1. the kinds --------------------------------------------------------------------------------------------------
const src = fs.readFileSync(path.join(ROOT, 'dungeons.js'), 'utf8');
const lit = (name) => { const m = new RegExp(`const ${name} = (/.*/[a-z]*);`).exec(src); return m ? eval(m[1]) : null; };
const HUMANOID = lit('HUMANOID'), ANIMAL = lit('ANIMAL');
check('HUMANOID and ANIMAL read from dungeons.js', HUMANOID instanceof RegExp && ANIMAL instanceof RegExp);
const humanoid = (k) => HUMANOID.test(k) && !ANIMAL.test(k);
const kinds = new Set();
for (const d of Object.values(JSON.parse(fs.readFileSync(path.join(ROOT, 'dungeons.json'), 'utf8')).dungeons)) for (const z of d.zones || []) for (const n of z.npcs || []) kinds.add(String(n.edid || ''));
(fs.readFileSync(path.join(ROOT, 'dungeon-pools.json'), 'utf8').match(/"kind": *"[^"]*"/g) || []).forEach((m) => kinds.add(m.split('"')[3]));
const goblins = [...kinds].filter((k) => /goblin/i.test(k));
check(`every goblin kind is a humanoid (${goblins.length} kinds)`, goblins.length > 10 && goblins.every(humanoid), goblins.filter((k) => !humanoid(k)));
const animals = ['CYRLvlWolf', 'LvlBearCave', 'CYRLvlMudcrab', 'riekling_melee', 'CYRLvlTroll', 'LvlSpiderFrostbite'];
check('wolves, bears, mudcrabs, rieklings, trolls and spiders are not', animals.every((k) => !humanoid(k)), animals.filter(humanoid));

// ---- 2-3. the real loot path ---------------------------------------------------------------------------------------
const ids = new Map(); const descs = new Map(); let nextId = 0x100;
const idOf = (d) => { const k = String(d).toLowerCase(); if (!ids.has(k)) { ids.set(k, nextId); descs.set(nextId, k); nextId++; } return ids.get(k); };
const A = 0x14;
const dir = fs.mkdtempSync(path.join(process.env.HARNESS_TMP || (fs.existsSync('/dev/shm') ? '/dev/shm' : os.tmpdir()), 'claude-nate-goblin-'));
const here = process.cwd(); process.chdir(dir);
for (const f of ['loot.json', 'ayleid-loot.json', 'expeditions.json']) fs.copyFileSync(path.join(ROOT, f), f);
fs.writeFileSync('dungeons.json', JSON.stringify({ dungeons: [] }));
const props = new Map([[`${idOf('boardref')}|baseDesc`, '6:DragonBreak.esp'], [`${A}|worldOrCellDesc`, 'f8d:BSHeartland.esm'], [`${A}|pos`, [0, -500, -221]]]);
const given = [], said = [];
const ui = new Map(); const savedTimeout = global.setTimeout; global.setTimeout = () => 0;
globalThis.__dboDungeons = undefined; globalThis.__dboExpeditionPending = undefined;
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
if (pend) fire('dungeonClaim', A, [pend.nonce, 'normal']);
const lease = globalThis.__dboDungeons.leases.get('CYRSilornLocation');
check('a lease is claimed to hang the goblin zones on', !!(lease && lease.kinds));
const zone = (kind, n) => { const tag = `dungeon:CYRSilornLocation:${900 + n}`; lease.kinds[tag] = kind; return tag; };
const GOB = zone('CYRLvlGoblinMelee', 1), GOB_POOL = zone('goblin_missile', 2), WOLF = zone('CYRLvlWolf', 3), BANDIT = zone('CYRLvlBanditMelee1H', 4);
let body = 0xff000500;
const lootBody = (tag) => { const id = body++; props.set(`${id}|private.npcSpawner`, tag); props.set(`${id}|isDead`, true); given.length = 0; const r = globalThis.__dboCorpseLoot(id, A); return { r, got: given.slice(), id }; };
const rollRate = (tag) => { let handled = 0, withLoot = 0; for (let i = 0; i < 600; i++) { const { r, got } = lootBody(tag); if (r === false) handled++; if (got.length) withLoot++; } return { handled, withLoot }; };
const banditRate = rollRate(BANDIT).withLoot;
for (const [label, tag] of [['a dungeons.json goblin (CYRLvlGoblinMelee)', GOB], ['a pool goblin (goblin_missile)', GOB_POOL]]) {
  const { handled, withLoot } = rollRate(tag);
  check(`${label}: E on its body is the server's search (${handled}/600)`, handled === 600);
  check(`${label}: and finds what a bandit's body would (${withLoot}/600 with something; a bandit ${banditRate}/600)`, withLoot > 0 && Math.abs(withLoot - banditRate) < 90);
  const { id } = lootBody(tag);
  given.length = 0;
  check(`${label}: a body is searched once`, globalThis.__dboCorpseLoot(id, A) === false && given.length === 0);
  const corpse = body++; props.set(`${corpse}|private.npcSpawner`, tag); props.set(`${corpse}|inventory`, { entries: [{ baseId: idOf('f:Skyrim.esm'), count: 50 }] });
  globalThis.__dboTrimCorpse(corpse);
  check(`${label}: its corpse is emptied at death, as a bandit's is`, (props.get(`${corpse}|inventory`) || { entries: [1] }).entries.length === 0);
}
check('a wolf of the same lease is not the server\'s to search (null)', lootBody(WOLF).r === null);
check('a bandit still is', lootBody(BANDIT).r === false);
global.setTimeout = savedTimeout; process.chdir(here); fs.rmSync(dir, { recursive: true, force: true });

console.log(failures ? `${failures} FAILED` : 'all checks passed');
process.exit(failures ? 1 : 0);
