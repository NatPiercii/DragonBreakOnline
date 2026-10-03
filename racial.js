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
//     blessings add theirs (prayer.js prayerBlessingRegen): every tickSeconds a bar is raised by the race's share, which
//     multiplies the rest of the chain: hunger (__dboNeedsRateMult), the vampire blood (__dboSuperRateMult), a
//     blessing's own boost (__dboBlessingRegen) and Death's Chill (__dboChillRateMult, 0 at its cap).
//   - gold: an Imperial's share of loot and contract pay, by goldBonus, which dungeons.js, wildlife.js and contracts.js
//     call where the server hands the coin over.
// Rules: players only; nothing while a beast form is on (werewolf, Vampire Lord); an always-on regeneration factor is
// never above alwaysRegenCap, a conditional one never above conditionalRegenCap. In a fight the game slows the client's
// own regeneration (the fCombat*RegenRateMult GMSTs), so the gift's extra is slowed the same way and the factor stays the
// factor: a player counts as fighting for combatSeconds after a landed blow given or taken (gamemode.js __dboCombatAt).
// Config "racial": { enabled, reductionCap, alwaysRegenCap, conditionalRegenCap, combatSeconds, tickSeconds, minStep,
// <race>: {...} }
'use strict';

const RACES = ['altmer', 'argonian', 'bosmer', 'breton', 'dunmer', 'imperial', 'khajiit', 'nord', 'orc', 'redguard'];
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
const DEFAULTS = {
  enabled: false, reductionCap: 0.75, alwaysRegenCap: 1.25, conditionalRegenCap: 1.5, combatSeconds: 10, tickSeconds: 1, minStep: 0.002,
  altmer: { magickaRegen: 1.25, elementalWeakness: 0 },
  // inCombat: Hist-Blooded keeps its full extra in a fight (the base game heals nothing in combat: off scales it to 0)
  argonian: { resistPoison: 0.5, lowHealth: 0.35, lowHealthHealRegen: 1.5, inCombat: false },
  bosmer: { bowDamage: 0.1, resistPoison: 0.5 },
  breton: { resistMagic: 0.25 },
  dunmer: { resistFire: 0.5 },
  imperial: { goldBonus: 0.1 },
  khajiit: { unarmedDamage: 8 },
  // Outdoors in Skyrim, or in the Jerall Mountains: the BSHeartland worldspace around Bruma and the Pale Pass road
  nord: { resistFrost: 0.5, coldStaminaRegen: 1.15, coldProvinces: ['skyrim'],
    coldAreas: [{ world: 'a764b:BSHeartland.esm', pos: [56000, 232000], radius: 60000 }] },
  orc: { lowHealth: 0.3, meleeDamage: 0.2, damageTaken: 0.2 },
  redguard: { staminaRegen: 1.25, resistPoison: 0.5 },
};
const merge = (cfg) => {
  const c = Object.assign({}, DEFAULTS, cfg || {});
  for (const r of RACES) c[r] = Object.assign({}, DEFAULTS[r], (cfg || {})[r] || {});
  return c;
};
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp01 = (v) => Math.max(0, Math.min(1, v));

module.exports = (api) => {
  const { mp, log, personal, giveItem, profileOf, display, recordOf, every, onlineActors, weaponHandsOf, sourceResistsOf, gmstFloat, cfg } = api;
  const C = merge(cfg && cfg.racial);
  const on = () => C.enabled === true;
  const S = globalThis.__dboRacialState || (globalThis.__dboRacialState = { owed: new Map(), highbornUntil: new Map() });

  // ---- who ----------------------------------------------------------------------------------------------------------
  const isPlayer = (a) => { try { return profileOf(a >>> 0) >= 0; } catch (e) { return false; } };
  const inBeastForm = (a) => { try { const b = mp.get(a >>> 0, 'private.beast'); return !!(b && b.form); } catch (e) { return false; } };
  const raceIdOf = (a) => { try { const app = mp.get(a >>> 0, 'appearance'); return app && app.raceId ? Number(app.raceId) >>> 0 : 0; } catch (e) { return 0; } };
  // The race whose gift this player has now, or '' (not a player, a beast form, an unknown race, switched off)
  const raceOf = (a) => {
    if (!on() || !isPlayer(a) || inBeastForm(a)) return '';
    return RACE_OF_ID.get(raceIdOf(a)) || '';
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

  // ---- damage -------------------------------------------------------------------------------------------------------
  const resists = (src) => { try { return sourceResistsOf(src >>> 0) || new Set(); } catch (e) { return new Set(); } };
  const isMagicSource = (src) => { const r = recordOf(src >>> 0); return !!r && ['SPEL', 'ENCH', 'SCRL'].includes(String(r.record.type)); };
  const hands = (src) => { try { return weaponHandsOf(src >>> 0) || ''; } catch (e) { return ''; } };
  // The attacker's gift: above 1 hits harder. dmg is the engine's damage, for nothing but a guard against 0.
  const attackMult = (agg, tgt, src, dmg) => {
    const race = raceOf(agg); if (!race || !(dmg > 0) || agg === tgt) return 1;
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
  // The target's gift: below 1 takes less, above 1 more (the Altmer's optional weakness)
  const targetMult = (agg, tgt, src) => {
    const race = raceOf(tgt); if (!race || agg === tgt) return 1;
    const R = C[race];
    const rs = resists(src);
    let m = 1;
    const resist = (share) => { m *= 1 - clamp01(num(share, 0)); };
    if (rs.has(AV.poison) && (race === 'argonian' || race === 'bosmer' || race === 'redguard')) resist(R.resistPoison);
    if (race === 'dunmer' && rs.has(AV.fire)) resist(R.resistFire);
    if (race === 'nord' && rs.has(AV.frost)) resist(R.resistFrost);
    if (race === 'breton' && isMagicSource(src)) resist(R.resistMagic);
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
  // The race's factor on one bar's regeneration now (1 = none), capped by the rule for its kind
  const regenFactor = (a, stat) => {
    const race = raceOf(a); if (!race) return 1;
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
  const extraPerSecond = (a, stat) => {
    const f = regenFactor(a, stat);
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
  const TICK_MS = Math.max(250, Math.round(num(C.tickSeconds, 1) * 1000));
  const regenTick = (now = Date.now()) => {
    const here = new Set();
    if (!on()) { S.owed.clear(); return; }
    for (const a of onlineActors()) {
      here.add(a);
      if (!raceOf(a)) { S.owed.delete(a); continue; }
      let owed = S.owed.get(a);
      if (!owed) { owed = { at: now - TICK_MS, health: 0, magicka: 0, stamina: 0 }; S.owed.set(a, owed); }
      // Never more than three ticks at once: a stall or a reload does not pay out
      const secs = Math.min(Math.max(0, now - owed.at), 3 * TICK_MS) / 1000;
      owed.at = now;
      let pc = null; try { pc = mp.get(a, 'percentages'); } catch (e) { pc = null; }
      let downed = false; try { downed = typeof globalThis.__dboIsDowned === 'function' && !!globalThis.__dboIsDowned(a); } catch (e) { downed = false; }
      if (!pc || !(Number(pc.health) > 0) || downed || !(secs > 0)) { owed.health = owed.magicka = owed.stamina = 0; continue; }
      const next = { health: Number(pc.health), magicka: Number(pc.magicka), stamina: Number(pc.stamina) };
      let changed = false;
      for (const stat of ['health', 'magicka', 'stamina']) {
        const add = extraPerSecond(a, stat) * secs;
        if (!(next[stat] < 1) || !(add > 0)) { owed[stat] = 0; continue; }
        owed[stat] += add;
        if (owed[stat] < num(C.minStep, 0.002)) continue;
        next[stat] = Math.min(1, next[stat] + owed[stat]);
        owed[stat] = 0;
        changed = true;
      }
      if (changed) { try { mp.set(a, 'percentages', next); } catch (e) { S.owed.delete(a); } }
    }
    for (const a of [...S.owed.keys()]) if (!here.has(a)) S.owed.delete(a);
  };
  // Registered whatever the config says and off inside, so a reload that turns it off replaces the running timer
  if (typeof every === 'function') every('racialRegen', TICK_MS, () => { try { regenTick(); } catch (e) { log('racial regen failed', e.message); } });

  // ---- Highborn -------------------------------------------------------------------------------------------------------
  // gamemode.js castHook: a Highborn cast that reaches the server (an old or modified client; 0.3.74 dispels it and
  // never relays it) runs the C++ rate boost for its minute, and the Altmer's gift waits that minute
  const onCast = (a, spellId) => {
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

  globalThis.__dboRaceGold = goldBonus;
  globalThis.__dboRaceOf = raceOf;
  return { config: C, raceOf, attackMult, targetMult, capTargetSide, regenFactor, extraPerSecond, regenTick, onCast, goldBonus, inCold, fighting, COMBAT };
};
module.exports.RACES = RACES;
module.exports.RACE_IDS = RACE_IDS;
