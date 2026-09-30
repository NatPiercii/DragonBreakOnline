# Place tool importer (drop 2e)

Bakes what GMs placed with the F7 Place tool into `DragonBreak Online Edits.esp` as real references (REFR), at the
byte level, and proves nothing else in the plugin changed. It extends `ck-mcp/add_records.py`'s approach; it doesn't
use xEdit, whose re-save has changed unrelated records before.

## On the PC

1. On the server, a GM types `/placeexport`. It writes `placements-export.json` beside the gamemode.
2. Copy that file and `place_import.py` to the PC. The script needs only Python 3, no ck-mcp imports.
3. Close xEdit, the Creation Kit and the ck-mcp MCP (they hold the plugin), then dry-run:

       py place_import.py --plugin "<Data>\DragonBreak Online Edits.esp" --data "<Data>" --export placements-export.json --out "<Data>\DLE.new.esp" --report report.json --dry-run

4. Read the skipped list, then run without `--dry-run`. It ends with
   `ok: N records unchanged, M added, ...` or stops with `VERIFY FAILED`.
5. Open the new file in xEdit read-only and spot-check a placed reference. Then replace the plugin, and deploy it the
   usual way (`deploy-plugins`, SHA256SUMS, the release zip).
6. Once the new plugin is live, remove the server's runtime copies in the Place tab (the report lists each import), or
   every object stands twice.

## What it does and refuses

- **Objects only.** Placed NPCs stay server zones (the server spawns all living actors).
- **Bases** must come from a plugin that's already a master of DLE (52 today), or from DLE itself. A new master would
  shift DLE's own form ids. Non-placeable records (an NPC_ picked as an object) are refused.
- **The cell:** an interior by its desc, a worldspace by the grid cell of the position (4096 units). A cell DLE
  doesn't override yet is copied from the last master that has it. Its form id fields are converted to DLE's master
  numbering (the list was measured on 401 cells DLE already overrides), and a cell with an unknown subrecord is refused
  rather than guessed at. Block and sub-block rules were measured on all 911 of DLE's cells.
- **Rotation:** degrees in, radians in DATA (the server reads DATA as radians × 180/π).

## Tested on CT 115 (2026-09-30) against the live DLE, output to scratch

7 sample placements: 4 imported and 3 refused (an NPC, a base from Beards.esp, an NPC_ picked as an object). The
imports covered an overridden interior (IceWind Traders), a new interior cell, an overridden Bruma grid and a new Bruma
grid. The importer's own proof passed: 29936 records unchanged, 6 added, 4 groups. The esplib check agreed:
- the HEDR count equals the records and groups in the file;
- every new REFR sits in its cell's temporary group, in the right world, with base, position and rotation as given;
- both copied cells match their Beyond Skyrim originals field by field after id conversion, in the right block and
  sub-block.

Not yet tested in game. The next check is loading the new plugin on the server and the client.
