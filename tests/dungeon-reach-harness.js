// dungeons.js spawnReach (Nate, 8 Oct: big dungeons should not load a solo host with every enemy at once, and should
// still feel alive): a dungeon with at least minEnemies (ambushers aside) is split into groups (same cell, within
// groupRadius), every zone of it is marked Reach with its group and a reach-sized radius, and the groups at a landing
// spot or holding the boss are prespawned. Smaller dungeons, ambushers and spawnReach.enabled false are left as they were.
// Slices REACH and applyReach out of dungeons.js; also reports what the real dungeons.json would get.
//   node tests/dungeon-reach-harness.js   (from server/)
'use strict';
const fs = require('fs');
const path = require('path');
const SERVER = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(SERVER, 'dungeons.js'), 'utf8');
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got)}`); if (!c) fails++; };
const a = src.indexOf('  const REACH = '), b = src.indexOf('  const zonesFor = ', a);
if (a < 0 || b < 0) { console.log('FAIL spawnReach is not in dungeons.js'); process.exit(1); }
const dist3 = (p, q) => Math.hypot((p[0] || 0) - (q[0] || 0), (p[1] || 0) - (q[1] || 0), (p[2] || 0) - (q[2] || 0));
const make = (C) => new Function('C', 'dist3', 'log', `${src.slice(a, b)}\nreturn applyReach;`)(C, dist3, () => {});
const applyReach = make({});
const zone = (i, cell, pos, extra = {}) => Object.assign({ Name: `dungeon:T:${i}`, ID: cell, POS: pos, Size: 100000, Prespawn: true, Ambush: false }, extra);
const CELL = '1234:Test.esp', CELL2 = '5678:Test.esp';
const build = () => {
  const out = [];
  out.bosses = [];
  for (let i = 0; i < 4; i++) out.push(zone(out.length, CELL, [i * 300, 0, 0]));                 // the landing camp
  for (let i = 0; i < 4; i++) out.push(zone(out.length, CELL, [8000 + i * 300, 0, 0]));          // a far camp
  for (let i = 0; i < 3; i++) out.push(zone(out.length, CELL2, [i * 400, 0, 0]));                // the boss's cell
  out.bosses.push(out[out.length - 1].Name);
  for (let i = 0; i < 2; i++) out.push(zone(out.length, CELL, [20000 + i * 5000, 0, 0]));        // two lone wolves
  out.push(zone(out.length, CELL, [30000, 0, 0], { Ambush: true, Size: 1200, Prespawn: false }));  // an ambusher
  return out;
};
const d = { id: 'T', entrances: [{ insideCell: '0001234:test.esp', insidePos: [100, 0, 0] }] };
let out = build();
applyReach(d, out);
const z = (i) => out[i];
ok(out.filter((x) => !x.Ambush).every((x) => x.Reach === true && x.Size === 4500), 'a 13-enemy dungeon: every enemy waits on approach, within 4500');
ok(z(13).Ambush && !z(13).Reach && z(13).Size === 1200, 'an ambusher keeps its own reach');
ok([0, 1, 2, 3].every((i) => z(i).Group === z(0).Group && z(i).Prespawn), 'the camp at the landing is one group, placed at once (cell ids in any padding and case)');
ok([4, 5, 6, 7].every((i) => z(i).Group === z(4).Group && !z(i).Prespawn) && z(4).Group !== z(0).Group, 'a far camp is its own group and waits');
ok([8, 9, 10].every((i) => z(i).Prespawn) && z(8).Group === z(10).Group, 'the boss\'s whole group is placed at once');
ok(z(11).Group !== z(12).Group && !z(11).Prespawn, 'enemies farther apart than groupRadius wake separately');
out = build().slice(0, 9); out.bosses = [];
applyReach(d, out);
ok(out.every((x) => !x.Reach && x.Size === 100000 && x.Prespawn), 'a dungeon under minEnemies spawns whole, as before');
out = build();
make({ spawnReach: { enabled: false } })(d, out);
ok(out.every((x) => !x.Reach), 'spawnReach.enabled false changes nothing');
ok(/applyReach\(d, out\);\n    return out;/.test(src), 'zonesFor applies it to every claim\'s zones');

// What the real dungeons.json gets (every placement counted once; difficulty and party size change the counts a little)
let dj = null; try { dj = JSON.parse(fs.readFileSync(path.join(SERVER, 'dungeons.json'), 'utf8')); } catch (e) { /* not present */ }
if (dj) {
  const list = Array.isArray(dj.dungeons) ? dj.dungeons : Object.values(dj.dungeons || {});
  const rows = [];
  for (const dd of list) {
    const zs = []; zs.bosses = [];
    for (const zz of dd.zones || []) for (const npc of zz.npcs || []) if (Array.isArray(npc.pos)) zs.push(zone(zs.length, zz.cell, npc.pos));
    applyReach(dd, zs);
    if (zs.some((x) => x.Reach)) rows.push([dd.id, zs.length, new Set(zs.map((x) => x.Group)).size, zs.filter((x) => x.Prespawn).length]);
  }
  rows.sort((p, q) => q[1] - p[1]);
  console.log(`info  ${rows.length} of ${list.length} dungeons wake on approach; the biggest (enemies, groups, placed at once):`);
  for (const r of rows.slice(0, 8)) console.log(`info    ${r[0]}: ${r[1]}, ${r[2]}, ${r[3]}`);
  const st = rows.find((r) => /Serpent/i.test(r[0]));
  if (st) console.log(`info  Serpent's Trail: ${st[1]} enemies in ${st[2]} groups, ${st[3]} placed before the party arrives`);
}
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
