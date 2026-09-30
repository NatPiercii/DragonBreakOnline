# Alpha capacity gate: the load test

The Road to Alpha's capacity gate: **no crash at 50 players, and tick lag and memory under the limits below**, with
10, 25, 50 and 100 simulated players. The bots are this folder's harness (README.md): each drives the game's own
`MpClientPlugin.dll`, logs in, crosses the hub gate into Bruma, walks, chats and, with `--fight`, trades fists with a
partner, so damage, the down state, mastery and the law run on the server as in a real brawl.

**Nothing here runs by itself.** Every step below is a command Nate runs.

## Where to run it

| | A: sandbox on CT 115, bots on the PC (recommended) | B: everything on the PC |
|---|---|---|
| Build under test | exactly the live one (`/opt/alduinak/build/dist/server`, same plugins) | whatever the PC's `server` folder holds |
| Your PC carries | the bots only (10 per `BotHost.exe`, ~36 MB each) | the bots and the server, competing for cores |
| Lag numbers | honest (the server has CT 115's cores to itself) | pessimistic (README: "the harness is not free") |
| Cost to the live box | small in CPU and memory, see below; **upload through Jake's line** | none |
| Setup | `sandbox.sh init/start` on CT 115, one ssh window | refresh the PC's `server` folder from the release first |

**What option A costs the live box** (the 2026-09-20 sweep's numbers, re-measured by this run's sampler):
- CPU: about 20% of one core at 100 players, out of CT 115's 8. The sandbox runs at CPUWeight 50 against the live
  server's 400, capped at 3 cores (`CPU_QUOTA`) and 4 GB (`MEM_MAX`), at nice 10. The live server keeps its 4 GB
  memory floor.
- Memory: about 1 GB of CT 115's 13 GB free.
- **Upload is the real cost.** Movement fans out to every player nearby, so traffic grows with the square of the
  player count. The 20 Sep estimate was about **0.3 Mbit/s at 10, 2 at 25, 8 at 50 and 30 at 100**, all leaving
  through Jake's connection to your PC, alongside the live players' traffic.
  - Ask Jake before the 100 step, or run the 100 step with option B.
  - The sampler records the real figure (`CT 115 upload` in gate.md).
- Run it when the live server is empty or quiet (`/api/servers` shows `online`), so nobody's evening competes with
  the test. Stopping it is one command.

**How the PC's bots reach CT 115.** Only ssh reaches CT 115 from outside, and the bots speak UDP. Two ways:
- **A1, the ssh tunnel (works today, no help needed).** Every bot's datagrams ride its own TCP connection through
  ssh. The server's numbers are real. Ping and packet loss become the tunnel's, not the internet's, so gate.md marks
  them advisory.
- **A2, a forwarded UDP port.** Jake forwards UDP 7787 to CT 115 (10.10.10.2) for the test window. Ping and loss are
  then real too.
  - This is a `host-network` change: ask through the ledger.
  - Run `sandbox.sh init --public`, then give the harness `--host <public address>` instead of `--tunnel`.

## Option A1, step by step

In `E:\DragonBreak Online Dev files\server\tools\loadtest` on the PC, with this branch pulled on both sides.

**Once, on the PC:**

    node loadtest.js build

This builds `bin\BotHost.exe` with Windows' own csc.exe. `server\client-dist\Data\SKSE\Plugins\MpClientPlugin.dll`
must be the one from the current client package.

**1. Check the server is quiet.**

    curl -s https://dragonbreakonline.com/api/servers

**2. Stand the sandbox up on CT 115.** It copies the live build, takes no secrets and starts nothing yet:

    ssh dragonbreak-dev "bash ~/dragonbreak/server/tools/loadtest/ct115/sandbox.sh init"
    ssh dragonbreak-dev "bash ~/dragonbreak/server/tools/loadtest/ct115/sandbox.sh start"
    ssh dragonbreak-dev "bash ~/dragonbreak/server/tools/loadtest/ct115/sandbox.sh tunnel"
    ssh dragonbreak-dev "bash ~/dragonbreak/server/tools/loadtest/ct115/sandbox.sh sample"
    ssh dragonbreak-dev "bash ~/dragonbreak/server/tools/loadtest/ct115/sandbox.sh target" > sandbox-target.json

- `init` refuses to finish if anything in the sandbox config still points outside the sandbox (a token, a Discord
  route, a live path, port 7777).
- `start` waits for the server's "listening" line.
- `sandbox-target.json` holds the sandbox's ports and its own `/metrics` login (never the live one). Keep it out of
  git; `.gitignore` already covers it.

**3. Open the tunnel** in a second window and leave it open for the whole run:

    ssh -N -L 7788:127.0.0.1:7788 -L 7789:127.0.0.1:7789 dragonbreak-dev

7788 is the sandbox's `/metrics`, 7789 the UDP tunnel.

**4. A dry run with two bots**, verbose, no report:

    node loadtest.js dry --target remote --target-file sandbox-target.json --tunnel --bots 2

Both should log in, pass the hub gate and walk in Bruma. If they don't, stop here: the sweep would only repeat it.

**5. The sweep**, about 30 minutes: four steps of 5 minutes measured, plus the ramp and a 25 s pause between steps.

    node loadtest.js run --target remote --target-file sandbox-target.json --tunnel --steps 10,25,50,100 --seconds 300 --spread city --fight 0.5

- `--fight 0.5` sets half the bots brawling in pairs, a fist every 2.5 s.
- `--steps 10,25,50` stops short of the 100 step's upload, if Jake would rather not carry it.
- The report lands in `reports\<stamp>\`.

**6. The host summary.** This is the CT 115 side: the sandbox's CPU and memory, its log's errors, and what the run
did to the live server:

    scp "reports\<stamp>\run.json" dragonbreak-dev:/tmp/claude-nate-loadtest/run.json
    ssh dragonbreak-dev "bash ~/dragonbreak/server/tools/loadtest/ct115/sandbox.sh summary /tmp/claude-nate-loadtest/run.json"
    scp dragonbreak-dev:/tmp/claude-nate-loadtest/host-summary.json "reports\<stamp>\"

**7. The verdict:**

    node loadtest.js gate reports\<stamp>

It writes `reports\<stamp>\gate.md` and prints PASS, FAIL or INCOMPLETE.

**8. Tear down** (stops the sandbox, tunnel and sampler, then deletes the sandbox):

    ssh dragonbreak-dev "bash ~/dragonbreak/server/tools/loadtest/ct115/sandbox.sh remove"

Close the ssh window from step 3.

**9. Write it up** in a copy of `ALPHA-GATE-RESULTS.template.md` and send it to the release session.

**To stop at any point:** Ctrl+C in the run window, then

    ssh dragonbreak-dev "bash ~/dragonbreak/server/tools/loadtest/ct115/sandbox.sh stop"

It stops the three `dbo-loadtest-*` units by name. The live `skymp` unit is never touched.

## Option B, all on the PC

Refresh the PC's `server` folder so it matches the live build:
- the gameplay files from the release;
- `dist_back\skymp5-server.js` from fork main;
- `scam_native.node` from the matching Windows build;
- the plugins by `SHA256SUMS`.

Then use the README's own sandbox:

    node loadtest.js sandbox init
    node loadtest.js run --steps 10,25,50,100 --seconds 300 --spread city --fight 0.5
    node loadtest.js gate reports\<stamp>

Without a host summary, gate.md judges the server from `/metrics` and the PC's counters, and leaves live-box
impact out.

## The thresholds (gate.json)

The baseline is the 2026-09-20 sweep on the old Windows server: 100 bots, zero errors, no disconnects, memory flat
at about 1 GB, 20% of one core, event-loop lag p99 25 ms.

| criterion | gate (every step up to 50) | stretch (100) | why |
|---|---|---|---|
| bots connected | at least 98% | at least 98% | a login that fails under load is a player who cannot play |
| bot disconnects | 0 | 0 | a disconnect under load is the crash a player sees |
| server stayed up | no restart, no exit | same | "no crash at 50" |
| event-loop lag p99 | at most 50 ms | at most 100 ms | the gameplay layer's own delay; 25 ms at 100 on 20 Sep |
| event-loop lag max | at most 250 ms | at most 500 ms | a quarter-second stall is a visible hitch |
| server tick p99 | at most 50 ms | at most 100 ms | the native tick; README: the p50 is timer granularity, the p99 is the signal |
| server CPU | at most 60% of one core | at most 85% | the gameplay runs on one thread; past that, ticks queue |
| server memory | at most 2 GB | at most 2.5 GB | 1 GB on 20 Sep; the live box reserves 4 GB for the live server |
| memory growth in a step | at most 10% | same | growth inside a flat 5-minute step is a leak |
| new error signatures | 0 | 0 | a new error under load is a bug the load found |
| movement delivery | at least 0.95 | at least 0.9 | the bots' packet-loss proxy (below); advisory through the tunnel |
| live server CPU rise | at most +25 points | same | the test must not cost live players |
| live gameplay timer worst | at most 50 ms | same | from the live server's own per-minute `ticks` line |
| CT 115 free memory | at least 4 GB | same | headroom for the live server |
| ping (server side) | advisory, at most 150 ms | | real only over a forwarded UDP port (A2) |
| CT 115 upload | advisory, at most 40 Mbit/s | | shares Jake's line with the live players |

**Movement delivery** stands in for packet loss. The server copies every movement to every listener in the sender's
grid block, the sender included, and Bruma city fits in one block. So each bot should receive about as many
movements as all the bots together send.
- 1.0 means nothing was lost.
- Below 0.95 means drops, or bots outside the block.
- Hosted NPCs add movement and push it above 1.

## Reading the verdict

- **PASS, stretch met at 100**: the alpha can open at 100 players on this build.
- **PASS at 50, stretch not met at 100**: open with `maxPlayers` 50, or fix what the 100 step shows first.
  gate.md names the criterion.
- **FAIL**: a gate criterion broke at or below 50. gate.md shows which, at which step. The run's `report.md` has
  the traffic and timers behind it, and `host-summary.json` the sandbox's errors.
- **INCOMPLETE**: a gate number could not be measured. Usually `/metrics` was unreachable: check the ssh window from
  step 3, and that `sandbox-target.json` is the one `target` printed after the last `init`. Or the run stopped before
  50.

## What it cannot tell you

- **The bots do not path, aim or dodge.** They walk straight lines at run speed and swing at their partner on a
  timer. Real fights make more animation and equipment traffic than this.
- **The world is Bruma with few NPCs near the crowd**: one wild zone within 5,000 units of the city (README). Hosted
  NPC traffic is under-represented unless you add `--host-npcs --seed-wildlife 150`. That is sandbox-only, and on
  20 Sep it added about 25% more outbound traffic at 100.
- **Through the tunnel (A1)**, ping and loss describe the tunnel. For real network numbers use A2.
