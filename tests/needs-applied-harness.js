// The needs system re-sent both regen rates on every tick (86% of the server's "SetActorValue executes locally"
// warnings, 1 Oct): needsOf() dropped appliedValue, so the "unchanged" skip in applyNeedsStage never fired. It cuts the
// needs section out of the gamemode and runs it on a fake clock, counting SetActorValue calls. Run it from this
// folder's parent with
//
//   node tests/needs-applied-harness.js
'use strict';
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.resolve(__dirname, '..', 'gamemode.js'), 'utf8');
const a = src.indexOf('const needsOf = (a) => {');
const b = src.indexOf("every('needs',", a);
if (a < 0 || b < 0) { console.log('FAIL the needs markers are gone from gamemode.js'); process.exit(1); }
const needsSrc = src.slice(a, b) + '\nreturn { needsOnConnect, needsTick };';

let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

let now = 1_700_000_000_000;
Date.now = () => now;
const P = 0xff000014;
const store = new Map();
const sent = [];
const mp = {
  get: (id, p) => store.get(`${id >>> 0}|${p}`),
  set: (id, p, v) => store.set(`${id >>> 0}|${p}`, JSON.parse(JSON.stringify(v))),
  makeProperty: () => {},
  getDescFromId: (id) => `${(id >>> 0).toString(16)}:x`,
  callPapyrusFunction: (kind, cls, fn, self, args) => { if (fn === 'SetActorValue') sent.push(args.slice()); return null; },
};
const NEEDS = { enabled: true, hungerPerHour: 12, tickSeconds: 60, warnEveryMinutes: 0, stages: [{ at: 0, name: 'Sated' }, { at: 60, name: 'Hungry', staminaRateMult: -50, healRateMult: -50 }] };
const NEEDS_STAGES = NEEDS.stages;
const NEEDS_AV = { staminaRateMult: 'StaminaRateMult', healRateMult: 'HealRateMult' };
delete globalThis.__dboChillRateMult;
delete globalThis.__dboSuperRateMult;
const { needsOnConnect, needsTick } = new Function('mp', 'log', 'NEEDS', 'NEEDS_STAGES', 'NEEDS_AV', 'cfg', 'sendPacket', 'goldOf', 'display', 'system',
  'onlineActors', 'creationPending', 'globalThis', needsSrc)(
  mp, () => {}, NEEDS, NEEDS_STAGES, NEEDS_AV, {}, () => true, () => 0, (x) => `Actor${(x >>> 0).toString(16)}`, () => {},
  () => [P], () => false, globalThis);

needsOnConnect(P);
check('login sends both rates', sent.length === 2, sent);
sent.length = 0;
needsTick();
check('the next tick, nothing changed: nothing is sent', sent.length === 0, sent);
for (let i = 0; i < 5; i++) { now += 60_000; needsTick(); }
check('five more ticks within ten minutes: still nothing', sent.length === 0, sent);
globalThis.__dboNeedsRefresh(P);
check('a refresh with nothing changed sends nothing', sent.length === 0, sent);

globalThis.__dboChillRateMult = (x, av) => (av === 'HealRateMult' ? 0.5 : 1);
globalThis.__dboNeedsRefresh(P);
check("Death's Chill halving the heal rate sends only that rate, at once", sent.length === 1 && sent[0][0] === 'HealRateMult' && sent[0][1] === 50, sent);
delete globalThis.__dboChillRateMult;
sent.length = 0;
globalThis.__dboNeedsRefresh(P);
check('the chill lifting sends it back to 100', sent.length === 1 && sent[0][1] === 100, sent);

sent.length = 0;
now += 10 * 60_000;
needsTick();
check('after ten minutes an unchanged rate is re-sent, in case the game reset it', sent.length === 2, sent);
sent.length = 0;
now += 60_000;
needsTick();
check('and then it is quiet again', sent.length === 0, sent);

store.set(`${P}|private.needs`, Object.assign(mp.get(P, 'private.needs'), { hunger: 70 }));
sent.length = 0;
now += 60_000;
needsTick();
check('a stage change (Hungry) sends both rates at once', sent.length === 2 && sent.every(([, v]) => v === 50), sent);

sent.length = 0;
needsOnConnect(P);
check('a login always re-sends both, whatever was applied', sent.length === 2, sent);

console.log(failures ? `${failures} FAILED` : 'all ok');
process.exit(failures ? 1 : 0);
