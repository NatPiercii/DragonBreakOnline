# Getting the server running (updated 2026-09-13, late)

## Where things stand

- Upstream SkyMP (skyrim-multiplayer/skymp, nightly CI build) RUNS on this
  machine: tested with the five vanilla masters, loaded, wrote data\manifest.json,
  UI on port 3000, master server gateway.skymp.net. Extracted into this folder
  from dist.zip (server-dist.zip and papyrus-vm-nexus.zip are the same build).
- Upstream CANNOT load our pack. It has no light-plugin (ESL) support anywhere:
  the server assigns one 8-bit slot per plugin, the manifest generator throws on
  any .esl filename, and the client compares only regular plugins. 45 of our
  100 plugins are ESL-flagged and 7 have the .esl extension. DO ran a
  private fork that handled this.
- The fix exists in another server's public fork: Alduinak-RP/alduinak
  (forked from SkyrimRoleplay/skyrp, pushed 2026-09-13). It maps light plugins
  into the 0xFE space server-side, accepts .esl in the manifest, and its client
  enumerates light mods for the load-order check. The same author opened
  upstream PR #2793 (server side only, no CI build, unreviewed as of today).
  Alduinak also ships a backend, a server manager, and a launcher builder.
- This PC has no Visual Studio / CMake / Yarn / Docker. Do not build locally.
  Alduinak's own guide builds on GitHub Actions in your fork, which is free and
  needs nothing installed here.

## Do next

1. Fork https://github.com/Alduinak-RP/alduinak on GitHub (their guide says
   fork into an organization account; a personal account should work too).
2. In your fork: Actions tab, enable workflows, run
   "Dist Windows Flatrim (fast, dist-only)" (workflow_dispatch, or push a
   trivial README change). Expect a long build, possibly hours.
3. Download the dist artifact when it is green. Give me the zip: I will
   replace dist_back\, scam_native.node, gamemode.js and client-dist\ here,
   keeping our data\ and server-settings.json.
4. I re-run the smoke test with the full 100-plugin order and read the log.
5. Client on this PC from the new client-dist (Platform + SKSE folders into the
   dev game install, skymp5-client-settings.txt pointed at 127.0.0.1:7777).
6. Only then: their backend / server manager / launcher, ports, VPS.

Fallback if the Alduinak build fails: fork upstream skymp, merge branch
esl-form-id-space from Alduinak-RP/alduinak (PR #2793), patch manifestGen.ts to
accept .esl, set ignoreLoadOrderMismatch in the client settings, build via the
upstream PR Windows Flatrim workflow in your fork.

## Licence note

Both trees carry SkyMP's TERMS.md: running a server is unrestricted; distributing
the binaries means referencing the source; code changes must be published.
Alduinak's fork has no separate licence file, so treat it as the same terms.

## What the Alduinak fork actually contains (read from alduinak-main.zip, 2026-09-13)

Source only; build\dist\server holds a README, no binaries. Beyond the ESL
server fix it is a complete operator stack:
- server-manager\   Electron control panel: start/stop nssm services, build
                    gamemode/launcher/client, Modlist tab that reads an MO2
                    profile, compiles install-manifest.json, syncs loadOrder and
                    the data folder, and flags form-id slot shifts (needs a
                    MongoDB purge when plugins move).
- skymp5-backend\   Express API: Discord OAuth login, whitelist/lockdown, chat WS
                    relay, launcher news/status, serves client files.
- skymp5-launcher\  Electron launcher for players: Discord login, installs
                    Mod Organizer 2 portable and replays the manifest, pulls mods
                    through the Nexus API with the player's own account (no
                    redistribution of other authors' files), gates on
                    SkyrimSE.exe 1.6.1170, launches via SKSE.
- deploy\           nginx + win-acme SSL, MongoDB, LiveKit voice.
- server-plugins\   gamemode plugin system (api.registerChatCommand etc.);
                    gamemode.js is generated from gamemode_extensions\*.js.
- dev\local-test.bat  one-machine offline loop (server + client), the same
                    smoke test we ran, ready-made.

Only the native pieces need CI: scam_native.node (server, carries the ESL fix)
and the client DLLs. The dist workflow passes DEPLOY_BRANCH "" so the
skymp5-patches secret is unused; a plain fork can run it.

## State at the end of 2026-09-14 (early hours)

Working now, on this PC, all offline:
- Server: Alduinak fork build with the case-insensitive master fix, 99 plugins,
  spawn at the RealmofLorkhan hub (DragonBreak Hub.esp), nine hold gates teleport to
  Tamriel, chat with channels/ranges/PM/system/admin, /help /players /whoami
  /ping /kick /tp. gamemode.js + gamemode-config.json hot-reload on save.
  Admin = profileId 1 (your offline client) in gamemode-config.json.
- In-game UI built from skymp5-front into data\ui (chat window etc).
- Client in the dev game folder: rebuilt bundle with X as the interact key
  (player menu: Introduce / Search / Restrain / Carry / Put down / Release /
  Trade; housing menu on doors and containers: claim / lock / unlock / grant).
  Prompt text beside the [E] glyph still reads as the engine draws it.
- DragonBreakLauncher.exe built (launcher-build\), points at the placeholder
  domain; useless to players until a backend + domain exist.
- DO overlay assets restored into game Data (502 files: LostArk,
  Paladin, IA/weapon meshes and textures, MCM presets). DO branding, DO client
  files and CBPC jiggle physics deliberately left out; 3BBB.esp dropped.

Not done yet, in order of value:
1. Backend + Discord login + domain (needed for the launcher and for online
   mode). Needs a Discord application and a domain you own; secrets go in
   skymp5-backend\.env by hand.
2. Modlist manifest: Alduinak's pipeline reads a Mod Organizer 2 profile. You
   run Vortex, so either build an MO2 portable profile of the pack once, or
   write a Vortex adapter for compile-manifest.js.
3. Gamemode depth: character select, introductions (ff_knownIds), hold
   appointments, factions, economy. The client contracts are documented in
   docs\docs_roleplay_*.md of the fork.
4. Push the X-key client commit from the scratch clone so CI builds carry it.
5. Rename the project folder with RENAME-FOLDER-AFTER-CLOSING-CLAUDE.ps1.
