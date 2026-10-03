// adminSystem's setSchool (F3 design 3.10, piece H12; Nate's N7): a Lead GM sets a player's school level through
// schools.js __dboAdminSetSchool (L4), a GM is refused, the level is checked, and the Skills detail the panel gets back
// carries the five schools from __dboMagicView. Also that L1's giveDisease still answers on the same line.
//
//   node tests/admin-school-harness.js <bundled adminSystem.js>
//
// An adminSystem without setSchool has nothing to test, which is said and not failed.
'use strict';
const fs = require('fs');
const path = require('path');

const bundle = process.argv[2];
if (!bundle) { console.error('usage: node tests/admin-school-harness.js <bundled adminSystem.js>'); process.exit(2); }
const SRC = fs.readFileSync(bundle, 'utf8');
if (!/__dboAdminSetSchool/.test(SRC)) { require('./expect')('admin-school', 'this adminSystem has no setSchool'); console.log('ok   skipped: this adminSystem has no setSchool'); process.exit(0); }
const { AdminSystem } = require(path.resolve(bundle));

let fails = 0;
const ok = (label, cond, got) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${!cond && got !== undefined ? `: got ${JSON.stringify(got)}` : ''}`); if (!cond) fails++; };

const LEAD = 0x14, GM = 0x15, PLAYER = 0x16;
const users = new Map([[1, LEAD], [2, GM], [3, PLAYER]]);
const names = new Map([[LEAD, 'Lead'], [GM, 'Plain GM'], [PLAYER, 'Mira']]);
const sent = [];
const mp = {
  isConnected: (u) => users.has(u),
  getUserActor: (u) => users.get(u) || 0,
  get: (id, k) => (k === 'appearance' ? { name: names.get(id) } : k === 'profileId' ? id : k === 'ff_charTag' ? `T${id}` : undefined),
  set: () => {},
  sendCustomPacket: (u, s) => sent.push({ u, p: JSON.parse(s) }),
};
const ctx = { svr: mp };
const mastery = { adminDetail: () => ({ skills: [], tierNames: [], tierHours: [], maxChosen: 3 }) };
const sys = new AdminSystem(() => { }, { listZones: () => [] }, mastery);
sys.isAdminActor = (m, a) => a === LEAD || a === GM;
sys.tierOf = (m, a) => (a === LEAD ? 'leadgm' : a === GM ? 'gm' : null);
sys.adminLog = () => { };

const calls = [];
const levels = { Alteration: 10, Conjuration: 0, Destruction: 30, Illusion: 0 };
globalThis.__dboAdminSetSchool = (t, school, level, by) => {
  calls.push([t, school, level, by]);
  if (school === 'Restoration') return { ok: false, text: 'Restoration follows the Priest skill: set Priest on the Wheel instead.' };
  levels[school] = level;
  return { ok: true, text: `Mira's ${school} is now ${level}.` };
};
globalThis.__dboMagicView = () => ({ schools: Object.entries(levels).map(([name, level]) => ({ name, level, role: name === 'Destruction' ? 'primary' : 'closed', roleLabel: name === 'Destruction' ? 'Primary school' : 'Closed', extra: 'x' }))
  .concat([{ name: 'Restoration', level: 12, role: 'priest', roleLabel: 'Through Priest' }]) });
const act = (u, content) => { sent.length = 0; sys.customPacket(u, 'adminAction', Object.assign({ customPacketType: 'adminAction' }, content), ctx); return sent; };
const result = (out) => (out.find((x) => x.p.customPacketType === 'adminActionResult') || {}).p;
const detail = (out) => (out.find((x) => x.p.customPacketType === 'adminMastery') || {}).p;

let out = act(1, { action: 'setSchool', school: 'Alteration', level: 40, targetName: 'Mira' });
ok('a Lead GM sets a school: schools.js is called with the target, the level and the GM', calls.length === 1 && calls[0][0] === PLAYER && calls[0][1] === 'Alteration' && calls[0][2] === 40 && calls[0][3] === LEAD, calls);
ok('the answer is schools.js\'s own words', result(out) && result(out).ok === true && /Alteration is now 40/.test(result(out).text), result(out));
const d = detail(out);
ok('the Skills detail comes back with the five schools', d && d.target === PLAYER.toString(16) && d.detail.schools.length === 5 && d.detail.schools.find((x) => x.name === 'Alteration').level === 40, d && d.detail.schools);
ok('only name, level, role and roleLabel go to the panel', d && Object.keys(d.detail.schools[0]).sort().join() === 'level,name,role,roleLabel', d && d.detail.schools[0]);
out = act(1, { action: 'setSchool', school: 'Destruction', level: 55.6, targetName: 'Mira' });
ok('a fraction is rounded', calls[calls.length - 1][2] === 56, calls[calls.length - 1]);
out = act(1, { action: 'setSchool', school: 'Restoration', level: 30, targetName: 'Mira' });
ok('Restoration is refused with schools.js\'s reason, and no detail is resent', result(out).ok === false && /Priest/.test(result(out).text) && !detail(out), result(out));
const n = calls.length;
for (const bad of [-1, 101, 'many']) act(1, { action: 'setSchool', school: 'Illusion', level: bad, targetName: 'Mira' });
ok('a level outside 0..100 never reaches schools.js', calls.length === n);
out = act(2, { action: 'setSchool', school: 'Illusion', level: 50, targetName: 'Mira' });
ok('a plain GM is refused (Lead GM and above)', calls.length === n && result(out).ok === false && /Lead GM/.test(result(out).text), result(out));
out = act(3, { action: 'setSchool', school: 'Illusion', level: 50 });
ok('a player is ignored', calls.length === n && out.length === 0);
out = act(1, { action: 'setSchool', school: 'Illusion', level: 50, targetName: 'Nobody' });
ok('an unknown target is refused', calls.length === n && result(out).ok === false, result(out));
delete globalThis.__dboAdminSetSchool;
out = act(1, { action: 'setSchool', school: 'Illusion', level: 50, targetName: 'Mira' });
ok('without schools.js it says so', result(out).ok === false && /schools\.js/.test(result(out).text), result(out));
sent.length = 0;
sys.customPacket(1, 'adminMasteryRequest', { customPacketType: 'adminMasteryRequest', targetName: 'Mira' }, ctx);
ok('adminMasteryRequest carries the schools too', detail(sent) && detail(sent).detail.schools.length === 5, detail(sent));
globalThis.__dboMagicView = () => ({ v: 1, open: false });
sent.length = 0;
sys.customPacket(1, 'adminMasteryRequest', { customPacketType: 'adminMasteryRequest', targetName: 'Mira' }, ctx);
ok('a character schools.js has opened no school to: an empty list (the panel says Not a mage yet)', detail(sent) && Array.isArray(detail(sent).detail.schools) && detail(sent).detail.schools.length === 0, detail(sent));
delete globalThis.__dboMagicView;
sent.length = 0;
sys.customPacket(1, 'adminMasteryRequest', { customPacketType: 'adminMasteryRequest', targetName: 'Mira' }, ctx);
ok('without schools.js the schools are null (the panel says Magic data unavailable)', detail(sent) && detail(sent).detail.schools === null, detail(sent));
if (/__dboSuperAdminInfect/.test(SRC)) {
  globalThis.__dboSuperAdminInfect = (t, kind) => `Mira now carries ${kind === 'vampire' ? 'Sanguinare Vampiris' : 'Sanies Lupinus'}.`;
  out = act(1, { action: 'giveDisease', kind: 'vampire', targetName: 'Mira' });
  ok('giveDisease (L1) still answers', result(out).ok === true && /Sanguinare/.test(result(out).text), result(out));
  delete globalThis.__dboSuperAdminInfect;
}

console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
