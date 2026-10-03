// The F3 journal's Court tab (court.js, piece H9): the officials functions cut from gamemode.js (APPOINT_RULES to the
// Scholar section, shared by /appoint and the tab), the real guilds.js with the real guild-defs.json, and court.js, run
// against stubs in a temp folder. Covers: staff seat outright, a ruler's appointment is an offer the target accepts or
// declines, an offer re-checked at acceptance (the ruler lost the seat, the seats filled), expiry after 24 h, the office
// setting the household rank (Count -> leader, Guard -> Guard, Steward -> joins as Citizen) and unseating dropping it,
// moving an official, the household's own rank actions, the views per player kind, stale nonces, /appoint by a ruler.
//
//   node tests/court-harness.js   (from server/)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'gamemode.js'), 'utf8');
const start = src.indexOf('const APPOINT_RULES = ');
const end = src.indexOf('// ---- Scholar');
if (start < 0 || end < start || !/const appointCheck = /.test(src.slice(start, end))) { console.log('FAIL the shared officials functions are not in gamemode.js'); process.exit(1); }
if (!fs.existsSync(path.join(ROOT, 'court.js'))) { console.log('FAIL court.js is missing'); process.exit(1); }
const section = src.slice(start, end) + '\nreturn { APPOINT_RULES, appointCap, appointCheck, appointFrom, seatOfficial, unseatOfficial, officialTarget, officialName, accountActors };';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-court-'));
fs.copyFileSync(path.join(ROOT, 'guild-defs.json'), path.join(dir, 'guild-defs.json'));
process.chdir(dir);

let fails = 0;
const ok = (label, cond, got) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${!cond && got !== undefined ? `: got ${JSON.stringify(got)}` : ''}`); if (!cond) fails++; };

// ---- the world --------------------------------------------------------------------------------------------------------
const ADMIN = 0x10, COUNT = 0x14, ALDO = 0x15, BRAN = 0xff000200, CAPT = 0x16, OUT = 0x17, KNIGHT = 0x18;
const chars = new Map([
  [ADMIN, { pid: 1, name: 'Admin', tag: 'AAAA', online: true, race: 'ImperialRace' }],
  [COUNT, { pid: 11, name: 'Narina Carvain', tag: 'CNT1', online: true, race: 'ImperialRace' }],
  [ALDO, { pid: 12, name: 'Aldo Varro', tag: 'ALD1', online: true, race: 'ImperialRace' }],
  [BRAN, { pid: 13, name: 'Bran Hollow', tag: 'BRN1', online: false, race: 'NordRace' }],
  [CAPT, { pid: 14, name: 'Cyrus Fane', tag: 'CPT1', online: true, race: 'BretonRace' }],
  [OUT, { pid: 15, name: 'Outsider', tag: 'OUT1', online: true, race: 'NordRace' }],
  [KNIGHT, { pid: 16, name: 'Kesta', tag: 'KST1', online: true, race: 'NordRace' }],
]);
const zones = [
  { id: 'bruma', name: 'Bruma', treasury: '79b22:BSHeartland.esm', officials: ['count', 'steward', 'captain', 'courtmage', 'guard'], worldspaces: [] },
  { id: 'whiterun', name: 'Whiterun', capital: 'x', officials: ['jarl', 'steward', 'commander', 'courtmage', 'guardcaptain', 'guard'] },
  { id: 'largashbur', name: 'Largashbur', center: [0, 0, 0], officials: ['chieftain', 'bane', 'shaman', 'wisewoman', 'strongholdcommander', 'strongholdguard'] },
];
const TITLES = { count: 'Count', steward: 'Steward', captain: 'Guard Captain', courtmage: 'Court Mage', guard: 'Guard', jarl: 'Jarl', commander: 'Hold Commander', guardcaptain: 'Guard Captain', chieftain: 'Chieftain', bane: 'Bane', shaman: 'Shaman', wisewoman: 'Wise-Woman', strongholdcommander: 'Stronghold Guard Commander', strongholdguard: 'Stronghold Guard' };
let officials = {};
const told = [], audits = [], props = new Map(), said = [];
const online = () => [...chars.entries()].filter(([, c]) => c.online).map(([id]) => id);
const byName = (q) => [...chars.entries()].filter(([, c]) => c.name.toLowerCase() === q.toLowerCase()).map(([id]) => id);
const byTag = (q) => [...chars.entries()].filter(([, c]) => c.tag.toLowerCase() === q.toLowerCase()).map(([id]) => id);
const findByName = (q) => { const s = String(q).trim().replace(/^#/, ''); const t = byTag(s).concat(byName(String(q).trim())).filter((id) => chars.get(id).online); return t[0] || 0; };
const findAnyByName = (q) => {
  const on = findByName(q); if (on) return on;
  const s = String(q).trim().replace(/^#/, ''); const t = byTag(s); if (t.length) return t[0];
  const r = byName(String(q).trim()); return r.length === 1 ? r[0] : r.length > 1 ? -r.length : 0;
};
const RACES = new Map([...chars.values()].map((c, i) => [100 + i, c.race]));
const raceIdOf = (a) => 100 + [...chars.keys()].indexOf(a);
const mp = {
  get: (id, k) => {
    if (k === 'appearance') return chars.has(id) ? { name: chars.get(id).name, raceId: raceIdOf(id) } : null;
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
const isAdmin = (a) => a === ADMIN;
const tierOf = (a) => (a === ADMIN ? 'developer' : null);
const zoneList = () => zones;
const zoneById = (id) => zones.find((z) => z.id === String(id).toLowerCase()) || null;
const ranksOf = (pid) => { const out = []; for (const z of zones) for (const r of Object.keys(officials[z.id] || {})) if ((officials[z.id][r] || []).map(Number).includes(pid)) out.push({ zone: z, rank: r }); return out; };
const handlers = {};
const onUi = (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); };
const base = {
  mp, log: () => {}, personal: (a, t) => said.push(t), system: (a, text) => told.push({ a, text }), audit: (t) => audits.push(t), cfg: {},
  isAdmin, isLeadStaff: isAdmin, tierOf, profileOf, nameOf, tagOf, display, who, findByName, findAnyByName, onUi,
  onlineActors: online, userOf: (a) => (chars.has(a) && chars.get(a).online ? 1 : -1), seen: new Map(),
  zoneList, zoneById, ranksOf, rankTitle: (r) => TITLES[r] || r,
  readOfficials: () => JSON.parse(JSON.stringify(officials)), writeOfficials: (o) => { officials = JSON.parse(JSON.stringify(o)); },
  registerChatCommand: (n, f) => { commands.set(n, f); }, openWidget: () => {}, closeWidget: () => {},
};
const commands = new Map();
const O = new Function(...Object.keys(base), section)(...Object.values(base));
require(path.join(ROOT, 'guilds.js'))(base);
// The journal shell's two hooks (H1): the nonce is 'N'; limited answers at once and keeps the answer
const answers = [];
globalThis.__dboJournalFresh = (a, n) => n === 'N';
globalThis.__dboJournalLimited = (a, fn) => { answers.push(Object.assign({ a }, fn())); };
const court = require(path.join(ROOT, 'court.js'))(Object.assign({}, base, O));
const sec = globalThis.__dboJournalSections.court;
const ev = (name, a, ...args) => { answers.length = 0; told.length = 0; for (const f of handlers[name] || []) f(a, args); return answers[answers.length - 1] || null; };
const household = () => (globalThis.__dboGuildState.members['county-bruma'] || {});
const hhTitle = (a) => { const e = household()[String(a >>> 0)]; if (!e) return null; return JSON.parse(fs.readFileSync(path.join(dir, 'guild-defs.json'), 'utf8')).factions.find((f) => f.id === 'county-bruma').ranks[e.rank].title; };
const seated = (z, r) => (officials[z] && officials[z][r]) || [];

// ---- staff seat outright -----------------------------------------------------------------------------------------------
ok('the Court tab is registered', sec && typeof sec.view === 'function' && typeof sec.visible === 'function');
ok('staff always see the tab; an outsider does not', sec.visible(ADMIN) === true && sec.visible(OUT) === false);
let r = ev('courtAppoint', ADMIN, 'N', 'bruma', 'Narina Carvain', 'count');
ok('staff appoint outright: Narina is Count', seated('bruma', 'count').includes(11) && r && r.kind === 'ok' && /is now Count of Bruma/.test(r.text), [r, officials]);
ok('the office sets the household rank: Count (the leader)', hhTitle(COUNT) === 'Count', hhTitle(COUNT));
ok('the Count sees the tab now', sec.visible(COUNT) === true);

// ---- a ruler offers, the target accepts ----------------------------------------------------------------------------------
r = ev('courtAppoint', COUNT, 'N', 'bruma', 'Aldo Varro', 'steward');
ok('a ruler\'s appointment is an offer: not seated yet', !seated('bruma', 'steward').includes(12) && r.kind === 'ok' && /offered Aldo Varro/.test(r.text), [r, officials]);
ok('the target is told in chat, with where to answer', told.some((t) => t.a === ALDO && /offers you the post of Steward of Bruma.*F3.*Court/.test(t.text)), told);
ok('the offer is in court-offers.json', JSON.parse(fs.readFileSync(path.join(dir, 'court-offers.json'), 'utf8')).length === 1);
const vAldo = sec.visible(ALDO);
ok('the target sees the tab with a badge', vAldo && vAldo.badge === 1, vAldo);
let view = sec.view(ALDO);
ok('the target\'s view lists the offer, and only Bruma', view.offers.length === 1 && view.offers[0].title === 'Steward' && view.offers[0].from === 'Narina Carvain #CNT1' && view.courts.length === 1 && view.courts[0].id === 'bruma', view);
const offerId = view.offers[0].id;
ok('a stale nonce does nothing', ev('courtAnswer', ALDO, 'old', offerId, 'accept') === null && !seated('bruma', 'steward').includes(12));
ok('someone else cannot accept it', ev('courtAnswer', CAPT, 'N', offerId, 'accept').kind === 'refused' && !seated('bruma', 'steward').includes(12));
r = ev('courtAnswer', ALDO, 'N', offerId, 'accept');
ok('accepting seats them', seated('bruma', 'steward').includes(12) && r.kind === 'ok' && /You are now Steward of Bruma/.test(r.text), [r, officials]);
ok('the one who offered is told', told.some((t) => t.a === COUNT && /accepted the post of Steward/.test(t.text)), told);
ok('the audit names the offer', audits.some((t) => /appointed Aldo Varro #ALD1 \(profile 12\) Steward of Bruma, offered and accepted/.test(t)), audits.slice(-2));
ok('a Steward has no household rank of its own: Aldo joins as Citizen', hhTitle(ALDO) === 'Citizen', hhTitle(ALDO));
ok('the offer is gone', sec.view(ALDO).offers.length === 0 && sec.visible(ALDO) === true);

// ---- decline, withdraw, re-check at acceptance --------------------------------------------------------------------------
ev('courtOffer', COUNT, 'N', 'bruma', 'Cyrus Fane', 'captain');
let id = sec.view(CAPT).offers[0].id;
r = ev('courtAnswer', CAPT, 'N', id, 'decline');
ok('declining: not seated, the ruler told', !seated('bruma', 'captain').includes(14) && /declined/.test(r.text) && told.some((t) => t.a === COUNT && /declined the post of Guard Captain/.test(t.text)), [r, told]);
ev('courtOffer', COUNT, 'N', 'bruma', 'Cyrus Fane', 'captain');
id = sec.view(CAPT).offers[0].id;
ok('a plain player cannot withdraw it', ev('courtWithdraw', CAPT, 'N', id).kind === 'refused');
r = ev('courtWithdraw', COUNT, 'N', id);
ok('the one who offered withdraws it', r.kind === 'ok' && sec.view(CAPT).offers.length === 0, r);
ev('courtOffer', COUNT, 'N', 'bruma', 'Cyrus Fane', 'captain');
id = sec.view(CAPT).offers[0].id;
ev('courtDismiss', ADMIN, 'N', 'bruma', 11);
ok('dismissing the Count drops their household rank to Citizen', !seated('bruma', 'count').includes(11) && hhTitle(COUNT) === 'Citizen', [officials, hhTitle(COUNT)]);
r = ev('courtAnswer', CAPT, 'N', id, 'accept');
ok('an offer from a ruler who lost the seat no longer stands', r.kind === 'refused' && /no longer stands/.test(r.text) && !seated('bruma', 'captain').includes(14), r);
ok('it is gone after that', sec.view(CAPT).offers.length === 0);

// ---- seats fill ---------------------------------------------------------------------------------------------------------
ev('courtAppoint', ADMIN, 'N', 'bruma', 'Narina Carvain', 'count');
ok('the Count is back, and leads the household again', hhTitle(COUNT) === 'Count', hhTitle(COUNT));
ev('courtOffer', COUNT, 'N', 'bruma', 'Cyrus Fane', 'captain');
ev('courtOffer', COUNT, 'N', 'bruma', 'Kesta', 'captain');
ev('courtAnswer', CAPT, 'N', sec.view(CAPT).offers[0].id, 'accept');
ok('the first to accept is Guard Captain, with the household rank', seated('bruma', 'captain').includes(14) && hhTitle(CAPT) === 'Guard Captain', [officials, hhTitle(CAPT)]);
r = ev('courtAnswer', KNIGHT, 'N', sec.view(KNIGHT).offers[0].id, 'accept');
ok('the second finds the one seat taken', r.kind === 'refused' && /already has 1 Guard Captain/.test(r.text) && !seated('bruma', 'captain').includes(16), r);

// ---- move and dismiss ---------------------------------------------------------------------------------------------------
r = ev('courtMove', COUNT, 'N', 'bruma', 12, 'guard');
ok('a ruler moves a serving Steward to Guard without an offer', seated('bruma', 'guard').includes(12) && !seated('bruma', 'steward').includes(12) && r.kind === 'ok', [r, officials]);
ok('the household follows: Guard', hhTitle(ALDO) === 'Guard', hhTitle(ALDO));
// A re-seat by staff from one office straight into another gives up the old office's household rank (R-f3b 3)
ev('courtAppoint', ADMIN, 'N', 'bruma', 'Cyrus Fane', 'courtmage');
ok('staff re-seat: the Guard Captain becomes Court Mage and leaves the Guard Captain rank', seated('bruma', 'courtmage').includes(14) && !seated('bruma', 'captain').includes(14) && hhTitle(CAPT) === 'Battlemage', [officials.bruma, hhTitle(CAPT)]);
ev('courtMove', ADMIN, 'N', 'bruma', 14, 'captain');
ok('...and moved back, Guard Captain again', seated('bruma', 'captain').includes(14) && hhTitle(CAPT) === 'Guard Captain', hhTitle(CAPT));
ok('moving someone with no office is refused', ev('courtMove', COUNT, 'N', 'bruma', 15, 'guard').kind === 'refused');
r = ev('courtDismiss', COUNT, 'N', 'bruma', 12);
ok('dismissing a Guard drops them to Citizen', !seated('bruma', 'guard').includes(12) && hhTitle(ALDO) === 'Citizen' && r.kind === 'ok', [r, hhTitle(ALDO)]);

// ---- the household's own actions -------------------------------------------------------------------------------------
r = ev('courtRank', ADMIN, 'N', 'bruma', ALDO, 0);
ok('the household head follows the office: courtRank cannot make a second Count, staff included', r.kind === 'refused' && /follows the court's office/.test(r.text) && hhTitle(ALDO) !== 'Count' && hhTitle(COUNT) === 'Count', [r, hhTitle(ALDO), hhTitle(COUNT)]);
r = ev('courtRank', ADMIN, 'N', 'bruma', COUNT, 8);
ok('...nor take the Count\'s rank away', r.kind === 'refused' && hhTitle(COUNT) === 'Count', r);
r = ev('courtRank', COUNT, 'N', 'bruma', ALDO, 2);
ok('the Count sets a household rank (Knight)', hhTitle(ALDO) === 'Knight' && r.kind === 'ok', [r, hhTitle(ALDO)]);
ok('a Citizen cannot', ev('courtRank', ALDO, 'N', 'bruma', COUNT, 8).kind === 'refused' && hhTitle(COUNT) === 'Count');
r = ev('courtInvite', COUNT, 'N', 'bruma', 'Kesta');
ok('the Count invites into the household', r.kind === 'ok' && told.some((t) => t.a === KNIGHT && /invites you to join County of Bruma/.test(t.text)), r);
view = sec.view(COUNT);
const hh = view.courts[0].household;
ok('the household view lists members, ranks and the invite out', hh && hh.id === 'county-bruma' && hh.members.length === 3 && hh.ranks.length === 9 && hh.pending.some((p) => p.name === 'Kesta'), hh && { members: hh.members.length, pending: hh.pending });
r = ev('courtKick', COUNT, 'N', 'bruma', ALDO);
ok('the Count removes a household member', !household()[String(ALDO)] && r.kind === 'ok', r);

// ---- views --------------------------------------------------------------------------------------------------------------
view = sec.view(ADMIN);
ok('staff see every court', view.staff === true && view.courts.length === 3 && view.courts.map((c) => c.kind).join() === 'region,hold,stronghold', view.courts.map((c) => [c.id, c.kind]));
const bruma = view.courts.find((c) => c.id === 'bruma');
const capt = bruma.offices.find((o) => o.rank === 'captain');
ok('an office shows its holders by name and #TAG, and its seats', capt.holders.length === 1 && capt.holders[0].name === 'Cyrus Fane' && capt.holders[0].tag === 'CPT1' && capt.seats === 1 && bruma.offices.find((o) => o.rank === 'guard').seats === 20, capt);
ok('staff may fill every office', bruma.appointable.length === 5);
view = sec.view(COUNT);
ok('the Count sees Bruma only, and may fill the offices below the Count', view.courts.length === 1 && view.courts[0].appointable.map((x) => x.rank).join() === 'steward,captain,courtmage,guard', view.courts[0].appointable);
ok('a court member who holds no office sees no treasury', sec.view(KNIGHT).courts.length === 0 || sec.view(KNIGHT).courts.every((c) => c.treasury === null));
ok('an outsider cannot act in Bruma', ev('courtAppoint', OUT, 'N', 'bruma', 'Kesta', 'guard').kind === 'refused' && !seated('bruma', 'guard').includes(16));
ok('a ruler cannot appoint in another hold', ev('courtOffer', COUNT, 'N', 'whiterun', 'Kesta', 'steward').kind === 'refused');
ok('nobody offers a post to themselves', /yourself/.test(ev('courtOffer', COUNT, 'N', 'bruma', 'Narina Carvain', 'guard').text));
ok('an unknown office is refused', ev('courtOffer', COUNT, 'N', 'bruma', 'Kesta', 'emperor').kind === 'refused');

// ---- /appoint goes the same way ---------------------------------------------------------------------------------------
base.personal = (a, t) => said.push(t);
const O2 = new Function(...Object.keys(base), section)(...Object.values(base));
O2.appointFrom(COUNT, zoneById('bruma'), 'guard', O2.officialTarget('Bran Hollow'), false);
ok('/appoint by a ruler is an offer too, offline targets included', !seated('bruma', 'guard').includes(13) && sec.view(COUNT).courts[0].outgoing.some((o) => o.name === 'Bran Hollow #BRN1' && o.title === 'Guard'), sec.view(COUNT).courts[0].outgoing);
const out = O2.appointFrom(ADMIN, zoneById('bruma'), 'guard', O2.officialTarget('Kesta'), false);
ok('/appoint by staff seats outright', seated('bruma', 'guard').includes(16) && /is now Guard of Bruma/.test(out.text) && hhTitle(KNIGHT) === 'Guard', [out, hhTitle(KNIGHT)]);

// ---- an offer redraws an open Court tab; /court answers in chat for today's journal (R-f3b 6) ---------------------------
const redrawn = [];
globalThis.__dboJournalTabOf = (a) => (a === KNIGHT ? 'court' : a === OUT ? 'profile' : '');
globalThis.__dboJournalRedraw = (a, tab) => { redrawn.push([a, tab]); return true; };
ev('courtOffer', COUNT, 'N', 'bruma', 'Kesta', 'steward');
ev('courtOffer', COUNT, 'N', 'bruma', 'Outsider', 'steward');
ok('an offer redraws the target\'s journal when it is open on Court, and only then', redrawn.length === 1 && redrawn[0][0] === KNIGHT && redrawn[0][1] === 'court', redrawn);
ok('...the chat line names /court accept', told.some((t) => t.a === OUT && /\/court accept/.test(t.text)), told);
delete globalThis.__dboJournalTabOf; delete globalThis.__dboJournalRedraw;
const chat = (a, args) => { said.length = 0; commands.get('court')(a, args); return said.join(' | '); };
let line = chat(OUT, 'offers');
ok('/court offers lists the posts offered, numbered', /1\. Steward of Bruma, offered by Narina Carvain #CNT1/.test(line), line);
line = chat(OUT, '');
ok('/court alone answers in chat on today\'s journal (no hub shell): it never opens Profile', /Posts offered to you/.test(line), line);
line = chat(OUT, 'accept');
ok('/court accept takes the only offer', seated('bruma', 'steward').includes(15) && /You are now Steward of Bruma/.test(line), [line, officials.bruma]);
line = chat(OUT, 'decline');
ok('/court decline with nothing offered says so', /No post is offered to you/.test(line), line);
ev('courtOffer', ADMIN, 'N', 'whiterun', 'Kesta', 'steward');
ok('offers from two courts both stand', sec.view(KNIGHT).offers.length === 2, sec.view(KNIGHT).offers.map((o) => o.zone));
ev('courtOffer', COUNT, 'N', 'bruma', 'Kesta', 'courtmage');
ok('...a second offer from the same court replaces its first', sec.view(KNIGHT).offers.length === 2 && sec.view(KNIGHT).offers.some((o) => o.rank === 'courtmage') && !sec.view(KNIGHT).offers.some((o) => o.zone === 'bruma' && o.rank === 'steward'), sec.view(KNIGHT).offers.map((o) => o.rank));
line = chat(KNIGHT, 'accept');
ok('with two offers /court accept asks which', /Which one\?/.test(line) && !seated('bruma', 'steward').includes(16), line);
line = chat(KNIGHT, 'decline 2');
ok('/court decline <number> declines that one', /declined/.test(line) && sec.view(KNIGHT).offers.length === 1, [line, sec.view(KNIGHT).offers]);

// ---- expiry -------------------------------------------------------------------------------------------------------------
const realNow = Date.now;
Date.now = () => realNow() + 25 * 3600000;
ok('offers expire after 24 hours', sec.view(COUNT).courts[0].outgoing.length === 0 && sec.view(ADMIN).courts[0].outgoing.length === 0);
Date.now = realNow;

for (const k of ['__dboJournalFresh', '__dboJournalLimited']) delete globalThis[k];
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* temp */ }
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
