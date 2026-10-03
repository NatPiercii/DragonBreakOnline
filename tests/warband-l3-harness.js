// Scripted test for the warband lane L3 (Nate's list N4, 3 Oct): warband.js ownership, sides, factions, bodies and raid
// ownership, and npcdirector.js keeping an unleashed raider off its own GM. No server and no game:
//   node tests/warband-l3-harness.js   (from server/)
// warband.js and factions.js run in a scratch folder against a mock mp and a mock companion system.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MODULE = path.join(ROOT, 'warband.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-warband-l3-'));
const home = process.cwd();
process.chdir(dir);
fs.copyFileSync(path.join(ROOT, 'factions.js'), path.join(dir, 'factions.js'));
fs.writeFileSync('admin-placeables.json', JSON.stringify({ categories: [{ id: 'npc', kind: 'npc', items: [
  ['1e7e2:Skyrim.esm', 'Bandit'], ['600:Skyrim.esm', 'Farmer'],
] }] }));

let now = 1790000000000;
const realNow = Date.now;
Date.now = () => now;

const BANDIT = 0x1e7e2, FARMER = 0x600, BANDIT_FACTION = 0x1bcc0, CRIME = 0x28713;
const u8 = (bytes) => new Uint8Array(bytes);
const acbs = (tflags) => { const b = new Uint8Array(24); new DataView(b.buffer).setUint16(18, tflags, true); return b; };
const snam = (id, rank) => { const b = new Uint8Array(8); new DataView(b.buffer).setUint32(0, id, true); b[4] = rank; return b; };
const crif = (id) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, id, true); return b; };
const NPC = (fields) => ({ record: { type: 'NPC_', editorId: 'x', fields: fields.map(([type, data]) => ({ type, data })) }, toGlobalRecordId: (x) => x });
const records = {
  [BANDIT]: NPC([['ACBS', acbs(0)], ['AIDT', u8([1, 2, 50])], ['SNAM', snam(BANDIT_FACTION, 0)], ['CRIF', crif(CRIME)]]),
  [FARMER]: NPC([['ACBS', acbs(0)], ['AIDT', u8([0])]]),
};

// Actors: two GMs (profiles 10 and 20), a second character of GM1's profile, a player who is not staff, a wolf
const GM1 = 0xff000a01, GM1ALT = 0xff000a02, GM2 = 0xff000a03, PLAYER = 0xff000a04, WOLF = 0xff000a05;
const state = new Map();
const actor = (id, o) => state.set(id, Object.assign({ pos: [0, 0, 0], angle: [0, 0, 0], worldOrCellDesc: 'a764b:BSHeartland.esm', isDead: false }, o));
actor(GM1, { profileId: 10 }); actor(GM1ALT, { profileId: 10, pos: [9000, 0, 0] }); actor(GM2, { profileId: 20, pos: [600, 0, 0] });
actor(PLAYER, { profileId: 30, pos: [300, 0, 0] }); actor(WOLF, { profileId: -1 });
const ADMINS = new Set([GM1, GM1ALT, GM2]);
const destroyed = new Set();
const factionsOf = new Map();
const mp = {
  get: (id, k) => { if (destroyed.has(id) || !state.has(id)) throw new Error('gone'); const v = state.get(id)[k]; return v === undefined && k === 'profileId' ? -1 : v; },
  set: (id, k, v) => { if (!state.has(id)) throw new Error('gone'); if (k === 'ff_factions') factionsOf.set(id, v); state.get(id)[k] = v; },
  getIdFromDesc: (d) => parseInt(d, 16),
  destroyActor: (id) => { if (destroyed.has(id)) throw new Error('gone'); destroyed.add(id); },
  lookupEspmRecordById: (id) => records[id] || null,
};

let next = 0xff000100;
const companions = new Map();
globalThis.__dboWarband = undefined;
globalThis.__dboCompanions = {
  spawn: (owner, baseId, opts) => {
    const id = next++;
    const p = state.get(owner).pos;
    companions.set(id, { id, ownerId: owner, baseId, kind: opts.kind, targetId: 0 });
    actor(id, { profileId: -1, pos: [p[0] + 10, p[1], p[2]], 'private.dboCompanion': 'companion', ff_companionOf: owner });
    return id;
  },
  list: (owner) => [...companions.values()].filter((c) => c.ownerId === owner && !c.released),
  follow: (id) => { companions.get(id).targetId = 0; return true; },
  stay: (id) => { companions.get(id).targetId = 0; return true; },
  attack: (id, t) => { companions.get(id).targetId = t; return true; },
  dismiss: (id) => { companions.delete(id); state.get(id).ff_companionOf = 0; destroyed.add(id); return true; },
  release: (id, hostile) => { const c = companions.get(id); c.released = true; c.hostile = hostile; state.get(id).ff_companionOf = 0; state.get(id).ff_hostile = hostile; return true; },
};
const said = [], logs = [], audits = [], commands = {}, timers = {};
const who = (a) => ({ [GM1]: 'GM One', [GM1ALT]: 'GM One alt', [GM2]: 'GM Two', [PLAYER]: 'Player' })[a] || `#${a.toString(16)}`;
require(MODULE)({
  mp, log: (...x) => logs.push(x.join(' ')), personal: (a, t) => said.push([a, t]), audit: (t) => audits.push(t), who, isAdmin: (a) => ADMINS.has(a),
  registerChatCommand: (n, fn) => { commands[n] = fn; }, findByName: () => 0, cfg: { warband: { bodySeconds: 300 } }, onUi: () => {},
  every: (name, ms, fn) => { timers[name] = fn; }, profileOf: (a) => { try { return Number(mp.get(a, 'profileId')); } catch (e) { return -1; } },
});

let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };
const run = (a, args, cmd) => { said.length = 0; commands[cmd || 'warband'](a, args); return said.map((x) => x[1]).join(' | '); };
const refuses = (agg, tgt) => globalThis.__dboWarbandRefusesHit(agg, tgt);
const bandOf = (gm) => [...companions.values()].filter((c) => c.ownerId === gm && !c.released).map((c) => c.id);
const FRIENDLY = JSON.stringify({ f: [[0xdb1, 0]], c: 0 });

try {
  // ---- ownership: an NPC never harms its GM; two friendly GMs' NPCs never harm each other -------------------------------
  run(GM1, 'raise bandit 3');
  run(GM2, 'raise bandit 2');
  const [a1, a2, a3] = bandOf(GM1), [b1, b2] = bandOf(GM2);
  check('raise: three for GM One, two for GM Two', bandOf(GM1).length === 3 && bandOf(GM2).length === 2);
  check('a follower of a GM on no side is of the player faction on every screen (ff_factions)', [a1, a2, a3, b1, b2].every((id) => JSON.stringify(factionsOf.get(id)) === FRIENDLY), [...factionsOf]);
  check('a follower never harms its own GM', refuses(a1, GM1) === true);
  check('...nor another character of the same GM (by profile)', refuses(a1, GM1ALT) === true);
  check('a follower still harms a player', refuses(a1, PLAYER) === false);
  check('two GMs on no side: their NPCs never harm each other, both ways', refuses(a1, b1) === true && refuses(b2, a3) === true);
  check('a GM\'s swing at a friendly GM\'s follower lands nothing (no brawl between bands)', refuses(GM1, b1) === true);
  check('a GM striking their own follower is left to companionSystem', refuses(GM2, b1) === false);
  check('a player who is not staff can still hit a GM\'s follower', refuses(PLAYER, b1) === false);
  check('a follower spares a friendly GM too (the friendly GM\'s swings at it are refused, so its blows are)', refuses(a1, GM2) === true && refuses(b1, GM1ALT) === true);
  check('hits that touch no warband NPC are never refused', refuses(WOLF, PLAYER) === false && refuses(PLAYER, WOLF) === false && refuses(GM1, PLAYER) === false);
  check('a self hit is never refused', refuses(a1, a1) === false);
  check('a refusal is logged once a minute per pair', logs.filter((l) => /refused a hit/.test(l)).length === 7 && (refuses(a1, GM1), logs.filter((l) => /refused a hit/.test(l)).length === 7), logs);
  // A follower raised before this code loaded: no record here, its own tags name its GM
  const OLD = 0xff000900;
  actor(OLD, { profileId: -1, 'private.dboCompanion': 'companion', ff_companionOf: GM2 });
  check('a follower raised before a reload is known by its tags', refuses(OLD, GM2) === true && refuses(OLD, a1) === true);
  const SUMMON = 0xff000901;
  actor(SUMMON, { profileId: -1, 'private.dboCompanion': 'summon', ff_companionOf: PLAYER });
  check('a player\'s summon is not a warband NPC', refuses(SUMMON, GM1) === false && refuses(a1, SUMMON) === false);

  // ---- sides: a staged battle needs two GMs on two sides --------------------------------------------------------------
  let r = run(GM1, 'side');
  check('/warband side says that defending against a raid with a band needs two sides', /on no side/.test(r) && /defending against another GM's raid with your own band, needs two GMs on two sides/.test(r), r);
  r = run(GM1, 'side Legion');
  check('a GM picks a side', /fights for Legion/.test(r) && /No other GM is on another side yet/.test(r), r);
  check('one side alone changes nothing: the other GM is on none', refuses(a1, b1) === true);
  r = run(GM2, 'side Stormcloaks');
  check('the second GM is told the enemy side', /Enemy sides: Legion/.test(r), r);
  check('two sides: their NPCs harm each other', refuses(a1, b1) === false && refuses(b1, a1) === false);
  check('...and a GM may strike the other side\'s follower', refuses(GM1, b1) === false);
  check('...but an NPC still never harms its own GM', refuses(a1, GM1) === true && refuses(b1, GM2) === true);
  check('...and a follower harms a GM of the enemy side', refuses(a1, GM2) === false && refuses(b1, GM1) === false);
  run(GM2, 'side legion');
  check('the same side, whatever the case, is friends again', refuses(a1, b1) === true);
  run(GM2, 'side Stormcloaks');
  const before = factionsOf.size;
  run(GM1, 'raise bandit 1');
  const a4 = bandOf(GM1).find((id) => ![a1, a2, a3].includes(id));
  check('a follower raised on a side keeps its own factions (no ff_factions)', factionsOf.size === before && !factionsOf.has(a4));
  check('the side is named in the staff log', audits.some((t) => /raised 1 x Bandit \(1e7e2:Skyrim.esm\) for Legion/.test(t)), audits.slice(-3));

  // ---- charge: idle followers go for the nearest NPC of an enemy side -------------------------------------------------
  run(GM2, 'side none');
  r = run(GM2, 'charge');
  check('a GM on no side cannot charge', /A charge needs a side/.test(r), r);
  run(GM2, 'side Stormcloaks');
  state.get(b1).pos = [600, 0, 0]; state.get(b2).pos = [5000, 0, 0];
  state.get(OLD).pos = [99999, 0, 0];   // GM Two's follower from before the reload counts too; out of range here
  r = run(GM1, 'charge');
  const targets = bandOf(GM1).map((id) => companions.get(id).targetId);
  check('every idle follower goes for the nearest enemy NPC in range', targets.every((t) => t === b1), targets.map((t) => t.toString(16)));
  check('the GM is told', /4 of your warband charge the enemy/.test(r), r);
  companions.get(a1).targetId = 0; state.get(b1).isDead = true;
  timers.warbandCharge();
  check('the charge goes on: a follower that is free again picks the next enemy (dead ones and those out of range are skipped)', companions.get(a1).targetId === 0, companions.get(a1).targetId);
  state.get(b2).pos = [700, 0, 0];
  timers.warbandCharge();
  check('...and finds one as soon as it comes near', companions.get(a1).targetId === b2, companions.get(a1).targetId);
  run(GM1, 'follow');
  companions.get(a1).targetId = 0;
  timers.warbandCharge();
  check('follow calls the charge off', companions.get(a1).targetId === 0);
  state.get(b1).isDead = false;

  // ---- unleash and settle: factions, never their GM, and who drives a raider --------------------------------------------
  run(GM1, 'side none');
  r = run(GM1, 'unleash');
  check('unleash releases the band', /warband of 4 is unleashed/.test(r) && /never to you/.test(r), r);
  check('a raider gets its record\'s own factions back on every screen (factions.js)', [a1, a2, a3, a4].every((id) => JSON.stringify(factionsOf.get(id)) === JSON.stringify({ f: [[BANDIT_FACTION, 0]], c: CRIME })), [a1, a4].map((id) => factionsOf.get(id)));
  check('a raider never harms its GM, after the release too', refuses(a1, GM1) === true && refuses(a2, GM1ALT) === true);
  check('...but harms the players it was unleashed on', refuses(a1, PLAYER) === false);
  check('a raider is driven by anyone but its GM (npcdirector asks)', globalThis.__dboWarbandAvoidHost(a1) === GM1);
  check('another GM may strike a released raider (raids are fought by GMs as players too)', refuses(GM2, a1) === false);
  check('...and a raider\'s blows land on that defending GM (only its own GM is spared)', refuses(a1, GM2) === false);
  run(GM2, 'side none');
  r = run(GM2, 'settle');
  check('settle keeps the band where it stands', /Your warband of 2 stays here/.test(r), r);
  check('a garrison is of the player faction on every screen', JSON.stringify(factionsOf.get(b1)) === FRIENDLY && JSON.stringify(factionsOf.get(b2)) === FRIENDLY);
  check('a garrison never harms its GM', refuses(b1, GM2) === true);
  check('a garrison is driven by whoever is near, its GM included', globalThis.__dboWarbandAvoidHost(b1) === 0);
  check('GM One\'s raiders and GM Two\'s garrison, both on no side, never harm each other', refuses(a1, b1) === true);

  // ---- /raid: each GM sees and clears their own; the dead are removed after bodySeconds ----------------------------------
  r = run(GM2, '', 'raid');
  check('/raid shows the GM\'s own, and how many others have', /0 raider\(s\) and 2 settled NPC\(s\) still stand/.test(r) && /Other GMs have 4 more/.test(r), r);
  r = run(GM2, 'all', 'raid');
  check('/raid all lists every GM', /GM One: 4 raider\(s\), 0 settled, 0 dead/.test(r) && /GM Two: 0 raider\(s\), 2 settled/.test(r), r);
  state.get(a1).isDead = true; state.get(a2).isDead = true;
  timers.warband();
  now += 299 * 1000;
  timers.warband();
  check('a body stays bodySeconds after it fell (so it can be searched)', !destroyed.has(a1) && !destroyed.has(a2));
  r = run(GM1, '', 'raid');
  check('/raid counts the dead', /2 raider\(s\) and 0 settled NPC\(s\) still stand, 2 lie dead \(removed 5 min after they fell\)/.test(r), r);
  now += 1000;
  timers.warband();
  check('...and is removed then', destroyed.has(a1) && destroyed.has(a2) && !destroyed.has(a3) && !destroyed.has(b1));
  check('one log line for the removal', logs.some((l) => /removed 2 body\(ies\)/.test(l)));
  check('a removed body leaves the records', !globalThis.__dboWarband.released.some((x) => x.id === a1) && globalThis.__dboWarband.owners.get(a1) === undefined);
  state.get(a3).isDead = true;
  now += 60 * 1000; timers.warband();
  now += 299 * 1000; timers.warband();
  check('the clock runs from the death, not from the release', !destroyed.has(a3));
  destroyed.add(a4);
  timers.warband();
  check('a form that is gone leaves the records without a removal', !globalThis.__dboWarband.released.some((x) => x.id === a4));
  r = run(GM2, 'clear', 'raid');
  check('/raid clear removes only the GM\'s own', /Removed 2\./.test(r) && destroyed.has(b1) && destroyed.has(b2) && !destroyed.has(a3), r);
  r = run(GM2, 'clear all', 'raid');
  check('/raid clear all removes every GM\'s, the dead included', /Removed 1 \(every GM's\)/.test(r) && destroyed.has(a3), r);
  // A released entry from before this code (no profile): matched by the GM's name
  globalThis.__dboWarband.released.push({ id: 0xff000902, name: 'x', by: 'GM One', at: now, hostile: true });
  actor(0xff000902, { profileId: -1 });
  r = run(GM1, 'clear', 'raid');
  check('an entry from before the reload is the GM\'s by name', /Removed 1\./.test(r), r);

  // ---- followers that end leave the records -----------------------------------------------------------------------------
  run(GM1, 'raise farmer 1');
  const f1 = bandOf(GM1)[0];
  run(GM1, 'dismiss');
  check('a dismissed follower leaves the records', globalThis.__dboWarband.owners.get(f1) === undefined);
  run(GM1, 'raise farmer 1');
  const f2 = bandOf(GM1)[0];
  state.get(f2).ff_companionOf = 0;   // ended in companionSystem (died, or its GM left)
  timers.warband();
  check('a follower that ended without a release leaves the records at the next pass', globalThis.__dboWarband.owners.get(f2) === undefined);
} finally {
  process.chdir(home);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- npcdirector.js: an unleashed raider is given to a player near it, never to its GM while anyone else is near ------
{
  const RAIDER = 0xff000200, GARRISON = 0xff000201, WOLF2 = 0xff000202, G = 0x14, P = 0x15;
  const npcs = { [RAIDER]: { 'private.dboCompanion': 'companion', ff_companionOf: 0 }, [GARRISON]: { 'private.dboCompanion': 'companion', ff_companionOf: 0 }, [WOLF2]: {} };
  const hosters = new Map([[RAIDER, G], [GARRISON, G]]);
  const pos = { [G]: [0, 0, 0], [P]: [600, 0, 0], [RAIDER]: [50, 0, 0], [GARRISON]: [50, 0, 0], [WOLF2]: [50, 0, 0] };
  globalThis.__dboHostPolicy = (p, npc) => { const a = pos[p], b = pos[npc]; return a && b ? { ok: true, dist: Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) } : { ok: false }; };
  globalThis.__dboHostCooldown = undefined;
  globalThis.__dboFormExists = undefined;
  globalThis.__dboWarbandAvoidHost = (npc) => (npc === RAIDER ? G : 0);
  const dirMod = path.join(ROOT, 'npcdirector.js');
  delete require.cache[dirMod]; globalThis.__dboNpcDirector = undefined;
  let tick = null; const ui = {};
  require(dirMod)({ mp: { get: (id, k) => (npcs[id] ? npcs[id][k] : undefined), getHoster: (id) => hosters.get(id) || 0, setHoster: (id, h) => hosters.set(id, h) },
    log: () => {}, every: (n, ms, fn) => { tick = fn; }, onUi: (e, fn) => { ui[e] = fn; }, onlineActors: () => [G, P], display: (a) => a.toString(16),
    profileOf: (a) => ([G, P].includes(a) ? 1 : -1), cfg: { npcDirector: { mode: 'on' } } });
  const sight = (p, list) => ui.npcSight(p, [list.map(([id, d]) => [id.toString(16), d])]);
  sight(G, [[RAIDER, 50], [GARRISON, 50], [WOLF2, 50]]);
  tick();
  check('director: while its GM is the only one near, the GM keeps a raider it drives', hosters.get(RAIDER) === G);
  check('director: the GM is refused when asking to drive it anew (it reported it)', globalThis.__dboNpcDirectorRefuses(G, RAIDER) === true);
  now += 4000;
  sight(G, [[RAIDER, 50], [GARRISON, 50], [WOLF2, 50]]); sight(P, [[RAIDER, 550], [GARRISON, 550], [WOLF2, 550]]);
  tick();
  check('director: a player near it takes the raider from its GM, though the GM is nearer', hosters.get(RAIDER) === P, [...hosters]);
  check('director: a settled garrison is left with whoever drives it, as before', hosters.get(GARRISON) === G);
  check('director: ordinary NPCs still go to the nearest player', hosters.get(WOLF2) === G);
  check('director: a garrison is not refused to its GM (not managed)', globalThis.__dboNpcDirectorRefuses(G, GARRISON) === false);
  delete globalThis.__dboHostPolicy; delete globalThis.__dboNpcDirector; delete globalThis.__dboNpcDirectorRefuses;
}

// ---- gamemode.js wiring -------------------------------------------------------------------------------------------------
{
  const gm = fs.readFileSync(path.join(ROOT, 'gamemode.js'), 'utf8');
  check('gamemode.js hands warband.js every and profileOf', /require\(WARBAND_JS\)\(\{[^}]*every, profileOf/.test(gm));
  const hook = gm.slice(gm.indexOf('const hitDamageAttemptHook'), gm.indexOf('hitDamageAttemptHook.__dbo = true'));
  const ask = hook.indexOf('__dboWarbandRefusesHit('), prev = hook.indexOf('const prev = globalThis.__dboPrevHitDamageAttempt');
  check('the hit hook asks warband.js before companionSystem\'s hook, for any damage', ask > 0 && prev > ask && !/dmg > 0 && agg !== tgt && typeof globalThis.__dboWarbandRefusesHit/.test(hook));
}

delete globalThis.__dboCompanions; delete globalThis.__dboWarband; delete globalThis.__dboWarbandRefusesHit; delete globalThis.__dboWarbandAvoidHost;
Date.now = realNow;
console.log('');
console.log(failures ? `${failures} FAILURES` : 'all checks passed');
process.exit(failures ? 1 : 0);
