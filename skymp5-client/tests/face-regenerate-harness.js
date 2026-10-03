// Scripted test for applyAppearanceToPlayer (sync/appearance.ts): the player's head is rebuilt from the base after the face
// sliders are set and before the NiNode update, a platform build without regenerateHead still applies the rest, and the
// dbo-diag line says how many sliders the base holds. Run from skymp5-client:
//
//   node tests/face-regenerate-harness.js [path to esbuild's package dir]
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const esbuildDir = [process.argv[2], path.resolve(__dirname, '../../skymp5-server/node_modules/esbuild'),
  path.join(os.homedir(), 'dragonbreak/fork/skymp5-server/node_modules/esbuild')].find((p) => p && fs.existsSync(p));
if (!esbuildDir) { console.log('SKIP face-regenerate (no esbuild)'); process.exit(0); }
const esbuild = require(esbuildDir);

let failures = 0;
const check = (name, ok, got) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`);
  if (!ok) failures++;
};

const STUBS = {
  skyrimPlatform: `
    module.exports = {
      Game: { getPlayer: () => globalThis.__face.player, getFormEx: () => null },
      ActorBase: { from: (b) => b }, Actor: { from: (a) => a },
      TESModPlatform: { setNpcSex() {}, setNpcRace() {}, setNpcSkinColor() {}, setNpcHairColor() {}, resizeHeadpartsArray() {},
        clearTintMasks() {}, pushTintMask() {}, setFormIdUnsafe() {}, createNpc: () => null },
      Race: { from: () => null }, HeadPart: { from: () => null }, TextureSet: { from: () => null }, VoiceType: { from: () => null },
      printConsole() {}, once() {}, on() {}, Utility: { wait: () => ({ then() {} }) }, ObjectReference: {},
      writeLogs: (name, line) => globalThis.__face.diag.push([name, line]),
    };`,
};

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-face-'));
  const out = path.join(tmp, 'appearance.js');
  try {
    await esbuild.build({
      entryPoints: [path.resolve(__dirname, '../src/sync/appearance.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out,
      logLevel: 'error',
      plugins: [{ name: 'stubs', setup(b) {
        b.onResolve({ filter: /^skyrimPlatform$/ }, (a) => ({ path: a.path, namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ contents: STUBS[a.path], loader: 'js' }));
      } }],
    });
    run(require(out));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function run({ applyAppearanceToPlayer }) {
  const appearance = { name: 'Fink Winky', raceId: 0x13747, isFemale: false, weight: 75, skinColor: 0, hairColor: 0, headTextureSetId: 0,
    headpartIds: [], tints: [], presets: [30, -1, 29, 26],
    options: [1, 1, -1, 1, -1, 1, 1, -0.42, 0.3, 0, 0.5, -0.5, 0.25, 0.1, -0.1, 0.9, -0.9, 0.6, -0.6] };
  const make = (withRegen) => {
    const calls = [];
    const morphs = new Array(19).fill(0);
    const base = { getFormID: () => 7, setWeight() {}, setNthHeadPart() {}, setFaceTextureSet() {}, setVoiceType() {}, setName() {},
      setFaceMorph: (v, i) => { morphs[i] = v; calls.push('morph'); }, getFaceMorph: (i) => morphs[i],
      setFacePreset: () => calls.push('preset') };
    const player = { getBaseObject: () => base, queueNiNodeUpdate: () => calls.push('niNode'), startDeferredKill() {} };
    if (withRegen) player.regenerateHead = () => calls.push('regenerate');
    globalThis.__face = { player, diag: [] };
    return { calls, morphs };
  };

  let t = make(true);
  applyAppearanceToPlayer(appearance);
  const iRegen = t.calls.indexOf('regenerate'), iLastMorph = t.calls.lastIndexOf('morph'), iNi = t.calls.indexOf('niNode');
  check('the head is regenerated once', t.calls.filter((c) => c === 'regenerate').length === 1, t.calls);
  check('...after every face slider is set', iRegen > iLastMorph && iLastMorph >= 0, t.calls);
  check('...and before the NiNode update', iNi > iRegen, t.calls);
  check('all 19 sliders are on the base', t.morphs.every((v, i) => Math.abs(v - appearance.options[i]) < 1e-6), t.morphs);
  const line = (globalThis.__face.diag[0] || [])[1] || '';
  check('the diag line says it ran and all 19 match', /regenerateHead ran, 19\/19 sliders on the base match/.test(line), globalThis.__face.diag);

  t = make(false);
  let threw = null;
  try { applyAppearanceToPlayer(appearance); } catch (e) { threw = e.message; }
  check('a platform build without regenerateHead still applies the look and the NiNode update', !threw && t.calls.includes('niNode') && t.morphs[7] === -0.42, threw || t.calls);
  check('...and the diag line says it was unavailable', /regenerateHead unavailable/.test(((globalThis.__face.diag[0] || [])[1]) || ''), globalThis.__face.diag);

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
