// DragonBreak Online: one passive gift per playable race (Nate approved all ten and the four rules, 3 Oct 2026; design
// ~/claude-nate-release/specs/racial-passives.md). Loaded by gamemode.js on every hot reload.
//
// The vanilla daily powers do nothing here: the client dispels every one and never relays it (magicSyncService
// BLOCKED_POWER_IDS), and the vanilla race abilities (Resist Frost 50% and the rest) run on the player's own game only,
// while the server judges damage and regeneration. So each race's gift is made real where the server decides:
//   - damage: gamemode.js hitDamageAttemptHook multiplies its mult by attackMult (the attacker's gift) and by
//     targetMult (the target's), and caps every reduction on the target's side together (defense x blessing x race)
//     at reductionCap through capTargetSide. The give-back after the engine's hit is the mastery one (let it land, read
//     the health lost, write percentages back).
//   - regeneration: a raised client rate is pulled back by the server's crop (CropRegeneration reads the server's own
//     rates, which SetActorValue never reaches: PapyrusActor.cpp), so the extra is added on the server instead, as the
//     blessings add theirs (prayer.js prayerBlessingRegen): the race's share accrues every tickSeconds and is paid on the
//     tick a fresh client report of that bar arrives (regenTick); the share
//     multiplies the rest of the chain: hunger (__dboNeedsRateMult), the vampire blood (__dboSuperRateMult), a
//     blessing's own boost (__dboBlessingRegen) and Death's Chill (__dboChillRateMult, 0 at its cap).
//   - gold: an Imperial's share of loot and contract pay, by goldBonus, which dungeons.js, wildlife.js and contracts.js
//     call where the server hands the coin over.
// Rules: players only; nothing while a beast form is on (werewolf, Vampire Lord); an always-on regeneration factor is
// never above alwaysRegenCap, a conditional one never above conditionalRegenCap. In a fight the game slows the client's
// own regeneration (the fCombat*RegenRateMult GMSTs), so the gift's extra is slowed the same way and the factor stays the
// factor: a player counts as fighting for combatSeconds after a landed blow given or taken (gamemode.js __dboCombatAt).
// Config "racial": { enabled, reductionCap, alwaysRegenCap, conditionalRegenCap, combatSeconds, tickSeconds, minStep,
// payoutSeconds, overhaul, <race>: {...} }
//
// The racial overhaul (Nate's "Racial Updates", 10 Oct; ~/claude-nate-release/specs/racial-overhaul.md), all behind
// `overhaul` (false: every number is the 3 Oct one):
//   - the Maormer: a creator option on the High Elf race record, told apart by private.rp.race 'maormer' (spawn.ts), with
//     its own gifts (shock resist, a swimming ability) instead of the Altmer's;
//   - one skill XP boost per race (xp: { <skill>: rate }), through skillrates.js __dboSkillRate after the ring, the hourly
//     bucket and the day's caps have metered the work, so it speeds a skill and never lifts a cap;
//   - the Argonian's Hist-given disease resistance: the share of a bite's or a feed's fever that never takes (supernatural.js);
//   - a Racial Power a real day (power: { name, seconds, cooldownHours, clientOnly, buffs }): timed buffs the server applies
//     in the same hooks as the gifts, under the same caps, never a spell. private.racialPower { race, usedAt, readyAt,
//     activeUntil } is the character's, so a relog neither resets the wait nor ends the buff.
'use strict';

const RACES = ['altmer', 'argonian', 'bosmer', 'breton', 'dunmer', 'imperial', 'khajiit', 'nord', 'orc', 'redguard', 'maormer'];
// Each race by its own RACE record and its vampire variant (Skyrim.esm, index 0: the same pairs regions.js and
// supernatural.js use)
const RACE_IDS = {
  argonian: [0x13740, 0x8883a], breton: [0x13741, 0x8883c], dunmer: [0x13742, 0x8883d], altmer: [0x13743, 0x88840],
  imperial: [0x13744, 0x88844], khajiit: [0x13745, 0x88845], nord: [0x13746, 0x88794], orc: [0x13747, 0xa82b9],
  redguard: [0x13748, 0x88846], bosmer: [0x13749, 0x88884],
};
const RACE_OF_ID = new Map();
for (const [race, ids] of Object.entries(RACE_IDS)) for (const id of ids) RACE_OF_ID.set(id, race);
// libespm ActorValue.h: the resistance a magic effect is resisted by (MGEF DATA i32 at 16)
const AV = { poison: 40, fire: 41, shock: 42, frost: 43, magic: 44 };
const UNARMED = 0x1f4;
const HIGHBORN = 0x0e40c8; // PowerHighElfMagickaRegen
const GOLD = 0xf;
// A power's buffs: meleeDamage, bowDamage, fireDealt, shockDealt (shares added to the attacker's hit); damageTaken (every
// hit), physicalTaken (a hit that is not a spell, enchantment or scroll), resistMagic (added to the race's own share):
// shares off the target's; wardPoints: spell damage absorbed in all while it lasts; healthRegen, staminaRegen,
// magickaRegen: factors, at most conditionalRegenCap
const DEFAULTS = {
  enabled: false, overhaul: false, reductionCap: 0.75, alwaysRegenCap: 1.25, conditionalRegenCap: 1.5, combatSeconds: 10, tickSeconds: 0.25, minStep: 0.002,
  payoutSeconds: 1,
  altmer: { magickaRegen: 1.25, elementalWeakness: 0, xp: { arcane: 1.15 },
    power: { name: 'Highborn', seconds: 60, buffs: { magickaRegen: 1.5 } } },
  // inCombat: Hist-Blooded keeps its full extra in a fight (the base game heals nothing in combat: off scales it to 0).
  // diseaseResist 0.5: the Hist keeps half of every fever out (Skyrim's 50%; not immunity: Argonian vampires are canon),
  // a bite's or a feed's; rites and a GM's curse are chosen
  argonian: { resistPoison: 0.5, lowHealth: 0.35, lowHealthHealRegen: 1.5, inCombat: false, diseaseResist: 0.5, xp: { harvesting: 1.15 },
    power: { name: 'Histskin', seconds: 60, buffs: { healthRegen: 1.5, physicalTaken: 0.15 } } },
  bosmer: { bowDamage: 0.1, resistPoison: 0.5, xp: { archery: 1.15 },
    power: { name: 'Wild Hunt', seconds: 30, buffs: { bowDamage: 0.2, staminaRegen: 1.5 } } },
  breton: { resistMagic: 0.25, xp: { priest: 1.15 },
    power: { name: 'Dragonskin', seconds: 60, buffs: { resistMagic: 0.25 } } },
  dunmer: { resistFire: 0.5, xp: { arcane: 1.15 },
    power: { name: "Ancestor's Wrath", seconds: 60, buffs: { fireDealt: 0.25 } } },
  imperial: { goldBonus: 0.1, xp: { defense: 1.15 },
    power: { name: 'Voice of the Emperor', seconds: 60, buffs: { healthRegen: 1.5, staminaRegen: 1.5 } } },
  // Night Eye is the player's own imagespace: a client release (clientOnly refuses it until then)
  khajiit: { unarmedDamage: 8, xp: { unarmed: 1.15 },
    power: { name: 'Night Eye', seconds: 60, cooldownHours: 1 / 3, clientOnly: true, buffs: {} } },
  // Outdoors in Skyrim, or in the Jerall Mountains: the BSHeartland worldspace around Bruma and the Pale Pass road
  nord: { resistFrost: 0.5, coldStaminaRegen: 1.15, coldProvinces: ['skyrim'],
    coldAreas: [{ world: 'a764b:BSHeartland.esm', pos: [56000, 232000], radius: 60000 }], xp: { blade: 1.15 },
    power: { name: 'Battle Cry', seconds: 60, buffs: { meleeDamage: 0.15 } } },
  orc: { lowHealth: 0.3, meleeDamage: 0.2, damageTaken: 0.2, xp: { blacksmith: 1.15 },
    power: { name: 'Berserker Rage', seconds: 30, buffs: { meleeDamage: 0.25, damageTaken: 0.25 } } },
  redguard: { staminaRegen: 1.25, resistPoison: 0.5, xp: { blade: 1.15 },
    power: { name: 'Adrenaline Rush', seconds: 60, buffs: { staminaRegen: 1.5 } } },
  // Pyandonea's sea-elves (lore), Nate's own table (10 Oct): a High Elf record with private.rp.race 'maormer', only with the
  // overhaul on. seafarerSpell: the DLE's DBO_AbMaormerSeafarer (SpeedMult +25 while swimming), an ability kept on every
  // Maormer while they are one; '' or a record not in the load order does nothing. Roaring Tempest: +25% magic resistance and
  // a ward that absorbs wardPoints of spell damage while it lasts (60, Steadfast Ward's), under reductionCap; wardSpell (the
  // DLE's DBO_MaormerTempestWard, its look only) is cast on the player when it is called
  maormer: { resistShock: 0.5, seafarerSpell: '', xp: { blade: 1.15 },
    // lookShader: what everyone near sees on the caster, ShockPlayerCloakFXShader (the ward effect's own hit shader)
    power: { name: 'Roaring Tempest', seconds: 60, wardSpell: '', lookShader: '10f9a6:Skyrim.esm', buffs: { resistMagic: 0.25, wardPoints: 60 } } },
};
const merge = (cfg) => {
  const c = Object.assign({}, DEFAULTS, cfg || {});
  for (const r of RACES) c[r] = Object.assign({}, DEFAULTS[r], (cfg || {})[r] || {});
  return c;
};
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp01 = (v) => Math.max(0, Math.min(1, v));

module.exports = (api) => {
  const { mp, log, personal, giveItem, profileOf, display, recordOf, every, onlineActors, weaponHandsOf, sourceResistsOf, gmstFloat, cfg, sendPacket } = api;
  const C = merge(cfg && cfg.racial);
  const on = () => C.enabled === true;
  const overhaul = () => on() && C.overhaul === true;
  const S = globalThis.__dboRacialState || (globalThis.__dboRacialState = { owed: new Map(), highbornUntil: new Map() });
  if (!(S.castAt instanceof Map)) S.castAt = new Map(); // state built by an older racial.js has none
  if (!(S.channel instanceof Map)) S.channel = new Map(); // open concentration casts: actor -> { at, magicka }

  // ---- who ----------------------------------------------------------------------------------------------------------
  const isPlayer = (a) => { try { return profileOf(a >>> 0) >= 0; } catch (e) { return false; } };
  const inBeastForm = (a) => { try { const b = mp.get(a >>> 0, 'private.beast'); return !!(b && b.form); } catch (e) { return false; } };
  // regenTick runs four times a second: inside it each player's race, appearance and power are read once (memo), not per bar
  let memo = null;
  const memoised = (map, a, read) => {
    if (!memo) return read(a);
    const k = a >>> 0;
    if (memo[map].has(k)) return memo[map].get(k);
    const v = read(a); memo[map].set(k, v); return v;
  };
  const raceIdOf = (a) => memoised('raceId', a, (x) => { try { const app = mp.get(x >>> 0, 'appearance'); return app && app.raceId ? Number(app.raceId) >>> 0 : 0; } catch (e) { return 0; } });
  // The creator's race key (spawn.ts private.rp.race: 'maormer', 'nibenese', ...), lower case, or ''
  // The DLE's MaormerRace and its vampire (config maormerRace), once both are RACE records in the load order: the Maormer by
  // the race itself, the creator's override (charCreatorData.ts __dboRaceOverrides) and nothing at all before
  const raceRec = (desc) => { try { const id = desc ? mp.getIdFromDesc(String(desc)) >>> 0 : 0; const r = id ? recordOf(id) : null; return r && String(r.record.type) === 'RACE' ? id : 0; } catch (e) { return 0; } };
  const MR = (cfg && cfg.maormerRace) || {};
  const MAORMER_IDS = (() => { const r = raceRec(MR.race), v = raceRec(MR.vampire); return r && v ? [r, v] : []; })();
  globalThis.__dboRaceOverrides = MAORMER_IDS.length ? { maormer: MAORMER_IDS[0] } : {};
  const rpRace = (a) => { try { const rp = mp.get(a >>> 0, 'private.rp'); return rp && rp.race ? String(rp.race).toLowerCase() : ''; } catch (e) { return ''; } };
  // The race whose gift this player has now, or '' (not a player, a beast form, an unknown race, switched off)
  const raceOf = (a) => memoised('race', a, raceNow);
  const raceNow = (a) => {
    if (!on() || !isPlayer(a) || inBeastForm(a)) return '';
    const id = raceIdOf(a);
    // On the DLE's MaormerRace: the Maormer with the overhaul, the Altmer's gift without it (as on the High Elf record)
    if (MAORMER_IDS.includes(id)) return C.overhaul === true ? 'maormer' : 'altmer';
    const r = RACE_OF_ID.get(id) || '';
    // A Maormer made before the DLE's race stands on the High Elf record (charCreatorData.ts): without this every Maormer
    // counts as an Altmer
    return r === 'altmer' && C.overhaul === true && rpRace(a) === 'maormer' ? 'maormer' : r;
  };
  const healthOf = (a) => { try { const p = mp.get(a >>> 0, 'percentages'); return p ? Number(p.health) : NaN; } catch (e) { return NaN; } };

  // RACE DATA floats (libespm RACE.cpp): regeneration at 84/88/92, unarmed damage at 96
  const raceData = new Map();
  const raceDataOf = (raceId) => {
    if (raceData.has(raceId)) return raceData.get(raceId);
    let out = null;
    const r = raceId ? recordOf(raceId) : null;
    const data = r && String(r.record.type) === 'RACE' && (r.record.fields || []).find((f) => f && f.type === 'DATA' && f.data instanceof Uint8Array && f.data.byteLength >= 100);
    if (data) {
      const v = new DataView(data.data.buffer, data.data.byteOffset, data.data.byteLength);
      out = { health: v.getFloat32(84, true), magicka: v.getFloat32(88, true), stamina: v.getFloat32(92, true), unarmed: v.getFloat32(96, true) };
    }
    raceData.set(raceId, out);
    return out;
  };
  const VANILLA = { health: 0.7, magicka: 3, stamina: 5, unarmed: 4 };
  const raceValue = (a, key) => { const d = raceDataOf(raceIdOf(a)); const v = d ? Number(d[key]) : NaN; return Number.isFinite(v) && v > 0 ? v : VANILLA[key]; };

  // ---- the Racial Power: its state and the buff it gives now ------------------------------------------------------------
  const POWER = 'private.racialPower';
  const powerOf = (race) => { const p = race && C[race] && C[race].power; return p && typeof p === 'object' ? p : null; };
  const powerState = (a) => { try { const v = mp.get(a >>> 0, POWER); return v && typeof v === 'object' ? v : {}; } catch (e) { return {}; } };
  // The running power's buffs, or null: only the race that used it, and only while it lasts (a beast form has no race)
  const activeBuffs = (a, now = Date.now()) => {
    if (!overhaul()) return null;
    const race = raceOf(a); const st = powerState(a); const p = powerOf(race);
    return p && st.race === race && Number(st.activeUntil) > now ? (p.buffs || {}) : null;
  };
  const buff = (a, key) => { const b = memoised('buffs', a, activeBuffs); return b ? Math.max(0, num(b[key], 0)) : 0; };
  // The ward: a pool of spell damage (wardPoints, set when the power is called) it takes off hits until it is spent or the
  // power ends. dmg: the hit after the race's other shares. Returns the factor on the hit, spending what it absorbed (the
  // reductionCap floor may let a little more through than the pool counted)
  const wardAbsorb = (a, dmg) => {
    const st = powerState(a);
    const left = Math.max(0, num(st.wardLeft, 0));
    if (!(left > 0) || !(dmg > 0)) return 1;
    const took = Math.min(left, dmg);
    try { mp.set(a >>> 0, POWER, Object.assign({}, st, { wardLeft: left - took })); } catch (e) { return 1; }
    if (took >= left) { try { personal(a >>> 0, 'Your ward breaks.'); } catch (e) { /* the message is optional */ } }
    return (dmg - took) / dmg;
  };

  // ---- damage -------------------------------------------------------------------------------------------------------
  const resists = (src) => { try { return sourceResistsOf(src >>> 0) || new Set(); } catch (e) { return new Set(); } };
  const isMagicSource = (src) => { const r = recordOf(src >>> 0); return !!r && ['SPEL', 'ENCH', 'SCRL'].includes(String(r.record.type)); };
  const hands = (src) => { try { return weaponHandsOf(src >>> 0) || ''; } catch (e) { return ''; } };
  // The attacker's gift: above 1 hits harder. dmg is the engine's damage, for nothing but a guard against 0.
  const attackMult = (agg, tgt, src, dmg) => {
    const race = raceOf(agg); if (!race || !(dmg > 0) || agg === tgt) return 1;
    return passiveAttack(race, agg, src) * powerAttack(agg, src);
  };
  const passiveAttack = (race, agg, src) => {
    const R = C[race];
    if (race === 'bosmer' && hands(src) === 'bow') return 1 + Math.max(0, num(R.bowDamage, 0));
    // The engine hits with the race's own unarmed damage (TES5DamageFormula CalcUnarmedDamage, RACE DATA), so the claws
    // add to that base and armour and the Unarmed tiers scale them like the rest of the blow
    if (race === 'khajiit' && (src >>> 0) === UNARMED) { const base = raceValue(agg, 'unarmed'); return (base + Math.max(0, num(R.unarmedDamage, 0))) / base; }
    if (race === 'orc') {
      const h = hands(src);
      if ((h === 'one' || h === 'two' || (src >>> 0) === UNARMED) && healthOf(agg) < num(R.lowHealth, 0)) return 1 + Math.max(0, num(R.meleeDamage, 0));
    }
    return 1;
  };
  // The power's share of the attacker's hit: melee (a one- or two-handed weapon, fists), a bow, fire or shock damage
  const powerAttack = (agg, src) => {
    const b = activeBuffs(agg); if (!b) return 1;
    const h = hands(src); const rs = resists(src);
    let m = 1;
    if (h === 'one' || h === 'two' || (src >>> 0) === UNARMED) m *= 1 + Math.max(0, num(b.meleeDamage, 0));
    if (h === 'bow') m *= 1 + Math.max(0, num(b.bowDamage, 0));
    if (rs.has(AV.fire)) m *= 1 + Math.max(0, num(b.fireDealt, 0));
    if (rs.has(AV.shock)) m *= 1 + Math.max(0, num(b.shockDealt, 0));
    return m;
  };
  // The target's gift: below 1 takes less, above 1 more (the Altmer's optional weakness)
  // dmg: the engine's damage, for the ward's absorb (no ward without it)
  const targetMult = (agg, tgt, src, dmg) => {
    const race = raceOf(tgt); if (!race || agg === tgt) return 1;
    const R = C[race];
    const rs = resists(src);
    let m = 1;
    const resist = (share) => { m *= 1 - clamp01(num(share, 0)); };
    if (rs.has(AV.poison) && (race === 'argonian' || race === 'bosmer' || race === 'redguard')) resist(R.resistPoison);
    if (race === 'dunmer' && rs.has(AV.fire)) resist(R.resistFire);
    if (race === 'nord' && rs.has(AV.frost)) resist(R.resistFrost);
    if (race === 'maormer' && rs.has(AV.shock)) resist(R.resistShock);
    // Magic resistance: the race's own share and the power's add up (Dragonskin: 25% + 25% = 50%), under the cap
    const magic = (race === 'breton' || race === 'maormer' ? Math.max(0, num(R.resistMagic, 0)) : 0) + buff(tgt, 'resistMagic');
    if (magic > 0 && isMagicSource(src)) resist(magic);
    const b = activeBuffs(tgt);
    if (b) { resist(b.damageTaken); if (!isMagicSource(src)) resist(b.physicalTaken); }
    if (b && num(b.wardPoints, 0) > 0 && isMagicSource(src) && dmg > 0) m *= wardAbsorb(tgt, dmg * m);
    if (race === 'altmer' && (rs.has(AV.fire) || rs.has(AV.frost) || rs.has(AV.shock))) m *= 1 + Math.max(0, num(R.elementalWeakness, 0));
    if (race === 'orc' && healthOf(tgt) < num(R.lowHealth, 0)) resist(R.damageTaken);
    return m;
  };
  // Every reduction on the target's side together (Defense x a blessing x the race) never takes more than reductionCap
  // off one hit. side: their product; returns it, raised to the floor when it goes below
  const capTargetSide = (side) => {
    if (!on()) return side;
    const floor = 1 - clamp01(num(C.reductionCap, 0.75));
    return side < floor ? floor : side;
  };

  // ---- regeneration ---------------------------------------------------------------------------------------------------
  const STAT_AV = { health: 'HealRateMult', magicka: 'MagickaRateMult', stamina: 'StaminaRateMult' };
  const capOf = (f, conditional) => Math.max(1, Math.min(num(f, 1), num(conditional ? C.conditionalRegenCap : C.alwaysRegenCap, 1)));
  const outdoors = (a) => {
    try { const d = String(mp.get(a >>> 0, 'worldOrCellDesc') || ''); const r = d ? recordOf(mp.getIdFromDesc(d) >>> 0) : null; return !!r && String(r.record.type) === 'WRLD'; } catch (e) { return false; }
  };
  const normDesc = (d) => { const s = String(d || ''); const i = s.indexOf(':'); if (i < 0) return s.toLowerCase(); const n = parseInt(s.slice(0, i), 16); return (Number.isFinite(n) ? n.toString(16) : s.slice(0, i).toLowerCase()) + ':' + s.slice(i + 1).toLowerCase(); };
  const inCold = (a) => {
    if (!outdoors(a)) return false;
    const R = C.nord;
    try {
      const reg = globalThis.__dboRegions;
      const p = reg && typeof reg.provinceAt === 'function' ? reg.provinceAt(a >>> 0) : null;
      if (p && (R.coldProvinces || []).includes(p.province)) return true;
    } catch (e) { /* no regions module */ }
    let desc = '', pos = null;
    try { desc = normDesc(mp.get(a >>> 0, 'worldOrCellDesc')); pos = mp.get(a >>> 0, 'pos'); } catch (e) { return false; }
    return (R.coldAreas || []).some((z) => z && normDesc(z.world) === desc && Array.isArray(z.pos) && pos
      && Math.hypot(Number(pos[0]) - Number(z.pos[0]), Number(pos[1]) - Number(z.pos[1])) <= num(z.radius, 0));
  };
  const highbornRunning = (a) => (S.highbornUntil.get(a >>> 0) || 0) > Date.now();
  // The client reports its own bars at most once a second and holds the report while it casts and for half a second
  // after (sendInputsService), so for a moment after a cast the server's percentages are the ones from before it. A
  // regeneration tick that writes them back then refills the caster (#bugs 1556641893054681179: an Altmer's Conjure
  // Familiar cost nothing). Every server-side regeneration (this gift, the blessings, the Ayleid well) waits
  // castHoldSeconds after the player's last cast.
  // A concentration channel sends no bars until it ends and its keep-alives never reach here, so its hold lasts until
  // the client's report moves the server's magicka, at most channelHoldSeconds (8 Oct: Flames past 3 s cost nothing)
  const SPIT_CONC = new Map();
  const concentration = (spellId) => {
    const id = spellId >>> 0;
    if (!SPIT_CONC.has(id)) {
      let yes = false;
      try {
        const r = recordOf(id);
        const f = r && r.record.type === 'SPEL' ? (r.record.fields || []).find((x) => x && x.type === 'SPIT' && x.data instanceof Uint8Array && x.data.byteLength >= 20) : null;
        yes = !!f && new DataView(f.data.buffer, f.data.byteOffset, f.data.byteLength).getUint32(16, true) === 2; // castType 2 = concentration
      } catch (e) { yes = false; }
      SPIT_CONC.set(id, yes);
    }
    return SPIT_CONC.get(id);
  };
  const magickaOf = (a) => { try { const p = mp.get(a >>> 0, 'percentages'); return p ? Number(p.magicka) : NaN; } catch (e) { return NaN; } };
  const castHeld = (a, now = Date.now()) => {
    const d = now - (S.castAt.get(a >>> 0) || -Infinity);
    if (d >= 0 && d < Math.max(0, num(C.castHoldSeconds, 3)) * 1000) return true;
    const ch = S.channel.get(a >>> 0);
    if (!ch) return false;
    const e = now - ch.at;
    if (e < 0) return false;
    if (e < Math.max(0, num(C.channelHoldSeconds, 30)) * 1000 && magickaOf(a) === ch.magicka) return true;
    S.channel.delete(a >>> 0); // the report came in, or the cap ran out
    return false;
  };
  globalThis.__dboCastHeld = castHeld;
  // The race's factor on one bar's regeneration now (1 = none), capped by the rule for its kind
  const regenFactor = (a, stat) => {
    const race = raceOf(a); if (!race) return 1;
    const passive = passiveRegen(race, a, stat);
    // A power's factor is timed (conditionalRegenCap) and stands in for the gift's while it runs, never on top of it
    const p = buff(a, `${stat}Regen`);
    return p > 1 ? Math.max(passive, capOf(p, true)) : passive;
  };
  const passiveRegen = (race, a, stat) => {
    const R = C[race];
    // Highborn's own boost runs on the server for its minute when a cast reaches it (6fa17721): the gift waits, never both
    if (race === 'altmer' && stat === 'magicka') return highbornRunning(a) ? 1 : capOf(R.magickaRegen, false);
    if (race === 'redguard' && stat === 'stamina') return capOf(R.staminaRegen, false);
    if (race === 'argonian' && stat === 'health') return healthOf(a) < num(R.lowHealth, 0) ? capOf(R.lowHealthHealRegen, true) : 1;
    if (race === 'nord' && stat === 'stamina') return inCold(a) ? capOf(R.coldStaminaRegen, true) : 1;
    return 1;
  };
  // The game's own slowdown of a bar's regeneration in combat (Skyrim.esm GMSTs fCombatHealthRegenRateMult 0x35056,
  // fCombatMagickaRegenRateMult 0x1031d4, fCombatStaminaRegenRateMult 0x2dd34); gamemode.js gmstFloat keeps the fallback
  // for a value of 0 or none, so health is 0 either way
  const gmst = (id, d) => { try { return typeof gmstFloat === 'function' ? num(gmstFloat(id, d), d) : d; } catch (e) { return d; } };
  const COMBAT = { health: gmst(0x35056, 0), magicka: gmst(0x1031d4, 0.33), stamina: gmst(0x2dd34, 0.35) };
  const fighting = (a) => {
    const m = globalThis.__dboCombatAt;
    const at = m instanceof Map ? Number(m.get(a >>> 0)) || 0 : 0;
    return at > 0 && Date.now() - at < num(C.combatSeconds, 10) * 1000;
  };
  const hook = (name, ...args) => { try { const f = globalThis[name]; if (typeof f !== 'function') return 1; const v = Number(f(...args)); return Number.isFinite(v) && v >= 0 ? v : 1; } catch (e) { return 1; } };
  const REGEN_MULT = (() => { try { const v = Number((mp.getServerSettings() || {}).regenerationMultiplier); return Number.isFinite(v) && v >= 0 ? v : 1; } catch (e) { return 1; } })();
  // The share of a bar a second the gift adds: the race's rate through the rest of the chain, times (factor - 1)
  // f: regenFactor(a, stat) when the caller has it already
  const extraPerSecond = (a, stat, f = regenFactor(a, stat)) => {
    if (!(f > 1)) return 0;
    const av = STAT_AV[stat];
    // hunger and the vampire blood set the client's health and stamina rates (gamemode.js applyNeedsStage); magicka has neither
    const chain = stat === 'magicka' ? 1 : hook('__dboNeedsRateMult', a, av) * hook('__dboSuperRateMult', a, av);
    let blessing = 0;
    try { for (const e of (typeof globalThis.__dboBlessingRegen === 'function' ? globalThis.__dboBlessingRegen(a) : []) || []) if (e && e.stat === stat && Number(e.perSecond) > 0) blessing += Number(e.perSecond); } catch (e) { blessing = 0; }
    const chill = Math.min(1, hook('__dboChillRateMult', a, av));
    // The client's own rate is slowed in a fight (the blessing's share is the server's and is not); Hist-Blooded keeps
    // its full extra there only when argonian.inCombat is on
    const keepsInCombat = stat === 'health' && raceOf(a) === 'argonian' && C.argonian.inCombat === true;
    const combat = !keepsInCombat && fighting(a) ? Math.max(0, num(COMBAT[stat], 1)) : 1;
    return ((raceValue(a, stat) / 100) * REGEN_MULT * chain * combat + blessing) * chill * (f - 1);
  };
  const TICK_MS = Math.max(250, Math.round(num(C.tickSeconds, 0.25) * 1000));
  const STATS = ['health', 'magicka', 'stamina'];
  const regenTick = (now = Date.now()) => {
    const here = new Set();
    if (!on()) { S.owed.clear(); return; }
    memo = { race: new Map(), raceId: new Map(), buffs: new Map() };
    try {
      for (const a of onlineActors()) {
        here.add(a);
        if (!raceOf(a)) { S.owed.delete(a); continue; }
        let owed = S.owed.get(a);
        if (!owed) { owed = { at: now - TICK_MS, health: 0, magicka: 0, stamina: 0 }; S.owed.set(a, owed); }
        // Just after a cast the server still holds the bars from before it: a write now would hand the spell's magicka back
        if (castHeld(a, now)) { owed.at = now; owed.health = owed.magicka = owed.stamina = 0; continue; }
        // Never more than three ticks at once: a stall or a reload does not pay out
        const secs = Math.min(Math.max(0, now - owed.at), 3 * TICK_MS) / 1000;
        owed.at = now;
        let pc = null; try { pc = mp.get(a, 'percentages'); } catch (e) { pc = null; }
        let downed = false; try { downed = typeof globalThis.__dboIsDowned === 'function' && !!globalThis.__dboIsDowned(a); } catch (e) { downed = false; }
        if (!pc || !(Number(pc.health) > 0) || downed || !(secs > 0)) { owed.health = owed.magicka = owed.stamina = 0; continue; }
        const next = { health: Number(pc.health), magicka: Number(pc.magicka), stamina: Number(pc.stamina) };
        // A write replaces the client's bar, so pay a bar only on the tick its own stored float32 moved (a fresh report):
        // never on another bar's blow or blessing, never from a silent client's old value (a held spell, a menu)
        const seen = owed.seen && typeof owed.seen === 'object' ? owed.seen : (owed.seen = {});
        const paid = [];
        for (const stat of STATS) {
          const v = Math.fround(next[stat]);
          const fresh = seen[stat] !== v;
          seen[stat] = v;
          if (!(next[stat] < 1)) { owed[stat] = 0; continue; }
          const f = regenFactor(a, stat);
          const per = f > 1 ? extraPerSecond(a, stat, f) : 0;
          if (!(per > 0)) { owed[stat] = 0; continue; }
          const own = per / (f - 1); // the bar's own regen a second
          // At least payoutSeconds of own regen, more than a report's age takes back; or the rest if own regen fills the bar first
          const step = Math.max(num(C.minStep, 0.002), own * Math.max(0, num(C.payoutSeconds, 1)));
          // Owed stops at a step plus 1.5 s of gift: a pause (a menu, the regen delay) adds no regen, so it is not paid as one jump
          owed[stat] = Math.min(owed[stat] + per * secs, step + per * 1.5);
          if (!fresh) continue;
          const fillsFirst = next[stat] + own >= 1 && owed[stat] >= own * 0.5;
          if (owed[stat] < step && !fillsFirst) continue;
          next[stat] = Math.min(1, next[stat] + owed[stat]);
          owed[stat] = 0;
          paid.push(stat);
        }
        if (paid.length) {
          try { mp.set(a, 'percentages', next); for (const stat of paid) seen[stat] = Math.fround(next[stat]); } catch (e) { S.owed.delete(a); }
        }
      }
    } finally { memo = null; }
    for (const a of [...S.owed.keys()]) if (!here.has(a)) S.owed.delete(a);
  };
  // Registered whatever the config says and off inside, so a reload that turns it off replaces the running timer
  if (typeof every === 'function') every('racialRegen', TICK_MS, () => { try { regenTick(); } catch (e) { log('racial regen failed', e.message); } });

  // ---- Highborn -------------------------------------------------------------------------------------------------------
  // gamemode.js castHook: a Highborn cast that reaches the server (an old or modified client; 0.3.74 dispels it and
  // never relays it) runs the C++ rate boost for its minute, and the Altmer's gift waits that minute
  const onCast = (a, spellId, at = Date.now()) => {
    S.castAt.set(a >>> 0, at);
    if (S.castAt.size > 500) for (const [k, t] of S.castAt) if (at - t > 60000) S.castAt.delete(k);
    // Stamped with the server's magicka from before the channel; a fire-and-forget cast in the other hand keeps it
    if (concentration(spellId)) S.channel.set(a >>> 0, { at, magicka: magickaOf(a) });
    if (S.channel.size > 500) for (const [k, c] of S.channel) if (at - c.at > 60000) S.channel.delete(k);
    if ((spellId >>> 0) !== HIGHBORN) return;
    S.highbornUntil.set(a >>> 0, Date.now() + 60000);
    for (const [k, t] of S.highbornUntil) if (t < Date.now()) S.highbornUntil.delete(k);
  };

  // ---- Imperial Luck --------------------------------------------------------------------------------------------------
  // Only coin the server hands out as loot or pay: a lease's chests and bodies, a camp chest, contract pay. Never the
  // bank, a trade between players, a refund or a staff grant: those never call this. The extra is new coin, given
  // straight to the Imperial. A lease chest pays only on the coin it was rolled with (dungeons.js counts that down), so
  // putting the pile back and taking it again pays nothing. Returns the extra given.
  const goldBonus = (a, amount, why) => {
    if (raceOf(a) !== 'imperial' || !(amount > 0)) return 0;
    const extra = Math.floor(amount * Math.max(0, num(C.imperial.goldBonus, 0)));
    if (extra < 1) return 0;
    if (!giveItem(a >>> 0, GOLD, extra)) return 0;
    try { personal(a >>> 0, `Imperial Luck: ${extra} more gold.`); } catch (e) { /* the message is optional */ }
    log(`racial: ${display(a >>> 0)} Imperial Luck +${extra} gold on ${amount} (${why || 'loot'})`);
    return extra;
  };

  // ---- the overhaul: XP, disease, the Racial Power ---------------------------------------------------------------------
  // skillrates.js rateFor multiplies by this after its own rate (never for a staff award): the race's one boosted skill
  const skillRate = (a, skillId, kind) => {
    if (!overhaul() || kind === 'award') return 1;
    const race = raceOf(a); const xp = race && C[race].xp;
    const r = xp && typeof xp === 'object' ? num(xp[skillId], 1) : 1;
    return r > 0 ? r : 1;
  };
  // supernatural.js: the share of a bite's or a feed's fever this player shrugs off (the Argonian's Hist)
  const diseaseResist = (a) => (overhaul() && raceOf(a) === 'argonian' ? clamp01(num(C.argonian.diseaseResist, 0)) : 0);

  const fmtWait = (ms) => {
    const m = Math.max(1, Math.ceil(ms / 60000));
    return m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`;
  };
  // What the Journal and /status show: null without a power (the overhaul off, a beast form, a race without one)
  const powerView = (a, now = Date.now()) => {
    if (!overhaul()) return null;
    const race = raceOf(a); const p = powerOf(race);
    if (!p) return null;
    const st = powerState(a);
    const activeUntil = st.race === race && Number(st.activeUntil) > now ? Number(st.activeUntil) : 0;
    const readyAt = Number(st.readyAt) > now ? Number(st.readyAt) : 0;
    // activeMs, waitMs: what is left at the time of sending, for a countdown on the player's own clock
    return { race, name: String(p.name || 'Racial Power'), seconds: Math.max(1, num(p.seconds, 60)), clientOnly: p.clientOnly === true,
      activeUntil, readyAt, activeMs: activeUntil ? activeUntil - now : 0, waitMs: readyAt ? readyAt - now : 0,
      ready: !readyAt && !activeUntil && p.clientOnly !== true, buffs: Object.assign({}, p.buffs || {}) };
  };
  // Use it: { ok, text }. Once a real day (cooldownHours), counted from the use, kept on the character
  const usePower = (a, now = Date.now()) => {
    if (!overhaul()) return { ok: false, text: 'Racial powers are not in use yet.' };
    const v = powerView(a, now);
    if (!v) return { ok: false, text: inBeastForm(a) ? 'The beast has no use for it.' : 'You have no racial power to call on.' };
    if (v.clientOnly) return { ok: false, text: `${v.name} comes with a later update of the game.` };
    if (v.activeUntil) return { ok: false, text: `${v.name} is already upon you (${Math.ceil((v.activeUntil - now) / 1000)} s).` };
    if (v.readyAt) return { ok: false, text: `${v.name} returns in ${fmtWait(v.readyAt - now)}.` };
    const p = powerOf(v.race);
    const hours = Math.max(0, num(p.cooldownHours, num(C.powerCooldownHours, 24)));
    const st = { race: v.race, usedAt: now, activeUntil: now + v.seconds * 1000, readyAt: now + hours * 3600000 };
    if (num((p.buffs || {}).wardPoints, 0) > 0) st.wardLeft = num(p.buffs.wardPoints, 0);
    try { mp.set(a >>> 0, POWER, st); } catch (e) { return { ok: false, text: 'Your power cannot be called just now.' }; }
    S.powerOn.set(a >>> 0, st.activeUntil);
    hudRefresh(a);
    // Its look on the player's own game (the DLE's ward spell): nothing when the record is not in the load order yet
    const look = spellOf(p.wardSpell);
    if (look && typeof sendPacket === 'function') { try { sendPacket(a >>> 0, { customPacketType: 'dboCastSelf', spell: look }); } catch (e) { log('racial: ward look failed', e.message); } }
    // What others see: the power's shader on the caster for every player near, until it fades (lookShader, an EFSH)
    const shader = shaderOf(p.lookShader);
    if (shader) { S.looks.set(a >>> 0, { shader, until: st.activeUntil, seen: new Set() }); showLooks(now); }
    log(`racial: ${display(a >>> 0)} used ${v.name} (${v.race}) for ${v.seconds} s`);
    return { ok: true, text: `${v.name}: ${v.seconds} seconds.` };
  };
  if (!(S.powerOn instanceof Map)) S.powerOn = new Map();   // actor -> activeUntil, to say when it fades
  const hudRefresh = (a) => { try { if (typeof globalThis.__dboHudRefresh === 'function') globalThis.__dboHudRefresh(a >>> 0); } catch (e) { /* the HUD catches up */ } };
  // Others see a power through the gamemode's glow packet on the caster (dboGlow, kind champion: an actor shader), sent
  // to each player within LOOK_UNITS when it starts or when they come near, and taken off when it fades (Nate, 11 Oct:
  // nobody saw Roaring Tempest; its spell played on the caster's own game only)
  const LOOK_UNITS = 6000;
  if (!(S.looks instanceof Map)) S.looks = new Map();   // caster -> { shader, until, seen: Set of players told }
  const near = (x, y) => {
    try {
      if (String(mp.get(x, 'worldOrCellDesc')) !== String(mp.get(y, 'worldOrCellDesc'))) return false;
      const a = mp.get(x, 'pos'), b = mp.get(y, 'pos');
      return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= LOOK_UNITS;
    } catch (e) { return false; }
  };
  const glow = (to, caster, shader, on) => { try { sendPacket(to >>> 0, { customPacketType: 'dboGlow', refs: [caster >>> 0], on, kind: 'champion', shader }); } catch (e) { /* offline */ } };
  const showLooks = (now = Date.now()) => {
    if (typeof sendPacket !== 'function') return;
    const online = onlineActors().map((x) => x >>> 0);
    for (const [caster, l] of S.looks) {
      if (l.until <= now || !online.includes(caster)) {
        for (const p of l.seen) glow(p, caster, l.shader, false);
        S.looks.delete(caster);
        continue;
      }
      for (const p of online) if (p !== caster && !l.seen.has(p) && near(p, caster)) { l.seen.add(p); glow(p, caster, l.shader, true); }
    }
  };
  const powerTick = (now = Date.now()) => {
    showLooks(now);
    for (const [a, until] of S.powerOn) {
      if (until > now) continue;
      S.powerOn.delete(a);
      const p = powerOf(raceOf(a));
      try { if (p) personal(a, `${p.name} fades.`); } catch (e) { /* offline */ }
      hudRefresh(a);
    }
  };
  if (typeof every === 'function') every('racialPower', 1000, () => { try { powerTick(); } catch (e) { log('racial power tick failed', e.message); } });
  // The /status line and the Journal's Status (gamemode.js __dboRegisterStatus)
  const statusLine = (a, now = Date.now()) => {
    const v = powerView(a, now); if (!v) return '';
    if (v.clientOnly) return `${v.name}: with a later update of the game`;
    if (v.activeUntil) return `${v.name}: upon you, ${Math.ceil((v.activeUntil - now) / 1000)} s left`;
    if (v.readyAt) return `${v.name}: returns in ${fmtWait(v.readyAt - now)}`;
    return `${v.name}: ready`;
  };
  if (typeof globalThis.__dboRegisterStatus === 'function') globalThis.__dboRegisterStatus('racialPower', 57, (a) => statusLine(a) || null);
  // The HUD's countdown (gamemode.js pushHud): { name, ms } while it lasts. ms is what is left at sending; the client turns it
  // into an end on its own clock. Whole seconds, so the HUD's dedupe sends it once a second at most
  const hudField = (a, now = Date.now()) => { const v = powerView(a, now); return v && v.activeUntil ? { name: v.name, ms: Math.ceil(v.activeMs / 1000) * 1000 } : null; };

  // A config desc ('<hex>:<plugin>') to a SPEL in the load order, else 0: a record the DLE does not carry yet does nothing
  const shaderOf = (desc) => {
    if (!desc) return 0;
    try { const id = mp.getIdFromDesc(String(desc)) >>> 0; const r = id ? recordOf(id) : null; return r && String(r.record.type) === 'EFSH' ? id : 0; } catch (e) { return 0; }
  };
  const spellOf = (desc) => {
    if (!desc) return 0;
    try { const id = mp.getIdFromDesc(String(desc)) >>> 0; const r = id ? recordOf(id) : null; return r && String(r.record.type) === 'SPEL' ? id : 0; } catch (e) { return 0; }
  };
  // The Maormer's swimming ability: on a Maormer character once a session (a relog builds the actor again), off a character
  // that is no longer one (private.racialAbility remembers what was given). A beast form keeps it; it comes off only with the race
  const ABILITY = 'private.racialAbility';
  if (!(S.abilityOn instanceof Set)) S.abilityOn = new Set();
  const papyrusSpell = (a, add, id) => {
    try {
      mp.callPapyrusFunction('method', 'Actor', add ? 'AddSpell' : 'RemoveSpell', { type: 'form', desc: mp.getDescFromId(a >>> 0) },
        add ? [{ type: 'espm', desc: mp.getDescFromId(id >>> 0) }, false] : [{ type: 'espm', desc: mp.getDescFromId(id >>> 0) }]);
      return true;
    } catch (e) { log(`racial: ${add ? 'AddSpell' : 'RemoveSpell'} ${id.toString(16)} on ${display(a >>> 0)} failed`, e.message); return false; }
  };
  const isMaormer = (a) => C.overhaul === true && on() && isPlayer(a) && (MAORMER_IDS.includes(raceIdOf(a)) || (RACE_OF_ID.get(raceIdOf(a)) === 'altmer' && rpRace(a) === 'maormer'));
  const abilityTick = () => {
    const want = spellOf(C.maormer.seafarerSpell);
    const here = new Set();
    for (const a0 of onlineActors()) {
      const a = a0 >>> 0; here.add(a);
      let held = ''; try { held = String(mp.get(a, ABILITY) || ''); } catch (e) { held = ''; }
      if (want && isMaormer(a)) {
        if (S.abilityOn.has(a)) continue;
        if (papyrusSpell(a, true, want)) { S.abilityOn.add(a); try { mp.set(a, ABILITY, mp.getDescFromId(want)); } catch (e) { /* given anyway */ } }
      } else if (held) {
        const id = (() => { try { return mp.getIdFromDesc(held) >>> 0; } catch (e) { return 0; } })();
        if (!id || papyrusSpell(a, false, id)) { S.abilityOn.delete(a); try { mp.set(a, ABILITY, null); } catch (e) { /* tried */ } }
      }
    }
    for (const a of [...S.abilityOn]) if (!here.has(a)) S.abilityOn.delete(a);
  };
  if (typeof every === 'function') every('racialAbility', 15000, () => { try { abilityTick(); } catch (e) { log('racial ability failed', e.message); } });

  globalThis.__dboRaceGold = goldBonus;
  globalThis.__dboRaceOf = raceOf;
  globalThis.__dboRaceSkillRate = skillRate;
  globalThis.__dboRaceDiseaseResist = diseaseResist;
  globalThis.__dboRacialPowerUse = usePower;
  globalThis.__dboRacialPowerView = powerView;
  globalThis.__dboRacialPowerHud = hudField;
  return { config: C, raceOf, attackMult, targetMult, capTargetSide, regenFactor, extraPerSecond, regenTick, onCast, castHeld, goldBonus, inCold, fighting, COMBAT,
    skillRate, diseaseResist, powerView, usePower, powerTick, statusLine, hudField, abilityTick, wardAbsorb };
};
module.exports.RACES = RACES;
module.exports.RACE_IDS = RACE_IDS;
