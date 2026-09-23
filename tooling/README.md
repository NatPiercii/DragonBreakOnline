# DragonBreak tooling snapshot

The tools that build DragonBreak's data and deploy it, copied here from Nat's working folder so they are
versioned and readable by everyone on the project. **Snapshot, not the working copy:** Nat edits them in
place on his PC and runs `bash server/tooling/refresh.sh` to recopy them here before a commit. The refresh
refuses to finish if a copy contains an IP address or anything credential-shaped, because this branch is
public.

| Folder | What | Working location on Nat's PC |
|---|---|---|
| `ck-mcp/` | 45 Python scripts: the Creation Kit MCP server (`server.py`, `core.py`, `esplib.py`) and the generators that read the whole load order and write the `server\*.json` data (notice boards, shrines, stations, loot, dungeons, item values, wildlife, pelts, blessings, admin catalog, readables, doors) | `ck-mcp\` |
| `ck-mcp/git-hooks/pre-commit` | Form-id check for this repo: refuses a staged `.js`/`.json` whose `'id:Plugin.esp'` is missing from the load order or the wrong record type | copied into `server\.git\hooks\` |
| `xedit-scripts/` | 31 `DBO*.pas` SSEEdit scripts that built records in DragonBreak's own plugins: blessings, race stats and abilities, skill and unarmed markers, shrine activators, notice-board activation, Orc clan sets, puzzle-gate removal, Bruma actor disabling | `Skyrim Special Edition - dev\Edit Scripts\` (20) and `SSEEdit 4.1.5f\Edit Scripts\` (11) |
| `ops/dev-server.sh` | Status, logs, gameplay/plugin/news deploys and announcements for CT115 | root |
| `ops/backup-git.cmd` | The pre-push backup of both repos (branch + bundle + working-tree patch) | root |
| `CLIENT_BUILD.md` | How the player download is built and published | - |

## Running them anywhere but Nat's PC

The scripts hard-code the root `E:\DragonBreak Online Dev files` and expect this layout under it:

```
ck-mcp\                                   these scripts
server\                                   this repo (plugins.server.txt, the JSON the generators write)
server\data\                              the server's plugin copies
Skyrim Special Edition - dev\Data\        a full game Data folder with the 104-plugin load order
```

Recreate that layout and replace the root string once (`sed -i 's#E:\\DragonBreak Online Dev files#<your root>#'`).
Python 3.14, `pip install mcp` for `server.py` only, SSEEdit 4.1.5 for the `.pas` scripts (run headless with
`-autoload -script:X.pas -autoexit -D:"<Data>" -P:"<root>\server\plugins.server.txt"`). Generators take
2-20 minutes each and must be re-run after any load-order or DragonBreak plugin change.

## The six edited third-party plugins

The server's `data\` copies of six Nexus plugins differ from the Nexus files in the reference MO2 install.
Record counts, master lists and header flags are unchanged, so form ids line up on both sides. That is
why nothing has visibly broken. `py ck-mcp\thirdparty_diff.py` prints this table.

| Plugin | Changed records | What changed |
|---|---|---|
| `Armors of the Velothi.esp` | 51 COBJ | crafting recipes: workbench keyword (BNAM), a few conditions |
| `Armors of the Velothi Pt2.esp` | 87 COBJ | crafting recipes: workbench keyword (BNAM) |
| `Hothtrooper44_ArmorCompilation.esp` | 386 COBJ | crafting recipe conditions (CTDA) |
| `Immersive Weapons.esp` | 156 COBJ | crafting recipe conditions (CTDA) |
| `TGCotN Winterhold.esp` | 4 REFR | 3 placed objects set Initially Disabled, 1 re-enabled and moved |
| `notice board.esp` | 133 REFR, 2 QUST | every placed ref set Initially Disabled, both quests' data changed (DragonBreak places its own boards) |

`OCW_TGCoW_FEPatch.esp` also differs, but it left the server load order on 2026-09-21 (105 -> 104).
