// Scripted test for server\greathunt.js (the Great Hunt, stage 1) with a mock gamemode api: renown from feeding on
// animals, people and players, kills and changes; the farming rules for players (only a victim this werewolf slew,
// outdoors and outside a city, once per victim account per day, never a partymate or its own account); rank-ups; the
// numbers each rank sets (beast time, feed time, changes a day, forced changes, damage); a cure resetting it; howls
// heard across the land once a minute; /hunt. Run it from this folder's parent with
//
//   node tests\greathunt-harness.js
'use strict';
const path = require('path');
const HUNT = path.resolve(__dirname, '..', 'greathunt.js');

let now = Date.UTC(2026, 8, 27, 12, 0);
Date.now = () => now;
const WOLF = 0xff000010, OTHER = 0xff000011, ALT = 0xff000012, PAL = 0xff000013, DEER = 0xff0000a0, BANDIT = 0xff0000a1, HUMAN = 0xff000014;
const W = 'a764b:BSHeartland.esm';
const props = new Map();
const get = (id, p) => props.get(id + '|' + p);
const set = (id, p, v) => props.set(id + '|' + p, v);
const profiles = { [WOLF]: 1, [OTHER]: 2, [ALT]: 1, [PAL]: 3, [HUMAN]: 4 };
const place = (id, world, pos) => { set(id, 'worldOrCellDesc', world); set(id, 'pos', pos); };
place(WOLF, W, [80000, 170000, 0]);
set(WOLF, 'private.beast', { form: 'werewolf' });
const party = { [WOLF]: 'lead1', [PAL]: 'lead1', [OTHER]: null };
globalThis.__dboSuperKind = (a) => (a === WOLF ? 'werewolf' : null);
globalThis.__dboPartyLeaderOf = (a) => party[a] || null;
const said = []; const audits = []; const packets = []; const commands = new Map();
const api = {
  mp: { get, set, getIdFromDesc: (d) => parseInt(String(d).split(':')[0], 16) + (/BSHeartland/.test(d) ? 0x2000000 : 0) },
  log: () => {}, personal: (a, t) => said.push({ a, t }), audit: (t) => audits.push(t), who: (a) => `P${a.toString(16)}`,
  sendPacket: (a, p) => packets.push({ a, p }), onlineActors: () => [WOLF, OTHER, PAL],
  profileOf: (a) => (profiles[a] === undefined ? -1 : profiles[a]),
  registerChatCommand: (n, fn) => commands.set(n, fn),
  zoneOfActor: () => 'bruma', zoneById: (z) => (z === 'bruma' ? { id: 'bruma', name: 'the County of Bruma' } : null),
  isWorldspace: (w) => w === W, cfg: {},
};
delete globalThis.__dboGreatHunt;
delete require.cache[HUNT];
const hunt = require(HUNT)(api);

let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail !== undefined ? '   ' + detail : ''}`); if (!ok) failures++; };
const renown = () => (get(WOLF, 'private.greatHunt') || {}).renown || 0;
const last = (a) => { const x = said.filter((s) => s.a === a); return (x[x.length - 1] || {}).t || ''; };

// Renown
check('a new werewolf is a Fledgling', hunt.rankOf(WOLF) === 0 && globalThis.__dboHuntBeastSeconds(WOLF) === 150);
globalThis.__dboHuntFed(WOLF, DEER, WOLF, false);
check('feeding on an animal: 5', renown() === 5);
globalThis.__dboHuntFed(WOLF, BANDIT, 0, true);
check('feeding on a humanoid: 10', renown() === 15);
globalThis.__dboHuntKill(WOLF, DEER);
check('a kill in beast form: 2', renown() === 17);
globalThis.__dboHuntKill(WOLF, OTHER);
check('killing a player earns nothing by itself', renown() === 17);
globalThis.__dboHuntChanged(WOLF);
check('a change: 2', renown() === 19);

// The farming rules for players
place(OTHER, W, [80000, 170000, 0]);
globalThis.__dboHuntFed(WOLF, OTHER, PAL, true);
check('a player someone else slew earns nothing', renown() === 19 && /did not bring them down/.test(last(WOLF)));
globalThis.__dboHuntFed(WOLF, ALT, WOLF, true);
check('its own account earns nothing', renown() === 19 && /not another person/.test(last(WOLF)));
globalThis.__dboHuntFed(WOLF, PAL, WOLF, true);
check('a partymate earns nothing', renown() === 19 && /ride with you/.test(last(WOLF)));
place(WOLF, W, [57592, 203000, 0]);
globalThis.__dboHuntFed(WOLF, OTHER, WOLF, true);
check('inside the walls of Bruma earns nothing', renown() === 19 && /inside walls/.test(last(WOLF)));
place(WOLF, '1234:BSHeartland.esm', [0, 0, 0]);
globalThis.__dboHuntFed(WOLF, OTHER, WOLF, true);
check('indoors earns nothing', renown() === 19);
place(WOLF, W, [80000, 170000, 0]);
globalThis.__dboHuntFed(WOLF, OTHER, WOLF, true);
check('a player this werewolf slew outdoors: 60', renown() === 79);
globalThis.__dboHuntFed(WOLF, OTHER, WOLF, true);
check('the same victim again the same day earns nothing', renown() === 79 && /too recently/.test(last(WOLF)));
now += 25 * 3600000;
globalThis.__dboHuntFed(WOLF, OTHER, WOLF, true);
check('a day later it counts again', renown() === 139);

// Ranks
check('100 renown makes a Prowler, and says so', hunt.rankOf(WOLF) === 1 && said.some((s) => s.a === WOLF && /You are a Prowler now/.test(s.t)) && packets.some((x) => x.p.customPacketType === 'dboBanner'));
check('the rise is audited', audits.some((t) => /^HUNT PW?ff000010 rose to Prowler/.test(t) || /rose to Prowler/.test(t)));
check('a Prowler: 180 s of beast form, 35 s a feed, 1 change a day, forced changes x0.85', globalThis.__dboHuntBeastSeconds(WOLF) === 180 && globalThis.__dboHuntFeedSeconds(WOLF) === 35 && globalThis.__dboHuntChangesPerDay(WOLF) === 1 && globalThis.__dboHuntForcedMult(WOLF) === 0.85);
check('in beast form a Prowler deals 5% more and takes 5% less', Math.abs(globalThis.__dboHuntDamageMult(WOLF, DEER) - 1.05) < 1e-9 && Math.abs(globalThis.__dboHuntDamageMult(DEER, WOLF) - 0.95) < 1e-9);
set(WOLF, 'private.beast', null);
check('out of beast form the rank changes nothing', globalThis.__dboHuntDamageMult(WOLF, DEER) === 1 && globalThis.__dboHuntDamageMult(DEER, WOLF) === 1);
set(WOLF, 'private.greatHunt', { renown: 1500, fedOn: {} });
check('an Elder: 300 s, 3 changes a day, forced changes a quarter as often', globalThis.__dboHuntBeastSeconds(WOLF) === 300 && globalThis.__dboHuntChangesPerDay(WOLF) === 3 && globalThis.__dboHuntForcedMult(WOLF) === 0.25);

// The curse ends
globalThis.__dboHuntReset(WOLF);
check('a cure starts the next werewolf as a Fledgling', hunt.rankOf(WOLF) === 0 && renown() === 0);

// Howls
said.length = 0;
globalThis.__dboHuntHowled(WOLF, 'Howl of Terror');
check('a howl is heard by everyone else online, with where', said.filter((s) => s.t === 'A howl echoes through the County of Bruma.').map((s) => s.a).sort().join() === [OTHER, PAL].sort().join());
globalThis.__dboHuntHowled(WOLF, 'Howl of Terror');
check('once a minute per howler', said.length === 2);
now += 61000;
globalThis.__dboHuntHowled(WOLF, 'Howl of Terror');
check('a minute later it carries again', said.length === 4);

// /hunt
said.length = 0;
commands.get('hunt')(OTHER);
check('/hunt is for werewolves', /for those who carry the beast/.test(last(OTHER)));
said.length = 0;
commands.get('hunt')(WOLF);
check('/hunt shows the rank, the renown and the next rank', /Fledgling of the Hunt, with 0 renown/.test(said[0].t) && /Prowler at 100 renown/.test(said[2].t), JSON.stringify(said.map((s) => s.t)));

console.log(failures ? `${failures} failure(s)` : 'all passed');
process.exit(failures ? 1 : 0);
