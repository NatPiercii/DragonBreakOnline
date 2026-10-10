// Scripted test for the creator's Maormer race data (front charCreator: races.js maormer raceEditorId MaormerRace with
// fallbackEditorId HighElfRace; appearanceBuilder.js editorIdFor). Until headparts.json and tints.json are generated with
// the DLE's MaormerRace, a Maormer reads the High Elf's head parts, tints and defaults; the race id sent stays the High
// Elf's (the server makes the character on MaormerRace: charCreatorData.ts raceOverrideFor). run-all bundles from $FORK:
//   node tests/maormer-race-front-harness.js <bundle of skymp5-front/src/features/charCreator/appearanceBuilder.js>
'use strict';
const fs = require('fs');
const bundle = process.argv[2];
if (!bundle) { console.log('usage: node tests/maormer-race-front-harness.js <bundle>'); process.exit(2); }
if (!/fallbackEditorId/.test(fs.readFileSync(bundle, 'utf8'))) {
  require('./expect')('maormer-race-front', 'this front has no Maormer race fallback');
  console.log('ok   skipped: this front predates the Maormer race');
  process.exit(0);
}
const B = require(bundle);
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got).slice(0, 300)}`); if (!c) fails++; };
const maormer = { id: 'maormer', raceId: 0x13743, raceEditorId: 'MaormerRace', fallbackEditorId: 'HighElfRace' };
const altmer = { id: 'altmer', raceId: 0x13743, raceEditorId: 'HighElfRace' };
const ed = B.editorIdFor(maormer, 'adult');
ok(ed === 'HighElfRace' || ed === 'MaormerRace', 'editorIdFor gives MaormerRace when the data knows it, else the High Elf\'s', ed);
if (ed === 'HighElfRace') {
  ok(JSON.stringify(B.partsFor('hair', maormer, 'adult', 'female')) === JSON.stringify(B.partsFor('hair', altmer, 'adult', 'female')) && B.partsFor('hair', maormer, 'adult', 'female').length > 0, 'before the data: a Maormer has the High Elf\'s hair to choose from');
  ok(JSON.stringify(B.defaultSkinRgb(maormer, 'adult', 'male')) === JSON.stringify(B.defaultSkinRgb(altmer, 'adult', 'male')), '...and the High Elf\'s skin tones');
} else ok(B.partsFor('hair', maormer, 'adult', 'female').length > 0, 'with the data: MaormerRace\'s own hair');
ok(B.editorIdFor(altmer, 'adult') === 'HighElfRace' && B.editorIdFor({ raceEditorId: 'NordRace', childRaceId: 1 }, 'child') === 'NordRaceChild', 'other races are as before');
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
