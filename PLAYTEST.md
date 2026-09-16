# Bruma playtest script

Everything built on 2026-09-16, in the order that fails fastest. Each line is what to do and what
proves it worked. Server log lines are quoted exactly so they can be grepped.

## Before you launch

1. **Close Vortex**, and don't use the launcher for a local test: both rewrite the shared `Plugins.txt`.
2. Double-click `server\sync-plugins.cmd`.
3. Launch the **dev copy** (`Skyrim Special Edition - dev`) directly. The launcher starts the Steam
   copy, which points at `50.116.28.194`, not this server.

## A. Character creation (afternoon fix)

| # | Do | Proof |
|---|---|---|
| 1 | Delete your character, create a new one | **Black screen, then fade up in the hub, creator opens.** You should never see the Pale Pass. Log: `arrived at the landing` → `moved ... into the hub` → `arrived in the hub` → `opened character creation` |
| 2 | Finish the creator | `given Pickaxe, Woodcutter's Axe` |
| 3 | Open Magic | Flames and Healing gone within 20 s |
| 4 | Open your pack ~10 s after the creator closes | No iron gear, lockpicks or Book of the Dragonborn. **If they're there, report it** |

If step 1 shows the Pale Pass for a few seconds and the creator opens ~8 s after the hub move, the
fallback timers did the work and the arrival reports are not reaching the server. Still a pass for
spawning, a fail for the new flow.

## B. Admin tools

| # | Do | Proof |
|---|---|---|
| 5 | `/selftest` | "Every system is wired" and `closex3` in the UI event list (the close-handler fix) |
| 6 | `/load` | Players, npcs, spawn poll ms, packet rates. Note the numbers as a baseline |

## C. Creatures (collision, cell and hostility fixes)

| # | Do | Proof |
|---|---|---|
| 7 | Take a hub gate to the Pale Pass | You arrive on the road |
| 8 | Find a wolf | **Stands on the ground and blocks you.** Walking through it is the collision bug |
| 9 | Hit it | **It takes damage.** The log must NOT show `different cells or world` |
| 10 | `/npc` next to it | `+0` to `+64 above its spot`. Hundreds above means it is floating |
| 11 | Let one see you | Hostile creatures come at you (the `ff_hostile` flag is registered now) |

## D. Hunting contracts

| # | Do | Proof |
|---|---|---|
| 12 | `/contracts` in Bruma | Three contracts from local fauna, with the treasury balance |
| 13 | `/contract take 1`, kill the quarry | `Contract: 1/N ...` per kill |
| 14 | Finish it | Gold arrives **and** the Bruma treasury drops by the same amount. Log `CONTRACT ...` |
| 15 | `/appoint <you> bruma count`, then `/contract post wolf 3 50` | "Posted: 3 wolves ...", and it appears in `/contracts` |

## E. Mining and woodcutting

Needs the skill first: take **Miner** and/or **Woodcutter** in the skills menu.

| # | Do | Proof |
|---|---|---|
| 16 | Use a copper vein near Bruma | The strike bar opens |
| 17 | Hammer Space | **Does not win.** A miss staggers you 600 ms |
| 18 | Win the round | Copper ore in your pack, the vein rests 45 min. Log `MINE ...` |
| 19 | Use a chopping block | 4 strikes at tier 1, firewood on a win. Log `CHOP ...` |
| 20 | Try either without the skill | A refusal message, no bar |

## F. Champions

| # | Do | Proof |
|---|---|---|
| 21 | `/champions` | Answers even with none abroad |
| 22 | If one is up | Name like "Ravening Wolf", **red rim**, takes about twice the hits, pays gold on death. Log `champion: ...` then `CHAMPION ...` |

## F2. Bruma notice board (placed 2026-09-16 in DLE)

| # | Do | Proof |
|---|---|---|
| 22a | Walk to the board near the cathedral, about [59437, 202554] | Manny's board stands outdoors in the city |
| 22b | Use it | The board opens on **Bruma**'s pool. The log must NOT say `[board] board 1164c7 ... is outside every zone` |
| 22c | Post on Shop Ads | 30 gold taken, half deposited in the Bruma treasury |
| 22d | As a Bruma official (`/appoint <you> bruma count`), post on Hold Notices | Free, and only officials can |

## G. Things that changed underneath

| # | Do | Proof |
|---|---|---|
| 23 | Read a book as a Scholar, then close it | Closes cleanly. The close handler was being overwritten until today |
| 24 | In a dungeon, look at a chest | A thin rim, not a white wash |

## If something fails

Report, in this order of usefulness: the **log line** from `server\server.log`, the **form id**
involved (`/npc` prints them), then one sentence of expected versus actual.

## Not in this build

- **No bank in Bruma** beyond the treasury safe. Also a Creation Kit job.
