// Scripted test for autoMoveClear.ts: when a focused mini-game widget opens, does the client tap the player's
// Auto-Move key? The tap is a toggle, so a wrong yes is worse than a wrong no: it would switch auto-run ON for a
// player who was not using it, and they would walk away from the station while they play the round.
//
// autoMoveClear.ts has no imports, so it transpiles on its own. Run it from skymp5-client:
//
//   ./node_modules/typescript/bin/tsc src/services/services/autoMoveClear.ts --outDir /tmp/dbo-automove --module commonjs --target es2019
//   node tests/automove-harness.js /tmp/dbo-automove/autoMoveClear.js
'use strict';
const path = require('path');
const m = require(path.resolve(process.argv[2] || '/tmp/dbo-automove/autoMoveClear.js'));
const { shouldClearAutoMove, isMinigameWidget, looksAutoMoving, MOVING_SPEED } = m;

let failures = 0;
const check = (name, ok, got) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${got !== undefined ? '   ' + JSON.stringify(got) : ''}`);
  if (!ok) failures++;
};
// A sample as the service reads it: SpeedSampled, any movement key held, bInJumpState
const s = (speed, key, air) => ({ speed, movementKeyHeld: !!key, airborne: !!air });
const running = s(MOVING_SPEED + 50, false, false);
const still = s(0, false, false);
const held = s(MOVING_SPEED + 50, true, false);

// ---- which widgets this applies to ------------------------------------------------------------------------------
check('the labour widget is a mini-game', isMinigameWidget('labour'));
check('the skinning widget is a mini-game', isMinigameWidget('skinning'));
check('struggle rides on the labour widget, so it is covered', isMinigameWidget('labour'));
check('an ordinary panel is not', isMinigameWidget('playermenu') === false);
check('a missing type is not', isMinigameWidget(undefined) === false);
check('a number is not a type', isMinigameWidget(33) === false);

// ---- the three in-game cases -----------------------------------------------------------------------------------
check('auto-running into the round: tap', shouldClearAutoMove('labour', [running, running]) === true);
check('holding a movement key: no tap', shouldClearAutoMove('labour', [held, held]) === false);
check('standing still: no tap', shouldClearAutoMove('labour', [still, still]) === false);

// ---- the false positive the two samples are there for -----------------------------------------------------------
// Falling, sliding or being shoved is motion with no key held. One sample of it looks exactly like auto-run.
check('a fall is airborne, so never auto-run', looksAutoMoving(s(MOVING_SPEED + 50, false, true)) === false);
check('motion that has stopped by the second sample: no tap',
  shouldClearAutoMove('labour', [running, still]) === false);
check('...and motion that only starts on the second sample: no tap',
  shouldClearAutoMove('labour', [still, running]) === false);
check('a single sample is never enough', shouldClearAutoMove('labour', [running]) === false);
check('no samples at all: no tap', shouldClearAutoMove('labour', []) === false);
check('something that is not a list of samples: no tap', shouldClearAutoMove('labour', null) === false);

// ---- the speed boundary ----------------------------------------------------------------------------------------
check('exactly at the moving threshold does not count as moving', looksAutoMoving(s(MOVING_SPEED, false, false)) === false);
check('a hair over it does', looksAutoMoving(s(MOVING_SPEED + 0.5, false, false)) === true);
check('a sneaking crawl is still moving with no key held', shouldClearAutoMove('skinning', [s(20, false, false), s(20, false, false)]) === true);

// ---- the property that matters ----------------------------------------------------------------------------------
// The tap is only ever returned for a mini-game widget where EVERY sample shows movement with no key held and both
// feet down. Any other combination must come back false, whatever else is in the samples.
let bad = 0;
const speeds = [0, MOVING_SPEED, MOVING_SPEED + 40];
for (const t of ['labour', 'skinning', 'playermenu', '']) {
  for (const a of speeds) for (const b of speeds) {
    for (const ka of [false, true]) for (const kb of [false, true]) {
      for (const aa of [false, true]) for (const ab of [false, true]) {
        const samples = [s(a, ka, aa), s(b, kb, ab)];
        const got = shouldClearAutoMove(t, samples);
        const want = isMinigameWidget(t) && samples.every((x) => x.speed > MOVING_SPEED && !x.movementKeyHeld && !x.airborne);
        if (got !== want) bad++;
      }
    }
  }
}
check('every combination of two samples agrees with the rule', bad === 0, { disagreements: bad });

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
