# Economy duplicate check before the no-wipe alpha (29 September 2026)

## In short

- **No duplication in play.** Nothing in the code lets a normal player copy gold or items, and the world shows no
  sign that it happened.
  - Gold is low and even: 42 characters carry 4,628 gold in total, the most is 829 and the median is 50.
  - No player-made (tempered or enchanted) item exists in identical copies.
- **The real contamination came from staff test grants.**
  - A materials chest was stocked with about 10,000 of each ingot and left open to players in Bruma's exterior.
  - GM-given items sit in characters' packs and a player storage barrel.
  - It needs a decision before the world becomes permanent.
- **Leaks, now fixed on branches:**
  - Five gameplay leaks: parallel mining rounds, starter kit refills, harvest rests lost at restart, loot in
    staff-placed chests, and non-playable gear (econ-leaks 1dc8207d).
  - Three engine holes, reachable only with a modified client (drop-guards b6f77dd8).
- **Crash windows remain** between the gameplay files and the engine's save. Closing them properly needs a small
  transaction mechanism, proposed below.

## What the world holds (read-only audit of /opt/skymp-state and the gameplay files)

Tool: `tools/economy/econ_audit.py`.

### Where the contamination is

| Where | What | How it got there |
|---|---|---|
| A merchant chest (`CYRMerchantBrumaJerallViewInnChest`) placed by DragonBreak Online Edits (ref 12ae13) in Bruma's exterior, at 60058, 207726 | About 10,000 each of Ebony, gold, steel, iron, orichalcum, dwarven and other ingots and leather; 1,490 of one more item; 72 Iron Cutlasses. Value about 4.6 million | A GM gave their own character 10,000 of each ingot through the admin panel on 25 Sep (22:44), then stocked the chest. 18 characters have opened it. About 680 units are gone (for example, gold ingots 10,000 → 9,983 and steel 10,000 → 9,449). The engine logged "requesting reloot" after a removal, so the chest may even restock. |
| Characters holding those materials now | 143 steel (Tara Dicoft), 101 dwarven metal and orichalcum (Grimgor Azgul), a few each for Floki, Flo'Riahn, Grimgor and Nilis | Some of this may have been mined. The rest of what left the chest was crafted or stored. |
| "Elder Uriel's Barrel", a player storage barrel owned by profile 5 | 399 Enhanced Dwarven Crossbows | The GM of profile 5 gave themselves 400 through the admin panel (24 Sep 16:46) |
| Flo'Riahn, Julius Draconis, Argosh gro-Shatul | Matching enchanted Daedric armor and greatsword sets | Consistent with staff grants: Daedric is never loot. There are 42 admin-panel grant lines on one GM account alone |
| Flo'Riahn (Blade of Ysgramor), Boris (Fahlbtharz helmet), Floki (the Kvatch murder weapon), two containers (Thorneblade, the Kvatch weapon) | Artifacts | From before the artifact filter (increment 4) |
| "The Barrel of Grimgor gro-Shatul" (profile 4) | Mephala's Ebony Blade (`DA08EbonyBlade`, `DA08RealEbonyBlade`) and another Ebony Blade | It is out of loot through the Ebony filter already. Add it to artifacts.json anyway, for clarity |

Staff grants on record (admin panel, 22-29 Sep): 42 grants of 101,031 items on one GM account, and between 5 and 33
grants on each of 14 other staff and test characters.

### Decision needed before alpha (Nate and Jake)

The no-wipe world should start clean. Three options, from the most targeted:

1. **Targeted cleanup** (recommended):
   - Empty and remove the supply chest.
   - Remove the materials it handed out, where they can be identified.
   - Remove staff-granted gear from non-staff characters and player containers: the enchanted Daedric sets, the 399
     crossbows, the artifacts.
   - Staff characters keep what staff need, on staff-only characters.

   This needs a one-off script run under a claim with no players online, with a backup first (the new world
   backups). I can write it for review.
2. **Reset items and gold, keep characters:** everyone keeps their name, look, skills and home, and starts alpha
   with the starter kit. It's simpler and certain, but every tester loses what they earned.
3. **Full reset at alpha:** the only fully clean start. Testers lose their characters.

Decide too whether GM characters play in the alpha world at all. Grants to a character that also plays normally are
how the test gear spread.

## Code review: what was left

Two reviews covered the engine, the TypeScript systems and the gameplay layer. Everything already fixed tonight was
excluded.

### Fixed, on branches (nothing deployed)

| # | Leak | Who can use it | Fix | Branch |
|---|---|---|---|---|
| 1 | Two workers on one seam or chopping block were both paid (the shared rest was set only on a win) | Normal play | The node is reserved for its worker; a win on a node worked out meanwhile pays nothing | econ-leaks |
| 2 | Hanging harvestables and torches rested only in memory, so every restart handed them out again | Normal play | The rest lives on the reference too | econ-leaks |
| 3 | The starter kit replaced tools on every login and reload, so stored or traded tools came back without limit | Normal play | A missing tool comes back at most once a day | econ-leaks |
| 4 | A chest placed with the F7 Place tool gave its first opener the base container's loot, with no dungeon rules and no Ebony/Daedric filter | Staff-created | A placed container starts empty | econ-leaks |
| 5 | Non-playable gear, such as the Vampire Lord robe, could be dropped or stored while worn and was re-issued on the next change | Modified client | The item guard refuses non-playable armor and weapons | econ-leaks |
| 6 | A drop of count 0 minted one of any record; an unknown record crashed the server | Modified client, and only if itemguards.js is off or fails to load | C++ checks: at least 1, a record that exists, an item type; null check in DropItem | drop-guards |
| 7 | A weapon or armor given away while worn kept counting in combat | Modified client | For players, the weapon must be held to hit and armor must be held to count | drop-guards |
| - | A harvest bonus on an already-picked plant | Modified client | Fixed earlier: `isHarvested` binding and rollHarvest | harvest-plant-rest (next server build) |

### Found safe

- **Container puts and takes:** one player at a time, and the removal must succeed before anything is added.
- **Drop and pick-up:** removed before the world item is placed; a pick-up is marked and deleted in one step.
- **Trade:** re-checks both inventories just before the swap and rolls back on failure.
- **Crafting, alchemy, crafted extras:** inputs are taken before outputs.
- **Eating and drinking, scrolls, arrows:** each use is removed.
- **Hot reloads:** timers are replaced by name, listeners are registered once, and state is on globalThis.
- **Relogs and character switches:** sessions are keyed by actor and nonce; owed lists pay once.
- **Money inputs:** every one is clamped, and negative and NaN amounts are refused.

### Still open: crash windows between the gameplay files and the engine save

The engine saves changed forms in a batch on a worker thread, 0.1 to 0.3 s after the change. Gameplay files like
bank.json are written in the same tick. A native crash inside that window can leave a player's gold and a file's
credit both standing:

| Flow | After a crash in the window |
|---|---|
| bank payIn | Gold in the player's pack and in the treasury |
| tenancy accept | Gold kept, and /property leave refunds the deposit (up to 20,000) |
| commission post | Gold kept, and cancel refunds the reward (up to 5,000) |
| business rent (owner offline) | The owner is paid rent nobody paid |
| bank chest sweep | The treasury counts the chest twice |
| inn rent, prayer offerings, the spell shop, pigeons | The treasury share is doubled |

Players can't time a crash. There were 3 server crashes this week (all 25 Sep), and the one known way to crash the
server on demand (#6) is closed on drop-guards. Changing the order of writes cannot fix this, because the engine
always saves after the file.

**Proposed fix, for review before building:**
- A transaction id is written on the payer's character (`private.dboTxn`) in the same tick as the file.
- At load, any file credit whose id is missing from the character is voided.
- For the chest sweep, keep a running swept total on the chest itself.

That's about a day's work across bank, tenancy, commissions, business and economy, each with a harness. Worth doing
before alpha only if the server still crashes after Phase 1.

### Minor

- `/contract post` accepts fractional counts and rewards. It is officials only, and worth at most 1 gold per
  contract. Round at parse.
- An enchanted item dropped before a restart comes back plain. That's a loss, not a duplication.
- The TypeScript search and housing-sale paths were covered only by the engine review.
