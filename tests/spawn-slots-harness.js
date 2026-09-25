// Scripted test for NpcSpawnSystem.slotPos: outer slots stand on the terrain under them (globalThis.__dboTerrainAt from
// server\npcground.js) when the zone centre stands on the terrain. Bundle first, then run from this folder's parent:
//
//   ./node_modules/.bin/esbuild ts/systems/npcSpawnSystem.ts --bundle --platform=node --format=cjs --outfile=<out>
//   node tests\spawn-slots-harness.js <out>
'use strict';
const path = require('path');
const { NpcSpawnSystem } = require(path.resolve(process.argv[2]));
const sys = new NpcSpawnSystem(() => {});
const slot = (zone, i) => sys.slotPos(zone, i).map((n) => Math.round(n));
let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

const zone = { cellOrWorldDesc: 'a764b:BSHeartland.esm', pos: [0, 0, 0], total: 7 };
delete globalThis.__dboTerrainAt;
check('without terrain data, outer slots keep the centre height + 16 (old behaviour)', slot(zone, 1)[2] === 16, slot(zone, 1));
// A hillside rising one unit per unit eastward (x)
globalThis.__dboTerrainAt = (desc, x, y) => (/bsheartland/i.test(desc) ? { lo: x, hi: x } : null);
check('the centre slot stays where it was placed', JSON.stringify(slot(zone, 0)) === '[0,0,0]', slot(zone, 0));
check('the uphill slot stands on the hill, not inside it', slot(zone, 1)[0] === 96 && slot(zone, 1)[2] === 96 + 16, slot(zone, 1));
check('the downhill slot stands on the ground, not in the air', slot(zone, 4)[0] === -96 && slot(zone, 4)[2] === -96 + 16, slot(zone, 4));
const onRock = Object.assign({}, zone, { pos: [0, 0, 400] });
check('a centre on a rock keeps its height for every slot', slot(onRock, 1)[2] === 416, slot(onRock, 1));
const interior = Object.assign({}, zone, { cellOrWorldDesc: '1234:Skyrim.esm' });
check('an interior (no terrain data) keeps the old behaviour', slot(interior, 1)[2] === 16, slot(interior, 1));
globalThis.__dboTerrainAt = () => { throw new Error('boom'); };
check('a failing lookup falls back quietly', slot(zone, 1)[2] === 16, slot(zone, 1));

console.log('');
console.log(failures ? `${failures} FAILURES` : 'all checks passed');
process.exit(failures ? 1 : 0);
