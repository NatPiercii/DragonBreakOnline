// The F3 journal's Faction tab, staff view (guilds.js, piece H8): Add member (Lead GM, online or offline), the rank list
// edit (a leader renames, a Lead GM adds, moves and removes; members keep their rank through a move; a held rank cannot
// go; one leader, first; caps; the prose filter), the override store guild-overrides.json read back on a reload, the
// wage kept through a rename, and the payload flags the tab reads. Real guilds.js and guild-defs.json, stub api, in a
// temp folder.
//
//   node tests/faction-staff-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const GUILDS = path.join(ROOT, 'guilds.js');
if (!/factionRanksEdit/.test(fs.readFileSync(GUILDS, 'utf8'))) { require('./expect')('faction-staff', 'guilds.js has no rank edit'); console.log('ok   skipped: guilds.js has no rank edit'); process.exit(0); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-faction-staff-'));
fs.copyFileSync(path.join(ROOT, 'guild-defs.json'), path.join(dir, 'guild-defs.json'));
process.chdir(dir);

let fails = 0;
const ok = (label, cond, got) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${!cond && got !== undefined ? `: got ${JSON.stringify(got)}` : ''}`); if (!cond) fails++; };

const LEAD = 0x10, GM = 0x11, BOSS = 0x14, MATE = 0x15, AWAY = 0xff000300, NEW = 0x16;
const chars = new Map([[LEAD, 'Lead'], [GM, 'Plain GM'], [BOSS, 'Boss'], [MATE, 'Mate'], [AWAY, 'Away'], [NEW, 'Newcomer']]);
const onlineSet = new Set([LEAD, GM, BOSS, MATE, NEW]);
const told = [], audits = [], drawn = [];
const handlers = {};
const props = new Map();
const api = {
  mp: { get: (id, k) => props.get(`${id}|${k}`), set: (id, k, v) => props.set(`${id}|${k}`, v) },
  log: () => {}, personal: () => {}, system: (a, t) => told.push({ a, t }), audit: (t) => audits.push(t),
  registerChatCommand: () => {}, onUi: (e, f) => { (handlers[e] = handlers[e] || []).push(f); },
  openWidget: (a, p) => drawn.push({ a, p }), closeWidget: () => {},
  display: (a) => `${chars.get(a)} #T${a.toString(16)}`, nameOf: (a) => chars.get(a) || 'Stranger', tagOf: (a) => `T${a.toString(16)}`,
  onlineActors: () => [...onlineSet], isAdmin: (a) => a === LEAD || a === GM, isLeadStaff: (a) => a === LEAD,
  findByName: (q) => [...chars.entries()].find(([id, n]) => onlineSet.has(id) && n.toLowerCase() === String(q).toLowerCase())?.[0] || 0,
  findAnyByName: (q) => [...chars.entries()].find(([, n]) => n.toLowerCase() === String(q).toLowerCase().replace(/^#/, ''))?.[0] || 0,
  who: (a) => `${chars.get(a)} (profile ${a})`, cfg: {}, profileOf: (a) => a,
};
const load = () => { delete require.cache[GUILDS]; delete globalThis.__dboGuildState; require(GUILDS)(api); };
load();
const FID = 'fighters-guild';
const nonce = (a) => globalThis.__dboGuildState.nonces.get(a >>> 0);
const payload = (a) => globalThis.__dboFactionPayload(a, false);
const send = (ev, a, ...args) => { drawn.length = 0; for (const f of handlers[ev] || []) f(a, [nonce(a)].concat(args)); const d = drawn[drawn.length - 1]; return d ? d.p : null; };
const ranksNow = () => payload(LEAD).factions.find((f) => f.id === FID).ranks;
const roster = () => globalThis.__dboGuildState.members[FID] || {};

// ---- setup: a leader and a member ----------------------------------------------------------------------------------
payload(LEAD);
let p = send('factionAdd', LEAD, FID, 'Boss');
ok('a Lead GM adds a member at the lowest rank', roster()[String(BOSS)] && roster()[String(BOSS)].rank === ranksNow().length - 1 && p.resultKind === 'ok', p && p.result);
ok('the member is told', told.some((t) => t.a === BOSS && /You have been made .* of /.test(t.t)));
ok('the audit names the GM', audits.some((t) => /FACTION GM Lead \(profile 16\) added Boss/.test(t)), audits.slice(-1));
p = send('factionAdd', LEAD, FID, 'Away');
ok('an offline character can be added, and the GM is told they are away', roster()[String(AWAY)] && /offline/.test(p.result), p && p.result);
ok('adding someone already in is refused', send('factionAdd', LEAD, FID, 'Boss').resultKind === 'refused');
ok('an unknown name is refused', send('factionAdd', LEAD, FID, 'Nobody').resultKind === 'refused');
payload(GM);
ok('a plain GM cannot add', send('factionAdd', GM, FID, 'Mate').resultKind === 'refused' && !roster()[String(MATE)]);
payload(LEAD);
send('factionAdd', LEAD, FID, 'Mate');
send('factionSetRank', LEAD, FID, BOSS, 0);
ok('Make leader: the Lead GM sets the leader rank', roster()[String(BOSS)].rank === 0);

// ---- the payload flags ---------------------------------------------------------------------------------------------
const fl = payload(LEAD).factions.find((f) => f.id === FID);
ok('staff payload: staff, roles, counts and the edit flags', payload(LEAD).staff === true && payload(LEAD).roles.includes('officer') && fl.count === 3 && fl.canEditRanks && fl.canAdd && fl.canRename, { staff: payload(LEAD).staff, fl: [fl.count, fl.canEditRanks, fl.canAdd, fl.canRename] });
const gmf = payload(GM).factions.find((f) => f.id === FID);
ok('a plain GM sees it read-only', payload(GM).staff === true && !gmf.canEditRanks && !gmf.canAdd && !gmf.canRename);
const bf = payload(BOSS).factions.find((f) => f.id === FID);
ok('the leader may rename, not add or move', bf.canRename && !bf.canEditRanks && !bf.canAdd && payload(BOSS).staff === false);
ok('hold factions carry court: true', payload(LEAD).factions.find((f) => f.id === 'county-bruma').court === true && fl.court === false);

// ---- the leader renames -----------------------------------------------------------------------------------------------
const before = ranksNow();
const renamed = before.map((r, i) => ({ title: i === 1 ? '  Shield-Brother  ' : r.title, role: r.role, from: i }));
let wageRenamed = null;
globalThis.__dboEconomyRankRenamed = (fid, from, to) => { wageRenamed = [fid, from, to]; return true; };
payload(BOSS);
p = send('factionRanksEdit', BOSS, FID, renamed);
ok('the leader renames a title (trimmed)', p.resultKind === 'ok' && ranksNow()[1].title === 'Shield-Brother', [p && p.result, ranksNow()[1]]);
ok('the wage keyed by the old title moves with it', wageRenamed && wageRenamed[1] === before[1].title && wageRenamed[2] === 'Shield-Brother', wageRenamed);
const swapped = ranksNow().map((r, i) => ({ title: r.title, role: r.role, from: i })); [swapped[1], swapped[2]] = [swapped[2], swapped[1]];
ok('the leader cannot reorder', send('factionRanksEdit', BOSS, FID, swapped).resultKind === 'refused' && ranksNow()[1].title === 'Shield-Brother');
ok('the leader cannot add a rank', send('factionRanksEdit', BOSS, FID, ranksNow().map((r, i) => ({ title: r.title, role: r.role, from: i })).concat([{ title: 'Squire', role: 'member', from: -1 }])).resultKind === 'refused');
globalThis.__dboProseProblem = (t) => (/badword/i.test(t) ? 'badword' : null);
ok('a title the prose filter refuses is refused, naming the word', /badword/.test(send('factionRanksEdit', BOSS, FID, ranksNow().map((r, i) => ({ title: i === 2 ? 'Badword' : r.title, role: r.role, from: i }))).result));
delete globalThis.__dboProseProblem;
payload(MATE);
ok('a member cannot rename', send('factionRanksEdit', MATE, FID, ranksNow().map((r, i) => ({ title: 'X' + i, role: r.role, from: i }))).resultKind === 'refused');

// ---- a Lead GM moves, adds and removes -----------------------------------------------------------------------------------
payload(LEAD);
const n0 = ranksNow().length;
const low = n0 - 1;
const mateRank = roster()[String(MATE)].rank;
ok('setup: Mate holds the lowest rank', mateRank === low);
// Move the lowest rank up to index 1 and add a new rank at the bottom
const cur = ranksNow().map((r, i) => ({ title: r.title, role: r.role, from: i }));
const moved = [cur[0], cur[low]].concat(cur.slice(1, low)).concat([{ title: 'Squire', role: 'member', from: -1 }]);
p = send('factionRanksEdit', LEAD, FID, moved);
ok('a Lead GM moves a rank and adds one', p.resultKind === 'ok' && ranksNow().length === n0 + 1 && ranksNow()[1].title === cur[low].title && ranksNow()[n0].title === 'Squire', [p && p.result, ranksNow().map((r) => r.title)]);
ok('the member keeps their title through the move (renumbered to 1)', roster()[String(MATE)].rank === 1 && ranksNow()[roster()[String(MATE)].rank].title === cur[low].title, roster()[String(MATE)]);
ok('the leader stays the leader', roster()[String(BOSS)].rank === 0);
const withHeld = ranksNow().map((r, i) => ({ title: r.title, role: r.role, from: i })).filter((r) => r.from !== 1);
p = send('factionRanksEdit', LEAD, FID, withHeld);
ok('a rank somebody holds cannot go, and the count is said', p.resultKind === 'refused' && /cannot go: 2 members hold it/.test(p.result) && ranksNow().length === n0 + 1, p && p.result);
const noSquire = ranksNow().map((r, i) => ({ title: r.title, role: r.role, from: i })).filter((r) => r.title !== 'Squire');
p = send('factionRanksEdit', LEAD, FID, noSquire);
ok('an empty rank goes', p.resultKind === 'ok' && ranksNow().length === n0 && !ranksNow().some((r) => r.title === 'Squire'), p && p.result);
const bad = (label, list, re) => { const q = send('factionRanksEdit', LEAD, FID, list); ok(label, q.resultKind === 'refused' && (!re || re.test(q.result)), q && q.result); };
const base = () => ranksNow().map((r, i) => ({ title: r.title, role: r.role, from: i }));
bad('two leaders are refused', base().map((r, i) => (i === 1 ? Object.assign({}, r, { role: 'leader' }) : r)), /only one/);
bad('the leader rank must come first', (() => { const l = base(); [l[0], l[1]] = [l[1], l[0]]; return l; })(), /comes first/);
bad('an unknown role is refused', base().map((r, i) => (i === 2 ? Object.assign({}, r, { role: 'emperor' }) : r)), /known roles/);
bad('two ranks of one title are refused', base().map((r, i) => (i === 2 ? Object.assign({}, r, { title: base()[1].title.toUpperCase() }) : r)), /Two ranks/);
bad('an empty title is refused', base().map((r, i) => (i === 2 ? Object.assign({}, r, { title: '   ' }) : r)), /needs a title/);
bad('a repeated from is refused', base().map((r, i) => (i === 2 ? Object.assign({}, r, { from: 1 }) : r)));
bad('a from out of range is refused', base().concat([{ title: 'Ghost', role: 'member', from: 99 }]));
bad('more than twelve ranks are refused', base().concat(Array.from({ length: 12 }, (x, i) => ({ title: `Extra ${i}`, role: 'member', from: -1 }))), /at most 12/);
bad('a role cap is kept (a second blacksmith-capped role over 3 is fine, a second leader role is not)', base().map((r, i) => (i === 1 ? Object.assign({}, r, { role: 'leader' }) : r)));
ok('a stale nonce does nothing', (() => { drawn.length = 0; for (const f of handlers.factionRanksEdit) f(LEAD, ['stale', FID, []]); return drawn.length === 0; })());

// ---- the override store ------------------------------------------------------------------------------------------------
const stored = JSON.parse(fs.readFileSync(path.join(dir, 'guild-overrides.json'), 'utf8'));
ok('guild-overrides.json holds the edited ranks with who and when', stored[FID] && stored[FID].ranks.length === n0 && /Lead/.test(stored[FID].by) && stored[FID].at > 0, stored[FID] && stored[FID].ranks.length);
const titlesBefore = ranksNow().map((r) => r.title).join('|');
const members = JSON.parse(fs.readFileSync(path.join(dir, 'guilds.json'), 'utf8'));
load();
globalThis.__dboGuildState.members = members;
ok('a reload reads the overrides back', ranksNow().map((r) => r.title).join('|') === titlesBefore, ranksNow().map((r) => r.title));
ok('other factions of the same template are untouched', JSON.stringify(payload(LEAD).factions.find((f) => f.id === 'hold-whiterun').ranks) === JSON.stringify(JSON.parse(fs.readFileSync(path.join(dir, 'guild-defs.json'), 'utf8')).templates.hold));
fs.writeFileSync(path.join(dir, 'guild-overrides.json'), JSON.stringify({ [FID]: { ranks: [{ title: 'Only Member', role: 'member' }] } }));
load();
ok('an override that cannot stand is ignored at load', ranksNow()[0].role === 'leader' && ranksNow().length > 1);

delete globalThis.__dboEconomyRankRenamed;
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* temp */ }
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
