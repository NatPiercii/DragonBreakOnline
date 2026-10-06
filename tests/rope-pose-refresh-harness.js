// Scripted test for rope.js's bound-pose refresh (Nate, 6 Oct: "when restrained hands need to stay bound"): every few
// seconds a bound captive who is not carried is sent the captive pose again, shackles and rope alike; a carried, freed,
// dead or offline one is not. Run it from this folder's parent with
//
//   node tests\rope-pose-refresh-harness.js
'use strict';
const path = require('path');
const BOUND = 0xff000010, CARRIED = 0xff000011, FREE = 0xff000012, DEAD = 0xff000013;
const props = {
  [BOUND]: { 'private.restrained': { boundHands: true, carried: false, captorActorId: 1 } },
  [CARRIED]: { 'private.restrained': { boundHands: true, carried: true } },
  [FREE]: { 'private.restrained': null },
  [DEAD]: { 'private.restrained': { boundHands: true }, isDead: true },
};
const anims = [], timers = {};
require(path.resolve(__dirname, '..', 'rope.js'))({
  mp: {
    get: (id, k) => (props[id] || {})[k],
    getDescFromId: (id) => id.toString(16), getIdFromDesc: (d) => parseInt(d, 16),
    callPapyrusFunction: (kind, cls, method, self, args) => { if (method === 'SendAnimationEvent') anims.push([parseInt(args[0].desc, 16) >>> 0, args[1]]); return null; },
    lookupEspmRecordById: () => null,
  },
  log: () => {}, personal: () => {}, audit: () => {}, display: (a) => a.toString(16), nameOf: () => 'x', cfg: {},
  onlineActors: () => [BOUND, CARRIED, FREE, DEAD], every: (n, ms, fn) => { timers[n] = [ms, fn]; }, sendPacket: () => {}, distanceMeters: () => 0,
});
let failures = 0;
const check = (name, ok, d) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${d !== undefined ? '   ' + JSON.stringify(d) : ''}`); if (!ok) failures++; };
check('a pose timer runs every 4 s by default', timers.ropePose && timers.ropePose[0] === 4000);
timers.ropePose[1]();
check('only the bound, uncarried, living captive is sent the pose', anims.length === 1 && anims[0][0] === BOUND && anims[0][1] === 'OffsetBoundStandingStart', anims);
console.log(failures ? `${failures} FAILURES` : 'all checks passed');
process.exit(failures ? 1 : 0);
