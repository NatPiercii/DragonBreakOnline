// The treasury guard in gamemode.js (review B1): a hold's treasury chest refuses everyone but staff, with one message
// and one audit line a second and a half, and other chests are untouched. The section is cut out of gamemode.js (from
// its comment to mp.onActivate) and run with stubs. Run it from this folder's parent with
//
//   node tests\treasury-guard-harness.js
'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.resolve(__dirname, '..', 'gamemode.js'), 'utf8');
const start = src.indexOf("// A hold's treasury chest is paid into at a bank");
const end = src.indexOf('mp.onActivate = (targetId, casterId) => {');
if (start < 0 || end < start) { console.log('FAIL the section markers are gone from gamemode.js'); process.exit(1); }
if (!/if \(treasuryRefused\(caster, target\)\) return false;/.test(src.slice(end, end + 1200))) { console.log('FAIL the activate chain no longer asks the treasury guard first'); process.exit(1); }

let now = 1000000; Date.now = () => now;
const SAFE = 0x0209b22, CHEST = 0x0300a01, STAFF = 0xff000001, CITIZEN = 0xff000002;
const said = []; const audits = [];
const zones = [{ id: 'bruma', treasury: '79b22:BSHeartland.esm' }, { id: 'whiterun' }];
const mp = { getIdFromDesc: (d) => (d === '79b22:BSHeartland.esm' ? SAFE : 0) };
const f = new Function('mp', 'zoneList', 'isAdmin', 'lastPickupDeny', 'personal', 'audit', 'who',
  src.slice(start, end) + '\nreturn treasuryRefused;')(mp, () => zones, (a) => a === STAFF, new Map(), (a, t) => said.push({ a, t }), (t) => audits.push(t), (a) => `P${a.toString(16)}`);

let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail !== undefined ? '   ' + detail : ''}`); if (!ok) failures++; };
check('a citizen is refused the treasury chest', f(CITIZEN, SAFE) === true && /hold's treasury/.test(said[0].t) && audits.length === 1);
check('mashing E gives one message and one audit line', f(CITIZEN, SAFE) === true && said.length === 1 && audits.length === 1);
now += 2000;
check('a second and a half later, one more', f(CITIZEN, SAFE) === true && said.length === 2 && audits.length === 2);
check('staff open it', f(STAFF, SAFE) === false);
check('any other chest is not the guard\'s business', f(CITIZEN, CHEST) === false);
console.log(failures ? `${failures} failure(s)` : 'all passed');
process.exit(failures ? 1 : 0);
