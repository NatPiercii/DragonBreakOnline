// Scripted test for fork skymp5-client/src/services/services/wcPluginDeletes.ts and its use in worldCleanerService.ts:
// one "wc:plugin" diagnostic line per burst of living plugin-placed actors removed after an arrival (dungeon crashes,
// 1 Oct: 2,349 such actors stay enabled in 135 dungeons). Bundle it first, then run from this folder's parent:
//
//   ../fork/skymp5-server/node_modules/.bin/esbuild ../fork/skymp5-client/src/services/services/wcPluginDeletes.ts --bundle --platform=node --format=cjs --outfile=<out>
//   FORK=../fork node tests/wc-plugin-deletes-harness.js <out>
'use strict';
const fs = require('fs');
const path = require('path');
const W = require(path.resolve(process.argv[2]));
let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

// ---- the batching ----
const w = new W.WcPluginDeletes();
check('the first cell seen is an arrival with nothing to report', w.seeCell(0x0b07f128, 1000) === null);
check('the same cell again is no arrival', w.seeCell(0x0b07f128, 1100) === null);
check('nothing removed, nothing due', w.due(5000) === null);
w.add(0x0b000101, 0x0b0abc01, true, true, 1300);
w.add(0x0b000102, 0x0b0abc01, false, true, 1310);
w.add(0x0b000101, 0x0b0abc01, true, true, 1320);   // picked again before its removal finished
check('a burst is not reported before its window', w.due(1300 + W.WC_BATCH_MS - 1) === null);
let line = w.due(1300 + W.WC_BATCH_MS);
check('then one line: the cell, how many, in combat, with 3D, how soon after arrival, the bases', line === 'cell b07f128: removed 2 living plugin actor(s), 1 in combat, 2 with 3D, first 300 ms after arrival; bases b0abc01', line);
check('...and only once', w.due(99999) === null);
for (let i = 0; i < 9; i++) w.add(0x0b000200 + i, 0x0b0abc00 + i, false, false, 3000 + i);
line = w.due(3000 + W.WC_BATCH_MS);
check('a later burst in the same cell is its own line, the first few bases only', /removed 9 living plugin actor\(s\), 0 in combat, 0 with 3D, first 2000 ms after arrival; bases b0abc00,b0abc01,b0abc02,b0abc03,b0abc04$/.test(line), line);
w.add(0x0b000300, 0x0b0abc09, false, true, 6000);
line = w.seeCell(0x3c, 6200);
check('an arrival elsewhere ends the open burst at once, under the old cell', /^cell b07f128: removed 1 living/.test(line || ''), line);
w.add(0x0b000301, 0x0b0abc0a, true, true, 6250);
line = w.due(6250 + W.WC_BATCH_MS);
check('...and the next burst belongs to the new cell, timed from that arrival', /^cell 3c: removed 1 .* first 50 ms after arrival/.test(line || ''), line);
check('a window short enough to leave before a crash a few seconds after arrival', W.WC_BATCH_MS > 0 && W.WC_BATCH_MS <= 2000);

// ---- worldCleanerService.ts ----
const src = process.env.FORK && path.join(process.env.FORK, 'skymp5-client/src/services/services/worldCleanerService.ts');
let skipped = 0;
if (!src || !fs.existsSync(src)) {
  const why = !src ? 'FORK is not set' : `${process.env.FORK} has no worldCleanerService.ts`;
  require('./expect')('wc-plugin-deletes', `the worldCleanerService.ts checks cannot run: ${why}`);
  skipped = 4;
  console.log(`SKIP  4 checks of worldCleanerService.ts: ${why}`);
} else {
  const s = fs.readFileSync(src, 'utf8');
  check('the cleaner checks for a due burst every update', /private onUpdate\(\) \{\n\s*this\.notePluginDeletes\(this\.pluginDeletes\.due\(Date\.now\(\)\)\);/.test(s));
  check('...and tells it the player\'s cell before each sweep', /this\.pluginDeletes\.seeCell\(ObjectReferenceEx\.getWorldOrCell\(pc\), Date\.now\(\)\)/.test(s));
  const body = s.slice(s.indexOf('private processOneActor()'), s.indexOf('private noteSpawnSwept'));
  const corpse = body.indexOf('if (actor.isDead() && actorId < 0xff000000)');
  const counts = [...body.matchAll(/this\.countPluginDelete\(actor, actorId\)/g)].map((m) => m.index);
  check('it counts both removal paths (dialogue and the delete), for plugin-placed actors only', counts.length === 2 && /if \(actorId < 0xff000000 && !actor\.isDead\(\)\) this\.countPluginDelete/.test(body) && /\} else \{\n\s*this\.countPluginDelete\(actor, actorId\);/.test(body), counts.length);
  check('corpses are kept before the delete is counted, and the line goes out as "wc:plugin"', corpse > 0 && counts[1] > corpse && /note\("wc:plugin", line\)/.test(s));
}
console.log(failures ? `${failures} FAILED` : skipped ? `all checks run passed, ${skipped} SKIPPED (see above)` : 'all checks passed');
process.exit(failures ? 1 : 0);
