# Alpha capacity gate: results (copy this file, fill it in)

**Verdict:** PASS / PASS at 50, stretch not met at 100 / FAIL / INCOMPLETE (from gate.md)

| | |
|---|---|
| Date and time (UTC) | |
| Run by | Nate |
| Where | A1 (CT 115 sandbox, ssh tunnel) / A2 (CT 115, forwarded UDP) / B (all on the PC) |
| Build | `BUILD.txt` from the sandbox (fork main commit), client package version |
| Plugins | DLE sha256 (first 8), from `/opt/skyrim-data/SHA256SUMS` |
| Command | the exact `node loadtest.js run ...` line |
| Report folder | `reports\<stamp>\` (report.md, gate.md, run.json, host-summary.json) |
| Live players during the run | from `/api/servers` before and after, and `live.online` in host-summary.json |

## Per step

| bots | connected | disconnects | server up | lag p99 / max (ms) | tick p99 (ms) | CPU (% of one core) | memory (MB) | delivery | errors | live CPU rise | CT 115 upload (Mbit/s) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 10 | | | | | | | | | | | |
| 25 | | | | | | | | | | | |
| 50 | | | | | | | | | | | |
| 100 | | | | | | | | | | | |

## What failed or came close

- (criterion, step, value against limit, and what report.md or host-summary.json shows behind it)

## New error signatures

- (count, signature, example line, from host-summary.json `steps[].sandbox.errors` or report.md)

## Effect on the live server

- Live server CPU before the run and during each step, its worst gameplay timer, and any player who left during the
  run (host-summary.json `liveBefore` and `steps[].live`).

## Decision

- maxPlayers for the alpha:
- Follow-ups (owner, what):
