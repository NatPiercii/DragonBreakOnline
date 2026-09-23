"""Exterior spots outside each hold's temple: for every temple interior cell used by the respawn table,
find the load door inside it and print its XTEL arrival marker (the spot on the street outside the door),
plus the same for the Bruma cathedral. Output: ck-mcp\\out\\temple_doors.json."""
import sys, json, struct
sys.path.insert(0, r"E:\DragonBreak Online Dev files\ck-mcp")
import core, esplib
lo = core.LoadOrder(r"E:\DragonBreak Online Dev files\Skyrim Special Edition - dev\Data", r"E:\DragonBreak Online Dev files\server\plugins.server.txt")
def edid(p, off, sz, fl): return esplib.edid_of(lo.body(p, off, sz, fl)) or ""
def desc(canon): src, loc = canon.rsplit(":", 1); return "%x:%s" % (int(loc, 16), src)
# Temple interiors the gamemode respawns into today (server\gamemode.js TEMPLE_DEFAULTS)
TEMPLES = {
    "solitude": "Skyrim.esm:016A02", "markarth": "Skyrim.esm:016DF3", "falkreath": "Skyrim.esm:013A71",
    "whiterun": "Skyrim.esm:0165A7", "windhelm": "Skyrim.esm:016785", "riften": "Skyrim.esm:016BD7",
    "bruma": "BSHeartland.esm:06EAA5",
}
want = {v: k for k, v in TEMPLES.items()}
cells, worlds = {}, {}
for p in lo.plugins:
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ("CELL", "WRLD")):
        c = lo.canon(p, fid); e = edid(p, off, sz, fl)
        if t == "WRLD": worlds[c] = e
        else:
            prev = cells.get(c, {})
            cells[c] = {"edid": e or prev.get("edid", "")}
where, out = {}, {}
for p in lo.plugins:
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ("REFR",)):
        w, c, g = ctx; key = lo.canon(p, fid)
        f = lo.ref_fields(p, off, sz, fl)
        sub = lo.subrecords(p, off, sz, fl); x = sub.get(b"XTEL", b"")
        prev = where.get(key, {})
        where[key] = {"world": lo.canon(p, w) if w else prev.get("world"), "cell": lo.canon(p, c) if c else prev.get("cell"),
                      "pos": f["pos"] or prev.get("pos"), "flags": fl,
                      "xtel": (lo.canon(p, struct.unpack("<I", x[:4])[0]), [round(q, 2) for q in struct.unpack("<6f", x[4:28])]) if len(x) >= 28 else prev.get("xtel")}
for key, r in where.items():
    if r["cell"] not in want or not r.get("xtel") or r["flags"] & 0x820: continue
    target = where.get(r["xtel"][0])
    if not target: continue
    zone = want[r["cell"]]
    world = target.get("world")
    v = r["xtel"][1]
    row = {"zone": zone, "templeCell": desc(r["cell"]), "doorInside": desc(key),
           "outsideWorld": desc(world) if world else (desc(target["cell"]) if target.get("cell") else None),
           "outsideWorldEdid": worlds.get(world) or cells.get(target.get("cell"), {}).get("edid"),
           "pos": [v[0], v[1], v[2]], "rotZdeg": round(v[5] * 57.2957795, 1)}
    out.setdefault(zone, []).append(row)
for zone, rows in sorted(out.items()):
    print(zone)
    for r in rows: print("   ", json.dumps(r))
json.dump(out, open(r"E:\DragonBreak Online Dev files\ck-mcp\out\temple_doors.json", "w"), indent=1)
print("written ck-mcp\\out\\temple_doors.json")
