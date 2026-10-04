// Scripted test for copyMagicka.ts and its use in formView.ts: an NPC copy this client hosts casts from its real base
// magicka, any other copy keeps 1,000,000 (C3, 0.3.77). Run from skymp5-client:
//
//   node tests/copymagicka-harness.js [path to esbuild's package dir]
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const esbuildDir = [process.argv[2], path.resolve(__dirname, '../../skymp5-server/node_modules/esbuild'),
  path.join(os.homedir(), 'dragonbreak/fork/skymp5-server/node_modules/esbuild')].find((p) => p && fs.existsSync(p));
if (!esbuildDir) { console.log('SKIP copymagicka (no esbuild)'); process.exit(0); }
const esbuild = require(esbuildDir);

let failures = 0;
const check = (name, ok, got) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`);
  if (!ok) failures++;
};

async function main() {
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'claude-nate-copymagicka-'));
  const out = path.join(tmp, 'copyMagicka.js');
  try {
    await esbuild.build({ entryPoints: [path.resolve(__dirname, '../src/view/copyMagicka.ts')], bundle: true, platform: 'node',
      format: 'cjs', outfile: out, logLevel: 'error' });
    run(require(out));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function run({ COPY_MAGICKA, realBaseMagicka, copyMagicka }) {
  check('the copy value is 1,000,000', COPY_MAGICKA === 1000000);
  check('a mage\'s base 150 is kept', realBaseMagicka(150) === 150);
  check('0 base magicka is no use (keeps 1,000,000)', realBaseMagicka(0) === undefined);
  check('NaN is no use', realBaseMagicka(NaN) === undefined);
  check('a base already raised to 1,000,000 is no use', realBaseMagicka(1000000) === undefined);
  check('a negative read is no use', realBaseMagicka(-5) === undefined);

  check('hosted with a real base: the real base', copyMagicka(150, true) === 150);
  check('not hosted: 1,000,000', copyMagicka(150, false) === COPY_MAGICKA);
  check('hosted but no real base: 1,000,000', copyMagicka(undefined, true) === COPY_MAGICKA);

  // Walk the formView flow on a fake actor: place, host, lose the host, destroy
  const fv = fs.readFileSync(path.resolve(__dirname, '../src/view/formView.ts'), 'utf8');
  check('formView reads the base before the 1,000,000 write, NPC copies only',
    /this\.realMagicka = model\.appearance \? undefined : this\.readBaseMagicka\(actor\);\s*actor\.setActorValue\("magicka", COPY_MAGICKA\);/.test(fv));
  check('formView syncs the hosted magicka every update', /if \(actor\) this\.syncHostedMagicka\(actor\);/.test(fv));
  check('formView no longer writes a bare 1000000 into magicka', !/setActorValue\("magicka", 1000000\)/.test(fv));
  check('formView forgets the real base on destroy', /this\.localImmortal = false;\s*this\.realMagicka = undefined;\s*this\.magickaSet = undefined;/.test(fv));
  const m = /private syncHostedMagicka\(actor: Actor\): void \{([\s\S]*?)\n  \}\n/.exec(fv);
  check('syncHostedMagicka is there', !!m);
  if (m) {
    const writes = [];
    const actor = { setActorValue: (n, v) => writes.push(['set', n, v]), restoreActorValue: (n, v) => writes.push(['restore', n, v]) };
    const self = { realMagicka: 150, magickaSet: COPY_MAGICKA, hostedLast: false };
    // The method body, run against the module's own copyMagicka (formView's TS annotations are absent from the body)
    const body = new Function('copyMagicka', 'COPY_MAGICKA', 'actor', m[1]);
    const step = () => body.call(self, copyMagicka, COPY_MAGICKA, actor);
    step();
    check('a watcher copy writes nothing', writes.length === 0, writes);
    self.hostedLast = true; step();
    check('hosting starts: base set to 150, then topped up', JSON.stringify(writes) === JSON.stringify([['set', 'magicka', 150], ['restore', 'magicka', COPY_MAGICKA]]), writes);
    step();
    check('...once', writes.length === 2, writes.length);
    self.hostedLast = false; step();
    check('hosting ends: back to 1,000,000, no restore', JSON.stringify(writes.slice(2)) === JSON.stringify([['set', 'magicka', COPY_MAGICKA]]), writes);
    const p = { realMagicka: undefined, magickaSet: COPY_MAGICKA, hostedLast: true };
    const before = writes.length; body.call(p, copyMagicka, COPY_MAGICKA, actor);
    check('a player copy (no real base) is never touched, hosted or not', writes.length === before, writes.length);
    const throwing = { setActorValue: () => { throw new Error('gone'); }, restoreActorValue() {} };
    let threw = false;
    try { body.call({ realMagicka: 80, magickaSet: COPY_MAGICKA, hostedLast: true }, copyMagicka, COPY_MAGICKA, throwing); } catch (e) { threw = true; }
    check('a vanished copy does not throw out of the update', !threw);
  }

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exitCode = failures ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exit(1); });
