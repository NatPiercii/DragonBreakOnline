// Scripted test for the Class Lectern panel (skymp5-front classLectern, widget 72; gameplay schools.js): renders the
// real widget with React's static renderer for the payloads schools.js sends. run-all bundles the widget from $FORK; by
// hand:
//
//   node tests/class-lectern-harness.js <bundle of skymp5-front/src/features/classLectern/index.tsx>
//
// A front from before the schools has nothing to test, which is said and not failed.
'use strict';
const fs = require('fs');

const bundle = process.argv[2];
if (!bundle) { console.log('usage: node tests/class-lectern-harness.js <bundle>'); process.exit(2); }
if (!/classLectern__/.test(fs.readFileSync(bundle, 'utf8'))) {
  require('./expect')('class-lectern', 'this front has no Class Lectern panel');
  console.log('ok   skipped: this front predates the schools of magic');
  process.exit(0);
}
const { Widget: ClassLectern, renderToStaticMarkup, createElement } = require(bundle);

let failures = 0;
const check = (label, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && got !== undefined ? '   ' + JSON.stringify(got).slice(0, 400) : ''}`); if (!ok) failures++; };
const render = (W, data) => renderToStaticMarkup(createElement(W, { data }));
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
let t, h;

// ---- the Class Lectern ----
const LEV = { start: 'dbo:lecternStart', join: 'dbo:lecternJoin', leave: 'dbo:lecternLeave', end: 'dbo:lecternEnd', cancel: 'dbo:lecternCancel', close: 'dbo:lecternClose' };
const lectern = (over) => Object.assign({ id: 72, nonce: 'l1', title: 'Class Lectern', result: '', resultKind: '', events: LEV }, over);
t = text(render(ClassLectern, lectern({ mode: 'idle', status: 'No class is being held here.', canTeach: false, whyNot: 'Only teachers the Synod has named may hold a class. Ask the staff.', spells: [] })));
check('idle, not a teacher: the reason and no Begin button', /No class is being held here\. Only teachers the Synod has named/.test(t) && !/Begin the class/.test(t), t);
t = text(render(ClassLectern, lectern({ mode: 'idle', status: 'No class is being held here.', canTeach: true, whyNot: '', minutes: 30,
  spells: [{ id: '10f7ed:Skyrim.esm', name: 'Incinerate', school: 'Destruction', rank: 3, rankName: 'Expert' }, { id: '1c789:Skyrim.esm', name: 'Fireball', school: 'Destruction', rank: 2, rankName: 'Adept' }] })));
check('idle, a teacher: the spells they may set it by, lowest rank first, and Begin the class', /Choose the spell your class is set by\. It decides the school and the rank; your students do not learn it\. The class runs 30 minutes\./.test(t) && /Destruction Adept Fireball Destruction Expert Incinerate/.test(t) && /Begin the class/.test(t), t);
const running = (over) => lectern(Object.assign({ mode: 'running', status: 'Class in Progress', teacher: 'Teacher #AB12', spell: 'Incinerate', school: 'Destruction', rankName: 'Expert', endsInMs: 25 * 60000 + 30000, minutes: 30, teacherAway: 0,
  students: [{ name: 'Adept #CD34', away: false }, { name: 'Other #EF56', away: true }], role: 'visitor', gain: 'At your study of Destruction you would take 70% of the lesson.', canJoin: true, whyNot: '', canEnd: false }, over));
t = text(render(ClassLectern, running()));
check('running, a visitor: Class in Progress with the countdown, the lesson, the students, what they would take, Sign up', /Class in Progress 25:30/.test(t) && /Teacher Teacher #AB12 Lesson Incinerate \(Destruction, Expert\) Students Adept #CD34\s*, Other #EF56 \(away\)/.test(t) && /you would take 70% of the lesson/.test(t) && /Sign up/.test(t), t);
t = text(render(ClassLectern, running({ canJoin: false, whyNot: 'At your study of Destruction this class would teach you nothing.' })));
check('...refused: the reason, no Sign up', /would teach you nothing/.test(t) && !/Sign up/.test(t), t);
t = text(render(ClassLectern, running({ role: 'student', canJoin: false, gain: '' })));
check('running, a student: Leave the class', /Leave the class/.test(t) && !/Sign up/.test(t), t);
h = render(ClassLectern, running({ role: 'teacher', gain: '' }));
check('running, the teacher before the time: End Class is there but disabled, Cancel is not', /<button class="tomeShop__button" disabled="">End Class<\/button>/.test(h) && /Cancel the class/.test(h), h.match(/<button[^>]*>[^<]*<\/button>/g));
h = render(ClassLectern, running({ role: 'teacher', gain: '', canEnd: true, endsInMs: 0, status: 'The class has run its course.' }));
check('...after it: End Class enabled', /<button class="tomeShop__button">End Class<\/button>/.test(h) && /The class has run its course\. 0:00/.test(text(h)), h.match(/<button[^>]*>[^<]*<\/button>/g));
t = text(render(ClassLectern, running({ role: 'teacher', gain: '', teacherAway: 4 * 60000 })));
check('the grace period is shown while the teacher is away', /The class is cancelled in 4:00 unless they return/.test(t), t);

console.log(failures ? `${failures} failure(s)` : 'all checks passed');
process.exit(failures ? 1 : 0);
