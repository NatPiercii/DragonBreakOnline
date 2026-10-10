// Scripted test for the lip sync guard (10 Oct, 0.3.90: two FaceGen morph-job crashes about 11 s after a nearby player
// went down, every client on voice). lipSyncGuard.ts has no imports and transpiles on its own; the call sites in
// lipSyncService.ts are checked in the source. Run it from skymp5-client:
//
//   ./node_modules/typescript/bin/tsc src/services/services/lipSyncGuard.ts --outDir /dev/shm/claude-nate-lipguard --module commonjs --target es2019
//   node tests/lipsync-guard-harness.js /dev/shm/claude-nate-lipguard/lipSyncGuard.js
'use strict';
const fs = require('fs');
const path = require('path');
const { RACE_FLAG_FACEGEN_HEAD, mouthSkipReason, createSkipNotes } = require(path.resolve(process.argv[2] || '/dev/shm/claude-nate-lipguard/lipSyncGuard.js'));
const src = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'services', 'lipSyncService.ts'), 'utf8');

let failures = 0;
const check = (name, ok, got) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`);
  if (!ok) failures++;
};

// ---- who may speak ----------------------------------------------------------------------------------------------------
const alive = { loaded: true, disabled: false, dead: false, faceGenHead: true };
check('the FaceGen Head flag is RACE DATA bit 1', RACE_FLAG_FACEGEN_HEAD === 2);
check('a loaded, living humanoid speaks', mouthSkipReason(alive) === '');
check('a downed player\'s copy (killed with Actor.kill) does not', mouthSkipReason({ ...alive, dead: true }) === 'dead');
check('a werewolf or Vampire Lord (no FaceGen head) does not', mouthSkipReason({ ...alive, faceGenHead: false }) === 'noFaceGenHead');
check('a copy with no 3D yet does not', mouthSkipReason({ ...alive, loaded: false }) === 'unloaded');
check('a disabled copy does not', mouthSkipReason({ ...alive, disabled: true }) === 'disabled');
for (const k of Object.keys(alive)) {
  check(`an unread ${k} (the native threw) is refused`, mouthSkipReason({ ...alive, [k]: null }) !== '', mouthSkipReason({ ...alive, [k]: null }));
}
check('a dead werewolf reads as dead first', mouthSkipReason({ ...alive, dead: true, faceGenHead: false }) === 'dead');

// ---- trace lines --------------------------------------------------------------------------------------------------------
const notes = createSkipNotes();
check('the first skip is logged', notes.note(0xff0014c1, 'dead') === 'lips held for ff0014c1: dead');
check('the same skip again is not', notes.note(0xff0014c1, 'dead') === '');
check('a speaking tick logs nothing', notes.note(0xff0014c1, '') === '');
check('a new skip after speaking is logged again', notes.note(0xff0014c1, 'dead') !== '');
notes.forget(0xff0014c1);
check('a forgotten speaker logs afresh', notes.note(0xff0014c1, 'dead') !== '');
check('a signed id prints unsigned', createSkipNotes().note(0xff001415 | 0, 'dead') === 'lips held for ff001415: dead');

// ---- the service uses it ------------------------------------------------------------------------------------------------
const animate = src.slice(src.indexOf('private animate('), src.indexOf('private closeMouth('));
const firstWrite = animate.indexOf('setExpressionPhoneme');
check('animate checks the guard before its first phoneme write', animate.indexOf('mouthSkipReason(') >= 0 && animate.indexOf('mouthSkipReason(') < firstWrite);
const close = src.slice(src.indexOf('private closeMouth('));
check('closeMouth checks it too', close.indexOf('mouthSkipReason(') >= 0 && close.indexOf('mouthSkipReason(') < close.indexOf('setExpressionPhoneme'));
check('the race read uses the FaceGen Head flag', /isRaceFlagSet\(RACE_FLAG_FACEGEN_HEAD\)/.test(src));
const writes = (src.match(/setExpressionPhoneme\(/g) || []).length;
check('no other phoneme writes in the service (3: close in animate, open in animate, closeMouth)', writes === 3, writes);

console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
