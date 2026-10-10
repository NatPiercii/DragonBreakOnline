// Scripted test for racial.js castHeld during a concentration channel (#bugs 1556641893054681179, follow-up 8 Oct).
// The client sends no bars while it casts, and a concentration spell's keep-alives never reach the gameplay layer, so
// 3 s after a channel starts the regeneration tick wrote the server's bars from before it back and refunded the spell.
// Also loads racial.js twice (a deploy-gameplay hot reload) and checks the hold and its state survive. Run from the parent:
//   node tests/racial-channel-hold-harness.js
'use strict';
const fs = require('fs');
const path = require('path');
const SERVER = path.resolve(__dirname, '..');
const RACIAL = path.join(SERVER, 'racial.js');
let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };
const near = (x, y) => Math.abs(x - y) < 1e-9;

// ---- records: RACE DATA regeneration at 84/88/92; SPEL SPIT castType u32 at 16 (2 = concentration) ----
const f32le = (x) => { const b = Buffer.alloc(4); b.writeFloatLE(x); return [...b]; };
const RACE = () => { const d = new Array(128).fill(0); [[84, 0.7], [88, 3], [92, 5], [96, 4]].forEach(([at, v]) => f32le(v).forEach((b, i) => { d[at + i] = b; })); return { record: { type: 'RACE', fields: [{ type: 'DATA', data: Uint8Array.from(d) }] } }; };
const SPEL = (castType) => { const d = new Array(36).fill(0); d[16] = castType; return { record: { type: 'SPEL', fields: [{ type: 'SPIT', data: Uint8Array.from(d) }] } }; };
const { RACE_IDS } = require(RACIAL);
const FLAMES = 0x12fcd, FAMILIAR = 0x640b6, HEALING = 0x12fcc;
const records = { [FLAMES]: SPEL(2), [FAMILIAR]: SPEL(0), [HEALING]: SPEL(2) };
for (const ids of Object.values(RACE_IDS)) for (const id of ids) records[id] = RACE();
const recordOf = (id) => records[id >>> 0] || null;

const state = {};
const mp = {
  get: (id, k) => { const s = state[id] || {}; if (k === 'appearance') return s.race ? { raceId: s.race } : null; if (k === 'percentages') return s.pc; return undefined; },
  set: (id, k, v) => { state[id] = state[id] || {}; if (k === 'percentages') { state[id].pc = v; writes.push([id, v]); } },
};
const writes = [];
const timers = [];
const load = () => {
  delete require.cache[require.resolve(RACIAL)];
  return require(RACIAL)({
    mp, log: () => {}, personal: () => {}, display: String, recordOf, giveItem: () => true, profileOf: (a) => (a < 1000 ? a : -1),
    every: (name) => { timers.push(name); }, onlineActors: () => Object.keys(state).map(Number),
    weaponHandsOf: () => 1, sourceResistsOf: () => new Set(), gmstFloat: () => undefined, cfg: { racial: { enabled: true, castHoldSeconds: 3 } },
  });
};
delete globalThis.__dboRacialState;
let R = load();
const ALT = 1;
state[ALT] = { race: RACE_IDS.altmer[0], pc: { health: 1, magicka: 0.8, stamina: 1 } };
const mag = () => state[ALT].pc.magicka;

// ---- 1. a long Flames channel: the client reports nothing until it ends ----
let t = 1000000;
R.regenTick(t); // first tick sets the owed clock
state[ALT].pc = { health: 1, magicka: 0.8, stamina: 1 };
R.onCast(ALT, FLAMES, t);
R.regenTick(t + 1000); R.regenTick(t + 2000);
check('channel: held for castHoldSeconds as before', near(mag(), 0.8));
writes.length = 0;
R.regenTick(t + 3500); R.regenTick(t + 5000); R.regenTick(t + 8000);
check('channel: still no write 3.5-8 s into it, the server\'s bars predate it (no refund)', near(mag(), 0.8) && writes.length === 0, { magicka: mag(), writes: writes.length });
check('channel: the shared hold (blessings, Ayleid well) says held too', typeof globalThis.__dboCastHeld === 'function' && globalThis.__dboCastHeld(ALT, t + 8000) === true);

// ---- 2. hot reload mid-channel: state on globalThis survives, the hold still holds ----
const S0 = globalThis.__dboRacialState, ch0 = S0.channel, held0 = globalThis.__dboCastHeld;
R = load();
check('reload: the same state object and channel map are kept', globalThis.__dboRacialState === S0 && S0.channel === ch0 && ch0 instanceof Map && ch0.has(ALT));
check('reload: __dboCastHeld is replaced, not stacked, and still holds', globalThis.__dboCastHeld !== held0 && globalThis.__dboCastHeld(ALT, t + 9000) === true);
check('reload: one racialRegen timer per load, by name (every() replaces it; the power has its own named timer)', timers.filter((n) => n === 'racialRegen').length === 2 && timers.every((n) => n === 'racialRegen' || n === 'racialPower'), timers);
R.regenTick(t + 9000);
check('reload: no write after the reload while the channel runs', near(mag(), 0.8));

// ---- 3. the channel ends: the client's report moves the server's magicka, the gift resumes at once ----
state[ALT].pc = { health: 1, magicka: 0.3, stamina: 1 }; // ChangeValues from the client
R.regenTick(t + 10000);
check('after the report the gift resumes from the reported value', mag() > 0.3 && mag() < 0.32, mag());
check('...and the channel entry is gone', !(globalThis.__dboRacialState.channel || new Map()).has(ALT));

// ---- 4. fire-and-forget (Conjure Familiar): the 5 Oct 3 s hold, unchanged ----
t += 60000; R.regenTick(t);
state[ALT].pc = { health: 1, magicka: 0.6, stamina: 1 };
R.onCast(ALT, FAMILIAR, t);
R.regenTick(t + 2900);
check('fire-and-forget: held at 2.9 s', near(mag(), 0.6));
R.regenTick(t + 4100);
check('fire-and-forget: no channel hold, the gift resumes after 3 s', mag() > 0.6 && !(globalThis.__dboRacialState.channel || new Map()).has(ALT), mag());

// ---- 5. a channel whose report never moves the bars is not held forever ----
t += 60000; R.regenTick(t);
state[ALT].pc = { health: 1, magicka: 0.5, stamina: 1 };
R.onCast(ALT, HEALING, t);
R.regenTick(t + 20000);
check('cap: held at 20 s without a report', near(mag(), 0.5));
R.regenTick(t + 31000);
check('cap: released after channelHoldSeconds (30)', mag() > 0.5, mag());

// ---- 6. the hot-reload guards, by source ----
const src = fs.readFileSync(RACIAL, 'utf8');
check('source: the channel map is created only when missing', /if \(!\(S\.channel instanceof Map\)\) S\.channel = new Map\(\)/.test(src));
check('source: no mp.makeProperty and no mp.on handler in racial.js', !/makeProperty|mp\.on[A-Z]\w*\s*=/.test(src));

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
