# Scaling DragonBreak to a thousand players

Written 2026-09-16 after the target was set: one logical server, sharded, up to ~1,000 concurrent
players, with the economy and the content player-driven. This is an audit of what the current code
does per tick and per player, what breaks first, and the order to fix it. Numbers are counted from
the code, not measured on a running server; where a figure is an estimate it says so.

## 1. The shape of the problem

Three costs grow with players, and they grow at different rates:

| Cost | Grows as | Where |
|---|---|---|
| Per-player work each tick | O(players) | movement, inventory, HUD |
| Zone and spawn checks | **O(zones x players)** unless indexed | `npcSpawnSystem` poll |
| Broadcasts | **O(players) per event, O(players^2) if every player causes one** | any `for (const a of onlineActors()) sendPacket(...)` |

The first is unavoidable and cheap. The second and third are where a design either survives 1,000
players or does not, and both were wrong here as of this morning.

## 2. Fixed 2026-09-16

### The spawn poll was O(zones x players)

`NpcSpawnSystem.updateInside` ran per zone, and inside it looped every online player calling
`getActorCellOrWorld` and `getActorPos` — two native N-API calls per pair, every 2 seconds.

With 1,883 wildlife zones: 50 players = 94,150 pairs = ~188,000 native calls per poll. 1,000 players
= 1,883,000 pairs = **~3.8 million native calls every 2 seconds**. That is the wall, and no amount of
sharding by worldspace fixes it on its own, because Tamriel holds most of the zones and would hold
most of the players.

Now: every player is read **once** per poll into a snapshot, bucketed by worldspace and into a
4,096-unit grid. A zone looks up only the grid squares its radius reaches. Cost falls to
O(players + zones + actual matches). At 1,000 players that is 2,000 native calls instead of 3.8
million, and the per-zone work for an empty region is one failed map lookup.

Zones wider than 8 grid squares (dungeon zones use a 100,000 radius) fall back to testing every
player in their world, which is correct and cheap because there are few of them and they are only
active during a lease.

### A live-NPC budget, now configurable

1,883 zones and a 4-minute despawn delay mean a player crossing the map trails actors the whole way.
`fillSlots` stops at a budget and retries the slot in 10 seconds. Default 150, override with
`npcLiveBudget` in server-settings.json. **150 is a playtest number.** For 1,000 players it is
nonsense — the right value is roughly (expected concurrent players in the shard) x (NPCs a player
should see), so plan on thousands, and watch memory and change-form count when raising it.

### Two broadcasts of my own making

- `champions.js` re-sent every champion's glow to **every online player every 4 seconds**. At 1,000
  players that is 250 packets a second carrying nothing new. Now marks go only to players in the
  champion's own worldspace, and only when that player's view of the set actually changed.
- `contracts.js` wrote `contracts.json` synchronously on **every kill of progress**. Now dirty-marked
  and flushed at most every 5 seconds.

## 3. What breaks next, in the order it will break

1. **NPC hosting.** Every NPC is simulated by one player's client (see NPC_NOTES.md). At 1,000
   players the "hosted by someone far away" problem stops being cosmetic: a crowded zone means many
   players watching NPCs driven by whoever claimed them first. Server-chosen hosting by proximity is
   the fix and it is a C++ change. This is the single biggest quality item on the list.
2. **`onlineActors()` loops in the gamemode.** Every one is O(players) per event. They are fine at
   50 and a problem at 1,000 if any of them run per player-action rather than per world-event. Audit
   before the player count grows: `grep -n "onlineActors()" server\*.js`.
3. **JSON state files.** `NPC-Spawns.json` is 541 KB and is rewritten whenever a dungeon lease
   changes; `notice-boards.json`, `officials.json`, `contracts.json`, `housing.json` are all
   read-modify-write on the main thread. Each write is a stall for every player on the shard. They
   want either a debounce (as contracts now has) or a real store.
4. **Change forms.** Every spawned NPC, every container the players empty, every property is a change
   form kept in memory and saved. Growth is unbounded over a server's life; the world backups in
   `_world-backup-*` are the only pruning today.
5. **The chat fan-out.** Say/shout/wide all resolve recipients by distance per message. Fine per
   message, but it is O(players) per message and every player generates messages.

## 4. What sharding gives, and what it does not

Sharding by worldspace (Bruma, Skyrim, Solstheim, hub) helps exactly the costs that are
**per-shard**: the spawn poll, NPC hosting pressure, chat fan-out, the live-NPC budget. It does not
help anything that is global: the master API, the account and character store, the economy, the
notice boards, bans, and the Discord integration. Those belong in the backend
(`skymp5-backend`), not in a game server process, and should be treated as shared services from the
start rather than retrofitted.

Two rules worth adopting now, while the code is small:

- **Anything a player owns or trades is global state**; anything about where an actor stands is
  shard state. Keep the two apart and sharding is mostly a deployment question.
- **No feature should send a packet to every player because one player did something.** Scope every
  send to a worldspace, a zone, a party or a single player. `champions.js` broke this rule within an
  hour of being written, which is how easy it is.

## 5. Player-driven, and why it also helps scaling

The decision to keep the economy player-run (player shops, no NPC merchants, hold treasuries funding
contracts) is a scaling asset, not just a roleplay one. NPC merchants would need per-shard inventory
simulation, price updates and restock timers; player shops are ordinary container and ownership
state that already exists, and the cost lives with the player who opened the shop. The same is true
of contracts: the money comes out of a treasury chest that a player filled, so no faucet needs
balancing at 1,000 players — the economy is bounded by what the players put into it.

## 6. How to measure before guessing

Nothing here has been profiled on a live server. Before the next scaling change, get real numbers:

- Time the spawn poll: wrap the body of `NpcSpawnSystem.poll` and log when it exceeds, say, 50 ms.
- Count packets: a counter on `sendPacket` in gamemode.js, reported per minute, will find the next
  accidental broadcast faster than reading code.
- Watch change-form count over a long session; it is the best proxy for memory growth.
