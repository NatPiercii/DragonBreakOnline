// The admin panel's revamp (skymp5-front adminPanel, client-local widget 23; F3 design 3.10, piece H12): renders the real
// widget with React's static renderer. A left rail instead of top tabs, the "Acting on" strip on the tabs that act on
// somebody, the Players tab's character care (L1's diseases moved from Powers, the five school levels from the
// server's adminMastery detail), the one SearchBar, and a plain GM seeing none of the Lead GM buttons. Also the fuzzy
// matcher the searches use.
//
//   node tests/admin-panel-front-harness.js <bundle of skymp5-front/src/features/adminPanel/index.tsx>
//
// A front from before the revamp has nothing to test, which is said and not failed unless a gate expects it.
'use strict';
const fs = require('fs');

const bundle = process.argv[2];
if (!bundle) { console.log('usage: node tests/admin-panel-front-harness.js <bundle>'); process.exit(2); }
const SRC = fs.readFileSync(bundle, 'utf8');
if (!/admin-panel__rail/.test(SRC)) {
  require('./expect')('admin-panel-front', 'this front has no admin panel rail');
  console.log('ok   skipped: this front predates the admin panel revamp');
  process.exit(0);
}
const M = require(bundle);
const { Widget: AdminPanel, renderToStaticMarkup, createElement, PlayerCare, PowersTab, fuzzyScore, fuzzyFilter } = M;

let failures = 0;
const check = (label, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && got !== undefined ? '   ' + JSON.stringify(got).slice(0, 400) : ''}`); if (!ok) failures++; };
const render = (W, props) => renderToStaticMarkup(createElement(W, props));
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

const events = { close: 'admin::close', refresh: 'admin::refresh', action: 'admin::action', request: 'admin::request', tp: 'admin::tp', summon: 'admin::summon', kick: 'admin::kick', ban: 'admin::ban', masteryGrant: 'admin::masteryGrant', masteryReset: 'admin::masteryReset', npcList: 'admin::npcList' };
const players = [
  { a: 'ff000014', p: 12, n: 'Mira Valen', d: '1', dn: 'mira', ip: '10.0.x.x', hwid: 'h', online: true, ping: 40, b: { werewolf: false, vampirelord: false, form: null } },
  { p: 13, n: 'Offline Olaf', d: '2', dn: 'olaf', ip: '', hwid: '', online: false, ping: null },
];
const data = (extra) => Object.assign({ players, locations: [], modes: [], events, admin: true, tier: 'leadgm', caps: { ban: false, spawn: true }, me: { a: 'ff000010' },
  mastery: { profession: null, label: '', rank: 0, rankName: '', hours: 0 }, bans: [] }, extra || {});

// The panel opens on Debug; the rail is there for staff, with every tab
let html = render(AdminPanel, { data: data() });
check('the tabs are a left rail', /admin-panel__rail/.test(html) && !/admin-panel__tabs"/.test(html) && (html.match(/class="admin-panel__railitem/g) || []).length === 9, (html.match(/class="admin-panel__railitem/g) || []).length);
check('Debug shows no Acting on strip', !/Acting on/.test(text(html)));
html = render(AdminPanel, { data: data({ admin: false }) });
check('a player sees only Debug', (html.match(/class="admin-panel__railitem/g) || []).length === 1, text(html).slice(0, 200));

// The Players tab's care: the PlayerCare part, rendered as the Players tab would
const detail = { skills: [], tierNames: [], tierHours: [], maxChosen: 3, schools: [
  { name: 'Restoration', level: 12, role: 'priest', roleLabel: 'Through Priest' }, { name: 'Destruction', level: 30, role: 'primary', roleLabel: 'Primary school' },
  { name: 'Alteration', level: 10, role: 'closed', roleLabel: 'Closed' }, { name: 'Conjuration', level: 0, role: 'closed', roleLabel: 'Closed' }, { name: 'Illusion', level: 0, role: 'closed', roleLabel: 'Closed' }] };
html = render(PlayerCare, { events, who: 'ff000014', selfId: 'ff000010', name: 'Mira Valen', masteryTarget: { name: 'Mira Valen', target: 'ff000014', detail }, canSpawn: true });
const t = text(html);
check('the diseases are on the Players tab now', /Sanguinare Vampiris/.test(t) && /Sanies Lupinus/.test(t) && /for Mira Valen/.test(t), t.slice(0, 300));
check('five schools in order, Alteration first and Restoration last', /Alteration.*Conjuration.*Destruction.*Illusion.*Restoration/.test(t) && (html.match(/admin-panel__school"/g) || []).length === 5, t);
check('each school shows its role and level, with a slider (no native select)', /Primary school/.test(t) && /value="30"/.test(html) && (html.match(/type="range"/g) || []).length === 5 && !/<select/.test(html), t.slice(0, 300));
check('Restoration follows Priest and cannot be set here', /follows Priest/.test(t) && (html.match(/disabled=""/g) || []).length >= 2);
check('four Set buttons for the four schools set here', (t.match(/\bSet\b/g) || []).length === 4, (t.match(/\bSet\b/g) || []).length);
html = render(PlayerCare, { events, who: 'ff000014', selfId: 'ff000010', name: 'Mira Valen', masteryTarget: { name: 'Someone', target: 'ff000099', detail }, canSpawn: true });
check('a late answer for another player is not shown as theirs', !/Primary school/.test(text(html)) && /Loading their schools/.test(text(html)));
html = render(PlayerCare, { events, who: '', selfId: 'ff000010', name: 'You', masteryTarget: { name: 'Lead', target: 'ff000010', detail }, canSpawn: true });
check('acting on yourself shows your own schools', /Primary school/.test(text(html)));
html = render(PlayerCare, { events, who: 'ff000014', selfId: 'ff000010', name: 'Mira Valen', masteryTarget: { name: 'Mira Valen', target: 'ff000014', detail: Object.assign({}, detail, { schools: undefined }) }, canSpawn: true });
check('an older server with no schools says so', /sends no school levels/.test(text(html)));
check('a plain GM sees no character care at all', render(PlayerCare, { events, who: 'ff000014', selfId: '', name: 'Mira', masteryTarget: { name: 'Mira', target: 'ff000014', detail }, canSpawn: false }) === '');

// Powers: no disease row any more, and nothing to press for a plain GM
html = render(PowersTab, { events, who: 'ff000014', beast: { werewolf: true, vampirelord: false, form: null }, canSpawn: true });
check('Powers keeps grant, transform, revert, revoke and the spells for a Lead GM', /Grant power/.test(text(html)) && /Transform now/.test(text(html)) && /Give all spells/.test(text(html)) && !/Sanguinare/.test(text(html)));
html = render(PowersTab, { events, who: 'ff000014', beast: { werewolf: true, vampirelord: false, form: null }, canSpawn: false });
check('a plain GM sees the state but no power buttons (R-L1)', /power held/.test(text(html)) && !/Grant power|Transform now|Revert|Revoke|Give all spells|Give all shouts/.test(text(html)) && /Lead GM and above/.test(text(html)), text(html));

// The fuzzy matcher
check('fuzzy: a whole word at a word start beats one inside a word', fuzzyScore('iron', 'Iron Sword') > fuzzyScore('iron', 'Environs'));
check('fuzzy: letters in order match', fuzzyScore('dwrsw', 'Dwarven Sword') > 0 && fuzzyScore('xyz', 'Dwarven Sword') === 0);
check('fuzzy: every word must be found', fuzzyScore('steel dagger', 'Steel Dagger') > 0 && fuzzyScore('steel bow', 'Steel Dagger') === 0);
check('fuzzy: editor ids count (name + edid + form searched together)', fuzzyScore('armorsteel', 'Steel Armor ArmorSteelCuirassA 0x13952') > 0);
const list = ['Elven Bow', 'Bow of the Hunt', 'Bowl', 'Rainbow Trout'];
check('fuzzyFilter: best first, non-matches out', JSON.stringify(fuzzyFilter(list, 'bow', (x) => x)) === JSON.stringify(['Bow of the Hunt', 'Bowl', 'Elven Bow', 'Rainbow Trout']), fuzzyFilter(list, 'bow', (x) => x));
check('fuzzyFilter: empty text keeps the list as it is', fuzzyFilter(list, '  ', (x) => x) === list);

console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
