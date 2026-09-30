// Dungeon container glow (dungeons.js, glow only while stocked) and camp chest glow (wildlife.js, glow while a roll
// waits) share one client set (DboGlowService) and one packet type. Loads both real modules against one packet stream,
// claims Bruma Caverns and a camp, and replays the stream the way the client does: "on" sets a ref's kind, "off" drops
// it only if the kind matches, "clear" drops everything. Emptying one kind of chest must leave the other lit, and the
// dungeon's clear-all on entry must not leave the camp chests dark for longer than one camp tick.
//   node tests/glow-together-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-glow-together-'));
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });
process.chdir(dir);
for (const f of ['loot.json', 'ayleid-loot.json', 'dungeon-pools.json', 'artifacts.json']) fs.copyFileSync(path.join(ROOT, f), f);
const D = JSON.parse(fs.readFileSync(path.join(ROOT, 'dungeons.json'), 'utf8')).dungeons.find((d) => d.id === 'CYRBrumaCavernsLocation');
fs.writeFileSync('dungeons.json', JSON.stringify({ dungeons: [D] }));
fs.writeFileSync('expeditions.json', JSON.stringify({ expeditions: [] }));
fs.writeFileSync('wildlife.json', JSON.stringify({ placements: [], giantCamps: [
  { id: 'BleakwindBasinLocation', name: 'Bleakwind Basin', chests: [{ ref: 'c899b:Skyrim.esm' }, { ref: 'c89a0:Skyrim.esm' }] },
] }));
global.setTimeout = () => 0;
// wildlife.js registers more than one timer (camp glow, camp-mate factions): keep them all and run them together
const intervals = [];
global.setInterval = (fn) => { intervals.push(fn); return { unref() {} }; };
const campTick = () => intervals.forEach((fn) => fn());
global.clearInterval = () => {};

let nextId = 0x1000;
const ids = new Map();
const idOf = (d) => { const k = String(d).toLowerCase(); if (!ids.has(k)) ids.set(k, nextId++); return ids.get(k); };
const A = 0x14;
const e0 = D.entrances[0];
const props = new Map([[`${A}|worldOrCellDesc`, e0.world || e0.cell], [`${A}|pos`, e0.doorPos || e0.pos]]);
const packets = [];
const timers = new Map(), ui = new Map();
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'gamemode-config.json'), 'utf8'));
const mp = { get: (id, p) => (p === 'profileId' ? (id === A ? 1 : -1) : props.get(`${id}|${p}`)), set: (id, p, v) => props.set(`${id}|${p}`, v), getIdFromDesc: idOf, lookupEspmRecordById: () => ({ record: null }) };
const common = { mp, log: () => {}, personal: () => {}, system: () => {}, audit: () => {}, registerChatCommand: () => {}, display: String, who: String,
  sendPacket: (a, pkt) => { packets.push(pkt); return true; }, onlineActors: () => [A], isAdmin: () => false, giveItem: () => true, profileOf: (a) => (a === A ? 1 : -1) };
globalThis.__dboDungeons = undefined;
require(path.join(ROOT, 'dungeons.js'))(Object.assign({}, common, {
  onUi: (n, fn) => { const l = ui.get(n) || []; l.push(fn); ui.set(n, l); }, openWidget: () => true, closeWidget: () => true,
  findByName: () => 0, nameOf: () => 'P', cfg: { dungeons: cfg.dungeons || {} }, every: (name, ms, fn) => timers.set(name, fn),
}));
globalThis.__dboWildFactionAudit = ' (skipped in the harness)';
require(path.join(ROOT, 'wildlife.js'))(Object.assign({}, common, { cfg: {} }));

let failures = 0;
const check = (label, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };
const fire = (n, a, args) => (ui.get(n) || []).forEach((f) => f(a, args, 0));
const inv = (id) => ((props.get(`${id}|inventory`) || { entries: [] }).entries || []);
// DboGlowService.onCustomPacketMessage, replayed
const glowing = () => {
  const on = new Map();
  for (const p of packets) {
    if (p.customPacketType !== 'dboGlow') continue;
    if (p.clear) { on.clear(); continue; }
    for (const r of p.refs) { if (p.on) on.set(r, p.kind); else if (on.get(r) === p.kind) on.delete(r); }
  }
  return on;
};

const CAMP1 = idOf('c899b:Skyrim.esm'), CAMP2 = idOf('c89a0:Skyrim.esm');
check('both modules loaded (dungeon glow check and camp glow timer registered)', typeof timers.get('dungeons.glow') === 'function' && intervals.length > 0);

globalThis.__dboDungeonActivate(idOf(e0.outsideDesc), A);
const pend = globalThis.__dboDungeons.pending.get(A);
fire('dungeonClaim', A, [pend && pend.nonce, 'normal']);
const lease = globalThis.__dboDungeons.leases.get(D.id);
check('Bruma Caverns is claimed', !!lease);
const chestIds = (D.chests || []).map((c) => idOf(c.ref));
const full = chestIds.filter((id) => inv(id).length > 0 && !lease.locked.has(id));
check('the claim stocked at least two unlocked containers', full.length >= 2, full.length);

// A member at the door: the lease's glow goes out (clear first), then the camp glow is re-sent
globalThis.__dboDungeonActivate(idOf(e0.outsideDesc), A);
let g = glowing();
check('right after the dungeon glow, the clear-all has left the camp chests dark', !g.has(CAMP1) && !g.has(CAMP2));
campTick();
g = glowing();
check('one camp tick later a stocked dungeon chest and both camp chests glow at once', g.get(full[0]) === 'loot' && g.get(CAMP1) === 'loot' && g.get(CAMP2) === 'loot', [...g]);

// Emptying the dungeon chest leaves the camp chests lit
globalThis.__dboDungeonActivate(full[0], A);
props.set(`${full[0]}|inventory`, { entries: [] });
timers.get('dungeons.glow')();
g = glowing();
check('the emptied dungeon chest goes dark and both camp chests stay lit', !g.has(full[0]) && g.get(CAMP1) === 'loot' && g.get(CAMP2) === 'loot', [...g]);
check('...and another stocked dungeon chest stays lit', g.get(full[1]) === 'loot');

// Rummaging a camp chest leaves the dungeon chest lit
globalThis.__dboCampChest(CAMP1, A);
g = glowing();
check('the rummaged camp chest goes dark; the other camp chest and the stocked dungeon chest stay lit', !g.has(CAMP1) && g.get(CAMP2) === 'loot' && g.get(full[1]) === 'loot', [...g]);
campTick(); timers.get('dungeons.glow')();
g = glowing();
check('after both periodic passes nothing changes: each module only touches its own refs', !g.has(CAMP1) && g.get(CAMP2) === 'loot' && g.get(full[1]) === 'loot' && !g.has(full[0]), [...g]);

// Re-entry clears everything again; the dungeon relights its stocked chests at once, the camp on its next tick,
// and the spent camp chest stays dark
globalThis.__dboDungeonActivate(idOf(e0.outsideDesc), A);
campTick();
g = glowing();
check('after a re-entry and a camp tick: stocked dungeon chest lit, emptied one dark, spent camp chest dark, ready one lit',
  g.get(full[1]) === 'loot' && !g.has(full[0]) && !g.has(CAMP1) && g.get(CAMP2) === 'loot', [...g]);

console.log('');
console.log(failures ? `${failures} FAILURES` : 'all checks passed');
process.exit(failures ? 1 : 0);
