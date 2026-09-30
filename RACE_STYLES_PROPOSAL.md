# Race styles: craft your people's gear anywhere

Proposal only. Nothing is switched on. Nate, 2026-09-30: "certain gear is good to craft based of lore accuracy with race."

**The idea (race plus home province):** a crafter may make their own people's traditional gear in any province, as an exception to the
province rule. An Orc forges Orcish in Bruma, a Dunmer makes chitin and Tribunal armour there, a Redguard makes Alik'r
scimitars in Skyrim. Canon basis: the racial styles of Oblivion and Skyrim smithing, and ESO's racial motifs.

## 1. Race → styles

| Race | Styles it may craft anywhere | Why (canon) |
|---|---|---|
| Nord | Nordic (draugr, honed Nordic) | Ancient Nord smithing: Nordic carved steel, the draugr's own arms |
| Orc | Orcish | Orsimer forges: Orcish is the Orcs' own heavy style (Orsinium, the strongholds) |
| Dunmer | Morrowind: Tribunal, chitin, bonemold, Dunmer food | Chitin and bonemold are Dunmer craft; Tribunal plate and ashland food are Morrowind's |
| Redguard | Hammerfell: Alik'r, Redguard | Alik'r desert styles are Redguard work |
| Khajiit | Elsweyr | Khajiiti bows and dress |
| Bosmer | Valenwood | Bosmer bows, capes and leathers (Green Pact wood) |
| Altmer | Summerset, Elven | Aldmeri and Justiciar styles; elven steel is Altmer smithing |
| Imperial | Imperial, Colovian and Cyrodiil styles, Akaviri | Legion and Colovian smithing; Akaviri arms came through the Empire |
| Breton | none in our data | No Breton or High Rock family exists in the recipe tags. It could be added (Breton styles are in several mods) |
| Argonian | none in our data | No Black Marsh gear among the recipes (the An-Xileel arrow is already common) |

Not racial: materials (iron, steel, ebony, glass, dwarven, daedric, dragon) and uniforms (hold guards, Stormcloaks,
Blades, Companions). They stay with the province rule.

## 2. How it would work

- Config `regions.raceStyles`: `{ "nord": ["draugr", "draugrhoned"], "orc": ["orcish"], ... }`. The keys are the
  family tags `regions.json` already carries on every recipe (`c`). Off when empty.
- `regions.js recipeOk`: after the province check refuses, before the admin bypass, allow when the recipe's family
  is in the crafter's race list. The race comes from `appearance.raceId`, with a vampire race counting as its mortal
  race (the table supernatural.js already has). Beast forms can't craft anyway.
- A recipe tied to a place's bench (Skyforge, Dawnguard, Aetherium, the Dragonborn staff enchanter) stays tied to
  that bench.
- The refusal text for other races could name it: "Orcish is an Orc design; the smiths of Cyrodiil do not know it."

## 3. Dry run (current data, craft gate on)

In Bruma, 953 of 2051 creation recipes are refused. What each race would unlock there:

| Race | Unlocks in Bruma | Examples |
|---|---|---|
| Orc | 31 | Orcish bow, saber, buckler |
| Dunmer | 166 (250 with the Solstheim tag) | Tribunal armour, Cliffracer stew, Guar haunch (+ chitin, bonemold) |
| Nord, Nordic only | 6 | Nordic spear, Nordic war pick, scrimshaw bow |
| Nord, whole "skyrim" tag | 278 | also Bone Hawk amulet (Forsworn) and mod sets: too broad, see question 3 |
| Redguard, Khajiit, Bosmer, Altmer, Imperial | 0 | their styles are already allowed in Cyrodiil |

In Skyrim (500 refused), the same rule would unlock Imperial 131 (Colovian, Ayleid, Akaviri), Redguard 17
(Alik'r) and Khajiit 1. So in Bruma the rule matters for Orcs, Dunmer and Nords; in Skyrim, for Imperials, Redguards
and Khajiit.

## 4. Decisions (Nate, relayed 2026-09-30: "go with your recommendations")

1. **Race plus home province:** a race makes its style anywhere; anyone makes it inside its home province.
2. **Solstheim tag split:** Dunmer get chitin and bonemold; stalhrim, Nordic carved and Skaal go to Nords (the Skaal
   are Nords).
3. **Nord scope:** Nordic carved, Ancient Nord (draugr) and Skaal/stalhrim, not the whole "skyrim" tag (hold guard
   and Stormcloak gear is issued by the holds, not a racial craft).
4. **Imperials:** Imperial, Akaviri and Colovian, but not Ayleid (Ayleid gear stays on Cyrodiil's province rule).
5. **Food** never follows race.
6. **Bretons:** later, with High Rock content. Argonians have nothing yet either.

## 5. As built (branch regions-lore-families, waiting for Nate's confirmation in the building session)

- Config `regions.raceStyles`: race → rules `{ family, edid?, notEdid? }` on each recipe's `c` tag and editor id.
- `regions.js recipeOk`: after the province refuses and before the admin bypass; the race comes from
  `appearance.raceId`, with a vampire race counting as its mortal race. Cooking benches and place-bound benches
  (Skyforge, Dawnguard, Aetherium, the Dragonborn staff enchanter, the Ayleid well) never follow race.
- Dry run through the real code: **in Bruma** Dunmer +164 (Tribunal 142, chitin and bonemold 22), Nord +42 (Nordic
  6, stalhrim, Nordic carved and Skaal 36), Orc +31. **In Skyrim** Dunmer +164, Imperial +111 (Colovian and other
  Cyrodiil styles 107, Akaviri 4), Nord +36, Redguard +17, Khajiit +1.
- `tests/race-styles-harness.js`: one case per race, plus the Forsworn catch-all, food, Ayleid, a Nord vampire, and
  Bretons and Argonians.
