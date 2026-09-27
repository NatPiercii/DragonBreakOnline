# Realm Map terrain generator

`render.py` draws the terrain art for the Realm Map (`WAR_DESIGN.md` section 3): a shaded relief image of one worldspace,
read straight from the landscape in the plugins, and a JSON that maps game coordinates to image pixels. It draws no text
and no borders; the map window adds territories, names and icons on top.

## Running it

On CT 115 (plugins in `/opt/skyrim-data`), from the root of the `server` repo:

```
python3 tools/realm-map/render.py --crop-to-land      # Cyrodiil around Bruma (the in-game map): 16 px per cell -> out/bruma.*
python3 tools/realm-map/render.py --name bruma-24 --ppc 24
python3 tools/realm-map/render.py --world 3c:Skyrim.esm --name whiterun --centre 20000 -10000 --radius 10
```

| Option | Default | Meaning |
|---|---|---|
| `--world` | `a764b:BSHeartland.esm` | worldspace as `localid:Plugin`, the form the gameplay code already uses |
| `--centre X Y` | `57750 202700` (Bruma) | game position; the region is the cell holding it plus `--radius` cells on every side |
| `--crop-to-land` | off | drop the edge rows and columns of cells with no LAND; Bruma is then -4,30 .. 34,64 (624 x 560), since the worldspace ends north of Pale Pass. The front's `BRUMA_MAP.bounds` must match the new bounds in the JSON |
| `--radius` | `20` | so the default region is 41 x 41 cells (-6,29 .. 34,69) |
| `--ppc` | `16` | pixels per cell (4096 game units); 16 gives 256 units per pixel, 656 x 656 px for the default |
| `--zfactor`, `--ambient` | `1`, `0.45` | hillshade exaggeration, brightness of slopes turned away from the light |
| `--name`, `--out` | `bruma`, `tools/realm-map/out` | output base name and folder |
| `--data`, `--order` | `/opt/skyrim-data`, `<data>/loadorder.txt` | where the plugins and the load order are |
| `--check` | the six County Bruma places | places to print and mark in red on the debug image |

Python 3 standard library only (the PNG encoder is in the script). It takes about 7 seconds for the default region and
reads the plugins through mmap, so it does not load Skyrim.esm into memory. It exits 1 if the centre falls outside the
image or under water. `tools/` is in `.gitignore`: add new files here with `git add -f`.

## Output

- `out/<name>.png`: RGBA, north up. Hillshade lit from the north-west (azimuth 315, altitude 45) over a muted parchment
  ramp (olive lowland to pale peaks, scaled to the region's own 2nd..99.5th percentile of land height), water in slate
  blue that darkens with depth, a darker line along shores. Cells with no LAND record at all (past the edge of the
  worldspace's landscape) are fully transparent, so the dark UI shows through.
- `out/<name>-debug.png`: the same image with a white dot at every place with a marker in the region, red dots at the
  `--check` places, and a blue dot at `--centre`.
- `out/<name>.json`: `world`, `cellMin`, `cellMax`, `pixelsPerCell`, `unitsPerPixel`, `width`, `height`, `bounds` (game
  units), `affine`, `heightRange`, `landFrom` (LAND records used per plugin, the region plus one cell of margin), and
  `places`: each LCTN in the region with its map marker (or centre marker when it has none), its game and pixel
  position.

### The transform

```
pixelX = a*gameX + b*gameY + c        a = 1/unitsPerPixel, b = 0, c = -xMin/unitsPerPixel
pixelY = d*gameX + e*gameY + f        d = 0, e = -1/unitsPerPixel, f = yMax/unitsPerPixel
```

Pixel (0,0) is the top-left corner of the image (a pixel's centre is at +0.5), and game +Y (north) is up. For the default
Bruma image: `a = 1/256, c = 96, e = -1/256, f = 1120`, so Bruma's centre (57750, 202700) lands at pixel (321.6, 328.2),
on land (terrain 7622, water -14000 there).

## The format, as checked against the bytes

Each point below was read from `BSHeartland.esm` and `DragonBreak Online Edits.esp` on CT 115 (2026-09-26) and matches
UESP's `Skyrim Mod:Mod File Format` pages for LAND, CELL, WRLD and LCTN unless it says otherwise.

- **Form ids.** The top byte indexes the plugin's own `MAST` list; one past its end is the plugin itself. BSHeartland's
  masters are Skyrim.esm and BSAssets.esm, so the Cyrodiil world `BSHeartland` is `0x020A764B` in its own file and
  `0x0B0A764B` in DragonBreak Online Edits.esp (12th master). BSHeartland is not localized (no TES4 flag 0x80), so its
  `FULL` names are plain strings.
- **Records and groups.** 24-byte headers. Record flag `0x40000`: the body is a uint32 decompressed size and a zlib
  stream (the sizes match). A subrecord longer than 65535 bytes is preceded by `XXXX` holding its size.
- **World layout.** The top-level `WRLD` group holds each WRLD record followed by a group of type 1 labelled with its form
  id. Inside that: the world's persistent CELL (which carries `XCLC` 0,0 as well, so it must not be put on the grid) and
  its children (group 6 > group 8), then exterior blocks (group 4 > group 5), each CELL followed by group 6 > group 8
  (persistent refs) and group 9 (temporary refs, NAVM, and the LAND). Groups 6, 8 and 9 are labelled with their cell's
  form id. BSHeartland's Cyrodiil: 2380 exterior cells, 2379 LAND, cells x -4..63, y 30..64 (inside `NAM0`/`NAM9`).
- **CELL.** `XCLC` = int32 X, int32 Y (then flags). `DATA` flag `0x2` = has water; every cell in the Bruma region has it.
  `XCLW` = float water height (`0x7F7FFFFF` means none); 38 cells in the region have one (rivers and lakes), the rest use
  the world default.
- **WRLD.** `DNAM` = default land height -27000, default water height -14000. No `WNAM`, so no parent world to inherit
  land or water from. DragonBreak Online Edits.esp overrides the record but keeps these values.
- **LAND `VHGT`**: 1096 bytes = float anchor, 33 x 33 int8 deltas row-major, 3 bytes of padding. Row 0 is the south
  edge and column 0 the west edge. Each row's first vertex adds to the previous row's first vertex (the anchor for row 0),
  every other vertex to its west neighbour; the sums times 8 are game units. Checked two ways: the vertices neighbouring
  cells share agree for 99.8% of the whole world's seams (153,334 of 153,582), while the same test with rows or columns
  flipped fails 99.9%; and the 46 map markers in the world stand 3 to 56 units above the terrain this gives (quartiles;
  median 15).
- **Overrides.** Only DragonBreak Online Edits.esp lists BSHeartland.esm as a master, so it is the only plugin that can
  override this world. It overrides the WRLD record, 241 CELL records and the LAND of cells (14,50), (15,50), (14,51)
  and (15,51) just north of Bruma; only (14,50) changes heights (94 vertices, up to 104 units). The last plugin in load
  order wins (ESM-flagged plugins load first, as the engine sorts them).
- **LCTN `LCSR`**: 16-byte entries = LCRT, reference, the CELL or WRLD it is in, int16 grid **Y**, int16 grid **X**
  (UESP leaves the order open; Bruma's entry reads 49,14 and its marker stands in cell 14,49). Skyrim.esm's LCRT
  `0x10F63C` is `MapMarkerRefType` and `0x01BDF1` is `LocationCenterMarker`. The referenced markers are persistent
  REFRs; their `DATA` is position then rotation (6 floats). Aleswell has no map marker, only a centre marker, which is
  why the script falls back to it.

## Known limits

- 148 of the 88,599 seam vertices in the Bruma region disagree between neighbouring cells in BSHeartland itself (up to
  336 units, at a few dozen cell edges). The map uses whichever cell is written last; it does not show at 16 px.
- Water is one flat level per cell (`XCLW` or the world default). Water placed as objects (activators, meshes) is not
  drawn, nor are the `XCLC` "hide land quad" flags applied.
- Only heights are used: no landscape textures (`BTXT`/`ATXT`), vertex colours (`VCLR`) or normals.
- The colour ramp is scaled to each image's own height range, so two regions rendered separately do not match in
  colour. For the shipped map, render each worldspace (or one agreed region) in one run.
