// Scripted test for the Study Magic panel (skymp5-front studyMagic, widget 73; gameplay schools.js): renders the real
// widget with React's static renderer for the payloads schools.js sends. run-all bundles the widget from $FORK; by hand:
//
//   node tests/study-magic-harness.js <bundle of skymp5-front/src/features/studyMagic/index.tsx>
//
// A front from before the schools has nothing to test, which is said and not failed.
'use strict';
const fs = require('fs');

const bundle = process.argv[2];
if (!bundle) { console.log('usage: node tests/study-magic-harness.js <bundle>'); process.exit(2); }
if (!/studyMagic__/.test(fs.readFileSync(bundle, 'utf8'))) {
  require('./expect')('study-magic', 'this front has no Study Magic panel');
  console.log('ok   skipped: this front predates the schools of magic');
  process.exit(0);
}
const { Widget: StudyMagic, renderToStaticMarkup, createElement } = require(bundle);

let failures = 0;
const check = (label, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && got !== undefined ? '   ' + JSON.stringify(got).slice(0, 400) : ''}`); if (!ok) failures++; };
const render = (W, data) => renderToStaticMarkup(createElement(W, { data }));
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
let t, h;

// ---- Study Magic ----
const EV = { choose: 'dbo:schoolChoose', start: 'dbo:studyStart', stop: 'dbo:studyStop', close: 'dbo:studyClose' };
const study = (over) => Object.assign({ id: 73, nonce: 's1', title: 'Study Magic', mode: 'idle', school: 'Conjuration', level: 12, rank: 'Novice', fill: 0.12, leftSeconds: 1200, tickSeconds: 10, gained: 0, whyNot: '', choices: [], result: '', resultKind: '', events: EV }, over);
const choices = ['Destruction', 'Illusion', 'Conjuration', 'Alteration'].map((n) => ({ name: n, blurb: `${n} line.`, confirm: `Do you want to choose ${n}?` }));
t = text(render(StudyMagic, study({ mode: 'choose', school: '', choices })));
check('with no school the panel asks for one: four schools with their lines', /Study Magic Before the books can teach you, choose the school/.test(t) && /Destruction Destruction line\. Illusion Illusion line\. Conjuration Conjuration line\. Alteration Alteration line\./.test(t), t);
t = text(render(StudyMagic, study({ mode: 'studying', gained: 3, leftSeconds: 1165 })));
check('studying: the school, its rank and level, what the sitting earned, the time left, and Close the books', /Conjuration Novice · 12/.test(t) && /This sitting: 3 units of study/.test(t) && /Time left for study: 19:25/.test(t) && /Close the books/.test(t) && !/Study Leave/.test(t), t);
h = render(StudyMagic, study({ mode: 'idle', whyNot: "You've done enough studying for the day. Come back in 3 hours." }));
t = text(h);
check('spent: the reason, and no Study button', /You've done enough studying for the day\. Come back in 3 hours\./.test(t) && !/>Study<\/button>/.test(h) && />Leave<\/button>/.test(h), t);
t = text(render(StudyMagic, study({ mode: 'idle', result: 'You close the books.', resultKind: 'ok' })));
check('idle with time left: a Study button to begin again', /Study Leave/.test(t) && /You close the books\./.test(t), t);

console.log(failures ? `${failures} failure(s)` : 'all checks passed');
process.exit(failures ? 1 : 0);
