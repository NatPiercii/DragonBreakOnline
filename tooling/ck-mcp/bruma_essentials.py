"""Bruma essentials audit for the playtest: every enabled ref in Bruma city, its surroundings and the
Bruma interiors, grouped for the four open items: notice board candidates, bank/treasury candidates,
crafting stations (with keywords, matched against skills.json station gates) and Harvesting nodes
(flora, trees, coin purses, ore veins, chopping blocks). Output: ck-mcp\\out\\bruma_essentials.json."""
import sys, json, struct, collections, re, math
sys.path.insert(0, r"E:\DragonBreak Online Dev files\ck-mcp")
import core, esplib
lo = core.LoadOrder(r"E:\DragonBreak Online Dev files\Skyrim Special Edition - dev\Data", r"E:\DragonBreak Online Dev files\server\plugins.server.txt")
def edid(p, off, sz, fl): return esplib.edid_of(lo.body(p, off, sz, fl)) or ""
def desc(canon): src, loc = canon.rsplit(":", 1); return "%x:%s" % (int(loc, 16), src)
def ids(p, raw): return [lo.canon(p, struct.unpack_from("<I", raw, i)[0]) for i in range(0, len(raw) - 3, 4)]
HEARTLAND = "BSHeartland.esm:0A764B"
CITY = (53000, 62500, 198000, 207400)          # x0, x1, y0, y1 from the playtest notes
CX, CY = (CITY[0] + CITY[1]) / 2, (CITY[2] + CITY[3]) / 2
AROUND = 20000                                  # units from the city centre counted as "around Bruma"
TYPES = ("ACTI", "FURN", "CONT", "FLOR", "TREE", "MISC", "STAT", "KYWD", "LCTN", "CELL")
skills = json.load(open(r"E:\DragonBreak Online Dev files\server\skills.json", encoding="utf-8"))
gates = {}
for s in skills.get("skills", []):
    for g in (s.get("gates") or {}).get("stations", []) or []: gates.setdefault(g.lower(), []).append(s["id"])

kywd, base, locs, cells = {}, {}, {}, {}
for p in lo.plugins:
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, TYPES):
        c = lo.canon(p, fid); e = edid(p, off, sz, fl)
        if t == "KYWD": kywd[c] = e; continue
        sub = lo.subrecords(p, off, sz, fl)
        if t == "LCTN":
            pn = sub.get(b"PNAM", b""); locs[c] = {"edid": e, "parent": lo.canon(p, struct.unpack("<I", pn[:4])[0]) if len(pn) >= 4 else None}
        elif t == "CELL":
            x = sub.get(b"XLCN", b""); prev = cells.get(c, {})
            cells[c] = {"edid": e or prev.get("edid", ""), "loc": lo.canon(p, struct.unpack("<I", x[:4])[0]) if len(x) >= 4 else prev.get("loc")}
        else:
            pf = sub.get(b"PFIG", b"")
            base[c] = {"type": t, "edid": e, "kw": ids(p, sub.get(b"KWDA", b"")), "yield": lo.canon(p, struct.unpack("<I", pf[:4])[0]) if len(pf) >= 4 else None, "model": sub.get(b"MODL", b"").rstrip(b"\0").decode("cp1252", "replace")}
print("bases", len(base), "locations", len(locs), "cells", len(cells), flush=True)

def bruma_loc(loc, depth=0):
    while loc and depth < 12:
        L = locs.get(loc)
        if not L: return None
        if "bruma" in L["edid"].lower(): return L["edid"]
        loc = L["parent"]; depth += 1
    return None

refs = {}
for p in lo.plugins:
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ("REFR",)):
        w, c, g = ctx; key = lo.canon(p, fid)
        wc = lo.canon(p, w) if w else None; cc = lo.canon(p, c) if c else None
        f = lo.ref_fields(p, off, sz, fl)
        prev = refs.get(key)
        if prev is not None and wc is None and cc is None: wc, cc = prev["world"], prev["cell"]
        refs[key] = {"world": wc, "cell": cc, "base": f["base"], "pos": f["pos"], "fl": fl, "last": p.name}
print("refs", len(refs), flush=True)

rows = []
for key, r in refs.items():
    if r["fl"] & 0x820 or not r["base"] or not r["pos"]: continue
    b = base.get(r["base"])
    if not b: continue
    if r["world"] == HEARTLAND:
        x, y = r["pos"][0], r["pos"][1]
        if CITY[0] <= x <= CITY[1] and CITY[2] <= y <= CITY[3]: area = "city"
        elif math.hypot(x - CX, y - CY) <= AROUND: area = "around"
        else: area = "heartland"
        cell = ""
    elif r["world"] is None and r["cell"]:
        cinfo = cells.get(r["cell"], {}); bl = bruma_loc(cinfo.get("loc"))
        if not bl and "bruma" not in cinfo.get("edid", "").lower(): continue
        area = "interior"; cell = cinfo.get("edid", "")
    else: continue
    rows.append({"ref": desc(key), "area": area, "cell": cell, "type": b["type"], "base": desc(r["base"]), "edid": b["edid"],
                 "kw": [kywd.get(k, "?") for k in b["kw"]], "yield": b["yield"], "pos": r["pos"], "last": r["last"]})
print("rows", len(rows), flush=True)

def gate_of(row):
    hit = set()
    for k in row["kw"] + [row["edid"]]:
        kl = k.lower()
        for g, sk in gates.items():
            if kl == g or kl.startswith(g): hit.update(sk)
    return sorted(hit)
out = {"boards": [], "bankCandidates": [], "crafting": [], "harvest": collections.Counter(), "harvestNoYield": collections.Counter(), "ore": [], "purses": [], "chopping": []}
craft_re = re.compile(r"forge|anvil|smelt|tanning|workbench|grindstone|sharpen|alchemy|enchant|cooking|oven|spit|loom|tailor|chopping|lumber|kiln", re.I)
for row in rows:
    e, t = row["edid"], row["type"]
    if re.search(r"notice|bounty|board|posting|mannyup", e, re.I) and t != "STAT" or (t == "STAT" and re.search(r"notice|bounty", e, re.I)):
        out["boards"].append(row)
    if t == "CONT" and (re.search(r"castle|count|treasur|strong|vault|coffer|safe|bank", row["cell"] + " " + e, re.I)):
        out["bankCandidates"].append(row)
    if t in ("FURN", "ACTI") and (craft_re.search(e) or any(k.lower().startswith(("isblacksmith", "issmelter", "isalchemy", "isenchanting", "istanning", "iscooking", "issmallcookingpot", "crafting")) for k in row["kw"])):
        row["gatedBy"] = gate_of(row); out["crafting"].append(row)
    if t in ("FLOR", "TREE"):
        k = (row["area"], t, e)
        (out["harvest"] if row["yield"] else out["harvestNoYield"])[k] += 1
    if re.search(r"^(coinpurse|goldpouch)", e, re.I): out["purses"].append(row)
    if re.search(r"mineore|pickaxemining|orevein", e, re.I): row["gatedBy"] = gate_of(row); out["ore"].append(row)
    if re.search(r"woodchopping|lumbermill|charcoalkiln", e, re.I): row["gatedBy"] = gate_of(row); out["chopping"].append(row)

by_area = collections.Counter((r["area"], r["type"]) for r in rows)
print("\nrefs by area/type:", sorted(by_area.items()))
print("\nBOARD candidates:", len(out["boards"])); [print("  ", r["area"], r["cell"], r["type"], r["edid"], r["ref"], r["pos"]) for r in out["boards"][:40]]
print("\nBANK candidates:", len(out["bankCandidates"])); [print("  ", r["area"], r["cell"], r["edid"], r["ref"]) for r in out["bankCandidates"][:60]]
cs = collections.Counter((r["area"], r["edid"], tuple(r["gatedBy"]), tuple(k for k in r["kw"] if not k.startswith("Furniture"))) for r in out["crafting"])
print("\nCRAFTING stations:", len(out["crafting"])); [print("  ", n, a) for a, n in sorted(cs.items())]
print("\nHARVEST nodes with a yield:"); [print("  ", n, k) for k, n in sorted(out["harvest"].items())]
print("\nFLOR/TREE without a yield:", sum(out["harvestNoYield"].values()), "(first 15)"); [print("  ", n, k) for k, n in out["harvestNoYield"].most_common(15)]
print("\nCOIN PURSES:", collections.Counter((r["area"], r["edid"]) for r in out["purses"]))
print("\nORE veins:", collections.Counter((r["area"], r["edid"], tuple(r["gatedBy"])) for r in out["ore"]))
print("\nCHOPPING/LUMBER:", collections.Counter((r["area"], r["edid"], tuple(r["gatedBy"])) for r in out["chopping"]))
json.dump({"rows": rows, "boards": out["boards"], "bankCandidates": out["bankCandidates"], "crafting": out["crafting"], "ore": out["ore"], "purses": out["purses"], "chopping": out["chopping"],
           "harvest": [[list(k), n] for k, n in out["harvest"].items()], "harvestNoYield": [[list(k), n] for k, n in out["harvestNoYield"].items()]},
          open(r"E:\DragonBreak Online Dev files\ck-mcp\out\bruma_essentials.json", "w"), indent=1)
print("\nwritten ck-mcp\\out\\bruma_essentials.json")
