# Blacksmith tiers: a lore-accurate ladder (proposal)

Nate, 2026-09-29: *"For Blacksmith. Purpose a lore accuracy with the tier system for how strong they are. Dont be
afraid to use xEdit to change numbers so they populate correctly."*

This is a proposal. Nothing changes until Nate picks. Every number below was read from the 105-plugin load order on
CT 115, using the last override of each record (census scripts under "How this was measured").

## The ladder at a glance

| Tier | Heavy armor | Light armor | Weapons |
|---|---|---|---|
| 1 Novice | Iron | Hide, Fur, Leather | Iron |
| 2 Apprentice | Steel, Dwarven | Chainmail, Mithril, Elven | Steel, Silver, Dwarven, Elven |
| 3 Journeyman | Orcish, Steel Plate, Nordic | Scaled | Orcish, Nordic |
| 4 Expert | Ebony, Stalhrim | Glass, Stalhrim | Glass, Ebony, Stalhrim |
| 5 Master | Dragonplate, Daedric | Dragonscale | Dragonbone, Daedric |

Within a tier, the strength order is as listed. Each tier is stronger than the one below it, with no inversions.

## What Nate has to choose

1. **The top of the ladder: Daedric or Dragon?** Vanilla disagrees with itself. Daedric armor (49 cuirass) beats
   Dragonplate (46), but Dragonbone weapons (sword 15) beat Daedric (14).
   - The Smithing tree makes Dragon the capstone: the Dragon Armor perk at 100 needs both Daedric and Glass.
   - Lore makes Daedric ebony bound with a Daedra's heart.
   - **Proposed:** both at Master, with vanilla's split kept: Daedric armor on top, Dragonbone weapons on top.
   - **Alternative:** Dragon on top everywhere, with Dragonplate at 50/19/19/24/37.
2. **Ebony: Expert or Master?** The Blacksmithing doc recorded "Ebony and Daedric at Master". skills.json has Ebony
   at Expert.
   - **Proposed:** Expert. Ebony Smithing is 80 in vanilla against Daedric 90 and Dragon 100. Putting Ebony at
     Master would leave Expert with only Glass and Stalhrim.
   - Ebony ore stays mineable only by a Master Miner either way (labour.js). That is a mining rule, not a smithing one.
3. **Dragonscale against Ebony.** Dragonscale is light armor (41 cuirass) and Ebony is heavy (43).
   - **Proposed:** keep separate ladders for heavy and light, as the game does. Light armor gives up protection for
     weight and stealth, so Dragonscale is the best light armor but below the best heavy.
   - **Alternative:** Dragonscale beats Ebony outright at 44/17/17/22/33. That is what the interim server override
     in increment 4 does today.
4. **Glass: Journeyman or Expert?** skills.json has Glass at Journeyman.
   - **Proposed:** Expert. Glass Smithing is 70 in vanilla, beside Ebony at 80, and in Morrowind and Oblivion Glass is
     the light-armor peer of Ebony.
5. **Orcish and Elven weapons.** Vanilla Orcish weapons (sword 9) sit below Dwarven (10) and Elven (11), although
   Orcish Smithing (50) comes after Dwarven and Elven (30). Orcish armor already follows the tree (40 against
   Dwarven 34).
   - **Proposed:** Orcish weapons +2 (sword 11) and Elven weapons −1 (sword 10). Say if you would rather leave the
     weapons alone.
6. **Nordic carved and Stalhrim heavy.**
   - Nordic heavy (43) equals Ebony, although it needs only Advanced Armors (50).
   - Stalhrim heavy (46) equals Dragonplate, although it needs only Ebony Smithing.
   - **Proposed:** Nordic 41 (Journeyman) and Stalhrim 44 (Expert, just above Ebony). Neither is reachable in Bruma
     today.
7. **Mithril and chainmail.** Beyond Skyrim has chainmail (30) above Mithril (27). Oblivion's canon order is
   Leather < Chainmail < Mithril < Elven.
   - **Proposed:** Chainmail 27 and Mithril 28, both below Elven 29.
8. **Silver.**
   - **Proposed:** one above Steel (sword 9, greatsword 18). Oblivion's weapon order puts Silver above Steel. Vanilla
     Skyrim silver matches Steel (8/17).
9. **Third-party sets that outrank the top.**
   - Saints & Seducers Madness armor is 52 heavy, above Daedric. Its Amber armor is 43 light, above Dragonscale.
   - Immersive Armors Daedric variants reach 50.
   - **Proposed:** each follows its own material's numbers (Madness to Daedric, Amber to Glass). The patches go in
     DragonBreak Nexus Patches.esp.

## Proposed numbers

Armor is listed as cuirass / gauntlets / boots / helmet / shield, with "–" where the set has no piece. Weapons are
listed as sword / dagger / war axe / mace / greatsword / battleaxe / warhammer / bow. **Bold** marks a change from
today's final records.

### Heavy armor
| Tier | Material | Now | Proposed |
|---|---|---|---|
| 1 | Iron | 25/10/10/15/20 | 25/10/10/15/20 |
| 2 | Imperial (DIS Heavy Legion) | 29/10/10/15/24 | 29/10/10/15/24 |
| 2 | Steel, Colovian/Nibenese steel | 31/12/12/17/24 | 31/12/12/17/24 |
| 2 | Bonemold | 32/12/12/17/21 | 32/12/12/17/21 |
| 2 | Dwarven, Dawnguard, Blades, Falmer Hardened | 34/13/13/18/26 | 34/13/13/18/26 |
| 3 | Steel Plate | 40/14/14/19/– | 40/14/14/19/– |
| 3 | Orcish | 40/15/15/20/30 | 40/15/15/20/30 |
| 3 | Nordic carved | 43/15/15/20/26 | **41**/15/15/20/**28** |
| 4 | Ebony | 43/16/16/21/32 | 43/16/16/21/32 |
| 4 | Falmer Heavy (Dawnguard) | 43/16/16/–/– | 43/16/16/–/– |
| 4 | Stalhrim | 46/17/17/22/– | **44/16/16/21**/– |
| 5 | Dragonplate | 46/17/17/22/34 | 46/17/17/22/34 (choice 1: 50/19/19/24/37) |
| 5 | Daedric | 49/18/18/23/36 | 49/18/18/23/36 |

### Light armor
| Tier | Material | Now | Proposed |
|---|---|---|---|
| 1 | Hide | 20/5/5/10/15 | 20/5/5/10/15 |
| 1 | Fur (BS), Studded | 23/5/5/11/– | 23/5/5/11/– |
| 1 | Leather, Colovian leather | 26/7/7/12/12 | 26/7/7/12/12 |
| 2 | Imperial light | 26/8/8/13/25 | 26/8/8/13/**21** |
| 2 | Chainmail (BS) | 30/8/8/13/– | **27/7/7/12**/– |
| 2 | Mithril (BS) | 27/8/8/13/20 | **28**/8/8/13/**21** |
| 2 | Elven, Dawnguard light | 29/8/8/13/21 | 29/8/8/13/21 |
| 2 | Chitin (Dragonborn) | 30/8/8/13/– | 30/8/8/13/– |
| 3 | Scaled | 32/9/9/14/– | 32/9/9/14/– |
| 3 | Elven Gilded | 35/–/–/–/– | 35/–/–/–/– |
| 4 | Glass | 38/11/11/16/27 | 38/11/11/16/27 |
| 4 | Stalhrim | 39/11/11/16/– | 39/11/11/16/– |
| 5 | Dragonscale | 41/12/12/17/29 | 41/12/12/17/29 (choice 3: 44/17/17/22/33) |

### Weapons
| Tier | Material | Now | Proposed |
|---|---|---|---|
| 1 | Iron | 7/4/8/9/15/16/18/7 (Hunting) | unchanged |
| 2 | Steel (Imperial bow) | 8/5/9/10/17/18/20/9 | unchanged |
| 2 | Silver | 8/–/–/10/17/–/–/– | **9/6/10/11/18/19/21**/– |
| 2 | Dwarven | 10/7/11/12/19/20/22/12 | unchanged |
| 2 | Elven | 11/8/12/13/20/21/23/13 | **10/7/11/12/19/20/22/12** |
| 3 | Orcish | 9/6/10/11/18/19/21/10 | **11/8/12/13/20/21/23/13** |
| 3 | Nordic | 11/8/12/13/20/21/23/13 | unchanged |
| 4 | Glass | 12/9/13/14/21/22/24/15 | unchanged |
| 4 | Ebony | 13/10/14/15/22/23/25/17 | unchanged |
| 4 | Stalhrim | 13/10/15/16/23/24/26/17 | 13/10/**14/15**/23/24/26/17 |
| 5 | Daedric | 14/11/15/16/24/25/27/19 | unchanged |
| 5 | Dragonbone | 15/12/16/17/25/26/28/20 | unchanged |

Stalhrim's war axe and mace came down so Daedric stays strictly above them. The weapons' server material bonus
(gamemode-config.json weaponMaterials) already follows this order and needs no change.

### Blacksmith tier text (skills.json)
1. Iron, hide, fur, leather
2. Steel, silver, dwarven, elven, chainmail, mithril
3. Orcish, steel plate, scaled, Nordic
4. Ebony, glass, stalhrim
5. Dragonbone, dragonscale, Daedric; legendary improvement

## Why each material sits where it does (lore)

- **Iron:** the first metal any smith works. It is Iron and Steel in every Elder Scrolls game.
- **Hide, Fur:** untreated skins, a hunter's first armor.
- **Leather:** tanned hide. It is the base light armor in Morrowind, Oblivion and Skyrim.
- **Steel:** iron refined. It is the second rung in every game, and Steel Smithing is the first perk.
- **Imperial:** Legion issue, standard steel and leather made for many hands, not one hero.
- **Silver:** a soft precious metal worked mainly for its bane against undead and lycanthropes. In Oblivion's weapon
  order it comes just above Steel.
- **Dwarven:** Dwemer metal, harder than steel and taken from ruins. The Dwarven Smithing perk is at 30.
- **Chainmail:** rings of steel, above leather and below Mithril in Oblivion.
- **Mithril:** a light, bright alloy. In Oblivion it sits between chainmail and Elven.
- **Elven:** Altmer moonstone and quicksilver, the finest light armor below Glass. The Elven Smithing perk is at 30.
- **Chitin, Bonemold:** Dunmer materials from giant insect shell and bone set with resin. Morrowind puts them at the
  low-to-middle rungs.
- **Orcish:** orichalcum hammered in Orsinium. It follows Dwarven in the Smithing tree (perk at 50) and in Oblivion's
  heavy order.
- **Steel Plate, Scaled:** the Advanced Armors perk (50). This is steel worked to its limit.
- **Nordic carved:** Skaal-forged Nord steel, Advanced Armors in Dragonborn. It should not rival Ebony.
- **Glass:** malachite, the Altmer and Dunmer masterwork. It is the light-armor peer of Ebony in Morrowind and
  Oblivion, with its perk at 70.
- **Ebony:** rare dark volcanic ore, in myth the blood of Lorkhan. It is the top mortal metal, with its perk at 80.
- **Stalhrim:** Solstheim's enchanted ice, worked only with Ebony Smithing and an Atronach's blessing.
- **Daedric:** ebony bound with a Daedra's heart under a new moon. It is stronger than Ebony by its making (perk at 90).
- **Dragonbone, Dragonscale:** the remains of dragons, the Smithing capstone at 100 (needs Daedric and Glass), and
  Skyrim's legend.

## Where lore and today's numbers disagree

1. Daedric armor beats Dragonplate, but Dragonbone weapons beat Daedric (choice 1).
2. Orcish weapons sit below Dwarven and Elven, against the Smithing tree (choice 5).
3. Nordic heavy equals Ebony, and Stalhrim heavy equals Dragonplate, against the perks they need (choice 6).
4. Beyond Skyrim's chainmail sits above Mithril, against Oblivion (choice 7).
5. Silver matches Steel, where Oblivion put it one above (choice 8).
6. The Imperial light shield (25, from DIS Heavy Legion) is an Apprentice shield well above Elven's 21 and close to
   Glass's 27. Proposed 21.
7. Third-party sets outrank Daedric and Dragonscale (choice 9).
8. Glass sits at Journeyman in skills.json, but at the Expert rung by its perk and in Oblivion (choice 4).

## Today's values and where they come from (census)

Each value is from the last override in the load order. The main sources are Update.esm (which raised Orcish,
Dragonplate, Dragonscale, Daedric and Glass) and the Unofficial Patch.

| Material | Heavy/light | Values | Set by |
|---|---|---|---|
| Iron | heavy | 25/10/10/15/20 | Skyrim.esm, USSEP (shield) |
| Steel | heavy | 31/12/12/17/24 | Update.esm, Skyrim.esm (shield) |
| Dwarven | heavy | 34/13/13/18/26 | Skyrim.esm |
| Orcish | heavy | 40/15/15/20/30 | Update.esm, USSEP (shield) |
| Steel Plate | heavy | 40/14/14/19 | Skyrim.esm |
| Ebony | heavy | 43/16/16/21/32 | Skyrim.esm; BSHeartland CYR copy the same |
| Dragonplate | heavy | 46/17/17/22/34 | Update.esm, Skyrim.esm (shield) |
| Daedric | heavy | 49/18/18/23/36 | Update.esm, Skyrim.esm (shield) |
| Nordic carved | heavy | 43/15/15/20/26 | Dragonborn.esm |
| Stalhrim | heavy | 46/17/17/22 | USSEP |
| Hide | light | 20/5/5/10/15 | Skyrim.esm |
| Leather | light | 26/7/7/12 | Skyrim.esm |
| Elven | light | 29/8/8/13/21 | Skyrim.esm, USSEP (shield) |
| Scaled | light | 32/9/9/14 | Skyrim.esm, USSEP |
| Glass | light | 38/11/11/16/27 | Update.esm, USSEP (shield) |
| Dragonscale | light | 41/12/12/17/29 | Update.esm, USSEP (shield) |
| Stalhrim | light | 39/11/11/16 | Dragonborn.esm, USSEP |
| Mithril (BS) | light | 27/8/8/13/20 | BSHeartland.esm |
| Chainmail (BS) | light | 30/8/8/13 | BSHeartland.esm |

Weapons (sword / greatsword): Iron 7/15, Steel 8/17, Silver 8/17 (USSEP), Orcish 9/18, Dwarven 10/19, Elven 11/20,
Glass 12/21, Ebony 13/22 (set by DragonBreak Online Edits.esp), Stalhrim 13/23, Daedric 14/24,
Dragonbone 15/25. The rest are in the tables above.

The only silver armor in the load order is Silver Hand faction gear (Sentinel.esp TH_SilverHand*, Hothtrooper44
IAMantleSilverHand*). It stays out of the Blacksmith ladder.

## How to apply the numbers

**Records, not server tables.** The game engine and the inventory both read armor rating (ARMO DNAM, rating x 100)
and weapon damage (WEAP DATA, a u16 at offset 8) straight from the records. Correct records mean every place shows
the same number with nothing to compensate for. Once they are in, the interim `armorMaterials` block in
gamemode-config.json and its code in gamemode.js should go.

- **Where the edits go:**
  - Vanilla and DLC records (Skyrim, Update, Dawnguard, Dragonborn, USSEP winners) go into DragonBreak Online
    Edits.esp.
  - Third-party records (Beyond Skyrim, Immersive Armors, Saints & Seducers and others) go into DragonBreak Nexus
    Patches.esp. Never edit a mod's own file.
- **Every enchanted variant needs the edit too.** In Skyrim.esm, all 4,267 templated variants (ARMO TNAM, WEAP CNAM)
  carry their own copy of the value, equal to their template's. SkyMP's C++ reads the record's own value, so an
  enchanted Orcish sword keeps the old damage unless it is edited as well. Records per material in the load order,
  counting variants:

  | Material | Records |
  |---|---|
  | Orcish weapons | 264 |
  | Elven weapons | 322 |
  | Silver weapons | 24 |
  | Stalhrim weapons | 287 |
  | Nordic heavy armor | 105 |
  | Stalhrim heavy armor | 90 |
  | Dragonscale armor | 157 |
  | Mithril | 6 |
  | Madness | 6 |
  | Amber | 5 |

  That is roughly 1,100 overrides for the proposed set. This is a job for a script, not for hand edits.
- **Tool, option A: xEdit on Nat's PC.** A Pascal script walks each material's records and sets DNAM or DATA
  (the `-autoload -script:X.pas -autoexit` flow). A full xEdit save has changed 93 unrelated records before (memory
  xedit-resave-mutates-unrelated-records). So the output must be diffed record by record, with every record outside
  the change list byte-identical before shipping.
- **Tool, option B: a byte-level writer on CT 115.** The ck-mcp scripts already edit plugins at the byte level
  (`edits.py`, `add_records.py`, `merge_into_dle.py`, all esplib-based), but none of them can write overrides. For
  that we would build `override_values.py`. It would copy each winning record into DLE or Nexus Patches, remap its
  form ids by plugin name the way merge_into_dle does, patch only the 4-byte DNAM or the 2-byte damage, and prove
  that every other record is byte-identical. It runs on Linux. Two cautions:
  - A third-party record needs its plugin as a master of Nexus Patches. Adding masters shifts the file's own index
    (memory merging-into-dle-needs-sseedit), so that part is safer in xEdit.
  - DLE builds from the PC have dropped server-side patches before (memory pc-dle-builds-drop-server-side-patches).
    The edits must end up in the PC's copy of DLE too.
- **Shipping:** plugins reach players only through `deploy-plugins` from the PC. That updates /opt/skyrim-data,
  SHA256SUMS and the launcher's extra files, and the client and server load orders must match. Then restart for
  skills.json.
- **Recommended path:**
  1. Nate picks the choices above.
  2. xEdit on the PC for the third-party records (Nexus Patches) and the DLE edits, or override_values.py on CT 115 for the vanilla
     ones if the PC is busy.
  3. Diff proof.
  4. deploy-plugins.
  5. Remove the armorMaterials override.
  6. Update the skills.json tier text.
  7. Patch note.

## How this was measured

On CT 115, 2026-09-29, with ck-mcp/esplib reading /opt/skyrim-data in fork deploy/skyrim-data/loadorder.txt order:
- **Census:** a script keyed every ARMO, WEAP, KYWD, COBJ and PERK record by (source plugin, local id) through
  modindex_source and kept the last override. It grouped armor by material keyword, armor type (BOD2 at offset 4) and
  slot (BOD2 mask), and weapons by keyword and animation type (DNAM byte 0).
- **Perks:** Smithing perks came from the recipes' HasPerk conditions (CTDA function 448).
- **Canonical sets:** these were read by editor id from the final records.
- **Beyond Skyrim sets:** these were read from the CYRArmor* and CYR* weapon records.
- **Templated variants:** checked against their templates in Skyrim.esm: 4,267 equal, 0 different.
