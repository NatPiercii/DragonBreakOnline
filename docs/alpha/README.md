# Alpha support documents (drafts for Nate, 30 September 2026)

| File | For | What |
|---|---|---|
| [install.md](install.md) | Players | Skyrim 1.6.1170, the launcher, Discord and Nexus login, the downgrade, Repair, first-run problems |
| [known-issues.md](known-issues.md) | Players | What is open, what is fixed and coming, what was fixed recently, what is by design |
| [specs.md](specs.md) | Players | Minimum and recommended PC, and why memory matters |
| [status-page.md](status-page.md) | Staff, Jake | The public status page: what it shows, from which endpoints, and the next steps. The page itself is the CT 107 package `~/claude-nate-handover/website-status-2026-09-30/` |
| [staff-rota-and-tickets.md](staff-rota-and-tickets.md) | Staff | Roles, hours to cover, where tickets land, the ticket flow, escalation (a template with blanks) |

**Sources.** Every fact was read from the launcher source (released 2.1.34 and the 2.1.35 branch), the live server
(client 0.3.70, launcher 2.1.34, the public `/api` endpoints), the Discord bug forums, `server/CHECKLIST.md` and the
crash notes. Each page ends with a short note for staff on its sources and what to update.

**Before publishing:**
- Update install.md's downgrade section when launcher 2.1.35 ships.
- Move known-issues.md's "coming in the next update" items once they are live.
- Confirm whether the alpha keeps the Discord whitelist role (install.md).
