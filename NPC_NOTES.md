# NPCs on DragonBreak Online: how they actually work, and what is worth fixing next

Written 2026-09-16 from a read of the fork (client, server TS, server C++) plus the evidence in
CHECKLIST.md and HANDOFF.md. Nothing here was measured in game; every claim points at the code it
came from so the next person can check it rather than trust it.

## 1. The pipeline, end to end

A spawned NPC passes through five owners. Almost every NPC bug is a handover between two of them.

1. **The zone file.** `server\NPC-Spawns.json` (written by the gamemode for `dungeon:*` and
   `wild:*` zones) is read by `npcSpawnSystem.ts`. A zone is a position, a radius, a list of NPC
   bases and a slot per NPC. Slot 0 stands on the zone position, the rest fill rings 96 units apart.
2. **Placement.** `npcPlacement.ts` `placeNpc` calls Papyrus `PlaceAtMe` on an **anchor**: a
   reference the server actually instantiates (furniture, activator, door, container, item).
   Bethesda's own placed NPCs are never instantiated by the server, which is why
   `ck-mcp\dungeons_anchor.py` re-anchors every placement onto the nearest loadable ref. The new
   actor is then moved with `locationalData`, and toggled `isDisabled` true/false because the move
   alone never reaches clients that are already watching the anchor.
3. **The copy on each client.** `formView.ts` creates a local copy per remote NPC. Its position
   comes from server movement messages through `applyMovement` / `translateTo`.
4. **The host.** One client simulates the NPC for real. `tryHostIfNeed` claims it; the server
   grants in `ActionListener.cpp` (`OnHostAttempt`, ~line 1070) if the NPC has no hoster **or** the
   current hoster has not reported movement for 2 seconds. On grant the server sends
   `HostStartMessage`, calls `EquipBestWeapon()` and schedules a health resync one second later.
5. **Back to the server.** Only the hoster's movement, hits and spell casts are accepted
   (`SendToNeighbours` refuses anyone else, ~line 378). The server's stored position for an NPC is
   therefore only ever as fresh as its hoster's last report.

The consequence worth memorising: **an NPC nobody hosts does not act.** It is a puppet standing at
whatever position the server last recorded.

## 2. What was wrong and is now fixed

- **Copies floating with no collision** (fixed 2026-09-16, client). `translateTo` moves a reference
  with collision **off for the entire translation**, and nothing ever called `stopTranslation`.
  `formView.ts` only applies movement while `model.isHostedByOther`, so the instant a copy was
  hosted by us or by nobody, its last translation kept running: X/Y parked at the target, Z creeping
  at the leftover speed, the player walking through it. `settleTranslation()` in `movementApply.ts`
  now ends it when the copy settles, dies, or stops being server-driven.
- **Spawn desync** (fixed earlier). The disable/enable in `placeNpc`, see above.
- **Unarmed humanoids.** `EquipBestWeapon()` on host grant, plus the gamemode's own arming pass in
  `dungeons.js`.
- **NPCs stuck above their spot / dragged across the map** (fixed 2026-09-16, server).
  `npcSpawnSystem.checkMisplaced` already replaced an NPC that fell below the world; it now also
  replaces one hanging `STRAND_LIFT` (600) above its slot, within 384 units of it, unmoved for three
  polls, and frees the slot of any NPC that strayed past `max(8000, radius * 3)` from its zone.

## 3. What is still open, cheapest first

### A. Host assignment is passive (TS: impossible, C++: small)

The server never chooses a host. It waits for a client to ask, and clients only ask when they notice
an actor that has not moved for 1.5 s. Two consequences:

- A player standing next to an NPC hosted by someone 6,000 units away sees a laggy NPC, and nothing
  corrects it: the distant hoster is still reporting, so the 2 s staleness rule never trips.
- The first host claim costs ~1.5-2.5 s after a spawn, which is the window where an NPC looks frozen.

The fix is server-side host reassignment: when an NPC has a hoster whose distance is more than,
say, twice the nearest other player's, send `HostStopMessage` to the current one and
`HostStartMessage` to the nearer. The hosters map lives in `worldState.hosters` (C++ only), so this
means editing `ActionListener.cpp` / `PartOne.cpp` and a **native build** (CI flatrim or the
manager's CMake button). The gamemode's `onHostAttempt` event can only *refuse* a claim, never
initiate one, so there is no TypeScript shortcut.

Upstream lists host change as an open roadmap item, so do not expect it to arrive for free.

### B. "Too distant" hit rejections (mitigated, watch it)

`ActionListener.cpp` (~line 1490) drops any non-bow hit where aggressor and target are more than one
exterior cell (4096 units) apart, using **server** positions. Those positions are the hoster's last
report, so a laggy or wrongly-placed NPC gets its hits thrown away and combat feels dead. The
collision and stranding fixes should reduce this; if it persists, the log line to grep for is
`OnHit - aggressor and targetRef are too`. The comment above it (`TODO: repair IsDistanceValid`) is
upstream's own admission that the check is a blunt stand-in.

### C. NPCs only fight what the host can see

Aggression is already handled well: `formView.attacksEveryone` raises a hostile NPC's Aggression to
2 so it will attack other players' copies, which are neutral by default. What is not handled is that
the NPC's AI only exists on the hosting client, so the quality of another player's fight depends on
someone else's frame rate and load order. This is inherent to the design; the only lever is A.

### D. Spawn placement quality

Slots are rings around the zone position and every spawn is lifted 64 units so it drops onto uneven
ground. With collision now restored on copies, that drop finally works as intended. Two known
weaknesses remain: a zone anchored on a ref that sits high (a shelf, a ceiling fixture) starts its
NPC in the air, and a ring slot can land inside geometry in a tight interior. The survey scripts
record the anchor distance, so a pass over `dungeons.json` for anchors far from their placement
would find the worst offenders without touching the game.

### E. Corpse and respawn tuning

`DEFAULT_CORPSE_SECONDS` 300, wildlife respawn 1800 s, despawn 240 s, radius 3000. These are
guesses that have never been measured against a populated server. Worth revisiting once more than
one player is on at a time.

## 4. Techniques worth borrowing, and what they would cost here

| Technique | What it buys | Cost here |
|---|---|---|
| Server-chosen host by proximity, with hysteresis | Ends the "someone else's lag is my wolf" problem | C++ change + native build |
| Host handover on hoster disconnect instead of waiting 2 s | Removes a visible freeze when a player leaves | C++, small |
| Interest management: only send NPC updates to clients within N units | Bandwidth, and fewer ghost copies | C++, medium |
| Server-side dead reckoning for unhosted NPCs | NPCs drift instead of freezing when unhosted | C++, medium, risks fighting the host |
| Leash + slot recycling | Zones stay populated, no runaway accumulation | **Done, TS** |
| Collision restore on settle | No floating, no walk-through | **Done, client** |
| Position sanity checks on the server poll | Self-healing bad spawns | **Done, TS** |

The three "done" rows are the ones that did not need a native build. Everything above them does,
which is the honest reason to stop here rather than keep going: the next real gain is A, and A is a
C++ change that must be tested with two players in the same cell before it can be trusted.

## 5. How to verify any of this in game

- Server log lines to watch: `NpcSpawnSystem: '<zone>' <id> hung ... above its spot`,
  `... strayed ... from its zone`, `... fell out of the world`, `Hoster of <id> changed from ... to ...`.
- A wolf should now stand on the ground and block you. If one still floats, get its form id from the
  log line and the zone name; that is enough to find its anchor in `wildlife.json`.
- If combat swallows hits, grep the server log for `too distant` and compare the reported positions
  with where the NPC visibly is.
