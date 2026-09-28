#!/usr/bin/env bash
# Runs every tests/*-harness.js the way it expects to be run, and prints one line per harness plus a total.
# Several harnesses test fork code and take a bundle of it as their argument; this builds those bundles with the
# fork's esbuild first. The fork is looked for beside this repo (../fork, as in ~/dragonbreak) or at $FORK.
# Server code and client code can come from two different forks: a release ships the server from fork main and the
# client pack from a client line, and a client line's skymp5-server is only as old as its branch point (2026-09-28:
# summon-race failed against client-playermenu-panel, whose espmMagic.ts predates main's per-race summons).
#   FORK=<client line> FORK_SERVER=<fork main> bash tests/run-all.sh
# FORK_SERVER defaults to FORK. Harnesses that read fork sources themselves (skill-openings) get FORK_SERVER too.
# Run it from this repo's root:  bash tests/run-all.sh
# A harness that prints nothing but a usage line would be counted as a failure here, which is how the suite looked
# broken on 2026-09-28 (nine "failures" were missing arguments).
set -u
cd "$(dirname "$0")/.."
FORK=${FORK:-$(cd .. && pwd)/fork}
FORK_SERVER=${FORK_SERVER:-$FORK}
export FORK FORK_SERVER
ESBUILD=$FORK_SERVER/skymp5-server/node_modules/.bin/esbuild
[ -x "$ESBUILD" ] || ESBUILD=$FORK/skymp5-server/node_modules/.bin/esbuild
OUT=$(mktemp -d /tmp/claude-nate-harness-XXXX)
trap 'rm -rf "$OUT"' EXIT

# harness -> the bundle it takes: which fork (client: $FORK, server: $FORK_SERVER) and the entry point in it
declare -A NEEDS=(
  [bodypos]=client:skymp5-client/src/sync/bodyPos.ts
  [housing-keys]=server:skymp5-server/ts/systems/housingSystem.ts
  [mastery-melee]=server:skymp5-server/ts/systems/masterySystem.ts
  [mastery-shadow]=server:skymp5-server/ts/systems/masterySystem.ts
  [mastery-values]=server:skymp5-server/ts/systems/masterySystem.ts
  [summon-race]=server:skymp5-server/ts/systems/espmMagic.ts
  [spawn-refill]=server:skymp5-server/ts/systems/npcSpawnSystem.ts
  [spawn-slots]=server:skymp5-server/ts/systems/npcSpawnSystem.ts
)
bundle() {
  local side=${1%%:*} entry=${1#*:}
  local root=$FORK; [ "$side" = server ] && root=$FORK_SERVER
  local out="$OUT/$side-$(basename "${entry%.ts}").js"
  [ -f "$out" ] || (cd "$root" && "$ESBUILD" "$entry" --bundle --platform=node --format=cjs --outfile="$out" --log-level=error) || return 1
  echo "$out"
}
echo "server code from $FORK_SERVER ($(git -C "$FORK_SERVER" log --oneline -1 2>/dev/null | cut -c1-60)), client code from $FORK ($(git -C "$FORK" log --oneline -1 2>/dev/null | cut -c1-60))"

pass=0; fail=0; failed=()
for h in tests/*-harness.js; do
  name=$(basename "$h" -harness.js); arg=
  if [ -n "${NEEDS[$name]:-}" ]; then
    if [ ! -x "$ESBUILD" ]; then echo "SKIP $name (no esbuild at $ESBUILD)"; fail=$((fail+1)); failed+=("$name"); continue; fi
    arg=$(bundle "${NEEDS[$name]}") || { echo "FAIL $name (bundle did not build)"; fail=$((fail+1)); failed+=("$name"); continue; }
  fi
  if timeout 120 node "$h" $arg > "$OUT/$name.log" 2>&1; then
    echo "ok   $name"; pass=$((pass+1))
  else
    echo "FAIL $name"; grep -E '^\s*FAIL' "$OUT/$name.log" | head -3 | sed 's/^/       /'; fail=$((fail+1)); failed+=("$name")
  fi
done
echo "$pass passed, $fail failed${failed[*]:+: ${failed[*]}}"
[ "$fail" -eq 0 ]
