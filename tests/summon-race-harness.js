// Does a summon spell with one summon per caster race (DragonBreak's Summon Skeleton, ISS_ConjureSkeleton) pick the
// caster's own, instead of always the first (the Khajiit skeleton, which never loads on a client)? Records are built the
// way the plugin has them: each EFIT followed by a CTDA "PlayerRef.GetIsRace(race) == 1".
//
//   node tests\summon-race-harness.js <bundled espmMagic.js>
//   (bundle with: cd fork\skymp5-server && node node_modules/esbuild/bin/esbuild ts/systems/espmMagic.ts --bundle
//    --platform=node --format=cjs --outfile=<out.js>)
'use strict';
const path = require('path');
const bundle = process.argv[2];
if (!bundle) { console.error('usage: node tests\\summon-race-harness.js <bundled espmMagic.js>'); process.exit(2); }
const { spellEffects, casterRacePasses } = require(path.resolve(bundle));

const KHAJIIT = 0x13745, ARGONIAN = 0x13740, NORD = 0x13746, KHAJIIT_VAMP = 0x88845, BRETON = 0x13741;
const SPELL = 0x3b002922;
const MGEF = { khajiit: 0x3b00291f, argonian: 0x3b002929, human: 0x3b002927, other: 0x3b000999 };
const NPC = { khajiit: 0x3b001e4f, argonian: 0x3b002928, human: 0x3b00292b, other: 0x3b000998 };

const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const efit = () => { const b = Buffer.alloc(12); b.writeFloatLE(0, 0); b.writeUInt32LE(0, 4); b.writeUInt32LE(60, 8); return b; };
// op: compare in the top 3 bits, OR in bit 0; function 69 GetIsRace; runOn 2 Reference with PlayerRef, or 0 Subject
const ctda = ({ fn = 69, race, value = 1, compare = 0, or = false, runOn = 2, ref = 0x14 }) => {
  const b = Buffer.alloc(32);
  b.writeUInt8((compare << 5) | (or ? 1 : 0), 0); b.writeFloatLE(value, 4); b.writeUInt16LE(fn, 8);
  b.writeUInt32LE(race, 12); b.writeUInt32LE(runOn, 20); b.writeUInt32LE(ref, 24); b.writeInt32LE(-1, 28);
  return b;
};
const mgefData = (assoc) => { const b = Buffer.alloc(0x44); b.writeUInt32LE(assoc, 0x08); b.writeUInt32LE(18, 0x40); return b; };
const field = (type, data) => ({ type, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) });
const rec = (type, fields) => ({ record: { type, fields }, toGlobalRecordId: (x) => x });

const records = new Map([
  [SPELL, rec('SPEL', [
    field('EDID', Buffer.from('ISS_ConjureSkeleton\0')),
    field('EFID', u32(MGEF.khajiit)), field('EFIT', efit()), field('CTDA', ctda({ race: KHAJIIT })),
    field('EFID', u32(MGEF.argonian)), field('EFIT', efit()), field('CTDA', ctda({ race: ARGONIAN })),
    field('EFID', u32(MGEF.human)), field('EFIT', efit()), field('CTDA', ctda({ race: NORD })),
    // A vampire Khajiit gets the Khajiit skeleton too
    field('EFID', u32(MGEF.khajiit)), field('EFIT', efit()), field('CTDA', ctda({ race: KHAJIIT_VAMP })),
  ])],
  [0x3b000100, rec('SPEL', [
    // Either race (OR), and not a condition on a HasKeyword (ignored), subject-run
    field('EFID', u32(MGEF.other)), field('EFIT', efit()),
    field('CTDA', ctda({ race: BRETON, or: true, runOn: 0, ref: 0 })), field('CTDA', ctda({ race: NORD, runOn: 0, ref: 0 })),
    field('CTDA', ctda({ fn: 560, race: 0x1234 })),
  ])],
  [0x3b000200, rec('SPEL', [
    // A race condition on the target, not the caster: not a caster race
    field('EFID', u32(MGEF.other)), field('EFIT', efit()), field('CTDA', ctda({ race: NORD, runOn: 1, ref: 0 })),
  ])],
  [MGEF.khajiit, rec('MGEF', [field('DATA', mgefData(NPC.khajiit))])],
  [MGEF.argonian, rec('MGEF', [field('DATA', mgefData(NPC.argonian))])],
  [MGEF.human, rec('MGEF', [field('DATA', mgefData(NPC.human))])],
  [MGEF.other, rec('MGEF', [field('DATA', mgefData(NPC.other))])],
]);
const mp = { lookupEspmRecordById: (id) => records.get(id >>> 0) || null };

let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail !== undefined ? '   ' + detail : ''}`); if (!ok) failures++; };
// The pick conjurationSystem.ts makes
const pick = (spellId, race) => { const s = spellEffects(mp, spellId).filter((e) => e.archetype === 18 && e.assocId); return (s.find((e) => casterRacePasses(e, race)) || s[0] || {}).assocId; };

const effects = spellEffects(mp, SPELL);
check('four summon effects, each with its caster race', effects.length === 4 && effects.every((e) => e.casterRaces.length === 1) && effects[1].casterRaces[0].raceId === ARGONIAN);
check('a Nord conjures the human skeleton', pick(SPELL, NORD) === NPC.human, pick(SPELL, NORD).toString(16));
check('an Argonian conjures the Argonian skeleton', pick(SPELL, ARGONIAN) === NPC.argonian);
check('a vampire Khajiit conjures the Khajiit skeleton', pick(SPELL, KHAJIIT_VAMP) === NPC.khajiit);
check('a race the spell does not name gets its first summon, as before', pick(SPELL, 0x999) === NPC.khajiit);
const either = spellEffects(mp, 0x3b000100)[0];
check('OR binds: Breton or Nord, subject-run conditions count', casterRacePasses(either, BRETON) && casterRacePasses(either, NORD) && !casterRacePasses(either, ARGONIAN));
check('other conditions are not caster races', either.casterRaces.length === 2);
check('a GetIsRace on the target is not a caster race', spellEffects(mp, 0x3b000200)[0].casterRaces.length === 0);
check('an effect with no race conditions passes for everyone', casterRacePasses({ casterRaces: [] }, ARGONIAN));

console.log(failures ? `${failures} failure(s)` : 'all passed');
process.exit(failures ? 1 : 0);
