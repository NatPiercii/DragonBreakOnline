# The inventory apply gate: why gold does not move while you are looking at it

Proposal, written 2026-09-28 by `claude-nate` after the 0.3.58 gold fix. Nothing here is done yet. The interim that
shipped in 0.3.58 (gold on the HUD, from the server's own count) stands on its own; this is about the thing underneath.

## What happens today

Gold the server moves reaches the player's engine inventory through one path, and it is intact until the last step:

| Step | Where | State |
|---|---|---|
| `giveItem` / `takeGold` write `mp.set(a, 'inventory')` | `server/gamemode.js` | works |
| The write becomes a message for that player | `skymp5-server/cpp/server_guest_lib/MpObjectReference.cpp:862` `SetInventory` -> `:868` `SendInventoryUpdate()` -> `:2037` builds `SetInventoryMessage` | works |
| The client stores the snapshot and asks for an immediate apply | `skymp5-client/src/services/services/remoteServer.ts:235` `onSetInventoryMessage`, which sets `pcInvLastApply = 0` | works |
| The apply loop writes it into the engine | `remoteServer.ts:116` | **skipped whenever a menu is open** |

The last step begins:

```ts
on('update', () => {
  if (isBadMenuShown()) {
    return;
  }
```

and `isBadMenuShown()` (`skymp5-client/src/sync/equipment.ts:146`) is true for `InventoryMenu`, `FavoritesMenu`,
`MagicMenu`, `ContainerMenu` and `Crafting Menu`. So for as long as the player has their own inventory open, nothing
the server pays them is written into the engine. Close the menu and the next update applies it.

Gold is not special in the apply. It is a Misc item, so it goes in as a single `AddItem` of the whole delta rather than
one coin at a time (`sync/inventory.ts:542`).

## What the guard was actually for

The guard is shared by three call sites that do different things, and only two of them are what it was written for:

1. `remoteServer.ts:116` - the **player's own inventory** apply. This is the one that costs us the gold figure.
2. `formView.ts:410` - applying an inventory to the **actor under the crosshair**. Its own comment says actors do not
   have inventory in their models "except your clone".
3. `formView.ts:689` - applying **equipment** to other actors. This one carries the reproduction, written by upstream:

   > 1. Place ~90 bots and force them to reequip iron swords to the left hand (rate should be ~50ms)
   > 2. Open your inventory and reequip different items fast
   > 3. After 1-2 minutes close your inventory and see that HUD disappeared

That is the evidence for the guard, and it is about **other actors' equipment churning while a menu is open**, not
about the player's own inventory receiving a snapshot. It is also a HUD loss, not a crash. `Crafting Menu` carries an
upstream comment on its own line: "Actually I don't think it causes crashes".

So the case we care about is the one with the least evidence behind it - but "least evidence" is not "no risk", and
the risk is real for a different reason, below.

## Why simply removing it for case 1 is not the fix

Skyrim's `ItemMenu` builds its list when it opens. Adding or removing items underneath an open inventory menu is a
long-known way to get a stale or corrupt list, and the number on screen does not redraw for the entry that changed.
So even with the gate removed, **the gold figure the player is staring at would probably still not move** - the apply
would land in the engine and the menu would keep showing what it drew when it opened.

That is worth stating plainly, because it changes what the fix is for. Narrowing the gate is about the inventory being
*correct* the moment the menu closes, not about the number ticking up while it is open. For the number the player
watches, the HUD readout that shipped in 0.3.58 is the right answer and probably the permanent one.

## The proposal

Three steps, smallest first. Each is worth doing on its own.

**1. Apply on the closing edge, not up to five seconds later.** Today the loop re-applies at most every 5 s
(`Date.now() - pcInvLastApply > 5000`), and a snapshot that arrived during a menu waits for that timer after the menu
closes. Track the menu state and call `requestPcInventoryApply()` (already exported, `remoteServer.ts:112`) the frame
the last blocking menu closes. Cheap, no new risk, and it removes the visible lag when someone closes their inventory
right after being paid.

**2. Split the guard by call site.** Replace the one `isBadMenuShown()` with two: keep the full list for the equipment
and crosshair-actor paths, which is what the reproduction is about, and give the player's own-inventory apply its own
predicate. That is a rename and a second function; it changes no behaviour by itself, and it makes step 3 a one-line
change that cannot affect the other two call sites.

**3. Then, and only with a test behind it, let the player's own apply run under `ContainerMenu` and
`Crafting Menu`.** Leave `InventoryMenu` blocked - that is the one the engine rebuilds least gracefully, and per the
section above we gain nothing visible by unblocking it. Containers and crafting are where a server-side payment most
often lands mid-menu (selling, a commission paying out at a bench).

## How to test it safely

Two bots on an isolated server is the instrument we already have (`server/tools/bot`, and see
`headless-bot-measures-the-wire` in the notes): it drives the real `MpClientPlugin.dll`, so it shows what a remote
client is actually sent.

- **Reproduce first, on today's build.** Pay a character gold from the server (`/give` or a bank withdrawal) while
  their inventory is open, and confirm from the client log that the `SetInventory` arrived and no apply followed until
  the menu closed. If that does not reproduce, the diagnosis in this document is wrong and nothing below is worth doing.
- **Re-run upstream's own reproduction** before and after step 3, since it is the only recorded failure: ~90 actors
  reequipping at ~50 ms with a player opening and reequipping in their inventory, for two minutes, then close and check
  the HUD is still there. If the HUD survives on the current build too, the guard is no longer protecting anything on
  this engine version and that is worth knowing.
- **Test on the dev server with nobody else on**, the way any client change is tested, and check `skyrim-platform.log`
  for allocator complaints around the apply rather than trusting the absence of a crash in one session.
- **Ship it in a client package of its own**, not bundled with unrelated client work, so a rollback is one version.

## The other question: is the gold row missing, or only stale?

Everything above explains a **stale** number. It does not explain a gold row that is absent from the inventory
entirely. If Nate reports the latter, the first thing to look at is ours, not upstream's:

`skymp5-client/src/index.ts:110-119` sets the weight of gold (`0x0000000F`) to 0.02 through SKSE's
`Form.SetWeight`, re-applied after every game load (Nate, 2026-09-26, so a fortune is worth banking). Vanilla gold
weighs 0. That is a change to the base form in memory, and the inventory menu sorts and groups Misc items partly by
weight, so it is the one DragonBreak-specific thing standing between the engine's gold and how the menu draws it.

Cheapest check: set `GOLD_WEIGHT` back to 0 in a test client, load, and see whether the row returns. If it does, the
weight and the visible row are in conflict and Nate has a design choice to make - weightless gold, or gold that weighs
something and is read from the HUD. If it does not, the weight is innocent and the missing row is a separate hunt.

## Related

- `server/gamemode.js` `pushHud` carries `gold` (0.3.58) - the interim, and the reason none of this is urgent.
- `docs/` in the fork for the client architecture; `skymp5-client/src/services/services/remoteServer.ts` is where all
  of the player-side apply lives.
