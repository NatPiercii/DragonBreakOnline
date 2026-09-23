"""Gives every dungeon placement in server\\dungeons.json a spawn anchor the server can use.
The server only instantiates refs whose base is NPC_, FURN, ACTI, DOOR, CONT, an item, or
FLOR/TREE with produce, and never plugin-placed NPCs, so the anchor is the nearest such ref
in the same cell (PlaceAtMe puts the spawn on the anchor's spot). Writes ref + anchorDist."""
import sys, json, math, collections
sys.path.insert(0, r"E:\DragonBreak Online Dev files\ck-mcp")
import core, esplib
lo = core.LoadOrder(r"E:\DragonBreak Online Dev files\Skyrim Special Edition - dev\Data", r"E:\DragonBreak Online Dev files\server\plugins.server.txt")
P = r"E:\DragonBreak Online Dev files\server\dungeons.json"
data = json.load(open(P))
OK_TYPES = {"FURN", "ACTI", "DOOR", "CONT", "WEAP", "ARMO", "MISC", "INGR", "ALCH", "BOOK", "AMMO", "KEYM", "SLGM", "SCRL", "LIGH"}
def canon_of(desc):
    h, src = desc.split(":", 1); return "%s:%06X" % (src, int(h, 16))
def desc_of(canon):
    src, loc = canon.rsplit(":", 1); return "%x:%s" % (int(loc, 16), src)
cells = {canon_of(c["desc"]) for d in data["dungeons"] for c in d["cells"]}
cands = collections.defaultdict(dict)   # cell canon -> ref canon -> pos
for p in lo.plugins:
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ("REFR",)):
        w, c, g = ctx
        if not c: continue
        cc = lo.canon(p, c)
        if cc not in cells: continue
        key = lo.canon(p, fid)
        if fl & 0x20 or fl & 0x800:
            cands[cc].pop(key, None); continue
        f = lo.ref_fields(p, off, sz, fl)
        if not f["base"] or not f["pos"]: continue
        bi = lo.base_info(f["base"])
        if not bi or bi["type"] not in OK_TYPES: continue
        if bi["type"] in ("FLOR", "TREE"): continue
        cands[cc][key] = f["pos"]
anchored = 0; total = 0; dists = []
for d in data["dungeons"]:
    for z in d["zones"]:
        cc = canon_of(z["cell"])
        pool = list(cands.get(cc, {}).items())
        for n in z["npcs"]:
            total += 1
            best = None
            for key, pos in pool:
                dd = math.dist(pos, n["pos"])
                if best is None or dd < best[1]: best = (key, dd)
            if best:
                n["ref"] = desc_of(best[0]); n["anchorDist"] = round(best[1]); anchored += 1; dists.append(best[1])
            else:
                n.pop("ref", None); n["anchorDist"] = None
json.dump(data, open(P, "w"), indent=0)
dists.sort()
print("placements", total, "anchored", anchored, "median dist", round(dists[len(dists)//2]) if dists else None, "90th", round(dists[int(len(dists)*0.9)]) if dists else None, "max", round(dists[-1]) if dists else None)
