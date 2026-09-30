# The after-a-crash report prompt, and hardware in reports (2.1.36)

Why: through 2.1.34, **not one of 21 crash sessions produced a crash log**, although every `crashWatch` note said one
existed on disk (measured 2026-09-30). Report a Problem is player-initiated and nobody presses it after a crash — Onny
crashed on 2.1.34 at 23:54 and the next thing they filed was an in-game `/bug` about something else. And no report has
ever carried RAM, CPU or GPU, so "propose minimum specs" had nothing behind it.

## What changed, launcher side

- **`offerCrashReport(note)`** runs off `crashWatch.watchGame(...)`. On `outcome === 'crash'` it shows one dialog —
  *"Skyrim closed unexpectedly. Send the crash report to the DragonBreak team?"* with **Send** / **Not now** — and on
  Send files a normal problem report, which already collects the crash log and `skyrim-platform.log`.
  - Asked **once per crash**: keyed `crashAsked.<note.endedAt>`, and the key is written **before** the dialog opens, so
    a second crash while the dialog is up cannot double-ask.
  - **Never at startup**: it only runs from the watcher, which only runs after a launch.
  - **"Not now" is remembered for that crash only** — the next crash asks again.
  - The key list is pruned to the newest 20 so the store cannot grow for ever.
  - A failed send says so in a second dialog and points at Report a Problem; a crash in the prompt is logged and
    swallowed, so it can never affect the game or the launcher.
- **`submitReport()`** is the old `report:send` body, extracted so the prompt and the button file the same report.
  `ipcMain.handle('report:send', (_e, args) => submitReport(args))` is now a thin forwarder.
- **Hardware in every report**: `ramGb`, `ramFreeGb`, `cpu` from `os` in `report.collect` (no extra process, so they
  cannot fail or delay a report); `gpu` and `freeSpaceGb` from one PowerShell call in `hardwareExtras()` with a 6 s
  timeout — **if it is slow, missing or refused the report still sends without those two**.
  - `AdapterRAM` is a uint32 and wraps above 4 GB, so a card with more reports its size modulo 4 GiB. The value is
    therefore shown as a floor with a `+` (`"RTX 4070 8 GB+"`) rather than pretending to be exact.

## THE BACKEND HALF IS NOT DONE, AND THE FIELDS ARE INERT WITHOUT IT

`skymp5-backend/sources/problemReport.js` is on claude-dragonbreak's protected list (`sources/*`), so this branch does
not touch it. Two consequences, both silent:

1. **`CONTEXT_FIELDS` is an allowlist.** Today it is `launcherVersion, clientVersion, filesVersion, os, gameVersion,
   installDir, step, error, mo2Enabled, freeSpaceGb`. So `freeSpaceGb` already arrives, and **`ramGb`, `ramFreeGb`,
   `cpu` and `gpu` are dropped in silence** until those four names are added.
2. **`LOG_FIELDS` has no `crashLog` entry on this line.** The launcher has collected the crash log since 2.1.34, but
   the commit that allows it through (`262c1ac9`) is **not an ancestor of `launcher-2135` or `launcher-2135-diaglog`**.
   So on the 2.1.35 line the crash log this prompt sends is discarded by the backend. `262c1ac9` has to be merged into
   the line, or the prompt ships asking players for something we throw away.

`test/hardwareReport.test.js` pins the four field names for exactly this reason: a rename here cannot quietly stop the
hardware arriving.

## Tested on CT 115

`npm test` — 117 pass, 0 fail (lint included). New file `test/hardwareReport.test.js`: 6 checks covering the field
names, whole-gigabyte units, that `cpu` carries no path to redact, and that `context` can still override so main.js
can fill `gpu` and `freeSpaceGb`.

`test/report-privacy.test.js` was updated, deliberately and visibly: it asserted the literal shape
`report:send', async (_e, { note, private: keepPrivate }`, which the extraction changed. It now checks **both** links —
that the handler forwards the message and that `submitReport` destructures the private flag off it — which is a
stronger guarantee than the single pattern it replaced. The flag's behaviour is unchanged.

## What Nate has to check on the PC (none of this can run on CT 115)

The prompt needs Windows, Electron and a real crash; `hardwareExtras` needs PowerShell.

1. **The dialog appears after a real crash.** Launch, crash the game (or kill `SkyrimSE.exe` with a non-zero code and a
   `crash-*.log` present), and confirm one dialog appears with Send / Not now.
2. **Send works**: press Send, confirm a thread appears and — this is the point — **that the crash log is attached**.
   If it is missing, the backend half above has not landed.
3. **Not now is remembered for that crash only**: press Not now, relaunch the launcher, confirm **no** prompt at
   startup. Then crash again and confirm it **does** ask.
4. **No nag**: restart the launcher several times with no new crash; there must be no dialog.
5. **Hardware arrives**: in the report's header check `ramGb`, `cpu`, `gpu` and `freeSpaceGb`. The GPU line should name
   the card; `8 GB+` on an 8 GB card is right, and a 12 GB card showing `8 GB+` is the uint32 wrap, not a bug.
6. **The PowerShell path degrades**: rename `powershell.exe` on PATH (or set an unreachable one) and confirm a report
   still sends, without `gpu`/`freeSpaceGb`, with `[report] could not read the GPU or free space` in the launcher log.
7. **A crash during the dialog** does not produce two dialogs (crash, leave the dialog open, crash again after the
   watcher rearms).
