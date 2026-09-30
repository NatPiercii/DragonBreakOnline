# Known issues

DragonBreak Online is in alpha: things break, and we fix them fast. This page lists what we know about. If you hit
something that is not here, tell us: **/bug** in game (it saves a snapshot of the scene for us), or the **#bugs**
forum on Discord.

_Last updated: 30 September 2026. Game client 0.3.70, launcher 2.1.34._

## Being worked on

| Problem | What we know | What you can do |
|---|---|---|
| **The game crashes near a player in Vampire Lord form** | Seen twice, both times for players watching a Vampire Lord (not the Lord themselves). The next update hides a Vampire Lord's body from other players by default until we find the cause | Keep your distance from a Vampire Lord until then. It is sensible, but we have not proven it helps |
| **Crashes in big dungeons** (the Maw of Sedor, Freezewind Hollow) | Crashes in the physics of falling bodies, on machines with 16 GB of memory almost full | Close other programs, leave the Windows page file on *System managed*. See [What PC you need](specs.md) |
| **Vampiric drain goes missing for a moment after you equip it** | Reported once; being looked at | Equip it again |
| **Enemies or animals float, sink into the ground, or pop back up** | A sync problem between players; we are measuring it | None yet. Report the place with /bug when you see it |
| **Enemies slide without walking** | Also a sync problem between players | None yet |
| **A hit sometimes does nothing** ("too far away") | Mostly fixed on 25 September; still happens now and then | Step closer and strike again |
| **Deer and other animals appear and vanish at the edge of view** | Animals come and go as players move around; being tuned | None needed; they come back |
| **Floating above the ground after a teleport** | Open | Log out and back in |
| **The launcher crashes on "Repair All"** | Reported once; not reproduced yet | Use the single Repair buttons one at a time, and send us your launcher log (Settings > Troubleshooting > Report a Problem) |
| **Hearing someone twice in voice chat** | Half fixed; the rest comes with an update | Use a headset rather than speakers |
| **Racial resistances** (Nord frost, Breton magic, Orc and so on) **do nothing yet** | The fix is built and comes with a server update | None |
| **Summon Will-o'-the-Wisp is switched off** | Its model crashed the caster every time | Use another summon; the spell tells you why it is off |
| **Weapon racks, plaques and display holders drop the item on the floor** | Not built for online play yet | Keep your display pieces in a chest for now |
| **Some furniture, levers and pressure plates do nothing** | The server cannot run some of Skyrim's scripts yet | None |
| **You can't open the player menu (X) on two players who are trading** | Being checked | Wait until the trade ends |
| **Force Rune's symbol shows solid green** | Looks only; the rune works | None needed |

## Fixed, coming in the next update

- **Waking up without your clothes after dying:** your outfit is put back on.
- **Every wild animal gives meat** when skinned or looted.
- **Dungeons have their full loot again:**
  - bandits can drop the weapon or armor they fought with;
  - chests hold fewer torches;
  - chests and barrels only glow while something is inside.
- **Alchemy labs** show a list of the potions your ingredients can make.
- **Salt deposits** give twice as much salt.
- **Hunting contracts are back**, on a Contracts tab of the expedition board.
- **Pure-blood vampires are told who holds the Blood Crown.** Only its holder can become a Vampire Lord.

## Fixed recently

- **The mouse was stuck in the middle of the screen in menus, and opening a chest or barrel crashed the game** (new
  installs from 27 September). Fixed in launcher **2.1.34**: open the launcher, let it update, press PLAY once.
- **Dead mouse at character select on a new install** (a hidden Community Shaders window). Fixed in client 0.3.59.
- **Our windows took the keyboard away from game menus** (you had to alt-tab). Fixed in client 0.3.68.
- **Shouts dealt no damage.** Fixed 29 September. Other players have seen your shouts since client 0.3.63.
- **High Elf Highborn regeneration snapped back.** Fixed 29 September.
- **Deer, rabbits, chickens and mudcrabs gave no meat.** Fixed 29 September.
- **Dropdown lists in our windows did not open.** Fixed in client 0.3.69.
- **Vampire eyes were drawn over normal eyes.** Fixed 29 September.
- **Healing Hands healed the caster, and the magicka bar filled and dropped back.** Fixed.
- **Summon scrolls did nothing, and summons did not follow you.** Fixed (0.3.57 and 0.3.43).
- **Wrong field of view at login.** Fixed in launcher 2.1.32.
- **The HUD stayed on the main menu after a disconnect.** Fixed in client 0.3.67.

## How the game works (not a bug)

- **Deer run away from you.** That is how Skyrim's deer behave.
- **Only the holder of the Blood Crown can become a Vampire Lord.** Other pure-bloods cannot.
- **Slow Time is not a player shout.** It only ever slowed the shouter's own screen.
- **Some puzzles and lever gates are gone** from dungeons. The server cannot run them, so the way is open instead.
- **Other house rules:**
  - Play is limited to Bruma and its surroundings for now.
  - No `/unstuck` in jail.
  - You cannot sleep within 5 minutes of a fight.
  - After a stagger or a shove you are safe from another for 3 seconds.
  - Artifacts and Ebony or Daedric gear never come from dungeon loot.
- **After a fresh install the game ignores you for a while.** Skyrim is downloading its free Creation Club items from
  the main menu. Let it finish.

_For staff: sources for every line (Discord thread ids, CHECKLIST lines, commits, live checks) are in the research
notes of 30 Sep 02:00 UTC. What is live was checked on the box: client 0.3.70, launcher 2.1.34, server built 29 Sep
17:15, gameplay deployed 29 Sep 20:45. "Coming in the next update" means built on overnight increments 8 and 9 (or the
30 Sep branches) and not live yet: move each item to "Fixed recently" when it ships._
