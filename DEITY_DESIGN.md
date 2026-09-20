# DragonBreak Online: deities, shrines and prayer

**Status:** built and authored, 2026-09-20 13:00. Written as design at 03:10 from Nat's brief; sections 3 to 8 were
then **corrected against measurement** when the thing was actually built, because three of the claims in
them were wrong. The corrections are marked. `server\prayer.js` is the implementation, its harness is
`server\tests\prayer-harness.js`, and the shrine census it rests on is `server\shrine-placements.json`
(regenerate with `py ck-mcp\shrines.py`).

**Every blessing spell now exists.** Eleven `DBO_BlessingOf*` SPELs were authored on 2026-09-20 at
`DragonBreak Online Edits.esp:1209BF-1209C9` by `SSEEdit 4.1.5f\Edit Scripts\DBO_Blessings.pas`, and the
live server reports `blessings 22 resolved, 4 server-side, 0 broken`. The same sitting finally gave
Unarmed its five marker spells at `1209CA-1209CE` (`DBO_UnarmedMarkers.pas`), so boot now reads
`unresolved: none` and `18 skills have marker spells`.

**Every Prince can be prayed to** (2026-09-20 15:00). Nat placed a statue of each at the Namira
shrine site as one central test ground; thirteen went in as STATICS, which the engine never fires an
activation on, so `DBO_ShrineActivators2.pas` gave each Prince an activator using that same statue
mesh and repointed the references at it. The boot line reads `44 shrine ids, 24 reachable`. Only **Auri-El**
(his one shrine is in the Forgotten Vale, though an Akatosh shrine will hear him) and **Clavicus Vile**
(no statue placed) are still out of reach.

**The picker is built** (2026-09-20 13:40): front widget `deityPicker`, id 36, offered automatically to
any character out of the race menu with no god, and reopened with `/deity`. The **first choice is free
and needs no shrine**; a later turn is gated by the 7-day cooldown alone, because the brief puts
conversion on a menu key rather than a pilgrimage.

**Still open, in section 8**: whether Talos and Daedra worship should actually be a crime in Imperial
Bruma, and a real hotkey for the menu, which is the one piece still wanting a client rebuild.

## 1. The brief, as given

> A deity picker after the race menu. Shrine buff for all Daedra and Aedra. Anyone can use the pray
> emote / `/pray` to do a mini-game. A really rare chance to get the blessing from the shrine after praying.
> You can only pray at the shrine of your deity. You can only change deity once a week IRL, by a menu key.
> Priests have a higher chance per tier to get the blessing.

## 2. What already exists in skills.json (do not re-invent)

The `praying` block already specifies:

- **Own deity only** (`onlyOwnDeity: true`), other shrines answer with a notice and no roll.
- **The mini-game**: *"hold the prayer key through three verses; releasing early ends the prayer with no roll"*.
- **Blessing odds**: `everyone: 0.02`, `priestByTier: [0.05, 0.10, 0.15, 0.20, 0.30]`.
- **Blessing duration by tier**: 8 / 8 / 12 / 16 / 24 hours.
- **60 minute cooldown per shrine**, and `priestActivityPoint: true` so prayer credits the Priest skill.

The `deities` block already specifies the picker (*"a popup right after character creation, server packet
`deityMenu` -> client `deityChoose`, stored per character"*). ~~and carries the nine Divines with their
shrine form ids and `BlessingOf*` spells.~~ **Both halves of that were wrong** and are corrected in
sections 3 and 5: it carried twenty-one deities, not nine, and no `BlessingOf*` record exists anywhere
in this load order. The roster is now twenty-six and every blessing names a real form id.

**The `prayer` event kind was already wired**: `masterySystem` does `add("prayer", "priest")` in its
candidate map and `matches()` has a `case "prayer"`. `prayer.js` now emits it, so nothing on the server
side needed rebuilding to credit the Priest.

## 3. The three changes the brief actually asks for

1. **Conversion cooldown: 30 days -> 7 days.** Done, `deities.conversionCooldownDays: 7`. The brief
   also moves conversion off `/convert`-at-a-shrine and onto **a menu key** - **the picker is built**
   (front widget `deityPicker`, id 36), and conversion through it is gated by the cooldown alone, no
   pilgrimage. `/deity` opens it; a real hotkey is the one piece still wanting a client rebuild.
   "Current blessing removed on conversion" is implemented and covered by the harness.
2. ~~**Add the Daedric Princes.** The `deities.choices` list holds only the nine Divines.~~
   **WRONG, corrected 2026-09-20.** `deities.choices` has held twenty-one entries since commit
   `60eabb7` on 2026-09-16: ten Divines (with Auri-El) and eleven Princes. This section was written
   from `praying.shrines`, a nine-entry index of the Divines that sits beside the real list. That
   duplication is now labelled in the file: **`deities.choices` is what the server reads.**
3. **Nothing else.** The odds, the durations, the mini-game and the own-shrine rule are already what Nat
   described, which is a good sign the original design held up.

## 4. ~~The problem that blocks all of it~~ - there was no blocker

~~**Every shrine id in `skills.json` is a Skyrim shrine**, and the playtest is region-locked to Bruma, so
a player cannot reach a single one of them.~~ **WRONG, corrected 2026-09-20 by census rather than
reasoning** (`py ck-mcp\shrines.py`, results in `server\shrine-placements.json`).

The shrine ids are **base objects**, and Beyond Skyrim Cyrodiil places the *vanilla Skyrim shrine bases*
all through its own chapels. `Skyrim.esm:0D9883` ShrineofAkatosh stands 39 times in the load order, 17 of
them inside the region lock, one of those in `CYRBrumaCathedralofStMartin`. **All nine Divines already had
reachable shrines in Bruma county before any of this work:**

| Deity | placements | inside the region lock | in Bruma county |
|---|---|---|---|
| Akatosh | 40 | 18 | 3 |
| Arkay | 50 | 8 | 4 |
| Dibella | 21 | 4 | 3 |
| Julianos | 21 | 6 | 4 |
| Kynareth | 23 | 8 | 4 |
| Mara | 21 | 4 | 2 |
| Stendarr | 25 | 4 | 3 |
| Talos | 56 | 6 | 4 |
| Zenithar | 23 | 6 | 2 |
| **every Daedric Prince** | — | — | **0 at the time** |

That last row was true until 20 September, when a statue of every Prince went in at the Namira site
and was wired to an activator. Fourteen of the sixteen now have exactly one reachable shrine; see the
note at the top.

The Cyrodiil wayshrines were added to the Divines anyway, because a wayshrine is a shrine a traveller
will walk up to. Note that **seven of the nine are base objects with no placement at all**: only
`CYRWayshrineofAkatosh` (1) and `CYRWayshrineofDibella` (1) are actually in the world. They resolve
cleanly and cost nothing to list:

| Deity | Cyrodiil wayshrine |
|---|---|
| Akatosh | `BSHeartland.esm:061B52` |
| Arkay | `BSHeartland.esm:061B53` |
| Dibella | `BSHeartland.esm:061B54` |
| Julianos | `BSHeartland.esm:061B55` |
| Kynareth | `BSHeartland.esm:061B56` |
| Mara | `BSHeartland.esm:061B57` |
| Stendarr | `BSHeartland.esm:061B58` |
| Talos | `BSHeartland.esm:061B59` |
| Zenithar | `BSHeartland.esm:061B5A` |

Every shrine entry is now a list holding both the Skyrim and the Cyrodiil base.

## 5. The roster and the boons

**The roster is canonical, not opportunistic.** It was "whoever already had a shrine"; since Nat is
placing hidden shrines through Cyrodiil it is now the Nine Divines plus Auri-El, and **Oblivion's
fifteen Cyrodiil Daedric shrines** plus Mephala - 26 entries. Five Princes were added in the lore pass:
Clavicus Vile, Hermaeus Mora, Namira, Peryite, Vaermina. **Jyggalag is deliberately absent** (section 7).

**There is no `BlessingOf*` record anywhere in this load order.** The vanilla shrine blessing is
`Altar<Deity>Spell`, and it is always one `Fortify<X>FFSelf` effect plus `CureDiseaseEffect` for
8 hours. Measured by `py ck-mcp\blessings.py` into `server\blessing-effects.json`.

Every boon below is built from a magic effect **that already exists in this load order**, so the
Creation Kit work is always "a new SPEL pointing at an existing MGEF" and never "a new MGEF" - for
every deity without exception, once the alchemy-family effects came into play (see below).

### No boon may be a dead stat

Nat, on reading the first pass: *"change sanguine, there is no NPCs... like everything is player ran
so."* **Persuasion, Speechcraft and Pickpocket do nothing on this server.** There are no merchants, no
dialogue and no barter - players trade with players - and there is no speech skill among the eighteen.
That killed four boons, not one: Sanguine's, which was mine, and **Dibella's, Zenithar's and
Mephala's, which are Bethesda's**.

Where the replacement overrides a vanilla shrine, **Bethesda's record is left untouched on disk** and
`skills.json` simply stops pointing at it, so reverting is one line. Each changed entry keeps a
`replacedBoon` line saying what it was and why it went.

| | was | is now |
|---|---|---|
| Sanguine | Persuasion +10 | **hunger comes on half as fast** - the feast does not end |
| Dibella | Persuasion +10 (vanilla) | Illusion +10 - charm is Illusion with nobody to talk to |
| Zenithar | Speechcraft +10 (vanilla) | **Carry weight +50** |
| Mephala | Speechcraft +10 (vanilla) | Alchemy +10 - the Webspinner taught the Morag Tong, who kill with poison |

**Zenithar is the one that matters.** The god of work and honest trade, on a server whose whole
economy is players hauling ore, ingots and firewood to each other: carry weight is the most Zenithar
thing that exists here, and no shrine in the game uses it.

**Sanguine stopped being a spell.** The Prince of indulgence belongs on the one system this server has
that is actually about appetite - `private.needs`. While the boon is worn, hunger accrues at half
rate: `prayer.js` exposes `__dboPrayerHungerMult` and the needs tick multiplies by it. No plugin, no
record, nothing for the Creation Kit. It is implemented and the harness covers it, including that it
lapses.

**The palette got much wider on the way, and it closed both open questions.**
`AltarMaraSpellWHAnvil` (WindhelmSSE.esp) uses `AlchFortifySmithing`, which proves an **alchemy-family
MGEF works inside a shrine spell**. So: **Mehrunes Dagon** takes `AlchFortifyDestruction` and no longer
shares Malacath's Damage - the school of ruin itself, in the county whose Great Gate he opened.
**Molag Bal** takes `AlchFortifyConjuration` - binding, thralldom and soul trap, and he is the reason
a black soul gem is black - so **no new magic effect has to be authored for anybody**. **Peryite**
takes `AlchResistPoison`, because there is no resist-disease effect anywhere in this load order and
poison is real here: players brew it.

**Check any future boon against what this server actually runs.** Real: combat and the damage formula,
health/magicka/stamina and their regen, carry weight, sneak, the magic schools, alchemy, lockpicking,
the needs meter. Not real: anything needing an NPC to talk to.

### The Divines - otherwise left mechanically alone

Apart from Dibella and Zenithar above, these are the blessings every Skyrim player already knows and
every other mod already assumes. Rewriting them is a change lore does not ask for. What was added is
the lore: each entry now carries
its `sphere` and, where the same god has other names, `alsoKnownAs` (Kyne, Jhunal, Stuhn, Tu'whacca,
Z'en). **Auri-El carries `aspectOf: akatosh`** - he is not a second god but the Aldmeri name for the
first, and `prayer.js` lets a worshipper of either kneel at either's shrine. That matters in practice:
Auri-El's one shrine is in the Forgotten Vale, so without it a Snow-Elf-faithed character could never
pray at all.

| Divine | Boon (vanilla, 8 h) |
|---|---|
| Akatosh | Magicka returns 10% faster |
| Arkay | Health +25 |
| Dibella | Illusion +10 (was Persuasion) |
| Julianos | Magicka +25 |
| Kynareth | Stamina +25 |
| Mara | Restoration +10 |
| Stendarr | Block +10 |
| Talos | Two-handed +10 (was a shout-cooldown boon, which may not work here at all) |
| Zenithar | Carry weight +50 (was Speechcraft) |
| Auri-El | Marksman +10, 12 h |

### The Princes

`blessingSource` says where the boon comes from: **live** = a real spell, whether Bethesda's or one of
the eleven authored on 2026-09-20; **server** = `prayer.js` does it and no record exists at all.
**Nothing is pending any more.**

| Prince | Sphere, in a line | Boon | Source |
|---|---|---|---|
| Azura | Dusk and dawn, prophecy | Resist Magic 10% | vanilla |
| Boethiah | Plots, murder, the teacher who tests | One-handed +10 | vanilla |
| Malacath | The sworn oath and the spurned | Damage +10%, Block +15 | vanilla |
| Mephala | Lies, secrets, the Webspinner | Alchemy +10 | live |
| Nocturnal | Night, luck, things not where they were left | Sneak +10 | vanilla |
| **Sheogorath** | **Madness** | **another god's blessing, a different one each time** | **server, done** |
| Clavicus Vile | Bargains granted exactly as worded | a boon you name, at a price | server, not built |
| Hermaeus Mora | Knowledge, memory, fate | what you read teaches you more | server, not built |
| Hircine | The Hunt and the Great Game | Stamina returns 10% faster | live |
| Mehrunes Dagon | Destruction and revolution; **Bruma's own Gate** | Destruction +10 | live |
| Meridia | Life energies; the energies of living things | Health regenerates 25% faster | live |
| Molag Bal | Domination; the harvest of souls | Conjuration +10 | live |
| Namira | The ancient darkness, decay, revulsion | Sneak +10 **and** night vision | live |
| Peryite | Pestilence and the natural order | Poison resisted by 50% | live |
| Sanguine | Revelry and indulgence | **hunger comes on half as fast** | **server, done** |
| Vaermina | Dreams and nightmares | You see as if dreaming | live |

**Sheogorath is the one worth noticing.** He is the only Prince whose boon is *more* lore-accurate as
code than as a record: the Madgod has no blessing of his own and hands over somebody else's, rolled
fresh every prayer. It needed no Creation Kit work at all, it is implemented, and the harness covers
it. `skills.json` marks him `capricious: true`.

**A useful accident:** `FortifyStaminaRateFFSelf` (`fb98b:Skyrim.esm`) is part of Bethesda's own shrine
family and **no shrine in the game uses it**. It went to Hircine - the hunt never tires - so that boon
needs a SPEL and nothing more.

**A shrine id may be a base or a reference, and both are deliberate.** Most name the base ACTI so every
statue of that god counts. The three activators authored on 2026-09-14 name their DBO base, which exists
only on the statues that pass placed. Meridia names one REFR on purpose - the Kilkreath activator -
because its base `DA09MeridiaStatue` also stands four times in `CYRCrowhavenBurialHalls` as scenery, and
scenery must not become a shrine. `prayer.js` indexes both and matches the reference first.

### Lawfulness, as data only

Every Prince and **Talos** now carry `lawful: false` and an `unlawfulWhere` line. Bruma is Imperial;
the White-Gold Concordat outlawed Talos, and Beyond Skyrim has already renamed the Great Chapel of
Talos to the **Cathedral of St Martin** for that reason. `prayer.js` says so once per character and
**nothing else happens** - no guard reads the flag. Whether the law has teeth is section 8.

## 6. Build order, by layer - what is done

1. **Data** (`skills.json`): **done.** Cyrodiil wayshrines on every Divine, `conversionCooldownDays: 7`,
   real blessing form ids, and a measured `placements` / `inPlaytest` / `inBruma` on every choice.
2. **Gamemode** (`server\prayer.js`, hot-reload): **done.** It sits in the `mp.onActivate` chain right
   after `__dboLabour`, and a target that is not a shrine `return false`s so the chain carries on - the
   lesson from `labour.js` and the memory note `gamemode-activate-chain-runs-before-systems`. A completed
   prayer emits `globalThis.__alduinakMasteryEvent('prayer', actorId, { refrId })`, which is all
   `masterySystem` needs to credit the Priest; no server rebuild was required for that half.
3. **Front** (`fork\skymp5-front\src\features\prayer`): **the prayer mini-game is done**, widget type
   `prayer`, id 35, built and deployed to both UI folders. It reports only the `[down, up]` spans of the
   key and the server replays the verse windows against them, so the widget cannot decide its own verdict
   (the competitive analysis's Tier 2 item 9). **The deity picker widget is NOT done** - `/deity <name>`
   at the shrine stands in for it.
4. **Client**: not needed. The relay passes a widget payload through verbatim (`dboRelayService`), so a
   new widget type needs no client rebuild; the key is held in the browser, not in the engine.

**Unverified in play.** Nobody was online when this was built. Everything above is covered by
`server\tests\prayer-harness.js` (37 checks, all passing) but nothing has been knelt at.

## 7. Placing the hidden shrines - the Creation Kit pass

Nat is placing hidden Daedric shrines through Cyrodiil. This is what the load order already gives you,
what has to be made, and what the server needs afterwards. Everything here is measured
(`py ck-mcp\daedricsites.py`, `server\daedric-sites.json`).

### What Beyond Skyrim has already built

- **Namira's shrine is finished and dressed.** `CYRNamirasShrineExterior`, `BSHeartland.esm:0A009B`,
  grid **(23, 47)**, 99 references placed: snow, bone piles, cobwebs, red-eye lights, evil cairns.
  The shrine itself is `CYRMountainCliffNamira` (`BSHeartland.esm:0AB529`) at
  **[95612.3, 195219.2, 3297.2]** - and it is a **STAT**, so nothing can activate it. It needs an
  ACTI standing at it and nothing else. This is the cheapest shrine in the entire list.
- **An Azura statue stands in the open world**: `CYRStatueAzuraSnow` at **[198151.7, 178842.1, 1872.6]**.
  Same situation - a statue, not an activator.
- `CYRShrineMephalaTEMP` is placed nine times inside `CYRNagastaniSilaseli`, an Ayleid ruin. The
  "TEMP" in the editor id suggests Beyond Skyrim means to replace it.
- Nothing else. There is no Daedric shrine **activator** anywhere in Beyond Skyrim Cyrodiil.

### What to make

An activation prompt only appears on an activatable record, so every shrine needs an **ACTI**; a STAT
cannot be prayed at. Two ways, and the first is much less work:

1. **Reuse the vanilla shrine activator** for the five Princes that have one - `ShrineOfNocturnal`,
   `DLC2ShrineAzura`, `DLC2ShrineBoethiah`, `DLC2ShrineMephala`, `ShrineOfMalacath`
   (`DragonBreak.esp:005DB6`). Place the existing ACTI; nothing to author.
2. **A new `DBO_ShrineOf<Prince>` ACTI**, exactly as the 2026-09-14 pass did for Hircine, Sanguine
   and Sheogorath (`DragonBreak Online Edits.esp:1112C5 / 1112C8 / 1112CB`). Copy one of those three -
   they are already the right shape - point it at whatever mesh suits, and place it.

### After placing, three steps or the server will not see it

1. Add the id to that deity's `shrines` list in `server\skills.json`. **Name the base ACTI** so every
   statue of it counts, or **name a single REFR** to claim one statue and not its neighbours -
   `prayer.js` indexes both and matches the reference first. Meridia is named by reference on purpose
   because her base also stands as scenery in Crowhaven.
2. **Copy the plugin into both `server\data\` and `Skyrim Special Edition - dev\Data\`, with node
   stopped.** They are separate copies, not a junction, and the running server memory-maps its one.
   Skipping this is the single most common way a plugin change appears not to work.
3. Restart the server, then `py ck-mcp\shrines.py` to refresh `shrine-placements.json` and
   `inBruma`. The boot line reports the roster: `prayer on: 26 deities, N shrine ids, M reachable`.

Vanilla activation of a shrine is blocked automatically the moment its id is in the list - `prayer.js`
takes the activation and returns, so no vanilla blessing fires.

### Where, in lore

Cyrodiil's Daedric shrines are **Oblivion's fifteen**, and that is the roster `skills.json` now
carries. Only Bruma county is released and walkable, so hidden shrines have to sit in the Jerall
Mountains and the county's woods whatever their Oblivion positions were - Namira's is already there,
in the snow at grid (23, 47), which is a good indication of the register Beyond Skyrim is working in.
**Jyggalag has no shrine and should not get one**: he was Sheogorath until the Greymarch ended and
has walked free since, but he has no cult and no worshippers in 4E 201. He is the one entry in this
whole list that lore actively forbids.

## 8. Decisions still needed from Nat

- ~~**Which Daedric Princes are pickable.**~~ **Answered: all of them.** Nat is placing hidden shrines
  through Cyrodiil, so the roster is the canonical sixteen rather than whoever had a statue, and the
  picker greys out a god by `inBruma` rather than by omission. Nothing to decide.
- ~~**What a Daedric blessing does.**~~ **Designed and fully closed, section 5.** Every Prince has a
  boon grounded in their sphere, **no deity needs a new magic effect**, and none of them rests on a
  stat this server does not run. The two decisions left open this morning - Molag Bal's absorb-health
  and Mehrunes Dagon duplicating Malacath - both dissolved once the alchemy-family effects turned out
  to be usable in a shrine spell. ~~What remains is labour, not design: eight pending SPELs to
  author.~~ **Those are written too** - eleven of them in the end, at `1209BF-1209C9`, plus Unarmed's
  five markers at `1209CA-1209CE` in the same sitting. Nothing about the boons is outstanding.
- **Whether a Daedric devotee is lawful** - the only one of the original three still fully open.
  `lawful: false` and `unlawfulWhere` are now written onto every Prince **and onto Talos**, and
  `prayer.js` warns the worshipper once and does nothing else. `private.dboLawful` exists and the
  guards read it. Wiring the two together is a faction decision, not a prayer one: it would make
  Talos worship and Daedra worship into the first real crimes in the game, in the county where the
  Thalmor keep a Justiciar. That is a good story and a big change.
- **Hermaeus Mora's boon is the one worth building next**, and it is not a Creation Kit job. "What you
  read teaches you more" lands exactly on the Scholar skill and the reading mini-game this server
  already has - no other Prince's sphere maps onto an existing system that cleanly. It needs the read
  weight to be multiplied in `masterySystem`, which is a TS rebuild.
- **Should `praying.shrines` be deleted?** It is a nine-entry duplicate of the Divines' shrine lists and
  nothing reads it. It is now labelled as such rather than removed, because it is Nat's data.
