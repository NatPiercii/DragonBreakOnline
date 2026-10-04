// Scripted test for ragdollHold.ts: a relayed Ragdoll waits until a new copy (player copies included) has settled, and no
// NiNode update goes to a copy while a relayed Ragdoll plays on it (FaceGen job crashes of 4 Oct 10:18Z and 10:57Z).
// Also checks formView.ts and npcLifetimeRuntime.ts still wire both guards in. Run from skymp5-client:
//
//   node tests/ragdollhold-harness.js [path to esbuild's package dir]
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const esbuildDir = [process.argv[2], path.resolve(__dirname, '../../skymp5-server/node_modules/esbuild'),
  path.join(os.homedir(), 'dragonbreak/fork/skymp5-server/node_modules/esbuild')].find((p) => p && fs.existsSync(p));
if (!esbuildDir) { console.log('SKIP ragdollhold (no esbuild)'); process.exit(0); }
const esbuild = require(esbuildDir);

let failures = 0;
const check = (name, ok, got) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`);
  if (!ok) failures++;
};

async function main() {
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'claude-nate-ragdollhold-'));
  const out = path.join(tmp, 'ragdollHold.js');
  try {
    await esbuild.build({ entryPoints: [path.resolve(__dirname, '../src/view/ragdollHold.ts')], bundle: true, platform: 'node',
      format: 'cjs', outfile: out, logLevel: 'error' });
    run(require(out));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function run({ holdsRelayedRagdoll, niNodeWaitsForRagdoll }) {
  const T = 1_000_000;
  // The two crash trails: spawn, Ragdoll and NiNode within 8 ms
  check('Ragdoll 4 ms after the copy was placed is held (KrizzlePop 10:18:31.429 -> .433)', holdsRelayedRagdoll('Ragdoll', T, T + 4) === true);
  check('Ragdoll 8 ms after placement is held (Rocco 10:56:59.569 -> .577)', holdsRelayedRagdoll('Ragdoll', T, T + 8) === true);
  check('Ragdoll on a copy not yet ready (spawnMoment 0) is held', holdsRelayedRagdoll('Ragdoll', 0, T) === true);
  check('Ragdoll at 1499 ms is still held', holdsRelayedRagdoll('Ragdoll', T, T + 1499) === true);
  check('Ragdoll at 1500 ms goes through (the NPC settle time)', holdsRelayedRagdoll('Ragdoll', T, T + 1500) === false);
  check('an older copy takes a Ragdoll at once', holdsRelayedRagdoll('Ragdoll', T, T + 60000) === false);
  check('other animations of a new copy are not held by this guard', holdsRelayedRagdoll('IdleForceDefaultState', T, T + 4) === false);
  check('no animation at all is not held', holdsRelayedRagdoll(undefined, T, T + 4) === false);
  check('the event name is matched exactly (ragdoll lower case is no relayed Ragdoll)', holdsRelayedRagdoll('ragdoll', T, T + 4) === false);

  check('a copy never ragdolled takes a NiNode update', niNodeWaitsForRagdoll(0, T) === false);
  check('NiNode waits right after a relayed Ragdoll', niNodeWaitsForRagdoll(T, T + 4) === true);
  check('NiNode still waits at 2999 ms', niNodeWaitsForRagdoll(T, T + 2999) === true);
  check('NiNode goes out at 3000 ms (RAGDOLL_HOLD_MS)', niNodeWaitsForRagdoll(T, T + 3000) === false);

  const fv = fs.readFileSync(path.resolve(__dirname, '../src/view/formView.ts'), 'utf8');
  const rt = fs.readFileSync(path.resolve(__dirname, '../src/view/npcLifetimeRuntime.ts'), 'utf8');
  check('formView holds a new copy\'s Ragdoll before applyAnimation',
    /is3DLoaded\(\) && !this\.isSettlingCopy\(model\) && !holdsRelayedRagdoll\(model\.animation\?\.animEventName, this\.spawnMoment, Date\.now\(\)\)/.test(fv));
  check('formView sends no NiNode update while a relayed Ragdoll plays',
    /isOnScreen != this\.isOnScreen && !niNodeWaitsForRagdoll\(ragdolledAtOf\(this\.refrId\), Date\.now\(\)\)/.test(fv));
  check('npcLifetimeRuntime exports the time of the last relayed Ragdoll', /export const ragdolledAtOf = \(id: number\): number => ragdolledAt\.get\(id\) \|\| 0;/.test(rt));
  check('allowRelayedRagdoll still records the time it applies one', /ragdolledAt\.set\(id, Date\.now\(\)\);\s*noteActorCall\("ragdoll", id\);/.test(rt));

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exitCode = failures ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exit(1); });
