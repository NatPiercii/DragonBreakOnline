# Interaction animations: the console check

The interaction-animation plan (claude-nate, 30 September 2026) picks vanilla idles from Skyrim.esm's IDLE records. A
record proves the event name, not that the player's behaviour graph answers it, and the dev server has no animation
archives to check. So each event below is tried once in game before anything is built on it.

The emote wheel already proves these, which are **not** in the list: IdleBook_PageTurn, IdleStudy, IdleSalute,
IdleSilentBow, IdleDialogueHandOnChinGesture, IdleWarmHandsCrouched, IdleWipeBrow, IdleExamine, IdleNoteRead,
IdleKneelingEnter, IdleDrink, IdleEatingStandingStart, IdleForceDefaultState.

## How to run it

- Use the dev copy, in a single-player save or offline. Stand in the open on flat ground, **weapon sheathed**.
- Open the console with the key above Tab. Paste one line, press Enter, and watch.
- The idle plays on your own character, so switch to third person first (F).
- After each test, run the exit line given for it. If you are still stuck in a pose, run
  `player.sae IdleForceDefaultState`, then walk forward.
- Write a result for each row: **plays** (and whether it looks right), **nothing** (no reaction), or **stuck** (and
  which exit freed you).

`sae` is the console's SendAnimEvent. It sends exactly the event name that the server and our client send.

## Standing tests

| # | Paste | For | What should happen | Then paste (exit) |
|---|---|---|---|---|
| 1 | `player.sae IdleActivateDoor` | doors | a short reach towards a door handle, then back to standing | nothing (one-shot); if stuck `player.sae IdleForceDefaultState` |
| 2 | `player.sae IdleActivatePickUp` | doors (fallback), gear (fallback) | a hand reaches forward at waist height and back | nothing (one-shot) |
| 3 | `player.sae IdleGive` | trading (giver) | hands something forward, as if handing it over | nothing (one-shot) |
| 4 | `player.sae IdleTake` | trading (receiver) | reaches out and takes something | nothing (one-shot) |
| 5 | `player.sae IdleSearchChestEnter` | chests | crouches or kneels down to a chest and starts rummaging, and keeps doing it | `player.sae IdleChairExitStart` |
| 6 | `player.sae IdleSearchingChest` | chests | the same rummaging loop, possibly without the way down | `player.sae IdleChairExitStart` |
| 7 | `player.sae IdleKneeling` | binding a downed person, body search | kneels as if checking a body (the event of IdleSearchBody and CheckCorpse) | `player.sae IdleChairExitStart` |
| 8 | `player.sae IdleLockPick` | lockpicking, binding a standing person | bent over, working at something at waist height | `player.sae IdleForceDefaultState` |
| 9 | `player.sae IdleBook_Read` | books (a longer read than the page turn) | a book appears in hand and is read | `player.sae IdleStop` (drops the book), then `player.sae IdleForceDefaultState` if still posed |
| 10 | `player.sae IdleSalute` | introductions | already proven; only **look**: is it a fist to the chest? | nothing |

## Seated tests

Sit on a chair first (activate it), then:

| # | Paste | For | What should happen | Then paste (exit) |
|---|---|---|---|---|
| 11 | `player.sae ChairEatingStart` | eating while seated | eats from the hand while sitting | `player.sae IdleStop`, then stand up with E |
| 12 | `player.sae ChairDrinkingStart` | drinking while seated | drinks while sitting | `player.sae IdleStop`, then stand up with E |
| 13 | `player.sae ChairEatingSoupStart` | soup while seated | spoon and bowl while sitting | `player.sae IdleStop`, then stand up with E |

If 11-13 do nothing while seated, try each once while **standing** and note it: some chair idles only work from the
chair's own sitting state.

## What the result decides

- **plays**: built as planned.
- **nothing**: the fallback in the plan is used (doors → 2, chests → the proven IdleWarmHandsCrouched, lockpick → 7,
  trade → 2 on both sides, seated eating → no animation while seated).
- **stuck** with no working exit: not used at all.

Send the list of results to the coordinator. The ENAM and form ids of every row are in the plan's IDLE dump:
IdleActivateDoor is the record activateDoor 0005AD38, IdleGive 000B5E20, IdleTake 000B5E1F, IdleLockPick 000BB051,
IdleActivatePickUp 0008B5D2 (all Skyrim.esm).
