#!/usr/bin/env bash
# Runs every tests/*-harness.js the way it expects to be run, and prints one line per harness plus a total.
# Several harnesses test fork code and take a bundle of it as their argument; this builds those bundles with the
# fork's esbuild first. The fork is looked for beside this repo (../fork, as in ~/dragonbreak) or at $FORK.
# Run it from this repo's root:  bash tests/run-all.sh
# A harness that prints nothing but a usage line would be counted as a failure here, which is how the suite looked
# broken on 2026-09-28 (nine "failures" were missing arguments).
set -u
cd "$(dirname "$0")/.."
FORK=${FORK:-$(cd .. && pwd)/fork}
SRV=$FORK/skymp5-server
ESBUILD=$SRV/node_modules/.bin/esbuild
OUT=$(mktemp -d /tmp/claude-nate-harness-XXXX)
trap 'rm -rf "$OUT"' EXIT

# harness -> the bundle it takes (entry point relative to skymp5-server)
declare -A NEEDS=(
  [bodypos]=../skymp5-client/src/sync/bodyPos.ts
  [housing-keys]=ts/systems/housingSystem.ts
  [mastery-melee]=ts/systems/masterySystem.ts
  [mastery-shadow]=ts/systems/masterySystem.ts
  [mastery-values]=ts/systems/masterySystem.ts
  [summon-race]=ts/systems/espmMagic.ts
  [spawn-refill]=ts/systems/npcSpawnSystem.ts
  [spawn-slots]=ts/systems/npcSpawnSystem.ts
)
bundle() {
  local entry=$1 out="$OUT/$(basename "${1%.ts}").js"
  [ -f "$out" ] || (cd "$SRV" && "$ESBUILD" "$entry" --bundle --platform=node --format=cjs --outfile="$out" --log-level=error) || return 1
  echo "$out"
}

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
