"""Record-level diff of the server's edited third-party plugins against the unedited copies in the MO2 install.

usage: py ck-mcp\thirdparty_diff.py
"""
import sys, glob, collections
sys.path.insert(0, r"E:\DragonBreak Online Dev files\ck-mcp")
import esplib
SRV = r"E:\DragonBreak Online Dev files\server\data"
NAMES = ["Armors of the Velothi.esp","Armors of the Velothi Pt2.esp","Hothtrooper44_ArmorCompilation.esp",
         "Immersive Weapons.esp","TGCotN Winterhold.esp","notice board.esp"]
def recs(path):
    p = esplib.Plugin(path); out = {}
    with open(path,'rb') as fh:
        for sig,fid,flags,off,size,ctx in p.index:
            out[(sig,fid)] = (flags, p.data_at(fh,off,size,flags))
    return p, out
for n in NAMES:
    mo2 = glob.glob(r"C:\DragonBreak\mods\*\\" + n)[0]
    a, ra = recs(SRV + "\\" + n); b, rb = recs(mo2)
    print(f"== {n}  hflags server={a.hflags:#x} nexus={b.hflags:#x}  masters same={a.masters==b.masters}")
    by = collections.Counter(); ex = []
    for k in sorted(set(ra)|set(rb)):
        if ra.get(k) == rb.get(k): continue
        fa, da = ra.get(k, (None,b'')); fb, db = rb.get(k, (None,b''))
        sa = dict(); sb = dict()
        for s,v in esplib.subrecords(da): sa.setdefault(s,[]).append(v)
        for s,v in esplib.subrecords(db): sb.setdefault(s,[]).append(v)
        subs = sorted({s.decode() for s in set(sa)|set(sb) if sa.get(s)!=sb.get(s)})
        if fa != fb: subs.append(f"flags {fb:#x}->{fa:#x}" if fa is not None and fb is not None else "added/removed")
        by[k[0]] += 1
        if len(ex) < 6: ex.append(f"   {k[0]} {k[1]:08X} {esplib.edid_of(da or db)}: {', '.join(subs)}")
    print("  changed records by type:", dict(by)); print("\n".join(ex))
