# DragonBreak website profiles

The website's "Log in with Discord" signs a player in with Discord and opens
`/profile.html`, a page that lists that player's own characters. This page covers what it
shows, the API behind it, where the data comes from, what is never sent to a browser,
the settings, the name table the game server writes for it, and how to deploy it and
roll it back.

## What players see

- **Signed out:** a "Log in with Discord" panel. After a failed sign-in it shows a fixed
  message for each `?error=` value (`cancelled`, `state`, `discord`, `unconfigured`); the
  value itself is never shown.
- **Signed in:** an account panel (Discord name and avatar, access badge, account created,
  last launcher sign-in, launcher download, Sign out), then a "Your characters" grid. The
  badge fills in when its own request answers, so the characters never wait on Discord. A card opens that
  character's detail view (`#c=<key>`, picked in the page with no extra request).
- **Never played:** "No characters yet" and the launcher download. Signing in on the
  website creates no game account; the only thing written is the website session.
- **LAN address (:80):** "Sign-in works on the public site only". The LAN listener does
  not proxy `/api/site/`, and the sign-in cookies belong to the public host.

Owner decisions (2026-09-21):

1. Any Discord user may sign in. The access badge tells them whether they can play.
2. A character shows race, location (worldspace or cell name, never coordinates) and
   faction and hold titles on top of the basic fields. Location and titles are on by
   default and each can be switched off (`SITE_SHOW_LOCATION=off`,
   `SITE_SHOW_FACTIONS=off`). Accepted caveats: an interior cell name can identify a
   house, and faction requirements have no "secret" flag, so every rank a player holds
   appears on their page.
3. Players see only their own characters. There are no public profiles.
4. The site files live in git under `website/` and are deployed by copy.

## Sign-in flow

`skymp5-backend/routes/site-auth.js`, mounted at `/api/site` in `server.js`. It is a third
Discord OAuth flow on the same Discord application as the launcher and the dashboard, with
its own redirect URI and its own session store. The launcher flow is not reused because it
creates a profile id and a `players.json` row for every visitor and mints a game token;
the dashboard flow is for staff only.

1. `GET /api/site/login` first sends a visitor on any other host (for example `www.`) to
   the same path on the host of `DISCORD_SITE_REDIRECT_URI`, because the state cookie is
   host-only and Discord returns to that host. There it sets the `db_site_state` cookie
   (32 random bytes, `Path=/api/site/callback`, 10 minutes) and redirects to Discord with
   scope `identify`.
2. Discord redirects to `GET /api/site/callback`. The backend clears the state cookie and
   compares it with the `state` query in constant time before any Discord call. Then it
   exchanges the code, reads `/users/@me`, stores a session and sets `db_site`
   (`Path=/api/site`, lifetime `SITE_SESSION_TTL_HOURS`). Only `/api/site/*` reads it, so
   the browser does not send it with page loads or to other proxied services such as
   `/api/status`.
3. The page calls `whoami` with that cookie, then `characters` and `access` side by side.

Details:

- Both cookies are `HttpOnly; SameSite=Lax`, plus `Secure` when `WEBSITE_URL` starts with
  `https:`. `Secure` comes from config, not the request: TLS ends at Cloudflare, so
  requests reach the backend as plain http.
- Sessions live in `skymp5-backend/data/site-sessions.json` (gitignored, mode 600), a JSON
  array of `[token, {discordId, username, avatar, expiresAt}]`. The lifetime is fixed from
  sign-in, not sliding. `sources/siteSessions.js` is a second instance of the
  `sources/sessionStore.js` factory that also backs dashboard sessions.
- The profile id is looked up on every request (`profiles.load().map[discordId]`),
  read-only, and never kept in the session. The site never calls `getOrCreateProfileId`,
  `upsertFromDiscordUser` or `createSession`.
- A site token is accepted by `/api/site/*` only. `requirePermission` and the admin routes
  read dashboard sessions only.
- Discord calls go through `sources/discord/oauth.js`, shared with the launcher and
  dashboard flows, with a 20 s deadline per request. From CT 115 each call took about 5 s
  in testing (slow DNS), so a sign-in can take 5 to 10 s.
- Only callbacks that pass the state check count toward the rate limits. Every website
  visitor reaches the backend from the same proxy hop, so each visitor is told apart by the
  `CF-Connecting-IP` address Cloudflare adds: 5 callbacks a minute per address. Requests
  without that header (LAN, test copies) skip the per-visitor limit. On top of that, 60
  callbacks a minute for the whole site protect the Discord application the launcher
  shares. Over either limit the callback returns a plain-text 429.

## Routes

Every response under `/api/site/` carries `Cache-Control: no-store, private`, including
redirects, errors and 404s. No route takes a profile id or form id from the browser.

| Route | Needs | Responses |
|---|---|---|
| `GET /api/site/login` | nothing | 302 to Discord. 302 to `/profile.html?error=unconfigured` when `DISCORD_CLIENT_ID` is empty. 302 to `/api/site/login` on the redirect URI's host when the request came in on another host. 302 to `/profile.html` when the visitor is already signed in, so the home page's "Log in with Discord" buttons take a returning player straight to the profile. |
| `GET /api/site/callback` | state cookie | 302 to `/profile.html` on success. On failure 302 to `/profile.html?error=cancelled` (Discord sent `?error`), `?error=state` (state cookie missing or different; Discord is not called) or `?error=discord` (no code, or Discord refused or failed). Plain-text 429 over the rate limit. |
| `GET /api/site/whoami` | cookie (optional) | 200 `{"signedIn":false}`, or 200 with the account shape below. 500 `{"error":"internal"}` on an unexpected error. |
| `GET /api/site/access` | cookie | 200 `{"allowed":...,"reason":...}`, see [access](#access). 401 `{"error":"signedOut"}`. 500 `{"error":"internal"}` on an unexpected error. |
| `GET /api/site/characters` | cookie | 200 `{"characters":[...]}`, empty for a Discord account with no profile or no characters. 401 `{"error":"signedOut"}`. 503 `{"error":"storeUnavailable"}` when `CHANGEFORMS_DIR` is missing or unreadable. |
| `POST /api/site/logout` | cookie, `Origin` | 204: revokes the session and clears `db_site`. 403 `{"error":"badOrigin"}` unless `Origin` equals the origin of `WEBSITE_URL`. |

### whoami

```json
{
  "signedIn": true,
  "discord": { "name": "...", "avatarUrl": "https://cdn.discordapp.com/avatars/... or null" },
  "account": { "hasProfile": true, "createdAt": "ISO or null", "lastLauncherLogin": "ISO or null" }
}
```

It reads local files only, so it answers at once.

- `discord.name` is Discord's `global_name`, else `username`, and `avatarUrl` is built from
  the avatar hash. Both are taken at sign-in, so they change only at the next sign-in.
- `account.hasProfile` is true when `profiles.json` maps the Discord id to a profile id.
  `createdAt` is `players.json` `createdAt`: when the backend first made the player's row
  (launcher sign-in, game connection, or staff adding the player). `lastLauncherLogin` is
  `players.json` `lastSeenAt`, which only the launcher sign-in writes.

### access

```json
{ "allowed": false, "reason": "banned | serverLocked | notWhitelisted | accessUnavailable | null" }
```

- It follows the game's own gates. `reason` is `banned` when `data/bans.json` matches the
  Discord id or the `players.json` hwid, as the game's session and connection checks do
  (`routes/master-api.js`); bans set in game or on the dashboard only write that file.
  Otherwise it is `serverAccess.getDiscordAccess(discordId)` cut down to `allowed` and
  `error`.
- The Discord lookup gets 8 s (`ACCESS_DEADLINE_MS`). If it takes longer or throws, the
  answer is `accessUnavailable`, shown as "Unknown", and one line is logged. The lookup
  keeps running and fills the bot's 60 s role cache, so a reload soon after usually
  answers at once. Without the deadline a stalled Discord takes about a minute to fail
  (discord.js retries, then the HTTP fallback), and nginx gives up at 60 s.
- When the Discord role lookup fails quickly, the role list reads as empty
  (`sources/discord/bot.js` `getMemberRoles`), so a whitelisted player shows as
  `notWhitelisted` while Discord is unreachable. The page says so beside the badge.

### characters

One entry per character:

| Key | Type | Source |
|---|---|---|
| `key` | string | The changeform's `formDesc`. Only an opaque key for the page's `#c=` link: form ids are reused over time, so it is not a permalink. |
| `name` | string | `displayName`, else `appearanceDump.name`, else `"Unnamed"`, or `"Unnamed (in creation)"` when there is no appearance yet. Sent verbatim; the page inserts it as text. |
| `status` | `"alive"`, `"dead"`, `"permaDead"`, `"creating"` | First match wins: `dynamicFields['private.permaDead'] === true`; `isDead`; no `appearanceDump`, `isRaceMenuOpen`, or `private.creationPending === true`; otherwise alive. The same tests as `skymp5-server/ts/systems/spawn.ts`. |
| `sex` | `"female"`, `"male"` or null | `appearanceDump.isFemale` |
| `weight` | number or null | `appearanceDump.weight` (0 to 100) |
| `vitals` | `{health, magicka, stamina}`, each an integer 0 to 100 or null | `healthPercentage`, `magickaPercentage`, `staminaPercentage`. The store saves fractions, not absolute values. |
| `gold` | integer | Sum of `inv.entries[].count` where `baseId` is 15 (`0xf`, Gold001, the id `masterySystem.ts` and `bountyBoardSystem.ts` use) |
| `itemStacks` | integer | `inv.entries.length`. Item names are never sent. |
| `masteries` | integer | Length of `dynamicFields['private.mastery'].order` |
| `tag` | string or null | `dynamicFields['private.charTag']` when it is 4 characters, as on the select screen |
| `race` | `{label}` or null | Name table `races[appearanceDump.raceId]`. null when there is no table or the id is not in it. |
| `location` | `{label, editorId}` or null | Name table `places[worldOrCellDesc]`: the display name, or the editor id with `editorId: true`, which the page shows as "(editor ID)". null when `SITE_SHOW_LOCATION=off` or the place is not in the table. Never coordinates. |
| `titles` | `[{title, group}]` or null | See [Titles](#titles). `[]` when the player holds nothing, null when `SITE_SHOW_FACTIONS=off`. `group` may be `""`. |
| `lastSaved` | ISO string | mtime of the changeform file, shown as "Record last saved". It is when the server last wrote the record, not when the player was last online. |

**Which characters.** Changeforms in `CHANGEFORMS_DIR` whose file name matches
`^[0-9a-f]+\.json$` (runtime-created forms; every player character is one, and this skips
`*.json.tmp` files and plugin refs), with `recType` 1, `profileId` equal to the signed-in
account's profile id, and not `isDeleted`. When `dynamicFields['private.indexed.discordId']`
is set it must equal the signed-in Discord id. Sorted by numeric form id. The store is read
at most once every 3 s, through the reader the Server Manager's Players tab also uses
(`skymp5-backend/sources/characters.js`). Characters of a deleted player row keep the old
profile id, so they are not shown; the game never loads them again either.

### Titles

Titles follow what the game applies to each character:

- **Hold and stronghold offices** come from `officials.json` plus `zones.json` in
  `ZONES_DIR`, read the way `skymp5-server/ts/systems/zones.ts` reads them
  (`sources/officials.js`). For each zone in `holds`, `strongholds` and `regions`, the
  office is the first rank in the zone's `officials` list that lists the profile id. The
  title is `rankTitles[rank]` (else the rank) and the group is the zone's name. Offices
  belong to the profile, so they appear on every character of the account.
  `officials.json` is written by the gamemode's `/appoint` and `/dismiss`.
- **Faction ranks** come from `factionWhitelist.getPlayerGameFactions(discordId)`
  (`data/faction-whitelist.json`), the same rows the game receives. The title is the
  requirement's rank and the group its group. A row with no slot applies to every
  character; a row with slot 0 to 2 applies only to the character whose `private.charSlot`
  matches, as `filterAccessForSlot` does at spawn.
- Offices come first, as in `housingSystem.ts` `holdRanks`, and identical `{title, group}`
  pairs are merged. Only `title` and `group` are sent.
- Two cases where the site follows its own rule: if two characters of one account share a
  `charSlot`, the game reassigns all but one at spawn, but the site shows the slot's rows
  on both. With `characterSelect` off the game applies every row to the one character,
  but the site still filters by `charSlot`. Live has `characterSelect` on (2026-09-21).

## Privacy rules

Every output object is built field by field (`toSiteCharacter`, `accessOf` and the
`whoami` handler); nothing is passed through from a stored record. `players.decorate()`,
`getByProfileId()` and `list()` are never called, because they copy whole rows.

Never sent to a browser:

| Data | Why |
|---|---|
| Discord id, profile id | The Discord id stays in the server-side session. The one exception is the viewer's own id inside `whoami`'s `avatarUrl`, because Discord's CDN path contains it; no other account's id is ever sent. The profile id is the key other backend routes are indexed by. |
| `players.json` `hwid`, `lastIp`, `notes` | Sensitive, or written by staff. Only `createdAt` and `lastSeenAt` are read. |
| Discord roles and access settings | `getDiscordAccess` also returns `roles` and `settings` (which include `lockedDiscordIds`); only `allowed` and `error` are copied. |
| `position`, `angle`, `spawnPoint*` | Exact coordinates, at most about 30 s old, would let anyone track a player. Location is a worldspace or cell name only. |
| `dynamicFields` as a whole | It holds the Discord id mirrors, Discord roles, faction snapshots, pending flags, housing, law and roleplay state and mastery internals. Only the values in the characters table are derived from it. |
| Item and equipment names | The client supplies them, and housing keys carry a credential in their name. Only the stack count and the gold total are sent. |
| Appearance internals (head parts, tints, morphs, colours) | Nothing resolves them, and the page does not need them. |
| Faction row details (`permission`, `requirementId`, `factionId`, `scope`, `slot`, numeric `rank`, notes, creator) | Staff data. Only `title` and `group` are sent. |
| `consoleCommandsAllowed`, `learnedSpells`, `effects`, engine factions, balances | Staff markers, or nothing resolves them. |
| Ban records (`bans.json` reason, hwid, IP, who banned) | Staff data. A match only turns the access reason into `banned`. |
| Other accounts' characters | Anonymity and the mask system. Owner decision 3. |
| Online status | The backend cannot see it, and `isDisabled` does not mean offline. |

- A visitor who has never played gets no row in `profiles.json` or `players.json`; only
  the site session is written.
- The page inserts every string with `textContent` and never uses `innerHTML`. It loads no
  external script, and it shows an avatar only when the URL is on
  `https://cdn.discordapp.com`.
- Scope: these rules cover `/api/site/*` only. The other backend routes the public
  listener proxies (`/api/servers/*`, `/api/serverinfo` and the rest of the `:81` block)
  are unchanged by this feature, by owner decision (2026-09-21).

## Configuration

Backend keys are read in `skymp5-backend/config.js`, with examples in `.env.example`. The
Server Manager shows them in its "Website profiles" group. On CT 115 they go in
`/opt/dragonbreak/backend.env`, which is live and not in git.

| Key | Default | Notes |
|---|---|---|
| `WEBSITE_URL` | `http://localhost:4001` | Existing key. Must be the exact public origin the pages are served from (live: `https://dragonbreakonline.com`). It decides `Secure` on the cookies, the default redirect URI and the only `Origin` that may sign out. |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | empty | Existing keys, shared with the launcher and the dashboard. An empty client id sends `/login` to `?error=unconfigured`. |
| `DISCORD_SITE_REDIRECT_URI` | `WEBSITE_URL` + `/api/site/callback` | Must be registered, exactly, under Redirects in the Discord application. |
| `SITE_SESSION_TTL_HOURS` | `24` | Any positive number; anything else means 24. |
| `CHANGEFORMS_DIR` | `build/dist/server/world/changeForms` in the repo | The game server's `<databaseName>/changeForms`. File driver only. |
| `NAME_TABLE_PATH` | `build/dist/server/name-table.json` in the repo | The game server writes it in its working directory. |
| `ZONES_DIR` | the folder of `NAME_TABLE_PATH` | Folder with `zones.json` and `officials.json`, also the game server's working directory. |
| `SITE_SHOW_LOCATION` | on | `off` (any case) hides location. Anything else shows it. |
| `SITE_SHOW_FACTIONS` | on | `off` (any case) hides titles. Anything else shows them. |

**Live paths on CT 115 (checked 2026-09-21).** The game server runs in
`/opt/alduinak/build/dist/server` (`skymp.service`) with the file driver and the default
database name `world`, and `build/dist/server/world` is a symlink to
`/opt/skymp-state/world`. So leave `CHANGEFORMS_DIR`, `NAME_TABLE_PATH` and `ZONES_DIR`
unset: the defaults reach the live store through the symlink and the name table and zones
in the game server's folder. Setting `CHANGEFORMS_DIR` does not move the other two. Neither
unit sets `User=`, so both run as root and can read these files.

The backend logs one `[jsonCache] <path> not readable (ENOENT)` line the first time a name
table, `zones.json` or `officials.json` it looks for is missing, and again each time one
disappears after being found. Until the game server has written its first name table, or
while nobody holds an office, that line is expected.

## The name table

The backend cannot turn race and place ids into names by itself: the ids depend on the load
order, and the plugin scanner lives in the game server's bundled TypeScript. So the game
server writes a table for it.

- **Generator:** `skymp5-server/ts/systems/nameTable.ts` (`NameTableSystem`, the last
  system in `ts/index.ts`).
- **When:** every game-server start. At init it deletes the old `name-table.json`, so a
  table from another load order is never used. It then scans in the background, without
  holding up startup, and writes the file when the scan finishes (temp file, then rename).
  A load-order change needs a restart anyway, and the updater restarts the game server on
  every new commit on `main`.
- **What it scans:** RACE, WRLD and CELL records in every plugin of `loadOrder` under
  `dataDir` (`scanRecords` in `espmEditorIds.ts`). Records with no editor id are skipped.
  - Races are keyed by the global form id from `mp.getIdFromDesc`, the same id the game
    saves in `appearanceDump.raceId`. The label is the editor id without "Race", split at
    capitals (`raceLabel` in `spawn.ts`, shared with the character select card):
    `DarkElfRace` -> `Dark Elf`.
  - Places are keyed by `hex:plugin`, normalized like `normDesc` in `zones.ts`. Later
    plugins overwrite earlier ones. `full` is the display name, or null when the plugin is
    localized (its names live in string files the scanner does not read). The vanilla
    masters are localized, so vanilla places show editor ids, for example
    `WhiterunWorld (editor ID)`.
- **Format** (the race row shows the expected Nord entry):

  ```json
  {"v":1,"generatedAt":"<ISO>","loadOrder":["Skyrim.esm","..."],
   "races":{"79686":{"desc":"13746:Skyrim.esm","edid":"NordRace","label":"Nord"}},
   "places":{"1a26f:skyrim.esm":{"type":"WRLD","edid":"WhiterunWorld","full":null}}}
  ```

- **Backend side:** `sources/nameTable.js` parses the file again only when its mtime or
  size changes (`sources/jsonCache.js`). A missing, unreadable or malformed table, or one
  whose `v` is not 1, counts as no table: race and location are null and the characters are
  still listed. The first request after each game-server start parses the whole file once.
- **Not resolved:** DragonBreak roleplay races. Several roleplay races share one engine
  race, and no roleplay race is saved on the character.

How to check it on CT 115:

```sh
grep '\[nameTable\]' /var/log/skymp-server.log | tail -n 3
python3 - <<'EOF'
import json
t = json.load(open('/opt/alduinak/build/dist/server/name-table.json'))
print(t['v'], t['generatedAt'], len(t['loadOrder']), 'plugins', len(t['races']), 'races', len(t['places']), 'places')
print(t['races'].get('79686'), t['races'].get('79687'))
EOF
```

- The log line reads `[nameTable] <n> races, <m> places written to ./name-table.json in
  <ms> ms`, or `no table written: ...` / `disabled: ...` when it fails.
- `loadOrder` must list as many plugins as `server-settings.json`.
- Oracle: `79686` (`0x13746`) must be `NordRace` and `79687` (`0x13747`) `OrcRace`, the ids
  `skymp5-front/src/features/charCreator/data/races.js` records from the live load order.

## Website files

`website/` holds the pages in git:

- `profile.html` (new): the profile page. Its CSS and script are inline, like the home
  page's, and it uses the `dbo.css` components.
- `index.html`: the live home page with both "Log in with Discord" buttons pointed at
  `/api/site/login` and step 3 reworded.
- `play.html`: now only a redirect to `/profile.html`.

`dbo.css`, `site-config.json`, the images and `downloads/` stay in the web root only,
unchanged. Pushing to `main` does not deploy the website; the files are copied to CT 107 by
hand.

## Deployment runbook

Other operators work on this server at the same time. Before each step that changes
something shared, run `/root/dragonbreak-ops/ops status` on the Proxmox host and claim the
resource (`github-main` for the push, `backend` for CT 115's env and restart, `website` for
CT 107). Message the other Claude sessions before a push or a restart, back up each live
file with `cp -a f f.bak-$(date +%Y%m%d-%H%M%S)`, log every change with its rollback
(`ops log`) and release the claim when done. See `/root/dragonbreak-ops/README.md`.

Order matters: backend, then nginx, then the pages. Once the new `index.html` is live its
buttons point at `/api/site/login`, which is a 404 until the nginx block exists.

0. **Read-only prechecks.**
   - CT 115: `python3 -c "import json;print(list(json.load(open('/opt/alduinak/skymp5-backend/data/profiles.json'))))"`
     prints `['nextId', 'map']`.
   - CT 115: `grep -o '^[A-Z_]*=' /opt/dragonbreak/backend.env` lists key names only.
     Confirm `WEBSITE_URL` is exactly the public origin, with no path or trailing slash.
   - CT 115: `node -e 'Object.hasOwn({}, 0)'` exits without an error (the backend uses
     `Object.hasOwn`; CT 115 had Node 22 on 2026-09-21).
   - CT 107: `docker ps`, then `docker inspect <container>` for the config and web-root
     mounts. The ops README lists the config at `/opt/skymp-download-conf` and the site
     files at `/opt/skymp-download`; confirm them.
1. **Discord Developer Portal**, the same application as the launcher: OAuth2 -> Redirects,
   add `https://dragonbreakonline.com/api/site/callback`. It must equal
   `DISCORD_SITE_REDIRECT_URI` exactly.
2. **CT 115 env** (claim `backend`). With the live paths above no new key is needed. Add
   `SITE_SHOW_LOCATION=off` or `SITE_SHOW_FACTIONS=off` only to hide those fields, and
   `SITE_SESSION_TTL_HOURS` to change how long a sign-in lasts. Back up `backend.env`
   before editing it.
3. **Push** (claim `github-main`, check nobody is in game). Push all the commits in one
   batch. Within 5 minutes the updater hard-resets `/opt/alduinak`, rebuilds and restarts
   the game server, which drops everyone in game. The game server then writes the name
   table; check it as in "How to check it".
4. **Restart the backend.** The updater only restarts `skymp`, never the backend.
   - Confirm `/opt/alduinak` is at the pushed commit: `git -C /opt/alduinak log -1 --format=%h`.
   - `systemctl restart dragonbreak-backend`, then `tail -n 50 /var/log/dragonbreak-backend.log`
     (the unit logs to that file, not to the journal).
   - `curl -si http://127.0.0.1:4000/api/site/whoami` gives 200 `{"signedIn":false}` with
     `Cache-Control: no-store, private`.
   - The restart also restarts the WS relay, the Discord bot and the dashboard. Dashboard
     sign-ins survive: their session file format is unchanged.
   - Server Manager (Windows): restart the app to get the "Website profiles" settings
     group, and smoke-test the Players tab, which now reads characters through
     `skymp5-backend/sources/characters.js`.
5. **CT 107 nginx** (claim `website`). Back up the live config; the repo has no copy of it.
   In the `:81` (public) server block, next to the `/api/users/login-discord` location, add:

   ```nginx
       # Website sign-in and profile API
       location ^~ /api/site/ {
           proxy_pass http://192.168.12.100:14000;
           proxy_set_header Host $host;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto $scheme;
           proxy_read_timeout 60s;
       }
   ```

   `proxy_pass` must be the same target as the existing `/api/users/login-discord` block
   (the host's forward to the backend's port 4000). Keep `proxy_set_header Host $host`:
   `/api/site/login` compares the visitor's host with the redirect URI's host. `^~` keeps
   the regex locations, such as the `.zip` rule, from matching these paths. Do not add it
   to `:80`. Then run
   `docker exec <container> nginx -t && docker exec <container> nginx -s reload`, and from
   outside `curl -si https://dragonbreakonline.com/api/site/whoami` gives
   `{"signedIn":false}`.
6. **Pages.** Back up the web-root `index.html` and `play.html`. Diff the live `index.html`
   against `website/index.html`: the only differences should be the two button links and
   step 3. If the live page has changed since 2026-09-21, merge those edits into
   `website/index.html` first. Copy `website/profile.html`, `index.html` and `play.html`
   into the web root. Move the `*.bak-*` files out of the web root too: they are served
   publicly.
7. **Cloudflare.** Confirm no Access application covers `/profile.html` or `/api/site/*`
   and no cache rule caches them. By default Cloudflare does not cache HTML, `no-store`
   responses or responses that set cookies; if a rule caches HTML, purge `/index.html` and
   `/play.html`.
8. **Verify.**
   - In a private window: Log in with Discord, approve on Discord, and `/profile.html`
     lists your characters; open one.
   - DevTools: `db_site` is HttpOnly, Secure, SameSite=Lax, Path=/api/site.
   - Sign out returns to the signed-out view. "Sign-out failed" means `WEBSITE_URL` is not
     the origin in the address bar (for example `www.` versus the bare domain).
   - With a Discord account that has never played, `sha256sum` of `profiles.json` and
     `players.json` is the same before and after signing in.
9. Log each change with `ops log` and release the claims.

### Rollback

Each step can be undone on its own, newest first. Never edit files under `/opt/alduinak`
to roll back: the updater resets that checkout to `origin/main`.

- **Pages:** restore the backed-up `index.html` and `play.html` and delete `profile.html`.
- **nginx:** remove the `/api/site/` block, `nginx -t`, reload. This alone takes the
  feature off the public site; the profile page then shows "Sign-in works on the public
  site only".
- **Hide fields without a code change:** `SITE_SHOW_LOCATION=off` and/or
  `SITE_SHOW_FACTIONS=off` in `backend.env`, then restart the backend.
- **Sign everyone out:** stop the backend, delete `skymp5-backend/data/site-sessions.json`,
  start it. Sessions are held in memory, so deleting the file while the backend runs does
  nothing.
- **Backend code:** `git revert` the site commits on `main` ("website Discord sign-in",
  "signed-in character list", "race and place labels from the name table", "faction and
  hold titles on website characters", and if needed the three shared-helper commits before
  them), push (one game-server restart), then restart the backend. Reverting "shared
  changeform character reader" also changes `server-manager/src/main.js`, so restart the
  Server Manager too. `data/site-sessions.json` can then be deleted, and the new env keys
  are ignored.
- **Game server:** revert "name table for web profiles" (one updater restart), then delete
  `/opt/alduinak/build/dist/server/name-table.json`; once the system is gone nothing
  deletes it.
- **Discord:** remove the redirect from the portal.
- **Env:** restore the `backend.env` backup and restart the backend.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Home page buttons give 404, or the profile page says "public site only" on the public address | The nginx `/api/site/` block is missing from `:81`. |
| `?error=unconfigured` | `DISCORD_CLIENT_ID` is empty in `backend.env`. |
| `?error=state` | The state cookie did not come back: the sign-in took over 10 minutes or the browser blocks cookies. |
| "Too many redirects" on sign-in | The nginx `/api/site/` block does not pass `Host`, so the backend never sees the redirect URI's host and `/login` keeps redirecting. |
| `?error=discord` | The redirect is not registered in the Discord portal or differs from `DISCORD_SITE_REDIRECT_URI`, the client secret is wrong, or Discord is unreachable. The backend log has `[site-auth] callback error:` with Discord's reason. |
| "Sign-out failed" | 403 `badOrigin`: `WEBSITE_URL` is not the page's origin. |
| "Your characters cannot be read right now" | 503 `storeUnavailable`: `CHANGEFORMS_DIR` is missing or unreadable (`[site-auth] changeForms store unreadable` in the log). |
| No race or location on any character | No name table yet (the game server has not restarted on the new build, or the scan failed: see its log line), `NAME_TABLE_PATH` is wrong (the backend log names the path it tried in a `[jsonCache]` line), or, for location only, `SITE_SHOW_LOCATION=off`. |
| Titles always "None" | There is no `data/faction-whitelist.json` and no `officials.json` (the live state on 2026-09-21), or `ZONES_DIR` is wrong. |
| A whitelisted player shows "Not whitelisted" | The Discord role lookup failed: bot token, guild id, or a Discord outage. |
| Access badge shows "Unknown" | The Discord lookup took over 8 s or threw (`[site-auth] Discord access lookup` in the log). Each new Discord connection from CT 115 has taken about 5 s (slow DNS). |
| Plain-text 429 on sign-in | More than 5 sign-ins in one minute from one visitor address, or more than 60 across the whole site. |

## Testing without a real Discord sign-in

A test backend with a made-up `DISCORD_CLIENT_ID` cannot finish a Discord sign-in. Test the
signed-in paths on a throwaway copy of the backend and its data, never on `/opt/alduinak`
or the live data, by writing a session into the copy's `data/site-sessions.json` before
starting it (the store is read only at start):

```sh
node -e "require('fs').writeFileSync('data/site-sessions.json', JSON.stringify([['0'.repeat(64),
  {discordId: '<discord id>', username: 'Test', avatar: null, expiresAt: Date.now() + 3600e3}]]), {mode: 0o600})"
curl -s -H "Cookie: db_site=$(printf '%064d' 0)" http://127.0.0.1:<port>/api/site/characters
```

The copied data holds real player data (hwid, IP addresses); delete the copy when done.

## Unverified

- Race ids and the labels of DragonBreak places on the live load order. Only the game
  server can build the table (`mp.getIdFromDesc` is native), so they are checked after
  deployment. Places from DragonBreak plugins may have display names or only editor ids.
- The table's size and scan time for the full DragonBreak load order.
- That `CF-Connecting-IP` reaches the backend through the Cloudflare tunnel and nginx
  (Cloudflare documents it for proxied traffic, and nginx passes request headers on). If it
  does not, only the site-wide sign-in limit applies.
- `appearanceDump.name` may be a mask label while a character is masked, and the writers
  of `private.permaDead` and `private.charTag` are in the gamemode.
- The page was tested against a stub DOM, not viewed in a real browser before deployment.
