# NPC system v2: one authority on the server, one agent on each client (from 2026-09-25)

Nat, after the 25 September playtest: "build a whole new system that manages the NPCs that is far better; these
fixes are weak bandaids." This replaces the ad-hoc actor layer described in `NPC_REBUILD.md` (whose invariants it
adopts) and the nets added since. Evidence: the playtest of 2026-09-25 (hosts holding 68 NPCs with 29 unloaded,
copies snapping 450-4300 units to stale positions, two clients driving one goblin, creatures underground on slopes,
and a terrain-based lift that floated an ogre standing on the path).

## The hard limit, and what follows from it

The server has no navmesh, physics or animation, so an NPC's body can only be simulated inside one player's game.
v2 keeps that and moves everything else to the server: **who** simulates each NPC, **when** it exists, **where** it
is agreed to be, and **what** it carries. A client never decides any of those; it executes and reports.

## Parts

### Server: `NpcDirector` (TypeScript system, replaces hosting and the placement nets in `npcSpawnSystem`)
- **Registry** keyed by a durable id (change-form tag, as companions already do): base, spawn slot, zone, owner
  system (wildlife, dungeon, placement, warband, companion), state, last agreed position, health, host.
- **States**: `dormant` (no player near: no copy anywhere, the server keeps its last agreed position) ->
  `activating` (a host was chosen and told to create it at that position) -> `live` (the host confirmed the copy
  exists, stands, and matches) -> `handover` (moving to another host) -> `dead` -> `gone`.
- **Host election on the server.** Each client reports once a second which NPCs it has loaded and how far away they
  are (the *sight report*). The director picks the host: the nearest player who has the NPC loaded, kept with
  hysteresis (a new player must be clearly closer, or the host silent for 2 s). Clients never ask to host; the C++
  host-attempt path refuses anything the director did not assign.
- **Handover from the agreed position.** The new host is sent the position the server agreed, seats its copy there,
  confirms, and only then drives it. The old host stops driving before the new one starts. No copy ever starts from
  its own stale position (the 3,900-unit snaps).
- **The host reports where the body is.** Measured at 17:12 on 2026-09-25: the terrain file matches both players'
  real height to 1-2 units, yet the server held an ogre 212 under the terrain while it stood on the path on its host's
  screen. On the host, an NPC's reference position and its 3D body drift apart (the npcDrift "split"), and the host
  sends the reference. The agent sends the body's root-node position and keeps the reference seated on it.
- **Ground truth is the host's physics, not a terrain file.** A spawn slot is chosen on the terrain as a first guess
  (the terrain file is known to be off in places), the host places the copy there, lets havok settle it, and reports
  the height it came to rest at; that becomes the agreed position. The periodic "lift" is retired.
- **Movement validation** (already in C++ since 16:37): a step no NPC can make is refused and the host corrected.

### Client: `NpcAgent` (replaces the NPC paths of `formView`, `SpawnProcess`, the cleaner exemptions and the drift repairs)
- **The only owner of NPC copies.** Creates, places, enables, verifies and deletes copies; the world cleaner, views,
  companions and repairs ask it instead of acting. No other code moves, disables or respawns an NPC copy.
- **Two modes per copy, never both.**
  - *Driving* (this client is the host): AI and collision on, nothing translating it, no keep-offset. Reports the
    body's root-node position every 130 ms, and re-seats the reference on the body when they part.
  - *Following* (someone else hosts it): AI off, collision on, placed from a short buffer of the host's positions
    played back ~150 ms behind (interpolation, not extrapolation), so it moves smoothly along the host's path
    instead of translating straight through hills.
- **Sight report** once a second: loaded NPC ids, distance, and for hosted ones the settled position.
- **Never respawns from stale data.** A copy that must be recreated is placed at the server's agreed position.

### C++ (fork `skymp5-server/cpp`)
1. A host-assignment call the director uses (`HostStart`/`HostStop` by server decision), and `OnHostAttempt`
   refusing client requests the director did not make.
2. Stop echoing an NPC's own movement back to its host.
3. Let an NPC change cell (a door, a cave mouth) instead of refusing every later move.

## Phases, each shipped and checked on its own

| Phase | What changes | Needs |
|---|---|---|
| 1. Director + server host election | Hosting decided on the server from sight reports; handover from the agreed position | server (TS + C++), client sight report |
| 2. NpcAgent following mode | Watchers play the host's path back smoothly; no translate-through-hills, no keep-offset hack | client |
| 3. Spawn handshake + settled ground | Copies placed, settled by the host's physics, confirmed; agreed height from the host | server + client |
| 4. Dormancy + durable ids | NPCs with nobody near hold no host and no copy; ids survive restarts | server |
| 5. Delete the nets | stranded/sliding/fell checks, drift repairs, ground lift, cleaner exemptions | both |

Every phase keeps the npcDrift reports (the measuring instrument) until phase 5 shows they have nothing left to say.
