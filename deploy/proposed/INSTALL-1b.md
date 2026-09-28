# Server panel 1b (Owner Start, Stop, Restart): ship steps

Branch `feature/server-controls-1b` (claude-jake), on origin/main 14415e42:

- cd46050e: the backend (`sources/serverControl.js`, the action and job routes in `routes/site-server.js`, tests)
- 41c9f904: `website/dashboard.html` (buttons, the confirm dialog, the result line, tests)
- the commit that adds this folder: this file and `skymp-update-stopped-marker.patch`

Designs: ST-D12; control-panel-design.md 3.1-3.9 and 3.11 (safety rules); staging DESIGN.md 4.1-4.7 (routes under
`/api/site/staff/server`). Tests: `node --test test/*.test.js` in `skymp5-backend`: 161 tests, 157 pass, 4 skipped, 0 fail.

Nothing here is live. Every step below waits for Jake's go.

## What Jake gets

- Owners see Start, Stop and Restart in the Server panel. Dragon Break Dev sees "Only Owners can control the server."
- Stop and Restart work only with 0 players online. With players online the buttons are disabled with
  "Players are online: restarts with a countdown arrive with the next update." Start works only when the server is down.
- Each press opens a dialog on the page: live player count, a reason (5 to 200 characters) and the typed word
  START, STOP or RESTART. The dialog reports the result (done, failed, not confirmed within 2 minutes, or the dry run).
- Stop keeps the server stopped (`/opt/skymp-stopped`) until an Owner presses Start. A host reboot still starts it.
- Every action holds the `game-server` claim as operator `site-owner` from before the change until systemd shows the
  result, writes an `ops log` line with its rollback, and posts an audit line (`WEB ...`) to #server-logs.

## Order

1. Updater patch (claude-jake, `updater` claim).
2. Main push (claude-nate).
3. Backend release and restart (claude-jake, `backend` claim).
4. Switch file set to `dry-run` (claude-jake).
5. `dashboard.html` on the website (claude-dragonbreak).
6. Dry-run check by Jake, then the switch goes to `on` and one live check at 0 players.

Steps 3 and 5 can happen in either order. The new page on the old backend shows "Controls arrive with the next update.";
the old page on the new backend shows the same line as today. Until step 4, the buttons show "The controls are switched
off on the server."

## 1. Updater patch (claude-jake, root, on Jake's go)

Why: the live updater (v1) builds and runs `systemctl restart skymp` when main moves, so a push while the server is
stopped would start it again. The patch adds one line after the deploy-hold check (line 18):
`if [ -e /opt/skymp-stopped ]; then say "skipped: server stopped by owner"; exit 0; fi`.
While `/opt/skymp-dev-hold` exists (it does today) the hold check comes first, so the new line only matters once the hold
is lifted. The v2 draft (`ops-v1` branch) already skips on the marker; this patch is for v1 only.

```
ops claim updater claude-jake "1b: skymp-update.sh skips while /opt/skymp-stopped exists" 30
systemctl is-active skymp-update.service          # must print inactive; otherwise wait for this run to end
sha256sum /usr/local/bin/skymp-update.sh          # must be bdc0fd6e71777eb9b37b136bcf841aaeec537f02265d07e74d544089f2bce5e7
B=/usr/local/bin/skymp-update.sh.bak-$(date +%Y%m%d-%H%M%S); cp -a /usr/local/bin/skymp-update.sh "$B"
patch --dry-run /usr/local/bin/skymp-update.sh < deploy/proposed/skymp-update-stopped-marker.patch
patch /usr/local/bin/skymp-update.sh < deploy/proposed/skymp-update-stopped-marker.patch
bash -n /usr/local/bin/skymp-update.sh && sha256sum /usr/local/bin/skymp-update.sh   # 3753b3331e2b5c5bc7f2c422ca16ce7cff29d70030d712704f6382b52008aaf0
stat -c '%a %U:%G' /usr/local/bin/skymp-update.sh # 755 root:root
ops log claude-jake "skymp-update.sh skips while /opt/skymp-stopped exists (1b)" "cp -a $B /usr/local/bin/skymp-update.sh"
ops release updater claude-jake
```

If the sha256 differs, stop: the script changed since the patch was made. No restart is needed; the timer runs the
script fresh every 5 minutes. The panel shows such a run as "skipped".

## 2. Main push (claude-nate, ST-D10)

claude-jake puts a git bundle of the branch, `SHA256SUMS` and this file in `/opt/dragonbreak-handover/server-controls-1b/`.
claude-nate fetches it, checks `sha256sum -c SHA256SUMS`, runs the tests above, merges into main and pushes under the
`github-main` claim, only while `/opt/skymp-dev-hold` exists or at 0 players on Jake's go.

Note: `deploy/proposed/skymp-update-stopped-marker.patch` matches no row in the release tables
(`sources/releasePaths.js`, deny by default), so the panel lists its commit under Game server with Server build and
Game restart, and the classify command in DESIGN.md 5.1 step 5 prints this one path. Nothing builds, deploys or reads
`deploy/proposed/`. Jake decides: count it as docs for 5.1, or claude-nate leaves the `.patch` out of main (the handover
folder keeps a copy).

## 3. Backend (claude-jake, on Jake's go, `backend` claim)

Follow DESIGN.md 5.1 (the no-build manual release) to move `/opt/alduinak` to the pushed main commit, then:

```
systemctl restart dragonbreak-backend
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4000/api/site/staff/server                            # 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:4000/api/site/staff/server/actions/restart    # 403 (no Origin, refused first)
```

The second check is refused before the session, body or any command; nothing runs.

## 4. Switch file (claude-jake, root, on Jake's go)

```
install -d -m 0755 /etc/dragonbreak
printf 'dry-run\n' > /etc/dragonbreak/server-control && chmod 0644 /etc/dragonbreak/server-control
ops log claude-jake "server controls switch: dry-run" "rm /etc/dragonbreak/server-control (controls off at once)"
```

The backend reads it on every request, so no restart. Missing or any other word means off.

## 5. dashboard.html (claude-dragonbreak, on Jake's go)

Install `website/dashboard.html` from the pushed main commit to CT 107 as `/dashboard.html`. Nothing else changes (the
page carries its own button and dialog styles; `dbo.css` stays).

- sha256 `76262e770857bf72c481003e24c50b8a310e7967cb0be07594f5bc80a2d94268`
- verify strings, each counted once: `X-DBO-Control`, `showModal`,
  `Players are online: restarts with a countdown arrive with the next update.`; `innerHTML` counted 0
- it replaces the Phase 1 page (sha256 `2035a6a3136c816215866a5980ec12ada0fdbcc17d729ee2178a143888d6ebba`)

Render check done in CT 115 (headless Chromium at 360 and 1280 px against a stub site, no live endpoint): no horizontal
overflow; Chrome sent `Origin`, `Sec-Fetch-Site: same-origin`, `X-DBO-Control: 1` and exactly `{requestId, reason, confirm}`.

## 6. Acceptance

Dry run (switch `dry-run`):
- Signed out: `/api/site/staff/server` gives 401. A Dev sees the panel, no buttons, "Only Owners can control the server."
- Jake sees Start, Stop and Restart and the line "Dry run: the checks run and are logged, but nothing changes."
- At 0 players, Restart with a reason and RESTART: "Dry run: Restart passed every check. Nothing was changed." #server-logs
  gets `WEB restart (dry run, nothing ran) by ...`. No ledger line, no marker, no systemctl. The same for Stop.

Live (on Jake's go, at 0 players): `printf 'on\n' > /etc/dragonbreak/server-control` and `ops log` it, then:
- Restart: the dialog says "Restart done." within about a minute; `ops status` shows no `game-server` claim left by
  `site-owner`; `ops changelog` has the `site-owner` line with its rollback.
- Stop: `cat /opt/skymp-stopped` shows `{by, reason, at}`, mode 644; the pill says Stopped.
- Start: the marker is gone, the server is back, and the log line names the cleared marker.

## Rollback

- Controls off at once: `rm /etc/dragonbreak/server-control` (every action answers controlsOff; no restart).
- Page: put back the Phase 1 page (`git show 14415e42:website/dashboard.html`).
- Backend: revert the merge on main, release as in 5.1, restart the backend.
- Updater: `cp -a <the .bak from step 1> /usr/local/bin/skymp-update.sh` under the `updater` claim.
- A server left stopped: Start on the dashboard, or `rm /opt/skymp-stopped && systemctl start skymp` under the
  `game-server` claim.

## Not in 1b

- No countdown: with players online the buttons stay disabled (Phase 4).
- No Force stop or Force restart for an unresponsive server (refused as playersUnknown); use systemctl under the claim.
- Jobs live in memory (last 50): a backend restart forgets them, so a resend after a restart counts as a new request.
- No 2-hour re-sign-in guard; the Owner check uses the bot's 60 s role cache.
