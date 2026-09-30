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
# The bundles above already go to this run's own folder. The fork sources did not: with FORK at the shared clone,
# another worker switching its branch mid-run changed what half the harnesses read (a dungeon harness flipped for
# Worker B, 2026-09-30). So the sources a run reads are copied here first, node_modules linked, and every bundle and
# harness reads the copy. FORK_LABEL keeps the real paths for the report line.
FORK_LABEL=$FORK FORK_SERVER_LABEL=$FORK_SERVER
snapshot() {
  local src=$1 dst=$2 d f sub
  for d in skymp5-server skymp5-client skymp5-front; do
    [ -d "$src/$d" ] || continue
    mkdir -p "$dst/$d"
    for sub in ts src; do [ -d "$src/$d/$sub" ] && cp -r "$src/$d/$sub" "$dst/$d/$sub"; done
    for f in package.json tsconfig.json; do [ -f "$src/$d/$f" ] && cp "$src/$d/$f" "$dst/$d/"; done
    [ -d "$src/$d/node_modules" ] && ln -s "$(cd "$src/$d/node_modules" && pwd -P)" "$dst/$d/node_modules"
  done
  return 0
}
snapshot "$FORK" "$OUT/fork"
if [ "$(cd "$FORK_SERVER" && pwd -P)" = "$(cd "$FORK" && pwd -P)" ]; then FORK_SERVER=$OUT/fork; else snapshot "$FORK_SERVER" "$OUT/fork-server"; FORK_SERVER=$OUT/fork-server; fi
FORK=$OUT/fork
export FORK FORK_SERVER

# Seconds a harness may run before it counts as failed (120 unless named here). The loot budget claims every dungeon at
# every difficulty and took almost 4 minutes on a busy box (27 s of CPU), so 120 s killed a passing run (2026-09-30).
declare -A LIMIT=([expedition-loot-budget]=600)

# harness -> the bundle it takes: which fork (client: $FORK, server: $FORK_SERVER) and the entry point in it
declare -A NEEDS=(
  [bodypos]=client:skymp5-client/src/sync/bodyPos.ts
  [glow-plan]=client:skymp5-client/src/services/services/dboGlowPlan.ts
  [client-calendar]=client:skymp5-client/src/services/services/calendar.ts
  [housing-keys]=server:skymp5-server/ts/systems/housingSystem.ts
  [housing-staff]=server:skymp5-server/ts/systems/housingSystem.ts
  [mastery-melee]=server:skymp5-server/ts/systems/masterySystem.ts
  [mastery-shadow]=server:skymp5-server/ts/systems/masterySystem.ts
  [mastery-values]=server:skymp5-server/ts/systems/masterySystem.ts
  [craft-weight]=server:skymp5-server/ts/systems/masterySystem.ts
  [mastery-cast-route]=server:skymp5-server/ts/systems/masterySystem.ts
  [mastery-award]=server:skymp5-server/ts/systems/masterySystem.ts
  [mastery-boost]=server:skymp5-server/ts/systems/masterySystem.ts
  [summon-race]=server:skymp5-server/ts/systems/espmMagic.ts
  [spawn-refill]=server:skymp5-server/ts/systems/npcSpawnSystem.ts
  [spawn-slots]=server:skymp5-server/ts/systems/npcSpawnSystem.ts
  [spawn-heading]=server:skymp5-server/ts/systems/npcSpawnSystem.ts
  [spawn-stray]=server:skymp5-server/ts/systems/npcSpawnSystem.ts
  [name-release]=server:skymp5-server/ts/systems/spawn.ts
  [capture-leash]=server:skymp5-server/ts/systems/captureSystem.ts
  [capture-rope]=server:skymp5-server/ts/systems/captureSystem.ts
  [contracts-tab]=front:skymp5-front/src/features/expeditionBoard/index.tsx
  [supernatural-tab]=front:skymp5-front/src/features/masteryMenu/index.tsx
  [shrine-panel-widget]=front:skymp5-front/src/features/shrinePanel/index.tsx
  [school-meters]=front:skymp5-front/src/features/masteryMenu/index.tsx
  [study-magic]=front:skymp5-front/src/features/studyMagic/index.tsx
  [class-lectern]=front:skymp5-front/src/features/classLectern/index.tsx
)
bundle() {
  local side=${1%%:*} entry=${1#*:}
  local root=$FORK; [ "$side" = server ] && root=$FORK_SERVER
  # A front widget from $FORK, bundled with React's static renderer; styles are left out. A worktree has no
  # node_modules of its own, so React comes from the main clone (beside this repo, or ~/dragonbreak/fork) when $FORK has none.
  if [ "$side" = front ]; then
    local out="$OUT/front-$(basename "$(dirname "$entry")").js" wrap="$OUT/front-$(basename "$(dirname "$entry")")-entry.tsx"
    # A widget this front does not have yet: the harness gets an empty bundle, finds none of its widget's classes in it
    # and says it skipped (each front harness looks for its own before it requires the bundle)
    [ -f "$root/$entry" ] || { : > "$out"; echo "$out"; return 0; }
    local mods="$root/skymp5-front/node_modules"
    [ -d "$mods" ] || mods="$(cd .. && pwd)/fork/skymp5-front/node_modules"
    [ -d "$mods" ] || mods="$HOME/dragonbreak/fork/skymp5-front/node_modules"
    # The widget's named exports come too, so a harness can render a part that only a click would show
    printf "export * from '%s';\nexport { default as Widget } from '%s';\nexport { renderToStaticMarkup } from 'react-dom/server';\nexport { createElement } from 'react';\n" "$root/$entry" "$root/$entry" > "$wrap"
    [ -f "$out" ] || NODE_PATH="$mods" "$ESBUILD" "$wrap" --bundle --platform=node --format=cjs --loader:.scss=empty --outfile="$out" --log-level=error || return 1
    echo "$out"; return 0
  fi
  local out="$OUT/$side-$(basename "${entry%.ts}").js"
  [ -f "$out" ] || (cd "$root" && "$ESBUILD" "$entry" --bundle --platform=node --format=cjs --outfile="$out" --log-level=error) || return 1
  echo "$out"
}
echo "server code from $FORK_SERVER_LABEL ($(git -C "$FORK_SERVER_LABEL" log --oneline -1 2>/dev/null | cut -c1-60)), client code from $FORK_LABEL ($(git -C "$FORK_LABEL" log --oneline -1 2>/dev/null | cut -c1-60)), copied at the start"

pass=0; fail=0; failed=()
for h in tests/*-harness.js; do
  name=$(basename "$h" -harness.js); arg=
  if [ -n "${NEEDS[$name]:-}" ]; then
    if [ ! -x "$ESBUILD" ]; then echo "SKIP $name (no esbuild at $ESBUILD)"; fail=$((fail+1)); failed+=("$name"); continue; fi
    # A front widget this client line does not have yet (a panel still on its branch) has nothing to test
    if [[ "${NEEDS[$name]}" == front:* ]] && [ ! -f "$FORK/${NEEDS[$name]#front:}" ]; then echo "ok   $name (skipped: no ${NEEDS[$name]#front:} in $FORK)"; pass=$((pass+1)); continue; fi
    # The same for a client module still on its branch (dboGlowPlan.ts until client-glow-shader is on the client line)
    if [[ "${NEEDS[$name]}" == client:* ]] && [ ! -f "$FORK/${NEEDS[$name]#client:}" ]; then echo "ok   $name (skipped: no ${NEEDS[$name]#client:} in $FORK)"; pass=$((pass+1)); continue; fi
    arg=$(bundle "${NEEDS[$name]}") || { echo "FAIL $name (bundle did not build)"; fail=$((fail+1)); failed+=("$name"); continue; }
  fi
  if timeout "${LIMIT[$name]:-120}" node "$h" $arg > "$OUT/$name.log" 2>&1; then
    echo "ok   $name"; pass=$((pass+1))
  else
    echo "FAIL $name"; grep -E '^\s*FAIL' "$OUT/$name.log" | head -3 | sed 's/^/       /'; fail=$((fail+1)); failed+=("$name")
  fi
done
echo "$pass passed, $fail failed${failed[*]:+: ${failed[*]}}"
[ "$fail" -eq 0 ]
