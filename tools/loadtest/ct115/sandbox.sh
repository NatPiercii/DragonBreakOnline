#!/usr/bin/env bash
# The load-test sandbox on CT 115: an isolated copy of the LIVE build, for the alpha capacity gate (ALPHA-GATE.md).
#
#   bash sandbox.sh init [--public]    copy the live build, gameplay files and data; settings without any secret
#   bash sandbox.sh start|stop|status  the sandbox server (its own unit, so stop never touches the live server)
#   bash sandbox.sh tunnel             the UDP tunnel the PC's bots use through ssh (not needed with --public)
#   bash sandbox.sh sample             the host sampler: sandbox and live server CPU/RSS, free memory, network
#   bash sandbox.sh summary <run.json> cut the samples and both logs into the PC run's steps -> host-summary.json
#   bash sandbox.sh target             the non-secret file the PC's harness reads (--target remote)
#   bash sandbox.sh reset|remove       throw the sandbox world away / the whole sandbox
#
# What it is: the same bundle, native addon, gameplay files and load order as the live server in
# /opt/alduinak/build/dist/server, run by nate (never root) from $SANDBOX, with
#   - its own port ($PORT, UI and /metrics on $PORT+1, tunnel on $PORT+2), loopback unless --public;
#   - offline mode, no master, no Discord (bot token, webhook, role sync, tickets, update posts all removed),
#     no voice, no admin profile ids, its own /metrics login;
#   - its own world folder and its own copy of every state file, so nothing it does reaches the live world;
#   - debugsnap and the updater pointed at the sandbox folder, so it cannot overwrite the live monitor's snapshot
#     or pause the live updater;
#   - transient system units run as nate (dbo-loadtest-*), CPUWeight 50 against the live server's 400, CPUQuota and
#     MemoryMax caps, nice 10.
# Nothing here starts on its own, and nothing touches /opt, the live unit or the live world. Stop is by unit name.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
SANDBOX=${SANDBOX:-/tmp/claude-nate-loadtest}
LIVE=${LIVE:-/opt/alduinak/build/dist/server}
PORT=${PORT:-7787}
CPU_QUOTA=${CPU_QUOTA:-300%}
MEM_MAX=${MEM_MAX:-4G}
UNIT=dbo-loadtest-sandbox
TUNNEL_UNIT=dbo-loadtest-tunnel
SAMPLER_UNIT=dbo-loadtest-sampler
BUNDLE=dbo-loadtest-server.js
say() { echo "[sandbox] $*"; }
die() { echo "[sandbox] $*" >&2; exit 1; }
# System-level transient units that run as nate: a user unit would die with nate's last login (Linger=no), and in
# system.slice CPUWeight 50 weighs directly against the live skymp unit's 400
RUN_AS=(--uid="$(id -u)" --gid="$(id -g)")
active() { systemctl is-active --quiet "$1"; }
mainpid() { systemctl show -p MainPID --value "$1" 2>/dev/null || echo 0; }

case "${SANDBOX}" in /tmp/claude-nate-*) ;; *) die "SANDBOX must be under /tmp/claude-nate- (got $SANDBOX)";; esac
[ "$PORT" != 7777 ] || die "7777 is the live server's port"

cmd_init() {
  local public=""; [ "${1:-}" = "--public" ] && public=--public
  active "$UNIT" && die "the sandbox is running; stop it first"
  [ -f "$LIVE/dist_back/skymp5-server.js" ] || die "no live build at $LIVE"
  mkdir -p "$SANDBOX/dist_back" "$SANDBOX/data" "$SANDBOX/world" "$SANDBOX/dbo-monitor"
  # 1. the bundle under test, renamed so no sweep for the live bundle can match it (README, Safety)
  cp "$LIVE/dist_back/skymp5-server.js" "$SANDBOX/dist_back/$BUNDLE"
  cp "$LIVE/dist_back/skymp5-server.js.map" "$SANDBOX/dist_back/skymp5-server.js.map" 2>/dev/null || true
  cp "$LIVE/scam_native.node" "$SANDBOX/scam_native.node"
  # 2. gameplay files and their data. Symlinks into /opt/skymp-state are copied as files (cp -L), so the
  # sandbox writes its own; the world folder starts empty. Settings and config are made below, never copied.
  local n=0 f base
  for f in "$LIVE"/*.js "$LIVE"/*.json; do
    base=$(basename "$f")
    case "$base" in
      server-settings*|gamemode-config.json|*.bak*|*.before-*|*-dump.json|*-merged.json|*.full.json|*.default.json|*.example.json|package-lock.json) continue;;
    esac
    cp -L "$f" "$SANDBOX/$base"; n=$((n + 1))
  done
  cp -a "$LIVE/data/." "$SANDBOX/data/"
  # 3. settings and gamemode config without secrets, Discord or live paths; checked before anything can start
  sudo cat "$LIVE/server-settings.json" | node "$HERE/make-settings.js" settings --port "$PORT" $public > "$SANDBOX/server-settings.json"
  chmod 600 "$SANDBOX/server-settings.json"
  node "$HERE/make-settings.js" gamemode --dir "$SANDBOX" < "$LIVE/gamemode-config.json" > "$SANDBOX/gamemode-config.json"
  if ! node "$HERE/make-settings.js" check --dir "$SANDBOX"; then
    rm -f "$SANDBOX/server-settings.json"; die "refusing: the sandbox config still points outside the sandbox"
  fi
  node "$HERE/make-settings.js" target --settings "$SANDBOX/server-settings.json" > "$SANDBOX/sandbox-target.json"
  chmod 600 "$SANDBOX/sandbox-target.json"
  git -C /opt/alduinak log -1 --format='%h %ci %s' > "$SANDBOX/BUILD.txt" 2>/dev/null || sudo git -C /opt/alduinak log -1 --format='%h %ci %s' > "$SANDBOX/BUILD.txt" || true
  say "init: $n gameplay files, build $(cut -c1-60 "$SANDBOX/BUILD.txt" 2>/dev/null), port $PORT${public:+ (public)}, in $SANDBOX"
}

cmd_start() {
  [ -f "$SANDBOX/server-settings.json" ] || die "run init first"
  active "$UNIT" && { say "already running, pid $(mainpid "$UNIT")"; return; }
  ss -lun "sport = :$PORT" | grep -q ":$PORT" && die "UDP $PORT is taken by something else"
  node "$HERE/make-settings.js" check --dir "$SANDBOX" >/dev/null || die "refusing: the sandbox config leaks (run init again)"
  : > "$SANDBOX/server.log"
  sudo systemd-run "${RUN_AS[@]}" --unit="$UNIT" --collect --quiet \
    -p WorkingDirectory="$SANDBOX" -p CPUWeight=50 -p CPUQuota="$CPU_QUOTA" -p MemoryMax="$MEM_MAX" -p LimitNOFILE=65535 \
    -p StandardOutput="append:$SANDBOX/server.log" -p StandardError="append:$SANDBOX/server.log" \
    /usr/bin/nice -n 10 /usr/bin/node "dist_back/$BUNDLE"
  local i
  for i in $(seq 1 180); do
    mainpid "$UNIT" > "$SANDBOX/server.pid"
    if grep -q "Server resources folder is listening on" "$SANDBOX/server.log" 2>/dev/null; then
      say "up: pid $(cat "$SANDBOX/server.pid"), UDP ${PORT}, /metrics on 127.0.0.1:$((PORT + 1)) (after ${i}s)"; return
    fi
    active "$UNIT" || { tail -20 "$SANDBOX/server.log" >&2; die "the sandbox server exited during boot"; }
    sleep 1
  done
  die "no 'listening' line within 180 s; see $SANDBOX/server.log"
}

cmd_stop() {
  local u
  for u in "$SAMPLER_UNIT" "$TUNNEL_UNIT" "$UNIT"; do active "$u" && { sudo systemctl stop "$u"; say "stopped $u"; }; done
  echo 0 > "$SANDBOX/server.pid" 2>/dev/null || true
}

cmd_status() {
  local u
  for u in "$UNIT" "$TUNNEL_UNIT" "$SAMPLER_UNIT"; do
    if active "$u"; then
      local pid; pid=$(mainpid "$u")
      say "$u: running, pid $pid, rss $(awk '/VmRSS/ {print int($2/1024) " MB"}' "/proc/$pid/status" 2>/dev/null)"
    else say "$u: stopped"; fi
  done
  active "$UNIT" && mainpid "$UNIT" > "$SANDBOX/server.pid"
  say "live skymp: pid $(systemctl show skymp -p MainPID --value), $(curl -s https://dragonbreakonline.com/api/servers | grep -o '"online":[0-9]*' || echo 'online: unknown')"
}

cmd_tunnel() {
  active "$TUNNEL_UNIT" && { say "tunnel already running"; return; }
  sudo systemd-run "${RUN_AS[@]}" --unit="$TUNNEL_UNIT" --collect --quiet -p WorkingDirectory="$SANDBOX" \
    /usr/bin/node "$HERE/udp-tunnel.js" --listen $((PORT + 2)) --server-port "$PORT" --log "$SANDBOX/tunnel.log"
  say "tunnel: tcp 127.0.0.1:$((PORT + 2)) -> udp $PORT. On the PC: ssh -N -L $((PORT + 1)):127.0.0.1:$((PORT + 1)) -L $((PORT + 2)):127.0.0.1:$((PORT + 2)) dragonbreak-dev"
}

cmd_sample() {
  active "$SAMPLER_UNIT" && { say "sampler already running"; return; }
  local iface; iface=$(ip route | awk '/default/ {print $5; exit}')
  sudo systemd-run "${RUN_AS[@]}" --unit="$SAMPLER_UNIT" --collect --quiet -p WorkingDirectory="$SANDBOX" \
    /usr/bin/node "$HERE/hostsample.js" sample --sandbox-pid-file "$SANDBOX/server.pid" \
    --live-pid "$(systemctl show skymp -p MainPID --value)" --out "$SANDBOX/host.csv" --iface "${iface:-eth0}"
  say "sampler: one line a second into $SANDBOX/host.csv"
}

cmd_summary() {
  local run=${1:-}; [ -f "$run" ] || die "usage: sandbox.sh summary <run.json copied from the PC's report folder>"
  local from to
  from=$(node -e "const r=require(process.argv[1]);const s=r.steps||[];console.log(new Date(s[0].startTs-600000).toISOString().replace('T',' ').slice(0,19))" "$(realpath "$run")")
  to=$(node -e "const r=require(process.argv[1]);const s=r.steps||[];console.log(new Date(s[s.length-1].endTs+60000).toISOString().replace('T',' ').slice(0,19))" "$(realpath "$run")")
  # Only the run's window of the live log, so the summary never holds more of it than it needs
  sudo awk -v from="[$from" -v to="[$to" 'substr($0,1,1)=="[" && $0 >= from && $0 <= to' /var/log/skymp-server.log > "$SANDBOX/live-window.log"
  node "$HERE/hostsample.js" summary --csv "$SANDBOX/host.csv" --run "$run" \
    --sandbox-log "$SANDBOX/server.log" --live-log "$SANDBOX/live-window.log" > "$SANDBOX/host-summary.json"
  say "summary: $SANDBOX/host-summary.json (copy it next to the PC report, then: node loadtest.js gate <report> --host-summary host-summary.json)"
}

cmd_target() { cat "$SANDBOX/sandbox-target.json"; }

cmd_reset() {
  active "$UNIT" && die "stop the sandbox first"
  rm -rf "$SANDBOX/world"; mkdir -p "$SANDBOX/world"
  rm -f "$SANDBOX"/starter-grants.json "$SANDBOX"/host.csv "$SANDBOX"/host-summary.json "$SANDBOX"/live-window.log
  say "reset: the sandbox world is empty; run init to put the gameplay files back"
}

cmd_remove() {
  cmd_stop
  [ -f "$SANDBOX/sandbox-target.json" ] || [ ! -d "$SANDBOX" ] || die "$SANDBOX does not look like a sandbox; not removing"
  rm -rf "$SANDBOX"; say "removed $SANDBOX"
}

c=${1:-help}; shift || true
case "$c" in
  init) cmd_init "$@";; start) cmd_start;; stop) cmd_stop;; status) cmd_status;; tunnel) cmd_tunnel;;
  sample) cmd_sample;; summary) cmd_summary "$@";; target) cmd_target;; reset) cmd_reset;; remove) cmd_remove;;
  *) sed -n '2,11p' "$0";;
esac
