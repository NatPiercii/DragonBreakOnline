# DragonBreak server setup

How the live DragonBreak Online server is put together, what players install, and
how to change either without breaking the other.

## What players connect to

- The game server runs in a container on the Proxmox host (`skymp.service`, UDP 7777).
- Home internet is behind carrier NAT, so players connect to the Linode VPS at
  `50.116.28.194:7777`; it forwards UDP 7777 through a WireGuard tunnel to the host,
  which forwards it to the game server. `dragonbreakonline.com` sits behind
  Cloudflare, which does not carry UDP, so the game address must be the VPS IP.
- The backend advertises that address through `/api/servers` (`SERVER_ADDRESS` in
  the backend's env file) and the launcher writes it into `skymp5-client-settings.txt`.
- Players log in with Discord in the launcher before playing (`discordAuthRequired`).

## What the server loads

- Skyrim SE **1.6.1170** base masters (clean Steam files) plus the DragonBreak Online
  Nexus collection (`2zbqu6`), 96 plugins in total.
- The plugin list and file hashes live in [`deploy/skyrim-data`](../deploy/skyrim-data/README.md).
  SkyMP needs the server and every client to load the same plugins in the same
  order; a mismatch shows as `FromFormId failed due to invalid file index` in the
  server log.
- The team's own pack (custom `DragonBreak*.esp` plugins and edited copies of some
  collection plugins) is **not** on this server yet; the decision for now is
  collection only. Adding it means new plugin files, a new `loadorder.txt`, and a
  rebuilt install manifest.

### Winterhold patch

The collection's `OCW_TGCoW_FEPatch.esp` (from Obscure's College of Winterhold 1.6.1)
was built for the old Great City of Winterhold and needs
`The Great City of Winterhold.esp`, which v4 renamed. Its overrides do not exist in
v4, so it stays disabled. The v4 patch, `TGC Winterhold - OCW Patch.esp` from The
Great City of Winterhold Patch Collection, loads instead, right after
`The Great City of Dragon Bridge.esp`. The published collection should tick that
installer option; Vortex users must reinstall the Patch Collection with Obscure's
College of Winterhold selected, or the launcher reports the plugin as missing.

## What players install

The launcher (`skymp5-launcher`) reads these backend endpoints:

| Endpoint | Source | Notes |
|---|---|---|
| `/api/serverinfo` | the live server | Plugin list the launcher enforces at launch. |
| `/api/install-manifest` | `skymp5-backend/data/install-manifest.json` | Gitignored, copied to the server by hand. Built with [`vortex-reference`](../skymp5-backend/scripts/vortex-reference/README.md). |
| `/api/modlist` | `skymp5-backend/data/modlist.json` | Tracked; display only (Modlist panel). |
| `/api/files/zip` | backend client files | SkyMP client for the launcher. |

Default launcher mode installs everything through its own Mod Organizer 2 from the
manifest (each player downloads the archives from Nexus with their own account).
With the portable install and MO2 turned off, the launcher plays from the player's
own Skyrim folder instead, e.g. with the collection installed by Vortex, and syncs
`plugins.txt` to the server's load order before launching.

## Live files outside git

These are not carried by a commit and must be updated on the server directly:

- `build/dist/server/server-settings.json`: `loadOrder` is set by
  `deploy/skyrim-data/apply-server-plugins.sh`. The build regenerates this file but
  keeps `loadOrder`; a known-good copy is in `/opt/skymp-config-backup/`.
- `/opt/skyrim-data/`: the plugin files themselves (never committed).
- `skymp5-backend/data/install-manifest.json`: the launcher's install manifest.

## Changing the mod set

1. Update the collection and deploy it with Vortex on a 1.6.1170 install.
2. Update `deploy/skyrim-data/loadorder.txt` and `SHA256SUMS`, build the bundle and
   apply it to the server.
3. Rebuild the install manifest with `vortex-reference` and copy it to the server.
4. Regenerate `modlist.json` with `build-modlist.py` and commit it.

Keep the server and the manifest in step: a player whose plugins differ from the
server's `loadOrder` cannot sync.
