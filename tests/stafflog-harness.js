// Scripted test for the #staff-commands lines in gamemode.js: every line names the staff member's Discord account next
// to their character (Nate, 2026-09-27: a panel line read only "Nilis Urnum #R4XY (panel) profile 7 gave 133 spells to
// themself"). Runs staffWho against stubs, then checks that each staffLog call builds its posted line from staffWho.
// Run it from this folder's parent with
//
//   node tests\stafflog-harness.js
'use strict';
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.resolve(__dirname, '..', 'gamemode.js'), 'utf8');
const line = src.split('\n').find((l) => l.startsWith('const staffWho = '));
let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail !== undefined ? '   ' + detail : ''}`); if (!ok) failures++; };
if (!line) { console.log('FAIL staffWho is gone from gamemode.js'); process.exit(1); }

const discord = new Map([[0x14, '457340616230174740']]);
const staffWho = new Function('display', 'discordOf', `${line}\nreturn staffWho;`)(
  (a) => (a === 0x14 ? 'Nilis Urnum #R4XY' : 'Guest #GST1'), (a) => discord.get(a) || '');
check('a staff member with a Discord account is named with its mention', staffWho(0x14) === 'Nilis Urnum #R4XY <@457340616230174740>', staffWho(0x14));
check('without one, the character alone', staffWho(0x15) === 'Guest #GST1', staffWho(0x15));

// Every staffLog call: its fourth argument (the line posted) must start from staffWho, or 'staff' when no one is online
const calls = src.split('\n').filter((l) => /staffLog\(/.test(l) && !/const staffLog = /.test(l));
// The sixth is charters.js's staffNote: the founder or the GM who acted, named the same way
check('the gamemode logs staff actions from six places', calls.length === 6, calls.length);
for (const c of calls) {
  const posted = c.slice(c.indexOf('staffLog('));
  check(`posted line names the Discord account: ${posted.slice(0, 70)}...`, /`\$\{(?:actor \? )?staffWho\((?:a|actor)\)/.test(posted));
}
check('the post pings nobody', /allowed_mentions: \{ parse: \[\] \}/.test(src.slice(src.indexOf('const flushStaff'), src.indexOf('const staffSummary'))));

console.log(failures ? `${failures} failure(s)` : 'all passed');
process.exit(failures ? 1 : 0);
