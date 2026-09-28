# Server panel 1b (Owner Start, Stop, Restart): ship steps

Branch `feature/server-controls-1b` (claude-jake), on origin/main 14415e42:

- cd46050e: the backend (`sources/serverControl.js`, the action and job routes in `routes/site-server.js`, tests)
- 41c9f904: `website/dashboard.html` (buttons, the confirm dialog, the result line, tests)
- 85fa236a: this folder (this file and `skymp-update-stopped-marker.patch`)
- 4f8c43c6 to a32631d7: the review fixes (A1-A3, OPS-1 to OPS-6), one commit each, then this file brought up to date

Designs: ST-D12; control-panel-design.md 3.1-3.9 and 3.11 (safety rules); staging DESIGN.md 4.1-4.7 (routes under
`/api/site/staff/server`). Tests: `node --test test/*.test.js` in `skymp5-backend`: 173 tests, 169 pass, 4 skipped, 0 fail.

Nothing here is live. Every step below waits for Jake's go.

## What Jake gets

- Owners see Start, Stop and Restart in the Server panel. Dragon Break Dev sees "Only Owners can control the server."
- Stop and Restart work only with 0 players online. With players online the buttons are disabled with
  "Players are online: restarts with a countdown arrive with the next update." Start works only when the server is down.
- Each press opens a dialog on the page: live player count, a reason (5 to 200 characters) and the typed word
  START, STOP or RESTART. The dialog reports the result (done, failed, not confirmed within 2 minutes, or the dry run).
- Stop keeps the server stopped (`/opt/skymp-stopped`) until an Owner presses Start. A host reboot starts it again and
  ends the stop: the marker is then older than the unit's last start, so it no longer reads as Stopped or pauses updates,
  and the panel says it is left over until Restart or Start removes it.
- While systemd waits to restart a crashed server (auto-restart), the pill reads "Crashed, restarting" and Stop is
  offered, so a crash loop can be ended from the dashboard.
- Every action holds the `game-server` claim as operator `site-owner` from before the change until systemd shows the
  result, writes an `ops log` line with its rollback (and a second "Result: ..." line when it did not end done), and
  posts an audit line (`WEB ...`) to #server-logs. The state is read again under the claim, right before systemctl.
- Jobs are kept in `skymp5-backend/data/server-jobs.json` (last 50, mode 0600, git-ignored, created on the first action),
  so a resent request never runs twice, even after a backend restart.

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
stopped would start it again. The patch adds three lines:

- a helper, `owner_stopped(){ [ -e /opt/skymp-stopped ] && ! systemctl is-active --quiet skymp; }`: the marker holds
  only while the server is really down, so a marker left behind by a host reboot or a manual `systemctl start` never
  pauses updates while the server runs;
- after the deploy-hold check (line 18): `if owner_stopped; then say "skipped: server stopped by owner"; exit 0; fi`;
- before the updater's own `systemctl restart skymp` (after the build): the same check, which exits with "skipped
  restart: server stopped by owner" and leaves the new build for the next Start. This covers a run that passed line 18
  just before an Owner's Stop. The rollback restart is left as it is: it is reached only after the updater's own restart,
  so the owner's stop cannot be what it undoes, and guarding it would leave a crashed new build down when a leftover
  marker is present.

While `/opt/skymp-dev-hold` exists (it does today) the hold check comes first, so the new lines only matter once the hold
is lifted. This patch is for v1 only. The v2 draft (`/root/dragonbreak-jake/b/ops-v1/tooling/ops/skymp-update.sh`, lines
324, 366 and 490) skips on `[ -e "$STOPF" ]` alone and needs the same "and skymp is not active" condition before it ships
(hand-off to its owner; not changed here).

```
ops claim updater claude-jake "1b: skymp-update.sh skips while the owner has the server stopped" 30
systemctl is-active skymp-update.service          # must print inactive; otherwise wait for this run to end
sha256sum /usr/local/bin/skymp-update.sh          # must be bdc0fd6e71777eb9b37b136bcf841aaeec537f02265d07e74d544089f2bce5e7
B=/usr/local/bin/skymp-update.sh.bak-$(date +%Y%m%d-%H%M%S); cp -a /usr/local/bin/skymp-update.sh "$B"
patch --dry-run /usr/local/bin/skymp-update.sh < deploy/proposed/skymp-update-stopped-marker.patch
patch /usr/local/bin/skymp-update.sh < deploy/proposed/skymp-update-stopped-marker.patch
bash -n /usr/local/bin/skymp-update.sh && sha256sum /usr/local/bin/skymp-update.sh   # 38752e865cfb991718498645743daac9f474a32bcef612f5f721624c2590dfee
stat -c '%a %U:%G' /usr/local/bin/skymp-update.sh # 755 root:root
ops log claude-jake "skymp-update.sh skips while /opt/skymp-stopped exists and skymp is not active (1b)" "cp -a $B /usr/local/bin/skymp-update.sh"
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

On every start the backend runs `ops check game-server` (read only). Only if that shows the claim held by `site-owner`
(an action cut short by the restart) does it write a `Result:` line and `ops release game-server site-owner`; a claim held
by anyone else is left alone. `journalctl -u dragonbreak-backend` must show no `[site-server] recover failed`.

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

- sha256 `7547786c6bdbbdec7e3ce703d92ca65e375e690a2b0be5582f339d5011dad8d6`
- verify strings, each counted once: `X-DBO-Control`, `showModal`,
  `Players are online: restarts with a countdown arrive with the next update.`; `innerHTML` counted 0
- it replaces the Phase 1 page (sha256 `2035a6a3136c816215866a5980ec12ada0fdbcc17d729ee2178a143888d6ebba`)

Render check done in CT 115 on the pre-review page (76262e77; headless Chromium at 360 and 1280 px against a stub site,
no live endpoint): no horizontal overflow; Chrome sent `Origin`, `Sec-Fetch-Site: same-origin`, `X-DBO-Control: 1` and
exactly `{requestId, reason, confirm}`. The review fixes add only wrapped text lines, one pill label in the wrapping bar
and dialog text; the request is unchanged. Re-run the render check on 7547786c before install.

## 6. Acceptance

Dry run (switch `dry-run`):
- Signed out: `/api/site/staff/server` gives 401. A Dev sees the panel, no buttons, "Only Owners can control the server."
- Jake sees Start, Stop and Restart and the line "Dry run: the checks run and are logged, but nothing changes."
- At 0 players, Restart with a reason and RESTART: "Dry run: Restart passed every check. Nothing was changed." #server-logs
  gets `WEB restart (dry run, nothing ran) by ...`. No ledger line, no marker, no systemctl. The same for Stop.

Live (on Jake's go, at 0 players): `printf 'on\n' > /etc/dragonbreak/server-control` and `ops log` it, then:
- Restart: the dialog says "Restart done." within about a minute; `ops status` shows no `game-server` claim left by
  `site-owner`; `ops changelog` has the `site-owner` line with its rollback.
- Stop: `cat /opt/skymp-stopped` shows `{by, reason, at}`, mode 644; the pill says Stopped, with "Stopped by ...".
  With the patched updater, its next run logs "skipped: server stopped by owner" (only once the hold is lifted).
- Start: the marker is gone, the server is back, and the log line names the cleared marker.
- `data/server-jobs.json` exists, mode 600, and lists the dry-run and live jobs (dry runs are kept too).

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
- Force stop for an active server with no fresh heartbeat stays out (its players cannot be known); the crash-loop case
  (auto-restart) is covered by Stop.
- The site-wide limit (6 actions an hour) is kept in memory and starts again when the backend restarts; a web user cannot
  restart the backend. Resent requests are recognised for the last 50 jobs.
- No 2-hour re-sign-in guard; the Owner check uses the bot's 60 s role cache, which the bot clears when it sees a
  member's roles change. Accepted for 1b; there is no test of the bot's cache itself (it needs the Discord client).
- The panel shows an updater run skipped for the stop as "skipped", like the other skip reasons.
