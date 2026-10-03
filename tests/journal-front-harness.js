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
// A front source file from $FORK (run-all sets it), or '' without one
const FRONT_SRC = (f) => { const p = process.env.FORK ? path.join(process.env.FORK, 'skymp5-front', 'src', f) : ''; return p && fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; };

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
  // From the source when $FORK is set (the bundle renames locals), else from the bundle
  const jsrc0 = FRONT_SRC('features/journal/index.tsx') || fs.readFileSync(bundle, 'utf8');
  check('a tab click asks the server for that tab under the journal nonce (dbo:journalTab)', /send\d*\(["']dbo:journalTab["'], nonce\.current, id\)/.test(jsrc0) && /send\d*\(["']dbo:journalTab["'], nonce\.current, id, focus\)/.test(jsrc0));
  check('...and a redraw on another tab does not pull the view back while that answer is on its way', /if \(w && w\.tab !== data\.tab && Date\.now\(\) - w\.at < WANT_MS\) return;/.test(jsrc0));
}

// ---- the Deity tab (prayer.js deityView; piece H2) ------------------------------------------------------------------
if (!J.JOURNAL_TABS || !J.JOURNAL_TABS.deity) {
  require('./expect')('journal-front', 'this front has no Deity tab');
  console.log('ok   (this front has no Deity tab yet: its checks are skipped)');
} else {
  const SK = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'skills.json'), 'utf8'));
  const deity = (extra) => Object.assign({ current: 'mara', first: false, daysLeft: 3, cooldownDays: 7, canChoose: false,
    choices: SK.deities.choices.map((d) => ({ id: d.id, name: d.name, kind: d.kind, sphere: d.sphere || '', boon: d.boon || '', reachable: Number(d.inBruma) > 0 || !!d.prayAnywhere,
      inBruma: Number(d.inBruma) || 0, prayAnywhere: !!d.prayAnywhere, lawful: d.lawful !== false, unlawfulWhere: d.lawful === false ? String(d.unlawfulWhere || '') : '', aspectOf: d.aspectOf || '', alsoKnownAs: d.alsoKnownAs || [] })) }, extra || {});
  const dData = (sec) => ({ type: 'journal', id: 50, nonce: 'd1', hub: 1, tab: 'deity', tabs: [{ id: 'profile', label: 'Profile' }, { id: 'stats', label: 'Stats' }, { id: 'deity', label: 'Deity' }],
    head: { name: 'Aela', title: 'Wanderer', race: 'Nord' }, deity: sec });
  html = render(Journal, { data: dData(deity()) });
  t = text(html);
  check('Deity: the body wears the Aedra\'s gold', /journal__body--deity" data-domain="aedric"/.test(html));
  check('...three groups: the Divines, the Daedric Princes, Other faiths', /The Divines.*The Daedric Princes.*Other faiths/.test(t), t.slice(0, 300));
  const divines = (t.match(/The Divines(.*)The Daedric Princes/) || [])[1] || '';
  check('...the Divines include Dibella, and Auri-El sits under Akatosh as the Aldmeri Akatosh, not as a tenth Divine', /Dibella/.test(divines) && /Akatosh .*Auri-El \(the Aldmeri Akatosh\)/.test(divines) && divines.indexOf('Auri-El') < divines.indexOf('Arkay'), divines);
  check('...Talos carries the Unlawful tag; Malacath, Azura and Meridia do not', /Talos[^A-Z]*Unlawful/.test(t) && !/Malacath[^A-Z]*Unlawful/.test(t) && !/Azura[^A-Z]*Unlawful/.test(t) && !/Meridia[^A-Z]*Unlawful/.test(t));
  check('...the player\'s god is marked', /Mara[^A-Z]*your god/.test(t));
  const far = render(Journal, { data: dData(deity({ choices: deity().choices.map((c) => (c.id === 'vaermina' ? Object.assign({}, c, { inBruma: 0, reachable: false }) : c)) })) });
  check('...a god with no shrine in reach is dimmed and says so (none is today: every god has one in Bruma or needs none)', /jdeity__row jdeity__row--far/.test(far) && /Vaermina.{0,30}no shrine within reach/.test(text(far)) && !/jdeity__row--far/.test(html));
  check('...the god shown first is your own, with its sphere, boon, shrines and law', /jdeity__title">Mara</.test(html) && /Boon/.test(t) && /2 shrines in Bruma\./.test(t) && /Lawful throughout the Empire\./.test(t));
  check('...and your state: the days until you may turn again, the Turn button held', /You follow Mara\. You may turn to another god in 3 days\./.test(t) && /Mara is your god\./.test(t));
  check('no native select anywhere on the tab', !/<select/.test(html));
  // Talos shown: a component state, so the page is rendered for a player whose god he is
  html = render(Journal, { data: dData(deity({ current: 'talos', daysLeft: 0, canChoose: true })) });
  t = text(html);
  check('Talos\' page: the Concordat line for 4E 211, his live boon, 4 shrines in Bruma, also known as Ysmir',
    /Under the White-Gold Concordat the worship of Talos is outlawed throughout the Empire, and Bruma is Imperial land; the Thalmor keep a Justiciar here\. North of the Jerall Mountains each Jarl now decides for their own hold\./.test(t)
    && /Two-handed \+10\./.test(t) && /4 shrines in Bruma\./.test(t) && /Also known as Ysmir/.test(t) && !/banned in Skyrim under the Thalmor/.test(t) && !/shout costs/.test(t), t.slice(0, 900));
  html = render(Journal, { data: dData(deity({ current: '', first: true, daysLeft: 0, canChoose: true })) });
  t = text(html);
  check('no god yet: the first choice is free, and the button reads Take', /Your first choice is free and needs no shrine\./.test(t) && /<button[^>]*journal__button--primary[^>]*>Take Akatosh</.test(html), (html.match(/<button[^>]*primary[^>]*>[^<]*/g) || []));
  check('a faith needs no shrine (its shrines line)', J.JOURNAL_TABS.deity && /kneel anywhere/.test(text(render(J.JOURNAL_TABS.deity.component, { section: deity({ choices: deity().choices.filter((c) => c.id === 'hist'), current: 'hist' }), sections: {}, nonce: 'd', busy: false, act: () => {}, openTab: () => {} }))));
  const dsrc = FRONT_SRC('features/journal/tabs/DeityTab.tsx');
  if (dsrc) check('Turn asks once more, then sends journalDeity with the god\'s id', /onClick=\{\(\) => setConfirm\(true\)\}/.test(dsrc) && /onClick=\{\(\) => act\('journalDeity', shown\.id\)\}/.test(dsrc));
}

// ---- the Settings tab (piece H3; General and Voice come with H4 and H5) ----------------------------------------------
if (!J.JOURNAL_TABS || !J.JOURNAL_TABS.settings) {
  require('./expect')('journal-front', 'this front has no Settings tab');
  console.log('ok   (this front has no Settings tab yet: its checks are skipped)');
} else {
  const sData = (sec) => ({ type: 'journal', id: 50, nonce: 's1', hub: 1, tab: 'settings', tabs: [{ id: 'profile', label: 'Profile' }, { id: 'settings', label: 'Settings', pinned: true }],
    head: { name: 'Aela', title: 'Wanderer', race: 'Nord' }, settings: sec || { staff: false } });
  // The section to open is named in the server's section (a deep link); without one the first in the rail opens
  html = render(Journal, { data: sData({ staff: false, section: 'interface' }) });
  t = text(html);
  check('Settings: pinned right, in the aqua', /dbo-tabs__tab dbo-tabs__tab--on dbo-tabs__tab--pinned/.test(html) && /journal__body--settings" data-domain="aqua"/.test(html));
  const rail = (html.match(/jset__rail-item[^"]*"[^>]*>[^<]*/g) || []).map((x) => x.replace(/.*>/, ''));
  check('...a rail of sections in order, Controls, Interface and Help among them; a deep link opens Interface', ['Controls', 'Interface', 'Help'].every((l) => rail.includes(l))
    && rail.indexOf('Controls') < rail.indexOf('Interface') && rail.indexOf('Interface') < rail.indexOf('Help') && /jset__rail-item jset__rail-item--on"[^>]*>Interface/.test(html), rail);
  if (rail.includes('General')) {
    // General (H4): the menu keys, from what the client told the page
    const KB = { live: { chatKeyCode: 20, freeCursorKeyCode: 66, housingMenuKeyCode: 45, playerActionKeyCode: 45, personalMenuKeyCode: 22, factionMenuKeyCode: 61, masteryMenuKeyCode: 37, emoteWheelKeyCode: 48,
      nametagKeyCode: 59, hideUiKeyCode: 60, voicePushToTalkKeyCode: 47, voiceModeKeyCode: 56, maskToggleKeyCode: 35, adminMenuKeyCode: 65, hideChatKeyCode: 0 } };
    KB.next = Object.assign({}, KB.live, { masteryMenuKeyCode: 34, emoteWheelKeyCode: 61 });
    global.window = { __dboKeybinds: KB, skyrimPlatform: { sendMessage() {} }, addEventListener() {}, removeEventListener() {} };
    let g = render(Journal, { data: sData({ staff: false }) });
    const gt = text(g);
    check('General opens first: the menu keys by name', rail[0] === 'General' && /jset__rail-item jset__rail-item--on"[^>]*>General/.test(g) && /Activate chat .{0,40}T Release mouse F8/.test(gt)
      && /Interact .{0,60}X Personal menu U/.test(gt) && /Journal F3/.test(gt) && /Push to talk V/.test(gt) && /Voice range Left Alt/.test(gt) && /Hide chat .*None/.test(gt), gt.slice(0, 900));
    check('...a key changed for the next start says so, and the note says when it applies', /Skills G.{0,40}from your next start/.test(gt) && /Saved\. Takes effect when you next start the game\./.test(gt));
    check('...two rows on one key are both marked (Emote wheel now on F3 with the journal)', (g.match(/jset__key jset__key--clash/g) || []).length === 2 && /Shared with another key/.test(gt));
    check('...the admin panel key only for staff', !/Admin panel/.test(gt) && /Admin panel F7/.test(text(render(Journal, { data: sData({ staff: true }) }))));
    delete global.window;
    // Voice (H5): only while voice is on; the players near, the one X named marked
    const vNear = [{ identity: 'ff000041', name: 'Stranger', meters: 1 }, { identity: 'ff000044', name: 'Ria', meters: 2 }];
    check('Voice is in the rail only while voice is on', !rail.includes('Voice') && /jset__rail-item[^>]*>Voice</.test(render(Journal, { data: sData({ voiceOn: true, nearby: [] }) })));
    global.window = { skyrimPlatform: { sendMessage() {} }, addEventListener() {}, removeEventListener() {} };
    const v = render(Journal, { data: sData({ voiceOn: true, nearby: vNear, section: 'voice', focusPeer: 'ff000044' }) });
    const vt = text(v);
    check('...Voice: microphone and speakers as Pickers, the two volumes, the transmit mode', /jset__rail-item jset__rail-item--on"[^>]*>Voice/.test(v) && /Microphone/.test(vt) && /Speakers/.test(vt)
      && (v.match(/dbo-picker jset__picker|jset__picker/g) || []).length >= 2 && /Your voice volume/.test(vt) && /Other players' volume/.test(vt) && /Push to talk/.test(vt) && /Voice activity/.test(vt) && !/<select/.test(v), vt.slice(0, 600));
    check('...the players near, with metres, each with a volume, Mute and Reset; the one X named is marked', (v.match(/class="jset__peer[ "]/g) || []).length === 2 && /Stranger 1 m/.test(vt) && /Ria 2 m/.test(vt)
      && (v.match(/jset__peer jset__peer--focus/g) || []).length === 1 && /jset__peer--focus"><span class="jset__peer-name">Ria/.test(v) && (vt.match(/Mute/g) || []).length >= 2);
    check('...nobody near says so', /Nobody is near enough to hear/.test(text(render(Journal, { data: sData({ voiceOn: true, nearby: [], section: 'voice' }) }))));
    delete global.window;
    const vsrc = FRONT_SRC('features/journal/tabs/SettingsVoice.tsx');
    if (vsrc) check('...changes go to the page\'s voice manager at once (setPrefsInGame, adjustPeer set)', /v\.setPrefsInGame\(patch\)/.test(vsrc) && /op\('set', n \/ 100\)/.test(vsrc));
    const ksrc = FRONT_SRC('features/journal/tabs/SettingsKeys.tsx');
    if (ksrc) check('...capture: Escape cancels, Backspace puts the launcher\'s key back (or clears an optional one), keys kept from the game', /if \(e\.code === 'Escape'\) \{ setCapturing\(''\); return; \}/.test(ksrc)
      && /if \(e\.code === 'Backspace'\) \{ save\(r, r\.optional \? 0 : null\); return; \}/.test(ksrc) && /e\.preventDefault\(\);\s*e\.stopPropagation\(\);/.test(ksrc) && /tell\('cef::keybinds:save', JSON\.stringify\(\{ keys \}\)\)/.test(ksrc));
  }
  check('...Interface: size, panel sizes, the bars, the chat and the names over heads', /Interface size/.test(t) && /Reset every panel/.test(t) && /Show the bars/.test(t) && /Fade when full/.test(t)
    && /Show the chat/.test(t) && /Hidden until T/.test(t) && /Lettering/.test(t) && /Text size/.test(t) && /Transparency/.test(t) && /Highlight words/.test(t) && /Player names/.test(t));
  // Once the chat's file is read: the new defaults for everyone (Nate, 3 Oct, final), or a choice saved in Settings
  const chosen = (h) => (h.match(/jset__chip jset__chip--on"[^>]*>[^<]*/g) || []).map((x) => x.replace(/.*>/, ''));
  global.window = { __alduinakChatSettings: { fontSize: 18 }, skyrimPlatform: { sendMessage() {} }, addEventListener() {}, removeEventListener() {} };
  const def = render(Journal, { data: sData({ staff: false, section: 'interface' }) });
  window.__alduinakChatSettings = { fontSize: 18, ui: { vitals: 'always', vitalsStyle: 'classic', chat: 'always', chatLettering: 'plain' } };
  const mine = render(Journal, { data: sData({ staff: false, section: 'interface' }) });
  delete global.window;
  check('...the defaults chosen for everyone: Fade when full, Quiet, Fade when idle, Book', ['Fade when full', 'Quiet', 'Fade when idle', 'Book'].every((l) => chosen(def).includes(l)), chosen(def));
  check('...a saved choice shows instead: Always, Classic, Always, Plain', ['Classic', 'Plain'].every((l) => chosen(mine).includes(l)) && chosen(mine).filter((l) => l === 'Always').length === 2, chosen(mine));
  check('...no native select anywhere (the size is a Picker)', !/<select/.test(html) && /class="dbo-picker jset__picker"|dbo-picker jset__picker|jset__picker/.test(html));
  const ssrc = FRONT_SRC('features/journal/tabs/SettingsTab.tsx');
  if (ssrc) {
    check('Help sends the report as journalReport; Controls points to the launcher', /act\('journalReport', text\)/.test(ssrc) && /Change these in the launcher \(Settings\), then restart the game\./.test(ssrc));
    check('...text fields keep their keys from the game (stopKeys)', (ssrc.match(/onKeyDown=\{stopKeys\}/g) || []).length >= 2 && /e\.stopPropagation\(\);/.test(ssrc));
    check('...the size goes through dboSetUiScaleInGame (the launcher snapshot rule)', /w\(\)\.dboSetUiScaleInGame\(v\)/.test(ssrc) && /window\.dboSetUiScaleInGame = /.test(FRONT_SRC('utils/UiScale.js')));
  }
}

// ---- the Magic tab (L4's schools.js __dboMagicView; piece H7). The sample is that view's shape on magic-flow-2 ----------
if (!J.JOURNAL_TABS || !J.JOURNAL_TABS.magic) {
  require('./expect')('journal-front', 'this front has no Magic tab');
  console.log('ok   (this front has no Magic tab yet: its checks are skipped)');
} else {
  const M = JSON.parse(fs.readFileSync(path.join(__dirname, 'journal-magic-sample.json'), 'utf8'));
  const mData = (sec) => ({ type: 'journal', id: 50, nonce: 'm1', hub: 1, tab: 'magic', tabs: [{ id: 'profile', label: 'Profile' }, { id: 'magic', label: 'Magic' }],
    head: { name: 'Aela', title: 'Apprentice Mage', race: 'Nord' }, magic: sec });
  html = render(Journal, { data: mData(M) });
  t = text(html);
  check('Magic: five schools, Enchanting not among them, in the journal\'s violet', (html.match(/class="jmagic__school /g) || []).length === 5 && !/Enchant/.test(t) && /journal__body--magic" data-domain="dragonbreak"/.test(html));
  check('...each with its level and role (primary, secondary, resting, closed, through Priest)', /Alteration 12 Secondary school/.test(t) && /Conjuration Closed/.test(t) && /Illusion 18 Resting/.test(t) && /Restoration 12 Through Priest/.test(t));
  check('...the primary school open first: Destruction, the Art of Ruin, 27 / 100 Apprentice, Adept at 50', /jmagic__title">Destruction</.test(html) && /The Art of Ruin/.test(t) && /27 \/ 100 Apprentice/.test(t) && /Adept at 50/.test(t));
  check('...what the rank really allows (no magicka cost bonus anywhere)', /You may read Destruction tomes up to Apprentice/.test(t) && !/magicka cost|-10%|-50%/i.test(t));
  check('...a first spell to choose: Flames, Sparks, Frostbite, each with its line', /Choose your first spell/.test(t) && /Flames A stream of fire/.test(t) && /Sparks Lightning/.test(t) && /Frostbite A stream of frost/.test(t) && (html.match(/>Choose</g) || []).length === 3);
  check('...the next tomes, with where they are sold', /Next tomes for you/.test(t) && /Firebolt Apprentice Sold by the Synod in Bruma/.test(t) && /Ice Spike Apprentice Sold in Skyrim/.test(t));
  check('Prepared 1 / 3, read only away from a ledger, saying where to change them', /Prepared \(1 \/ 3\)/.test(t) && /Change your prepared spells at a Scholars\' Ledger or in a college\./.test(t) && !/>Prepare<|>Put away</.test(html));
  check('Known spells: rank chips instead of a dropdown, the spells, one known without study', /All Novice Apprentice Adept Expert Master/.test(t) && !/<select/.test(html) && /Courage Illusion Novice/.test(t) && /Ancestor.s Wrath Destruction Novice known without study/.test(t));
  const ledger = JSON.parse(JSON.stringify(M)); ledger.book.canPrepare = true;
  html = render(Journal, { data: mData(ledger) });
  check('at a ledger: Put away on the prepared, Prepare on the others, none on a spell known without study', (html.match(/>Put away</g) || []).length === 2 && (html.match(/>Prepare</g) || []).length === 2);
  html = render(Journal, { data: mData({ v: 1, open: false }) });
  check('a player off the Wheel: what opens Magic', /Magic opens with Arcane Arts or Priest/.test(text(html)));
  // Views schools.js really built (magic-flow-2 886acc1d, its own harness's characters: a teacher, a priest, a mage)
  const real = JSON.parse(fs.readFileSync(path.join(__dirname, 'journal-magic-views.json'), 'utf8'));
  for (const who of Object.keys(real)) {
    let out = '';
    try { out = text(render(Journal, { data: mData(real[who]) })); } catch (e) { out = 'THREW ' + e.message; }
    check(`a view schools.js built (${who}) draws: its schools and its book`, !/THREW/.test(out) && (real[who].schools || []).every((x) => out.includes(x.name)) && /Prepared \(\d \/ 3\)/.test(out), out.slice(0, 300));
  }
  const msrc = FRONT_SRC('features/journal/tabs/MagicTab.tsx');
  if (msrc) check('...the actions: journalMagic firstSpell <school> <spell>, prepare and unprepare <spell>', /act\('journalMagic', 'firstSpell', s\.name, c\.id\)/.test(msrc) && /act\('journalMagic', sp\.prepared \? 'unprepare' : 'prepare', sp\.id\)/.test(msrc));
}

// ---- a journal read by staff (readOnly): the faction panel inert ------------------------------------------------------
if (typeof J.registerJournalTab === 'function') {
  const ro = render(Journal, { data: { type: 'journal', id: 50, nonce: 'r1', hub: 1, readOnly: 1, subject: 'ff000010', opened: 4, tab: 'faction',
    tabs: [{ id: 'profile', label: 'Profile' }, { id: 'faction', label: 'Faction' }], head: { name: 'Vaeliss Dren', title: 'x', race: 'Dunmer' },
    faction: faction({ invites: [{ factionId: 'mg', name: 'Mages Guild', from: 'Borin' }], factions: [Object.assign({}, faction().factions[0], { canKick: true, canSetRank: true, canInvite: true })] }) } });
  const buttons = (ro.match(/<button[^>]*class="faction__button[^"]*"[^>]*>/g) || []);
  check('read only: every faction button is disabled (Join, Decline, Remove, Invite, Leave)', buttons.length >= 4 && buttons.every((b0) => /disabled=""/.test(b0)), buttons);
  const pickers = (ro.match(/<button[^>]*class="dbo-picker__button[^"]*"[^>]*>/g) || []);
  check('...the rank Pickers too', pickers.length >= 1 && pickers.every((p0) => /disabled=""/.test(p0)), pickers);
  check('...and the footer says whose journal it is', /You are reading Vaeliss Dren.s journal\. Nothing can be changed here\./.test(text(ro)));
  const fsrc = FRONT_SRC('features/faction/index.tsx');
  if (fsrc) check('...FactionContent sends nothing read only', /const act = \(key: string, \.\.\.args: unknown\[\]\) => \{ if \(readOnly\) return;/.test(fsrc));
  const jsrc2 = FRONT_SRC('features/journal/index.tsx');
  if (jsrc2) check('the section cache starts afresh for each opening and each subject', /if \(cacheOf\.current !== opening\) \{ cacheOf\.current = opening; cache\.current = \{\}; \}/.test(jsrc2) && /data\.opened/.test(jsrc2) && /data\.subject/.test(jsrc2));
  const scss = FRONT_SRC('features/journal/tabs/SettingsTab.scss');
  if (scss) check('a Picker in Settings opens in the section\'s flow (the d26e2875 rule)', /&__content \.dbo-picker--open \.dbo-picker__list \{ position: static;/.test(scss));
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
