"""Every load door that crosses between the Bruma side (BSHeartland/BSAssets cells and worldspaces) and a
Skyrim-plugin cell or worldspace, in both directions, plus what ref 8000fe7 is. The playtest lock's
blockedDoors must cover every door in the 'to Skyrim' direction. Output: ck-mcp\\out\\border_doors2.json."""
import sys, json, struct
sys.path.insert(0, r"E:\DragonBreak Online Dev files\ck-mcp")
import core, esplib
lo = core.LoadOrder(r"E:\DragonBreak Online Dev files\Skyrim Special Edition - dev\Data", r"E:\DragonBreak Online Dev files\server\plugins.server.txt")
def edid(p, off, sz, fl): return esplib.edid_of(lo.body(p, off, sz, fl)) or ""
def desc(canon): src, loc = canon.rsplit(":", 1); return "%x:%s" % (int(loc, 16), src)
BS = {"BSHeartland.esm", "BSAssets.esm"}
SKYRIM = {"Skyrim.esm", "Update.esm", "Dawnguard.esm", "HearthFires.esm", "Dragonborn.esm"}
cells, worlds = {}, {}
for p in lo.plugins:
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ("CELL", "WRLD")):
        c = lo.canon(p, fid); e = edid(p, off, sz, fl)
        if t == "WRLD": worlds[c] = e
        else:
            prev = cells.get(c, {})
            w = lo.canon(p, ctx[0]) if ctx[0] else prev.get("world")
            cells[c] = {"edid": e or prev.get("edid", ""), "world": w}
where = {}
for p in lo.plugins:
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ("REFR",)):
        w, c, g = ctx; key = lo.canon(p, fid)
        f = lo.ref_fields(p, off, sz, fl)
        sub = lo.subrecords(p, off, sz, fl); x = sub.get(b"XTEL", b"")
        prev = where.get(key, {})
        where[key] = {"world": lo.canon(p, w) if w else prev.get("world"), "cell": lo.canon(p, c) if c else prev.get("cell"),
                      "pos": f["pos"] or prev.get("pos"), "base": f["base"] or prev.get("base"), "flags": fl,
                      "xtel": lo.canon(p, struct.unpack("<I", x[:4])[0]) if len(x) >= 4 else prev.get("xtel")}
def side(ref):
    r = where.get(ref)
    if not r: return None, None
    world = r.get("world"); cell = r.get("cell")
    place = world or cell
    if not place: return None, None
    src = place.split(":")[0]
    name = worlds.get(world) or cells.get(cell, {}).get("edid", "")
    if src in BS: return "bruma", name
    if src in SKYRIM: return "skyrim", name
    return src, name
rows = []
for key, r in where.items():
    if not r.get("xtel") or r["flags"] & 0x820: continue
    a, aname = side(key)
    b, bname = side(r["xtel"])
    if not a or not b or a == b: continue
    if {a, b} != {"bruma", "skyrim"}: continue
    rows.append({"door": desc(key), "from": a, "fromPlace": aname, "to": b, "toPlace": bname,
                 "pos": r.get("pos"), "target": desc(r["xtel"])})
rows.sort(key=lambda r: (r["from"], r["fromPlace"] or ""))
print("crossing doors:", len(rows))
for r in rows: print("  ", json.dumps(r))
probe = next((k for k in where if k.endswith(":000FE7") and k.split(":")[0] in BS), None)
print("\n8000fe7 =", probe, json.dumps(where.get(probe, {}), default=str)[:400] if probe else "not found")
json.dump(rows, open(r"E:\DragonBreak Online Dev files\ck-mcp\out\border_doors2.json", "w"), indent=1)
print("written ck-mcp\\out\\border_doors2.json")
