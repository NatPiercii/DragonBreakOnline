// Staff hits train no magic school (vanilla staves give no skill): a staff's hit now names its enchantment (ENCH), which
// carries the same EFIDs as a spell. masterySystem must not read a school from it, and a hit with it has no reach.
//
//   node tests/staff-mastery-harness.js <bundled masterySystem.js>
'use strict';
const path = require('path');

const bundle = process.argv[2];
if (!bundle) { console.error('usage: node tests/staff-mastery-harness.js <bundled masterySystem.js>'); process.exit(2); }
const { MasterySystem } = require(path.resolve(bundle));

let fails = 0;
const ok = (label, cond, got) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${!cond && got !== undefined ? `: got ${JSON.stringify(got)}` : ''}`); if (!cond) fails++; };

// MGEF DATA: the magic skill actor value at offset 12 (20 = Destruction)
const mgefData = (() => { const d = new Uint8Array(16); new DataView(d.buffer).setInt32(12, 20, true); return d; })();
const efid = (id) => { const d = new Uint8Array(4); new DataView(d.buffer).setUint32(0, id, true); return d; };
const SHOCK = 0x13cab, SPARKS_SPELL = 0x2dd29, SPARKS_ENCH = 0x4dedc;
const RECS = {
  [SHOCK]: { type: 'MGEF', fields: [{ type: 'DATA', data: mgefData }] },
  [SPARKS_SPELL]: { type: 'SPEL', fields: [{ type: 'EFID', data: efid(SHOCK) }] },
  [SPARKS_ENCH]: { type: 'ENCH', fields: [{ type: 'EFID', data: efid(SHOCK) }] },
};
const mp = {
  get: () => undefined, set: () => {}, getUserByActor: () => 7, getUserActor: () => 0xff000014, sendCustomPacket: () => {},
  lookupEspmRecordById: (id) => (RECS[id >>> 0] ? { record: RECS[id >>> 0], toGlobalRecordId: (x) => x } : null),
};
const ctx = { svr: mp };
const sys = new MasterySystem(() => {});

ok('a Sparks spell is Destruction (the control)', sys.spellSchool(ctx, SPARKS_SPELL) === 'Destruction', sys.spellSchool(ctx, SPARKS_SPELL));
const staffSchool = sys.spellSchool(ctx, SPARKS_ENCH);
if (staffSchool) {
  require('./expect')('staff-mastery', 'this masterySystem reads a school from an enchantment');
  console.log('ok   skipped: this masterySystem predates the staff school check (C++ refuses an ENCH cast before the event)');
  process.exit(0);
}
ok("a Sparks staff's enchantment is no school", staffSchool === '', staffSchool);
const rules = { spellSchools: new Set(['Destruction']), gateStations: new Set(), gatePrefixes: [] };
ok('a cast event naming an enchantment credits no school skill', sys.matches(ctx, 'arcane', rules, { kind: 'cast', actorId: 0xff000014, detail: { spellId: SPARKS_ENCH, value: 19 } }) === false);
ok('a staff hit has no reach, so it credits no hit skill', sys.hitReach(ctx, SPARKS_ENCH) === 0, sys.hitReach(ctx, SPARKS_ENCH));
ok('...while a spell hit has (the control)', sys.hitReach(ctx, SPARKS_SPELL) > 0, sys.hitReach(ctx, SPARKS_SPELL));

console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
