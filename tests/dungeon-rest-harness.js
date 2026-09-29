// A dungeon's rest and its loot belong to the claiming party (combat and economy review, 2026-09-29). The real
// dungeons.js and dungeons.json, with one dungeon: a lease that ends while its party is logged out still rests for
// them (on another character too), a claim is refused while any party member's rest runs, and only the claiming
// party opens its chests and searches its bodies.
//   node tests/dungeon-rest-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let failures = 0;
const check = (label, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${got !== undefined && !ok ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

const ids = new Map(); let nextId = 0x100;
const idOf = (d) => { const k = String(d).toLowerCase(); if (!ids.has(k)) ids.set(k, nextId++); return ids.get(k); };
const all = JSON.parse(fs.readFileSync(path.join(ROOT, 'dungeons.json'), 'utf8')).dungeons;
const HUMANOID = /bandit|draugr|falmer|forsworn|necromancer|warlock|vampire|conjurer|marauder|orc/i;
const D = all.find((d) => (d.entrances || []).some((e) => e && (e.doorPos || e.pos) && e.outsideDesc) && (d.chests || []).length && (d.zones || []).some((z) => (z.npcs || []).some((n) => HUMANOID.test(n.edid || ''))));
if (!D) { console.log('FAIL  no dungeon with an entrance, chests and humanoid enemies in dungeons.json'); process.exit(1); }
const e0 = D.entrances.find((e) => e && (e.doorPos || e.pos) && e.outsideDesc);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-dungeon-rest-'));
process.chdir(dir);
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });
for (const f of ['loot.json', 'ayleid-loot.json', 'dungeon-pools.json']) if (fs.existsSync(path.join(ROOT, f))) fs.copyFileSync(path.join(ROOT, f), f);
fs.writeFileSync('expeditions.json', JSON.stringify({ expeditions: [] }));
fs.writeFileSync('dungeons.json', JSON.stringify({ dungeons: [D] }));
global.setTimeout = () => 0;
// deny() says nothing twice to one player within 1.5 s, so each case moves the clock on
const realNow = Date.now; let skew = 0; Date.now = () => realNow() + skew; const later = () => { skew += 2000; };

// A and A2 are two characters of account 1, B is account 2
const A = 0x14, A2 = 0xff000014, B = 0xff000020;
const PROFILE = { [A]: 1, [A2]: 1, [B]: 2 };
let online = [A, B];
const props = new Map();
const home = (a) => { props.set(`${a}|worldOrCellDesc`, e0.world || e0.cell); props.set(`${a}|pos`, e0.doorPos || e0.pos); };
[A, A2, B].forEach(home);
const said = new Map(), ui = new Map(), cmds = new Map(), timers = new Map();
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'gamemode-config.json'), 'utf8'));
globalThis.__dboDungeons = undefined; globalThis.__dboDungeonAccountRest = undefined;
const API = {
  mp: { get: (id, p) => (p === 'profileId' ? (PROFILE[id] ?? -1) : props.get(`${id}|${p}`)), set: (id, p, v) => props.set(`${id}|${p}`, v), getIdFromDesc: idOf,
    lookupEspmRecordById: () => ({ record: null }) },
  log: () => {}, personal: (a, t) => said.set(a, t), system: (a, t) => said.set(a, t), audit: () => {},
  registerChatCommand: (n, fn) => cmds.set(n, fn), onUi: (n, fn) => { const l = ui.get(n) || []; l.push(fn); ui.set(n, l); },
  openWidget: () => true, closeWidget: () => true, sendPacket: () => true, findByName: () => 0, display: String, who: String,
  profileOf: (a) => PROFILE[a] ?? -1, nameOf: (a) => (a === B ? 'Bea' : 'Aela'), onlineActors: () => online, isAdmin: () => false,
  giveItem: () => true, cfg: { dungeons: cfg.dungeons || {} }, every: (n, ms, fn) => timers.set(n, fn),
};
require(path.join(ROOT, 'dungeons.js'))(API);
const ST = globalThis.__dboDungeons;
const fire = (n, a, args) => (ui.get(n) || []).forEach((f) => f(a, args, 0));
const claim = (a) => {
  home(a);
  globalThis.__dboDungeonActivate(idOf(e0.outsideDesc), a);
  const pend = ST.pending.get(a);
  if (pend) fire('dungeonClaim', a, [pend.nonce, 'normal']);
  return ST.leases.get(D.id) || null;
};
const REST = globalThis.__dboDungeonAccountRest;

// 1. Logging out: the lease ends unseen and still rests for the account
let lease = claim(A);
check(`${D.name}: a solo claim takes the lease`, !!lease && lease.members.has(1));
online = [B];
lease.lastInsideAt = Date.now() - 60 * 60000;
timers.get('dungeons.tick')();
check('with everyone logged out the lease ends', !ST.leases.has(D.id));
check('...and the dungeon rests for the account all the same', (REST.get(`1:${D.id}`) || 0) > Date.now());
check('...kept in dungeon-cooldowns.json', (JSON.parse(fs.readFileSync('dungeon-cooldowns.json', 'utf8'))[`1:${D.id}`] || 0) > Date.now());
online = [A2, B];
check('another character of the account cannot claim it again', claim(A2) === null && /still rests for you/.test(said.get(A2) || ''), said.get(A2));
online = [A, B];
check('nor can the same character back from logging out', claim(A) === null);

// 2. Party: one member's rest refuses the claim
REST.clear(); props.delete(`${A}|private.dungeonCooldowns`);
REST.set(`2:${D.id}`, Date.now() + 30 * 60000);
ST.parties.set(1, { leader: 1, leaderName: 'Aela', members: new Set([1, 2]) }); ST.memberOf.set(1, 1); ST.memberOf.set(2, 1);
said.clear(); later();
check("a leader whose party member still rests there is refused", claim(A) === null && /still rests for Bea/.test(said.get(A) || ''), said.get(A));
REST.clear(); ST.parties.clear(); ST.memberOf.clear();

// 3. Only the claiming party loots
said.clear();
lease = claim(A);
check('a fresh solo claim takes the lease', !!lease);
const chestRef = idOf((D.chests[0] || {}).ref);
const r1 = globalThis.__dboDungeonActivate(chestRef, B);
check('someone outside the claiming party cannot open its chest', r1 === false && /belongs to the party that claimed/.test(said.get(B) || ''), [r1, said.get(B)]);
const r2 = globalThis.__dboDungeonActivate(chestRef, A);
check('the claimer can', r2 !== false, r2);
const zone = lease.zones.find((z) => HUMANOID.test(z.Kind || '') || HUMANOID.test(z.Name || '')) || lease.zones[0];
const body = 0xff000500;
props.set(`${body}|private.npcSpawner`, zone.Name); props.set(`${body}|isDead`, true);
said.delete(B); later();
check('someone outside the claiming party cannot search its dead', globalThis.__dboCorpseLoot(body, B) === false && /belongs to the party/.test(said.get(B) || ''), said.get(B));
check('...and the body is left unsearched for the party', props.get(`${body}|private.dboLooted`) !== true);
check('the claimer searches it', globalThis.__dboCorpseLoot(body, A) === false && props.get(`${body}|private.dboLooted`) === true);

// 4. The party can change while the gate is open (exploit audit): whoever joined is checked again at the claim
ST.leases.delete(D.id); REST.clear(); props.delete(`${A}|private.dungeonCooldowns`); props.delete(`${B}|private.dungeonCooldowns`); ST.parties.clear(); ST.memberOf.clear();
REST.set(`2:${D.id}`, Date.now() + 30 * 60000);
home(A); globalThis.__dboDungeonActivate(idOf(e0.outsideDesc), A);
const pend4 = ST.pending.get(A);
check('a leader alone opens the gate', !!pend4);
ST.parties.set(1, { leader: 1, leaderName: 'Aela', members: new Set([1, 2]) }); ST.memberOf.set(1, 1); ST.memberOf.set(2, 1);
said.clear(); later();
if (pend4) fire('dungeonClaim', A, [pend4.nonce, 'normal']);
check('a member who still rests and joined while the gate was open refuses the claim', !ST.leases.has(D.id) && /still rests for someone in your party/.test(said.get(A) || ''), said.get(A));

// 5. A member offline when the claim ends rests all the same; the rest survives a reload, then runs out
REST.clear(); props.delete(`${A}|private.dungeonCooldowns`); props.delete(`${B}|private.dungeonCooldowns`);
online = [A, B]; home(B); said.clear(); later();
lease = claim(A);
check('a party of two claims it', !!lease && lease.members.has(1) && lease.members.has(2));
online = [A];
lease.lastInsideAt = Date.now() - 60 * 60000;
timers.get('dungeons.tick')();
check('...the member who logged out before the end rests all the same', !ST.leases.has(D.id) && (REST.get(`2:${D.id}`) || 0) > Date.now());
globalThis.__dboDungeonAccountRest = undefined;
delete require.cache[path.join(ROOT, 'dungeons.js')];
require(path.join(ROOT, 'dungeons.js'))(API);
const REST2 = globalThis.__dboDungeonAccountRest;
check('the account rest is read back from dungeon-cooldowns.json after a reload', (REST2.get(`1:${D.id}`) || 0) > Date.now() && (REST2.get(`2:${D.id}`) || 0) > Date.now());
online = [A, B]; said.clear(); later();
check('...and still refuses the claim', claim(A) === null);
skew += ((Number((cfg.dungeons || {}).cooldownMinutes) || 60) + 1) * 60000;
props.delete(`${A}|private.dungeonCooldowns`); props.delete(`${B}|private.dungeonCooldowns`);
said.clear();
check('once the rest has run out the party claims again', !!claim(A), said.get(A));

console.log(failures ? `${failures} FAILED` : 'all checks passed');
process.exitCode = failures ? 1 : 0;
