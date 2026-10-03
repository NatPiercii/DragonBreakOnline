// Scripted test for the Character Journal (skymp5-front journal, widget 50; gameplay journal.js, phase 1): renders the
// real widget with React's static renderer for the payload journal.js sends (contract agreed by Workers A and D,
// 2026-09-30). run-all bundles the widget from $FORK; by hand:
//
//   node tests/journal-front-harness.js <bundle of skymp5-front/src/features/journal/index.tsx>
//
// With $FORK set (run-all sets it) it also checks the widget is wired in: constructor.js, App.js and the uiCaps list.
// A front from before the journal has nothing to test, which is said and not failed unless a gate expects it.
'use strict';
const fs = require('fs');
const path = require('path');

const bundle = process.argv[2];
if (!bundle) { console.log('usage: node tests/journal-front-harness.js <bundle>'); process.exit(2); }
if (!/journal__frame/.test(fs.readFileSync(bundle, 'utf8'))) {
  require('./expect')('journal-front', 'this front has no Character Journal');
  console.log('ok   skipped: this front predates the Character Journal');
  process.exit(0);
}
const J = require(bundle);
const { Widget: Journal, renderToStaticMarkup, createElement } = J;

let failures = 0;
const check = (label, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && got !== undefined ? '   ' + JSON.stringify(got).slice(0, 500) : ''}`); if (!ok) failures++; };
const render = (W, props) => renderToStaticMarkup(createElement(W, props));
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const count = (html, re) => (html.match(re) || []).length;

// ---- the payload, as journal.js sends it ----------------------------------------------------------------------
const skill = (id, name, level, tier, tierName, epithet) => ({ id, name, level, tier, tierName, epithet });
const profile = (extra) => Object.assign({
  name: 'Vaeliss Dren', race: 'Dunmer', playtime: '31 h 12 min', created: '30 September 2026', joined: '21 September 2026',
  backstory: 'Born in the ash of Vvardenfell,\nraised on the road to Bruma.', origin: 'House Dren, the lesser branch.',
  backstoryMax: 4000, originMax: 1000,
  skills: [skill('blade', 'Blade', 81, 3, 'Expert', 'The Honed Edge'), skill('defense', 'Defense', 52, 2, 'Adept', 'The Iron Wall'), skill('arcane', 'Arcane Arts', 30, 1, 'Apprentice', 'The Ordered Mind')],
  title: 'Expert Spellsword', titleEpithet: 'The Honed Edge', titleId: 'spellsword',
  titles: [{ id: 'spellsword', label: 'Expert Spellsword' }, { id: 'knight', label: 'Adept Knight' }],
}, extra || {});
const faction = (extra) => Object.assign({
  id: 37, nonce: 'f1', admin: false, self: 0xff000010, selected: 'fg',
  factions: [{ id: 'fg', name: 'Fighters Guild', kind: 'guild', secret: false, prince: '', myRank: 2, myTitle: 'Swordsman',
    canInvite: false, canKick: false, canSetRank: false, ranks: [{ title: 'Guildmaster', role: '' }, { title: 'Champion', role: '' }, { title: 'Swordsman', role: '' }],
    members: [{ actorId: 0xff000010, name: 'Vaeliss Dren', tag: 'K3F9', rank: 2, title: 'Swordsman', role: '', online: true }, { actorId: 0xff000011, name: 'Borin', tag: 'Z7EG', rank: 0, title: 'Guildmaster', role: '', online: false }] }],
  invites: [],
}, extra || {});
const curse = {
  kind: 'werewolf', group: 'curse', label: 'Werewolf', epithet: 'The Blood of Hircine', creed: 'The Hunt answers to no law.',
  ladder: { name: 'Renown', unit: 'renown', value: 320, rank: 1, earn: 'Hunt under the moons.', ranks: [{ name: 'Fledgling', at: 0, perk: 'a' }, { name: 'Hunter', at: 250, perk: 'b' }, { name: 'Elder', at: 1500, perk: 'c' }] },
  rows: [{ label: 'Turned', value: '14th of Last Seed, 4E 211' }], powers: [{ name: 'Howl of Terror', have: true, note: 'Once a night' }],
};
const stats = { groups: [
  { name: 'Combat', rows: [{ label: 'Players killed', value: '3' }, { label: 'Times downed', value: '7', hint: 'the finishing blow counts as a death' }] },
  { name: 'Time & Travel', rows: [{ label: 'Distance travelled', value: '41.2 km (25.6 mi)' }] },
] };
const data = (extra) => Object.assign({
  type: 'journal', id: 50, nonce: 'n1',
  clock: { date: '17th of Last Seed, 4E 211', time: '9:42 in the evening', moons: 'The moons are waxing crescent.' },
  profile: profile(), faction: faction(), supernatural: curse, stats,
}, extra || {});

// ---- the frame: name, clock, tabs, close -----------------------------------------------------------------------
let html = render(Journal, { data: data() });
let t = text(html);
check('the character\'s name is the page\'s heading', /<h1 class="journal__name">Vaeliss Dren<\/h1>/.test(html), html.slice(0, 400));
check('...with the title and race under it', /Expert Spellsword · Dunmer/.test(t), t.slice(0, 200));
check('the world clock is in the header: date, time and moons', /17th of Last Seed, 4E 211 9:42 in the evening The moons are waxing crescent\./.test(t), t.slice(0, 300));
const tabs = (h) => (h.match(/class="dbo-tabs__tab[^"]*"[^>]*>[^<]*/g) || []).map((x) => x.replace(/.*>/, ''));
check('tabs in order: Profile, Faction, the curse by name, Stats', JSON.stringify(tabs(html)) === '["Profile","Faction","Werewolf","Stats"]', tabs(html));
check('Profile is open first', /dbo-tabs__tab dbo-tabs__tab--on"[^>]*>Profile/.test(html) && /journal__body--profile/.test(html));
check('one Close, the journal\'s own', count(t, /\bClose\b/g) === 1, t.match(/.{30}Close.{10}/g));
html = render(Journal, { data: data({ supernatural: null }) });
check('no Supernatural tab for a mortal', JSON.stringify(tabs(html)) === '["Profile","Faction","Stats"]', tabs(html));
html = render(Journal, { data: data({ faction: null }) });
check('no Faction tab when the server sends none', JSON.stringify(tabs(html)) === '["Profile","Werewolf","Stats"]', tabs(html));
html = render(Journal, { data: data({ faction: faction({ invites: [{ factionId: 'mg', name: 'Mages Guild', from: 'Borin' }] }) }) });
check('an invitation waiting shows as a count on the Faction tab', /Faction<span class="dbo-tabs__badge">1<\/span>/.test(html));
html = render(Journal, { data: data({ clock: null }) });
check('no clock, no clock row (an older server)', !/journal__clock/.test(html));
html = render(Journal, { data: data({ result: 'A word in your story is not allowed.', resultKind: 'refused' }) });
check('a refused save says why, marked as refused', /journal__result journal__result--refused">A word in your story is not allowed\./.test(html));

// ---- Profile ---------------------------------------------------------------------------------------------------
t = text(render(Journal, { data: data() }));
check('race, time in Tamriel, the date made and the first arrival', /Race Dunmer Time in Tamriel 31 h 12 min Character made 30 September 2026 First arrived 21 September 2026/.test(t), t);
html = render(Journal, { data: data() });
check('the backstory keeps its line breaks (pre-wrap), and the origin shows', /Born in the ash of Vvardenfell,\nraised on the road to Bruma\./.test(html) && /House Dren, the lesser branch\./.test(html));
check('...with a Write button', />Write<\/button>/.test(html));
t = text(render(Journal, { data: data({ profile: profile({ backstory: '', origin: '' }) }) }));
check('an empty story invites one', /No story written yet/.test(t) && /Where you were born/.test(t));

// the top three
const meters = (h) => (h.match(/journal__meter journal__meter--rank\d journal__meter--tier\d/g) || []);
check('three meters, ranked 1 to 3, each wearing its tier', JSON.stringify(meters(html)) === JSON.stringify(['journal__meter journal__meter--rank1 journal__meter--tier3', 'journal__meter journal__meter--rank2 journal__meter--tier2', 'journal__meter journal__meter--rank3 journal__meter--tier1']), meters(html));
check('...each filled bottom to top to its level', JSON.stringify(html.match(/height:\d+%/g)) === '["height:81%","height:52%","height:30%"]', html.match(/height:\d+%/g));
check('...with the Wheel\'s four tier floors marked on every meter', count(html, /journal__meter-tick/g) === 12 && /bottom:25%/.test(html) && /bottom:90%/.test(html));
t = text(html);
check('...and the level, tier, skill and epithet under each', /81 Expert Blade The Honed Edge 2 .*52 Adept Defense The Iron Wall 3 .*30 Apprentice Arcane Arts The Ordered Mind/.test(t), t);
const four = profile({ skills: profile().skills.concat([skill('priest', 'Priest', 10, 0, 'Novice', 'The Kindled Heart')]) });
check('never more than three meters', meters(render(Journal, { data: data({ profile: four }) })).length === 3);
check('a level outside 0-100 is held to the meter', /height:100%/.test(render(Journal, { data: data({ profile: profile({ skills: [skill('x', 'X', 140, 4, 'Master', '')] }) }) })));
check('no skills yet says so', /No skill has been taken up yet/.test(render(Journal, { data: data({ profile: profile({ skills: [] }) }) })));

// the title
check('two or more earned titles: a Picker (never a native select) on the chosen one', /class="dbo-picker"/.test(html) && /dbo-picker__label">Expert Spellsword</.test(html) && !/<select/.test(html));
const one = render(Journal, { data: data({ profile: profile({ titles: [{ id: 'spellsword', label: 'Expert Spellsword' }] }) }) });
check('one title: plain text, no picker', !/dbo-picker/.test(one) && /journal__title-text">Expert Spellsword</.test(one));
check('the title\'s epithet under it', /journal__title-epithet">The Honed Edge</.test(html));

// the editor (the Write button opens it; drawn here directly)
const noop = () => {};
const edit = render(J.ProfileTab, { data: data(), editing: true, setEditing: noop, busy: false, act: noop });
check('editing: a backstory field capped at 4000 and an origin field at 1000', /<textarea[^>]*maxLength="4000"/.test(edit) && /<textarea[^>]*maxLength="1000"/.test(edit), edit.match(/<textarea[^>]*>/g));
check('...with character counts', /0 \/ 4000/.test(text(edit)) || /\d+ \/ 4000/.test(text(edit)));
check('...Save waits for a change; Discard is there', /disabled=""[^>]*>Save<|<button[^>]*disabled=""[^>]*>Save/.test(edit) && />Discard</.test(edit), edit.match(/<button[^>]*>[^<]*/g));
check('...and the hint says Escape sets the page aside and only Discard throws it away', /Escape sets the page aside for later\. Discard throws it away\./.test(text(edit)));

// ---- the other tabs ----------------------------------------------------------------------------------------------
html = render(Journal, { data: data({ tab: 'faction' }) });
t = text(html);
check('Faction: the faction menu\'s content inside the journal', /journal__body--faction/.test(html) && /Fighters Guild/.test(t) && /Borin/.test(t) && /Swordsman/.test(t));
check('...without the faction menu\'s own Close or its "F3 opens this menu" hint', count(t, /\bClose\b/g) === 1 && !/F3 opens this menu/.test(t) && /X on a player invites them/.test(t));
check('...nor its full-screen shade', !/faction__fade|faction__panel/.test(html));
html = render(Journal, { data: data({ tab: 'supernatural' }) });
t = text(html);
check('Supernatural: the curse as the K menu draws it (creed, rows, powers, the ladder)', /The Hunt answers to no law\./.test(t) && /Turned 14th of Last Seed, 4E 211/.test(t) && /Howl of Terror/.test(t) && /Fledgling/.test(t) && /Elder/.test(t), t.slice(0, 600));
html = render(Journal, { data: data({ tab: 'supernatural', supernatural: null }) });
check('a Supernatural tab asked for on a mortal opens Profile instead', /journal__body--profile/.test(html));
html = render(Journal, { data: data({ tab: 'stats' }) });
t = text(html);
check('Stats: one table per group, label and value', count(html, /<table class="journal__table">/g) === 2 && /Combat Players killed 3 Times downed 7 the finishing blow counts as a death/.test(t) && /Time &? ?Travel Distance travelled 41\.2 km \(25\.6 mi\)/.test(t), t);
check('...an empty record says so', /Nothing has been recorded yet/.test(render(Journal, { data: data({ tab: 'stats', stats: { groups: [] } }) })));

// ---- the F3 hub (data.hub; journal.js hubPayload, piece H1) --------------------------------------------------------
if (typeof J.registerJournalTab !== 'function') {
  require('./expect')('journal-front', 'this front has no F3 hub');
  console.log('ok   (this front predates the F3 hub: its checks are skipped)');
} else {
  const hubData = (extra) => Object.assign({
    type: 'journal', id: 50, nonce: 'h1', hub: 1, tab: 'stats',
    tabs: [{ id: 'profile', label: 'Profile' }, { id: 'faction', label: 'Faction', badge: '2' }, { id: 'court', label: 'Court' }, { id: 'stats', label: 'Stats' },
      { id: 'supernatural', label: 'Werewolf' }, { id: 'settings', label: 'Settings', pinned: true }],
    clock: { date: '17th of Last Seed, 4E 211', time: '9:42 in the evening' }, head: { name: 'Vaeliss Dren', title: 'Expert Spellsword', race: 'Dunmer' }, stats,
  }, extra || {});
  html = render(Journal, { data: hubData() });
  t = text(html);
  const known = Object.keys(J.JOURNAL_TABS || {});
  const sent = ['profile', 'faction', 'court', 'stats', 'supernatural', 'settings'], labels = ['Profile', 'Faction', 'Court', 'Stats', 'Werewolf', 'Settings'];
  const drawable = labels.filter((l, i) => ['profile', 'faction', 'stats', 'supernatural'].includes(sent[i]) || known.includes(sent[i]));
  check('hub: the server\'s tabs in its order, less any this front cannot draw', JSON.stringify(tabs(html)) === JSON.stringify(drawable), tabs(html));
  check('...a badge from the server on its tab', /Faction<span class="dbo-tabs__badge">2<\/span>/.test(html));
  check('...the open tab is the server\'s, its section drawn', /journal__body journal__body--stats/.test(html) && /Players killed/.test(t));
  check('...the header from head when Profile is not sent', /<h1 class="journal__name">Vaeliss Dren<\/h1>/.test(html) && /Expert Spellsword · Dunmer/.test(t));
  check('...the body wears its tab\'s hue: Stats is the journal\'s violet', /journal__body--stats" data-domain="dragonbreak"/.test(html));
  check('...Supernatural the Heart\'s red, Faction the aqua', /data-domain="lorkhan"/.test(render(Journal, { data: hubData({ tab: 'supernatural', supernatural: curse }) })) && /data-domain="aqua"/.test(render(Journal, { data: hubData({ tab: 'faction', faction: faction() }) })));
  check('...an older payload has no data-domain on the body (today\'s journal)', !/journal__body[^"]*" data-domain/.test(render(Journal, { data: data() })));
  html = render(Journal, { data: hubData({ tab: 'faction' }) });
  check('a tab whose section has not come yet says the page is turning', /journal__body--faction/.test(html) && /Turning the page/.test(text(html)));
  html = render(Journal, { data: hubData({ tab: 'faction', faction: null }) });
  check('...a section the server could not build says so', /This page cannot be shown just now/.test(text(html)));
  html = render(Journal, { data: hubData({ tab: 'profile', profile: profile(), head: undefined }) });
  check('Profile on the hub: the profile section draws as before', /Born in the ash of Vvardenfell/.test(html) && /<h1 class="journal__name">Vaeliss Dren<\/h1>/.test(html));
  check('...its meters are no links while this front has no Skills tab', !/journal__meter--link/.test(html));
  // A tab module registers itself; the hub then draws it with its section
  J.registerJournalTab('skills', ({ section, act }) => createElement('div', { className: 'probe-skills' }, `skills ${JSON.stringify(section)}`), 'dragonbreak');
  J.registerJournalTab('probe', ({ section }) => createElement('div', { className: 'probe' }, `probe ${section && section.n}`), 'aedric');
  html = render(Journal, { data: hubData({ tab: 'profile', profile: profile(), tabs: hubData().tabs.concat([{ id: 'skills', label: 'Skills' }, { id: 'probe', label: 'Probe' }]) }) });
  check('...with Skills drawn by this front, each meter opens its skill there', (html.match(/journal__meter--link/g) || []).length === 3 && /title="Blade: open its page in Skills"/.test(html));
  html = render(Journal, { data: hubData({ tab: 'probe', probe: { n: 7 }, tabs: hubData().tabs.concat([{ id: 'probe', label: 'Probe' }]) }) });
  check('a registered tab draws its component with its section, in its own hue', /class="probe">probe 7</.test(html) && /journal__body--probe" data-domain="aedric"/.test(html));
  check('...the pinned tab (Settings) carries the pinned class when drawn', !known.includes('settings') || /dbo-tabs__tab--pinned/.test(render(Journal, { data: hubData() })));
  check('the caps the HUD sends: journalHub and one journalTab:<id> per registered tab', JSON.stringify(J.journalCaps().slice(0, 1)) === '["journalHub"]' && J.journalCaps().includes('journalTab:probe'));
  const jsrc0 = fs.readFileSync(bundle, 'utf8');
  check('a tab click asks the server for that tab under the journal nonce (dbo:journalTab)', /send\d*\(["']dbo:journalTab["'], nonce\.current, id\)/.test(jsrc0) && /send\d*\(["']dbo:journalTab["'], nonce\.current, id, focus\)/.test(jsrc0));
  check('...and a redraw on another tab does not pull the view back while that answer is on its way', /if \(w && w\.tab !== data\.tab && Date\.now\(\) - w\.at < WANT_MS\) return;/.test(jsrc0));
}

// ---- a payload from the server's own harness (JOURNAL_SAMPLE=<file>, written by journal-harness.js) ------------------
if (process.env.JOURNAL_SAMPLE && fs.existsSync(process.env.JOURNAL_SAMPLE)) {
  const sample = JSON.parse(fs.readFileSync(process.env.JOURNAL_SAMPLE, 'utf8'));
  for (const tab of ['profile', 'faction', 'supernatural', 'stats']) {
    let out = '';
    try { out = text(render(Journal, { data: Object.assign({}, sample, { tab }) })); } catch (e) { out = 'THREW ' + e.message; }
    check(`the server's sample payload draws on ${tab}`, out.includes(sample.profile.name) && !/THREW/.test(out), out.slice(0, 200));
  }
}

// ---- giving way to a panel the server opens over the journal (review F2) --------------------------------------------
const over = J.panelOpenedOver;
check('panelOpenedOver is exported for this check', typeof over === 'function');
if (typeof over === 'function') {
  const before = new Set(['hud:29', 'party:32', 'journal:50', 'faction:37']);
  check('a HUD, party or journal re-push is not a panel over the journal', !over(before, [{ type: 'journal', id: 50 }, { type: 'hud', id: 29 }, { type: 'party', id: 32 }]));
  check('...nor a panel that was already there, re-pushed', !over(before, [{ type: 'faction', id: 37 }, { type: 'journal', id: 50 }]));
  check('...nor a passive marker or prompt appearing', !over(before, [{ type: 'mailMarkers', id: 44 }, { type: 'interactPrompt', id: 45 }, { type: 'journal', id: 50 }]));
  for (const type of ['downed', 'robPrompt', 'feedPrompt', 'tradeInvite', 'death'])
    check(`a ${type} panel appearing is`, over(before, [{ type: 'journal', id: 50 }, { type, id: 60 }]));
}

// ---- the answers go back under the journal's nonce ----------------------------------------------------------------
const src = fs.readFileSync(bundle, 'utf8');
for (const ev of ['dbo:journalProfile', 'dbo:journalTitle', 'dbo:journalClose']) check(`sends ${ev}`, src.includes(`'${ev}'`) || src.includes(`"${ev}"`));

// ---- wired in: constructor.js, App.js, the uiCaps list (from $FORK) ------------------------------------------------
const FRONT = process.env.FORK ? path.join(process.env.FORK, 'skymp5-front', 'src') : '';
if (!FRONT || !fs.existsSync(FRONT)) console.log('ok   (no $FORK: the wiring checks are left to run-all)');
else {
  const read = (f) => fs.readFileSync(path.join(FRONT, f), 'utf8');
  const jsrc = read('features/journal/index.tsx');
  check('a text field keeps its keys from the game and the global Escape, and Escape leaves the edit', /onKeyDown=\{\(e\) => \{\s*e\.stopPropagation\(\);\s*if \(e\.key === 'Escape'\) \{ e\.preventDefault\(\); onEscape\(\); \}/.test(jsrc));
  check('constructor.js draws type "journal" with the Journal widget', /case 'journal':\s*return <Journal data=\{rend\} \/>;/.test(read('constructor.js')));
  check('App.js keys the journal by its id, so a redraw keeps its state', /widget\.type === 'journal'\) \? \('journal-' \+ widget\.id\)/.test(read('App.js')));
  check('the front tells the server it can draw the journal (dbo:uiCaps)', /const UI_CAPS = \[[^\]]*'journal'/.test(read('features/hud/index.tsx')));
  if (fs.existsSync(path.join(FRONT, 'features/journal/tabs.ts')))
    check('...and the hub with every tab it draws', /sendMessage\('dbo:uiCaps', \.\.\.UI_CAPS, \.\.\.journalCaps\(\)\)/.test(read('features/hud/index.tsx')) && /import '\.\.\/journal\/sections';/.test(read('features/hud/index.tsx')));
  check('Escape in a field leaves the edit and keeps the draft; only Discard clears it (review F3)',
    /const discard = \(\): void => \{ unsaved = null; setEditing\(false\); \};/.test(jsrc) && /const leave = \(\): void => setEditing\(false\);/.test(jsrc)
    && (jsrc.match(/onEscape=\{leave\}/g) || []).length === 2 && /onClick=\{discard\}>Discard</.test(jsrc) && !/onEscape=\{discard\}/.test(jsrc));
  check('a panel opened over it hides the journal at once and asks the server to close it as a yield (review F2)',
    /if \(panelOpenedOver\(seen, list\)\) \{ setYielded\(true\); send\('dbo:journalClose', nonce\.current, 'yield'\); \}/.test(jsrc)
    && /if \(yielded\) return null;/.test(jsrc) && /setBusy\(false\);\s*setYielded\(false\);/.test(jsrc) && /widgets\.removeListener\(onChange\)/.test(jsrc));
  check('the faction menu (panel 37) keeps its own Close and F3 hint', /!embedded && <button className="faction__button" onClick=\{\(\) => send\('dbo:factionClose'/.test(read('features/faction/index.tsx')));
}

console.log(failures ? `${failures} failure(s)` : 'all checks passed');
process.exit(failures ? 1 : 0);
