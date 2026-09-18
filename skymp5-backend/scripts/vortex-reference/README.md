# Install manifest from a Vortex install

`compile-manifest.js` builds `data/install-manifest.json` from a reference Mod
Organizer 2 install. These tools produce that reference from a Vortex install of
the DragonBreak Nexus collection instead, so the manifest can be rebuilt on any
PC that has the collection deployed.

| Script | What it does |
|---|---|
| `build-reference.py` | Hardlinks an MO2-shaped reference (`mods/`, `downloads/` with `.meta` ids, `profiles/DragonBreak/`) from Vortex. Each mod gets only the files it won in Vortex's deployment, so the manifest reproduces the deployed game exactly. Plugins come from `deploy/skyrim-data/loadorder.txt`, the same list the game server loads. |
| `build-modlist.py` | Rewrites `data/modlist.json` (the launcher's Modlist panel) from the collection, using each mod's Nexus page name. |
| `vortex_msgpack.py` | Reads Vortex's `vortex.deployment*.msgpack` files. |

Nothing in Vortex or the game folder is modified. The reference must be on the same
drive as Vortex because files are hardlinked, not copied.

## Rebuilding the manifest

Requirements: Python 3, Node, 7-Zip at `C:\Program Files\7-Zip` (needed for `.rar`
downloads), and the collection deployed by Vortex. Open Vortex once first so its
state backup is current.

```bash
python skymp5-backend/scripts/vortex-reference/build-reference.py --out C:/dbref --search <folder with extra archives>
node skymp5-backend/scripts/compile-manifest.js --mo2 C:/dbref --game "<Skyrim Special Edition folder>" --no-modlist
```

`build-reference.py` stops and prints Nexus links when it cannot find a collection
archive (Vortex sometimes installs a mod without keeping its download) or when a
plugin in `loadorder.txt` is not deployed. Download the exact pinned file into a
folder passed with `--search`, or tick the missing installer option in Vortex.
`--add-file MOD/REL=SRC` puts a single file into a reference mod when Vortex cannot.

`--no-modlist` keeps `compile-manifest.js` from replacing the curated
`data/modlist.json`; regenerate that with `build-modlist.py` when the collection
changes. `install-manifest.json` is gitignored: copy it to the backend's `data/` on
the server (the route re-reads it per request, no restart).
