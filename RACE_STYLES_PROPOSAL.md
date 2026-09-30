# Race styles: craft your people's gear anywhere

Proposal only. Nothing is switched on. Nate, 2026-09-30: "certain gear is good to craft based of lore accuracy with race."

**The idea:** a crafter may make their own people's traditional gear in any province, as an exception to the
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

## 4. Questions for Nate

1. **An exception, or exclusive?** Proposed: an exception (a Nord smith in Skyrim and an Orc anywhere both make
   Orcish). The alternative: ONLY that race makes its style, everywhere, which would also refuse Orcish to a Nord in
   Skyrim.
2. **Dunmer and the "solstheim" tag:** it mixes Dunmer chitin and bonemold with Skaal stalhrim. Give Dunmer only
   the Morrowind styles (166), or split the tag so chitin and bonemold are Dunmer and stalhrim is Nord (Skaal)?
3. **Nord scope:** only the Nordic/draugr styles (6), or everything tagged "skyrim" (278, which also holds Forsworn
   and several mod armour sets)? A proper "nordic" tag in the generator would be the lore-accurate answer.
4. **Imperial and Ayleid:** Ayleid arms are ancient Cyrodiil work, not Imperial; include them for Imperials?
5. **Food:** should cooking follow race too (Dunmer ashland dishes anywhere), or only gear?
6. **Bretons and Argonians** have nothing: add a Breton family (High Rock styles from the mods), or leave them out?
