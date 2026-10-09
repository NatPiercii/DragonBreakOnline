// Scripted test for the dungeon container glow (server\dungeons.js): groundedpasta (2026-09-29) could not tell an empty
// barrel from a full one, because every container of a lease glowed until opened. Now only a container the claim filled
// with something glows, opening it leaves the glow on, and it goes out once the container is empty. Loads the real
// dungeons.js with a mock gamemode api, claims Bruma Caverns and drives its containers. No server and no game:
//
//   node tests/dungeon-glow-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-dungeon-glow-'));
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });
process.chdir(dir);
for (const f of ['loot.json', 'ayleid-loot.json', 'dungeon-pools.json']) fs.copyFileSync(path.join(ROOT, f), f);
const D = JSON.parse(fs.readFileSync(path.join(ROOT, 'dungeons.json'), 'utf8')).dungeons.find((d) => d.id === 'CYRBrumaCavernsLocation');
fs.writeFileSync('dungeons.json', JSON.stringify({ dungeons: [D] }));
fs.writeFileSync('expeditions.json', JSON.stringify({ expeditions: [] }));
global.setTimeout = () => 0;

let nextId = 0x1000;
const ids = new Map();
const idOf = (d) => { const k = String(d).toLowerCase(); if (!ids.has(k)) ids.set(k, nextId++); return ids.get(k); };
const A = 0x14;
const e0 = D.entrances[0];
const props = new Map([[`${A}|worldOrCellDesc`, e0.world || e0.cell], [`${A}|pos`, e0.doorPos || e0.pos]]);
const packets = [];
const timers = new Map(), ui = new Map(), cmds = new Map();
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'gamemode-config.json'), 'utf8'));
globalThis.__dboDungeons = undefined;
require(path.join(ROOT, 'dungeons.js'))({
  mp: { get: (id, p) => (p === 'profileId' ? (id === A ? 1 : -1) : props.get(`${id}|${p}`)), set: (id, p, v) => props.set(`${id}|${p}`, v), getIdFromDesc: idOf, lookupEspmRecordById: () => ({ record: null }) },
  log: () => {}, personal: () => {}, system: () => {}, audit: () => {}, registerChatCommand: (n, fn) => cmds.set(n, fn),
  onUi: (n, fn) => { const l = ui.get(n) || []; l.push(fn); ui.set(n, l); }, openWidget: () => true, closeWidget: () => true,
  sendPacket: (a, pkt) => { packets.push(pkt); return true; }, findByName: () => 0, display: String, who: String,
  profileOf: (a) => (a === A ? 1 : -1), nameOf: () => 'P', onlineActors: () => [A], isAdmin: () => false,
  // the glow mechanism itself, without the shipped dungeons.glow A/B switch (that has its own harness)
  giveItem: () => true, cfg: { dungeons: Object.assign({}, cfg.dungeons || {}, { glow: undefined }) }, every: (name, ms, fn) => timers.set(name, fn),
});

let failures = 0;
const check = (label, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };
const fire = (n, a, args) => (ui.get(n) || []).forEach((f) => f(a, args, 0));
const inv = (id) => ((props.get(`${id}|inventory`) || { entries: [] }).entries || []);
// What each ref glows as now, replaying the packets in order
const glowing = () => {
  const on = new Map();
  for (const p of packets) {
    if (p.customPacketType !== 'dboGlow') continue;
    if (p.clear) { on.clear(); continue; }
    for (const r of p.refs) { if (p.on) on.set(r, p.kind); else if (on.get(r) === p.kind) on.delete(r); }
  }
  return on;
};

globalThis.__dboDungeonActivate(idOf(e0.outsideDesc), A);
const pend = globalThis.__dboDungeons.pending.get(A);
fire('dungeonClaim', A, [pend && pend.nonce, 'normal']);
const lease = globalThis.__dboDungeons.leases.get(D.id);
check('Bruma Caverns is claimed', !!lease);
const chestIds = (D.chests || []).map((c) => idOf(c.ref));
const full = chestIds.filter((id) => inv(id).length > 0), empty = chestIds.filter((id) => inv(id).length === 0);
check(`the claim filled some containers and left others empty (${full.length} full, ${empty.length} empty)`, full.length > 0 && empty.length > 0);

packets.length = 0;
globalThis.__dboDungeonActivate(idOf(e0.outsideDesc), A);   // a member at the door again: the lease's glow is sent
let g = glowing();
check('every container that holds loot glows', full.every((id) => g.has(id)), full.filter((id) => !g.has(id)).length);
check('no empty container glows', empty.every((id) => !g.has(id)), empty.filter((id) => g.has(id)).length);

const small = (D.chests || []).filter((c) => !c.big).map((c) => idOf(c.ref)).filter((id) => inv(id).length > 0);
const target = small[0] || full.find((id) => !lease.locked.has(id));
check('a full container that is not locked is found to open', !!target);
globalThis.__dboDungeonActivate(target, A);
g = glowing();
check('opening it leaves its glow on (it still holds loot)', g.get(target) === 'loot');
const glowTimer = timers.get('dungeons.glow');
check('the glow check is registered', typeof glowTimer === 'function');
glowTimer();
check('...and the check keeps it lit while something is inside', glowing().get(target) === 'loot');
props.set(`${target}|inventory`, { entries: [] });
glowTimer();
check('emptied, it stops glowing on the next check', !glowing().has(target));

// Another opened container, only partly emptied, keeps its glow
const other = full.find((id) => id !== target && !lease.locked.has(id) && inv(id).length > 0);
if (other) {
  globalThis.__dboDungeonActivate(other, A);
  const left = inv(other).slice(0, 1).concat([{ baseId: 0xf, count: 0 }]);
  props.set(`${other}|inventory`, { entries: left });
  glowTimer();
  check('a partly emptied container keeps its glow', glowing().get(other) === 'loot');
}

// A player putting something into an empty container does not light it
const quiet = empty.find((id) => !lease.locked.has(id));
if (quiet) {
  globalThis.__dboDungeonActivate(quiet, A);
  props.set(`${quiet}|inventory`, { entries: [{ baseId: 0xf, count: 5 }] });
  glowTimer();
  check('a container that was empty stays dark after someone stores in it', !glowing().has(quiet));
}

console.log('');
console.log(failures ? `${failures} FAILURES` : 'all checks passed');
process.exit(failures ? 1 : 0);
