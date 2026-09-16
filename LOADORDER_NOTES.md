# Load order notes for server-settings.json

Generated 2026-09-13 from the active client load order, updated the same evening after the magic drop
(`%LOCALAPPDATA%\Skyrim Special Edition\Plugins.txt`, 108 active plugins)
plus the 10 base-game masters. Order in the JSON = runtime order: master-flagged
files first, then the rest in Plugins.txt order. 111 entries after the magic drop.

## Done 2026-09-13: magic drop

Removed from DLE, server-settings.json and the dev Plugins.txt:
MysticismMagic.esp, OCW_MaMO_FEPatch.esp, Mage Clothing Expansion.esp,
Ghostlight.esl, evgnnsmpaccessories.esp, Kad_MoonMonkRobes.esp, RP_MagicPatch.esp.

DLE edits: five placed Mysticism items deleted (tomes for Conjure Ancestral
Guardian, Stormblast and Stendarr's Mercy, an Ash Rune staff, a Regeneration
scroll), then xEdit Clean Masters. Clean Masters strips every unreferenced
master, so DLE went from 72 masters to 48. The 21 extra masters it dropped
were never referenced; the 'zero refs' table below is now historical.
Backups: ckmcp-backups\DragonBreak Online Edits.esp.before-magic-drop-* and
%LOCALAPPDATA%\Skyrim Special Edition\Plugins.txt.bak-before-magic-drop-*.

No longer mastered by DLE, so now free to drop from the load order if the
rest of the pack does not need them: Sentinel - Master Plugin (Sentinel.esp
still needs it), CommonClothes, MoreCraftableEquipment_CloaksandCapes,
Sentinel - Priests and Acolytes, Sentinel - More Craftable Equipment,
RP_DungeonOpen, RP_JKWhiterun, Sentinel Bodyslide, Common Clothing Expanded,
COTN Winterhold - Castle Interior Tweaks, TGCotN Winterhold - JKs Skyrim patch,
COTN Morthal - CC - Fishing Patch, TGC Winterhold - Notice Board Patch,
COTN Morthal - Notice Board patch, Torches of Quality, OCW_CellSettings,
OCW_TGCoW_FEPatch, COTN Falkreath - JKs Skyrim - TGCF Patch,
COTN Falkreath - CC - Fishing Patch, OCW_RLS_FEPatch,
Riften Expansion - JK's Skyrim Patch.

Rules the server imposes:

- Every file in `loadOrder` must exist in the server's `dataDir`, including
  client-only plugins (RaceMenu, SkyUI, CBBE, hair, eyes). The server needs them
  so FormID indices line up with the client. It ignores record types it does
  not understand.
- Client and server order must be identical. Change one, change both.
- `offlineMode: true` is for local testing only. Set it false and fill in
  `masterKey` before going public.

## Files not in this dev install's Data folder

Parked by the DO launcher in
`Skyrim Special Edition - dev\_old-server-launcher-data\skymp-disabled\files\Data\`
(copy from there if you keep them):

- RP_Nexus.esp, DragonBreak Built.esp, RP_CraftGates.esp, DragonBreak Harvest.esp
- LostArk_Kamen.esp, [Kirax] Lost Ark Reborn Paladin Legendary.esp

Nowhere on this machine (last three entries of the client order, nothing
depends on them, so they can simply be removed from both sides):

- RP_CraftGatesTail.esp, RP_NoNatives.esp, RP_MagicPatch.esp

## What blocks pruning: DragonBreak Online Edits.esp

DLE now lists 48 masters (was 72 before the magic drop). A plugin can only leave the load order if DLE (and any
patch) stops mastering it. "refs" below is an approximate count of FormID
references DLE makes into that master (byte scan, not xEdit, so treat as a
rough size of the job). 0 refs = xEdit "Clean Masters" on DLE drops it for
free. More refs = remove or repoint those records first, then clean masters.

### Magic (the group you asked about)

| Plugin | Who depends on it | DLE refs | Verdict |
|---|---|---|---|
| MysticismMagic.esp | DLE, OCW_MaMO_FEPatch | ~5 | Droppable with a small DLE edit. Remove OCW_MaMO_FEPatch with it. |
| RP_MagicPatch.esp | nothing | n/a | Missing anyway. Was almost certainly DO's Mysticism tuning. Drop. |
| Ghostlight.esl | nothing | 0 | Drop freely. |
| Mage Clothing Expansion.esp | DLE | 0 | Clean Masters on DLE, then drop. |
| evgnnsmpaccessories.esp | nothing | 0 | Drop freely (enchanted accessories). |
| Kad_MoonMonkRobes.esp | nothing | 0 | Drop freely. |
| OCW_MaMO_FEPatch.esp | DLE | ~55 (suspect, 1 KB file) | Goes with Mysticism. Verify in xEdit. |

Note: TrueDirectionalMovement, Precision, Obsidian Weathers and PipeSmoking
carry MGEF/SPEL records but are not magic mods. Leave them.

### DO's own RP plugins

| Plugin | Who depends on it | DLE refs | Verdict |
|---|---|---|---|
| RP_Nexus.esp (0 KB, empty header) | nothing | 0 | Drop. |
| DragonBreak Built.esp | nothing | 0 | Drop or keep; DO content. |
| RP_CraftGates.esp | nothing | 0 | Drop; the server gamemode did the gating. |
| DragonBreak Harvest.esp | nothing | 0 | Drop or keep. |
| DragonBreak Dungeons.esp | DLE | 0 | Clean Masters, then optional. |
| DragonBreak Whiterun.esp | DLE | 0 | Clean Masters, then optional. |
| DragonBreak Hub.esp | DragonBreak.esp, DLE | ~3 + ~1 | Keep. Both landscape plugins reference it. |

These are DO's files. Whether you may ship them on another server
is a question for whatever agreement you had with DO.

### Free to drop (nothing masters them, DLE has no refs)

Expressive Facegen Morphs.esl, TrueHUD.esl, RaceMenu.esp, RaceMenuPlugin.esp,
Precision.esp, TrueDirectionalMovement.esp, DIS_Heavy_Legion.esp,
MCMHelper.esp (needs SkyUI), IcePenguinWorldMap.esp, XPMSE.esp, CBBE.esp,
3BBB.esp, RaceMenuMorphsCBBE.esp, HIMBO.esp, RaceMenuMorphsHIMBO.esp,
KS Hairdo's.esp, Brows.esp, Beards.esp, TheEyesOfBeauty.esp,
Improved Eyes Skyrim.esp, Smooth Argonians.esp, AlternateHighPolyHead_SE.esp,
Hothtrooper44_Armor_Ecksstra.esp, IA CBBE Patch.esp, LostArk_Kamen.esp,
[Kirax] Lost Ark Reborn Paladin Legendary.esp, MoonsAndStars.esp,
Obsidian CS.esp (then Obsidian Weathers.esp), PipeSmokingSE.esp,
FlawnsArgonians - NPCs, Flawns Edits.esp, DragonPriestArmor.esp,
Armors of the Velothi.esp, Armors of the Velothi Pt2.esp.

Most of these are client-side character/UI mods. Dropping them changes the
player experience, not the world, so decide on gameplay grounds.

### Mastered by DLE with zero refs (Clean Masters removes the tie)

Cloaks&Capes.esp (also mastered by MoreCraftableEquipment_CloaksandCapes),
CommonClothes.esp, MoreCraftableEquipment_CloaksandCapes.esp,
Sentinel - Priests and Acolytes.esp, Sentinel - More Craftable Equipment.esp,
CWE - JK - United.esp, Mage Clothing Expansion.esp, TGCotN Winterhold.esp,
Torches of Quality.esp, OCW_TGCoW_FEPatch.esp, The Great City of Dawnstar.esp,
The Great City of Falkreath.esp.

Check each in xEdit before removing: a zero here means DLE does not point at
it, not that it is unused by other patches in the chain.

### Effectively locked in (heavy DLE dependence)

| Plugin | DLE refs |
|---|---|
| DragonBreak.esp | ~624 |
| The Great City of Winterhold v4.esp | ~530 |
| OCW_Obscure's_CollegeofWinterhold.esp | ~492 |
| The Great City of Rorikstead.esp | ~283 |
| COTN Falkreath - JKs Skyrim - TGCF Patch.esp | ~69 |
| WindhelmSSE.esp | ~57 |
| JKs Skyrim.esp | ~46 (plus 9 patches) |
| Sentinel.esp | ~44 (plus 4 dependants) |
| Immersive Weapons.esp | ~28 (Orc Clan set) |
| The Great Cities - Minor Cities and Towns.esp | ~28 |
| OCW_RLS_FEPatch.esp | ~26 |
| COTN Falkreath - CC - Fishing Patch.esp | ~20 |
| JK's Whiterun's Outskirts.esp | ~18 |
| SurWR.esp | ~16 |
| The Great City of Morthal.esp + its JK patch | ~16 each |

Everything else DLE masters sits under 10 refs and is a short xEdit session.

## Suggested pruning procedure

1. Decide the drop list.
2. In SSEEdit load DLE with the full order. For each plugin on the list,
   right-click DLE, Apply Filter for references to that master, remove or
   repoint the records, then Clean Masters.
3. Remove the plugin from both `Plugins.txt` and `loadOrder`.
4. Run Check for Errors on DLE. Fix anything that surfaces.
5. Start the server; it refuses to start if a master is absent.

## Done 2026-09-13, later: cruft drop

Dropped from server-settings.json and the dev Plugins.txt (nothing masters
them, and they are content, not patches): Sentinel - More Craftable Equipment,
Sentinel Bodyslide, Common Clothing Expanded, COTN Winterhold - Castle Interior
Tweaks, Torches of Quality.

Held back, and why:

- Sentinel - Master Plugin.esp: Sentinel.esp masters it. Cannot go while
  Sentinel stays.
- RP_CraftGates.esp also went: it mastered Kad_MoonMonkRobes and
  evgnnsmpaccessories, which left in the magic drop, so keeping it would have
  broken the order. With it gone, CommonClothes, MoreCraftableEquipment_
  CloaksandCapes and Sentinel - Priests and Acolytes were freed and dropped
  as requested. The two ghost entries that were never on disk
  (RP_CraftGatesTail, RP_NoNatives) were removed as well. Load order is now
  100 entries and every file in it exists on disk with all masters present.
- DragonBreak Dungeons.esp: 2283 overrides, only 85 of which DLE also carries.
  The other 2198 (1949 placed refs, 188 cells) are DO's dungeon-opening work
  and would revert. Its masters are Skyrim/Update/Dawnguard, a prefix of
  DLE's, so a scripted merge into DLE is possible before dropping it.
- DragonBreak Whiterun.esp: 1962 worldspace records, DO's Whiterun layout. Dropping
  it puts JK's Whiterun back to stock.
- Ten compatibility patches whose parent mods all remain: TGCotN Winterhold -
  JKs Skyrim patch, COTN Morthal - CC - Fishing Patch, TGC Winterhold - Notice
  Board Patch, COTN Morthal - Notice Board patch, OCW_CellSettings,
  OCW_TGCoW_FEPatch, COTN Falkreath - JKs Skyrim - TGCF Patch, COTN Falkreath -
  CC - Fishing Patch, OCW_RLS_FEPatch, Riften Expansion - JK's Skyrim Patch.
  "Not mastered by DLE" only means DLE does not point at their records; they
  still resolve conflicts between mods that are still loaded.
