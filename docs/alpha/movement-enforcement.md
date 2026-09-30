# Switching movement enforcement on (plan for Nate, 30 September 2026)

The server has checked every player's speed since 21 September, but only **logs** what it would refuse. This plan turns
refusing on one direction at a time: sideways first, then upward, then downward. Each step is one settings change and
one restart, taken only when the step before it has run clean. Each has its own rollback.

| Step | What changes | Your decision |
|---|---|---|
| 0 | The new build is live, everything still logged only, with the tuned settings | Starts when server-next-v2 goes live |
| 1 | Refuse moves that are too fast **sideways** | After step 0 has run clean |
| 2 | Also refuse moves that go **up** too fast | After step 1 has run clean |
| 3 | Also refuse moves that go **down** too fast | After step 2 has run clean |

**What a refusal does.** The player's move is not accepted and their game is pulled back to the last good spot (a
"snap back", at most every 250 ms). Nothing else happens: no kick, no ban, no log line in Discord.

## What the logs say (21 Sep 19:05 to 30 Sep 08:25 UTC)

The ceilings are 1000 units a second sideways (sprinting is 500 and a galloping horse 600), 2000 up and 4000 down. A
player may bank some unused movement (the burst), so a lag spike that delivers several moves at once still passes.

- **Sideways.** 207 moments above 1000 u/s from 29 characters, all absorbed by the burst. Separately there were **21
  would-refuse lines**, and each has an innocent cause:
  - 17 lines (about 470 moves) were a senior GM testing in god mode on 24 Sep at 3000-4500 u/s. **Covered:** staff
    with console rights are never refused, only logged.
  - 1 was 2868 units in the first second after a login (the landing). **Covered:** everything is accepted for 30 s after
    a login.
  - 2 were 48-71 units refused after an 8.8 s server hitch (27 Sep), when the delayed moves arrived at once.
    **Covered:** after a stall of 1.5 s while two or more players were moving, nothing is refused for 5 s.
  - 1 was 4082 units in 3 s during a load on 21 Sep. The live burst of 3 s allows 3000. **Covered if** the player had been
    standing still for 4.1 s or more, since the proposed burst of 5 s allows up to 5000. The log line caps the time at the
    burst, so it can't show how long they stood. Step 0 measures this with the new build.
- **Up and down.** **No** would-refuse line in nine days. There were 4 moments above 2000 u/s up and 1 above 4000 down.
  All were absorbed by the burst: 4 of the 5 spanned a server teleport (a door, a respawn), and the fifth was the GM's
  god-mode session.
- **No cheating was seen.**

So with the settings below, the nine days give **no wrong refusals**: 20 of the 21 lines are covered by the three
exemptions, and the last by the longer burst.

Two things already happen today and don't change. A single move of 4096 units or more, or into another cell without a
door, is refused and snapped back. Moves still in flight from before a server teleport are dropped silently.

## Before step 0

- **server-next-v2 must be live** (the PC unit-test run, then the push to main). It holds the per-direction switches
  and the three exemptions (branch server-movement-checks 47726f46).
- The new build's defaults are **all three directions enforced**. The live settings stay safe only because they carry
  `"enforce": false`. **Never remove that key**. Every step below keeps it and adds the per-direction keys, which
  override it.
- `server-settings.json` is read only when the server starts, so every step and every rollback is a settings edit
  plus `restart skymp`. The updater keeps `server-settings.json` across builds.

## How to apply a step (the same for every step and every rollback)

1. Nobody online and nobody at character select: `curl -s https://dragonbreakonline.com/api/servers` shows
   `"online":0`, **and** `bash /tmp/claude-nate-release/sessions.sh` prints `0`. No dungeon lease open.
2. Claim and back up:
   ```
   sudo /opt/dragonbreak-ops/ops claim game-server claude-nate "movement enforcement step N" 20
   S=/opt/alduinak/build/dist/server; sudo cp -a $S/server-settings.json $S/server-settings.json.bak-$(date +%Y%m%d-%H%M%S)
   ```
3. Set the keys of the step (only the `movementValidation` block changes; every other key is kept):
   ```
   sudo python3 - <<'EOF'
   import json; p='/opt/alduinak/build/dist/server/server-settings.json'; s=json.load(open(p))
   s['movementValidation'].update({ ...the step's keys... })
   json.dump(s, open(p,'w'), indent=2)
   EOF
   ```
4. `bash ~/dragonbreak/dev-server.sh restart skymp --yes`, then check the boot line:
   `sudo grep -a "movementValidation: on" /var/log/skymp-server.log | tail -1`. It prints each direction as
   `enforced` or `logged`, and the burst and the exemptions.
5. Log it with its rollback, then release:
   `sudo /opt/dragonbreak-ops/ops log claude-nate "movement enforcement step N: ..." "restore the .bak, restart skymp"`, then
   `sudo /opt/dragonbreak-ops/ops release game-server claude-nate`.

## Step 0: the new build, logging only

Keys:
```json
"enforce": false, "enforceHorizontal": false, "enforceUp": false, "enforceDown": false,
"burstSeconds": 5, "exemptStaff": true, "loginGraceMs": 30000, "stallMs": 1500, "stallGraceMs": 5000
```
(The ceilings stay 1000 / 2000 / 4000, `teleportGraceMs` 5000, `snapBackIntervalMs` 250. The per-direction keys are
written out as `false` so a missing key can never fall back to the enforcing default.)

The boot line should read `ceilings 1000 horizontal (logged), 2000 up (logged), 4000 down (logged) u/s, burst 5.0 s,
login grace 30000 ms, staff exempt, stall 1500 ms -> grace 5000 ms`.

**Watch**, each evening:
```
L=/var/log/skymp-server.log
sudo grep -a "would refuse (log only)" $L | tail -20         # what enforcement WOULD refuse: must be empty, or a cheater
sudo grep -a "MovementValidation: accepted (" $L | tail -20  # what the exemptions covered (staff, login grace, server stall)
sudo grep -a "server stall" $L | wc -l                       # server hitches; many a night means the server is struggling
```
**Runs** at least 2 busy evenings (3 or more players for an hour or more each; 20 player-hours in all).
**Next step when** there are no `would refuse (log only)` lines for ordinary players. Look into any line there is: who,
where, and what they were doing (door, horse, fall, load) before going on.

## Step 1: sideways

Keys: `"enforceHorizontal": true` (the rest as in step 0).

**Watch:** `sudo grep -a "MovementValidation: refused" $L`. Each line names the player, the direction, the distance, the
time and the budget. Every refusal of an ordinary player is a wrong refusal until shown otherwise. Also check `/bug`
reports and Discord #bugs for "pulled back", "rubber-banding", "snapping back" or "stuck", plus whatever Nate and Jake
notice themselves.
**Runs** at least 3 busy evenings (30 player-hours), including an evening with 10 or more online if there is one.
**Next step when** there are no wrong refusals.
**Rollback:** `"enforceHorizontal": false`, then restart (the steps above). **Stopgap** for one player caught in a
snap-back loop before a restart is possible: log out and back in, since the 30 s login grace accepts everything.

## Step 2: up

Keys: `"enforceHorizontal": true, "enforceUp": true`.
**Watch** the same, plus refusals `over up ceiling` near cliffs, lifts, stairs and mounts.
**Runs** at least 2 busy evenings (20 player-hours). **Next step when** there are no wrong refusals.
**Rollback:** `"enforceUp": false`, then restart.

## Step 3: down

Keys: `"enforceHorizontal": true, "enforceUp": true, "enforceDown": true`.
**Watch** refusals `over down ceiling` after falls, jumps off walls and ledges, and beast forms (the werewolf leap, the
Vampire Lord's landing).
**Runs** at least 2 busy evenings. After that, enforcement is simply on.
**Rollback:** `"enforceDown": false`, then restart.

## Full rollback at any time

Put back the settings from before step 0 (the `.bak` file, or all three `enforce*` keys `false` with `"enforce": false`),
then restart. `"enabled": false` switches the speed check off completely. The 4096-unit and cell checks stay, as they
always have.

## Timing against the alpha

The alpha opens 13 October (go/no-go 11 October, event night before it). If server-next-v2 is live by 2 October, step 0
runs 2-3 October, step 1 from 4 October, step 2 from 7 October and step 3 from 9 October. That puts step 1 through the
event night and leaves the go/no-go with two days of full enforcement behind it. If it goes live later, stop at step 1
for the opening and take the vertical steps after it: sideways speed is where cheating would show first, and the
vertical checks never had a line to refuse.

*Sources: `/var/log/skymp-server.log` and `.log.1` (21 Sep 19:05 to 30 Sep 08:25 UTC: 10,685 peak lines and the 21
would-refuse lines), the live `server-settings.json`, and the fork source at server-next-v2
(`MovementLimits.h`, `MovementValidation.cpp`, `ScampServer.cpp` settings parse). Update the numbers if step 0 finds
anything the nine days didn't.*
