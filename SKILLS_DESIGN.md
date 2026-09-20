# DragonBreak Online skills: the point system

**Status:** replaces the 2026-09-14 design review in this file. That review was written against the owner's first spec (three chosen skills, five tiers, hours-to-tier). The tier ladder, the mini-games, the stations, the marker spells, the study points, the prayer design, the harvesting/no-pickup rule and the ownership/tag/respec notes all survive and are carried forward below. What is superseded: `maxChosen: 3`, `tierHours`, `swapCooldownDays`, "dropping a skill wipes its progress", and the `vanillaLevel` formula. Sections marked **(superseded)** say so where they appear.

Written 2026-09-19 from a read-only pass over the live code. Every number below was measured today against the live files, or is a proposal flagged as such. Line numbers are current as of this pass and will drift.

---

## 1. The system in ten lines

1. Every skill has a **level, 0–100**. Level 0 means you have never done it; level 1 means you have.
2. The five existing tiers become **bands of level**: Novice 1–24, Apprentice 25–49, Journeyman 50–74, Expert 75–89, Master 90–100.
3. A character has a **pool of 300 levels** shared across all seventeen skills, a **per-skill cap of 100**, and two structural caps: **at most one skill ≥ 91** (the Seat) and **at most three ≥ 76**.
4. Levels come from **server-verified events**, weighted by what the act was worth, rate-limited by a **token bucket** (20 burst, 30 units/hour) and a **daily cap** that tightens at the top.
5. Hours to level, saturated in one skill: **25 → 8.3 h, 50 → 25 h, 75 → 58 h, 90 → 98 h, 95 → 132 h, 100 → 198 h**, with a hard floor of **~51 real days from 90 to 100** that no macro can buy under.
6. When the pool is full a gain **takes from a skill you marked to fall** (UO's ▲ raise / ■ hold / ▼ lower). Nothing falls that you did not mark, and nothing falls below level 25.
7. **No decay while you are offline.** Ever. Played-day atrophy is specified, defaulted off, and I recommend leaving it off.
8. The record keeps writing `order` and `rank` as **derived fields**, so every gate in `gamemode.js`, `labour.js` and `dungeons.js` keeps working with zero edits, and live characters migrate lazily into the exact tier they already hold.
9. **Ebony needs Miner 95; ebony and daedric recipes need Blacksmith 95/100.** The Seat rule makes those different people, so a daedric cuirass structurally requires three Masters who have to talk to each other.
10. Ebony and daedric are **crafted-only**, enforced in eight places in the loot path plus the `HasSpell` conditions on the recipes — which **do not exist yet** (`CHECKLIST.md:853`) and are the one genuinely blocking item.

---

## 2. Principles

- **Authority is the server, execution is the client, replication is the server** (`SERVER_AUTHORITY.md`). A point exists only when the server saw the whole causal chain with its own data: espm lookups, cell-and-distance checks, inventory reads. A modified client cannot enqueue an event; `globalThis.__alduinakMasteryEvent` is server-side.
- **Never guess an engine fact.** Every claim in this document that could be checked was checked today. Where something is unverified it says so and is listed in §11 rather than built on.
- **Measure before theorising.** `labour.js:249` already logs a per-verdict `err=`; the same instinct — *a player who is always at 0.00 is not a player* — is the model for the credit log in §6. Phase 0 of the build plan is shipping that log against the **current** system and reading a week of it, because every events-per-hour number here is an estimate.
- **Nothing periodic.** No sweep over players × 17, no broadcast per event (`SCALING_NOTES.md`). Atrophy, if ever enabled, is computed lazily on read. The only per-tick work is draining the event queue.
- **Scarcity, not permission.** Losing "three chosen skills" loses exclusivity. It is replaced by a market: anybody may forge an iron dagger, and at any moment there may be one or two people alive who can forge ebony.
- **Breadth is free, competence is cheap, mastery is the whole budget.** That is the honest translation of the owner's two requirements, and the arithmetic is in §3.
- **Players create the content.** Where a design choice can put a resource behind a place people have to reach, guard and fight over instead of behind a drop rate, it does.

---

## 3. The point model

### 3.1 Pool, caps, and the Seat

```
per-skill cap    100
pool             300 levels, shared across all 17 skills
Seat             at most one skill >= 91
Expert slots     at most three skills >= 76
floor            nothing falls below 25 by transfer
```

Holding a skill at all costs 1 level, so **all seventeen skills at Novice costs 17 of 300** and "people can do everything" is literally true at the dabbling level. Mastery is the whole budget: 100 + 78 + 76 + a scatter of Novices is a full sheet.

**The Seat is the most important rule in the document**, and it is the one grafted in from the economy-first design. Without it a 300 pool lets one character hold Blacksmith 100 and Miner 95 and close half the daedric loop alone, and the market never forms. With it, and with the material gates in §7 placed on opposite sides of the line, a daedric cuirass requires a Master Smith, a Master Miner and a Master Conjurer who are three different people by construction.

**On the owner's 100-point figure.** 100 as a *total* cannot coexist with "people can do everything": if Smithing must sit at 95 for daedric, that character has 5 points for sixteen other skills — he is not a generalist, he is a smith who cannot walk. 100 survives, and survives as the number the owner already thinks in ("hitting level 95 or 100"), as the **per-skill** cap. 300 is the pool. This is stated once here and not relitigated elsewhere in the document.

### 3.2 The gain curve

One validated event carries a **weight** `w ∈ [0.5, 3.0]`. It spends `w` from the token bucket and grants `w × xpPerUnit(level)` experience. **100 xp = 1 level.**

| level band | xp per unit | units per level | cumulative units |
|---|---|---|---|
| 0–24 | 10 | 10 | 250 at L25 |
| 25–49 | 5 | 20 | 750 at L50 |
| 50–74 | 2.5 | 40 | 1,750 at L75 |
| 75–89 | 1.25 | 80 | 2,950 at L90 |
| 90–94 | 0.5 | 200 | 3,950 at L95 |
| 95–99 | 0.25 | 400 | 5,950 at L100 |

**Token bucket, per (character, skill):** capacity **20**, refill **30 units/hour**, divided by `private.needs.xpMult` (written at `gamemode.js:982`, read the same way `masterySystem.ts:365-371` reads it today) — so starving still quarters the rate and the hunger lever keeps its meaning.

The bucket is the whole anti-macro budget at the hourly scale: **xp per hour is capped by the refill rate, independent of weight.** Weight decides *which* work fills your hour, not how much progress exists in an hour. Ten meaningful crafts and thirty trivial ones reach the same ceiling; the ten are simply faster to perform.

### 3.3 Hours, and the calendar floor at the top

| target | units | hours saturated | old `tierHours` |
|---|---|---|---|
| L25 Apprentice | 250 | **8.3** | 10 |
| L50 Journeyman | 750 | **25** | 30 |
| L75 Expert | 1,750 | **58** | 70 |
| L90 Master | 2,950 | **98** | 150 |
| L95 (ebony) | 3,950 | **132** | — |
| L100 (daedric) | 5,950 | **198** | — |

The ladder to Expert reproduces the current one within 20%, which is what matters to live players. Master's door opens sooner and Master now has a hundred hours of interior.

**Daily cap, per skill** — this is the calendar floor, and it is the graft from the UO-faithful design's best idea:

| band | daily unit cap | consequence |
|---|---|---|
| below 75 | 360 (12 h saturated) | never binds on a human |
| 75–89 | 180 | Expert→Master takes ≥ 7 days |
| 90–100 | **60** | 90→95 ≥ 17 days; 95→100 ≥ 34 days |

Character-wide daily cap 1,080 units. A six-hour session across three skills spends at most ~540, so the caps only ever touch a macro or a grinder.

The property that matters: **above 90 the daily cap binds while honest play supplies several times the units needed.** A bot running 24/7 gains nothing over a player with two focused hours a day, with no detection logic at all, and **Grandmaster is arithmetically impossible in fewer than about 51 days from Master.** That is the "super hard" the owner asked for, expressed as a number nobody can buy under rather than as a hope.

### 3.4 Weights

| kind | weight | source |
|---|---|---|
| craft | `0.5 + min(2.5, productValue/400)` | COBJ product value, already in `loot.json` |
| hit / kill | `0.5 + min(1.5, targetMaxHealth/200)` | rabbit 0.5, bandit ~1.2, giant 2.0 |
| mining round | 1.0 at band 1 → 2.0 at ebony | `MINER.oreByTier` index |
| chopping round | 1.0 | |
| reading | 1.0, ×1.5 first time this character reads that BOOK | `private.scholarReads` is already per-ref |
| activate (node, purse) | 0.5 | |
| cast | `0.5 + min(1.0, magickaCost/150)` | SPIT cost |
| hurt / block | `0.5 + min(1.5, damageTaken/40)` | from the `onHitDamageAttempt` path |

**Repetition decay.** Per `(skill, novelty key)` — target base form, station ref, recipe id, vein ref, book id — the *k*-th event in a rolling hour is worth `w / (1 + k/8)`. The novelty state is a **16-entry ring of `(hash, at)` persisted inside `private.mastery`**, not an in-memory map: a map that a relog clears is a two-key macro.

### 3.5 How points leave a skill

**a) Transfer (automatic).** A gain that would push the total past 300 takes the overflow, xp for xp, from a donor: skills marked ▼ first, highest level first; then the lowest-level ▲ skill above 25; never from ■; never below 25. If nothing can give, the gain is **refused with a notice**, rate-limited to once per ten minutes — never silently lost. When the pool first fills with nothing marked ▼, the server marks the least-recently-used skill above 25 once, says so, and lets the player change it.

Cost: O(1) per event plus one bounded walk of at most 17 entries. No broadcast.

**b) Deliberate lowering at a standing stone (manual).** Reuses the existing 120-second DoomStone respec window (`masterySystem.ts:287-292`) and gold take (`:574-586`). In respec mode the K menu lets any skill be dragged down to any value, freeing pool. First lowering free, 1,200 gold after — the existing `respec.firstRespecFree` / `goldCostAfterFirst` constants, unchanged. This **replaces** `dropSkill`'s wipe-everything behaviour, which no longer means anything once nothing is "chosen".

**c) Atrophy — specified, default OFF, and I recommend leaving it off.**

The owner asked for "if you stop using a skill points fade off of it". The honest translation is (a): the skill you neglect is the one that bleeds when you take up another, because *you chose to do something else*. Wall-clock decay taxes exactly the player this server is built for — the one who disappears for ten days to write a character arc — and it will be the most-complained-about mechanic on the server inside a month.

If it is wanted anyway, the only safe form is **played-day** atrophy, never calendar:

```
atrophy: { enabled: false, floor: 76, idlePlayedDays: 14, levelsPerPlayedDay: 1 }
```

A played day is one where the character was online 30+ minutes. Only above level 76 (i.e. it can cost an Expert their Master grade but never a tier a player earned as a rank), floor 76, computed **lazily inside `read()`** from `lastPointAt` and a `playedDays` counter — O(17) on login, zero per tick, no timer, no sweep.

### 3.6 Locks

Per-skill `lock: "up" | "hold" | "down"` in the record.

| state | gains | donor for overflow |
|---|---|---|
| ▲ **up** (default) | yes | only if nothing is marked ▼, and only above 25 |
| ■ **hold** | discarded | never |
| ▼ **down** | discarded | first, highest level first |

A skill at 100 behaves as ■ automatically. This is what keeps the tailor who defends herself on the road from losing her trade: she sets Tailor ■ and One-Handed ▲, and her forty levels of weaving are untouchable. Lock changes are re-validated server-side (unknown id, rate limit) — a modified client may not set a state the server would refuse.

---

## 4. The seventeen skills and their server-verified events

Sixteen skills plus Harvesting, seventeen in total: five combat, six profession, six support (`skills.json`). "Exists" means the event is credited today.

| skill | cat | server-verified event | where validated | status |
|---|---|---|---|---|
| **twohanded** | combat | `hit` — live actor in reach (400 melee), weapon class from WEAP `DNAM[0]` | `masterySystem.ts:393-405`, `:873-898` | **exists** |
| **onehanded** | combat | same | same | **exists** |
| **archery** | combat | `hit`, reach 8192 for Bow/Crossbow | same | **exists** |
| **defense** | combat | `hurt` — damage taken while wearing an `ARMO` | `:406`, `:764-770` | **half.** `blockEvents: true` is parsed (`:688`, copied into ResolvedRules at `:724`) and **read nowhere**; there is no `block` kind, so blocking never counts |
| **arcane** | combat | `cast`, school from the spell's first MGEF | `:407-411`, `:746-762` | **exists**, but a zero-cost spell at a wall is free progress — see §6 |
| **blacksmith** | prof | `craft` — real COBJ, `holdsInputs` against the live inventory, bench within 600 units | `:375-381`, `:808-831` | **exists** |
| **alchemist** | prof | `eat` INGR + FLOR/TREE activate | `:392`, `:382-391` | **PARTIAL — brewing never counts.** No `craftKeywords` entry at all; `activatePrefixes: ["CraftingAlchemyWorkbench"]` is a keyword name used as an editor-id prefix and matches no FURN |
| **woodcutter** | prof | `activate` by editor-id prefix, fired by hand after a server-judged round | `labour.js:308` | **exists** |
| **miner** | prof | same | `labour.js:308` | **exists**, plus a free-credit hole — see §6 |
| **tailor** | prof | `craft` at `MCE_CraftingLoom` / `TailorBench` | `:375-381` | **UNVERIFIED.** `TailorBench` exists nowhere in the load order; `MCE_CraftingLoom` exists in `MoreCraftableEquipment.esp`. Whether any MCE loom COBJ carries that BNAM has not been checked |
| **lockpicking** | prof | `lock` | fired **only** from `dungeons.js:650` | **partial** — picking a housing door sends nothing |
| **skinner** | sup | `kill` on `ActorTypeAnimal` + tanning-rack `craft` | `:393-405` | **exists**, but the skinning minigame itself (`gamemode.js:1623-1700`) fires **no** mastery event |
| **scholar** | sup | `activate` BOOK, fired on a won reading | `gamemode.js:1395` | **exists** |
| **enchanter** | sup | — | — | **NONE.** `counts` is `{craftStations:["isEnchanting"]}` only, and enchanting is not a COBJ craft (`onCraft` fires from `CraftService.cpp`), so **zero events ever** |
| **priest** | sup | `cast` works; `prayer` matcher at `:412` | `:407-411` | **half.** No prayer producer exists anywhere — a grep for `prayer|shrine|deity` across `server\*.js` returns nothing. The whole `praying`/`deities` block in `skills.json` is read by nothing |
| **cook** | sup | `craft` at `CraftingCookpot` / `BYOHCraftingOven` | `:375-381` | **exists** |
| **harvesting** | sup | `activate` FLOR/TREE through the gate itself, plus coin purses | `:313-338`, `gamemode.js:1467` | **exists** |

**This is the blocking list, and a pool makes it worse than it sounds.** Under today's model a skill with no source merely never rises. Under a shared pool it can be **drained** by other skills' gains with no way to recover — free pool room for anybody who notices. Enchanter, Alchemist-brewing, Priest-prayer and Tailor must either get producers before the pool ships, or be exempted from donation until they do.

**Correcting the brief:** combat skills do *not* lack per-skill sources. `onHitDamage` classifies the weapon from WEAP `DNAM[0]` and credits One-Handed, Two-Handed and Archery separately today. Defense is the genuinely half-built one.

**Name resolution is quietly lossy.** `resolveEditorIds` scans only `["KYWD","SPEL"]`; unresolved `craftKeywords`/`craftStations` are silently dropped by `toIds`, and the log line filters marker and station names out of its own "unresolved:" list — so `server.log` prints `resolved 108/124 ... unresolved: none` while sixteen names failed. **Print the real list before adding a single new keyword.**

---

## 5. Tiers, gates and the compatibility shim

### 5.1 Bands

| tier | name | level | meaning |
|---|---|---|---|
| 0 | Novice | 1–24 | you may use the station at all |
| 1 | Apprentice | 25–49 | the transfer floor |
| 2 | Journeyman | 50–74 | |
| 3 | Expert | 75–89 | capped at 3 skills |
| 4 | Master | 90–100 | capped at 1 skill (the Seat) |

`rankFor` (`masterySystem.ts:609`) becomes a band lookup on level instead of a threshold walk on hours. `tierNames`, `AV_PER_TIER`, `missingSpells`, `revokeAbove`, `syncRank`, the 85 `DBO_Skill_<id>_T<n>` markers and the K-menu ladder are all untouched.

### 5.2 The shim: keep writing `order` and `rank`

This is the single decision that makes the whole thing shippable in a week. Five call sites in the gameplay layer read the raw property with the identical idiom `order.includes(id) ? rank : -1`:

- `gamemode.js:1374` `masteryOf`, `:1375` `scholarTier`
- `gamemode.js:1471` `harvestingTier`
- `gamemode.js:1610` `skinnerTier`
- `labour.js:82-87` `tierOf`
- `dungeons.js:563` `lockpickingTier`

So the new record **keeps writing both fields, derived**:

- `order` = every skill with `level ≥ 1`, sorted by level descending
- `rank` = the band of that skill's level

**Not one line of `gamemode.js`, `labour.js` or `dungeons.js` has to change for the gates to keep working.** `creditActivity`'s `if (!rec.order.length) return` and `gateActivation`'s membership test keep working too — "chosen" simply becomes "has ever done". The shim also silently preserves two things worth naming: `rollHarvest`'s tier chance and multiplier, and `masteryDamageMult` at `gamemode.js:1895`.

### 5.3 First touch grants level 1

`gateActivation` (`masterySystem.ts:277-310`) refuses a station unless the skill is held, and the only craft/activate source for that skill is working at that station. With `maxChosen` gone, an untouched skill would become **unreachable** rather than merely unpicked — a deadlock that any pool design walks into.

Fix: activating a gated station at level 0 costs 1 from the pool, says *"You set your hand to the forge for the first time,"* and lets the activation through. If the pool is full: *"Your hands are full — set a skill to fall (K) before taking up a new trade."*

### 5.4 Capstones, not new tiers

Ebony at 95 and daedric at 100 need marks, but adding a 6th and 7th tier would mean 34 new SPEL records and a change to every rank-indexed array. Instead, `skills.json` gains a per-skill `capstones` list resolved in the same `resolveEditorIds` call:

```json
"capstones": [
  { "level": 95,  "spell": "DBO_Skill_blacksmith_T6", "label": "Ebony" },
  { "level": 100, "spell": "DBO_Skill_blacksmith_T7", "label": "Daedric" }
]
```

Two new SPELs (four if the Enchanter gets the same treatment), granted and revoked by the existing `applySpells` / `removeSpell` path keyed on level instead of rank — about 25 lines. Five tiers stay five tiers.

### 5.5 Use floors

The pool replaces exclusivity with scarcity, but the *felt* rule ("only a Blacksmith may use the forge") should survive. Set a floor per gate class:

| gate class | floor | reached in |
|---|---|---|
| gathering nodes (ore, trees, plants, purses, books) | 1 (first touch) | immediately |
| profession benches (forge, loom, lab, oven, enchanter, tanning rack) | 1 to touch, **25 to make anything above iron/hide tier** | ~8 h |
| dungeon chest locks (`dungeons.js:563`) | unchanged: `tier < level` refuses | |

Chest success stays `min(0.95, 0.55 + 0.15·(tier − level))` — it reads a rank, and the rank still exists.

### 5.6 Actor values, and the combat half

`applyActorValues` becomes a direct `Math.min(100, level)` write instead of `AV_PER_TIER * (rank+1)` (`masterySystem.ts:650`).

Per `SERVER_AUTHORITY.md`, Smithing, Alchemy, Enchanting, Lockpicking, Sneak and Speechcraft **genuinely work**, because the engine computes those on the owner's own client. Do not "fix" them by moving them server-side; that deletes working features.

**Correcting all three design passes and the brief:** the combat half is *not* inert today. `gamemode.js:1875` defines `MASTERY_DMG = { enabled: true, byTier: [0, 0, 0.10, 0.20, 0.30] }`, and `masteryDamageMult` / `masteryBonusDamage` run inside the `onHitDamageAttempt` path (`:1743`, `:1895-1954`). A Master swings 30% harder, server-side, in the hot-reload layer, right now. Nobody should be told their combat skills are cosmetic. **What this design does require is retuning that table**, because `byTier` is indexed by rank and the bands have moved — see §11.

---

## 6. Anti-macro and authority

### 6.1 The four layers

1. **Validation.** Unchanged and already good: same cell, distance in reach, live target, real COBJ, inputs actually held, bench actually present. A pool system does not change the validators, it changes what they are *worth*.
2. **Novelty.** Same key within 1 h pays 25%, within 6 h pays 50%. This is what kills the AFK dummy, the one-bandit farm and the one-book loop. Persisted in the record.
3. **Token bucket.** 30 units/hour per skill, 20 burst, divided by `needs.xpMult`. Legible in the menu: *"This hour: 18 of 30 counted in Blacksmith."*
4. **Daily cap.** 360 / 180 / 60 units by band, 1,080 character-wide. This is the calendar floor at the top and the only thing a determined macro actually meets.

Plus zero-credit cases: dead targets, the attacker's own companion (`private.dboCompanion` owner match), party members, and any target that has dealt no damage to anyone in 60 s pays 25%.

### 6.2 Per-skill hardening

- **arcane** — require SPIT cost > 0 **and** that the caster's `percentages.magicka` fell since the last credit. `percentages` is server-readable per `SERVER_AUTHORITY.md`. Today a zero-cost spell spammed at a wall is free.
- **defense** — do **not** add a client-reported `block` event. A block is only visible to the client. Credit Defense from the damage *reduction* the server computes in the `onHitDamageAttempt` path. Then either implement `blockEvents` or delete the key; it is dead today.
- **scholar / harvesting / mining** — per-ref novelty, which the ring gives for free.
- **labour** — flag any player whose last 20 rounds all show `err < 0.05` to the admin log. `labour.js:249` already computes the field.

### 6.3 The 169 free-credit activators — fix this before anything else ships

Cyrodiil holds **169 `PickaxeMining*Marker` FURN records** (83 Table, 43 Wall, 43 Floor), measured from `ck-mcp/out/bruma_essentials.json`. `labour.js`'s `__dboLabour` dispatches only on `type === 'ACTI'` matching `/^(CYR)?MineOre|^DLC2MineOre/`, so these fall straight through to `masterySystem`, whose miner `counts.activatePrefixes` includes `"PickaxeMining"` — and a **bare activation with no minigame and no yield credits the Miner skill.**

At one point per hour this is invisible. Under per-event gain it is a 169-node farm on launch day. Either handle them in `__dboLabour` or drop `"PickaxeMining"` from `activatePrefixes`.

### 6.4 Event loss and write cost

- `enqueue` drops the **oldest** event past `MAX_QUEUED_EVENTS = 4096` (`:251`). **Fold instead of dropping:** collapse identical `(kind, actorId, novelty key)` within a tick into one entry with a count. At 100 players in combat the duplicates are the volume, so folding fixes the cause rather than the symptom. Raise the cap to 16,384 as a backstop, drop the **newest** on overflow, and log a per-minute drop counter.
- **The cost nobody priced:** `write()` (`masterySystem.ts:926`) serialises the whole record with a single `mp.set`. Today that happens at most once per hour per skill. Under per-event gain it becomes a change-form write per credited event per player. **Add a dirty flag with a flush on tick and on logout** before this goes near a populated server, and stop `updateAsync` draining the entire queue unbounded in one pass.

### 6.5 A correction: `neighborsFailed` is not a latch

All three design passes reported that `masterySystem.ts:822` disables craft credit server-wide after the first `getNeighborsByPosition` throw. **It does not.** The `return false` is inside the `catch` and affects only the call that threw; `benchInReach` retries on every call. The flag suppresses repeat logging and nothing else. There is no silent crafting outage to fix. The real defect is the inverse — every failure after the first is silent — so the fix is a rate-limited log, not a per-call backoff. Do not let someone "fix" a bug that is not there.

### 6.6 Condition functions: the gate can fail open

Verified in the fork: `CraftService::OnCraftItem` finds a real COBJ and `ConsiderRecipeCandidate` runs `EvaluateCraftRecipeConditions` on the record's CTDAs, **server-side**. `HasSpell` is implemented and reads `MpActor::GetSpellList()` — i.e. `changeForm.learnedSpells`, the server's own copy, which is exactly what `masterySystem` writes through `Actor.AddSpell`. A failed condition means `FindRecipe` returns empty and no item is added: **it fails closed.**

**But an unknown condition function logs a warning and evaluates to `True`** (`ConditionsEvaluator.cpp:268-273`). That is why `HasPerk` is useless here, and it means any recipe gated on a function the fork does not implement is not a weak gate — it is an open door that looks like a gate. The implemented set is:

```
GetActorValuePercent, GetEquipped, GetEquippedItemType, GetIsPlayableRace,
GetIsRace, GetItemCount, HasSpell, IsBlocking, IsInInterior, IsWeaponMagicOut,
IsWeaponOut, SpellHasKeyword, WornHasKeyword, WornApparelHasKeywordCount,
SkympWornHasKeywordCount, SkympGetIsDamageSource, SkympGetDamageSourceHasKeyword
```

**Gate with `HasSpell` only, and audit every CTDA on every DBO COBJ against that list before trusting any of them.**

---

## 7. Ebony, daedric and the material economy

### 7.1 Measured today, and the brief's numbers do not reproduce

`server/loot.json` has been regenerated since the brief was written. Gear pools, and matches on `/Ebony|Daedric/`:

| pool | entries | match |
|---|---|---|
| weapons | 239 | 32 |
| armor | 487 | 18 |
| ench_weapons | 3,297 | 608 |
| ench_armor | 3,040 | 207 |
| **total** | **7,063** | **865** |

By the `DIFFICULTIES` value bands (`dungeons.js:32-36`):

| cap | entries admitted | of which ebony/daedric |
|---|---|---|
| 150 Novice | 3,222 | **0** |
| 400 Adept | 4,710 | **80** |
| 900 Expert | 5,989 | **286** |
| 3,000 Master | 6,990 | **796** |
| 9,000 (`diff.gear*3`, the enchanted roll at `:264`) | 7,063 | **865 — all of them** |

The brief's 1,608 / 929 / 1,539 do not reproduce under either a narrow or a wide regex. Quote the table above.

### 7.2 Eight enforcement points, not four

The brief named four. There are eight, and **the two worst were not on the list**, because they pass `maxValue = 0` and no difficulty band ever sees them.

| # | where | what leaks |
|---|---|---|
| 1 | `pool()` — `dungeons.js:229` | the shared filter every roll goes through. **This is the one-line fix**: reject craft-only entries here and all callers inherit it |
| 2 | chest gear roll — `:262` | 796 ebony/daedric at Master |
| 3 | enchanted roll `diff.gear * 3` — `:264` | all 865 |
| 4 | `BAD_WEAPON` — `:411` | already excludes `Daedric`, `Stalhrim`, `Dragonbone` for NPC hand-outs; **does not exclude `Ebony`** |
| 5 | `arrowFor` — `:432`, arrows pool at `:258` | pool holds `EbonyArrow`, `DLC1DragonboneArrow`, `DLC2StalhrimArrow`, **all value 0**, so no band touches them |
| 6 | corpse trim — `:681-696`, `corpseLoot` `:733` | keeps MISC and INGR unconditionally, no material filter |
| 7 | **`pool('materials', 0, ok)` — `:256`, 25% per chest** | the materials pool (22 entries) contains **`IngotEbony` at value 150** — ebony ingots drop from **every chest at every difficulty including Novice**, routing straight past the entire mining curve. This single line makes points 1–6 cosmetic |
| 8 | **`pool('ingredients', 0, ok)` — `:255`, 40% per chest** | the ingredients pool (235 entries) contains **`DaedraHeart` at value 250** — the second daedric gate is currently a coin flip on any chest in the game |

Note for whoever writes the filter: **`/Ebony|Daedric/` does not match the string `DaedraHeart`.** A regex-only fix leaves gate 8 open.

**Do it upstream.** Have `ck-mcp/loot.py` emit `"craftOnly": true` on every ebony/daedric/stalhrim/dragon entry **and on `IngotEbony` and `DaedraHeart`**, and make `pool()` reject it unconditionally. Then the rule is data, it survives the next regeneration, there is one place to audit, and a boot-time assertion logging the `craftOnly` count makes a lost flag loud instead of silent.

### 7.3 The recipe gate does not exist

`CHECKLIST.md:849` — all 85 marker spells created and validated in `DragonBreak Online Edits.esp`, confirmed at boot.
`CHECKLIST.md:853` — **unticked. Not one COBJ carries a `HasSpell` condition.**

Today a character who has touched a forge once can craft anything the forge offers the moment he owns the ingots. Station gating is not a recipe gate. **Every rarity number in this document is aspirational until that xEdit pass lands**, it is one afternoon with a script of the same shape as `DBO_SkillMarkers.pas`, and it should ship **before** the point system, on its own.

Tier mapping for the script:

| marker | materials |
|---|---|
| `_T1` | iron, hide, fur, leather, copper, tin |
| `_T2` | steel, studded, banded iron, bronze |
| `_T3` | dwarven, elven, scaled, orcish, corundum, brass |
| `_T4` | glass, nordic, moonstone, malachite, adamantium, meteoric iron |
| `_T5` | dragonbone, dragonscale, dragonplate, stalhrim |
| `_T6` (level 95) | **ebony** — armour, weapons **and the ebony smelting recipe** |
| `_T7` (level 100) | **daedric** |

The smelter matters: ore → ingot is a COBJ, and without a condition on it a level-1 smith smelts ore he bought from a miner and the whole gate is a formality.

### 7.4 Cyrodiil has ebony — do not announce that it does not

Measured from `ck-mcp/out/bruma_essentials.json` (129,724 placed refs; 328 mining-related):

| family | count | type |
|---|---|---|
| `PickaxeMining{Table,Wall,Floor}Marker` | 169 | FURN — the §6.3 hole |
| `MineOreIron` | 60 | ACTI |
| `MineOreCorundum` | 33 | ACTI |
| `MineOreSilver` | 26 | ACTI |
| `MineOreMoonstone` | 14 | ACTI |
| `MineOreGold` | 11 | ACTI |
| `CYRMineOreCopper` | 7 | ACTI |
| `MineOreMalachite` | 6 | ACTI |
| **`MineOreEbony`** | **2** | ACTI — `83e5a` and `83e5c:BSHeartland.esm`, bases `e2bc2` / `a2be5:Skyrim.esm`, both in cell **`CYRRedRubyCave01`** |

Two corrections follow, both in the owner's favour.

**One:** BSHeartland places *vanilla* `MineOre*` bases, which `labour.js:100-104`'s `oreOf` already matches, so iron, corundum, silver, moonstone, gold and malachite all work in Bruma today. Mining is **not** copper-only, and the note in `CHECKLIST.md:640` saying so is wrong.

**Two:** `CYRRedRubyCaveLocation` is already an entry in `dungeons.json` (`LocTypeVampireLair`, `LocTypeClearable`, cells `CYRRedRubyCave01` and `02`). **The province's entire ebony supply is two veins inside a leased, contested, cooldown-gated vampire lair.** That is better than the design goal, it costs no world edit, and it reads correctly in lore as a curiosity rather than an industry — Cyrodiil has no ebony trade, and two seams in a vampire lair is exactly what that should look like.

So: **do not tell players ebony is unobtainable until Skyrim opens.** Tell them there is exactly one ebony seam in the province and let them find it, guard it, sell access to it and fight over it. Skyrim's opening still brings Gloombound and supply at scale, which is the reward the brief wanted.

### 7.5 Two data bugs in `skills.json` that contradict the strictness the owner wants

Both are free to fix:

- `miner.oreByTier` (`skills.json:384`) is `[[Copper,Iron,Corundum],[Silver,Quicksilver],[Orichalcum,Moonstone],[Ebony,Malachite],[Ebony,Malachite]]`. **Ebony opens at index 3, which is Expert**, two bands earlier than the owner thinks.
- **Gold and Tin appear in no tier at all**, so the 11 placed gold veins in Cyrodiil refuse every miner at every rank.

### 7.6 The mining percentage curve

**There is no percentage today.** `labour.js:312-314` awards `Math.max(1, Math.round(base * mult))` on a won round — fully deterministic. Ebony base is 1, tier-5 multiplier is 2, so a top-tier miner gets **exactly 2 ebony ore, guaranteed, every single won round**. That is the opposite of what the owner asked for, and it is about twenty lines in a hot-reloading file.

Proposal: roll once per won round, **after** the timing round is judged. A failed roll still pays full skill credit — only the material is denied (*"The seam gives nothing but waste rock"*).

```
P(ore) = clamp(0.05, 0.95, base[ore] + 0.006 * (minerLevel - minLevel[ore]))
```

| ore | min level | base | P at min | P at 50 | P at 75 | P at 90 | P at 100 |
|---|---|---|---|---|---|---|---|
| Copper, Tin | 1 | 0.95 | 0.95 | 0.95 | 0.95 | 0.95 | 0.95 |
| Iron | 1 | 0.90 | 0.90 | 0.95 | 0.95 | 0.95 | 0.95 |
| Corundum | 20 | 0.70 | 0.70 | 0.88 | 0.95 | 0.95 | 0.95 |
| Silver | 35 | 0.55 | 0.55 | 0.64 | 0.79 | 0.88 | 0.94 |
| Quicksilver | 40 | 0.50 | 0.50 | 0.56 | 0.71 | 0.80 | 0.86 |
| Orichalcum | 50 | 0.45 | 0.45 | 0.45 | 0.60 | 0.69 | 0.75 |
| Moonstone | 60 | 0.40 | 0.40 | — | 0.49 | 0.58 | 0.64 |
| Malachite | 75 | 0.30 | 0.30 | — | 0.30 | 0.39 | 0.45 |
| **Gold** | 80 | 0.20 | 0.20 | — | — | 0.26 | 0.32 |
| **Ebony** | **95** | **0.10** | **0.10** | — | — | — | **0.13** |
| Stalhrim (Solstheim) | 95 | 0.08 | 0.08 | — | — | — | 0.11 |

`oresUpTo(tier)` (`labour.js:107`) becomes `oresAtLevel(level)` reading `minLevel`; `oreByTier` stays as the source for the K-menu blurbs. `yieldMultiplierByTier` applies to the count on success. Per-player daily ore caps at the top: 20/day at band 5, **8/day for ebony**.

### 7.7 The faucet, which is the number to tune against

Compute the server-wide rate, not the per-player one:

```
ebony ore/day (server) = MasterMiners x min(dailyOreCap, veinsReached x roundsPerDay x P)
```

Red Ruby Cave, two veins, 45-minute per-player rest, P = 0.10 at Miner 95: about **0.27 ore per hour** for a miner camping the cave — which he cannot do continuously, because the cave is a leased dungeon with a party requirement and a cooldown. With the Seat rule and the ~51-day floor from Master, a 100-player server holds perhaps **one to three Master Miners**, so **single-digit ebony ore per day server-wide** during the Bruma playtest.

**What that buys is deliberately not asserted here.** Vanilla ebony smelting and the daedric recipes' exact input counts must be read out of SSEEdit before any number is published — see §11. What is certain is the shape: a daedric set is a server-wide event measured in weeks, not a farm.

**Daedra hearts are the second gate** and are a coin flip today (§7.2 point 8). Two sources only once fixed: a drop from dremora/daedra killed inside a **Master** dungeon lease, and an Atronach Forge ritual requiring **Arcane 95** — so hearts and armour compete for the same Seat and the same ebony.

### 7.8 Two Master levers that cannot be looted

`craftedExtrasSystem.ts` already server-validates tempering and enchanting against the station, the reserved materials and the consumed soul — and then applies the **same cap to everyone**: `MAX_HEALTH_STEP = 16` (Legendary) and `ENCHANT_MARGIN = 2`. A level-1 smith tempers to Legendary today.

- `maxStep = 2 + floor(blacksmithLevel / 8)` — Legendary only at 100 with the Seat, Epic around 90.
- enchant margin `= 0.8 + enchanterLevel/125`.
- **Credit the Enchanter at the same hook.** This fixes the only skill in `skills.json` with literally zero event sources, in the one place where the server already validates the enchantment, the soul and the station — no new producer, no plugin work.

---

## 8. What it feels like

### A new character's first hour

No "choose three" prompt and no irreversible decision. K opens on seventeen skills at `—` and a pool reading `0 / 300`.

- **0:00** He kills a wolf on the Bruma road with a rusty sword. *"One-Handed 1."* Pool 1/300.
- **0:04** Picks a mountain flower — Harvesting 1. Picks four more; the fifth counts for a quarter and the menu says why: `This hour: 3 of 30 counted in Harvesting.`
- **0:20** Walks into the smithy. The forge does not refuse him: *"You set your hand to the forge for the first time."* Blacksmith 1, pool 3/300. He forges iron daggers at weight 0.54 and works out inside a minute that something worth 400 gold would fill his hour six times faster — if he could make one.
- **0:35** Finds an iron seam outside town, wins the timing round, gets three ore. Miner 2.
- **1:00** One-Handed 12, Harvesting 9, Blacksmith 6, Miner 4, Cook 2. Pool 33/300. Everything Novice; the first tier edge is about eight hours away and the menu shows which skill is closest.

He has spent an hour, chosen nothing he cannot unchoose, and does not yet know that the Journeyman miner he sold his iron to will be one of two people on the server who ever reach 95.

### A 500-hour veteran's sheet

```
Beriel of Chorrol — Master Blacksmith, The Forge-Bound         Renounced 1x (free)

  Pool  ████████████████████  300 / 300     Expert 3/3   Seat: Blacksmith

  Blacksmith    100  Master     ✦Ebony ✦Daedric   ■   legendary tempering
  Defense        84  Expert                       ▲
  Cook           79  Expert                       ■
  Woodcutter     76  Expert                       ■   charcoal for steel
  One-Handed     25  Apprentice   at the floor    ▼   falling
  Scholar        11  Novice                       ▲
  Harvesting      9  Novice                       ▲
  ...ten more at 1-6

  This hour   Blacksmith 12 / 30
  Today       Blacksmith 41 / 60        (Master band)
```

She is the province's smith. She **cannot** mine her own ebony — not because Miner is expensive, but because she already holds her one Seat, and the ebony seam needs 95. She buys ore from a Master Miner she does not control, hearts from a conjurer she has to be polite to, and she eats well because starving would quarter her credit rate. Five hundred hours in, she is still dependent on three other people, and everybody in the hold knows her name.

That is the design working.

---

## 9. Build plan, by layer and phase

### Phase 0 — measure (this week, before any design lands)

| task | file | layer |
|---|---|---|
| One log line per credited point: `skill gain <player> <skill> <old>-><new> w=<weight> nov=<0.25\|0.5\|1> hr=<n>/30 day=<n>/cap src=<kind>:<id>` | `masterySystem.ts` | server TS |
| Hourly per-player rollup; flag 20 consecutive labour rounds with `err < 0.05` | `masterySystem.ts`, `labour.js` | server TS + hot reload |
| Print the **real** unresolved list at boot instead of filtering markers and station names out of it | `masterySystem.ts` | server TS |

Read a fortnight of it. Every events-per-hour estimate in §3.4 is replaced for free by this log, and freezing weights before it exists is guessing.

### Phase 1 — week 1, ships without touching the point system

| task | file | layer / how it ships |
|---|---|---|
| **`HasSpell` conditions on every gated COBJ**, by tier, including the ebony smelting recipe (`CHECKLIST.md:853`) | `DragonBreak Online Edits.esp` | xEdit script, headless with `-D:"<dev Data>" -P:"server\plugins.server.txt"`, mind the leftover `.save` |
| **Audit every DBO CTDA** against the 17 implemented condition functions (§6.6) | same | xEdit, same pass |
| `craftOnly: true` on ebony/daedric/stalhrim/dragon gear **and on `IngotEbony` and `DaedraHeart`**; boot-time count assertion | `ck-mcp/loot.py` → `loot.json` | `py ck-mcp\loot.py`, minutes |
| Reject `craftOnly` inside `pool()`; `BAD_WEAPON` += `Ebony`; arrow exclusions; corpse-trim material filter | `dungeons.js:229/411/432/681-696` | **hot reload**, ~10 lines |
| **The mining percentage roll**, `oresAtLevel`, per-player daily ore caps | `labour.js` | **hot reload**, ~20 lines |
| Fix `oreByTier` (ebony → top band) and add Gold and Tin | `skills.json` | data |
| Handle or exclude the 169 `PickaxeMining` FURN markers | `labour.js` or `skills.json` | hot reload |

Week 1 delivers the two things the owner actually asked for — crafted-only ebony/daedric and a percentage chance on high-tier ore — with no dependency on the points work at all.

### Phase 2 — the missing producers

| task | file | layer |
|---|---|---|
| Credit the **Enchanter**, and scale `MAX_HEALTH_STEP` / `ENCHANT_MARGIN` by level | `craftedExtrasSystem.ts` | server TS |
| **Alchemist** brewing: add a real `craftKeywords` entry; remove the bogus `activatePrefixes` | `skills.json` (+ verify the keyword resolves) | data + boot |
| **Tailor**: verify MCE loom COBJs carry `MCE_CraftingLoom`; drop `TailorBench` | verification first | — |
| **Priest** prayer producer; **lockpicking** on housing doors; **skinning** minigame fires its event | `gamemode.js` | hot reload |
| **Defense** credit from server-computed damage reduction; delete or implement `blockEvents` | `masterySystem.ts` | server TS |

### Phase 3 — the gain engine

| task | file | layer |
|---|---|---|
| Pool, caps, Seat, weights, token bucket, daily caps, persisted novelty ring, transfer, locks, capstones by level, lazy atrophy (off), derived `order`/`rank`, v2 migration on `read()`, first-touch grant, event folding, **dirty-flag writes** | `masterySystem.ts` (~350 lines) | `cd fork\skymp5-server && npm run build-ts`, copy `fork\build\dist\server\dist_back\*` → `server\dist_back\`, restart node |
| `pool`, `caps`, `bands`, per-skill `weights` / `minLevel` / `capstones`, `atrophy`, miner `oreChance` | `skills.json` | read at **boot** → restart |
| Admin: `masterySetLevel`, `masteryGrant` (keep `MAX_GRANT`), `masteryRenounce`, `masteryLock` | `adminSystem.ts`, `masterySystem.ts` | server TS |
| 2–4 capstone SPELs (`DBO_Skill_<id>_T6/T7`) | `DragonBreak Online Edits.esp` | xEdit |
| **Make the client mirror pass-through** (`info = content`) instead of copying named fields | `masteryService.ts` | `npm run build`, copy to **both** Plugins folders, players relaunch |
| Pool bar, level numbers, three-state lock chevrons, bleed-order group, capstone pips, hourly/daily meters, renounce slider | `masteryMenu/index.tsx` | `npm run build`, copy `dist\*` to **both** UI folders |

The client rebuild is worth doing once for the pass-through alone: `masteryService.ts` is 188 lines of named-field mirroring today, and one rebuild makes **every future menu field front-only forever**.

### Phase 4 — retune and refine

Retune `MASTERY_DMG.byTier` against the new bands (§11). Move gates that want finer resolution off `rank` and onto raw level: ore bands, tempering steps, enchant magnitude, lock difficulty. Add the gamemode-side distance guard on `onActivate`, which matters more once first touch is worth a level.

**C++: none required at any phase.**

---

## 10. Migration for live characters

Today's record: `{ skills: { <id>: { points /* hours */, lastPointAt, rank, granted[] } }, order: [<id≤3>], respecs }` (`masterySystem.ts:902-928`).

Convert hours to units at **30 units/hour** and invert the cumulative table:

| old points (= hours) | old tier | units | new level | new tier |
|---|---|---|---|---|
| 0 | Novice | 0 | 1 | Novice ✓ |
| 10 | Apprentice | 300 | **27** | Apprentice ✓ |
| 30 | Journeyman | 900 | **54** | Journeyman ✓ |
| 70 | Expert | 2,100 | **79** | Expert ✓ |
| 150 | Master | 4,500 | **96** | Master ✓ |

**Every live character lands in exactly the tier they hold**, a little above the boundary. Because the old cap was three skills and `creditActivity` returns immediately unless the skill is in `order`, skills outside `order` have no progress and migrate to 0. Three maxed skills convert to at most 96 + 96 + 96 = 288 against a 300 pool, one Seat and three Expert slots — **no live character can be over cap or over either structural cap.** The migration cannot strand anyone and needs no refund or grandfathering.

Mechanics:

- Run it **lazily inside `read()`** behind a `v: 2` marker, the same pattern as the existing legacy one-profession migration at `:917-921`. No script, no downtime, no world-file surgery.
- `granted[]` and `respecs` carry over untouched. Keep v1 records readable for one release.
- Locks: the former `order` skills → **▲**, everything else → **■**. Nobody starts bleeding. Put a confirmation on the first ▼ a character ever sets, and an amber warning row when a ▼ skill is within 2 levels of a band edge and about to lose a marker spell.
- Two changes players will notice, both gifts: they can now hold more than three skills, and the dropped-skill wipe is gone.

---

## 11. Open decisions

Each with a recommended default and the trade-off in one line.

| # | decision | recommended default | trade-off |
|---|---|---|---|
| 1 | Pool size | **300** | 250 forces harder specialisation and thins the player base for each trade; 350 lets one character hold the whole metal chain at Expert and the market thins instead. |
| 2 | The Seat (one skill ≥ 91) | **keep, and make it the headline** | Without it a smith mines his own ebony and there is no economy; with it, the first three people who hit it will complain. |
| 3 | Ebony seam requirement | **Miner 95** (not tier 4 as `skills.json` has it today) | At 90 a Seat-holder could in principle pair it with a 90 Blacksmith; 95 on both sides makes them provably different people. |
| 4 | Atrophy | **off** | Off means a skill only falls when you mark it; on (played-day, floor 76) stops the server accumulating retired grandmasters who hold scarce Master slots and serve nobody. |
| 5 | Master daily cap | **60 units/day** | Lower makes the last ten points feel like a second job; higher lets a dedicated grinder reach 100 in under a month and ebony stops being rare. |
| 6 | `MASTERY_DMG.byTier` retune | **`[0, 0, 0.08, 0.16, 0.28]`, revisited after a playtest** | The bands moved, so leaving `[0,0,0.10,0.20,0.30]` makes Master a bigger combat jump than it is today. |
| 7 | Ebony ingot recipe | **verify vanilla in SSEEdit first**; if 1 ore → 1 ingot, author a DBO COBJ at 3 ore → 1 ingot | Vanilla ratios make a cuirass reachable in a fortnight; a DBO ratio makes it a month but is one more plugin record to maintain. |
| 8 | Daedric recipe inputs | **read them out of SSEEdit before publishing any number** | Every faucet figure in §7.7 is shape, not quantity, until this is done — and guessing an engine fact is the rule this project exists to enforce. |
| 9 | Arrows | **exclude ebony/dragonbone/stalhrim arrows from loot entirely** | Excluding makes a quiver a smith's commission; keeping them means an ebony arrow pool that no value band can see. |
| 10 | Announce ebony scarcity publicly? | **yes, before launch — "one seam in the province", not "no ebony"** | Saying it up front makes scarcity a feature; discovering it later makes it a nerf, and announcing absence would be a public retraction. |
| 11 | `vanillaLevel` (cap 5, level = Σtiers/3) | **defer — read by nothing today** | Reviving it needs a rule for "sum of tiers" under a pool; leaving it out costs a flavour system nobody currently has. |
| 12 | The unimplemented `skills.json` blocks (`minigames`, `spellStudyPoints`, `praying`, `deities`, `worldPickup`, `markerSpells` placeholders, `gates.nodes/books/skinning/weaponOnly/pickable`) | **keep as design, mark clearly as unbuilt** | Leaving them looks like features that exist; deleting them loses the design work in §12 of the old review. |

---

## 12. What we deliberately rejected, and where we disagree with the first sketch

Said plainly, because the owner asked for judgement rather than agreement.

**1. A 100-point total.** Rejected. It cannot coexist with "people can do everything" — 95 in Smithing leaves 5 points for sixteen skills. The 100 survives as the per-skill cap, which is also the number the owner already uses when he says "level 95 or 100". The pool is 300. *(§3.1)*

**2. Time decay during absence.** Rejected as the default. The owner's sentence — "if you stop using a skill points fade off of it" — is fully served by transfer-on-use: the skill you neglect is the one that bleeds when you take up another, because you chose to do something else. Calendar decay taxes precisely the roleplayer who disappears for a week to write a character arc, and it is the only part of the design that would need a clock, which is the part that does not scale. Played-day atrophy is specified and defaulted off. *(§3.5c)*

**3. "At most one skill above 90" as a *replacement* for the pool.** Rejected — a second rule doing the first rule's job produces a wall you hit while still holding points. Kept as a **structural** rule with a specific job: making the miner and the smith different people. That is not pool shaping, it is the economy. *(§3.1)*

**4. A weighted pool where a level costs more at the top.** Rejected. It delivers similar scarcity to the Seat rule, and the mechanic most players meet is *"why did five points cost me fifteen?"* — two numbers on the sheet whose relationship is a piecewise formula. The Seat does the same work in one comparison and explains itself in one sentence.

**5. Two new tiers for ebony and daedric.** Rejected. Six and seven ranks means 34 new plugin records and a change to every rank-indexed array. Capstone spells keyed on level are two records and 25 lines. *(§5.4)*

**6. Client-reported blocking.** Rejected outright. A block is visible only to the client, and `blockEvents` is a key that has been parsed and never read since it was written. Defense gets credit from the damage reduction the server itself computes. *(§6.2)*

**7. Raising `MAX_QUEUED_EVENTS` as the answer to event loss.** Rejected as the primary fix. At 100 players in combat the volume is duplicates, so folding identical events within a tick addresses the cause; the larger queue is a backstop. *(§6.4)*

**8. Rewriting `neighborsFailed`.** Rejected — the bug is not there. Three separate design passes reported a server-wide crafting outage that does not exist. The flag suppresses repeat logging; `benchInReach` retries every call. *(§6.5)*

**9. Telling players ebony does not exist in Cyrodiil.** Rejected, and this one would have hurt. There are two ebony veins in `CYRRedRubyCave01`, which is already a leased vampire lair in `dungeons.json`. Announcing absence would be disproved by a player in one evening. *(§7.4)*

**10. Value bands as the ebony/daedric filter.** Rejected. An ebony sword and a glass sword sit in the same band, the enchanted roll multiplies the cap by three and admits all 865, and the two worst leaks pass `maxValue = 0` so no band ever sees them. The filter has to be an explicit `craftOnly` flag, emitted upstream in `loot.py`. *(§7.2)*

**11. Regex-in-`dungeons.js` as the durable form of that filter.** Rejected as the *permanent* answer, though it is the right emergency patch. A regex in a hot-reloading file is lost the next time `loot.json` is regenerated, and `/Ebony|Daedric/` does not even match `DaedraHeart`.

**12. Use floors that cannot be reached.** Rejected. Any floor above "first touch" on a gated station deadlocks the skill it gates, because the station is the skill's only event source. First touch grants level 1 and lets the activation through. *(§5.3)*

**13. Rewriting the five gameplay-layer gate readers.** Rejected as unnecessary. Deriving `order` and `rank` keeps `gamemode.js`, `labour.js` and `dungeons.js` untouched on day one, which is the difference between a week and a month — and between a migration that can strand live characters and one that provably cannot. *(§5.2, §10)*

**14. Superseded from the 2026-09-14 review**, for the record: `maxChosen: 3` (replaced by the pool), `tierHours` (replaced by levels and units), `swapCooldownDays: 7` (already replaced by the standing-stone gold cost, now replaced entirely by locks and renunciation), "dropping a skill wipes its tier progress" (replaced by lowering, which is gradual and priced), and the `vanillaLevel` formula (deferred, read by nothing). **Still standing from that review and carried forward unchanged:** the five tiers, the mini-game pattern with the server as judge, the smelter belonging to Blacksmith with a charcoal kiln for Woodcutter, Shield merged into Defense, armour tiers as permission-with-penalty, spell study points as places, the prayer and deity design (unbuilt — §4), Harvesting as the seventeenth skill with the no-pickup rule, farms staying open, the character tag, the guest list on X, admin `/chargen` and `/rename`, and the height slider.

## 13. The charcoal chain: making Woodcutter worth taking (Nat, 2026-09-20)

Nat's note, recorded as given: **ingots should require charcoal, and better ingots should require better
charcoal.** Firewood feeds the kiln, the kiln makes charcoal in grades, and the smelter spends it. Woodcutting
stops being a parallel hobby and becomes the supply line that Blacksmith depends on — the reason a server with
two players has a use for the second one.

Three further points from the same note, and where each already stands:

| Asked for | State today |
|---|---|
| Woodcutting needs a mini-game | **Already built.** `labour.js` `chop()` runs a rhythm round, 4/8/12/16/20 strikes by tier, and pays `firewoodByTier: [3, 4, 5, 6, 8]`. Confirmed live in the boot line. |
| Only a certain tier of Woodcutter may use a saw mill, for bulk wood, every thirty minutes | **Already designed, not built.** `skills.json` §minigames already says *"lumberMill: no mini-game, 30-minute cooldown per player per mill, yield by Woodcutter tier"*, and `LumberMill`/`FarmLumbermill` are already in the woodcutter's `gates.stations` **and** `activatePrefixes`. What is missing is a handler: `__dboLabour` dispatches only `MineOre*` and `WoodChoppingBlock*`, so activating a mill does nothing. |
| Charcoal grades tied to Woodcutter tier | **Half designed.** The tier names in `skills.json` already read "rough charcoal" → "good charcoal" → "fine charcoal", and `CharcoalKiln` is in `gates.stations`. There is no charcoal item, no kiln handler and no consumption anywhere. |

So the new work is the **dependency**, not the stations. What it needs:

1. **A charcoal item per grade.** Vanilla has no charcoal ingredient worth reusing as three tiers, so this is
   likely three MISC records in the DLE plugin — plugin work, and the first thing that has to be decided,
   because everything below references the ids.
2. **A kiln handler in `labour.js`**, taking firewood and returning charcoal of a grade capped by Woodcutter
   tier. Same shape as `mine()`/`chop()`: server-issued round, server-judged, a rest timer on the kiln ref.
3. **A mill handler**, no mini-game, a per-player-per-mill 30-minute rest (`restsOf`/`saveRests` already do
   exactly this for veins and blocks) and yield by tier. **Pick the scale against `firewoodByTier`:** a
   chopping round pays 3–8 firewood in ~30 s, so a half-hour mill claim wants to be worth roughly an
   uninterrupted stretch of chopping, not an order of magnitude more. Something near 40–60 at tier 1 rising to
   120–150 at tier 5 keeps the mill attractive without making the block pointless — decide against a measured
   chopping rate rather than this estimate.
4. **The smelter spending it.** This is the part with no scaffolding at all: `isSmelter` today is only a
   Blacksmith gate/craft station, and ingot recipes carry no input beyond ore. Gating ingot *grade* on charcoal
   grade is the whole point of the note, and it lands in the same xEdit pass as the crafted-only ebony/daedric
   `HasSpell` conditions that §9 already calls for — one plugin session, not two.

**Sequencing note:** none of this should start before the point system keeps a level (see the top block of
`CHECKLIST.md`). A supply chain built on a skill system that discards progress cannot be tested.

## 14. Combat openings, magic learning and player levels (Nat + Claude, 2026-09-20)

Agreed in conversation the night the point system first went live. Nat approved the combat and magic shapes
("everything looks really good"); the numbers below are proposals to be tuned, not settled values.

### 14.1 Opening a combat skill: shadow progress, then an offer

The "a trade is opened at its station, not by accident" rule (§5.3, `masterySystem.ts:418`) works for trades
because you walk to a forge deliberately. Combat happens *to* you - a bandit swings, you swing back, and that
is not a career choice. Five combat skills plus scholar, priest, lockpicking and harvesting therefore have no
opening move at all today, and cannot be levelled.

**The shape:** an unopened skill accrues a hidden counter. When it crosses one level's worth of units (10 at
Novice), the player gets a notice and the K menu offers *"Take up One-Handed - 1 spoke"*. The pool point is
spent on confirmation, and the shadow counter converts into real progress.

Why this one over the alternatives:

- Explicit consent, so the "not by accident" rule holds intact.
- No station required, which is the entire problem for combat.
- Free until agreed - a stray arrow costs nothing.
- Nothing is wasted: work done before confirming is credited retroactively, so a player who fights for an
  hour and only then takes up the skill is not punished for the delay.
- It surfaces in a menu that already exists and already knows how to spend a pool point.

**Cheap fallback if the shadow counter is too much for a first pass:** open on the first credited act but
defer the pool cost until level 2. Muddier, because the skill exists before the player chose it.

### 14.2 Magic stays two skills, with per-school familiarity inside them

**Rejected: one skill per school.** The pool is a fixed 300 and the question is zero-sum, so splitting a role
into more skills taxes that role rather than deepening it:

| Build | Skills at Adept (50) | Pool spent of 300 |
|---|---|---|
| Warrior: One-Handed + Defense | 2 | 100 |
| Mage as `arcane` + `priest` (today) | 2 | 100 |
| Mage as five schools | 5 | **250** |

Five schools makes a mage pay 2.5x a warrior for equal breadth and leaves 50 points for every trade and
support skill combined.

**Instead: a per-school familiarity counter inside each of the two skills** - casts per school, decayed, never
spending pool - deciding which schools' spells may be slotted at a given rank. A player who has only ever cast
Destruction cannot slot a Conjuration tome of the same rank until they have put work into Conjuration. This
buys the *feel* of five trees for the price of two, and it is the same persisted-ring shape already used for
repetition decay.

### 14.3 The gate that matters is supply, not rank

`arcane` and `priest` already cap spell rank by tier and hold three slots each, studied at a spell study
point. None of that blocks entry. **The tome supply does:** today the only source is a Scholar's roll,
`tomeDropChanceByTier: [0, 0.02, 0.04, 0.07, 0.1]` - nothing at tier 1, one in ten at Master. Combined with a
starter kit that contains no magic, nobody can become a mage without another player who invested in Scholar
first. That is social gatekeeping of exactly the kind Nat explicitly does not want, arriving through the
economy rather than through a rule.

- **Novice and Apprentice tomes sold for gold** by a court mage. This single change decides whether magic is a
  class or a clique.
- **Scholar drops and player teaching cover Adept and above.** The rare tiers stay social and Scholar stays
  worth taking.
- **Keep the study point.** It is a *place*, so it makes players gather - worth more to a roleplay server than
  the gate it imposes.
- **Keep rank-by-tier and the three slots.** That is the progression and the identity, and neither blocks entry.

### 14.4 Player teaching, as a judged round

Same pattern as mining and reading: the server issues the round and the server judges it.

- **Teacher** at tier 4+ in `arcane`/`priest`, teaching a spell they actually know.
- **Learner** must hold the skill, and their own tier must allow that rank - teaching accelerates, never skips.
- **Both inside a study point radius** (6 m is already configured), giving study points a second purpose.
- The server issues the round to the *learner*; the **teacher's tier sets the allowed misses**, so a Master is
  a measurably better teacher.
- **Both earn credit**, with repetition decay per (teacher, learner, spell) through the existing ring - that is
  what stops two friends farming each other.

### 14.5 Player levels: cap 5, and it is a C++ item

The `vanillaLevel` block already says what Nat wants - `cap: 5`, `perks: disabled`, `+10 to one of Health,
Magicka or Stamina per level, chosen by the player`. Two things block building it.

**The formula is stale.** `levelFrom` still reads "sum of tiers across the three chosen skills divided by 3",
which is the shape the pool replaced. Under points the natural input is total levels across all skills, which
is pool used, 0-300. **Proposed thresholds: 30 / 80 / 145 / 215 / 285** - level 1 inside a first week, level 5
only at near-total commitment. Checked against §10's own migration examples: the 10h/70h/150h character lands
at 202 -> level 3, and three maxed skills at 288 -> level 5.

**It cannot be built in the gameplay layer.** Base Health, Magicka and Stamina are computed in
`GetBaseActorValues.cpp` from race data plus NPC offsets, with no hook the JS layer can reach, and
`SetActorValue` is client-local by the server's own log warning. A +10 the server honours has to enter where
the server computes the value. **Player levelling therefore belongs in the same native session as the movement
rate validation** - batch it, rather than spending a separate C++ build on it.

### 14.6 The starter kit, and race birthright spells

`STARTER_KIT` (`gamemode.js:897`) is already a Pickaxe and a Woodcutter's Axe and nothing else - no magic, as
Nat intends. Vanilla races nonetheless hand out cantrips behind that decision's back (an Orc arrives holding
Flames), and something then removes them; nothing in `server/*.js` grants or removes a spell, so the grant is
client-side race behaviour and the removal is most likely the first `learnedSpells` reconciliation. **Measure
it on a fresh character before choosing.** Two clean answers: strip race defaults explicitly at creation so
nobody ever sees them, or keep them deliberately as every race's birthright cantrip, free and outside the
pool. The first fits "magic is learned" and is the recommendation - but it argues harder for §14.3, because a
new character's first hour would otherwise contain no magic at all.
