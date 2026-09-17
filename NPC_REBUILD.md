# The NPC layer rebuild (started 2026-09-17)

Why: the gameplay layer is sound, the actor layer is not. An NPC's existence is currently negotiated between
five systems that do not know about each other, and every gap between them has produced a bug we then patched
with a detector. This document names the invariants the rebuild must hold, so the detectors can be deleted
afterwards. If a net cannot be deleted at the end, the rebuild did not work.

Read with `server\NPC_NOTES.md` (the current pipeline and technique ranking) and the C++ session at the top
of `server\CHECKLIST.md`.

## What stays

- **Server decides intent, the owner's engine executes.** Same choice Tilted Online (Skyrim Together) made,
  for the same reasons: the server has no navmesh, no collision, and cannot broadcast a movement message.
  `docs\docs_roleplay_companions.md` already states this design.
- The gameplay layer: dungeon leases, zones and officials, skills, boards, contracts, needs.
- Hosting as the unit of authority. One client drives an actor; everyone else watches its stream.

## The five systems that fight over one actor today

1. `npcSpawnSystem` / `companionSystem` (server): decide an actor should exist, create it with PlaceAtMe on an
   anchor, then teleport it to its spot.
2. `formView` (client): creates the local copy with `placeAtMe(base, 1, persist, initiallyDisabled = true)`.
3. `SpawnProcess` (client): sets position, enables, resurrects, and only then calls back.
4. `worldCleanerService` (client): picks a random actor within 8192 units and disables then deletes it unless
   it is in a protection list, which `formView` fills only once the view exists.
5. Hosting (`onHostAttempt`, `tryHostIfNeed`): decides who drives it, up to 2 s after it appears.

## Invariants the rebuild must hold

1. **One authority per actor, on the client.** A single place knows, for every server actor: does a local copy
   exist, is it enabled, is it mapped remote<->local, who drives it, is it protected from the cleaner. Every
   other system asks that authority instead of racing it. No system may delete, disable or move an actor it
   does not own.
2. **An actor is live only when it has been verified.** Server says "create this here"; the client creates,
   places, enables, verifies position and cell, and reports back; the server treats the actor as live only
   then. No "teleport and hope the move reached watchers", so no disable/enable resend trick.
3. **Identity is durable, not a reused dynamic id.** Dynamic ids (0xff...) are reassigned every run, which is
   why crash cleanup by id cannot work. The change form tag (`private.dboCompanion`, added 2026-09-17) becomes
   the primary key, and the same idea extends to zone spawns.
4. **Placement is chosen where the actor can stand.** A summon is currently placed blindly 96 units in front
   of the caster with a 16 unit lift; a dungeon enemy is placed on a recorded vanilla spot that may be in the
   void. The authority that creates it must confirm the spot, or pick another.
5. **One movement path.** Either the host's AI drives an actor, or the server's stream does, never both, and
   collision is on whenever nothing is mid-translation.

## Phases

- [ ] **0. Write down today's behaviour** (in progress). The npcDrift report now carries `moved`, `deleted`,
  `disabled`, `loaded`, `localId`, the companion position and the owner position. Keep samples of a working
  follow and a frozen one before changing anything.
- [ ] **1. Client actor lifecycle authority.** Extract from `formView` and `SpawnProcess` a single owner of
  copy state. Cleaner, views, companions and hosting all consult it. This is the oldest and least documented
  code in the fork and touches every synced actor, not only summons: expect regressions, and test with players
  and creatures, not just a summon.
- [ ] **2. Spawn handshake.** Server request -> client create/place/verify -> server marks live. Retires the
  misplaced, fell, stranded and wrong-cell families at the source.
- [ ] **3. Durable identity everywhere.** Tag zone spawns like companions; sweep by tag at boot.
- [ ] **4. The three C++ fixes** (see CHECKLIST): let an NPC change cell and correct a rejected move,
  server-chosen hosting by proximity, stop echoing an actor's own movement back to its host.
- [ ] **5. Delete the nets** below and confirm nothing regresses.

## Nets to delete once the invariants hold

| Net | Where | Keep or delete |
|---|---|---|
| Misplacement: fell out of the world, strayed, hung above its spot | `npcSpawnSystem.checkMisplaced` | delete after phase 2 |
| Wrong-cell replacement (hits refused forever) | `npcSpawnSystem.checkMisplaced`, added 2026-09-17 | delete after phase 4 (C++ fix 1) |
| Give up a spot after two falls | `npcSpawnSystem`, added 2026-09-17 | delete after invariant 4 |
| Placed-position verification and resend | `npcPlacement.assertStandingAt`, added 2026-09-17 | folds into phase 2 |
| Cell verification and destroy | `npcPlacement.assertPlacedIn` | folds into phase 2 |
| Companion tag sweep at boot | `companionSystem.taggedLeftovers`, added 2026-09-17 | keep, it becomes invariant 3 |
| Stuck rescue: teleport a companion that cannot move | `companionService.unstick`, added 2026-09-17 | keep while phase 1 is unfinished, then reassess |
| Re-seat an undriven copy stranded from the server | `formView`, added 2026-09-17 | delete after phase 1 |
| Cleaner burst delayed 3 s so it cannot sweep a new companion | `companionService`, added 2026-09-17 | delete after phase 1 (the authority protects it instead) |
| Cleaner skips own companions | `worldCleanerService`, added 2026-09-17 | delete after phase 1 |
| HostedDriftService reseats a split reference | `hostedDriftService` | reassess after phase 4 |
| Collision restored after a settled translation | `movementApply.settleTranslation` | keep, it is invariant 5 |

## The open summon case, as evidence for phase 1

A Flame Atronach summoned 2026-09-17 17:57 was hosted by its owner, `deleted: false`, `disabled: false`,
`loaded: true`, AI enabled, holding a live keep-offset order, and it moved 0 to 12 units per five seconds while
its owner walked 1,500 units away. `keepOffsetFromActor`, `evaluatePackage`, `moveTo` (leash) and a direct
`moveTo` (stuck rescue) all had no effect on it. One atronach did follow correctly at 15:20, so it is
intermittent. Ruled out: the stranded re-seat pinning it (fixed, commit 6c75eac), combat holding it
(`inCombat: false`), the world cleaner deleting or disabling it (the report above), and AI being off.

Notable: at its first report the atronach was already 585 units from its owner, although the server places a
summon 96 units in front of the caster. The next thing to check is the companion position against the owner
position, now in the report, to learn whether the reference being commanded is the one the player sees.
