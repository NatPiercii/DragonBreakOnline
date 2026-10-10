// Scripted test for the creator's race override (charCreatorData.ts raceOverrideFor, Nate 10 Oct: the DLE's MaormerRace):
// bundles charCreatorData.ts with esbuild (the name filter stubbed) and runs validateResult on a whole creator result.
// The gameplay layer (server racial.js) publishes globalThis.__dboRaceOverrides once config maormerRace resolves.
//   node tests/charcreator-race-override-harness.js   (from skymp5-server, node_modules present)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = path.resolve(__dirname, '..');
const esbuild = require(path.join(root, 'node_modules', 'esbuild'));
const out = fs.mkdtempSync(path.join(fs.existsSync('/dev/shm') ? '/dev/shm' : os.tmpdir(), 'claude-nate-ccrace-'));
process.on('exit', () => { try { fs.rmSync(out, { recursive: true, force: true }); } catch (e) { /* the OS clears it */ } });
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got)}`); if (!c) fails++; };

(async () => {
  await esbuild.build({
    entryPoints: [path.join(root, 'ts/systems/charCreatorData.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: path.join(out, 'cc.js'), logLevel: 'error',
    plugins: [{ name: 'stubs', setup(b) { b.onResolve({ filter: /^\.\/nameFilter$/ }, () => ({ path: 'nf', namespace: 'stub' })); b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'module.exports = { checkName: () => ({ ok: true }) };', loader: 'js' })); } }],
  });
  const CC = require(path.join(out, 'cc.js'));
  const HIGHELF = 0x13743, MRACE = 0x3c007801;
  const config = { allowChildren: false, disabledRaces: [], statPool: 10 };
  const result = (race, raceId, age = 'adult') => ({
    race, age, sex: 'female', name: 'Orgnum Vae',
    appearance: { raceId, isFemale: true, weight: 50, options: new Array(19).fill(0), presets: [0, 0, 0, 0], headpartIds: [1, 2], headTextureSetId: 0, tints: [], skinColor: 0, hairColor: 0 },
    stats: { strength: 40, endurance: 40, agility: 40, speed: 40, intelligence: 40, willpower: 40, personality: 40, luck: 40 },
    bodyExtras: { muscle: 50, fat: 50 }, backstory: '', description: '',
  });
  delete globalThis.__dboRaceOverrides;
  let r = CC.validateResult(result('maormer', HIGHELF), config);
  ok(r.ok && r.clean.appearance.raceId === HIGHELF, 'no override: a Maormer is made on the High Elf record, as today', r);
  ok(!CC.validateResult(result('maormer', MRACE), config).ok, '...and the DLE race id is refused');
  globalThis.__dboRaceOverrides = {};
  ok(CC.raceOverrideFor('maormer', 'adult') === 0, 'an empty override map: nothing');
  globalThis.__dboRaceOverrides = { maormer: MRACE };
  r = CC.validateResult(result('maormer', HIGHELF), config);
  ok(r.ok && r.clean.appearance.raceId === MRACE && r.clean.race === 'maormer', 'with MaormerRace published: the front\'s High Elf id is accepted and the character is made on MaormerRace', r.ok ? r.clean.appearance.raceId : r);
  r = CC.validateResult(result('maormer', MRACE), config);
  ok(r.ok && r.clean.appearance.raceId === MRACE, '...a front that sends MaormerRace itself is accepted too');
  r = CC.validateResult(result('altmer', HIGHELF), config);
  ok(r.ok && r.clean.appearance.raceId === HIGHELF, 'an Altmer stays on the High Elf record');
  ok(!CC.validateResult(result('altmer', MRACE), config).ok, '...and cannot claim MaormerRace');
  ok(CC.raceOverrideFor('maormer', 'child') === 0, 'no child override (the Maormer have no child race)');
  globalThis.__dboRaceOverrides = { maormer: 'x' };
  ok(CC.raceOverrideFor('maormer', 'adult') === 0, 'a bad id is ignored');
  console.log(fails ? `${fails} failed` : 'all passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL', e.stack); process.exit(1); });
