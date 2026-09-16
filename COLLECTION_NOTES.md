# Nexus collection: what changes from DO revision 22 (2026-09-14)

Source: Vortex's local copy of the DO collection, `E:\Vortex Mods\skyrimse\Daedric-Online-768397-22-*\collection.json`
(124 mods, 95 plugins), compared with `server-settings.json` loadOrder (98 entries) and the plugins inside each
staged mod folder. "Server" below means the DragonBreak server load order.

## Remove entirely (their only plugins are not on the server)

| Collection mod | Plugin the server no longer has | Why |
|---|---|---|
| Mysticism - A Magic Overhaul | MysticismMagic.esp | magic drop 2026-09-13 |
| Mage Clothing Expansion + Mage Clothing Expansion - 3BA Uniboob | Mage Clothing Expansion.esp | magic drop |
| Moon Monk's Robes - 2K + Moon Monk's Robes 3BA | Kad_MoonMonkRobes.esp | magic drop |
| Nirn Necessities - SMP Accessories + Nirn Necessities - Non-HDT patch | evgnnsmpaccessories.esp | magic drop |
| Common Clothes ESP (NPC Level List Distribution...) + Common Clothes 1K Assets + Common Clothes and Armors 3BA Bodyslide + Common Clothes and Armors - HIMBO | CommonClothes.esp | cruft drop |
| Common Clothing Expansion + Common Clothing Expansion CBBE 3BA | Common Clothing Expanded.esp | cruft drop |
| Sentinel CBBE 3BA Bodyslide | Sentinel Bodyslide.esp | cruft drop |
| COTN Winterhold - Castle Interior Enhanced (ESP version) | COTN Winterhold - Castle Interior Tweaks.esp | cruft drop |
| Torches of Quality | Torches of Quality - Brighter. Warmer. Better..esp | cruft drop |
| CBPC - Physics with Collisions | (no plugin) | jiggle physics decision; the 32 CBPC files are parked in `_removed-client-mods` |
| Dark Hierophant Magic | Ghostlight.esl | not wanted (decision 2026-09-14 evening); spell VFX go back to vanilla |

## Keep the mod, but its FOMOD/plugin set must match the server

| Collection mod | Keep | Do not ship / disable |
|---|---|---|
| Sentinel - An Equipment Overhaul | Sentinel.esp, Sentinel - City Guards.esp (+ Master Plugin from Required Resources) | Sentinel - Priests and Acolytes.esp, Sentinel - More Craftable Equipment.esp |
| More Craftable Equipment | MoreCraftableEquipment.esp | MoreCraftableEquipment_CloaksandCapes.esp |
| Obscure's College of Winterhold | OCW_Obscure's_CollegeofWinterhold.esp, OCW_CellSettings, OCW_TGCoW_FEPatch, OCW_RLS_FEPatch | OCW_MaMO_FEPatch.esp (Mysticism patch) |
| CBBE 3BA (3BBB) | body meshes, RaceMenuMorphsCBBE.esp | 3BBB.esp (physics config; jiggle off) |
| Armory of the Dragon Cult | DragonPriestArmor.esp | DragonPriestArmorKP.esp (FOMOD option) |
| FNIS Behavior SE 7.6 | the tool and FNISBase (Pipe Smoking ships FNIS animations; XPMSE requires a behaviour engine; the dev Data carries FNIS_PipeSmoking_Behavior.hkx) | FNIS.esp (on disk in the dev install, disabled in Plugins.txt). Players must run FNIS after deploy: enable Vortex's "run FNIS on deployment", or ship the generated output as a mod in the collection |

A collection installs whatever the FOMOD choice produces, so re-run those installers with the right options
in the clean profile before publishing, or the plugins come back and the client's plugin check fails.

## Not in the collection but on the server (must be added, or shipped by the launcher)

- LostArk_Kamen.esp, [Kirax] Lost Ark Reborn Paladin Legendary.esp: third-party, arrived through the DO launcher
  package (the DO overlay assets). Check whether both are on Nexus with permissions; else the launcher carries them.
- DragonBreak.esp/.bsa, DragonBreak Online Edits.esp/.bsa, DragonBreak Hub/Dungeons/Whiterun/Built/Harvest.esp: ours,
  launcher only (decision 2026-09-14).

## Text to change on the collection page

- "Anniversary Edition required" -> base SE 1.6.1170 plus the four free creations (Fish, Survival, Curios,
  Rare Curios/AdvDSGS come with SE; the server order lists them). Decision 2026-09-14: no AE.
- Launcher name and link, server name.

## Everything else: keep as is

TDM, Precision, TrueHUD, SkyUI, MCM Helper, Skyrim Souls, Engine Fixes, Address Library, po3 Tweaks, SkyPatcher,
CrashLogger, Native EditorID Fix, Simple Dual Sheath, Skyrim Priority, SSE Display Tweaks, Actor Limit Fix,
Animation Queue Fix, OAR, FSMP (hair and cloaks), XPMSE, RaceMenu, CBBE, HIMBO (+ refits), BodySlide, Skysight,
Tempered Skins, KS Hairdos (+ Salt and Wind), Vanilla Hair Remake, Alt High Poly Head, Expressive Facegen /
Facial Animation, Brows, Beards, Eyes of Beauty, Improved Eyes, Eyes AO fix, Flawn's Argonians (+ CBBE, FVAR),
Feminine Grey Cat, JK's Skyrim + outskirts + Castle Volkihar, Capital Windhelm + CWE-JK, Whiterun Expansion (SurWR),
Great Cities set + patches, Cities of the North set + patch collections, Riften Expansion + JK patch, Notice Board,
Obsidian Weathers + CS, Relighting Skyrim, Moons and Stars, Sea Salt Deposits, Pipe Smoking, Immersive Armors
(+ 3BA bodyslide), Immersive Weapons, New Legion (base, textures, 3BA, HIMBO), Sentinel Required Resources +
HIMBO refit, Cloaks and Capes, Armors of the Velothi I/II (+ 3BA, HIMBO), Dragon Priests Retexture, Quality World
Map (+ Clear Skies), Crafting Categories, Community Shaders (client-only, optional), USSEP, SKSE.

## Added 2026-09-14 evening (fresh profile deployed to the Steam install)

Vortex deploys to `E:\Steam\steamapps\common\Skyrim Special Edition`; the dev copy in `DragonBreak Online Dev files`
is separate and shares only Plugins.txt. New mods are copied from the Vortex staging folders into the dev copy by hand.

Added to the server load order (both settings files) and to the dev copy:
- Beyond Skyrim: Bruma 1.6.4 (BSAssets.esm, BSHeartland.esm after _ResourcePack.esl; no separate DLC patch in 1.6.x).
  Its four BSAs (4 GB) live only on the client side; the server holds plugins only.
- Daedric Shrines - All in One 2K (man_DaedricShrines.esp, placed just before DragonBreak.esp so our plugins win).
- JK's Fort Dawnguard (ESL-flagged, after JK's Castle Volkihar.esp).
- More Craftable Equipment patches the reinstall produced: USSEP, Fish, BYOH Looms (ESL-flagged, after MoreCraftableEquipment.esp).
  All three patch mods we run, so they were kept rather than removed.

Still in the fresh profile and still to be removed from it and the collection: Mage Clothing Expansion (+3BA Uniboob),
Moon Monk's Robes (+3BA), Nirn Necessities (both), COTN Winterhold - Castle Interior Enhanced. Plugins to disable in the
profile: 3BBB.esp, FNIS.esp (Plugins.txt was rewritten from the server order, but the next Vortex deploy puts them back).

## Added 2026-09-14 evening: Journey to Baan Malur and Morrowind (i1.1.9b)

- Server load order: "Journey to Baan Malur.esp" (ESM-flagged, 114k records, masters include Fish and Rare Curios) and
  "Journey to Baan Malur - Dunmeth Pass.esp" (ESM+ESL) sit right after BSHeartland.esm in the masters block. Load order
  is now 107. Dev copy synced from the staging folders (2.5 GB: two BSAs plus 1,493 loose files, incl. SkyPatcher data,
  LOD settings and Papyrus scripts that do nothing under SkyMP).
- "Morrowind Map Fix.esp" is NOT in the load order. It only widens the Solstheim map bounds (MNAM) and renames the
  worldspace, and loading it last would revert DragonBreak's own Solstheim WRLD edits (FULL, XLCN, NAM2, NAM3, ZNAM).
  Its MNAM block was copied into DragonBreak Online Edits.esp by Edit Scripts\DBO_SolstheimMapData.pas
  (bounds 8,17..17,1 -> -64,-64..127,125). Remove the Map Fix from the profile and the collection.
- Overlap audit: no LAND or NAVM clash with any non-vanilla plugin; only the usual worldspace and persistent-cell
  record overrides, all resolved by load position. It also overrides three Azura-shrine cells' CELL records (b490,
  b491, b4b1); the shrine plugin loads later and wins.
- It bundles Armors of the Velothi meshes: 16 HDT-SMP xml files overlap, 12 differ. Keep the Velothi originals winning:
  in Vortex, set a rule "Armors of the Velothi Pt. I/II load after Journey to Baan Malur" (file conflict). The dev copy
  was restored to the Velothi versions. No overlap with the Daedric Shrines files.
- Players need bBorderRegionsEnabled=0 under [General] in Skyrim.ini or the border bounces them: add it in the
  collection's INI Tweaks tab. Set on this PC's shared Skyrim.ini on 2026-09-14 (backup beside it).
- Under SkyMP: NPCs, quests, ferries and scarab currency are inert. The ferry (Raven Rock / Cormaris / Baan Malur) needs
  gamemode gate doors; the land route east of Windhelm through Kalbthurz works as ordinary doors. Its creature set is
  usable as NPC-Spawns enemies for Morrowind dungeons.
