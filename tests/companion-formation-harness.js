// The companions' formation (client companionFormation.ts, wired into companionService follow, unstick and the far
// catch-up): each follower keeps its own place behind the owner instead of every one pushing for the same spot (Nate, 3 Oct:
// a warband's NPCs "collide with each other when several try to follow closely"). Bundles the module and checks the wiring.
//   node tests/companion-formation-harness.js [fork root]   (default $FORK, else ~/dragonbreak/fork)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const ROOT = path.resolve(process.argv[2] || process.env.FORK || path.join(os.homedir(), 'dragonbreak/fork'));
const FILE = path.join(ROOT, 'skymp5-client/src/services/services/companionFormation.ts');
if (!fs.existsSync(FILE)) { require('./expect')('companion-formation', `${ROOT} has no companionFormation.ts`); console.log(`skipped: no companionFormation.ts in ${ROOT}`); process.exit(0); }
const ESBUILD = process.env.ESBUILD || path.join(os.homedir(), 'dragonbreak/fork/skymp5-server/node_modules/.bin/esbuild');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-formation-'));
const out = path.join(tmp, 'f.js');
execFileSync(ESBUILD, [FILE, '--bundle', '--platform=node', '--format=cjs', `--outfile=${out}`, '--log-level=error']);
const { formationOffset, formationWorldOffset, formationPoint, formationGap } = require(out);
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${what}${!c && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!c) fails++; };
const near = (a, b) => Math.abs(a - b) < 1e-6;

ok(JSON.stringify(formationOffset(0)) === JSON.stringify([0, -128]), 'the first follower keeps the old spot, 128 behind the owner', formationOffset(0));
const band = Array.from({ length: 25 }, (_, i) => formationOffset(i));
ok(new Set(band.map((p) => p.join(','))).size === 25, 'a full warband of 25 has 25 different places', band);
let closest = Infinity;
for (let i = 0; i < band.length; i++) for (let j = i + 1; j < band.length; j++) closest = Math.min(closest, Math.hypot(band[i][0] - band[j][0], band[i][1] - band[j][1]));
ok(closest >= 120, 'no two places are closer than 120 units', closest);
ok(band.every(([, y]) => y <= -128), 'every place is behind the owner, never ahead', band);
ok(JSON.stringify(band.slice(0, 3)) === JSON.stringify([[0, -128], [-120, -128], [120, -128]]) && JSON.stringify(band[3]) === JSON.stringify([0, -248]), 'rows of three, the middle first', band.slice(0, 4));
ok(JSON.stringify(formationOffset(-3)) === JSON.stringify(formationOffset(0)) && JSON.stringify(formationOffset(NaN)) === JSON.stringify(formationOffset(0)), 'a bad slot is the first place, never a throw');
// World axes (Skyrim: angle 0 faces +Y, clockwise; companionSystem locationNear uses the same sin/cos)
let w = formationWorldOffset(0, 0);
ok(near(w[0], 0) && near(w[1], -128), 'facing north, behind is south', w);
w = formationWorldOffset(0, 90);
ok(near(w[0], -128) && near(w[1], 0), 'facing east, behind is west', w);
w = formationWorldOffset(2, 90);
ok(near(w[0], -128) && near(w[1], -120), 'facing east, the right-hand place is to the south', w);
w = formationWorldOffset(5, 37);
const [lx, ly] = formationOffset(5);
ok(near(Math.hypot(w[0], w[1]), Math.hypot(lx, ly)), 'turning keeps the distance', w);

const svc = fs.readFileSync(path.join(ROOT, 'skymp5-client/src/services/services/companionService.ts'), 'utf8');
const num = (name) => Number((svc.match(new RegExp(`static readonly ${name} = (\\d+)`)) || [])[1]);
const STUCK = num('stuckDistance'), RADIUS = num('followRadius'), CATCH_UP = num('catchUpRadius');
const maxBand = Number((fs.readFileSync(path.resolve(__dirname, '..', 'warband.js'), 'utf8').match(/maxBand: (\d+)/) || [])[1]);
ok(STUCK > 0 && RADIUS > 0 && maxBand > 0, 'stuckDistance, followRadius and maxBand read from the sources', [STUCK, RADIUS, maxBand]);
// Review rv3 (3 Oct): measured from the owner, the back rows of a full band rest past stuckDistance and were lifted,
// driven to heel and sent back every ~20 s while the owner stood still. Measured from the slot, a resting follower never is.
const owners = [[0, 0, 0, 0], [61079, 230076, 10878, 37], [-5000, 1200, -300, 181], [100, -100, 50, 359]];
let worst = 0, oldOver = 0;
for (let n = 0; n < maxBand + 2; n++) for (const [ox, oy, oz, ang] of owners) for (let k = 0; k < 8; k++) {
  const p = formationPoint(n, [ox, oy, oz], ang);
  const at = [p[0] + RADIUS * Math.cos(k * Math.PI / 4), p[1] + RADIUS * Math.sin(k * Math.PI / 4), p[2]];
  worst = Math.max(worst, formationGap(at, n, [ox, oy, oz], ang));
  if (Math.hypot(at[0] - ox, at[1] - oy) > STUCK) oldOver++;
}
ok(worst <= RADIUS + 1e-6 && worst < STUCK, `a follower resting anywhere within followRadius of its place, in every slot up to maxBand + 2 (${maxBand + 2}), is never past stuckDistance from it`, worst);
ok(oldOver > 0, '(the same followers measured from the owner would be: the loop the review found)', oldOver);
// drive(): it walks to its place, and is at heel there (followRadius * 2), not at the owner's side
{
  const slot = maxBand + 1, owner = [0, 0, 0], ang = 90;
  const p = formationPoint(slot, owner, ang);
  let at = [3000, 2500, 0], steps = 0;
  while (formationGap(at, slot, owner, ang) > RADIUS * 2 && steps++ < 1000) {
    const dx = p[0] - at[0], dy = p[1] - at[1], flat = Math.hypot(dx, dy) || 1;
    const step = Math.min((formationGap(at, slot, owner, ang) > CATCH_UP ? 900 : 260) * 0.25, flat);
    at = [at[0] + dx / flat * step, at[1] + dy / flat * step, p[2]];
  }
  ok(formationGap(at, slot, owner, ang) <= RADIUS * 2 && Math.hypot(at[0], at[1]) > STUCK, 'a driven back-row follower stops at its place, far behind the owner, not at heel beside them', [at.map(Math.round), Math.round(Math.hypot(at[0], at[1]))]);
}
ok(/let slot = 0;/.test(svc) && /state\.slot = slot\+\+;/.test(svc), 'each companion\'s slot is its order among the owner\'s loaded, living companions');
const loop = (svc.match(/let slot = 0;[\s\S]*?state\.slot = slot\+\+;/) || [''])[0];
ok(/if \(!actor \|\| actor\.isDead\(\) \|\| !actor\.is3DLoaded\(\)\) \{[\s\S]*?continue;/.test(loop), '...so a dead or unloaded one leaves no hole in the rows');
const unstick = (svc.match(/private unstick\([\s\S]*?\n  \}\n/) || [''])[0];
ok(/const gap = formationGap\(here, state\.slot,/.test(unstick) && /gap <= CompanionService\.stuckDistance/.test(unstick) && /state\.lastGap = gap;/.test(unstick) && !/distance <= CompanionService\.stuckDistance/.test(unstick), 'the stuck watch (and lastGap) measures from the follower\'s place, not the owner');
const drive = (svc.match(/private drive\([\s\S]*?\n  \}\n/) || [''])[0];
ok(/const gap = formationGap\(from, state\.slot, owner,/.test(drive) && /if \(gap <= CompanionService\.followRadius \* 2\)/.test(drive) && /const target: number\[\] = formationPoint\(state\.slot, owner,/.test(drive) && /actor\.setPosition\(target\[0\], target\[1\], target\[2\]\)/.test(drive), 'drive() walks to the place and is at heel there; the far catch-up lands on it');
const follow = (svc.match(/private follow\([\s\S]*?\n  \}\n/) || [''])[0];
ok(/const \[ox, oy\] = formationOffset\(state\.slot\);\s*actor\.keepOffsetFromActor\(player, ox, oy, 0, 0, 0, angle,/.test(follow), 'the keep-offset follow uses the slot', follow.slice(-900));
ok(/state\.followSlot !== state\.slot/.test(follow), '...and is given again when the slot changes (a band member died or was dismissed)');
ok((svc.match(/formationWorldOffset\(state\.slot, player\.getAngleZ\(\)\)/g) || []).length === 2 && !/moveTo\(player, 0, CompanionService\.followOffsetY/.test(svc), 'the far catch-up and the unstick lift put it in its place too');
fs.rmSync(tmp, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
