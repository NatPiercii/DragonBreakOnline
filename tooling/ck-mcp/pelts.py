"""Every hide, pelt and skin in the load order, with its gold value.

gamemode.js decides what can be skinned with a regex over MISC editor ids, then hands whatever the
corpse carried straight over. To band creatures by difficulty we need to know what those items
actually are and what they are worth, because value is the honest rarity signal: a deer hide and a
dragon scale are both "skinnable" to the current code.

MISC keeps its gold value at DATA offset 0 (measured over the whole load order by itemvalues.py).

usage: py ck-mcp\pelts.py
"""
import sys, os, struct, json
sys.path.insert(0, r"E:\DragonBreak Online Dev files\ck-mcp")
import core, esplib

DATA = r"E:\DragonBreak Online Dev files\Skyrim Special Edition - dev\Data"
PLUGINS = r"E:\DragonBreak Online Dev files\server\plugins.server.txt"

# the same test gamemode.js applies
import re
PELT = re.compile(r"pelt|hide|skin$|fur$|pelts$", re.I)

lo = core.LoadOrder(DATA, PLUGINS)
names = [l.strip().lstrip("*") for l in open(PLUGINS, encoding="utf-8-sig")
         if l.strip() and not l.startswith("#")]

found = {}
for n in names:
    try:
        p = lo.plugin(n)
    except Exception:
        continue
    try:
        for ri, t, fid, fl, off, sz, ctx in lo.records(p, ("MISC",)):
            b = lo.body(p, off, sz, fl)
            e = esplib.edid_of(b) or ""
            if not PELT.search(e):
                continue
            val = 0
            for tg, d in esplib.subrecords(b):
                if tg == b"DATA" and len(d) >= 4:
                    val = struct.unpack_from("<I", d, 0)[0]
            found[lo.canon(p, fid)] = (e, val, n)
    except Exception:
        pass

rows = sorted(found.items(), key=lambda kv: kv[1][1])
print(f"{len(rows)} skinnable MISC records\n")
print(f"{'value':>7}  {'editor id':40s} source")
for gid, (e, val, n) in rows:
    print(f"{val:>7}  {e:40s} {n}")

print("\n--- suggested bands by value ---")
bands = [(0, 10, "common"), (10, 50, "uncommon"), (50, 150, "rare"),
         (150, 500, "very rare"), (500, 10 ** 9, "legendary")]
for lo_v, hi_v, label in bands:
    hits = [e for gid, (e, val, n) in rows if lo_v <= val < hi_v]
    print(f"  {label:10s} {lo_v}-{hi_v if hi_v < 10**9 else '+'}: {len(hits)}")
    for h in hits[:14]:
        print(f"      {h}")

out = {f"{gid}": {"edid": e, "value": v} for gid, (e, v, n) in rows}
dest = r"E:\DragonBreak Online Dev files\server\pelt-values.json"
open(dest, "w", encoding="utf-8").write(json.dumps(out, indent=1))
print("\nwrote", dest)
