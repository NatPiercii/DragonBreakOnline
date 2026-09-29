// Scripted test for CaptureSystem's leash when the captor leaves their body without disconnecting (quit to character
// select, a character switch): the captive was skipped for good and stayed bound (2026-09-29 review). Bundle first,
// then run from this folder's parent (run-all.sh does both):
//
//   ./node_modules/.bin/esbuild ts/systems/captureSystem.ts --bundle --platform=node --format=cjs --outfile=<out>
//   node tests/capture-leash-harness.js <out>
'use strict';
const path = require('path');
const { CaptureSystem } = require(path.resolve(process.argv[2]));
const logs = [];
const sys = new CaptureSystem((...x) => logs.push(x.join(' ')));
let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

const CAPTOR = 0xff000010, CAPTIVE = 0xff000011;
const users = new Map([[CAPTOR, 1], [CAPTIVE, 2]]);   // actor -> user; a body with no player has none
const props = new Map();
const packets = [];
const here = { cellOrWorldDesc: 'a764b:BSHeartland.esm', pos: [0, 0, 0], rot: [0, 0, 0] };
const svr = {
  getUserByActor: (a) => (users.has(a) ? users.get(a) : -1),
  getUserActor: (u) => { for (const [a, x] of users) if (x === u) return a; return 0; },
  isConnected: () => true,
  get: (id, p) => (p === 'locationalData' ? here : p === 'isDead' ? false : props.get(`${id}|${p}`)),
  set: (id, p, v) => props.set(`${id}|${p}`, v),
  sendCustomPacket: (u, s) => packets.push([u, JSON.parse(s)]),
  getInventory: () => ({ entries: [] }), setInventory: () => {}, callPapyrusFunction: () => null,
};
const ctx = { svr };
const bind = () => { sys.restraints.set(CAPTIVE, { boundHands: true, carried: false, captorActorId: CAPTOR }); props.set(`${CAPTIVE}|private.restrained`, { boundHands: true }); packets.length = 0; logs.length = 0; };

bind();
sys.followLeashes(ctx);
check('a captor still at the rope keeps the captive bound', sys.restraints.has(CAPTIVE) && packets.length === 0);

// The captor quits to character select: the user stays connected, the old body has no player
users.delete(CAPTOR);
sys.followLeashes(ctx);
check('a captor who left their body lets the captive go', !sys.restraints.has(CAPTIVE), [...sys.restraints.keys()]);
check('the captive is told they are free', packets.some(([u, p]) => u === 2 && p.customPacketType === 'restraintState' && p.boundHands === false && p.leash === 0), packets);
check('the release is written to the log', logs.some((l) => /\[capture\] ff000011 let go: captor ff000010 left their body/.test(l)), logs);
check('the restraint property is cleared', !props.get(`${CAPTIVE}|private.restrained`));

// A captive who is not online is left for their relog (onActorAssigned frees them then)
users.set(CAPTOR, 1); bind(); users.delete(CAPTOR); users.delete(CAPTIVE);
sys.followLeashes(ctx);
check('a captive who is offline too is left for their relog', sys.restraints.has(CAPTIVE));

console.log('');
console.log(failures ? `${failures} FAILURES` : 'all checks passed');
process.exit(failures ? 1 : 0);
