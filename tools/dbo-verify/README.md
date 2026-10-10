# dbo-verify

Verification tooling for DragonBreak Online. Each module answers one question and exits non-zero
when the answer is bad.

```
node tools/dbo-verify/preflight.js          # is this machine fit to produce a trustworthy result?
node tools/dbo-verify/api-check.js          # can a player download and launch today?
node tools/dbo-verify/fixture-contract.js   # do the UI fixtures match what the server sends?
```

Add `--json` to any of them to also write `tools/dbo-verify/out/<module>.json`.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | everything passed |
| 1 | a real failure |
| 2 | **INVALID** - the run could not produce a trustworthy answer |

`INVALID` is deliberately separate from a failure. It means the environment was wrong, so the result
proves nothing either way. Treating an invalid run as a pass, or as a failure of the thing under
test, is the single most expensive mistake this tooling exists to prevent.

## Why each module exists

Every check below was written because the absence of it already cost real time.

**preflight** - On 2026-10-07, launcher 2.1.37 was reported broken five times in a row. It was not.
The launcher had been started from an agent shell, which passed its sandbox down to MO2; MO2 then
could not spawn `skse64_loader.exe` and reported `ERROR_ACCESS_DENIED` while blaming antivirus. An
hour went into Windows Defender. The same build launched first time when started from Windows.
`preflight` walks the launcher's parent chain and returns INVALID if any shell is an ancestor.

It also catches Vortex, which deploys mods into the *Steam* folder by hardlink and took that folder
from 2,577 to 23,582 files in the middle of a test, invalidating a baseline.

**api-check** - A dead API host shipped in 2.1.15 and took the launcher offline for every player. On
7 Oct about 40 launchers pulled a 184 MB client zip at once over a home upload and locked players
out; the fix was redirecting to Cloudflare R2. This module checks both the redirect path and the
legacy direct path, because launchers older than 2.1.44 still use the second. On its first run
against production it found that client 0.3.90 had been published with no matching R2 object, so the
backend had silently fallen back to streaming and the outage condition was live again.

**fixture-contract** - The UI composes titles from server data: `{boardName} Notice Board` and
`The Bank of ${where}`. The server sends a zone name - `Whiterun`, `Solitude`. A fixture that says
`Whiterun Notice Board` therefore renders `Whiterun Notice Board Notice Board`, which looks exactly
like a component bug. That nearly caused a "fix" to the component that would have broken the live
title. This module re-derives each contract from `origin/server` with `git grep` before testing
anything, so a stale contract reports INVALID rather than producing a confident wrong answer.

## Known constraints these modules defend against

These are observed facts about this project, not general advice:

1. **Sandbox inheritance** - a launcher started from an agent shell cannot spawn SKSE. Always start
   it from Windows; `preflight` enforces this.
2. **Foreground false hang** - Skyrim renders no frames while another window holds the foreground
   (`InputDiag: no frame for N ms`). A screenshot taken during load looks identical to a crash.
   Never infer a hang from a screenshot; read readiness from the logs.
3. **Cursor desync** - the in-game cursor does not track the OS cursor, so synthetic clicks on CEF
   controls do not land. Keyboard input also stops reaching the game once the browser takes focus.
4. **Log rotation** - the launcher recreates `install.log` every session. Identify a session by its
   first line, never by a line count (`env.logLinesSince` does this).
5. **Vortex contamination** - Vortex hardlinks mods into the Steam folder and leaves
   `vortex.deployment.json`. Attribute Steam-folder changes to Vortex before blaming the launcher.
6. **selfRepair quarantine** - stray files in the game copy are moved to
   `DragonBreak Quarantine\<timestamp>\`. Test artifacts are not where the test left them.
7. **No C++ tests** - `skymp5-server` has none. Server changes can only be verified by building and
   reading the live log, so a change that emits nothing is untestable until it logs.
8. **Client-declared vs server-authoritative** - `HitMessage` carries no aim data; appearance carries
   vanilla fields only. Do not write a test that assumes the server can see something it cannot.

## What is deliberately not covered

- **An automated in-game launch test.** It needs a human: the cursor desync makes UI interaction
  unreliable, and starting the launcher must happen outside the agent's shell.
- **RaceMenu / appearance persistence.** Extended RaceMenu data is not in the `Appearance` model and
  has no co-save, so it cannot survive a login by design. A test would only re-observe that.
- **Anti-cheat.** Nothing is deployed yet.

## Agent permission boundaries

These modules are read-only apart from writing to `out/`. Steps that need Windows settings, network
changes, Proxmox host edits, or renaming files inside the game copy are surfaced as instructions
rather than automated, because an agent running this will be blocked from them.
