// Scripted test for the school meters on the skills menu's Arcane Arts page (skymp5-front masteryMenu; gameplay
// schools.js, Swag's magic rework): renders the real widget with React's static renderer for the dboSchoolProgress
// payload schools.js sends. run-all bundles the widget from $FORK; by hand:
//
//   node tests/school-meters-harness.js <bundle of skymp5-front/src/features/masteryMenu/index.tsx>
//
// A front from before the schools has nothing to test, which is said and not failed: the gameplay side stays off for any
// client that does not report the 'schools' capability.
'use strict';
const fs = require('fs');

const bundle = process.argv[2];
if (!bundle) { console.log('usage: node tests/school-meters-harness.js <bundle>'); process.exit(2); }
if (!/mastery__schools/.test(fs.readFileSync(bundle, 'utf8'))) {
  require('./expect')('school-meters', 'this front has no school meters');
  console.log('ok   skipped: this front predates the schools of magic');
  process.exit(0);
}
const { Widget: MasteryMenu, renderToStaticMarkup, createElement } = require(bundle);

let failures = 0;
const check = (label, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && got !== undefined ? '   ' + JSON.stringify(got).slice(0, 400) : ''}`); if (!ok) failures++; };
const render = (W, data) => renderToStaticMarkup(createElement(W, { data }));
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

// ---- the skills menu (K): the meters take the place of the five rank cards on the Arcane Arts page ----
const skills = [
  { id: 'blunt', category: 'combat', label: 'Blunt', title: 'The Heavy Hand', description: 'Maces.', tiers: ['a', 'b', 'c', 'd', 'e'] },
  { id: 'arcane', category: 'combat', label: 'Arcane Arts', title: 'The Ordered Mind', description: 'Magic.', tiers: ['Novice spells', 'Apprentice spells', 'Adept spells', 'Expert spells', 'Master spells'] },
];
const points = (first) => ({ enabled: true, pool: 300, used: 60, capPerSkill: 100, seatAbove: 90, seatCount: 1, expertAbove: 75, expertCount: 3, transferFloor: 25, offers: [],
  held: [{ id: first, level: 80, xp: 20, tier: 3, lock: 'raise' }, { id: first === 'arcane' ? 'blunt' : 'arcane', level: 10, xp: 0, tier: 0, lock: 'raise' }] });
const meter = (name, role, level, rank, choose) => ({ name, role, roleLabel: role === 'primary' ? 'Primary school' : role === 'secondary' ? 'Secondary school' : 'Closed', level, rank, fill: role === 'locked' ? 0 : level / 100, hint: role === 'locked' ? (choose ? '' : 'Closed to you') : 'Master at 90', choose });
const secondary = (name) => ({ as: 'secondary', label: 'Choose as secondary', title: `Choose ${name}?`, confirm: `Do you want to choose ${name} as your secondary school of magic?`, yes: 'Choose', no: 'Not yet' });
const schools = {
  skill: 'arcane', title: 'Schools of Magic', note: 'Your Arcane Arts has reached 76: you may take up one more school as your secondary.', nonce: 'n1',
  floors: [1, 25, 50, 75, 90], ranks: ['Novice', 'Apprentice', 'Adept', 'Expert', 'Master'],
  schools: [meter('Destruction', 'primary', 80, 'Expert', null), meter('Illusion', 'locked', 0, '', secondary('Illusion')), meter('Conjuration', 'locked', 0, '', secondary('Conjuration')), meter('Alteration', 'locked', 0, '', secondary('Alteration'))],
  events: { choose: 'dbo:schoolChoose' },
};
const menu = (first, extra) => Object.assign({ skills, categories: [{ id: 'combat', label: 'Combat' }], points: points(first), tierNames: ['Novice', 'Apprentice', 'Journeyman', 'Expert', 'Master'], chosen: [], events: { choose: 'c', drop: 'd', lock: 'l', takeUp: 't', close: 'x' }, profession: null, rank: 0, hours: 0, rankHours: [], professions: [] }, extra || {});

let html = render(MasteryMenu, menu('arcane', { schools }));
let t = text(html);
check('the Arcane Arts page shows the four schools in Swag\'s order', /Schools of Magic Destruction Primary school Expert · 80 Master at 90 Illusion Closed Choose as secondary Conjuration Closed Choose as secondary Alteration Closed Choose as secondary/.test(t), t);
check('...in place of the five rank cards', !/Novice spells/.test(t) && (html.match(/class="mastery__school mastery__school--/g) || []).length === 4, (html.match(/class="mastery__school[^"]*"/g) || []));
check('...each meter filled bottom to top by its level, with the four rank floors above Novice ticked', /mastery__school-meter[^]*?height:80%/.test(html) && (html.match(/mastery__school-tick/g) || []).length === 16, (html.match(/height:[0-9.]+%/g) || []));
check('...closed schools are marked and carry their hue class', /mastery__school mastery__school--locked mastery__school--illusion/.test(html) && /mastery__school mastery__school--primary mastery__school--destruction/.test(html));
check('...and the note says why a secondary is offered', /may take up one more school as your secondary/.test(t));
t = text(render(MasteryMenu, menu('blunt', { schools })));
check('another skill\'s page keeps its rank cards and shows no meters', /Maces/.test(t) && !/Schools of Magic/.test(t) && /Journeyman/.test(t), t);
t = text(render(MasteryMenu, menu('arcane', { schools: null })));
check('without the schools (off, or an old server) Arcane Arts shows its rank cards', /Adept spells/.test(t) && !/Schools of Magic/.test(t), t);
t = text(render(MasteryMenu, menu('arcane', { schools: Object.assign({}, schools, { skill: 'priest' }) })));
check('meters meant for another skill are not drawn on Arcane Arts', !/Schools of Magic/.test(t), t);

console.log(failures ? `${failures} failure(s)` : 'all checks passed');
process.exit(failures ? 1 : 0);
