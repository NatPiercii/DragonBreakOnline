# Crafting tiers: the Cook's and the Blacksmith's recipes, the smithing manuals, tier 5 above tier 4

Nate, 2026-09-30: "go with your recommendations"; "keep the approved ladder"; "keep ebony at tier 4, stat wise it needs to
be less than tier 5, and tier 5 needs to be better"; smithing manuals, "do both, gives scholars more meaning".

Three things, applied on the PC in **one run of `tools/materials/DBO_BlacksmithTiers.pas`**, together with the Blacksmith
ladder (`tools/materials/BLACKSMITH_LADDER_README.md`):

1. **Recipes by tier.** Every recipe at the cooking pot, the oven, the Survival campfire, the forge and anvil, the
   Skyforge and the Dawnguard forge (1,695) loses its vanilla `HasPerk` conditions and gains `HasSpell(DBO_Skill_<skill>_T<n>)
   == 1`. masterySystem already grants a skill's markers T1..rank and takes them back on a respec, and the server's
   CraftService evaluates `HasSpell` itself, so a recipe above your rank is both hidden in your menu and refused if forged.
   Today no recipe carries a marker, and 1,054 forge recipes need vanilla perks that nobody on DragonBreak can get.
2. **Smithing manuals.** A forge recipe of a tier 2+ material also needs `HasSpell(DBO_Manual_<manual>) == 1`: your tier
   lets you work the metal, the manual shows you its recipes. 17 manuals (`manuals.tsv`), each an inert marker SPEL and a
   BOOK created in DragonBreak Online Edits.esp. Reading a book gives its marker for good: the gameplay side (Worker G,
   manuals.js), keyed on the book.
3. **Tier 5 out-stats tier 4.** `t4_below_t5.py` finds the tier 4 gear (glass, ebony, stalhrim, amber) above the tier 4
   ceiling and the tier 5 gear (Daedric, dragon, madness) below the tier 5 floor, per slot and weight class, in what the
   server counts. 49 records move (27 down, 22 up); `stat_clamps.tsv`. Three `weaponMaterials` lines in
   gamemode-config.json give Madness, Amber and Immersive Weapons' Dragonsteel their material's damage bonus.

## Files

| File | What it is | Edit it? |
|---|---|---|
| `cook_tiers.csv` | every dish, its proposed tier and why, ingredients, effects | **yes**: the `tier` column |
| `forge_tiers.csv` | every forge recipe, tier, manual, how it was decided, `review` marks | **yes**: `tier` and `manual` |
| `forge_rules.tsv` | material keyword / editor id / perk -> tier and manual, on the approved ladder | yes, then `propose` |
| `manuals.tsv`, `manuals/*.txt` | the manuals: marker, book, title, value, canon source; the book texts | yes: titles and texts are drafts |
| `recipe_tiers.tsv` | what the PC script reads: origin, local id, recipe, tier marker, manual marker | **no**: `make_tables.py tsv` |
| `stat_clamps.tsv` | the tier 4 / tier 5 moves | **no**: `t4_below_t5.py --write` |
| `recipe_census.py` | every recipe at those stations, decoded, from the server's load order | |
| `make_tables.py` | `propose <census>` refreshes the CSVs (keeps hand edits); `tsv` builds recipe_tiers.tsv | |
| `t4_below_t5.py` | the stats check; `--write` makes stat_clamps.tsv | |
| `verify_recipes.py` | the gate after the PC run; `--manuals-json` writes server/manuals.json for manuals.js | |
| `test_recipes.py` | self-test: the rules, the tables in step, and the gate against a simulated run | |

The tiers today: cooking 45 / 13 / 53 / 26 / 8 (a new Cook sees **31 dishes at the pot**, not 85); forge
238 / 427 / 262 / 251 / 372, 31 of them marked `review` in forge_tiers.csv (quest-locked Thieves Guild and Dark
Brotherhood sets from More Craftable Equipment, giant armour, curiosities: set them by hand).

The cook tiers follow skills.json's own names (Simple meals, Hearty meals, Feast dishes, Restorative dishes, Banquet fare
with long buffs): salt and one thing is 1; three or four ingredients 2; oven baking, Morrowind dishes, poisoner's dishes,
five ingredients or a rare catch 3; restore-over-time or potion-like effects 4; a Fortify of 5 minutes or more 5.
The forge tiers are the ones players read in skills.json: 1 iron, hide, fur, leather; 2 steel, silver, dwarven, elven,
chainmail, mithril; 3 orcish, steel plate, scaled, Nordic; 4 ebony, glass, stalhrim; 5 dragonbone, dragonscale, Daedric.

## Changing a tier or a manual

```
# on CT 115, in this branch
edit tools/recipes/cook_tiers.csv / forge_tiers.csv   (the tier and manual columns)
python3 tools/recipes/make_tables.py tsv
python3 tools/recipes/test_recipes.py
```

After a plugin changes (a new DLE, a new mod): `python3 tools/recipes/recipe_census.py /tmp/claude-nate-x/c.json` then
`make_tables.py propose` it; hand edits survive, new recipes get the proposal, gone ones are named. Re-run
`t4_below_t5.py --write` too.

## The PC run

Copy into xEdit's `Edit Scripts` folder, keeping `manuals\` as a folder:

```
tools/materials/DBO_BlacksmithTiers.pas   tools/materials/ladder.tsv
tools/recipes/stat_clamps.tsv             tools/recipes/recipe_tiers.tsv
tools/recipes/manuals.tsv                 tools/recipes/manuals/*.txt  -> Edit Scripts\manuals\
```

Then as the ladder README says: `DRY_RUN` first, read `DBO_BlacksmithTiers_result.txt`, then the real run. The dry run
should say, besides the ladder's own numbers:

- recipes that would get their tier gates: **1,695** (none are gated today); refused: **0** (no recipe has a HasPerk
  ORed with another condition); rows that matched no recipe: **0**
- manuals: **17**, all `(new)`
- tier 4 / tier 5 clamps among the ARMO/WEAP changes: **49**

**The recipe and manual writes have never run.** The dry run exercises the reading half only. The writes use xEdit's
usual calls (`Add(rec, 'Conditions', True)`, `ElementAssign`, `CTDA\Function` / `Parameter #1` / `Type` /
`Comparison Value`, `wbCopyElementToFile(..., True, True)` for the new records) and read every write back into the
PROBLEMS list, but if the live run lists PROBLEMS, do not ship its plugins: fix and run again on fresh copies.
Nexus Patches gains DragonBreak Online Edits as a master (the markers live there); it already loads after it.

## Prove it on CT 115, before deploy-plugins

```
python3 tools/recipes/recipe_census.py before.json                                   # before the PC run
# ... the PC run, the two plugins back to CT 115 ...
python3 tools/recipes/recipe_census.py after.json --replace "DragonBreak Online Edits.esp=<new DLE>" \
    --replace "DragonBreak Nexus Patches.esp=<new NEX>"
python3 tools/recipes/verify_recipes.py before.json after.json --dle <new DLE> --manuals-json server/manuals.json
python3 tools/recipes/t4_below_t5.py --replace "DragonBreak Online Edits.esp=<new DLE>" \
    --replace "DragonBreak Nexus Patches.esp=<new NEX>"          # must say "0 record(s) to move", exit 0
```

plus the ladder's own `verify_ladder.py`, the record-by-record xEdit diff, and the new-DLE probes (border REGN, 251 cells,
Aleswell/Caractacus markers).

## What ships with it (gameplay, not the plugin)

- gamemode-config.json `weaponMaterials`: Amber 0.13, Madness 0.2, `ArmorMaterialDragonplate` 0.3 (only weapons read
  it; Immersive Weapons tags its Dragonsteel weapons with that armour keyword). Harmless before the plugins land.
- Worker G's manuals.js (reading a manual -> its marker; who sells and drops them) and server/manuals.json from the gate.
- Players' existing crafted gear keeps what it has; recipes they knew only through vanilla perks were never craftable.

## For Nate

- The 17 manual titles and texts are drafts. Nine quote Thorbald's notes from *Forge, Hammer and Anvil* (Skyrim) word for
  word; Bonemold and Chitin rests on *Bone* (Tavi Dromio) and the *Bonemold Formula* (Dragonborn); Amber and Madness on
  Joften's Notes and Evethra's Journal (Saints & Seducers); the rest are new and say so in `manuals.tsv`.
- The 31 `review` rows in forge_tiers.csv.
- Dawnbreaker, the Rueful Axe, the Ebony Blade, Chillrend, the Mace of Molag Bal and Volendrung are not in artifacts.json;
  `t4_below_t5.py` leaves them alone as uniques, but loot does not.
