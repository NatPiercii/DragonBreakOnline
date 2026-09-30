// Scripted test for how NpcSpawnSystem treats an animal that runs off its zone (deer and rabbits flee on sight, which is
// their vanilla AI and stays). Purr's /bug of 29 Sep 22:18: a deer that bolted was destroyed 32 s later 9,854 from its
// zone and a new one placed on its slot 10 s after that, in front of the player, and a zone despawned with its deer in view.
// Bundle first, then run from this folder's parent:
//
//   ./node_modules/.bin/esbuild ts/systems/npcSpawnSystem.ts --bundle --platform=node --format=cjs --outfile=<out>
//   node tests/spawn-stray-harness.js <out>
//
// Runs in a scratch folder, so the real zone-spawns.json and npc-fallen-spots.json are never touched.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { NpcSpawnSystem } = require(path.resolve(process.argv[2]));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-spawn-stray-'));
process.chdir(dir);
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* left for the OS */ } });
fs.writeFileSync('zone-spawns.json', '[]');
let now = 1790000000000;
Date.now = () => now;
const realTimeout = global.setTimeout;
// updateAsync waits out its poll interval first; the harness drives the clock itself
global.setTimeout = (fn, ms, ...args) => (ms >= 1000 ? (fn(...args), 0) : realTimeout(fn, ms, ...args));

let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

// ---- mock world (as spawn-refill-harness) --------------------------------------------------------------------------
const WORLD = 'a764b:bsheartland.esm';
const CAVE = '1234:skyrim.esm';
const worldIds = { [WORLD]: 0x0800a764b, [CAVE]: 0x1234 };
const PLAYER = 0x14;
const actors = new Map();
const free = [];
let nextIdx = 0x100;
const destroyed = [];
const created = [];
const newId = () => { free.sort((a, b) => a - b); return (0xff000000 + (free.length ? free.shift() : nextIdx++)) >>> 0; };
const descOf = (id) => (id >= 0xff000000 ? id.toString(16) : Object.keys(worldIds).find((d) => worldIds[d] === id) || `${id.toString(16)}:Skyrim.esm`);
const mp = {
  get: (id, k) => {
    if (k === 'onlinePlayers' && id === 0) return [PLAYER];
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
const player = { pos: [0, 0, 0], world: WORLD, dead: false, props: {} };
actors.set(PLAYER, player);

const lines = [];
const sys = new NpcSpawnSystem((msg) => lines.push(String(msg)));
sys.mp = mp;
sys.ready = true;
delete globalThis.__dboTerrainAt;
// wildlife.js zones: radius 3000, so the leash is max(8000, 3 x 3000) = 9000 from the zone's centre
const zoneOf = (name, pos, count, despawn = 120) => sys.buildZone(mp, { name, locator: WORLD, anchor: '', pos, radius: 3000, npcs: [{ id: '4932a:BSHeartland.esm', count }], despawnSeconds: despawn, respawnSeconds: 1800, prespawn: false, ambush: false }, new Map());
const poll = () => sys.updateAsync({ svr: mp });
const live = (zone) => zone.spawned.filter((e) => e.id && !e.diedAt);
const at = (x, world = WORLD) => { player.pos = [x, 0, 0]; player.world = world; };
const reset = () => { destroyed.length = 0; created.length = 0; lines.length = 0; };

(async () => {
  // ---- 1: a deer that bolts past the leash while a player can see it stays where it ran ----------------------------
  const deer = zoneOf('wild:deer:2875', [0, 0, 0], 2);
  sys.zones = [deer];
  at(0);
  await poll();
  check('the zone fills with a player inside', live(deer).length === 2);
  const [a, b] = live(deer);
  const runner = a.id;
  actors.get(runner).pos = [9854, 0, 0];
  at(2000); // 7,854 from the deer: still streamed to the player
  reset();
  await poll();
  check('a deer 9,854 from its zone and 7,854 from the player is not destroyed', !destroyed.includes(runner) && live(deer).length === 2, destroyed.map((id) => id.toString(16)));
  check('...and nothing is logged as strayed', !lines.some((l) => /strayed/.test(l)), lines);
  now += 60000; await poll();
  check('...nor a minute later while the player stays', actors.has(runner));

  // ---- 2: out of everyone's sight it is removed, and its slot waits until nobody would see the new one appear ------
  at(-500); // 10,354 from the deer, 500 from the slot
  reset();
  await poll();
  check('once the player is 10,354 from it the stray is destroyed', destroyed.includes(runner), lines);
  check('...the log names it strayed', lines.some((l) => /strayed 9854 from its zone/.test(l)), lines);
  check('...its slot is held while the player is near the slot', deer.strayHeld.has(a.slot));
  now += 11000; await poll();
  check('...and not refilled after the 10 s refill hold', created.length === 0 && live(deer).length === 1, created.map((id) => id.toString(16)));
  now += 600000; await poll();
  check('...nor 10 minutes later with the player still in the zone', created.length === 0 && live(deer).length === 1);
  check('the deer that stayed is untouched', actors.has(b.id));

  // ---- 3: the hold ends once nobody is near the slot; the next visit fills the zone again ------------------------
  at(9000); // out of the zone (4,500 hysteresis) and 9,000 from the slot
  await poll();
  check('a player 9,000 from the slot releases the hold', !deer.strayHeld.has(a.slot));
  check('...without filling the empty zone', created.length === 0);
  at(0);
  now += 1000; await poll();
  check('coming back into the zone fills the slot again', created.length === 1 && live(deer).length === 2);

  // ---- 4: a player in another cell at the same coordinates does not see the stray -----------------------------
  const second = live(deer).find((e) => e.id !== b.id);
  const secondId = second.id;
  actors.get(secondId).pos = [9500, 0, 0];
  at(9000, CAVE);
  reset();
  await poll();
  check('a stray is destroyed when the only player near it is inside an interior', destroyed.includes(secondId), lines);
  check('...and its slot is not held for that player', !deer.strayHeld.has(second.slot));

  // ---- 5: a zone is not despawned while one of its deer is in view ---------------------------------------------
  const herd = zoneOf('wild:deer:3000', [100000, 0, 0], 1);
  sys.zones = [herd];
  at(100000);
  now += 20000; await poll();
  check('a second zone fills', live(herd).length === 1);
  const grazer = live(herd)[0].id;
  at(106000); // left the zone (beyond 4,500) but 6,000 from the deer
  reset();
  await poll();
  now += 130000; await poll();
  check('past its 120 s despawn, a zone whose deer is 6,000 from a player keeps it', actors.has(grazer) && live(herd).length === 1, lines);
  at(110000); // 10,000 from the deer
  now += 1000; await poll();
  check('...and despawns once nobody is within 8,192', !actors.has(grazer) && herd.spawned.length === 0, lines);

  // Dead deer do not keep a zone: only a live actor vanishing is seen
  at(100000);
  now += 20000; await poll();
  const fallen = live(herd)[0].id;
  actors.get(fallen).dead = true;
  await poll();
  at(106000);
  await poll();
  now += 130000; await poll();
  check('a zone holding only a corpse despawns on time with the player 6,000 away', herd.spawned.length === 0, lines);

  // ---- 6: an admin reset clears a hold ------------------------------------------------------------------------
  const reed = zoneOf('wild:deer:3100', [200000, 0, 0], 1);
  sys.zones = [reed];
  at(200000);
  now += 20000; await poll();
  const bolt = live(reed)[0].id;
  actors.get(bolt).pos = [210000, 0, 0];
  await poll();
  check('a third zone\'s stray, 10,000 from the player, is destroyed and held', !actors.has(bolt) && reed.strayHeld.size === 1);
  sys.resetZone('wild:deer:3100');
  check('an admin reset clears the hold', reed.strayHeld.size === 0);

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
