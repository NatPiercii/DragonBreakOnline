// Scripted test for NpcSpawnSystem's slot bookkeeping against a mock mp whose form ids are handed out like the
// server's MakeID (lowest free index first, so a destroyed NPC's index goes to the next form at once).
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-spawn-refill-'));
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
const settle = () => new Promise((r) => realTimeout(r, 30));

(async () => {
  // ---- 1: a slot is never refilled in the poll that destroyed its NPC ----------------------------------------------
  delete globalThis.__dboTerrainAt;
  const wolves = zoneOf('wild:wolf:1', WORLD, [0, 0, 0], 2);
  sys.zones = [wolves];
  await poll();
  check('the zone fills with a player inside', live(wolves).length === 2, live(wolves).map((e) => e.id.toString(16)));
  const [first] = live(wolves);
  const fallenId = first.id;
  actors.get(fallenId).pos = [0, 0, -5000];
  destroyed.length = 0; created.length = 0;
  await poll();
  check('a fallen NPC is destroyed', destroyed.includes(fallenId));
  check('...and its slot is not refilled in the same poll', created.length === 0, created.map((id) => id.toString(16)));
  now += 5000; await poll();
  check('...nor 5 s later', created.length === 0);
  now += 6000; await poll();
  check('...but after the 10 s hold', created.length === 1 && live(wolves).length === 2, created.map((id) => id.toString(16)));

  // A corpse swept after a cooldown shorter than its timer: the slot waits out the hold, not the next poll
  const quick = zoneOf('wild:deer:2', WORLD, [500, 0, 0], 1, 60);
  sys.zones = [wolves, quick];
  await poll();
  const deerId = live(quick)[0].id;
  actors.get(deerId).dead = true;
  await poll();
  now += 301000;
  destroyed.length = 0; created.length = 0;
  await poll();
  check('a swept corpse is destroyed', destroyed.includes(deerId));
  check('...and its slot (cooldown long over) is not refilled in the same poll', created.length === 0, created.map((id) => id.toString(16)));
  now += 11000; await poll();
  check('...it is refilled after the hold', live(quick).length === 1);

  // A despawned zone that comes back by the same name at once (a dungeon lease cleared and claimed again)
  // Prespawned from a placed anchor ref (here the player's id stands in for it), with nobody in the cave
  const lease = zoneOf('dungeon:D:0', CAVE, [0, 0, 0], 1, 0);
  lease.prespawn = true; lease.anchorId = PLAYER;
  sys.zones = [wolves, quick, lease];
  await poll();
  check('the lease zone prespawns', live(lease).length === 1);
  const again = zoneOf('dungeon:D:0', CAVE, [64, 0, 0], 1, 0);
  again.prespawn = true; again.anchorId = PLAYER;
  destroyed.length = 0; created.length = 0;
  sys.replaceZones(mp, [wolves, quick, again]);
  sys.fillSlots(mp, again, now, PLAYER);
  check('a reload that replaces the zone destroys its NPC', destroyed.length === 1);
  check('...and the zone of the same name is not filled at once', created.length === 0 && again.spawned.length === 0);
  now += 11000; await poll();
  check('...but is after the hold', live(again).length === 1);

  // ---- 2: the fall memory follows the spot, not the zone's name and number ----------------------------------------
  const player = actors.get(PLAYER);
  player.world = CAVE; player.pos = [0, 0, 0];
  const spot = `${CAVE}@0,0,0`;
  fs.writeFileSync('npc-fallen-spots.json', JSON.stringify({ 'dungeon:D:3:0': 2, [spot]: 1 }));
  sys.fallenSpots.clear(); sys.unseenFalls.clear();
  sys.loadFallen();
  check('old <zone>:<slot> keys are ignored, spot keys kept', !sys.fallenSpots.has('dungeon:D:3:0') && sys.fallenSpots.get(spot) === 1, [...sys.fallenSpots]);
  const d3 = zoneOf('dungeon:D:3', CAVE, [0, 0, 0], 1, 0, 100000);
  sys.zones = [d3];
  now += 20000; await poll();
  check('the zone the old key named still fills', live(d3).length === 1);
  const dropOnce = async (zone) => { const e = live(zone)[0]; actors.get(e.id).pos = [zone.pos[0], zone.pos[1], zone.pos[2] - 5000]; await poll(); };
  await dropOnce(d3);
  check('a second witnessed fall on the spot gives it up', sys.fallenSpots.get(spot) === 2 && d3.slotReadyAt[0] === -1, [...sys.fallenSpots]);
  check('...and the spawn system reports one given-up slot for the dungeon', sys.givenUpSlots('dungeon:D:') === 1 && sys.givenUpSlots('dungeon:E:') === 0);
  await settle();
  const saved = JSON.parse(fs.readFileSync('npc-fallen-spots.json', 'utf8'));
  check('the saved file is keyed by spot, the old key dropped', saved[spot] === 2 && !('dungeon:D:3:0' in saved), saved);
  // Next lease: the numbering moved, the same placement is now zone 7 and zone 3 stands elsewhere
  const d7 = zoneOf('dungeon:D:7', CAVE, [0, 0, 0], 1, 0, 100000);
  const d3b = zoneOf('dungeon:D:3', CAVE, [800, 0, 0], 1, 0, 100000);
  sys.zones = [d7, d3b];
  now += 20000; await poll();
  check('the placement on the floorless spot stays empty under its new number', live(d7).length === 0);
  check('the placement that took the old number fills', live(d3b).length === 1);

  // Falls nobody saw: the spot waits for a player, and the third one gives it up for this run
  const far = zoneOf('dungeon:F:0', CAVE, [5000, 0, 0], 1, 0, 100000);
  sys.zones = [far];
  const farSpot = `${CAVE}@5000,0,0`;
  now += 20000; await poll();
  check('a spot 5,000 from the player fills', live(far).length === 1);
  for (let i = 1; i <= 3; i++) {
    player.pos = [0, 0, 0];
    await dropOnce(far);
    now += 11000; await poll();
    const waits = live(far).length === 0;
    player.pos = [4000, 0, 0];
    now += 1000; await poll();
    if (i < 3) check(`unseen fall ${i}: counted for this run only, the slot waits for a player and then refills`, sys.unseenFalls.get(farSpot) === i && !sys.fallenSpots.has(farSpot) && waits && live(far).length === 1, [sys.unseenFalls.get(farSpot), waits, live(far).length]);
    else check('the third unseen fall gives the spot up', sys.unseenFalls.get(farSpot) === 3 && live(far).length === 0 && far.slotReadyAt[0] === -1 && sys.givenUpSlots('dungeon:F:') === 1);
  }
  await settle();
  check('unseen falls are not written to the file', !(farSpot in JSON.parse(fs.readFileSync('npc-fallen-spots.json', 'utf8'))));
  sys.resetZone('dungeon:F:0');
  check('an admin reset forgets them', !sys.unseenFalls.has(farSpot) && sys.givenUpSlots('dungeon:F:') === 0);

  // ---- 3: outdoors 'fell out of the world' is measured against the terrain under the NPC -----------------------------
  // A mountain spot at z 19396 over a valley whose terrain lies at 10,000 (wild:wolf:2882, 2026-09-25)
  const peak = zoneOf('wild:wolf:2882', WORLD, [75078, 238652, 19396], 1);
  globalThis.__dboTerrainAt = (desc, x, y) => (/bsheartland/i.test(desc) ? { lo: 10000, hi: 10000 } : null);
  check('outdoors, 4,500 below the spot but 4,900 above the terrain is not a fall', !sys.fellOut(peak, [79071, 233420, 14882]));
  check('outdoors, 1,500 under the terrain is a fall', sys.fellOut(peak, [79071, 233420, 8500]));
  check('outdoors, 500 under the terrain is not', !sys.fellOut(peak, [79071, 233420, 9500]));
  const room = zoneOf('dungeon:R:0', CAVE, [0, 0, 0], 1, 0, 100000);
  check('an interior (no terrain data) keeps 3,000 below the spot', !sys.fellOut(room, [0, 0, -2900]) && sys.fellOut(room, [0, 0, -3100]));
  globalThis.__dboTerrainAt = () => { throw new Error('boom'); };
  check('a failing lookup falls back to the old rule', !sys.fellOut(peak, [0, 0, 16500]) && sys.fellOut(peak, [0, 0, 16300]));
  delete globalThis.__dboTerrainAt;
  check('without the terrain module the old rule holds outdoors', sys.fellOut(peak, [79071, 233420, 14882]));
  // Through a poll: the chase downhill keeps its NPC
  globalThis.__dboTerrainAt = (desc, x, y) => (/bsheartland/i.test(desc) ? { lo: 10000, hi: 10000 } : null);
  player.world = WORLD; player.pos = [76000, 237000, 19000];
  sys.zones = [peak];
  now += 20000; await poll();
  const ogre = live(peak)[0];
  actors.get(ogre.id).pos = [79071, 233420, 14882];
  destroyed.length = 0;
  await poll();
  check('a poll leaves an NPC chasing downhill where it is', destroyed.length === 0 && live(peak).length === 1 && live(peak)[0].id === ogre.id);
  delete globalThis.__dboTerrainAt;

  // ---- 4: the spawn files are written off the game loop -----------------------------------------------------------
  await settle();
  check('zone-spawns.json is still a symlink into the state folder', fs.lstatSync('zone-spawns.json').isSymbolicLink());
  const idsOnDisk = () => JSON.parse(fs.readFileSync(path.join('state', 'zone-spawns.json'), 'utf8'));
  const idsNow = () => [...new Set([...sys.zones.flatMap((z) => z.spawned.map((e) => e.id)), ...sys.corpses.keys()])].filter((id) => id > 0);
  check('...and the file it points at holds the live ids', JSON.stringify(idsOnDisk()) === JSON.stringify(idsNow()), [idsOnDisk(), idsNow()]);
  // Ten zones fill in one poll: the old code wrote the file ten times, synchronously
  const herd = [];
  for (let i = 0; i < 10; i++) herd.push(zoneOf(`wild:herd:${i}`, WORLD, [76000 + i * 200, 237000, 19000], 1));
  sys.zones = [peak, ...herd];
  writes.length = 0;
  now += 20000;
  const polled = poll();
  check('the poll does not write the file itself', writes.length === 0);
  await polled; await settle();
  const sidecar = writes.filter((w) => /zone-spawns\.json\.tmp$/.test(w.file));
  check('ten zones filled in one poll make one write', herd.every((z) => live(z).length === 1) && sidecar.length === 1, sidecar.length);
  check('...to a temp file beside the real one, renamed over it', sidecar.length === 1 && path.dirname(sidecar[0].file) === fs.realpathSync('state') && !fs.existsSync(path.join('state', 'zone-spawns.json.tmp')));
  const herdIds = herd.map((z) => live(z)[0].id);
  check('...holding every live id', JSON.stringify(idsOnDisk()) === JSON.stringify(idsNow()) && herdIds.every((id) => idsOnDisk().includes(id)));
  // A save asked for while a write is in flight is written after it, with the ids as they are then
  writes.length = 0;
  sys.saveSpawns();
  await Promise.resolve(); await Promise.resolve();
  sys.despawn(mp, herd[0]);
  sys.despawn(mp, herd[1]);
  await settle();
  const late = writes.filter((w) => /zone-spawns\.json\.tmp$/.test(w.file));
  check('saves during a write make one more write, not one each', late.length === 2, late.length);
  check('...and the file ends with the latest ids', JSON.stringify(idsOnDisk()) === JSON.stringify(idsNow()) && !idsOnDisk().includes(herdIds[0]) && !idsOnDisk().includes(herdIds[1]) && idsOnDisk().includes(herdIds[2]));

  // The player prefilter is a shortcut only: who is inside a zone is the same with 3 players or 30 in a world
  const crowd = zoneOf('wild:crowd:0', WORLD, [0, 0, 0], 1);
  const inside = (count) => {
    const ps = [];
    for (let i = 0; i < count; i++) ps.push({ id: 0x100 + i, world: 0x800a764b, pos: [i * 450 - 4000, (i % 5) * 700 - 1400, 0] });
    crowd.inside = new Set([0x100 + 12]);
    sys.updateInside(mp, crowd, sys.buildIndex(ps));
    return [...crowd.inside].sort();
  };
  const brute = (count) => {
    const out = [];
    for (let i = 0; i < count; i++) { const x = i * 450 - 4000, y = (i % 5) * 700 - 1400; const reach = i === 12 ? 4500 : 3000; if (Math.hypot(x, y) <= reach) out.push(0x100 + i); }
    return out.sort();
  };
  check('the zone holds exactly the players within reach, few players (grid skipped)', JSON.stringify(inside(20)) === JSON.stringify(brute(20)), inside(20).length);
  check('...and many players (grid used)', JSON.stringify(inside(30)) === JSON.stringify(brute(30)), inside(30).length);

  console.log('');
  console.log(failures ? `${failures} FAILURES` : 'all checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.log('FAIL  harness threw', e && e.stack); process.exit(1); });
