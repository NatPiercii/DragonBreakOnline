# Staff test sheet, 30 September

For Nate's next session with two clients, after client 0.3.71 and gameplay increments 11 and 12 are live.
The safe checks come first. The two that may crash a client (the standing bite, then the Vampire Lord) come last.
Sections 7, 8 and 9 need later builds; each says what it needs at its top. Skip one until then.

## Before you start

- **Nobody else online.** Check `/api/servers` shows `online:0` apart from the two of you. Several steps move the
  world clock or switch on something that other players would see too.
- **Two clients:**
  - **A** is a Lead GM (needed for `/settime`, `/feedpair`, `/vlremote`, `/curse`).
  - **B** is a second staff client, a mortal. For section 7, B must not be Lead GM or above and must hold no zone rank:
    anyone with authority ties with shackles (Restrain), not rope.
  - **C**, a third client, only for section 7's Cut Free: any character with no Lead GM tier and no zone rank.
- **Both run Crash Logger**, so a crash leaves `Documents\My Games\Skyrim Special Edition\SKSE\crash-<date>-<time>.log`
  (under MO2, the `overwrite\SKSE` folder).
- **Note the time (UTC) at every numbered step.** The logs are matched by time.
- **Make A a vampire:** `/curse <A> vampire`. A turned vampire's powers sleep until the first meal; that is expected.

What to send back is listed at the end.

---

## 1. The Werewolf / Vampire tab (K)

1. A opens K. Pass: a **Vampire** tab beside the skills, showing:
   - thirst stage;
   - "First meal: Not yet";
   - a "Your gifts: Asleep" row;
   - the powers marked "After your first meal".
2. B opens K. Pass: no Vampire tab (B has no curse).

## 2. Feeding: the prompt, the blood and washing it off

1. A stands next to B, presses X on B and chooses **Feed**. Pass: B gets a panel with:
   - "Stranger wants to drink from you" (or A's name if introduced);
   - the Sanguinare chance;
   - a 20-second bar;
   - **Offer Your Neck** and **Resist / Flee**.
2. **Resist:** B presses **Resist / Flee**. Pass:
   - A reads "... refuses you" and gets a short banner;
   - B reads "You refuse. Be ready for a fight, or run.".
   (No answer within 20 seconds, or closing the panel, counts the same.)
3. A asks again at once. Pass: "... refused you not long ago". A refusal holds 5 minutes for that pair, and a
   vampire asks at most once a minute. **Wait 5 minutes** (section 1 fits in the wait).
4. A asks again; B presses **Offer Your Neck**. Pass:
   - A sees "Feeding..." for about 12 seconds;
   - B reads that A drinks from their neck;
   - then B loses about a quarter of their health;
   - A reads "Blood, at last" (the first meal: A's powers wake) and "You drink deep".
5. **The blood on A's face.** A is a Fledgling, so every feed leaves blood. Pass:
   - A reads "Blood smears your mouth and chin";
   - A's lips and chin are dark red in third person;
   - **B sees the same on A's character.** Take one screenshot from each client.
6. **Washing:** A swims in any water deep enough to swim in. Pass:
   - "The water runs red, then clear.";
   - the red is gone on both screens.
7. A asks B again (after a minute). Pass: B has "no blood left to give", because a person gives blood once a game day.
   Step 3.3's clock jump lets them give again for section 10.
8. K again on A. Pass: First meal "Taken, from a willing neck"; the powers are no longer "After your first meal".

## 3. Vampiric Drain after the thirst changes (which hand)

This answers Worker B's open question: the server puts the stronger drain into the hand that held the weaker one, using
EquipSpell hand 0 for left and 1 for right. That mapping comes from the CK wiki and has not been seen in game.

1. A equips **Vampiric Drain in the RIGHT hand** and **Vampire's Servant (Raise Thrall) in the LEFT hand**.
2. A notes the drain's magnitude in the magic menu, then types `/curse <A> status`. Pass: "stage 1".
3. A types `/settime <hour just below the current one>`. For example, at 14:00 type `/settime 13.9`. This moves the
   world clock almost a full day forward, for everyone, which is why nobody else may be online.
4. Wait up to 15 seconds, then `/curse <A> status`. Pass: stage 2.
5. **Pass:**
   - The right hand still holds Vampiric Drain, now the stronger one (its magnitude went up).
   - The left hand holds the stronger servant.
   - Neither hand is empty, and the drain is not in the wrong hand.
   Write down which hand each spell is in. If they are swapped, the 0/1 mapping is backwards.
6. Cast the drain at B once. Pass: it casts; no "lost drain".

## 4. The shrine panel (Hircine or Arkay)

At a shrine of Hircine or Arkay. The panel opens only at shrines that keep a rite: Molag Bal, Hircine, Arkay and Stendarr.

1. B activates the shrine. Pass: a panel with **Pray** and **Perform the Rite**.
2. B presses **Pray**. Pass: the prayer game opens, or the panel says in one quiet line why not ("another god's
   follower", "prayed here recently", "no god yet").
3. B activates it again and presses **Perform the Rite**. Pass: the rite's warning appears with its own button (Kneel, Run
   the Hunt, or Offer the soul gem) and **Cancel**.
4. B presses **Cancel**. Pass: the panel closes and no rite starts.
   **Never press Kneel or Run the Hunt on a real character.** A failed rite can end a character for good.

## 5. Magic schools (only after Nate turns schools on)

Schools are off in the config (`"schools": {"enabled": false}`). Turn them on in `gamemode-config.json` on CT 115 and
deploy the gameplay. A test class lasts 30 minutes (`schools.classes.minutes`), with 10 minutes to sign up
(`joinMinutes`). To shorten them for the test, set those two numbers (for example 5 and 2) with the same edit, and put
them back afterwards. There is no command for it.

1. A opens K, **Arcane Arts** page. Pass: four school meters (Destruction, Illusion, Conjuration, Alteration) and a way
   to choose a primary school. A chooses one.
2. **Study Magic:** A activates one of the Synod Conclave's bookcases. Pass:
   - a reading pose;
   - the school meter ticks about every 10 seconds while A stands still;
   - moving more than a step stops it.
3. **Class Lectern:**
   - A names a teacher: `/classteacher add <A>`. The teacher must be Expert in the school and in the Synod or a
     College. If A does not qualify, ask the magic worker (G) for the quickest way to qualify a test teacher.
   - A activates a Class Lectern and sets a class with a spell A knows.
   - B signs up within the sign-up time.
   - A presses **End Class**.
   Pass:
   - both panels open;
   - the crosshair shows "Class in Progress" with the time left;
   - B is paid by the scale;
   - A and B see their cooldowns (teacher 1 hour, student 12 hours).

## 6. World objects (one player, alone)

From the scripted-objects census (branch `scripted-objects-census`, `tools/scripts/REPORT_2026-09-30.md`).
Do each with one client while the other stands back and watches.

1. **Weapon rack** (any: a guild hall, a home, a fort). Take a weapon off, then put one back.
   - Pass: the weapon sits on the rack for both clients.
   - Fail: it falls to the floor or floats. The server lacks MoveToNode, so this is the expected failure; say which.
2. **Torch sconce.** Put a torch into an empty sconce, then take it back. Pass: the torch appears and disappears on both
   screens.
3. **Nirnroot.** Harvest one.
   - Pass: you get Nirn Root, and the other client sees it picked.
   - Fail: it still shows as unpicked on either screen.
4. **A fish (critterFish)** in a pond or river, if you can reach one. Catch it.
   - Pass: you get the ingredient.
   - Fail: nothing happens. The server lacks GetAngleZ, so a failure is possible.
5. **Rignar's door** in the Bruma castle great hall. Open it.
   - Pass: it leads somewhere a guest may go.
   - Fail: it opens a room that should stay private. Say which room.

## 7. Rope: tying up, leaving tied, the slip, Cut Free (needs rope live)

Needs the server build with rope (server-next-v2) and the rope gameplay. If B, carrying a Rope, presses X on A and sees
no **Tie Up**, rope is not live yet: skip this section. It takes about 15 minutes.

Setup: give B two Ropes (admin panel item list, "Rope"). A and B must not be in the same party (a party hurts itself for
only 20%). Do it somewhere quiet outside town.

1. **Asking first.** B presses X on A and chooses **Tie Up**. Pass: A is asked "B wants to tie your hands with rope.
   Allow?". A answers **No**. Pass:
   - nothing is tied; B reads "A refused.";
   - B asks again at once: "A refused you not long ago." (a refusal holds 2 minutes).
2. **A downed player is tied at once.** A takes off their armour (a naked character has 150 health). B fights A until A
   falls, then stops: a hostile player can finish someone who is down. Within 60 s, B presses X on A, **Tie Up**. Pass:
   - A stands up with hands bound, with no prompt;
   - B has one Rope fewer;
   - B reads "You tied up A."; A reads "B tied your hands with rope." and "Your hands are tied with rope. Type /struggle...";
   - **the Helgen animation at the knot:** B's hands work at A's wrists (the motion Hadvar uses to cut your binds at
     Helgen). Write down what each screen shows, or that nothing played.
3. **Led, then left.** B walks a few steps. Pass: A is walked after B. Then B presses X on A, **Leave Tied Here**, and
   walks off. Pass: A stays where they are; B's X menu on A now offers **Lead**. B comes back, **Lead**, walks: A follows
   again. Finish with **Leave Tied Here**.
4. **Time the slip** (about 6 minutes). B walks well away, more than 20 paces or out of sight, notes the UTC time and
   stays there. Pass, counted from that moment:
   - about **0:30**: A reads "Nobody is watching you. The knots are loosening...";
   - A types /struggle once. Pass: the gap in the bar is visibly wider than with cuffs, and the hint says "Nobody is
     watching and the knots are loose". A presses **Give up** (a win ends the timing early: if A wins, note it and redo
     from step 2);
   - about **4:30**: "The rope is nearly loose.";
   - about **5:30**: "The knots slip loose. Your hands are free."; B reads "A slipped out of the rope."
   Write down the three times.
5. **Cut Free.** Wait a minute (a player just freed from rope cannot be tied again for 60 s unless they are down). B ties
   A again (**Tie Up**, A accepts).
   1. C stands right next to A and presses X on A. Pass: C's menu has **Cut Free** (B's has Untie and Leave Tied Here).
   2. C chooses **Cut Free** and holds still. Pass:
      - C's hands work at A's wrists (the Helgen motion) and C sees "Cutting the rope...";
      - after 5 s, A plays the Helgen "freed" motion from the bound pose, and about 2 s later A's hands are free;
      - A reads "C cuts you free." (or "Stranger" if not introduced); B reads "Someone cut A free."
      Write down what each screen shows for both motions.
   3. After another minute B ties A again; C starts **Cut Free** and takes a step. Pass: "You stop cutting: you moved.",
      and A stays tied.
   4. B presses X on A, **Untie**. Pass: A is free; B reads "You untied A."
6. **Shackles cannot be cut.** A (Lead GM) presses X on C, **Restrain**, then B presses X on C. Pass: no **Cut Free**.
   A uncuffs C.

## 8. The chest hold (needs client 0.3.72, Worker D's chest hold and its business-chest fix)

Off by default. Only a client on 0.3.72 or later crouches; an older one opens chests at once. **Nobody else online:** the
switch changes every chest for every 0.3.72 player.

1. Turn it on: in `gamemode-config.json` on CT 115 set `"interactionIdles": { "chestHold": { "enabled": true } }`
   (keep the rest of `interactionIdles`), and deploy the gameplay as in section 5. If Worker D adds a staff command, use
   that instead.
2. A opens a plain chest (any unlocked chest outside a dungeon). Pass: A crouches over it (warming-hands crouch) and its
   menu opens about 1 s later, promptly. Write down what B sees.
3. A activates a chest and walks away during the crouch. Pass: the menu does not open.
4. A opens a locked chest (a locked dungeon chest during a claim, or any locked chest). Pass: unchanged: lockpicking
   works as before.
5. If a rented business chest exists and its renter is online: the renter opens it with less than a day's rent left,
   chooses **Open** in the rent menu, then uses the chest again. Pass: it opens (the review found it looping back to the
   menu; the fix ships with the hold).
6. Turn it off again (`"enabled": false`, deploy). Pass: the next chest opens at once, with no crouch.

## 9. Auto-run into a work round (needs client 0.3.72)

Worker B's fix. Each tap writes a line in the client's `dbo-diag-logs.txt`; send it afterwards.

1. A switches auto-run on and runs into a **skinning** round (E on an animal body while auto-running). Pass: the
   character stops and the round plays normally.
2. The same with a **mining** round (E on an ore vein while auto-running). Pass: the character stops.
3. A holds W and runs into a round. Pass: nothing extra happens: auto-run is not switched on afterwards.
4. A stands still and starts a round. Pass: nothing changes.

## 10. The standing bite (may crash a client)

Dawnguard's standing feed, the one Serana uses when she turns the player. It is a paired animation, which SkyMP does
not sync, so **every client near the feed plays it itself: A, B, and any bystander**. It is off by default.
`/feedpair on|off` switches it until the next restart, which always puts it back off.

1. Make sure B can give blood again: step 3's clock jump did that. Otherwise run `/settime` once more as in 3.3.
2. A types `/feedpair on`. Pass: "The standing feeding bite ... is ON".
3. A presses X on B and chooses Feed; B presses Offer Your Neck.
4. Pass: both clients see A bite B's neck from the front, the two bodies lined up, then let go. Neither client crashes.
   Write down what each screen showed: lined up, offset, sliding, one side only.
5. A types `/feedpair off`. Pass: "... is off".
6. If a client crashes, stop here and send that client's crash log and `dbo-diag-logs.txt` (see below). Each attempt
   writes a "feed pair ... played / skipped / refused" line in it.

## 11. LAST: the Vampire Lord, one power at a time (may crash B)

Both Vampire Lord watchers crashed on 28 and 29 Sep, each seconds after the Lord's magic, not at the transform. This
finds the step. **B watches from about 10 metres. Wait a full minute between steps, and note the UTC time of each.**

1. A types `/vlremote on`. Pass: "Other players see the Vampire Lord body".
2. A transforms: admin panel, Powers tab, Vampire Lord, **Transform now**.
3. Walk around B and melee lightly for 2 minutes.
4. Levitate and land a few times (the Sneak key) without casting.
5. **Drain Life** at B.
6. **Corpse Curse** at B.
7. **Raise Dead** on a corpse, if there is one.
8. **Conjure Gargoyle**.
9. **Vampiric Grip** on B.
10. **Bats**.
11. Revert (Powers tab, Revert).
12. A types `/vlremote off`.

**Pass:** B sees the Vampire Lord body throughout and never crashes.

**If B crashes:**
- Stop and note which step.
- The server's breaker turns the remote body off by itself; still type `/vlremote off`.
- B sends:
  - the SKSE crash log;
  - `dbo-diag-logs.txt`, whose `vl-anim` lines are the last animations B's game applied to the Lord.

## What to send back

| What | Where |
|---|---|
| A crash | `Documents\My Games\Skyrim Special Edition\SKSE\crash-<date>-<time>.log`, or MO2's `overwrite\SKSE\` |
| The client's own log (feed pair lines, `vl-anim` lines) | `<game folder>\Data\Platform\Logs\dbo-diag-logs.txt`, or MO2's `overwrite\Platform\Logs\dbo-diag-logs.txt`. It is rewritten at every launch, so copy it before starting the game again |
| Screenshots | 2.5 (blood on both screens), 3.5 (both hands), 7.2 and 7.5 (the Helgen motions, on each screen), 10.4 (the bite on both screens) |
| Times | the UTC time of each numbered step you ran, with pass or fail; for 7.4, the three times from when B walked away |

Once launcher 2.1.35 is out, **Report a Problem** carries the crash log and `dbo-diag-logs.txt` by itself.
