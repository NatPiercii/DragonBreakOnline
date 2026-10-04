// What E on a dead creature does, from the real __dboSkin in server\gamemode.js run in a sandbox. Run it from
// server\ with
//
//   node tests\skin-activate-harness.js
//
// false = the activation is taken (the skinning game opens, nothing else happens); null = the corpse opens as
// any container. GroundedPasta (2026-09-29): deer never gave venison, because a skinned deer refused every E
// ("already been skinned") and a fresh one only ever started skinning, so its meat could not be reached.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.resolve(__dirname, '..', 'gamemode.js'), 'utf8');
const start = src.indexOf('\nglobalThis.__dboSkin = ');
if (start < 0) throw new Error('globalThis.__dboSkin not found in gamemode.js');
const end = src.indexOf('\n};', start);
const code = src.slice(start + 1, end + 3);

let failures = 0;
const check = (label, ok) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`); };

const run = ({ pelts, dead = true, skinned = false, worth = 5, cap = 12, pendingSince }) => {
  const said = [];
  const opened = [];
  const props = { 'private.dboPelts': pelts, isDead: dead, 'private.dboSkinned': skinned };
  const sandbox = {
    globalThis: {},
    mp: { get: (id, key) => props[key] },
    skinSay: (a, text) => { said.push(text); return false; },
    skinnerTier: () => 0,
    peltsWorth: () => worth,
    tierCap: () => cap,
    rankForValue: () => 2,
    RANK_NAMES: ['Novice', 'Apprentice', 'Adept', 'Expert', 'Master'],
    skinRound: () => ({ nonce: 'n', seed: 1, name: 'deer', cuts: 3, minMs: 900 }),
    skinSessions: new Map(),
    openWidget: (a, w) => opened.push(w),
    skinPacket: (r) => ({ type: 'skinning', r }),
    creatureName: () => 'deer',
    peltPending: new Map(pendingSince === undefined ? [] : [[0xff000100, pendingSince]]),
    PELT_PENDING_MS: 2000,
    // client-judged skinning (minigames.js): the attempt records where it began; nothing here has a position
    MG: require(path.resolve(__dirname, '..', 'minigames.js')),
    SKIN: {},
    log: () => {},
    display: String,
    skinKeepClosing: () => {},
    skinIdleStart: () => {},
    skinIdleStop: () => {},
    performance: { now: () => 0 },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(code, sandbox);
  const result = sandbox.__dboSkin(0xff000100, 0xff000001);
  return { result, said, opened };
};

const pelt = [{ baseId: 0x80679bd, count: 1 }];

// The pelts are stashed 50 ms after death; until then the body does not open (loot review, 2026-09-29)
let q = run({ pelts: undefined, pendingSince: Date.now() });
check('a body whose pelts are not stashed yet does not open', q.result === false && q.opened.length === 0);
q = run({ pelts: [], pendingSince: Date.now() - 5000 });
check('...for 2 s at most, if the stash never ran', q.result === null);

let r = run({ pelts: pelt });
check('a fresh deer: E starts the skinning game and is taken', r.result === false && r.opened.length === 1);

r = run({ pelts: pelt, skinned: true });
check('a skinned deer: E opens the corpse (its venison), with no refusal', r.result === null && r.said.length === 0 && r.opened.length === 0);

r = run({ pelts: pelt, worth: 80, cap: 12 });
check('a hide beyond the skinner: says so, and the corpse still opens', r.result === null && r.said.length === 1 && /beyond your hand/.test(r.said[0]) && r.opened.length === 0);

r = run({ pelts: [] });
check('a mudcrab (no pelt): the corpse opens', r.result === null && r.opened.length === 0);

r = run({ pelts: pelt, dead: false });
check('a living creature: not a skinning matter', r.result === null && r.opened.length === 0);

r = run({ pelts: undefined });
check('a body with no pelt record (a player, a dungeon humanoid): not a skinning matter', r.result === null);

console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
