# How the player download (`skymp-client.zip`) is built

Written 2026-09-23 for Jake. The package has been built on Nat's Windows PC and uploaded to the dev
server (CT115) since client 0.3.3. Every build is logged, with its backup path, in Nat's
`OPS_HANDOFF_<date>_claude-nate.md` files. The newest is 0.3.17 (2026-09-23 02:22 UTC, the merged
DragonBreak Online Edits).

## Why the server cannot build it today

- `./build.sh --build` on Linux never produces `Data/Platform/UI` ("Building client-deps is disabled on
  non-Windows setups"), so a package built there has no in-game interface.
- `/opt/alduinak/skymp5-backend/sources/client` and `/opt/alduinak/build/client-files/root` on CT115 hold
  an old client (18 Sep). `npm run populate && npm run merge` there would publish that old client to every
  player.

A Windows machine that runs the CI client build (the `flatrim` workflow in the Actions tab) plus
`npm run build` in `skymp5-front` and `skymp5-client` has everything needed. Nothing secret is involved.

## What goes in it

`fork/build/client-files/root/` zipped as-is:

- `Data/Platform/**`: `skymp5-client.js` (from `skymp5-client`, `npm run build`), the UI (from
  `skymp5-front/dist`), the CEF runtime and fonts (from the CI build).
- `Data/SKSE/Plugins/`: `SkyrimPlatform.dll`, `SkyrimPlatformImpl.dll`, `MpClientPlugin.dll` and
  friends (CI build).
- `Data/Scripts/*.pex` (CI build).
- The 9 DragonBreak and Lost Ark plugins, byte-identical to `fork/deploy/skyrim-data/SHA256SUMS`.
- `Data/Platform/UI/dbo-watermark.png`, which sits loose and is not a webpack output.

The 4 DragonBreak BSAs and the loose assets are **not** in the zip. They go through the launcher's
extra-files channel (`/api/files/extra`, launcher 2.1.17+). See `fork/skymp5-backend/LAUNCHER_FILES_GUIDE.md`.

## The recipe

1. **Match the live package first.** Fetch the live `skymp5-backend/data/files-version.json` and hash
   every file under the local `root/`. They must match exactly. If they do not, the local folder is not
   what players have, and a merge ships something nobody reviewed.
2. **Replace only what changed**, e.g. `root/Data/Platform/UI/` from `skymp5-front/dist`, or
   `root/Data/Platform/Plugins/skymp5-client.js`. Re-diff: the manifest should differ only by the files
   you meant.
3. **Do not run `npm run populate`** on a box without a full CI client build. It wipes `root/Data`
   first and skips every plugin on purpose.
4. Bump `CLIENT_VERSION` in `skymp5-backend/routes/version.js`, then `npm run merge` in
   `skymp5-backend`. It zips `root` into `build/client-files/skymp-client.zip` and writes
   `data/files-version.json`.
5. **Open the zip with adm-zip** (what the launcher uses): every entry readable, 9 plugins present, the
   new code in the bundle. Never edit the zip in place with .NET `ZipArchive` / `Compress-Archive
   -Update`; the launcher then fails with `ADM-ZIP: No descriptor present`.
6. Upload: scp both files to `/tmp` while the backend still serves, stop `dragonbreak-backend`, back the
   old zip and manifest up to `/opt/skymp-backups/`, install both, bump the version on the box, start.
   Downtime is under 10 s.
7. Verify through the public URL: `/api/version` (clientVersion), `/api/files/version` (sha256; note
   `/api/manifest` is 404 on this backend) and `/api/files/zip` (byte size).

**Never edit a tracked file on CT115 by hand.** `skymp-update` then refuses to run ("skipped:
uncommitted changes") and every later auto-deploy silently stops. Push the change, then
`sudo git checkout -- <file>` and `sudo systemctl start skymp-update.service`.
