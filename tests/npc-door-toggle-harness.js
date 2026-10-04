// Scripted test for the NPC door rule in gamemode.js (2026-10-04): an NPC opens a plain door but never closes it again.
// Each server activation of a door without XTEL flips it, and an NPC's AI kept activating a door its hoster had not yet
// seen open: in Fort Cutpurse Tower two NPCs flipped door cf4e8 209 times in 21 s (1 Oct 15:13:46-15:14:07). This cuts
// the rule out of the gamemode and runs it around a stand-in chain that flips isOpen as the server does. Run it from this
// folder's parent with
//
//   node tests/npc-door-toggle-harness.js
'use strict';
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.resolve(__dirname, '..', 'gamemode.js'), 'utf8');
const a = src.indexOf('// NPCs open doors but never close them');
const b = src.indexOf('// TEMPORARY door trace', a);
if (a < 0 || b < 0) { console.log('FAIL the NPC door rule markers are gone from gamemode.js'); process.exit(1); }
const ruleSrc = src.slice(a, b);

let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

// The world: refs with a base, a record of their own, and an isOpen the stand-in chain flips
const PLAIN = 0x080cf4e8, LOAD = 0x08085ef0, CHEST = 0x08012345, RUNTIME = 0xff00a001, BROKEN = 0x08099999;
const DOOR_BASE = 0x00042035, CONT_BASE = 0x00012000;
const NPC1 = 0xff00221d, NPC2 = 0xff00221e, PLAYER = 0xff000014;
const refs = {
  [PLAIN]: { base: DOOR_BASE, fields: [{ type: 'NAME', data: [] }, { type: 'DATA', data: [] }, { type: 'XLRL', data: [] }] },
  [LOAD]: { base: DOOR_BASE, fields: [{ type: 'NAME', data: [] }, { type: 'XTEL', data: [] }] },
  [CHEST]: { base: CONT_BASE, fields: [{ type: 'NAME', data: [] }] },
  [RUNTIME]: { base: DOOR_BASE, fields: null },
  [BROKEN]: { base: DOOR_BASE, throws: true },
};
const isOpen = new Map();
let lookups = 0;
const mp = {
  get: (id, prop) => {
    id >>>= 0;
    if (prop === 'baseDesc') return refs[id] ? `${refs[id].base.toString(16)}:Skyrim.esm` : '';
    if (prop === 'isOpen') return isOpen.get(id) === true;
    throw new Error(`unexpected property ${prop}`);
  },
  getIdFromDesc: (desc) => parseInt(String(desc).split(':')[0], 16),
  getDescFromId: (id) => `${(id & 0xffffff).toString(16)}:BSHeartland.esm`,
  lookupEspmRecordById: (id) => {
    lookups++;
    id >>>= 0;
    if (id === DOOR_BASE) return { record: { type: 'DOOR', fields: [] } };
    if (id === CONT_BASE) return { record: { type: 'CONT', fields: [] } };
    const r = refs[id];
    if (!r || r.fields === null) return {};
    if (r.throws) throw new Error('record unreadable');
    return { record: { type: 'REFR', fields: r.fields } };
  },
};
let chainCalls = 0;
// The server's own processing of a plain door: SetOpen(!IsOpen()); a load door opens and stays open
const chain = (t) => {
  chainCalls++;
  t >>>= 0;
  if (t === PLAIN || t === RUNTIME || t === BROKEN) isOpen.set(t, !isOpen.get(t));
  if (t === LOAD) isOpen.set(t, true);
  return true;
};
const users = new Map([[PLAYER, 0]]);
const userOf = (actor) => (users.has(actor >>> 0) ? users.get(actor >>> 0) : -1);
const logged = [];
const load = (keep) => {
  if (!keep) delete globalThis.__dboNpcDoorKind;
  mp.onActivate = (t, c) => chain(t, c);
  new Function('mp', 'userOf', 'logCapped', 'globalThis', ruleSrc)(mp, userOf, (key, n, ...parts) => logged.push([key, parts.join(' ')]), globalThis);
  return mp.onActivate;
};

let act = load();
// 1. The Fort Cutpurse storm replayed: two NPCs, 209 activations on a closed plain door
isOpen.set(PLAIN, false);
let allowed = 0;
for (let i = 0; i < 209; i++) if (act(PLAIN, i % 3 ? NPC1 : NPC2) !== false) allowed++;
check('209 NPC activations of a closed plain door: the first one opens it', allowed === 1 && chainCalls === 1, { allowed, chainCalls });
check('...and the door ends open (it flipped 209 times before)', isOpen.get(PLAIN) === true);
check('...the refusals are logged through the per-door cap', logged.length === 208 && logged.every(([k]) => k === `npcdoor:${PLAIN}`), logged.length);
check('...naming the actor and the door', /npc door: actor ff00221d would close cf4e8:BSHeartland.esm again; refused/.test(logged[0][1]), logged[0][1]);

// 2. A player still closes and opens it
chainCalls = 0;
check('a player activating the open door closes it', act(PLAIN, PLAYER) === true && chainCalls === 1 && isOpen.get(PLAIN) === false);
check('...and opens it again', act(PLAIN, PLAYER) === true && isOpen.get(PLAIN) === true);
act(PLAIN, PLAYER);
check('an NPC opens the door a player closed', isOpen.get(PLAIN) === false && act(PLAIN, NPC1) === true && isOpen.get(PLAIN) === true);

// 3. Load doors, other forms, runtime and unreadable refs are never refused
isOpen.set(LOAD, true);
chainCalls = 0;
check('an NPC goes through an open load door (its teleport), every time', act(LOAD, NPC1) === true && act(LOAD, NPC2) === true && chainCalls === 2);
isOpen.set(CHEST, true);
check('an NPC activating an open container is not this rule\'s business', act(CHEST, NPC1) === true);
isOpen.set(RUNTIME, true);
check('a runtime (0xff) door is never refused', act(RUNTIME, NPC1) === true);
isOpen.set(BROKEN, true);
check('a door whose record cannot be read is never refused', act(BROKEN, NPC1) === true);

// 4. The chain's own refusal passes through for everyone
mp.onActivate = () => false;
new Function('mp', 'userOf', 'logCapped', 'globalThis', ruleSrc)(mp, userOf, () => {}, globalThis);
isOpen.set(PLAIN, false);
check('the chain\'s own refusal is passed through (closed door, NPC)', mp.onActivate(PLAIN, NPC1) === false);
check('the chain\'s own refusal is passed through (player)', mp.onActivate(PLAIN, PLAYER) === false);

// 5. The kind is read once per ref and kept over a hot reload
act = load();
lookups = 0;
isOpen.set(PLAIN, true);
act(PLAIN, NPC1); act(PLAIN, NPC1); act(PLAIN, NPC2);
check('a door\'s kind is read from the records once', lookups === 2, lookups);
act = load(true);
lookups = 0;
act(PLAIN, NPC1);
check('...and kept over a hot reload', lookups === 0 && globalThis.__dboNpcDoorKind.get(PLAIN) === true, lookups);
check('a player\'s activation never reads a record or isOpen it does not need', (() => { lookups = 0; act(LOAD, PLAYER); return lookups === 0; })());

// 6. Where it sits: inside the door trace (so a refusal is traced as allowed=false) and the activate guard, and the guard
// still wraps the trace directly (activate-guard-harness checks that too)
const rule = src.indexOf('// NPCs open doors but never close them');
const trace = src.indexOf('TEMPORARY door trace');
const guard = src.indexOf('// An Activate is a native packet');
check('the rule is installed before the door trace and the activate guard', rule > 0 && rule < trace && trace < guard);
const between = src.slice(trace, guard);
check('...one wrapper between the trace and the guard, as before', (between.match(/mp\.onActivate = /g) || []).length === 1);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
