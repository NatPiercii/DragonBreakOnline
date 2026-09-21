#!/usr/bin/env bash
# RECORD of the 2026-09-21 switch of CT115 to the DragonBreak setup (run inside the CT as root, from a
# staging folder holding plugins/, gameplay/, scripts/, loadorder.txt, SHA256SUMS, settings-gameplay.json).
# It RESETS THE WORLD; for later plugin-only updates drop the world step. Server-side gameplay updates
# use `bash dev-server.sh deploy-gameplay` from Nat's working root instead.
# Switch the dev server to the DragonBreak setup: 105-plugin load order, DragonBreak gameplay layer,
# fresh world. Runs inside CT115 as root. Mirrors deploy/skyrim-data/apply-server-plugins.sh (staging,
# sha256 check, updater paused, backups, rollback) without pct, and adds the gamemode + world steps.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
SRV=/opt/alduinak/build/dist/server
SETTINGS=$SRV/server-settings.json
DATA=/opt/skyrim-data
NEW=/opt/skyrim-data-new
OLD="/opt/skyrim-data.bak-$TS"
BK="/opt/skymp-backups/pre-dragonbreak-$TS"
LOG=/var/log/skymp-server.log
say() { echo "[$(date -u +%H:%M:%S)] $*"; }

say "1/8 Staging $NEW from the live folder plus 16 new/changed plugins"
rm -rf "$NEW"; cp -a "$DATA" "$NEW"
rm -f "$NEW/TGC Winterhold - OCW Patch.esp"
cp "$HERE"/plugins/* "$NEW/"
cp "$HERE/loadorder.txt" "$HERE/SHA256SUMS" "$NEW/"
chown -R root:root "$NEW"; chmod 644 "$NEW"/*

say "2/8 Verifying every file's SHA-256 against the repo's SHA256SUMS"
(cd "$NEW" && sha256sum -c --quiet SHA256SUMS)
N="$(grep -c . "$NEW/loadorder.txt")"; say "    OK: $N plugins"

say "3/8 Pausing the auto-updater and backing up to $BK"
systemctl stop skymp-update.timer
# a oneshot unit reports "activating" while it runs, never "active"
while systemctl is-active --quiet skymp-update.service || [ "$(systemctl is-active skymp-update.service || true)" = "activating" ]; do say "    update running, waiting"; sleep 10; done
mkdir -p "$BK"
cp -a "$SETTINGS" "$SRV/gamemode.js" "$SRV/starter-grants.json" "$BK/"
tar -C /opt -czf "$BK/skymp-state.tgz" skymp-state

STOPPED=0
rollback() {
  set +e
  say "!! FAILED - rolling back"
  systemctl stop skymp
  if [ -d "$OLD" ]; then [ -d "$DATA" ] && mv "$DATA" "/opt/skyrim-data.failed-$TS"; mv "$OLD" "$DATA"; fi
  cp -a "$BK/server-settings.json" "$SETTINGS"
  cp -a "$BK/starter-grants.json" "$SRV/starter-grants.json"
  if [ -d "/opt/skymp-state/world-pre-dragonbreak-$TS" ]; then rm -rf /opt/skymp-state/world; mv "/opt/skymp-state/world-pre-dragonbreak-$TS" /opt/skymp-state/world; fi
  echo '[]' > /opt/skymp-state/zone-spawns.json
  tar -C /opt -xzf "$BK/skymp-state.tgz"
  systemctl start skymp; systemctl start skymp-update.timer
  say "!! Rolled back: data folder, settings, world. The DragonBreak files stay beside the stub, unused."
  exit 4
}
trap 'if [ "$STOPPED" = 1 ]; then rollback; else systemctl start skymp-update.timer; fi' ERR

say "4/8 Stopping the game server"
STOPPED=1
systemctl stop skymp

say "5/8 Swapping the data folder (old kept at $OLD)"
mv "$DATA" "$OLD"; mv "$NEW" "$DATA"

say "6/8 Installing the gameplay layer into $SRV"
install -m 644 -o root -g root "$HERE"/gameplay/* "$SRV/"
install -m 644 -o root -g root "$HERE"/scripts/*.pex "$SRV/data/scripts/"

say "7/8 Settings: loadOrder, gamemodePath, gameplay keys (master/auth/offlineMode untouched); fresh world"
node -e '
const fs = require("fs")
const [settingsPath, dataDir, localPath] = process.argv.slice(1)
const names = fs.readFileSync(dataDir + "/loadorder.txt", "utf8").split("\n").map(s => s.trim()).filter(Boolean)
for (const n of names) if (!fs.existsSync(dataDir + "/" + n)) throw new Error("missing plugin file: " + n)
const s = JSON.parse(fs.readFileSync(settingsPath, "utf8"))
const local = JSON.parse(fs.readFileSync(localPath, "utf8"))
Object.assign(s, local)
s.loadOrder = names.map(n => dataDir + "/" + n)
s.archives = [dataDir + "/Skyrim - Misc.bsa"]
s.gamemodePath = "dbo-gamemode.js"
fs.writeFileSync(settingsPath + ".tmp", JSON.stringify(s, null, 2) + "\n")
fs.renameSync(settingsPath + ".tmp", settingsPath)
console.log("    " + names.length + " plugins, gamemodePath " + s.gamemodePath + ", offlineMode " + s.offlineMode + ", master " + (s.master ? "set" : "EMPTY"))
' "$SETTINGS" "$DATA" "$HERE/settings-gameplay.json"
mv /opt/skymp-state/world "/opt/skymp-state/world-pre-dragonbreak-$TS"
mkdir -p /opt/skymp-state/world/changeForms
echo '[]' > /opt/skymp-state/zone-spawns.json

say "8/8 Starting and checking health"
START_LINE="$(wc -l < "$LOG" 2>/dev/null || echo 0)"
systemctl start skymp
sleep 45
ACTIVE="$(systemctl is-active skymp || true)"
PORT_OK="$(ss -uln | grep -c ':7777 ' || true)"
NEWLOG="$(tail -n +$((START_LINE + 1)) "$LOG")"
READY="$(printf '%s\n' "$NEWLOG" | grep -c 'Gamemode path is' || true)"
GM="$(printf '%s\n' "$NEWLOG" | grep -c '\[gamemode\] loaded' || true)"
ERR="$(printf '%s\n' "$NEWLOG" | grep -c '\[error\]' || true)"
FATAL="$(printf '%s\n' "$NEWLOG" | grep -iE 'unresolved|invalid file index|uncaught|fatal' | grep -vc 'unresolved: none' || true)"
say "    service=$ACTIVE udp7777=$PORT_OK gamemode_path=$READY dragonbreak_loaded=$GM error_lines=$ERR fatal=$FATAL"
if [ "$ACTIVE" != "active" ] || [ "${PORT_OK:-0}" -lt 1 ] || [ "${GM:-0}" -lt 1 ] || [ "${FATAL:-0}" -gt 0 ]; then
  printf '%s\n' "$NEWLOG" | tail -n 40
  false
fi
trap - ERR
cp -a "$SETTINGS" /opt/skymp-config-backup/server-settings.json
systemctl start skymp-update.timer
say "DONE. $N plugins, DragonBreak gameplay layer live. Backup: $BK  old data: $OLD"
