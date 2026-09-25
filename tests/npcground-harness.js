// Scripted test for server\npcground.js: writes a one-cell terrain file (a slope) into a temp folder, loads the
// module with a mock gamemode api and checks the height decoding, the under/over lines and their rate limit.
// No server and no game: run it from this folder's parent with
//
//   node tests\npcground-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const NPCGROUND = path.resolve(__dirname, '..', 'npcground.js');
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'npcground-harness-')));

// Cell 0,0: base 1000, rising 8 units per vertex eastward (x) and 16 per vertex northward (y)
const vhgt = Buffer.alloc(4 + 33 * 33);
vhgt.writeFloatLE(1000 / 8, 0);
for (let y = 0; y < 33; y++) for (let x = 0; x < 33; x++) vhgt.writeInt8(x === 0 ? (y === 0 ? 0 : 2) : 1, 4 + y * 33 + x);
fs.writeFileSync('terrain-heights.json', JSON.stringify({ worlds: { 'a764b:BSHeartland.esm': { cells: { '0,0': vhgt.toString('base64') } } } }));
const heightAt = (x, y) => 1000 + (x / 128) * 8 + (y / 128) * 16;

const WORLD = 'a764b:BSHeartland.esm';
const P = 0x14, P2 = 0x15;
const actors = new Map([
  [P, { pos: [100, 100, heightAt(100, 100)], world: WORLD, profileId: 1 }],
  [P2, { pos: [200, 200, heightAt(200, 200)], world: WORLD, profileId: 2 }],
  [0xff000001, { pos: [512, 512, heightAt(512, 512) - 100], world: WORLD, profileId: -1 }],
  [0xff000002, { pos: [640, 640, heightAt(640, 640) + 2], world: WORLD, profileId: -1 }],
  [0xff000003, { pos: [768, 768, heightAt(768, 768) + 900], world: WORLD, profileId: -1 }],
  [0xff000004, { pos: [896, 896, heightAt(896, 896) - 300], world: WORLD, profileId: -1, isDead: true }],
  [0xff000005, { pos: [1024, 1024, heightAt(1024, 1024) - 300], world: '6ade1:BSHeartland.esm', profileId: -1 }],
  [0xff000006, { pos: [1100, 1100, heightAt(1100, 1100) - 300], world: WORLD, profileId: 3 }],
]);
const neighbors = new Map([[P, [P2, 0xff000001, 0xff000002, 0xff000003]], [P2, [P, 0xff000001, 0xff000004, 0xff000005, 0xff000006]]]);
const mp = {
  get: (id, prop) => {
    const a = actors.get(id);
    if (!a) throw new Error(`Form with id ${id.toString(16)} doesn't exist`);
    if (prop === 'actorNeighbors') return neighbors.get(id) || [];
    if (prop === 'pos') return a.pos.slice();
    if (prop === 'worldOrCellDesc') return a.world;
    if (prop === 'isDead') return !!a.isDead;
    if (prop === 'profileId') return a.profileId;
    if (prop === 'baseDesc') return '4932f:BSHeartland.esm';
    return undefined;
  },
};
const lines = [];
let tick = null;
let now = 1000000;
Date.now = () => now;
require(NPCGROUND)({ mp, log: (...a) => lines.push(a.join(' ')), every: (name, ms, fn) => { tick = fn; }, onlineActors: () => [P, P2], display: (a) => `P${a.toString(16)}`, cfg: { npcGround: { fix: false } } });

let failures = 0;
const check = (label, ok) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`); if (!ok) failures++; };
const count = (re) => lines.filter((l) => re.test(l)).length;

check('file loaded (1 cell)', count(/1 terrain cells in 1 world/) === 1);
const dz = globalThis.__dboTerrainDz;
for (const [x, y] of [[0, 0], [64, 64], [300, 70], [4000, 4000], [127.9, 0.1]]) {
  const got = dz(WORLD, [x, y, heightAt(x, y)]);
  check(`plane height at ${x},${y} decodes exactly (dz ${got})`, got === 0);
}
check('world desc matched without case', dz('A764B:bsheartland.esm', [512, 512, heightAt(512, 512) - 100]) === -100);
check('other world gives null', dz('3c:Skyrim.esm', [0, 0, 0]) === null);
check('outside the data gives null', dz(WORLD, [5000, 5000, 0]) === null);

tick();
check('first sample under: nothing logged yet', count(/npcGround under/) === 0);
now += 5000; tick();
check('second sample under: one line for ff000001', count(/npcGround under ff000001/) === 1);
check('the line names the dz and the player it was near', lines.some((l) => /under ff000001 .* dz -100, near P14 for 2 samples/.test(l)));
check('1 m above the ground is not reported', count(/ff000002/) === 0);
check('900 above is reported over', count(/npcGround over ff000003/) === 1);
check('dead, other world and a player body are skipped', count(/ff000004|ff000005|ff000006/) === 0);
now += 5000; tick();
check('under is not repeated within 60 s', count(/npcGround under ff000001/) === 1);
now += 60000; tick();
check('under is logged again after 60 s', count(/npcGround under ff000001/) === 2);
actors.get(0xff000001).pos[2] = heightAt(512, 512);
now += 5000; tick();
actors.get(0xff000001).pos[2] = heightAt(512, 512) - 100;
now += 60000; tick();
check('a return to the ground resets the sample count', count(/npcGround under ff000001/) === 2);

// A hot reload keeps the parsed file and the per-actor state
const before = globalThis.__dboTerrain.terrain;
delete require.cache[NPCGROUND];
require(NPCGROUND)({ mp, log: (...a) => lines.push(a.join(' ')), every: (name, ms, fn) => { tick = fn; }, onlineActors: () => [P, P2], display: (a) => `P${a.toString(16)}`, cfg: { npcGround: { fix: false } } });
check('reload reuses the parsed terrain', globalThis.__dboTerrain.terrain === before);
now += 5000; tick();
check('reload keeps the sample count', count(/npcGround under ff000001/) === 3);

// ---- the lift: the server puts an NPC held under the terrain back onto it -------------------------------------
const moves = [];
mp.set = (id, prop, v) => { if (prop === 'locationalData') { moves.push([id, v]); actors.get(id).pos = v.pos.slice(); } };
mp.get = ((get) => (id, prop) => (prop === 'angle' ? [0, 0, 90] : get(id, prop)))(mp.get);
const lift = () => { delete require.cache[NPCGROUND]; globalThis.__dboNpcGround = new Map(); lines.length = 0; moves.length = 0;
  require(NPCGROUND)({ mp, log: (...a) => lines.push(a.join(' ')), every: (name, ms, fn) => { tick = fn; }, onlineActors: () => [P, P2], display: (a) => `P${a.toString(16)}`, cfg: {} }); };
lift();
actors.get(0xff000001).pos = [512, 512, heightAt(512, 512) - 200];
now += 5000; tick();
check('lift: one sample under is not enough', moves.length === 0);
now += 5000; tick();
const m = moves.find(([id]) => id === 0xff000001);
check('lift: two samples 200 under put it on the terrain, facing as it was', !!m && m[1].cellOrWorldDesc === WORLD && Math.round(m[1].pos[2]) === Math.round(heightAt(512, 512) + 24) && m[1].rot[2] === 90);
check('lift: it is logged', count(/npcGround lifted ff000001/) === 1);
check('lift: 900 above is never lowered', !moves.some(([id]) => id === 0xff000003));
actors.get(0xff000001).pos[2] = heightAt(512, 512) - 200;
now += 1000; tick(); now += 1000; tick();
check('lift: not again within 5 s', moves.filter(([id]) => id === 0xff000001).length === 1);
now += 5000; tick(); now += 1000; tick();
check('lift: again after 5 s if it sank back', moves.filter(([id]) => id === 0xff000001).length === 2);
lift();
actors.get(P).pos[2] = heightAt(100, 100) - 400;
actors.get(0xff000001).pos = [512, 512, heightAt(512, 512) - 200];
now += 5000; tick(); now += 5000; tick();
check('lift: nothing moves where the player near it is off the terrain data too', moves.length === 0 && count(/npcGround under ff000001/) === 1);
actors.get(P).pos[2] = heightAt(100, 100);
actors.get(0xff000001).pos = [512, 512, heightAt(512, 512) - 60];
lift();
now += 5000; tick(); now += 5000; tick();
check('lift: 60 under is logged but not moved (under 64)', moves.length === 0 && count(/npcGround under ff000001/) === 1);

console.log(failures ? `${failures} failure(s)` : 'all passed');
process.exit(failures ? 1 : 0);
