// Scripted test for copyConfidence.ts and its use in formView.ts: a server-driven copy is Foolhardy (39cd30d32, the flee
// package crashed hosts) unless it is prey, an animal whose own record is Unaggressive and Cowardly or Cautious, which
// keeps its confidence and runs (d88ddb75 judged prey by Aggression 0 alone, which let Bruma's Brave wolves flee).
// The AIDT values below were read from Skyrim.esm and BSHeartland.esm on CT 115 (11 Oct). Run from skymp5-client:
//
//   node tests/preyflee-harness.js [path to esbuild's package dir]
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const esbuildDir = [process.argv[2], path.resolve(__dirname, '../../skymp5-server/node_modules/esbuild'),
  path.join(os.homedir(), 'dragonbreak/fork/skymp5-server/node_modules/esbuild')].find((p) => p && fs.existsSync(p));
if (!esbuildDir) { console.log('SKIP preyflee (no esbuild)'); process.exit(0); }
const esbuild = require(esbuildDir);

let failures = 0;
const check = (name, ok, got) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`);
  if (!ok) failures++;
};

async function main() {
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'claude-nate-preyflee-'));
  const out = path.join(tmp, 'copyConfidence.js');
  try {
    await esbuild.build({ entryPoints: [path.resolve(__dirname, '../src/view/copyConfidence.ts')], bundle: true, platform: 'node',
      format: 'cjs', outfile: out, logLevel: 'error' });
    run(require(out));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function run({ FOOLHARDY, keepsOwnConfidence }) {
  const animal = (aggression, confidence, extra) => Object.assign({ playerCopy: false, hostile: undefined, companion: undefined, person: false, aggression, confidence }, extra || {});
  // [edid, aggression, confidence, keeps its own]
  const records = [
    ['CYREncDeer (BSHeartland 4932F)', 0, 0, true], ['EncDeer', 0, 0, true],
    ['CYREncFox (BSHeartland 4933C)', 0, 0, true], ['CYREncFoxGray', 0, 0, true], ['EncFox', 0, 0, true],
    ['CYREncRabbit (BSHeartland 4933D)', 0, 0, true], ['EncHare', 0, 0, true],
    ['EncElk', 0, 0, true], ['EncGoatWild', 0, 0, true], ['EncGoatDomestic', 0, 1, true], ['EncCow', 0, 0, true], ['EncChicken', 0, 0, true],
    ['CYREncWolf (BSHeartland 03C86, Brave)', 0, 3, false], ['CYREncWolfTimber', 0, 4, false], ['EncWolf', 0, 4, false],
    ['CYREncBearBrown', 0, 4, false], ['CYREncMountainLion', 0, 4, false], ['EncSabreCat', 0, 4, false], ['EncDog', 1, 2, false],
    ['EncSkeever', 1, 4, false], ['CYREncTroll', 2, 4, false], ['EncHorker', 1, 2, false], ['DLC2EncNetchCalf', 0, 2, false],
  ];
  for (const [edid, ag, conf, keeps] of records) check(`${edid}: ${keeps ? 'keeps its own confidence (flees)' : 'Foolhardy'}`, keepsOwnConfidence(animal(ag, conf)) === keeps);
  check('Foolhardy is Confidence 4', FOOLHARDY === 4);
  check('a deer the server flags hostile: Foolhardy', !keepsOwnConfidence(animal(0, 0, { hostile: true })));
  check('a deer flagged not hostile: still prey', keepsOwnConfidence(animal(0, 0, { hostile: false })));
  check('a companion animal: Foolhardy', !keepsOwnConfidence(animal(0, 0, { companion: 'ff000123' })));
  check('a cowardly person (ActorTypeNPC): Foolhardy', !keepsOwnConfidence(animal(0, 0, { person: true })));
  check('a player\'s copy: Foolhardy', !keepsOwnConfidence(animal(0, 0, { playerCopy: true })));
  check('an unreadable confidence (NaN): Foolhardy', !keepsOwnConfidence(animal(0, NaN)));

  const fv = fs.readFileSync(path.resolve(__dirname, '../src/view/formView.ts'), 'utf8');
  check('formView writes Foolhardy unless the copy is prey, in the localImmortal block',
    /actor\.setActorValue\("magicka", COPY_MAGICKA\);[\s\S]{0,400}if \(!FormView\.isPrey\(actor, model\)\) actor\.setActorValue\("Confidence", FOOLHARDY\);\s*this\.localImmortal = true;/.test(fv));
  check('isPrey reads the copy\'s own Aggression and Confidence', /aggression: actor\.getActorValue\("Aggression"\), confidence: actor\.getActorValue\("Confidence"\)/.test(fv));
  const hostility = /private applyHostility\(actor: Actor, model: FormModel\): void \{([\s\S]*?)\n  \}\n/.exec(fv);
  check('applyHostility (run at placement, before the Foolhardy write) never touches Confidence', !!hostility && !/Confidence/.test(hostility[1]));
  check('...and an Aggression it raised marks an attacker: Foolhardy', !keepsOwnConfidence(animal(2, 0)));
  check('the Aggression-only test is gone', !/isPassiveAnimal/.test(fv));
  console.log(failures ? `${failures} FAILED` : 'all checks passed');
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.log('FAIL', e.stack); process.exit(1); });
