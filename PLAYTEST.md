# Bruma playtest script

For the first session on the 2026-09-16 build. Everything in it is untested, so the order below is
chosen to fail fast: each step either proves a system or hands you the one line to report. Roughly
20 minutes solo, 10 more with a second player.

Target for this stage: 40-50 slots configured, 20 concurrent hoped for. `maxPlayers` is 100, so
slots are not the limit; the limits worth finding are the ones that show up between 2 and 20.

## Before you launch

1. **Close Vortex.** It rewrites `Plugins.txt` within ~30 s of running and the client then refuses
   to connect.
2. Double-click `server\sync-plugins.cmd` (running it through bash fails; use its node one-liner).
3. Launch from `Skyrim Special Edition - dev`.
4. The server should already be running. If not: `server\launch_server.bat`.

## Solo pass

Each line says what to do, then what proves it worked.

| # | Do | Proof |
|---|---|---|
| 1 | Log in | You reach the hub or the Pale Pass without a black screen. A hang here is section 14 of HANDOFF.md, not a new bug |
| 2 | `/selftest` | Says "Every system is wired". If anything is listed as NOT wired, stop and report that line |
| 3 | `/load` | Players, npcs alive, spawn poll ms, packet rates. Note the poll figure with nobody else on |
| 4 | Open Magic | Flames and Healing should be gone within 20 s. The console prints `spells enforced at Ns` when it strips them |
| 5 | Check your pack | Iron gear, potions, lockpicks, Book of the Dragonborn should not be there ~10 s after the creator closes. **If they are, say so** - the client already force-applies the server's inventory every 5 s, so their presence means something is blocking that loop |
| 6 | Walk the road until a wolf spawns | It stands **on the ground** and **blocks you**. Walking through it means the translation fix did not take |
| 7 | `/contracts` | Three contracts for Bruma, drawn from local fauna, with the treasury balance |
| 8 | `/contract take 1` | "Taken: ..." and the count |
| 9 | Kill that quarry | `Contract: 1/8 wolves` in chat per kill |
| 10 | Finish the contract | Gold arrives **and** the Bruma treasury drops by the same amount. Audit line `CONTRACT ...` |
| 11 | Find a copper vein, as a Miner | The strike bar opens. Hammering the key should NOT win: a miss staggers you 600 ms |
| 12 | Win the mining round | Copper ore in your pack, the vein rests 45 min |
| 13 | Use a chopping block, as a Woodcutter | 4 strikes at tier 1, firewood on a win |
| 14 | `/champions` | Answers even with none abroad. If one is up, its name is "<Epithet> Wolf" and it has a red rim |
| 15 | `/load` again | Compare the poll ms and packet rates against step 3 |

## With a second player

| # | Do | Proof |
|---|---|---|
| 16 | Both stand near the same wolf | It behaves for both, not just whoever got there first. Laggy-for-one is the hosting limit in NPC_NOTES.md section 3A, a known C++ item, not a new bug |
| 17 | Both damage a champion, one lands the kill | **Both** are paid, and each gets their own message |
| 18 | Local chat at range | Whisper/say/shout ranges behave. The fan-out was rewritten today |
| 19 | `/load` | Packet rate per player. This is the number that matters for 20 concurrent: roughly, packets/min divided by players should stay flat as players are added |

## If something fails

Report the smallest specific thing, in this order of usefulness:

1. The **log line** from `server\server.log` at the time (it is live again as of 2026-09-16).
2. The **form id** of the ref involved: a floating creature, a chest whose glow stuck, a vein that
   refused. `/load` and the NpcSpawnSystem lines carry them in hex.
3. What you expected versus what happened, in one sentence.

Screenshots are the least useful of the three unless the problem is visual (glow colour, widget
layout, a creature in the air).

## Known untested, so not a surprise if it breaks

Contracts, champions, mining, woodcutting, the spell enforcement, the chest rim shaders, the NPC
misplacement net, the live-npc budget, and the indexed spawn poll all shipped 2026-09-16 without a
player ever touching them. The one thing in this list with a blast radius beyond itself is the
`onUi` change: it altered how **every** widget's close event is delivered, so if the reading game,
the dungeon gate or the skills menu misbehaves on close, that is the first suspect.

## What this session decides

If steps 1-15 pass, the foundation is sound enough to invite two or three more people and repeat
with `/load` open. If they pass at three players, the next question is whether anything degrades
between 3 and 20, which is a different kind of test: watch the poll time and the packet rate per
player rather than the features.
