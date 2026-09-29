# A blank main menu: what holds up, what does not, and how to find out in five minutes

> **TESTED AND PASSED, 2026-09-29.** Nate ran the whole plan on his PC with the 30-byte swf in
> `Data\Interface\`: the game launches to our title screen on black with no Bethesda menu behind it (step 2),
> he logged in and reached the world (step 3), quitting to the main menu from the Journal brought character
> select back (step 4), and pulling the network for 60 s landed the watchdog on our screen rather than a black
> void (step 5). So section 3's open question is answered: **the engine is content with a main menu that
> registers no GameDelegate callbacks and draws nothing**, outcome 3 did not happen, and the JPEXS fallback is
> not needed. The file ships from `client-deps/ae/Data/Interface/startmenu.swf`.
>
> The rest of this document is kept as written, because the reasoning is what a later reader will want if the
> menu ever misbehaves.

Investigation and prototype, 2026-09-28, `claude-nate` (Worker B), for Nate's route (a): swap in a blank version of
Skyrim's main menu so ours is the only one. Nothing ships before Nate tests.

Read section 3 before building anything into a release. The client side holds up completely; the engine side has one
question I could not answer from CT 115, and it is the question that decides whether this works at all.

## 1. What our client needs from the Main Menu, and whether a blank swf keeps it

Every dependency is on the engine's menu **state** - its name, its open/close events, `Ui.isMenuOpen`. Nothing reads
the movie, its buttons or its art. A replacement swf leaves the state exactly as it is: the Main Menu still opens,
still carries the name `Main Menu`, still fires its events. All nine survive.

| Where | What it uses | With a blank swf |
|---|---|---|
| `menuMediaService.ts:33,38` | `menuOpen` for `Menu.Main`, then `Ui.isMenuOpen(Menu.Main)` as a stale-event guard, to show the title video after a quit | unchanged |
| `browserService.ts:198` | `Menu.Main` is in `badMenus`: the browser is hidden and unfocused while it is open | unchanged - **and see section 4** |
| `connectionWatchdogService.ts:63,67` | `Ui.isMenuOpen(Menu.Main)` so it does not quit when already there; `Game.quitToMainMenu()` after 60 s unreachable | unchanged |
| `characterProgressService.ts:77,169` | flushes progress when the main menu opens; refuses a restore while it is open | unchanged |
| `timersService.ts:150` | switches from `update` to `tick` processing when the main menu opens | unchanged |
| `charCreatorService.ts:47,50` | the same stale-event guard | unchanged |
| `remoteServer.ts:883`, `spVersionCheckService.ts:22`, `version.ts:18` | `Game.quitToMainMenu()` | unchanged |
| `characterSelectService.ts:211,249` | **no main-menu events at all**: it infers the menu from `update` going silent while `tick` keeps running | unchanged |

Two of these are worth spelling out because they are not what one would assume:

- **Character select never listens for the main menu.** Its own comment is *"Main Menu events only arrive on `update`,
  which the main menu never runs"*, so it watches for `update` stopping shortly after the Journal was open. The swf
  has nothing to do with that.
- **The way into the world does not pass through the menu at all.** `remoteServer.ts:801` calls
  `LoadGameService.loadGame(...)` with the position, cell and appearance the server sent, and `sp.loadGame` is what
  puts the player in the world. Continue / New / Load are not on our path, so removing them costs nothing.

**Reconnect after a disconnect** is the one flow that leans on the menu hardest, and it also survives: the watchdog
sees 60 s unreachable, checks `Ui.isMenuOpen(Menu.Main)`, calls `Game.quitToMainMenu()`; the engine returns to the
Main Menu state; `update` goes silent while `tick` continues; character select notices and asks for the menu again.
Every step is state, not picture. It is still the flow most worth testing by hand (section 5, step 3).

## 2. Does anything else in our load order ship a startmenu.swf?

**No - nothing does today.**

- The only `Interface` file we ship is `client-deps/ae/Data/Interface/CombatAlertOverlayMenu.swf`, which arrives at
  `Data/Interface/` in the client package (it is in the built bundle at `build/client-files/root/Data/Interface/`).
  That is also the proof that this is a working delivery path for a loose Interface file.
- Nothing named `startmenu` exists anywhere under `/opt` on CT 115.
- The collection (`server/COLLECTION_NOTES.md`) has no main-menu replacer in it - no Nordic UI, Untarnished UI, Main
  Menu Design Replacer or similar. The one big UI mod is **SkyUI**, which replaces `bartermenu`, `containermenu`,
  `craftingmenu`, `giftmenu`, `inventorymenu`, `magicmenu` and `map`, and keeps its own files under
  `Interface/skyui/`. It does not touch `startmenu.swf`.

So we would not be overriding anything. The standing risk is the other direction: a player who installs any main-menu
replacer later would override ours by load order and see a vanilla-shaped menu under our screen again. Worth a line in
the collection page rather than any code.

## 3. The engine side: the question I could not answer here

This is the part that decides whether a blank file works, and I could not settle it from CT 115. What is established:

Skyrim's menus talk to the engine through Scaleform's `gfx.io.GameDelegate`, which uses
`flash.external.ExternalInterface.addCallback` for both directions. A menu registers its handlers with
`gfx.io.GameDelegate.addCallBack(name, ...)`, and the engine calls into the movie by those names. Skyrim's UI is
SWF 10 with ActionScript 2.

**A movie with no ActionScript registers nothing.** So if the engine calls into `startmenu.swf` during the menu's
start-up - and Bethesda's menus generally do hand back a "ready" of some kind - a blank movie has nothing to answer
with. Three outcomes are possible and I cannot distinguish them without running the game:

1. The engine does not care: the menu opens, draws nothing, and we are done. **This is what we are hoping for and it
   costs five minutes to find out.**
2. The engine's calls fail quietly: the menu opens blank but something later misbehaves.
3. The engine waits for a call back that never comes: **the menu hangs on a black screen before our title screen
   appears.** This is the failure the peer asked about, and it is a real possibility, not a theoretical one.

I did not find a documented "minimum callback set" for `startmenu.swf`, and I do not want to invent one. Two honest
ways forward, in order:

- **Try the blank one first** (section 5). It is one file, five minutes, and it answers the question outright. If it
  hangs, delete the file - the vanilla menu is back with no trace.
- **If it hangs, blank the vanilla movie instead of replacing it.** Extract `Interface/startmenu.swf` from
  `Skyrim - Interface.bsa` on Nate's PC, open it in JPEXS Free Flash Decompiler, and remove or hide the visible
  content while leaving every `GameDelegate` registration in place. That is what the Nexus main-menu replacers are:
  the same ActionScript, different art. It keeps the handshake by construction, so outcome 3 cannot happen.
  JPEXS is Java and runs on Linux, so it could be done on CT 115 - but the vanilla swf is not on this box (only
  `Skyrim - Misc.bsa` is here, not `Skyrim - Interface.bsa`), so the file has to come from the PC either way.

I would not put the blank file in a client package until step 1 of section 5 has been done on Nate's PC.

## 4. Separately: the dead mouse is probably ours, and this change will not fix it

Worth knowing before anyone expects the menu swap to help with GroundedPasta's report.

`browserService` keeps a list of `badMenus` - menus during which our CEF page must not hold focus, because "a hidden
browser that keeps focus swallows every key with no cursor to show it". **`Menu.Main` is in that list**
(`browserService.ts:198`), and its handler calls `unfocus()` and `setVisible(false)`.

Character select opens through `openFormMenu`, which forces `setVisible(true)` and `setFocused(true)`. So the order of
two events decides what the player gets:

- `menuOpen("Main Menu")` **before** character select opens: fine.
- `menuOpen("Main Menu")` **after** it: character select is hidden and unfocused while it is the only thing the player
  is meant to be using. The free-cursor key cannot rescue it either, because `canFocus` is
  `!this.uiHidden && this.badMenusOpen.size === 0` (`:57`), and `Main` only leaves `badMenusOpen` on its `menuClose`,
  which is when the game actually loads.

Late `menuOpen` delivery is not hypothetical here: `menuMediaService` carries a guard for it, commented *"menuOpen
events can arrive late (queued into SP update tasks)"*, and `charCreatorService` carries the same guard. Neither
`browserService` nor character select has one. A race also explains why it hits some players and not others, and why a
heavier boot makes it likelier.

**A blank swf does not change any of this** - the Main Menu state still opens and still fires `menuOpen`. If this is
the cause, the fix is a few lines in `browserService`: do not hide the browser for `Menu.Main` while character select
is open, or drop `Main` from `badMenusOpen` when character select takes the screen. I have not written it; it belongs
with Worker A's native mouse work, and it should be confirmed first (section 5, step 0).

## 5. Testing on Nate's PC

**Step 0 - do this first, whatever happens to the swf.** On today's client, reach character select and check whether
the mouse is alive. If it is dead, look in `skyrim-platform.log` for the `menuOpen` lines around character select
opening. If `Main Menu` arrives *after* character select opened, section 4 is confirmed and the real mouse fix is a
few lines in `browserService`.

Then, for the blank menu:

1. **By hand, not through the package.** Drop `tooling/mainmenu/startmenu.swf` into the dev install's
   `Data/Interface/` and start the game. Check first that no mod in the load order already provides one.
   - **Good:** our title screen on a black background, no logo, no buttons, no version text, menu music and video
     playing from the CEF front.
   - **Stop, this is outcome 3:** a black screen that never reaches our title screen, or a hang or crash on launch.
     Delete the file and report it - we move to the JPEXS route in section 3.
2. **Log in and get into the world.** This proves `loadGame` still ends the menu phase with a movie that does nothing.
3. **Quit to the main menu from the Journal and confirm character select comes back.** This is the most valuable
   single test: it exercises character select's update-silence detection, `menuMediaService`'s re-show and the
   `badMenus` handling in one go, and it is the flow most likely to expose outcome 2.
4. **Pull the network for 60 s in game** and confirm the watchdog's `quitToMainMenu()` lands on our screen rather than
   a black void. That is the reconnect path.
5. **Only then** put the file in the client package and give it to one playtester before any release.

Rollback at every step is deleting one file.

## 6. What is on this branch

Nothing wired into a build; the swf is not in `client-deps` yet, deliberately, so it cannot ship by accident.

- `tooling/mainmenu/startmenu.swf` - 30 bytes. Header, `SetBackgroundColor` black, `ShowFrame`, `End`. No
  `PlaceObject` of any kind and no `DoABC`, so nothing is drawn and no code runs. That is also precisely why
  section 3 is uncertain.
- `tooling/mainmenu/make-startmenu-swf.py` - builds it. **No Flash tooling is needed and none is installed on
  CT 115**: an empty SWF is a header and three tags, written against the SWF specification.
- `tooling/mainmenu/check-startmenu-swf.py` - verifies what can be checked without the game: the header length matches
  the file, the tag stream parses to exactly the last byte, nothing is placed on the stage, no ActionScript is
  present. It passes.

**How it would ship, once it is proven:** copy it to `client-deps/ae/Data/Interface/startmenu.swf`, beside the
`CombatAlertOverlayMenu.swf` we already ship. It then rides the client zip to `Data/Interface/` like any other client
file - no launcher change, no plugin, no new download path, and a player who wants Bethesda's menu back deletes one
file.

## Sources

- [Modding the GUI - gamesas](https://www.gamesas.com/modding-the-gui-t187236.html) - `gfx.io.GameDelegate`,
  `ExternalInterface.addCallback`, how the engine calls into a menu movie
- [Main Menu Design Replacer](https://www.nexusmods.com/skyrimspecialedition/mods/30810) and
  [Start Menu Redesigned](https://www.nexusmods.com/skyrimspecialedition/mods/192119) - replacers are one loose
  `Interface/startmenu.swf`, built with JPEXS, conflicting only with each other
- [SkyUI troubleshooting](https://steamcommunity.com/sharedfiles/filedetails/?id=429076438) - the menus SkyUI does
  replace; `startmenu.swf` is not among them
