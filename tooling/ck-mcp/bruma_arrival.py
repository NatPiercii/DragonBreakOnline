"""Candidate arrival spots for the Bruma playtest: every load door whose destination cell belongs to a
Bruma location (edid contains Bruma), with the door's own position and its XTEL arrival marker."""
import sys, json, struct
sys.path.insert(0, r"E:\DragonBreak Online Dev files\ck-mcp")
import core, esplib
lo = core.LoadOrder(r"E:\DragonBreak Online Dev files\Skyrim Special Edition - dev\Data", r"E:\DragonBreak Online Dev files\server\plugins.server.txt")
def edid(p, off, sz, fl): return esplib.edid_of(lo.body(p, off, sz, fl)) or ""
def desc(canon): src, loc = canon.rsplit(":", 1); return "%x:%s" % (int(loc, 16), src)
cells, locs, worlds = {}, {}, {}
for p in lo.plugins:
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ("CELL", "LCTN", "WRLD")):
        c = lo.canon(p, fid); e = edid(p, off, sz, fl)
        if t == "CELL":
            sub = lo.subrecords(p, off, sz, fl); x = sub.get(b"XLCN", b""); prev = cells.get(c, {})
            cells[c] = {"edid": e or prev.get("edid", ""), "loc": lo.canon(p, struct.unpack("<I", x[:4])[0]) if len(x) >= 4 else prev.get("loc")}
        elif t == "LCTN": locs[c] = e
        else: worlds[c] = e
where, xtel = {}, {}
for p in lo.plugins:
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ("REFR",)):
        w, c, g = ctx; key = lo.canon(p, fid)
        f = lo.ref_fields(p, off, sz, fl)
        where[key] = {"world": lo.canon(p, w) if w else None, "cell": lo.canon(p, c) if c else None, "pos": f["pos"], "flags": fl}
        sub = lo.subrecords(p, off, sz, fl); x = sub.get(b"XTEL", b"")
        if len(x) >= 28:
            v = struct.unpack("<6f", x[4:28]); xtel[key] = (lo.canon(p, struct.unpack("<I", x[:4])[0]), [round(q, 1) for q in v[:3]], round(v[5], 4))
out = []
for door, (target, apos, arot) in xtel.items():
    t = where.get(target); d = where.get(door)
    if not t or not d or d["flags"] & 0x820: continue
    tloc = locs.get(cells.get(t["cell"], {}).get("loc"), "")
    dloc = locs.get(cells.get(d["cell"], {}).get("loc"), "")
    if "bruma" not in (tloc + dloc).lower(): continue
    out.append({"door": desc(door), "doorWorld": worlds.get(d["world"]) or ("interior " + cells.get(d["cell"], {}).get("edid", "")), "doorLoc": dloc,
                "arriveWorld": desc(t["world"]) if t["world"] else desc(t["cell"]), "arriveWorldEdid": worlds.get(t["world"]) or ("interior " + cells.get(t["cell"], {}).get("edid", "")),
                "arriveLoc": tloc, "arrivePos": apos, "arriveRotZ": arot})
exteriors = [o for o in out if not o["arriveWorldEdid"].startswith("interior")]
print("doors touching Bruma:", len(out), "arriving outdoors:", len(exteriors))
for o in exteriors[:40]: print(json.dumps(o))
json.dump(out, open(r"E:\DragonBreak Online Dev files\ck-mcp\out\bruma_arrival.json", "w"), indent=1)
