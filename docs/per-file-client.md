# Per-file client updates

Launcher 2.1.44 can update the client one file at a time. A release then downloads only the files that changed,
not the whole 184 MB zip.

On 7 Oct 2026 about 40 launchers pulled the zip at once over the home upload, and players were locked out. Big
downloads now come from Cloudflare R2 (`files.dragonbreakonline.com`). This page covers the backend side:

- the route
- the two release scripts
- the switches
- whether the client and extra-files lists may stop overlapping

## How it works

### The launcher (2.1.44, `perFileClientUpdate` in `skymp5-launcher/src/main.js`)

1. It reads `/api/files/version` and compares each listed file (`path`, `size`, `sha256`) with the copy on disk.
   Launcher-owned files (settings, logs) are skipped.
2. If more than 60% of the bytes changed, it downloads the zip as before.
3. For each changed file it requests `GET /api/files/client/<path>?v=<version>` with `X-DBO-Accept-Redirect: 1`. Each
   path segment is `encodeURIComponent`'d.
   - It follows https redirects only.
   - It resumes with `Range`.
   - It waits in line on `503` with `Retry-After`.
4. It checks each file's sha256 and writes it in place.
5. **Any** non-2xx answer or checksum mismatch stops the per-file run, and the launcher downloads the whole zip
   (`/api/files/zip`). So a 404 from the backend is always safe. It means "use the zip".

### The backend (`skymp5-backend/sources/clientFiles.js`, mounted in `routes/files.js`)

`GET /api/files/client/<path>?v=<version>` takes the first matching row below:

| Condition | Answer |
|---|---|
| `data/client-files.json` has `"perFile": false` | 404 |
| `v` is not exactly the version in `data/files-version.json` (missing, different or repeated) | 404 |
| The path is not exactly one of the listed files. It is case-sensitive and decoded one segment at a time. A segment of `''`, `.`, `..`, `%2F`, a backslash, NUL or a malformed escape is refused. | 404 |
| The request has `X-DBO-Accept-Redirect: 1`, and `data/r2.json` `"clientFiles"` lists this version with `files-version.json`'s `zipSize` | 302 to `https://files.dragonbreakonline.com/client/<version>/files/<encoded path>`, with `Cache-Control: no-store` |
| `<clientFilesDir>/unpacked/<version>/.verified` matches this version and this exact file list | 200 from that folder (`res.sendFile`, `application/octet-stream`; `Range` gives 206) |
| Anything else | 404, so the launcher uses the zip |

- **Nothing is unpacked inside a request.**
- **No edge caching.** Every answer of the route carries `Cache-Control: no-store`: the 200 and 206 from disk, every
  404, the 302 and the limiter's 429. Cloudflare in front of the API host caches by file extension (`.js`, `.png`,
  `.svg`, `.bin`, `.swf`, `.ttf`, `.mp3` and more; about 175 of the 287 listed files) when the origin says nothing about
  caching. A 404 was measured staying at the edge for about 3 minutes (and Cloudflare's default for a 200 is about
  2 hours). Without `no-store`, a 404 from the minutes between the zip swap and `unpack-client.js` would keep
  launchers on the zip after the unpack, an old 200 would outlive a rebuilt package under the same version number, and
  the kill switches would not reach cached URLs. For extra safety a Cloudflare Cache Rule can bypass the cache for
  `/api/files/client/*`; it is not needed while the backend sends `no-store`.
- **Rate limit.** The route has its own limiter: 1500 requests per 15 minutes per Cloudflare visitor. It uses the same
  key as the zip limiter (`visitorKey`: `CF-Connecting-IP`, IPv6 grouped by /56). One update of about 300 files fits
  easily. A `429` makes that launcher fall back to the zip.
- **Marker check.** The marker holds the sha256 of the file list (paths, sizes and sha256s). A reused version number
  with different files therefore never serves the old copy. The 0.3.81 rollback put 0.3.80 back, so this happens.
  `r2.json` `clientFiles` maps a version to its zip size for the same reason, as `client` does for the zip.
- **Proxy.** The public nginx already forwards `/api/files/*` (the extra files are served from
  `/api/files/extra/<path>`), so the new path needs no proxy change. After deploy, check that
  `curl -s https://<api host>/api/files/client/x?v=0` returns the backend's JSON 404, not an nginx page.
- **Restart needed.** The route is new code, so the backend needs one restart to serve it. After that, every file and
  switch on this page is read again when it changes. No further restarts are needed.

### Files

| File | Written by | Purpose |
|---|---|---|
| `build/client-files/skymp-client.zip`, `skymp5-backend/data/files-version.json` | claude-nate's `release-client.sh` (swaps both) | The package and its file list |
| `build/client-files/unpacked/<version>/` with its `.verified` marker | `scripts/unpack-client.js` | The verified copy served from disk |
| `skymp5-backend/data/r2.json` `"clientFiles": { "<version>": <zipSize> }` | `scripts/publish-client-r2.sh` | Versions whose files are on R2 and checked |
| `skymp5-backend/data/client-files.json` (optional) | by hand | The switches below |

`.verified` holds this JSON:

```json
{ "version", "zipSha256", "zipSize", "fileCount", "totalBytes", "listSha256", "unlisted", "verifiedAt" }
```

`build/client-files/root/` is **stale**. It holds 108 files against the 287 listed, 180 listed files are missing and 8
differ (last written 6 Oct). It is `merge-files.js`'s old staging folder, from before the zip was built on Windows.
Nothing here uses it.

It is still mounted at `/files/root` in `server.js`. The public proxy does not forward that path, but the mount and
folder could be removed.

## Release steps, in order

Run these as root on CT 115. Claim and log as the ops ledger readme says (`client-bucket` is the claim
`release-client.sh` uses).

1. **claude-nate's `release-client.sh`** swaps in the new `skymp-client.zip` and `files-version.json` (version `V`).
   From this moment, per-file requests for `V` get 404 and launchers download the zip as before. The previous
   version's requests also get 404, because their `?v=` is no longer current.

2. **Unpack and verify** (about 5 s for the 412 MB package; it needs about 412 MB of disk per version):

   ```bash
   cd /opt/alduinak/skymp5-backend
   systemd-run --scope -q -p MemoryMax=2G nice -n 19 node scripts/unpack-client.js
   ```

   - It checks the zip's entry names, its size against `files-version.json`, and the free space (2 GB must remain).
   - It unpacks into `unpacked/.tmp-V`. Any symlink or special file fails the run.
   - It checks **every** listed file's size and sha256.
   - It writes `.verified`, then renames the folder to `unpacked/V` in one step.
   - It keeps the current version and the one before it, and deletes older ones.
   - It exits 1 on any mismatch, leaving `unpacked/` as it was. The last line of output is a JSON summary.
   - Running it again is harmless ("already unpacked"). `--force` unpacks again anyway.

   **From here, per-file updates of `V` are served from disk.**

3. **Publish to R2.** Do a dry run first. It reads no credentials and contacts nothing:

   ```bash
   bash scripts/publish-client-r2.sh --dry-run V
   systemd-run --scope -q -p MemoryMax=2G nice -n 19 bash scripts/publish-client-r2.sh V
   ```

   The script works in this order:

   - It checks that `unpacked/V` is verified for the current `files-version.json` (`unpack-client.js --check`).
   - It runs `rclone copy` with exactly the listed files to `r2:dragonbreak/client/V/files/`, using `--checksum` and
     `--bwlimit 3M`.
     - The credentials come only from `/root/.r2.env`, passed as `RCLONE_CONFIG_R2_*` environment.
     - rclone never runs with `-v`.
     - All of rclone's output goes through a sed that masks the endpoint, its host, the key id and the secret.
     - The mask and the file list live in a private temp folder (umask 077, mode 0700). If `mktemp -d` fails, or the
       mask is incomplete or unreadable, the script stops before rclone runs.
   - Files unchanged since the newest version already in `clientFiles` are copied inside R2 (`--copy-dest`) instead of
     going over the home upload again. A first publish sends all 412 MB, which takes about 2.5 min at 3 MiB/s.
     `--copy-dest` has not yet been run against the real bucket. If it fails, rerun with `--no-copy-dest`.
   - It sends an anonymous `curl -I` to every file on `https://files.dragonbreakonline.com/client/V/files/<path>`. Each
     must answer 200 with the listed size. curl's default user agent passes Cloudflare; Python's urllib gets a 403.
   - **Only then** does it add `"clientFiles": {"V": <zipSize>}` to `data/r2.json`, writing a temp file beside it and
     moving it into place, and print the new file. If any step fails, `r2.json` is left alone and the files keep
     coming from disk.
   - If `r2.json` is missing, the script stops. A missing `r2.json` means R2 is switched off, and the script never
     switches it on.

4. **`r2.json` now lists `V`.** Launchers that send `X-DBO-Accept-Redirect: 1` are redirected to R2 from the next
   request, with no restart. To check:

   ```bash
   curl -sI -H 'X-DBO-Accept-Redirect: 1' 'http://127.0.0.1:4000/api/files/client/Data/DragonBreak.esp?v=V'
   ```

   It should answer 302 with `Location: https://files.dragonbreakonline.com/client/V/files/Data/DragonBreak.esp`.

**Optional: prepare before the swap.** Both scripts can run on the staged package before step 1, so per-file updates
work the moment the swap lands. `r2.json` can list `V` early, because the route only redirects once
`files-version.json` says `V`.

```bash
node scripts/unpack-client.js --zip /opt/dragonbreak-handover/client-V/skymp-client.zip \
     --version-file /opt/dragonbreak-handover/client-V/files-version.json
VERSION_FILE=/opt/dragonbreak-handover/client-V/files-version.json bash scripts/publish-client-r2.sh V
```

When it unpacks a staged package, `unpack-client.js` also keeps the live version.

**Rollback.** If a release goes back to the previous version (`files-version.json` restored), `unpacked/PREV` is still
there and verified, and `clientFiles` still lists it. Per-file updates of `PREV` work again at once.

## Kill switches

None of these needs a restart; each is read again when the file changes. Because every answer of the route is
`no-store`, each takes effect at the next request; no Cloudflare purge is needed for `/api/files/client/*`.

| To stop | Do this | Effect |
|---|---|---|
| All per-file serving | `data/client-files.json`: `{ "perFile": false }` | Every `/api/files/client/*` answers 404; every launcher downloads the zip |
| Per-file from R2 only | Remove the version from `r2.json` `"clientFiles"` | Per-file updates are served from the disk copy |
| Per-file from disk only | Delete `unpacked/V/.verified` (or the folder) | Per-file updates come from R2 if listed, otherwise 404 (zip) |
| Everything on R2 (zip, extra files, per-file) | `r2.json` `"enabled": false`, or delete `r2.json` | Everything is served from disk, as before 7 Oct |
| The overlap switch | Delete `data/client-files.json` or set `"omitExtras": false` | `/api/files/version` is `files-version.json` unchanged |

## The overlap between the client list and the extra files

`files-version.json` (the zip) and `extra-files.json` (the per-file extra sync) both list nine `Data/*.esp`:

- `DragonBreak.esp`
- `DragonBreak Built.esp`
- `DragonBreak Dungeons.esp`
- `DragonBreak Harvest.esp`
- `DragonBreak Hub.esp`
- `DragonBreak Online Edits.esp`
- `DragonBreak Whiterun.esp`
- `LostArk_Kamen.esp`
- `[Kirax] Lost Ark Reborn Paladin Legendary.esp`

Seven are identical. Two differ, and the extras copy is newer in both:

| File | Client (zip) | Extras |
|---|---|---|
| `DragonBreak Hub.esp` | 18,407 B | 19,538 B |
| `DragonBreak Online Edits.esp` | 4,469,326 B | 4,562,357 B |

### What happens today (switch off)

- **Every launcher, whole-zip update.** Unpacking the zip writes the older copies of those two files. The extra sync
  that runs straight after in the same install sees the wrong size and downloads the extras copy again. Players end up
  with the extras copy, at the cost of about 4.5 MB downloaded twice per update.
- **2.1.44, per-file update.** The two files always differ from the client list, so every client release fetches the
  older copies from `/api/files/client` (about 4.5 MB). The extra sync then replaces them with the newer ones (another
  4.5 MB). The result is correct, but the old plugins sit on disk between the two steps, and each release costs every
  player about 9 MB extra.
- **No repair loop.** `selfRepair.checkClient` only checks the files that decide whether the client starts (DLLs,
  `skymp5-client.js`, the UI). `.esp` files are not among them.

### The switch

`data/client-files.json` `{ "omitExtras": true }` makes `/api/files/version` leave out every listed path that
`extra-files.json` also lists. It compares case-insensitively, as the launcher does, and adds
`"omittedExtras": <count>`. On today's data it leaves out exactly the nine `.esp`.

- **Never under `Data/Platform/` or `Data/SKSE/`.** It never leaves out anything there, even if the extra list names it,
  because launchers move unlisted files there into quarantine (below).
- **Fails safe.** If `extra-files.json` is missing or empty, nothing is left out.
- **Same package.** The zip and `zipSize` are unchanged, and the per-file route still serves the omitted files.
- **Off by default.** It is **off**, and it is not turned on by these commits.

### Is it safe to turn on?

I checked both launchers: 2.1.43 (`16b00910`) and 2.1.44 (this branch). `selfRepair.js` is the same in both. The list
from `/api/files/version` is used in five places.

1. **Play button update check** (`files:updateCheck`). It uses only `version`. Not affected.
2. **Self-repair before every PLAY** (`selfRepairBeforeLaunch`):
   - `selfRepair.strayFiles` moves files the list does not name into `DragonBreak Quarantine`. It only looks inside
     `Data/Platform/{Plugins,UI,Distribution,Modules}` and at the platform DLLs in `Data/SKSE/Plugins`.
   - The nine `.esp` are in `Data/`, so they are never called stray.
   - `checkClient` only looks at the start-critical files above.
   - **Safe.** The switch's refusal to omit anything under `Data/Platform` or `Data/SKSE` keeps it safe if the extra
     list ever grows into those folders. Otherwise a file both lists name there would be quarantined before every PLAY
     and downloaded again by the extra sync.
3. **Repair Client Files** (`installClientFilesCore` with `force`):
   - It unpacks the whole zip and then runs the forced extra sync. The `.esp` end up as the extras copy, as today.
   - Its cleanup of unlisted files is the same `strayFiles` (Platform and SKSE only), so the `.esp` are never moved.
   - **Safe.**
4. **Check Files diagnostics:**
   - Since 2.1.22 it already skips client-listed files that the extra list owns (`syncOwned`). It checks them in the
     DragonBreak files section against `extra-files.json` instead.
   - Its "not in the server package" notes only cover `Data/Platform` and `Data/SKSE/Plugins`.
   - Leaving the `.esp` out changes nothing it reports. **Safe.**
5. **2.1.44 per-file update:**
   - The omitted files are no longer compared or downloaded. The extra sync that runs straight after owns them.
   - This removes the double download and the window with the older plugins on disk.
   - The 60% rule's total shrinks by about 15 MB of 412 MB (under 4%), which is negligible.
   - **Safe, and better.**

**Which copy wins does not change.** With the switch on or off, the extra sync runs after the client files in the same
install, so the extras copy always ends up on disk. Every launcher since 2.1.22 already treats `extra-files.json` as the
owner of these paths. If a release ever ships a newer plugin only inside the client zip, the extra sync replaces it with
the extras copy, switch or no switch. The lasting fix is to build the client zip without these plugins, or with the
same copies (Windows build side).

**Verdict.** It is safe to turn on for 2.1.43 and 2.1.44. It mainly helps 2.1.44, so turn it on with or after the 2.1.44
rollout.

Older launchers are also unaffected. From git history, the client list's per-file entries were used only by Check Files
(added 3 Sep) until self-repair arrived in 2.1.40. On those launchers, leaving the `.esp` out only means Check Files no
longer compares them with the client list. Launchers before 2.1.22 would otherwise report the two differing files as
mismatches.

## Tests

- `test/clientFileRoute.test.js` covers the route, the switches and `unpack-client.js` on a tiny zip:
  - mismatches and failure paths
  - `..`, absolute, backslash and symlink entries
  - pruning, the lock
- `test/publishClientR2.test.js` covers `publish-client-r2.sh` with a stand-in `rclone` and `curl`:
  - masking
  - r2.json left untouched on any failure
  - the dry run

Checked by hand on the real package, in `/tmp`:

- `unpack-client.js` verified all 287 files of the live 0.3.80 zip in 5 s.
- The launcher's own `download.js` fetched all 287 through the route with matching sha256s.
- `Range` gives 206 on `libcef.dll`.
- The `curl -I` parsing reads the real `files.dragonbreakonline.com` answers (200 with size for the zip, 404 for a
  missing file).
