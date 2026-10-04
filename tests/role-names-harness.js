// Staff names for offices and ranks (rolenames.js; Nate, 4 Oct: "GMs can rename roles in Holds/factions live"). The real
// rolenames.js, guilds.js, court.js with the real guild-defs.json and name-filter.json, gamemode.js's own rankTitle and
// its officials functions (APPOINT_RULES to the Scholar section), run against stubs in a temp folder.
// Covers: who may rename (a Lead GM; a plain GM and a leader may not), an office renamed at the Court tab for every
// holder at once (the tab, /appoint's lines, the hook the fork's notice boards ask), the household rank it sets renamed
// with it, the office id and the rank's own title kept (officials.json, the office-to-rank map, the roster stamps,
// guild-overrides.json untouched), the Faction tab's rank editor (a Lead GM's rename is a staff name, a leader's is the
// rank's own, a leader cannot rename over a staff name), the name rules (length, the game's lettering, name-filter's
// blocked and reserved words per word, the prose filter, capitals, no twin names, no court-set title on another rank),
// the audit line, reset to the default (empty name or the default itself), /rolename, the names kept through a hot reload,
// a fresh load and a regenerated guild-defs.json (a rank inserted above), and the live guilds.js loaded first.
//
//   node tests/role-names-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
if (!fs.existsSync(path.join(ROOT, 'rolenames.js'))) { require('./expect')('role-names', 'rolenames.js is missing'); console.log('ok   skipped: no rolenames.js'); process.exit(0); }
const src = fs.readFileSync(path.join(ROOT, 'gamemode.js'), 'utf8');
const start = src.indexOf('const APPOINT_RULES = ');
const end = src.indexOf('// ---- Scholar');
const rt = src.match(/const rankTitle = \(r, zoneId\) => \{[\s\S]*?\n\};/);
if (start < 0 || end < start || !rt) { console.log('FAIL gamemode.js has no zone-aware rankTitle or officials section'); process.exit(1); }
const section = src.slice(start, end) + '\nreturn { APPOINT_RULES, appointCap, appointCheck, appointFrom, seatOfficial, unseatOfficial, officialTarget, officialName, accountActors };';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-rolenames-'));
for (const f of ['guild-defs.json', 'name-filter.json']) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
process.chdir(dir);

let fails = 0;
const ok = (label, cond, got) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${!cond && got !== undefined ? `: got ${JSON.stringify(got)}` : ''}`); if (!cond) fails++; };

// ---- the world -------------------------------------------------------------------------------------------------------
const LEAD = 0x10, GM = 0x11, COUNT = 0x14, ALDO = 0x15, CAPT = 0x16, BOSS = 0x17, MATE = 0x18;
const chars = new Map([
  [LEAD, { pid: 1, name: 'Lead', tag: 'LEAD', online: true, race: 'ImperialRace' }],
  [GM, { pid: 2, name: 'Plain GM', tag: 'PLGM', online: true, race: 'ImperialRace' }],
  [COUNT, { pid: 11, name: 'Narina Carvain', tag: 'CNT1', online: true, race: 'ImperialRace' }],
  [ALDO, { pid: 12, name: 'Aldo Varro', tag: 'ALD1', online: true, race: 'ImperialRace' }],
  [CAPT, { pid: 14, name: 'Cyrus Fane', tag: 'CPT1', online: true, race: 'BretonRace' }],
  [BOSS, { pid: 15, name: 'Boss', tag: 'BOS1', online: true, race: 'NordRace' }],
  [MATE, { pid: 16, name: 'Mate', tag: 'MAT1', online: true, race: 'NordRace' }],
]);
const zones = [
  { id: 'bruma', name: 'Bruma', officials: ['count', 'steward', 'captain', 'courtmage', 'guard'], worldspaces: [] },
  { id: 'whiterun', name: 'Whiterun', capital: 'x', officials: ['jarl', 'steward', 'commander', 'courtmage', 'guardcaptain', 'guard'] },
];
const ZONES = { rankTitles: { count: 'Count', steward: 'Steward', captain: 'Guard Captain', courtmage: 'Court Mage', guard: 'Guard', jarl: 'Jarl', commander: 'Hold Commander', guardcaptain: 'Guard Captain' } };
let officials = {};
const told = [], audits = [], said = [], props = new Map();
const online = () => [...chars.entries()].filter(([, c]) => c.online).map(([id]) => id);
const byName = (q) => [...chars.entries()].filter(([, c]) => c.name.toLowerCase() === String(q).trim().toLowerCase()).map(([id]) => id);
const findByName = (q) => { const s = String(q).trim().replace(/^#/, ''); const t = [...chars.entries()].filter(([, c]) => c.tag.toLowerCase() === s.toLowerCase()).map(([id]) => id).concat(byName(q)); return t[0] || 0; };
const RACES = new Map([...chars.values()].map((c, i) => [100 + i, c.race]));
const mp = {
  get: (id, k) => {
    if (k === 'appearance') return chars.has(id) ? { name: chars.get(id).name, raceId: 100 + [...chars.keys()].indexOf(id) } : null;
    if (k === 'profileId') return chars.has(id) ? chars.get(id).pid : -1;
    return props.get(`${id}|${k}`);
  },
  set: (id, k, v) => props.set(`${id}|${k}`, v),
  getActorsByProfileId: (pid) => [...chars.entries()].filter(([, c]) => c.pid === pid).map(([id]) => id),
  lookupEspmRecordById: (id) => ({ record: RACES.has(id) ? { editorId: RACES.get(id) } : null }),
};
const nameOf = (a) => (chars.has(a) ? chars.get(a).name : 'Stranger');
const tagOf = (a) => (chars.has(a) ? chars.get(a).tag : '????');
const profileOf = (a) => (chars.has(a) ? chars.get(a).pid : -1);
const display = (a) => `${nameOf(a)} #${tagOf(a)}`;
const who = (a) => `${display(a)} (profile ${profileOf(a)})`;
const zoneList = () => zones;
const zoneById = (id) => zones.find((z) => z.id === String(id).toLowerCase()) || null;
const ranksOf = (pid) => { const out = []; for (const z of zones) for (const r of Object.keys(officials[z.id] || {})) if ((officials[z.id][r] || []).map(Number).includes(pid)) out.push({ zone: z, rank: r }); return out; };
const handlers = {};
const commands = new Map();
const rankTitle = new Function('ZONES', 'globalThis', `${rt[0]}\nreturn rankTitle;`)(ZONES, globalThis);
const base = {
  mp, log: () => {}, personal: (a, t) => said.push(t), system: (a, text) => told.push({ a, text }), audit: (t) => audits.push(t), cfg: {},
  isAdmin: (a) => a === LEAD || a === GM, isLeadStaff: (a) => a === LEAD, tierOf: (a) => (a === LEAD ? 'developer' : a === GM ? 'gm' : null),
  profileOf, nameOf, tagOf, display, who, findByName, findAnyByName: findByName, onlineActors: online,
  onUi: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); },
  userOf: (a) => (chars.has(a) && chars.get(a).online ? 1 : -1), seen: new Map(),
  zoneList, zoneById, ranksOf, rankTitle, defaultTitles: ZONES.rankTitles,
  readOfficials: () => JSON.parse(JSON.stringify(officials)), writeOfficials: (o) => { officials = JSON.parse(JSON.stringify(o)); },
  registerChatCommand: (n, f) => { commands.set(n, f); }, openWidget: (a, p) => drawn.push({ a, p }), closeWidget: () => {},
};
const drawn = [];
const O = new Function(...Object.keys(base), section)(...Object.values(base));
const answers = [];
globalThis.__dboJournalFresh = (a, n) => n === 'N';
globalThis.__dboJournalLimited = (a, fn) => { answers.push(Object.assign({ a }, fn())); };
const loadAll = (guildsPath) => {
  for (const f of ['rolenames.js', 'guilds.js', 'court.js']) delete require.cache[path.join(ROOT, f)];
  require(path.join(ROOT, 'rolenames.js'))(base);
  require(guildsPath || path.join(ROOT, 'guilds.js'))(base);
  require(path.join(ROOT, 'court.js'))(Object.assign({}, base, O));
};
loadAll();
const sec = () => globalThis.__dboJournalSections.court;
const ev = (name, a, ...args) => { answers.length = 0; told.length = 0; for (const f of handlers[name] || []) f(a, args); return answers[answers.length - 1] || null; };
const HOLD = 'county-bruma';
const defsRanks = () => JSON.parse(fs.readFileSync(path.join(dir, 'guild-defs.json'), 'utf8')).factions.find((f) => f.id === HOLD).ranks;
const entry = (fid, a) => (globalThis.__dboGuildState.members[fid] || {})[String(a >>> 0)] || null;
const court = (a) => sec().view(a).courts.find((c) => c.id === 'bruma');
const office = (a, rank) => court(a).offices.find((o) => o.rank === rank);
const hhRank = (a, title) => court(a).household.ranks.find((r) => (r.canon || r.title) === title);
const chat = (a, args) => { said.length = 0; commands.get('rolename')(a, args); return said.join(' | '); };
const stored = () => JSON.parse(fs.readFileSync(path.join(dir, 'role-names.json'), 'utf8'));
const seated = (z, r) => (officials[z] && officials[z][r]) || [];

// ---- who may ---------------------------------------------------------------------------------------------------------
ev('courtAppoint', LEAD, 'N', 'bruma', 'Aldo Varro', 'steward');
ok('setup: Aldo is Steward of Bruma, and the household Steward', seated('bruma', 'steward').includes(12) && defsRanks()[entry(HOLD, ALDO).rank].title === 'Steward');
ok('the court view tells a Lead GM they may rename; a plain GM and a ruler are not told', court(LEAD).canName === true && court(GM).canName === false);
let r = ev('courtRename', GM, 'N', 'bruma', 'office', 'steward', 'Reeve');
ok('a plain GM cannot rename an office', r.kind === 'refused' && /Lead GM/.test(r.text) && office(LEAD, 'steward').title === 'Steward', r);
ev('courtAppoint', LEAD, 'N', 'bruma', 'Narina Carvain', 'count');
r = ev('courtRename', COUNT, 'N', 'bruma', 'office', 'steward', 'Reeve');
ok('nor can the court\'s own ruler', r.kind === 'refused' && office(LEAD, 'steward').title === 'Steward', r);
ok('/rolename refuses a plain GM', /Lead GM/.test(chat(GM, 'bruma steward Reeve')) && office(LEAD, 'steward').title === 'Steward');

// ---- an office renamed at the Court tab ---------------------------------------------------------------------------------
r = ev('courtRename', LEAD, 'N', 'bruma', 'office', 'steward', '  Reeve ');
ok('a Lead GM renames Bruma\'s Steward to Reeve', r.kind === 'ok' && /Bruma's Steward is now called Reeve, and so is the household rank it sets/.test(r.text), r);
let o = office(LEAD, 'steward');
ok('the Court tab shows Reeve, with the default kept beside it', o.title === 'Reeve' && o.named === true && o.default === 'Steward', o);
ok('...for the court\'s own members too (the Count\'s view)', office(COUNT, 'steward').title === 'Reeve' && !office(COUNT, 'count').named);
ok('the holder online is told once', told.filter((t) => t.a === ALDO).length === 1 && /Your office in Bruma is now called Reeve/.test(told.find((t) => t.a === ALDO).text), told);
ok('gamemode.js rankTitle names it for Bruma only', rankTitle('steward', 'bruma') === 'Reeve' && rankTitle('steward', 'whiterun') === 'Steward' && rankTitle('steward') === 'Steward');
ok('...and an index from .map never reads as a court', rankTitle('steward', 1) === 'Steward');
ok('the hook the fork\'s notice boards ask (__dboOfficeTitle)', globalThis.__dboOfficeTitle('bruma', 'steward') === 'Reeve' && globalThis.__dboOfficeTitle('whiterun', 'jarl') === 'Jarl');
ok('the household rank it sets is shown as Reeve, its own title still Steward', hhRank(LEAD, 'Steward').title === 'Reeve' && hhRank(LEAD, 'Steward').canon === 'Steward' && defsRanks()[entry(HOLD, ALDO).rank].title === 'Steward');
ok('...the member line too', court(LEAD).household.members.find((m) => m.actorId === ALDO).title === 'Reeve');
ok('officials.json keeps the office id', seated('bruma', 'steward').includes(12) && !officials.bruma.reeve);
ok('guild-overrides.json is not written for a name', !fs.existsSync(path.join(dir, 'guild-overrides.json')));
ok('role-names.json holds both names, who and when', stored().offices.bruma.steward.name === 'Reeve' && /Lead/.test(stored().offices.bruma.steward.by) && stored().ranks[HOLD].steward.canon === 'Steward', stored());
ok('the audit names the GM, the office, old and new', audits.some((t) => /^ROLENAME GM Lead #LEAD \(profile 1\) renamed the Steward office \(steward\) of Bruma: Steward -> Reeve$/.test(t)) && audits.some((t) => /renamed the Steward rank of County of Bruma: Steward -> Reeve \(with its office\)/.test(t)), audits.slice(-2));
// Appointing, offering and dismissing say the new name; the office still sets the household rank by its own title
r = ev('courtAppoint', LEAD, 'N', 'bruma', 'Cyrus Fane', 'steward');
ok('appointing says Reeve', r.kind === 'ok' && /Cyrus Fane #CPT1 is now Reeve of Bruma/.test(r.text) && told.some((t) => t.a === CAPT && /appointed Reeve of Bruma/.test(t.text)), [r, told]);
ok('...and the office still sets the household rank (by its own title, Steward)', defsRanks()[entry(HOLD, CAPT).rank].title === 'Steward', entry(HOLD, CAPT));
ok('the household line says Reeve', court(LEAD).household.members.find((m) => m.actorId === CAPT).title === 'Reeve');
ev('courtOffer', COUNT, 'N', 'bruma', 'Boss', 'steward');
ok('an offer says Reeve', told.some((t) => t.a === BOSS && /offers you the post of Reeve of Bruma/.test(t.text)) && sec().view(BOSS).offers[0].title === 'Reeve', told);
said.length = 0; O.unseatOfficial(LEAD, zoneById('bruma'), O.officialTarget('Cyrus Fane'));
ok('dismissing says Reeve', told.some((t) => t.a === CAPT && /no longer Reeve of Bruma/.test(t.text)));
ok('the other zones are untouched', sec().view(LEAD).courts.find((c) => c.id === 'whiterun').offices.find((x) => x.rank === 'steward').title === 'Steward');

// ---- the rules ------------------------------------------------------------------------------------------------------------
const refused = (label, name, re, kind, key) => { const q = ev('courtRename', LEAD, 'N', 'bruma', kind || 'office', key === undefined ? 'guard' : key, name); ok(label, q.kind === 'refused' && (!re || re.test(q.text)) && office(LEAD, 'guard').title === 'Guard', q); };
refused('one letter is too short', 'G', /2 to 40/);
refused('41 letters are too long', 'G'.repeat(41), /2 to 40/);
refused('a digit is refused', 'Guard 2', /letters/);
refused('an accented letter the game cannot draw is refused', 'Garde élue', /letters/);
refused('an emoji is refused', 'Guard ⚔', /letters/);
refused('a separator at the end is refused', 'Guard-', /start or end/);
refused('capitals are refused', 'WARDEN', /capitals/);
const blocked = JSON.parse(fs.readFileSync(path.join(dir, 'name-filter.json'), 'utf8')).blocked;
refused('name-filter\'s blocked words are refused', `Lord ${blocked.find((w) => w.length >= 5)[0].toUpperCase()}${blocked.find((w) => w.length >= 5).slice(1)}`, /will not do/);
ok('...per word: "Night Watch" is fine (folding both words would read "twat")', ev('courtRename', LEAD, 'N', 'bruma', 'office', 'guard', 'Night Watch').kind === 'ok' && office(LEAD, 'guard').title === 'Night Watch');
ev('courtRename', LEAD, 'N', 'bruma', 'office', 'guard', '');
refused('a reserved word (staff, admin) is refused', 'Staff Sergeant', /staff or the server/);
globalThis.__dboProseProblem = (t) => (/modern/i.test(t) ? 'Modern' : null);
refused('the prose filter is asked, and names the word', 'Modern Guard', /"Modern"/);
delete globalThis.__dboProseProblem;
refused('two offices of a court cannot share a name', 'Reeve', /two offices called Reeve/);
ok('Cyrillic is in the game\'s lettering', ev('courtRename', LEAD, 'N', 'bruma', 'office', 'guard', 'Страж').kind === 'ok' && office(LEAD, 'guard').title === 'Страж');
ok('a smart apostrophe is folded to the plain one', ev('courtRename', LEAD, 'N', 'bruma', 'office', 'guard', 'Count’s Guard').kind === 'ok' && office(LEAD, 'guard').title === "Count's Guard", office(LEAD, 'guard'));
ok('an office the court lacks is refused', ev('courtRename', LEAD, 'N', 'bruma', 'office', 'jarl', 'High King').kind === 'refused');
const knight = court(LEAD).household.ranks.findIndex((x) => x.title === 'Knight');
r = ev('courtRename', LEAD, 'N', 'bruma', 'rank', knight, 'Guard Captain');
ok('a household rank cannot take a title a court office sets (it would read as that office\'s rank)', r.kind === 'refused' && /a court office sets/.test(r.text), r);
r = ev('courtRename', LEAD, 'N', 'bruma', 'rank', knight, 'Citizen');
ok('nor another rank\'s name', r.kind === 'refused' && /two ranks shown as Citizen/.test(r.text), r);

// ---- a household rank renamed on its own, and reset ---------------------------------------------------------------------
r = ev('courtRename', LEAD, 'N', 'bruma', 'rank', knight, 'Knight of the Dragon');
ok('a Lead GM renames the household\'s Knight rank at the Court tab', r.kind === 'ok' && court(LEAD).household.ranks[knight].title === 'Knight of the Dragon' && court(LEAD).household.ranks[knight].canon === 'Knight', r);
r = ev('courtRename', LEAD, 'N', 'bruma', 'rank', knight, 'Knight');
ok('typing the default back resets it', r.kind === 'ok' && / again/.test(r.text) && !court(LEAD).household.ranks[knight].canon && !(stored().ranks[HOLD] || {}).knight, [r, stored()]);
ok('...and the audit says reset', audits.some((t) => /reset the Knight rank of County of Bruma: Knight of the Dragon -> Knight \(the default\)/.test(t)), audits.slice(-1));

// ---- the Faction tab's rank editor --------------------------------------------------------------------------------------
const fp = (a) => { drawn.length = 0; const p = globalThis.__dboFactionPayload(a, false); return p; };
const nonce = (a) => globalThis.__dboGuildState.nonces.get(a >>> 0);
const send = (evn, a, ...args) => { drawn.length = 0; for (const f of handlers[evn] || []) f(a, [nonce(a)].concat(args)); const d = drawn[drawn.length - 1]; return d ? d.p : null; };
const fRanks = (a, fid) => fp(a).factions.find((f) => f.id === fid).ranks;
const rows = (a, fid, edit) => { const l = fRanks(a, fid).map((x, i) => ({ title: x.title, role: x.role, from: i })); if (edit) edit(l); return l; };
fp(LEAD);
let p = send('factionRanksEdit', LEAD, HOLD, rows(LEAD, HOLD, (l) => { l[l.findIndex((x) => x.title === 'Guard Captain')].title = 'Captain of the Watch'; }));
ok('a Lead GM renames a court-set rank in the editor: it is a staff name now, no longer refused', p.resultKind === 'ok' && fRanks(LEAD, HOLD).some((x) => x.title === 'Captain of the Watch' && x.canon === 'Guard Captain'), p && p.result);
ok('...the rank keeps its own title and no override is written', !fs.existsSync(path.join(dir, 'guild-overrides.json')) && defsRanks().some((x) => x.title === 'Guard Captain'));
ev('courtAppoint', LEAD, 'N', 'bruma', 'Cyrus Fane', 'captain');
ok('...and the Guard Captain office still sets that rank, shown with its new name', defsRanks()[entry(HOLD, CAPT).rank].title === 'Guard Captain' && court(LEAD).household.members.find((m) => m.actorId === CAPT).title === 'Captain of the Watch');
p = send('factionRanksEdit', LEAD, HOLD, rows(LEAD, HOLD, (l) => { l[l.findIndex((x) => x.title === 'Captain of the Watch')].title = 'Guard Captain'; }));
ok('typing its own title back in the editor resets it', p.resultKind === 'ok' && fRanks(LEAD, HOLD).some((x) => x.title === 'Guard Captain' && !x.canon), p && p.result);
// A guild: a leader and a member
const FID = 'fighters-guild';
send('factionAdd', LEAD, FID, 'Boss'); fp(LEAD); send('factionAdd', LEAD, FID, 'Mate'); fp(LEAD); send('factionSetRank', LEAD, FID, BOSS, 0);
const own = globalThis.__dboGuildRankList(FID).map((x) => x.title);
fp(LEAD);
p = send('factionRanksEdit', LEAD, FID, rows(LEAD, FID, (l) => { l[1].title = 'Shield-Brother'; }));
ok('a Lead GM\'s rename of a guild rank is a staff name too', p.resultKind === 'ok' && fRanks(LEAD, FID)[1].title === 'Shield-Brother' && fRanks(LEAD, FID)[1].canon === own[1] && globalThis.__dboGuildRankList(FID)[1].title === own[1], p && p.result);
ok('...shown on what a character belongs to (title stays the key wages use)', (() => { const m = globalThis.__dboGuildsOf(MATE).find((g) => g.id === FID); return m && m.title === own[m.title === own[1] ? 1 : own.indexOf(m.title)] && typeof m.shown === 'string'; })());
fp(BOSS);
p = send('factionRanksEdit', BOSS, FID, rows(BOSS, FID, (l) => { l[2].title = 'Sword-Sister'; }));
ok('the leader renames another rank: the rank\'s own title, as before', p.resultKind === 'ok' && globalThis.__dboGuildRankList(FID)[2].title === 'Sword-Sister' && fs.existsSync(path.join(dir, 'guild-overrides.json')), p && p.result);
ok('...and the staff name on rank 1 is kept through the leader\'s save', fRanks(LEAD, FID)[1].title === 'Shield-Brother', fRanks(LEAD, FID)[1]);
fp(BOSS);
p = send('factionRanksEdit', BOSS, FID, rows(BOSS, FID, (l) => { l[1].title = 'Housecarl'; }));
ok('the leader cannot rename over a staff name', p.resultKind === 'refused' && /staff gave/.test(p.result) && fRanks(LEAD, FID)[1].title === 'Shield-Brother', p && p.result);
fp(BOSS);
p = send('factionRanksEdit', BOSS, FID, rows(BOSS, FID, (l) => { l[3].title = 'Blade 7'; }));
ok('a leader\'s own rename meets the same lettering rule', p.resultKind === 'refused' && /letters/.test(p.result), p && p.result);
// A Lead GM moves a rank below a staff-named one: the name follows its rank
fp(LEAD);
const before = fRanks(LEAD, FID).map((x) => x.canon || x.title);
p = send('factionRanksEdit', LEAD, FID, (() => { const l = rows(LEAD, FID); const moved = [l[0], l[2], l[1]].concat(l.slice(3)); return moved; })());
ok('a Lead GM moves ranks: the staff name follows its rank', p.resultKind === 'ok' && fRanks(LEAD, FID)[2].title === 'Shield-Brother' && fRanks(LEAD, FID)[2].canon === before[1], [p && p.result, fRanks(LEAD, FID).slice(0, 3)]);
// A rank that goes takes its staff name with it
fp(LEAD);
send('factionRanksEdit', LEAD, FID, rows(LEAD, FID).concat([{ title: 'Squire', role: 'member', from: -1 }]));
const sq = fRanks(LEAD, FID).findIndex((x) => x.title === 'Squire');
fp(LEAD);
send('factionRanksEdit', LEAD, FID, rows(LEAD, FID, (l) => { l[sq].title = 'Page'; }));
ok('setup: Squire is shown as Page', fRanks(LEAD, FID)[sq].title === 'Page' && stored().ranks[FID].squire);
fp(LEAD);
p = send('factionRanksEdit', LEAD, FID, rows(LEAD, FID).filter((x, i) => i !== sq));
ok('removing the rank removes its staff name', p.resultKind === 'ok' && !stored().ranks[FID].squire && stored().ranks[FID][before[1].toLowerCase()], [p && p.result, stored().ranks[FID]]);

// ---- /rolename -------------------------------------------------------------------------------------------------------------
let line = chat(LEAD, 'list bruma');
ok('/rolename list <court> lists the offices, named ones with their default', /steward = Reeve \(default Steward\)/.test(line) && /count = Count,/.test(line), line);
line = chat(LEAD, `list ${HOLD}`);
ok('/rolename list <faction> numbers the ranks', /2\. Reeve \(default Steward\)/.test(line), line);
line = chat(LEAD, 'whiterun jarl High King');
ok('/rolename <court> <office> <title> renames it', /Whiterun's Jarl is now called High King/.test(line) && rankTitle('jarl', 'whiterun') === 'High King', line);
line = chat(LEAD, `${HOLD} 4 Knight Errant`);
ok('/rolename <faction> <number> <title> renames a rank', /Knight is now called Knight Errant/.test(line) && court(LEAD).household.ranks[3].title === 'Knight Errant', line);
line = chat(LEAD, 'reset whiterun jarl');
ok('/rolename reset puts the default back', /Jarl again/.test(line) && rankTitle('jarl', 'whiterun') === 'Jarl', line);
ok('/rolename with a bad rank number says how', /by its number/.test(chat(LEAD, `${HOLD} x Knight`)));
ok('/rolename with nothing names the usage', /Usage/.test(chat(LEAD, '')));

// ---- it stays: a hot reload, a fresh load, regenerated data, the live guilds.js first --------------------------------------
loadAll();
ok('a hot reload keeps every name (they live in role-names.json)', office(LEAD, 'steward').title === 'Reeve' && court(LEAD).household.ranks[3].title === 'Knight Errant' && fRanks(LEAD, FID)[2].title === 'Shield-Brother');
ok('...and the handlers registered on reload still work', ev('courtRename', LEAD, 'N', 'bruma', 'office', 'courtmage', 'Court Wizard').kind === 'ok' && office(LEAD, 'courtmage').title === 'Court Wizard');
const members = JSON.parse(fs.readFileSync(path.join(dir, 'guilds.json'), 'utf8'));
delete globalThis.__dboGuildState; delete globalThis.__dboRoleNames; delete globalThis.__dboOfficeTitle;
loadAll();
ok('a fresh start reads them back from the file', office(LEAD, 'steward').title === 'Reeve' && court(LEAD).household.ranks[3].title === 'Knight Errant' && rankTitle('steward', 'bruma') === 'Reeve');
// guild-defs.json regenerated with a rank inserted above the Steward: members move by title, names follow their rank
const defs = JSON.parse(fs.readFileSync(path.join(dir, 'guild-defs.json'), 'utf8'));
defs.factions.find((f) => f.id === HOLD).ranks.splice(1, 0, { title: 'Chancellor', role: 'officer', added: '2026-10-05' });
fs.writeFileSync(path.join(dir, 'guild-defs.json'), JSON.stringify(defs));
delete globalThis.__dboGuildState;
loadAll();
ok('regenerated defs: Aldo keeps the Steward rank (now index 2) and it is still shown as Reeve', entry(HOLD, ALDO).rank === 2 && court(LEAD).household.members.find((m) => m.actorId === ALDO).title === 'Reeve' && court(LEAD).household.ranks[1].title === 'Chancellor', [entry(HOLD, ALDO), members[HOLD] && members[HOLD][String(ALDO)]]);
ok('...and the Knight Errant name followed the Knight rank down one', court(LEAD).household.ranks[4].title === 'Knight Errant' && court(LEAD).household.ranks[4].canon === 'Knight');
// The guilds.js this ships over (update-1004's, then the live server's) loaded first, then this one over the same state.
// No state key was added, so the names only need the new code's display path.
let liveSrc = '', liveRef = '';
for (const ref of ['origin/update-1004', 'origin/server']) { try { liveSrc = execFileSync('git', ['-C', ROOT, 'show', `${ref}:guilds.js`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); liveRef = ref; break; } catch (e) { liveSrc = ''; } }
if (liveSrc && !/__dboGuildRankList/.test(liveSrc)) {
  fs.writeFileSync(path.join(dir, 'guilds-live.js'), liveSrc);
  delete globalThis.__dboGuildState;
  loadAll(path.join(dir, 'guilds-live.js'));
  fp(LEAD);
  ok(`${liveRef}'s guilds.js shows the defaults (it does not know staff names)`, fRanks(LEAD, HOLD)[2].title === 'Steward', fRanks(LEAD, HOLD).slice(0, 3));
  loadAll();
  fp(LEAD);
  ok('...this guilds.js loaded over its state shows the names', fRanks(LEAD, HOLD)[2].title === 'Reeve' && court(LEAD).household.members.find((m) => m.actorId === ALDO).title === 'Reeve');
} else ok('the shipped guilds.js could not be read, or already has staff names: checked against itself only', true);
// The fork's zones.ts (the notice boards' bylines and "Only the ... may post" line): bundled from FORK_SERVER when it is
// set, and asked with and without a zone. A fork from before gm-rename-roles-zones has no zone argument: said, not failed.
{
  const fork = process.env.FORK_SERVER || process.env.FORK || '';
  const zts = fork && path.join(fork, 'skymp5-server', 'ts', 'systems', 'zones.ts');
  const esb = fork && path.join(fork, 'skymp5-server', 'node_modules', '.bin', 'esbuild');
  if (zts && fs.existsSync(zts) && fs.existsSync(esb) && /titleOf\(rank: string, zoneId\?: string\)/.test(fs.readFileSync(zts, 'utf8'))) {
    const out = path.join(dir, 'zones-bundle.js');
    execFileSync(esb, [zts, '--bundle', '--platform=node', '--format=cjs', `--outfile=${out}`, '--log-level=error']);
    fs.writeFileSync(path.join(dir, 'zones.json'), JSON.stringify({ holds: [{ id: 'whiterun', name: 'Whiterun', officials: ['jarl', 'steward'], capital: [0, 0] }], regions: [{ id: 'bruma', name: 'Bruma', officials: ['count', 'steward'], worldspaces: [] }], rankTitles: ZONES.rankTitles }));
    const Z = new (require(out).Zones)(() => {});
    ok('the fork\'s zones.ts titleOf asks the hook for a zone: Bruma\'s Steward is Reeve on a new notice', Z.titleOf('steward', 'bruma') === 'Reeve' && Z.titleOf('steward', 'whiterun') === 'Steward' && Z.titleOf('steward') === 'Steward', [Z.titleOf('steward', 'bruma'), Z.titleOf('steward')]);
    const keep = globalThis.__dboOfficeTitle; globalThis.__dboOfficeTitle = () => { throw new Error('x'); };
    ok('...and a hook that throws gives zones.json\'s title', Z.titleOf('steward', 'bruma') === 'Steward');
    globalThis.__dboOfficeTitle = keep;
  } else console.log(`ok   the fork's zones.ts was not checked (${zts && fs.existsSync(zts) ? 'it has no zone-aware titleOf: notice boards show zones.json titles' : 'no FORK_SERVER'})`);
}
// rolenames.js gone: everything falls back to the defaults, and the editor renames ranks as before
delete globalThis.__dboRoleNames; delete globalThis.__dboOfficeTitle;
ok('without rolenames.js every title is the default', rankTitle('steward', 'bruma') === 'Steward' && court(LEAD).household.ranks[2].title === 'Steward' && !court(LEAD).canName);

for (const k of ['__dboJournalFresh', '__dboJournalLimited']) delete globalThis[k];
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* temp */ }
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
