# Map marker icons for the Realm map

One transparent PNG per map marker type, named by the type number from the marker's REFR TNAM (for example `2.png` for
a town, `224.png` for Beyond Skyrim's castle). They are exported from the game's own `interface/map.swf` (the one that
wins in the load order: Beyond Skyrim's), so the Realm map shows the icons the game's map shows. Territories name their
type in server `territories.json` (`icon`); a type with no file here falls back to a coloured dot.
