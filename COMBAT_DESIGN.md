# Combat feel: skill-based fights (draft for Nat, 2026-09-25)

Nat: "pvp damage across the board needs to be buffed a bit", "daedric and bone do the same damage", "i want fights to be
skill based yanno, with staggering, shield bash, damage etc", "magic is a bit weak too".

## What the server does today (read from the code and the live log)

| Piece | Today | Where |
|---|---|---|
| Weapon hit | weapon base damage x armor penalty (rating x 0.12 %, max 80 %) x2 power attack x1.3 sneak, then x2 (server-settings `multiplier`), then the weapon tier +35/+65/+100 % | `TES5DamageFormula.cpp`, `DamageMultFormula`, `gamemode.js masteryDamageMult` |
| **Block** | a blocked hit does **0 damage** (`kBlockedHitDamageMult = 0`) and costs **no stamina**. Holding block in the right direction is full immunity to melee | `TES5DamageFormula.h:6`, `ActionListener.cpp` ~2110 |
| **Shield bash** | the client sends `isBashAttack`, the damage formula ignores it: a bash does the weapon's full damage, staggers nothing | `HitMessage.h`, `TES5DamageFormula.cpp` |
| **Stagger** | none from the server. A hit lands on the attacker's copy of the victim, so a power attack never staggers another player | - |
| Stamina | power attacks 30 (live since 2026-09-23), jumps 10/15; light attacks and blocking free | `AnimationSystem.cpp` |
| **Spells** | the effect's raw magnitude, x1 (`magicMultiplier`), and **no Arcane tier bonus** (`masteryDamageMult` only knows weapons). Live log 24-25 Sep: Flames 8/s, Firebolt/Ice Spike/Lightning Bolt 25, Fireball/Chain Lightning 40, Icy Spear 60 | `gamemode.js`, `OnSpellHit` log lines |
| Weapon hits, live | engine damage per hit (before tiers): median 8, 90 % under 28, over 847 hits of players and NPCs | "mastery damage" log lines |

The gamemode sees a blocked hit only as a 0-damage hit: `onHitDamageAttempt` gets (target, source, damage) and none
of the blocked / power / bash / sneak flags.

## Built, on branch `pvp-damage` (server `2d3cff9a`, not deployed)

- PvP x1.25 on every player-on-player hit.
- Material ladder by the weapon's material keyword, for hits by players: Iron 0, Steel +3 %, Orcish/Silver +5 %,
  Dwarven +7 %, Elven +9 %, Nordic +11 %, Glass +13 %, Ebony/Stalhrim +17 %, Daedric +20 %, **Dragonbone +30 %**.
  Dragonbone now hits ~16 % harder than Daedric (was 7 %). 4041 of the 4372 weapons carry one of these keywords.

## Built after Nat's answers (2026-09-25)

Nat chose: block = chip + stamina; power attacks stagger; bash breaks guards; Defense resists the bash stagger; Arcane
tier boosts Destruction damage and should cut magicka costs.
- `614aa088` Arcane tier damage +20/+35/+50 % (Journeyman..Master) for Destruction spells.
- `combat.js` + `tests/combat-harness.js` (18/18): the triangle below, config `"combat"`. It reads the C++ hit flags
  (fork `71014c24`, other server session); chip and block stamina also need `targetMaxHealth` / `targetMaxStamina` in
  those flags (asked for). Player targets only. Log: `combat <attacker> -> <target>: ...`.
- Not built yet: the bash's own stamina cost (the attacker's maximum is not in the flags) and Arcane magicka costs. The
  engine on the player's client charges magicka, reduced by the vanilla Destruction skill the tier sets (15 per tier,
  `masterySystem.ts` AV_PER_TIER); a bigger cut needs the vanilla cost perks or a higher skill value, to be measured.

## Proposed: the combat triangle

Attack beats nothing on its own; **power attack beats an open guard, block beats attacks, bash beats block.**

1. **Block costs stamina and lets some through.** A blocked hit lets through 30 % with a weapon, 15 % with a shield,
   minus 5 % per Defense tier (Master Defense with a shield: 0 %). The blocker pays the prevented damage in stamina
   (shield x0.5). At 0 stamina the guard breaks: stagger, and blocking does nothing for 2 s.
2. **Power attacks stagger.** A power attack that lands unblocked staggers the target (`staggerStart` on the target's
   own client). Blocked by a shield, it does not stagger but costs the blocker double stamina. A Master weapon tier
   power attack staggers through a weapon block.
3. **Shield bash breaks guards.** A bash deals 25 % of the weapon's damage, costs 15 stamina, always staggers, and on a
   blocking target breaks the guard (as in 1). It interrupts a power attack or a spell being charged (the stagger does).
4. **Stagger resistance from skill.** Defense Expert and Master shrug off the stagger of a light hit from a bash
   (stagger still breaks a charged spell). Stagger has a 1.5 s cooldown per target, so nobody is stun-locked.
5. **Light attacks stay free**, as in vanilla. Stamina is the resource that decides a duel: power, bash, block.

## Proposed: magic

1. **Arcane tier scales Destruction damage** +20/+35/+50 % (Novice..Master), smaller than weapons because spells hit
   from range. PvP x1.25 applies. Firebolt at Master in PvP: 25 -> 47; Icy Spear 60 -> 112 (still two casts on a
   naked 150-health player).
2. **Magicka is the real limit.** With a 150 magicka pool and no Destruction perks, vanilla costs are roughly 40 for
   Firebolt, 130+ for Fireball and more than the pool for Icy Spear (to confirm from the records). The Arcane tier
   should cut costs the way vanilla's Destruction perks do; how the engine charges magicka here (client or server)
   has to be checked before choosing how.
3. A spell hit on a caster who is charging a spell does not stagger; a bash or power attack does (from 3 above).

## What each part needs

| Part | Layer | Reaches players by |
|---|---|---|
| Arcane tier damage | `gamemode.js` | hot reload |
| Block chip + stamina, guard break, bash, stagger | C++: pass blocked / power / bash / sneak and the pre-block damage to `onHitDamageAttempt` (`ActionListener.cpp`, being reworked by the other server session: coordinate) + `gamemode.js` rules | fork `main` push (server restart) + hot reload |
| Stagger itself | `Debug.SendAnimationEvent(target, "staggerStart")`, registered server-side (`PapyrusDebug.cpp`) and run on the target player's client; needs a check in game that it plays and is seen by others | hot reload |
| Magicka costs | to find out first | - |

Everything is measured before and after in the log: a `combat` line per hit with power / bash / blocked / stagger /
stamina paid.
