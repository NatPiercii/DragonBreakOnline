// combat.js against a mock mp: block chip and stamina, guard breaks, bash, power stagger, Defense resistance.
// node tests/combat-harness.js
const path = require('path');
const cfg = JSON.parse(require('fs').readFileSync(path.join(__dirname, '..', 'gamemode-config.json'), 'utf8'));
const SHIELD = 0x500, SWORD = 0x600;
const RUNE = 0x806fa2c, FIREBALL = 0x1c789, UF1 = 0x13e09, UF3 = 0x13f3a, DISARM2 = 0x8bb28, DISMAY1 = 0x2395b, DISMAY3 = 0x23967;
const pushes = [], statuses = [];
const RECS = { [UF1]: { type: 'SPEL', editorId: 'VoiceUnrelentingForce1', fields: [] }, [UF3]: { type: 'SPEL', editorId: 'VoiceUnrelentingForce3', fields: [] }, [RUNE]: { type: 'SPEL', editorId: 'CYRForceRune', fields: [] }, [FIREBALL]: { type: 'SPEL', editorId: 'Fireball', fields: [] }, [DISARM2]: { type: 'SPEL', editorId: 'VoiceDisarm2', fields: [] }, [DISMAY1]: { type: 'SPEL', editorId: 'VoiceDismayingShout1', fields: [] }, [DISMAY3]: { type: 'SPEL', editorId: 'VoiceDismayingShout3', fields: [] }, [SWORD]: { type: 'WEAP', fields: [] }, [SHIELD]: { type: 'ARMO', fields: [{ type: 'BOD2', data: (() => { const d = new Uint8Array(8); new DataView(d.buffer).setUint32(0, 1 << 9, true); return d; })() }] } };
let P, EQ, calls, MAST;
const reset = () => {
  P = { 1: { health: 1, magicka: 1, stamina: 1 }, 2: { health: 1, magicka: 1, stamina: 1 } };
  EQ = { 1: [], 2: [] }; calls = []; MAST = {};
  globalThis.__dboCombat = undefined;
};
reset();
const mp = {
  get: (a, k) => (k === 'percentages' ? P[a] : k === 'equipment' ? { inv: { entries: EQ[a].map((b) => ({ baseId: b, worn: true })) } } : null),
  set: (a, k, v) => { if (k === 'percentages') P[a] = v; },
  getDescFromId: (a) => `${a.toString(16)}:x`,
  callPapyrusFunction: (...args) => calls.push(args),
};
const API = {
  mp, log: () => {}, profileOf: (a) => (a === 1 || a === 2 ? a : -1),
  masteryOf: (a) => MAST[a] || null,
  wornOf: (e) => e.inv.entries.map((x) => ({ baseId: x.baseId })),
  recordOf: (id) => (RECS[id] ? { record: RECS[id] } : null),
  fieldsOf: (lr, t) => ((lr && lr.record.fields) || []).filter((f) => f.type === t),
  weaponSkillOf: (src) => (src === SWORD ? 'blade' : ''), display: String, cfg,
  sendPacket: (a, p) => { if (p.customPacketType === 'dboPush') pushes.push([a, p]); if (p.customPacketType === 'dboStatus') statuses.push([a, p]); },
};
const load = () => require(path.join(__dirname, '..', 'combat.js'))(API);
let pass = 0, fail = 0;
const ok = (cond, what) => { if (cond) pass++; else { fail++; console.log('FAIL', what); } };
const near = (a, b) => Math.abs(a - b) < 1e-6;
const staggers = () => calls.filter((c) => c[2] === 'SendAnimationEvent').length;
const hit = (flags, mult = 1, dmg = 0) => load().onAttempt(1, 2, SWORD, dmg, Object.assign({ targetMaxHealth: 200, targetMaxStamina: 100 }, flags), mult);

// weapon block: 30 % through, the rest in stamina
reset(); hit({ blocked: true, unblockedDamage: 40 });
ok(near(P[2].health, 1 - 12 / 200), 'weapon block lets 30 % through');
ok(near(P[2].stamina, 1 - 28 / 100), 'weapon block costs the prevented 28 in stamina');
ok(staggers() === 0, 'a light blocked blow staggers nobody');
// shield: 15 % through, half the rest in stamina; Defense Master takes the chip to 0
reset(); EQ[2] = [SHIELD]; hit({ blocked: true, unblockedDamage: 40 });
ok(near(P[2].health, 1 - 6 / 200) && near(P[2].stamina, 1 - 17 / 100), 'shield: 15 % through, half the rest in stamina');
reset(); EQ[2] = [SHIELD]; MAST[2] = { order: ['defense'], skills: { defense: { rank: 4 } } }; hit({ blocked: true, unblockedDamage: 40 });
ok(near(P[2].health, 1), 'Master Defense with a shield takes no chip');
// the skills' multiplier scales the blocked blow too
reset(); hit({ blocked: true, unblockedDamage: 40 }, 1.5);
ok(near(P[2].health, 1 - 18 / 200), 'blocked blow carries the attack multiplier');
// power into a shield: double stamina, no stagger
reset(); EQ[2] = [SHIELD]; hit({ blocked: true, power: true, unblockedDamage: 40 });
ok(near(P[2].stamina, 1 - 34 / 100) && staggers() === 0, 'power into a shield: double stamina, no stagger');
// out of stamina: the guard breaks, a stagger, then blocked blows land in full
reset(); P[2].stamina = 0.1; hit({ blocked: true, unblockedDamage: 40 });
ok(P[2].stamina === 0 && staggers() === 1, 'empty stamina breaks the guard with a stagger');
const h = P[2].health; hit({ blocked: true, unblockedDamage: 40 });
ok(near(P[2].health, h - 40 / 200), 'a broken guard lets the whole blow through');
// bash into a guard: breaks it and staggers; Defense Expert resists the stagger but the guard still breaks
reset(); hit({ blocked: true, bash: true, unblockedDamage: 40 });
ok(staggers() === 1 && globalThis.__dboCombat.get(2).guardBrokenUntil > Date.now(), 'bash breaks a guard and staggers');
reset(); MAST[2] = { order: ['defense'], skills: { defense: { rank: 3 } } }; hit({ blocked: true, bash: true, unblockedDamage: 40 });
ok(staggers() === 0 && globalThis.__dboCombat.get(2).guardBrokenUntil > Date.now(), 'Defense Expert: guard breaks, no stagger');
// unblocked: bash is a quarter and staggers; power staggers; cooldown
reset(); const m = hit({ bash: true, unblockedDamage: 40 }, 1, 40);
ok(m === 0.25 && staggers() === 1, 'unblocked bash: quarter damage and a stagger');
reset(); hit({ power: true, unblockedDamage: 40 }, 1, 40); hit({ power: true, unblockedDamage: 40 }, 1, 40);
ok(staggers() === 1, 'power attack staggers once inside the cooldown');
// Master blade power attack staggers through a weapon block
reset(); MAST[1] = { order: ['blade'], skills: { blade: { rank: 4 } } }; hit({ blocked: true, power: true, unblockedDamage: 40 });
ok(staggers() === 1, 'Master power attack staggers through a weapon block');
// spells, NPC targets, no flags and no maxima change nothing
reset(); ok(load().onAttempt(1, 2, SWORD, 20, { spell: true, power: false }, 1) === 1 && staggers() === 0, 'spells are left alone');
reset(); ok(load().onAttempt(1, 9, SWORD, 20, { power: true }, 1) === 1 && staggers() === 0, 'NPC targets are left alone');
reset(); ok(load().onAttempt(1, 2, SWORD, 20, undefined, 1) === 1, 'no flags, no change');
reset(); load().onAttempt(1, 2, SWORD, 0, { blocked: true, unblockedDamage: 40 }, 1);
ok(near(P[2].health, 1) && near(P[2].stamina, 1), 'no maxima: chip and stamina skipped');
// Force Rune staggers a player it hits; other spells, NPC targets and the cooldown do not
reset(); load().onSpellHit(1, 2, RUNE);
ok(staggers() === 1, 'Force Rune staggers a player');
load().onSpellHit(1, 2, RUNE);
ok(staggers() === 1, 'a second rune inside the cooldown does not');
reset(); load().onSpellHit(1, 2, FIREBALL);
ok(staggers() === 0, 'Fireball does not stagger');
reset(); load().onSpellHit(1, 9, RUNE);
ok(staggers() === 0, 'an NPC target is left alone');
reset(); load().onSpellHit(2, 2, RUNE);
ok(staggers() === 0, 'your own rune does not stagger you');
// An NPC's power attack or rune never staggers a player (playersOnly)
reset(); load().onAttempt(9, 2, SWORD, 20, { power: true, unblockedDamage: 20 }, 1);
ok(staggers() === 0, 'an NPC power attack does not stagger a player');
reset(); load().onSpellHit(9, 2, RUNE);
ok(staggers() === 0, 'an NPC Force Rune does not stagger a player');
// One attacker causes one stagger every 3 s, whatever the target cooldown says (SCH-2)
reset(); P[3] = { health: 1, magicka: 1, stamina: 1 }; EQ[3] = [];
const load3 = () => require(path.join(__dirname, '..', 'combat.js'))(Object.assign({}, API, { profileOf: (a) => (a >= 1 && a <= 3 ? a : -1) }));
load3().onAttempt(1, 2, SWORD, 20, { power: true, unblockedDamage: 20 }, 1);
load3().onAttempt(1, 3, SWORD, 20, { power: true, unblockedDamage: 20 }, 1);
ok(staggers() === 1, 'one attacker cannot stagger a second player inside its own cooldown');
load3().onAttempt(3, 2, SWORD, 20, { power: true, unblockedDamage: 20 }, 1);
ok(staggers() === 1, 'the target cooldown still holds against another attacker');
// Shouts: Unrelenting Force pushes its victim on their own screen, from a draugr too; word one only staggers
reset(); pushes.length = 0; load().onSpellHit(9, 2, UF3);
ok(pushes.length === 1 && pushes[0][0] === 2 && pushes[0][1].from === 9 && pushes[0][1].force === 8, "a draugr's third word pushes a player hard");
load().onSpellHit(9, 2, UF3);
ok(pushes.length === 1, 'one push per target inside the cooldown');
reset(); pushes.length = 0; load().onSpellHit(1, 2, UF1);
ok(pushes.length === 1 && pushes[0][1].force === 0, 'the first word only staggers');
reset(); pushes.length = 0; load().onSpellHit(1, 9, UF3);
ok(pushes.length === 0, 'an NPC victim is left to the shouter\'s own game');
// Disarm unequips the weapons in a player's hands on their own client, once per 10 s; Dismay terrifies them
const unequips = () => calls.filter((c) => c[2] === 'UnequipItem');
reset(); EQ[2] = [SWORD, SHIELD]; load().onSpellHit(9, 2, DISARM2);
ok(unequips().length === 1 && unequips()[0][4][0].desc === mp.getDescFromId(SWORD) && unequips()[0][3].desc === mp.getDescFromId(2), "a draugr's Disarm unequips the victim's sword, not the shield");
load().onSpellHit(9, 2, DISARM2);
ok(unequips().length === 1, 'one disarm per target inside the cooldown');
reset(); EQ[1] = [SWORD]; load().onSpellHit(2, 9, DISARM2);
ok(unequips().length === 0, 'an NPC victim of Disarm is left to the shouter\'s own game');
reset(); statuses.length = 0; load().onSpellHit(9, 2, DISMAY3);
ok(statuses.length === 1 && statuses[0][0] === 2 && statuses[0][1].kind === 'terror' && statuses[0][1].seconds === 12 && statuses[0][1].speedMult === -50, 'Dismay\'s third word terrifies a player for 12 s');
reset(); statuses.length = 0; load().onSpellHit(1, 2, DISMAY1);
ok(statuses.length === 1 && statuses[0][1].seconds === 5, 'its first word for 5 s');
reset(); statuses.length = 0; load().onSpellHit(1, 2, FIREBALL);
ok(statuses.length === 0 && unequips().length === 0, 'an ordinary spell neither disarms nor terrifies');
// The shout gate (release review, 2026-09-28): a player's shout word counts only with the grant and inside the 27
{
  const fs = require('fs'), os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nate-shoutgate-'));
  const here = process.cwd(); process.chdir(dir);
  fs.writeFileSync('admin-powers.json', JSON.stringify({ shouts: [{ shout: '13e07:Skyrim.esm', name: 'UnrelentingForceShout', words: [] }] }));
  const spit = (type) => { const d = new Uint8Array(36); new DataView(d.buffer).setUint32(8, type, true); return d; };
  const snam = (spell) => { const d = new Uint8Array(12); new DataView(d.buffer).setUint32(4, spell, true); return d; };
  const DRAGON_BREATH = 0x252c1, HOWL = 0xcf791;
  RECS[UF1] = { type: 'SPEL', editorId: 'VoiceUnrelentingForce1', fields: [{ type: 'SPIT', data: spit(11) }] };
  RECS[UF3] = { type: 'SPEL', editorId: 'VoiceUnrelentingForce3', fields: [{ type: 'SPIT', data: spit(11) }] };
  RECS[DRAGON_BREATH] = { type: 'SPEL', editorId: 'VoiceDragonFireBreath', fields: [{ type: 'SPIT', data: spit(11) }] };
  RECS[HOWL] = { type: 'SPEL', editorId: 'HowlWerewolfFear', fields: [{ type: 'SPIT', data: spit(11) }] };
  RECS[FIREBALL].fields = [{ type: 'SPIT', data: spit(0) }];
  RECS[0x13e07] = { type: 'SHOU', editorId: 'UnrelentingForceShout', fields: [{ type: 'SNAM', data: snam(UF1) }, { type: 'SNAM', data: snam(UF3) }] };
  const origRecordOf = API.recordOf;
  API.recordOf = (id) => (RECS[id] ? { record: RECS[id], toGlobalRecordId: (l) => l } : null);
  mp.getIdFromDesc = (d) => parseInt(String(d).split(':')[0], 16);
  reset(); pushes.length = 0;
  let c = load();
  ok(c.shoutAllowed(1, UF3) === false, 'a player without the grant may not use a shout word');
  c.onSpellHit(1, 2, UF3);
  ok(pushes.length === 0, 'and their Unrelenting Force pushes nobody');
  RECS[DISARM2].fields = [{ type: 'SPIT', data: spit(11) }]; RECS[DISMAY3].fields = [{ type: 'SPIT', data: spit(11) }];
  EQ[2] = [SWORD]; statuses.length = 0; c = load();
  c.onSpellHit(1, 2, DISARM2); c.onSpellHit(1, 2, DISMAY3);
  ok(calls.filter((x) => x[2] === 'UnequipItem').length === 0 && statuses.length === 0, 'nor do their Disarm and Dismay');
  P[1] = P[1] || {}; mp.set(1, 'private.dboAllShouts', true);
  const origGet = mp.get; mp.get = (a, k) => (k === 'private.dboAllShouts' ? a === 1 : origGet(a, k));
  c = load();
  ok(c.shoutAllowed(1, UF3) === true, 'a granted player may use a word of the 27');
  ok(c.shoutAllowed(1, DRAGON_BREATH) === false, "a dragon's breath, outside the 27, is refused even with the grant");
  ok(c.shoutAllowed(9, DRAGON_BREATH) === true, "a draugr or dragon is not gated");
  ok(c.shoutAllowed(2, HOWL) === true, 'a werewolf howl is left to beastform.js');
  ok(c.shoutAllowed(2, FIREBALL) === true, 'an ordinary spell is not a shout');
  c.onSpellHit(1, 2, UF3);
  ok(pushes.length === 1, "the granted player's push lands");
  // The relay of a shout to the players around (dboShoutCast -> dboShoutFx): the same gate, and a cleaned message
  c = load();
  const cast = (o) => Object.assign({ caster: 0xdead, target: 2, spell: UF3, isDualCasting: true, interruptCast: false, keepAlive: false, castingSource: 2,
    aimAngle: 0.1, aimHeading: 1.5, actorAnimationVariables: { booleans: [1, 300, -1], floats: [2], integers: [] } }, o || {});
  let r = c.shoutRelay(1, cast());
  ok(r.data && r.data.caster === 1 && r.data.spell === UF3 && r.data.isDualCasting === false && r.data.castingSource === 2, "a granted player's shout word is relayed, as their own cast");
  ok(r.data && r.data.actorAnimationVariables.booleans.join() === '1,44,255' && r.data.target === 2, '...its fields reduced to checked numbers and bytes');
  ok(!!c.shoutRelay(1, cast()).refused, 'one relay per shoutRelayMinMs');
  c = load();
  ok(/may not use/.test(c.shoutRelay(2, cast()).refused || ''), 'a player without the grant is refused');
  ok(/not a shout word/.test(c.shoutRelay(1, cast({ spell: DRAGON_BREATH })).refused || '') === false && !!c.shoutRelay(1, cast({ spell: DRAGON_BREATH })).refused, "a dragon's breath (outside the 27) is refused");
  c = load();
  ok(/not a shout word/.test(c.shoutRelay(1, cast({ spell: FIREBALL })).refused || ''), 'an ordinary spell is never relayed this way');
  ok(/not a shout word/.test(c.shoutRelay(1, cast({ spell: HOWL })).refused || ''), 'nor a werewolf howl (beastform.js)');
  ok(/not a single cast/.test(c.shoutRelay(1, cast({ keepAlive: true })).refused || ''), 'nor a keep-alive or a stop');
  ok(/not a player/.test(c.shoutRelay(9, cast()).refused || ''), 'nor an NPC');
  mp.get = origGet; API.recordOf = origRecordOf;
  process.chdir(here); fs.rmSync(dir, { recursive: true, force: true });
}
// spell hits: one per caster, target and spell every spellHitMinMs (combat review, 2026-09-29)
{
  reset(); globalThis.__dboSpellHitAt = undefined;
  const c = load(), T = 1e12;
  ok(c.spellHitAllowed(1, 2, FIREBALL, T), 'a first spell hit counts');
  ok(!c.spellHitAllowed(1, 2, FIREBALL, T + 100), 'a second hit of the same spell 0.1 s later is refused');
  ok(c.spellHitAllowed(1, 3, FIREBALL, T + 100), '...but the same blast on another target counts (area spells)');
  ok(c.spellHitAllowed(1, 2, RUNE, T + 100), '...and another spell on the same target counts');
  ok(c.spellHitAllowed(1, 2, FIREBALL, T + 650), 'the same spell counts again after 0.6 s');
  ok(c.spellHitAllowed(1, 2, SWORD, T + 651) && c.spellHitAllowed(1, 2, SWORD, T + 652), 'weapons are not limited here');
  ok(c.spellHitAllowed(1, 1, FIREBALL, T + 651) && c.spellHitAllowed(1, 1, FIREBALL, T + 652), 'a spell on the caster is not limited');
}
console.log(`${pass}/${pass + fail}`);
process.exitCode = fail ? 1 : 0;
