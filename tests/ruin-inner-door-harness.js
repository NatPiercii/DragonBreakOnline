// A ruin's raised stair (ruinbuttons.js, a gamebryo "Open" sequence) looked shut to a player who left the stair's cell for
// the ruin's other cell and came back through the inner door (Rielle: 7cae1 and 7cae2): an interior keeps no gamebryo
// sequence once its 3D unloads, and only a press or a ruin arrival replayed it. This loads the real ruinbuttons.js and
// ruin-buttons.json and cuts gamemode.js's activation wrapper for it, then drives them as the engine does: the gamemode's
// onActivate first, and for an allowed door the teleport right after it.
//   node tests/ruin-inner-door-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const MODULE = path.resolve(__dirname, '..', 'ruinbuttons.js');
const DATA = path.resolve(__dirname, '..', 'ruin-buttons.json');
const GAMEMODE = path.resolve(__dirname, '..', 'gamemode.js');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-jake-bugs-ruindoor-'));
fs.copyFileSync(DATA, path.join(scratch, 'ruin-buttons.json'));
process.chdir(scratch);

let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

const fromDesc = (d) => { const [h, p] = String(d).split(':'); return /bsheartland/i.test(p) ? (0x08000000 | parseInt(h, 16)) >>> 0 : 0; };
const where = new Map();
const calls = [], packets = [], logs = [];
const mp = {
  getIdFromDesc: fromDesc,
  get: (id, p) => (p === 'worldOrCellDesc' ? where.get(id >>> 0) : undefined),
  callPapyrusFunction: (kind, cls, fn, self, args) => calls.push(`${fn}(${args[0]}) ${self.desc}`),
};
const log = (...a) => logs.push(a.join(' '));
const load = (cfg) => { delete require.cache[MODULE]; require(MODULE)({ mp, log, personal: () => {}, audit: () => {}, who: (a) => `P${(a >>> 0).toString(16)}`, cfg: { ruinButtons: cfg || {} }, sendPacket: (a, p) => { packets.push([a >>> 0, p]); return true; } }); };
delete globalThis.__dboRuinButtons;
load();

// The gamemode's chain below the wrapper: a ruin button is handled and refused (gamemode.js onActivate), anything else
// answers as `answer` says
let answer = true;
const core = (targetId, casterId) => {
  if (globalThis.__dboRuinButton && globalThis.__dboRuinButton(targetId >>> 0, casterId >>> 0)) return false;
  return answer;
};
mp.onActivate = core;
const src = fs.readFileSync(GAMEMODE, 'utf8');
const a = src.indexOf("// A ruin's opened stair, for a player who comes into its cell through an inner door");
const b = a < 0 ? -1 : src.indexOf('\n}\n', a);
check('gamemode.js wraps onActivate for a ruin\'s inner doors', a >= 0 && b > a);
if (a >= 0 && b > a) new Function('mp', 'log', 'globalThis', src.slice(a, b + 3))(mp, log, globalThis);

const tick = () => new Promise((r) => setTimeout(r, 5));
// The engine: the gamemode's hook, then an allowed door's teleport (MpObjectReference::ProcessActivate, same call)
const activate = async (ref, actor, to) => { const ok = mp.onActivate(fromDesc(ref), actor); if (ok !== false && to) where.set(actor, to); await tick(); return ok; };

const RIELLE_STAIR_CELL = '7cae2:BSHeartland.esm', RIELLE_OTHER_CELL = '7cae1:BSHeartland.esm';
const RIELLE_BUTTON = 'cbadf:BSHeartland.esm', RIELLE_STAIR = 'cbade:BSHeartland.esm';
const TELEPE_CELL = 'aecba:BSHeartland.esm', TELEPE_BUTTON = 'aed73:BSHeartland.esm', TELEPE_STAIR = 'aed72:BSHeartland.esm';
const ANGA_CELL = '7eedd:BSHeartland.esm';
// Stand-ins: the engine decides where a door leads, so any reference does for the inner door and the chest
const DOOR = 'f00001:BSHeartland.esm', CHEST = 'f00002:BSHeartland.esm';
const A = 0xff000014, B = 0xff000020;
const to = (actor) => packets.filter((p) => p[0] === actor).map((p) => p[1]);
const stairPacket = (p, stair) => p && p.customPacketType === 'dboRefAnim' && p.refId === fromDesc(stair) && p.name === 'Open' && p.gamebryo === true;

(async () => {
  where.set(A, RIELLE_STAIR_CELL);
  await activate(RIELLE_BUTTON, A);
  check('Rielle\'s button raises the stair for the cell', calls.length === 1 && calls[0] === `PlayGamebryoAnimation(Open) ${RIELLE_STAIR}`, calls);
  await activate(DOOR, A, RIELLE_OTHER_CELL);
  check('leaving the stair\'s cell by the inner door sends nothing', to(A).length === 0, to(A));
  await activate(DOOR, A, RIELLE_STAIR_CELL);
  check('coming back through the inner door plays the opened stair for that player', to(A).length === 1 && stairPacket(to(A)[0], RIELLE_STAIR), to(A));
  check('...and only for them', packets.every((p) => p[0] === A));
  check('...and it is logged', logs.some((l) => l === `ruinbuttons: Pff000014 came into ${RIELLE_STAIR_CELL} through a door, 1 opened sequence(s) played for them`), logs.slice(-3));
  await activate(RIELLE_BUTTON, A);
  check('a press straight after arriving does not restart the rise', to(A).length === 1 && calls.length === 1, to(A).length);
  await activate(DOOR, A, RIELLE_OTHER_CELL);
  await activate(DOOR, A, RIELLE_STAIR_CELL);
  check('out and back again at once plays it again (a door is never held back)', to(A).length === 2 && stairPacket(to(A)[1], RIELLE_STAIR), to(A).length);

  where.set(B, RIELLE_OTHER_CELL);
  await activate(DOOR, B, RIELLE_STAIR_CELL);
  check('a party member who never saw the press gets it on first walking in', to(B).length === 1 && stairPacket(to(B)[0], RIELLE_STAIR), to(B));

  const n = packets.length;
  const real0 = globalThis.__dboRuinDoorUsed;
  let used = 0;
  globalThis.__dboRuinDoorUsed = (c) => { used++; return real0(c); };
  answer = false;
  await activate(DOOR, B, RIELLE_OTHER_CELL);
  check('a refused activation is left alone', used === 0 && packets.length === n && where.get(B) === RIELLE_STAIR_CELL, used);
  answer = true;
  await activate(CHEST, B);
  check('an activation that moves nobody sends nothing', used === 1 && packets.length === n, used);
  globalThis.__dboRuinDoorUsed = real0;
  await activate(DOOR, B, ANGA_CELL);
  check('a cell whose stair nobody opened sends nothing', packets.length === n);

  where.set(A, TELEPE_CELL);
  await activate(TELEPE_BUTTON, A);
  where.set(B, RIELLE_OTHER_CELL);
  await activate(DOOR, B, RIELLE_STAIR_CELL);
  check('with two ruins open, the stair cell gets only its own stair', to(B).length === 2 && stairPacket(to(B)[1], RIELLE_STAIR) && packets.length === n + 1, to(B).slice(1));
  where.set(B, RIELLE_OTHER_CELL);
  await activate(DOOR, B, TELEPE_CELL);
  check('...and Telepe\'s cell gets Telepe\'s', to(B).length === 3 && stairPacket(to(B)[2], TELEPE_STAIR), to(B).slice(2));

  load();
  where.set(A, RIELLE_OTHER_CELL);
  const k = to(A).length;
  await activate(DOOR, A, RIELLE_STAIR_CELL);
  check('a hot reload keeps it working (the wrapper calls the newest module)', to(A).length === k + 1, to(A).length - k);

  globalThis.__dboRuinLeaseEnded('CYRRielleLocation');
  where.set(A, RIELLE_OTHER_CELL);
  await activate(DOOR, A, RIELLE_STAIR_CELL);
  check('once the lease ends and the stair is closed, nothing is played', to(A).length === k + 1);
  where.set(A, RIELLE_OTHER_CELL);
  await activate(DOOR, A, TELEPE_CELL);
  check('...while the other ruin\'s stair still is', to(A).length === k + 2 && stairPacket(to(A)[k + 1], TELEPE_STAIR));

  load({ enabled: false });
  where.set(A, RIELLE_OTHER_CELL);
  await activate(DOOR, A, TELEPE_CELL);
  check('ruinButtons.enabled false turns it off', to(A).length === k + 2);
  load();
  globalThis.__dboRuinLeaseEnded('CYRTelepeLocation');
  check('with no stair open anywhere, an activation schedules nothing', globalThis.__dboRuinDoorUsed && globalThis.__dboRuinDoorUsed(A) === false);

  const real = globalThis.__dboRuinDoorUsed;
  globalThis.__dboRuinDoorUsed = () => { throw new Error('boom'); };
  const ok = await activate(DOOR, A, RIELLE_STAIR_CELL);
  check('a throw in the replay never refuses the door', ok === true && logs.some((l) => l === 'ruin door replay failed boom'), logs.slice(-2));
  globalThis.__dboRuinDoorUsed = real;
  answer = undefined;
  check('the wrapper hands the chain\'s answer on unchanged', mp.onActivate(fromDesc(CHEST), A) === undefined);

  process.chdir(os.tmpdir());
  fs.rmSync(scratch, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
