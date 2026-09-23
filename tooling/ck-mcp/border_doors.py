"""Fast scan for the playtest lock: Beyond Skyrim worldspaces, and every load door that crosses between
Skyrim (Tamriel, its city worldspaces, Skyrim-plugin interiors) and the Beyond Skyrim side."""
import sys, json, struct
sys.path.insert(0, r"E:\DragonBreak Online Dev files\ck-mcp")
import core, esplib
lo = core.LoadOrder(r"E:\DragonBreak Online Dev files\Skyrim Special Edition - dev\Data", r"E:\DragonBreak Online Dev files\server\plugins.server.txt")
BS = {"BSAssets.esm", "BSHeartland.esm"}
def edid(p, off, sz, fl): return esplib.edid_of(lo.body(p, off, sz, fl)) or ""
def desc(canon): src, loc = canon.rsplit(":", 1); return "%x:%s" % (int(loc, 16), src)
worlds, cellw = {}, {}
for p in lo.plugins:
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ("WRLD",)):
        c = lo.canon(p, fid); worlds[c] = edid(p, off, sz, fl)
bs_worlds = {c: e for c, e in worlds.items() if c.split(":")[0] in BS}
print("Beyond Skyrim worldspaces:", {desc(c): e for c, e in bs_worlds.items()})
where, xtel = {}, {}
for p in lo.plugins:
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ("REFR",)):
        w, c, g = ctx; key = lo.canon(p, fid)
        f = lo.ref_fields(p, off, sz, fl)
        where[key] = (lo.canon(p, w) if w else None, lo.canon(p, c) if c else None, f["pos"], fl)
        sub = lo.subrecords(p, off, sz, fl); x = sub.get(b"XTEL", b"")
        if len(x) >= 4: xtel[key] = lo.canon(p, struct.unpack("<I", x[:4])[0])
def side(ref):
    w, c, pos, fl = where.get(ref, (None, None, None, 0))
    if w: return "bs" if w in bs_worlds else "skyrim"
    if c: return "bs" if c.split(":")[0] in BS else "skyrim"
    return None
border = []
for door, target in xtel.items():
    a, b = side(door), side(target)
    if not a or not b or a == b: continue
    w, c, pos, fl = where[door]
    border.append({"door": desc(door), "side": a, "leadsTo": b, "world": worlds.get(w) if w else None, "cell": desc(c) if c else None, "pos": pos, "disabled": bool(fl & 0x800), "deleted": bool(fl & 0x20)})
print("crossing doors:", len(border))
for d in border: print(json.dumps(d))
json.dump({"bsWorlds": {desc(c): e for c, e in bs_worlds.items()}, "border": border}, open(r"E:\DragonBreak Online Dev files\ck-mcp\out\border_doors.json", "w"), indent=1)
