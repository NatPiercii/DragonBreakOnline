// Scripted test for the beast race check (GroundedPasta, 10 Oct: downed as a werewolf, the server's revert landed while his
// character lay in bleed-out and did not hold; he woke at the temple a wolf on his own screen). beastRaceCheck.ts has no
// imports and transpiles on its own; the call sites in beastFormService.ts are checked in the source. Run from skymp5-client:
//
//   ./node_modules/typescript/bin/tsc src/services/services/beastRaceCheck.ts --outDir /dev/shm/claude-nate-racecheck --module commonjs --target es2019
//   node tests/beast-race-check-harness.js /dev/shm/claude-nate-racecheck/beastRaceCheck.js
'use strict';
const fs = require('fs');
const path = require('path');
const { wantRace, raceCheckStep, RACE_CHECK_MS, RACE_HELD_CHECKS } = require(path.resolve(process.argv[2] || '/dev/shm/claude-nate-racecheck/beastRaceCheck.js'));
const SRC = fs.readFileSync(path.resolve(__dirname, '..', 'src/services/services/beastFormService.ts'), 'utf8');
let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };
const NORD = 0x13746, WOLF = 0xcdd84;
const up = (raceId) => ({ dead: false, bleeding: false, raceId });

let w = wantRace(NORD, false, 1000);
check('a revert to Nord is watched for five minutes', w.raceId === NORD && w.beast === false && w.until === 1000 + RACE_CHECK_MS && RACE_CHECK_MS === 300000);
let s = raceCheckStep(w, 2000, { dead: false, bleeding: true, raceId: WOLF });
check('in bleed-out, still a wolf: wait, no retry', s.next === w && !s.retry);
s = raceCheckStep(w, 2000, { dead: true, bleeding: false, raceId: WOLF });
check('dead: wait', s.next === w && !s.retry);
s = raceCheckStep(w, 3000, up(WOLF));
check('up again and still a wolf: set the race again', s.retry && s.next && s.next.checks === 0);
w = s.next;
s = raceCheckStep(w, 4000, up(NORD));
check('now Nord: one check counted, still watched', !s.retry && s.next && s.next.checks === 1 && RACE_HELD_CHECKS === 2);
s = raceCheckStep(s.next, 5000, up(NORD));
check('Nord twice while up: held, no longer watched', !s.retry && s.next === null);
w = wantRace(NORD, false, 0);
s = raceCheckStep(raceCheckStep(w, 1, up(NORD)).next, 2, up(WOLF));
check('held once, then undone a moment later: set again', s.retry && s.next.checks === 0);
check('past five minutes: given up', raceCheckStep(wantRace(NORD, false, 0), RACE_CHECK_MS + 1, up(WOLF)).next === null);
check('no player yet: wait', raceCheckStep(w, 5, null).next === w);
check('nothing watched: nothing', raceCheckStep(null, 5, up(WOLF)).next === null && !raceCheckStep(null, 5, up(WOLF)).retry);
check('a signed race id compares as unsigned', raceCheckStep(wantRace(0x8883d, true, 0), 1, up(0x8883d | 0)).retry === false);

check('beastFormService watches a revert the server sends (only a revert: a watched beast race would force the form back after a lost dboBeast)', /player\.setRace\(race\);[\s\S]{0,700}?this\.raceWanted = beast \? null : wantRace\(raceId, beast, Date\.now\(\)\);/.test(SRC));
check('...and a check that throws stops watching instead of throwing on', /catch \(e\) \{ logError\(this, "race check failed", e\); this\.raceWanted = null; return; \}/.test(SRC));
check('...checks it each update (onCameraCheck)', /private onCameraCheck\(\): void \{\s*\n\s*this\.checkRace\(\);/.test(SRC));
check('...and a retry sets the race, the beast flag and the controls again', /player\.setRace\(race\);\s*\n\s*try \{ this\.sp\.Game\.setBeastForm\(w\.beast\);/.test(SRC) && /this\.restoreControls\(\);\s*\n\s*logTrace\(this, "Race did not hold, set again"/.test(SRC));
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
