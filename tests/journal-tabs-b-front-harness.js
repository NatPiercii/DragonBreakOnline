// The F3 journal's Skills, Court and Faction staff tabs (skymp5-front, pieces H6, H8, H9 on the client-f3-shell hub):
// renders the real journal with React's static renderer for the sections gameplay journalskills.js, court.js and
// guilds.js send. Skills: the Wheel, the lore and rule lines, the moons, the five tiers with their lines, a focus.
// Court: an offer card, the offices with their seats and the appoint row, the household with its rank pickers.
// Faction: the staff browser, member actions for a Lead GM and none for a GM, the rank editor (a leader renames only),
// holds kept off a player's Faction tab.
//
//   node tests/journal-tabs-b-front-harness.js <bundle of skymp5-front/src/features/journal/index.tsx>
//
// A front without these tabs has nothing to test, which is said and not failed unless a gate expects it.
'use strict';
const fs = require('fs');

const bundle = process.argv[2];
if (!bundle) { console.log('usage: node tests/journal-tabs-b-front-harness.js <bundle>'); process.exit(2); }
const SRC = fs.readFileSync(bundle, 'utf8');
if (!/journal-skills__page/.test(SRC) || !/court__office/.test(SRC)) {
  require('./expect')('journal-tabs-b', 'this front has no Skills or Court tab');
  console.log('ok   skipped: this front has no Skills or Court tab');
  process.exit(0);
}
const J = require(bundle);
const { Widget: Journal, renderToStaticMarkup, createElement } = J;

let failures = 0;
const check = (label, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && got !== undefined ? '   ' + JSON.stringify(got).slice(0, 400) : ''}`); if (!ok) failures++; };
const render = (data) => renderToStaticMarkup(createElement(Journal, { data }));
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ');
const hub = (tab, extra) => Object.assign({ type: 'journal', id: 50, nonce: 'n1', hub: 1, tab,
  tabs: [{ id: 'profile', label: 'Profile' }, { id: 'faction', label: 'Faction' }, { id: 'court', label: 'Court' }, { id: 'skills', label: 'Skills' }, { id: 'stats', label: 'Stats' }],
  head: { name: 'Narina Carvain', title: 'Adept Knight', race: 'Imperial' }, clock: { date: '1st of Frostfall, 4E 211', time: '9:00 in the morning' } }, extra || {});

check('the HUD announces both tabs (journalTab:skills, journalTab:court)', J.journalCaps().includes('journalTab:skills') && J.journalCaps().includes('journalTab:court'), J.journalCaps());

// ---- Skills ------------------------------------------------------------------------------------------------------
const skill = (id, category, label, title, extra) => Object.assign({ id, category, label, title, description: `${label} rule text.`, tiers: ['t0', 't1', 't2', 't3', 't4'], openable: 'station', hint: 'a forge', lore: '', tierLore: [] }, extra || {});
const menu = (extra) => Object.assign({
  points: { enabled: true, pool: 300, used: 44, capPerSkill: 100, seatAbove: 90, seatCount: 1, expertAbove: 75, expertCount: 3, transferFloor: 25,
    held: [{ id: 'defense', level: 52, xp: 40, tier: 2, lock: 'hold' }, { id: 'blade', level: 30, xp: 10, tier: 1, lock: 'raise' }], offers: [{ id: 'archery', banked: 3 }] },
  maxChosen: 3, tierNames: ['Novice', 'Apprentice', 'Adept', 'Expert', 'Master'], tierHours: [0, 10, 30, 70, 150],
  categories: [{ id: 'combat', label: 'Combat' }, { id: 'profession', label: 'Professions' }, { id: 'support', label: 'Support' }],
  skills: [
    skill('defense', 'combat', 'Defense', 'The Iron Wall', { lore: 'The shield-wall of the Nords: the art of standing where others fall.', tierLore: ['L0', 'L1', 'Adept line', 'L3', 'L4'] }),
    skill('blade', 'combat', 'Blade', 'The Honed Edge'), skill('archery', 'combat', 'Archery', 'The Far Reach'), skill('arcane', 'combat', 'Arcane Arts', 'The Ordered Mind'),
    skill('blacksmith', 'profession', 'Blacksmith', 'The Anvil'),
  ],
  chosen: [], respec: { open: false, free: true, cost: 0, count: 0 },
}, extra || {});
let html = render(hub('skills', { skills: menu() }));
let t = text(html);
check('Skills: the tab draws in the journal body, in the violet', /journal__body--skills" data-domain="dragonbreak"/.test(html));
check('...the Wheel: 44 / 300 spokes', /44 \/ 300/.test(t) && /spokes of the Wheel/.test(t), t.slice(0, 200));
check('...the groups and every skill in the list', /Combat/.test(t) && /Professions/.test(t) && (html.match(/class="mastery__item[ "]/g) || []).length === 5);
check('...the first held skill opens: name, epithet, lore line and rule apart', /Defense/.test(t) && /The Iron Wall/.test(t) && /journal-skills__lore">The shield-wall/.test(html) && /journal-skills__rules">Defense rule text/.test(html), t.slice(0, 400));
check('...level of its ceiling, the tier and the three modes in plain words', /52 of 100/.test(t) && /Raise/.test(t) && /Hold/.test(t) && /Lower/.test(t) && /mastery__lock mastery__lock--on[^>]*>[^<]*<span class="mastery__lock-glyph">●/.test(html));
check('...the floor line from the server (Lower down to its floor, raised skills down to 25)', /points come from a skill set to Lower/.test(t) && /down to 25\)/.test(t), t.slice(0, 600));
check('...five tiers, Adept for tier 3, with its line, the current marked and the higher dimmed', /Adept/.test(t) && /mastery__rank-lore">Adept line/.test(html) && (html.match(/mastery__rank--reached/g) || []).length === 3 && /mastery__rank--current/.test(html) && !/Journeyman/.test(t));
check('...the epigraph once', (t.match(/Time broke over Nirn/g) || []).length === 1);
html = render(hub('skills', { skills: menu({ focus: 'archery' }) }));
t = text(html);
check('a focus (Profile\'s meter) opens that skill; an offer shows Take up', /Archery/.test(t) && /Take up Archery/.test(t) && /3 unit\(s\) of work/.test(t), t.slice(0, 300));
html = render(hub('skills', { skills: menu({ focus: 'blacksmith' }) }));
check('an untaken station skill names its station', /Set your hand to a forge/.test(text(html)));
html = render(hub('skills', { skills: menu({ focus: 'arcane' }) }));
check('Arcane Arts links to the Magic tab only when this front draws it', !/Open Magic/.test(text(html)) || Object.keys(J.JOURNAL_TABS).includes('magic'));
html = render(hub('skills', { skills: null }));
check('no section from the server: the page says so', /This page cannot be shown just now/.test(text(html)));

// ---- Court -------------------------------------------------------------------------------------------------------
const office = (rank, title, seats, holders, canAppoint) => ({ rank, title, seats, holders, canAppoint });
const court = (extra) => Object.assign({
  staff: false, outright: false, selected: 'bruma',
  offers: [{ id: 'c1', zone: 'bruma', zoneName: 'Bruma', rank: 'steward', title: 'Steward', from: 'Narina Carvain #CNT1', at: Date.now(), expiresAt: Date.now() + 20 * 3600000 }],
  courts: [{ id: 'bruma', name: 'Bruma', kind: 'region', mine: true, treasury: 1200,
    offices: [office('count', 'Count', 1, [{ pid: 11, name: 'Narina Carvain', tag: 'CNT1', online: true }], false), office('steward', 'Steward', 5, [{ pid: 12, name: 'Aldo Varro', tag: 'ALD1', online: false }], true),
      office('captain', 'Guard Captain', 1, [{ pid: 14, name: 'Cyrus Fane', tag: 'CPT1', online: true }], true), office('guard', 'Guard', 20, [], true)],
    outgoing: [{ id: 'c2', name: 'Bran Hollow #BRN1', rank: 'guard', title: 'Guard', from: 'Narina Carvain #CNT1', at: Date.now(), expiresAt: Date.now() + 5 * 3600000 }],
    appointable: [{ rank: 'steward', title: 'Steward' }, { rank: 'captain', title: 'Guard Captain' }, { rank: 'guard', title: 'Guard' }],
    household: { id: 'county-bruma', name: 'County of Bruma', myRank: 0, canInvite: true, canKick: true, canSetRank: true,
      ranks: [{ title: 'Count', role: 'leader' }, { title: 'Guard Captain', role: 'officer' }, { title: 'Citizen', role: 'member' }],
      members: [{ actorId: 20, name: 'Narina Carvain', tag: 'CNT1', rank: 0, title: 'Count', role: 'leader', online: true }, { actorId: 21, name: 'Aldo Varro', tag: 'ALD1', rank: 2, title: 'Citizen', role: 'member', online: false }],
      pending: [{ actorId: 22, name: 'Kesta', from: 'Narina Carvain', at: Date.now() }] } }],
}, extra || {});
html = render(hub('court', { court: court() }));
t = text(html);
check('Court: the tab draws in the aqua', /journal__body--court" data-domain="aqua"/.test(html));
check('...an offer card with Accept and Decline, no pushed widget', /Offered: Steward of Bruma/.test(t) && /Accept/.test(t) && /Decline/.test(t), t.slice(0, 300));
check('...the court of Bruma (a region) and its treasury', /Court of Bruma/.test(t) && /1200 gold/.test(t));
check('...each office with holders and seats (Steward 1 / 5), offline marked', /Steward 1 \/ 5/.test(t) && /Aldo Varro #ALD1 \(offline\)/.test(t) && /Vacant/.test(t), t.slice(0, 600));
check('...the offices the viewer fills have Dismiss, Move to and an Offer row; the Count has none', (t.match(/Dismiss/g) || []).length === 2 && /Move to/.test(t) && (t.match(/Offer the post/g) || []).length === 2 && !/>Appoint</.test(html), (t.match(/Offer the post/g) || []).length);
check('...a full office has no offer row (Guard Captain 1 / 1)', /Guard Captain 1 \/ 1/.test(t));
check('...the offers waiting, with Withdraw', /Offers waiting/.test(t) && /Bran Hollow #BRN1: Guard/.test(t) && /Withdraw/.test(t));
check('...the household with rank pickers, Remove, Invite and who is invited', /County of Bruma/.test(t) && /dbo-picker/.test(html) && /Remove/.test(t) && /Invite/.test(t) && /Invited: Kesta/.test(t));
check('...no native <select> anywhere', !/<select/.test(html));
check('...the head (the Count) shows a title, not a rank picker; the other member keeps theirs', (html.match(/court__rank/g) || []).length === 1 && /court__member-title">Count</.test(html), (html.match(/court__rank/g) || []).length);
html = render(hub('court', { court: court({ staff: true, outright: true, offers: [] }) }));
t = text(html);
check('staff: a search over the courts, and Appoint beside Offer', /Search courts/.test(html) && /Holds/.test(t) && />Appoint</.test(html));
html = render(hub('court', { court: court({ courts: [], offers: [] }) }));
check('a court list with nothing in it says so', /You serve no court yet/.test(text(html)));

// ---- Court: a Lead GM renames offices and household ranks (rolenames.js, gm-rename-roles) ------------------------------
if (/court__rename/.test(SRC)) {
  const named = court({ staff: true, outright: true, offers: [] });
  const c0 = named.courts[0];
  c0.canName = true;
  c0.offices[1] = Object.assign({}, c0.offices[1], { title: 'Reeve', named: true, default: 'Steward' });
  c0.household.ranks[1] = { title: 'Captain of the Watch', role: 'officer', canon: 'Guard Captain' };
  html = render(hub('court', { court: named }));
  t = text(html);
  check('names: every office and every household rank has Rename', (t.match(/Rename/g) || []).length === c0.offices.length + c0.household.ranks.length, (t.match(/Rename/g) || []).length);
  check('...a renamed office shows its default beside it, with Default', /Reeve \(Steward\)/.test(t) && /title="Back to Steward"/.test(html), t.slice(0, 500));
  check('...the household\'s Rank names list, a renamed rank with its own title', /Rank names/.test(t) && /Captain of the Watch \(Guard Captain\)/.test(t) && /title="Back to Guard Captain"/.test(html));
  check('...only the renamed ones have Default', (html.match(/title="Back to /g) || []).length === 2);
  html = render(hub('court', { court: court({ staff: true, outright: true, offers: [] }) }));
  check('without canName (a plain GM, a ruler) there is no Rename and no Rank names', !/Rename|Rank names/.test(text(html)));
} else check('this front has no office rename (gm-rename-roles front): not checked', true);

// ---- Faction: the staff view --------------------------------------------------------------------------------------
const member = (actorId, name, rank, title, role) => ({ actorId, name, tag: 'T' + actorId, rank, title, role, online: true });
const fview = (extra) => Object.assign({ id: 'fighters-guild', name: 'Fighters Guild', kind: 'guild', secret: false, prince: '', myRank: -1, myTitle: '', canInvite: true, canKick: true, canSetRank: true,
  ranks: [{ title: 'Guildmaster', role: 'leader' }, { title: 'Champion', role: 'officer' }, { title: 'Associate', role: 'member' }],
  members: [member(1, 'Boss', 0, 'Guildmaster', 'leader'), member(2, 'Mate', 2, 'Associate', 'member')], court: false, count: 2, player: false, canRename: true, canEditRanks: true, canAdd: true }, extra || {});
const factionData = (extra) => Object.assign({ type: 'faction', id: 37, nonce: 'f1', admin: true, staff: true, self: 99, selected: 'fighters-guild', invites: [],
  roles: ['leader', 'officer', 'sergeant', 'mage', 'blacksmith', 'tailor', 'member'], rankTitleMax: 40, ranksMax: 12,
  factions: [fview(), fview({ id: 'county-bruma', name: 'County of Bruma', kind: 'hold', court: true, count: 5 }), fview({ id: 'mages-guild-x', name: 'Order of the Lamp', kind: 'guild', player: true, count: 1 })] }, extra || {});
html = render(hub('faction', { faction: factionData() }));
t = text(html);
check('Faction staff: the browser with kind chips and counts (Charters for player factions)', /Search factions/.test(html) && /Guilds/.test(t) && /Charters/.test(t) && /2 members/.test(t), t.slice(0, 400));
check('...members with Promote, Demote, Make leader and Remove for a Lead GM', /Demote/.test(t) && /Make leader/.test(t) && /Remove/.test(t), t.slice(0, 600));
check('...Promote is not offered into the leader rank (that is Make leader)', !/Promote/.test(t.split('Mate')[0]));
check('...Add member, online or not', /Add member/.test(t) && /online or not/.test(html));
check('...the rank editor with role pickers, moves and Save ranks', /Ranks/.test(t) && /Save ranks/.test(t) && /Move up/.test(html) && /A new rank&#x27;s title|A new rank's title/.test(html));
check('...a held rank cannot be removed (its Remove is disabled)', /disabled="" title="1 hold it"/.test(html), (html.match(/title="[^"]*hold it"/g) || []));
html = render(hub('faction', { faction: factionData({ admin: false, factions: [fview({ canRename: false, canEditRanks: false, canAdd: false })] }) }));
t = text(html);
check('a plain GM: the same view, read-only', /Search factions/.test(html) && /A GM observes/.test(t) && !/Make leader|Demote|Add member|Save ranks/.test(t), t.slice(0, 500));
if (/Staff named this rank/.test(SRC)) {
  html = render(hub('faction', { faction: factionData({ factions: [fview({ ranks: [{ title: 'Guildmaster', role: 'leader' }, { title: 'Shield-Brother', role: 'officer', canon: 'Champion' }, { title: 'Associate', role: 'member' }] })] }) }));
  check('the rank editor: a staff-named rank has Default, naming its own title', (html.match(/Staff named this rank\. Its own title is Champion\./g) || []).length === 1 && />Default</.test(html));
}
// ---- Faction: a player's view
const player = (f) => factionData({ admin: false, staff: false, factions: f });
html = render(hub('faction', { faction: player([fview({ myRank: 0, myTitle: 'Guildmaster', canRename: true, canEditRanks: false, canAdd: false }), fview({ id: 'county-bruma', name: 'County of Bruma', kind: 'hold', court: true, myRank: 2, canRename: false, canEditRanks: false })]) }));
t = text(html);
check('a player: holds are kept off the Faction tab, with a pointer to Court', !/County of Bruma/.test(t) && /household is on the Court tab/.test(t), t.slice(0, 400));
check('...a leader renames titles: the editor without role pickers, moves or removes', /Save ranks/.test(t) && /As leader you may rename/.test(t) && !/Move up/.test(html) && !/A new rank/.test(html));
html = render(hub('faction', { faction: player([fview({ myRank: 2, canRename: false, canEditRanks: false, canAdd: false, canSetRank: false })]) }));
check('...a member gets no editor', !/Save ranks/.test(text(html)));

// The Move and rank Pickers choose only on Enter or a click: their arrow keys move a highlight (R-f3b)
check('the action Pickers (court Move, household and roster ranks) are in commit mode', /dbo-picker__option--hi/.test(SRC) && (SRC.match(/className: "court__(move|rank)",\s*commit: true/g) || []).length === 2, (SRC.match(/className: "court__(move|rank)"[^)]{0,40}/g) || []));

console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
