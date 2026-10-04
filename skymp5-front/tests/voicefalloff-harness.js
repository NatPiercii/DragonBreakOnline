// Scripted test for voiceFalloff.js (VoiceManager.gainFor): talk is heard as talk and shout as shout at the same
// distance (#bugs 4 Oct: "normal talk is like whispering, yelling is like normal talking"). Run from skymp5-front:
//
//   node tests/voicefalloff-harness.js [path to esbuild's package dir]
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const esbuildDir = [process.argv[2], path.resolve(__dirname, '../../skymp5-server/node_modules/esbuild'),
  path.join(os.homedir(), 'dragonbreak/fork/skymp5-server/node_modules/esbuild')].find((p) => p && fs.existsSync(p));
if (!esbuildDir) { console.log('SKIP voicefalloff (no esbuild)'); process.exit(0); }
const esbuild = require(esbuildDir);

let failures = 0;
const check = (name, ok, got) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`);
  if (!ok) failures++;
};

async function main() {
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'claude-nate-voicefalloff-'));
  const out = path.join(tmp, 'voiceFalloff.js');
  try {
    await esbuild.build({ entryPoints: [path.resolve(__dirname, '../src/utils/voiceFalloff.js')], bundle: true, platform: 'node',
      format: 'cjs', outfile: out, logLevel: 'error' });
    run(require(out));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function run({ voiceFalloff }) {
  const M = 70; // game units per metre
  const W = 140, T = 840, S = 3150; // the server's default ranges (voiceSystem.ts)
  const old = (d, r) => { // the 0.3.76 curve, for comparison
    if (d > r) return 0;
    const ref = Math.max(70, r * 0.08);
    let g = d <= ref ? 1 : ref / (ref + 1.6 * (d - ref));
    const t = d / r; if (t > 0.75) g *= Math.max(0, (1 - t) / 0.25);
    return g;
  };
  const row = (m) => [m, voiceFalloff(m * M, W), voiceFalloff(m * M, T), voiceFalloff(m * M, S)].map((x) => Math.round(x * 100) / 100);
  console.log('   m   whisper talk shout');
  for (const m of [0.5, 1, 1.5, 2, 3, 5, 8, 12, 20, 30, 45]) console.log('   ' + row(m).join('\t'));

  check('the reported case: talk at 3 m was a quarter of full (old curve)', old(3 * M, T) < 0.3, old(3 * M, T));
  check('talk at 3 m is now at least two thirds of full', voiceFalloff(3 * M, T) >= 0.66, voiceFalloff(3 * M, T));
  check('talk is full at 2 m, as close conversation', voiceFalloff(2 * M, T) === 1);
  check('shout at 3 m is full', voiceFalloff(3 * M, S) === 1);
  check('shout at 12 m is louder than talk at 12 m (talk is silent there)', voiceFalloff(12 * M, S) > 0.5 && voiceFalloff(12 * M, T) === 0, [voiceFalloff(12 * M, S), voiceFalloff(12 * M, T)]);
  check('shout at 8 m is louder than talk at 8 m', voiceFalloff(8 * M, S) > voiceFalloff(8 * M, T) + 0.3, [voiceFalloff(8 * M, S), voiceFalloff(8 * M, T)]);
  check('talk at 1.5 m is louder than whisper at 1.5 m', voiceFalloff(1.5 * M, T) > voiceFalloff(1.5 * M, W));
  check('whisper is full within a metre', voiceFalloff(1 * M, W) === 1);
  check('whisper beyond its 2 m is silent', voiceFalloff(2.1 * M, W) === 0);
  let mono = true;
  for (const r of [W, T, S]) for (let d = 0; d < r; d += 5) if (voiceFalloff(d + 5, r) > voiceFalloff(d, r) + 1e-12) mono = false;
  check('never louder further away, in every mode', mono);
  let order = true;
  for (let d = 0; d <= S; d += 5) if (voiceFalloff(d, W) > voiceFalloff(d, T) + 1e-12 || voiceFalloff(d, T) > voiceFalloff(d, S) + 1e-12) order = false;
  check('at any distance whisper <= talk <= shout', order);
  check('the very edge is silent (no cut-off jump)', voiceFalloff(T, T) === 0 && voiceFalloff(S, S) === 0);
  check('out of range is 0', voiceFalloff(T + 1, T) === 0);
  check('no range, a negative or missing distance: 0', voiceFalloff(10, 0) === 0 && voiceFalloff(-1, T) === 0 && voiceFalloff(undefined, T) === 0 && voiceFalloff(NaN, T) === 0);

  const vm = fs.readFileSync(path.resolve(__dirname, '../src/utils/VoiceManager.js'), 'utf8');
  check('VoiceManager.gainFor uses voiceFalloff', /let g = voiceFalloff\(d, r\);/.test(vm) && /import \{ voiceFalloff \} from '\.\/voiceFalloff';/.test(vm));
  check('the old 8% core is gone from VoiceManager', !/r \* 0\.08/.test(vm));
  check('mic capture still has automatic gain control off', /MIC_CAPTURE = Object\.freeze\(\{[^}]*autoGainControl: false/.test(vm));

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exitCode = failures ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exit(1); });
