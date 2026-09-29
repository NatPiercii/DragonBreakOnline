# Auto Reports interface contract, v1

`docs/auto-report-v1.md` · wire contract version **1** · document revision **1.0-rc3** (2026-09-26)

**Status:** claude-nate reviewed revision 1.0-draft for the client, launcher and build side, and a separate privacy and security review covered the rest (folded into 1.0-rc1). claude-nate then reviewed 1.0-rc1 and found a privacy defect that already affects the live Report a Problem (X5, §9), and the fixes for X5 were reviewed in turn (folded into 1.0-rc2). 1.0-rc3 records where the backend steps 1-4 differ from the text, after a correctness, privacy and conformance review of that code; none of it changes what a sender sends. Every accepted point is folded in. The lists of changes are at the end, together with the points that were rejected or narrowed and the reason for each. The revision becomes `1.0` when claude-nate confirms these changes in the ops ledger. Both sides then build against it.

**What it implements:** the Auto Reports design that Jake approved on 2026-09-26 with all 17 recommended decisions (D1-D17), `/root/dragonbreak-jake/build/auto-reports-design.md`. §10 lists the places where this contract fills a gap in the design or changes it.

**Code baselines:** alduinak `origin/main` **f8cd7897** and gameplay `origin/server` **8c638310**. Every `file:line` below refers to those commits unless it says "on client-0344". Appendix A lists them all.
- The client work builds on `client-0344` (client 0.3.47 plus `d28822bd`). There, `authService.ts` lines are about 8 higher than at f8cd7897 (`:338` is `:346`). Appendix A maps the client lines that moved.

**Who builds against which part:**

| Part | Owner | Sections |
|---|---|---|
| Backend route, validation, scrub engine and rule file, storage, trail join, signatures, Discord output, symbol archive script | claude-jake | §1, §2.11, §2.12, §3.3, §5.4, §6 |
| Client: `errorSink.ts`, `BreadcrumbService`, `scrub.ts`, in-game sender | claude-nate | §1.6, §1.7, §2.3, §2.9, §3.1, §4 |
| Front: error handlers, `ErrorBoundary`, `front:error` message | claude-nate | §2.8 |
| Launcher: `crashWatch.js`, `crashlog.js`, settings and consent writer, queue, notice, the installer build on CT 115 | claude-nate | §1.6-§1.8, §2.2, §2.4, §3.1.8, §4, §5.5 |
| Gameplay: `trail.js` | claude-nate | §3.2 |
| Build pipeline: tsconfig and webpack changes, build id, running the archive script | claude-nate, with claude-jake's script | §5 |

**Conventions**
- MUST, SHOULD and MAY carry their usual meaning.
- **Times** are integer epoch milliseconds (UTC) on the sender's clock. Their field names end in `At`, except the trail's `t`.
- **Lengths** are JavaScript string `.length` values (UTF-16 code units), measured after scrubbing.
- **Hex ids** are lowercase with no `0x` and no padding, the way `debugsnap.js:19` prints them (`ff00012a`, `a2c94`).
- **Module offsets** are `0x` plus uppercase hex, with leading zeros stripped (`0x1A2B3C`).
- **Form desc (`DESC`)** is the server's `baseDesc` format:
  - For an id below `ff000000`, it is `<local hex>:<plugin file>` (`1a2b3:Skyrim.esm`), computed the way `characterProgressService.ts:324-331` does it, light plugins included.
  - For an FF-range id, or when the plugin lookup fails, it is the full hex (`ff00012a`).
  - Pattern: `[0-9a-f]{1,8}(?::[^:\r\n]{1,64}?\.es[lmp])?`.
- **Version string:** `^\d+(\.\d+){1,3}$`, for example `0.3.44` or `1.6.1170.0`.
- **Scrubbed** means the sender ran the §2.11 rules. The backend runs them again.
- **Patterns** are JavaScript regular expressions and must match the whole value.

---

## 1. Transport

### 1.1 Endpoint and route (D9)

`POST <base>/api/files/report`, with the header `x-report-kind: auto`.

- **Game client base:** the settings key `master` (`settingsService.ts:39-41`), normalised the same way (`:169-174`).
  - The launcher writes it from serverinfo `masterUrl`, or writes `''` when there is none (`main.js:3311`). The client then falls back to `https://dragonbreakonline.com` (`settingsService.ts:40`).
  - The backend's default master URL is `https://api.dragonbreakonline.com/` (`config.js:53`).
- **Launcher base:** `config.apiUrl`, which is `https://dragonbreakonline.com` (`skymp5-launcher/src/config.js:11`).
- **Up to two hosts carry this path.** Each one must forward it with a 400 KB body (open item O1). §1.3 says which bases may carry the token.
- **Why this path:**
  - The public proxy already forwards it (`files.js:73-74`).
  - `server.js:67-69` keeps the global JSON parser off this path. The auto route can therefore parse the body with its own limit, after its checks.
  - The comment at `files.js:73` says "the game uses it too". That is out of date: no client code posts there today.

**Route (backend).** It goes before the manual route at `files.js:106`:

```js
router.post('/report',
  (req, res, next) => (req.headers['x-report-kind'] === 'auto' ? next() : next('route')),
  autoReport.killSwitch,        // AUTO_REPORTS=off -> 503 before any other work
  autoIpLimiter,                // per visitor IP, keyed like anonKey (files.js:86)
  identifyReporter,             // files.js:77-83 -> lookupSession (master-api.js:100-103)
  autoUnverifiedCeiling,        // one global ceiling on unverified requests, like files.js:96-104
  autoReport.requireVerified,   // 401 without a live session; 403 for a banned profile
  autoProfileLimiter,           // 429, per profile
  autoReport.requireJson,       // 415 unless application/json and no content-encoding
  express.json({ limit: '400kb', inflate: false, type: 'application/json' }),
  autoReport.accept)            // 422 / 202; any throw -> 500 JSON
```

- **Body-parser failures** fall through to `problemReport.bodyErrors`, mounted at `files.js:115` (`problemReport.js:154-161`). They answer 400, 413 or 415 in JSON.
- **`requireJson` is needed** because `express.json` skips parsing when the type does not match, instead of failing. Without it, a wrong content type would come back as a 422.
- **`accept` catches every error** and answers `500 {"error":"internal"}` with no stack. The default handler would send a stack trace (`server.js:108`).
- **Bans are checked silently.** The route writes no `bans.logBan` line per report, unlike `master-api.js:242`.
- The backend runs Express 4.22, which supports `next('route')`.
- **A request without `x-report-kind: auto`** goes to the manual route. It fails there with 400 "The report has no logs, screenshot or description." (`problemReport.js:91`), and the report is lost. Senders MUST set the header.
- **The manual route refuses auto payloads.** It answers 400 `{"error":"x-report-kind"}` to any body that has `contractVersion`. The manual route posts top-level log fields (`problemReport.js:12-13`), so without this check an auto payload could become an unverified manual thread.

### 1.2 Headers

| Header | Value | Required |
|---|---|---|
| `content-type` | `application/json` (`; charset=utf-8` allowed) | yes |
| `x-report-kind` | `auto` | yes |
| `x-session` | The play-session token | yes |

- **Game client:** set the content type only through the `contentType` option.
  - SkyrimPlatform already sends it from there (`HttpClient.cpp:83-84`), so a `content-type` entry in `headers` would be sent twice.
  - Every header value must be a string, or the call throws (`HttpClientApi.cpp:46-51`).
- Do not send `content-encoding`. A compressed body gets 415.
- Header names are case-insensitive. The client may send `X-Session`, as `settingsService.ts:90` already does.

### 1.3 Authentication and trust

**Where the token comes from:**
- **Game client:** read `sp.getPluginSourceCode("auth-data-no-load", "PluginsNoLoad")` directly and take `.session` from `JSON.parse(text.slice(2))`, inside the sink's own `try/catch`. This is the file the launcher writes (`main.js:3337-3347`).
  - Do not call `AuthService.readAuthDataFromDisk` (`authService.ts:430-447`; `:439-457` on client-0344). It prints a line on every call (`:431`) and sends its parse error through `logError` (`:444`), which would feed the sink.
  - The sink never reports its own parse errors. It re-reads the token only while reports are waiting (§1.6).
- **Launcher:** `store.get('gameSession')`, set at login (`main.js:930`).

**Where the token may go (both senders):**
- It is attached only in two cases. Otherwise no auto report is sent.
  - The base is `https://` and the host is `dragonbreakonline.com` or ends in `.dragonbreakonline.com`.
  - For development, the base is `http://127.0.0.1` or `http://localhost`.
- Redirects are never followed. httplib does not follow them by default (`HttpClient.cpp:77`), and neither does the launcher's helper (`main.js:3426-3427`).
- **Never logged:**
  - The backend never logs `req.headers`, the token or the visitor IP on this route.
  - The launcher logs only `reportId`, `kind` and the status, never options or headers. Manual reports upload `install.log` (`report.js:55`).
  - Pending, sent and evidence files never contain the token.

**What the backend does:**
- **Session lookup.** `lookupSession(token)` (`master-api.js:100-103`) returns `{profileId, discordId, username, expiresAt, launchCheck?, hwid?}` (`master-api.js:193-198`, `:117`, `:126`).
  - No entry → **401**.
  - The profile, Discord id and name come only from this entry. Nothing in the body identifies the sender.
- **Session lifetime.** A session lasts 24 h. The expiry moves forward each time the game server validates it (`master-api.js:70`, `:253-255`).
  - A player who stays in game for more than 24 h can hit a 401; see §1.7.
  - Before client 0.3.47, the game could also hold an older token than the launcher under MO2 (§9, defect X2, now fixed).
- **Bans.** A profile banned by Discord id or hardware id gets **403**. The check works the way `master-api.js:238-244` does.
- **Trust label** stored with each report:
  - `verified` when `entry.launchCheck.filesOk === true` (`launch-check.js:46`, `master-api.js:114-120`); otherwise `unverified-launch`.
  - **It is a spam signal only, never proof.** The launcher sends `filesVersion` itself (`launch-check.js:36-46`), and the current value is public (`files.js:35-43`).
  - The body's `versions.files` is for information only.
- **No anonymous auto reports (D10).** A server in offline mode issues no session, so its clients do not report.

### 1.4 Size limits

| Limit | Value | Over the limit |
|---|---|---|
| Whole request body | 400 KB (409,600 bytes) | 413 |
| Target for `script-error` and `ui-error` | at most 48 KB | (sender guideline) |
| Target for launcher kinds | at most 256 KB | (sender guideline) |

Per-field caps are in §2.

**On a 413, the sender MUST shrink the report once and resend it with the same `reportId`.** It removes these, in this order, until the body fits the target:
1. `logs`;
2. `crash.sections.modules` and `crash.sections.plugins`;
3. trail entries, down to the last 20.

A second 413 means the report is dropped.

### 1.5 Responses

| Status | Body | Meaning | Sender action |
|---|---|---|---|
| **202** | `{ "ok": true, "id": "<reportId>", "duplicate": false }` | Stored, stored before, ignored (§2.12), or from a muted profile | Done. Record it as sent (§4.5). Never send it again. |
| 400 | `{ "error" }` | The body is not JSON | Drop it and log locally. |
| 401 | `{ "error": "session", "reason": "missing" or "invalid" }` | No live session | Queue it (§1.7). Do not retry with the same token. |
| 403 (JSON body) | `{ "error": "refused" }` | The profile is banned | Drop it. Send nothing more this session. |
| 413 | `{ "error" }` | Too large | Shrink once (§1.4). |
| 415 | `{ "error" }` | Not `application/json`, or compressed | Drop it; this is a sender bug. |
| 422 | `{ "error": "schema", "problems": [ ...up to 10 strings ] }`, `{ "error": "contractVersion", "supported": [1] }` or `{ "error": "consent" }` | Failed validation (§2.12) | Drop it and log the problems locally. |
| 429 | `{ "error": "rate", "retryAfterSec": <int> }` plus a `Retry-After` header | Rate limited | Wait for the larger of `retryAfterSec` and the backoff, then retry. This counts as an attempt. The game client cannot read headers (`HttpClientApi.cpp:166-171`), so `retryAfterSec` is required in the body. |
| 500 | `{ "error": "internal" }` | Backend fault | Transient: retry with backoff. |
| 503 | `{ "error": "paused", "pauseSec" }` | `AUTO_REPORTS=off` | Drop the report and do not queue it. Send nothing until `pauseSec` has passed (default 3600). |
| Other 5xx, status 0, or no answer in 30 s | anything | Transient | Retry with backoff (§1.6). |
| Any status with a non-JSON body (for example a Cloudflare page) | HTML | Proxy or WAF | Treat it as transient. After 3 in one session, stop sending for that session (O1). |

- `duplicate` is `true` when this `reportId` was already stored for this profile.
- The 202 body deliberately carries no group id, no "new group" flag and no ignore reason, so it tells a forger nothing about signatures or filters. That information stays on the backend.
- **Server modes:**
  - In `collect` mode the backend still answers 202 and stores the report, but nothing reaches Discord.
  - In `on` mode it posts as §6.1 describes.

### 1.6 Sending rules

**All senders:**
- **`reportId`.** A lowercase UUID v4, `^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`, created once with the report.
  - It stays the same through retries, shrinking, the queue and the hand-off to the launcher.
  - This is how `main.js:1608-1615` keeps the manual report's id.
- **Per attempt, only `sentAt`, `attempt` and `queued` change.** Everything else is sent byte-identical. `error.count` is frozen when the report is built (§2.3).
- **`attempt`** counts the attempts of one sending episode by one sender, from 1 to 5. A report taken from a queue, by either sender, starts again at 1 with `queued: true`.
- **Backoff.** After attempt *n* fails transiently, wait 30 s × 2^(n-1) (30, 60, 120 and 240 s), plus or minus 20 % jitter. After attempt 5, queue the report (§1.7).
- **Backend deduplication:**
  - The key is `<profileId>:<reportId>`, kept for 8 days in `data/auto/auto-state.json`, at most the latest 500 per profile.
  - A repeat gets 202 with `duplicate: true`.
- **One auto report in flight at a time** per sender.
- **Consent is checked again before every send** (§4).

**Game client:**
- **Call.** `new SpHttpClient(base).post('/api/files/report', { body, contentType: 'application/json', headers: { 'x-report-kind': 'auto', 'x-session': token } }, callback)`, using the callback form (`HttpClientApi.cpp:143-146`, `:176-179`).
  - `SpHttpClient` is the original `skyrimPlatform.HttpClient`, saved before errorSink patches it (§2.3).
  - Promises do not work in the main menu (`settingsService.ts:60`).
  - `IHttpClientWithCallback` (`settingsService.ts:8-13`) needs a `post` overload that takes the callback.
- **Result.** The callback receives `{status, body, error}` and no headers (`HttpClientApi.cpp:166-171`).
  - For POST, `error` is always empty.
  - A transport failure shows up as `status` 0 (`HttpClient.cpp:88-91`).
- **No timeout from SkyrimPlatform.** It uses httplib's defaults, with a connect timeout of up to 300 s (`HttpClient.cpp:77-84`). All requests share 3 worker threads, login and serverinfo included (`HttpClient.cpp:22-24`). Therefore:
  - After 30 s without a callback, the attempt counts as failed and the backoff clock starts.
  - The next attempt starts only after the earlier attempt's callback has arrived. An abandoned request must never hold a second thread.
  - A late 202 completes the report. A retry that already went out is deduplicated.
- **All timing is driven by `tick`.**
  - The Node event loop (timers, promises, async `fs`) runs only on the update path (`SkyrimPlatform.cpp:408-412`), so it never runs in the main menu.
  - `tick` runs in both (`SkyrimPlatform.cpp:133-135`).
- **No NUL bytes.** The body is copied as a C string (`HttpClient.cpp:75`). Build it with `JSON.stringify`, which escapes U+0000.
- **Wrap the callback in `try/catch`.** A throw there skips that frame's `tick` (`SkyrimPlatform.cpp:133-135`).
- **Client caps** (design §7):
  - each pre-check key once per session (§2.3);
  - at most 10 reports per session;
  - at least 30 s between sends;
  - at most 5 reports waiting in memory. When that is full, the newest is dropped.
- **Before a session exists.** Hold reports in memory. While reports are waiting, re-read the token once a minute.

**Launcher:**
- **Its own POST helper.**
  - `postJSON` (`main.js:3428-3460`) rejects every non-2xx answer and passes on neither the headers nor the body.
  - The auto sender needs a variant that returns the status, `Retry-After` and the JSON body, and that also does not follow redirects.
- **Timeout:** 15 s.
- **Pacing.** At most one report per game exit, plus the queue.

### 1.7 Queueing (D10)

**Wrapper, both queues:** `{ "v": 1, "profileId": <int>, "savedAt": <ms>, "needsConsent": false, "payload": { ... } }`. It never holds the token.

**Client:**
- **When.** On a 401, or after attempt 5.
- **Where.** `<D>/dbo-pending/<reportId>.json` (§3.1.1).
  - `profileId` is `masterApiId` from the auth data.
  - Keep at most 5 files; delete the oldest first.
- **While still in game, after a 401.** Re-read the token once a minute. If it has changed, send the queued reports from memory. Delete each report's file once the report is acknowledged.

**Launcher:**
- **Its own queue.** `<userData>/pending-reports/<reportId>.json`, at most 5 files.
- **`needsConsent: true`** marks a crash-kind report that is waiting for the player's answer to "ask" (§4.4). A file with this flag is never sent.
- **When it sends.** After login (`main.js:928-933`), and at launcher start when it has a session:
  - first its own queue, then the client's `dbo-pending/` files from every folder in the §3.1.8 search list;
  - oldest first, with `queued: true` and `attempt` starting from 1.
- **Consent at send time.** Before each file, the launcher checks:
  - the current toggles;
  - the notice for that file's profile;
  - `mode` (§1.8);
  - for launcher kinds, `crashWatch`.

  A file that is no longer allowed is deleted unsent.
- **What it discards unsent:**
  - a file whose `profileId` differs from `store.get('gameProfileId')` (a shared PC);
  - a file older than 7 days, including an unanswered `needsConsent` file.
- **Opt-out clears queues.**
  - Turning "Errors in game" off deletes every queued `script-error`, `ui-error`, `js-fatal` and `freeze` file in both queues.
  - Turning crash reports off deletes queued crash-kind files and `crash-evidence/`.
- **When it deletes a file:** after a 202, a 403, a 415, a 422, or a second 413. It keeps the file after a 401, a 429, a 5xx or status 0.
- **Nothing is queued after a 503.**

### 1.8 Server switch that the launcher reads

`GET /api/version` (`version.js:13-20`), which the launcher already fetches (`main.js:1630-1631`), gets one more field:

```json
"autoReport": { "mode": "collect", "crashWatch": false, "contract": [1] }
```

- `mode` is `AUTO_REPORTS`.
- `crashWatch` is the P5 flag.
- `contract` lists the wire versions the backend accepts.

**How the launcher uses it:**
- It caches the last answer. Until it has fetched one, it assumes `{ "mode": "off", "crashWatch": false }`.
- While `mode` is `off`, it sends nothing, the queue included.
- It classifies game exits and sends launcher kinds only while `crashWatch` is `true`.

The game client does not read this field; a 503 covers it.

---

## 2. Payload

### 2.1 Envelope (every kind)

| Field | Type | Req. | Rule |
|---|---|---|---|
| `contractVersion` | int | yes | `1` |
| `reportId` | string | yes | UUID v4 (§1.6) |
| `kind` | enum | yes | One of the §2.2 kinds |
| `sender` | `"client"` or `"launcher"` | yes | Must match the kind (§2.2) |
| `clientAt` | int | yes | When it happened: when the error was captured, or when the launcher detected the exit |
| `sentAt` | int | yes | This attempt, on the sender's clock (used for skew, §3.3) |
| `attempt` | int 1-5 | yes | §1.6 |
| `queued` | bool | yes | `true` when the report waited in a queue (§1.7) |
| `consent` | object | yes | `noticeVersion` (int ≥ 1); `errors` (bool); `crash` (`"always"` or `"once"`). `crash` is required for `crash`, `crash-nolog` and `crash-on-quit`, and left out otherwise. §2.12 enforces these. |
| `versions` | object | yes | See below |
| `build` | object | client kinds | `client`: build id (§5.1), required for `script-error`. `front`: build id or `null`, required for `ui-error`. `probe`: `{line, col}` or `null` (§2.9). Launcher kinds copy `client` from the trail header when there is one. |
| `session` | object | no | `start` (int: the trail header's `sessionStart`), `uptimeSec` (int), `connected` (bool), `actorId` (the player's server actor id in hex, or `null`) |
| `error` | object | script-error, ui-error | §2.3 |
| `exit` | object | launcher kinds | §2.4 |
| `crash` | object | crash, crash-on-quit | §2.4 |
| `trail` | object | yes | §2.5. `entries` may be empty. |
| `logs` | object | no | §2.6 |

**`versions`:**
- `client`: version string.
  - Required for client kinds. For launcher kinds, it is taken from the trail header when known.
  - The client takes it from `__CLIENT_VERSION__` (§2.9).
- `files`: `^[0-9A-Za-z][0-9A-Za-z.-]{0,31}$`, optional.
  - This is the launcher's installed `filesVersion`, which can be a git hash (`merge-files.js:138`).
  - The client reads it from settings `autoReport.filesVersion`.
- `launcher`: version string, optional. `app.getVersion()` in the launcher, or settings `autoReport.launcherVersion` in the client.
- `game`: version string. Required for crash kinds when known, from the crash log header or `gameversion.js`.
- `os`: `^[\w .()-]{1,40}$`. Launcher kinds only, for example `win32 10.0.22631`.

**Field rules for every kind:**
- **Unknown fields at any level are dropped.** A `signature` or `group` field anywhere is ignored (design §3).
- **An optional field the sender cannot fill validly MUST be left out.** If one arrives invalid anyway, the backend does not refuse the report (§2.12). It removes the field or sets it to `null`, and flags the report `invalidField`.

### 2.2 Kinds

| `kind` | Sender | When | Consent toggle | Blocks | In Discord |
|---|---|---|---|---|---|
| `script-error` | client | A JavaScript error in the client script, from: an event handler (the global `on`/`once` patch), a hook handler, `logError` with an `Error`, an HTTP callback, or a process hook | errors | error, trail | One thread per group |
| `ui-error` | client (forwarded from the front) | A CEF `window` error, an `unhandledrejection`, or the `ErrorBoundary` | errors | error (`source: "front"`), trail | One thread per group |
| `js-fatal` | launcher | Rule 3 below | errors | exit, trail, logs | Grouped by the last `err` entry |
| `freeze` | launcher | Rule 4 below | errors | exit, trail, logs | One group, `v1\|freeze` |
| `crash` | launcher | Rule 1 below, without a quit marker | crash (`ask` or `always`) | exit, crash (full), trail, logs | One thread per group |
| `crash-nolog` | launcher | Rule 2 below | crash (`ask` or `always`) | exit (with `event` when there is one), trail, logs | One thread per group |
| `crash-on-quit` | launcher | Rule 1 below, with a quit marker | crash, `always` only, never asked | exit, crash (no `sections`), trail (last 10) | Index line only (D14) |

**Launcher classification.**

A launcher kind is sent only when all of these hold; otherwise nothing is sent:
- `crashWatch` is `true` (§1.8);
- the D2 notice has been shown to the logged-in profile (§4.2);
- the trail holds a DragonBreak entry within 60 s before the event (§3.1.9).

Then these rules apply in order, and the first match wins:

1. **A new crash log:** a `crash-*.log` written after `lastLaunch.at` and after `crashSeenBefore`, and no longer growing (wait up to 20 s). The kind is `crash-on-quit` when `exit.quitMarker` is true, and `crash` otherwise.
2. **`crash-nolog`** when either of these holds:
   - `exit.code` ≥ 0xC0000000, except 0xC000013A (shutdown or logoff);
   - Windows event 1000 for `gamePid`.
3. **`js-fatal`** when both of these hold:
   - `exit.code` is not 0 (`null` counts as not 0);
   - the last trail entry other than `hb` is `err` or `fatal`, with `t` ≥ `exit.at` - 15 s.
4. **`freeze`** when all of these hold:
   - `exit.code` is 1 or `null`;
   - `quitMarker` is false;
   - either `lastHeartbeatAt` < `exit.at` - 30 s, or Windows event 1002 for `gamePid`.

   A Task Manager kill gives code 1 and no event.
5. **Anything else is a clean exit.** Code 0 is always clean unless rule 1 applies.

O4 confirms the codes on Windows, read as the signed `ExitCode` (§2.4). O12 checks whether `tick` keeps running while the game is minimised, which decides how often rule 4 misfires.

### 2.3 The `error` block (script-error, ui-error)

| Field | Type | Req. | Rule |
|---|---|---|---|
| `source` | `"client"` or `"front"` | yes | Must match the kind |
| `where` | enum | yes | Client: `on`, `once`, `hook`, `logged`, `http`, `uncaught`, `rejection`. Front: `window`, `promise`, `boundary`. |
| `event` | string or null | yes | `on`, `once`: the SkyrimPlatform event name, `^[A-Za-z][A-Za-z0-9]{0,39}$`. `hook`: the hook name (`sendAnimationEvent` or `sendPapyrusEvent`). `http`: `get` or `post`, never the path. Otherwise `null`. |
| `service` | string or null | no | `logged` only: the `logError` service name. Every character outside `[A-Za-z0-9_$]` is replaced by `_`, and the result is cut to 64 (`logError` accepts any string, `logging.ts:5`). |
| `handled` | bool | yes | `true` only for `logged` |
| `type` | string | yes | The constructor name, `^[A-Za-z_$][A-Za-z0-9_$.]{0,63}$`. A thrown value that is not an `Error` gets `NonError:<typeof>`, matching `^NonError:[a-z]{1,9}$`, for example `NonError:string`. |
| `message` | string | yes | Scrubbed, including S21 (§2.11). At most 1000. May be empty. |
| `frames` | array | yes | Up to 12 `{fn, line, col, file}` entries. May be empty: errors raised from C++ have no JS frames. |
| `site` | object or null | yes | `{line, col}`: where `on`, `once` or `hooks.*.add` was called (the registration site). `null` for the other `where` values. |
| `componentStack` | string or null | no | `boundary` only. One line per component: `at <Name> (build.js:<line>:<col>)`. React 18's production build minifies component names (`skymp5-front/package.json:7`), so the position in `build.js` is what identifies the component, and the backend MAY resolve it with the front map. URLs and paths are reduced to the base name `build.js`. A line located in any other file becomes `at <Name>`. At most 2000. |
| `count` | int 1 to 10,000,000 | yes | How many times the pre-check key had fired this session when the report was built. Frozen after that. |

**Frames:**
- `fn`: `^[A-Za-z0-9_$.<>\[\] ]{1,128}$`, or `null` for anonymous functions. The sender replaces any other character with `_`.
- `line` and `col`: integers from 1 to 10,000,000. They are 1-based, as V8 prints them. Take the **last** `:<line>:<col>` pair on the frame line.
- `file`:
  - **Bundle frames: `null`.** SkyrimPlatform loads the client script with a global `eval` (`JsEngine.cpp:77-82`, `NapiHelper.h:29-34`), so its frames show `<anonymous>`.
  - **Some `<anonymous>` frames are not from the bundle.** Every event and HTTP callback runs inside a wrapper script (`JsEngine.cpp:49-55`), compiled with no script origin (`NodeInstance.cpp:246-252`). That wrapper adds an `<anonymous>:3:NN` frame.
  - **How the sender tells them apart:**
    - It takes the location text of the probe frame (§2.9) and strips the trailing `:L:C`.
    - Only frames whose location has exactly that prefix are bundle frames.
    - Every other `<anonymous>` frame is dropped.
  - **Front frames from `build.js`:** `"build.js"`. The URL and the path are dropped.
  - **Front frames from code injected with `executeJavaScript`** (56 call sites in the client): `"<injected>"`, keeping `fn`.
  - `node:*` names stay as they are. Any other path is reduced to its base name.
- **Dropped frames:**
  - The sender drops its own frames (functions whose names start with `__dbo`), after it has read the probe.
  - The backend drops `node:internal` and `webpack/bootstrap` frames when it computes the signature.
  - The backend drops any frame or `site` whose line is below 1 after the probe correction (§2.12).
- **Stack depth.** errorSink sets `Error.stackTraceLimit = 16`, because the wrapper and the dispatcher use 2 of the default 10.

**Pre-check key (client side, never sent).** It decides "once per session" and drives `count`. It is computed **before** `.stack` is read:

```
where + "|" + (event or "") + "|" + e.name + "|" + skeleton(e.message)
```

`skeleton` takes the first 200 characters, replaces digit runs with `#` and quoted strings with `<s>`, then keeps the first 120.

**Capture rules (design §1a):**
1. Check the pre-check key against the session's "already seen" set before reading `.stack`. A repeat only increments its count.
2. Mark the `Error` object, so that an error is captured once when it is logged and then rethrown, or caught by two wrappers.
3. Keep the whole body in `try/catch`, guarded against re-entry.
4. **The `on`/`once` wrappers:**
   - They always rethrow, so `EventsApi.cpp:57-70` still logs `on('<ev>'): msg`.
   - They return the original handle `{uid, eventName}` (`EventsApi.cpp:176-180`); otherwise `unsubscribe` breaks.
5. **Registration site.** Keep one bare `new Error()` per `on`, `once` or `hooks.*.add` call, and read its `.stack` only when that handler first fails. `once` is called often at run time (for example `customPacketUtil.ts:26-29`).
6. **Hooks.** Wrap `enter` and `leave` on the object passed to `hooks.sendAnimationEvent.add` and `hooks.sendPapyrusEvent.add`. C++ catches their errors and rethrows only `e.what()` in a later update task (`Hook.cpp:67-71`, `:94-98`), so the `on`/`once` patch never sees them.
   - The patched `add` passes on all four arguments, `add(handler, minSelfId, maxSelfId, pattern)` (`EventsApi.cpp:117-141`), and returns the native id.
   - The wrappers call the original `enter` and `leave` with `this` undefined, as C++ does (`Hook.cpp:124`, `:185`).
7. **HTTP callbacks.**
   - `HttpClient` instances get their own `get` and `post` properties (`HttpClientApi.cpp:66-73`), so there is no prototype to patch.
   - There are three construction sites: `settingsService.ts:45`, `authService.ts:338` and `authService.ts:374` (`:346` and `:382` on client-0344). The callback of the client built at `:338` calls `JSON.parse` on the response at `:355` (`:363` on client-0344).
   - So errorSink replaces `skyrimPlatform.HttpClient`, as it does `on` and `once`, with a constructor that builds the native client and wraps the callback passed to its `get` and `post`.
   - **The wrapper calls the native method with the native instance as `this`** (`native.post.call(native, path, options, cb)`). Native `Get` and `Post` read `this.host` (`HttpClientApi.cpp:92`, `:148`).
   - **It passes a third argument only when the caller gave a callback.** Native code picks the callback form or the promise form from whether `info[2]` is undefined (`HttpClientApi.cpp:88-90`, `:144-146`), so an added wrapper would turn a promise call into a callback call.
   - The sink's own requests use the saved original.
8. **No `controller` wrapper.** `controller.on` and `controller.once` are the same functions as the patched `sp.on` and `sp.once`. They are captured at `spApiInteractor.ts:16-17`, after errorSink has run.
9. **Process hooks** (`uncaughtException`, `unhandledRejection`):
   - They are installed once per process. `process` survives a hot reload; only the `skyrimPlatform` object is recreated (`SkyrimPlatform.cpp:317-318`).
   - **They call the current sink through `globalThis.__dboAutoReport`**, never a function captured when they were installed. Otherwise, after a hot reload, they would run the old bundle's code.
   - They write a synchronous `fatal` trail entry. That entry is the only record, because `console.error` does not reach `skyrim-platform.log` (only spdlog writes that file).
10. **errorSink has no service dependencies.** It is the first import in `index.ts`, so it must not use SettingsService or AuthService.
    - **It is imported before `./services/services/skympClient`** (`index.ts:6` on client-0344). `remoteServer.ts:115` calls `on('update')` when its module loads, before any service is constructed.
    - **It patches `globalThis.skyrimPlatform`**, the real object. The TypeScript namespace import (`import * as sp`) is read-only. The shipped 0.3.47 bundle confirms that services receive the real object and call `(0, X.on)(…)` on it, reading the property at every call (O2).
    - It reads the master URL from `sp.settings["skymp5-client"].master`, with the same fallback and normalisation (`settingsService.ts:39-41`, `:169-174`).
    - It reads the token as §1.3 says.

### 2.4 The `exit` and `crash` blocks (launcher kinds)

**What the launcher must collect.** Both launch paths spawn detached and call `unref` (`main.js:1777`, `:1806`; `mo2.js:1343-1347`). `SkyrimSE.exe` is therefore a grandchild of the launcher, which today knows neither its pid nor its exit code.
- **Pid.** After a launch, poll `tasklist /FI "IMAGENAME eq SkyrimSE.exe" /FO CSV /NH` every 2 s for up to `LAUNCH_GRACE_MS` (`main.js:1548`). Save `{pid, foundAt}` in `lastLaunch`.
- **Exit code.** Run hidden PowerShell: `$p=Get-Process -Id <pid>; $null=$p.Handle; $p.WaitForExit(); $p.ExitCode`. This is `detectedBy: "wait"`.
  - Touching `.Handle` first is required. Without it, .NET gives no exit code for a process it did not start.
  - **Print `ExitCode` as it is, signed, and convert it in JavaScript with `>>> 0`** (`-1073741819` becomes `3221225477`, 0xC0000005). .NET `ExitCode` is a signed Int32, and every crash code is negative there. A `[uint32]` cast throws on each of them: the watcher would fall back to polling with `code: null`, `crash-nolog` would be missed, and rule 4 would call the crash a freeze.
  - If PowerShell fails, fall back to the `tasklist` poll every 5 s (`main.js:1515-1523`), with `detectedBy: "poll"` and `code: null`.
  - If the launcher was not running at the exit, `detectedBy` is `next-start`.
- **Windows events.** Read Application log events 1000 (crash) and 1002 (hang). Match them by the pid in the event data, not by time alone.
  - Normalise `c0000005` to `0xC0000005` and `0x00000000001a2b3c` to `0x1A2B3C`.
  - Event 1002 has no module and no exception code. Set `module: "SkyrimSE.exe"` and the rest to `null`.
- **Evidence copy.** At the exit, before classifying, copy both trail files and the `skyrim-platform.log` tail into `<userData>/crash-evidence/<pid>/`.
  - This is needed because SkyrimPlatform empties the log at the next game start (`main.cpp:107-108`), and a relaunch rotates the trail.
  - The log tail goes through S0 (§2.11) as it is copied, so the copy holds no game UI lines (X5).
  - Delete the copy once the report is sent or discarded, and after 7 days at most.
- **Crash-log folder:**
  - Use `CrashLogger.ini` `[Debug] Crashlog Directory` when it is set. Under MO2, read the ini from the Crash Logger mod folder; on a direct launch, from `Data\SKSE\Plugins\`.
  - Otherwise use the SKSE folder of §3.1.1.
  - Crash Logger is required only on the MO2 path, so the watcher must work without it.

**`exit`:**

| Field | Type | Req. | Rule |
|---|---|---|---|
| `at` | int | yes | When the exit was detected. When classified at the next launcher start, use the later of `lastHeartbeatAt` and the last trail `t`. |
| `code` | int or null | yes | 0 to 4294967295. A signed value is converted with `>>> 0`. `null` when only polling saw the exit. |
| `detectedBy` | enum | yes | `wait`, `poll` or `next-start` (above) |
| `gamePid` | int or null | yes | Used to pick the right trail file (§3.1.8) and to match Windows events |
| `lastHeartbeatAt` | int or null | yes | The `t` of the last `hb` entry. Required and not null for `freeze`, unless the evidence is event 1002. |
| `quitMarker` | bool | yes | See below |
| `event` | object or null | yes | `{ id: 1000 or 1002, module (MODULE or null), moduleVersion (version or null), exceptionCode (^0x[0-9A-F]{8}$ or null), offset (^0x[0-9A-F]{1,16}$ or null) }`. Required for `crash-nolog` when there is no exit code. |

**`quitMarker`** is `true` when the last trail entry other than `hb` is one of these:
- `net exit quit`, `net exit kick` or `net exit auth`.
  - The client writes these synchronously right before each `exitProcess()` call (`authService.ts:329`, `characterSelectService.ts:204`, `kickService.ts:90`).
  - `exitProcess` only sets the engine's `quitGame` flag (`Win32Api.cpp:18-21`). That is the same engine shutdown in which crashes on quit happen.
- `net menu-quit`.
  - The client writes it when `update` stops right after the Journal, the rule at `characterSelectService.ts:238-258`.
  - This covers "Quit to main menu", and a later Quit from the main menu.

An open Journal is **not** a quit marker by itself. The Journal is also open during pause and in MCM menus.

**Known gap until O11 is settled.** "Quit to desktop" from the pause menu writes no marker today: it is not an `exitProcess()` call, and O11 has not yet shown which menu events come before it. A crash during that quit is therefore classified `crash`, not `crash-on-quit`, and opens a thread. O11 MUST be settled, and that path given a marker, before P5 turns the crash watcher on.

**`crash`** (for `crash` and `crash-on-quit`). Patterns used below:
- `MODULE` is `^[A-Za-z0-9_. ()+-]{1,64}$`.
- Offsets are `^0x[0-9A-F]{1,16}$`, with leading zeros stripped. Crash Logger prints them as `SkyrimSE.exe+0123456`.
- Symbols are `^[\x20-\x7e]{1,200}$`.

| Field | Type | Req. | Rule |
|---|---|---|---|
| `crashAt` | int | yes | The crash log's mtime in UTC ms |
| `logName` | string | no | `^crash-[0-9_-]{1,40}\.log$` |
| `crashLoggerVersion` | string | no | `^[\w.-]{1,32}$` |
| `exception` | string | yes | `^(EXCEPTION_[A-Z_]{3,40}\|0x[0-9A-F]{8})$` |
| `faultModule` | string or null | yes | `MODULE`. `null` when the fault is in memory outside any module. |
| `faultOffset` | string or null | yes | Offset. `null` when `faultModule` is `null`. |
| `faultSymbol` | string or null | yes | PDB symbol |
| `faultAlid` | int or null | yes | Address Library id |
| `hasOurDll` | bool | yes | See below |
| `frames` | array | yes | Up to 24 `{ module, offset, symbol, alid }` entries, in the same formats. `module` and `offset` may be `null`. No absolute addresses. May be empty. |
| `sections` | object | `crash` only | See below. Not sent for `crash-on-quit`. |

**`hasOurDll`** is `true` when the fault module, or one of the first 10 frames that are not system modules, is one of the DLLs we ship:
- `SkyrimPlatform.dll`;
- `SkyrimPlatformImpl.dll`;
- `MpClientPlugin.dll`;
- `libnode.dll`, where a V8 fatal error or an out-of-memory error lands;
- `libcef.dll`.

There is no `SkyrimPlatformCEF.dll`; the package ships `SkyrimPlatformCEF.exe.hidden`, which runs as a separate process. `hasOurDll` is a triage label, not a filter (§10, item 16).

**`crash.sections`.** Each value is a scrubbed string, cut from its head with `keep: 'head'` (the design's new option for `report.js:27-38`). The total is at most 128 KB.

| Key | Crash Logger section | Cap | Kept |
|---|---|---|---|
| `header` | Exception line, game and Crash Logger versions | 4 KB | as is |
| `callStack` | `PROBABLE CALL STACK` or `CALL STACK (HYBRID)` | 24 KB | Frame lines with module+offset, PDB symbol or Address Library id |
| `registers` | `REGISTERS` | 4 KB | `<REG> (<type>)` only. No values, strings or nested lines. |
| `relevantObjects` | `POSSIBLE RELEVANT OBJECTS` | 16 KB | Form ids, type names and `File: "<plugin>"`. The value of every `Name` or `Full Name` field becomes `<name>`, quoted or not, whatever the object. Every other quoted string is dropped. |
| `modules` | `MODULES` | 32 KB | Module lines, paths scrubbed |
| `sksePlugins` | `SKSE PLUGINS` | 8 KB | as is |
| `plugins` | `PLUGINS` | 32 KB | as is |
| `systemSpecs` | `SYSTEM SPECS` | 4 KB | as is (covered by crash consent, D1) |

Every name goes because character names appear on more forms than FF-range references:
- the player's own base form 0x7 and reference 0x14 carry the character name (`appearance.ts:145-146`, `:162-165`);
- remote players' FF-range base NPCs carry theirs (`appearance.ts:154`, `formView.ts:129`).

**Never taken from a crash log:** the `STACK` section, strings read from memory, or any line outside a kept section.

The same parser produces `sections` and the parsed fields. It lives in `crashlog.js` in the launcher and `sources/crashLog.js` in the backend, as identical copies (§2.11). The line formats will be confirmed against real logs (O3).
- **Until O3 is settled, the backend has no `crashLog.js`.** It trusts the sender's parsed fields, and runs the `registers` and `relevantObjects` filters of the table above again on its own (`autoSchema.js` `SECTION_FILTERS`): a line of `registers` is kept only as `<REG> (<type>)`, and in `relevantObjects` every `Name` or `Full Name` value becomes `<name>` and every quoted string other than `File: "<plugin>"` becomes `""`. The shared parser replaces them once the real formats are known.

### 2.5 The `trail` block

```json
"trail": { "source": "memory", "entries": [ ... ], "dropped": 0 }
```

- `source`: `memory` (the client's ring), `file` (`dbo-trail.jsonl`), `file-prev` (`dbo-trail.prev.jsonl`) or `none`.
- `entries`: up to **56**, in the §3.1.3 shape, sorted by `t` ascending.
  - These are the 50 ring entries, plus up to 6 pinned entries that are not already among them (§3.1.5).
  - `hb` entries are **never** included.
  - `crash-on-quit` sends only the last 10.
- `dropped`: optional count of entries left out because of size. The backend adds to it the entries it removes for failing the grammar (§3.1.4).

### 2.6 The `logs` block

```json
"logs": { "gameLog": "..." }
```

- `gameLog` is the tail of `skyrim-platform.log`, scrubbed. SkyrimPlatform writes that file in the SKSE log folder (`main.cpp:96-103`).
  - **Client kinds:** at most 16 KB, only on the first report of a session, and only when `autoReport.trailDir` is set. The log is never in the fallback folder.
  - **Launcher kinds:** at most 32 KB, from the evidence copy (§2.4). A log read at the next launcher start is sent only when its mtime is at most `exit.at` + 60 s.
  - **Read the tail at a file position**, as `report.js:27-38` does; never read the whole file. While a handler throws every frame, the file grows by about 60 lines a second, because `EventsApi.cpp:57-70` logs each occurrence.
  - **Read up to 6 × the cap back**, as the X5 launcher fix `559a98ca` does, because S0 can remove most of what was read. Drop the partial first line of the read window; S0 does this too.
- **What it can hold, and the scrub rules that cover it:**
  - **On the NirnLab browser backend: a `JS …` line for every script run in the game UI and a `LoadUrl …` line for every page load** (`BrowserApiNirnLab.cpp:75`, `:91`; defect X5). These hold chat including `/pm`, system notices, the character name, the voice URL and the start of the voice token. Covered by S0, which drops them whole before any other rule runs.
  - The raw `e.what()` of every failing handler (`EventsApi.cpp:64`). This includes `JSON.parse` snippets of server and chat content (`networkingService.ts:126`). Covered by S20, and by the 500-character line cap (§2.11 step 4).
  - The names of programs in front of the game, logged by ForegroundGuard (`main.cpp:530-531`, `:613-615`, `:623-626`, via `QueryFullProcessImageNameW` at `:504`). Covered by S19.
- Plain `printConsole` output never reaches this file (`networkingService.ts:31`, `ConsoleApi.cpp:35-44`).
- **No other log exists in v1.** The CEF log field (`logs.cefLog`) is removed (design §1b and design §3).

### 2.7 Examples

**`script-error`** (client):

```json
{
  "contractVersion": 1,
  "reportId": "3f1c2b9e-8a41-4d2e-9b7a-0c5d6e7f8a90",
  "kind": "script-error",
  "sender": "client",
  "clientAt": 1790400000123,
  "sentAt": 1790400000456,
  "attempt": 1,
  "queued": false,
  "consent": { "noticeVersion": 1, "errors": true },
  "versions": { "client": "0.3.44", "files": "0.3.44", "launcher": "2.1.30" },
  "build": { "client": "f8cd78971a2b.20260927T101500Z", "front": "f8cd78971a2b.20260927T101500Z", "probe": { "line": 212, "col": 15 } },
  "session": { "start": 1790399000000, "uptimeSec": 1000, "connected": true, "actorId": "ff00012a" },
  "error": {
    "source": "client", "where": "on", "event": "update", "service": null, "handled": false,
    "type": "TypeError",
    "message": "Cannot read properties of undefined (reading 'getFormID')",
    "frames": [ { "fn": "RemoteServer.onUpdate", "line": 48213, "col": 31, "file": null },
                { "fn": null, "line": 47110, "col": 12, "file": null } ],
    "site": { "line": 47102, "col": 9 },
    "count": 1
  },
  "trail": { "source": "memory", "entries": [
    { "t": 1790399950123, "s": 950, "k": "menu", "d": "open InventoryMenu" },
    { "t": 1790399951400, "s": 951, "k": "send", "d": "DropItem 1397d:Skyrim.esm Iron Dagger" },
    { "t": 1790400000120, "s": 1000, "k": "err", "d": "on TypeError: Cannot read properties of undefined (reading 'getFormID')" }
  ] }
}
```

The client sends the message scrubbed but not normalised; the backend normalises it (§6).

**`ui-error`** (client, from the front): the same envelope, with:

```json
"error": {
  "source": "front", "where": "boundary", "event": null, "service": null, "handled": false,
  "type": "TypeError", "message": "Cannot read properties of null (reading 'map')",
  "frames": [ { "fn": "Kt", "line": 2, "col": 183244, "file": "build.js" } ],
  "site": null,
  "componentStack": "at Kt (build.js:2:183100)\nat Ye (build.js:2:201877)\nat Zn (build.js:2:9120)",
  "count": 1
}
```

**`crash`** (launcher):

```json
{
  "contractVersion": 1,
  "reportId": "b7e1d0c2-5f3a-4a8e-8c1d-2e3f4a5b6c7d",
  "kind": "crash",
  "sender": "launcher",
  "clientAt": 1790401000000,
  "sentAt": 1790401021000,
  "attempt": 1,
  "queued": false,
  "consent": { "noticeVersion": 1, "errors": true, "crash": "always" },
  "versions": { "client": "0.3.44", "files": "0.3.44", "launcher": "2.1.30", "game": "1.6.1170.0", "os": "win32 10.0.22631" },
  "build": { "client": "f8cd78971a2b.20260927T101500Z" },
  "session": { "start": 1790399000000, "actorId": "ff00012a" },
  "exit": { "at": 1790401000000, "code": 3221225477, "detectedBy": "wait", "gamePid": 18244,
            "lastHeartbeatAt": 1790400996000, "quitMarker": false, "event": null },
  "crash": {
    "crashAt": 1790400999000, "logName": "crash-2026-09-27-10-16-39.log", "crashLoggerVersion": "1.15.0",
    "exception": "EXCEPTION_ACCESS_VIOLATION",
    "faultModule": "SkyrimPlatform.dll", "faultOffset": "0x1A2B3C", "faultSymbol": "EventsApi::SendEvent", "faultAlid": null,
    "hasOurDll": true,
    "frames": [ { "module": "SkyrimPlatform.dll", "offset": "0x1A2B3C", "symbol": "EventsApi::SendEvent", "alid": null },
                { "module": "SkyrimSE.exe", "offset": "0x5E8F12", "symbol": null, "alid": 37014 } ],
    "sections": { "header": "...", "callStack": "...", "registers": "RAX (size_t)\nRCX (TESObjectREFR*)",
                  "relevantObjects": "...", "modules": "...", "sksePlugins": "...", "plugins": "...", "systemSpecs": "..." }
  },
  "trail": { "source": "file", "entries": [ { "t": 1790400990000, "s": 1990, "k": "world", "d": "enter cell 165a7:Skyrim.esm Dragonsreach" } ] },
  "logs": { "gameLog": "..." }
}
```

**`freeze`:**
- `exit`: `{ "code": 1, "detectedBy": "poll", "lastHeartbeatAt": <exit.at - 45000>, "quitMarker": false, "event": null, ... }`
- No `crash` block.
- A trail and `logs.gameLog`.

**`js-fatal`:**
- `exit.code` is non-zero.
- No `crash` block.
- The last entry other than `hb` is `{ "k": "fatal", "d": "uncaught TypeError" }` or an `err` entry, within 15 s of the exit.

**`crash-nolog`:**
- `exit.code` is `3221226505` (0xC0000409, `__fastfail`), and/or `exit.event` is `{ "id": 1000, "module": "SkyrimSE.exe", "exceptionCode": "0xC0000409", ... }`.
- No `crash` block.

**`crash-on-quit`:**
- `exit.quitMarker` is `true`: the trail ends with `net exit quit` or `net menu-quit`.
- `crash` has no `sections`.
- The trail has the last 10 entries.
- There are no `logs`.

### 2.8 Front to client: the `front:error` message

The front calls:

```js
if (typeof window.skyrimPlatform?.sendMessage === 'function') {
  window.skyrimPlatform.sendMessage('front:error', JSON.stringify({
    v: 1, where, type, message, stack, componentStack, frontBuild: __FRONT_BUILD__, at: Date.now()
  }))
}
```

- **The guard is needed.** Outside the game, `index.js:18-21` creates an empty `window.skyrimPlatform`.
- **The handlers live in their own module, which `index.js` imports first.** Imports run before the body of `index.js`, so the `error` and `unhandledrejection` handlers are in place before `ReactDOM.render` (`index.js:27-34`).
- **The `ErrorBoundary` fallback text MUST NOT say "press F6 to reload"** (design §1b). F6 focuses chat (`browserService.ts:21`, `:168` on client-0344). The text names a key only when a real UI reload key exists.
- **The key must not start with `dbo:`.** `dboRelayService.ts:233-235` forwards those keys to the game server.
- **Size.** The whole string is at most 4096. The front truncates `message` to 1000 and `stack` to 2500 before stringifying.
- **What the front drops:**
  - messages that are exactly `Script error.`;
  - anything without an `Error` object.

  It sends each `(where, type, message, first stack line)` once per page load.
- **What the client does.** It listens on `browserMessage` for `arguments[0] === 'front:error'` and parses `arguments[1]` inside `try/catch`. Then it:
  - builds the §2.3 block with `source: "front"`;
  - parses the frames from `stack`: `build.js` frames keep the base name, and frames from injected code get `file: "<injected>"`;
  - reduces `componentStack` to names with their `build.js` positions (§2.3);
  - sets `build.front = frontBuild`;
  - runs every scrub rule. The front cannot scrub the Windows user or computer name, because CEF does not know them; the client can.
- The UI loads from `file:///Data/Platform/UI/index.html` (`BrowserApiNirnLab.cpp:176`). Whether CEF turns its `window` errors into `Script error.` is open item O14.

### 2.9 Build stamp and bundle positions

- **Client** `DefinePlugin`: `__CLIENT_BUILD__` (the §5.1 build id) and `__CLIENT_VERSION__` (the `CLIENT_VERSION` being released, `version.js:9`). Both come from the pipeline's environment (§5.1).
- **Front** `DefinePlugin`: `__FRONT_BUILD__`. `package.json` still says 1.0.0.
- **Positions.** `line` and `col` refer to the bundle **as SkyrimPlatform evaluates it**.
- **The probe.** When `errorSink.ts` starts, it runs `function __dboStackProbe() { return new Error('__DBO_STACK_PROBE__') }` and reads the first frame. The rule that drops the sink's own frames does not apply here.
  - The frame's `{line, col}` goes in `build.probe`.
  - Its location prefix identifies bundle frames (§2.3).
  - The build step records the bundle line that holds the marker as `probeLine` (§5.4).
  - The backend subtracts `probe.line - probeLine` from every client frame and `site` before it resolves them. This keeps resolution correct if anything shifts the script's lines at load, for example the plugin-source patch hook at `SkyrimPlatform.cpp:230-237`.
  - A missing probe means an offset of 0. Without a probe, no `<anonymous>` frame can be classified, so the client sends `frames: []`. It keeps `site` only if it was read the same way.

### 2.10 Never sent (design §6)

- Chat, `/pm` and letter (pigeon) text, commission text, `/bug` text, board, mail and announcement text.
- Custom-packet payloads and free-form widget arguments. Only packet types and `dbo:` event names are recorded (§3.1.4).
- Other players' names or positions, and names of actors in general. An actor is recorded as `player <hex>` or `npc <desc>`.
- Character names from any source: display names (`getDisplayName`), names of FF-range base forms, and crash-log `Name` values (§2.4).
- Tokens, the session value, IP addresses, the Windows user and computer names, the Discord username, email addresses, and employer or school names in OneDrive paths.
- The names of other programs the player runs (ForegroundGuard lines, S19).
- The CEF log (`cef_debug.log`: the front's `console.log` includes letter text), the crash log's `STACK` section, strings read from memory, minidumps, `threaddump` files, MO2 logs and screenshots.
- Anything from `logError` arguments other than `Error` objects (§3.1.4 `err`).
- The request path of HTTP errors (`event` is only `get` or `post`).
- The game UI lines of `skyrim-platform.log` (`JS …` and `LoadUrl …`, defect X5): chat and `/pm`, notices, the character name, the voice URL and token. S0 drops them from `gameLog` on every sender and again on the backend (§2.11).

**The client MUST NOT:**
- listen to `consoleMessage` or wrap `printConsole`. Console text carries chat and notices, a whole custom packet on a parse error (X6), and before 0.3.47 the session token (X1);
- log any `browserMessage` argument after `arguments[0]`, to the console or to the trail. This is true today: `authService.ts:280` and `:287` (client-0344) log only `[0]`. The trail's `ui dbo <event>` entry keeps only the key (§3.1.4). The one argument read is `front:error`'s `[1]`, which is parsed into the §2.3 block and scrubbed, never logged as it is (§2.8).

### 2.11 Scrub rules

**Where they apply:** every free-text value:
- `error.message` and `error.componentStack`;
- every trail `d`, client and server;
- `logs.gameLog`;
- every `crash.sections` value.

Version fields, ids, build ids, numbers, enums, `fn`, modules and symbols are validated by pattern instead (§2.12). That is why `1.6.640.0` survives.

**One rule file, three engines.**
- The canonical rules live in `skymp5-backend/sources/scrub-rules.json`, an array of `{ "id", "pattern", "flags", "replacement", "fields" }`.
- The launcher and the client carry byte-identical copies:
  - the launcher at `src/scrub-rules.json`, replacing `report.js:11-18`;
  - the client at `src/lib/scrub-rules.json`, imported through webpack (the client tsconfig needs `resolveJsonModule`, §5.2).

  A test compares the SHA-256 of the copies across the three trees.
- Each side has a small engine. Patterns are built with `new RegExp(pattern, flags)` at run time, so the client's ES5 target does not matter; V8 supports lookbehind and `\p{...}`.
- S0, S1, S2 and S21 need line state, run-time values or a mapping, so each engine implements them in code. Their entries in the file have `"pattern": null`.
- All three engines must pass `scrub-cases.json` (§8).
- The launcher and client parts must be dependency-free, ES5-safe JavaScript. The launcher packages only `src/**/*`, and the client compiles to ES5.

**Steps for each field:**
1. Replace `\r\n` with `\n`. Remove C0 control characters except `\n` and `\t`. Remove `\u200b-\u200f`, `\u202a-\u202e` and `\u2066-\u2069`.
2. **Backend (senders MAY do this too):** cut the field to 1.25 × its cap, keeping the same end as step 4, so that no rule runs on more than that.
3. Run the rules below, in order.
4. Cut to the cap. Keep the head of messages, crash sections and trail entries; keep the tail of `gameLog`, cut at a line boundary (the partial first line left by the cut is dropped). **In `gameLog`, every line is also cut to 500 characters** here, after the rules have run and before the cut to the cap, without splitting a surrogate pair. This bounds an exception line (`EventsApi.cpp:64`) that carries packet or chat text in its message.

**Rules, in order:**

0. **S0. Game UI lines** (`gameLog` only; defect X5). On the NirnLab browser backend, SkyrimPlatform logs the start of every script it runs in the game UI and every page it loads, and those lines hold chat, `/pm`, notices, the character name and the voice URL. S0 runs first, so that no auto payload ever carries them, whatever browser backend the player uses.
   - **A record** is one line that starts with a timestamp, `^\[\d\d:\d\d:\d\d:\d{3}\] ` (the only pattern, set at `main.cpp:120` before the first line), plus every following line that does not. Lines are split on `\n` only, after step 1; a `\r` or U+2028 inside a line does not start a new one.
   - **Text before the first timestamped line is dropped,** with no `[N UI line(s) left out]` line for it. It is the rest of a record cut by the read window or by the step 2 pre-cut, and it may be the tail of a UI line. A `gameLog` with no timestamped line therefore becomes empty.
   - **A record whose first line matches `^\[\d\d:\d\d:\d\d:\d{3}\] (?:JS|LoadUrl) ` is dropped whole**, its continuation lines included. `LoadUrl` logs the whole URL with its newlines (`BrowserApiNirnLab.cpp:75`), so a `data:` URL can span several lines. The `JS` line is always one line (`:83-91` replaces `\n`), but the same rule covers it.
   - Each run of dropped lines becomes one line, `[N UI line(s) left out]`, as the X5 launcher and backend filters write it.
   - S0 runs in linear time. The launcher also runs it when it makes the evidence copy (§2.4).
1. **S1. Literal folders.**
   - The game folder becomes `<game>`: `process.cwd()` in the client, the install path in the launcher.
   - The Documents folder becomes `<docs>`: `app.getPath('documents')` in the launcher; in the client, `trailDir` up to `\My Games`.
   - Both slash styles, case-insensitive, built from an escaped literal.
   - Skipped for paths shorter than 6 characters.
2. **S2. Literal names.** Built from escaped literals, longest first, case-insensitive:
   - The Windows user name becomes `<user>` (`os.userInfo().username`; `process.env.USERNAME`). So does the home folder's base name (`os.homedir()`; `process.env.USERPROFILE`), which differs from the user name after an account rename.
   - The computer name becomes `<pc>` (`os.hostname()`; `process.env.COMPUTERNAME`).
   - The logged-in player's Discord username becomes `<discord>`. It is auth data `discordUsername` (`main.js:3341`); on the backend, the session's `username`.
   - Client only: the player's own character name, and the display names of players seen this session (the latest 100), become `<player>`.
   - A name is skipped when it is shorter than 3 characters, or when it is one of: `user`, `admin`, `administrator`, `owner`, `pc`, `desktop`, `laptop`, `windows`, `skyrim`, `steam`, `games`, `data`, `default`, `public`, `guest`.
   - A 3-character name is matched only between word boundaries.
3. **S3-S10. The existing backend rules, `scrubLog.js:6-20`, in their order:**
   - Windows `Users` paths;
   - `/home` and `/Users` paths;
   - Nexus `key=` and `nmm_key=`;
   - `expires=` and `user_id=`;
   - `Bearer` tokens;
   - labelled credentials;
   - Discord bot tokens;
   - long hex runs (8 characters kept, then `<redacted>`).
4. **S11. The session JSON value:** `/("session"\s*:\s*")[^"]*"/g` becomes `$1<redacted>"`.
5. **S12. Email** (linear time):
   `/(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,24}(?![A-Za-z0-9-])/g` becomes `<email>`.
6. **S13. Discord mention:** `/<@!?\d{15,21}>/g` becomes `<discord>`.
7. **S14. Player tag.** `/(?:[\p{L}\p{N}'_-]{1,32} ){0,2}#[A-HJ-NP-Z2-9]{4}\b/gu` becomes `<player>`. This matches the `Name #TAG` of `display()` (`gamemode.js:156`), using the tag alphabet of `gamemode.js:144`.
8. **S15. OneDrive organisation:** `/(OneDrive)\s*-\s*[^\\\/\r\n"<>|]+/gi` becomes `$1 - <org>`.
9. **S16. IPv4, only where it cannot be a version number:**
   `/(?<![\w.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?::\d+)?(?!\w|\.\w)/g` becomes `<ip>`. It catches an address at the end of a sentence.
10. **S17. IPv6, full form.** Requires a digit:
    `/(?<![\w:.])(?=[0-9a-fA-F:]*\d)(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}(?![\w:]|\.\w)/g` becomes `<ip>`.
11. **S18. IPv6, compressed form.** Requires `::` and a digit:
    `/(?<![\w:.])(?=[0-9a-fA-F:]*\d)(?:[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{1,4}){0,5})?::(?:[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{1,4}){0,5})?(?![\w:]|\.\w)/g` becomes `<ip>`.
    - `RE::Actor::Add`, `std::vector`, `D3D11::Create`, `BSScript::Internal` and `12:34:56` survive.
    - A rare all-hex C++ name with a digit, such as `BA::B1`, is scrubbed by mistake. That is the safe direction.
12. **S19. Foreground programs:** `/class '[^'\r\n]{0,256}' pid (\d{1,10}) \([^)\r\n]{0,260}\)/g` becomes `class '<app>' pid $1 (<app>)`.
13. **S20. JSON snippets in any text.** This rule is keyed on the text, not on the error type. It therefore also covers `gameLog`, crash sections, server trails, and a JSON error wrapped in another error's message:
    - `/Unexpected token [^\r\n]{0,160}? is not valid JSON/g` becomes `Unexpected token in JSON`;
    - `/"[^\r\n]{0,160}?"(?:\.\.\.)? is not valid JSON/g` becomes `<s> is not valid JSON`.
14. **S21. JSON.parse canonical form** (`error.message` and trail `err` only).
    - It applies to a `SyntaxError` whose message contains `JSON`.
    - The message becomes exactly one of these forms, picked by prefix:
      - `Unexpected token…` → `Unexpected token in JSON`
      - `Unexpected end of JSON input…` → `Unexpected end of JSON input`
      - `Unterminated string…` → `Unterminated string in JSON`
      - `Bad control character…` → `Bad control character in JSON`
      - `Expected …` → `Expected token in JSON`
      - anything else → `Invalid JSON`
    - Reason: `authService.ts:442` parses the file that holds the session, and Node puts a snippet of the input in the message.

**Cost.** Every rule runs in linear time on its input, and §8 has a timing fixture. The old email rule took 16.9 s on 128 KB of `a`. S12 replaces it and takes 1 ms.

### 2.12 Backend validation (for information)

**Hardening:**
- Stored records are built from known keys only, never by spreading or deep-copying the body. This covers `__proto__` and deep nesting.
- Every integer must pass `Number.isSafeInteger` and must not be negative. `count`, `n`, `line` and `col` are at most 10,000,000.
- **Times outside [2025-01-01, receipt + 1 day] are not refused.** The report is flagged `clockSuspect`, and the join uses the receipt time (§3.3).
- Strings go through step 1 of §2.11.
- **Build and version must agree.** If the archived meta for `build.client` has a `clientVersion` other than `versions.client`, the report is flagged `suspect` and its group is held.

**422 (`schema`):**
- a missing required field, or a wrong type;
- an unknown `kind`, `where`, `detectedBy` or `source`;
- a `sender` that does not match the kind;
- a `reportId`, version, build id, `type` or `exception` that does not match its pattern, or an `error.type` that passes its pattern but that a rule below would change;
- `attempt` outside 1-5;
- more than 12 `error.frames`, or more than 24 `crash.frames`.

**422 (`contractVersion`):** any version not listed in `autoReport.contract`.

**422 (`consent`):**
- `consent.noticeVersion` is missing or below 1 (the second D2 guard);
- `script-error`, `ui-error`, `js-fatal` or `freeze` with `consent.errors !== true`;
- `crash` or `crash-nolog` with `consent.crash` other than `"always"` or `"once"`;
- `crash-on-quit` with `consent.crash !== "always"`.

The `consent` object is stored with each report.

**Removed and flagged `invalidField`, not refused:**
- An optional or nullable field that fails its rule, such as `fn`, a frame's `module` or `symbol`, `faultSymbol`, `crashLoggerVersion`, `versions.files`, `service` or `site`.
- A name that reaches a group title or key, or `versions.os`, that passes its pattern but that any §2.11 rule without run-time values (S3-S20) would change: a path with a user name, an email, an IP address, a token or a long hex run. These values reach group titles and keys, which outlive the reports. The names are `error.frames[].fn` and `.file`, `error.event`, `error.service`, a crash frame's `module` and `symbol`, `crash.faultModule`, `crash.faultSymbol` and `exit.event.module`.
- A frame or `site` whose line is below 1 after the probe correction.

Every `invalidField` report counts toward the invalid-payload mute (design §7), and so does every 422 `schema`. A 422 `consent` or `contractVersion` does not count: it is a stale setting or an old sender, not a forgery.

**Trail grammar:**
- Each entry's `d` must match the pattern for its kind (§3.1.4, §3.2.3).
- An entry that does not match is removed and counted in `trail.dropped`.
- The join applies the same check to server entries.

**Truncated, not refused:** strings over their cap, and trail entries beyond 56 (the last 56 are kept). The report is flagged `truncated`.

**Stored as metadata only, not counted and not posted (`ignored`):**
- a `ui-error` with the message `Script error.` (`opaque`);
- a launcher kind with no DragonBreak trail entry within [event - 60 s, event], re-checked from `trail.entries` (`no-dbo-trail`);
- a `crash.crashAt` more than 7 days before receipt, after the skew correction (`too-old`). When there is no crash block, `exit.at` is checked instead;
- a launcher kind while `crashWatch` is `false` (`crash-watch-off`, §1.8), which only a pre-release launcher sends.

"Metadata only" means that no `logs`, no `crash.sections` and no trail entries are kept.

**Counted with no thread:** a `versions.client` outside the known list (the current version plus the last 10) is counted under `unknown-version` (design §7). The list is `CLIENT_VERSION` of `routes/version.js` plus the 10 newest `clientVersion` values of the archived client metas (§5.4), re-read at most once a minute. Such a report is stored but not grouped, and no map is loaded for it. A launcher report without `versions.client` is grouped as usual.

**New signatures (design §7):** a profile's first 5 distinct new signatures in a UTC hour, and 15 new groups in a UTC day, open groups. Its other new signatures are stored and count nowhere; they count toward a group once another profile opens it. Signatures are computed after the 202, so the caps apply where a group would be created, not in the request.

**Over the per-profile daily byte budget (2 MB):** the report is accepted with `logs` and `crash.sections` removed. Only the metadata and the trail are kept.

**A muted profile** gets a plain 202; its reports are not counted. A profile is muted for 24 hours after more than 15 distinct new signatures, or more than 20 invalid payloads, in one hour (`AUTO_REPORT_MUTE_*`). While it is muted, the body is neither validated nor stored.

---

## 3. Breadcrumb trails

### 3.1 Client trail (`BreadcrumbService`)

#### 3.1.1 Files and location

- **Folder `D`:**
  - Settings `autoReport.trailDir` (§4), when it is an absolute path to an existing directory. The launcher sets it to the SKSE log folder that holds `skyrim-platform.log`: `<Documents>\My Games\<variant>\SKSE`.
    - It picks the variant as `report.js:44-68` does, by the most recently written `skyrim-platform.log`, using the variant names at `main.js:1376-1381`.
    - **First run, no log yet:** it picks the variant from `mo2.detectEdition(gamePath)` (`mo2.js:278-287`) and creates the folder. The mapping is:
      - `Steam` → `Skyrim Special Edition`;
      - `GOG` → `Skyrim Special Edition GOG`;
      - `Epic Games` → `Skyrim Special Edition EPIC`;
      - `Microsoft Store` → `Skyrim Special Edition MS`.
    - This folder is under Documents, outside MO2's virtual file system.
  - Otherwise `Data/Platform/Logs/`, relative to the game folder.
    - The client's working directory is the game folder, as `sweetCameraEnforcementService.ts:46` relies on. SkyrimPlatform's own `writeLogs` writes there too (`ConsoleApi.cpp:406`).
    - **Under MO2 these writes land in `<MO2 root>\overwrite\Platform\Logs\`** (the instance's `overwrite_directory`, `mo2.js:297`), not in the game folder. The launcher's search list covers this folder (§3.1.8).
- **Files in `D`:**
  - `dbo-trail.jsonl`: the current session.
  - `dbo-trail.prev.jsonl`: the session before.
  - `dbo-pending/<reportId>.json`: the client queue (§1.7).
  - `dbo-sent.jsonl`: the last 10 payloads the client sent (§4.5).
  - `dbo-consent.json`: written by the launcher (§4.3).
- The client writes through Node `fs`, which is available in the client (`authService.ts:2`).

#### 3.1.2 Header

The first line of `dbo-trail.jsonl` is the header:

```json
{"h":1,"v":1,"pid":18244,"sessionStart":1790399000000,"clientVersion":"0.3.44","build":"f8cd78971a2b.20260927T101500Z","profileId":123,"actorId":null}
```

| Field | Rule |
|---|---|
| `h` | Always `1`; this marks the header |
| `v` | Trail format version, `1` |
| `pid` | `process.pid` of the game |
| `sessionStart` | When the client script loaded |
| `clientVersion` | `__CLIENT_VERSION__` |
| `build` | `__CLIENT_BUILD__` |
| `profileId` | int or `null`: `masterApiId` from the auth data, or `gameData.profileId`. It is `null` when the player logs in inside the game; the header is then rewritten at `net login ok`. |
| `actorId` | hex or `null`: the `refrId` of the `CreateActor` message with `isMe: true` (`createActorMessage.ts:28`), as a server id. The header is rewritten when it becomes known. |

#### 3.1.3 Entry

```json
{"t":1790399950123,"s":950,"k":"menu","d":"open InventoryMenu"}
{"t":1790399960000,"s":960,"k":"recv","d":"CustomPacket dboHud","n":12}
```

| Field | Rule |
|---|---|
| `t` | When it happened. For a collapsed entry, the time of the **latest** occurrence. |
| `s` | `floor((t - sessionStart) / 1000)` |
| `k` | A kind from §3.1.4 |
| `d` | A string of at most 160, matching the kind's grammar, scrubbed. Empty only for `hb`. |
| `n` | int from 2 to 10,000,000 when collapsed; left out when 1 |

#### 3.1.4 Kinds and their `d` grammar (allow-list)

**Rule R for naming a target:**
- **A non-actor reference whose base form id is below `ff000000`:** `<baseDesc> <baseName>`.
  - The name comes from the base form's `getName()`. It is scrubbed and cut to 40 characters.
  - It is left out when it is empty or does not match `NAME` (below), so the entry still passes the grammar.
- **A non-actor reference with an FF-range base:** `<baseDesc>` only (the hex). These can be player-made or player-named items.
- **The player's own actor:** `self`.
- **An actor the client knows to be another player:** `player <hex>`, the server id from `localIdToRemoteId` and `isRemotePlayerCharacter` (`worldViewMisc.ts:15`, `:53`).
- **Any other actor:** `npc <baseDesc>`.
- **Never** `getDisplayName`, and never any actor name.
- Descs are cached per form id, at most 2,000 entries.

**Cost rules for every kind:**
- **Build each `d` string inside the event handler.** Native objects (forms, references, actors) expire at the end of the frame, so no string is built later from a stored object.
- **The listeners never throw.** BreadcrumbService's emitter listeners run synchronously in the send path, and `sendInputsService` sends for every hosted NPC every frame. Each listener body is in `try/catch`.

**Kinds:**
- **`net`:** `connecting`, `connected`, `disconnected`, `login ok`, `login denied <code>` (`<code>` matches `[A-Za-z]{1,32}`), `reconnect <n>`, `exit quit`, `exit kick`, `exit auth` or `menu-quit` (§2.4). The `exit …` entries are written synchronously right before `exitProcess()`.
- **`send`:** `<MsgType>` or `<MsgType> <target>` (rule R), with the `MsgType` enum name (`messages.ts:1-37`).
  - **Listen** to the emitter events `sendMessage` and `sendMessageWithRefrId` (`networkingService.ts:16-18`), and switch on the numeric `t` first.
  - **Register the `sendMessageWithRefrId` listener before NetworkingService's own** (`networkingService.ts:18`). That listener deletes `_refrId` from the message (`:58` on client-0344), so a later listener cannot name the target.
  - **Recorded types only:** `Activate`, `PutItem`, `TakeItem`, `DropItem`, `CraftItem`, `OnEquip`, `ConsoleCommand`, `CustomPacket`, `OpenContainer`, `SpellCast`, `PlayerBowShot`. Frequent types such as `UpdateMovement`, `Host`, `FinishSpSnippet`, `UpdateProperty` and `OnHit` are never recorded.
  - **`CustomPacket`:** `CustomPacket <type>`, where `<type>` is the content's `customPacketType` or `type`.
    - The `dbo` relay becomes `CustomPacket dbo <event>`.
    - Chat (`cef::chat:send`, `chatService.ts:340-346`) becomes `CustomPacket chat`, or `CustomPacket chat /<word>` with `<word>` matching `[a-z]{1,16}`. Speech and `/pm` text are never recorded.
  - **`ConsoleCommand`:** `ConsoleCommand <word>`, where `<word>` is the leading `[A-Za-z]{1,24}` of the command.
- **`recv`:** filter on the type **before** building any string.
  - Listen to the typed emitter events (`networkingService.ts:133-200`), not `anyMessage`.
  - Recorded: `CreateActor`, `DestroyActor`, `Teleport`, `Teleport2`, `SetInventory`, `SetRaceMenuOpen`, `SpSnippet <class>.<method>`, `CustomPacket <type>`, `DeathStateContainer`, `HostStart`, `HostStop` and `UpdateGamemodeData`. Everything else is skipped.
  - For `CustomPacket`, take the type with a regex on the first 256 characters of `contentJsonDump`, without `JSON.parse`.
  - Binary messages go to `anyRawMessage` (`networkingService.ts:124-131`) and are never recorded.
- **`menu`:** `open <MenuName>` or `close <MenuName>`, with the SkyrimPlatform menu name. `Cursor Menu`, `HUD Menu`, `Fader Menu` and `Mist Menu` are never recorded.
  - A menu name can contain `/`: `Sleep/Wait Menu` (`ConstEnumApi.cpp:563`), the likeliest last menu before a freeze. It is the only one of the 36 names outside `[A-Za-z0-9 _]`.
- **`world`:** polled in the 1 s flush.
  - `enter cell <desc> <name>` for an interior cell.
  - `enter ws <desc> <name>` when the worldspace changes (not for every exterior cell).
  - `<name>` is the game-data name, at most 40, only for ids below `ff000000`. It is left out when it does not match `NAME`.
  - `teleport <desc>` and `loadGame`.
- **`act`:** `<verb> <target>` (rule R).
  - The verbs are `activate`, `open`, `read`, `eat`, `use`, `equip`, `unequip`, `drop`, `take`, `craft`, `cast`, `hit` and `shoot`.
  - `hit`, `equip`, `unequip`, `activate` and `containerChanged` fire for every actor and container. Check the numeric ids first (the player is 0x14), and only then call `getBaseObject()` or `getName()`.
- **`life`:** `death`, `downed`, `revived`, `respawn` or `ragdoll`.
- **`inv`:** `add <desc> x<n>`, `remove <desc> x<n>` or `set <n> entries`.
  - `set <n> entries` is recorded once, while a `SetInventory` is being applied. The items it adds or removes are not recorded one by one.
- **`ui`:** `front-loaded`, `reload`, `widget open <type>`, `widget close <type>`, `focus <type>`, or `dbo <event>`. `dbo <event>` is the browser's `dbo:` key without its arguments; keys are built at run time, for example at `labour/index.tsx:132`.
- **`err`:**
  - `<where> <Type>: <message>`, with the message scrubbed (S21 included) and cut to 100 characters;
  - or, for `logError`, `logged <Service>`. When an argument is an `Error`, `: <Type>: <message>` is added, with the message cut to 80. **No other `logError` argument is ever written.**
- **`fatal`:** `uncaught <Type>` or `rejection <Type>`, written synchronously by the process hooks.
- **`hb`:** `c` while connected to the game server, otherwise an empty string.

**Grammar the backend enforces** (§2.12). Placeholders:
- `DESC`: see Conventions.
- `NAME`: `[\p{L}\p{N} '.,:()-]{1,40}` (flag `u`).
- `TGT`: `(?:self|player [0-9a-f]{1,8}|npc DESC|(?!ff[0-9a-f]{6} )DESC(?: NAME)?)`. The lookahead enforces rule R: an FF-range desc never carries a name.
- `TOK`: `[A-Za-z0-9_:.-]{1,40}`.
- `TYPE`: the §2.3 `type` pattern.
- `SVC`: `[A-Za-z0-9_$]{1,64}`.

```
net    (?:connecting|connected|disconnected|login ok|login denied [A-Za-z]{1,32}|reconnect \d{1,4}|exit (?:quit|kick|auth)|menu-quit)
send   (?:CustomPacket (?:dbo TOK|chat(?: /[a-z]{1,16})?|TOK)|ConsoleCommand [A-Za-z]{1,24}|[A-Z][A-Za-z0-9]{1,39}(?: TGT)?)
recv   (?:SpSnippet [A-Za-z0-9_]{1,40}\.[A-Za-z0-9_]{1,40}|CustomPacket TOK|[A-Z][A-Za-z0-9]{1,39})
menu   (?:open|close) [A-Za-z0-9 _/]{1,40}
world  (?:enter (?:ws|cell) (?!ff[0-9a-f]{6} )DESC(?: NAME)?|teleport DESC|loadGame)
act    (?:activate|open|read|eat|use|equip|unequip|drop|take|craft|cast|hit|shoot) TGT
life   (?:death|downed|revived|respawn|ragdoll)
inv    (?:(?:add|remove) DESC x\d{1,6}|set \d{1,5} entries)
ui     (?:front-loaded|reload|(?:widget open|widget close|focus|dbo) TOK)
err    (?:(?:on|once|hook|http|uncaught|rejection|window|promise|boundary) TYPE(?:: .{0,100})?|logged SVC(?:: TYPE: .{0,80})?)
fatal  (?:uncaught|rejection) TYPE
hb     c?
```

A new `d` form needs a matching change to this grammar, deployed on the backend first (§7).

#### 3.1.5 Ring, collapse and pins

- **Ring:** 50 regular entries.
- **Collapse.** When a new entry has the same `k` and `d` as the newest ring entry, it takes no new slot. Instead, that entry's `n` goes up by one (starting from 2), and its `t` becomes the new time.
  - **A collapsed repeat is never written at once,** whatever its kind. The next 1 s batch restates the entry as one line with its current `n`. Otherwise a `logError` called every frame would mean a synchronous write every frame.
  - **Replay rule:** a line with `n` whose `k` and `d` match the newest entry **sets** that entry's `n` and `t`; it does not add to them.
- **Pins that never roll off** keep the latest entry of each of: `world`; `world teleport…`; `menu`; `life death`; `net`; `err` or `fatal`; `hb`.
- **In a payload:** the ring plus the pins that are not already in it, sorted by `t`, at most 56. The `hb` pin is never sent.
- **Shared code.** The ring, pin and replay logic is one pure function, `applyEntry(state, entry)`. It is dependency-free and ES5-safe, and it is copied into the client and the launcher. The client uses it live; the launcher replays the file through it (§3.1.8).

#### 3.1.6 Writing

- **Open the file once** with `fs.openSync(path, 'a')` and write with `fs.writeSync`.
  - `appendFileSync` opens and closes the file on every line, and antivirus scans on close.
  - Close and reopen around the rewrite and the rotation.
- **Written at once:** the first occurrence of `err`, and every `fatal`, `net`, `menu`, `life` and `hb` entry. Any batched lines are flushed first, so the file stays in order.
- **Batched:** all other kinds and every collapsed repeat, written once a second from `tick`.
- **Heartbeat:** every 10 s, from `tick`. `tick` also runs in the main menu (`SkyrimPlatform.cpp:133-135`), where `update` does not (`characterSelectService.ts:211`).
- **Rewrite.** The file is rewritten with the header, the ring and the pins (tmp then rename) when:
  - `actorId` or `profileId` becomes known; or
  - the file passes 256 KB.
- **Write failures.** After 3 consecutive failures, stop writing for the rest of the session. The ring in memory carries on.
- **The trail is written only when** `autoReport` exists and `autoReport.trail !== false` (§4).
- **State survives hot reloads.**
  - SkyrimPlatform reloads every plugin when a file in its plugin folders changes (`Settings.h:177-182`, `SkyrimPlatform.cpp:115-131`, `:322-331`).
  - The launcher's hotkey and preference saves already rewrite the settings file there mid-game (`main.js:500-541`).
  - So keep this state on `globalThis.__dboAutoReport`, and reuse it when its `pid` equals `process.pid`: the seen set, the session caps, the ring, the pins, the open file, the outstanding request and the hook flags.

#### 3.1.7 Rotation

When the client script starts:
- If `dbo-trail.jsonl` exists and its header `pid` equals `process.pid`, this is a hot reload in the same game. Keep appending.
- Otherwise rename it to `dbo-trail.prev.jsonl`, replacing any older one, and start a new file with a new header.

#### 3.1.8 Reading (launcher)

- **Search list,** in order:
  1. the `trailDir` the launcher wrote;
  2. `<gamePath>\Data\Platform\Logs`;
  3. `<MO2 root>\overwrite\Platform\Logs`, when MO2 is in use;
  4. each `<Documents>\My Games\<variant>\SKSE`.

  At a game exit, the launcher reads the evidence copy (§2.4) made from this list.
- **Pick the file.** Read every `dbo-trail.jsonl` and `dbo-trail.prev.jsonl` found.
  - Take the one whose header `pid` equals `exit.gamePid`.
  - With no pid, take the one with the latest `sessionStart` at or before `exit.at`.
- **Profile check.** Use `source: "none"` when the header `profileId` is `null` or differs from `store.get('gameProfileId')`.
- **Bad lines.** Skip any line that does not parse. A crash in the middle of a write leaves a partial last line.
- **Build the entries.** Replay the lines through `applyEntry` (§3.1.5). Use the `hb` pin for `exit.lastHeartbeatAt` and for the freeze rule, then remove it.

#### 3.1.9 The "DragonBreak entry" rule (single-player filter)

A trail proves a DragonBreak session near an event at time E when it holds at least one entry with `t` in [E - 60 s, E] that is either:
- a `net`, `send` or `recv` entry; or
- an `hb` entry whose `d` is `c`.

Without one, the launcher sends nothing, and the backend marks the report `no-dbo-trail`.

### 3.2 Server trail (`trail.js`, gameplay)

#### 3.2.1 Path, permissions and rollout

- One file per session: `/var/lib/dbo-monitor/trails/<profileId>/<sessionStart>.json`.
  - `profileId` is `profileOf(a)` (`gamemode.js:137`), recorded only when it is ≥ 0.
  - `sessionStart` is the `connectedAt` time set in `onCharacterReady` (`gamemode.js:1017-1018`).
- **Modes.**
  - `trail.js` sets `trails/` and each profile folder to 0700 with an explicit `chmod`, at load and on creation. This is needed because `mkdir` does not change an existing folder, `/var/lib/dbo-monitor` is 0755, and the umask is 0022.
  - Files are written with `{ mode: 0o600 }`. (`debugsnap.js:63` passes no mode.)
- **Logging.** The game server, the backend and dbo-monitor all run as root in CT 115. dbo-monitor reads only its own `state.json` (`dbo_monitor.py:21-22`) and tails the server log. So `trail.js` MUST NOT log a line per entry; it logs only load and failure lines.
- **Rollout.** P1 ships with disk writes off (`cfg.trail.write: false`, rings in memory only) until the P2 notice and the website text are live.

#### 3.2.2 Session file shape

```json
{
  "v": 1,
  "profileId": 123,
  "actorId": "ff00012a",
  "sessionStart": 1790399010000,
  "updatedAt": 1790400005000,
  "endedAt": null,
  "endReason": null,
  "entries": [
    { "t": 1790399990000, "k": "act", "d": "activate 1a2b3:Skyrim.esm ok" },
    { "t": 1790399995000, "k": "inv", "d": "refused itemguard 3eadd:Skyrim.esm", "n": 3 }
  ],
  "view": null
}
```

- **`endReason`:** `null`, `disconnect` or `stale`.
- **`view`** is set once, at disconnect. It is **name-free**, so it is not `playerView` as written:
  - `playerView` puts `name: display(p)` at `debugsnap.js:28`, and puts other players' names in `host` at `debugsnap.js:23` and `:38`.
  - Shape: `{ "world", "pos": [x, y, z], "terrainDz", "npcs": [ { "id", "base", "dist", "dead", "host" } ], "hosting" }`.
  - At most 12 `npcs`. `host` is one of `self`, `player <hex>`, `nobody` or `null`.
  - Players are never in `npcs`, as in `debugsnap.js:32`.
- **`entries`** hold at most 50, with the same collapse rule as §3.1.5 and no pins. `t` is the server clock.

#### 3.2.3 Server kinds and their `d` grammar

**Targets** (`STGT`):
- a player: `player <hex>`, where `<hex>` is the player's **actor** form id (`hex()`, `debugsnap.js:19`), never the profile id;
- an NPC: `npc <baseDesc>`;
- an object: `<baseDesc>`, the form description, as in `debugsnap.js:36`.

Names are never used, and neither is the `Name #TAG` from `display()` (`gamemode.js:156`).

**Kinds:**
- **`net`:** `connect` or `disconnect`.
- **`act`:** `activate <target> ok`, `activate <target> refused`, or `activate <target> refused:<reason>`.
- **`hit`:** `refused <reason> <target>`.
- **`life`:** `death`, `death by <target>`, `downed`, `collapsed` or `revived`.
- **`spell`:** `cast <spellDesc>`.
- **`inv`:** `take <baseDesc> x<n>`, `eat <baseDesc>`, `read <baseDesc>`, `craft <baseDesc>`, `alchemy <baseDesc>`, or `refused <guard> <baseDesc>`.
- **`equip`:** `equip <baseDesc>` or `unequip <baseDesc>`.
- **`console`:** the leading `[A-Za-z]{1,24}` of the command, otherwise `?`.
- **`chat`:** `chat`, `pm`, or `/<word>`. `/<word>` is used only for commands registered with `registerChatCommand` (`debugsnap.js:15`); any other command is `/?`.
- **`pkt`:** `<customPacketType>`, or `dbo <event>` (no arguments).
- **`widget`:** `open <type>` or `close <type>`.
- **`world`:** the new `worldOrCellDesc`.

**Grammar.** `trail.js` checks it before recording, and the backend checks it again at the join. Placeholders: `REASON` = `[A-Za-z0-9_-]{1,32}`; `STGT` = `(?:player [0-9a-f]{1,8}|npc DESC|DESC)`.

```
net      (?:connect|disconnect)
act      activate STGT (?:ok|refused(?::REASON)?)
hit      refused REASON STGT
life     (?:death(?: by STGT)?|downed|collapsed|revived)
spell    cast DESC
inv      (?:take DESC x\d{1,6}|(?:eat|read|craft|alchemy) DESC|refused REASON DESC)
equip    (?:equip|unequip) DESC
console  (?:[A-Za-z]{1,24}|\?)
chat     (?:chat|pm|/[a-z]{1,16}|/\?)
pkt      (?:dbo TOK|TOK)
widget   (?:open|close) TOK
world    DESC
```

#### 3.2.4 Writing

- **In memory:** `globalThis.__dboTrail = { rings: Map<profileId, { sessionStart, actorId, entries, dirty }>, writing, seq }`.
  - The state survives gamemode reloads (about 60 a day).
- **Load position.** `gamemode.js` loads `trail.js` last: after the `movetrace.js` loader (`gamemode.js:3378-3383`), the last loader today, and not beside debugsnap (`:3221-3226`).
  - `supernatural.js`, `downed.js`, `regions.js` and `alchemy.js` load after debugsnap (`:3337-3369`) and wrap hooks themselves. trail's wrapper must be the outermost one to see their verdicts.
  - The loader passes a context object, as it does for debugsnap (`:3225`): at least `mp`, `log`, `every`, `profileOf`, `cfg` and the `commands` registry (`:336-337`). trail.js records `/<word>` only for commands in that registry (§3.2.3).
- **Wrap again on every load.** Keep-once guards (the pattern at `downed.js:452`) are wrong for these hooks, because `gamemode.js` assigns them again on every reload: `onActivate` (`:699`, `:748`), `onEatItem` (`:1307`), `onDeath` (`:2391`), `onHitDamage` (`:2408`), `onConsoleCommand` (`:2442`), `onTakeItem` (`:2486`) and `onSpellCast` (`:2512`). A kept original would hold an old gamemode function, and a wrap done once is lost at the first reload. So on every load, for each hook:
  1. if the current `mp.onX` is trail's own wrapper (it carries a marker property such as `__dboTrail`, and keeps the function it wraps), unwrap it;
  2. wrap the current `mp.onX`.

  This leaves exactly one trail wrapper, around the current function.
- **Explicit calls where a wrapper cannot see.** trail.js defines `globalThis.__dboTrailRec(who, k, d)`, where `who` is `{ actorId }` or `{ userId }`. It checks `d` against the §3.2.3 grammar and never throws. Callers use `globalThis.__dboTrailRec?.(…)`, so gameplay runs unchanged when trail.js failed to load.
  - **Refusal reasons** are decided inside the checks, where no outer wrapper can see them. The item guards (`itemguards.js`, loaded at `gamemode.js:2469-2474`; `inv refused <guard> <desc>`), the hit checks (`hit refused <reason> <target>`), the craft checks (`inv refused <reason> <desc>`) and the activate checks (`activate <target> refused:<reason>`) call it where they refuse.
  - **`connect`, `disconnect` and `customPacket`** are single slots in `globalThis.__dboHandlers` (`gamemode.js:785-791`, `:1074`, `:1095`) that gamemode.js fills again on every load, so there is nothing stable to wrap. Those handlers call it for `net connect`, `net disconnect` and `pkt …`.
- **Flush every 5 s**, only for rings that changed, with `every('trail', 5000, …)` (`gamemode.js:46`). `every` stops the timer of the same name first, so a reload never adds a second flush loop.
  - Write **asynchronously**: `fs.promises.writeFile(tmp, data, { mode: 0o600 })` to a unique tmp name (`<file>.<pid>.<seq>.tmp`), then `rename`, one write at a time. `seq` lives on `globalThis.__dboTrail`, so a reload never reuses a tmp name.
  - `debugsnap.js:54-68` moved `live.json` to this pattern after a synchronous write froze the server for 549 ms. The synchronous tmp-then-rename at `debugsnap.js:49-52` is not used for trails.
- **On disconnect** (the explicit call in `__dboHandlers.disconnect`, `gamemode.js:1095-1096`), set `endedAt`, `endReason: "disconnect"` and `view`, and write at once, still asynchronously.
- **One owner for hooks.** Hooks shared with the p2p logging module (hits, downs, trades) must be wrapped only once. See D12 and O9.

#### 3.2.5 Janitor and retention

Every 10 minutes the janitor:
- deletes session files whose mtime is more than 24 h old;
- keeps at most the newest 5 per profile;
- removes empty profile folders;
- marks a session stale when its file has `endedAt: null`, an `updatedAt` more than 10 minutes old, and its player is not online. It sets `endedAt = updatedAt` and `endReason: "stale"`.

### 3.3 Join (backend)

**Not built yet.** It has no data before P2, since `trail.js` writes nothing to disk until then (§3.2.1). It is a later backend step, after P1 and P2; until it lands, stored reports carry no `serverTrail`.

- **When:**
  - client kinds: at least 15 s after receipt (the 5 s write cycle plus a margin);
  - launcher kinds: at least **90 s** after receipt (45 s of silence before LEAVE, then the disconnect write).
- **Anchor time T:**
  - client kinds: `clientAt + (receivedAt - sentAt)`;
  - launcher kinds: `(crash.crashAt ?? exit.at) + (receivedAt - sentAt)`;
  - when the skew is more than 24 h, or the report is already `clockSuspect`, the receipt time is used instead and the report is flagged `clockSuspect`.
- **Choosing the session.**
  - Among the files in `trails/<session profileId>/`, choose those whose window `[sessionStart - 60 s, (endedAt ?? updatedAt) + 60 s]` contains T.
  - When several match, take the latest `sessionStart`.
  - When none match, `serverTrail` is `none`.
  - A queued report that arrives after the 24 h retention gets `expired`.
- **What is attached:**
  - the entries with `t` in [T - 180 s, T + 15 s] that pass the §3.2.3 grammar;
  - `view`, when `endedAt` is at most T + 120 s;
  - all of it scrubbed with §2.11 and capped at 12 KB;
  - rendered as `server-trail.txt`, with the last 8 lines inline (§6.1).
- **Storage.** The join result is stored with the report and kept for the report's retention (§6.3). Session files are never copied whole.

---

## 4. Client settings and consent

### 4.1 Keys (`skymp5-client-settings.txt`)

The file is the JSON object that the client reads as `sp.settings["skymp5-client"]` (`settingsService.ts:29`, `main.js:343-347`). It lives in `Data/Platform/Plugins` (`main.js:346`). The launcher adds one object key, `autoReport`. Names in the design such as `autoReport.errors` are paths inside that object.

```json
"autoReport": {
  "v": 1,
  "noticeVersion": 1,
  "errors": true,
  "processHooks": true,
  "trail": true,
  "trailDir": "C:\\Users\\...\\Documents\\My Games\\Skyrim Special Edition\\SKSE",
  "filesVersion": "0.3.44",
  "launcherVersion": "2.1.30"
}
```

| Key | Type | Launcher writes | When missing | Client use |
|---|---|---|---|---|
| (whole object) | object | On every write of the file | **No trail and no reports**, because an older launcher showed no notice (D2). Process hooks still install. | Gate |
| `v` | int | `1` | `1` | Format |
| `noticeVersion` | int | The highest notice version shown to the **logged-in profile** (§4.2) | `0`, so **no reports** | D2 gate: report only when it is ≥ `MIN_NOTICE_VERSION` (1 in v1) |
| `errors` | bool | The Troubleshooting toggle "Errors in game" (default on, D1) | `true` | Send `script-error` and `ui-error` |
| `processHooks` | bool | `true`, unless staff turn it off to test (design §1a) | `true` | Install the `uncaughtException` and `unhandledRejection` hooks. Independent of reporting. |
| `trail` | bool | `false` only when errors and crash reports are both off | `true` | Write `dbo-trail.jsonl` |
| `trailDir` | string | The SKSE log folder (§3.1.1) | Fall back to `Data/Platform/Logs/`; no `gameLog` | Trail folder |
| `filesVersion` | string | The version being installed or launched, passed in (§4.2) | Leave out of the payload | `versions.files` |
| `launcherVersion` | string | `app.getVersion()` | Leave out of the payload | `versions.launcher` |

The crash consent setting (`ask`, `always` or `off`, default `ask`) stays in the launcher's own store. The client never needs it.

### 4.2 Rules for the launcher's writer

- **`writeClientSettings` starts from nothing** every time and keeps only `HOTKEY_KEYS` (`main.js:3289-3302`). The launcher MUST therefore write `autoReport` from its own store on every write. Do not add it to `HOTKEY_KEYS`.
- **Pass `filesVersion` in.** Reading it from the store would write an empty value on the install path, which:
  1. clears the stored version (`main.js:2799`);
  2. writes the settings (`:2821`);
  3. only then stores the new version (`:2822`).

  The launch path (`:1925`) hides this, unless the player starts the game from MO2 directly.
- **The package never carries this file** (`merge-files.js:26-27`), so there is no default to rely on.
- **Never write this file while `SkyrimSE.exe` runs.** Any change in the plugin folders reloads every plugin (§3.1.6). Toggle changes are saved in the launcher's store and in `dbo-consent.json` (§4.3), and reach the settings file at the next launch.
- **The settings object is read at every plugin load, hot reloads included.** SkyrimPlatform caches it on first read (`SkyrimPlatform.cpp:246-257`) and drops the cache in `ClearState` (`:329-330`).
- **D2 gating, per profile.** The launcher stores `autoReportNoticeShown` as `{ "<profileId>": n }`.
  - After login, it shows notice *n* once to a profile that has not seen it, with a link to the website text.
  - It writes `noticeVersion` for the logged-in profile, or `0` when nobody is logged in.
  - The launcher's own reports use the same per-profile value. The backend refuses `consent.noticeVersion < 1` (§2.12).
- **Notice text** (P2) must also include:
  - "The game server keeps a short record of your character's recent actions for 24 hours to match with reports. The part matched to a report is kept with that report for up to 30 days."
  - that crash reports include system specs, the list of loaded modules and the plugin list;
  - "visible only to staff", but only if D15 confirms it.
- **Changing the notice.** When the notice text changes materially, for example when a new kind of data is collected, `noticeVersion` goes up. The client's `MIN_NOTICE_VERSION` is raised in the same release.

### 4.3 Live opt-out: `dbo-consent.json`

`<trailDir>/dbo-consent.json`:

```json
{ "v": 1, "profileId": 123, "errors": false, "crash": "ask", "noticeVersion": 1, "at": 1790400000000 }
```

- **Launcher.** Writes it (tmp then rename) at every launch and whenever a toggle changes, including while the game runs. The file is outside the watched plugin folders, so writing it reloads nothing.
- **Client.** Reads it from `tick` at start and before each send, at most 10 times a session.
  - It applies only when `profileId` matches the logged-in profile.
  - **It can only switch reporting off, never on.** `errors: false`, or a `noticeVersion` below `MIN_NOTICE_VERSION`, stops all client reports.
  - When it says off, the client empties its memory queue and deletes its `dbo-pending/` files.
- Without `trailDir`, an opt-out made while playing takes effect at the next game start.

### 4.4 Crash consent "ask" (D1, D13)

- With `ask`, the launcher saves a crash-kind report in `pending-reports/` with `needsConsent: true` (§1.7).
- At the game exit it shows its window, or a tray notification while hidden, with "Send" and "Don't send". It does not quit while the question is open.
- "Send" sets `consent.crash: "once"` and sends. "Don't send" deletes the file. An unanswered file is deleted after 7 days.
- `crash-on-quit` is never asked; it is sent only with `always`.

### 4.5 "See what was sent"

- **Client:** keep the last 10 payloads in memory. After each 202, write `<D>/dbo-sent.jsonl` once, from memory (tmp then rename). Never re-read the file on the game thread.
- **Launcher:** keeps its own `<userData>/sent-reports.jsonl` the same way. The Troubleshooting tab shows both files, newest first.

---

## 5. Source maps and symbols (D11)

### 5.1 Build id

The id is `<sha12>[-dirty].<UTC time>`, for example `f8cd78971a2b.20260927T101500Z`. It matches `^[0-9a-f]{12}(-dirty)?\.\d{8}T\d{6}Z$`.

- `sha12` is `git rev-parse --short=12 HEAD` of the alduinak tree the bundle was built from.
- `-dirty` is added when `git status --porcelain -- skymp5-client skymp5-front` is not empty.
- **The pipeline computes the id once.** It passes `DBO_BUILD_ID` and `DBO_CLIENT_VERSION` to both webpack builds, which set them through `DefinePlugin` with `JSON.stringify`. A release build fails if either is missing.
- **`DBO_CLIENT_VERSION` MUST equal the bumped `CLIENT_VERSION`** at `routes/version.js:9`. Nothing links the two today, so the bump comes before the build.
- Each webpack build writes a sidecar next to its bundle, `<bundle base>.build.json` with `{ "build", "clientVersion" }`. The archive script checks it (§5.4).
- Every bundle build gets a new id, so a map always matches exactly one bundle.
- Builds run on CT 115, in git worktrees owned by `nate` (for example `/tmp/claude-nate-build-0340`). Running git as root there needs `-c safe.directory=<tree>`. §5.5 says where every build runs.

### 5.2 Client bundle

- **`skymp5-client/tsconfig.json`:** add `"sourceMap": true` and `"resolveJsonModule": true`.
  - Today it targets ES5 with no maps (`tsconfig.json:4`), so the webpack map resolves to compiled ES5, not to TypeScript.
  - The front already has `sourceMap`.
  - `resolveJsonModule` lets `scrub.ts` import `src/lib/scrub-rules.json` (§2.11). client-0344 does not set it either.
- **`webpack.config.js:66-67`:** replace `devtool: 'inline-source-map'` with `'hidden-source-map'`.
  - This writes `skymp5-client.js.map` next to the bundle.
  - The bundle gets no inline map and no `sourceMappingURL` comment.
  - `mode` may stay `development`.
- **`DefinePlugin`:** `__CLIENT_BUILD__` and `__CLIENT_VERSION__` (§2.9).
- **The marker.** The bundle must contain the probe marker `__DBO_STACK_PROBE__` exactly once.

### 5.3 Front bundle

- **`skymp5-front/webpack.config.ts`:** add `devtool: 'hidden-source-map'`. The production build (`package.json:7`, `--mode production`) has no map today.
- **`DefinePlugin`:** `__FRONT_BUILD__`.
- **Output:** `build.js` and `build.js.map` (`webpack.config.ts:14`).
  - The output folder comes from `skymp5-front/config.js`, which is not in git (`webpack.config.ts:4-8`). The pipeline therefore passes the real paths to the archive script.
  - The shipped `build.js` is one minified line. That is fine with maps.

### 5.4 Archive: storage, naming and who does what

**The script.** claude-jake writes `skymp5-backend/scripts/archive-symbols.js`. The build pipeline (claude-nate) runs it **right after each webpack run and before any packaging step**:

```
node skymp5-backend/scripts/archive-symbols.js client --build <id> --bundle <dir>/skymp5-client.js --map <dir>/skymp5-client.js.map --client-version 0.3.44 [--store <path>]
node skymp5-backend/scripts/archive-symbols.js front  --build <id> --bundle <dir>/build.js --map <dir>/build.js.map [--store <path>]
node skymp5-backend/scripts/archive-symbols.js pdb    --files-version 0.3.44 --pdb-dir <dir> --dll-dir <dir> [--store <path>]
```

- **`--store`** defaults to `/opt/alduinak/skymp5-backend/data`, and the script refuses any other path. A run from a worktree therefore cannot archive inside the worktree.
- That folder is root-owned (0755 today). The pipeline user runs the script through a sudo rule for exactly this script, logged in the ledger with its undo.

**What the script does** (for `client` and `front`):
1. Checks that the sidecar (§5.1) matches `--build` and, for `client`, `--client-version`.
2. Refuses a bundle that has a `sourceMappingURL` comment or an inline map.
3. For `client`, finds `probeLine`, the 1-based line that holds `__DBO_STACK_PROBE__`. The marker must occur exactly once.
4. Copies the map and writes its meta file with mode 0600.
5. **Deletes the `.map` and the sidecar from the build output**, so they cannot reach a package.
6. Exits non-zero on any failure, which stops the build.

**Layout.** Everything goes under `skymp5-backend/data/`, which is gitignored (`.gitignore:18`) and never cleaned (`skymp-update.sh`: "NEVER git clean"):

```
data/sourcemaps/                     0700
  client/<build>.map                 0600  the webpack map, unchanged
  client/<build>.json                0600  {"v":1,"kind":"client","build","gitSha","dirty","builtAt","clientVersion","bundleBytes","bundleSha256","probeLine"}
  front/<build>.map                  0600
  front/<build>.json                 0600  {"v":1,"kind":"front","build","gitSha","dirty","builtAt","bundleBytes","bundleSha256"}
data/symbols/<filesVersion>/         0700
  SkyrimPlatform.pdb  SkyrimPlatformImpl.pdb  MpClientPlugin.pdb (when present)  SkyrimPlatformCEF.pdb (for the .exe)
  index.json                         0600  {"v":1,"filesVersion","archivedAt","files":[{"pdb","image","imageSha256","imageBytes","peTimestamp","pdbGuidAge"}]}
```

**PDBs.**
- The DLLs are not built on CT 115. They are prebuilt files in the gitignored `sources/client/` (`.gitignore:3`).
- `dev_service` is Windows tooling, and it deletes the PDBs from its release folder (`dev_service/index.js:202-205`).
- **The PDBs MUST come with each DLL drop.**
  - The `pdb` step archives them from the drop, with each image's hash and PE timestamp, so the backend can refuse to symbolise against the wrong build.
  - `SkyrimPlatformCEF.pdb` belongs to `SkyrimPlatformCEF.exe`, not to a DLL.
- Without PDBs, P6 symbolisation is blocked (O15). If the drop is on another machine, getting it onto CT 115 is a hand-off to claude-dragonbreak.

**No upload route.** Builds happen on CT 115 (owner rule, 2026-09-24), so archiving is a local copy. There is no HTTP upload route to protect.

**Never shipped.**
- The zip is built from `OUTPUT_DIR` (`merge-files.js:129-131`). `populate-files.js` copies `build/dist/client/Data` straight into it (`populate-files.js:12-13`, `:44-45`), bypassing `sources/client`.
- So `merge-files.js` MUST refuse (exit non-zero) when `OUTPUT_DIR` contains any `*.map` or `*.pdb`, checked just before `buildZip`.
- `populate-files.js` MUST refuse the same files in its source.
- `SKIP_ALWAYS` (`merge-files.js:27`) covers neither case today.
- **The guard is off until the build side is ready.** Both scripts refuse only with `AUTO_REPORT_SYMBOL_GUARD=true` in the backend `.env`; unset, they warn and package as before. The client webpack build still uses `devtool: 'inline-source-map'` (`skymp5-client/webpack.config.js:67` on `96fd685e`), so the staged `skymp5-client.js` carries an inline map, and a hard guard would stop every release, even one that changes only plugins. claude-nate sets the switch once the build emits an external map, the archive script runs before staging, and the bundle in `sources/client` has been re-staged without the inline map.

**Retention.** Keep the maps and PDBs for every version in the known-version list (the current version plus the last 10), and for at least 30 days. Never delete the current ones.

**Resolution (for information).**
- Resolution runs after the 202, never in the request, and only for known versions.
- At most 6 map loads a minute. An LRU keeps 3 maps (design §4.1).
- The backend uses Node 22's built-in `module.SourceMap` and its `findOrigin(line, col)`, which takes 1-based positions. No new dependency is needed.
- It applies the probe offset first (§2.9).
- Development-mode maps carry no `names`, so the `function` in `src/file.ts:function` comes from the sent `fn`.
- An unknown build makes the group `held`, and so do frames that are present but do not resolve (design §4.4).

### 5.5 Where builds run

**Every build runs on CT 115** (owner rule, 2026-09-24). None runs on Nate's PC:
- the client and front webpack builds, in `nate`-owned worktrees (§5.1), each followed at once by the archive script (§5.4);
- the client package (`populate-files.js`, `merge-files.js`), with the map and PDB guard (§5.4);
- the launcher installer for P2, with electron-builder's NSIS target (below, O16).

So no step carries a bundle, a map or a sidecar between machines. A bundle built anywhere else has no archived map: its reports resolve nothing and its groups stay held (§5.4). The PC keeps the in-game and Windows tests (§8, §9).

- `TEAM.md:12` and `:43` still say the PC builds the client package and the launcher. That text is older than the owner rule.
- The native DLLs are the exception today. They are still prebuilt drops (§5.4, O15), and a change to them, such as the X5 follow-up, waits for a native build.

**Launcher installer on CT 115 (O16).** claude-nate's dry run on 2026-09-26 (`/opt/dragonbreak-handover/launcher-build-ct115/BUILD.md`) built the Windows installer on CT 115 with no wine and no system package. It matched the released 2.1.29 in layout and in its version strings.

```
cd skymp5-launcher
npm install --no-audit --no-fund
LANG=C.UTF-8 LC_ALL=C.UTF-8 node -r <dir>/preload.js node_modules/electron-builder/cli.js \
  --win --x64 --publish never -c.win.signAndEditExecutable=false -c.afterPack=<dir>/afterPack.js
```

| Step | Failure on CT 115 | Fix |
|---|---|---|
| makensis | `main argv conversion failed!` under `LANG=C` (the `©` in the copyright) | `LANG=C.UTF-8 LC_ALL=C.UTF-8` |
| NSIS uninstaller | electron-builder runs the uninstaller generator under wine on every platform except macOS | `preload.js` takes electron-builder's own macOS path, `UninstallerReader` |
| App exe icon and version strings | rcedit needs wine on Linux | `afterPack.js` sets them with `resedit`, which electron-builder already uses |

Still open before the P2 release:
1. commit a `package-lock.json` for `skymp5-launcher`, so dependencies stop floating;
2. move `preload.js` and `afterPack.js` into `skymp5-launcher/build-linux/`, with a `build:win-on-linux` script;
3. one Windows test of install, the silent in-app update (`/S --force-run`, `main.js:1704-1726`), the uninstaller and the Start menu icon;
4. re-check the preload on any electron-builder upgrade (pinned at 26.8.1).

Publishing (the version bump, the GitHub release upload and `routes/version.js` `DOWNLOAD_URL`) needs the owner's GO.

---

## 6. Signatures and Discord output (for information)

The backend computes signatures. They are listed here so that senders send the fields the backend needs. **A signature sent by a client is ignored.** These rules follow design §4.2.

**`normMsg(message)`, in this order:**
1. Quoted strings become `<s>`, including everything after `(reading '`.
2. UUIDs become `<uuid>`.
3. `0x[0-9a-f]+` becomes `<hex>`.
4. `\b[0-9a-f]{8}\b` containing a digit becomes `<form>`.
5. `\b[0-9a-f]{6,}\b` containing a digit becomes `<hex>`.
6. Paths become `<path>`, and URLs `<url>`.
7. Numbers become `<n>`.
8. `Name #TAG`, `<player>` and `<@id>` become `<player>`.
9. Whitespace is collapsed, and the result is cut to 200 characters.

**Canonical strings.** The group id is `'S' + sha1(canonical).slice(0, 10)`.

| Kind | Canonical | Fields used |
|---|---|---|
| `script-error`, `ui-error` | `v1\|<source>\|<type>\|<normMsg>\|<top 4 frames as <src>:<function>, comma-separated>`. `<src>` is the resolved `src/file.ts`, the file of a frame outside the bundle (`node:events`), or `?` | `error.source`, `type`, `message`, `frames`, `build.client` or `build.front`, `build.probe` |
| The same, with no frame left after the drops | `v1\|<source>\|<where>\|<event>\|<resolved site or ?>\|<type>\|<normMsg>` | `error.where`, `error.event`, `error.site` |
| Client, with bundle frames but none resolved (unknown build, or no map) | The first row, keyed on the function names with `?` sources. The group is held (`unknown-build` or `unresolved`) until a second player hits it | `error.frames`, `build.client` |
| Front, with bundle frames but none resolved | `v1\|front\|<type>\|<normMsg>\|<fn>@<line>:<col>\|<front build>`, from the first `build.js` frame | `error.frames`, `build.front` |
| Front, top frame `<injected>` | `v1\|front\|<type>\|<normMsg>\|injected:<fn>` | `error.frames[0].fn` |
| `js-fatal` | `v1\|err\|<where, or logged:<Service>>\|<type>\|<normMsg>` from the last `err` trail entry, otherwise `v1\|js-fatal` | `trail.entries` |
| `crash` | `v1\|crash\|<exception>\|<faultModule or ?>+<symbol, alid or offset>\|<top 3 frames>` | `crash.*`, `versions.files`, `versions.game` |
| `crash-nolog` | `v1\|crash\|exit:<code>\|<event 1000 module, or unknown>` | `exit.code`, `exit.event.module` |
| `freeze` | `v1\|freeze` (one group; the thread tabulates the last menu and the last world) | `trail` pins |
| `crash-on-quit` | `v1\|crash-on-quit\|<faultModule or ?>` | `crash.faultModule` |

**Details:**
- `kind` is not part of the key, so an error that is logged and then rethrown forms one group. Nor is `where` when frames are present: the logged copy has `where: "logged"` and the rethrown one `"on"` (§8 payload 2). `where` stays in the key only when no frame is left, where the handler is all that tells two errors apart.
- The frames dropped before hashing are the sink, the wrapper, `node:internal` and `webpack/bootstrap`.
- **Crash frames:**
  - System frames are skipped first: ntdll, KERNELBASE, KERNEL32, ucrtbase, `VCRUNTIME*` and `MSVCP*`.
  - For frame identity, a PDB symbol wins, then an Address Library id.
  - A raw offset in our DLLs gets `versions.files` appended. A raw offset in `SkyrimSE.exe` gets `versions.game` appended.
  - A third-party DLL is keyed on module plus exception only.
  - A frame with no module is `?`. Absolute addresses are never used.
- The backend re-parses `crash.sections.header` and `crash.sections.callStack` with the shared parser. It uses the sender's parsed fields only when that fails, which covers `crash-on-quit` (it has no sections). **Until O3 settles the formats, it uses the sender's fields** (§2.4).
- **Titles** never contain player text. They are `(Auto Report) <Type> in <resolved function>` or `(Auto Report) Crash <EXC> <module>+<symbol or offset>`. They go through `cleanName` (`problemReport.js:36-40`) without its 64-character cut, and are capped at 100.

### 6.1 What reaches Discord and how

1. **One helper** sends every post, reply, edit and index rebuild, with `allowed_mentions: { parse: [] }` and `flags: 4` (SUPPRESS_EMBEDS). Today `audit.js:14` sets only `allowed_mentions`.
2. **Text from a sender appears only inside fenced code blocks.**
   - Every backtick becomes `ˋ` (U+02CB), not only triple backticks.
   - C0 controls and `\u200b-\u200f`, `\u202a-\u202e` and `\u2066-\u2069` are removed.
   - Every string goes through `toWellFormed()`.
   - Lengths are measured after escaping.
3. **Titles** that appear in the index or in `#server-logs` also go through `escapeMarkdown` (`problemReport.js:42`).
4. **The inline trail lines** and the "most common action before the error" line go in a code block, not in inline code.
5. **`report.json`** carries `normMsg`, never the raw `error.message`. Design §4.2 says the raw message stays in the jsonl only.
6. **Identity.** Auto threads show `profile <id>` only: no `<@id>` and no username, unlike the manual report (`problemReport.js:109`).
7. **Attachments.**
   - The starter carries `report.json`, `trail.txt` and `server-trail.txt`.
   - `game.log` and `crash.txt` go in the first reply, which D5 keeps as the first sample.
   - Nothing is posted to the real forum before D15 is settled (O8, rollout P4).
8. **Poison messages.** On a Discord 4xx, the outbox logs the message and drops it, so one bad message cannot block the serialized queue. The exceptions are 401 and 403, which go to the pause guard (design §5), and 429, which is retried.
9. **The P6 dashboard** renders every field as text, never as HTML.

### 6.2 Grouping safeguards

- **Regression.** A group reopens as a regression only when at least 2 distinct profiles hit it at or above `fixedInVersion`.
- **Held promotion** needs 2 distinct profiles, and distinct `hwid` values when the sessions have them (`master-api.js:123-128`).
- **Thread budget.** One profile can open at most 3 of the 30 new threads per day.
- **Suspect builds.** When the archived `clientVersion` for a `build.client` differs from `versions.client`, the group stays held (§2.12).

### 6.3 Retention and purge

| Data | Kept |
|---|---|
| Raw reports, one file each: `data/auto/reports/<profileId>-<reportId>.json`, with the joined server-trail excerpt (§3.3, not built yet) | 30 days. Full logs only for the first 5 samples per group and version. |
| `ignored` reports | Metadata only |
| Server trail session files | 24 h |
| Group records (`data/auto/error-groups.json`) | Until deleted; profile ids only, plus the hardware hash below |
| `hwidHash`: the first 16 hex of SHA-256 of `auto-report:<hwid>`, compared only for equality (§6.2) | In each report record (30 days), and in a held group's promotion list until the group opens |
| New-signature counters per profile (`error-groups.json`) | Until the next UTC day |
| Mutes and the hourly invalid-payload count per profile (`data/auto/auto-state.json`) | 24 h after the mute; the count for its hour |
| `unknown-version` counts (`error-groups.json`) | Until deleted; versions and totals only, at most 50 versions |
| Reply attachments | Purged after 90 days, except the starter and the first sample (D5) |
| Seen `reportId`s | 8 days, at most 500 per profile |
| Source maps and PDBs | Known versions, and at least 30 days |
| Client and launcher files | `dbo-sent.jsonl` and `sent-reports.jsonl`: last 10. Queues: 5 files, 7 days. `crash-evidence/`: 7 days. |

- Every stored key is `<profileId>:<reportId>`, and every file name `<profileId>-<reportId>.json`, so one profile's `reportId` can never shadow another's. A profile id is digits only, so `-` is unambiguous.
- `skymp5-backend/scripts/purge-auto-reports.js --profile <id>` removes a profile's reports, joined excerpts and seen ids. It also removes the profile's id and hardware hash from group records, keeping the counts (the id becomes one anonymous key per run). **Run it with the backend stopped:** the backend keeps both state files in memory and would write the ids back.

---

## 7. Versioning

- **Wire version.** `contractVersion` is an integer; this document defines **1**.
- **Changes that do not bump it:**
  - new optional fields (older backends drop them);
  - new `d` forms within an existing trail kind, once the backend grammar accepts them;
  - tighter sender caps.
- **New enum values** (a kind, a `where`, a trail kind) need the backend to accept them first, because unknown enum values get 422. The backend always deploys first (rollout P0). That is why `hook` is in v1 and `controller` is not.
- **Changes that bump it to 2:**
  - removing or renaming a field;
  - changing a unit or a meaning;
  - making an optional field required.

  The backend then accepts N and N-1 for as long as any client version in the known list sends N-1. It announces what it accepts in `GET /api/version` → `autoReport.contract`.
- **Sub-formats carry their own `v`,** and each one moves independently:
  - the client trail header (§3.1.2);
  - the server session file (§3.2.2);
  - the queue wrapper (§1.7);
  - the `front:error` message (§2.8);
  - the settings object `autoReport.v` (§4.1);
  - `dbo-consent.json` (§4.3);
  - the symbol meta files (§5.4).

  A reader MUST accept its current version and the one before.
- **Document revision.** `1.0-rc2` becomes `1.0` when claude-nate confirms in the ledger. Later edits are 1.1, 1.2 and so on, each with a changelog entry at the end of this file.

---

## 8. Test fixtures

Shared fixtures live in `skymp5-backend/test/fixtures/auto-report/`. The client and launcher tests copy `scrub-rules.json`, `scrub-cases.json`, `trail/*`, `classify/*` and `crashlogs/*`, and a test checks the hashes of the copies.

**Payloads (`payloads/`, backend `node:test`):**
1. `script-error-on-update.json`: a direct `on('update')` throw, in the style of `remoteServer.ts`.
2. `script-error-logged.json` and `script-error-rethrown.json`: the same error, logged and then rethrown. They must form **one** group.
3. `script-error-no-frames.json`: the C++ `e.what()` path, with `frames: []` and a `site`.
4. `script-error-http-callback.json`: `where: "http"`, `event: "post"`.
5. `script-error-hook.json`: `where: "hook"`, `event: "sendAnimationEvent"`.
6. `script-error-process-uncaught.json`, and `script-error-process-rejection-nonerror.json` (`type: "NonError:string"`, accepted).
7. `script-error-json-parse.json`: a raw Node 22 JSON.parse message containing a session-like snippet. It must come out as `Unexpected token in JSON`.
8. `script-error-site-below-1.json`: a `site` that the probe offset moves below line 1. The site is removed and the report is flagged, not refused.
9. Front errors:
   - `ui-error-boundary.json` (with a `componentStack` of minified names and `build.js` positions);
   - `ui-error-window.json`;
   - `ui-error-injected.json` (`file: "<injected>"`);
   - `ui-error-opaque.json` (`Script error.`, expecting `ignored`).
10. Crashes:
    - `crash-ours.json` (fault in `SkyrimPlatform.dll`);
    - `crash-libnode.json` (`hasOurDll: true`);
    - `crash-kernelbase-top.json` (system frames skipped);
    - `crash-gpu-driver.json` (third party: module plus exception only);
    - `crash-exe-raw-offset.json` (`versions.game` appended);
    - `crash-no-module.json` (`faultModule: null`).
11. Other launcher kinds:
    - `crash-nolog-fastfail.json` (0xC0000409);
    - `freeze-taskkill.json` (exit code 1, heartbeat 45 s stale);
    - `freeze-event1002.json`;
    - `js-fatal.json`;
    - `crash-on-quit.json`.
12. **Negative and edge cases:**
    - no `reportId` → 422;
    - `versions.client: "0.3.44-beta"` → 422;
    - `contractVersion: 2` → 422 `contractVersion`;
    - `consent.noticeVersion: 0` → 422 `consent`;
    - `script-error` with `consent.errors: false` → 422 `consent`;
    - a crash with no `consent.crash`, or with `"ask"` → 422 `consent`;
    - `crash-on-quit` with `consent.crash: "once"` → 422 `consent`;
    - an unknown `kind` → 422;
    - a `sender` that does not match the kind → 422;
    - an `fn` with a backtick → `fn: null`, flagged `invalidField`;
    - a `menu` entry whose `d` holds chat text → entry removed, `dropped` counted;
    - a `__proto__` key and 1,000-deep nesting → ignored, no crash;
    - a time in 2019 → accepted, `clockSuspect`;
    - no session → 401;
    - a banned profile → 403, with no ban log line;
    - a body over 400 KB → 413;
    - gzip → 415; `content-type: text/plain` → 415;
    - no `x-report-kind` → manual route (400);
    - a body with `contractVersion` on the manual route → 400;
    - a repeated `reportId` → 202 `duplicate`;
    - the same `reportId` from another profile → a separate record;
    - a sender-supplied `signature` → ignored;
    - `crashAt` 8 days ago → `ignored`, metadata only;
    - a crash with no DragonBreak trail → `ignored`, metadata only;
    - a muted profile → plain 202;
    - a thrown error inside `accept` → 500 JSON with no stack.

**Scrubbing (`scrub-cases.json`, run by the backend, the client and the launcher):**
- **Names:**
  - The user `jake` and the computer `DESKTOP-AB12CDE`, in paths, in plain text and in upper case.
  - A user name containing `.`, `$` and `(`.
  - A home folder named differently from `USERNAME`.
  - A Discord username.
  - A character name and a seen player's name (client).
  - A 2-letter user name (skipped), and a user named `admin` (on the deny-list, so skipped).
- **Folders:** the game folder and the Documents folder, in both slash styles → `<game>`, `<docs>`.
- **Tags and OneDrive:**
  - `Hit by Jon Snow #AB2C` → `Hit by <player>`.
  - `C:\Users\<user>\OneDrive - Contoso Ltd\Documents` → `OneDrive - <org>`.
- **IPv4:**
  - `192.168.1.20:7777` and `Failed to connect to 192.168.1.20.` → `<ip>`.
  - `1.6.640.0`, `1.6.1170.0`, `0.3.44` and `v2.1.29` are unchanged.
- **IPv6:**
  - `fe80::1ff:fe23:4567:890a`, `addr 2001:db8::1.` and `2001:DB8:0:0:8:800:200C:417A` → `<ip>`.
  - `RE::Actor::Add`, `std::vector`, `D3D11::Create`, `12:34:56` and `BSScript::Internal` are unchanged.
- **Mentions and email:** `<@123456789012345678>` → `<discord>`. `a.b@example.org` → `<email>`.
- **Tokens and paths:** `"session":"<64 hex>"` → `<redacted>`. A Discord bot-token shape, `Bearer …` and `C:\Users\Jake\…`.
- **Foreground programs:** a ForegroundGuard line naming `chrome.exe` → `class '<app>' pid N (<app>)`.
- **JSON snippets:** a `gameLog` line `on('update'): Unexpected token 'm', "{"a": my letter "... is not valid JSON` → no letter text left.
- **Game UI lines (S0):**
  - A `gameLog` with `\r\n` line ends, holding `JS window.__alduinakAddChat(…)`, `JS window.__alduinakSetNames(…)` and `LoadUrl …` lines between diagnostic lines → each run of UI lines becomes `[N UI line(s) left out]`, and every diagnostic line is kept.
  - A multi-line `LoadUrl data:text/html,<p>hello\nBrelyna: the key...` → no `Brelyna` text left.
  - A `gameLog` that starts in the middle of a `JS` line, as a read window leaves it → the partial line is dropped.
  - An empty `JS` payload (`JS  ...`), and a `JS` line with a `\r` or U+2028 inside → dropped whole.
  - A launcher line (`[2026-09-26T10:00:00.000Z] …`) and an `skse64.log` line → untouched.
  - A 2,000-character exception line → cut to 500 characters.
- **Control characters:** a string with C0 controls and bidi characters → removed.
- **Signature case:** `decade` and `facade` are untouched by `<form>`.
- **Timing:**
  - every rule under 50 ms on 64 KB of adversarial input for that rule (runs of `a`, `"`, `a@`, `1.`, `a:`, `class '`, and `[00:00:00:000] JS ` lines for S0);
  - the whole backend pipeline under 250 ms on a maximal 400 KB adversarial report;
  - the crash-log parser under 100 ms on 400 KB.

**Signatures (`signature-cases.json`):** the design §8 golden cases (`<form>` fires, and so on), plus the injected-front and no-module crash rows. Each case is an input record with its expected canonical string and id.

**Client trail (`trail/`):**
- `dbo-trail.jsonl`: a header, `hb` lines, pins, and collapsed repeats restated by the batch (the replay sets `n`; it does not add).
- `dbo-trail.prev.jsonl`.
- `trail-partial-last-line.jsonl`: the reader skips the bad line.
- `trail-profile-mismatch.jsonl` and `trail-profile-null.jsonl`: `source: "none"`.
- `trail-hot-reload-same-pid`: appended to, not rotated.
- `trail-256kb-compaction`.
- `trail-singleplayer.jsonl`: no `net`, `send` or `recv`, and `hb` without `c`, so nothing is sent.
- `trail-quit-exit.jsonl` (ends with `net exit quit`) and `trail-quit-menu.jsonl` (ends with `net menu-quit`): quit marker.
- `trail-journal-mcm.jsonl`: the Journal is open in an MCM menu at the crash, so there is no quit marker.
- `grammar-cases.json`: one passing and one failing `d` per kind, client and server. `menu open Sleep/Wait Menu` passes.

**Launcher classification (`classify/`):** one case per §2.2 rule, plus:
- a clean quit (code 0) with a stale heartbeat → clean;
- an old `err` followed by heartbeats → not `js-fatal`;
- 0xC000013A → clean;
- PowerShell prints `-1073741819` → `exit.code` 3221225477 (0xC0000005) → `crash-nolog`, not `freeze`;
- a crash log plus `net exit quit` → `crash-on-quit`.

**Server trail (`server-trail/`):**
- A closed session with a name-free `view`.
- An open session.
- A stale session.
- Two sessions for one profile around T: the join picks the right one.
- `player <hex>` holds the actor id, not the profile id.
- An unregistered chat command becomes `/?`.
- A lint test that fails on any `name` field or `#TAG` pattern in a session file.
- **`tests/trail-harness.js`** (gameplay, next to the other harnesses): loads `trail.js` twice. Each hook then carries exactly one trail wrapper, around the current gamemode function; the rings survive the reload; one flush loop runs; a refusal recorded through `__dboTrailRec` passes the grammar.

**Crash logs (`crashlogs/`):**
- At least 3 real Crash Logger logs from Nate's PC: one in our code, one third-party, and one in vanilla code. Each comes with the expected `sections` and parsed fields.
- `relevantObjects` lines for 0x14, 0x7, an FF-range TESNPC and an unquoted name: all become `<name>`.
- `SkyrimSE.exe+0123456` → `0x123456`.
- A `CrashLogger.ini` with a custom `Crashlog Directory`.

**Source maps (`sourcemaps/`):**
- A small bundle and map made by a fixture script, with frames of known resolution to a `.ts` source.
- The same bundle with 3 lines prepended: the probe offset fixes it.
- An unknown build → `held`.
- A build whose meta `clientVersion` differs from `versions.client` → `suspect`, held.
- `archive-symbols.js` refusing a bundle that contains `sourceMappingURL`, a sidecar that does not match, and a `--store` outside the allowed path.
- `merge-files.js` refusing a `.map` in `OUTPUT_DIR`, and `populate-files.js` refusing one in its source.

**Settings and consent (`settings/`):**
- `autoReport` missing: no trail, no reports, hooks on.
- `noticeVersion: 0`: no reports.
- `errors` missing: on. `errors: false`: off.
- `processHooks: false`.
- `trailDir` missing, relative, or not existing: fall back, no `gameLog`.
- `dbo-consent.json` with `errors: false`: no send, memory queue emptied, `dbo-pending/` deleted.
- `dbo-consent.json` for another profile: ignored.
- `dbo-consent.json` with `errors: true` while the settings say off: still off.
- Install path: `filesVersion` is the new version, not empty.

**In game and launcher (manual, on Windows):** the design §8 in-game and launcher lists, and the tests in the §9 table, plus the items below. Most of them need a dev client with errorSink installed first.
- a hot reload that keeps the trail and the seen set;
- a hotkey save mid-game that keeps reporting alive;
- a 401 in game that ends up in `dbo-pending/` and is sent by the launcher after the next login;
- an "ask" crash while the launcher is hidden in the tray;
- an opt-out while playing.

---

## 9. Open items (they do not block the build)

| # | Item | Who or where |
|---|---|---|
| O1 | For **every** host the settings can name: the nginx body limit, `limit_req`, and whether the Cloudflare WAF blocks bodies with stack traces. The hosts are `dragonbreakonline.com` (used by the launcher, and the game's fallback) and the master host (`api.dragonbreakonline.com` by default). Also check whether the WAF can answer with a non-JSON 403. Also confirm: no `$http_x_session` in any nginx `log_format`, and no debug `error_log`; no Cloudflare Logpush of request headers; and origin traffic limited to Cloudflare, or `CF-Connecting-IP` overwritten. `visitorIp.js:6-7` trusts that header from anyone, so otherwise the per-IP limiter can be bypassed, a victim's address can be charged, and two addresses can use up the 120 unverified requests per 10 minutes, so that every sender with an expired token gets 429 instead of 401 for a while. The backend keeps this trust until O1 is answered. | claude-dragonbreak, before P3 |
| O2 | **Answered from code, and confirmed from the shipped 0.3.47 bundle.** `on` and `once` are plain properties (`EventsApi.h:27-30`) on the object from `addNativeExports('skyrimPlatform', {})` (`SkyrimPlatform.cpp:317-318`). Services receive that real object and call `(0, X.on)(…)`, reading the property on every call, so assigning to `globalThis.skyrimPlatform` works (§2.3 item 10). `HttpClient` is set the same way (`HttpClientApi.h:20`). **Test:** throw from a module-level `on('update')` and from an HTTP callback; the sink catches both, and the console still prints. | Nate's PC (confirm only) |
| O3 | Crash Logger section headings and the frame and symbol line format, from three or more real `crash-*.log` files (a fault in our DLL, in a third-party DLL and in vanilla code), with names removed | Nate's PC |
| O4 | Exit codes for quit to desktop, a kick, a Task Manager kill and a crash, read as the signed `$p.ExitCode` (§2.2, §2.4) | Nate's PC |
| O5 | **Answered from code.** The SKSE folder is outside MO2's virtual file system. The real MO2 issue is the fallback folder (§3.1.1). | Closed |
| O6 | **Answered from code.** spdlog opens the log with `_SH_DENYNO`, and libuv opens files with full sharing, so the client can read `skyrim-platform.log` while SkyrimPlatform has it open. **Test:** the game reads the log's tail while it runs. | Nate's PC (confirm only) |
| O7 | An unhandled rejection and a timer throw, with process hooks on and off: does the game survive, and with which exit code? (Node 23's `unhandledRejection` behaviour inside SkyrimPlatform.) | Nate's PC |
| O8 | Forum permission overwrites (D15). Not part of the wire contract. | Before P4 |
| O9 | Who owns the p2p logging module (D12), so that the hit, down and trade hooks are wrapped only once | Before P1 |
| O10 | One real stack from each capture path (`on`, `once`, HTTP callback, hook `enter` and `leave`, process hook, a front throw, injected front code), saved as fixtures, to confirm the frame shapes in §2.3 | Nate's PC |
| O11 | The menu events for quit to desktop, quit to main menu, and quit from character select (§2.4 quit marker). **Settle before P5:** until then, a crash during "Quit to desktop" from the pause menu is a `crash`, not `crash-on-quit` (§2.4). | Nate's PC, **before P5** |
| O12 | **Mostly answered from code.** The client sets `bAlwaysActive` (`index.ts:102` on client-0344), and `tick` runs once a frame from the SKSE task queue (`TickHandler.h:27-33`), so heartbeats should stop only on a real stall. **Test:** alt-tab and minimise for 60 s or more; do heartbeats continue? This decides how many false freezes to expect. | Nate's PC (confirm only) |
| O13 | Under MO2: where the trail, pending and sent files land, and whether an in-game Discord sign-in writes the auth file to `overwrite\`. That sign-in still writes it, on purpose (`authService.ts:308-309` on client-0344, X2). | Nate's PC |
| O14 | A throw from `build.js` and from `executeJavaScript` code: does CEF pass the full message, or `Script error.`? (§2.8) | Nate's PC |
| O15 | PDBs arriving with each DLL drop (§5.4) | Before P6 |
| O16 | **The P2 launcher release is built on CT 115**, with NSIS, where there is no wine and no system `makensis`. **Proven by claude-nate's dry run** (2026-09-26): the installer builds and matches 2.1.29 (§5.5). Still open: the lock file, moving the two scripts into the tree, one Windows install and update test, and the owner's GO to publish (§5.5). P2 blocks P3 (D2). | claude-nate, **before P2** |

Most of the "Nate's PC" items need a dev client with errorSink installed first.

**Existing defects found during review.** These are outside this contract; each gets its own fix and ledger entry.
- **X1. Fixed in client 0.3.47** (`a893a452`). `writeAuthDataToDisk` printed the whole auth data, **session token included**, to the in-game console (`authService.ts:449-452`, through `logTrace`, `logging.ts:19-29`), where it showed on screen and in streams. It now logs only the byte count.
  - **Follow-up, on client-0344 `d28822bd`, not yet released:** `readAuthDataFromDisk` logged the error of an unreadable auth file with its stack. A JSON parse error quotes the text around the fault, and that text is the token. It now logs only the error's name (`authService.ts:454` on client-0344).
- **X2. Fixed in client 0.3.47** (`a893a452`). On auto sign-in, the client wrote the auth file back (`authService.ts:257-258`). Under MO2 that copy went to `overwrite\` and then hid the launcher's newer file (`main.js:3337-3347`), so the game could send an older token.
  - An in-game Discord sign-in still writes the file (`authService.ts:308-309` on client-0344). That is intended: the token is remembered for the next launch. O13 checks where it lands under MO2.
- **X3.** `master-api.js:82` writes `sessions.json` with no `mode: 0o600`, so a re-created file would be 0644. This is the code half of D17.
- **X4.** The install path writes the settings with an empty `filesVersion` (`main.js:2799`, `:2821-2822`). §4.2 fixes this for `autoReport`.
- **X5. The game UI's chat in `skyrim-platform.log`, uploaded by the live Report a Problem.** Found by claude-nate on 2026-09-26.
  - **What is logged.** On the NirnLab browser backend, SkyrimPlatform logs the first 120 bytes of every `executeJavaScript` call (`logger::info("JS {} ...")`, newlines turned into spaces) and every whole `loadUrl` URL (`BrowserApiNirnLab.cpp:83-91`, `:75`). Info is the default `LogLevel` (`Settings.cpp:14`), and the package ships no `SkyrimPlatform.ini`. The log therefore holds (lines on client-0344):
    - every chat line, `/pm` included (`chatService.ts:439`);
    - system notices and banners (`systemNotification.ts:9`, `dboRelayService.ts:189`);
    - the character name (`chatService.ts:432`);
    - the voice connect URL and, when the URL is short, the start of the voice token (`voiceService.ts:271`).

    The session token stays outside the 120 bytes only because `events` comes first in the login widget's `getText` (`authService.ts:330`, `:435` on client-0344). A reorder there would log it.
  - **Where it goes.** The launcher's Report a Problem uploads the last 80 KiB of the log as `gameLog`, with only keys and paths redacted (`report.js:42-68`). Support also asks players to attach the file by hand in Discord, and the plaintext stays in the player's own log file. The staff error-report forum already holds attachments that carry chat lines; whether to delete them is the owner's call.
  - **Who is affected.** The Tilted backend logs neither line (`BrowserApiTilted.cpp:83-94`, `tilted/ui/MyChromiumApp.cpp:272-291`). The default `BackendName` is `auto`, and `auto` falls back to Tilted (`BrowserApi.cpp:20-23`; the shipped `SkyrimPlatformImpl.dll` holds that message). The client zip ships no NirnLab plugin, and nothing in the repo or the backend manifests sets `nirnlab`. So a default install probably writes none of these lines, and X5 hits players who set `BackendName=nirnlab`. **Before telling players what leaked, read the `browser backend: config value is …` line in one real uploaded log.**
  - **Fixes,** none live:

    | Fix | Where | State |
    |---|---|---|
    | The launcher drops `JS` and `LoadUrl` lines; each run becomes `[N UI line(s) left out]`. It reads 480 KiB back, so the 80 KiB it sends is still useful. | fork `launcher-report-no-chat` `559a98ca`, `skymp5-launcher/src/report.js` | Tested on synthetic logs: no chat left, diagnostic lines kept. Needs the usual `launcher 2.1.30: …` bump commit at release, or auto-update does not deliver it. |
    | The backend drops the same lines, for launchers up to 2.1.29 already out | same branch, `90102f66`: `sources/scrubLog.js` `dropUiLines`, `sources/problemReport.js`, `test/scrubLog.test.js` | Backend tests 20/20. `sources/` needs the owner's go. |
    | Both copies: after a dropped UI line, keep dropping until a timestamped line, with a multi-line `LoadUrl` test. The backend: run `dropUiLines` on every `LOG_FIELDS` entry, not only `gameLog` (a pre-release launcher, `8a9c6c94`, sent this log in `clientLog`). | the two commits above | To do before release |
    | Auto Reports: S0 (§2.11), in the shared rule file with fixtures (§8), and on the launcher's evidence copy (§2.4) | this contract | Specified here |
    | **The real fix:** SkyrimPlatform lowers both lines to `logger::debug`, or logs only the byte length and the call name (the text up to the first `(`) for `JS`, and only the scheme and host for `LoadUrl`. The filters stay, for old DLLs and for players who raise `LogLevel`. | `BrowserApiNirnLab.cpp:75`, `:91`, in a later native build (§5.5) | Proposal |

  - **Not recommended:** shipping a `SkyrimPlatform.ini` with a lower `LogLevel`. It would overwrite players' own settings and drop the info lines staff use.
  - **By design, not covered:** exception lines. `EventsApi.cpp:64` logs the whole message of any handler's throw, and `networkingService.ts` rethrows on purpose so errors reach this log. No current path puts chat in such a message. The native follow-up can cap `what()` at a few hundred characters; the auto payload caps each line at 500 (§2.11 step 4).
- **X6.** `authService.ts:183` and `sweetTaffyEvalService.ts:30` (client-0344) print the whole custom-packet JSON to the in-game console when it fails to parse, and the `voiceToken` packet carries the voice URL and token. This happens only on malformed server JSON, and the console never reaches `skyrim-platform.log`, so the exposure is the screen and screenshots, not reports. Fix when convenient: log the length and `customPacketType` instead.
- **X7.** In `BrowserApi.cpp:62-89`, the `Backend::kOff` case has no `break` and falls through into `kTilted`, so `BackendName=off` still registers the Tilted browser functions. Fix in a separate native change.

---

## 10. Where this contract adds to or differs from the design (please review)

1. **Seen `reportId`s are kept for 8 days, not 24 h,** at most 500 per profile. A report can wait in a queue for up to 7 days. With a 24 h window, a retry after a lost 202 would count twice.
2. **The build id includes a UTC timestamp,** `<sha12>[-dirty].<time>`, so that two builds from one commit never share a map.
3. **The map store is split** into `data/sourcemaps/client/` and `front/`. Each map has a meta file holding `probeLine` and `clientVersion`. The design had `data/sourcemaps/<build>.map`.
4. **Every crash-log `Name` value becomes `<name>`.** The design replaced names on FF-range references with `player <hex>`. That missed the player's own forms 0x7 and 0x14, and remote players' FF-range base NPCs.
5. **In-game reports get a disk queue as well** (`dbo-pending/`), which the launcher sends after the next login. The design had an in-memory queue only.
6. **The server trail writes asynchronously,** following `debugsnap.js:54-68`, not the synchronous tmp-then-rename at `debugsnap.js:49-52` that the design cited.
7. **The disconnect `view` is a name-free copy of `playerView`.**
8. **The P5 crash-watch flag reaches the launcher through `GET /api/version` → `autoReport`.** The design did not say where it lives.
9. **Consent mapping, enforced by the backend:**
   - `js-fatal` and `freeze` follow the errors toggle;
   - the crash kinds follow the crash toggle;
   - `crash-on-quit` needs `always` and is never asked.
10. **Trail additions:**
    - a `fatal` kind;
    - `hb` carries `c` while connected;
    - an explicit `act` verb list;
    - a `send` allow-list;
    - form descs in the server's format;
    - the `hb` pin is never sent;
    - a grammar that the backend enforces, which allows `/` in menu names (`Sleep/Wait Menu`).
11. **The quit marker is `net exit …` or `net menu-quit`,** not "Journal open" (design §1c.4). The Journal is also open during pause and in MCM menus, and three quit paths never open it. "Quit to desktop" from the pause menu has no marker yet, so O11 is settled before P5 (§2.4).
12. **An explicit launcher classification order** (§2.2). A freeze needs exit code 1 or no code, so a clean quit after a long hang is not a freeze. The exit code is read signed and converted in JavaScript (§2.4).
13. **Consent changes:**
    - consent is re-checked at send time;
    - notices are tracked per profile;
    - a live opt-out file exists (§4.3);
    - the launcher asks about a crash at game exit (§4.4).
14. **Scrubbing:**
    - a shared rule file;
    - IPv6 matches either case;
    - new rules for folders, the Discord username, character names, `#TAG`, OneDrive, foreground programs and JSON snippets in any text;
    - the backend cuts to 1.25 × the cap before scrubbing.
15. **`crash-nolog` is its own `kind`,** and **two hosts** carry the route (O1).
16. **`hasOurDll` is a label, not a filter.**
    - Design §7 says "Crashes must have `hasOurDll`". But design §4.2 gives third-party DLL crashes their own signature rule, which only makes sense if they are kept.
    - Recommendation: keep them, labelled. Jake can make it a filter later with no wire change.
17. **Process hooks:** `console.error` does not reach `skyrim-platform.log`, although design §1a says it does. The synchronous `fatal` trail entry is the record.
18. **No `controller` wrapper,** though design §1a kept one: the patched global already covers `controller.on`. Hook handlers get a wrapper instead (`where: "hook"`), which passes all four `add` arguments on (§2.3).
19. **Backend safeguards beyond design §7:**
    - a regression needs 2 profiles (a small change to D6);
    - held promotion needs distinct hardware ids;
    - one profile opens at most 3 threads a day;
    - a build whose version does not match is held.
20. **The 202 body is `{ok, id, duplicate}`**, smaller than the design's `{id, group, new}`, so it reveals nothing about signatures.
21. **Rollout and attachments:**
    - Rollout P1 writes no server trail to disk until the P2 notice is live.
    - **`game.log` and `crash.txt` move from the starter to the first reply**, which D5 still keeps.
22. **Out-of-date references in the design.**
    - The launcher has no `errorReport.js`. Its collector is `skymp5-launcher/src/report.js`. `errorReport.js` is the backend's Discord poster, `sources/discord/errorReport.js`.
    - Line numbers that moved since the design's baseline are corrected in Appendix A:
      - `SESSION_TTL` is at `master-api.js:70`;
      - `guardLaunch` is at `main.js:1560-1574`;
      - the dbo relay is at `dboRelayService.ts:230-236`;
      - the debugsnap loader is at `gamemode.js:3221-3226`;
      - the forum comment is at `config.js:115`.
23. **A scrub rule for game UI lines, S0** (§2.11). The design did not know that SkyrimPlatform logs chat on the NirnLab backend (defect X5). `gameLog` stays in v1, with those lines dropped.
24. **The `ErrorBoundary` text does not say "press F6 to reload"** (design §1b). F6 focuses chat (§2.8).
25. **Where builds run is stated** (§5.5): every build on CT 115, including the launcher installer (O16). The design did not say, and `TEAM.md` still gives the client package and the launcher to the PC.
26. **Storage layout** (§6.3): one 0600 file per report under `data/auto/reports/`, not `data/autoreports.jsonl` (design §4.3), so the 30-day janitor and the purge delete whole files and nothing is rewritten in place. `auto-state.json` and `error-groups.json` live in `data/auto/` too.
27. **New-signature caps** (§2.12) apply where a group would be created, after the 202, not inside `accept` (design §7): the signature needs the source map, which is loaded after the answer. Their counters are kept in `error-groups.json` with the groups and their sequence number, not in `auto-state.json` (design §4.3), so a replay after a restart makes the same decisions.
28. **A mute lasts 24 hours** (§2.12). The design gives no duration.
29. **A hash of the hardware id is stored** (§6.3), in reports and in held groups' promotion lists, for the distinct-machine rule of §6.2. The design said group records keep profile ids only.

---

## Changes after review

Review sources: **N** is claude-nate's client and launcher review, and **P** is the privacy and security review. Both were checked against f8cd7897 and 8c638310 before being folded in.

**Accepted from N:**
- A1: bundle frames are told apart from dispatcher frames by the probe prefix. Frames below line 1 are removed, not refused (§2.3, §2.12).
- A2: `sourceMap: true` in the client tsconfig. `function` comes from `fn` (§5.2, §5.4).
- A3: `controller` removed. `hook` added, with an `enter`/`leave` wrapper (§2.3, §7).
- A4: `count` is frozen at build time and keyed on the pre-check key (§2.3).
- A5: `attempt` restarts at 1 for each sending episode (§1.6).
- A6: `retryAfterSec` is required in the 429 body (§1.5).
- A7: the `net exit …` and `net menu-quit` entries replace the Journal as the quit marker (§2.4, §3.1.4).
- A8: an ordered classification with exact exit-code sets (§2.2).
- A9: the MO2 fallback folder, the launcher's search list, the first-run variant, and `gameLog` only with `trailDir` (§3.1.1, §3.1.8, §2.6). Defect X2 (§9).
- A10: the settings file is never written while the game runs; state survives hot reloads; process hooks are installed once; the claim in §4.2 is corrected (§3.1.6, §4.2).
- A11: no new attempt while a callback is outstanding, and all timing from `tick` (§1.6).
- A12: pid discovery, the exit code through PowerShell, and events matched by pid and normalised (§2.4).
- B1-B11: the game-thread cost rules (§2.3, §2.6, §3.1.4-§3.1.6), including `Error.stackTraceLimit = 16` and a sink that reads the master URL and the token without services (§1.3, §2.3).
- C1: `needsConsent` and the exit prompt (§1.7, §4.4).
- C2: the evidence copy (§2.4).
- C3: identical dependency-free copies and a rule file (§2.11).
- C4: `filesVersion` passed in (§4.2).
- C5: the header rewritten at login (§3.1.2).
- C6: the crash-log folder (§2.4).
- C7: the `hasOurDll` list (§2.4).
- C8: nullable module and offset (§2.4).
- D1: the build id and version come from the pipeline, with a sidecar, and `safe.directory` is noted (§5.1).
- D2: `--store` and the sudo rule (§5.4).
- D3: the map guard moved to `OUTPUT_DIR` and `populate-files.js` (§5.4).
- D4: the front output path (§5.3).
- D5: PDBs come with the DLL drop (§5.4, O15).
- E1: `versions.sp` removed.
- E2: invalid optional fields are removed and flagged (§2.1, §2.12).
- E3: the service name is sanitised.
- E4: HTTP callbacks wrapped, and handles returned (§2.3).
- E5: no `content-type` in SkyrimPlatform headers (§1.2).
- E6: server ids and form descs in the trail (§3.1.4).
- E7: the front guard, injected frames, and O14 (§2.8).
- E8: the `console.error` claim corrected (§2.3, §10).
- E9: the sent file is written from memory (§4.5).
- E10: the fallback host added to O1 (§1.1, O1).
- F: O2 and O5 answered from code; O6 kept, with the expected answer (§9).
- G: O10-O14 added (§9).

**Accepted from P:**
- A1: a linear email rule, escaped S2 names, the 1.25 × cap pre-cut, and a timing fixture (§2.11, §8).
- A2: every crash-log `Name` value becomes `<name>` (§2.4).
- A3: S20 for JSON snippets in any text (§2.11).
- A4: S19 for foreground programs (§2.6, §2.11).
- A5: character sets for fields the sender controls, and the §6.1 Discord output rules.
- A6: the trail grammar is enforced by the backend and by `trail.js`; only registered chat commands on the server (§3.1.4, §3.2.3).
- A7 (§1.7, §2.12, §3.2.1, §4):
  - consent is re-checked at send time, and an opt-out clears the queues;
  - stricter backend consent checks, with the consent object stored;
  - the notice is tracked per profile;
  - P1 disk writes stay off until P2;
  - the notice text mentions the 30-day excerpt;
  - an unanswered "ask" expires.
- A8: storage keyed by `<profileId>:<reportId>`, and seen ids kept per profile (§1.6, §6.3).
- B1: the IP rules fixed for sentence ends and upper case (§2.11).
- B2: more literal names, `#TAG`, OneDrive and folders (§2.11).
- B3 (§1.3, §1.5, §5.4, §6.2):
  - the trust label is described as a spam signal;
  - regression, promotion, thread-budget and build/version safeguards;
  - resolution after the 202, with a load limit;
  - a smaller 202 body;
  - muted profiles get a plain 202.
- B4: records built from known keys, integer limits, control characters stripped, a JSON 500, and the manual route refusing auto payloads (§1.1, §2.12).
- B5: the token is never logged, an HTTPS allow-list, no redirects, O1 extended, and an unverified ceiling (§1.1, §1.3, §9). Defects X1 and X3.
- B6 (§2.12, §3.2.3, §6.1, §6.3):
  - metadata only for ignored reports;
  - a retention table;
  - only the profile id in threads;
  - logs moved to the first reply;
  - a purge script;
  - the actor id in server trails;
  - the dashboard renders text only.
- B7: explicit folder `chmod`, file modes, and unique tmp names (§3.2.1, §3.2.4).
- C: the `NonError:<typeof>` pattern fixed; an explicit `requireJson` for 415; `hasOurDll` listed for Jake (§2.3, §1.1, §10 item 16).

**Rejected or narrowed:**
- **P-B6, profile ids as an HMAC in group records: rejected.** Threads already show the profile id so staff can follow up, and `data/` records are root-only 0600. An HMAC adds key handling without reducing exposure.
- **P-B4, refusing times outside [2025-01-01, receipt + 1 day]: narrowed to a `clockSuspect` flag.** Otherwise a PC with a wrong clock would lose real reports.
- **P-A5, a 422 on every character-set failure: narrowed.** Required fields still get 422. Optional and nullable fields are removed and flagged, and count toward the invalid-payload mute (N-E2). One bad symbol therefore does not lose a crash report.
- **P-A7.4, re-reading the settings file before each send: replaced.** The settings file is no longer written while the game runs (N-A10), so re-reading it would find nothing new. The launcher writes `dbo-consent.json` instead, and the client re-reads that.
- **P-B6, purging the `game.log`/`crash.txt` reply at 90 days: narrowed.** The files move to the first reply as asked. But D5, as approved, keeps the first sample; purging it too is Jake's call and a one-line change.
- **P-A6, only registered chat commands on the client: narrowed to the server.** The client does not know the server's command list. The backend grammar still limits the client's word to `[a-z]{1,16}`.
- **P-A1, "under 100 ms on 400 KB per rule": narrowed.** With the pre-cut, no rule sees more than 40 KB. The fixture uses 64 KB per rule (under 50 ms) and a whole 400 KB report (under 250 ms). S20 measured 25 ms on 64 KB of quotes.
- **N-E4, "wrap at the only construction site, `settingsService.ts:45`": corrected.** `authService.ts:338` and `:374` also construct clients, so errorSink patches `skyrimPlatform.HttpClient` instead (§2.3).
- **P-A3, `customPacketUtil.ts:19` as a leak path: narrowed.** That parse is caught silently. `networkingService.ts:126`, inside the `tick` handler, is a real leak path, and S20 is kept because of it.
- **N-D2, "`data/` is mode 0700": corrected.** `data/` is 0755 today; the new `sourcemaps/` and `symbols/` folders are 0700. The sudo rule is still needed because the folder is root-owned.

---

## Changes in 1.0-rc2

Review sources: **N2** is claude-nate's review of 1.0-rc1 (`/opt/dragonbreak-handover/auto-reports-design/REVIEW-claude-nate-2026-09-26.md`), and **R** is the review of the X5 fixes (`559a98ca`, `90102f66`, `d28822bd`). Both were checked before being folded in: the SkyrimPlatform, hook, HttpClient and menu claims at f8cd7897, the client claims at client-0344 `d28822bd`, the gameplay line numbers at 8c638310, and the launcher build at `/opt/dragonbreak-handover/launcher-build-ct115/BUILD.md`.

**Accepted from N2:**
- Item 12: the exit code is printed signed and converted with `>>> 0` in JavaScript (§2.4, O4, §8).
- Item 10: `/` is allowed in menu names, for `Sleep/Wait Menu` (§3.1.4, §8).
- Item 11: the pause-menu quit gap is stated, and O11 is settled before P5 (§2.4, §9, §10 item 11).
- Item 18 and the HttpClient note: the hook wrapper passes all four `add` arguments and calls `enter` and `leave` with `this` undefined; the HttpClient wrapper calls the native method on the native instance and passes a callback only when the caller gave one (§2.3).
- O2 confirmed from the shipped bundle: errorSink patches `globalThis.skyrimPlatform` and is imported before `skympClient` (§2.3 item 10, §9).
- Process hooks call the current sink through `globalThis` (§2.3 item 9).
- Per-frame cost: listeners never throw, the `sendMessageWithRefrId` listener goes before NetworkingService's, `d` is built inside the event, and one `inv set` entry per `SetInventory` (§3.1.4).
- Front: the handlers in a module imported first, `componentStack` keeps `build.js:L:C`, and the `ErrorBoundary` text names no F6 (§2.3, §2.7, §2.8, §10 item 24).
- trail.js: loaded last, after `movetrace.js`; re-wrapped on every load, by marker; explicit `__dboTrailRec` call sites; `every('trail', …)`; the tmp sequence on `globalThis`; the `commands` registry passed in (§3.2.4); and a reload harness (§8).
- X5: the defect with its fixes, rule S0, the fixtures, and the §2.6 and §2.10 text (§2.4, §2.6, §2.10, §2.11, §8, §9, §10 item 23).
- X1 and X2 marked fixed in client 0.3.47; the in-game sign-in write noted as intended; the auth-file parse error (`d28822bd`) recorded under X1 (§1.3, §9).
- The two MUST NOTs: no `consoleMessage` or `printConsole` capture, and no `browserMessage` argument after `[0]` (§2.10).
- O6 answered and O12 mostly answered from code; each PC item says what to test (§9, §8).
- Where builds run, and O16, now proven by the dry run (§5.5, §9, §10 item 25).
- `resolveJsonModule` in the client tsconfig (§2.11, §5.2).
- The client-0344 line numbers (header, Appendix A).

**Accepted from R:**
- R1: X5's reach is stated. Only the NirnLab backend writes these lines, and the default `auto` falls back to Tilted, so a real uploaded log is checked before players are told what leaked (§9 X5).
- R2: S0 drops a record's continuation lines, with a multi-line `LoadUrl` fixture (§2.11, §8). The two branch filters need the same change (§9 X5).
- R3: the backend filter runs on every manual log field (§9 X5). S0 keys on SkyrimPlatform's own timestamp prefix, which no other log uses.
- R4: the native change is recorded as the real fix, with the voice-token detail (§9 X5).
- R5: the launcher 2.1.30 bump is part of the X5 release (§9 X5).
- R6: each `gameLog` line is capped at 500 characters after the rules (§2.11 step 4); the native `what()` cap is left to the follow-up (§9 X5).
- R7 and R8: recorded as defects X6 and X7 (§9).

**Rejected or narrowed:**
- **N2, "if webpack runs on the PC, add a step that sends the bundle, map and sidecar to CT 115": not needed.** Every build runs on CT 115 (owner rule, 2026-09-24; §5.5), so nothing crosses machines.
- **N2, the authService line numbers: narrowed.** References stay at the f8cd7897 baseline, as the header says; Appendix A maps the client lines that moved on client-0344.

---

## Changes in 1.0-rc3

Review source: **B** is the correctness, privacy and conformance review of backend steps 1-4 (`b61addf9`..`b5a7ce6c`) against rc2. The code was changed where it fell short of the contract; the text was changed where the code was right and the text was not. Nothing here changes what a sender sends.

**The code now does what rc2 says** (backend commits after `4acc81f6`):
- S0 in the rule file and the engine; the `gameLog` line cap and whole-line tail cut; the §8 S0 cases and timing units (§2.11, §8).
- `/` in menu names, and `componentStack` lines with `build.js` positions (§3.1.4, §2.3).
- The invalid-payload and new-signature mutes, the new-signature caps and `unknown-version` (§2.12).
- `scripts/purge-auto-reports.js` (§6.3).
- `--files-version` of `archive-symbols.js` takes a git hash (§2.1, §5.4).

**Text changed to match the code, or to fill a gap:**
- §6: `where` is left out of the key when frames are present, so logged and rethrown copies form one group, as §8 payload 2 requires. The rows for unresolved client and front bundles, and the `js-fatal` form, are spelled out.
- §6.3 and §1.6: the real storage layout, the `-` in file names, and retention rows for `hwidHash`, the counters, the mutes and `unknown-version` (§10 items 26 and 29).
- §2.12: symbols, `faultSymbol` and `versions.os` that a scrub rule would change are removed and flagged; which refusals count toward the mute; the mute's length; `crash-watch-off`; how the known-version list is built; where the new-signature caps apply (§10 items 27 and 28).
- §2.11: text before the first timestamped line gets no count line; the line cap comes before the cut to the cap.
- §2.4 and §6: the backend has no `crashLog.js` until O3. Meanwhile it trusts the sender's parsed fields and runs the `registers` and `relevantObjects` filters again itself.
- §3.1.4: `TGT` and `world` refuse a name after an FF-range desc (rule R).
- §3.3: the join is not built yet; it comes after P1 and P2.
- O1: what an unguarded `CF-Connecting-IP` allows.
- §5.4: the map and PDB guard refuses only with `AUTO_REPORT_SYMBOL_GUARD=true`, since the client bundle still carries an inline map (merge review, 2026-09-29).
- §2.12: the scrub check on names covers every name that reaches a title or key (`fn`, `file`, `event`, `service`, `module`), not only symbols, and refuses an `error.type` it would change (merge review, 2026-09-29).

**Fixture status (§8):**
- In `test/fixtures/auto-report/` now: the S0 cases (CRLF, multi-line `LoadUrl`, a partial first line, empty payloads and breaks inside a line, other log formats), the 2,000-character line, the S0 timing units, `menu open Sleep/Wait Menu`, FF-range names refused, and the rc2 `componentStack` in `ui-error-boundary.json`. `gameLog` values use the real `[hh:mm:ss:mmm] ` prefix.
- Not there yet: `trail/*.jsonl`, `classify/` and `settings/` (for the client and launcher side; who writes them is to be agreed in the ledger), `crashlogs/` (waits on O3) and `server-trail/` (waits on P1).

---

## Appendix A. Code references

**alduinak f8cd7897, backend**
- `skymp5-backend/routes/files.js`
  - `:35-43`: `GET /api/files/version` (the files version is public).
  - `:73-74`: report route comment; "the game uses it too" is out of date.
  - `:77-83`: `identifyReporter`.
  - `:86`: `anonKey`.
  - `:87-104`: manual limiters; `:96-104` is the unverified ceiling.
  - `:106-114`: manual route.
  - `:115`: `bodyErrors`.
- `skymp5-backend/server.js`
  - `:57`: `trust proxy`.
  - `:67-69`: `REPORT_PATHS` skip the global parser.
  - `:85`: `/api/files` mount.
  - `:108`: the default error handler would send a stack trace.
- `skymp5-backend/routes/master-api.js`
  - `:69-71`: session store and `SESSION_TTL`.
  - `:82`: `sessions.json` written with no mode.
  - `:100-103`: `lookupSession`.
  - `:114-120`: `recordLaunchCheck`.
  - `:123-128`: `recordSessionHwid`.
  - `:132-141`: `launchGateStatus`.
  - `:193-198`: session entry shape.
  - `:238-244`: ban check (`:242` logs the refusal).
  - `:253-255`: sliding expiry.
  - `:503`: export.
- `skymp5-backend/routes/launch-check.js`: `:29-49` (`launchCheck {filesVersion, filesOk, pluginsOk}`) and `:36-46` (the sender supplies `filesVersion`).
- `skymp5-backend/sources/problemReport.js`
  - `:12-13`: manual top-level log fields.
  - `:26`: manual parser, 2 MB.
  - `:29-33`: `text()`.
  - `:36-40`: `cleanName`.
  - `:42`: `escapeMarkdown`.
  - `:91`: "no logs" 400.
  - `:93-96`: manual `reportId` and dedupe key.
  - `:109`: Discord mention in manual reports.
  - `:154-161`: `bodyErrors`.
- `skymp5-backend/sources/scrubLog.js`: `:6-20` (rules) and `:25-41` (`scrub`).
- `skymp5-backend/sources/visitorIp.js:6-7`: trusts `CF-Connecting-IP`.
- `skymp5-backend/sources/discord/errorReport.js`: `:13-64` (`request`, `buildMultipart`) and `:108` (only `postReport` is exported).
- `skymp5-backend/sources/discord/audit.js:14`: `allowed_mentions` only.
- `skymp5-backend/routes/version.js`: `:9` (`CLIENT_VERSION`) and `:13-20` (`GET /api/version`).
- `skymp5-backend/scripts/merge-files.js`: `:26-27` (`SKIP_ALWAYS`; the settings file is never shipped), `:129-131` (zip built from `OUTPUT_DIR`) and `:138` (files version).
- `skymp5-backend/scripts/populate-files.js`: `:12-13` and `:44-45` (build output copied into the zip input).
- `skymp5-backend/config.js`: `:53` (`masterUrl` default) and `:115-116` (error forum; the "one thread per reporter" comment is out of date).
- `.gitignore`: `:3` (`sources/client/`) and `:18` (`skymp5-backend/data/*`).

**alduinak f8cd7897, launcher**
- `skymp5-launcher/src/main.js`
  - `:288-290`: `window-all-closed`.
  - `:343-353`: settings path (`:346`, in `Data/Platform/Plugins`) and reader.
  - `:500-541`: hotkey and preference saves write the settings file.
  - `:928-933`: login stores `gameProfileId` and `gameSession`.
  - `:1376-1381`: My Games variants.
  - `:1515-1523`: `tasklist` poll.
  - `:1548`: `LAUNCH_GRACE_MS`.
  - `:1560-1574`: `guardLaunch`.
  - `:1608-1615`: `reportId` kept across retries.
  - `:1630-1631`: `GET /api/version`.
  - `:1777` and `:1806`: detached `skse64_loader.exe` spawns.
  - `:1925`: settings written at launch.
  - `:2799` and `:2821-2822`: the install path clears, writes, then stores `filesVersion`.
  - `:3289-3302`: `writeClientSettings` starts fresh; `HOTKEY_KEYS`.
  - `:3304-3312`: keys written (`:3311` is `master`).
  - `:3337-3347`: `auth-data-no-load.js` (`:3341` is `discordUsername`).
  - `:3426-3460`: `postJSON`, no redirects.
  - `:3463`: `compareVersions`.
- `skymp5-launcher/src/mo2.js`: `:278-287` (`detectEdition`), `:297` (`overwrite_directory`) and `:1343-1347` (detached MO2 launch).
- `skymp5-launcher/src/report.js`: `:10-18` (redactions), `:27-38` (`tail`), `:42-68` (SKSE log discovery) and `:55` (`install.log` in manual reports).
- `skymp5-launcher/src/config.js:11`: `apiUrl`.
- `skymp5-launcher/src/gameversion.js:6-7`: game versions.

**alduinak f8cd7897, client and front**
- `skymp5-client/tsconfig.json:4`: `target: es5`, no `sourceMap`.
- `skymp5-client/webpack.config.js`: `:8-9` (output), `:66-67` (mode, inline map) and `:71-75` (externals).
- `skymp5-client/src/services/spApiInteractor.ts:16-17`: `controller.on` and `once` are `sp.on` and `sp.once`.
- `skymp5-client/src/logging.ts`: `:5-16` (`logError`) and `:19-29` (`logTrace`).
- `skymp5-client/src/services/services/settingsService.ts`
  - `:8-13`: no `post` callback overload.
  - `:29`: settings object.
  - `:39-46`: master URL; `HttpClient` built at `:45`.
  - `:60`: callbacks only in the main menu.
  - `:87-91`: `X-Session`.
  - `:169-174`: `normalizeUrl`.
- `skymp5-client/src/services/services/authService.ts`
  - `:2`: `fs`.
  - `:257-258`: auth file written back.
  - `:329`: `exitProcess`.
  - `:338` and `:374`: `HttpClient` built; `:355` calls `JSON.parse` in the callback.
  - `:430-447`: `readAuthDataFromDisk` (`:431` trace, `:442` `JSON.parse`, `:444` `logError`).
  - `:449-452`: token printed.
- `skymp5-client/src/services/services/characterSelectService.ts`: `:204` (`exitProcess`), `:211-230` (Journal state) and `:238-258` (left to the main menu).
- `skymp5-client/src/services/services/kickService.ts:90`: `exitProcess`.
- `skymp5-client/src/services/services/networkingService.ts`: `:16-18` (send events), `:31` (`printConsole` does not reach `skyrim-platform.log`), `:124-131` (raw messages), `:126` (`JSON.parse` of received content) and `:133-200` (typed receive events).
- `skymp5-client/src/services/services/characterProgressService.ts:324-331`: form desc.
- `skymp5-client/src/services/messages/createActorMessage.ts:28`: `isMe`.
- `skymp5-client/src/view/worldViewMisc.ts`: `:15` (`localIdToRemoteId`) and `:53` (`isRemotePlayerCharacter`).
- `skymp5-client/src/sync/appearance.ts`: `:145-146` (base form named), `:154` (`createNpc`) and `:162-165` (player base).
- `skymp5-client/src/view/formView.ts:129`: remote base renamed.
- `skymp5-client/src/services/services/customPacketUtil.ts`: `:19` (`JSON.parse`, caught silently) and `:26-29` (`once` at run time).
- `skymp5-client/src/services/services/dboRelayService.ts:230-236`: `dbo:` relay.
- `skymp5-client/src/services/services/chatService.ts:340-346`: chat send.
- `skymp5-client/src/services/services/sweetCameraEnforcementService.ts:46`: paths relative to the game folder.
- `skymp5-client/src/messages.ts:1-37`: `MsgType`.
- `skymp5-front/webpack.config.ts`: `:4-8` (output from `config.js`) and `:14-16` (`build.js`, no devtool).
- `skymp5-front/package.json:7`: production build.
- `skymp5-front/src/index.js`: `:18-21` (empty `skyrimPlatform` outside the game) and `:27-34` (`ReactDOM.render`).
- `skymp5-front/src/features/labour/index.tsx:132`: `dbo:` keys built at run time.

**alduinak f8cd7897, SkyrimPlatform**
- `skyrim-platform/src/platform_lib/HttpClientApi.h:20`: `HttpClient` set as a plain property.
- `skyrim-platform/src/platform_lib/HttpClientApi.cpp`: `:46-51` (string headers), `:66-73` (`get` and `post` set per instance), `:88-92` and `:144-148` (callback form chosen from `info[2]`; `host` read from `this`), `:133-190` (`Post`, callback at `:143-146` and `:176-179`) and `:166-171` (result fields, no headers).
- `skyrim-platform/src/platform_lib/HttpClient.cpp`: `:22-24` (3 threads), `:75` (body as a C string), `:77-84` (default timeouts; content type from the option) and `:88-91` (status 0, no error text).
- `skyrim-platform/src/platform_se/skyrim_platform/JsEngine.cpp`: `:49-55` (wrapper script) and `:77-82` (`RunScript`).
- `skyrim-platform/src/platform_se/skyrim_platform/NapiHelper.h:29-34`: the script is `eval`'d.
- `skyrim-platform/src/platform_se/skyrim_platform/NodeInstance.cpp:246-252`: compiled with no origin.
- `skyrim-platform/src/platform_se/skyrim_platform/SkyrimPlatform.cpp`
  - `:115-131`: hot reload.
  - `:133-135`: HTTP callbacks, then `tick`.
  - `:230-237`: plugin-source patch hook.
  - `:246-257`: settings cached.
  - `:317-319`: `skyrimPlatform` object created per load.
  - `:322-331`: `ClearState`.
  - `:408-412`: Node loop only on the update path.
- `skyrim-platform/src/platform_se/skyrim_platform/Settings.h:177-182`: watched plugin folders.
- `skyrim-platform/src/platform_se/skyrim_platform/EventsApi.cpp`: `:57-70` (`on('<ev>')` error log; `:64` is the raw `e.what()`), `:117-141` (hook `add` takes four arguments) and `:176-180` (handle).
- `skyrim-platform/src/platform_se/skyrim_platform/EventsApi.h:27-30`: `on` and `once` properties.
- `skyrim-platform/src/platform_se/skyrim_platform/Hook.cpp`: `:67-71` and `:94-98` (hook errors rethrown as text); `:124` and `:185` (`enter` and `leave` called with `this` undefined).
- `skyrim-platform/src/platform_se/skyrim_platform/Win32Api.cpp:18-21`: `exitProcess` sets `quitGame`.
- `skyrim-platform/src/platform_se/skyrim_platform/main.cpp`
  - `:96-103`: `skyrim-platform.log` in the SKSE log folder.
  - `:107-108`: log emptied at start.
  - `:120`: log pattern `[%H:%M:%S:%e] %v`, no level field.
  - `:504`: image name.
  - `:530-531`, `:613-615`, `:623-626`: ForegroundGuard lines.
- `skyrim-platform/src/platform_se/skyrim_platform/ConsoleApi.cpp`: `:35-44` (`printConsole` goes to the in-game console, not the log) and `:395-407` (`Data\Platform\Logs\`).
- `skyrim-platform/src/platform_se/skyrim_platform/Settings.cpp`: `:14` (`LogLevel` defaults to 2, info) and `:37` (`BackendName` defaults to `auto`).
- `skyrim-platform/src/platform_se/skyrim_platform/ConstEnumApi.cpp:563`: `Sleep/Wait Menu`.
- `skyrim-platform/src/platform_se/skyrim_platform/DevApi.cpp:173-177`: the platform version is the constant `2.9.0`.
- `skyrim-platform/src/platform_se/skyrim_platform/BrowserApiNirnLab.cpp`: `:75` (`LoadUrl` logs the whole URL), `:83-91` (`JS` logs the first 120 bytes, `\n` turned into spaces) and `:176` (UI URL).
- `skyrim-platform/src/platform_se/skyrim_platform/BrowserApi.cpp`: `:15-30` (backend choice; `auto` falls back to Tilted) and `:62-89` (`kOff` falls through into `kTilted`, X7).
- `skyrim-platform/src/platform_se/skyrim_platform/BrowserApiTilted.cpp:83-94` and `skyrim-platform/src/tilted/ui/MyChromiumApp.cpp:272-291`: the Tilted path logs neither scripts nor URLs.
- `skyrim-platform/src/platform_se/skyrim_platform/TickHandler.h:27-33`: `tick`.
- `skyrim-platform/tools/dev_service/index.js:202-205`: PDBs deleted from the release.

**Gameplay 8c638310**
- `gamemode.js`
  - `:46`: `every` (stops the timer of the same name first).
  - `:137`: `profileOf`.
  - `:144`: tag alphabet.
  - `:156`: `display` (`Name #TAG`).
  - `:336-337`: `commands` and `registerChatCommand`.
  - `:699` and `:748` (`onActivate`), `:1307` (`onEatItem`), `:2391` (`onDeath`), `:2408` (`onHitDamage`), `:2442` (`onConsoleCommand`), `:2486` (`onTakeItem`), `:2512` (`onSpellCast`): hooks assigned on every load.
  - `:785-791`: `__dboHandlers` dispatch (`customPacket` at `:791`).
  - `:1017-1018`: `onCharacterReady` and `connectedAt`.
  - `:1032`: `JOIN`.
  - `:1074`: `__dboHandlers.connect`.
  - `:1095-1096`: `__dboHandlers.disconnect` and `LEAVE`.
  - `:2469-2474`: `itemguards.js` loader.
  - `:3216-3219`: `clientState` Journal.
  - `:3221-3226`: debugsnap loader (context object at `:3225`).
  - `:3337-3369`: `supernatural.js`, `downed.js`, `regions.js`, `spells.js` and `alchemy.js` loaders.
  - `:3378-3383`: `movetrace.js` loader, the last one.
- `downed.js:452`: a keep-once guard.
- `tests/*-harness.js`: the gameplay test harnesses.
- `debugsnap.js`
  - `:15`: `registerChatCommand`.
  - `:19`: `hex()`.
  - `:23`: `nameOrId`.
  - `:25-47`: `playerView` (names at `:28` and `:38`, players skipped at `:32`, `baseDesc` at `:36`).
  - `:49-52`: synchronous write.
  - `:54-68`: asynchronous `live.json` write (`:63`, no mode).
  - `:74`: 5 s loop.
- `tooling/dbo-monitor/dbo_monitor.py:21-22`: state folder only.

**On CT 115:**
- `/var/lib/dbo-monitor` is 0755 and `live.json` is 0644. The umask is 0022.
- `/opt/alduinak/skymp5-backend/data` is 0755 and root-owned.
- The shipped client zip (2026-09-26) holds `SkyrimPlatform.dll`, `MpClientPlugin.dll`, `SkyrimPlatformImpl.dll`, `libnode.dll`, `libcef.dll` and `SkyrimPlatformCEF.exe.hidden`, and no `.map` file. It ships no `SkyrimPlatform.ini` and no NirnLab plugin, and its `SkyrimPlatformImpl.dll` holds the "falling back to Tilted UI" message.
- `/opt/dragonbreak-handover/launcher-build-ct115/BUILD.md`: the launcher dry run (O16).

**alduinak client-0344 `d28822bd`** (client 0.3.47, `a8af458f`, plus the auth-file fix)
- `skymp5-client/src/index.ts`: `:1-6` (`skyrimPlatform` imports, then `skympClient` at `:6`) and `:102` (`bAlwaysActive`).
- `skymp5-client/src/services/services/remoteServer.ts:115`: `on('update')` at module load.
- `skymp5-client/src/services/services/authService.ts`
  - `:183`: the whole custom packet printed on a parse error (X6).
  - `:252-262`: the auth file read at start and not written back (X2 fixed).
  - `:280`, `:287`: only `arguments[0]` of a browser message is logged.
  - `:308-309`: an in-game sign-in writes the file.
  - `:330` and `:435`: `events` first in the login widget's `getText`.
  - `:337`: `exitProcess` (`:329` at f8cd7897).
  - `:346` and `:382`: `HttpClient` built (`:338` and `:374` at f8cd7897); `:363`: `JSON.parse` in the callback.
  - `:439-457`: `readAuthDataFromDisk` (`:440` trace, `:451` `JSON.parse`, `:454` the error's name only).
  - `:459-`: `writeAuthDataToDisk`, byte count only (X1 fixed).
- `skymp5-client/src/services/services/chatService.ts`: `:432` (character name to the UI) and `:439` (each chat line to the UI).
- `skymp5-client/src/services/services/systemNotification.ts:9` and `dboRelayService.ts:189`: notices and banners to the UI.
- `skymp5-client/src/services/services/voiceService.ts:271`: voice URL and token to the UI.
- `skymp5-client/src/services/services/browserService.ts:21`, `:168`: F6 focuses chat.
- `skymp5-client/src/services/services/networkingService.ts`: `:18` (`sendMessageWithRefrId` listener), `:29-32` (a failed send is rethrown so it reaches the log) and `:58` (`_refrId` deleted).
- `skymp5-client/src/services/services/sweetTaffyEvalService.ts:30`: the whole custom packet printed on a parse error (X6).
- `skymp5-client/src/services/services/frontHotReloadService.ts:40`: the only `browser.loadUrl` caller (development only).
- `skymp5-client/tsconfig.json`: no `sourceMap`, no `resolveJsonModule`.

**Other commits**
- `a893a452`: X1 and X2 fixed (client 0.3.47).
- `559a98ca` and `90102f66` (fork branch `launcher-report-no-chat`): the X5 launcher and backend filters.
- `8a9c6c94`: the pre-release launcher report that sent `skyrim-platform.log` in `clientLog`.
- `5a5f56a2`: launcher 2.1.29, the pattern for a version bump commit.
- `skymp5-launcher/src/main.js:1704-1726` (f8cd7897): the silent in-app update, `/S --force-run`.

## Changelog

- **1.0-draft (2026-09-26):** first draft by claude-jake from the approved design, for claude-nate's review.
- **1.0-rc1 (2026-09-26):** claude-nate's review and the privacy and security review folded in (see "Changes after review").
- **1.0-rc2 (2026-09-26):** claude-nate's review of rc1 and the review of the X5 fixes folded in: defect X5 and scrub rule S0, X1 and X2 marked fixed, X6 and X7, the signed exit code, `/` in menu names, O11 before P5, the hook, HttpClient and process-hook forwarding rules, the trail.js load and wrap rules, `componentStack` positions, where builds run, and O16 (see "Changes in 1.0-rc2").
- **1.0-rc3 (2026-09-26):** the review of backend steps 1-4 folded in: the §6 canonical strings without `where`, the storage layout and retention rows, the mute, cap and `unknown-version` rules, the backend's crash-section filters until O3, FF-range names in the grammar, the join and fixture status (see "Changes in 1.0-rc3").
