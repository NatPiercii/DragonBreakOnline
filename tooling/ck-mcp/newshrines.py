"""Which of the newly placed shrines can actually be prayed at.

A shrine only works if the reference the player crosshairs is an ACTIVATOR whose base id is in
skills.json's deities.choices[].shrines. A STAT is scenery: the engine fires no activation on it, so
prayer.js never hears about it however good the statue looks.

This lists every reference the candidate save added, says what kind of record its base is, where it
stands, and whether the deity roster already claims it.

usage: py ck-mcp\newshrines.py [candidate] [live]
"""
import sys, os, struct, json, collections
sys.path.insert(0, r"E:\DragonBreak Online Dev files\ck-mcp")
import core, esplib

# Every record type a reference can place. TACT - a talking activator - was missing from this list
# on 2026-09-20 and hid the Clavicus Vile shrine twice: it reported as an unresolved "?" base while
# sitting in plain sight among the other shrines. An activator is not always an ACTI.
BASE_SIGS = ("ACTI", "TACT", "STAT", "FURN", "MSTT", "LIGH", "TREE", "FLOR", "CONT", "DOOR",
             "MISC", "SCOL", "ADDN", "NPC_", "LVLI")

DATA = r"E:\DragonBreak Online Dev files\Skyrim Special Edition - dev\Data"
PLUGINS = r"E:\DragonBreak Online Dev files\server\plugins.server.txt"
SKILLS = r"E:\DragonBreak Online Dev files\server\skills.json"

cand = sys.argv[1] if len(sys.argv) > 1 else os.path.join(DATA, "DragonBreak Online Edits.tes")
live = sys.argv[2] if len(sys.argv) > 2 else os.path.join(DATA, "DragonBreak Online Edits.esp")

lo = core.LoadOrder(DATA, PLUGINS)

# every base object in the load order, by canonical id, with its record type
base = {}
for p in lo.plugins:
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, BASE_SIGS):
        c = lo.canon(p, fid)
        if c not in base:
            base[c] = (t, esplib.edid_of(lo.body(p, off, sz, fl)) or "")

cellname = {}
for p in lo.plugins:
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ("CELL", "WRLD")):
        e = esplib.edid_of(lo.body(p, off, sz, fl)) or ""
        if e:
            cellname[lo.canon(p, fid)] = e

sk = json.load(open(SKILLS, encoding="utf-8"))
claimed = {}                                     # canonical id -> deity name
for ch in sk["deities"]["choices"]:
    for s in ch.get("shrines", []):
        local, plugin = s.split(":", 1)
        claimed["%s:%06X" % (plugin, int(local, 16))] = ch["name"]


def refs(path, slot):
    p = esplib.Plugin(path)
    p.load_index = slot
    out = {}
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ("REFR",)):
        sub = lo.subrecords(p, off, sz, fl)
        nm = sub.get(b"NAME", b"")
        if len(nm) < 4:
            continue
        w, c, g = ctx
        data = sub.get(b"DATA", b"")
        pos = [round(v, 1) for v in struct.unpack("<3f", data[:12])] if len(data) >= 12 else None
        out[fid & 0xFFFFFF] = {
            "base": lo.canon(p, struct.unpack("<I", nm[:4])[0]),
            "cell": lo.canon(p, c) if c else None,
            "world": lo.canon(p, w) if w else None,
            "pos": pos,
        }
    lo._fh.pop(slot, None)
    return out


cr = refs(cand, 0xFA)
lr = refs(live, 0xFB)
added = {k: v for k, v in cr.items() if k not in lr}

print("%d references added by the save\n" % len(added))
rows = []
for local, r in added.items():
    t, e = base.get(r["base"], ("?", "?"))
    rows.append((t, e, local, r))
rows.sort(key=lambda x: (x[0] not in ("ACTI", "TACT"), x[1].lower()))

SHRINEISH = ("shrine", "statue", "altar", "namira", "sheogorath", "vaermina", "mephala",
             "nocturnal", "boethiah", "mehrunes", "dagon", "malacath", "meridia", "azura",
             "hircine", "sanguine", "clavicus", "hermaeus", "peryite", "molag", "hm")

ACTIVATABLE = ("ACTI", "TACT")   # a talking activator is activated exactly like an ACTI

print("=== ACTIVATORS - these are the ones prayer can use ===")
for t, e, local, r in rows:
    if t not in ACTIVATABLE:
        continue
    tag = claimed.get(r["base"], "")
    where = cellname.get(r["cell"] or r["world"] or "", r["cell"] or r["world"] or "?")
    print("  %06X  %-42s %-26s %s" % (local, e, where, r["pos"]))
    print("         base %-34s %s" % (r["base"], ("claimed by " + tag) if tag else "*** NOT in skills.json ***"))

print("\n=== STATICS that look like shrines - scenery, NOT prayable ===")
any_stat = False
for t, e, local, r in rows:
    if t in ACTIVATABLE:
        continue
    if not any(k in e.lower() for k in SHRINEISH):
        continue
    any_stat = True
    where = cellname.get(r["cell"] or r["world"] or "", r["cell"] or r["world"] or "?")
    print("  %06X  [%s] %-38s %-24s %s" % (local, t, e, where, r["pos"]))
if not any_stat:
    print("  none")

print("\n=== everything else added (dressing) ===")
other = [(t, e, local) for t, e, local, r in rows
         if t not in ACTIVATABLE and not any(k in e.lower() for k in SHRINEISH)]
print("  " + ", ".join("%s %s" % (t, e) for t, e, _ in other[:30]) or "  none")

print("\n=== which Daedric Princes now have a prayable activator here ===")
for ch in sk["deities"]["choices"]:
    if ch["kind"] == "divine":
        continue
    hit = [r for t, e, local, r in rows if t in ACTIVATABLE and claimed.get(r["base"]) == ch["name"]]
    print("  %-16s %s" % (ch["name"], "YES - %d new activator(s)" % len(hit) if hit else "no"))
