// The region lock's closed automatic door (Serpents Trail's exit to Skyrim, 877c2) must take the player back to Bruma
// however far from the door's centre the engine fired it. An automatic load door fires when the player walks into its
// trigger (AutoLoadDoor01 bounds are 1200 x 1200 units), but the activate chain's 6.5 m reach gate (455 units) ran
// before the region lock, so a refusal there skipped the return and left the player frozen in the half-started load
// (Lady Aurora Hux, 7 Oct 04:54: refused, frozen, reconnected inside the Trail, /unstuck). An activation sent from
// anywhere else earns no trip. Runs the real activate chain cut from gamemode.js with the real playtest.js and config.
//   node tests/playtest-autodoor-reach-harness.js   (from server/)
'use strict';
const fs = require('fs');
const path = require('path');
const SERVER = path.resolve(__dirname, '..');
const cfg = require(path.join(SERVER, 'gamemode-config.json'));
const src = fs.readFileSync(path.join(SERVER, 'gamemode.js'), 'utf8');

let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got)}`); if (!c) fails++; };

const start = src.indexOf('mp.onActivate = (targetId, casterId) => {\n  const caster = Number(casterId) >>> 0;');
const end = src.indexOf('// Any throw in the chain above is refused', start);
const dStart = src.indexOf('const distanceMeters = (a, b) => {');
const dEnd = src.indexOf('\n};\n', dStart);
const upm = /const UNITS_PER_METER = (\d+(?:\.\d+)?);/.exec(src);
if (start < 0 || end < 0 || dStart < 0 || dEnd < 0 || !upm) { console.log('FAIL  the activate chain markers are gone from gamemode.js'); process.exit(1); }
const chainSrc = src.slice(start, end);
const distSrc = src.slice(dStart, dEnd + 3);

const ids = new Map(); let next = 0x02000000;
const idOf = (d) => { const k = String(d).toLowerCase(); if (!ids.has(k)) ids.set(k, next++); return ids.get(k); };
const descOf = (id) => { for (const [k, v] of ids) if (v === id) return k; return ''; };
const TRAIL = '6a7bd:BSHeartland.esm';
const SKYRIM_EXIT = idOf('877c2:BSHeartland.esm');     // automatic, blocked
const PALE_PASS_DOOR = idOf('656df:BSHeartland.esm');  // blocked, not automatic
const CAVE_DOOR = idOf('7e6be:BSHeartland.esm');       // an ordinary way out
const P = 0xff002106;
const where = new Map([[SKYRIM_EXIT, { cell: TRAIL, pos: [-8004, -3519, 9868] }], [PALE_PASS_DOOR, { cell: TRAIL, pos: [0, 0, 9868] }], [CAVE_DOOR, { cell: TRAIL, pos: [999, -11096, 9830] }]]);
let playerAt = { cell: TRAIL, pos: [0, 0, 0] };
const moves = [], audits = [], told = [];
const mp = {
  get: (id, k) => {
    const w = id === P ? playerAt : where.get(id >>> 0);
    if (k === 'type') return id === P ? 'MpActor' : 'MpObjectReference';
    if (k === 'worldOrCellDesc') return w ? w.cell : '';
    if (k === 'pos') return w ? w.pos : undefined;
    return undefined;
  },
  set: (id, k, v) => { if (k === 'locationalData') moves.push([id, v]); },
  getIdFromDesc: idOf,
  getDescFromId: descOf,
};
global.setTimeout = (fn) => { fn(); return 0; };
let clock = 1_700_000_000_000;
Date.now = () => clock;

require(path.join(SERVER, 'playtest.js'))({
  mp, log: () => {}, personal: (a, t) => told.push(t), system: () => {}, registerChatCommand: () => {}, display: String, who: (a) => `player ${(a >>> 0).toString(16)}`,
  audit: (t) => audits.push(t), onlineActors: () => [], isAdmin: () => false, sendPacket: () => {}, cfg, hubDesc: 'hub:x', connectedAt: new Map(), every: () => {},
});
const distanceMeters = new Function('mp', 'UNITS_PER_METER', `${distSrc}\nreturn distanceMeters;`)(mp, Number(upm[1]));
const stub = () => false;
const chain = new Function('mp', 'lastPickupDeny', 'personal', 'treasuryRefused', 'distanceMeters', 'log', 'businessFailClosed', 'gateOf', 'TAMRIEL', 'system', 'logActivateThrow', 'blockPlacedPickup',
  `${chainSrc}\nreturn mp.onActivate;`)(mp, new Map(), (a, t) => told.push(t), stub, distanceMeters, () => {}, stub, () => null, '3c:Skyrim.esm', () => {}, () => {}, stub);

const arrival = cfg.playtest.arrival;
const at = (dx) => ({ cell: TRAIL, pos: [-8004 + dx, -3519, 9868] });
const tryDoor = (door, pos) => { clock += 5000; moves.length = 0; audits.length = 0; told.length = 0; playerAt = pos; return chain(door, P); };

let r = tryDoor(SKYRIM_EXIT, at(300));
ok(r === false && moves.length === 1 && moves[0][1].cellOrWorldDesc === arrival.world, 'closed automatic exit, walked into 300 units from its centre: refused and taken back to the arrival spot', { r, moves });
ok(audits.some((t) => /877c2/.test(t) && /taken back/.test(t)), '...and the return is in the audit log, naming the door', audits);

r = tryDoor(SKYRIM_EXIT, at(600));
ok(r === false && moves.length === 1 && moves[0][1].cellOrWorldDesc === arrival.world, 'closed automatic exit, walked into at the trigger edge 600 units out (beyond the 6.5 m reach): still taken back', { r, moves });
ok(audits.some((t) => /877c2/.test(t)), '...and audited', audits);

// An activation of the closed exit sent from somewhere else (a jail cell, Bruma, far down the Trail) is no free trip
r = tryDoor(SKYRIM_EXIT, { cell: '9999:BSHeartland.esm', pos: [-8004, -3519, 9868] });
ok(r === false && moves.length === 0 && audits.length === 0, 'the closed exit "activated" from another cell: refused, nobody moved', { r, moves });
r = tryDoor(SKYRIM_EXIT, at(3000));
ok(r === false && moves.length === 0 && audits.length === 0, 'the closed exit "activated" from 3000 units down the Trail: refused, nobody moved', { r, moves });

r = tryDoor(PALE_PASS_DOOR, { cell: TRAIL, pos: [700, 0, 9868] });
ok(r === false && moves.length === 0, 'a closed ordinary door is refused and nobody is moved', { r, moves });

r = tryDoor(CAVE_DOOR, { cell: TRAIL, pos: [999 + 800, -11096, 9830] });
ok(r === false && moves.length === 0, 'an open door out of reach is still refused by the reach gate (no change for other doors)', { r, moves });
r = tryDoor(CAVE_DOOR, { cell: TRAIL, pos: [999 + 200, -11096, 9830] });
ok(r === true && moves.length === 0, 'an open door within reach still opens', { r, moves });

console.log(fails ? `\n${fails} check(s) FAILED` : '\nall checks passed');
process.exit(fails ? 1 : 0);
