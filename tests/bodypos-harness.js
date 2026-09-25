// Scripted test for fork skymp5-client/src/sync/bodyPos.ts: which position a host reports for an NPC it drives.
// Bundle it first, then run from this folder's parent:
//
//   ../fork/skymp5-server/node_modules/.bin/esbuild ../fork/skymp5-client/src/sync/bodyPos.ts --bundle --platform=node --format=cjs --outfile=<out>
//   node tests\bodypos-harness.js <out>
'use strict';
const path = require('path');
const { reportedPos, forgetBody } = require(path.resolve(process.argv[2]));
let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };
const same = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-6);
const learn = (id, ref, offset) => { for (let i = 0; i < 5; i++) reportedPos(id, ref, [ref[0], ref[1], ref[2] + offset]); };

// A humanoid: root at the feet (offset 0)
learn(1, [0, 0, 100], 0);
check('body and reference together: the reference is reported', same(reportedPos(1, [10, 0, 100], [10, 0, 100]), [10, 0, 100]));
check('a small split (under 48) still reports the reference', same(reportedPos(1, [0, 0, 100], [0, 0, 130]), [0, 0, 100]));
check("the ogre: body on the path, reference 212 below: the body is reported", same(reportedPos(1, [0, 0, -112], [0, 0, 100]), [0, 0, 100]));
check('a sinking body (reference above it) is reported too', same(reportedPos(1, [0, 0, 300], [0, 0, 100]), [0, 0, 100]));
check('a sideways split reports where the body walked to', same(reportedPos(1, [0, 0, 100], [400, 0, 100]), [400, 0, 100]));

// A creature whose root sits 90 above its reference: never floated by that offset
learn(2, [0, 0, 0], 90);
check('a high root is learned, not reported as a float', same(reportedPos(2, [5, 0, 0], [5, 0, 90]), [5, 0, 0]));
check('its later vertical split reports the feet, not the root', same(reportedPos(2, [0, 0, -200], [0, 0, 90]), [0, 0, 0]));

// Learning waits for body and reference to be together
reportedPos(3, [0, 0, 0], [300, 0, 0]);
check('while learning, the reference is reported even if split', same(reportedPos(3, [0, 0, 0], [300, 0, 0]), [0, 0, 0]));
learn(3, [0, 0, 0], 0);
check('after five together samples the rule applies', same(reportedPos(3, [0, 0, 0], [300, 0, 0]), [300, 0, 0]));

// Forgetting on unload relearns
forgetBody(2);
check('an unloaded actor relearns before reporting its body', same(reportedPos(2, [0, 0, -200], [0, 0, 90]), [0, 0, -200]));
check('a broken node position is ignored', same(reportedPos(1, [0, 0, 100], [NaN, 0, 100]), [0, 0, 100]));

console.log('');
console.log(failures ? `${failures} FAILURES` : 'all checks passed');
process.exit(failures ? 1 : 0);
