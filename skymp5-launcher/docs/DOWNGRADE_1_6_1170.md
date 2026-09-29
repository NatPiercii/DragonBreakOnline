# Downgrading Skyrim to 1.6.1170 from the launcher (proposal for 2.1.35)

DragonBreak runs on Skyrim SE **1.6.1170.0** (GOG: 1.6.1179.0). Steam now ships 1.7.104. The launcher checks the exe
version and blocks PLAY on a mismatch. It then sends the player to Reliquary on Nexus (`gameversion.js`,
`showGameVersionDialog`), and that is where most new players give up. This proposal builds the downgrade into the launcher.

## The method: Steam's own depot download, under the player's own account

This is the owner's method, taken from Jake's `SkyrimSteamDowngrader.ps1` (2026-09-29) and rewritten in Node. The
launcher never runs PowerShell.

- The player runs three `download_depot` commands in Steam's console, signed in to their own Steam account, one at a
  time. App 489830:

  | Depot | Holds | Manifest for 1.6.1170 |
  |---|---|---|
  | 489831 | core Data (masters, BSAs) | 8442952117333549665 |
  | 489832 | interface, textures, launcher | 8042843504692938467 |
  | 489833 | SkyrimSE.exe | 1914580699073641964 |

- Steam writes each depot to `<Steam>\steamapps\content\app_489830\depot_<id>`.
- The launcher copies those files over the game folder. Every file it replaces is backed up first.
- **Why this route:**
  - The files come from Valve, to a player who owns the game. The launcher never holds, sends or asks for Steam
    credentials, and it ships no Bethesda file.
  - Delta patchers depend on the version they patch from (BoBW supports only 1.7.104), and they run third-party exes.
  - It is the owner's chosen method (Jake's tool).

## What the player sees

**1. At start, detection.**
- The current check stays: `SkyrimSE.exe` FileVersion, read from both the original install and the game copy.
- Two more signals catch a 1.7.99 install, which still carries the 1.6.1170 exe:
  - the byte sizes of `Skyrim.esm` (249,753,412) and `Update.esm` (18,874,041);
  - the sizes of the other masters, from the server's `/opt/skyrim-data` copy.
  A mismatch means "data from a newer Steam build".
- On a mismatch, PLAY is replaced by a **Skyrim needs downgrading** panel. The Reliquary dialog goes away.

**2. Editions the launcher refuses, with a clear message and no downgrade.**

| Edition (`mo2.detectEdition`) | What happens |
|---|---|
| Steam | Downgrade offered |
| GOG | Already accepted at 1.6.1179. On any other version: "roll back in GOG Galaxy (Manage installation > Configure > Version)", as today |
| Epic Games | Refused: "The Epic Games edition cannot be switched to the build DragonBreak uses. DragonBreak needs the Steam or GOG edition." |
| Microsoft Store / Game Pass | Refused, with the same wording, plus: "its files are protected and SKSE cannot run on it." |

**3. Which folder gets changed.**
- The downgrade always targets the **original game folder** (`store.get('skyrimPath')`). It never targets the MO2 folder
  and never targets the launcher's game copy directly.
- Afterwards the files it replaced are copied into the game copy too. The launcher does this explicitly, not through
  the size-only integrity repair, so the game copy follows the original.
- If `skyrimPath` is not under a Steam library's `steamapps\common` (for example a Wabbajack "Stock Game" folder
  inside MO2), it is downgraded in place the same way. The Steam update setting (step 7) is skipped, because Steam does
  not manage that folder.

**4. Download panel.** The panel shows one row per depot:

```
Skyrim needs downgrading to 1.6.1170                       [Open Steam console]
Run these in Steam's console ONE AT A TIME. There is no progress bar; Steam says "Done" when one finishes.

 1  download_depot 489830 489831 8442952117333549665   [Copy]   Downloading... 3.1 GB so far
 2  download_depot 489830 489832 8042843504692938467   [Copy]   Waiting
 3  download_depot 489830 489833 1914580699073641964   [Copy]   Done ✓

If the console does not open: press Win+R and type  steam://open/console
Steam may ask you to be signed in. The launcher never asks for your Steam password.
```

- **Open Steam console** calls `shell.openExternal('steam://open/console')`.
- **Copy** puts that depot's command on the clipboard.
- **Status:** the launcher polls each depot folder every 2 s, under every Steam root:
  - the registry `SteamPath` and `InstallPath`;
  - every library in `libraryfolders.vdf`;
  - the Steam root beside the game's own library.

  It accepts all four folder layouts Jake's script accepts:
  - `app_489830\depot_N`
  - `489830\N`
  - `depot_N`
  - `N`

  Each depot is in one of four states:

  | State | When |
  |---|---|
  | Waiting | No folder yet |
  | Downloading | The folder exists and its total size is still changing |
  | Done | Every file of that depot is present at its expected size, and nothing changed for 20 s |
  | Wrong build | For 489833, SkyrimSE.exe is present but its FileVersion is not 1.6.1170 |

- **Install** is enabled once all three are Done. The launcher never asks the player to "press Enter when done".

**5. Install, with progress.** In order, and nothing is touched until the checks pass:

1. **Version check before anything is touched** (Jake's guard). The downloaded `SkyrimSE.exe` must read 1.6.1170.
   Otherwise the panel says "Nothing was changed".
2. **Verification.**
   - Hash with sha256: the exe and every master (`Skyrim.esm`, `Update.esm`, the three DLC masters, the four free CC
     plugins, `_ResourcePack.esl`). The reference hashes are the server's own `SHA256SUMS`, the files players must match
     to connect.
   - Check sizes for the BSAs and the other files.
   - The launcher ships only this list (relative path, size, hash), never a file.
3. **Guards:**
   - Game, SkyrimSE.exe, skse64_loader.exe and MO2 are not running (`isProcessRunning`).
   - There is free space for the new files on the game drive.
   - Every source path resolves inside its depot folder, and every target inside the game folder (Jake's
     `Get-SafeRelativePath`, as `path.relative` plus an escape check).
4. **Backup, then copy, file by file, with a progress bar.**
   - Each file being replaced is moved into `<game>\_DragonBreakDowngrade\<stamp>\<same relative path>`. Moving is a
     rename on the same drive: instant, and no double disk use. A plain copy is the fallback if the rename fails.
   - The depot file is then copied in.
   - A `backup.json` in the backup folder records every replaced file and every **added** file (one the game folder
     did not have before), so Restore can remove the added ones too. Jake's script leaves those behind.
   - If any copy fails, the launcher puts back what it moved so far and says so.
5. **Re-read the installed exe version** (Jake's final check) and refresh the game copy (step 3 above).

**6. After install: SKSE and Address Library.**
- Check that `skse64_loader.exe` and `skse64_1_6_1170.dll` are in the game copy. The launcher's SKSE is `skse64_2_02_06`,
  the 1.6.1170 build, so this should already pass.
- Check that `SKSE\Plugins\versionlib-1-6-1170-0.bin` is in an enabled MO2 mod. The collection's Address Library "All
  in one" (Nexus 32444) carries it.
- If either is missing, the panel points to **Repair Modlist**. The downgrade itself stays done.

**7. Keep Steam from updating it again.**
- Steam keeps each game's state in memory and writes `<library>\steamapps\appmanifest_489830.acf` itself, so an edit
  made while Steam runs can be overwritten. **So Steam must be closed** for the launcher to write the setting.
- The panel's last row says: "Close Steam (Steam > Exit) to lock Skyrim to this version".
- It polls `steam.exe`. Once Steam is closed, it sets `"AutoUpdateBehavior" "1"` ("Only update this game when I launch
  it") inside the `AppState` block. It adds the key if it is missing and keeps every other byte of the file.
- If the player would rather not close Steam, a second option tells them where to set it in Steam: Skyrim Special
  Edition > Properties > Updates. On every start the launcher reads the acf and shows a warning line until the value
  is 1.
- The launcher starts the game through MO2 and SKSE from its own copy, never through Steam's Play button. The setting
  only matters if the player starts Skyrim from Steam, and the panel says so.

**8. The way back.** Two buttons, in Settings > Repair and on the panel:
- **Restore my previous Skyrim files:**
  - moves the newest backup's files back, removes the files the downgrade added, and refreshes the game copy;
  - asks before it starts;
  - lists what it will do: "Skyrim will be on the newer version again, and DragonBreak will not start until it is
    downgraded".
- **Let Steam repair Skyrim:** `steam://validate/489830`. Steam then updates Skyrim to its newest build. This is the
  authoritative way back, as Jake's script also says.
- A third, optional button deletes the downloaded depots (several GB in `steamapps\content`). It stays hidden while the
  game copy still uses `depot_489831\Data` as its fallback for the free CC archives.

## Code shape

- **New `src/downgrade.js`**, pure functions that `main.js` calls through IPC:
  - `findDepots(steamRoots)`: depot path resolution;
  - `depotState(dir, ref)`;
  - `detectNeedsDowngrade(gameDir, edition, ref)`;
  - `planInstall(depots, gameDir, ref)`: the list of `{ from, to, backup, replaces }` jobs, with the path-escape check;
  - `runPlan(plan, onProgress)`;
  - `planRestore(backupDir)`;
  - `setAutoUpdateOnLaunch(acfText)`: returns the new text.
- **New `src/downgrade-1.6.1170.json`:** the reference list (relative path, size, sha256 for the hashed files).
- **The panel:** a new overlay in the renderer beside the existing version dialog, which it replaces.
- **Tests (`test/downgrade.test.js`), on temporary folders:**
  - detection: exe version, master sizes, each edition;
  - depot resolution: the four layouts, several roots, a partial folder;
  - the plan: replaced versus added, `..` and absolute paths refused;
  - backup, copy and rollback on a failed copy;
  - restore;
  - the acf edit: key present, key missing, other lines kept.

## To confirm on a Windows PC before release

1. Download the three depots once and run `node tools/depot-reference.js <content\app_489830>`. It writes the file list
   and sizes for `downgrade-1.6.1170.json`, plus the exe's sha256. The master hashes already match the server's.
2. Whether `download_depot` pre-allocates files at full size. If it does, size alone cannot mark a depot Done, and the
   20 s rule plus the hashes carry it. Whether Steam's `logs\console_log.txt` records the completion line. If it does,
   that line becomes the first Done signal.
3. That an acf written with Steam closed keeps `AutoUpdateBehavior` 1 after Steam restarts, and that
   `steam://validate/489830` opens Steam's verify.

Until item 1 lands, Done relies on the folder standing still for 20 s plus the exe version and master hashes. The BSAs
then get no per-file size check.
