# Public status page: spec

**Goal.** A page at `dragonbreakonline.com/status.html` where a player can see at a glance:
- whether the server is up;
- how many are playing;
- which launcher and client versions are current;
- whether something is known to be wrong.

**Delivery.** The website is Jake's (CT 107), so the page ships as a package:
`/home/nate/claude-nate-handover/website-status-2026-09-30/` holds `status.html`, `README.md` and `SHA256SUMS`. It
needs no nginx or backend change.

## Phase 1: what the page shows, from endpoints that exist today

| Field | Endpoint (public, GET) | Rule |
|---|---|---|
| State | `/api/servers`: `lastSeen` | **Online** if the heartbeat (every 5 s) is under 30 s old. **Not responding (may be restarting)** under 5 min. **Offline** after, or if the server never reported |
| Players online | `/api/servers`: `online` / `maxPlayers` | The same figure the launcher shows |
| Peak today | `/api/metrics`: `world.sections[type=cards]`, card "Online Now", `sub` | From `server-stats.json`, written every minute; blank when stale |
| Client version | `/api/version`: `clientVersion` | |
| Launcher version, download | `/api/version`: `version`, `downloadUrl` | |
| Latest update | `/api/news`: first item's `title`, `date` | |
| Known incidents | `/api/news`: items with `tag` `Incident` or `Maintenance`, dated within 14 days | |

**Rules for the page.**
- **Never show the server address** that `/api/servers` carries.
- **Escape all text**: patch notes are data, not HTML.
- **Refresh every 30 s.** The endpoints set no cache headers, and Cloudflare passes them through. `/api/metrics`
  calls the game server on every request, so do not poll faster.
- **Same origin only.** CORS allows only the site's own origins, so the page must be served from
  dragonbreakonline.com.

**Posting an incident** needs no new tool. Add an entry to `server/patch-notes.json` and publish it with
`dev-server.sh deploy-news`, as for any patch note:

```
{ "title": "Server restarting for an update", "date": "2026-10-13", "tag": "Maintenance",
  "sections": [ { "heading": "What is happening", "items": ["The server restarts at 18:00 UTC for about 10 minutes."] } ] }
```

Use `"tag": "Incident"` for problems ("Crashes in the Maw of Sedor: we are on it"). Post a follow-up entry when it is
resolved. `/api/news` returns the newest 20, so an incident stays visible for its 14 days unless more than 20 notes
follow it.

## Phase 2: last restart and uptime (needs a backend route)

**Not public today.** The page cannot show when the server last restarted, how often it has restarted, or uptime.

**Where the data already is.**
- systemd: `systemctl show skymp -p ActiveEnterTimestamp,NRestarts`.
- The staff-only route `GET /api/site/staff/server` (`routes/site-server.js`, `sources/serverStatus.js`), which
  already computes the service state and its "since" time.
- dbo-monitor's 24 hours of 5-minute windows (`/var/lib/dbo-monitor/state.json`). It is internal: it holds player
  names and error text and must never be exposed raw.

**The smallest addition.** A public route `GET /api/site/status`, mounted before the site's auth check. `/api/site/`
is already proxied, so there is no nginx change. It returns only:

```
{ "state": "online|starting|updating|restarting|maintenance|down", "since": "<ISO>",
  "players": { "online": 0, "max": 100, "peakToday": 3 }, "client": "0.3.70", "launcher": "2.1.34",
  "restarts24h": 2, "updatedAt": "<ISO>" }
```

**How it would work.** It reuses `createServerStatus().get()` (5 s cache), applies a per-IP rate limit, and sends
`Cache-Control: public, max-age=15`. The page then adds "Up since …" and "Restarts in the last 24 h".

**Shipping it.** This is a fork `main` change, so it restarts the game server: it goes out at 0 players, followed by a
backend restart under a `backend` claim.

## Phase 3: maintenance windows and history

`dbo-statusd` (`/opt/dragonbreak-handover/ops-v1-statusd/`: built and tested, not installed) writes a public-safe
`status.json`. It has the state, the time since, the players, a maintenance window, the next scheduled restart and any
degraded parts, with its text scrubbed. Once it is installed, `/api/site/status` can serve that instead, and the page
can show "Maintenance at 18:00 UTC" before it happens. Uptime percentages over days need a sampler that does not exist
yet.
