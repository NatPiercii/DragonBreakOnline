# Applying the Blacksmith ladder (for the PC session)

Nate approved every default in `BLACKSMITH_TIERS_PROPOSAL.md` **except choice 3**: Dragonscale beats Ebony outright,
light cuirass **44/17/17/22/33**, which is what the interim `armorMaterials` server override counts today.

Everything here is read-only on CT 115. **The run happens on Nat's PC**, because only xEdit can add the masters a
third-party override needs without breaking a plugin's own index (memory `merging-into-dle-needs-sseedit`).

## Files

| File | What it is |
|---|---|
| `ladder.tsv` | **The values. One source of truth.** Edit this, never the script. |
| `DBO_BlacksmithTiers.pas` | The xEdit script. Reads `ladder.tsv`, sets ARMO `DNAM` and WEAP `DATA` damage, nothing else. |
| `verify_ladder.py` | The proof. Compares a census taken before with one taken after and fails on any other movement. |
| `material_census.py` | Worker C's census, now splitting battleaxe from warhammer (see below). |

## Run it

Put `DBO_BlacksmithTiers.pas` **and `ladder.tsv`** together in xEdit's `Edit Scripts` folder. Since 2026-09-30 the same
run also sets the recipe tiers, creates the smithing manuals and moves tier 4 gear below tier 5: it needs
`tools/recipes/stat_clamps.tsv`, `recipe_tiers.tsv`, `manuals.tsv` and the `manuals\` folder beside it too. See
`tools/recipes/README.md`, which also has what the dry run should say for those parts.

```
SSEEdit64.exe -IKnowWhatImDoing -autoload -script:DBO_BlacksmithTiers.pas -autoexit ^
  -D:"<dev Data>" -P:"server\plugins.server.txt"
```

`-D` and `-P` are not optional: without them Vortex's load order is used instead of the server's
(memory `vortex-rewrites-plugins-txt-while-running`). Close Vortex first.

**`DRY_RUN` is `True` in the script. Run it once as it is.** It changes nothing and writes
`DBO_BlacksmithTiers_result.txt` beside SSEEdit64.exe listing every record it would touch, with the raw value it
found and the raw value it would write. Read that, check the numbers below, then set `DRY_RUN := False` and run again.

The result file is written whether or not the run saves, because a headless run that saves nothing must still leave
its result behind (memory `sseedit-runs-scripts-headless`). Watch for the leftover `.save` file if the Creation Kit
MCP is holding a plugin (memory `xedit-save-rename-fails-under-ck-mcp`).

## What the dry run should say

**1,039 records**, computed here from the census. If the dry run's count is wildly different, stop and ask.

| Material | Records | Material | Records |
|---|---|---|---|
| WeapMaterialElven | 322 | WeapMaterialSilver | 23 |
| WeapMaterialOrcish | 264 | ccBGSSSE025_WeapMaterialMadness | 8 |
| ArmorMaterialDragonscale | 157 | ccBGSSSE025_WeapMaterialAmber | 8 |
| DLC2ArmorMaterialStalhrimHeavy | 90 | ccBGSSSE025_ArmorMaterialMadness | 6 |
| DLC2WeaponMaterialStalhrim | 74 | ccBGSSSE025_ArmorMaterialAmber | 5 |
| DLC2ArmorMaterialNordicHeavy | 42 | IAKMaterialDaedric | 3 |
| IAKMaterialDragonScale | 34 | ArmorMaterialMithril | 2 |
| ArmorMaterialImperialLight | 1 | | |

Plus the Beyond Skyrim chainmail records matched by editor id, which the census cannot count separately (below).

## Where the edits go

- Origin **Skyrim, Update, Dawnguard, HearthFires, Dragonborn, USSEP** → `DragonBreak Online Edits.esp`.
- Everything else, **Creation Club included** (Saints & Seducers), and Beyond Skyrim, Immersive Armors →
  `DragonBreak Nexus Patches.esp`.
- A mod's own file is never opened for writing (memory `third-party-edits-go-in-nexus-patches`).
- A record already overridden by one of those two goes back into the same one, so a re-run is idempotent.
- **Records carrying a script (`VMAD`) are listed in the result file and left alone**, as asked: a script may read or
  set these values itself.

## Prove it, before `deploy-plugins`

A full xEdit save has silently changed 93 unrelated records before (memory `xedit-resave-mutates-unrelated-records`),
so this is the gate.

```
# on CT 115, before the PC run
python3 tools/materials/material_census.py before.json --all
# ... PC run, then the edited plugins back into /opt/skyrim-data ...
python3 tools/materials/material_census.py after.json --all
python3 tools/materials/verify_ladder.py before.json after.json tools/materials/ladder.tsv
```

Exit 0 means every ladder value landed and no other material/slot group moved. Exit 1 lists what is wrong. Exit 2
means only an editor-id rule's host group moved, which needs a human to read it.

It checks the whole of each group, not just its commonest value. A group whose most common rating is the ladder's but
whose range still spans something else is reported as `PARTIAL`: some records carry the keyword and were missed. That
is not hypothetical - before this pass, `ArmorMaterialImperialLight` shield has 13 records at 19 and one at 25, and a
check on the commonest value alone would have called it done.

That proves the *values*. It does not prove no unrelated **record** was touched, so also diff the two plugins record by
record in xEdit and confirm every record outside the result file's list is byte-identical.

Two more standing traps for a DLE built on the PC: it has dropped server-side patches before, so probe the new DLE for
the border REGN, the 251 cells and the Aleswell/Caractacus markers (memory `pc-dle-builds-drop-server-side-patches`),
and remember `server\data` is a separate plugin copy that needs the same file (memory
`server-data-is-a-separate-plugin-copy`).

## Two things I could not settle from here — please look

1. **Beyond Skyrim's chainmail has no material keyword of its own.** `CYRArmorNibeneseChainmail*` carries
   `ArmorMaterialIron` and the enchanted `CYREnchArmorChainmail*` carry `ArmorMaterialSteel`. So choice 7's chainmail
   half **cannot** be done by keyword — setting all Iron or all Steel to chainmail numbers would wreck both. The
   ladder therefore matches chainmail by editor id (`CYR*Chainmail*`), which is the only handle available. Check the
   dry run's list of chainmail records is the set you expect, and nothing else.
2. **`ArmorMaterialImperialLight` shield: settled, and smaller than it looked** (Nate, 2026-09-30: "make the imperial
   shields all 19"). Counted directly rather than from the census summary: **14** shield records carry the keyword,
   **13 are already 19**, and exactly **one** is 25 - `ArmorImperialLightShield` from `DIS_Heavy_Legion.esp`. So the
   rule moves one record. That was the shield the proposal raised as its item 6, sitting above Elven's 21 and near
   Glass's 27. Its origin is third-party, so the override lands in Nexus Patches.

Related: the proposal's tables were measured per canonical set by editor id, while this script works per material
keyword. Where a keyword group holds several designs the group is flattened to one number, which is the intent
("correct records mean every place shows the same number"), but it does mean a few "now" values differ from the
proposal's tables. The dry run prints the real before value for every record.

## Why battleaxe and warhammer needed a census change

They share animation type 6 and have different damage in the ladder (Orcish 21 and 23). The census grouped them as
one, so it could not have proved the split. `material_census.py` now splits them on `WeapTypeBattleaxe` /
`WeapTypeWarhammer`, and the script does the same. Both keywords are present in the load order.

## The script has not been run

I cannot run xEdit on CT 115, so `DBO_BlacksmithTiers.pas` is unexercised code. It avoids `PosEx`, `IfThen`,
`StringOfChar` and `TStringList.Values`/`Names`/`IndexOfName` in case this xEdit build lacks them, and it reads every
value back after writing it. The dry run is there to catch what review cannot. The encodings it relies on were checked
against real records here: ARMO `DNAM` is a uint32 holding rating x 100 (`ArmorIronCuirass` 2500,
`ArmorDaedricCuirass` 4900) and WEAP `DATA` damage is a uint16 at offset 8 (`IronSword` 7, `DaedricSword` 14).

## After the plugins are live

1. `bash dev-server.sh deploy-plugins`, then commit and push the `SHA256SUMS` it updates.
2. **Remove the interim server override** — see `ARMORMATERIALS_REMOVAL.md`. Leaving it in double-counts.
3. The skills.json tier text is already committed (branch `blacksmith-skills-text`); it needs
   `dev-server.sh restart skymp --yes`.
4. Patch note.
