"""What body does each playable race actually wear when nothing is equipped?

Nat reports Khajiit women look naked. A race's bare body is its WNAM skin, an ARMO whose MODL
addons (ARMA) name the real .nif. Nevernude is a property of that mesh, so the question is which
mesh each race lands on and whether that file is present.

usage: py ck-mcp\skins.py
"""
import sys, os, struct
sys.path.insert(0, r"E:\DragonBreak Online Dev files\ck-mcp")
import core, esplib

DATA = r"E:\DragonBreak Online Dev files\Skyrim Special Edition - dev\Data"
PLUGINS = r"E:\DragonBreak Online Dev files\server\plugins.server.txt"

RACES = ["HighElfRace", "ArgonianRace", "WoodElfRace", "BretonRace", "DarkElfRace",
         "ImperialRace", "KhajiitRace", "NordRace", "OrcRace", "RedguardRace"]

lo = core.LoadOrder(DATA, PLUGINS)
names = [l.strip().lstrip("*") for l in open(PLUGINS, encoding="utf-8-sig")
         if l.strip() and not l.startswith("#")]

# winning override of every ARMO and ARMA, plus the races
armo, arma, races = {}, {}, {}
for n in names:
    try:
        p = lo.plugin(n)
    except Exception:
        continue
    for sig, store in (("ARMO", armo), ("ARMA", arma), ("RACE", races)):
        try:
            for ri, t, fid, fl, off, sz, ctx in lo.records(p, (sig,)):
                body = lo.body(p, off, sz, fl)
                store[lo.canon(p, fid)] = (p, body, esplib.edid_of(body) or "")
        except Exception:
            pass

print(f"ARMO {len(armo)}, ARMA {len(arma)}, RACE {len(races)}\n")


def field(body, tag):
    for t, d in esplib.subrecords(body):
        if t == tag:
            return d
    return None


def all_fields(body, tag):
    return [d for t, d in esplib.subrecords(body) if t == tag]


def nif_of(data):
    return data.split(b"\x00")[0].decode("cp1252", "replace")


for name in RACES:
    hit = None
    for gid, (p, body, e) in races.items():
        if e == name:
            hit = (gid, p, body)
    if not hit:
        print(f"{name}: NOT FOUND")
        continue
    gid, p, body = hit

    out = [f"{name:14s}"]
    wnam = field(body, b"WNAM")
    if not wnam or len(wnam) < 4:
        print(" ".join(out) + "  no WNAM skin")
        continue
    skin_id = lo.canon(p, struct.unpack_from("<I", wnam, 0)[0])
    skin = armo.get(skin_id)
    if not skin:
        print(" ".join(out) + f"  skin {skin_id} not an ARMO in the order")
        continue
    sp, sbody, sedid = skin
    out.append(f"skin={sedid}")
    print(" ".join(out))

    # the ARMO's MODL addons are ARMA records naming the meshes
    for d in all_fields(sbody, b"MODL"):
        if len(d) < 4:
            continue
        aid = lo.canon(sp, struct.unpack_from("<I", d, 0)[0])
        ent = arma.get(aid)
        if not ent:
            print(f"                 addon {aid} (not found)")
            continue
        ap, abody, aedid = ent
        meshes = []
        for t, dd in esplib.subrecords(abody):
            if t in (b"MOD2", b"MOD3", b"MOD4", b"MOD5"):
                meshes.append(nif_of(dd))
        for m in meshes:
            full = os.path.join(DATA, "meshes", m.replace("\\", os.sep))
            mark = "present" if os.path.exists(full) else "MISSING (from a BSA or absent)"
            print(f"                 {aedid:34s} {m}  [{mark}]")
    print()
