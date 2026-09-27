// Scripted test for server\raids.js with a mock gamemode api: closed unless raids.enabled, only a leader raids, never their own land, 5 defenders
// online, 3 days between raids on the same land, the defenders warned, a raider breaking into a home (3 things across
// its containers and 15% of their gold) or one of its containers, once each per raid, nobody else breaking in, homes on
// other land untouched, the owner told, a failed write putting things back, and the raid ending on time.
// Run it from this folder's parent with
//
//   node tests\raids-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const RAIDS = path.resolve(__dirname, '..', 'raids.js');
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'raids-harness-')));

let now = Date.UTC(2026, 8, 26, 20, 0);
Date.now = () => now;
const GOLD = 0xf, SWORD = 0x1397e, BREAD = 0x65c9f, STRIPS = 0x800e4, BOOK = 0x1b0e1;
const types = { [SWORD]: 'WEAP', [BREAD]: 'ALCH', [STRIPS]: 'MISC', [BOOK]: 'BOOK', [GOLD]: 'MISC' };
// A home in Applewatch (door 0x300, containers 0x310 and 0x311) and one in Greenwood (door 0x400, container 0x410)
const HOME = 0x300, C1 = 0x310, C2 = 0x311, HOME2 = 0x400, C3 = 0x410;
fs.writeFileSync('housing.json', JSON.stringify([HOME, HOME2]));
const recs = { [HOME]: { owner: 11, ownerName: 'Lydia', name: 'Lydia\'s house', partner: 0, containers: [C1, C2] }, [HOME2]: { owner: 12, ownerName: 'Brelyna', partner: 0, containers: [C3] } };
const props = new Map();
const get = (id, p) => props.get(id + '|' + p);
const set = (id, p, v) => props.set(id + '|' + p, v);
const reset = () => {
  set(C1, 'inventory', { entries: [{ baseId: GOLD, count: 1000 }, { baseId: SWORD, count: 1 }, { baseId: BREAD, count: 3 }] });
  set(C2, 'inventory', { entries: [{ baseId: GOLD, count: 200 }, { baseId: STRIPS, count: 5 }, { baseId: BOOK, count: 1 }] });
  set(C3, 'inventory', { entries: [{ baseId: GOLD, count: 100 }, { baseId: SWORD, count: 1 }] });
  set(RAIDER, 'inventory', { entries: [] });
};
set(HOME, 'worldOrCellDesc', 'tamriel'); set(HOME, 'pos', [1, 1, 0]); set(HOME2, 'worldOrCellDesc', 'tamriel'); set(HOME2, 'pos', [9, 9, 0]);
const LEADER = 100, RAIDER = 101, PEASANT = 50;
reset();
const count = (a, id) => ((get(a, 'inventory') || {}).entries || []).filter((e) => e.baseId === id).reduce((s, e) => s + e.count, 0);

let bruma = [1, 2, 3, 4, 5, 11];
let online = [...bruma, LEADER, RAIDER, PEASANT];
globalThis.__dboHousing = { primaryOf: (r) => (recs[r] ? r : 0), recordOf: (r) => recs[r] || null };
globalThis.__dboRealmTerritoryAt = (w, p) => (p[0] < 5 ? { id: 'applewatch', name: 'Applewatch' } : { id: 'greenwood', name: 'Greenwood' });
globalThis.__dboRealmOwnerOf = (t) => (t === 'applewatch' ? 'county-bruma' : t === 'greenwood' ? 'county-bruma' : null);
globalThis.__dboRealmLeads = (a, f) => a === LEADER && f === 'fighters-guild';
globalThis.__dboRealmMemberOf = (a, f) => (f === 'fighters-guild' ? a === LEADER || a === RAIDER : f === 'county-bruma' ? bruma.includes(a) : false);
globalThis.__dboGuildInfo = (f) => ({ 'county-bruma': { name: 'County of Bruma' }, 'fighters-guild': { name: 'Fighters Guild' } }[f] || null);
globalThis.__dboFactionNonceOk = () => true;
const replies = []; globalThis.__dboFactionRefresh = (a, text, ok) => { replies.push({ a, text, ok }); return true; };
let failWriteFor = 0;
const out = { personal: [], system: [], audits: [] };
const handlers = new Map(); const timers = new Map();
const api = {
  mp: { get, set: (id, p, v) => { if (id === failWriteFor && p === 'inventory') throw new Error('write failed'); set(id, p, v); }, getDescFromId: (id) => id.toString(16) + ':Skyrim.esm', getActorsByProfileId: (pid) => (pid === 11 ? [11] : []) },
  log: () => {}, personal: (a, t) => out.personal.push({ a, t }), system: (a, t) => out.system.push({ a, t }), audit: (t) => out.audits.push(t),
  who: (a) => `P${a}`, display: (a) => `P${a}`, cfg: { raids: { enabled: true } }, onUi: (e, f) => handlers.set(e, f), onlineActors: () => online.slice(), every: (n, ms, f) => timers.set(n, f),
  recordOf: (id) => (types[id] ? { record: { type: types[id], editorId: 'Item' } } : null), adminItemName: () => '', sendPacket: () => true,
};

let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail !== undefined ? '   ' + detail : ''}`); if (!ok) failures++; };
const startRaid = (a, t) => { replies.length = 0; handlers.get('raidStart')(a, ['n', 'fighters-guild', t]); return replies[0] || {}; };

api.cfg = {};
delete require.cache[RAIDS];
require(RAIDS)(api);
check('raids are closed while raids.enabled is off (the default)', /closed during the alpha/.test(startRaid(LEADER, 'applewatch').text) && globalThis.__dboRaidView().rules.enabled === false);
api.cfg = { raids: { enabled: true } };
delete require.cache[RAIDS];
const raids = require(RAIDS)(api);
check('only the leader starts a raid', !startRaid(RAIDER, 'applewatch').ok);
bruma = [1, 2, 3, 4];
check('5 defenders must be online', /needs 5 of County of Bruma online/.test(startRaid(LEADER, 'applewatch').text));
bruma = [1, 2, 3, 4, 5, 11];
check('a raid on land the defender holds starts', startRaid(LEADER, 'applewatch').ok);
check('the defenders are warned', out.personal.filter((x) => bruma.includes(x.a) && /Raiders of Fighters Guild/.test(x.t)).length === bruma.length);
check('one raid at a time per raider', /already raiding/.test(startRaid(LEADER, 'greenwood').text));

// A failed write to the raider puts the container back (and uses up that container's break-in)
failWriteFor = RAIDER;
check('a failed write still ends the activation', globalThis.__dboRaidActivate(C2, RAIDER) === true);
check('and puts the container back', count(C2, GOLD) === 200 && count(C2, STRIPS) === 5 && count(RAIDER, GOLD) === 0);
failWriteFor = 0;

// Break-ins
check('a stranger cannot break in (not a raider)', globalThis.__dboRaidActivate(HOME, PEASANT) === false);
check('a home on other land is untouched', globalThis.__dboRaidActivate(HOME2, RAIDER) === false && count(C3, GOLD) === 100);
check('a raider breaks into the home', globalThis.__dboRaidActivate(HOME, RAIDER) === true);
check('15% of the gold in its containers not yet broken into', count(RAIDER, GOLD) === 150 && count(C1, GOLD) === 850 && count(C2, GOLD) === 200, count(RAIDER, GOLD));
const took = [SWORD, BREAD].filter((id) => count(RAIDER, id) === 1).length;
check('up to 3 things from them, one of each (C1 has 2 kinds)', took === 2);
check('the owner, online, is told', out.system.some((x) => x.a === 11 && /broken into Lydia's house/.test(x.t)));
check('the break-in is audited', out.audits.some((t) => /^RAID break-in by P101/.test(t)));
check('once per home per raid', globalThis.__dboRaidActivate(HOME, RAIDER) === true && count(RAIDER, GOLD) === 150 && /already broken in/.test(out.personal[out.personal.length - 1].t));
check('a container of a home already broken into gives nothing more', globalThis.__dboRaidActivate(C1, RAIDER) === true && count(RAIDER, GOLD) === 150);


// The raid ends; the land rests for 3 days
now += 31 * 60000; timers.get('raids')();
check('the raid ends on time', raids.active().length === 0 && out.personal.some((x) => x.a === LEADER && /raid on applewatch is over/.test(x.t)));
check('after it no break-ins', globalThis.__dboRaidActivate(C3, RAIDER) === false);
check('the same land rests 3 days', /raided too recently/.test(startRaid(LEADER, 'applewatch').text));
now += 3 * 86400000;
check('then it can be raided again', startRaid(LEADER, 'applewatch').ok);
check('never your own land', (globalThis.__dboRealmOwnerOf = (t) => 'fighters-guild') && /your own/.test(startRaid(LEADER, 'greenwood').text));

console.log(failures ? `${failures} failure(s)` : 'all passed');
process.exit(failures ? 1 : 0);
