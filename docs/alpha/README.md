# Alpha documents (drafts for Nate, 30 September 2026)

The one set of alpha documents (branch alpha-docs). docs-alpha-support is superseded: its PC specs and status page spec
are here; its install page and known issues gave way to install-guide.md and known-issues.md. There is no staff rota:
Nate and Jake run everything themselves (Nate, 2026-09-30), and "staff" on these pages means the two of them.

| File | For | What |
|---|---|---|
| [install-guide.md](install-guide.md) | Players | Skyrim Special Edition, Discord access, the launcher and sign-in, the game version (1.6.1170), the mods, Play, and what to do if something goes wrong |
| [known-issues.md](known-issues.md) | Players | How to report a problem, what you might run into today and what to do, whether your PC is enough, and what is working as intended |
| [specs.md](specs.md) | Players | What PC you need and why memory matters. **Estimates** until launcher 2.1.36 reports players' hardware |
| [status-page.md](status-page.md) | Staff, Jake | The public status page: what it shows, from which endpoints, and the next steps. The page itself is the CT 107 package `~/claude-nate-handover/website-status-2026-09-30/` |
| [event-night.md](event-night.md) | Staff | The alpha dress rehearsal (15-20 players): pre-flight, what to watch and when to stop, the activity, and the numbers for the go/no-go. Its tools are `tools/event-night/watch.py` (a live watch) and `tools/event-night/numbers.py` (the night's numbers) |

**Sources.** Facts were read from the launcher source (released 2.1.34 and the 2.1.35 branch), the live server
(client 0.3.70, launcher 2.1.34, the public `/api` endpoints), the Discord bug forums, `server/CHECKLIST.md` and the
crash notes. The staff pages end with a short note on their sources and what to update.

**Before publishing:**
- install-guide.md: update "Coming in launcher 2.1.35" when 2.1.35 ships, and confirm whether the alpha keeps the
  Discord whitelist role.
- known-issues.md and specs.md: replace the estimates in "Is my PC enough?" and specs.md once launcher 2.1.36 reports
  players' hardware.
- event-night.md: the date, the staff names and the NPC budget decision.
