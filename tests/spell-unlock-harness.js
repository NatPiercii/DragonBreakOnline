// Open Lock spells on dungeon chests (dungeons.js __dboSpellUnlock, gamemode.js castHook openLockLevelOf): the BSAssets
// spells' effect has no script, so the claim's own locks answer them (Ancano #3PZ6, 9 Oct 05:09: an Adept chest refused,
// Open Master Lock cast, refused again). Real dungeons.js on a stub api, a lease put in by hand.
//   node tests/spell-unlock-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${!c && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!c) fails++; };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-spellunlock-'));
process.chdir(dir);
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* left */ } });
for (const f of ['dungeons.json', 'loot.json', 'ayleid-loot.json', 'dungeon-pools.json']) if (fs.existsSync(path.join(ROOT, f))) fs.copyFileSync(path.join(ROOT, f), f);
fs.writeFileSync('expeditions.json', JSON.stringify({ expeditions: [] }));

const A = 0xff000101, OUT = 0xff000102;
const PROFILE = { [A]: 1, [OUT]: 2 };
const props = new Map(), said = [], packets = [];
const put = (id, k, v) => props.set(`${id}|${k}`, v);
require(path.join(ROOT, 'dungeons.js'))({
  mp: { get: (id, p) => (p === 'profileId' ? (PROFILE[id] ?? -1) : props.get(`${id}|${p}`)), set: (id, p, v) => props.set(`${id}|${p}`, v), getIdFromDesc: () => 0x100, lookupEspmRecordById: () => ({ record: null }) },
  log: () => {}, personal: (a, t) => said.push([a, t]), system: (a, t) => said.push([a, t]), audit: () => {}, registerChatCommand: () => {}, onUi: () => {},
  openWidget: () => true, closeWidget: () => true, sendPacket: (a, p) => packets.push([a, p]), findByName: () => 0, display: String, who: String,
  profileOf: (a) => PROFILE[a] ?? -1, nameOf: () => 'P', onlineActors: () => [A, OUT], isAdmin: () => false, giveItem: () => true, cfg: { dungeons: {} }, every: () => {},
});
const unlock = globalThis.__dboSpellUnlock;
ok(typeof unlock === 'function', 'dungeons.js exports __dboSpellUnlock');

const CELL = 'abc:BSHeartland.esm';
// The caster at the origin facing +Y (angle 0); chests: ahead (Adept), behind and nearer (Novice), far ahead (Master, 15 m), another cell
const AHEAD = 0xa1, BEHIND = 0xa2, FAR = 0xa3, ELSEWHERE = 0xa4;
put(A, 'pos', [0, 0, 0]); put(A, 'angle', [0, 0, 0]); put(A, 'worldOrCellDesc', CELL);
put(AHEAD, 'pos', [50, 500, 0]); put(BEHIND, 'pos', [0, -200, 0]); put(FAR, 'pos', [0, 1050, 0]); put(ELSEWHERE, 'pos', [0, 100, 0]);
for (const id of [AHEAD, BEHIND, FAR]) put(id, 'worldOrCellDesc', CELL);
put(ELSEWHERE, 'worldOrCellDesc', 'def:BSHeartland.esm');
const lease = { id: 'CYRTest', name: 'Test', members: new Set([1]), locked: new Map([[AHEAD, 2], [BEHIND, 0], [FAR, 4], [ELSEWHERE, 4]]), unlocked: new Set(), looted: new Set(), stocked: new Set([AHEAD, BEHIND, FAR]) };
globalThis.__dboDungeons.leases.set('CYRTest', lease);
const last = () => (said.length ? said[said.length - 1][1] : '');

ok(unlock(A, 1) === false && !lease.unlocked.size && /Adept lock holds/.test(last()), 'Open Apprentice Lock at the Adept chest it faces: holds, nothing opened', last());
ok(unlock(A, 4) === true && lease.unlocked.has(AHEAD) && !lease.unlocked.has(BEHIND) && /Adept lock gives way to the spell/.test(last()), 'Open Master Lock: the chest ahead opens, not the nearer one behind', last());
ok(packets.some(([a, p]) => a === A && p.customPacketType === 'dboGlow' && p.kind === 'locked' && p.on === false && p.refs.includes(AHEAD)) && packets.some(([, p]) => p.kind === 'loot' && p.on === true && p.refs.includes(AHEAD)), '...its locked glow swaps to the loot glow, as a picked lock does');
put(A, 'angle', [0, 0, 180]);
ok(unlock(A, 1) === true && lease.unlocked.has(BEHIND), 'turned round, Open Apprentice Lock opens the Novice chest behind');
put(A, 'angle', [0, 0, 0]);
ok(unlock(A, 4) === false && !lease.unlocked.has(FAR) && !lease.unlocked.has(ELSEWHERE) && /no locked chest/.test(last()), 'a chest 15 m away or in another cell is out of reach', last());
ok(unlock(OUT, 4) === false && unlock(0xff000999, 4) === false, 'someone outside the claim, or not a player, opens nothing');

const GM = fs.readFileSync(path.join(ROOT, 'gamemode.js'), 'utf8');
ok(/OPEN_LOCK_SPELLS = \[\['6028cd:BSAssets\.esm', 1\], \['6028cf:BSAssets\.esm', 3\], \['6028d0:BSAssets\.esm', 4\]\]/.test(GM), 'castHook maps BSKOpenSpell2/4/5 (BSAssets 6028cd/cf/d0, read from the plugin) to Apprentice, Expert, Master');
ok(/globalThis\.__dboSpellUnlock\(Number\(casterId\) >>> 0, lockLevel\)/.test(GM) && /globalThis\.__dboSpellUnlock = null; \}/.test(GM), '...calls dungeons.js after a cast the chain let through, and a failed load clears it');
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
