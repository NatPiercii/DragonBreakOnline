// A faction's rank list changed in guild-defs.json keeps every member on their title (guilds.js remapByTitle; #bugs
// 4 Oct: a Count could not grant Steward, so Steward was added to the hold ranks). Members are stored by rank index; the
// load remaps them by title against guild-ranks-seen.json, or, with no snapshot yet, against today's list without the
// ranks marked "added". A rank edit in the journal updates the snapshot, so a reload never remaps twice. Real guilds.js
// and guild-defs.json, stub api, temp folder.
//
//   node tests/guild-ranks-remap-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const GUILDS = path.join(ROOT, 'guilds.js');
if (!/remapByTitle/.test(fs.readFileSync(GUILDS, 'utf8'))) { require('./expect')('guild-ranks-remap', 'guilds.js has no remap by title'); console.log('ok   skipped: guilds.js has no remap by title'); process.exit(0); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-ranks-remap-'));
const DEFS = JSON.parse(fs.readFileSync(path.join(ROOT, 'guild-defs.json'), 'utf8'));
process.chdir(dir);

let fails = 0;
const ok = (label, cond, got) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${!cond && got !== undefined ? `: got ${JSON.stringify(got)}` : ''}`); if (!cond) fails++; };

const COUNT = 0x14, REYLA = 0x15, OLD = 0x16, LEAD = 0x10;
const logs = [];
const handlers = {};
const drawn = [];
const api = {
  mp: { get: () => undefined, set: () => {} }, log: (...a) => logs.push(a.join(' ')), personal: () => {}, system: () => {}, audit: () => {},
  registerChatCommand: () => {}, onUi: (e, f) => { (handlers[e] = handlers[e] || []).push(f); }, openWidget: (a, p) => drawn.push(p), closeWidget: () => {},
  display: (a) => `P${a}`, nameOf: (a) => `P${a}`, tagOf: () => 'TAG', onlineActors: () => [LEAD], isAdmin: (a) => a === LEAD, isLeadStaff: (a) => a === LEAD,
  findByName: () => 0, who: (a) => `P${a}`, cfg: {}, profileOf: (a) => a,
};
const writeDefs = (d) => fs.writeFileSync(path.join(dir, 'guild-defs.json'), JSON.stringify(d));
const load = (fresh) => { delete require.cache[GUILDS]; if (fresh) delete globalThis.__dboGuildState; logs.length = 0; require(GUILDS)(api); };
const roster = () => globalThis.__dboGuildState.members['county-bruma'];
const titles = () => DEFSNOW.factions.find((f) => f.id === 'county-bruma').ranks.map((r) => r.title);
const titleOf = (a) => titles()[roster()[String(a)].rank];
let DEFSNOW = DEFS;

const bruma = DEFS.factions.find((f) => f.id === 'county-bruma');
ok('the County of Bruma has a Steward rank, right under the Count, marked added', bruma.ranks[1].title === 'Steward' && bruma.ranks[1].role === 'officer' && !!bruma.ranks[1].added, bruma.ranks.slice(0, 2));
ok('so has every hold of the template', DEFS.templates.hold[1].title === 'Steward' && !!DEFS.templates.hold[1].added);

// Today's live state (4 Oct 00:09): the Count at 0 and a Citizen at 8, stored against the list without Steward
writeDefs(DEFS);
fs.writeFileSync(path.join(dir, 'guilds.json'), JSON.stringify({ 'county-bruma': { [COUNT]: { rank: 0, name: 'Frigga Hux', tag: 'GLNP', since: 1 }, [REYLA]: { rank: 8, name: 'Reyla Feign', tag: 'FXWY', since: 2 } },
  'hold-whiterun': { [OLD]: { rank: 7, name: 'Old Guard', tag: 'OLDG', since: 3 } } }));
load(true);
ok('first load with no snapshot: the Count stays Count', titleOf(COUNT) === 'Count', roster());
ok('...and the Citizen stays a Citizen (8 -> 9), not a Guard', titleOf(REYLA) === 'Citizen' && roster()[String(REYLA)].rank === 9, roster());
ok('...a Whiterun Guard stays a Guard (7 -> 8)', globalThis.__dboGuildState.members['hold-whiterun'][String(OLD)].rank === 8);
ok('...the remap is saved to guilds.json', JSON.parse(fs.readFileSync(path.join(dir, 'guilds.json'), 'utf8'))['county-bruma'][String(REYLA)].rank === 9);
ok('...the snapshot is written with Steward in it', JSON.parse(fs.readFileSync(path.join(dir, 'guild-ranks-seen.json'), 'utf8'))['county-bruma'][1] === 'Steward');
ok('...and the change is logged', logs.some((l) => /county-bruma's ranks changed/.test(l)), logs);

load(false);
ok('a reload with the same defs (a hot reload keeps the state) changes nothing', titleOf(REYLA) === 'Citizen' && roster()[String(REYLA)].rank === 9 && !logs.some((l) => /ranks changed/.test(l)));
load(true);
ok('a restart (state read back from guilds.json) changes nothing either', titleOf(REYLA) === 'Citizen' && roster()[String(REYLA)].rank === 9);

// A later defs edit with the snapshot in place: Knight moves above Guard Captain, Armorer is gone
const next = JSON.parse(JSON.stringify(DEFS));
const nb = next.factions.find((f) => f.id === 'county-bruma');
roster()[String(OLD)] = { rank: titles().indexOf('Armorer'), name: 'Smith', tag: 'SMTH', since: 4 };
roster()[String(LEAD)] = { rank: titles().indexOf('Guard Captain'), name: 'Capt', tag: 'CAPT', since: 5 };
const gc = nb.ranks.findIndex((r) => r.title === 'Guard Captain'); const kn = nb.ranks.findIndex((r) => r.title === 'Knight');
[nb.ranks[gc], nb.ranks[kn]] = [nb.ranks[kn], nb.ranks[gc]];
nb.ranks = nb.ranks.filter((r) => r.title !== 'Armorer');
writeDefs(next); DEFSNOW = next;
load(false);
ok('a moved rank: the Guard Captain is still Guard Captain', titleOf(LEAD) === 'Guard Captain', roster());
ok('a removed rank: its holder takes the lowest rank', titleOf(OLD) === 'Citizen', roster());
ok('...the others keep theirs', titleOf(COUNT) === 'Count' && titleOf(REYLA) === 'Citizen');

// A rank edit in the journal remaps and updates the snapshot itself: the next load must not remap again
const nonce = () => globalThis.__dboGuildState.nonces.get(LEAD);
globalThis.__dboFactionPayload(LEAD, false);
const list = titles().map((t, i) => ({ title: t, role: nb.ranks[i].role, from: i }));
[list[2], list[3]] = [list[3], list[2]];
for (const f of handlers.factionRanksEdit) f(LEAD, [nonce(), 'county-bruma', list]);
const edited = drawn[drawn.length - 1];
ok('a Lead GM reorders two ranks in the journal', edited && edited.resultKind === 'ok', edited && edited.result);
const capBefore = roster()[String(LEAD)].rank;
const seen = JSON.parse(fs.readFileSync(path.join(dir, 'guild-ranks-seen.json'), 'utf8'))['county-bruma'];
ok('...the snapshot follows the edit', JSON.stringify(seen) === JSON.stringify(list.map((r) => r.title)), seen);
load(false);
ok('...and a reload leaves the roster as the edit left it', roster()[String(LEAD)].rank === capBefore && !logs.some((l) => /county-bruma's ranks changed/.test(l)), [roster()[String(LEAD)], logs]);

try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* temp */ }
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
