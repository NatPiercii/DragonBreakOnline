# DragonBreak Online: race design

**Status:** 2026-09-20. Agreed with Nat the night the point system first went live. **Section 2 (the stat
spread) is built and live** - written into the plugin, synced to the server, verified. Section 3 (the
resistances) still needs one function in `gamemode.js`; section 5's rejections stand.

**Sources:** Imperious - Races of Skyrim (nexusmods.com/skyrim/mods/61218) for the stat spread, ESO's racial
passives for design discipline, vanilla Skyrim for the resistance values. Section 5 says where we
deliberately disagree with Imperious.

## 1. The architectural split, measured before designing

A racial bonus is only real if the layer that decides the outcome can see it. Two checks settle what is
buildable here, and they land on opposite sides:

- **Base stats are already server-authoritative.** `GetBaseActorValues.cpp:48` computes
  `raceData.startingHealth + attributesNpcData.healthOffset`, and the same for Magicka and Stamina, reading
  the RACE record straight out of the load order. The server's own boot log proves it is live
  (`GetBaseActorValues ... startingMagicka=0, magickaOffset=-25, defaulting to 100`). **Per-race stats are
  therefore pure plugin work** - edit the RACE records and the server honours them. No C++, no client, no
  gamemode.
- **Resistances are cosmetic today.** `TES5DamageFormula.cpp` reads the weapon's base damage, the target's
  worn armour, the race's unarmed damage and the client's power/sneak/block flags. It contains no reference
  to resistance of any kind. A 50% fire resist ability on a RACE record changes the client's HUD number and
  nothing the server computes.

That second one is fixable **without C++**: `gamemode.js:1895` already has `masteryDamageMult` running inside
the `onHitDamageAttempt` hook, scaling damage by mastery tier. A racial resistance multiplier belongs in that
same function - the server knows the target's race from `appearance.raceId`, and `OnSpellHit` carries the
spell id, which is enough to derive an element. Hot-reload work, no rebuild.

## 2. Tier 1 - stats on the RACE records - **DONE 2026-09-20 02:48**

Written as ten overrides in `DragonBreak Online Edits.esp` by `SSEEdit 4.1.5f\Edit Scripts\DBO_RaceStats.pas`,
then synced into `server\data\` and the server restarted. Verified by re-running the read-only report:
every race now wins from DLE with the intended totals.

**Two facts the pass turned up, both measured:**

- **Vanilla RACE DATA is `50/50/50`, carry 300, regen 0.7/3.0/5.0 - identical across all ten races.** The
  player's familiar 100 comes from the RACE value plus the **Player NPC_ offset, which is +50** for health,
  magicka and stamina (`DBO_PlayerOffsets.pas`). So the script writes **target minus 50**; carry weight and
  the regen rates are absolute. Vanilla differentiates races only through abilities, never through DATA,
  which is why this spread is entirely new information.
- **`Unarmed Damage` was already 10 for Khajiit and Argonian against 4 for everyone else**, and
  `TES5DamageFormulaImpl::CalcUnarmedDamage` returns exactly this field. Khajiit claws were server-
  authoritative before any of this. **Khajiit raised to 14 on 2026-09-20 11:36**, Argonian left at 10:
  the two were identical, and since Night Eye is client-side cosmetic that left Khajiit with **no
  server-enforceable trait of their own at all** while Argonian also carried a 50% disease resist.
  Rawlith Khaj is the iconic set of claws, so the split goes their way. The field sits outside the
  300 stat budget, so it costs Khajiit nothing elsewhere.

  **Deliberately not given a resistance.** Khajiit have none in Skyrim, Oblivion or Morrowind; their
  identity across the series is agility and stealth, not resilience. Inventing one would be the same
  mistake as Imperious halving fire resist - balancing the sheet at the cost of the lore.

  **If their second trait ever goes on the agility axis** (Imperious's "Feline Agility", 15% faster),
  note that it will fight the movement rate validation: that C++ work uses a flat
  `maxHorizontalSpeed: 1000` for everyone, so a race that legitimately moves faster trips a flat
  ceiling and gets snapped back. The ceiling needs to be per-race or carry a margin, and it is far
  cheaper to say so while the binary is still unbuilt than to debug "Khajiit keep rubber-banding".

A third, incidental: the Player NPC_ record's `RACE` is **NordRace**, which proves rather than infers where
`PowerNordBattleCry` on a non-Nord character comes from.

**Also note:** the second and later runs of the script re-process each record (the new DLE override becomes
the winning override mid-run), so the log reads "20 of 10". The writes are idempotent, so the values are
correct; it is not a sign of double application.

### The spread as written

Imperious's spread, with three races retuned by Nat on 2026-09-20 (bold below, re-run at 11:15 and verified).
It is roughly 15-20 either side of vanilla's flat 100, which is meaningful next to `vanillaLevel`'s +10 per
level to a cap of 5 (section 4) without swamping it.

**Every race sums to exactly 300**, which Imperious held to and Nat's three edits preserve. Treat that as the
invariant when retuning: move points between a race's own three stats, never add to the total. What the
edits changed in the pecking order - **Redguard takes the stamina crown at 120** (Orc had it at 115),
**Orc ties Nord for the most health at 110** and gives up the stamina lead, and **Altmer goes further out on
its own axis**, 120 magicka against 90/90 physical, the most lopsided sheet in the game.

| Race | Health | Magicka | Stamina | H regen | M regen | S regen | Carry |
|---|---|---|---|---|---|---|---|
| Altmer | 90 | **120** | **90** | 0.5% | 3.75% | 4.5% | 250 |
| Argonian | 100 | 95 | 105 | 0.5% | 3.0% | 5.0% | 325 |
| Bosmer | 95 | 100 | 105 | 1.0% | 3.0% | 5.0% | 275 |
| Breton | 95 | 105 | 100 | 0.75% | 3.125% | 4.75% | 300 |
| Dunmer | 95 | 110 | 95 | 0.75% | 3.125% | 4.75% | 275 |
| Imperial | 100 | 100 | 100 | 1.0% | 3.0% | 5.0% | 300 |
| Khajiit | 90 | 105 | 105 | 0.5% | 3.125% | 5.25% | 300 |
| Nord | 110 | 85 | 105 | 0.75% | 2.875% | 5.25% | 325 |
| Orc | **110** | 80 | **110** | 1.0% | 2.75% | 5.5% | 350 |
| Redguard | 100 | **80** | **120** | 0.75% | 2.875% | 5.25% | 325 |

Base stats are read per actor at spawn, so a live character picks up a changed race record on its next
login - no wipe, no migration.

## 3. Tier 2 - resistances in the damage hook (hot-reload)

**Vanilla's values, not Imperious's** (section 5). Applied as a multiplier on inbound damage in the same hook
as `masteryDamageMult`, keyed on the target's `appearance.raceId`.

| Race | Server-enforceable identity |
|---|---|
| Altmer | Magicka pool (section 2) carries it; no resist in vanilla |
| Argonian | 50% disease resist; waterbreathing (client-side, harmless) |
| Bosmer | 50% poison resist, 50% disease resist |
| Breton | **25% magic resist** - all elements and spell damage |
| Dunmer | **50% fire resist** |
| Imperial | Gold found on bodies and in containers raised; hook `loot.js`, not the damage path |
| Khajiit | Unarmed claw damage at **14** against Argonian's 10 and everyone else's 4 - **already honoured**, `TES5DamageFormula` reads the race's unarmed damage. No resistance, deliberately (section 2). |
| Nord | **50% frost resist** |
| Orc | **15% magic resist** (restored, see below) plus weapon damage up / enchantment strength down (Imperious's "Strength of Steel", lore-true for orcish smithing) |
| Redguard | 50% poison resist |

**Orc magic resistance is restored deliberately.** Orsimer carried Resist Magic in Oblivion and Skyrim
dropped it, leaving Orcs with a single scripted power and nothing passive - which is exactly the kind of
identity this design is trying to give back. It is set to **15%, not Oblivion's 25%**, so that Breton stays
the magic-resistant race by a clear margin; in Oblivion both had it and Breton's was the larger of the two,
which is the relationship worth preserving rather than the exact numbers. Worth confirming the Oblivion
values against a source before the pass, since they are quoted from memory here.

Three of these need no new mechanism at all: Khajiit claws are already server-side, Altmer's identity is the
stat table, and Imperial gold belongs to the loot layer.

**Element derivation:** weapon hits are physical. Spell hits arrive through `OnSpellHit` with a spell id; the
element comes from the spell's first MGEF, which is the same lookup `masterySystem` already does to classify
a cast by school (`spellCastSchools`). Reuse it rather than building a second table.

## 4. How this sits with the skill system

- **No double-dipping with mastery.** `MASTERY_DMG.byTier` scales *outgoing* damage by the attacker's tier.
  Racial resistance scales *inbound* damage by the defender's race. They multiply in the same hook but never
  read the same input.
- **Race is not a skill and must not spend pool.** The 300-point pool is the skill budget; a racial bonus is
  free and fixed at creation. A player who wants to be a smith is not taxed for being an Orc.
- **`vanillaLevel` (cap 5, +10 to one of Health/Magicka/Stamina per level) stacks on top** of the race base.
  A Nord at level 5 who put everything into Health reads 160; an Altmer the same way reads 140. That is the
  intended spread - noticeable, not decisive. Note `vanillaLevel` itself is a C++ item (`SKILLS_DESIGN`
  section 14.5), so it ships in the same native build as the movement validation.

## 5. Where we disagree with Imperious

**Imperious halves vanilla's resistances** - Dunmer 25% fire instead of 50%, Nord 25% frost instead of 50%,
Breton 15% magic instead of 25% - because it hands out three scripted actives and a quest reward per race to
pay for it. **We are not taking the actives, so we do not pay that price.** Copying the lowered numbers would
leave racial identity *weaker than vanilla* while giving nothing back. Use vanilla's values.

**We reject the scripted actives outright**, and not only on taste:

- Papyrus here only reaches player actors; `SpSnippet` is dropped for server-spawned NPCs, so anything an
  active does to an enemy is unreliable by construction.
- Per-day cooldowns and quest counters (pluck 40 butterfly wings, stagger 150 enemies) are client-local
  state on a server whose whole authority model is that the client is not trusted.
- Imperious's own FAQ warns the scripts are load-order sensitive and want a new character. We are a server.

**Also rejected:** the race quests, and the Orc Shockwave stomp - Nat's call, and both are the
scripted-active class anyway.

**Taken from ESO instead:** the discipline. ESO racial passives are flat, numeric and scriptless - a Nord
gets health and cold resistance, a Breton magicka and spell resistance. That style survives translation to an
authoritative server. Imperious's does not.

## 6. Build order

1. **RACE record stats** (plugin, xEdit). The whole of section 2, one pass. Biggest identity win for zero
   code. Check first whether `DragonBreak Online Edits.esp` already overrides any RACE record, or the pass
   will fight the conflict layer.
2. **The resistance table** in `gamemode.js`, inside the `onHitDamageAttempt` path beside `masteryDamageMult`.
   Start with the four pure-lore ones: Dunmer fire, Nord frost, Breton magic, Redguard and Bosmer poison.
3. **Imperial gold** in `loot.js`, and the **Orc weapon/enchant trade** in the same damage hook.
4. Nothing per-day. Nothing quest-gated.

**Open question for Nat:** the Orc weapon/enchantment trade (more weapon damage, weaker enchantments) is the
one Imperious idea worth keeping that is not a resistance. It needs a number. Imperious uses 20% both ways;
10% is likelier to be right next to `MASTERY_DMG`'s 0-30% tier bonus, but that should be decided against a
measured fight, not picked here.
