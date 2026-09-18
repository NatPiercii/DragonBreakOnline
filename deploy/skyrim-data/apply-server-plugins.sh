#!/usr/bin/env bash
# Installs a plugin bundle from build-bundle.py on the game server CT and sets loadOrder; run as root on the Proxmox host.
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin

CT="${CT:-115}"
HERE="$(cd "$(dirname "$0")" && pwd)"
BUNDLE="${1:-$HERE/dragonbreak-server-plugins.tar}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
SETTINGS=/opt/alduinak/build/dist/server/server-settings.json
LOG=/var/log/skymp-server.log
DATA=/opt/skyrim-data
NEW=/opt/skyrim-data-new
OLD="/opt/skyrim-data.bak-$TS"
SETTINGS_BAK="/opt/skymp-config-backup/server-settings.json.$TS"

say() { echo "[$(date -u +%H:%M:%S)] $*"; }
ct()  { pct exec "$CT" -- "$@"; }

[ -f "$BUNDLE" ] || { echo "Bundle not found: $BUNDLE"; exit 1; }
[ "$(pct status "$CT")" = "status: running" ] || { echo "CT$CT is not running"; exit 1; }

say "1/7 Staging bundle into $NEW (live server untouched)"
ct rm -rf "$NEW"
ct mkdir -p "$NEW"
ct tar --no-same-owner -xf - -C "$NEW" < "$BUNDLE"

say "2/7 Verifying every file's SHA-256 inside CT$CT"
ct sh -c "cd '$NEW' && sha256sum -c --quiet SHA256SUMS"
N="$(ct sh -c "grep -c . '$NEW/loadorder.txt'")"
say "    OK: $N plugins"

say "3/7 Pausing the 5-minute auto-updater"
ct systemctl stop skymp-update.timer
while [ "$(ct systemctl is-active skymp-update.service || true)" = "active" ]; do
  say "    an update is running, waiting..."; sleep 10
done
ct mkdir -p /opt/skymp-config-backup
ct cp -a "$SETTINGS" "$SETTINGS_BAK"

STOPPED=0
rollback() {
  set +e
  say "!! FAILED - rolling back"
  ct systemctl stop skymp
  if ct test -d "$OLD"; then
    ct test -d "$DATA" && ct mv "$DATA" "/opt/skyrim-data.failed-$TS"
    ct mv "$OLD" "$DATA"
  fi
  ct cp -a "$SETTINGS_BAK" "$SETTINGS"
  ct systemctl start skymp
  ct systemctl start skymp-update.timer
  say "!! Rolled back to the previous data folder and settings. Server restarted."
  exit 4
}
trap 'if [ "$STOPPED" = 1 ]; then rollback; else ct systemctl start skymp-update.timer; fi' ERR

say "4/7 Stopping the game server"
STOPPED=1
ct systemctl stop skymp

say "5/7 Swapping data folder (old one kept at $OLD)"
ct mv "$DATA" "$OLD"
ct mv "$NEW" "$DATA"

say "6/7 Writing loadOrder ($N plugins) into server-settings.json"
ct node -e '
const fs = require("fs")
const [settingsPath, dataDir] = process.argv.slice(1)
const names = fs.readFileSync(dataDir + "/loadorder.txt", "utf8").split("\n").map(s => s.trim()).filter(Boolean)
for (const n of names) if (!fs.existsSync(dataDir + "/" + n)) throw new Error("missing plugin file: " + n)
const s = JSON.parse(fs.readFileSync(settingsPath, "utf8"))
s.loadOrder = names.map(n => dataDir + "/" + n)
s.archives = [dataDir + "/Skyrim - Misc.bsa"]
fs.writeFileSync(settingsPath + ".tmp", JSON.stringify(s, null, 2) + "\n")
fs.renameSync(settingsPath + ".tmp", settingsPath)
console.log("    loadOrder written: " + names.length + " entries, first " + names[0] + ", last " + names[names.length - 1])
' "$SETTINGS" "$DATA"

say "7/7 Starting the game server and checking health"
START_LINE="$(ct sh -c "wc -l < '$LOG'")"
ct systemctl start skymp
sleep 45
ACTIVE="$(ct systemctl is-active skymp || true)"
PORT_OK="$(ct sh -c "ss -uln | grep -c ':7777 '" || true)"
NEW_ERR="$(ct sh -c "tail -n +$((START_LINE + 1)) '$LOG' | grep -ciE 'fatal|uncaught|exception|unresolved|failed to (load|open|read)|error'" || true)"
READY="$(ct sh -c "tail -n +$((START_LINE + 1)) '$LOG' | grep -c 'Gamemode path is'" || true)"
say "    service=$ACTIVE udp7777=$PORT_OK new_error_lines=$NEW_ERR gamemode_loaded=$READY"
if [ "$ACTIVE" != "active" ] || [ "${PORT_OK:-0}" -lt 1 ] || [ "${READY:-0}" -lt 1 ] || [ "${NEW_ERR:-0}" -gt 0 ]; then
  ct sh -c "tail -n +$((START_LINE + 1)) '$LOG' | tail -n 40"
  false
fi

trap - ERR
ct cp -a "$SETTINGS" /opt/skymp-config-backup/server-settings.json
ct systemctl start skymp-update.timer
say "DONE. Server is running with $N plugins."
say "Previous data: $OLD   previous settings: $SETTINGS_BAK"
