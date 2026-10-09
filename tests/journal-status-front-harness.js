// Scripted test for the journal's Status on the Profile tab (front 0.3.88; journal.js profile.status): renders the real
// widget's StatusBox and ProfileTab with React's static renderer. run-all bundles the widget from $FORK; by hand:
//
//   node tests/journal-status-front-harness.js <bundle of skymp5-front/src/features/journal/index.tsx>
'use strict';
const fs = require('fs');
const bundle = process.argv[2];
if (!bundle) { console.log('usage: node tests/journal-status-front-harness.js <bundle>'); process.exit(2); }
if (!/journal__status/.test(fs.readFileSync(bundle, 'utf8'))) {
  require('./expect')('journal-status-front', 'this front has no Status on the Profile tab');
  console.log('ok   skipped: this front predates the Profile tab\'s Status');
  process.exit(0);
}
const J = require(bundle);
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got).slice(0, 500)}`); if (!c) fails++; };
const render = (W, props) => J.renderToStaticMarkup(J.createElement(W, props));
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&apos;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');

const rows = [{ label: "Death's Chill", value: '12 min', hint: 'A Priest of tier 2 or higher can lift it with a healing spell' },
  { label: 'Hunger', value: '40% (Peckish)' }, { label: 'Level', value: '7, 2 points to spend' }, { label: 'Dungeons resting', value: 'Anga 34 min' }];
let h = render(J.StatusBox, { rows });
ok(/<h2[^>]*>Status<\/h2>/.test(h) && (h.match(/<tr/g) || []).length === 4, 'the Status box draws one row per line', text(h));
ok(/Death's Chill 12 min A Priest of tier 2/.test(text(h)) && /Level 7, 2 points to spend/.test(text(h)), 'each row: the name, the value, and its hint', text(h));
h = render(J.StatusBox, { rows: [] });
ok(/Nothing is weighing on you/.test(text(h)), 'nothing to report: a quiet line, not an empty table');
const profile = { name: 'Aela', race: 'Nord', playtime: '3h', backstory: '', origin: '', backstoryMax: 4000, originMax: 1000, skills: [], title: 'Wanderer', titleId: 'x', titles: [] };
h = render(J.ProfileTab, { data: { profile: Object.assign({ status: rows }, profile) }, editing: false, setEditing: () => {}, busy: false, act: () => {} });
ok(/journal__profile-side[\s\S]*journal__status[\s\S]*Death&#x27;s Chill/.test(h), 'the Profile tab shows it in its side column', text(h).slice(0, 300));
h = render(J.ProfileTab, { data: { profile }, editing: false, setEditing: () => {}, busy: false, act: () => {} });
ok(!/journal__status/.test(h), 'an older server sends no status: the tab is as before');
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
