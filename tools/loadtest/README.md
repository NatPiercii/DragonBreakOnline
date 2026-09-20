# DragonBreak load test harness

A headless bot client and a measuring rig, for answering "what happens to this server at 100 players"
before a hundred people find out for us. Built 2026-09-19 against the review item
*"Load test before any real 100-player night"* in `_reviews\2026-09-19-daily-review.md`.

It changed nothing it measures: no edit to the fork, the gameplay layer or the server's data. It lives at
`server\tools\loadtest` and is tracked only because it was force-added - `server\.gitignore` excludes
`tools/`, so `git add .` will never pick up a new file here. Add one explicitly or it stays untracked.

    node loadtest.js build                  compile bin\BotHost.exe (uses the csc.exe that ships with Windows)
    node loadtest.js sandbox init           build an isolated copy of the live server
    node loadtest.js sandbox start|stop|status|reset
    node loadtest.js preflight --target live    is anyone playing on 7777 right now
    node loadtest.js dry --bots 2 --seconds 60  a couple of bots, verbose, no measurement
    node loadtest.js run --steps 10,25,50,100 --seconds 300

Reports land in `reports\<timestamp>\` as `report.md` plus one JSON per step.

## How a bot talks to the server

It uses the **game's own network plugin**. `MpClientPlugin.dll` (from
`server\client-dist\Data\SKSE\Plugins`) exports a tiny C API - `CreateClient`, `Send`, `Tick`,
`IsConnected`, `DestroyClient` - and behind it sits the real SLikeNet client and the real
`MessageSerializerFactory`. A bot therefore sends exactly the bytes the game sends, including the binary
message formats, and anything this harness gets wrong on the wire is wrong in game too. The DLL imports
only `WS2_32`, `KERNEL32` and `IPHLPAPI`, so it loads fine outside Skyrim.

    bot logic (node)  <-- lines -->  bin\BotHost.exe (C#)  <-- P/Invoke -->  MpClientPlugin.dll  <-- UDP -->  server

`BotHost.exe` exists because the DLL keeps **one** client in a file-static: each bot loads its own copy of
the file (`bin\runtime\mpclient_<host>_<bot>.dll`), which Windows treats as a separate module with separate
state. One host process carries `botsPerHost` bots (default 10). The host also filters: high-volume messages
(movement, animation, equipment, actor values) are counted natively and never cross the pipe, or parsing
them in node would measure the harness instead of the server.

The C# is compiled by `%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`, which is present on every
Windows box. No SDK, no npm packages: the whole harness runs on node's standard library.

### The login flow a bot follows

The same one a player's client walks through, checked against the fork's source line by line:

1. RakNet connect. The password is `kMessagingProtocolVersion` (`"7_"`, `Config.h`), so a protocol
   mismatch shows up as a refused connection, not as garbage.
2. `loginWithSkympIo` with `gameData.profileId` - offline mode takes the id the client names (`login.ts:272`).
3. `characterSelectMenu` arrives, the bot answers `characterSelectResult` with `play` or `create` (`spawn.ts`).
4. `createActor` with `isMe` gives the bot its `idx`, its actor form id and where it is standing.
5. The bot reports arrival (`{customPacketType:'dbo', event:'arrived', args:[worldOrCell]}`), which is what
   the gamemode waits for before opening the creator (`remoteServer.ts:429`, `gamemode.js:1204`). A bot that
   skips this takes the 12 s fallback through the landing point instead.
6. On `SetRaceMenuOpen` it waits a few seconds and sends an `UpdateAppearance` - an accepted appearance is
   what finishes character creation (`spawn.ts:488`).
7. A fresh character is in the hub, so the bot walks to the nearest Realm of Lorkhan gate (the nine
   `RP_LorkhanGate*` DOOR refs stream in like any other ref) and activates it. The playtest lock turns that
   into a move to the Bruma arrival.
8. Then: `UpdateMovement` every 130 ms, `ChangeValues` every few seconds, a chat line now and then, and
   optionally a dungeon claim.

Two details cost an hour each and are worth remembering:

- **The caster of your own activation is the literal `0x14`**, not your actor id. `localIdToRemoteId` leaves
  `0x14` alone (`worldViewMisc.ts:20`) and `ActionListener::OnActivate` only skips its hoster check for
  `0x14` (`ActionListener.cpp:833`). Sending the actor id gives
  `Bad hoster is attached to caster 0x..., but found 0x0`.
- **Custom gamemode properties are not in `props`.** A `createActor` carries them in
  `customPropsJsonDumps`, an array of `{propName, propValueJsonDump}` (`CreateActorMessage.h`), which is
  where `ff_factions` and friends are read from. And `baseRecordType` is only set when the base is a DOOR
  (`PartOne.cpp:869-874`), which is why an `=== 'NPC_'` test never matches anything - `--host-npcs` was
  silently hosting nothing until that was fixed.
- **`nlohmann` dumps object keys alphabetically**, so `"t"` is at the END of a message, not the start. The
  host scans backwards for it.

## Using it as a library

Other sessions drive the `lib/` modules from their own script for one-off questions (a faction probe, an
ambush check) rather than running a sweep. Two things about a bot that cost people time:

- **Move a bot with `bot.driveTo(pos, radius)`, not by setting `warper`.** `tickTravel` steers back towards
  `bot.home` on every tick, so a warper set from outside is undone on the next one. `driveTo` moves both.
- **A bot cannot reach anything down a cell chain.** It has no engine, so it never walks through a load
  door: interior cells have their own coordinate space, and a bot only ever moves inside the cell or
  worldspace the server last put it in. Anything behind a second door - a deeper dungeon room, an ambush
  placement in a back cell - is out of reach. The only cross-cell moves a bot gets are the ones the server
  performs for it: a hub gate, a dungeon claim's teleport, the playtest bounce.

## Safety

- `--target live` refuses to run without `--yes-live`, and `preflight` blocks when `server.log` shows a
  player connected, activity in the last 20 minutes, or a dungeon lease with no release line. Live runs are
  a deliberate act: every bot login writes a character into the live world and a row into
  `starter-grants.json`.
- Bot profile ids start at 900001 (`config.json`). Preflight refuses any id that is 1 or listed in
  `adminProfileIds`, because offline mode would hand that bot a senior admin account.
- The sandbox's copy of the server bundle is called `dbo-loadtest-server.js`, **not** `skymp5-server.js`.
  That is deliberate: on 2026-09-20 a session restarting the live server swept processes by
  `CommandLine -like '*skymp5-server*'` and killed the sandbox three times mid-run. Do not rename it back,
  and if you write a restart script, match on the working directory or the port instead. A marker argument
  cannot be used: `settings.ts:95` calls argparse's `parse_args()` with no arguments defined, so the server
  exits on any flag it does not recognise.
- The **sandbox** is the default target and the reason the live server can be left alone. It is the same
  bundle, the same `gamemode.js`, the same data files and the same load order, with its own port (7787), its
  own world folder, `/metrics` switched on and a short logout grace so steps do not overlap. Plugins are
  hardlinked from `server\data`, not copied, so nothing is duplicated and nothing writes back.

## What is measured, and what the numbers mean

| Number | Where it comes from |
|---|---|
| tick p50/p90/p99, ticks/s | `skymp_tick_duration_summary_seconds` from the server's own `/metrics` |
| event loop lag mean/p50/p99/max | prom-client's `nodejs_eventloop_lag_*` |
| server CPU %, RSS, heap | `process_cpu_seconds_total` and `process_resident_memory_bytes`, or `Get-Process` when there is no `/metrics` |
| UDP datagrams/s | `\UDPv4\Datagrams Sent/sec`, machine-wide, minus the idle baseline |
| messages/s in and out, per type | counted inside `BotHost.exe` for every bot |
| KiB/s of JSON | the deserialized size of what the bots received |
| per-timer tick durations | the `ticks (ms, last 60 s, N online)` lines the gamemode writes, captured from `server.log` |
| errors | `server.log` lines while the step ran, grouped by signature |

Honest limits, measured rather than assumed:

- **There is no per-process byte counter for the network on Windows.** Measured 2026-09-19: sending 10 MB of
  UDP on loopback moves `Win32_Process.WriteTransferCount` by **0 bytes**. `\UDPv4\Datagrams Sent/sec` does
  see loopback (18.3k/s under a 20k/s flood), so by default the harness reports datagram rates and the JSON
  byte volume the bots received. `--measure-bytes` gets the true number instead: each bot connects to its own
  UDP relay (`lib\relay.js`) which forwards to the server and counts both directions, which is a pcap-free
  way to measure the wire. The relay adds a hop, so the per-client rate is the number to carry forward.
- **`tick` is not work.** `index.ts:269` times `server.tick()` **plus** the `await setTimeout(1)` after it, so
  a p50 near 15.5 ms is the Windows timer granularity (about 64-69 ticks a second), not load. Watch the p99
  and the loop lag for the real signal.
- **Bots run no AI.** Nothing they host fights back, and without `--host-npcs` nobody hosts the NPCs near
  them at all, so a bot-only run under-represents hosted-actor traffic. `--host-npcs` asks for host of NPCs
  that stream in and sends a standing movement sample for each, which reproduces the traffic but not the
  behaviour. Leave it off on a live server: a bot holding host of an NPC freezes that NPC for real players.
- **The harness is not free.** Measured at 50 bots on one box: five `BotHost.exe` processes at about 36 MB
  each, and together they burned roughly as much CPU as the server process did. Per-process CPU and memory
  for the server are still honest, but latency is not: everything is competing for the same cores, so
  event-loop lag on a one-box run is pessimistic. For the definitive 100-player number, run the bots from a
  second machine - which also makes the NIC byte counters work.
- **Bots walk, they do not path.** There is no collision or navmesh on the server, so a bot reports a
  plausible straight-line position at run speed (350 u/s, from `UNITS_PER_METER = 70` in `gamemode.js`) with
  a configured ground height. Zone and proximity checks are 3D, so the height has to be roughly right, and
  `config.json` carries one per place.
- **Crossing Bruma by warp.** `--no-warp` makes bots run the whole way. By default a bot covers a long
  distance in steps just under the 4096-unit per-packet limit, which is only possible because movement has
  no rate or speed validation (`SERVER_AUTHORITY.md` item 2, still open). Each step counts as a warp step in
  the report; the gamemode's own `movetrace` will log them as teleports.

## Options

    --target sandbox|live     default sandbox
    --steps 10,25,50,100      cumulative: bots are added, not restarted
    --seconds 300             measured window per step (after a 6 s settle)
    --bots N                  for "dry"
    --dungeons                claim the dungeons in config.json ("--dungeons id1,id2" for your own, "none" for off)
    --spread city|arrival     where the bots play (config.json "places")
    --measure-bytes           route every bot through a counting UDP relay for real wire bytes (costs a hop,
                              so use it on the smaller steps: bytes per client per second is what extrapolates)
    --host-npcs               also host and drive NPCs that stream in (sandbox only). An npc is recognised
                              by being a dynamic ref with actor props: baseRecordType is NOT it, the server
                              only ever sets that to "DOOR" (MpObjectReference.cpp:72)
    --seed-wildlife N         clone N real Bruma wildlife zones to where the bots stand, so there is
                              anything to host at all. Of 3,185 wild zones only 345 are in the Bruma
                              worldspace and just ONE within 5,000 units of the city the bots play in.
                              Seeded zones are named loadtest:* on purpose - wildlife.js owns wild:* and
                              dungeons.js owns dungeon:*, and each deletes the other entries on load
    --drift-hosted            report a hosted npc with its x/y frozen and its z creeping, which is the
                              signature npcSpawnSystem's isSliding detector looks for
    --drift-units N           units per second of drift (default 4); --drift-seconds how long
    --drift-axis x            walk the hosted npc out of its zone instead of lifting it (the strayed path)
    --no-warp                 walk the long distances instead of stepping across them
    --no-chat --no-av         drop chat / actor-value traffic
    --bots-per-host 10        bots per BotHost.exe process
    --connect-gap-ms 250      RakNet refuses two connections from one IP inside ~100 ms
                              (SetLimitIPConnectionFrequency, Networking.cpp), so the ramp is deliberate
    --keep-sandbox            leave the sandbox server running when the run ends
    --verbose                 per-bot lines while it runs
    --force                   run even though preflight objected
    --yes-live                required for --target live

## Files

    loadtest.js          CLI, the runner, preflight, the step builder
    config.json          rates, places, dungeons, profile id base
    native\BotHost.cs    the C# transport host (one process, several bots)
    native\build.cmd     builds it with the Windows csc.exe
    lib\protocol.js      message builders, copied from the C++ message headers
    lib\bot.js           one bot: login, creation, gate, walking, chat, dungeon claim
    lib\walk.js          waypoints and the warp stepper
    lib\host.js          the BotHost process pool
    lib\formid.js        plugin desc -> form id, the way libespm's Combiner does it
    lib\metrics.js       /metrics scrape, Windows counters, server.log tail and grouping
    lib\sampler.ps1      one CSV line a second: UDP datagrams, server CPU, RSS, threads
    lib\sandbox.js       the isolated server instance
    lib\report.js        report.md and the per-step JSON
    sandbox\             the isolated server (generated; delete it freely). It reads as ~540 MB but the
                         plugins are hardlinks, so it really costs about 35 MB
    bin\                 BotHost.exe and the per-bot DLL copies (generated; a run clears stale copies,
                         and 100 bots means 150 MB of them while it runs)
    reports\             one folder per run: report.md plus a JSON per step
    Data\Platform\Distribution\password
                         empty on purpose. MpClientPlugin reads this path relative to the working directory
                         and warns to stdout when it is missing; empty means the same default password
                         ("7_", the protocol version). If the server ever sets a password, put it here too

## Related work

`server\tools\bot\bot.py` is a single-bot ctypes version of the same idea, written the same day for the
stamina/magicka relay question. It is the better tool for "what does one client actually receive"; this one
is for "what does the server do when a hundred of them arrive at once".
