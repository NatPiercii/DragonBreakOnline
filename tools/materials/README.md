# Material census tools

Read the plugins in load order with ck-mcp's esplib (pure Python, runs on CT 115) and report armor ratings and weapon
damage by material, with the plugin whose override sets each value. Used for BLACKSMITH_TIERS_PROPOSAL.md.

- `material_census.py <out.json>`: every ARMO/WEAP grouped by material keyword; armor by type (BOD2 +4) and slot
  (BOD2 mask), weapons by animation type (DNAM byte 0); the most common value, range, count and plugins per group;
  the Smithing perks (COBJ CTDA HasPerk, function 448) of the recipes per material. `--all` counts the enchanted
  variants too (the count of records an edit would touch).
- `canonical_sets.py`: the base game, DLC and Beyond Skyrim sets by editor id, final override.

Environment: `ESPLIB_DIR` (default `~/dragonbreak/ck-mcp`), `DATA_DIR` (default `/opt/skyrim-data`), `LOADORDER`
(default `~/dragonbreak/fork/deploy/skyrim-data/loadorder.txt`). A full run takes a few minutes; run with `nice`.
