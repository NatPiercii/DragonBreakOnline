"""Compare a Creation Kit save against the live plugin before promoting it.

The CK rewrites everything it loads, and it does not always give back what it was handed. Before a
save replaces the live file this answers: what records did each side have, what did the save lose,
what did it gain, and are the records other sessions authored still in there.

usage: py ck-mcp\comparesave.py <candidate.tes> [live.esp]
"""
import sys, os, struct, collections
sys.path.insert(0, r"E:\DragonBreak Online Dev files\ck-mcp")
import core, esplib

DATA = r"E:\DragonBreak Online Dev files\Skyrim Special Edition - dev\Data"
PLUGINS = r"E:\DragonBreak Online Dev files\server\plugins.server.txt"

cand = sys.argv[1] if len(sys.argv) > 1 else os.path.join(DATA, "DragonBreak Online Edits.tes")
live = sys.argv[2] if len(sys.argv) > 2 else os.path.join(DATA, "DragonBreak Online Edits.esp")

lo = core.LoadOrder(DATA, PLUGINS)

SIGS = ("SPEL", "RACE", "ACTI", "REFR", "STAT", "CELL", "WRLD", "MGEF", "NPC_", "WEAP", "ARMO",
        "MISC", "CONT", "DOOR", "FURN", "LVLI", "LVLN", "COBJ", "BOOK", "FLST", "KYWD", "QUST",
        "FACT", "IDLE", "MSTT", "TREE", "FLOR", "LIGH", "SNDR", "SOUN", "EFSH", "TXST", "GLOB")


def scan(path, slot):
    p = esplib.Plugin(path)
    p.load_index = slot
    counts = collections.Counter()
    edids = {}
    refrs = collections.Counter()      # base editorId -> how many REFRs point at it
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, SIGS):
        counts[t] += 1
        local = fid & 0xFFFFFF
        if t == "REFR":
            sub = lo.subrecords(p, off, sz, fl)
            nm = sub.get(b"NAME", b"")
            if len(nm) >= 4:
                refrs[struct.unpack("<I", nm[:4])[0] & 0xFFFFFF] += 1
        else:
            e = esplib.edid_of(lo.body(p, off, sz, fl)) or ""
            if e:
                edids.setdefault(t, {})[e] = local
    masters = list(p.masters)
    lo._fh.pop(slot, None)
    return counts, edids, refrs, masters


print("candidate:", cand, os.path.getsize(cand), "bytes")
print("live:     ", live, os.path.getsize(live), "bytes")
print()

cc, ce, cr, cm = scan(cand, 0xFA)
lc, le, lr, lm = scan(live, 0xFB)

print("=== masters ===")
print("  live %d, candidate %d  ->  %s" % (len(lm), len(cm), "same" if lm == cm else "DIFFERENT"))
if lm != cm:
    for m in cm:
        if m not in lm:
            print("    candidate ADDS master:", m)
    for m in lm:
        if m not in cm:
            print("    candidate DROPS master:", m)

print("\n=== record counts by type (only where they differ) ===")
for t in sorted(set(list(cc) + list(lc))):
    a, b = lc.get(t, 0), cc.get(t, 0)
    if a != b:
        print("  %-5s live %6d   candidate %6d   %+d" % (t, a, b, b - a))
print("  (types not listed are identical)")

print("\n=== records the candidate LOST, by editor id ===")
lost_total = 0
for t in sorted(le):
    lost = sorted(set(le[t]) - set(ce.get(t, {})))
    if not lost:
        continue
    lost_total += len(lost)
    print("  %s: %d" % (t, len(lost)))
    for e in lost[:25]:
        print("      %s" % e)
    if len(lost) > 25:
        print("      ... and %d more" % (len(lost) - 25))
if not lost_total:
    print("  none")

print("\n=== records the candidate ADDED, by editor id ===")
gained_total = 0
for t in sorted(ce):
    gained = sorted(set(ce[t]) - set(le.get(t, {})))
    if not gained:
        continue
    gained_total += len(gained)
    print("  %s: %d" % (t, len(gained)))
    for e in gained[:40]:
        print("      %-44s %06X" % (e, ce[t][e]))
    if len(gained) > 40:
        print("      ... and %d more" % (len(gained) - 40))
if not gained_total:
    print("  none")

# ---- the records this project authored, which MUST survive ------------------------------------
print("\n=== records other sessions authored - must all survive ===")
must = [e for e in le.get("SPEL", {}) if e.startswith("DBO_")]
missing = [e for e in must if e not in ce.get("SPEL", {})]
print("  DBO_* spells: %d in live, %d in candidate%s"
      % (len(must), len(must) - len(missing), (", MISSING: " + ", ".join(missing[:12])) if missing else " - all present"))
races = [e for e in le.get("RACE", {}) if e.endswith("Race")]
rmiss = [e for e in races if e not in ce.get("RACE", {})]
print("  RACE overrides: %d in live, %d in candidate%s"
      % (len(races), len(races) - len(rmiss), (", MISSING: " + ", ".join(rmiss)) if rmiss else " - all present"))

# ---- what new references were placed, and on what ----------------------------------------------
print("\n=== new REFRs in the candidate, by what they place ===")
names = {}
for p in lo.plugins:
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ("ACTI", "STAT", "FURN", "MSTT", "LIGH")):
        names[lo.canon(p, fid)] = (t, esplib.edid_of(lo.body(p, off, sz, fl)) or "")
newrefs = 0
for base, n in sorted(cr.items(), key=lambda kv: -kv[1]):
    delta = n - lr.get(base, 0)
    if delta <= 0:
        continue
    newrefs += delta
    label = "?"
    for key, (t, e) in names.items():
        if int(key.split(":")[1], 16) == base:
            label = "%s %s" % (t, e)
            break
    print("  +%-3d  base %06X  %s" % (delta, base, label))
if not newrefs:
    print("  none")
print("\n  %d new references in total" % newrefs)
