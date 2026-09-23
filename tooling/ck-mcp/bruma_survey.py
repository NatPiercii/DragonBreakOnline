"""Surveys Beyond Skyrim Bruma in the load order for the playtest: worldspaces, locations,
border doors between Skyrim and Cyrodiil, dungeons, creature placements, containers, crafting."""
import sys, json, struct, collections, re
sys.path.insert(0, r"E:\DragonBreak Online Dev files\ck-mcp")
import core, esplib
lo = core.LoadOrder(r"E:\DragonBreak Online Dev files\Skyrim Special Edition - dev\Data", r"E:\DragonBreak Online Dev files\server\plugins.server.txt")
def edid(p, off, sz, fl): return esplib.edid_of(lo.body(p, off, sz, fl)) or ""
BS = {"BSAssets.esm", "BSHeartland.esm"}
worlds, cells, locs, kywd = {}, {}, {}, {}
for p in lo.plugins:
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ("WRLD", "CELL", "LCTN", "KYWD")):
        c = lo.canon(p, fid); e = edid(p, off, sz, fl); sub = lo.subrecords(p, off, sz, fl)
        if t == "KYWD": kywd[c] = e
        elif t == "WRLD":
            wn = sub.get(b"WNAM", b""); worlds[c] = {"edid": e, "parent": lo.canon(p, struct.unpack("<I", wn[:4])[0]) if len(wn) >= 4 else None, "from": p.name}
        elif t == "CELL":
            x = sub.get(b"XLCN", b""); w, cc, g = ctx
            prev = cells.get(c, {})
            cells[c] = {"edid": e or prev.get("edid", ""), "loc": lo.canon(p, struct.unpack("<I", x[:4])[0]) if len(x) >= 4 else prev.get("loc"), "world": lo.canon(p, w) if w else prev.get("world"), "interior": len(sub.get(b"XCLC", b"")) < 8 and not w}
        else:
            kw = sub.get(b"KWDA", b""); pn = sub.get(b"PNAM", b"")
            locs[c] = {"edid": e, "kw": [lo.canon(p, struct.unpack_from("<I", kw, i)[0]) for i in range(0, len(kw) - 3, 4)], "parent": lo.canon(p, struct.unpack("<I", pn[:4])[0]) if len(pn) >= 4 else None, "from": p.name}
for L in locs.values(): L["kw"] = [kywd.get(k, "?") for k in L["kw"]]
bs_worlds = {c: w for c, w in worlds.items() if c.split(":")[0] in BS}
print("BS worldspaces:", {c: (w["edid"], worlds.get(w["parent"], {}).get("edid")) for c, w in bs_worlds.items()})
bs_locs = {c: L for c, L in locs.items() if c.split(":")[0] in BS}
print("BS locations:", len(bs_locs)); print("  sample:", sorted(L["edid"] for L in bs_locs.values())[:60])
print("  dungeons (LocTypeDungeon):", sorted(L["edid"] for L in bs_locs.values() if "LocTypeDungeon" in L["kw"]))
print("  keyword sets used:", collections.Counter(k for L in bs_locs.values() for k in L["kw"]).most_common(25))
# refs: doors with XTEL crossing between a BS worldspace/cell and Tamriel; creatures; containers; crafting furniture
ref_where, xtel = {}, {}
counts = collections.Counter(); crafting = collections.Counter()
for p in lo.plugins:
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ("REFR", "ACHR")):
        w, c, g = ctx; key = lo.canon(p, fid)
        ref_where[key] = (lo.canon(p, w) if w else None, lo.canon(p, c) if c else None)
        wc = lo.canon(p, w) if w else None
        cc = lo.canon(p, c) if c else None
        in_bs = (wc in bs_worlds) or (cc and cc.split(":")[0] in BS and cells.get(cc, {}).get("world") is None) or (cc and cells.get(cc, {}).get("loc") in bs_locs)
        sub = lo.subrecords(p, off, sz, fl); x = sub.get(b"XTEL", b"")
        if len(x) >= 4: xtel[key] = lo.canon(p, struct.unpack("<I", x[:4])[0])
        if not in_bs or fl & 0x20: continue
        f = lo.ref_fields(p, off, sz, fl)
        if t == "ACHR": counts["npc placements"] += 1; continue
        bi = lo.base_info(f["base"]) if f["base"] else None
        if not bi: continue
        counts[bi["type"]] += 1
        if bi["type"] == "FURN" and re.search(r"forge|anvil|smelter|tanning|workbench|grindstone|alchemy|enchant|cooking|oven", bi["editor_id"], re.I): crafting[bi["editor_id"]] += 1
print("BS refs by base type:", counts.most_common(15)); print("BS crafting stations:", crafting.most_common(15))
def side(ref):
    w, c = ref_where.get(ref, (None, None))
    if w in bs_worlds: return "BS:" + bs_worlds[w]["edid"]
    if w == "Skyrim.esm:00003C": return "Tamriel"
    if c and cells.get(c, {}).get("loc") in bs_locs: return "BSint:" + cells[c]["edid"]
    return None
border = []
for door, target in xtel.items():
    a, b = side(door), side(target)
    if a and b and (a == "Tamriel") != (b == "Tamriel") and (a.startswith("BS:") or b.startswith("BS:") or a == "Tamriel" or b == "Tamriel"):
        border.append({"door": door, "from": a, "to": b, "cell": cells.get(ref_where[door][1], {}).get("edid"), "pos": None})
print("doors between Tamriel and Cyrodiil:", len(border)); [print("  ", d) for d in border[:20]]
json.dump({"worlds": {c: w for c, w in bs_worlds.items()}, "border": border}, open(r"E:\DragonBreak Online Dev files\ck-mcp\out\bruma_survey.json", "w"), indent=1)
