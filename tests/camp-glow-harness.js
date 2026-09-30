// Camp chests glow while they hold a roll for the player and go dark while theirs is spent (wildlife.js campGlow;
// GroundedPasta, #suggestions 29 Sep: "no way to tell between a chest or barrel that is empty and one that isn't").
// Runs the real wildlife.js in a scratch folder with its own small wildlife.json, since loading it writes NPC-Spawns.json.
//   node tests/camp-glow-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const SRC = path.resolve(__dirname, '..', 'wildlife.js');
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${what}${!c && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!c) fails++; };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-campglow-'));
const cwd = process.cwd();
const CHEST_A = 0x000c899b, CHEST_B = 0x000c89a0, CHEST_G = 0x09001234;
fs.writeFileSync(path.join(dir, 'wildlife.json'), JSON.stringify({ placements: [], giantCamps: [
  { id: 'BleakwindBasinLocation', name: 'Bleakwind Basin', chests: [{ ref: 'c899b:Skyrim.esm' }, { ref: 'c89a0:Skyrim.esm' }] },
  { id: 'DuskThornCamp', name: 'Dusk Thorn Camp', owners: 'goblins', chests: [{ ref: '1234:Test.esp' }] },
] }));
fs.writeFileSync(path.join(dir, 'loot.json'), JSON.stringify({ pools: {} }));
fs.writeFileSync(path.join(dir, 'artifacts.json'), JSON.stringify({ patterns: [] }));

const props = new Map(), packets = [], said = [];
const PLUGINS = { 'skyrim.esm': 0x00, 'test.esp': 0x09 };
const mp = {
  get: (id, k) => props.get(`${id}|${k}`), set: (id, k, v) => props.set(`${id}|${k}`, v),
  getIdFromDesc: (d) => { const [h, p] = String(d).split(':'); const i = PLUGINS[String(p).toLowerCase()]; if (i === undefined) throw new Error('no plugin'); return ((i << 24) | parseInt(h, 16)) >>> 0; },
};
const A = 0xff000275, B = 0xff0001e6;
let online = [A, B];
globalThis.__dboWildFactionAudit = ' (skipped in the harness)';
const load = (cfg) => {
  process.chdir(dir);
  try {
    delete require.cache[SRC];
    require(SRC)({ mp, log: () => {}, personal: (a, t) => said.push([a, t]), system: () => {}, registerChatCommand: () => {}, giveItem: () => true,
      profileOf: () => 1, display: String, who: String, audit: () => {}, isAdmin: () => false, cfg: cfg || {}, onlineActors: () => online,
      sendPacket: (a, p) => packets.push([a, p]) });
  } finally { process.chdir(cwd); }
};
const glowState = (a) => {
  const on = new Set();
  for (const [to, p] of packets) if (to === a && p.customPacketType === 'dboGlow') for (const r of p.refs || []) { if (p.on) on.add(r); else on.delete(r); }
  return on;
};
try {
  load();
  ok(typeof globalThis.__dboCampGlow === 'function' && globalThis.__dboCampGlowTimer, 'the camp glow and its timer are registered');
  globalThis.__dboCampGlow(A);
  let on = glowState(A);
  ok(on.has(CHEST_A) && on.has(CHEST_B) && on.has(CHEST_G), 'with nothing looted, every camp chest glows for the player', [...on]);
  ok(packets.every(([, p]) => p.kind === 'loot'), 'the loot rim is used');

  packets.length = 0; said.length = 0;
  ok(globalThis.__dboCampChest(CHEST_A, A) === false, 'rummaging through a chest is handled by the server');
  on = glowState(A);
  ok(!on.has(CHEST_A) && on.has(CHEST_B), 'the rummaged chest goes dark at once; the other stays lit', [...on]);
  ok(/giants' chest/.test((said[0] || [])[1] || ''), 'a giant camp chest is still the giants\' chest', said);

  packets.length = 0; said.length = 0;
  globalThis.__dboCampChest(CHEST_G, A);
  ok(/goblins' chest/.test((said[0] || [])[1] || ''), 'a camp with owners names them (Dusk Thorn: the goblins\' chest)', said);

  packets.length = 0;
  globalThis.__dboCampGlow(B);
  on = glowState(B);
  ok(on.has(CHEST_A) && on.has(CHEST_G), 'another player still sees both chests lit: the roll is per player', [...on]);

  // The cooldown runs out: the next pass lights it again
  const loots = mp.get(A, 'private.campLoot');
  loots[CHEST_A.toString(16)] = Date.now() - 1000;
  mp.set(A, 'private.campLoot', loots);
  packets.length = 0;
  globalThis.__dboCampGlow(A);
  on = glowState(A);
  ok(on.has(CHEST_A) && !on.has(CHEST_G), 'a chest whose hour has passed lights up again; one still resting stays dark', [...on]);

  // A dungeon entry or login clear wipes the client's set; the timer sends the whole state again
  packets.length = 0;
  online = [A];
  const tick = globalThis.__dboCampGlowTimer;
  ok(typeof tick === 'object' || typeof tick === 'number', 'a timer handle is kept on globalThis');
  load();
  ok(globalThis.__dboCampGlowTimer !== tick, 'a hot reload replaces the timer instead of stacking a second one');

  // Wildlife switched off: every camp chest goes dark
  packets.length = 0;
  load({ wildlife: { enabled: false } });
  globalThis.__dboCampGlow(B);
  on = glowState(B);
  ok(on.size === 0 && packets.some(([, p]) => p.on === false), 'with wildlife off no camp chest glows', [...on]);

  const gm = fs.readFileSync(path.resolve(__dirname, '..', 'gamemode.js'), 'utf8');
  ok(/require\(WILDLIFE_JS\)\(\{[^}]*sendPacket[^}]*\}\)/.test(gm), 'gamemode.js hands wildlife.js its sendPacket');
  ok(/__dboGlowClear\(a\)[^\n]*\n[^\n]*\n\s*try \{ if \(globalThis\.__dboCampGlow\) globalThis\.__dboCampGlow\(a\);/.test(gm), 'login relights the camp chests right after the glow clear');
} finally {
  if (globalThis.__dboCampGlowTimer) clearInterval(globalThis.__dboCampGlowTimer);
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(fails ? `${fails} FAILED` : 'all checks passed');
process.exit(fails ? 1 : 0);
