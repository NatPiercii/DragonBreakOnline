// champions.js pays one reward per kill, shared by damage, with one gem roll (economy review, 2026-09-29, M7): each
// fighter with 10% of the damage used to get the full 25-120 gold and a gem roll, so a party of alts multiplied it.
//   node tests/champion-reward-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const MODULE = path.resolve(__dirname, '..', 'champions.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-champions-'));
process.chdir(dir);
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });

let pass = 0, fail = 0;
const ok = (c, what, got) => { if (c) pass++; else { fail++; console.log('FAIL', what, got === undefined ? '' : JSON.stringify(got)); } };
const A = 0x14, B = 0xff000015, C = 0xff000016, GEM = 0x63b45;
const props = new Map();
const given = [];
const timers = {};
const mp = {
  get: (id, k) => (k === 'isOnline' ? [A, B, C].includes(id) : k === 'percentages' ? { health: 1, magicka: 1, stamina: 1 } : props.get(`${id}|${k}`)),
  set: (id, k, v) => props.set(`${id}|${k}`, v),
  getDescFromId: (id) => id.toString(16), getIdFromDesc: () => GEM, callPapyrusFunction: () => null,
};
require(MODULE)({
  mp, log: () => {}, personal: () => {}, audit: () => {}, display: String, giveItem: (a, id, n) => { given.push({ a, id, n }); return true; },
  loot: { pools: { gems: [{ id: '63b45:Skyrim.esm' }] } }, registerChatCommand: () => {}, sendPacket: () => {}, onlineActors: () => [A, B, C],
  every: (n, ms, fn) => { timers[n] = fn; }, stopTimer: () => {}, cfg: { champions: { goldReward: [100, 101], gemChance: 1 } },
});
let nextId = 0xff000500;
const champion = () => {
  const id = nextId++;
  props.set(`${id}|private.npcSpawner`, 'wild:wolf:0');
  fs.writeFileSync('zone-spawns.json', JSON.stringify([id]));
  const real = Math.random; Math.random = () => 0; timers.champions(); Math.random = real;
  return id;
};
const gold = (a) => given.filter((g) => g.a === a && g.id === 0xf).reduce((n, g) => n + g.n, 0);
const gems = () => given.filter((g) => g.id === GEM).length;
const withRandom = (r, fn) => { const real = Math.random; Math.random = () => r; try { fn(); } finally { Math.random = real; } };

// Alone: the whole reward
let id = champion();
globalThis.__dboChampionHit(A, id, 100);
withRandom(0, () => globalThis.__dboChampionDeath(id, A));
ok(gold(A) === 100 && gems() === 1, 'a lone fighter gets the whole reward and the gem', { gold: gold(A), gems: gems() });

// Three fighters: one pot (x1.4 for two extra fighters), shared by damage, one gem
given.length = 0;
id = champion();
globalThis.__dboChampionHit(A, id, 50); globalThis.__dboChampionHit(B, id, 30); globalThis.__dboChampionHit(C, id, 20);
withRandom(0, () => globalThis.__dboChampionDeath(id, A));
const total = gold(A) + gold(B) + gold(C);
ok(total <= 140 && total >= 137, 'three fighters share one reward, a little more than one alone', total);
ok(gold(A) === 70 && gold(B) === 42 && gold(C) === 28, '...by their share of the damage', [gold(A), gold(B), gold(C)]);
ok(gems() === 1, '...with one gem between them', gems());

// Equal fighters: the party's bonus stays within groupBonusMax (x2 at most)
given.length = 0;
id = champion();
for (const a of [A, B, C]) globalThis.__dboChampionHit(a, id, 10);
withRandom(0, () => globalThis.__dboChampionDeath(id, A));
ok(gold(A) + gold(B) + gold(C) <= 200, 'a party never takes more than groupBonusMax over one reward', gold(A) + gold(B) + gold(C));

console.log(`${pass}/${pass + fail}`);
process.exitCode = fail ? 1 : 0;
