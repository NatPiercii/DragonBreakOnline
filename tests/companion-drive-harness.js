// Client companionService.ts (#bugs 2 Oct "Raise Zombie, not working at all": a raised mudcrab and rabbit stood still): a
// companion stuck again after the lift to its owner is walked along the owner's trail (the drive path, which nothing ever
// switched on), instead of being lifted and left standing over and over; and the alias follow says why it gave up.
// Bundles the fork's companionService.ts with SkyrimPlatform stubbed and drives unstick() with stand-in actors.
//   node tests/companion-drive-harness.js [fork root]   (default $FORK, else ~/dragonbreak/fork)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const ROOT = path.resolve(process.argv[2] || process.env.FORK || path.join(os.homedir(), 'dragonbreak/fork'));
const SRC = path.join(ROOT, 'skymp5-client/src');
const FILE = path.join(SRC, 'services/services/companionService.ts');
if (!fs.existsSync(FILE) || !/stuck again at/.test(fs.readFileSync(FILE, 'utf8'))) { require('./expect')('companion-drive', `${ROOT} has no companion drive switch`); console.log(`skipped: no companion drive switch in ${ROOT}`); process.exit(0); }
const ESBUILD = process.env.ESBUILD || path.join(os.homedir(), 'dragonbreak/fork/skymp5-server/node_modules/.bin/esbuild');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-compdrive-'));
// Every name the client imports from SkyrimPlatform, as a callable stand-in
const names = new Set();
const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (/\.tsx?$/.test(f.name)) { for (const m of fs.readFileSync(p, 'utf8').matchAll(/import \{([^}]*)\} from ['"](?:skyrimPlatform|@skyrim-platform\/skyrim-platform)['"]/g)) for (const n of m[1].split(',')) { const k = n.replace(/\btype\b/, '').split(' as ')[0].trim(); if (k) names.add(k); } } } };
walk(SRC);
fs.writeFileSync(path.join(tmp, 'sp.js'), `const h = { get: (t, k) => (k === 'then' ? undefined : (k in t ? t[k] : new Proxy(function () {}, h))), apply: () => new Proxy(function () {}, h), construct: () => new Proxy({}, h) };
for (const n of ${JSON.stringify([...names])}) exports[n] = new Proxy(function () {}, h);
exports.storage = {}; exports.__esModule = true;`);
const out = path.join(tmp, 'comp.js');
execFileSync(ESBUILD, [FILE, '--bundle', '--platform=node', '--format=cjs', `--outfile=${out}`, `--alias:skyrimPlatform=${path.join(tmp, 'sp.js')}`, `--alias:@skyrim-platform/skyrim-platform=${path.join(tmp, 'sp.js')}`, '--log-level=error'], { cwd: path.join(ROOT, 'skymp5-client') });
const { CompanionService } = require(out);
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${what}${!c && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!c) fails++; };

const svc = Object.create(CompanionService.prototype);
const calls = [];
const at = (pos) => ({ pos, getPositionX() { return this.pos[0]; }, getPositionY() { return this.pos[1]; }, getPositionZ() { return this.pos[2]; } });
const player = at([0, 0, 0]);
const crab = Object.assign(at([1200, 0, 0]), {
  isInCombat: () => false,
  getDistance(p) { return Math.hypot(this.pos[0] - p.pos[0], this.pos[1] - p.pos[1]); },
  moveTo() { calls.push('moveTo'); this.pos = [0, -128, 0]; },
  clearKeepOffsetFromActor() { calls.push('clearKeepOffset'); },
});
const state = { stuckSince: 0, unstuckAt: 0, driven: false, following: true, followResult: '' };
let now = 1e9;
const tick = (ms) => { now += ms; svc.unstick(crab, player, state, now); };

tick(0); tick(1000); tick(7000);
ok(calls.includes('moveTo') && !state.driven && /unstuck at/.test(state.followResult), 'stuck 6 s far from its owner: lifted to the owner first, as before', [calls, state]);
// It never walks after the lift: the owner moves on and it stands
calls.length = 0;
player.pos = [1500, 0, 0];
tick(1000); tick(1000); tick(7000);
ok(!calls.includes('moveTo') && state.driven === true, 'stuck again after the lift: driven along the trail instead of a second lift', [calls, state]);
ok(calls.includes('clearKeepOffset') && state.following === false && /stuck again at \d+, driven/.test(state.followResult), '...its keep-offset cleared and the reason reported', state.followResult);
// Far beyond the teleport distance a lift still comes first
const far = Object.assign(Object.create(Object.getPrototypeOf(crab)), crab, { pos: [5000, 0, 0] });
const s2 = { stuckSince: 0, unstuckAt: now - 60000, driven: false, following: false, followResult: '' };
player.pos = [0, 0, 0];
calls.length = 0;
svc.unstick(far, player, s2, now); svc.unstick(far, player, s2, now + 1000); svc.unstick(far, player, s2, now + 8000);
ok(calls.includes('moveTo') && !s2.driven, 'beyond the teleport distance it is lifted, not driven', [calls, s2]);
// A companion that walks is never touched
const walker = Object.assign(Object.create(Object.getPrototypeOf(crab)), crab, { pos: [1200, 0, 0] });
const s3 = { stuckSince: 0, unstuckAt: now, driven: false, following: true, followResult: 'offset 0' };
calls.length = 0;
for (let i = 0; i < 8; i++) { walker.pos = [walker.pos[0] - 100, 0, 0]; svc.unstick(walker, player, s3, now + 20000 + i * 1000); }
ok(!calls.length && !s3.driven && s3.followResult === 'offset 0', 'a companion that keeps walking is left alone', [calls, s3]);

// Sticky drive (follow-up to C's review): once driven, it is driven again as soon as it falls behind, no stand and no lift
const sticky = /driveSticky/.test(fs.readFileSync(FILE, 'utf8'));
if (sticky) {
  ok(state.driveSticky === true, 'the stuck-again companion is marked to be driven from now on', state);
  const s4 = Object.assign({}, state, { driven: false, following: false, followResult: '' });
  const crab2 = Object.assign(Object.create(Object.getPrototypeOf(crab)), crab, { pos: [600, 0, 0], getCombatTarget: () => null, isInCombat: () => false });
  player.pos = [0, 0, 0];
  calls.length = 0;
  svc.follow(crab2, player, s4);
  ok(s4.driven === true && /behind at 600, driven again/.test(s4.followResult) && calls.includes('clearKeepOffset') && !calls.includes('moveTo'), 'behind again: driven at once, no stand and no lift', [s4, calls]);
  const near = Object.assign({}, state, { driven: false, followResult: 'x' });
  const crab3 = Object.assign(Object.create(Object.getPrototypeOf(crab)), crab, { pos: [100, 0, 0], getCombatTarget: () => null, isInCombat: () => false });
  svc.nativeFollow = () => true;   // at heel the ordinary follow carries on
  svc.follow(crab3, player, near);
  ok(near.driven === false, 'at heel it is not driven', near);
  const fresh = { stuckSince: 0, unstuckAt: 0, driven: false, following: false, followResult: '', fightingTarget: 0 };
  svc.follow(crab2, player, fresh);
  ok(fresh.driven === false, 'a companion never stuck is not driven when behind (the lift comes first, as before)', fresh);
} else console.log('(no sticky drive in this companionService: those checks are not run)');

const src = fs.readFileSync(FILE, 'utf8');
ok(/state\.followResult = "no free follower alias";\s*return false;/.test(src) && /state\.aliasFailed = true;\s*state\.followResult = "alias " \+ slot \+ " not found";/.test(src), 'the alias follow reports both silent give-ups');
fs.rmSync(tmp, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
