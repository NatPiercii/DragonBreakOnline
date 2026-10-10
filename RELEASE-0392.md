# Client 0.3.92

Source branch `client-0392` (fork). Client JS only: no C++, no front, no plugins, no server restart.

## Base

0.3.91 is claude-jake's appearance build (`client-face-diag`, tip 7863afdd on 26a4c137e). That tip was not on the
remote when this branch was made, so `client-0392` is based on **26a4c137e (0.3.90's source) + client-1010-fixes
6047471a**. Nate put client-1010-fixes into 0.3.91 too, so 0.3.92 has everything from us that 0.3.91 has.

**Before building 0.3.92, merge this branch onto 0.3.91's pushed tip.** The merge has one conflict, in
`skymp5-client/src/services/spApiInteractor.ts` (the controller's `on:` line). The resolution, tried locally on
`client-0392-on-0391-local` (never push that branch, it holds claude-jake's unpushed commits; tsc clean, 35/35 harnesses):

```ts
const perfOn = perfDiagEnabled((sp.settings && sp.settings["skymp5-client"]) as Record<string, unknown> | undefined);
SpApiInteractor.controller = {
    on: ((event: unknown, handler: Handler) =>
        ((perfOn ? SpApiInteractor.timedOn : sp.on) as any)(event, reporting("on", event, handler))) as unknown as typeof sp.on,
    once: ((event: unknown, handler: Handler) => (sp.once as any)(event, reporting("once", event, handler))) as unknown as typeof sp.once,
```

The `sp.settings &&` guard keeps `tests/client-diag-harness.js` working (its platform stub has no settings). After the merge,
set `DBO_CLIENT_VERSION` in `src/lib/clientDiag.ts` to `"0.3.92"`.

## What is in it

| From | What |
|---|---|
| client-1010-fixes 6047471a (c4d3f158, c1b4ff4e) | A beast form's revert is checked until it holds; a character switch leaves no orphaned body |
| client-facemorph-guard 8b3ee2b8 | Lip sync moves no mouth on a dead, unloaded or disabled body, or a race with no FaceGen head |
| client-glow-remote-actors-0391 bdaf0011 (a794b65d, bdaf0011) | Glows (outlines) find the local copy of another player or a spawned NPC, and are lit again when its form is made again |
| client-perf-diag 9699c746, f5529967 | Every update handler is timed under its listener; a perf report every 30 s as an `npcDrift <name> perf` line (fps, worst frame, slow frames, JS time, top handlers, cell, hosted forms, glow refs). `perfDiag: false` in the skymp5-client settings turns it off |
| a61e672f (new) | A souled soul gem the player holds is left alone by the server inventory apply (Barush #C9TM) |

### The soul gem fix

`InventoryApi.cpp` reads `ExtraSoul` with `GetType()`, which is the extra-data type id `ExtraDataType::kSoul` (0x9C)
in CommonLibSSE b93280e8 (the pinned flatrim port), not the soul level (`GetContainedSoul()`). The typings say `soul: 0..5`,
but every held souled gem reads as 156. The 5 s apply (`remoteServer.ts` -> `applyInventory` -> `getDiff(..., "apply")`)
never matched the server's `{ baseId 0x2e4e4, soul: 1 }`. The apply-mode fallback skips server copies that have extras.
So each pass removed the gem and added it back, and the game showed the item notice every 5 s.
Fix: `soulsMatch` in `sync/inventory.ts` treats a soul outside 1..5 as an unreadable level that matches any soul, never
an empty gem. `tests/soulgem-apply-harness.js` runs the real `inventory.ts` on a fake container. On the old code it shows
the remove and add on every pass. On the fix it shows no change on the second and later applies. The real cure is
`extra.GetContainedSoul()` in `InventoryApi.cpp`, and that needs a platform DLL build. Once that ships, levels compare exactly again.

## Patch notes for players

- Remote players and NPCs are outlined again when a glow should show on them.
- Switching characters no longer leaves your old character's body standing in the world.
- A werewolf or vampire lord who is downed and revived wakes in their own shape.
- A crash when someone near you was downed or died while talking is fixed.
- A filled soul gem no longer pops its notice up over and over.
- The client now sends the server a short performance report every 30 seconds, so we can track down lag.

## In-game tests needed

1. **Login:** log in, character select shows your characters, enter the world (required for every client release).
2. **Remote outlines (2 players):** each sees the other's outline, and a spawned NPC's outline, where a glow applies.
   It should still be there after the other player relogs or the NPC respawns.
3. **Lip sync:** down a player who is talking (voice) next to a watcher. Neither client crashes, and the log shows "lips held".
4. **Character switch:** switch character in place. No body of the old character stays behind (check from a second client).
5. **Beast form:** a downed werewolf, revived, wakes in their own race on their own screen and on a watcher's.
6. **Soul gem:** a character holding a filled lesser soul gem (Barush's, or soul-trap a petty creature into one) sees no
   repeating item notice for a few minutes. Empty and fill another gem, then drop one: counts stay right.
7. **Perf:** `/var/log/skymp-server.log` shows `npcDrift <name> perf:` lines every ~30 s per player.

Build with `npm run build` (development mode) and run `check-client-bundle.js` before shipping.
