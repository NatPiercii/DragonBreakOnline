"""Overlay a child plugin onto DragonBreak Online Edits.esp (DLE): the child's records win.

    py ck-mcp\\merge_into_dle.py <child.esp> <out.esp> [--dle <DLE.esp>]

Why a script and not xEdit: an xEdit save re-serialises every record and has changed 93 unrelated records before
(memory: xedit-resave-mutates-unrelated-records). This works on the raw bytes, touches only the child's records,
and proves it afterwards.

Form ids are remapped by plugin NAME, because the child's master list is rarely in DLE's order. Only fields known
to be form ids for the record types handled are remapped (QNAM, MODL and friends mean different things per record
type; memory: merging-into-dle-needs-sseedit); an unknown record type or an unexpected subrecord stops the merge
instead of guessing. New records get DLE-owned ids from DLE's HEDR counter. Records that moved cell leave no
stale copy behind. Every child record is then checked against its merged copy, and every DLE record the child
does not touch must come out byte-identical.
"""
import sys, struct, zlib, argparse, collections
sys.path.insert(0, r"E:\DragonBreak Online Dev files\ck-mcp")
import tree

DLE_DEFAULT = r"E:\DragonBreak Online Dev files\Skyrim Special Edition - dev\Data\DragonBreak Online Edits.esp"
DLE_NAME = "dragonbreak online edits.esp"

# subrecord -> offsets of form ids inside it; 'all' = an array of form ids
FID = {
    'CELL': {'LTMP': [0], 'XLCN': [0], 'XCMO': [0], 'XCIM': [0], 'XOWN': [0], 'XCAS': [0], 'XILL': [0], 'XEZN': [0], 'XCWT': [0], 'XCCM': [0], 'XCLR': 'all'},
    'REFR': {'NAME': [0], 'XLRL': [0], 'XOWN': [0], 'XLIB': [0], 'XLCN': [0], 'XEZN': [0], 'XESP': [0], 'XTEL': [0], 'XEMI': [0], 'XMBR': [0], 'XLRT': 'all', 'XLKR': [0, 4], 'XAPR': [0], 'XNDP': [0], 'XLTW': [0], 'XPOD': [0, 4], 'XLRM': [0]},
    'ACHR': {'NAME': [0], 'XLRL': [0], 'XOWN': [0], 'XLCN': [0], 'XEZN': [0], 'XESP': [0], 'XLKR': [0, 4], 'XAPR': [0], 'XLRT': 'all', 'XEMI': [0], 'XMBR': [0]},
    'WRLD': {'XLCN': [0], 'CNAM': [0], 'NAM2': [0], 'NAM3': [0], 'WNAM': [0], 'ZNAM': [0], 'XWEM': [0], 'INAM': [0]},
    'LAND': {'BTXT': [0], 'ATXT': [0], 'VTEX': 'all'},
    'PACK': {'PKCU': [4], 'INAM': [0]},
}
# data-only subrecords per type, checked so a subrecord this script has never seen stops it
DATA_ONLY = {
    'CELL': {'EDID', 'FULL', 'DATA', 'XCLL', 'XCLW', 'XCLC', 'MHDT', 'TVDT', 'XNAM', 'XRNK', 'XWCN', 'XWCS', 'XWCU', 'XCGD'},
    'REFR': {'EDID', 'DATA', 'XSCL', 'XRDS', 'XLIG', 'XMBO', 'XPRM', 'XRNK', 'XCNT', 'XHTW', 'XFVC', 'XLOD', 'XACT', 'XTRI', 'XIS2', 'XCVL', 'XCVR', 'XCZA', 'XWCN', 'XWCS', 'XWCU', 'XALP', 'XRMR', 'LNAM', 'INAM', 'FNAM', 'FULL', 'TNAM', 'XMRK'},
    'ACHR': {'EDID', 'DATA', 'XSCL', 'XRNK', 'XHTW', 'XLOD', 'XIS2'},
    'WRLD': {'EDID', 'FULL', 'NAM4', 'DNAM', 'MODL', 'MODT', 'MNAM', 'ONAM', 'NAMA', 'DATA', 'NAM0', 'NAM9', 'TNAM', 'UNAM', 'RNAM', 'OFST', 'XXXX'},
    'LAND': {'DATA', 'VNML', 'VHGT', 'VCLR', 'VTXT'},
    'PACK': {'EDID', 'PKDT', 'PSDT', 'ANAM', 'CNAM', 'UNAM', 'XNAM', 'POBA', 'POEA', 'POCA', 'PTDA', 'PLDT', 'CTDA', 'PDTO', 'PKC2', 'PNAM', 'BNAM', 'TPIC', 'PFO2', 'PFOR', 'CIS1', 'CIS2', 'VMAD'},
}
FID_GROUP_TYPES = {1, 6, 7, 8, 9, 10}      # group labels that are form ids
PLDT_FID_TYPES = {0, 1, 4}                 # near reference, in cell, object id
PTDA_FID_TYPES = {0, 1}                    # specific reference, object id
CTDA_PARAM1_FID = {58}                     # GetStage(quest); extend only after checking the function's params


def masters_of(head):
    out, pos, end = [], 24, 24 + struct.unpack_from('<I', head, 4)[0]
    while pos < end:
        sig = bytes(head[pos:pos + 4]); sz = struct.unpack_from('<H', head, pos + 4)[0]
        if sig == b'MAST': out.append(bytes(head[pos + 6:pos + 6 + sz]).rstrip(b'\0').decode('cp1252'))
        pos += 6 + sz
    return out


def subrecords(body):
    q, out = 0, []
    while q + 6 <= len(body):
        s = bytes(body[q:q + 4]).decode('ascii', 'replace'); z = struct.unpack_from('<H', body, q + 4)[0]
        if s == 'XXXX':
            raise SystemExit('XXXX (oversized subrecord) not handled')
        out.append((s, q + 6, z)); q += 6 + z
    return out


def body_of(rec):
    fl = struct.unpack_from('<I', rec[1], 8)[0]
    b = bytes(rec[2])
    return (bytearray(zlib.decompress(b[4:])), True) if fl & 0x40000 else (bytearray(b), False)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('child'); ap.add_argument('out'); ap.add_argument('--dle', default=DLE_DEFAULT)
    a = ap.parse_args()

    dbuf = open(a.dle, 'rb').read(); cbuf = open(a.child, 'rb').read()
    dhead, dnodes = tree.parse(dbuf); chead, cnodes = tree.parse(cbuf)
    dm, cm = masters_of(dhead), masters_of(chead)
    dlow = [m.lower() for m in dm]
    self_d = len(dm)
    # child index -> DLE index, by name
    imap = {}
    for i, name in enumerate(cm):
        if name.lower() == DLE_NAME: imap[i] = self_d
        elif name.lower() in dlow: imap[i] = dlow.index(name.lower())
        else: raise SystemExit(f'child master {name} is not a DLE master: add it to DLE with SSEEdit Add Masters first')
    self_c = len(cm)

    # new ids from DLE's HEDR counter, skipping any DLE already uses
    hpos = dhead.find(b'HEDR')
    _, nrec, nextid = struct.unpack_from('<fII', dhead, hpos + 6)
    used = {struct.unpack_from('<I', r[1], 12)[0] & 0xFFFFFF for r in tree.walk_records(dnodes) if struct.unpack_from('<I', r[1], 12)[0] >> 24 == self_d}
    newmap = {}
    for r in tree.walk_records(cnodes):
        fid = struct.unpack_from('<I', r[1], 12)[0]
        if fid >> 24 >= self_c and fid not in newmap:
            while nextid in used: nextid += 1
            newmap[fid] = (self_d << 24) | nextid; used.add(nextid); nextid += 1

    remapped = collections.Counter()

    def remap(v):
        if v == 0: return 0
        idx = v >> 24
        if idx >= self_c:
            if v not in newmap: raise SystemExit('reference to a child record that does not exist: %08x' % v)
            return newmap[v]
        if idx not in imap: raise SystemExit('form id %08x has an index beyond the child masters' % v)
        return (imap[idx] << 24) | (v & 0xFFFFFF)

    def fix_record(rec):
        sig = bytes(rec[1][:4]).decode()
        if sig not in FID: raise SystemExit(f'record type {sig} is not handled; add its form id fields first')
        struct.pack_into('<I', rec[1], 12, remap(struct.unpack_from('<I', rec[1], 12)[0]))
        body, comp = body_of(rec)
        for s, off, z in subrecords(body):
            spec = FID[sig].get(s)
            if spec == 'all':
                for k in range(0, z - z % 4, 4):
                    struct.pack_into('<I', body, off + k, remap(struct.unpack_from('<I', body, off + k)[0])); remapped[(sig, s)] += 1
            elif spec:
                for k in spec:
                    if k + 4 <= z: struct.pack_into('<I', body, off + k, remap(struct.unpack_from('<I', body, off + k)[0])); remapped[(sig, s)] += 1
            elif sig == 'PACK' and s == 'PLDT':
                if struct.unpack_from('<I', body, off)[0] in PLDT_FID_TYPES:
                    struct.pack_into('<I', body, off + 4, remap(struct.unpack_from('<I', body, off + 4)[0])); remapped[(sig, s)] += 1
            elif sig == 'PACK' and s == 'PTDA':
                if struct.unpack_from('<I', body, off)[0] in PTDA_FID_TYPES:
                    struct.pack_into('<I', body, off + 4, remap(struct.unpack_from('<I', body, off + 4)[0])); remapped[(sig, s)] += 1
            elif sig == 'PACK' and s == 'CTDA':
                fn = struct.unpack_from('<H', body, off + 8)[0]
                if fn in CTDA_PARAM1_FID:
                    struct.pack_into('<I', body, off + 12, remap(struct.unpack_from('<I', body, off + 12)[0])); remapped[(sig, 'CTDA.param1')] += 1
                elif struct.unpack_from('<I', body, off + 12)[0] >> 24 not in (0,) and struct.unpack_from('<I', body, off + 12)[0] != 0:
                    raise SystemExit('CTDA function %d has a non-zero param1 this script does not know' % fn)
                if struct.unpack_from('<I', body, off + 20)[0] == 2:   # run on: reference
                    struct.pack_into('<I', body, off + 24, remap(struct.unpack_from('<I', body, off + 24)[0])); remapped[(sig, 'CTDA.ref')] += 1
            elif sig == 'PACK' and s == 'PDTO':
                if struct.unpack_from('<I', body, off)[0] == 0:
                    struct.pack_into('<I', body, off + 4, remap(struct.unpack_from('<I', body, off + 4)[0])); remapped[(sig, s)] += 1
            elif s not in DATA_ONLY.get(sig, ()):
                raise SystemExit(f'{sig} subrecord {s} is not classified; check whether it holds form ids')
        if comp:
            packed = zlib.compress(bytes(body))
            rec[2] = bytearray(struct.pack('<I', len(body)) + packed)
        else:
            rec[2] = body

    def fix_groups(nodes):
        for n in nodes:
            if n[0] == 'G':
                gtype = struct.unpack_from('<I', n[1], 12)[0]
                if gtype in FID_GROUP_TYPES:
                    struct.pack_into('<I', n[1], 8, remap(struct.unpack_from('<I', n[1], 8)[0]))
                fix_groups(n[2])
            else:
                fix_record(n)

    import copy
    original_child = copy.deepcopy(cnodes)
    fix_groups(cnodes)

    # ---- overlay: child wins; a record that moved leaves no stale copy -----------------------------------------
    key = lambda n: ('R', struct.unpack_from('<I', n[1], 12)[0]) if n[0] == 'R' else ('G', struct.unpack_from('<I', n[1], 12)[0], bytes(n[1][8:12]))
    child_fids = {struct.unpack_from('<I', r[1], 12)[0] for r in tree.walk_records(cnodes)}
    stale = []

    def merge(dlist, clist, top=False):
        for cn in clist:
            k = key(cn)
            hit = next((i for i, dn in enumerate(dlist) if key(dn) == k), None)
            if cn[0] == 'R':
                if hit is not None: dlist[hit] = cn
                else: dlist.append(cn)
            else:
                if hit is not None:
                    merge(dlist[hit][2], cn[2])
                else:
                    gtype = struct.unpack_from('<I', cn[1], 12)[0]
                    label = struct.unpack_from('<I', cn[1], 8)[0]
                    # a CELL's or WRLD's children group sits right after its record
                    at = next((i for i, dn in enumerate(dlist) if dn[0] == 'R' and gtype in (1, 6) and struct.unpack_from('<I', dn[1], 12)[0] == label), None)
                    if at is not None: dlist.insert(at + 1, cn)
                    else: dlist.append(cn)

    # remember where DLE had each child fid before merging, to find moved records afterwards
    def locate(nodes, path=()):
        out = {}
        for i, n in enumerate(nodes):
            if n[0] == 'R': out.setdefault(struct.unpack_from('<I', n[1], 12)[0], []).append(path)
            else: out.update({k: out.get(k, []) + v for k, v in locate(n[2], path + (key(n),)).items()})
        return out

    merge(dnodes, cnodes, top=True)
    where = locate(dnodes)
    for fid, paths in where.items():
        if fid in child_fids and len(paths) > 1:
            stale.append(fid)
    # drop duplicates: keep the copy whose group path matches the child's
    cwhere = locate(cnodes)
    def drop(nodes, fid, keep_path, path=()):
        for i in range(len(nodes) - 1, -1, -1):
            n = nodes[i]
            if n[0] == 'R' and struct.unpack_from('<I', n[1], 12)[0] == fid and path != keep_path: del nodes[i]
            elif n[0] == 'G': drop(n[2], fid, keep_path, path + (key(n),))
    for fid in stale: drop(dnodes, fid, cwhere[fid][0])

    # ---- header: record count (records + groups) and the next object id -----------------------------------------
    def count(nodes): return sum(1 + (count(n[2]) if n[0] == 'G' else 0) for n in nodes)
    struct.pack_into('<II', dhead, hpos + 10, count(dnodes), nextid)
    out = tree.serialize(dhead, dnodes)
    open(a.out, 'wb').write(out)

    # ---- proof ------------------------------------------------------------------------------------------------
    mhead, mnodes = tree.parse(out)
    merged = {struct.unpack_from('<I', r[1], 12)[0]: r for r in tree.walk_records(mnodes)}
    orig = {}
    for r in tree.walk_records(tree.parse(dbuf)[1]): orig.setdefault(struct.unpack_from('<I', r[1], 12)[0], []).append(r)
    bad = 0
    for r in tree.walk_records(cnodes):
        fid = struct.unpack_from('<I', r[1], 12)[0]
        m = merged.get(fid)
        if m is None or body_of(m)[0] != body_of(r)[0] or bytes(m[1][:12]) != bytes(r[1][:12]): bad += 1; print('MISMATCH %08x' % fid)
    untouched = [f for f in orig if f not in child_fids]
    changed = [f for f in untouched if f not in merged or bytes(merged[f][1]) + bytes(merged[f][2]) != bytes(orig[f][0][1]) + bytes(orig[f][0][2])]
    dup = [f for f, rs in collections.Counter(struct.unpack_from('<I', r[1], 12)[0] for r in tree.walk_records(mnodes)).items() if rs > 1]
    print('child masters -> DLE: %d remapped by name, %d new records renumbered %06x..%06x' % (sum(1 for i, j in imap.items() if i != j), len(newmap), min(v & 0xFFFFFF for v in newmap.values()) if newmap else 0, max(v & 0xFFFFFF for v in newmap.values()) if newmap else 0))
    print('form id fields remapped:', dict(remapped))
    print('records: DLE %d -> %d (child %d, of which %d replaced DLE copies, %d stale moved copies dropped)' % (len(orig), len(merged), len(child_fids), sum(1 for f in child_fids if f in orig), len(stale)))
    print('child records not identical after merge:', bad)
    print('DLE records the child does not touch that changed:', len(changed), [('%08x' % f) for f in changed[:10]])
    print('duplicate form ids in the result:', len(dup))
    print('HEDR: records %d, next object id %06x' % struct.unpack_from('<II', mhead, hpos + 10))
    # every byte the remap changed must be a 4-byte form id naming the same (plugin, local id) on both sides
    names_c = cm + ['<child>']; names_d = dm + [DLE_NAME]
    inv_new = {v: k for k, v in newmap.items()}
    wrong = 0; windows = 0
    for o, f in zip(tree.walk_records(original_child), tree.walk_records(cnodes)):
        ob, fb = body_of(o)[0], body_of(f)[0]
        if len(ob) != len(fb): wrong += 1; continue
        pairs = [(bytes(o[1][12:16]), bytes(f[1][12:16]))]
        # windows are aligned to each subrecord's data, where every remapped form id starts
        for s, off, z in subrecords(ob):
            for k in range(0, z, 4):
                a, b = bytes(ob[off + k:off + k + 4]), bytes(fb[off + k:off + k + 4])
                if a != b: pairs.append((a, b))
        for ov, fv in pairs:
            ov, fv = struct.unpack('<I', ov.ljust(4, b'\0'))[0], struct.unpack('<I', fv.ljust(4, b'\0'))[0]
            if ov == fv: continue
            windows += 1
            if fv in inv_new: ok = inv_new[fv] == ov
            else: ok = (ov & 0xFFFFFF) == (fv & 0xFFFFFF) and names_c[min(ov >> 24, len(cm))].lower() == names_d[min(fv >> 24, len(dm))].lower()
            if not ok: wrong += 1; print('BAD REMAP %08x -> %08x in %08x' % (ov, fv, struct.unpack_from('<I', f[1], 12)[0]))
    print('changed form id windows checked: %d, wrong: %d' % (windows, wrong))
    if bad or changed or dup or wrong: raise SystemExit('PROOF FAILED: output written but must not be installed')
    print('PROOF OK')


if __name__ == '__main__':
    main()
