// NPC damage by kind (gamemode-config npcDamage.byKind) and the lethal guard for scaled-down NPC hits on players
// (gamemode.js npcKindDamageMult, npcLethalGuard), with npcPowerHits. Lifts the block out of gamemode.js and runs it on a
// stub mp; then plays boar bites through the server's model: the formula's damage (unarmed 25, x2 NPC on player, x2 for a
// power attack, the armor penalty), the attempt hook, the engine's deduction, and masteryBonusDamage's give-back.
//   node tests/npc-damage-harness.js   (from server/)
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SERVER = path.resolve(__dirname, '..');
const START = '// ---- NPC power hits: how hard a creature', END = 'const hitDamageAttemptHook =';
const cut = (src) => { const a = src.indexOf(START), b = src.indexOf(END, a); return a < 0 || b < 0 ? null : src.slice(a, b); };
const NEW = cut(fs.readFileSync(path.join(SERVER, 'gamemode.js'), 'utf8'));
if (!NEW) { console.log('FAIL the NPC damage block is gone from gamemode.js'); process.exit(1); }

let fails = 0;
const ok = (c, what, got) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${what}${!c && got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!c) fails++; };

// ---- a stub world ----------------------------------------------------------------------------------------------------
const PLAYER = 0xff000014, PLAYER2 = 0xff000015, BOAR = 0xff000100, WOLF = 0xff000101, BANDIT = 0xff000102, PLAIN = 0xff000103;
const props = new Map();
const put = (id, k, v) => props.set(id + '|' + k, v);
put(BOAR, 'private.npcSpawner', 'wild:boar:p15404f-dragonbreakonlineedits');
put(WOLF, 'private.npcSpawner', 'wild:wolf:12');
put(BANDIT, 'private.npcSpawner', 'dungeon:plunderedmine:3');
const mp = { get: (id, k) => props.get(id + '|' + k), set: (id, k, v) => props.set(id + '|' + k, v) };
const profileOf = (a) => (a === PLAYER || a === PLAYER2 ? 7 : -1);
const load = (src, cfg) => new Function('mp', 'cfg', 'profileOf', src + '\nreturn { npcPowerHitMult, npcKindDamageMult: typeof npcKindDamageMult === "function" ? npcKindDamageMult : null, npcLethalGuard: typeof npcLethalGuard === "function" ? npcLethalGuard : null, npcKindOf: typeof npcKindOf === "function" ? npcKindOf : null, npcTakenDamageMult: typeof npcTakenDamageMult === "function" ? npcTakenDamageMult : null, npcTakenLowerFirst: typeof npcTakenLowerFirst === "function" ? npcTakenLowerFirst : null };')(mp, cfg, profileOf);

// ---- npcKindDamageMult ------------------------------------------------------------------------------------------------
const cfg = { npcPowerHits: { mult: 0.5 }, npcDamage: { byKind: { boar: 0.4, wolf: 0 } } };
const F = load(NEW, cfg);
ok(F.npcKindOf(BOAR) === 'boar' && F.npcKindOf(WOLF) === 'wolf' && F.npcKindOf(BANDIT) === '' && F.npcKindOf(PLAIN) === '', 'the kind is the middle of a wild:<kind>:... tag; dungeon and untagged actors have none');
ok(F.npcKindDamageMult(BOAR, PLAYER, 50) === 0.4, "a boar's hit on a player takes byKind.boar");
ok(F.npcKindDamageMult(PLAYER, BOAR, 50) === 1, "a player's hit on a boar is untouched");
ok(F.npcKindDamageMult(PLAYER, PLAYER2, 50) === 1, 'PvP is untouched');
ok(F.npcKindDamageMult(BOAR, WOLF, 50) === 1, 'a boar biting another creature is untouched');
ok(F.npcKindDamageMult(WOLF, PLAYER, 50) === 1, 'a value that is not above 0 (wolf: 0) changes nothing');
ok(F.npcKindDamageMult(BANDIT, PLAYER, 50) === 1 && F.npcKindDamageMult(PLAIN, PLAYER, 50) === 1, 'a kind not listed, or no kind, changes nothing');
ok(F.npcKindDamageMult(BOAR, PLAYER, 0) === 1, 'a hit for nothing changes nothing');
cfg.npcDamage.byKind.boar = 0.6;
ok(F.npcKindDamageMult(BOAR, PLAYER, 50) === 0.6, 'read per hit: a config edit takes effect at once');
cfg.npcDamage.byKind.boar = 0.4;
ok(load(NEW, {}).npcKindDamageMult(BOAR, PLAYER, 50) === 1 && load(NEW, { npcDamage: { byKind: {} } }).npcKindDamageMult(BOAR, PLAYER, 50) === 1, 'no npcDamage, or an empty byKind (as shipped): nothing changes');

// ---- npcLethalGuard ---------------------------------------------------------------------------------------------------
const MAX = 150;
const setHealth = (pts) => put(PLAYER, 'percentages', { health: pts / MAX, magicka: 1, stamina: 0.5 });
const healthPts = () => mp.get(PLAYER, 'percentages').health * MAX;
setHealth(40);
let g = F.npcLethalGuard(BOAR, PLAYER, 50, 0.4, { targetMaxHealth: MAX });
ok(!!g && g.rest === 1 && Math.abs(healthPts() - 70) < 1e-9, 'a 50-point bite at 40 health, scaled to 20: health is raised to 70 first, so the engine leaves 20 (nothing left to give back)', [g, healthPts()]);
ok(mp.get(PLAYER, 'percentages').stamina === 0.5, '...and magicka and stamina are kept');
setHealth(100);
ok(F.npcLethalGuard(BOAR, PLAYER, 50, 0.4, { targetMaxHealth: MAX }) === null && healthPts() === 100, 'not lethal as dealt: nothing is raised (the give-back afterwards does it)');
setHealth(15);
ok(F.npcLethalGuard(BOAR, PLAYER, 50, 0.4, { targetMaxHealth: MAX }) === null && healthPts() === 15, 'lethal even scaled (20 at 15 health): nothing is raised, the bite downs them');
setHealth(40);
ok(F.npcLethalGuard(PLAYER2, PLAYER, 50, 0.4, { targetMaxHealth: MAX }) === null && healthPts() === 40, 'PvP is never guarded');
ok(F.npcLethalGuard(BOAR, PLAYER, 50, 1, { targetMaxHealth: MAX }) === null && F.npcLethalGuard(BOAR, PLAYER, 50, 1.2, { targetMaxHealth: MAX }) === null, 'a scale of 1 or more is never guarded');
ok(F.npcLethalGuard(BOAR, PLAYER, 50, 0.4, {}) === null && F.npcLethalGuard(BOAR, PLAYER, 50, 0.4, null) === null, 'no targetMaxHealth from the server: nothing is raised');
ok(F.npcLethalGuard(BOAR, WOLF, 50, 0.4, { targetMaxHealth: MAX }) === null, 'an NPC target is never guarded');
setHealth(90);
g = F.npcLethalGuard(BOAR, PLAYER, 100, 0.2, { targetMaxHealth: MAX });
ok(!!g && healthPts() === 150 && Math.abs(g.rest - 0.8) < 1e-9, 'a 100-point power bite at 90 health, scaled to 20: the raise stops at full health (150), and the give-back is told to return the 20 the cap kept (rest 0.8)', [g, healthPts()]);

// D2: weapon hits only (a spell hit writes its own snapshot back after the hook)
setHealth(40);
ok(F.npcLethalGuard(BOAR, PLAYER, 50, 0.4, { targetMaxHealth: MAX, spell: true }) === null && healthPts() === 40, 'a spell hit is never guarded (OnSpellHit writes its snapshot back after the hook)');

// D1 (Worker D's repro): a hit from someone fighting for a player goes through downed.js's friendly-fire rule, which reads
// health after this hook; a raise there handed the player back more than the hit took. Through the real downed.js.
const friendlyRun = (guardSrc) => {
  const OWNER = 0xff000016, COMP = 0xff000200;
  const fp = new Map(); const fput = (id, k, v) => fp.set(id + '|' + k, v);
  fput(PLAYER, 'profileId', 7); fput(OWNER, 'profileId', 8); fput(COMP, 'ff_companionOf', OWNER);
  const fmp = { get: (id, k) => fp.get(id + '|' + k), set: (id, k, v) => fp.set(id + '|' + k, v) };
  const fprofile = (x) => { const v = fp.get(x + '|profileId'); return v === undefined ? -1 : v; };
  const G = new Function('mp', 'cfg', 'profileOf', guardSrc + '\nreturn { npcLethalGuard };')(fmp, { npcPowerHits: { mult: 0.5 } }, fprofile);
  const MULT = 0.5;
  let pending = null;
  fmp.onHitDamageAttempt = (agg, tgt, srcId, dmg, flags) => {     // the gamemode's hook, reduced to the guard and the pending note
    pending = null;
    const g = G.npcLethalGuard(agg, tgt, dmg, MULT, flags);
    if (g) { if (g.rest < 1) pending = { mult: g.rest, health: g.health }; return true; }
    const q = fmp.get(tgt, 'percentages'); pending = { mult: MULT, health: q.health }; return true;
  };
  fmp.onHitDamage = (agg, tgt) => {                               // masteryBonusDamage's give-back
    const pend = pending; pending = null; if (!pend) return;
    const now = fmp.get(tgt, 'percentages'); if (!(now.health > 0)) return;
    const dealt = pend.health - now.health; if (!(dealt > 0)) return;
    const h = Math.min(pend.health, now.health - dealt * (pend.mult - 1)); if (h > now.health) fmp.set(tgt, 'percentages', { health: h, magicka: 1, stamina: 1 });
  };
  const savedLeader = globalThis.__dboPartyLeaderOf, savedState = globalThis.__dboDownedState;
  globalThis.__dboPartyLeaderOf = (x) => (x === PLAYER || x === OWNER ? OWNER : null);
  globalThis.__dboDownedState = undefined;
  const DOWNED = path.join(SERVER, 'downed.js'); delete require.cache[DOWNED];
  require(DOWNED)({ mp: fmp, log: () => {}, personal: () => {}, sendPacket: () => {}, audit: () => {}, who: String, display: String,
    profileOf: fprofile, nameOf: String, onlineActors: () => [PLAYER, OWNER], every: () => {}, registerChatCommand: () => {}, cfg: {}, openWidget: () => {},
    closeWidget: () => {}, onUi: () => {}, redress: () => {} });
  const out = [];
  for (const [h0, d] of [[60, 100], [60, 70], [40, 50], [120, 140]]) {
    fput(PLAYER, 'percentages', { health: h0 / MAX, magicka: 1, stamina: 1 });
    if (fmp.onHitDamageAttempt(COMP, PLAYER, 0x1f4, d, { targetMaxHealth: MAX }) !== false) {
      const q = fmp.get(PLAYER, 'percentages');                  // the C++ re-reads, then deducts the engine's full damage
      fmp.set(PLAYER, 'percentages', { health: Math.max(0, q.health - d / MAX), magicka: 1, stamina: 1 });
      fmp.onHitDamage(COMP, PLAYER, 0x1f4, d, {});
    }
    out.push([h0, Math.round(fmp.get(PLAYER, 'percentages').health * MAX * 10) / 10]);
  }
  globalThis.__dboPartyLeaderOf = savedLeader; globalThis.__dboDownedState = savedState;
  return out;
};
const NO_GUARD = NEW.replace(/const npcLethalGuard = [\s\S]*?\n};\n/, 'const npcLethalGuard = () => null;\n');
const today = friendlyRun(NO_GUARD), withGuard = friendlyRun(NEW);
ok(withGuard.every(([h0, h1]) => h1 <= h0), "a party member's companion's scaled hit never leaves the player with more health than before (downed.js's friendly rule)", withGuard);
ok(JSON.stringify(withGuard) === JSON.stringify(today), "...and lands exactly as it does without the guard: downed.js owns friendly hits", { withGuard, today });

// ---- boar bites through the server's model ------------------------------------------------------------------------------
// formula: unarmed 25 x armor penalty, x2 for a power attack, x2 NPC on player; the hook's mult (npcPowerHits x byKind x the
// Defense ratio); the guard; the engine's deduction; then masteryBonusDamage's give-back of dealt x (1 - mult) if alive.
const kept = (ar) => 1 - Math.min(ar * 0.12, 80) / 100;
const bitesToDown = (fx, { power = false, ar = 0, defense = 1, max = 150 } = {}) => {
  let h = max;
  for (let n = 1; n <= 100; n++) {
    const dmg = 25 * kept(ar) * (power ? 2 : 1) * 2;
    const mult = fx.npcPowerHitMult(BOAR, PLAYER, { power }, dmg) * (fx.npcKindDamageMult ? fx.npcKindDamageMult(BOAR, PLAYER, dmg) : 1) * defense;
    put(PLAYER, 'percentages', { health: h / max, magicka: 1, stamina: 1 });
    const guard = fx.npcLethalGuard ? fx.npcLethalGuard(BOAR, PLAYER, dmg, mult, { targetMaxHealth: max }) : null;
    const before = mp.get(PLAYER, 'percentages').health * max;
    let after = before - dmg;
    if (after <= 0) return n;                                   // the engine's hit downed them
    // masteryBonusDamage: gives back dealt x (1 - pending mult), never above the health the pending recorded
    const pendMult = guard ? guard.rest : mult;
    if (pendMult !== 1) after = Math.min(before, after + dmg * (1 - pendMult));
    h = after;
  }
  return Infinity;
};
const LIVE_SRC = (() => { try { return cut(execSync('git show ce22b2c7:gamemode.js', { cwd: SERVER, encoding: 'utf8', maxBuffer: 64 << 20 })); } catch (e) { return null; } })();
const LIVE_BOAR = (() => { try { return cut(execSync('git show 9ec5e741:gamemode.js', { cwd: SERVER, encoding: 'utf8', maxBuffer: 64 << 20 })); } catch (e) { return null; } })();
if (!LIVE_SRC) console.log('skip  the live comparison (ce22b2c7 is not in this clone)');
const live = LIVE_SRC ? load(LIVE_SRC, { npcPowerHits: { mult: 0.5 } }) : null;
const now0 = load(NEW, { npcPowerHits: { mult: 0.5 } });                                  // this code, byKind empty (as shipped)
const prop = load(NEW, { npcPowerHits: { mult: 0.5 }, npcDamage: { byKind: { boar: 0.4 } } });   // with the proposal
const table = [];
const row = (label, o) => { const r = { label, live: live ? bitesToDown(live, o) : '-', shipped: bitesToDown(now0, o), boar04: bitesToDown(prop, o) }; table.push(r); return r; };
const fresh = row('new character (150), starter clothes, normal bites', {});
const freshP = row('new character (150), starter clothes, power bites', { power: true });
const imp = row('Imperial (200), starter clothes, normal bites', { max: 200 });
const hide = row('hide armour (AR 40), no Defense, normal bites', { ar: 40 });
const hideD2 = row('hide armour (AR 40), Defense tier 2 (x1.75), normal bites', { ar: 40, defense: kept(70) / kept(40) });
for (const r of table) console.log(`      ${r.label}: down on bite ${r.live} live, ${r.shipped} shipped (byKind empty), ${r.boar04} with boar 0.4`);
if (live) {
  ok(fresh.live === 3 && freshP.live === 2, 'live today: 3 normal bites or 2 power bites down a new character (the give-back cannot save a hit the engine made lethal)', [fresh.live, freshP.live]);
}
ok(fresh.shipped === 3 && freshP.shipped === 3, 'as shipped (byKind empty): the guard makes npcPowerHits real, power bites now count as normal ones (3)', [fresh.shipped, freshP.shipped]);
ok(fresh.boar04 === 8 && freshP.boar04 === 8, 'with boar 0.4: a new character survives 7 bites, normal or power, and goes down on the 8th', [fresh.boar04, freshP.boar04]);
ok(imp.boar04 === 10 && hideD2.boar04 >= 8, 'with boar 0.4: an Imperial lasts 9 bites, hide armour with Defense tier 2 at least as long as a new character', [imp.boar04, hideD2.boar04]);

// ---- live then new: npcPowerHitMult is unchanged ------------------------------------------------------------------------
if (live) {
  let same = true;
  for (const [a, t] of [[BOAR, PLAYER], [PLAYER, BOAR], [PLAYER, PLAYER2], [BOAR, WOLF]]) for (const power of [true, false]) for (const spell of [true, false]) for (const d of [0, 50]) {
    if (live.npcPowerHitMult(a, t, { power, spell }, d) !== now0.npcPowerHitMult(a, t, { power, spell }, d)) same = false;
  }
  ok(same, 'live then new: npcPowerHitMult gives the same answer for every attacker, target, flag and damage');
  ok(live.npcKindDamageMult === null && live.npcLethalGuard === null, 'the live block has neither function: a hot reload adds them, and they keep no state on globalThis');
}

// ---- npcDamage.takenByKind: players' hits on a kind (Nate, 1 Oct: boars "barely take damage") ---------------------------
{
  const COMPANION = 0xff000300, STRAY = 0xff000301;
  put(COMPANION, 'ff_companionOf', PLAYER2);
  put(STRAY, 'ff_companionOf', BOAR);
  const tcfg = { npcPowerHits: { mult: 0.5 }, npcDamage: { byKind: { boar: 0.4 }, takenByKind: { boar: 5, wolf: -1 } } };
  const T = load(NEW, tcfg);
  ok(T.npcTakenDamageMult(PLAYER, BOAR, 7) === 5, "a player's hit on a boar takes takenByKind.boar");
  ok(T.npcTakenDamageMult(COMPANION, BOAR, 7) === 5, "...and so does a hit by someone fighting for a player (ff_companionOf names a player)");
  ok(T.npcTakenDamageMult(STRAY, BOAR, 7) === 1 && T.npcTakenDamageMult(WOLF, BOAR, 7) === 1, 'an NPC fighting for no player, or an NPC on an NPC, is untouched');
  ok(T.npcTakenDamageMult(PLAYER, PLAYER2, 7) === 1 && T.npcTakenDamageMult(BOAR, PLAYER, 7) === 1, 'PvP and NPC-on-player hits are untouched');
  ok(T.npcTakenDamageMult(PLAYER, WOLF, 7) === 1 && T.npcTakenDamageMult(PLAYER, BANDIT, 7) === 1 && T.npcTakenDamageMult(PLAYER, PLAIN, 7) === 1, 'a value not above 0, a kind not listed, or no kind: untouched');
  ok(load(NEW, { npcDamage: { byKind: { boar: 0.4 } } }).npcTakenDamageMult(PLAYER, BOAR, 7) === 1, 'no takenByKind: untouched');
  tcfg.npcDamage.takenByKind.boar = 3;
  ok(T.npcTakenDamageMult(PLAYER, BOAR, 7) === 3, 'read per hit: a config edit takes effect at once');
  tcfg.npcDamage.takenByKind.boar = 5;
  // lower first: weapon hits only, a sliver left so the engine's own blow kills
  const BMAX = 200;
  const setBoar = (pts) => put(BOAR, 'percentages', { health: pts / BMAX, magicka: 0, stamina: 0.7 });
  const boarPts = () => mp.get(BOAR, 'percentages').health * BMAX;
  setBoar(200);
  ok(T.npcTakenLowerFirst(BOAR, 7, 5, { targetMaxHealth: BMAX }) === true && Math.abs(boarPts() - 172) < 1e-9 && mp.get(BOAR, 'percentages').stamina === 0.7, 'a 7-point sword blow at x5: 28 comes off first (200 -> 172), the engine takes the 7, stamina kept', boarPts());
  setBoar(20);
  ok(T.npcTakenLowerFirst(BOAR, 7, 5, { targetMaxHealth: BMAX }) === true && boarPts() > 0 && boarPts() < 7, '...at 20 health the extra leaves only a sliver, so the engine\'s own blow kills', boarPts());
  setBoar(100);
  ok(T.npcTakenLowerFirst(BOAR, 7, 5, { targetMaxHealth: BMAX, spell: true }) === false && boarPts() === 100, 'a spell hit is not lowered first (OnSpellHit writes its snapshot back): its extra goes the usual way');
  ok(T.npcTakenLowerFirst(BOAR, 7, 5, {}) === false && T.npcTakenLowerFirst(BOAR, 7, 1, { targetMaxHealth: BMAX }) === false && T.npcTakenLowerFirst(BOAR, 7, 0.5, { targetMaxHealth: BMAX }) === false && boarPts() === 100, 'no max health from the server, or a mult of 1 or less: nothing is lowered');

  // hits to kill a boar (BSKEncBoar01, level 7, BSKBoarRace 200 health, no armour): a new character's weapon hits, the
  // formula's damage (base WEAP damage or the race's unarmed 4, x2 power, no armour penalty, no NPC x2), tier 0 and iron
  // add nothing; through the hook (lower first) and the engine's deduction
  const hitsToKill = (fx, dmg) => {
    let h = BMAX;
    for (let n = 1; n <= 200; n++) {
      put(BOAR, 'percentages', { health: h / BMAX, magicka: 0, stamina: 1 });
      const m = fx.npcTakenDamageMult ? fx.npcTakenDamageMult(PLAYER, BOAR, dmg) : 1;
      if (m > 1 && fx.npcTakenLowerFirst) fx.npcTakenLowerFirst(BOAR, dmg, m, { targetMaxHealth: BMAX });
      h = mp.get(BOAR, 'percentages').health * BMAX - dmg;
      if (h <= 1e-9) return n;                                  // the engine's hit killed it (allowing for float error)
    }
    return Infinity;
  };
  const SAME = { npcPowerHits: { mult: 0.5 }, npcDamage: { byKind: { boar: 0.4 } } };
  const liveT = LIVE_BOAR ? load(LIVE_BOAR, SAME) : null;
  const rows = [['fists (unarmed 4)', 4], ['iron dagger (4)', 4], ['iron sword (7)', 7], ['iron sword, power attack (14)', 14], ['Khajiit fists (unarmed 10)', 10]];
  const res = {};
  for (const [label, dmg] of rows) {
    res[label] = { live: liveT ? hitsToKill(liveT, dmg) : Math.ceil(BMAX / dmg), x5: hitsToKill(T, dmg) };
    console.log(`      boar, ${label}: ${res[label].live} hits today, ${res[label].x5} with takenByKind.boar 5`);
  }
  ok(res['iron sword (7)'].live === 29 && res['fists (unarmed 4)'].live === 50, 'today: a new character needs 29 iron-sword blows or 50 punches for a boar', res);
  ok(res['iron sword (7)'].x5 === 6 && res['iron dagger (4)'].x5 === 10 && res['iron sword, power attack (14)'].x5 === 3, 'with takenByKind.boar 5: 6 iron-sword blows, 10 dagger stabs, 3 power attacks', res);
  if (liveT) {
    let same = true;
    for (const [a, t] of [[BOAR, PLAYER], [PLAYER, BOAR], [PLAYER, PLAYER2], [BOAR, WOLF], [COMPANION, PLAYER]]) for (const power of [true, false]) for (const d of [0, 50]) {
      const nw = load(NEW, SAME);
      if (liveT.npcPowerHitMult(a, t, { power }, d) !== nw.npcPowerHitMult(a, t, { power }, d)) same = false;
      if (liveT.npcKindDamageMult(a, t, d) !== nw.npcKindDamageMult(a, t, d)) same = false;
    }
    ok(same, 'live (9ec5e741) then new: npcPowerHitMult and npcKindDamageMult answer the same in every case');
    ok(liveT.npcTakenDamageMult === null, 'the live block has no takenByKind: a hot reload adds it, with no state on globalThis');
  }
}

console.log(fails ? `\n${fails} FAILED` : '\nall checks passed');
process.exit(fails ? 1 : 0);
