"""Dump real COBJ/product/SPEL bytes as a fixture for tests\mastery-values-harness.js.

The offsets in masterySystem.PRODUCT_VALUE_AT were measured by `itemvalues.py`, but a measurement in
Python only proves where the number is - not that the shipped TypeScript reads it. This writes the
actual bytes of real records out of the real load order so the harness can run the real reader
against them and compare with the value this script read independently.

usage: py ck-mcp/valuefixtures.py    ->  server/tests/value-fixtures.json
"""
import sys, struct, json, collections
sys.path.insert(0, r"E:\DragonBreak Online Dev files\ck-mcp")
import core, esplib

DATA = r"E:\DragonBreak Online Dev files\Skyrim Special Edition - dev\Data"
PLUGINS = r"E:\DragonBreak Online Dev files\server\plugins.server.txt"
OUT = r"E:\DragonBreak Online Dev files\server\tests\value-fixtures.json"

FIELD = {"WEAP": (b"DATA", 0), "ARMO": (b"DATA", 0), "MISC": (b"DATA", 0), "INGR": (b"DATA", 0),
         "SLGM": (b"DATA", 0), "SCRL": (b"DATA", 0), "KEYM": (b"DATA", 0), "AMMO": (b"DATA", 12),
         "BOOK": (b"DATA", 8), "ALCH": (b"ENIT", 0)}
i32 = lambda b, o: struct.unpack_from("<i", b, o)[0]

lo = core.LoadOrder(DATA, PLUGINS)

def subs_of(p, off, sz, fl):
    body = lo.body(p, off, sz, fl)
    out = collections.OrderedDict()
    for tag, d in esplib.subrecords(body):
        out.setdefault(tag, bytes(d))
    return esplib.edid_of(body) or "", out

# index products
prod = {}
for p in lo.plugins:
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, tuple(FIELD)):
        e, s = subs_of(p, off, sz, fl)
        tag, o = FIELD[t]
        d = s.get(tag)
        if d is None or len(d) < o + 4:
            continue
        prod[lo.canon(p, fid)] = {"edid": e, "type": t, "field": tag.decode(),
                                  "bytes": list(d), "value": i32(d, o)}

# pick recipes covering as many product types as possible, preferring products worth something
want = {t: 2 for t in FIELD}
recipes = []
for p in lo.plugins:
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ("COBJ",)):
        e, s = subs_of(p, off, sz, fl)
        c = s.get(b"CNAM")
        if not c or len(c) < 4:
            continue
        local = struct.unpack_from("<I", c, 0)[0]
        g = lo.canon(p, local)
        hit = prod.get(g)
        if not hit or not want.get(hit["type"]):
            continue
        if hit["value"] <= 0:
            continue
        want[hit["type"]] -= 1
        recipes.append({"recipeEdid": e, "cnamLocal": local, "productCanon": g,
                        "cnamBytes": list(c[:4]), "product": hit})
    if not any(want.values()):
        break

LADDER = ["Healing", "Flames", "Firebolt", "Fireball", "Incinerate", "IcySpear", "Blizzard"]
spells = []
for p in lo.plugins:
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ("SPEL",)):
        e, s = subs_of(p, off, sz, fl)
        if e not in LADDER:
            continue
        d = s.get(b"SPIT")
        if not d or len(d) < 36:
            continue
        if any(x["edid"] == e for x in spells):
            continue
        spells.append({"edid": e, "bytes": list(d), "cost": struct.unpack_from("<I", d, 0)[0]})

out = {"recipes": recipes, "spells": spells,
       "note": "bytes are the raw espm field contents; value/cost were read independently by ck-mcp/valuefixtures.py"}
with open(OUT, "w", encoding="utf-8") as fh:
    json.dump(out, fh, indent=1)
print("recipes:", len(recipes), "covering", sorted({r["product"]["type"] for r in recipes}))
for r in recipes:
    print("   %-34s -> %-26s %-5s value=%d" % (r["recipeEdid"][:34], r["product"]["edid"][:26], r["product"]["type"], r["product"]["value"]))
print("spells:", [(s["edid"], s["cost"]) for s in spells])
print("wrote", OUT)
