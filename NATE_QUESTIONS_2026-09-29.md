# Questions for Nate, 29 September

Collected from the overnight review. Nothing here is broken in a way that needs a fix tonight; each is a choice only
you can make. A recommendation follows each one. Reply with the numbers you agree with, or what you'd rather have.

## Inn beds

**1. A renter who stays in bed after the rent runs out.** If someone is lying in a rented bed when their rent ends,
they stay there. The next renter pays, but can't lie down in a single bed.
Options: (a) leave it; (b) stand the old renter up when the rent ends; (c) refuse to rent a bed someone is lying in.
Recommended: (c). It's the simplest and nobody pays for a bed they can't use.

**2. Inns with several front doors get several owners.** Jerall View has three doors, and each can be claimed by a
different player. Each owner can keep a bed of their own, and all the rent goes to one of them.
Options: (a) one owner per inn, the first claim wins; (b) share the rent between the owners; (c) leave it.
Recommended: (a). An inn should have one owner.

**3. An inn owner can't rent or sleep in their own inn's other beds.** They can only choose their one private bed.
Options: (a) leave it; (b) let the owner sleep in any free bed for nothing.
Recommended: (b). It's what an innkeeper would expect.

**4. Some inn beds outside Bruma can't be rented.** Under the old whitelist rule, two Solstheim inns and three
Windhelm-mod inns were left out. It doesn't matter while players stay in Bruma.
Options: (a) apply your 28 September rule (every inn bed rentable bar the owner's) to them too; (b) decide when those
regions open.
Recommended: (a), so it's done before the region lock lifts.

## Jails

**5. Anyone can be locked into an occupied cell.** A guard can open a cell, let someone else in and relock it. Without
a lockpick they can't get out, and `/unstuck` doesn't work in a jail.
Options: (a) leave it (a guard's call); (b) let anyone who isn't serving a sentence use `/unstuck` in a jail.
Recommended: (b). Only prisoners should be stuck in cells.

**6. A downed prisoner can walk free.** A prisoner who is downed in a cell can give up and wake at the temple outside.
The sentence stays but only counts inside the jail.
Options: (a) leave it; (b) wake a prisoner in their cell instead of at the temple.
Recommended: (b). Otherwise dying is a way out of jail.

**7. "In jail" means the whole jail building.** Sentence time counts anywhere in the building, not just in the cell.
A guard can also sentence anyone within 8 m of a cell door, even in the corridor.
Options: (a) leave it; (b) count time only inside the cell and sentence only someone inside it.
Recommended: (b), if you want cells to matter; otherwise (a) is simpler.

**8. An escaped prisoner can never use `/unstuck` anywhere.** Escaping leaves the sentence standing, and `/unstuck` is
refused while one stands.
Options: (a) leave it (the cost of escaping); (b) end an unserved sentence after a day away from the jail.
Recommended: (a) for now. It's a fair cost, and nobody has been jailed yet.

**9. Prisoners keep their lockpicks, and lockpicking can be cheated.** Nothing takes lockpicks at imprisonment. The
lockpick game's timing is reported by the player's game, so a modified client could always win.
Options: (a) take lockpicks at imprisonment; (b) leave both.
Recommended: (a). The client-side timing can't be fixed cheaply and matters less once picks are taken.

**10. Removing a jail mid-sentence.** `/jail remove` on a jail with a prisoner turns its cell doors into ordinary
doors, and the sentence then counts nowhere.
Options: (a) refuse `/jail remove` while someone is serving there; (b) leave it (admin only).
Recommended: (a).

## The down state

**11. Carrying or restraining a downed player stands them up at full health.** The engine restores their health, and
the server treats it as waking at the temple, with Death's Chill.
Options: (a) keep them downed while carried (a game-server change); (b) stand them up at low health without the chill;
(c) leave it.
Recommended: (a). Carrying the fallen off the field is the point.

**12. Relogging while downed.** A player who relogs within the 60 seconds gets no down-state window back, only a chat
line. `/respawn` still works.
Options: (a) reopen the window at login; (b) leave it.
Recommended: (a), once someone can test a window opening at login in game.

**13. A server restart while downed.** The down state is lost. The player can't give up until the engine brings them
back at the temple within 60 seconds.
Options: (a) leave it (restarts wait for an empty server); (b) save the down state.
Recommended: (a).

**14. Downed players when a dungeon lease ends.** They are moved to the entrance still downed, and can be revived there.
This hasn't been tested in game.
Options: (a) leave it and test; (b) revive them at the entrance.
Recommended: (a), and test it at the next playtest.

## Loot and crafting (other workers' findings)

**15. Top-tier gear gets past the Ebony and Daedric ban (M8).** Dungeon loot is filtered by name, so Dragonbone gear (a
tier above Daedric), Stalhrim, and artifacts like Auriel's Bow and Shield are still in the loot tables.
Options: (a) ban them too, by tier or by a list; (b) allow them as rare finds.
Recommended: (a), matching your rule that the best gear isn't looted.

**16. Crafting rank caps are off.** Tempering and enchanting now need the Blacksmith and Enchanter skills, but the
per-rank caps on how good a result can be are switched off (`craftedExtrasRankGates`). They wait for you to compare
them with the game's own results.
Options: (a) switch them on; (b) leave them off.
Recommended: test a Novice enchant in game first, then (a).
