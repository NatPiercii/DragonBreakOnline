"""Re-enables the stone arches of the swinging-blade traps, leaving every portcullis gate removed.

The 2026-09 blocker pass disabled and sank (z = -30000) the lever gates and the puzzle blockers, because the
server cannot run the puzzles. It also caught the arch the blade of a swinging-axe trap hangs in
(STAT NorHallExSmPortcullis01), while leaving the blades (ACTI TrapBladeSwinging01) live. The result in game is
axes swinging in a bare corridor with nothing around them.

This removes DragonBreak Online Edits.esp's override of each arch that sits exactly where a live blade still
swings, so the vanilla record wins again: enabled, at its original height, same position, rotation and scale.
It touches nothing else. The gate grates (NorPortcullis, NorPortcullisLarge01) stay disabled, and so do the
arches with no blade at their spot, whose removal may have been deliberate.

Targets are derived from the load order every run, never hard-coded, and each one must pass three checks:
its only override is DragonBreak Online Edits.esp's, that override differs from vanilla only in the
"initially disabled" flag and z, and a live blade stands at the same x,y in the same cell. Anything else is
reported and skipped. The write goes through ck-mcp's own edits.remove_records, which backs the plugin up,
verifies the result (masters unchanged, HEDR count, group walk) and refuses to save a file that fails.

    py ck-mcp\\restore_axe_arches.py            list what would change
    py ck-mcp\\restore_axe_arches.py --apply    do it

Afterwards: stop the server, copy the plugin to server\\data\\, and relaunch the client (arches are statics,
so what makes them appear is the client's copy)."""
import sys, os, struct

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "ck-mcp"))
import core, esplib, edits

DATA = os.path.join(ROOT, "Skyrim Special Edition - dev", "Data")
PLUGINS_TXT = os.path.join(ROOT, "server", "plugins.server.txt")
BACKUPS = os.environ.get("CKMCP_BACKUPS") or os.path.join(ROOT, "ckmcp-backups")
LAYER = "DragonBreak Online Edits.esp"
ARCH_EDID, BLADE_EDID = "NorHallExSmPortcullis01", "TrapBladeSwinging01"
DISABLED = 0x800

lo = core.LoadOrder(DATA, PLUGINS_TXT)

base = {}
for p in lo.plugins:
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ("STAT", "ACTI")):
        e = esplib.edid_of(lo.body(p, off, sz, fl)) or ""
        if e in (ARCH_EDID, BLADE_EDID):
            base.setdefault(e, lo.canon(p, fid))
arch_base, blade_base = base.get(ARCH_EDID), base.get(BLADE_EDID)
if not arch_base or not blade_base:
    sys.exit("could not find %s / %s in the load order" % (ARCH_EDID, BLADE_EDID))

# every version of every arch and blade reference, in load order
versions = {}
for p in lo.plugins:
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ("REFR",)):
        f = lo.ref_fields(p, off, sz, fl)
        if f["base"] in (arch_base, blade_base):
            cell = lo.canon(p, ctx[1]) if ctx[1] else None
            versions.setdefault(lo.canon(p, fid), []).append((p.name, fl, f, cell))

spot = lambda cell, f: (cell, round(f["pos"][0]), round(f["pos"][1]))
live_blades = {spot(c, f) for vs in versions.values() for (_, fl, f, c) in [vs[-1]]
               if f["base"] == blade_base and not fl & DISABLED}

targets, skipped = [], []
for ref, vs in versions.items():
    name, fl, f, cell = vs[-1]
    if f["base"] != arch_base or not fl & DISABLED:
        continue
    if spot(cell, f) not in live_blades:
        continue                                    # no blade here: not an axe-trap arch, leave it alone
    if len(vs) != 2 or vs[-1][0] != LAYER:
        skipped.append((ref, "override chain is " + " -> ".join(v[0] for v in vs)))
        continue
    van_fl, van = vs[0][1], vs[0][2]
    diffs = []
    if van_fl & DISABLED:
        diffs.append("vanilla itself is disabled")
    if van["base"] != f["base"]:
        diffs.append("base differs")
    if [round(x, 3) for x in van["pos"][:2]] != [round(x, 3) for x in f["pos"][:2]]:
        diffs.append("x,y differ")
    if [round(x, 4) for x in van["rot"]] != [round(x, 4) for x in f["rot"]]:
        diffs.append("rotation differs")
    if round(van["scale"], 3) != round(f["scale"], 3):
        diffs.append("scale differs")
    if diffs:
        skipped.append((ref, "; ".join(diffs)))      # more than a disable+sink: needs a human
        continue
    targets.append((ref, cell, van["pos"][2], f["pos"][2]))

print("%s: %d arches to re-enable, %d skipped" % (LAYER, len(targets), len(skipped)))
for ref, why in skipped:
    print("   skipped %-28s %s" % (ref, why))
by_cell = {}
for ref, cell, van_z, now_z in sorted(targets):
    by_cell.setdefault(cell, []).append((ref, van_z))
for cell, rows in sorted(by_cell.items(), key=lambda kv: kv[0] or ""):
    print("   %-22s %d arch(es) back to z %s" % (cell, len(rows), ", ".join(str(z) for _, z in rows)))

if not targets:
    sys.exit(0)
if "--apply" not in sys.argv:
    print("\ndry run. Re-run with --apply to write. Backups go to %s" % BACKUPS)
    r = edits.remove_records(lo, LAYER, [t[0] for t in targets], BACKUPS, True)
else:
    r = edits.remove_records(lo, LAYER, [t[0] for t in targets], BACKUPS, False)
print("\nresult:", {k: v for k, v in r.items() if k in
                    ("written", "reason", "removed", "empty_groups_pruned", "verification", "problems")})
if "--apply" in sys.argv and r.get("written"):
    print("\nWritten. Now: stop the server, copy the plugin to server\\data\\, relaunch the client.")
