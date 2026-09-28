// Scripted test for NpcSpawnSystem's per-zone Heading and Hostile (the F7 Place tool's NPCs are one-NPC zones that face
// where the GM turned them and are hostile or friendly as the GM chose). Bundle first, then run from this folder's parent:
//
//   ./node_modules/.bin/esbuild ts/systems/npcSpawnSystem.ts --bundle --platform=node --format=cjs --outfile=<out>
//   node tests/spawn-heading-harness.js <out>
'use strict';
const path = require('path');
const { NpcSpawnSystem } = require(path.resolve(process.argv[2]));
const sys = new NpcSpawnSystem(() => {});
let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

const entry = { Name: 'placed:ff000123', ID: 'a764b:BSHeartland.esm', POS: [100, 200, 300], NPC: ['1e80e:Dragonborn.esm 1'], Size: 1500, Despawn: 0, Respawn: 0 };
let d = sys.parseDraft(entry, () => {});
check('a zone without Heading or Hostile reads as before (heading 0, hostility from the base)', d && d.heading === 0 && d.hostile === null, d && [d.heading, d.hostile]);
d = sys.parseDraft(Object.assign({}, entry, { Heading: 450, Hostile: false }), () => {});
check('Heading and Hostile are read (any case, as every field)', d && d.heading === 450 && d.hostile === false, d && [d.heading, d.hostile]);
d = sys.parseDraft(Object.assign({}, entry, { hostile: 'yes' }), () => {});
check('a Hostile that is not true or false is ignored', d && d.hostile === null);

// spawnOne against a mock mp: what the placed NPC is given
const sets = [];
let next = 0xff000500;
const mp = {
  getDescFromId: (id) => (id >>> 0).toString(16),
  getIdFromDesc: (desc) => parseInt(desc, 16),
  callPapyrusFunction: () => ({ desc: (next++).toString(16) }),
  set: (id, k, v) => sets.push([id, k, v]),
  get: (id, k) => (k === 'worldOrCellDesc' ? 'a764b:BSHeartland.esm' : undefined),
  getActorPos: () => [100, 200, 300],
};
const zone = (extra) => Object.assign({ name: 'placed:ff000123', cellOrWorldDesc: 'a764b:BSHeartland.esm', pos: [100, 200, 300], total: 1, anchorId: 0, heading: 0, hostile: null }, extra);
const npc = { baseDesc: '1e80e:Dragonborn.esm', count: 1 };
const spawn = (z) => { sets.length = 0; const id = sys.spawnOne(mp, z, npc, 0, 0xff000001); return { id, loc: (sets.find((s) => s[1] === 'locationalData') || [])[2], hostile: (sets.find((s) => s[1] === 'ff_hostile') || [])[2] }; };

let r = spawn(zone({ heading: 135, hostile: false }));
check('the NPC stands on the zone centre facing the zone heading', r.id && r.loc && r.loc.pos.join() === '100,200,300' && r.loc.rot.join() === '0,0,135', r.loc);
check('Hostile false makes it friendly whatever its base', r.hostile === false);
r = spawn(zone({ heading: 0, hostile: true }));
check('Hostile true makes it hostile', r.hostile === true);
r = spawn(zone({}));
check('without Hostile, the base decides as before (the mock base reads as not hostile)', r.hostile === false && r.loc.rot.join() === '0,0,0');

console.log('');
console.log(failures ? `${failures} FAILURES` : 'all checks passed');
process.exit(failures ? 1 : 0);
