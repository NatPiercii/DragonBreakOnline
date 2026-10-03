// The gate panel's replies are honoured only for the panel that was offered: Cancel and Claim carry its nonce, and the
// player is moved back to the entrance only while free there. A pending gate ends at logout, when its player is held,
// carried, jailed, away or offline, and after 5 minutes. Real dungeons.js.
//   node tests/gate-panel-validate-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const DUNGEONS = path.resolve(__dirname, '..', 'dungeons.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-gatevalidate-'));
process.chdir(dir);
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });
global.setTimeout = () => 0;
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got)}`); if (!c) fails++; };

const W = 'a764b:BSHeartland.esm';
const ENTRANCE_POS = [98088, 230627, 9149];
const entrance = { outsideDesc: 'd5596:BSHeartland.esm', insideDesc: 'd5597:BSHeartland.esm', world: W, cell: 'a7646:BSHeartland.esm', pos: ENTRANCE_POS, rot: [0, 0, 1.5708],
  insidePos: [0, 0, 0], insideCell: '9999:BSHeartland.esm' };
const HOLLOW = { id: 'CYRFreezewindHollowLocation', name: 'Freezewind Hollow', type: 'cave', cells: [{ desc: '1111:BSHeartland.esm' }], chests: [], zones: [], entrances: [entrance] };
fs.writeFileSync('dungeons.json', JSON.stringify({ dungeons: [HOLLOW] }));

const ids = new Map(); let next = 0x01000000;
const idOf = (d) => { const k = String(d).toLowerCase(); if (!ids.has(k)) ids.set(k, next++); return ids.get(k); };
const AUTO_BASE = '31897:Skyrim.esm';
const baseOf = new Map([[idOf('d5596:BSHeartland.esm'), AUTO_BASE]]);
const records = new Map([[idOf(AUTO_BASE), { type: 'DOOR', fields: [{ type: 'FNAM', data: new Uint8Array([0x02]) }] }]]);
const A = 0x14, PID = 29, FRIEND = 21, F = 0x15;
let friendOnline = false;
let restrained = null, sentence = null, online = true;
const timers = new Map();
let pos = ENTRANCE_POS.slice();
const moves = [], said = [], logs = [], widgets = [], closed = [], ui = new Map();
globalThis.__dboDungeons = { leases: new Map(), parties: new Map(), memberOf: new Map(), invites: new Map(), pending: new Map() };
globalThis.__dboDungeonsBooted = true;
delete globalThis.__dboAutoDoorBases;
require(DUNGEONS)({
  mp: {
    get: (id, p) => (p === 'profileId' ? (id === A ? PID : id === F ? FRIEND : -1) : p === 'baseDesc' ? baseOf.get(id >>> 0) : p === 'pos' ? pos : p === 'worldOrCellDesc' ? W
      : p === 'private.dungeonCooldowns' && id === F ? { [HOLLOW.id]: Date.now() + 3600000 }
      : p === 'private.restrained' ? restrained : p === 'private.dboSentence' ? sentence : undefined),
    set: (id, p, v) => { if (p === 'locationalData') { moves.push([id, v]); pos = v.pos.slice(); } },
    getIdFromDesc: idOf, lookupEspmRecordById: (id) => (records.has(id >>> 0) ? { record: records.get(id >>> 0) } : null),
  },
  log: (...x) => logs.push(x.join(' ')), personal: (a, t) => said.push(t), system: (a, t) => said.push(t), audit: () => {},
  registerChatCommand: () => {}, onUi: (ev, fn) => ui.set(ev, fn), openWidget: (a, w) => { widgets.push(w); return true; }, closeWidget: (a, id) => { closed.push(id); return true; },
  sendPacket: () => true, findByName: () => 0, display: () => 'Viggo #UFHK', who: () => 'Viggo #UFHK', profileOf: (a) => (a === A ? PID : a === F ? FRIEND : -1), nameOf: () => 'Viggo',
  onlineActors: () => (online ? (friendOnline ? [A, F] : [A]) : []), isAdmin: () => false, giveItem: () => true, cfg: {}, every: (name, ms, fn) => timers.set(name, fn),
});
const ST = globalThis.__dboDungeons;
const door = idOf('d5596:BSHeartland.esm');
const realNow = Date.now; let skew = 0; Date.now = () => realNow() + skew;
const lease = () => ({ id: HOLLOW.id, name: HOLLOW.name, difficulty: 'story', leader: FRIEND, members: new Set([FRIEND]), startedAt: Date.now(), endsAt: Date.now() + 3600000, warned: false,
  lastInsideAt: Date.now(), locked: new Map(), zones: [], seenNpcs: new Set(), deadNpcs: new Set(), bossZones: new Set(), bossIds: new Set(), looted: new Set(), unlocked: new Set() });
const reset = () => { restrained = null; sentence = null; online = true; moves.length = 0; said.length = 0; logs.length = 0; widgets.length = 0; ST.leases.clear(); ST.pending.clear(); ST.parties.clear(); ST.memberOf.clear(); pos = ENTRANCE_POS.slice(); skew += 5000; };
// Touch the automatic door with no claim on it: the gate panel opens and the activation stays refused
const openGate = () => { const v = globalThis.__dboDungeonActivate(door, A); const w = widgets.find((x) => x.type === 'dungeonGate'); return { v, nonce: w && w.nonce }; };
const putBackOk = () => moves.length === 1 && moves[0][1].cellOrWorldDesc === W && moves[0][1].pos.join() === ENTRANCE_POS.join();


const sweep = () => timers.get('dungeons.gates')();

// ---- replies must match the panel they answer ---------------------------------------------------------------------------
reset();
let g = openGate();
ui.get('dungeonCancel')(A, ['not-the-nonce']);
ok(!moves.length && ST.pending.has(A), 'Cancel with a wrong nonce does nothing: nobody moved, the gate still pending', { moves });
ui.get('dungeonCancel')(A, []);
ok(!moves.length && ST.pending.has(A), '...nor does Cancel with none', { moves });
ui.get('dungeonCancel')(A, [g.nonce]);
ok(putBackOk() && !ST.pending.has(A), 'Cancel with the panel\'s own nonce turns back as before', moves);
reset();
g = openGate();
ui.get('dungeonClaim')(A, ['not-the-nonce', 'story']);
ok(!moves.length && ST.pending.has(A) && !ST.leases.has(HOLLOW.id), 'a claim with a wrong nonce does nothing', { moves });

// ---- put back only a player free at the entrance ------------------------------------------------------------------------
reset();
g = openGate();
pos = [1000, 2000, 300];                                         // far away, with the panel's nonce in hand
ui.get('dungeonCancel')(A, [g.nonce]);
ok(!moves.length, 'Cancel from away from the entrance moves nobody', moves);
reset();
g = openGate();
restrained = { boundHands: true, captorActorId: 0x16 };
ui.get('dungeonCancel')(A, [g.nonce]);
ok(!moves.length, 'Cancel while bound moves nobody', moves);
reset();
g = openGate();
restrained = { carried: true };
ST.leases.set(HOLLOW.id, lease());
ui.get('dungeonClaim')(A, [g.nonce, 'story']);
ok(!moves.length && said.some((t) => /Someone claimed/.test(t)), 'a refused claim while carried is told but moves nobody', { moves, said });
reset();
g = openGate();
sentence = { door: 1, cell: 'x', totalMs: 600000, servedMs: 0 };
ui.get('dungeonCancel')(A, [g.nonce]);
ok(!moves.length, 'Cancel while serving a sentence moves nobody', moves);
reset();
g = openGate();
ST.leases.set(HOLLOW.id, lease());
ui.get('dungeonClaim')(A, [g.nonce, 'story']);
ok(putBackOk(), 'the frozen race loser at the door is still put back (the case the step back exists for)', moves);

// ---- a pending gate does not outlive its moment -------------------------------------------------------------------------
reset();
g = openGate();
globalThis.__dboDungeonLeave(A);
ok(!ST.pending.has(A), 'logging out clears the pending gate');
reset();
g = openGate();
restrained = { carried: true };
sweep();
ok(!ST.pending.has(A) && !moves.length && closed.includes(31), 'a gate whose player is carried away is closed by the sweep, nobody moved', { pending: ST.pending.has(A), moves, closed });
reset();
g = openGate();
sentence = { door: 1 };
sweep();
ok(!ST.pending.has(A) && !moves.length, '...and so is one whose player is jailed');
reset();
g = openGate();
pos = [1000, 2000, 300];
sweep();
ok(!ST.pending.has(A) && !moves.length, '...or who walked away');
reset();
g = openGate();
online = false;
sweep();
ok(!ST.pending.has(A) && !moves.length, '...or who is offline');
reset();
g = openGate();
sweep();
ok(ST.pending.has(A) && !moves.length, 'a free player at the entrance keeps the gate while it is fresh');
skew += 5 * 60000 + 1000;
sweep();
ok(!ST.pending.has(A) && putBackOk() && closed.includes(31), 'after 5 minutes unanswered the gate closes and the player is put back (an automatic door\'s load ends)', { moves, closed });
ui.get('dungeonCancel')(A, [g.nonce]);
ok(moves.length === 1, '...and the old nonce does nothing afterwards');

Date.now = realNow;
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
