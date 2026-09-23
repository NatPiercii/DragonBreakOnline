"""Where a player lands in Cyrodiil when walking in from Skyrim: the XTEL arrival markers of the Skyrim-side
border doors, plus every door in the cells they lead to (to follow a tunnel through to the outside)."""
import sys, json, struct
sys.path.insert(0, r"E:\DragonBreak Online Dev files\ck-mcp")
import core, esplib
lo = core.LoadOrder(r"E:\DragonBreak Online Dev files\Skyrim Special Edition - dev\Data", r"E:\DragonBreak Online Dev files\server\plugins.server.txt")
def edid(p, off, sz, fl): return esplib.edid_of(lo.body(p, off, sz, fl)) or ""
def desc(canon): src, loc = canon.rsplit(":", 1); return "%x:%s" % (int(loc, 16), src)
START = {"BSHeartland.esm:087621", "BSHeartland.esm:0014DF"}
cells, worlds, where, xtel = {}, {}, {}, {}
for p in lo.plugins:
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ("CELL", "WRLD")):
        (cells if t == "CELL" else worlds)[lo.canon(p, fid)] = edid(p, off, sz, fl)
for p in lo.plugins:
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ("REFR",)):
        w, c, g = ctx; key = lo.canon(p, fid); f = lo.ref_fields(p, off, sz, fl)
        where[key] = {"world": lo.canon(p, w) if w else None, "cell": lo.canon(p, c) if c else None, "pos": f["pos"]}
        sub = lo.subrecords(p, off, sz, fl); x = sub.get(b"XTEL", b"")
        if len(x) >= 28:
            v = struct.unpack("<6f", x[4:28]); xtel[key] = {"target": lo.canon(p, struct.unpack("<I", x[:4])[0]), "pos": [round(q, 1) for q in v[:3]], "rotZdeg": round(v[5] * 57.29578, 1)}
def place(ref):
    w = where.get(ref, {})
    return {"world": desc(w["world"]) + " " + worlds.get(w["world"], "") if w.get("world") else None, "cell": desc(w["cell"]) + " " + cells.get(w["cell"], "") if w.get("cell") else None, "pos": w.get("pos")}
for d in sorted(START):
    x = xtel.get(d)
    print("SKYRIM-SIDE DOOR", desc(d), "at", place(d))
    if not x: print("  no XTEL"); continue
    t = x["target"]; tp = where.get(t, {})
    print("  leads to door", desc(t), "in", place(t)); print("  ARRIVAL marker", x["pos"], "rotZ", x["rotZdeg"], "deg")
    if tp.get("world") is None and tp.get("cell"):
        print("  -> destination is an interior; its other doors:")
        for k, w in where.items():
            if w.get("cell") == tp["cell"] and k in xtel and k != t:
                xx = xtel[k]; print("     door", desc(k), "->", desc(xx["target"]), place(xx["target"]), "arrival", xx["pos"], "rotZ", xx["rotZdeg"])
