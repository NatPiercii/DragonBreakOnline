# NPC and creature rework plan (2026-09-25)

Nate asked for the whole NPC pipeline to be reviewed and reworked so the same creature bugs stop coming back. Four
read-only reviews ran on 2026-09-25 (client, server C++, server systems plus gameplay, and a measured catalog of the
day's log), followed by two pre-deploy reviews. This file is the result: what was wrong, what is already fixed, and
what to build next, in order. NPC_SYSTEM_V2.md stays the design of the host director; this plan supersedes its phase
list where the two disagree.

## Fixed and live on 2026-09-25

| What | Where | Evidence |
|---|---|---|
| A hoster was told its own NPCs were hosted by someone else. `UpdateHoster` sent `isHostedByOther` to NPC listeners too; `GetActorToSendTo()` forwards those to the NPC's hoster, and the test compared with the NPC's own id. Its client then played the NPC back from the server: walking in place, fighting only what stood in front | fork `8f012ed8` (C++) | Three reviews agree. Before: a lone player's heartbeat flagged 4-5 own copies. After: 0, with 5 hosted and live (19:56:36) |
| The client never plays server movement back on a copy it hosts; a leftover playback is released and reported (`npcDrift pinned`) | fork `c5ca5085`, client 0.3.41 | 0 `pinned` reports after the C++ fix |
| A slot the server reuses for a different NPC gets a fresh view | fork `f4b56e82`, client 0.3.41 | Harmless. The review found the client destroys the old view on DestroyActor, so the ghost fox has another cause (below) |
| `live.json` is written off the game loop | server `393ffe16` | A synchronous write stalled the server 549 ms |

Why it got worse on 0.3.40: the wrong flag is old (48 flagged heartbeats before noon). 0.3.39 played an NPC copy back
with look-ahead, so a wrongly flagged own copy drifted forward. 0.3.40 plays back exactly, so the copy stayed put (log
catalog: 0 of 29 eligible NPCs stuck on 0.3.39, 7 of 8 on 0.3.40). Upstream SkyMP also clears the keep-offset every frame
on hosted copies; the fork dropped that on 16 and 18 September (`d73b1470`, `4754a774`).

## Measured on 2026-09-25 (log catalog)

- The NPC director has never assigned an NPC: 0 of 446 grants. Every host came from a client asking. The client's
  sight report skips forms with no movement, and a lone player's fresh or self-hosted NPC never gets movement, so the
  director never sees it.
- Ghost hosts: 13 of 13 NPCs the server deleted and recreated stayed on their host's list for 110-2,911 s; 5 live NPCs
  stayed hosted with no copy on the host for 2,541 s and were never released.
- Host churn during the playtest: 270 releases, 157 of them under 1.5 s after the grant (the `hostSeenSince` bug, fixed
  in `6cdcae25`).
- 20 refused NPC jumps (median 9,039 units), 12 of them Northfringe Sanctum draugr; one NPC cycled grant, refuse,
  release, re-grant every 6 s.
- 44 NPCs under the terrain on the server (median 83 units, worst 2,563); the old lift did not stick (25 lifts on 6
  NPCs).

## Phase A: correctness fixes (small, after the playtest, one batch)

Each is a contained change with a harness or a syntax check. Order is by harm.

1. **Destroyed NPCs leave dangling state (C++).** `WorldState` never clears the lookup entry of a destroyed form and hands its
   index out again at once (`WorldState.cpp:141-148`, `MakeID.h:120-137`); the spawn system destroys and respawns in the same
   poll. A former host's in-flight packets then land on the new NPC, or read freed memory. Fix: null the entry in
   `DestroyForm`, hold freed indices about 10 s, and erase the NPC's `hosters`, `hostSeenSince`, `npcJumps` and
   `lastMovUpdateByIdx` entries in `MpActor::BeforeDestroy`. In TS, never refill a slot in the poll that destroyed it.
2. **Hosts are never released when they should be (C++ plus client).** Unsubscribe, disconnect and `SetUserActor` (relog) keep
   the host; a deleted NPC gets no HostStop. Fix: a hoster to NPCs index, release on those events, HostStop on destroy. Client:
   drop the id from `storage['hosted']` on DestroyActor, and clear `hosted`, `hostAttempts`, `lastTryHost` and the id map on
   connect (form ids restart at `ff000000` after every server restart).
3. **The host gets its own NPC's movement and animation back (C++).** `SendToNeighbours` (`ActionListener.cpp:397-402`) includes
   the sender. Skip it. On the client, the hosted branch of `FormView` then stops calling `stopTranslation` and friends about 7
   times a second on actors its own AI is driving.
4. **NPC movement is relayed before it is checked (C++).** Watchers see positions the server then refuses, and the 3 s "the host
   insists" rule contradicts the 4,096-unit cap, which loops. Fix: one check (world, then jump) before the relay; replace the
   insist rule with stop hosting and re-seat; accept a world change when the host's own actor is already in that world
   (the NPC followed through a door) and call `SetCellOrWorld`.
5. **Other loops forward through NPC listeners (C++).** `EquipBestWeapon` (`MpActor.cpp:209`), the owner branch of
   `SetPropertyValueDump` (`MpObjectReference.cpp:807`) and `SendMessageToActorListeners` (`:2189`) send duplicates to hosters,
   and errors to hosters that do not have the form. Send once per user, as `UpdateHoster` now does.
6. **Every grant re-equips the NPC (C++).** `AssignHoster` and `OnActivate` call `EquipBestWeapon`. Only on the first host, or with
   no weapon equipped.
7. **Death and respawn (C++).** The host cannot report an NPC's death; a hit refused on a stale position leaves a corpse on the
   host and a live NPC on the server. Watchers never see a respawn (`MpActor.cpp:1216-1234`). Fix: accept an epoch-checked death
   report from the current hoster (health may only go down); send corrective health when a hit is refused; send `isDead=false`
   and the teleport to all listeners on respawn.
8. **Client leaks and stale state.** One global animation hook per hosted copy, never removed and unfiltered (`animation.ts:246`,
   `sendInputsService.ts:230`): frame rate decays over a session. `hostedDriftService.ts:256` uses a native object in a later
   frame. Per-copy maps (`translating`, `applyStates`, `groundSamples`, `learnedOffset`, ...) are never cleared: one
   `forgetLocalCopy(localId)` from `destroy`. The HostStart handler should call `settleTranslation` (it clears the engine state
   but not the tracking, which makes false `pinned` reports). The rehost path ignores `alreadyHosted`. `onUpdatePropertyMessage`
   must check the form exists and its `refrId` matches.
9. **Dungeons.** The "spot has no floor" memory is keyed by zone number, which points at a different placement each lease: 11
   slots are given up for good and those dungeons can never finish early. Key it by the placement ref, subtract skipped slots
   from `totalNpcs`, and measure "fell" against the terrain outdoors, not 3,000 units below the spot.
10. **Packets.** Client-to-server reliable packets are not ordered, and movement has no sequence number; an older NPC position
    can win. Add a per-NPC sequence number (see B2).

## Phase B: one owner for each NPC (the rework)

1. **A director that works.** Refuse every host request from a client that sends sight reports; include NPCs without movement
   (and the client's own) in the sight report; grant only after two reports in a row list the NPC and the client's distance
   matches the server's within about 300 units; take the host away when its reports stop listing the NPC; log a summary every
   minute. Gameplay only, hot-reloadable, after the client's sight filter is fixed.
2. **Epochs.** One owner record per NPC: hoster, epoch (bumped on every change), last heard, agreed position and cell, alive or
   dead. HostStart and HostStop carry the epoch; every NPC packet (movement, animation, hits as aggressor, activation, death
   report) carries it, and the server drops a stale one. This removes the stale-packet and slot-reuse races for good.
3. **`mp.createNpc(baseDesc, locationalData)`.** Create the NPC at its spot (about 20 lines in C++, from
   `PapyrusObjectReference::PlaceAtMe` with the location set before `AddForm`). Today every NPC is created at an anchor
   (a static up to 21,929 units away, or a player), teleported, then disabled and enabled: that is where "a fox spawned on
   me" comes from.
4. **Client state machine.** Each `FormView` is in exactly one state: Spawning, Unowned, Remote, Hosted, Releasing, Destroyed.
   HostStart and HostStop only change the hosted list; the view applies side effects on its next frame through
   `exit(old)` then `enter(new)`. Hosted refuses playback; Remote never runs its own AI; Spawning is not reported or asked
   for. This replaces the fragile `alreadyHosted` flag.
5. **Dormancy and durable ids.** Keep a zone awake while any player has one of its NPCs nearby (not the zone centre); when
   nobody has, keep the record and destroy the actor; re-adopt NPCs by a durable id on boot; spawn beyond view distance.

## Phase C: delete the safety nets

Once A and B hold in a playtest: `resyncDesynced` (already off), the npcground lift (already off), the stranded and sliding
checks, the fall check and `npc-fallen-spots.json`, `assertPlacedIn`, `assertStandingAt` and the disable/enable step, the
wrong-cell check, and the 3 s insist rule. Keep the 5 s stale-host release as a backstop, the leash as a despawn, and the
corpse sweep.

## Still open

- The fox that appeared on the player at 19:30:43: spawned and granted 200 ms apart; the slot fix probably does not cover it.
  B3 (create at the spot) is the likely fix. Watch the playtest logs.
- The player cannot move for about 20 s after login (server log shows nothing holding them): needs the client log.
- Slow ticks: `npcGround` 55-118 ms, `worldStats` 263 ms, the spawn poll 80-234 ms.
