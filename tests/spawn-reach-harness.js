// Scripted test for NpcSpawnSystem's zones on approach (Reach, Group; dungeons.js spawnReach, Nate 8 Oct: big dungeons wake as
// the party comes near instead of all at once). Same mock mp as spawn-refill-harness.js.
// Bundle first, then run from this folder's parent:
//
//   ./node_modules/.bin/esbuild ts/systems/npcSpawnSystem.ts --bundle --platform=node --format=cjs --outfile=<out>
//   node tests\spawn-refill-harness.js <out>
//
// Runs in a scratch folder, so the real zone-spawns.json and npc-fallen-spots.json are never touched.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { NpcSpawnSystem } = require(path.resolve(process.argv[2]));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-spawn-reach-'));
process.chdir(dir);
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });
// As on the live server: zone-spawns.json is a symlink into the world state folder
fs.mkdirSync('state');
fs.writeFileSync(path.join('state', 'zone-spawns.json'), '[]');
fs.symlinkSync(path.join('state', 'zone-spawns.json'), 'zone-spawns.json');
// Every file write the system starts, to count them
const writes = [];
const realWriteFile = fs.promises.writeFile;
fs.promises.writeFile = (file, data, ...rest) => { writes.push({ file: String(file), data: String(data) }); return realWriteFile.call(fs.promises, file, data, ...rest); };
let now = 1790000000000;
Date.now = () => now;
const realTimeout = global.setTimeout;
// updateAsync waits out its poll interval first; the harness drives the clock itself
global.setTimeout = (fn, ms, ...args) => (ms >= 1000 ? (fn(...args), 0) : realTimeout(fn, ms, ...args));

let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

// ---- mock world --------------------------------------------------------------------------------------------------
const WORLD = 'a764b:bsheartland.esm';
const CAVE = '1234:skyrim.esm';
const worldIds = { [WORLD]: 0x0800a764b, [CAVE]: 0x1234 };
const PLAYER = 0x14;
const actors = new Map();   // id -> { pos, world, dead, props }
const free = [];            // freed low indices, lowest handed out first
let nextIdx = 0x100;
const destroyed = [];
const created = [];
const newId = () => { free.sort((a, b) => a - b); return (0xff000000 + (free.length ? free.shift() : nextIdx++)) >>> 0; };
const descOf = (id) => (id >= 0xff000000 ? id.toString(16) : Object.keys(worldIds).find((d) => worldIds[d] === id) || `${id.toString(16)}:Skyrim.esm`);
const mp = {
  get: (id, k) => {
    const a = actors.get(id);
    if (!a) throw new Error(`no form ${id.toString(16)}`);
    if (k === 'isDead') return !!a.dead;
    if (k === 'worldOrCellDesc') return a.world;
    return a.props[k];
  },
  set: (id, k, v) => {
    const a = actors.get(id);
    if (!a) throw new Error(`no form ${id.toString(16)}`);
    if (k === 'locationalData') { a.pos = v.pos.slice(); a.world = v.cellOrWorldDesc; return; }
    a.props[k] = v;
  },
  getActorPos: (id) => { const a = actors.get(id); if (!a) throw new Error('gone'); return a.pos.slice(); },
  getActorCellOrWorld: (id) => { const a = actors.get(id); if (!a) throw new Error('gone'); return worldIds[a.world.toLowerCase()] || 0; },
  getActorName: () => 'someone',
  destroyActor: (id) => { if (!actors.delete(id)) throw new Error('gone'); destroyed.push(id); free.push(id - 0xff000000); },
  getIdFromDesc: (d) => { const s = String(d).toLowerCase(); if (worldIds[s] !== undefined) return worldIds[s]; if (/^ff[0-9a-f]{6}$/.test(s)) return parseInt(s, 16); return 0x1000 + s.length; },
  getDescFromId: descOf,
  lookupEspmRecordById: () => ({ record: { type: 'NPC_', fields: [] } }),
  callPapyrusFunction: (kind, cls, fn, self) => {
    const anchor = actors.get(parseInt(self.desc, 16)) || { pos: [0, 0, 0], world: WORLD };
    const id = newId();
    actors.set(id, { pos: anchor.pos.slice(), world: anchor.world, dead: false, props: {} });
    created.push(id);
    return { desc: id.toString(16) };
  },
};
actors.set(PLAYER, { pos: [0, 0, 0], world: WORLD, dead: false, props: {} });
mp.get = ((get) => (id, k) => (k === 'onlinePlayers' && id === 0 ? [PLAYER] : get(id, k)))(mp.get);

const sys = new NpcSpawnSystem(() => {});
sys.mp = mp;
sys.ready = true;
const zoneOf = (name, desc, pos, count, respawn = 1800, radius = 3000) => sys.buildZone(mp, { name, locator: desc, anchor: '', pos, radius, npcs: [{ id: '4932a:BSHeartland.esm', count }], despawnSeconds: 120, respawnSeconds: respawn, prespawn: false, ambush: false }, new Map());
const poll = () => sys.updateAsync({ svr: mp });
const live = (zone) => zone.spawned.filter((e) => e.id && !e.diedAt);
// Until the spawn files' writes have finished, and any write asked for meanwhile: they run off the game loop on the real
// disk. A fixed 30 ms was shorter than a write on a busy box and failed run-all 2 runs in 10 (2026-09-30); ten seconds
// is a bound for a hung write, not a wait.
const idle = (w) => !w || (!w.writing && !w.dirty);
const settle = async () => {
  for (let i = 0; i < 2000 && !(idle(sys.spawnsFile) && idle(sys.fallenFile)); i++) await new Promise((r) => realTimeout(r, 5));
  if (!(idle(sys.spawnsFile) && idle(sys.fallenFile))) check('the spawn files finish writing within ten seconds', false);
};

const ok = (c, what, got) => check(what, c, got);
const reachZone = (name, pos, opts = {}) => {
  const z = sys.buildZone(mp, { name, locator: CAVE, anchor: '', pos, radius: opts.radius || 4500, npcs: [{ id: '4932a:BSHeartland.esm', count: 1 }],
    despawnSeconds: 0, respawnSeconds: 0, prespawn: !!opts.prespawn, ambush: false, reach: opts.reach !== false, group: opts.group || '' }, new Map());
  if (opts.anchorPlayer) z.anchorId = PLAYER;
  return z;
};
const me = actors.get(PLAYER);
(async () => {
  delete globalThis.__dboTerrainAt;
  me.world = CAVE; me.pos = [0, 0, 0];
  const entrance = reachZone('dungeon:D:0', [500, 0, 0], { group: 'D:a', prespawn: true, anchorPlayer: true });
  const far = reachZone('dungeon:D:1', [10000, 0, 0], { group: 'D:b' });
  const farMate = reachZone('dungeon:D:2', [10900, 0, 0], { group: 'D:b' });
  const farther = reachZone('dungeon:D:3', [30000, 0, 0], { group: 'D:c' });
  const old = reachZone('dungeon:E:0', [40000, 0, 0], { reach: false, radius: 100000 });
  sys.zones = [entrance, far, farMate, farther];
  ok(sys.zones.every((z) => z.reach) && far.group === 'D:b', 'Reach and Group are read from the zone file (any case)');
  ok(JSON.stringify(entrance.signature).includes('reach') && !JSON.stringify(old.signature).includes('reach'), 'only a zone on approach carries the flag in its signature (others reload unchanged)');
  const placed = sys.prespawnZones('dungeon:D:');
  ok(placed === 1 && live(entrance).length === 1 && !live(far).length && !live(farther).length, 'the claim places only the prespawned group (the landing)', placed);
  await poll();
  ok(!live(far).length && !live(farMate).length && !live(farther).length, 'with the party at the landing, the far groups stay unspawned');
  me.pos = [6000, 0, 0]; await poll();
  ok(live(far).length === 1, 'coming within reach of one enemy wakes it');
  ok(live(farMate).length === 1, '...and the rest of its group with it, though that one is still out of reach');
  ok(!live(farther).length, '...but no other group');
  me.pos = [0, 0, 0]; now += 600000; await poll();
  ok(live(far).length === 1 && live(farMate).length === 1, 'walking away despawns nothing (Despawn 0)');
  // A dungeon without Reach still spawns whole, the old way
  sys.zones = [old]; me.pos = [0, 0, 0];
  const oldPlaced = sys.prespawnZones('dungeon:E:');
  ok(oldPlaced === 1 && live(old).length === 1, 'a zone without Reach is placed at the claim as before, however far');
  console.log(failures ? `${failures} failed` : 'all passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
