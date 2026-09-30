# Server load and memory over time, with alerts

Status: built and tested on 30 September 2026. **Nothing is installed.** Installing it is a standing change on Jake's
box, so it waits for Nate, and runs under a claim.

This is the Road to Alpha item "track memory and server load over time and add alerts":

- **Every minute**, one JSON line in `/var/lib/dbo-monitor/metrics-YYYYMMDD.jsonl`. Files older than 30 days are
  deleted.
- **Alerts** to staff in #server-monitor for memory, disk and sustained lag. They use the same bot and channel as
  `dbo-monitor`, rate-limited, and never include an address, a path or a token.
- **Each day at 00:05 UTC**, a summary of the day before:
  - a line in `daily.jsonl`;
  - a post to #server-monitor;
  - `public-status.json`, which the status page's phase 2 route can serve (`docs/alpha/status-page.md`).

## What `dbo-monitor` already does, and what this adds

`dbo-monitor` already posts skymp **crashes and restarts** (from systemd's journal) and **freezes**: an event-loop p99
over 2 s twice, a block over 5 s, a hitch of 20 s or more, or no tick summary for 3 minutes. This sampler does not post
those again. It counts restarts and crashes in the daily summary, and it adds:

- the time series;
- the game server's own memory;
- low box memory. `dbo-monitor`'s memory-pressure alerts run in shadow, logged but not posted.
- disk. `dbo-disk-check` only writes to the journal.
- lag that is milder than a freeze but lasts.

## A sample

```json
{"t":"2026-09-30T02:10:18Z",
 "skymp":{"active":"active","since":"Wed 2026-09-30 01:57:51 UTC","restarts":0,"pid":2018560,"rssMB":1134,"threads":14,"cpuPct":4.9},
 "box":{"memTotalMB":16384,"memAvailMB":12965,"memAvailPct":79.1,"load":[3.73,3.94,3.21],"cores":8},
 "disk":{"usedPct":62.4,"freeGB":44.3},
 "players":1,
 "loop":{"p99":12.5,"max":260.2,"slowest":{"timer":"orphans","ms":247.8}},
 "log":{"host_not_hoster":2,"host_granted":1,"hit_too_distant":1,"form_missing":1},
 "errors":0}
```

About a line of 0.5 KB a minute, so roughly 0.7 MB a day and 22 MB for the 30 days kept.

| Field | From |
|---|---|
| `skymp` | `systemctl show skymp` (state, since, restarts, main pid); `/proc/<pid>` (memory, threads); CPU % since the last sample |
| `box` | `/proc/meminfo` (the container's view), `/proc/loadavg` |
| `disk` | `statvfs('/')` |
| `players` | the backend's own `/api/servers` on this box (the launcher's figure); if the backend does not answer, the gamemode's ticks line |
| `loop` | the gamemode's `ticks (ms, last 60 s, N online)` line: event loop p99 and max, and its slowest timer |
| `log` | lines of the game log since the last sample, by series (below); it follows logrotate's copytruncate |
| `errors` | other `[error]` lines, leaving out known noise: Papyrus context dumps, master-server connectivity, the census's noise |

## Log series (Worker B's sync signatures, 2026-09-30)

Each line counts in the first series it matches. There is **no blended "sync errors" total**. `host_not_hoster` is the
figure the Road to Alpha page quotes (48 a day on 21 Sep, 1,351 on 29 Sep), and it stays its own series.

| Series | Group | Line |
|---|---|---|
| `host_not_hoster` | host | `SendToNeighbours - No permission to update actor … (not a hoster)` |
| `host_target_missing` | host | `SendToNeighbours - Target actor doesn't exist` |
| `host_granted` | hostEvent | `Hoster of … changed from`: the denominator. From 26 Sep the errors roughly equal the grants |
| `host_rel_unsub` / `host_rel_stale` | hostEvent | `Hoster of … released from …: its hoster no longer has it` / `: no movement` |
| `hit_too_distant`, `hit_diff_cell`, `hit_worldspace`, `hit_target_missing`, `cast_bad_hoster` | hit | the refusals players feel |
| `drift_split`, `drift_jump`, `drift_other` | drift | the gamemode's `npcDrift` reports by `"kind"` |
| `form_missing` | other | `Form with id 0x… doesn't exist`: a gameplay loop polling a gone id (0xff000323 on 30 Sep), not sync |
| `refr_expired` | other | `Refr pointer expired`: several unrelated paths |

Checked against the live log of 30 Sep: 3,967 not-a-hoster, 3,092 grants, 2,052 and 653 releases, 58 / 5 / 28 / 24 / 5
hit refusals, 2,748 missing-form lines. These are Worker B's figures.

## Alerts

| Alert | Line (defaults) | Repeat |
|---|---|---|
| Game server memory high / critical | skymp RSS 4 GB / 6 GB for 3 minutes (it runs about 1.1 GB, peaking 1.4 GB) | warning at most hourly, critical every 20 min |
| Box memory low / critical | under 15% / 7% free for 3 minutes | the same |
| Disk filling / critical | 90% / 95% used (as `dbo-disk-check`) | the same |
| Server lagging | event loop p99 over 250 ms for 5 minutes (a freeze of 2 s is `dbo-monitor`'s) | hourly |
| Box load high | load over 2 per core for 10 minutes | hourly |

**How they behave.**
- A warning turning critical posts at once.
- No more than 8 posts an hour in all. The rest wait in an outbox of 20 and are retried each minute while Discord is
  down.
- The texts carry figures only (sizes, percentages, player counts, a timer name).

Change any line in `/etc/dragonbreak/dbo-metrics.json` (the keys are `DEFAULTS` in the script), for example
`{"skympRssWarnMB": 3072, "dailyPost": false}`. An empty `DBO_MONITOR_CHANNEL` switches every post off, for testing.

## The daily summary

At 00:05 UTC it covers the day before and posts a line like this:

> **Daily summary 2026-09-29:** peak 4 players at 20:01 UTC; game server memory peak 1.4 GB; box memory free down to
> 71%; load peak 6.2; event loop p99 peak 30 ms; disk 62%; restarts 1, crashes 0; not a hoster 1,351 of 1,380 host
> grants; hit refusals 49; drift reports 12 (split 3, jump 5); 1,440 samples.

- **Restarts and crashes** come from skymp's journal. An exit with a failure status that nobody asked for is a crash.
  On 25 Sep that finds 15 starts and 3 crashes, matching the economy audit.
- **`public-status.json`** holds only `state`, `since`, `playersOnline` and yesterday's peak players, restarts and
  crashes.

`dbo_metrics.py report 2026-09-29` prints a day's line without posting.

## Install (as root, under a claim, after Nate's yes)

```
install -d -m 755 /opt/dragonbreak-tools/metrics
install -m 755 dbo_metrics.py /opt/dragonbreak-tools/metrics/
install -m 644 README.md /opt/dragonbreak-tools/metrics/
install -m 644 systemd/dbo-metrics.service systemd/dbo-metrics.timer systemd/dbo-metrics-daily.service systemd/dbo-metrics-daily.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now dbo-metrics.timer dbo-metrics-daily.timer
```

**Check.**
- After two minutes, `tail -1 /var/lib/dbo-monitor/metrics-$(date -u +%Y%m%d).jsonl` shows a sample with `cpuPct` and
  `loop`. The first sample starts at the end of the log, so its `log` is empty.
- `systemctl list-timers dbo-metrics*` shows both timers.

**Rollback.** `systemctl disable --now dbo-metrics.timer dbo-metrics-daily.timer`, remove the four unit files, then
`daemon-reload`. The files in `/var/lib/dbo-monitor/` can stay or go (`metrics-*.jsonl`, `daily.jsonl`,
`metrics-state.json`, `public-status.json`).

**Cost.** One Python run a minute at nice 10 and idle IO. It reads about a minute of log (capped at 64 MB) and makes
one local HTTP call.

## Tests

`python3 tools/metrics/test_dbo_metrics.py`: 23 checks on temp folders and a fake log, never Discord. They cover:
- log series and copytruncate;
- the ticks line;
- every alert's threshold and duration;
- repeats, escalation, the hourly cap and the retry;
- pruning;
- the daily summary and crash counting from journal lines;
- that `public-status.json` holds nothing internal.

Also run read-only on CT 115 on 30 Sep: two live samples into a scratch folder with posting off, and the journal count
for 25-30 Sep.
