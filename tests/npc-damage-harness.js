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
const load = (src, cfg) => new Function('mp', 'cfg', 'profileOf', src + '\nreturn { npcPowerHitMult, npcKindDamageMult: typeof npcKindDamageMult === "function" ? npcKindDamageMult : null, npcLethalGuard: typeof npcLethalGuard === "function" ? npcLethalGuard : null, npcKindOf: typeof npcKindOf === "function" ? npcKindOf : null };')(mp, cfg, profileOf);

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

console.log(fails ? `\n${fails} FAILED` : '\nall checks passed');
process.exit(fails ? 1 : 0);
