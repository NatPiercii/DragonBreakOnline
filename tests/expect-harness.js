// EXPECT_FEATURES (tests/expect.js, tests/run-all.sh): a guarded harness skips when its feature is missing, and fails
// instead when the gate says the line must carry it. Checks the helper, every guarded harness on a build without its
// feature (an empty bundle, a captureSystem stub without rope), and run-all's own skip of a missing widget.
//   node tests/expect-harness.js
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
let fails = 0, checks = 0;
const ok = (c, what, got) => { checks++; if (!c) { fails++; console.log(`FAIL  ${what}${got === undefined ? '' : '   ' + JSON.stringify(got)}`); } };
const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^EXPECT_/.test(k)));
const run = (args, env) => { const r = spawnSync(process.execPath, args, { cwd: ROOT, env: Object.assign({}, clean, env), encoding: 'utf8', timeout: 30000 }); return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }; };

// ---- the helper ----
const probe = (env) => run(['-e', "require('./tests/expect')('crafted-credit', 'no credit here'); console.log('carried on')"], env);
ok(probe({}).code === 0 && /carried on/.test(probe({}).out), 'nothing expected: the guard carries on to its skip');
ok(probe({ EXPECT_FEATURES: 'all' }).code === 1, 'EXPECT_FEATURES=all: the skip fails');
ok(probe({ EXPECT_FEATURES: 'mastery-award, crafted-credit' }).code === 1, 'a comma list naming it (spaces allowed): fails');
ok(probe({ EXPECT_FEATURES: 'mastery-award,craft-weight' }).code === 0, 'a list without it: carries on');
ok(probe({ EXPECT_CRAFTED_CREDIT: '1' }).code === 1, 'EXPECT_CRAFTED_CREDIT=1 on its own: fails');
ok(probe({ EXPECT_CRAFTED_CREDIT: '0' }).code === 0, 'EXPECT_CRAFTED_CREDIT=0: carries on');
ok(/FAIL  crafted-credit is expected .*no credit here/.test(probe({ EXPECT_FEATURES: 'all' }).out), 'the failure names the harness and why', probe({ EXPECT_FEATURES: 'all' }).out);

// ---- every guarded harness, on a build without its feature ----
const scratch = fs.mkdtempSync(path.join(require('os').tmpdir(), 'claude-nate-expect-'));
const empty = path.join(scratch, 'empty.js'); fs.writeFileSync(empty, '');
const noRope = path.join(scratch, 'capture.js'); fs.writeFileSync(noRope, 'exports.CaptureSystem = class { constructor() {} };\n');
const GUARDED = {
  'crafted-credit': empty, 'craft-weight': empty, 'mastery-award': empty, 'mastery-boost': empty, 'mastery-cast-route': empty,
  'capture-rope': noRope, 'shrine-panel-widget': empty, 'class-lectern': empty, 'contracts-tab': empty, 'school-meters': empty,
  'study-magic': empty, 'supernatural-tab': empty, 'name-release': empty, 'client-calendar': empty, 'trade-open-hook': empty,
};
for (const [name, bundle] of Object.entries(GUARDED)) {
  const h = `tests/${name}-harness.js`;
  const plain = run([h, bundle], {});
  ok(plain.code === 0 && /skip/i.test(plain.out), `${name}: skips on a build without its feature`, plain);
  const want = run([h, bundle], { EXPECT_FEATURES: name });
  ok(want.code === 1 && new RegExp(`FAIL  ${name} is expected`).test(want.out), `${name}: fails when the gate expects it`, want);
  const all = run([h, bundle], { EXPECT_FEATURES: 'all' });
  ok(all.code === 1, `${name}: fails under EXPECT_FEATURES=all`, all);
}
// name-release's second skip: a spawn.ts bundle from a fork without the delete fix
const noNameKey = path.join(scratch, 'spawn.js'); fs.writeFileSync(noNameKey, 'exports.Spawn = class {};\n');
const oldFork = run(['tests/name-release-harness.js', noNameKey], {});
ok(oldFork.code === 0 && /SKIP  deleting a character \(this fork/.test(oldFork.out), 'name-release: skips the delete checks on a fork without the fix', oldFork);
const oldForkWant = run(['tests/name-release-harness.js', noNameKey], { EXPECT_FEATURES: 'name-release' });
ok(oldForkWant.code === 1 && /FAIL  name-release is expected .*does not free the name/.test(oldForkWant.out), 'name-release: fails on that fork when the gate expects it', oldForkWant);
// No other harness may skip on a missing feature without the guard: a new skip must call tests/expect.js too
const unguarded = fs.readdirSync(path.join(ROOT, 'tests')).filter((f) => f.endsWith('-harness.js') && f !== 'expect-harness.js')
  .filter((f) => { const s = fs.readFileSync(path.join(ROOT, 'tests', f), 'utf8'); return /(predates|has no |credits no )[^\n]*process\.exit\(0\)|console\.log\([^)]*(predates|has no )[^\n]*\n[^\n]*process\.exit\(0\)/.test(s) && !/require\('\.\/expect'\)/.test(s); });
ok(!unguarded.length, 'every harness that skips on a missing feature asks tests/expect.js first', unguarded);
fs.rmSync(scratch, { recursive: true, force: true });

// ---- run-all's own skip, for a widget file the client line lacks ----
const RUNALL = fs.readFileSync(path.join(ROOT, 'tests', 'run-all.sh'), 'utf8');
const fn = (n) => { const m = new RegExp(`^${n}\\(\\) \\{.*$`, 'm').exec(RUNALL); return m ? m[0] : ''; };
ok(fn('expected') && fn('lacks'), 'run-all defines expected() and lacks()');
const lacks = (env) => {
  const script = `${fn('expected')}\n${fn('lacks')}\nname=study-magic; FORK=/x; pass=0; fail=0; failed=(); skipped=()\nlacks skymp5-front/src/features/studyMagic/index.tsx\necho "pass=$pass fail=$fail skipped=\${skipped[*]}"`;
  const r = spawnSync('bash', ['-c', script], { env: Object.assign({}, clean, env), encoding: 'utf8' });
  return r.stdout.trim();
};
ok(/^ok   study-magic \(skipped: no .*\)\npass=1 fail=0 skipped=study-magic$/.test(lacks({})), 'run-all: a missing widget is a skip, and listed', lacks({}));
ok(/^FAIL study-magic \(expected, but no .*\)\npass=0 fail=1 skipped=$/.test(lacks({ EXPECT_FEATURES: 'study-magic' })), 'run-all: a missing widget the gate expects is a failure', lacks({ EXPECT_FEATURES: 'study-magic' }));
ok(/^echo "skipped \$\{#skipped\[@\]\}/m.test(RUNALL), 'run-all ends with the list of what skipped');

console.log(fails ? `${fails} of ${checks} failed` : `all ${checks} checks passed`);
process.exit(fails ? 1 : 0);
