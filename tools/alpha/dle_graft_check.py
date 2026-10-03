#!/usr/bin/env python3
"""Proof for a graft made by dle_graft.py, read with ck-mcp's esplib and a group walker of its own (not dle_graft's).

    python3 tools/alpha/dle_graft_check.py <base esp> <source esp> <grafted esp> --expect <n> [--data <dir>]

Exit 0 with "ok" lines, or 1 with one line per failure. It checks that the grafted file is the base plus exactly <n>
references and nothing else:
  header    the same masters, and the TES4 header byte-identical apart from HEDR's record count and next object id
  records   against the base, by form id (the masters are the same list, so ids compare as they are): none removed, none
            changed in flags or bytes, and exactly <n> added, every one a REFR or ACHR byte-identical to the source's
            and in the same world, cell and group type
  navi      every NAVI record (the navmesh info map) byte-identical to the base's
  groups    every group's size is its header plus its contents, to the byte, up to the end of the file; HEDR's count is
            records plus groups; a cell's child groups come in type order (persistent, temporary, distant); the base's
            groups are all there and each new group is one the source has
  bases     with --data, the base object each added reference names is a record of a master or of the file
"""
import argparse, collections, os, struct, sys

sys.path.insert(0, os.environ.get('ESPLIB_DIR', os.path.expanduser('~nate/dragonbreak/ck-mcp')))
import esplib  # noqa: E402

CMP = 0x40000


def records(path):
    """form id -> (type, flags without the compressed bit, data, (world, cell, group type)), plus duplicate ids"""
    p = esplib.Plugin(path)
    out, dups = {}, []
    with open(path, 'rb') as fh:
        for t, fid, fl, off, sz, ctx in p.index:
            if fid in out and t != 'TES4':
                dups.append(fid)
            out[fid] = (t, fl & ~CMP, p.data_at(fh, off, sz, fl), ctx)
    return p, out, dups


def tree(path):
    """Walk the groups: (records, groups, problems, {group path: size}, [(cell group path, [child types in order])])"""
    b = open(path, 'rb').read()
    problems, sizes, cells = [], {}, []
    head = 24 + struct.unpack_from('<I', b, 4)[0]
    nrec, ngrp = [1], [0]   # TES4 itself is not in HEDR's count; it is subtracted below

    def walk(pos, end, path):
        kids = []
        while pos < end:
            if pos + 24 > end:
                problems.append(f'{path}: a header runs past the end at {pos}')
                return kids
            sig, size = b[pos:pos + 4], struct.unpack_from('<I', b, pos + 4)[0]
            if sig == b'GRUP':
                label, gtype = struct.unpack_from('<Ii', b, pos + 8)
                if size < 24 or pos + size > end:
                    problems.append(f'group ({gtype},{label:08X}) at {pos} is {size} bytes and runs past its parent')
                    return kids
                key = path + ((gtype, label),)
                if key in sizes:
                    problems.append(f'group path {key} appears twice')
                sizes[key] = size
                ngrp[0] += 1
                inner = walk(pos + 24, pos + size, key)
                if gtype == 6:
                    cells.append((key, inner))
                kids.append(gtype)
                pos += size
            else:
                nrec[0] += 1
                pos += 24 + size
        if pos != end:
            problems.append(f'{path}: contents end at {pos}, the group at {end}')
        return kids

    walk(head, len(b), ())
    return nrec[0] - 1, ngrp[0], problems, sizes, cells


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('base'); ap.add_argument('source'); ap.add_argument('out')
    ap.add_argument('--expect', type=int, required=True, help='the number of references the graft should add')
    ap.add_argument('--data', help='a Data folder with the masters, to resolve each added reference\'s base object')
    a = ap.parse_args()
    fails, oks = [], []

    bp, base, bd = records(a.base)
    sp, src, _ = records(a.source)
    op, out, od = records(a.out)
    if bd or od:
        fails.append(f'duplicate form ids: base {len(bd)}, graft {len(od)}')

    # header
    if [m.lower() for m in op.masters] != [m.lower() for m in bp.masters]:
        fails.append('masters differ from the base')
    hb, ho = open(a.base, 'rb').read(), open(a.out, 'rb').read()
    def header_rest(buf):
        size = 24 + struct.unpack_from('<I', buf, 4)[0]
        at = buf.index(b'HEDR', 24, size) + 6
        return buf[:at + 4] + buf[at + 12:size]   # the version stays; the record count and next id are skipped
    if header_rest(hb) != header_rest(ho):
        fails.append('the TES4 header differs beyond HEDR count and next id')
    else:
        oks.append(f'header: {len(op.masters)} masters as the base; HEDR count {bp.hedr[1]} -> {op.hedr[1]}, '
                   f'next id {bp.hedr[2]:06X} -> {op.hedr[2]:06X}')

    # records
    added = [f for f in out if f not in base]
    removed = [f for f in base if f not in out]
    changed = [f for f in base if f in out and (base[f][1] != out[f][1] or base[f][2] != out[f][2] or base[f][0] != out[f][0])]
    bytype = collections.Counter(out[f][0] for f in added)
    if removed:
        fails.append(f'{len(removed)} base record(s) removed, e.g. {removed[0]:08X}')
    if changed:
        fails.append(f'{len(changed)} base record(s) changed, e.g. {changed[0]:08X}')
    if len(added) != a.expect or set(bytype) - {'REFR', 'ACHR'}:
        fails.append(f'added {len(added)} record(s) {dict(bytype)}, expected {a.expect} references')
    bad = [f for f in added if f not in src or src[f][:3] != out[f][:3] or src[f][3] != out[f][3]]
    if bad:
        fails.append(f'{len(bad)} added record(s) differ from the source or sit elsewhere, e.g. {bad[0]:08X}')
    moved = [f for f in base if f in out and base[f][3] != out[f][3]]
    if moved:
        fails.append(f'{len(moved)} base record(s) now sit in another group, e.g. {moved[0]:08X}')
    if not (removed or changed or bad or moved) and len(added) == a.expect:
        own = len(op.masters)
        cells = collections.Counter(out[f][3][1] for f in added)
        oks.append(f'records: {len(base)} -> {len(out)}; +{len(added)} {dict(bytype)} ({sum(1 for f in added if f >> 24 == own)} new, '
                   f'{sum(1 for f in added if f >> 24 != own)} override(s) of a master), 0 removed, 0 changed; every added one '
                   f'byte-identical to the source, by cell ' + ', '.join(f'{c:08X} x{n}' for c, n in sorted(cells.items())))
    flagged = [f for f in added if out[f][1] & 0x20]
    if flagged:
        oks.append(f'note: {len(flagged)} added reference(s) flagged Deleted')

    # navi
    bn = {f: v for f, v in base.items() if v[0] == 'NAVI'}
    on = {f: v for f, v in out.items() if v[0] == 'NAVI'}
    if bn.keys() != on.keys() or any(bn[f][1:3] != on[f][1:3] for f in bn):
        fails.append('NAVI differs from the base')
    else:
        nvmi = sum(1 for v in on.values() for s, _ in esplib.subrecords(v[2]) if s == b'NVMI')
        oks.append(f'navi: {len(on)} NAVI record(s) byte-identical to the base ({nvmi} NVMI entries)')

    # groups
    nb, gb, pb, sb, _ = tree(a.base)
    no, go, po, so, co = tree(a.out)
    _, _, _, ss, _ = tree(a.source)
    fails += [f'groups: {x}' for x in po]
    if pb:
        fails.append(f'the base itself has {len(pb)} group problem(s)')
    if op.hedr[1] != no + go:
        fails.append(f'HEDR count {op.hedr[1]} but {no} records and {go} groups')
    order = [(k, kids) for k, kids in co if [t for t in kids if t in (8, 9, 10)] != sorted(t for t in kids if t in (8, 9, 10))
             or len([t for t in kids if t in (8, 9, 10)]) != len(set(t for t in kids if t in (8, 9, 10)))]
    if order:
        fails.append(f'{len(order)} cell(s) with child groups out of order or repeated, e.g. {order[0][0][-1][1]:08X} {order[0][1]}')
    lost = [k for k in sb if k not in so]
    new = [k for k in so if k not in sb]
    stray = [k for k in new if k not in ss]
    if lost:
        fails.append(f'{len(lost)} base group(s) missing')
    if stray:
        fails.append(f'{len(stray)} new group(s) the source does not have')
    grew = sum(1 for k in sb if k in so and so[k] != sb[k])
    if not (po or lost or stray or order) and op.hedr[1] == no + go:
        oks.append(f'groups: {gb} -> {go} (+{len(new)} new, each one the source has: '
                   + ', '.join(f'type {k[-1][0]} in cell {k[-1][1]:08X}' for k in new)
                   + f'); {grew} enclosing group(s) grew; every size exact to the end of the file; HEDR {op.hedr[1]} = '
                   f'{no} records + {go} groups; child groups in type order in all {len(co)} cells')

    # bases
    if a.data:
        files = {n.lower(): os.path.join(a.data, n) for n in os.listdir(a.data)}
        need = collections.defaultdict(set)
        for f in added:
            for s, v in esplib.subrecords(out[f][2]):
                if s == b'NAME':
                    nid = struct.unpack_from('<I', v, 0)[0]
                    need[nid >> 24].add(nid)
        types, missing = collections.Counter(), []
        for mi, ids in need.items():
            if mi == len(op.masters):
                for nid in ids:
                    (types.update([out[nid][0]]) if nid in out else missing.append(nid))
                continue
            name = op.masters[mi].lower()
            m = esplib.Plugin(files[name]) if name in files else None
            have = {fid & 0xFFFFFF: t for t, fid, *_ in m.index if fid >> 24 == len(m.masters)} if m else {}
            for nid in ids:
                t = have.get(nid & 0xFFFFFF)
                (types.update([t]) if t else missing.append(nid))
        if missing:
            fails.append(f'{len(missing)} base object(s) not found, e.g. {missing[0]:08X}')
        else:
            oks.append(f'bases: every added reference names a record that exists ({dict(types)})')

    for line in oks:
        print('ok   ' + line)
    for line in fails:
        print('FAIL ' + line)
    print(('PASS' if not fails else 'FAIL') + f': {a.out}')
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
