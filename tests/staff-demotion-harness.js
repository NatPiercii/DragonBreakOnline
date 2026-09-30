// Scripted test for gamemode.js's staffRolesSeen (2026-09-30): staff rights are read from the Discord roles written at
// login, so a demotion only took effect at the next login. The role sync hands a staff member's current roles to
// staffRolesSeen; a lower tier or none logs them out so the next login derives every right afresh. It cuts the tier
// code out of the gamemode and runs it with stubs. Run it from this folder's parent with
//
//   node tests/staff-demotion-harness.js
'use strict';
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.resolve(__dirname, '..', 'gamemode.js'), 'utf8');
const a = src.indexOf('const tierFrom = ');
const b = src.indexOf('const TIER_LABEL', a);
if (a < 0 || b < 0) { console.log('FAIL the tier markers are gone from gamemode.js'); process.exit(1); }
const code = src.slice(a, b);

let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };

const ROLE = { senior: 's1', developer: 'd1', leadgm: 'l1', gm: 'g1', legacy: 'x1', player: 'p1' };
const actors = {
  0x10: { profile: 5, roles: [ROLE.senior], user: 1 },
  0x11: { profile: 6, roles: [ROLE.gm], user: 2 },
  0x12: { profile: 7, roles: [ROLE.leadgm], user: 3 },
  0x13: { profile: 1, roles: [], user: 4 },            // senior by profile (adminProfileIds)
  0x14: { profile: 8, roles: [ROLE.player], user: 5 },
};
const audits = [], told = [], kicked = [];
const timers = [];
const T = new Function('ADMIN_PROFILES', 'TIERS', 'tierRoles', 'legacyAdminRoles', 'profileOf', 'rolesOf', 'idList', 'audit', 'who', 'personal', 'userOf', 'mp', 'log', 'setTimeout',
  code + '\nreturn { tierFrom, tierOf, staffRolesSeen };')(
  new Set([1]), ['senior', 'developer', 'leadgm', 'gm'], { senior: [ROLE.senior], developer: [ROLE.developer], leadgm: [ROLE.leadgm], gm: [ROLE.gm] }, [ROLE.legacy],
  (x) => actors[x].profile, (x) => actors[x].roles, (v) => (Array.isArray(v) ? v.map(String) : []),
  (t) => audits.push(t), (x) => `#${x.toString(16)}`, (x, t) => told.push([x, t]), (x) => actors[x].user,
  { kick: (u) => kicked.push(u) }, () => {}, (fn) => timers.push(fn));
const run = () => { while (timers.length) timers.shift()(); };

check('tierOf reads the login roles as before', T.tierOf(0x10) === 'senior' && T.tierOf(0x11) === 'gm' && T.tierOf(0x12) === 'leadgm' && T.tierOf(0x13) === 'senior' && T.tierOf(0x14) === null);

T.staffRolesSeen(0x10, [ROLE.gm]); run();
check('a Senior whose roles now give GM is logged out', kicked.includes(1) && /was senior/.test(audits[0] || '') && /now give gm/.test(audits[0] || ''), audits);
check('...and told why first', told.some(([x, t]) => x === 0x10 && /staff roles have changed/.test(t)));
T.staffRolesSeen(0x11, [ROLE.player]); run();
check('a GM whose staff role is gone is logged out', kicked.includes(2), kicked);
T.staffRolesSeen(0x12, []); run();
check('a Lead GM who left the guild is logged out', kicked.includes(3), kicked);

kicked.length = 0; audits.length = 0;
T.staffRolesSeen(0x11, [ROLE.gm, ROLE.player]); run();
check('the same tier: nothing happens', kicked.length === 0 && audits.length === 0);
T.staffRolesSeen(0x11, [ROLE.senior]); run();
check('a promotion is left for the next login (no logout)', kicked.length === 0, kicked);
T.staffRolesSeen(0x13, []); run();
check('a Senior by profile id is not affected by Discord roles', kicked.length === 0);
T.staffRolesSeen(0x14, []); run();
check('a player who is not staff is never logged out by this', kicked.length === 0);
T.staffRolesSeen(0x11, [ROLE.legacy]); run();
check('the legacy admin role still counts (as Senior)', kicked.length === 0);

check('discordroles.js is given isStaff and staffRolesSeen', /require\(DISCORDROLES_JS\)\(\{[\s\S]*?isStaff: \(a\) => tierOf\(a\) !== null, staffRolesSeen \}\)/.test(src));

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
