"""Daedric shrine sites in Beyond Skyrim Cyrodiil, and what stands on them.

Nat is placing hidden Daedric shrines through Cyrodiil in the Creation Kit. Before authoring a single
activator this answers: which Daedric sites has Beyond Skyrim already BUILT, where are they, and is
there a statue on them already? A dressed site that only lacks an activator is an afternoon; an empty
hillside is a weekend.

Cyrodiil's canonical Daedric roster is Oblivion's fifteen shrines. This script does not assume that -
it searches every cell, location and reference in BSHeartland/BSAssets for each Prince's name, and for
the shrine statue meshes the vanilla game uses, and reports what it finds.

usage: py ck-mcp\daedricsites.py
"""
import sys, struct, json, re, collections
sys.path.insert(0, r"E:\DragonBreak Online Dev files\ck-mcp")
import core, esplib

DATA = r"E:\DragonBreak Online Dev files\Skyrim Special Edition - dev\Data"
PLUGINS = r"E:\DragonBreak Online Dev files\server\plugins.server.txt"
OUT = r"E:\DragonBreak Online Dev files\server\daedric-sites.json"

# The seventeen Princes, so a site for one nobody expected is still found.
PRINCES = ["Azura", "Boethiah", "ClavicusVile", "HermaeusMora", "Hircine", "Jyggalag", "Malacath",
           "MehrunesDagon", "Meridia", "MolagBal", "Mephala", "Namira", "Nocturnal", "Peryite",
           "Sanguine", "Sheogorath", "Vaermina"]
PAT = re.compile("|".join(["azura", "boethia", "clavicus", "hermaeus", "hircine", "jyggalag",
                           "malacath", "mehrunes", "dagon", "meridia", "molagbal", "molag",
                           "mephala", "namira", "nocturnal", "peryite", "sanguine", "sheogorath",
                           "vaermina"]), re.I)
BS = ("BSHeartland.esm", "BSAssets.esm")

lo = core.LoadOrder(DATA, PLUGINS)
edid = lambda p, off, sz, fl: esplib.edid_of(lo.body(p, off, sz, fl)) or ""

# ---- pass 1: name every cell, worldspace and base object once -----------------------------------
cellname, cellgrid, cellworld, basename = {}, {}, {}, {}
for p in lo.plugins:
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ("CELL", "WRLD")):
        c = lo.canon(p, fid)
        e = edid(p, off, sz, fl)
        if e:
            cellname[c] = e
        if t == "CELL":
            sub = lo.subrecords(p, off, sz, fl)
            x = sub.get(b"XCLC", b"")
            if len(x) >= 8:
                cellgrid[c] = struct.unpack("<ii", x[:8])
            w = ctx[0]
            if w:
                cellworld[c] = lo.canon(p, w)
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ("ACTI", "STAT", "FURN", "MSTT")):
        c = lo.canon(p, fid)
        if c not in basename:
            basename[c] = (t, edid(p, off, sz, fl))

# ---- pass 2: any cell or location named after a Prince ------------------------------------------
sites = {}
for p in lo.plugins:
    if p.name not in BS:
        continue
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ("CELL", "LCTN")):
        e = edid(p, off, sz, fl)
        if not PAT.search(e):
            continue
        c = lo.canon(p, fid)
        sites[c] = {"kind": t, "editorId": e, "from": p.name,
                    "grid": cellgrid.get(c), "world": cellworld.get(c), "refs": 0, "statues": []}

# ---- pass 3: what stands in each site, and every Daedric statue anywhere in BS -------------------
DAEDRIC_BASE = re.compile(r"shrine|statue|altar", re.I)
loose = collections.defaultdict(list)          # a Daedric-named base placed anywhere in BS
for p in lo.plugins:
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ("REFR",)):
        w, c, g = ctx
        cc = lo.canon(p, c) if c else None
        ww = lo.canon(p, w) if w else None
        sub = lo.subrecords(p, off, sz, fl)
        nm = sub.get(b"NAME", b"")
        if len(nm) < 4:
            continue
        base = lo.canon(p, struct.unpack("<I", nm[:4])[0])
        bt, be = basename.get(base, ("?", ""))
        data = sub.get(b"DATA", b"")
        pos = [round(v, 1) for v in struct.unpack("<3f", data[:12])] if len(data) >= 12 else None

        if cc in sites:
            sites[cc]["refs"] += 1
            if PAT.search(be) or DAEDRIC_BASE.search(be):
                sites[cc]["statues"].append({"refr": lo.canon(p, fid), "base": base, "type": bt,
                                             "editorId": be, "pos": pos, "from": p.name})
        # a Prince-named base standing anywhere inside Beyond Skyrim, site or not
        in_bs = (ww and ww.split(":")[0] in BS) or (cc and cc.split(":")[0] in BS)
        if in_bs and PAT.search(be):
            loose[be].append({"refr": lo.canon(p, fid), "where": cellname.get(ww or cc or "", ww or cc),
                              "pos": pos, "from": p.name})

print("=" * 100)
print("DAEDRIC SITES BEYOND SKYRIM HAS ALREADY BUILT")
print("=" * 100)
if not sites:
    print("  none")
for c, s in sorted(sites.items(), key=lambda kv: kv[1]["editorId"]):
    where = "interior" if s["grid"] is None else "grid %s -> world units ~%s" % (
        s["grid"], [s["grid"][0] * 4096, s["grid"][1] * 4096])
    print("\n  %-34s %s  [%s]" % (s["editorId"], c, s["kind"]))
    print("      %s   %d references placed" % (where, s["refs"]))
    if s["statues"]:
        for st in s["statues"]:
            print("      statue/altar: %-34s %-6s %s  %s" % (st["editorId"], st["type"], st["refr"], st["pos"]))
    else:
        print("      NO shrine statue or altar on it - the site is dressed but has nothing to activate")

print()
print("=" * 100)
print("PRINCE-NAMED OBJECTS PLACED ANYWHERE INSIDE BEYOND SKYRIM")
print("=" * 100)
if not loose:
    print("  none")
for be, rows in sorted(loose.items()):
    print("  %-38s %dx   e.g. %s %s" % (be, len(rows), rows[0]["where"], rows[0]["pos"]))

json.dump({"_comment": "Generated by ck-mcp\\daedricsites.py. Daedric shrine sites Beyond Skyrim has "
                       "built, and every Prince-named object placed inside its worldspaces.",
           "sites": {c: s for c, s in sites.items()},
           "placedObjects": {k: v for k, v in loose.items()}},
          open(OUT, "w", encoding="utf-8", newline="\r\n"), indent=2)
print("\nwrote", OUT)
