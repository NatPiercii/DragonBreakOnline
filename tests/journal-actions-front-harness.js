// Scripted test for the journal's Profile buttons (front 0.3.88; journal.js journalAction): renders the real widget's
// ActionsBox and ProfileTab with React's static renderer. run-all bundles the widget from $FORK; by hand:
//
//   node tests/journal-actions-front-harness.js <bundle of skymp5-front/src/features/journal/index.tsx>
//
// A static render shows no click, so Unstuck's confirm step is checked as the first state (one button, no move).
'use strict';
const fs = require('fs');
const bundle = process.argv[2];
if (!bundle) { console.log('usage: node tests/journal-actions-front-harness.js <bundle>'); process.exit(2); }
if (!/journal__actions/.test(fs.readFileSync(bundle, 'utf8'))) {
  require('./expect')('journal-actions-front', 'this front has no buttons on the Profile tab');
  console.log('ok   skipped: this front predates the Profile tab\'s buttons');
  process.exit(0);
}
const J = require(bundle);
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got).slice(0, 500)}`); if (!c) fails++; };
const render = (W, props) => J.renderToStaticMarkup(J.createElement(W, props));
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&apos;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const act = () => {};

let h = render(J.ActionsBox, { points: 2, busy: false, act });
ok(/2 level points to spend/.test(text(h)) && /\+1 Health/.test(h) && /\+1 Magicka/.test(h) && /\+1 Stamina/.test(h), 'points waiting: +1 Health, Magicka and Stamina', text(h).slice(0, 200));
ok(/Call a GM/.test(h) && /Report a problem/.test(h) && (h.match(/<textarea/g) || []).length === 2, 'Call a GM and Report a problem, each with its own text box');
ok(/>Unstuck<\/button>/.test(h) && !/Move me/.test(h), 'Unstuck asks before moving anyone: its first state is one button, no move');
ok((h.match(/disabled=""/g) || []).length === 2, 'Send stays off until there is something to send (both boxes empty)', (h.match(/disabled=""/g) || []).length);
h = render(J.ActionsBox, { points: 0, busy: false, act });
ok(!/level point/.test(h) && !/\+1 /.test(h), 'no points: no level buttons');
h = render(J.ActionsBox, { points: 1, busy: true, act });
ok(/1 level point to spend/.test(text(h)) && !/<button(?![^>]*disabled)[^>]*>/.test(h), 'while an answer is on its way every button waits', h.slice(0, 300));
const profile = { name: 'Aela', race: 'Nord', playtime: '3h', backstory: '', origin: '', backstoryMax: 4000, originMax: 1000, skills: [], title: 'Wanderer', titleId: 'x', titles: [] };
h = render(J.ProfileTab, { data: { profile: Object.assign({ status: [], levelPoints: 1 }, profile) }, editing: false, setEditing: () => {}, busy: false, act });
ok(/journal__status[\s\S]*journal__actions/.test(h), 'the Profile tab shows them under Status');
h = render(J.ProfileTab, { data: { profile }, editing: false, setEditing: () => {}, busy: false, act });
ok(!/journal__actions/.test(h), 'an older server (no status): no buttons, which it could not answer');
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
