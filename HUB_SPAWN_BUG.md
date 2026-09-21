# The hub spawn bug: everything ruled out, and the one reading still missing

Written 2026-09-21 ~00:15, at the end of the first two-player session. Read this before touching the
spawn path; most of the obvious causes are already eliminated and re-checking them wastes a session.

## The symptom

Every character, on every machine, lands in **Riverwood** (the Sleeping Giant Inn interior) instead of
the character-creation hub. Both Nat and his friend, reproducibly, including on a brand new world.

The gamemode then recovers: after `HUB_SPAWN_WAIT_MS` it sends the player to the Pale Pass landing
and from there into the hub, so character creation happens **at Pale Pass** rather than in the Realm.

## What the server believes, second by second

`gamemode.js` carries a temporary diagnostic, `spawnTrace`, added for this. It polls
`worldOrCellDesc` and `pos` each second for 45 s after a character is ready and logs on change.
Disable with `"spawnTrace": false` in `gamemode-config.json`; delete the function once this is fixed.

```
+1s   17482:DragonBreak Hub.esp [2122,2079,3]   <-- IN THE HUB
+35s  Stranger #QK74 did not arrive in the hub from the spawn; sending them via the landing
+36s  a764b:BSHeartland.esm [48236,260600,20405]
+37s  17482:DragonBreak Hub.esp [2122,2079,3]   <-- IN THE HUB
+45s  ended, stage=open
```

Read that carefully: at **+1 s the server has the player in the hub**, because that is what
`createActor` was told. The client never confirms arrival, so at +35 s the fallback fires. Meanwhile
the player's screen shows Riverwood throughout.

**The server and the client disagree about where the player is.** That is the whole bug.

## Ruled out - do not spend time re-checking these

| Hypothesis | How it was eliminated |
|---|---|
| `startPoints` wrong | `0x25017482` = `RealmofLorkhan` in `DragonBreak Hub.esp`, identical to the `HUB` constant at `gamemode.js:746` (same pos, same angle) |
| Server never applies it | `spawn.ts:412` calls `createActor(0, pos, angleZ, +worldOrCell, profileId)`; JS parses `"0x25017482"` as hex correctly |
| Plugin missing client-side | present in the game Data, **sha256 identical** to `server\data\` |
| Plugin not enabled | `*DragonBreak Hub.esp` active in the MO2 profile's `plugins.txt` |
| Plugin index mismatch | **37 on both sides**, computed three ways: server `loadOrder`, the client's real `plugins.txt`, and again with ESM-flagged plugins hoisted (4 of them; hoisting does not move it) |
| ESL plugins shifting indices | accounted for - ESLs live in the `0xFE` space and consume no index; 62 non-ESL plugins on both sides |
| Wrong coordinates | `[2122.2, 2079.6, 3]` is **0 units** from the nearest placed object; the worldspace's content spans x -568..4543, y -1018..5329 |
| No cell at the spawn | the worldspace has 10 cells including **two at grid (0,0)**, one named `ASpawn1`; `[2122, 2079]` is in cell (0,0) |
| Something ejects the player | `DragonBreak Hub.esp` is inert: 66 REFR, 10 CELL, 9 DOOR, 6 STAT, 6 WEAP, 1 WRLD, 1 LAND, **zero QUST, zero VMAD** |
| Stale saved character | reproduced on a brand new `world\` (the old one is `world-old`) |
| Server pre-empting the client | **was real and is fixed** - see below - but fixing it did not cure the symptom |

## The one real bug found and fixed on the way

`HUB_SPAWN_WAIT_MS` was **12000**. The client's own spawn loop retries `SPAWN_MAX_ATTEMPTS` (30)
times at ~1 s (`remoteServer.ts`), so it needs about thirty seconds. The server gave up at twelve and
its fallback teleport aborted the client mid-spawn (`Spawn loop stopped by a server teleport`), so a
hub taking longer than 12 s to load could never be reached.

Raised to **35000** (commit `4f458f05`, pushed). The trace above proves it now waits properly - the
client gets its full budget and *still* fails, which is what makes the remaining bug interesting.

## The reading that is still missing

The client's spawn loop logs its own failure, in `remoteServer.ts`:

```js
const inTargetCell = ObjectReferenceEx.getWorldOrCell(pl) === msg.transform.worldOrCell;
if (distance < 256 && inTargetCell) { this.reportArrival(msg.transform.worldOrCell); break; }
...
logError(this, 'Spawn loop gave up: still in', ObjectReferenceEx.getWorldOrCell(pl).toString(16),
         'expected', msg.transform.worldOrCell.toString(16));
```

`logTrace`/`logError` go to **`printConsole`** - the in-game console (`~`) and nowhere else. This was
checked: `Documents\My Games\Skyrim Special Edition\SKSE\skyrim-platform.log` contains only the
SkyrimPlatform host's own output, and no file anywhere mirrors `printConsole`.

**Get this first, before changing anything:**

1. Connect, press `~` immediately.
2. Find the lines containing `RemoteServer`.

Then:

- **`still in <hex>` where hex is NOT `25017482`** - the client resolved a different worldspace, or
  never left the one it started in. The hex names it. Compare against the runtime load order.
- **`still in 25017482`** - it reached the right worldspace but stayed further than 256 units from the
  target, so the coordinates or the cell are the problem after all.
- **no `Spawn loop` lines at all** - the spawn task never ran. Look at `onCreateActorMessage` and the
  `msg.isMe` branch in `remoteServer.ts`; something is short-circuiting before the loop starts.

## If the console turns out not to be enough

The next step is a client-side diagnostic, which costs a client rebuild and a re-download for every
player: add a file log beside `printConsole` in `skymp5-client/src/logging.ts`, or report the failure
to the server as a `dbo` packet so it lands in `server.log` like `npcDrift` does. Prefer the packet -
it matches how this codebase already measures client-side problems, and it needs no log hunting.

## Related, still open

- **RaceMenu shows the vanilla menu.** `skee64.dll` loads correctly (confirmed in `skse64.log`) and
  `RaceMenu.bsa` is correctly installed in the MO2 mod folder, so the mod is present. RaceMenu's full
  slider UI *was* seen earlier in the same session, so it can work. Leading theory: the server calls
  `setRaceMenuOpen` before RaceMenu has swapped in `racesex_menu.swf`, so Skyrim opens the stock menu.
  **Test first:** `showracemenu` in the console. Full RaceMenu UI means the mod is fine and the fix is
  to delay `setRaceMenuOpen` server-side; vanilla again means it is a mod/VFS problem instead.
- **The custom character creator is disabled** on purpose - Nat prefers RaceMenu.
  `"charCreator": { "enabled": false }` in `server-settings.json` (boot only). `spawn.ts:67` documents
  that disabling it "keeps the vanilla race menu".
- **`NAME: Prisoner` / `RACE: Nord`** in RaceMenu. May disappear now the custom creator is off, since
  RaceMenu becomes the only source of name and race. Re-check before treating it as a bug.

## Facts worth keeping

- Nat's profile id is **763749340**. It is minted by the launcher and stored client-side, so it
  **survives a server world wipe**. `adminProfileIds` in `server-settings.json` is boot-only;
  `admins` in `gamemode-config.json` hot-reloads, so use that one.
- The Realm of Lorkhan hub contains nine `RP_LorkhanGate<Hold>` portals, one per Skyrim hold. It is a
  small worldspace: 10 cells, 1 LAND record.
- Three launcher fixes shipped tonight for offline-mode servers (download guard, minted profile id,
  Discord launch gate) - commits `abca872`, `817741f`, pushed.
