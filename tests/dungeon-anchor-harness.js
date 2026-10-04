// G3 (4 Oct): a dungeon enemy whose anchor ref the server never loads (DragonBreak Online Edits disables it, or it starts
// dead) failed every spawn on it: "Form with id 0x80863d2 doesn't exist" (159 refs in Underpall, Red Ruby Cave, Fort
// Cutpurse, Anga, Niryastare, Plundered Mine, Silorn). The real dungeons.js claims Telepe with every other anchor
// missing from the mock world: those zones carry no Anchor (they spawn at the spot) but keep Placed for their
// template's factions; the rest keep their Anchor; each ref is asked of the server once.
//   node tests/dungeon-anchor-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got).slice(0, 600)}`); if (!c) fails++; };
const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));

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


const d = EXP.find((x) => /Telepe/.test(x.id));
reseed('anchor');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-anchor-'));
process.chdir(dir);
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* left */ } });
for (const f of ['loot.json', 'ayleid-loot.json', 'dungeon-pools.json', 'artifacts.json', 'dragon-materials.json']) { try { fs.copyFileSync(path.join(ROOT, f), f); } catch (e) { /* optional */ } }
fs.writeFileSync('expeditions.json', JSON.stringify({ expeditions: [d] }));
fs.writeFileSync('dungeons.json', JSON.stringify({ dungeons: [] }));
const refs = [...new Set([].concat(...d.zones.map((z) => z.npcs.map((n) => n.ref))).filter(Boolean))];
const missing = new Set(refs.filter((r, i) => i % 2 === 0).map((r) => idOf(r)));
const asked = new Map();
const props = new Map([[`${idOf('boardref')}|baseDesc`, '6:DragonBreak.esp']]);
props.set(`${A}|worldOrCellDesc`, 'f8d:BSHeartland.esm'); props.set(`${A}|pos`, [0, -500, -221]);
const ui = new Map(), cmds = new Map(), logs = [];
global.setTimeout = () => 0;
require(path.join(ROOT, 'dungeons.js'))({
  mp: { get: (id, p) => {
      if (p === 'profileId') return id === A ? 1 : -1;
      if (p === 'baseDesc' && missing.has(id)) { asked.set(id, (asked.get(id) || 0) + 1); throw new Error(`Form with id 0x${id.toString(16)} doesn't exist`); }
      if (p === 'baseDesc' && refs.map(idOf).includes(id)) asked.set(id, (asked.get(id) || 0) + 1);
      return props.get(`${id}|${p}`);
    }, set: (id, p, v) => props.set(`${id}|${p}`, v), getIdFromDesc: idOf, getDescFromId: (id) => descs.get(id),
    lookupEspmRecordById: (id) => (id === idOf('6:DragonBreak.esp') ? { record: { editorId: 'ExpeditionBoard' } } : REC.has(id) ? { record: REC.get(id) } : { record: null }) },
  log: (...a) => logs.push(a.join(' ')), personal: () => {}, system: () => {}, audit: () => {}, registerChatCommand: (n, fn) => cmds.set(n, fn), onUi: (n, fn) => { const l = ui.get(n) || []; l.push(fn); ui.set(n, l); },
  openWidget: () => true, closeWidget: () => true, sendPacket: () => true, findByName: () => 0, display: String, who: String, profileOf: (a) => (a === A ? 1 : -1), nameOf: () => 'P',
  onlineActors: () => [A], isAdmin: () => true, giveItem: () => true, cfg: { dungeons: Object.assign({}, cfg.dungeons || {}) }, every: () => {},
});
const fire = (n, a, args) => (ui.get(n) || []).forEach((f) => f(a, args, 0));
const claim = () => {
  props.set(`${A}|worldOrCellDesc`, 'f8d:BSHeartland.esm'); props.delete(`${A}|private.dungeonCooldowns`); if (globalThis.__dboDungeonAccountRest) globalThis.__dboDungeonAccountRest.clear();
  globalThis.__dboDungeonActivate(idOf('boardref'), A); fire('expeditionPick', A, [d.id]);
  const pend = globalThis.__dboDungeons.pending.get(A); if (pend) fire('dungeonClaim', A, [pend.nonce, 'nightmare']);
  return globalThis.__dboDungeons.leases.get(d.id);
};
const lease = claim();
ok(!!lease && lease.zones.length >= 10, `Telepe claimed on Master: ${lease ? lease.zones.length : 0} enemy zones, ${refs.length} anchor refs, ${missing.size} of them not in the world`);
const withRef = (lease ? lease.zones : []).filter((z) => z.Placed);
const badAnchor = withRef.filter((z) => missing.has(idOf(z.Placed)) && z.Anchor);
const lostAnchor = withRef.filter((z) => !missing.has(idOf(z.Placed)) && z.Anchor !== z.Placed);
ok(withRef.length >= 10 && withRef.some((z) => missing.has(idOf(z.Placed))) && !badAnchor.length, 'a zone whose anchor the server does not load has no Anchor (it spawns at the spot) and keeps Placed', badAnchor.map((z) => z.Name));
ok(!lostAnchor.length && withRef.some((z) => z.Anchor), 'a zone whose anchor loads keeps it as Anchor', lostAnchor.map((z) => z.Name));
const spawns = JSON.parse(fs.readFileSync('NPC-Spawns.json', 'utf8')).zones.filter((z) => /^dungeon:/.test(z.Name));
ok(spawns.length === lease.zones.length && !spawns.some((z) => z.Anchor && missing.has(idOf(z.Anchor))), 'NPC-Spawns.json names no missing anchor');
ok(logs.filter((t) => /dungeon anchor .* is not in the server's world/.test(t)).length === new Set(withRef.filter((z) => missing.has(idOf(z.Placed))).map((z) => z.Placed)).size, 'each missing anchor is logged once');
cmds.get('dungeon')(A, `end ${d.id.toLowerCase()}`);
const before = new Map(asked);
claim();
ok([...asked].every(([id, n]) => n === before.get(id) || !before.has(id)), 'a second claim asks the server about no ref again', [...asked].filter(([id, n]) => n !== before.get(id)).length);
const SRC = fs.readFileSync(path.join(ROOT, 'dungeons.js'), 'utf8');
ok(/zone && \(zone\.Placed \|\| zone\.Anchor\) \? placedBase\(zone\.Placed \|\| zone\.Anchor\)/.test(SRC), 'factionCheck reads the placement from Placed');

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
