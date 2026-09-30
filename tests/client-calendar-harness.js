// The client's calendar (fork client-worldclock-year, skymp5-client calendar.ts, used by TimeService): the engine's year
// comes from the server's dboClock packet (startYear, 4E 211 by the server's lore) instead of the engine's own 4E 201, so
// the Wait menu and the journal agree with /time. A packet with no or a nonsense startYear means 211.
//   node tests/client-calendar-harness.js <bundled calendar.js>   (from server/; run-all bundles it from FORK)
'use strict';
const fs = require('fs');
const path = require('path');
const bundle = process.argv[2];
if (!bundle) { console.error('usage: node tests/client-calendar-harness.js <bundled calendar.js>'); process.exit(2); }
if (!fs.statSync(bundle).size) { require('./expect')('client-calendar', 'this client has no calendar module'); console.log('ok   skipped: this client has no calendar module yet (before client-worldclock-year)'); process.exit(0); }
const { calendarOf, startYearOf, DEFAULT_START_YEAR, MONTH_DAYS } = require(path.resolve(bundle));
let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${c || got === undefined ? '' : '   ' + JSON.stringify(got)}`); if (!c) fails++; };

ok(DEFAULT_START_YEAR === 211, 'the default start year is 4E 211');
ok(JSON.stringify(calendarOf(0.5)) === JSON.stringify({ year: 211, month: 7, day: 17 }), 'day 0 is 17 Last Seed 4E 211', calendarOf(0.5));
ok(JSON.stringify(calendarOf(136.9)) === JSON.stringify({ year: 211, month: 11, day: 31 }), '136 days on is 31 Evening Star 4E 211', calendarOf(136.9));
ok(JSON.stringify(calendarOf(137)) === JSON.stringify({ year: 212, month: 0, day: 1 }), 'the next day is 1 Morning Star 4E 212', calendarOf(137));
ok(calendarOf(137 + 365).year === 213, 'a full year later is 4E 213 (365 days, no leap day)', calendarOf(137 + 365));
ok(MONTH_DAYS.reduce((n, d) => n + d, 0) === 365, 'the months add to 365');
ok(calendarOf(0, 215).year === 215, 'a start year from the server is used');
ok(startYearOf(211) === 211 && startYearOf('211') === 211 && startYearOf(215.7) === 215, "the packet's startYear is read");
ok([undefined, null, 'soon', NaN, 0, -5, 5000].every((v) => startYearOf(v) === 211), 'a missing or nonsense startYear (an older server) means 211');
// The server's own calendar (worldclock.js) must name the same day for the same GameDaysPassed
const src = fs.readFileSync(path.resolve(__dirname, '..', 'worldclock.js'), 'utf8');
ok(/month = 7, day = 17 \+ Math\.floor\(gameDays\(\)\)/.test(src) && /startYear: 211/.test(src), "the server's calendar starts on the same day and year (worldclock.js)");

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
