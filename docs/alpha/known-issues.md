# Known issues

DragonBreak Online is in alpha. This page lists what you might run into today and what to do about it.
We update it as things are fixed.

*Last updated: 30 September 2026.*

## How to tell us about a problem

- **In game:** type `/bug` followed by what happened, for example `/bug the door to the inn won't open`.
  It saves a snapshot of where you are and what is around you, so send it while the problem is in front of you.
- **When the game closes or won't start:** open the launcher, click the gear, then **Troubleshooting** >
  **Report a Problem**. It sends the launcher's log and the game's logs, including the newest crash log from the
  last day, to staff. What you type in the box is posted in the public #bugs channel so you can follow it.
  Tick **Keep this private** if it's about an exploit or anything personal.
- **On Discord:** post in #bugs.

## The game closes

**What to do:** open the launcher and send **Report a Problem** (see above) straight away. Add a line about
what you were doing. The crash log it sends is what lets us find the cause, and it only sends one from the last
day, so don't wait.

## Is my PC enough?

**What we know:** DragonBreak Online is Skyrim Special Edition with a large mod collection and online play on top,
and it needs more memory than plain Skyrim. Games on 16 GB machines have closed in the busiest dungeons with nearly
all of the memory in use.

**What to do for now:** 16 GB of memory is the least that works. Close browsers, videos and other big programs while
you play, and leave the Windows page file on **System managed**. 32 GB is better if you go into big dungeons with a
full party. You need Skyrim Special Edition on Steam (game version 1.6.1170); the launcher checks it for you.

**Coming:** a full list of the PC you need, minimum and recommended. From launcher 2.1.36 the launcher tells us what
hardware the game runs on, so the numbers will come from real players' machines rather than guesses. Until then, our
estimate is on [What PC you need](specs.md).

<!-- Placeholder (30 Sep): fill the minimum and recommended table once launcher 2.1.36's hardware reports are in. The
memory line is from the crash notes (four crashes on 23-24 Sep at 14.3-15.2 of 16 GB in use: a correlation, not a
proven cause). specs.md holds the interim table, estimated from Bethesda's requirements. -->

## Other players don't see your Vampire Lord form

**What happens:** while you're in the Vampire Lord's form, other players see you in your own shape for now.
Your form and its powers still work for you.

**What to do:** nothing. We'll show the Vampire Lord to everyone again once it's fixed.

## Dual casting

**What happens:** casting the same spell from both hands at once doesn't give the extra strength a dual cast
has in Skyrim.

**What to do:** nothing yet. We're deciding how dual casting should work here.

## Enemies float, sink or slide in big fights

**What happens:** in busy fights an enemy can float, sink into the ground, slide without walking, or be a
little away from where it looks, and a hit can miss it.

**What to do:** type `/bug` while it's happening. The snapshot shows us exactly what you saw.

## Class Lecterns have no teachers yet

**What happens:** a class at a Class Lectern can only be held by a teacher the Synod has named, and nobody has been
named yet. Until then, no classes can be held.

**What to do:** nothing for now. If you'd like to teach, ask staff on Discord.

## The Synod's enchanting table is open to everyone

**What happens:** the enchanting table in the Synod Conclave belongs to the Synod and the Colleges, but for now
anyone can use it.

**What to do:** use it while it's open. Later it will be for members of the Synod and the Colleges only.

## Dragon bone and dragon scales

**What happens:** dragon bone and dragon scales now come only from a slain dragon, and no dragons appear in the alpha
yet, so for now there's no way to get more. Breaking dragon gear down gives its other materials, but no bone or
scales.

**What to do:** nothing. We'll tell you when dragons arrive.

<!-- Publish with the rope release: its patch note waits for the same release. Take this section out if the page goes
out before rope does. -->
## Tying someone up with rope

**What's new:** anyone carrying a Rope can tie up another player: press X on them and choose **Tie Up**. Someone who
is down is tied at once; anyone standing is asked first, and nobody who says no is tied. It's new, so expect rough
edges.

**If you're tied up:** use `/struggle`. When your captor has been more than 10 metres away for 30 seconds, the knots
loosen and struggling gets much easier, and after 5 minutes alone the rope slips off by itself. A friend standing
right next to you can press X and choose **Cut Free**.

**What to do if it goes wrong:** type `/bug` while it's happening.

## You can only travel around Bruma

**What happens:** the alpha takes place in and around Bruma. Border doors and roads out of the region are
closed. If you go past the border, you're brought back.

**What to do:** nothing. This is on purpose, and more of the world opens as the alpha grows.

## Weapon racks, plaques and display holders

**What happens:** putting a weapon or shield on a rack, plaque or holder drops it on the floor.

**What to do:** pick it back up. Displays aren't in the game yet.

## Summon Will-o-the-Wisp is switched off

**What happens:** the spell is refused when you cast it. It closed the game, so it's off for now.

**What to do:** nothing. It comes back once it's fixed.

## Repair All crashes

**What happens:** **Repair All** or **Repair Modlist** has crashed for some players.

**What to do:** make sure your launcher is up to date (2.1.34 or newer). If it still happens, ask for help on
Discord and send us your install log. Staff will show you where to find it.

## Fixed recently

- **The mouse stuck in menus, and containers closing the game** (new installs): fixed in launcher 2.1.34. Open the
  launcher, let it update itself, then press **Play**. An older install is repaired when you press Play; you don't
  need to reinstall.
- **Goblins and boars fighting each other:** the goblins of Dusk Thorn Camp are one tribe now and turn on you
  together, and a boar herd sticks together and charges you as one.
- **Cooking refused in Bruma:** every dish can now be cooked in every land. Cooked Boar Meat and other dishes from
  Solstheim and Morrowind are no longer refused.
- **Alchemist rising from picking plants:** picking plants, mushrooms and fruit now trains Harvesting only, and
  eating ingredients doesn't train Alchemist. Alchemist grows from working at an alchemy lab.
<!-- Mark fixed with the deer release. -->
- **Deer popping in and out:** deer and other animals that run from you no longer vanish and reappear in the
  distance.

## Working as intended

These come up as bug reports, but the game is doing what it should:

- **A pure-blood vampire can't become a Vampire Lord:** only the holder of the Blood Crown can take that form.
  Type `/blood` to see whether the Crown is held.
- **No `/unstuck` in jail:** you can't use it while serving a sentence.
- **Ebony and Daedric gear don't come out of dungeon chests.**
