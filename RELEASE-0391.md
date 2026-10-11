# Client 0.3.91

Source branch `client-0391-release` (fork, local). Client JS and front: no C++, no plugins, no server restart for the
client itself. The Thalmor, Nobility and pigeon post panels need their gameplay modules (`thalmor.js`, `nobility.js`,
`post.js`) live to show anything; without them the tabs are simply not offered.

## Base

`client-0392` (d9eb854f): 26a4c137e (0.3.90's source) + client-1010-fixes 6047471a + lip sync guard + perf diag + remote
glows + the soul gem fix + the Maormer creator data. That line was written up as 0.3.92 on top of claude-jake's appearance
build (`client-face-diag` 7863afdd), which is **not** in this branch. This release takes the number 0.3.91 instead.

`skymp5-backend/routes/version.js` here reads `CLIENT_VERSION = '0.3.91'`. The live number is set by the usual
version-only commit on fork `main` (0.3.90 was b9c22bca1), made when the package is staged.

## What is in it

| From | What |
|---|---|
| client-1010-fixes 6047471a (c4d3f158, c1b4ff4e) | A beast form's revert is checked until it holds; a character switch leaves no orphaned body |
| client-facemorph-guard 8b3ee2b8 | Lip sync moves no mouth on a dead, unloaded or disabled body, or a race with no FaceGen head |
| client-glow-remote-actors-0391 bdaf0011, client-glow-remote-r 3dc35675 | Glows (outlines, a Racial Power's look) find the local copy of another player or a spawned NPC, and are lit again when its form is made again; `tests/glow-remote-harness.js` |
| client-perf-diag 9699c746, f5529967 | Every update handler is timed; a perf report every 30 s as an `npcDrift <name> perf` line. `perfDiag: false` in the skymp5-client settings turns it off |
| a61e672f | A souled soul gem the player holds is left alone by the server inventory apply (Barush #C9TM) |
| 26a4c137e, d9eb854f | Character creator data for MaormerRace (tints, head parts) |
| client-copy-budget d0020f0a (03440a76, dd355f0c, 14bc224c, 1b888ecc, d0020f0a) | NPC copy work runs a few a frame (3 spawns, 3 host starts, 2 deletes, 2 disables), in order; own companions, the player's own copies and the placement ghost never wait |
| client-mouse-binds 28b75a95 (86b902c6, 28b75a95) | A beast form's Shout and Sneak work from a mouse button bind; F3 Settings takes Mouse 4 and Mouse 5 |
| client-prey-flee 1cda6e98 | Only prey (Confidence Cowardly or Cautious) keeps its own confidence; Bruma's wolves no longer flee |
| client-admin-invis-noshimmer da85b8c6 | No potion shimmer on an Invisible admin; staff still see the ghost |
| front-post-1011 79786e0e | The pigeon coop sends and collects parcels of gold and goods, and has a Supply orders tab |
| thalmor-front c024ce42 | F3 Thalmor tab (reports, the Concordat, dossiers); the Dominion stipend on the Treasury line |
| client-nobility-front 127a96727, 7b520f3c8 | F3 Nobility tab (holds, fiefs, the roll of nobles, grants and revokes; Revoke for a Lead GM) |

The soul gem fix is a client-side workaround: `InventoryApi.cpp` reads `ExtraSoul` with `GetType()` (0x9C) instead of
`GetContainedSoul()`, so `soulsMatch` in `sync/inventory.ts` treats a soul outside 1..5 as unreadable. The real cure
needs a platform DLL build.

## Patch notes for players

- Other players and NPCs are outlined again when a glow should show on them, and a Racial Power's look (such as Roaring
  Tempest's shock cloak) shows to everyone nearby.
- Busy areas stutter less when many NPCs appear or leave at once: the game now places them a few at a time.
- Wolves around Bruma stand and fight again instead of running off; deer, foxes, hares and other prey still flee.
- Werewolves and Vampire Lords can use their Shout and Sneak powers from a mouse button.
- The key settings in the journal (F3) accept the back and forward mouse buttons (Mouse 4 and Mouse 5).
- Pigeon coops can send and collect parcels of gold and goods, and have a new Supply orders tab.
- New journal tabs: Nobility (holds, fiefs and titles) and, for those who serve the Dominion, Thalmor.
- Switching characters no longer leaves your old character's body standing in the world.
- A werewolf or vampire lord who is downed and revived wakes in their own shape.
- A crash when someone near you was downed or died while talking is fixed.
- A filled soul gem no longer pops its notice up over and over.
- The Maormer can be made in the character creator.
- The client now sends the server a short performance report every 30 seconds, so we can track down lag.

## In-game tests needed

1. **Login:** log in, character select shows your characters, enter the world (required for every client release).
2. **Remote outlines (2 players):** each sees the other's outline, and a spawned NPC's outline, where a glow applies. Cast
   Roaring Tempest: the watcher sees the cloak. Still lit after the other player relogs or the NPC respawns.
3. **Copy budget:** walk into a crowded area (Bruma market at a busy hour, or a dungeon lease starting): NPCs appear over a
   few frames, none missing, none doubled; your companion and the placement ghost appear and go at once. Trail lines in
   the log carry `f=`.
4. **Prey and wolves:** a Bruma wolf fights to the end; a deer or hare still runs. No host crash.
5. **Mouse binds:** bind Shout to Mouse 4 in the launcher or Controls; as a werewolf, the howl reaches the server
   (a watcher sees it). In F3 Settings, General, rebind a key to Mouse 5.
6. **Admin invisibility:** an Invisible admin shows no shimmer on their own screen; another staff member sees the ghost;
   a player sees nothing.
7. **Pigeon post:** at a coop, send a parcel of gold and an item to another character and collect it on theirs; open
   Supply orders.
8. **F3 Thalmor and Nobility:** a Thalmor rank sees the Thalmor tab and a writer can add and strike a note; the Countess
   sees the grant form and treasuries, a player sees the roll only, a Lead GM sees Revoke.
9. **Lip sync:** down a player who is talking (voice) next to a watcher. Neither client crashes.
10. **Character switch:** switch character in place. No body of the old character stays behind.
11. **Beast form:** a downed werewolf, revived, wakes in their own race on their own screen and on a watcher's.
12. **Soul gem:** a character holding a filled soul gem sees no repeating item notice for a few minutes.
13. **Perf:** `/var/log/skymp-server.log` shows `npcDrift <name> perf:` lines every ~30 s per player.

Build the client with `npm run build` (development mode) and run `check-client-bundle.js` before shipping; build the
front with its production build.
