# Map marker icons for the Realm map

One transparent PNG per map marker type, named by the type number from the marker's REFR TNAM (for example `2.png` for
a town, `224.png` for Beyond Skyrim's castle). They are exported from the game's own `interface/map.swf` (the one that
wins in the load order: Beyond Skyrim's), so the Realm map shows the icons the game's map shows. Territories name their
type in server `territories.json` (`icon`); a type with no file here falls back to a coloured dot.

## What is here

| File | Marker type | Place | Source |
|---|---|---|---|
| `224.png` | 224 | Castle Bruma (County Bruma's capital) | export `BS224` |
| `102.png` | 102 | Bruma | export `BS102` |
| `2.png` | 2 | Applewatch (town) | `mapMarkerArt.swf` export `Town` |
| `3.png` | 3 | Greenwood (settlement) | `mapMarkerArt.swf` export `Settlement` |
| `6.png` | 6 | Pale Pass (fort) | `mapMarkerArt.swf` export `Fort` |

Both come from Beyond Skyrim's marker art in `MapMarkers/Resources/bsresources01.swf` (the map marker framework files
the launcher already installs; Nate's PC sent the same bytes, 2026-09-27), exported with JPEXS FFDec 26.3.0:
`ffdec-cli.jar -selectid <sprite ids> -format sprite:png -zoom 1.2 -export sprite <out> bsresources01.swf` (48 x 48).
`bsresources01.swf` / `02.swf` hold Beyond Skyrim's types 67..511 only; the vanilla types (2 town, 3 settlement, 6 fort)
are placeholders there and come from `interface/SkyUI/mapMarkerArt.swf` (the same map marker framework mod, sha256
b30c61e2..., what the launcher installs). Its sprites run in marker type order (City00, Town, Settlement, Cave, Camp, Fort,
Nordic Ruin... as character ids 4, 6, 8, ...), so type N is character id 2N+2; exported the same way at zoom 1.2.
