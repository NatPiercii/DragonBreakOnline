#!/usr/bin/env bash
# HYBRID dev/production, shared with other operators: follow the owner's protocol (root CLAUDE.md, we are claude-nate).
# Every change goes to GitHub first; before a push to fork main, /api/servers must show "online":0.
#
# The DragonBreak development server: the `skymp` LXC (10.10.10.2) on Jake's Proxmox host, reached as
# `ssh dragonbreak-dev` (user, address, port and key live in ~/.ssh/config, never in this file).
# Everything under /opt is root-owned, so reads there go through sudo -n.
#
#   bash dev-server.sh status                 services, SkyMP checkout, disk and memory
#   bash dev-server.sh logs [unit] [lines]    skymp: /var/log/skymp-server.log; other units: journal
#   bash dev-server.sh run '<command>'        one command on the server, non-interactive
#   bash dev-server.sh deploy-gameplay        push server\*.js/json (tracked) live; hot-reloads, keeps admins
#   bash dev-server.sh deploy-plugins         the 9 non-Nexus plugins -> game server + launcher sync; updates SHA256SUMS
#   bash dev-server.sh deploy-news            server\patch-notes.json (committed) -> launcher news feed, no restart
#   bash dev-server.sh announce '<text>'      on-screen + chat message to every online player (gamemode announce.json)
#   bash dev-server.sh restart <unit> --yes   restart a unit; refuses without --yes
#   bash dev-server.sh shell                  interactive shell (needs a real terminal)
#
# Layout on the server:
#   skymp.service                /opt/alduinak/build/dist/server, gamemodePath dbo-gamemode.js, log /var/log/skymp-server.log
#   dragonbreak-backend.service  /opt/alduinak/skymp5-backend (Discord OAuth + master API), env /opt/dragonbreak/backend.env
#   skymp-api.service            /usr/local/bin/skymp-api.py (status + trigger update)
#   /opt/skyrim-data             plugins    /opt/skymp-state    world, companions, zone spawns
#   /opt/alduinak                the fork checkout (root-owned: use `sudo git -C /opt/alduinak ...`)
set -u
HOST=dragonbreak-dev
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=20 "$HOST")
UNITS="skymp dragonbreak-backend skymp-api dbprofile-test-backend tailscaled"

case "${1:-status}" in
  status)
    "${SSH[@]}" "echo \"\$(whoami)@\$(hostname) (\$(hostname -I | xargs)), \$(uptime -p)\"
      for u in $UNITS; do printf '  %-24s %s since %s\n' \"\$u\" \"\$(systemctl is-active \$u)\" \"\$(systemctl show -p ActiveEnterTimestamp --value \$u)\"; done
      echo \"  checkout: \$(sudo -n git -C /opt/alduinak log -1 --format='%h %ci %s' 2>&1)\"
      echo \"  bundle:   \$(stat -c '%y' /opt/alduinak/build/dist/server/dist_back/skymp5-server.js 2>&1)\"
      df -h / | awk 'NR==2{print \"  disk:     \" \$3 \" used of \" \$2}'
      free -h | awk 'NR==2{print \"  memory:   \" \$3 \" used of \" \$2}'" ;;
  logs)
    # skymp writes its own file; the journal only holds systemd's start/stop lines for it
    if [ "${2:-skymp}" = "skymp" ]; then "${SSH[@]}" "sudo -n tail -n '${3:-80}' /var/log/skymp-server.log"
    else "${SSH[@]}" "sudo -n journalctl -u '$2' -n '${3:-80}' --no-pager"; fi ;;
  deploy-gameplay)
    # server\*.js and *.json as tracked in the server repo -> the live server dir. gamemode.js goes in as
    # dbo-gamemode.js (the fork build overwrites gamemode.js with its placeholder on every auto-update) and
    # lands last, so the hot reload fires once with every module already in place. The server's own
    # gamemode-config.json `admins` list is kept. skills.json and server-settings are read at boot only.
    ROOT="$(cd "$(dirname "$0")" && pwd)/server"
    STAGE="$(mktemp -d)"; mkdir -p "$STAGE/g"
    git -C "$ROOT" ls-files | grep -E '^[^/]+\.(js|json)$' | grep -v -E '^(package|companions|patch-notes)\.json$' \
      | while read -r f; do cp "$ROOT/$f" "$STAGE/g/"; done
    mv "$STAGE/g/gamemode.js" "$STAGE/g/dbo-gamemode.js"
    ( cd "$STAGE" && tar -cf g.tar -C g . ) && scp -q "$STAGE/g.tar" "$HOST:/tmp/claude-nate-gameplay.tar" || exit 1
    rm -rf "$STAGE"
    "${SSH[@]}" 'set -e; S=/opt/alduinak/build/dist/server; T=$(mktemp -d); tar -xf /tmp/claude-nate-gameplay.tar -C "$T"
      B=/opt/skymp-backups/gameplay-$(date -u +%Y%m%dT%H%M%SZ); sudo -n mkdir -p "$B"
      for f in "$T"/*; do n=$(basename "$f"); [ -e "$S/$n" ] && sudo -n cp -a "$S/$n" "$B/"; done
      sudo -n node -e "const fs=require(\"fs\"),[n,o]=process.argv.slice(1);const a=JSON.parse(fs.readFileSync(n)),b=JSON.parse(fs.readFileSync(o));a.admins=b.admins||[];fs.writeFileSync(n,JSON.stringify(a,null,2)+\"\n\")" "$T/gamemode-config.json" "$S/gamemode-config.json"
      # The server reloads only when dbo-gamemode.js content changes (requireUncached compares it), and its
      # modules are re-read only on that reload, so a deploy stamps the file to force exactly one reload.
      for f in "$T"/*; do [ "$(basename "$f")" = dbo-gamemode.js ] || sudo -n cp "$f" "$S/"; done
      sudo -n cp "$T/dbo-gamemode.js" "$S/"
      echo "// deployed $(date -u +%FT%TZ)" | sudo -n tee -a "$S/dbo-gamemode.js" >/dev/null
      rm -rf "$T" /tmp/claude-nate-gameplay.tar; echo "installed; previous files in $B"; sleep 8
      sudo -n tail -n 400 /var/log/skymp-server.log | grep -E "\[gamemode\] loaded|\[error\]" | tail -5' ;;
  deploy-plugins)
    # The 9 non-Nexus plugins in server\data -> /opt/skyrim-data (game server, restarted only if one changed) and the
    # launcher's extra files (then its manifest is rebuilt). Updates fork\deploy\skyrim-data\SHA256SUMS; commit + push that.
    ROOT="$(cd "$(dirname "$0")" && pwd)"
    SUMS="$ROOT/fork/deploy/skyrim-data/SHA256SUMS"
    # DBO_PLUGIN_SRC overrides serverdata, e.g. the dev Data copy while a local server holds serverdata open
    SRC="${DBO_PLUGIN_SRC:-$ROOT/server/data}"
    PLUGINS=("DragonBreak.esp" "DragonBreak Built.esp" "DragonBreak Dungeons.esp" "DragonBreak Harvest.esp" "DragonBreak Hub.esp"
      "DragonBreak Whiterun.esp" "DragonBreak Online Edits.esp" "LostArk_Kamen.esp" "[Kirax] Lost Ark Reborn Paladin Legendary.esp")
    node -e 'const fs=require("fs"),crypto=require("crypto"),path=require("path");const [sums,data,...names]=process.argv.slice(1);
      let s=fs.readFileSync(sums,"utf8");let n=0;for(const p of names){const h=crypto.createHash("sha256").update(fs.readFileSync(path.join(data,p))).digest("hex");
      const re=new RegExp("^[0-9a-f]{64}  "+p.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+"$","m");if(!re.test(s))throw new Error("not in SHA256SUMS: "+p);
      const next=s.replace(re,h+"  "+p);if(next!==s){n++;s=next}}fs.writeFileSync(sums,s);console.log("SHA256SUMS: "+n+" line(s) changed")' "$SUMS" "$SRC" "${PLUGINS[@]}" || exit 1
    ( cd "$SRC" && tar -cf - "${PLUGINS[@]}" ) | ssh -o BatchMode=yes "$HOST" 'rm -rf /tmp/claude-nate-plugins && mkdir -p /tmp/claude-nate-plugins && tar -xf - -C /tmp/claude-nate-plugins' || exit 1
    "${SSH[@]}" 'sudo -n bash -s' <<'REMOTE'
set -euo pipefail
T=/tmp/claude-nate-plugins; D=/opt/skyrim-data; X=/opt/alduinak/build/client-files/extra/Data; B=/opt/skymp-backups/plugins-$(date -u +%Y%m%dT%H%M%SZ)
changed=()
for f in "$T"/*; do n=$(basename "$f"); cmp -s "$f" "$D/$n" || changed+=("$n"); done
if [ ${#changed[@]} -gt 0 ]; then
  mkdir -p "$B"; for n in "${changed[@]}"; do cp -a "$D/$n" "$B/" 2>/dev/null || true; done
  systemctl stop skymp
  for n in "${changed[@]}"; do install -m 644 -o root -g root "$T/$n" "$D/$n"; sed -i "s|^[0-9a-f]\{64\}  $(printf '%s' "$n" | sed 's/[][\.*^$|]/\\&/g')\$|$(sha256sum < "$T/$n" | cut -c1-64)  $n|" "$D/SHA256SUMS"; done
  systemctl start skymp
  echo "game server: ${#changed[@]} plugin(s) replaced and restarted (old copies in $B): ${changed[*]}"
else
  echo "game server: plugins already current, no restart"
fi
(cd "$D" && sha256sum -c --quiet SHA256SUMS) && echo "game server: SHA256SUMS verified"
for f in "$T"/*; do install -m 644 -o root -g root "$f" "$X/"; done
cd /opt/alduinak/skymp5-backend && node scripts/build-extra-manifest.js
rm -rf "$T"
REMOTE
    ;;
  run)
    shift; [ $# -gt 0 ] || { echo "usage: dev-server.sh run '<command>'" >&2; exit 2; }
    "${SSH[@]}" "$*" ;;
  restart)
    [ -n "${2:-}" ] && [ "${3:-}" = "--yes" ] || { echo "usage: dev-server.sh restart <unit> --yes" >&2; exit 2; }
    "${SSH[@]}" "sudo -n systemctl restart '$2' && sleep 3 && systemctl is-active '$2'" ;;
  announce)
    shift; [ $# -gt 0 ] || { echo "usage: dev-server.sh announce '<text>'" >&2; exit 2; }
    node -e 'process.stdout.write(JSON.stringify({ at: Date.now(), text: process.argv[1] }))' "$*" | "${SSH[@]}" 'sudo -n tee /opt/alduinak/build/dist/server/announce.json >/dev/null && echo "announced: $(sudo -n node -e "console.log(require(\"/opt/alduinak/build/dist/server/announce.json\").text)")"' ;;
  deploy-news)
    # The launcher shows /api/news, which prefers the untracked skymp5-backend/data/news.live.json and re-reads
    # it on change. Only committed notes go out (GitHub first); the newest entry comes first and is featured.
    ROOT="$(cd "$(dirname "$0")" && pwd)/server"; F="$(mktemp)"
    git -C "$ROOT" show HEAD:patch-notes.json > "$F" || { echo 'commit server\patch-notes.json first' >&2; exit 1; }
    node -e 'const a=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(!Array.isArray(a)||!a.length||!a.every(i=>i&&i.title))throw new Error("patch-notes.json must be a non-empty array of entries with a title");console.log(a.length+" entries, newest: "+a[0].title)' "$F" || exit 1
    scp -q "$F" "$HOST:/tmp/claude-nate-news.json" && rm -f "$F" || exit 1
    "${SSH[@]}" 'set -e; D=/opt/alduinak/skymp5-backend/data
      [ -f $D/news.live.json ] && sudo -n cp -a $D/news.live.json /opt/skymp-backups/news.live-$(date -u +%Y%m%dT%H%M%SZ).json
      sudo -n install -m 644 -o root -g root /tmp/claude-nate-news.json $D/.news.live.json.new && sudo -n mv $D/.news.live.json.new $D/news.live.json
      rm -f /tmp/claude-nate-news.json' || exit 1
    curl -s --max-time 20 "https://dragonbreakonline.com/api/news?v=$(date +%s)" \
      | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s);console.log("public feed: "+a.length+" entries, newest: "+(a[0]||{}).title)})' ;;
  shell)
    exec ssh "$HOST" ;;
  *)
    sed -n '2,24p' "$0"; exit 2 ;;
esac
