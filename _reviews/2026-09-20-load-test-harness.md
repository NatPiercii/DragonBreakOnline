# Load test: a headless bot harness, and the first numbers from it

Written 2026-09-20. Answers the review item *"Load test before any real 100-player night"*
(`_reviews\2026-09-19-daily-review.md`), which asked for a headless bot client that walks N bots around
Bruma, sends chat and claims dungeons, and measures event-loop lag, outbound traffic and tick durations at
10, 25, 50 and 100 bots.

The harness is `server\tools\loadtest` (new folder, its own README). **Nothing in `fork\` or `server\` was changed
to build it**, and no bot has ever logged into the live server: every run in this report is against an
isolated sandbox instance of the same build, on port 7787, with its own world.

## 1. What the bots are

They are not a re-implementation of the protocol. Each bot drives **the game's own network plugin**,
`MpClientPlugin.dll`, through its exported C API, so every message goes through the same SLikeNet client and
the same `MessageSerializerFactory` the player's client uses. A field this harness gets wrong is a field the
real client would get wrong too.

    bot logic (node)  <-- lines -->  BotHost.exe (C#)  <-- P/Invoke -->  MpClientPlugin.dll  <-- UDP -->  server

`BotHost.exe` is ~350 lines of C# compiled by the `csc.exe` that ships with Windows (no SDK, no npm
packages; the node side uses only the standard library). It exists because the DLL keeps one client in a
file-static: each bot loads its own copy of the file, which Windows treats as a separate module with
separate state. One host process carries ten bots, and it counts the high-volume message types natively
instead of forwarding them, so the harness does not measure itself.

A bot logs in with its own offline `profileId` (900001+, never 1 and never an admin id), answers character
select, reports arrival, closes the race menu by sending an appearance, walks out of the hub through a
Realm of Lorkhan gate like a player, then walks plausible waypoints at run speed (350 u/s), sends
`UpdateMovement` every 130 ms, `ChangeValues` every few seconds, a chat line every 45-150 s, and optionally
claims a dungeon. The full flow, with the source line behind each step, is in `server\tools\loadtest\README.md`.

## 2. Five things the harness had to learn (all verified, none guessed)

1. **The caster of your own activation is the literal `0x14`**, not your actor's form id.
   `localIdToRemoteId` leaves `0x14` alone (`worldViewMisc.ts:20`) and `ActionListener::OnActivate` only
   skips its hoster check for `0x14` (`ActionListener.cpp:833`). Anything else is refused with
   `Bad hoster is attached to caster 0x..., but found 0x0` and the activation is silently dropped.
2. **The gamemode waits for the client's arrival report** (`{customPacketType:'dbo', event:'arrived',
   args:[worldOrCell]}`, `remoteServer.ts:429` -> `gamemode.js:1204`) before opening the creator. A client
   that never sends it is routed through the 12 s landing fallback instead, which is how the first bots
   ended up somewhere nobody intended.
3. **RakNet refuses two connections from one IP inside ~100 ms** (`SetLimitIPConnectionFrequency`,
   `Networking.cpp:168`), so a hundred bots have to arrive over about 25 seconds. Worth knowing before
   anyone worries about a real crowd logging in after a restart: they will queue themselves.
4. **`nlohmann` dumps object keys alphabetically**, so `"t"` sits at the END of every message, not the
   start. Anything sniffing a message type has to scan backwards.
5. **Windows has no per-process network byte counter without ETW.** Measured: sending 10 MB of UDP on
   loopback moves `Win32_Process.WriteTransferCount` by **0 bytes**. `\UDPv4\Datagrams Sent/sec` does see
   loopback (18.3k/s under a 20k/s flood), so the harness reports datagram rates plus exact message counts
   by type. For true bytes it grew a third instrument: `--measure-bytes` puts a counting UDP relay in front
   of each bot, which is pcap-free, needs no second machine, and is how the wire figures below were taken.

## 3. The numbers

Sandbox server, one machine, bots on the same box, bots spread over a 4,000-unit ring around Bruma city,
four dungeon claims running. Steps are cumulative, five minutes of measurement each.

| bots | msg/s to server | msg/s to bots | per bot in | KiB/s to bots (JSON) | UDP dgram/s | server CPU | RSS MB | tick p99 | loop lag p50 / p99 / max | errors |
|---|---|---|---|---|---|---|---|---|---|---|
| 10 | 74 | 330 | 33 | 88 | 557 | 3.1% | 980 | 16.59 ms | 15.52 / 16.96 / 17.6 ms | 1 |
| 25 | 184 | 3,247 | 130 | 908 | 2,021 | 4.0% | 975 | 16.60 ms | 15.56 / 17.24 / 19.99 ms | 0 |
| 50 | 368 | 14,518 | 290 | 4,121 | 4,732 | 9.6% | 1,003 | 16.60 ms | 15.55 / 19.33 / 19.56 ms | 0 |
| 100 | 736 | **61,951** | 620 | **17,752** | 8,634 | 20.6% | 1,022 | 16.61 ms | 15.61 / **26.49** / 29.84 ms | 0 |

Every bot kept its 7.1-7.2 movement messages a second at every step, nobody was disconnected, and the
whole 25-minute run produced **one** error line in `server.log` (`Refr pointer expired`, an actor crossing
a trigger volume in the same tick it was replaced). Memory did not move: 980 MB at 10 bots, 1,022 MB at
100. Four dungeon leases were open throughout, with 89 spawned enemies and 267 filled containers behind
them. Chat worked at every step: at 100 bots, 287 lines sent became 2,780 deliveries, which is the
distance ranges doing their job.

### The same sweep on the live server

Run against the live server on 7777 at the user's request, with the world snapshotted beforehand and
restored afterwards so nothing was left behind (see section 6). No dungeon claims and no NPC hosting, so
all 100 bots stayed in one worldspace.

| bots | msg/s to bots | per bot | createActor/s | server CPU | loop lag p50 / p99 | errors |
|---|---|---|---|---|---|---|
| 10 | 740 | 74 | 8 | 2.7% | 15.6 / 16.7 ms | 0 |
| 25 | 4,591 | 184 | 47 | 5.6% | 15.6 / 17.2 ms | 0 |
| 50 | 17,328 | 347 | 138 | 11.2% | 15.5 / 18.6 ms | 0 |
| 100 | **67,454** | 675 | 307 | 20.2% | 15.5 / **24.9 ms** | 0 |

**Zero errors in 25 minutes, no disconnects, no refused movement, memory flat at ~1 GB.** The relay is
about 10% heavier than the sandbox at the top step (67,454 against 61,951) and the stream churn is higher
too (307 createActor a second against 277) - partly because this run held no dungeon leases, so nobody was
tucked away in an interior, and partly because the live world has more references to stream.

The gameplay timers were indistinguishable from the sandbox at 100 players: `meet` 1.15 ms mean against
0.71-1.12, `lawful` 1.09 against 1.04-2.03, `watch` 1.09, `outside` 1.09, `playtest` 0.74, `moveTrace`
0.00. So the real character data behind `meet` and `lawful` costs nothing measurable now that both are
caches - which is the useful confirmation, because it means **the sandbox is a fair stand-in for load work
and nobody needs to touch live to get these numbers again.**

## 4. What the numbers say

### The wall is the movement fan-out, and it is quadratic

Look at the "per bot in" column: 33, 130, 290, 620 messages a second. It doubles when the player count
doubles, because **each player receives roughly (players nearby) x 7.1 messages a second**, and the server
therefore sends N times that. 330 messages a second at 10 players is 61,951 at 100 - a 188-fold rise in
outbound traffic for a ten-fold rise in players.

The same numbers against the model, where "full mesh" is every player being every other player's
neighbour (N x N x 7.1):

| bots | measured to bots | full mesh | share |
|---|---|---|---|
| 10 | 330 | 712 | 46% |
| 25 | 3,247 | 4,450 | 73% |
| 50 | 14,518 | 17,800 | 82% |
| 100 | 61,951 | 71,200 | 87% |

The share climbs towards 100% as the crowd fills the area, which is exactly what you would expect if the
relevance test is a fixed-size box rather than a distance: the more players, the more of them share a box.

What it costs today is bandwidth, not CPU: 20.6% of one core at 100 players, and 8,634 UDP datagrams a
second, which is RakNet coalescing about 7 messages into each one. Event-loop lag p99 went 17 -> 17 -> 19
-> 26 ms, and that is with the hundred bots competing for the same CPU as the server; the 26 ms is
pessimistic but the shape is real.

**The real wire figure**, measured through the harness's counting relay (`--measure-bytes`, one UDP relay
per bot) rather than estimated: at 25 players the server pushes **220 KiB/s, which is 8.8 KiB/s per
player**, and takes 16 KiB/s back. JSON is **4.6x** the size of the wire form, so the JSON column above
divides by 4.6: at 100 players that is about **3.8 MB/s out, 38 KiB/s (roughly 300 kbit/s) per player**.
That is comfortable for a hosted server and marginal for a home upload.

Double the players again and this is the number that breaks first: about 250,000 messages a second and
15 MB/s, or 120 Mbit/s of upstream at 200 players - a gigabit link runs out somewhere near 500, and a
home connection runs out long before that.

The mechanism is not subtle and it is worth writing down: a movement message goes to the sender's
**neighbours**, and the neighbour set is the 3x3 block of 4,096-unit grid squares around the actor
(`MpObjectReference.cpp:158` `GetGridPos`, `WorldState::GetNeighborsByPosition`). That is a square about
12,288 units on a side, and Bruma city is about 9,500 by 9,400 units. **The whole city is inside one
neighbour block**, so in the playtest region every player is every other player's neighbour, and each
player's 7.1 messages a second are copied to all of them. An actor is also its own listener on purpose
(`MpObjectReference.cpp:745`, "Self-subscription is OK"), so every player is sent their own movement back.

Three levers exist, in increasing order of effort:

- **Do not echo the sender's own movement back.** It is already on the open list in HANDOFF §16 ("stop
  echoing to the host"). At 100 players it is only 710 of the 61,951 messages a second, about 1%, so it is
  a tidiness fix rather than a scaling one - but it is the one that needs no design decision.
- **Interest management by distance rather than by grid block.** The grid is loaded-chunk bookkeeping that
  is being reused as a relevance test. A radius check per listener (or a smaller grid square with a
  configurable neighbour ring) would cut the fan-out in a crowd without touching the streaming distance
  elsewhere. C++.
- **Rate the fan-out, not just the source.** A player 8,000 units away does not need 7.5 position updates a
  second; 2 would look the same. A per-listener rate ladder by distance is the standard fix and it composes
  with the other two.

### The gameplay timers are not the problem, with one exception

The gamemode now logs its own per-timer summary once a minute (another session's instrumentation), and the
harness copies those lines into each step's report. Means per call, from the sweep:

| timer | calls/min | 25 players | 50 players | 100 players |
|---|---|---|---|---|
| `lawful` | 4 | 2.4-3.5 ms | 4.6-4.8 ms | **6.99 ms** |
| `moveTrace` | ~1,940 | 0.12 ms | 0.22 ms | 0.47 ms |
| `moveTraceWrite` | 12 | 0.83-0.93 ms | 1.06-1.09 ms | 1.80 ms |
| `dungeons.arm` (4 leases) | 30 | 1.2-1.3 ms | 1.3-1.5 ms | 1.53 ms |
| `dungeons.tick` (4 leases) | 4 | 1.4-1.8 ms | 1.6-2.0 ms | 2.09 ms |
| `meet` | 12 | 0.16-0.21 ms | 0.36-0.38 ms | 1.52 ms |
| `watch` | 12 | 0.28-0.31 ms | 0.43-0.54 ms | 1.25 ms |
| `playtest` | 12 | 0.23-0.30 ms | 0.37-0.50 ms | 0.72 ms |
| `outside` | 6 | 0.27-0.28 ms | 0.56-0.61 ms | 1.51 ms |

Add those up at 100 players and the entire gameplay timer layer costs about **1.1 seconds of CPU a minute,
under 2% of one core** - and most of that is `moveTrace`, a diagnostic, at 32 calls a second. The server
process was using about 30% of a core at that moment. So roughly **95% of what the server does at 100
players is relaying packets**, not running the gamemode.

Read that as a list of things that are **not** the problem. `meet` was the one everybody expected to
explode - it was O(n^2) pairwise until this week - and at 50 players it costs a third of a millisecond;
the grid rewrite did its job. `watch`, `playtest`, `outside` and `needs` are all under a millisecond.

Two exceptions, both already in hand:

- **`lawful` is a blocking disk read per player.** It grew 2.5 -> 4.7 ms from 25 to 50 players, and an
  earlier run on an older server process measured 10-11 ms at 25. The cause: the lawful tick calls
  `refreshLawful` for every online player, which walks `isLawful` -> `ranksOf` -> `readOfficials`, and
  `readOfficials` was a synchronous `readFileSync` + `JSON.parse` of `officials.json` **per player**. The
  perf session fixed it (`6f68fc3`, an mtime-checked in-memory cache) after this sweep's snapshot was
  taken, so the numbers above are the before. The total CPU is small either way; what it produces is a
  blocking spike every 15 s, which is jitter in everyone's movement.
- **`moveTrace` runs 32 times a second** and reads every online player. It was a diagnostic; the movement
  session made it opt-in per actor (`e07b09c`) after this snapshot too.

**The pattern worth grepping for is "per-player synchronous file read inside a timer".** It was pigeon
cooldowns and contracts (review item S7), then `officials.json`, and each one only becomes visible when
enough players are online, which is exactly the thing that is hard to notice before opening night.

### Both fixes re-measured, same afternoon

Both landed while this was being written, so the harness was pointed at them: `sandbox init` to pick up the
current gameplay layer, then the same 25- and 100-bot runs.

| timer at 100 players | before | after |
|---|---|---|
| `lawful` mean | 6.99 ms | 1.04-2.03 ms |
| `moveTrace` mean | 0.47 ms (915 ms/min) | 0.00 ms (max 0.03-0.31) |
| `dungeons.arm` mean (4 leases) | 1.53 ms | 0.80 ms |
| `dungeons.tick` mean (4 leases) | 2.09 ms | 1.11 ms |
| whole timer layer | ~1.1 s of CPU a minute | **~0.07 s a minute** |

(The dungeon pair was a third fix, `86da0d6`: each lease was re-reading every id in `zone-spawns.json`
every tick, including ids belonging to other leases and to wildlife. One shared snapshot per tick now.
The "after" run happened to hold heavier dungeons than the "before" one - Sedor alone is 36 spawn zones -
so that improvement is understated rather than flattered.)

*(Superseded in one respect: the ambush work of 2026-09-20 evening, commit `90bfec3`, marks 971 placements
across 95 dungeons as `Ambush: true`, and those wait for a player inside their own radius instead of
pre-spawning with the claim. Every prespawn count and claim-time churn figure below was measured before it -
Northfringe Sanctum, for example, now pre-spawns 15 where this run saw 33. The timer numbers are unaffected:
they scale with living actors, and the ambush actors still arrive, just later.)*

**Checked again at many leases**, because four is not where a leases-times-ids cost would show. A third run
put 100 bots on twenty dungeon doors at once; thirteen leases were granted, holding **225 living enemies**
against the four-lease run's 135:

| | 4 leases, 135 enemies | 13 leases, 225 enemies | if it were still linear in leases |
|---|---|---|---|
| `dungeons.arm` mean | 0.80 ms | **0.86 ms** | 2.6 ms |
| `dungeons.tick` mean | 1.11 ms | **1.53 ms** | 3.6 ms |

Tripling the leases moved `arm` by 8%. What growth there is tracks the enemy count, which is the per-actor
work that has to happen, and it is sub-linear even in that. The quadratic is gone. (`factions:` - the
faction audit that runs once per new actor - wrote 22 lines across that run, its first real volume.)

The gameplay timer layer is now about **0.1% of one core at 100 players**, and the traffic and CPU of the
runs did not move at all: 61,951 messages a second at 20.6% CPU before, 60,742 at 20.3% after the first two
fixes, 61,253 at 17.4% after the third, with loop lag p99 26.5, 25.2 and 25.0 ms. That is the clearest
statement of where the budget goes: **three real per-player bugs left the gameplay layer and the server's
cost did not change**, because it was never there.

One more probe, suggested by the perf session: with 100 bots connected, a newline was appended to the
sandbox's `gamemode.js` to force a hot reload, because the met-list cache lives in module scope and every
reload empties it. The first `meet` tick after the reload peaked at **2.48 ms** (steady state is about 1 ms),
so refilling the cache for a hundred players costs about a millisecond and a half, once. No action needed,
and worth knowing since a dev save with players online does this on purpose.

### Stream churn is the second cost, and nobody has looked at it

After movement, the busiest message types are `CreateActor` and `DestroyActor`, in near-equal numbers: 18
and 20 a second at 10 bots, 32 and 31 at 25, 109 and 110 at 50, and **277 and 277 a second at 100**. They
are not spawns and despawns. They are the same references streaming in and out as players
cross grid squares: `ForceSubscriptionsUpdate` recomputes the 3x3 block on every crossing
(`MpObjectReference.cpp:550`), subscribes to what entered the set and drops what left, and a subscription
is delivered as a full `CreateActor`.

That matters more than the count suggests, because `CreateActor` is the fattest message in the protocol: it
carries appearance (including every tint), equipment, inventory, the animation, the custom properties and
the whole additional-props block (`CreateActorMessage.h`). A player running across Bruma at 350 u/s crosses
a 4,096-unit boundary about every 12 seconds, and each crossing re-streams a third of the block.

Nobody has tuned this and it has never been measured before today. Two cheap questions worth asking before
the C++ work above: does a subscription need the full payload every time the same reference re-enters the
set, and does the grid need to resubscribe at all for a player who has moved 30 units past a boundary
(hysteresis)?

### The server that "vanished" was killed from outside, and it is worth knowing why

On the first twenty-lease attempt the sandbox server process disappeared 80 seconds into the measured
window, a minute after the last lease was claimed, with nothing in its log: no stack, no shutdown line,
just the log stopping mid-warning. All 100 bots reported a disconnect. It looked like a crash with many
dungeons open, which would have been a serious finding.

**It was not the server.** Restarting the live server by sweeping processes -
`Get-CimInstance Win32_Process ... | Where-Object { $_.CommandLine -like '*skymp5-server*' }` - matches
every copy of the bundle, and the sandbox ran the same file name, so it was stopped along with the live one.
Checked against `server\server-exit.log` rather than taken on trust; every death on my side sits within a
second of a live restart:

| live server restart | what died on my side | whose restart |
|---|---|---|
| 14:16:48 exit -1, back up at 14:16:55 | the first twenty-lease run **and** its sandbox, together | **unattributed** - nobody has claimed it and several sessions were active |
| 14:28:36 exit -1 | the sandbox at 14:28:35.876, mid-warning | the perf session's sweep, confirmed by them |
| 14:43:52 exit -1 | the sandbox at 14:43:52 | the same sweep, confirmed |

An earlier version of this note pinned the 14:16 row on a particular session and cited the mtime of
`server\data\DragonBreak Online Edits.esp` as corroboration. That was withdrawn: the file has been written
again since (it now reads 14:50), and a timestamp that moves is not evidence of who restarted six minutes
before it. All that row rests on is the exit log.

The conclusion does not depend on who: a sweep by bundle name is a hazard whoever runs it. There is **no
evidence of a server dying with many dungeons open**, and my first guess, that a long foreground wait in my
own tooling was to blame, was wrong too.

The sandbox's copy of the bundle is now called `dbo-loadtest-server.js`, so no sweep for the live server can
reach it. A marker argument would have been neater and is not available: `settings.ts:95` calls argparse's
`parse_args()` with no arguments defined, so the server exits on any flag it does not know. The other half
of the lesson belongs to whoever writes a restart script: **match on the working directory or the port**,
never on a bundle name that every copy of the server shares.

### Two smaller things the runs turned up

- **A server that stops with a dungeon lease open spams its next boot.** The lease's zones are still in
  `NPC-Spawns.json`; `npcSpawnSystem` reads that file at boot and starts placing them, and `dungeons.js`
  only clears them about thirteen seconds later when the gamemode finishes loading (`dungeons.js:856`
  does the right thing, it is just late). Measured: 73 `failed to spawn ... Form with id ... doesn't exist`
  lines in the first 40 seconds after such a boot. Harmless, self-correcting, and worth knowing because it
  will look alarming in the log after any crash during an evening with dungeons running. The harness now
  strips orphan `dungeon:*` zones before it starts the sandbox, which is the same fix one line earlier in
  the boot.
- **1,165 `GetBaseActorValues ... Negative Magicka` warnings** in a 25-minute run, about three a second
  while dungeon NPCs are alive: base records whose `magickaOffset` is -25 with `startingMagicka` 0. It is
  a warning per read, not per actor, so it is pure log volume - and log volume at 100 players is work.

### NPC hosting, measured at last

`--host-npcs` was written blind and was quietly broken: it looked for `baseRecordType === 'NPC_'`, and the
server only ever sets that field to `"DOOR"` (`MpObjectReference.cpp:72`), so no bot ever asked to host
anything. A server-spawned actor is instead recognised by being a dynamic ref (`0xff...`) that carries actor
props and is not another bot. With that fixed, and with wildlife seeded where the bots actually stand:

| 100 bots, 240 s | msg/s to bots | server CPU | loop lag p99 |
|---|---|---|---|
| no seeded npcs, 4 leases (earlier baseline) | 60,742 | 20.3% | 25.2 ms |
| 200 seeded zones, bots do **not** host | 66,643 | 20.0% | 27.3 ms |
| the same, bots **host** what they can | **77,117** | 21.8% | 28.8 ms |

The bots held only **34** npcs and sent **243** hosted-actor movement messages a second, and that produced
**10,474 more messages a second leaving the server**: about **43 listeners per hosted actor**. The npcs are
spread over the same ring the players are, so each has fewer neighbours than a player's ~87.

Extrapolate to the live npc budget of 150 all hosted and it is roughly **46,000 messages a second on top of
the players' 62,000** - so a populated world does not add a little to the relay bill, it adds most of
another one. This is the multiplier `SCALING_NOTES.md` predicted, now with a number on it.

Two traps found on the way, both worth knowing outside the harness:

- **Wildlife had to be seeded at all**, because of where it is: of 3,185 `wild:*` zones, 2,612 are in
  Tamriel and only 345 in the Bruma worldspace, with exactly **one** inside 5,000 units of the city the
  playtest crowd stands in. Every earlier measurement in this document is therefore player-to-player only,
  in a world with essentially no npcs near the players.
- **A zone that disappears while its npcs live orphans them forever.** The first seeded zones were named
  `wild:loadtest:*`; `wildlife.js` owns that prefix and rewrites its entries on every gamemode load, so the
  zones were deleted and their npcs stayed alive, streamed and hostable but tracked by no zone -
  `checkMisplaced` never examines them, so no detector can correct them. The same is true of any npc whose
  zone leaves `NPC-Spawns.json` while the server runs.

And a third, from the sandbox's own wreckage: **a server killed while players are connected leaves their
characters enabled in the world.** On the next boot they stream to everybody and any client can take host
of them. The sandbox had collected about 200 such bodies from runs that were killed mid-flight.

### The sliding detector, exercised on the live path

`npcSpawnSystem`'s new `isSliding` check (a copy whose x/y are frozen while its z creeps is riding a
`translateTo` nobody stopped) could not be tested in game, so the harness did it: four bots took host of a
zone npc each and reported it with x/y frozen and z rising 6 units a second. It fired twelve times, each at
278-286 units off the spot, which is `FLOAT_LIFT` 250 plus its three confirming polls:

    NpcSpawnSystem: 'loadtest:0' ff000008 is riding a translation nothing stopped, 285 off its spot
    with its x/y frozen, placing it again

No false fire on the 48 zones' npcs standing still in the same world, and none on the drifting ones before
they crossed the threshold. `--drift-axis x` walks a hosted actor out of its zone instead, for the
`strayed` path.

### Twenty doors at once: the live-NPC budget runs out and dungeons come up empty

Re-run against the evening build (ambush, `90bfec3`, plus the refusal logging in `73fb0e5`), 100 bots, 20
dungeon doors claimed at once. Two results, and the second is the important one.

**Refusals now say why, and the first run's said it was my bug.** 14 claims granted, 6 refused, and all six
read `claim from beyond 2500 units of the entrance`: the bots pressed claim while the server still had them
a warp step short of the door, because `tickTravel` was steering each one back towards its home patch while
the dungeon code warped it to the door. Fixed (`driveTo` plus one settle tick before the claim); the
verification run claimed **21 of 21** doors with zero distance refusals, the 14 refusals it did log being
honest ones - `claimed by another party for 56 more min`, from the previous run's leases.

**With enough leases open, a claim pre-spawns nothing.** Every one of the seven doors claimed in the second
run reported `0 prespawned` - Underpall with 69 enemies, Anga with 21, Fort Caractacus with 15, all zero.
The cause is the live-NPC budget: `zone-spawns.json` sat at exactly **150**, the default `npcLiveBudget`,
with the log repeating `budget of 150; 'dungeon:CYRSedorLocation:10' waits for room`. Fourteen leases from
the earlier run were still holding about 142 actors, and wildlife wanted the rest.

The failure mode matters more than the number:

- Nothing errors. The claim succeeds, the party is moved in, and the claim line still reads
  `15 enemies, 0 prespawned` - a phrase nobody would notice in a log.
- The party walks into an **empty dungeon**, and enemies trickle in only as other actors despawn
  elsewhere in the world.
- **Fourteen concurrent leases is enough to exhaust it** in the Bruma playtest. `SCALING_NOTES.md` already
  says 150 "is a playtest number" and that the right value is expected players times NPCs a player should
  see; this is the measured threshold behind that sentence.
- The ambush change softens it by accident, not by design: it holds 68 of 210 actors back (32%) until a
  player is inside the radius, which frees budget for other leases but also means a late claimant's
  ambushers may be what finally spawns.

Raising `npcLiveBudget` is one line in `server-settings.json` and needs a restart. Before raising it, watch
memory and change-form count, which is the cost the budget exists to bound.

### What the harness cannot see, and what that means for the 100-player night

- **Bots run no AI.** `--host-npcs` now reproduces the *traffic* of hosting (measured above) but not the
  behaviour: a bot's hosted npc stands where it was streamed instead of walking, fighting or pathing. It
  must not be pointed at a live server, because a bot holding host of an npc freezes that npc for the real
  players around it.
- **Nothing fights.** No hits, no deaths, no loot, no corpse trimming, no skinning.
- **Every bot is a fresh or near-fresh character.** No 500-entry `metActors` lists, no large inventories,
  no housing, no mastery records. Real characters are heavier in every one of those.
- So these numbers are a **floor**, not a ceiling. The right reading is: this is what the server does when
  a hundred people are merely present and walking.

## 5. Recommended order of work before a 100-player night

Ranked by what the measurements say, not by what looked expensive in the code.

1. **Decide the movement relay policy.** With the two timer fixes in, it is essentially all of the server's
   work at 100 players, and it is the only thing here that grows quadratically. Cheapest first: stop
   echoing a player's own movement back to them (about 1%, but it needs no design decision); then interest
   management by distance instead of by 3x3 grid block; then a per-listener rate ladder so a player 8,000
   units away gets 2 updates a second instead of 7. The second and third are C++ and they are the single
   highest-value change on the roadmap for player count.
2. ~~Land the two per-player timer fixes and re-measure~~ **done this afternoon** (`6f68fc3`, `e07b09c`);
   see the before-and-after above. The pattern they came from - a per-player synchronous file read inside
   a timer - is worth one grep across the gameplay layer.
3. ~~Give `dungeons.arm` and `dungeons.tick` the same treatment~~ **also done this afternoon** (`86da0d6`),
   and measured: 1.53 -> 0.80 ms and 2.09 -> 1.11 ms at 100 players with four leases. The remaining cost is
   each lease reading its own actors, which is real work. Worth re-measuring at the twenty leases a busy
   evening would have, which the harness can do by naming twenty dungeons.
4. **Then, and only then, worry about the gameplay layer.** Everything else in the timer table is under
   two milliseconds at 100 players.
5. **Run the definitive test from a second machine.** One box cannot both simulate a hundred clients and
   be measured by them: the harness used more CPU than the server did, so the latency numbers here are
   pessimistic. Bots on another machine also make the NIC byte counters usable as a cross-check on the
   relay figure.
6. ~~Then re-run with `--host-npcs`~~ **done, and it is the multiplier the plan expected**: 34 hosted npcs
   added 16% to the fan-out, so the live budget of 150 would add roughly another 46,000 messages a second.
   Whatever interest management is chosen in step 1 has to cover hosted actors, not just players - they ride
   the same relay path and there are more of them than there are people.

Two things this run says are **not** urgent, which is worth as much as the list above: the gameplay timers
(other than the two being fixed) and the server's memory, which sat at 1.0 GB from 10 bots to 100.

## 6. How to repeat this

    cd server\tools\loadtest
    node loadtest.js build                     (once)
    node loadtest.js sandbox init              (after any server or gamemode change)
    node loadtest.js run --steps 10,25,50,100 --seconds 300 --dungeons

Reports land in `server\tools\loadtest\reports\<stamp>\report.md`, one folder per run with a JSON per step, so
before-and-after comparisons are a diff rather than an argument. That is how the two timer fixes above were
checked within an hour of being written.

Against the live server it is `--target live --yes-live`, and preflight refuses while anyone is connected
(it asks the server's own `skymp_server_connected_clients_count` when `/metrics` is on, because a client
killed without a disconnect line leaves the log lying) or while a dungeon lease is open.

**A live run leaves permanent marks unless you snapshot first**: a character per bot in
`world\changeForms`, a row per profile in `starter-grants.json`, and a permanent entry in the name and
#TAG index that pigeons use to find offline characters (`gamemode.js:456-458`). That is why bots are named
`LOADTEST 001`-`100` rather than plausibly, and why the live run on 2026-09-20 was done like this:

    node loadtest.js sandbox stop                  (free the port, not needed for a live run)
    # stop the live server, then, with it stopped:
    copy server\world\ and starter-grants.json, zone-spawns.json, npc-fallen-spots.json,
         companions.json, housing.json into server\_world-snapshot-<stamp>\
    # add metricsAuth to server-settings.json (backed up first), start the server, run the sweep
    # stop the server, copy the snapshot back, restore server-settings.json, start again

Verified afterwards by counting: `changeForms` back to 650, `starter-grants.json` back to 1 row from 101,
`npc-fallen-spots.json` still exactly 11 entries, `metricsAuth` gone, and no `LOADTEST` string anywhere in
the world. The bot characters had not even been flushed to disk when the server was stopped.

Restore only with the server **stopped** - a running process holds change forms in memory and will write
over what you just put back - and only when nobody real is connected, because the restore discards
everything that happened in the window.
