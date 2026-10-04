// The map of whole buildings (server\buildings.json from tools/buildings_build.py, Nate 4 Oct): its shape, the Bruma
// buildings the property work rests on, and, where the plugins are on this box, that it is current (--check).
//   node tests/buildings-map-harness.js
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const map = JSON.parse(fs.readFileSync(path.join(ROOT, 'buildings.json'), 'utf8'));
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${what}${!c && got !== undefined ? '   ' + JSON.stringify(got).slice(0, 400) : ''}`); if (!c) fails++; };
const byCell = new Map();
for (const b of map.buildings) for (const c of b.cells) byCell.set(c.toLowerCase(), b);
const at = (cell) => byCell.get(cell.toLowerCase()) || null;

ok(Array.isArray(map.buildings) && map.buildings.length > 500 && map.buildings.every((b) => b.id && b.cells.length && b.entrances.length), 'every building has cells and a way in', map.counts);
ok(new Set(map.buildings.flatMap((b) => b.cells)).size === map.buildings.reduce((n, b) => n + b.cells.length, 0), 'no cell is in two buildings');
const castle = at('6c40f:BSHeartland.esm');
ok(castle && castle.cells.length === 6 && ['6c40e', '6c410', '6c40d', '6c40c', '72653'].every((c) => castle.cells.includes(`${c}:BSHeartland.esm`)) && castle.entrances.length === 1 && castle.entrances[0].inside === '6c473:BSHeartland.esm' && !castle.flags,
  'Castle Bruma is one building of six cells, one way in (the door Frigga holds)', castle && { cells: castle.cells, entrances: castle.entrances });
ok(castle && castle.innerDoors.includes('7f027:BSHeartland.esm') && castle.innerDoors.includes('7f028:BSHeartland.esm'), '...7f027/7f028 are an inner pair of it, not a second way in');
const cathedral = at('12cb:BSHeartland.esm');
ok(cathedral && cathedral.cells.length === 3 && cathedral.entrances.some((e) => e.door === '7a817:BSHeartland.esm') && cathedral.innerDoors.includes('4807c:BSHeartland.esm'), "the Cathedral of St Martin holds Sylvia's rooms, and 7a817 is a way in", cathedral && cathedral.cells);
const fort = at('b5936:BSHeartland.esm');
ok(fort && (fort.flags || []).includes('dungeon') && fort.entrances.length === 7, 'Fort Caractacus is flagged a dungeon (dungeons.json): the claim code walks it as before', fort && fort.flags);
ok(map.counts && map.counts.bruma === map.buildings.filter((b) => b.world === 'a764b:BSHeartland.esm').length, 'the Bruma count matches');

// Current against the plugins, where they are (the dev server)
const py = spawnSync('python3', ['--version']);
if (fs.existsSync('/opt/skyrim-data') && !py.error) {
  const r = spawnSync('nice', ['-n', '19', 'python3', path.join(ROOT, 'tools', 'buildings_build.py'), '--check'], { encoding: 'utf8', timeout: 110000 });
  ok(r.status === 0, 'buildings.json is current with the plugins (tools/buildings_build.py --check)', (r.stdout || '') + (r.stderr || ''));
} else console.log('skipped: the --check needs the plugins (/opt/skyrim-data) and python3');
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
