#!/usr/bin/env bash
# Recopies the working tooling from Nat's dev root into server/tooling, then refuses if a copy looks secret.
# Run from anywhere on Nat's PC:  bash server/tooling/refresh.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

rm -rf "$HERE/ck-mcp" "$HERE/xedit-scripts" "$HERE/ops"
mkdir -p "$HERE/ck-mcp/git-hooks" "$HERE/xedit-scripts" "$HERE/ops"

cp "$ROOT"/ck-mcp/*.py "$ROOT/ck-mcp/README.md" "$ROOT/ck-mcp/run.cmd" "$HERE/ck-mcp/"
cp "$ROOT"/ck-mcp/{dungeons_extra,actors_server_replaced,wildlife_server_replaced}.json "$HERE/ck-mcp/"
cp "$ROOT/ck-mcp/git-hooks/pre-commit" "$HERE/ck-mcp/git-hooks/"
cp "$ROOT/.mcp.json" "$HERE/ck-mcp/mcp.json.example"

cp "$ROOT/Skyrim Special Edition - dev/Edit Scripts"/DBO_*.pas "$HERE/xedit-scripts/"
cp "$ROOT/SSEEdit 4.1.5f/Edit Scripts"/DBO*.pas "$HERE/xedit-scripts/"

cp "$ROOT/dev-server.sh" "$ROOT/backup-git.cmd" "$HERE/ops/"

# The server branch is public: stop on anything that looks like a credential or a real address
if grep -rnIE '([0-9]{1,3}\.){3}[0-9]{1,3}:?[0-9]*' "$HERE" --include='*.sh' --include='*.cmd' --include='*.py' --include='*.pas' --include='*.json' \
     | grep -vE '(127\.0\.0\.1|0\.0\.0\.0|10\.10\.10\.2)'; then
  echo "refresh: an IP address is in the snapshot, remove it before committing" >&2; exit 1
fi
if grep -rnIiE '(api[_-]?key|client_secret|password|passwd|bearer [a-z0-9]|ghp_[a-z0-9]|-----BEGIN)' "$HERE" --exclude=refresh.sh; then
  echo "refresh: something credential-shaped is in the snapshot, check it before committing" >&2; exit 1
fi
echo "refresh: $(find "$HERE/ck-mcp" -name '*.py' | wc -l) python, $(ls "$HERE/xedit-scripts" | wc -l) xEdit scripts, $(ls "$HERE/ops" | wc -l) ops files"
