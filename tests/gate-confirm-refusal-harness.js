// A claim refused at the gate panel's Confirm puts the player back at the entrance, as Cancel always did (#bugs "Caves",
// Viggo #UFHK, 1 Oct 20:20Z): two friends not in a party touched Freezewind Hollow's automatic door together, each got a
// gate panel, one claimed, and the other's Confirm was refused with a message only. The engine's load the automatic
// door had started stayed half-open and he stood frozen until he relogged. Real dungeons.js.
//   node tests/gate-confirm-refusal-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const DUNGEONS = path.resolve(__dirname, '..', 'dungeons.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-gateconfirm-'));
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
let pos = ENTRANCE_POS.slice();
const moves = [], said = [], logs = [], widgets = [], ui = new Map();
globalThis.__dboDungeons = { leases: new Map(), parties: new Map(), memberOf: new Map(), invites: new Map(), pending: new Map() };
globalThis.__dboDungeonsBooted = true;
delete globalThis.__dboAutoDoorBases;
require(DUNGEONS)({
  mp: {
    get: (id, p) => (p === 'profileId' ? (id === A ? PID : id === F ? FRIEND : -1) : p === 'baseDesc' ? baseOf.get(id >>> 0) : p === 'pos' ? pos : p === 'worldOrCellDesc' ? W
      : p === 'private.dungeonCooldowns' && id === F ? { [HOLLOW.id]: Date.now() + 3600000 } : undefined),
    set: (id, p, v) => { if (p === 'locationalData') { moves.push([id, v]); pos = v.pos.slice(); } },
    getIdFromDesc: idOf, lookupEspmRecordById: (id) => (records.has(id >>> 0) ? { record: records.get(id >>> 0) } : null),
  },
  log: (...x) => logs.push(x.join(' ')), personal: (a, t) => said.push(t), system: (a, t) => said.push(t), audit: () => {},
  registerChatCommand: () => {}, onUi: (ev, fn) => ui.set(ev, fn), openWidget: (a, w) => { widgets.push(w); return true; }, closeWidget: () => true,
  sendPacket: () => true, findByName: () => 0, display: () => 'Viggo #UFHK', who: () => 'Viggo #UFHK', profileOf: (a) => (a === A ? PID : a === F ? FRIEND : -1), nameOf: () => 'Viggo',
  onlineActors: () => (friendOnline ? [A, F] : [A]), isAdmin: () => false, giveItem: () => true, cfg: {}, every: () => {},
});
const ST = globalThis.__dboDungeons;
const door = idOf('d5596:BSHeartland.esm');
const realNow = Date.now; let skew = 0; Date.now = () => realNow() + skew;
const lease = () => ({ id: HOLLOW.id, name: HOLLOW.name, difficulty: 'story', leader: FRIEND, members: new Set([FRIEND]), startedAt: Date.now(), endsAt: Date.now() + 3600000, warned: false,
  lastInsideAt: Date.now(), locked: new Map(), zones: [], seenNpcs: new Set(), deadNpcs: new Set(), bossZones: new Set(), bossIds: new Set(), looted: new Set(), unlocked: new Set() });
const reset = () => { moves.length = 0; said.length = 0; logs.length = 0; widgets.length = 0; ST.leases.clear(); ST.pending.clear(); ST.parties.clear(); ST.memberOf.clear(); pos = ENTRANCE_POS.slice(); skew += 5000; };
// Touch the automatic door with no claim on it: the gate panel opens and the activation stays refused
const openGate = () => { const v = globalThis.__dboDungeonActivate(door, A); const w = widgets.find((x) => x.type === 'dungeonGate'); return { v, nonce: w && w.nonce }; };
const putBackOk = () => moves.length === 1 && moves[0][1].cellOrWorldDesc === W && moves[0][1].pos.join() === ENTRANCE_POS.join();

// ---- Viggo's race: his friend claims while his own panel is open --------------------------------------------------
reset();
let g = openGate();
ok(g.v === false && !!g.nonce && !moves.length, 'touching the free automatic door opens the gate panel and moves nobody (as before)', { g, moves });
ST.leases.set(HOLLOW.id, lease());                               // the friend, in no party with him, claims first
ui.get('dungeonClaim')(A, [g.nonce, 'story']);
ok(putBackOk(), "the race's loser is put back at the entrance, which finishes the automatic door's half-open load", moves);
ok(said.some((t) => /^Someone claimed Freezewind Hollow first\. To go in together, party up with \/party invite before anyone claims it\.$/.test(t)),
  '...told that someone claimed it first, and how to go in together next time', said);
ok(logs.some((l) => /was claimed by someone else while their gate was open/.test(l)) && logs.some((l) => /lost the claim at CYRFreezewindHollowLocation; put back at the entrance/.test(l)),
  '...and both the refusal and the move are logged', logs);
ok(!ST.pending.has(A), '...the gate is closed: a second Confirm does nothing');
moves.length = 0; ui.get('dungeonClaim')(A, [g.nonce, 'story']);
ok(!moves.length, '...nobody is moved twice');

// ---- the other refusals at Confirm ----------------------------------------------------------------------------------
reset();
g = openGate();
ui.get('dungeonClaim')(A, [g.nonce, 'no-such-difficulty']);
ok(putBackOk(), 'a claim the server cannot read (unknown difficulty) puts the player back too', moves);

reset();
g = openGate();
// A friend joins his party while the gate is open, and the dungeon still rests for him (his online character's cooldown)
ST.parties.set(PID, { leader: PID, leaderName: 'Viggo #UFHK', members: new Set([PID, FRIEND]) }); ST.memberOf.set(PID, PID); ST.memberOf.set(FRIEND, PID);
friendOnline = true;
ui.get('dungeonClaim')(A, [g.nonce, 'story']);
friendOnline = false;
ok(said.some((t) => /still rests for someone in your party/.test(t)) && putBackOk(), 'refused because it rests for someone who joined the party while the gate was open: put back too', { said, moves });

reset();
g = openGate();
pos = [ENTRANCE_POS[0] + 5000, ENTRANCE_POS[1], ENTRANCE_POS[2]];   // walked off with the panel open
ui.get('dungeonClaim')(A, [g.nonce, 'story']);
ok(!moves.length && said.some((t) => /You have wandered from the entrance/.test(t)), 'a player who wandered off could move, so is told and left where they are', { moves, said });

// ---- Cancel is unchanged ------------------------------------------------------------------------------------------------
reset();
g = openGate();
ui.get('dungeonCancel')(A, []);
ok(putBackOk() && logs.some((l) => /Viggo #UFHK turned back at CYRFreezewindHollowLocation; put back at the entrance/.test(l)), 'Cancel puts the player back as it always did, with the same log line', { moves, logs });

// ---- the door while a claim runs: the step back stays, the message says who can go in ---------------------------------
reset();
ST.leases.set(HOLLOW.id, lease());
globalThis.__dboDungeonActivate(door, A);
ok(putBackOk() && said.some((t) => /^Someone is inside Freezewind Hollow\. It frees up in \d+ minutes at most\. Only the party that claimed it can go in\. To go in together, party up with \/party invite before anyone claims it\.$/.test(t)),
  'at the door of a running claim: stepped back as last night, and told only the claiming party can go in', { moves, said });

Date.now = realNow;
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
