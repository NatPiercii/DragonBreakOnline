#!/bin/bash
# Publishes client <version>'s files one by one to Cloudflare R2 for launcher 2.1.44's per-file update
# (docs/per-file-client.md). Run after scripts/unpack-client.js has verified unpacked/<version>.
#   1. checks unpacked/<version>/.verified matches files-version.json (unpack-client.js --check)
#   2. rclone copy of exactly the listed files to r2:dragonbreak/client/<version>/files/ (--bwlimit 3M, --checksum;
#      files unchanged since the newest version already in r2.json "clientFiles" are copied inside R2, not uploaded)
#   3. an anonymous HEAD of every file on the public URL; each must answer 200 with the listed size
#   4. only then data/r2.json gets "clientFiles": { "<version>": <zip size> } (written to a temp file, then mv) and is
#      printed. Until that line exists the backend serves the files from disk, so a failed run changes nothing live.
#
#   bash scripts/publish-client-r2.sh [--dry-run] [--no-copy-dest] [--replace-live] <version>
#     --dry-run       show what would be uploaded and written; reads no credentials, contacts nothing
#     --no-copy-dest  upload every file instead of copying unchanged ones inside R2
#     --replace-live  publish a staged list (VERSION_FILE) even though it reuses the live version number with other files
#
# A staged list that reuses the live version number with other files is refused: the upload would overwrite the R2 files
# launchers are redirected to until the swap. A same-number rebuild is published after the swap, from the live list.
#
# Credentials come only from /root/.r2.env (R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY), given to rclone as
# environment variables. rclone never runs with -v, and everything it prints goes through a sed that masks those values.
# Overrides (tests): CLIENT_FILES_DIR, DATA_DIR, VERSION_FILE, R2_ENV_FILE, R2_REMOTE.
set -uo pipefail
umask 077   # everything this script writes is private: the file list, the r2.json temp file and, above all, the sed mask

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
BACKEND=$(dirname "$HERE")
CLIENT_FILES_DIR=${CLIENT_FILES_DIR:-$(dirname "$BACKEND")/build/client-files}
DATA_DIR=${DATA_DIR:-$BACKEND/data}
VERSION_FILE=${VERSION_FILE:-$DATA_DIR/files-version.json}
R2_ENV_FILE=${R2_ENV_FILE:-/root/.r2.env}
R2_REMOTE=${R2_REMOTE:-r2:dragonbreak/client}
UNPACKED=$CLIENT_FILES_DIR/unpacked
R2_JSON=$DATA_DIR/r2.json

say(){ echo "[publish-client-r2] $*"; }
die(){ echo "[publish-client-r2] FAILED: $*" >&2; exit 1; }

DRY=""; COPY_DEST=1; REPLACE_LIVE=""; V=""
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --no-copy-dest) COPY_DEST="" ;;
    --replace-live) REPLACE_LIVE=1 ;;
    -*) echo "unknown option $a" >&2; exit 2 ;;
    *) [ -z "$V" ] || { echo "one version only" >&2; exit 2; }; V=$a ;;
  esac
done
[ -n "$V" ] || { echo "usage: publish-client-r2.sh [--dry-run] [--no-copy-dest] <version>" >&2; exit 2; }
[[ "$V" =~ ^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$ ]] || die "version '$V' is not a plain version string"
for c in node curl rclone sed; do command -v "$c" >/dev/null || die "$c is not installed"; done

# 0700: holds the file list and, during the upload, the sed mask. Without it every "$WORK/..." would be a file in /.
WORK=$(mktemp -d) && [ -n "$WORK" ] && [ -d "$WORK" ] || die "cannot create a private temp folder (mktemp -d failed; check TMPDIR and free space)"
trap 'rm -rf "$WORK"' EXIT

# 1. The verified copy, for the version files-version.json names now
INFO=$(node "$HERE/unpack-client.js" --check --version-file "$VERSION_FILE" --out "$UNPACKED") || die "unpacked/$V is not verified for $VERSION_FILE"
field(){ node -e 'const o = JSON.parse(process.argv[1]); const v = o[process.argv[2]]; process.stdout.write(v === undefined || v === null ? "" : String(v))' "$INFO" "$1"; }
[ "$(field version)" = "$V" ] || die "$VERSION_FILE is version $(field version), not $V"
ZIPSIZE=$(field zipSize); COUNT=$(field fileCount); BYTES=$(field totalBytes); SRC=$(field dir)
[[ "$ZIPSIZE" =~ ^[0-9]+$ ]] || die "the marker has no zip size"
node "$HERE/unpack-client.js" --files --version-file "$VERSION_FILE" --out "$UNPACKED" > "$WORK/files.tsv" || die "cannot list the files"
cut -f3 "$WORK/files.tsv" > "$WORK/files.txt"
[ "$(wc -l < "$WORK/files.txt")" -eq "$COUNT" ] || die "the file list has $(wc -l < "$WORK/files.txt") lines, the marker says $COUNT"

# A staged list (not the live files-version.json) must not reuse the live version number with other files: r2.json still
# lists the live zip size for it, so launchers are redirected to client/$V/files/ until the swap and would get the rebuild
LIVE_FILE=$DATA_DIR/files-version.json
if [ "$(realpath -m "$VERSION_FILE")" != "$(realpath -m "$LIVE_FILE")" ]; then
  LIVE=$(node -e '
    const [file, mod] = process.argv.slice(1)
    const { safeVersion, listedFiles, listSha256 } = require(mod)
    let v
    try { v = JSON.parse(require("fs").readFileSync(file, "utf8")) } catch { process.exit(0) }
    if (v && safeVersion(v.version)) process.stdout.write(v.version + "\t" + listSha256(listedFiles(v)))' "$LIVE_FILE" "$BACKEND/sources/clientFiles.js") || die "cannot read $LIVE_FILE"
  if [ "$(cut -f1 <<<"$LIVE")" = "$V" ] && [ "$(cut -f2 <<<"$LIVE")" != "$(field listSha256)" ]; then
    [ -n "$REPLACE_LIVE" ] || die "$VERSION_FILE reuses the live version number $V with other files; uploading it now would replace the files launchers are redirected to. Swap the release in first, then publish without VERSION_FILE (or pass --replace-live)"
    say "WARNING: --replace-live: the R2 files of the live $V are replaced by this staged rebuild"
  fi
fi

# r2.json must exist: without it R2 is switched off, and this script never switches it on
[ -f "$R2_JSON" ] || die "$R2_JSON is missing (R2 is switched off); add it by hand first"
R2INFO=$(node -e '
  const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
  if (typeof s.baseUrl !== "string" || !/^https:\/\/[^/]+/i.test(s.baseUrl)) { console.error("r2.json has no https baseUrl"); process.exit(1) }
  const m = s.clientFiles && typeof s.clientFiles === "object" && !Array.isArray(s.clientFiles) ? s.clientFiles : {}
  const prev = Object.keys(m).filter(k => k !== process.argv[2] && /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/.test(k)).pop() || ""
  const listed = Object.prototype.hasOwnProperty.call(m, process.argv[2]) ? String(m[process.argv[2]]) : ""
  console.log(s.baseUrl.replace(/\/+$/, "") + "\t" + prev + "\t" + listed)' "$R2_JSON" "$V") || die "cannot read $R2_JSON"
BASE=$(cut -f1 <<<"$R2INFO"); PREV=$(cut -f2 <<<"$R2INFO"); LISTED=$(cut -f3 <<<"$R2INFO")
DEST="$R2_REMOTE/$V/files"
ARGS=(copy "$SRC" "$DEST" --files-from-raw "$WORK/files.txt" --checksum --bwlimit 3M --stats 30s --stats-one-line --stats-log-level NOTICE)
[ -n "$COPY_DEST" ] && [ -n "$PREV" ] && ARGS+=(--copy-dest "$R2_REMOTE/$PREV/files")

say "client $V: $COUNT files, $((BYTES / 1048576)) MB from $SRC"
say "upload: rclone ${ARGS[*]}"
say "check:  HEAD $BASE/client/$V/files/<path> for each file (size)"
say "then:   $R2_JSON clientFiles[\"$V\"] = $ZIPSIZE"
# The same version number published before from another build: Cloudflare may still hold those files at the edge
REUSED=""
[ -n "$LISTED" ] && [ "$LISTED" != "$ZIPSIZE" ] && REUSED=1
reused_note(){ say "WARNING: $V was published before with zip size $LISTED. Purge $BASE/client/$V/files/ in Cloudflare (by prefix, or each URL) so no edge serves the old files; the size check may also read cached copies"; }
[ -n "$REUSED" ] && reused_note
if [ -n "$DRY" ]; then say "dry run: nothing uploaded or written"; exit 0; fi

# 2. Upload. The credentials go to rclone as environment only; the mask script never appears on a command line.
[ -r "$R2_ENV_FILE" ] || die "$R2_ENV_FILE is not readable"
set +x
# shellcheck disable=SC1090
. "$R2_ENV_FILE"
[ -n "${R2_ENDPOINT:-}" ] && [ -n "${R2_ACCESS_KEY_ID:-}" ] && [ -n "${R2_SECRET_ACCESS_KEY:-}" ] || die "$R2_ENV_FILE must set R2_ENDPOINT, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY"
esc(){ printf '%s' "$1" | sed -e 's/[]\/$*.^[]/\\&/g'; }
R2_HOST=${R2_ENDPOINT#*://}; R2_HOST=${R2_HOST%%/*}
{
  printf 's/%s/<R2_ENDPOINT>/g\n' "$(esc "$R2_ENDPOINT")"
  [ -n "$R2_HOST" ] && printf 's/%s/<R2_ENDPOINT>/g\n' "$(esc "$R2_HOST")"
  printf 's/%s/<R2_ACCESS_KEY_ID>/g\n' "$(esc "$R2_ACCESS_KEY_ID")"
  printf 's/%s/<R2_SECRET_ACCESS_KEY>/g\n' "$(esc "$R2_SECRET_ACCESS_KEY")"
} > "$WORK/mask.sed" || die "cannot write the output mask; nothing uploaded"
# rclone runs only behind a complete mask that sed accepts
MASKLINES=$(grep -c '^s/..*/<R2_[A-Z_]*>/g$' "$WORK/mask.sed")
[ "$MASKLINES" -ge 3 ] && [ "$MASKLINES" -eq "$(wc -l < "$WORK/mask.sed")" ] || die "the output mask is incomplete; nothing uploaded"
printf 'x\n' | sed -f "$WORK/mask.sed" >/dev/null 2>&1 || die "sed cannot read the output mask; nothing uploaded"
export RCLONE_CONFIG_R2_TYPE=s3 RCLONE_CONFIG_R2_PROVIDER=Cloudflare RCLONE_CONFIG_R2_NO_HEAD=true RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true
export RCLONE_CONFIG_R2_ENDPOINT="$R2_ENDPOINT" RCLONE_CONFIG_R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
unset R2_ENDPOINT R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY
say "uploading…"
rclone "${ARGS[@]}" 2>&1 | sed -u -f "$WORK/mask.sed"
RC=${PIPESTATUS[0]}
unset RCLONE_CONFIG_R2_ENDPOINT RCLONE_CONFIG_R2_ACCESS_KEY_ID RCLONE_CONFIG_R2_SECRET_ACCESS_KEY
rm -f "$WORK/mask.sed"
[ "$RC" -eq 0 ] || die "rclone exited $RC; r2.json not changed"

# 3. Every file from the public side, anonymously (curl's own user agent: Cloudflare answers Python's urllib with 403)
say "checking $COUNT files on $BASE…"
BAD=0; N=0
while IFS=$'\t' read -r size urlpath rel; do
  N=$((N + 1))
  head=$(curl -sS -I --max-time 30 --retry 2 --retry-delay 2 "$BASE/$urlpath" 2>&1 | tr -d '\r')
  code=$(awk 'toupper($1) ~ /^HTTP\// { c = $2 } END { print c }' <<<"$head")
  len=$(awk 'tolower($1) == "content-length:" { l = $2 } END { print l }' <<<"$head")
  # Cloudflare answers some types (index.html) without a content-length: then fetch the file and compare its sha256 with
  # the verified local copy (a match proves the size too)
  if [ "$code" = "200" ] && [ -z "$len" ]; then
    got=$(curl -sS --max-time 120 --retry 2 --retry-delay 2 "$BASE/$urlpath" 2>/dev/null | sha256sum | cut -d' ' -f1)
    want=$(sha256sum "$SRC/$rel" | cut -d' ' -f1)
    if [ "$got" = "$want" ]; then len=$size; else len="a body with sha256 ${got:0:12} instead of ${want:0:12}, so the wrong"; fi
  fi
  if [ "$code" != "200" ] || [ "$len" != "$size" ]; then
    BAD=$((BAD + 1)); [ "$BAD" -le 20 ] && say "  MISMATCH $rel: HTTP ${code:-none}, ${len:-no} bytes, expected $size"
  fi
  [ $((N % 50)) -eq 0 ] && say "  $N/$COUNT checked"
done < "$WORK/files.tsv"
[ "$N" -eq "$COUNT" ] || die "checked $N of $COUNT files"
[ "$BAD" -eq 0 ] || die "$BAD of $COUNT files are missing or the wrong size on $BASE; r2.json not changed"
say "all $COUNT files are on R2 at their listed sizes"

# 4. List the version: a temp file beside r2.json, then one mv
TMPJ="$DATA_DIR/.r2.json.tmp-$$"
node -e '
  const fs = require("fs")
  const [file, tmp, v, size] = process.argv.slice(1)
  const s = JSON.parse(fs.readFileSync(file, "utf8"))
  const m = s.clientFiles && typeof s.clientFiles === "object" && !Array.isArray(s.clientFiles) ? s.clientFiles : {}
  m[v] = Number(size)
  s.clientFiles = m
  fs.writeFileSync(tmp, JSON.stringify(s, null, 1) + "\n", { flag: "wx" })' "$R2_JSON" "$TMPJ" "$V" "$ZIPSIZE" || { rm -f "$TMPJ"; die "cannot write $TMPJ"; }
chmod --reference="$R2_JSON" "$TMPJ" 2>/dev/null || chmod 644 "$TMPJ"
chown --reference="$R2_JSON" "$TMPJ" 2>/dev/null || true
mv -f "$TMPJ" "$R2_JSON" || { rm -f "$TMPJ"; die "cannot replace $R2_JSON"; }
say "$R2_JSON now lists client files $V (zip size $ZIPSIZE):"
cat "$R2_JSON"
[ -n "$REUSED" ] && reused_note
exit 0
