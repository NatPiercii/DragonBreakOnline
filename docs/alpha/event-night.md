# Event night: the alpha dress rehearsal

**What.** One evening with 15 to 20 real players on the live server, doing things together that the alpha will
ask of it: a crowd in one place, and several parties in ruins at the same time. **Why.** It is the main evidence for
the go/no-go on 11 October. So far the server has never held more than 5 players at once, and most of what we know
comes from one to four.

**When.** Saturday ____ October, ____ UTC, for about 2 hours 15 minutes. Write the start time down as **T0** (UTC):
every check below counts from it.

**The question the night answers.** Can 15 to 20 players play for two hours without the server crashing, without the
game crashing much more often than on a normal night, and without the server running short of memory or falling behind?

## Who runs the night

Nate and Jake run it between them; there is no one else on duty.

- **Nate** leads the night: runs the activity in game (the war party needs Lead GM rights or above), helps players form
  parties, makes every go/stop call and talks to the players in Discord and in game.
- **Jake** keeps the server and the machine: runs the watch on CT 115 (section 2), or has a Claude session there run it,
  and tells Nate when a line is crossed. Only Jake restarts anything.

Keep a timeline as you go: when each phase started and anything that went wrong. It goes into the results table.

## 1. Pre-flight

### T-24 hours

- [ ] **The freeze starts.** The last release lands before T-24 h. From then until the event ends there are no pushes to
      fork `main` (they rebuild and restart the server), no `deploy-gameplay`, no client, launcher or plugin publish and
      no restart. Only the event lead can make an exception, and only to fix a server that is down.
- [ ] **Versions.** Write down what is live and put it in the event notice, so players can check they are current:

      curl -s https://dragonbreakonline.com/api/version

      shows `version` (the launcher) and `clientVersion`. The launcher checks and updates the client itself; ask every
      player to start through the launcher and run **Repair** once before the event.
- [ ] **The NPC budget.** The server keeps at most 150 spawned NPCs alive at once (the default; the setting is
      `npcLiveBudget`, read only when the server starts). A goblin war party and three expeditions at once can reach it.
      When it is reached, new enemies wait for room and a ruin can look half empty. Decide now whether to raise it, and
      if so, raise it as part of the last release before the freeze. It cannot change during the event.
- [ ] **Backups.** The world is snapshotted every hour. Check the newest snapshot verifies:

      ls -t /opt/skymp-backups/world/*.tar.gz | head -1
      sudo python3 /opt/dragonbreak-tools/backups/dbo_backup.py verify <that file>

      The answer must be `OK, <n> world records, <n> gameplay files, <n> state files`.
- [ ] **Disk.** `sudo python3 /opt/dragonbreak-tools/backups/dbo_backup.py disk --warn 90 --crit 95`. It should show
      under 80% used and at least 20 GB free. A busy night writes more log than usual.
- [ ] **Rehearse the activity.** Nate raises and dismisses a small war party (2 or 3 goblins) out of sight of
      players, and checks that the expedition board in the Synod Conclave lists the four expeditions.
- [ ] **Nate and Jake both free** for the whole evening.
- [ ] **Announcement** in Discord: the time in UTC and in the main player time zones, what to update, and the plan in
      two lines. Players who cannot come can still help by being online later for the "normal night" comparison.

### T-1 hour

- [ ] **Hold the updater**, so nothing rebuilds the server during the event:

      sudo touch /opt/skymp-dev-hold

      Remove it after the event (`sudo rm /opt/skymp-dev-hold`). Log both in the ops ledger as usual.
- [ ] **The server is up and fresh.** `systemctl show skymp -p ActiveState,ActiveEnterTimestamp,NRestarts` shows
      `active`. If the event lead planned a clean restart (recommended, so the night starts on a fresh process), it
      happens between T-3 h and T-1 h, with nobody online and nobody at character select, by the usual release steps.
- [ ] **Players online now:**

      curl -s https://dragonbreakonline.com/api/servers | python3 -c 'import json,sys; s=json.load(sys.stdin)[0]; print(s["online"], "online, last seen", s["lastSeen"])'

      (This prints only the count. The raw answer also carries the server's address: never paste that anywhere public.)
- [ ] **Starting figures.** Note the game server's memory and the machine's free memory:

      sudo tail -n 1 /var/lib/dbo-monitor/metrics-$(date -u +%Y%m%d).jsonl

      and copy `skymp.rssMB`, `box.memAvailPct` and `disk.usedPct` into the results table.
- [ ] **A normal-night baseline** for comparison: pick the busiest evening of the last few days (same hours as the
      event, the day before if it was busy enough) and run the numbers for it now (section 4).
- [ ] **The watch is running** (section 2), and whoever runs it can reach Nate straight away.
- [ ] **Staff check-in** in game at the Synod Conclave. The expedition boards (the Synod Conclave, the Fighters Guild)
      show every expedition free.

## 2. What to watch during the event

Everything here only reads. Jake (or a Claude session on CT 115) runs it and tells Nate when a line is
crossed. **NOTE** means write it down with the time and keep going. **STOP** means tell the event lead at once. The event
lead decides whether to pause (everyone back to Bruma, nothing new started) or end the night.

### The one-line-a-minute watch

    sudo python3 tools/event-night/watch.py

run from the server repo (`~/dragonbreak/server`). It prints one line a minute, like this:

    time  online  p99/max ms   rss MB  free%  disk%  hoster-err/grants  too-far  crashes(15m)  flags
    19:42      17      14/310     2410   61.2   64.9      212/180             3             0

| Column | What it is |
|---|---|
| online | players in the world (the gamemode's own count; players at character select are not in it) |
| p99/max ms | how late the server's main loop ran in that minute: the 99th percentile and the worst single delay. A healthy minute reads about 11 ms (the measuring step is 10 ms) |
| rss MB | the game server's memory |
| free% | memory left on the whole machine |
| disk% | disk used |
| hoster-err/grants | "not a hoster" errors against NPC host hand-offs in that minute (the NPC sync problem; the Road to Alpha page quotes it) |
| too-far | hits refused because attacker and target were too far apart on the server |
| crashes(15m) | games that crashed in the last 15 minutes, as the players' launchers reported them |
| flags | NOTE and STOP, as in the table below |

### Where each figure comes from, if the watch is not running

| What | Command | Source |
|---|---|---|
| Players, lag | `sudo tail -F /var/log/skymp-server.log \| grep --line-buffered "ticks (ms"` then read `N online` and `event loop p99 X max Y` | the gamemode's tick summary, once a minute |
| Memory, disk, lag, sync series | `sudo tail -n 3 /var/lib/dbo-monitor/metrics-$(date -u +%Y%m%d).jsonl` (`skymp.rssMB`, `box.memAvailPct`, `disk.usedPct`, `loop.p99`, `loop.max`, `log.host_not_hoster`, `log.host_granted`, `log.hit_too_distant`) | dbo-metrics, once a minute. It also posts its own alerts to #server-monitor (memory, disk, and "Server lagging" for p99 over 250 ms for 5 minutes) |
| NPC budget | `sudo grep -c "at the budget of" /var/log/skymp-server.log` (compare with the count at T0), or live: `sudo tail -F /var/log/skymp-server.log \| grep --line-buffered "at the budget of"` | the spawn system, at most once a minute while it waits for room |
| Vampire Lord breakers | `sudo tail -F /var/log/skymp-server.log \| grep --line-buffered -E "vlbreaker\|vlwatch"` | the gamemode. A trip means a remote Vampire Lord body was switched off after a watcher crashed |
| Errors by kind | `sudo awk -v t0="[$(date -u +%Y-%m-%d) 19:00" '$0 >= t0' /var/log/skymp-server.log \| grep -E '\] \[(error\|critical)\] ' \| sed -E 's/^\[[^]]*\] //; s/0x[0-9a-f]+\|[0-9a-f]{8}/X/g; s/[0-9]+/N/g' \| sort \| uniq -c \| sort -rn \| head` (put T0 in place of 19:00) | the server log |
| Server crashes and restarts | `systemctl show skymp -p ActiveEnterTimestamp,NRestarts`; dbo-monitor also posts "Game server crashed" or "restarted" in #server-monitor | systemd |
| Player crashes | the launcher posts each crash as a line in #server-monitor; dbo-monitor posts "Likely crash" (a game that went silent 45 s before disconnecting) | the launcher's crash watch (2.1.34 and later); dbo-monitor |
| Problem reports | new threads in #bug-tracker: `/bug` from the game and "Report a Problem" from the launcher (tagged Launcher) | the backend and the gamemode |
| Freezes | dbo-monitor posts a **Freeze** alert in #server-monitor (p99 over 2 s twice in a row, or a single block over 5 s twice) | dbo-monitor |

**Known noise, not a problem on its own:** `resolved context with N entries (reason=exception)` (Papyrus context
dumps), `Form with id 0x... doesn't exist` (a known poll of a removed form, about once a second), `Refr pointer expired`,
`Target actor doesn't exist`, `Method not found`. "Not a hoster" errors are counted in their own column and are an
open problem already. They matter when they grow much faster than host hand-offs, not on their own.

### Lines: note it, or stop

| Figure | NOTE (write it down, carry on) | STOP (tell the event lead now) |
|---|---|---|
| The game server | | **any** crash or restart. After the first: pause, everyone back to Bruma, check the server came back clean (log in, walk, fight), then the event lead decides whether to carry on. A second crash ends the night |
| Lag (loop p99) | over 250 ms for 3 minutes in a row, or one block over 2 s | over 1,000 ms for 3 minutes in a row, or a dbo-monitor **Freeze** alert |
| Game server memory | over 4 GB | over 6 GB |
| Machine memory free | under 15% | under 7% |
| Disk used | over 90% | over 95% |
| Player crashes (launcher) | each one: who, where, doing what (ask them for a `/bug` after they return) | 5 or more in any 15 minutes, or 3 that look the same (same place, same action) |
| Disconnects | | 5 or more in 2 minutes that are not players quitting from the menu (the network or the server) |
| NPC budget ("at the budget of") | every time: when, and what the players were doing | only if a ruin stands empty for the whole party. Then end that expedition |
| Vampire Lord breakers | every trip | a second watcher crash near a Vampire Lord: no more Vampire Lord form tonight |
| Errors | a kind not in the known-noise list, more than 20 lines in a minute | "failed to load" for a gameplay module, or errors of one kind every second for 5 minutes |
| "Not a hoster" | more than 3 per host hand-off in a minute with at least 10 hand-offs | only if players report enemies they cannot hit or that freeze, in several places at once |

When the event is paused or ended, the event lead tells the players in game and in Discord, in plain words, and the
time and the reason go into the timeline.

## 3. The activity

**The Bald Tail war party.** A goblin tribe from the Jerall Mountains comes down on Bruma. Everyone defends the city
together, and then the Synod sends parties out after the ruins the goblins came from. It uses only what is live today.

| Phase | When | What happens | Systems it exercises |
|---|---|---|---|
| 1. Muster | T0 to T+15 | Everyone meets at the Synod Conclave's door in Bruma. Nate greets players and helps them form parties with `/party invite` and `/party accept`: one **raid party** of up to 12, and one or two parties of up to 6. (A party of more than 6 is a raid: its skill gain is halved, except inside a raid ruin. Say so, so nobody is surprised) | logins in a crowd; 15-20 players in one city (the city's NPCs hosted and handed between many players); voice, if it is on |
| 2. The defence of Bruma | T+15 to T+50 | Out of sight of the gate, Nate raises the war party from the Place tab's catalog: Bald Tail goblins (grunts, bruisers, butchers, savages), 10 at a time with `/warband raise <id> 10`, up to 25 in all. Nate leads them to the gate, then `/warband unleash`. Everyone fights in one place. When it is over, `/raid` lists anything left standing and `/raid clear` removes it | warbands (companion system), NPC host hand-offs with many watchers at once, hit checks, the down state and revives (Priest tier 4, the Draught of Revival), friendly fire inside a party (20%), looting bodies, respawn temples |
| 3. The expeditions | T+50 to T+1:50 | From the expedition board in the Synod Conclave (or the Fighters Guild): the raid party takes a **raid ruin**, **Silorn** or **Bawn** (two bosses each, up to 12 players). The other parties take the **boss ruins**, **Niryastare** and **Telepe** (one boss, up to 6). Anyone without a party takes a hunting contract from the board's Contracts tab and hunts around Bruma. So there is a crowd in and around Bruma and two to three ruins full of players at the same time | dungeon leases, raid scaling, many enemies placed at once (the NPC budget), locked chests and lockpicking, loot glow, Ayleid loot, the boss timer that brings a party home, hunting contracts |
| 4. Home and wrap-up | T+1:50 to T+2:15 | Parties come home when their bosses fall (a 10-minute timer then brings them back) or with `/expedition leave`. Everyone meets at an inn in Bruma (Nate picks one): rest, eat, and tell Nate what went wrong. Everyone who crashed or saw something strange sends a `/bug` | a crowd in one interior; inn rooms (Well Rested, Well Fed); `/bug` snapshots |

**Rules for the night**, said at the muster:
- Stay with your party; don't go exploring on your own.
- If your game crashes, come back and send `/bug` with what you were doing.
- No Vampire Lord form in the crowd.
- Keep the Bruma lock (no leaving the region).

**If the war party is too much for the server** (a STOP line on lag or memory): Nate uses `/raid clear` and phase
3 starts early with fewer parties.

## 4. Afterwards: the numbers for the go/no-go

Run the numbers **the same night**: dbo-monitor keeps its counters for 24 hours only. From the server repo:

    sudo python3 tools/event-night/numbers.py --from "<date> <T0>" --to "<date> <end>" \
        --baseline-from "<baseline date> <start>" --baseline-to "<baseline date> <end>"

All times are UTC, written as `2026-10-04 19:00`. It prints counts only (no names or accounts), so the output can go
straight into the notes. Add `--json` for the raw figures.

### What each number is and where it comes from

| Number | Source | Why it matters |
|---|---|---|
| Peak players, and player-hours | dbo-metrics' one-minute samples (the gamemode's tick summary for a baseline before 30 September) | the load the night actually put on the server |
| Server crashes and restarts | the server log (each start writes "Using master server on"), systemd's restart count, dbo-monitor's counters | the first go/no-go line |
| Player crash rate | the launcher's crash watch: crashes ÷ game sessions ended in the window, and how many left a Crash Logger log (`skymp5-backend/data/session-ends.jsonl`) | the second line. dbo-monitor's "likely crash" count (silence before a disconnect) is a second view |
| Sync errors per player-hour | the server log, counted as dbo-metrics counts them: "not a hoster" (and per host hand-off), hits refused, drift reports | does the NPC sync get worse with a crowd, or only grow with the number of players |
| Peak memory | dbo-metrics: the game server's memory at the start and at its peak, the machine's lowest free memory, the disk | headroom for the alpha's first weeks |
| Lag | the gamemode's tick summary: the highest p99, minutes over 250 ms, the worst single block, minutes with a block over 2 s | what players felt as rubber-banding |
| NPC budget hits, Vampire Lord breakers, gameplay load failures | the server log | known risks, checked under load |
| Errors of new kinds | the server log, grouped by kind with numbers taken out | anything new the crowd brought out |
| Bug reports | `/bug` snapshots saved on the server, and the #bug-tracker threads | what players saw |

### Proposed go/no-go lines (the event lead decides)

| Line | Go if |
|---|---|
| Server crashes | none |
| Player crash rate | no worse than a normal night, and under 10% of sessions |
| Lag | p99 under 250 ms in at least 95% of the minutes, and no Freeze alert |
| Memory | the game server stayed under 4 GB, and the machine kept more than 15% free |
| Sync | "not a hoster" per player-hour no more than twice a normal night's |
| Data | the next world snapshot after the event verifies (section 1's backup check) |

### Results table

Fill in one column for the event and one for the baseline.

| | Event | Normal night |
|---|---|---|
| Window (UTC) | | |
| Peak players (at) | | |
| Player-hours | | |
| Server crashes / restarts | | |
| Game sessions ended / crashed (rate) | | |
| Crashes with a Crash Logger log | | |
| dbo-monitor likely crashes / joins | | |
| Game server memory: start / peak (MB) | | |
| Machine memory free: lowest (%) | | |
| Disk used: peak (%) | | |
| Loop p99: peak (ms) / minutes over 250 ms | | |
| Worst single block (ms) / minutes over 2 s | | |
| "Not a hoster" per player-hour / per host hand-off | | |
| Hits refused per player-hour | | |
| Drift reports per player-hour | | |
| NPC budget hits | | |
| Vampire Lord breaker trips | | |
| New error kinds (count, the top one) | | |
| `/bug` reports | | |
| Pauses or stops (time, why) | | |
| **Go / no-go** | | |

### Also collect

- The timeline: each phase's start and end, and every pause.
- Players' own words: a short Discord post the next day. What worked? What broke? Would you play like this every
  week?
- The `/bug` and launcher reports from the night, triaged by the developer the next day.
- Remove the updater hold (`sudo rm /opt/skymp-dev-hold`) and log it. The freeze ends when the event lead says so.

---

*For staff: the watch and the numbers read the gamemode's tick summary (server/gamemode.js), dbo-metrics
(/opt/dragonbreak-tools/metrics), dbo-monitor (/opt/dbo-monitor), the launcher's crash watch (skymp5-backend
sessionEnds.js) and the `/bug` snapshots. The lines in section 2 match dbo-metrics' own alert lines where it has one
(memory 4/6 GB, machine memory 15/7%, disk 90/95%, lag 250 ms). Update this page if those change. Written 30 September
2026 from the live server (at most 5 players at once so far; 30 September: 0 launcher crashes in 17 sessions; 29
September: 21 in 69).*
