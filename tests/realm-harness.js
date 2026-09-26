// Scripted test for server\realm.js with a mock gamemode api: territories and owners, the declaration rules (leader or
// ruler, 10 online on each side, 10,000 gold from the treasury, the land must be the defender's, one offensive war, two
// weeks before the same war again), the week's notice and three evening windows, capture only inside a window and only
// with no defender at the marker, the capital falling (officials lose their ranks, the winner's leader may appoint),
// peace with tribute, surrender, the war to the death (only if accepted, only in a window, only on contested land), and a
// hot reload. Run it from this folder's parent with
//
//   node tests\realm-harness.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER = path.resolve(__dirname, '..');
const REALM = path.join(SERVER, 'realm.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'realm-harness-'));
fs.copyFileSync(path.join(SERVER, 'territories.json'), path.join(tmp, 'territories.json'));
process.chdir(tmp);

let now = Date.UTC(2026, 8, 26, 12, 0); // Saturday 26 September 2026, noon UTC
Date.now = () => now;
const DAY = 86400000;

// Two factions: the County of Bruma (hold) and the Fighters Guild, 10 members each online, plus leaders
const COUNT = 1, GM = 100;
const bruma = Array.from({ length: 10 }, (_, i) => COUNT + i);      // 1..10, 1 is the Count
const fighters = Array.from({ length: 10 }, (_, i) => GM + i);      // 100..109, 100 leads
let online = [...bruma, ...fighters];
const pos = new Map(); const world = new Map(); const dead = new Set();
for (const a of online) { pos.set(a, [0, 0, 0]); world.set(a, 'a764b:BSHeartland.esm'); }
const ranks = new Map([[COUNT, [{ zone: { id: 'bruma' }, rank: 'count' }]]]);
for (const a of bruma.slice(1)) ranks.set(a, [{ zone: { id: 'bruma' }, rank: 'guard' }]);
globalThis.__dboGuildInfo = (id) => ({ 'county-bruma': { id, name: 'County of Bruma', kind: 'hold', zone: 'bruma' }, 'fighters-guild': { id, name: 'Fighters Guild', kind: 'guild', zone: '' } }[id] || null);
globalThis.__dboGuildsOf = (a) => (fighters.includes(a) ? [{ id: 'fighters-guild', role: a === GM ? 'leader' : 'member' }] : []);
globalThis.__dboHoldFactionOf = (z) => (z === 'bruma' ? 'county-bruma' : null);
const treasury = { 'county-bruma': 10000, 'fighters-guild': 25000 };
globalThis.__dboTreasury = {
  balance: (f) => treasury[f] || 0,
  spend: (f, n) => { if ((treasury[f] || 0) < n) return false; treasury[f] -= n; return true; },
  deposit: (f, n) => { treasury[f] = (treasury[f] || 0) + n; return true; },
};
let officials = { bruma: { count: [1], guard: [2, 3] } };
const killed = []; const permaDead = new Set(); let permaFails = false;
globalThis.__dboPermaKill = (a, why) => { killed.push({ a, why }); if (!permaFails) permaDead.add(a); };

const out = { personal: [], system: [], audits: [] };
const handlers = new Map(); const timers = new Map();
const api = {
  mp: {
    get: (a, p) => (p === 'pos' ? pos.get(a) : p === 'worldOrCellDesc' ? world.get(a) : p === 'isDead' ? dead.has(a) : p === 'private.permaDead' ? permaDead.has(a) : undefined),
    getIdFromDesc: (d) => ({ 'a764b:BSHeartland.esm': 0x20a764b }[d] || 0x1),
  },
  log: () => {}, personal: (a, t) => out.personal.push({ a, t }), system: (a, t) => out.system.push({ a, t }), audit: (t) => out.audits.push(t),
  who: (a) => `P${a}`, display: (a) => `P${a}`, cfg: {}, onUi: (ev, fn) => handlers.set(ev, fn), registerChatCommand: (n, fn) => handlers.set('/' + n, fn),
  isAdmin: () => false, onlineActors: () => online.slice(), every: (n, ms, fn) => timers.set(n, fn), sendPacket: () => true,
  ranksOf: (pid) => ranks.get(pid) || [], profileOf: (a) => a, zoneById: (id) => (id === 'bruma' ? { id: 'bruma', name: 'Bruma', officials: ['count', 'steward', 'guard'] } : null),
  readOfficials: () => JSON.parse(JSON.stringify(officials)), writeOfficials: (o) => { officials = JSON.parse(JSON.stringify(o)); },
};
let realm;
const load = () => { handlers.clear(); delete require.cache[REALM]; realm = require(REALM)(api); };
load();

let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail !== undefined ? '   ' + detail : ''}`); if (!ok) failures++; };
const T = JSON.parse(fs.readFileSync('territories.json', 'utf8')).territories;
const marker = (id) => T.find((t) => t.id === id).marker.pos;
const standAt = (list, id) => { for (const a of list) pos.set(a, marker(id).slice()); };
const tickFor = (seconds) => { for (let s = 0; s < seconds; s += 2) { now += 2000; timers.get('realm')(); } };

// Territories start with the hold
check('every territory starts with the County of Bruma', T.every((t) => realm.ownerOf(t.id) === 'county-bruma'), T.length + ' territories');
check('a point belongs to the nearest marker', realm.territoryAt('a764b:BSHeartland.esm', [36000, 210000, 0]).id === 'applewatch');

// Declaration rules
const decl = (a, goal, opts = {}) => realm.declare(a, opts.attacker || 'fighters-guild', opts.defender || 'county-bruma', goal, opts.picks || [], !!opts.death);
check('only a leader declares', /Only a faction's leader/.test(decl(GM + 1, ['applewatch']).text));
check('the land must be the defender\'s', /does not hold/.test(decl(GM, ['nowhere']).text) || /does not hold/.test(realm.declare(GM, 'fighters-guild', 'county-bruma', ['nowhere'], [], false).text));
online = online.filter((a) => a !== 109);
check('10 of the declarer online', /10 of Fighters Guild must be online/.test(decl(GM, ['applewatch']).text));
online.push(109); online = online.filter((a) => a !== 10);
check('10 of the defender online', /10 of County of Bruma must be online to receive/.test(decl(GM, ['applewatch']).text));
online.push(10);
treasury['fighters-guild'] = 9999;
check('the 10,000 gold fee', /costs 10000 gold/.test(decl(GM, ['applewatch']).text));
treasury['fighters-guild'] = 25000;
let r = decl(GM, ['applewatch', 'bruma'], { death: true });
check('a valid declaration', r.ok, r.text);
check('the fee is paid from the treasury', treasury['fighters-guild'] === 15000);
const w = r.war;
check('a week of notice before the first window', w.startsAt >= now + 7 * DAY && w.startsAt < now + 8 * DAY, new Date(w.startsAt).toISOString());
check('three evening windows of two hours, on separate evenings', w.windows.length === 3 && w.windows.every((x) => x.end - x.start === 2 * 3600000 && new Date(x.start).getUTCHours() === 0) && new Set(w.windows.map((x) => new Date(x.start).getUTCDate())).size === 3);
check('it is announced to everyone', out.system.filter((x) => /declares war/.test(x.t)).length === online.length);
check('one offensive war at a time', /already fights a war it declared/.test(decl(GM, ['greenwood']).text));
check('the defending leader is asked about a war to the death', out.personal.some((x) => x.a === COUNT && /to the death/.test(x.t)));
check('only the defending leader answers it', !realm.answerDeath(GM, w.id, true).ok && realm.answerDeath(COUNT, w.id, true).ok && w.death === 'accepted');

// No capture before a window
standAt(fighters, 'applewatch');
tickFor(400);
check('no capture during the notice', realm.ownerOf('applewatch') === 'county-bruma' && w.status === 'notice');

// First window: capture
now = w.windows[0].start - 1000; timers.get('realm')(); now += 2000; timers.get('realm')();
check('the war becomes active when the first window opens', w.status === 'active');
standAt(bruma, 'pale-pass'); // defenders elsewhere
standAt([COUNT + 1], 'applewatch');
tickFor(400);
check('no capture while a defender stands at the marker', realm.ownerOf('applewatch') === 'county-bruma');
standAt([COUNT + 1], 'pale-pass');
tickFor(290);
check('not yet: 300 s are needed', realm.ownerOf('applewatch') === 'county-bruma');
tickFor(12);
check('attackers alone at the marker for 300 s take it', realm.ownerOf('applewatch') === 'fighters-guild');
dead.add(GM); for (const a of fighters.slice(1)) dead.add(a);
standAt(bruma, 'applewatch');
tickFor(302);
check('the defenders take it back the same way (the fallen do not count)', realm.ownerOf('applewatch') === 'county-bruma');
dead.clear();

// Outside a window nothing moves
now = w.windows[0].end + 1000;
standAt(fighters, 'applewatch'); standAt(bruma, 'pale-pass');
tickFor(400);
check('outside the battle windows nothing is taken', realm.ownerOf('applewatch') === 'county-bruma');

// War to the death: only in a window, only on contested land, only between the sides
now = w.windows[1].start + 1000;
standAt([5], 'greenwood');
check('no permadeath off the contested land', globalThis.__dboWarFinish(5, GM) === false && killed.length === 0);
standAt([5], 'applewatch');
check('an enemy\'s killing blow on contested land in a window ends the character', globalThis.__dboWarFinish(5, GM) === true && killed.length === 1 && killed[0].a === 5);
check('a blow between members of the same side is not war', globalThis.__dboWarFinish(6, 2) === false);
permaFails = true; standAt([7], 'applewatch');
check('if the permadeath does not take, the victim wakes at the temple instead', globalThis.__dboWarFinish(7, GM) === false && !permaDead.has(7));
permaFails = false;

// The capital falls: officials lose their ranks; the winner's leader appoints
standAt(bruma, 'pale-pass'); standAt(fighters, 'bruma');
tickFor(302);
check('the capital is taken', realm.ownerOf('bruma') === 'fighters-guild');
check('the hold\'s officials lose their ranks', !officials.bruma, JSON.stringify(officials));
check('the winning leader counts as a conqueror of the hold', globalThis.__dboConquerorLeads(GM, 'bruma') === true && globalThis.__dboConquerorLeads(GM + 1, 'bruma') === false);
check('and sees its treasury at the bank', JSON.stringify(globalThis.__dboConqueredZonesLedBy(GM)) === '["bruma"]');

// The war ends when everything named is taken
standAt(fighters, 'applewatch'); standAt(bruma, 'pale-pass');
tickFor(302);
check('the war ends when the attacker holds everything it named', w.status === 'ended' && /took everything/.test(w.outcome), w.outcome);

// A hot reload keeps owners and wars
load();
check('after a hot reload the owners stand', realm.ownerOf('bruma') === 'fighters-guild' && realm.ownerOf('applewatch') === 'fighters-guild');

// Two weeks before the same war again; peace; surrender
realm.setOwner('bruma', 'county-bruma', 'test reset'); officials = { bruma: { count: [1] } };
treasury['fighters-guild'] = 30000;
check('the same declarer waits two weeks', /too recently/.test(decl(GM, ['greenwood']).text));
now += 15 * DAY;
r = decl(GM, ['greenwood']);
check('after two weeks it may declare again', r.ok, r.text);
const w2 = r.war;
check('a war to the death is only proposed when asked for', w2.death === null);
check('only the defending leader can refuse a proposal that does not exist', !realm.answerDeath(COUNT, w2.id, true).ok);
treasury['county-bruma'] = 500;
realm.proposePeace(COUNT, w2.id, 1000, 'me');
check('peace needs the payer to afford the tribute', !realm.answerPeace(GM, w2.id, true).ok);
treasury['county-bruma'] = 5000;
realm.proposePeace(COUNT, w2.id, 1000, 'me');
check('only the other side answers peace', !realm.answerPeace(COUNT, w2.id, true).ok);
check('peace with tribute ends the war', realm.answerPeace(GM, w2.id, true).ok && w2.status === 'ended' && treasury['county-bruma'] === 4000);
now += 15 * DAY; treasury['fighters-guild'] = 30000;
const w3 = decl(GM, ['aleswell']).war;
check('surrender by the defender hands over the land named', realm.surrender(COUNT, w3.id).ok && realm.ownerOf('aleswell') === 'fighters-guild' && w3.status === 'ended');

// Hidden layers: a cult's shrine only for its members
globalThis.__dboGuildsOf = (a) => (fighters.includes(a) ? [{ id: 'fighters-guild', role: a === GM ? 'leader' : 'member' }] : a === 5 ? [{ id: 'cult-namira', role: 'member' }] : []);
check('a cult member sees its shrine on the map', realm.realmView(5).secret.length === 1 && realm.realmView(5).secret[0].name === 'Shrine of Namira');
check('nobody else does', realm.realmView(GM).secret.length === 0 && realm.realmView(COUNT).secret.length === 0);
check('a hidden place is never land: the nearest public marker still owns that spot', realm.territoryAt('a764b:BSHeartland.esm', [95612, 195219, 0]).id !== 'namira-shrine');

// Files
check('owners and wars are kept on disk', fs.existsSync('territory-owners.json') && fs.existsSync('wars.json') && JSON.parse(fs.readFileSync('wars.json', 'utf8')).wars.length === 3);

console.log(failures ? `${failures} failure(s)` : 'all passed');
process.exit(failures ? 1 : 0);
