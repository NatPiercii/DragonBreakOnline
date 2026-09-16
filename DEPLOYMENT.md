# Standing the server up on another machine

Written 2026-09-16, for handing the game server to Jake. Everything here is about the **game
server** (`skymp5-server`), not the backend; the backend, the Discord bot and the website are a
separate service and are already Jake's ground.

## The one question to answer first: Windows or Linux

`server\scam_native.node` is a **5.4 MB prebuilt native addon, built for Windows x64**. The server
bundle loads it by name. It is not portable:

- **Windows host**: copy it as-is, everything below applies unchanged.
- **Linux host**: it must be rebuilt for Linux from the fork's C++ (`skymp5-server/cpp`), through
  the CI flatrim build or a local CMake build on that box. Nothing in the JavaScript layer changes,
  but until that binary exists the server cannot start at all. Decide this before copying 500 MB
  around.

## What to copy

| Copy | Size | Why |
|---|---|---|
| `data\` | 528 MB | The 114 plugins and BSAs. The load order must match what players run, byte for byte |
| `dist_back\skymp5-server.js` | 3.3 MB | The server build. Or have Jake build it: `cd fork\skymp5-server && npm run build-ts` |
| `scam_native.node` | 5.4 MB | Windows only, see above |
| `package.json`, `node_modules` | - | Or `npm install` on the host |
| `gamemode.js` + the modules | ~250 KB | `dungeons.js`, `wildlife.js`, `playtest.js`, `labour.js`, `champions.js`, `contracts.js` |
| The data files | ~7 MB | `skills.json`, `zones.json`, `loot.json`, `dungeons.json`, `wildlife.json`, `doors.json`, `readables.json`, `NPC-Spawns.json`, `gamemode-config.json`, `housing.json`, `companions.json`, `starter-grants.json` |
|  | - | The reference load order |

Node 22 is what runs it here ( = v22.14.0);  is , so the world
state is  on disk and no database server is needed.

**Do not copy:**

- `world\` unless you want this machine's characters and change forms. A fresh server should start
  empty; the file is rebuilt on boot.
- `server-settings.json` **verbatim** - see the next section, it is host-specific.
- `_*` folders, `*.log`, `client-dist\` (that one goes to players, not to the server host).

`dataDir` and `gamemodePath` in server-settings.json are relative (`data`, `gamemode.js`), so the
folder is portable as long as its internal layout is preserved.

## What changes per host

In `server-settings.json`:

| Key | Here | On Jake's host |
|---|---|---|
| `listenHost` | `127.0.0.1` | `0.0.0.0` to accept remote players. **This is the setting that makes the server reachable at all** |
| `port` | 7777 | Same, UDP. Forward it |
| `uiListenHost` | - | The admin/UI port; keep it on loopback or behind a firewall, it is not for players |
| `maxPlayers` | 100 | 40-50 for the first sessions |
| `offlineMode` | `true` | See the warning below |

In `gamemode-config.json`: `admins` is keyed by **profile id**, so Jake's own id belongs there or
nobody can run `/selftest`, `/load`, `/kick` or the admin panel.

## Offline mode is no authentication

With `offlineMode: true` the client simply states which profile it is:

```js
} else if (offlineMode === true && typeof gameData.profileId === "number") {
  const profileId = gameData.profileId;
  this.emit(ctx, "spawnAllowed", userId, profileId, ...);
```

Two consequences, both of which matter the moment the port is open:

1. **Anyone who knows the address can join as any profile**, including an admin one. Fine for a
   closed test with people you trust; not fine for a public address left running.
2. **Every tester needs a unique `profileId`** in their own `skymp5-client-settings.txt`. Ship the
   client folder with `profileId` 2, 3, 4, 5... per person, or all of them share one character and
   one inventory.

The real fix is the backend's Discord login, which is exactly what Jake's `POST /auth/session` fix
on 2026-09-15 was hardening. Once that is deployed, `offlineMode` goes to `false` and the launcher
does the login.

## What players install

`server\client-dist\` (396 MB) over their Skyrim SE install, plus the third-party mods from the
Nexus collection. Their own `skymp5-client-settings.txt` needs:

```json
"server-ip": "<the host's public address>",
"server-port": 7777,
"gameData": { "profileId": <unique per player> }
```

A load-order mismatch fails at connect and looks like a server fault, so it is worth checking one
player's `Plugins.txt` against `plugins.server.txt` before blaming anything else. Vortex rewrites
that file within ~30 s of running, so it must be closed while playing.

## After it boots

In order, and stop at the first one that fails:

1. The log ends with `playtest lock ON: Bruma, 5 world(s)...` and has zero `failed to load` lines.
2. `netstat` shows the port on `0.0.0.0`, not `127.0.0.1`.
3. Join as an admin profile, run `/selftest`: it should say every system is wired.
4. `/load`: players, live npcs, spawn poll ms, packet rates. Note the poll figure with one player
   as a baseline.
5. Then work through `PLAYTEST.md`.

## The gameplay layer is in git, and needs a remote

`server\` is a git repository as of 2026-09-16 (the gameplay modules, the data files and the design
docs; secrets, `world\`, builds and backups are ignored). It has **no remote yet**, which is now the
blocking item: Jake cannot pull what is only on one machine. A private repo he can clone, with the
fork as the other half, is the whole handoff.

The fork itself is at `github.com/NatPiercii/alduinak`, pushed through `46e75f1`.
