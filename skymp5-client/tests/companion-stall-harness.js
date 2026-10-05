// Scripted test for companionFightStall.ts and its use in companionService.ts: a companion holding an attack order that
// goes nowhere (the raised wolf of 4 Oct 07:32Z, 25 s in combat without a step, its target untouched) restarts the fight
// after 6 s and gives the order up 6 s later for the owner's heel; a fight that progresses never stalls. Run from
// skymp5-client:
//
//   node tests/companion-stall-harness.js [path to esbuild's package dir]
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const esbuildDir = [process.argv[2], path.resolve(__dirname, '../../skymp5-server/node_modules/esbuild'),
  path.join(os.homedir(), 'dragonbreak/fork/skymp5-server/node_modules/esbuild')].find((p) => p && fs.existsSync(p));
if (!esbuildDir) { console.log('SKIP companion-stall (no esbuild)'); process.exit(0); }
const esbuild = require(esbuildDir);

let failures = 0;
const check = (name, ok, got) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`);
  if (!ok) failures++;
};

// Drives one companion at the service's 250 ms tick for ms, with pos/health/toTarget as functions of the elapsed time
const drive = (m, ms, f, start = null, target = 0x14e4) => {
  let stall = start; const actions = [];
  for (let t = 0; t <= ms; t += 250) {
    const r = m.fightStallStep(stall, 1e6 + t, target, f.pos(t), f.health(t), f.toTarget(t));
    stall = r.stall;
    if (r.action !== 'none') actions.push([t, r.action]);
  }
  return { stall, actions };
};

function run(m) {
  const wolf = { pos: () => [-1474, -1854, 1601], health: () => 1, toTarget: () => 700 };
  const w = drive(m, 25000, wolf);
  check('the frozen wolf restarts its fight after 6 s', w.actions[0] && w.actions[0][0] === 6000 && w.actions[0][1] === 'restart', w.actions);
  check('...and gives the order up 6 s later', w.actions[1] && w.actions[1][0] === 12000 && w.actions[1][1] === 'drop', w.actions);
  check('...once given up nothing more is asked of the window that keeps running', w.actions.filter((a) => a[1] === 'restart').length === 1, w.actions);

  const caster = { pos: () => [0, 0, 0], health: (t) => 1 - t / 60000, toTarget: () => 1200 };
  check('a ranged caster whose hits land never stalls', drive(m, 25000, caster).actions.length === 0);

  const melee = { pos: () => [0, 0, 0], health: () => 1, toTarget: () => 120 };
  check('a companion at its target\'s side never stalls (a blocked swing is still a fight)', drive(m, 25000, melee).actions.length === 0);

  const walker = { pos: (t) => [t / 20, 0, 0], health: () => 1, toTarget: (t) => 2000 - t / 20 };
  check('a companion walking to its target never stalls', drive(m, 25000, walker).actions.length === 0);

  const late = { pos: (t) => (t < 9000 ? [0, 0, 0] : [(t - 9000) / 20, 0, 0]), health: () => 1, toTarget: () => 800 };
  const l = drive(m, 20000, late);
  check('a restart that gets it moving is not followed by giving up', l.actions.length === 1 && l.actions[0][1] === 'restart', l.actions);

  const first = drive(m, 5000, wolf);
  const other = m.fightStallStep(first.stall, 1e6 + 5250, 0x9999, wolf.pos(0), 1, 700);
  check('a new target starts a new window with no restarts counted', other.action === 'none' && other.stall.kicks === 0 && other.stall.target === 0x9999);

  const src = fs.readFileSync(path.resolve(__dirname, '../src/services/services/companionService.ts'), 'utf8');
  check('the service runs the watch before each ordered fight', /fightProgress\(c\.id, actor, target, state, now\)/.test(src));
  check('giving up sends the server a follow order for that companion', /action === "drop"|action !== "drop"/.test(src) && /action: "follow", companionId: remoteId/.test(src));
  check('the owner\'s hits skip a target given up as stalled', /if \(this\.isSkipped\(targetId, now\)\)/.test(src));
  check('the assist skips it too', /isOwnCompanion\(remoteId\) \|\| this\.isSkipped\(remoteId, now\)/.test(src));
  check('the npcDrift report carries the stall window and the distance to the target', /stall: state\.stall \?/.test(src) && /toTarget: this\.distanceTo\(/.test(src));
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'claude-nate-companion-stall-'));
  const out = path.join(tmp, 'companionFightStall.js');
  try {
    await esbuild.build({ entryPoints: [path.resolve(__dirname, '../src/services/services/companionFightStall.ts')], bundle: true,
      platform: 'node', format: 'cjs', outfile: out, logLevel: 'error' });
    run(require(out));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
