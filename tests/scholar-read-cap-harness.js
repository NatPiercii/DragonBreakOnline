// Nate, 9 Oct: a Scholar who can earn nothing right now is refused a reading round (gamemode.js scholarNoRoom).
// Lifts the function out of gamemode.js and drives it with a stub mp and the real skills.json pointSystem.
//   node tests/scholar-read-cap-harness.js   (from server/)
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'gamemode.js'), 'utf8');
const start = src.indexOf('const scholarNoRoom = ');
const end = src.indexOf('globalThis.__dboScholarNoRoom = scholarNoRoom;');
let fails = 0;
const ok = (label, cond, got) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${!cond && got !== undefined ? `: got ${JSON.stringify(got)}` : ''}`); if (!cond) fails++; };
ok('scholarNoRoom is in gamemode.js', start > 0 && end > start);
const SKILLS_DEF = JSON.parse(fs.readFileSync(path.join(ROOT, 'skills.json'), 'utf8'));
const ps = SKILLS_DEF.pointSystem;
let rec = null;
const mp = { get: () => rec };
const fn = new Function('mp', 'SKILLS_DEF', `${src.slice(start, end)}; return scholarNoRoom;`)(mp, SKILLS_DEF);
const NOW = Date.parse('2026-10-09T12:00:00Z'), DAY = '2026-10-09';
const scholar = (o) => Object.assign({ level: 40, lock: 'raise', bucket: { tokens: 5, at: NOW }, day: DAY, spentToday: 0 }, o);
const make = (s, extra = {}, others = {}) => ({ order: ['scholar', 'blade'], day: DAY, spentToday: 0, skills: Object.assign({ scholar: scholar(s), blade: { level: 10 } }, others), ...extra });

rec = make({}); ok('room to earn: reading allowed', fn(1, NOW) === null, fn(1, NOW));
rec = { order: ['blade'], skills: { blade: { level: 10 } } }; ok('not a Scholar: never refused (work is banked)', fn(1, NOW) === null);
rec = make({ lock: 'lower' }); ok('Scholar marked to fall: refused', /marked to fall/.test(fn(1, NOW) || ''));
rec = make({ bucket: { tokens: 0, at: NOW } }); ok('bucket empty: refused with minutes', /read again in about \d+ minutes/.test(fn(1, NOW) || ''), fn(1, NOW));
rec = make({ bucket: { tokens: 0, at: NOW - 3600000 } }); ok('...an hour later the bucket has refilled', fn(1, NOW) === null);
rec = make({ spentToday: ps.dailyCaps.low }); ok('skill daily cap reached: refused until midnight', /after midnight/.test(fn(1, NOW) || ''));
rec = make({ spentToday: ps.dailyCaps.low, day: '2026-10-08' }); ok('...yesterday\'s spending does not count today', fn(1, NOW) === null);
rec = make({ level: 80, spentToday: ps.dailyCaps.expert }); ok('expert skill uses the expert daily cap', /after midnight/.test(fn(1, NOW) || ''));
rec = make({}, { spentToday: ps.characterDaily }); ok('character daily cap reached: refused', /one day allows/.test(fn(1, NOW) || ''));
rec = make({ level: ps.expertAbove }, {}, { a: { level: 80 }, b: { level: 80 }, c: { level: 80 } }); ok('three other skills above 75: Scholar held at 75, refused', /rise no further than 75/.test(fn(1, NOW) || ''), fn(1, NOW));
rec = make({ level: 74 }, {}, { a: { level: 80 }, b: { level: 80 }, c: { level: 80 } }); ok('...below the hold it still reads', fn(1, NOW) === null);
rec = make({ level: ps.capPerSkill }); ok('Scholar at 100: refused', /at its peak/.test(fn(1, NOW) || ''));
console.log(fails ? `${fails} FAILED` : 'all checks passed');
process.exit(fails ? 1 : 0);
