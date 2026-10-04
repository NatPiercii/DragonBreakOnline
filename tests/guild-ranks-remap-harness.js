// A faction's rank list changed in guild-defs.json keeps every member on their title (guilds.js remapByTitle; #bugs
// 4 Oct: a Count could not grant Steward, so Steward was added to the hold ranks). Members are stored by rank index and
// every entry is stamped with its rank's title on save. At load a stamp that no longer names its index moves the entry
// to that title; an entry with no stamp (written before stamping) is mapped from the defs without their "added" ranks.
// Cases: the first load against today's live roster, idempotent reloads and restarts, a guilds.json restored from
// before and from after stamping, an unwritable guilds.json, a stray corrupt snapshot from the first version, the
// Blades' two "Blade" ranks, a later defs move and removal, a journal rank edit, and no "added" reaching the front.
// Real guilds.js and guild-defs.json, stub api, temp folder.
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

const COUNT = 0x14, REYLA = 0x15, OLD = 0x16, LEAD = 0x10, B1 = 0x21, B2 = 0x22, B3 = 0x23;
const logs = [], handlers = {}, drawn = [];
const api = {
  mp: { get: () => undefined, set: () => {} }, log: (...a) => logs.push(a.join(' ')), personal: () => {}, system: () => {}, audit: () => {},
  registerChatCommand: () => {}, onUi: (e, f) => { (handlers[e] = handlers[e] || []).push(f); }, openWidget: (a, p) => drawn.push(p), closeWidget: () => {},
  display: (a) => `P${a}`, nameOf: (a) => `P${a}`, tagOf: () => 'TAG', onlineActors: () => [LEAD], isAdmin: (a) => a === LEAD, isLeadStaff: (a) => a === LEAD,
  findByName: () => 0, who: (a) => `P${a}`, cfg: {}, profileOf: (a) => a,
};
const GFILE = path.join(dir, 'guilds.json');
let DEFSNOW = DEFS;
const writeDefs = (d) => { DEFSNOW = d; fs.writeFileSync(path.join(dir, 'guild-defs.json'), JSON.stringify(d)); };
const load = (fresh) => { delete require.cache[GUILDS]; if (fresh) delete globalThis.__dboGuildState; logs.length = 0; require(GUILDS)(api); };
const titlesOf = (fid) => { const f = DEFSNOW.factions.find((x) => x.id === fid); return (f.ranks || DEFSNOW.templates[f.template]).map((r) => r.title); };
const entry = (fid, a) => globalThis.__dboGuildState.members[fid][String(a)];
const titleOf = (fid, a) => titlesOf(fid)[entry(fid, a).rank];
const fileEntry = (fid, a) => JSON.parse(fs.readFileSync(GFILE, 'utf8'))[fid][String(a)];

// Today's live state (4 Oct 00:09, before stamping): the Count at 0 and a Citizen at 8; the Blades' second Blade (5)
const PRESHIP = { 'county-bruma': { [COUNT]: { rank: 0, name: 'Frigga Hux', tag: 'GLNP', since: 1 }, [REYLA]: { rank: 8, name: 'Reyla Feign', tag: 'FXWY', since: 2 } },
  'hold-whiterun': { [OLD]: { rank: 7, name: 'Old Guard', tag: 'OLDG', since: 3 } },
  'clan-largashbur': { [0x41]: { rank: 0, name: 'Chief', tag: 'CHIF', since: 7 }, [0x42]: { rank: 8, name: 'Blood-Kin', tag: 'KIN1', since: 8 }, [0x43]: { rank: 1, name: 'Commander', tag: 'CMDR', since: 9 } },
  blades: { [B1]: { rank: 2, name: 'Sergeant Blade', tag: 'BLD1', since: 4 }, [B2]: { rank: 5, name: 'Member Blade', tag: 'BLD2', since: 5 }, [B3]: { rank: 6, name: 'Initiate', tag: 'BLD3', since: 6 } } };
const expectPostShip = (label) => {
  ok(`${label}: the Count is Count`, titleOf('county-bruma', COUNT) === 'Count' && entry('county-bruma', COUNT).rank === 0, entry('county-bruma', COUNT));
  ok(`${label}: the Citizen is a Citizen (index 9), not a Guard`, titleOf('county-bruma', REYLA) === 'Citizen' && entry('county-bruma', REYLA).rank === 9, entry('county-bruma', REYLA));
  ok(`${label}: a Whiterun Guard is a Guard (index 8)`, entry('hold-whiterun', OLD).rank === 8);
  ok(`${label}: Largashbur keeps its Chief (0), Blood-Kin (8 -> 9) and Guard Commander (1 -> 2)`, entry('clan-largashbur', 0x41).rank === 0 && entry('clan-largashbur', 0x42).rank === 9 && entry('clan-largashbur', 0x43).rank === 2, globalThis.__dboGuildState.members['clan-largashbur']);
  ok(`${label}: the Blades keep both Blades apart (2 and 5)`, entry('blades', B1).rank === 2 && entry('blades', B2).rank === 5 && entry('blades', B3).rank === 6, [entry('blades', B1), entry('blades', B2)]);
};

const bruma = DEFS.factions.find((f) => f.id === 'county-bruma');
ok('the County of Bruma has a Steward rank, right under the Count, marked added', bruma.ranks[1].title === 'Steward' && bruma.ranks[1].role === 'officer' && !!bruma.ranks[1].added, bruma.ranks.slice(0, 2));
ok('so has every hold of the template', DEFS.templates.hold[1].title === 'Steward' && !!DEFS.templates.hold[1].added);
ok('the stronghold template has a Bane right under the Chief, marked added', DEFS.templates.stronghold[1].title === 'Bane' && DEFS.templates.stronghold[1].role === 'officer' && !!DEFS.templates.stronghold[1].added, DEFS.templates.stronghold.slice(0, 2));

writeDefs(DEFS);
fs.writeFileSync(GFILE, JSON.stringify(PRESHIP));
load(true);
expectPostShip('first load');
const st = fileEntry('county-bruma', REYLA);
ok('...every entry is stamped with its title in guilds.json', st.title === 'Citizen' && st.rank === 9 && fileEntry('county-bruma', COUNT).title === 'Count', st);
ok('...the second Blade carries nth 1, the first none', fileEntry('blades', B2).title === 'Blade' && fileEntry('blades', B2).nth === 1 && fileEntry('blades', B1).nth === undefined, [fileEntry('blades', B1), fileEntry('blades', B2)]);
const POSTSHIP = fs.readFileSync(GFILE, 'utf8');

load(false);
expectPostShip('a hot reload (state kept)');
ok('...it moves nobody', !logs.some((l) => /keeps the title/.test(l)), logs);
load(true);
expectPostShip('a restart');
ok('...it moves nobody', !logs.some((l) => /keeps the title/.test(l)), logs);

// The first version's snapshot is not used: a stray corrupt one changes nothing
fs.writeFileSync(path.join(dir, 'guild-ranks-seen.json'), '{ not json');
load(true);
expectPostShip('a corrupt guild-ranks-seen.json beside a stamped roster');
fs.unlinkSync(path.join(dir, 'guild-ranks-seen.json'));
load(true);
expectPostShip('no snapshot at all');

// Backups restored
fs.writeFileSync(GFILE, JSON.stringify(PRESHIP));
load(true);
expectPostShip('a pre-ship guilds.json restored');
fs.writeFileSync(GFILE, POSTSHIP);
load(true);
expectPostShip('a post-ship guilds.json restored');

// A guilds.json that cannot be written: the remap holds in memory, and the next load from the old file comes out the same
fs.writeFileSync(GFILE, JSON.stringify(PRESHIP));
const realRename = fs.renameSync;
fs.renameSync = (a, b) => { if (String(b) === GFILE) throw new Error('read-only'); return realRename(a, b); };
load(true);
expectPostShip('an unwritable guilds.json, in memory');
ok('...the file is still the pre-ship one', JSON.parse(fs.readFileSync(GFILE, 'utf8'))['county-bruma'][String(REYLA)].rank === 8);
load(true);
expectPostShip('...and the next load from it');
fs.renameSync = realRename;
load(true);
expectPostShip('once writable again');

// A later defs edit: Knight moves above Guard Captain, Armorer is gone, a Blade moves
const next = JSON.parse(JSON.stringify(DEFS));
const nb = next.factions.find((f) => f.id === 'county-bruma');
// Two more members, stamped as a save would stamp them
{
  const g = JSON.parse(fs.readFileSync(GFILE, 'utf8'));
  g['county-bruma'][String(OLD)] = { rank: titlesOf('county-bruma').indexOf('Armorer'), name: 'Smith', tag: 'SMTH', since: 7, title: 'Armorer' };
  g['county-bruma'][String(LEAD)] = { rank: titlesOf('county-bruma').indexOf('Guard Captain'), name: 'Capt', tag: 'CAPT', since: 8, title: 'Guard Captain' };
  fs.writeFileSync(GFILE, JSON.stringify(g));
}
const gc = nb.ranks.findIndex((r) => r.title === 'Guard Captain'); const kn = nb.ranks.findIndex((r) => r.title === 'Knight');
[nb.ranks[gc], nb.ranks[kn]] = [nb.ranks[kn], nb.ranks[gc]];
nb.ranks = nb.ranks.filter((r) => r.title !== 'Armorer');
const bl = next.factions.find((f) => f.id === 'blades');
const blRanks = bl.ranks || next.templates[bl.template];
const second = blRanks.splice(5, 1)[0]; blRanks.splice(3, 0, second);
writeDefs(next);
load(true);
ok('a moved rank: the Guard Captain is still Guard Captain', titleOf('county-bruma', LEAD) === 'Guard Captain', entry('county-bruma', LEAD));
ok('a removed rank: its holder takes the lowest rank', titleOf('county-bruma', OLD) === 'Citizen', entry('county-bruma', OLD));
ok('...the others keep theirs', titleOf('county-bruma', COUNT) === 'Count' && titleOf('county-bruma', REYLA) === 'Citizen');
ok('the second Blade moved in the defs: its member follows it (5 -> 3), the first Blade stays', entry('blades', B2).rank === 3 && entry('blades', B1).rank === 2, [entry('blades', B1), entry('blades', B2)]);
load(true);
ok('...and a second load moves nobody', !logs.some((l) => /keeps the title/.test(l)), logs);

// A rank edit in the journal stamps the new titles itself
globalThis.__dboFactionPayload(LEAD, false);
const nonce = globalThis.__dboGuildState.nonces.get(LEAD);
const list = titlesOf('county-bruma').map((t, i) => ({ title: t === 'Knight' ? 'Knight of the Hour' : t, role: nb.ranks[i].role, from: i }));
[list[2], list[3]] = [list[3], list[2]];
for (const f of handlers.factionRanksEdit) f(LEAD, [nonce, 'county-bruma', list]);
ok('a Lead GM renames Knight and reorders two ranks in the journal', drawn[drawn.length - 1] && drawn[drawn.length - 1].resultKind === 'ok', drawn[drawn.length - 1] && drawn[drawn.length - 1].result);
const capRank = entry('county-bruma', LEAD).rank;
ok('...the saved stamps follow the edit', fileEntry('county-bruma', LEAD).title === 'Guard Captain' && fileEntry('county-bruma', LEAD).rank === capRank, fileEntry('county-bruma', LEAD));
load(false);
ok('...and a reload leaves the roster as the edit left it', entry('county-bruma', LEAD).rank === capRank && !logs.some((l) => /keeps the title/.test(l)), [entry('county-bruma', LEAD), logs]);

// An unstamped entry in a faction with a guild-overrides.json override was indexed against the override (R-steward)
{
  writeDefs(DEFS);
  const fg = DEFS.factions.find((f) => f.id === 'fighters-guild');
  const base = (fg.ranks || DEFS.templates[fg.template]).map((r) => ({ title: r.title, role: r.role }));
  const A = 0x31, B = 0x32, C = 0x33;
  const run = (label, ovr, roster, expect) => {
    fs.writeFileSync(path.join(dir, 'guild-overrides.json'), JSON.stringify({ 'fighters-guild': { ranks: ovr } }));
    fs.writeFileSync(GFILE, JSON.stringify({ 'fighters-guild': roster }));
    load(true);
    const got = Object.fromEntries(Object.keys(roster).map((k) => [k, entry('fighters-guild', Number(k)).rank]));
    ok(label, JSON.stringify(got) === JSON.stringify(expect), { got, expect });
    load(true);
    const again = Object.fromEntries(Object.keys(roster).map((k) => [k, entry('fighters-guild', Number(k)).rank]));
    ok(`${label}: a second load moves nobody`, JSON.stringify(again) === JSON.stringify(expect), again);
    ok(`${label}: the stamps name the override's titles`, Object.keys(roster).every((k) => fileEntry('fighters-guild', Number(k)).title === ovr[expect[k]].title));
  };
  const renamed = base.map((r, i) => (i === 2 ? { title: 'Shield-Brother', role: r.role } : r));
  run('an override renaming a title: unstamped holders keep their index (and the new title)', renamed,
    { [A]: { rank: 2, name: 'A', tag: 'AAAA', since: 1 }, [B]: { rank: base.length - 1, name: 'B', tag: 'BBBB', since: 2 } }, { [A]: 2, [B]: base.length - 1 });
  const swapped = base.slice(); [swapped[1], swapped[2]] = [swapped[2], swapped[1]];
  run('an override swapping two ranks: unstamped holders stay on the override\'s index', swapped,
    { [A]: { rank: 1, name: 'A', tag: 'AAAA', since: 1 }, [B]: { rank: 2, name: 'B', tag: 'BBBB', since: 2 }, [C]: { rank: 0, name: 'C', tag: 'CCCC', since: 3 } }, { [A]: 1, [B]: 2, [C]: 0 });
  fs.unlinkSync(path.join(dir, 'guild-overrides.json'));
}

// Nothing of "added" reaches a payload
writeDefs(DEFS);
delete require.cache[GUILDS]; delete globalThis.__dboGuildState;
fs.writeFileSync(GFILE, JSON.stringify(PRESHIP));
try { fs.unlinkSync(path.join(dir, 'guild-overrides.json')); } catch (e) { /* none */ }
require(GUILDS)(api);
const pay = globalThis.__dboFactionPayload(LEAD, false);
ok('no rank in the faction payload carries added', !JSON.stringify(pay).includes('"added"') && pay.factions.find((f) => f.id === 'county-bruma').ranks[1].title === 'Steward');

try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* temp */ }
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
