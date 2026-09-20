# DragonBreak Online: deities, shrines and prayer

**Status:** built, 2026-09-20 11:00. Written as design at 03:10 from Nat's brief; sections 3 to 7 were
then **corrected against measurement** when the thing was actually built, because three of the claims in
them were wrong. The corrections are marked. `server\prayer.js` is the implementation, its harness is
`server\tests\prayer-harness.js`, and the shrine census it rests on is `server\shrine-placements.json`
(regenerate with `py ck-mcp\shrines.py`).

**Still open, all in section 7**: which Princes are pickable, what a Daedric blessing does, whether
Daedric worship is unlawful in Imperial Bruma.

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
`deityMenu` -> client `deityChoose`, stored per character"*) and carries the nine Divines with their shrine
form ids and `BlessingOf*` spells.

**The `prayer` event kind is already wired**: `masterySystem` does `add("prayer", "priest")` in its candidate
map and `matches()` has a `case "prayer"`. Nothing emits it yet.

## 3. The three changes the brief actually asks for

1. **Conversion cooldown: 30 days -> 7 days.** Done, `deities.conversionCooldownDays: 7`. The brief
   also moves conversion off `/convert`-at-a-shrine and onto **a menu key**, so this is a front widget
   (a deity menu) and is **not built**; `/deity <name>`, said while standing at that god's shrine, is
   the stopgap. "Current blessing removed on conversion" is implemented and covered by the harness.
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
| **every Daedric Prince** | — | — | **0** |

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

## 5. Daedric shrines - eleven Princes are pickable, none is reachable

~~The other twelve Princes have no shrine activator in this load order.~~ **Corrected.** Eleven Princes are
in `deities.choices` and all but Mehrunes Dagon and Molag Bal have at least one placed shrine somewhere:

| Prince | shrine id in skills.json | placed | in Bruma |
|---|---|---|---|
| Malacath | `5db6:DragonBreak.esp` ShrineOfMalacath | 10 (all Skyrim strongholds) | 0 |
| Boethiah | `39e34:Dragonborn.esm` | 8 | 0 |
| Azura | `3a484:Dragonborn.esm` | 7 | 0 |
| Mephala | `3a481:Dragonborn.esm` | 4 | 0 |
| Nocturnal | `10e8b0:Skyrim.esm` | 2 | 0 |
| Hircine | `1112c5:...Edits.esp` DBO_ShrineOfHircine | 2 | 0 |
| Sanguine | `1112c8:...Edits.esp` | 2 | 0 |
| Sheogorath | `1112cb:...Edits.esp` | 1 | 0 |
| Meridia | `4e4d6:Skyrim.esm` (a REFR, deliberately) | 1 | 0 |
| Mehrunes Dagon | `bf2b6:Skyrim.esm` MehrunesDagonAltar01 | **0** | 0 |
| Molag Bal | `c7b72:Skyrim.esm` AltarOfMolagBal01 | **0** | 0 |

So the real recommendation stands, for a different reason than the one first written: **under the region
lock only the Divines can be prayed to.** Nothing needs restricting in the data - the picker can simply
grey out any choice whose `inBruma` is 0, which every entry now carries.

**A shrine id may be a base or a reference, and both are deliberate.** Most name the base ACTI so every
statue of that god counts. The three activators authored on 2026-09-14 name their DBO base, which exists
only on the statues that pass placed. Meridia names one REFR on purpose - the Kilkreath activator - because
its base `DA09MeridiaStatue` also stands four times in `CYRCrowhavenBurialHalls` as scenery, and scenery
must not become a shrine. `prayer.js` indexes both and matches the reference first.

**Blessings: there is no `BlessingOf*` record anywhere in this load order.** The vanilla shrine blessing is
`Altar<Deity>Spell`, and fifteen of the twenty-one deities have a real one, now written into
`deities.choices[].blessing` as a form id with the editor id beside it:

- Divines: `fb988` Akatosh, `fb994` Arkay, `fb995` Dibella, `fb996` Julianos, `fb997` Kynareth,
  `fb998` Mara, `fb999` Stendarr, `fb99a` Talos, `fb99b` Zenithar (all `Skyrim.esm`);
  `11360:Dawnguard.esm` Auri-El.
- Princes: `5db8:DragonBreak.esp` Malacath, `10e8ae:Skyrim.esm` Nocturnal, `3bcfb`/`3bcfc`/`3bcfd`
  `:Dragonborn.esm` Azura / Boethiah / Mephala.
- **No spell**: Mehrunes Dagon, Molag Bal, Meridia, Hircine, Sanguine, Sheogorath. A prayer to one of
  these still succeeds and still credits the Priest; the roll lands on "gives no sign" and logs it.

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

## 7. Decisions still needed from Nat

- **Which Daedric Princes are pickable.** Nine of the eleven have a shrine somewhere, **none has one in
  Bruma county**, so today the Daedric half of the picker offers gods nobody can reach. Three ways out,
  and no code changes for the first: (a) grey out any choice whose `inBruma` is 0 and let the Princes
  arrive with Skyrim; (b) place Daedric shrines in the Bruma wilds as a plugin pass - Malacath first,
  which pairs with the Orsimer work in `RACES_DESIGN.md`; (c) let a player pick a Prince they cannot
  pray to, as a statement of allegiance with no mechanical return until Skyrim opens. **(a) is the
  recommendation**; (c) is defensible roleplay and costs nothing.
- **What a Daedric blessing does** for the six with no `Altar<Name>Spell`: Mehrunes Dagon, Molag Bal,
  Meridia, Hircine, Sanguine, Sheogorath. Either new SPEL records (one xEdit pass, the same one that
  owes Unarmed its five marker spells) or a reuse of an existing ability, decided per Prince. Until
  then the prayer succeeds and says so honestly.
- **Whether a Daedric devotee is lawful.** `private.dboLawful` already exists and the guards read it;
  openly worshipping a Prince is a crime in the Empire, and Bruma is Imperial. Nothing has been wired:
  `prayer.js` does not touch `dboLawful`, deliberately, because this is a faction decision and not a
  prayer decision. It is a bigger design question than the picker itself.
- **Should `praying.shrines` be deleted?** It is a nine-entry duplicate of the Divines' shrine lists and
  nothing reads it. It is now labelled as such rather than removed, because it is Nat's data.
