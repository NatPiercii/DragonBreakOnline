// Trial GM (Nate, 9 Oct): a fifth staff tier below GM with a few tools (tp, fixloc, kick) and nothing else: isAdmin,
// isLeadStaff and every other staff right stay false. Cuts the tier code and the command gate out of gamemode.js.
//   node tests/trial-gm-harness.js
'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.resolve(__dirname, '..', 'gamemode.js'), 'utf8');
const a = src.indexOf('const tierFrom = '), b = src.indexOf('const TIER_LABEL', a);
let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };
check('the tier code is found', a > 0 && b > a);
const ROLE = { gm: 'g1', trial: 't1', player: 'p1' };
const actors = { 0x11: [ROLE.gm], 0x15: [ROLE.trial], 0x14: [ROLE.player] };
const T = new Function('ADMIN_PROFILES', 'TIERS', 'tierRoles', 'legacyAdminRoles', 'profileOf', 'rolesOf', 'idList',
  src.slice(a, b) + '\nreturn { tierOf, isAdmin, isLeadStaff, TRIAL_GM_COMMANDS, TIER_RANK };')(
  new Set(), ['senior', 'developer', 'leadgm', 'gm', 'trialgm'], { senior: [], developer: [], leadgm: [], gm: [ROLE.gm], trialgm: [ROLE.trial] }, [],
  () => 99, (id) => actors[id] || [], (x) => x);
check('a Trial GM role gives the trialgm tier', T.tierOf(0x15) === 'trialgm', T.tierOf(0x15));
check('...which is no admin anywhere else (panel, placing, property, staff chat)', T.isAdmin(0x15) === false);
check('...and no lead staff', T.isLeadStaff(0x15) === false);
check('...with exactly tp, fixloc and kick', [...T.TRIAL_GM_COMMANDS].sort().join(',') === 'fixloc,kick,tp', [...T.TRIAL_GM_COMMANDS]);
check('...ranked below a GM, so a promotion to GM is no demotion', T.TIER_RANK.trialgm < T.TIER_RANK.gm && T.TIER_RANK.trialgm > 0);
check('a GM is unchanged: admin, not lead staff', T.isAdmin(0x11) === true && T.isLeadStaff(0x11) === false);
check('a player is nothing', T.tierOf(0x14) === null && T.isAdmin(0x14) === false);
// The command gate lets a Trial GM through only for those commands, and logs it as staff
const gate = src.slice(src.indexOf("const trial = c.admin && tierOf(a) === 'trialgm'"), src.indexOf("try { c.fn(a, body, userId); }"));
check('the command gate admits a Trial GM only for TRIAL_GM_COMMANDS', /TRIAL_GM_COMMANDS\.has\(cmd\)/.test(gate) && /if \(c\.admin && !isAdmin\(a\) && !trial\)/.test(gate));
check('...and staff-logs what they run', /if \(staffCmd && \(isAdmin\(a\) \|\| trial\)\) staffLog/.test(gate));
console.log('');
console.log(failures ? `${failures} FAILURES` : 'all checks passed');
process.exit(failures ? 1 : 0);
