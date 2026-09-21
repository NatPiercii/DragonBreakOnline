# What the launcher delivers, and what to publish to it

For Jake (and Jake's Claude), who hosts the production server and backend. Written 2026-09-21 from
Nat's dev box after the first two-player test, updated the same day. Nat's home server PC is retired
as a host; nothing below assumes it.

**Read "Fix these before players install" first** - there are two known gaps in what is published
today. Then "What changed on 2026-09-21" for the server update.

The code lives in `github.com/NatPiercii/DragonBreakOnline`: branch `main` (server systems, client,
launcher, this backend) and branch `server` (the gameplay layer: `gamemode.js`, its modules and data).
The two branches are separate histories and never merge.

---

## The rule everything else follows

**Every player's plugins, and the server's `server\data\` copies, must be byte-identical - header
flags included.** Form ids are `plugin index << 24 | local id`. An ESL-flagged plugin takes no
regular index, so a single flag byte that differs shifts every later index on one side only.

This happened on 2026-09-20 with `AlternateHighPolyHead_SE.esp`. It was ESL-flagged on the client and
not on the server, the hub's form id came out `0x24` on the client and `0x25` on the server, and
every player spawned in Riverwood. The full account is in the `server` branch at `HUB_SPAWN_BUG.md`.

After any publish, check a player's crash log (or `Plugins.txt` plus the file flags). Its `PLUGINS:`
block prints the real runtime indices. They must match what `server-settings.json` `loadOrder`
produces, and `startPoints` must use the client's index. It is `0x24017482` today.

---

## The three things the launcher downloads

| Channel | Backend endpoint | File on the backend | Built by | In git? |
|---|---|---|---|---|
| 1. **Mod install** (Nexus and other third-party mods) | `/api/install-manifest` | `skymp5-backend/data/install-manifest.json` | `npm run compile-manifest -- --mo2 <MO2 root>` | **no** (`data/` is untracked) |
| 2. **Client package** (SkyMP client plus DragonBreak's own plugins) | `/api/files`, `/api/manifest` | `build/client-files/skymp-client.zip` + `data/files-version.json` | `npm run populate`, then copy the plugins in, then `npm run merge` | **no** |
| 3. **Launcher self-update** | `/api/version` | `routes/version.js` (`LATEST_VERSION`, `DOWNLOAD_URL`) | GitHub release `launcher-vX.Y.Z` | yes |

Because `data/` and `build/` are untracked, **a fresh backend deploy publishes nothing** until you
run steps 1 and 2 on that box.

### 1. The install manifest: every third-party mod

`compile-manifest` reads a reference **MO2 install** (Nat's is `C:\DragonBreak`, profile
`DragonBreak`). It records every mod's archive, file hashes, the plugin order and which plugins are
enabled. Today that is 106 mods and 100 plugins. RaceMenu, `AlternateHighPolyHead_SE.esp` (the ESL
copy from Nexus) and the rest arrive through here.

- Build it from an MO2 install that **runs the game correctly**. The manifest copies that install
  exactly, so a wrong flag or a missing mod there reaches every player.
- Mods shipped as `.rar` need a full 7-Zip. Set `DRAGONBREAK_7Z` to a `7z.exe` (the launcher bundles
  one), or the bundled `7za` silently inlines the extracted files as base64. That turned a 5 MB
  manifest into 1 GB on 2026-09-20.
- Archives with no Nexus page get a direct URL through `data/manifest-sources.json` `urls`.
- The manifest's plugin list includes the 9 DragonBreak and LostArk plugins as enabled, but it does
  not deliver those files. Channel 2 does.

### 2. The client package: SkyMP plus the 9 plugins nobody else hosts

**What the zip must contain:**

- The SkyMP client build: `Data/Platform/**` (the `skymp5-client.js` bundle, the UI, CEF runtime,
  fonts), `Data/SKSE/Plugins/` (`SkyrimPlatform.dll`, `MpClientPlugin.dll` and friends), and
  `Data/Scripts/*.pex`. It comes from `fork/build/dist/client/Data`.
- **These 9 plugins**, byte-identical to the server's `server\data\` copies:

  | Plugin | sha256 (first 12) of the current server copy |
  |---|---|
  | `DragonBreak Built.esp` | `753e13d6deb8` |
  | `DragonBreak Dungeons.esp` | `6ded966b2a3b` |
  | `DragonBreak Harvest.esp` | `30a60c203036` |
  | `DragonBreak Hub.esp` | `c05979791deb` |
  | `DragonBreak Online Edits.esp` | `86bffd107539` |
  | `DragonBreak Whiterun.esp` | `514c1adb20e6` |
  | `DragonBreak.esp` | `56a801964022` |
  | `LostArk_Kamen.esp` | `5c2d810cd551` |
  | `[Kirax] Lost Ark Reborn Paladin Legendary.esp` | `8c34899fd51e` |

  The two LostArk plugins sit at load-order positions 63-64 and **must not be dropped**. Removing a
  plugin from the middle shifts every later index.

**The build order, and its trap:**

```
cd fork/skymp5-backend
npm run populate      # WIPES build/client-files/root/Data and copies the client build, SKIPPING every .esp/.esm/.esl
# copy the 9 plugins above into build/client-files/root/Data/
npm run merge         # builds skymp-client.zip and data/files-version.json
```

`populate` deliberately skips plugins and deletes the folder first. If you run `populate` and then
`merge` straight away, the 9 plugins are gone and players cannot load the game.

**Never modify `skymp-client.zip` in place** with .NET `ZipArchive` (PowerShell `Compress-Archive
-Update` and similar). The launcher extracts with `adm-zip`, which cannot read the result, and fails
with `ADM-ZIP: No descriptor present` after a full download. Always rebuild with `npm run merge`.
**Stop the backend first**, because it locks the zip while it serves it.

`skymp5-client-settings.txt` is never shipped. The launcher writes it on every launch.

### 3. Launcher self-update

Bump `LATEST_VERSION` and `DOWNLOAD_URL` in `routes/version.js` to a published GitHub release. You
already did this for 2.1.16. `CLIENT_VERSION` is the version players see for the client package.
Bump it when the zip changes so launchers pick up the new zip.

---

## Fix these before players install

### A. The published zip's `DragonBreak Online Edits.esp` is stale

The zip in `build/client-files` (built 2026-09-20 22:47) holds a copy of `DragonBreak Online
Edits.esp` from **20:27:46** (4 340 414 bytes, sha `252135a1eb04`). The server and dev copies were
rewritten 90 seconds later, at **20:29:17** (4 340 654 bytes, sha `86bffd107539`). Nat's MO2 install
has the stale one, so every player who installed on 2026-09-20 runs a different DLE than the
server. Rebuild the zip from the current plugins with the steps above.

### B. DragonBreak's own BSAs ship through no channel

These archives exist in Nat's dev game `Data` folder and are **in neither the manifest nor the zip**,
and not in the MO2 install:

| Archive | Size |
|---|---|
| `DragonBreak.bsa` | 26 MB |
| `DragonBreak - Textures.bsa` | 146 MB |
| `DragonBreak Online Edits.bsa` | 54 MB |
| `DragonBreak Online Edits - Textures.bsa` | 364 MB |

A player therefore loads `DragonBreak.esp` and `DragonBreak Online Edits.esp` without their meshes
and textures. Expect missing or purple textures and invisible or "!" meshes wherever DragonBreak's
custom content is used. It went unnoticed because Nat's dev copy has them.

Two ways to ship them. It's Nat's and Jake's call:
- **In the zip**, next to the plugins. Simple, but the zip grows from 175 MB to about 765 MB, and
  every client update re-downloads all of it.
- **As a manifest archive**: pack the 4 BSAs into one archive, host it, and add it through
  `data/manifest-sources.json` `urls`. It downloads once and is hash-checked, and client updates stay
  small. This is the better fit.

Either way, the BSAs must also sit next to the plugins in the server's `data\` if anything on the
server reads them. Today nothing does, since the server only reads records.

---

## What changed on 2026-09-21 that the server needs

Pull both branches, then:

| Change | Files | To apply |
|---|---|---|
| **Notice boards work everywhere.** Before, no board in Skyrim worked: `zones.ts` compared lowercased worldspace ids against `"3c:Skyrim.esm"`. All 28 placed boards are now loaded at boot, static ones included, and are reachable with N or `/board`. | `main`: `bountyBoardSystem.ts`, `zones.ts`. `server`: `notice-board-spots.json` (new), `zones.json` (adds an `alikr` region) | `npm run build-ts` in `skymp5-server`, copy `build/dist/server/dist_back/*` to the server's `dist_back/`, restart. Expect the boot line `[board] 28 of 28 placed boards known`. |
| **Housing now finds Skyrim holds.** It uses the same zone lookup, so `housingSystem` resolves Skyrim positions to holds for the first time. | same bundle | same restart |
| **Skinning credits the Skinner skill.** | `main`: `masterySystem.ts`, `skillPoints.ts`. `server`: `gamemode.js` | same bundle, plus the new `gamemode.js`. Ship both together: the new `gamemode.js` sends an event the old bundle drops. |
| **Finished characters go to Bruma automatically**, and the spawn diagnostic is removed. | `server`: `gamemode.js` | hot-reloads on save |

None of these touch the launcher or the client package.

`notice-board-spots.json` is generated from the plugins by `py ck-mcp\board_spots.py`, run on Nat's
dev box. If the load order changes, ask Nat to regenerate it; the server logs any board it cannot
place in a zone.

---

## The server side, briefly (Jake's box)

Git brings the code: the `main` branch for the TS server, client and launcher, and the `server`
branch for `gamemode.js` and its modules. **Git never brings these, on purpose, because the repo is
public:**

- `server-settings.json`: `loadOrder`, `startPoints` (must be the client's index), `adminProfileIds`,
  `offlineMode`. In production, `offlineMode: false` with Discord verification, and admin comes
  through `adminRoles` (role-based), not profile ids. In offline mode, `login.ts` refuses an admin
  profile id from a non-loopback IP by design.
- `server\data\`: the plugin copies. They must match channels 1 and 2 byte for byte (the rule above).
- `world\`, the logs, `.env` files.

Open **UDP 7777** (game) and **TCP 4000** (backend) only. Keep port 3000 (admin RPC and metrics) on
loopback: `uiListenHost: "127.0.0.1"`.

## A checklist for each publish

1. The 9 plugins in the zip match the server's `data\` (compare sha256, not dates).
2. `startPoints` in `server-settings.json` equals the hub id the **client** computes. Confirm it from
   a crash log's `PLUGINS:` block, where `DragonBreak Hub.esp` is `[24]` today.
3. The zip was rebuilt with `npm run merge`, not edited in place, with the backend stopped.
4. `CLIENT_VERSION` in `routes/version.js` was bumped if the zip changed.
5. A test client installs from scratch, reaches the Realm of Lorkhan and walks through a gate to
   Bruma.
