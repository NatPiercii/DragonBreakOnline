# The hub spawn bug: SOLVED, and what is still open

Written 2026-09-20 ~00:15, resolved ~01:00. Two players connected from separate machines for the
first time the same night.

---

## SOLVED: the spawn landed everyone in Riverwood

**Cause: one flag byte on one plugin.** `AlternateHighPolyHead_SE.esp` existed in two copies -
identical size (16463), version (1.7), record count (41) and masters - but **ESL-flagged in the copy
the client loads and not in `server\data\`**.

An ESL-flagged plugin lives in the `0xFE` space and consumes **no** regular index. So the client
counted 61 regular plugins where the server counted 62, and **every index after that plugin was off
by one on the client only**:

| | server | client |
|---|---|---|
| `DragonBreak Hub.esp` | `0x25` | **`0x24`** |

`startPoints` said `0x25017482`. On the client that is a form in `Hothtrooper44_ArmorCompilation.esp`
that does not exist, so `Game.getFormEx` returned null, both `Cell.from()` and `WorldSpace.from()`
returned null, and `TESModPlatform.moveRefrToPosition` **did nothing at all**. The player therefore
stayed at the player reference's default editor location, which in `Skyrim.esm` is the **Sleeping
Giant Inn in Riverwood** - exactly the symptom, on every machine, every time.

### The fix that shipped

1. `server\data\AlternateHighPolyHead_SE.esp` and the dev `Data\` copy replaced with the ESL-flagged
   one (old copy kept as `.bak-noesl`).
2. `startPoints.worldOrCell` `0x25017482` -> **`0x24017482`**.
3. Restart (server-settings is boot only).

`Regular: 61` now matches the crash log exactly and the hub computes to `0x24` on both sides.

### Blast radius, checked before changing anything

- **All generated data uses desc-style ids** (`"17482:Plugin.esp"`) - 96k in `dungeons.json` alone,
  and **zero** numeric hex ids in `dungeons/loot/wildlife/NPC-Spawns/doors.json`. Descs resolve at
  runtime, so an index shift cannot touch them.
- The **only** hard-coded numeric id at a shifted index in the whole config was `startPoints` itself.
  Every `blockedSpells` entry sits at index <= `0x18`, well before the shift.
- A full scan compared 86 plugins present in both `server\data\` and the MO2 mods:
  **exactly one ESL/ESM flag mismatch**, the one above.

### How it was finally found, and the lesson

Eleven static hypotheses were eliminated first - the `startPoints` value, the plugin's presence and
sha256, the index computed three separate ways, ESL handling, ESM hoisting, the worldspace, the cell
at those coordinates, a stale character, and a real timing race that was fixed on the way and did not
cure it. All of them said "correct".

**The answer came from a Skyrim crash log**, which prints the game's actual runtime load order with
indices. `[24] DragonBreak Hub.esp` settled in one line what hours of computing from files on disk
could not.

> **Lesson: the crash log's `PLUGINS:` block is ground truth for plugin indices.** Ask for one before
> computing indices from files. What is on disk in `server\data\` is not necessarily what the client
> loads, and a single flag byte is enough to desynchronise every form id after it.

### A second, real bug fixed on the way

`HUB_SPAWN_WAIT_MS` was **12000**, but the client's spawn loop retries `SPAWN_MAX_ATTEMPTS` (30)
times at ~1 s, so it needs about thirty seconds. The server gave up first and its fallback teleport
aborted the client mid-spawn (`Spawn loop stopped by a server teleport`). Raised to **35000**
(commit `4f458f05`). Genuine bug, now proven by the trace, but not the cause of the symptom.

### Leaving the Realm

The nine `RP_LorkhanGate*` doors carry **no XTEL** - they teleport nobody on their own.
`gamemode.js:582` handles them in code (`GATES`, keyed by base local ids `a000`-`a008`, which match),
and `playtest.js` intercepts so a gate sends the player to the Bruma arrival. **Confirmed working**:
*"You step through the gate to Bruma."*

A character who finishes creation and does not walk through a gate would otherwise stay in the Realm
for good, since the region lock explicitly allows the hub. `sendToArrival` in `gamemode.js` now moves
a finished character to the arrival 9 s after the starter kit.

---

## STILL OPEN - for the next session

### 1. RaceMenu shows the vanilla menu, not its sliders

**Symptom:** the race menu offers only Sex / Presets / Skin Tone / Weight with Race/Body/Head/Face
tabs - the stock `RaceSexMenu`. RaceMenu's own panel (ALL/RACE/BODY/HEAD filter, Sliders / Presets /
Camera / Sculpt) does not appear. The full UI **was** seen earlier the same evening, so it can work.

**Already established - do not re-check:**

- `skee64.dll` loads correctly (`skse64.log`: *"plugin skee64.dll (skee) loaded correctly"*, and the
  RaceMenu translations are read).
- `RaceMenu.esp` `[0D]` and `RaceMenuPlugin.esp` `[0E]` are both active in the crash log.
- `RaceMenu.bsa` is correctly installed at
  `C:\DragonBreak\mods\RaceMenu Anniversary Edition v0-4-20-0-.../RaceMenu.bsa`.
- `racesex_menu.swf` - the file that draws the sliders - exists **only inside that BSA**. There is no
  loose copy anywhere in the mods folder or the game Data, so nothing is overriding it.
- The SkyMP client package ships only `Data/Interface/CombatAlertOverlayMenu.swf`, so it does not
  clash.

**Leading theory:** the BSA is not being loaded. The MO2 profile's `archives.txt` is **empty**
(`C:\DragonBreak\profiles\DragonBreak\archives.txt`, 0 bytes), which is where MO2 records the mod
archives it has enabled. **Check the MO2 Archives tab first and make sure `RaceMenu.bsa` is ticked.**
This is a mod-manager setting, not a server one - nothing to restart.

**If the archive is already enabled**, the next suspect is timing: the server calls
`mp.setRaceMenuOpen` early in the spawn sequence, and if RaceMenu has not yet swapped in its UI the
engine opens the stock menu. Test with `showracemenu` in the console - full RaceMenu UI there means
the mod is fine and the fix is to delay `setRaceMenuOpen` server side.

### 2. An Orc still has Nord frost resistance

`RaceSpellsService` **is** in the deployed client bundle (9 references) and the checklist records it
confirmed working on 2026-09-20 at 20:10. Two reasons it may not be firing now, both plausible:

- The service derives the strip set from the player's race at runtime, and creation has only just
  started working properly - if it runs while the engine still has the player as the base Player
  record (which is a **Nord**), it finds nothing to strip.
- Papyrus `RemoveSpell` **cannot** remove a spell inherited from the actor's base record, and every
  character is built from `Skyrim.esm:000007`, the vanilla Player, whose race is `NordRace`. The
  service deliberately gives up after one failed attempt (retrying caused a 4-second dispel loop).

**Retest on a character created now that the spawn works**, before treating it as a new bug. The
deeper fix is already scoped and **not promoted**: `DBO_PlayerRecord.pas` overrides that Player
record in DLE to strip its spells and its 16-item starting kit; the first run removed 16 of 16 items
but 0 spells because the `Spells` element path does not exist on `NPC_`.

### 3. Housekeeping

- **`spawnTrace` is still live in `gamemode.js`** - a diagnostic that logs the player's world and
  position every second for 45 s after a character is ready. Remove it, or set `"spawnTrace": false`
  in `gamemode-config.json`.
- **Admin in offline mode, and why adding your id can take it away.** Two lists, two behaviours:
  - `gamemode-config.json` -> `admins` - gamemode commands and `/whoami`, **hot-reloads**
  - `server-settings.json` -> `adminProfileIds` - the **admin panel** (`AdminSystem`/`adminRoles.ts`),
    **boot only**

  **`login.ts:275` refuses an admin profile id from any non-loopback IP in offline mode** and
  substitutes `1000 + userId`. Offline mode has no authentication - a client simply states its id - so
  without this anyone could type an admin's number. It is correct and must not be weakened.

  The consequence is surprising: putting your *own* id in `adminProfileIds` and connecting over the
  LAN **takes it away** - you log in as `1001` instead, with no admin at all. That is exactly what
  happened on 2026-09-21: Nat added `763749340`, restarted, and came back as `1001`.

  **For offline testing:** keep your id in `admins` only (gamemode admin works), leave
  `adminProfileIds` as `[1]`, and accept that the Insert admin panel is unavailable to remote players.
  Play on the server PC itself (loopback is exempt) if the panel is needed.

  **Known hole, test-only:** the gamemode's `admins` list has no equivalent guard, so anyone who learns
  an admin's id gets gamemode admin. Acceptable for a private test, not for anything public.

  **Production (Jake's server) will use Discord verification and role-based admin**, which is the
  proper fix for both: identity is proven, so the loopback guard no longer bites and the `admins` hole
  closes. `adminRoles.ts` already supports it - *"adminProfileIds are always senior, then adminRoles
  tiers, then legacy adminRoleIds"*. Configure `adminRoles` there, not profile ids.

  The admin menu key is the launcher's `adminMenuKeyCode`, currently **210 (Insert)**; the client
  default is F7.
- **"Argy" at profile `1001` was Nat's own second character, not the friend** - the loopback guard
  above, not a second machine. The Debug panel shows the account id (`763749340`) and `/whoami` the
  character's (`1001`), which is how to tell them apart.
- **`world-old\`** on the server PC is the pre-wipe world. Delete when nobody wants it.
