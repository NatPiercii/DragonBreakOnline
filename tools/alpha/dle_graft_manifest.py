#!/usr/bin/env python3
"""dle_graft.py --manifest: graft a chosen set of records of any placed kind, with every change listed by form id.

    python3 tools/alpha/dle_graft.py --manifest <plan.json> <base esp> <source esp> <out esp> --data <Data dir>

For a PC build that adds more than references (a new interior, its navmesh, terrain), the plan names each record and how
it comes over; nothing else of the source is read. The base's bytes are kept everywhere else.

    "copy":    [ids]  the source's record, byte for byte, in the source's group path: new records of the file's own
                      (REFR, ACHR, CELL, NAVM, LAND) and overrides the base lacks. Compressed records stay compressed.
    "master":  [ids]  the winning record among the base's masters, its form ids mapped to the base's numbering (an
                      exterior CELL override that only hosts new groups, so the source's re-saved XCLR/XCLC never come)
    "master_with": {id: [signatures]}  the same, with those subrecords' values taken from the source (a moved tree:
                      DATA, XSCL), so the source's other re-save changes (an added XLRL) stay out
    "disable": [ids]  the winning master record, Initially Disabled, in place (refused if it has an enable parent)
    "disable_drop_parent": [ids]  the same, with the enable parent (XESP) removed, as tooling/xedit-scripts/
                      DBO_RemovePuzzleGates.pas does: otherwise the parent's state wins over Initially Disabled
    "patch":   {id: {"flags_or": n, "data": [x, y, z, rx, ry, rz], "subs_from_source": [signatures]}}
                      an existing base record changed in place, nothing else of it touched
    "navi_add": [navmesh ids]  the source NAVI's NVMI entries for those navmeshes, inserted into the base's NAVI right
                      after the entry the source has before each (the stored list is in the CK's order, not sorted, though
                      xEdit shows it sorted), else after the base's last NVMI; every other NAVI byte stays the base's

Groups: a record goes into its source group path. Where the base has the group, records are appended (LAND and NAVM at
the front of a cell's group, as the CK writes them); where it does not, the missing groups are built with the source's
group headers, their contents in the source's order, and a new Cell Children group goes right after its CELL record.
Every enclosing group grows, HEDR's count and next object id follow. The output is verified before it is kept.
"""
import json, os, struct, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import dle_layouts as L  # noqa: E402

DELETED, DISABLED, COMPRESSED = 0x20, 0x800, 0x40000
HEAD_TYPES = ('LAND', 'NAVM')        # first in a cell's group


def refuse(msg):
    raise SystemExit(msg + '; graft refused')


def body_ids(rtype, rec, what):
    try:
        return L.form_ids(rtype, L.unpack(rec)[1], what)
    except L.Unreadable as e:
        refuse(str(e))


def rebuild(head, body):
    return L.pack(head, body)


def replace_subs(body, sig_values):
    """body with the values of the named subrecords replaced in order (same count of each signature)"""
    out, seen = b'', {}
    for sig, at, val in L.subs(body):
        if sig in sig_values:
            n = seen.get(sig, 0); seen[sig] = n + 1
            vals = sig_values[sig]
            if n >= len(vals):
                refuse(f'{sig.decode()} appears more often than the values given')
            val = vals[n]
        out += sig + struct.pack('<H', len(val)) + val
    for sig, vals in sig_values.items():
        if seen.get(sig, 0) != len(vals):
            refuse(f'{sig.decode()} count differs ({seen.get(sig, 0)} here, {len(vals)} given)')
    return out


def take_subs(body, src_body, sigs):
    """body with the named subrecords as the source has them: replaced where both have them (same count), added where only
    the source has one (before the next subrecord that follows it in the source and is in body, else at the end)"""
    have = {s for s, _, _ in L.subs(body)}
    same = [s for s in sigs if s in have]
    body = replace_subs(body, {s: values_of(src_body, s) for s in same})
    src_list = [(s, v) for s, _, v in L.subs(src_body)]
    for s in sigs:
        if s in have:
            continue
        vals = [v for x, v in src_list if x == s]
        if len(vals) != 1:
            refuse(f'{s.decode()}: only one new subrecord of a kind is added ({len(vals)} in the source)')
        i = [x for x, _ in src_list].index(s)
        after = next((x for x, _ in src_list[i + 1:] if x in have), None)
        out, done = b'', False
        for x, _, v in L.subs(body):
            if not done and x == after:
                out += s + struct.pack('<H', len(vals[0])) + vals[0]; done = True
            out += x + struct.pack('<H', len(v)) + v
        if not done:
            out += s + struct.pack('<H', len(vals[0])) + vals[0]
        body, have = out, have | {s}
    return body


def values_of(body, sig):
    return [val for s, _, val in L.subs(body) if s == sig]


class Mapper:
    """The winning master record of an id (dle_graft.Winners), mapped into the base's numbering"""

    def __init__(self, winners):
        self.w = winners

    def record(self, fid, flags_or=0, drop=(), take_from=None, sigs=(), refuse_parent=False):
        hit = self.w.winner(fid)
        if not hit:
            refuse(f'{fid:08X}: no master holds it')
        name, r = hit
        p = self.w.plugin(name)
        if r[2] & DELETED:
            refuse(f'{fid:08X}: the winning record in {name} is deleted')
        head, body = L.unpack(p.bytes_of(r))
        ids = body_ids(r[1], p.bytes_of(r), f'{fid:08X} in {name}')
        if refuse_parent and any(s == b'XESP' for s, _, _ in ids):
            refuse(f'{fid:08X}: has an enable parent in {name}, whose state would win over Initially Disabled')
        base = self.w.base

        def remap(x):
            if not x:
                return 0
            owner = name if x >> 24 == len(p.masters) else (p.masters[x >> 24] if x >> 24 < len(p.masters) else None)
            if owner not in base.masters:
                refuse(f'{fid:08X}: names {x:08X} in {name}, whose plugin is not a master of the base')
            return base.masters.index(owner) << 24 | (x & 0xFFFFFF)

        body = bytearray(body)
        for _, at, x in ids:
            struct.pack_into('<I', body, at, remap(x))
        body = bytes(body)
        if drop:
            kept = b''
            for sig, at, val in L.subs(body):
                if sig not in drop:
                    kept += sig + struct.pack('<H', len(val)) + val
            body = kept
        if sigs:
            body = take_subs(body, L.unpack(take_from)[1], sigs)
        flags = ((r[2] & ~(DELETED | COMPRESSED)) | flags_or)
        head = head[:4] + struct.pack('<II', 0, flags) + struct.pack('<I', fid) + head[16:24]
        return rebuild(head, body), name


def plan_manifest(base, src, man, mapper):
    have = {r[0]: r for r in base.records}
    srcby = {r[0]: r for r in src.records}
    add = {}              # fid -> (bytes, path, kind, type)

    def src_rec(fid):
        r = srcby.get(fid)
        if not r:
            refuse(f'{fid:08X}: not in the source')
        if fid in have:
            refuse(f'{fid:08X}: the base already has it (use "patch")')
        return r

    for fid in man.get('copy', []):
        r = src_rec(fid)
        if r[2] & DELETED:
            refuse(f'{fid:08X}: flagged Deleted in the source')
        add[fid] = (src.bytes_of(r), r[5], 'copy', r[1])
    for fid in man.get('master', []):
        r = src_rec(fid); add[fid] = (mapper.record(fid)[0], r[5], 'master', r[1])
    for fid, sigs in man.get('master_with', {}).items():
        r = src_rec(fid)
        add[fid] = (mapper.record(fid, take_from=src.bytes_of(r), sigs=[s.encode() for s in sigs])[0], r[5], 'master_with', r[1])
    for fid in man.get('disable', []):
        r = src_rec(fid); add[fid] = (mapper.record(fid, DISABLED, refuse_parent=True)[0], r[5], 'disable', r[1])
    for fid in man.get('disable_drop_parent', []):
        r = src_rec(fid); add[fid] = (mapper.record(fid, DISABLED, drop=(b'XESP',))[0], r[5], 'disable_drop_parent', r[1])
    for fid, (_, path, _, rtype) in add.items():
        if rtype not in ('REFR', 'ACHR', 'CELL', 'NAVM', 'LAND'):
            refuse(f'{fid:08X}: {rtype} records are not grafted')

    patches = {}          # fid -> new bytes
    for fid, p in man.get('patch', {}).items():
        r = have.get(fid)
        if not r:
            refuse(f'{fid:08X}: a patch needs the record in the base')
        head, body = L.unpack(base.bytes_of(r))
        if 'subs_from_source' in p:
            s = srcby.get(fid)
            if not s:
                refuse(f'{fid:08X}: not in the source')
            sb = L.unpack(src.bytes_of(s))[1]
            body = replace_subs(body, {x.encode(): values_of(sb, x.encode()) for x in p['subs_from_source']})
        if 'data' in p:
            old = values_of(body, b'DATA')
            if len(old) != 1 or len(old[0]) != 24:
                refuse(f'{fid:08X}: no 24-byte DATA to move')
            body = replace_subs(body, {b'DATA': [struct.pack('<6f', *p['data'])]})
        flags = (r[2] & ~COMPRESSED) | int(p.get('flags_or', 0))
        if flags & DELETED:
            refuse(f'{fid:08X}: a patch never deletes')
        if int(p.get('flags_or', 0)) & DISABLED and any(sg == b'XESP' for sg, _, _ in L.subs(body)):
            refuse(f'{fid:08X}: has an enable parent, whose state would win over Initially Disabled')
        head = head[:8] + struct.pack('<I', flags) + head[12:]
        patches[fid] = rebuild(head, body)

    if man.get('navi_add'):
        navi_b = [r for r in base.records if r[1] == 'NAVI']
        navi_s = [r for r in src.records if r[1] == 'NAVI']
        if len(navi_b) != 1 or len(navi_s) != 1:
            refuse('NAVI: the base and the source need one NAVI record each')
        rb, rs = navi_b[0], navi_s[0]
        head, body = L.unpack(base.bytes_of(rb))
        sbody = L.unpack(src.bytes_of(rs))[1]
        try:
            snvmi = {L.nvmi(v)[0]: v for s, _, v in L.subs(sbody) if s == b'NVMI'}
            bkeys = [L.nvmi(v)[0] for s, _, v in L.subs(body) if s == b'NVMI']
        except L.Unreadable as e:
            refuse(f'NAVI: {e}')
        want = list(man['navi_add'])
        skeys = [L.nvmi(v)[0] for s_, _, v in L.subs(sbody) if s_ == b'NVMI']
        for k in want:
            if k not in snvmi:
                refuse(f'NAVI: the source has no NVMI for {k:08X}')
            if k in bkeys:
                refuse(f'NAVI: the base already has an NVMI for {k:08X}')
        # The stored NVMI list is in the CK's own order, not sorted (v10 has 390 inversions): a new entry goes right after
        # the entry the source has before it, where that one is in the base, else after the base's last NVMI
        after = {}
        for k in want:
            i = skeys.index(k)
            prev = next((x for x in reversed(skeys[:i]) if x in bkeys), None)
            after.setdefault(prev, []).append(k)
        out = b''
        entries = list(L.subs(body))
        last_nvmi = max(i for i, (s_, _, _) in enumerate(entries) if s_ == b'NVMI')
        for i, (sig, _, val) in enumerate(entries):
            out += sig + struct.pack('<H', len(val)) + val
            key = L.nvmi(val)[0] if sig == b'NVMI' else 'none'
            for k in after.pop(key, []) if sig == b'NVMI' else []:
                v = snvmi[k]; out += b'NVMI' + struct.pack('<H', len(v)) + v
            if i == last_nvmi:
                for k in after.pop(None, []):
                    v = snvmi[k]; out += b'NVMI' + struct.pack('<H', len(v)) + v
        if after:
            refuse('NAVI: an entry found no place')
        patches[rb[0]] = rebuild(head, out)
    return add, patches


def layout(base, src, add, patches):
    """Inserts and replacements: [(offset, depth, seq, bytes, enclosing path, kind)], new group count"""
    srcpos = {r[0]: r[3] for r in src.records}
    edits, ngroups = [], [0]
    tree = {}             # anchor path -> node {'recs': [fid], 'groups': {seg: node}}

    def node():
        return {'recs': [], 'groups': {}}

    for fid, (_, path, _, _) in add.items():
        anchor = path
        while anchor and anchor not in base.groups:
            anchor = anchor[:-1]
        if not anchor:
            refuse(f'{fid:08X}: no group of its path is in the base')
        if anchor in base.dup_groups:
            refuse(f'{fid:08X}: the base has its group more than once')
        n = tree.setdefault(anchor, node())
        for seg in path[len(anchor):]:
            n = n['groups'].setdefault(seg, node())
        n['recs'].append(fid)

    def group_bytes(path, n):
        if path not in src.groups:
            refuse(f'group {path[-1]} is not in the source')
        gpos = src.groups[path][0]
        items = [(srcpos[f], 'r', f) for f in n['recs']] + [(src.groups[path + (seg,)][0], 'g', seg) for seg in n['groups']]
        body = b''
        for _, kind, x in sorted(items):
            body += add[x][0] if kind == 'r' else group_bytes(path + (x,), n['groups'][x])
        ngroups[0] += 1
        return b'GRUP' + struct.pack('<IIi', 24 + len(body), path[-1][1], path[-1][0]) + src.buf[gpos + 16:gpos + 24] + body

    base_rec_at = {r[0]: r for r in base.records}
    seq = 0
    for anchor, n in tree.items():
        apos, asize = base.groups[anchor]
        depth = len(anchor)
        paired = set()
        # CELL records with their new Cell Children group, together
        for fid in sorted(n['recs'], key=lambda f: srcpos[f]):
            rtype = add[fid][3]
            chunk = add[fid][0]
            seg = (6, fid)
            if rtype == 'CELL' and seg in n['groups']:
                chunk += group_bytes(anchor + (seg,), n['groups'][seg]); paired.add(seg)
            at = apos + 24 if (rtype in HEAD_TYPES and anchor[-1][0] in (8, 9, 10)) else apos + asize
            edits.append((at, depth, seq, chunk, anchor, 'insert')); seq += 1
        for seg, sub in n['groups'].items():
            if seg in paired:
                continue
            gtype, label = seg
            if gtype in (8, 9, 10) and anchor[-1][0] == 6:
                at = apos + asize
                for other, (opos, _) in base.groups.items():
                    if len(other) == len(anchor) + 1 and other[:-1] == anchor and other[-1][0] > gtype:
                        at = min(at, opos)
            elif gtype == 6 and label in base_rec_at and base_rec_at[label][5] == anchor:
                r = base_rec_at[label]; at = r[3] + r[4]
            else:
                refuse(f'a new group {seg} under {anchor[-1]} has no place this tool knows')
            edits.append((at, depth, seq, group_bytes(anchor + (seg,), sub), anchor, 'insert')); seq += 1
    for fid, new in patches.items():
        r = base_rec_at[fid]
        edits.append((r[3], len(r[5]), seq, (r[4], new), r[5], 'replace')); seq += 1
    return edits, ngroups[0]


def build(base, add, edits, ngroups):
    b = base.buf
    out_size = {}
    for at, depth, _, payload, inside, kind in edits:
        delta = len(payload) if kind == 'insert' else len(payload[1]) - payload[0]
        for d in range(1, len(inside) + 1):
            gpos = base.groups[inside[:d]][0]
            out_size[gpos] = out_size.get(gpos, 0) + delta
    head = bytearray(b[:base.head_size])
    count = base.count + len(add) + ngroups
    own = [f & 0xFFFFFF for f in add if f >> 24 == len(base.masters)]
    next_id = max([base.next_id] + [x + 1 for x in own])
    struct.pack_into('<iI', head, base.hedr_at + 4, count, next_id)
    result = bytearray(head)
    last = base.head_size
    # innermost first at one offset; then in plan order
    for at, depth, _, payload, inside, kind in sorted(edits, key=lambda e: (e[0], -e[1], e[5] != 'insert', e[2])):
        result += b[last:at]
        if kind == 'insert':
            result += payload; last = at
        else:
            result += payload[1]; last = at + payload[0]
    result += b[last:]
    out = bytes(result)
    # group sizes: every base group shifts; patch each header where it now sits
    final = bytearray(out)
    shifts = sorted(((at, (len(p) if k == 'insert' else len(p[1]) - p[0]), k, (p[0] if k == 'replace' else 0))
                     for at, _, _, p, _, k in edits), key=lambda e: e[0])

    def moved(pos):
        """where a base byte at pos sits in the output (a group header is never inside a replaced record)"""
        off = 0
        for at, delta, kind, oldlen in shifts:
            if kind == 'insert' and at <= pos:
                off += delta
            elif kind == 'replace' and at < pos:
                off += delta
        return pos + off

    for path, (gpos, gsize) in base.groups.items():
        np = moved(gpos)
        if final[np:np + 4] != b'GRUP':
            raise SystemExit(f'internal: group {path[-1]} lost its place')
        struct.pack_into('<I', final, np + 4, gsize + out_size.get(gpos, 0))
    return bytes(final)


def verify(base, src, out_path, add, patches, Plugin):
    o = Plugin(out_path)
    fails = []
    if o.masters != base.masters:
        fails.append('masters changed')
    if o.count != len(o.records) + len(o.groups):
        fails.append(f'HEDR count {o.count} but {len(o.records)} records and {len(o.groups)} groups')
    kept = [r for r in o.records if r[0] not in add]
    if [r[0] for r in kept] != [r[0] for r in base.records]:
        fails.append('the base records are not all there, in order')
    else:
        for r, br in zip(kept, base.records):
            want = patches.get(r[0], base.bytes_of(br))
            if o.bytes_of(r) != want or r[5] != br[5]:
                fails.append(f'{r[0]:08X} not as planned (base record {"patched" if r[0] in patches else "kept"})')
    got = {r[0]: r for r in o.records if r[0] in add}
    for fid, (data, path, kind, _) in add.items():
        g = got.get(fid)
        if not g or o.bytes_of(g) != data or g[5] != path:
            fails.append(f'{fid:08X} ({kind}) not grafted as planned')
    if o.buf[:base.hedr_at] != base.buf[:base.hedr_at] or o.buf[base.hedr_at + 12:o.head_size] != base.buf[base.hedr_at + 12:base.head_size]:
        fails.append('the TES4 header changed beyond the record count and next id')
    if o.next_id <= max([0] + [r[0] & 0xFFFFFF for r in o.records if o.own(r[0])]):
        fails.append(f'next object id {o.next_id:06X} is not past every record of its own')
    present = {r[0] for r in o.records}
    for fid, rec in list(add.items()) + [(f, (b, None, 'patch', None)) for f, b in patches.items()]:
        data = rec[0]
        rtype = data[:4].decode()
        if rtype == 'NAVI':
            try:
                ids = [x for s, _, v in L.subs(L.unpack(data)[1]) if s == b'NVMI' for x in
                       (lambda r: [struct.unpack_from('<I', v, at)[0] for at in r[1]])(L.nvmi(v))]
            except L.Unreadable as e:
                fails.append(f'NAVI: {e}'); continue
            ids = [(b'NVMI', 0, x) for x in ids]
        else:
            try:
                ids = L.form_ids(rtype, L.unpack(data)[1], f'{fid:08X}')
            except L.Unreadable as e:
                fails.append(str(e)); continue
        for sig, _, ref in ids:
            if ref and o.own(ref) and ref not in present:
                fails.append(f'{fid:08X} {sig.decode()} names {ref:08X}, which is not in the output')
    return o, fails


def run(argv, Plugin, Winners):
    import argparse
    ap = argparse.ArgumentParser(prog='dle_graft.py --manifest', description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('manifest'); ap.add_argument('base'); ap.add_argument('source'); ap.add_argument('out')
    ap.add_argument('--data', required=True)
    a = ap.parse_args(argv)
    if os.path.abspath(a.out) in (os.path.abspath(a.base), os.path.abspath(a.source)):
        raise SystemExit('the output must be a new file')
    raw = json.load(open(a.manifest))
    hexid = lambda x: int(x, 16) if isinstance(x, str) else int(x)
    man = {k: ([hexid(x) for x in v] if isinstance(v, list) else {hexid(i): w for i, w in v.items()})
           for k, v in raw.items() if not k.startswith('_')}
    base, src = Plugin(a.base), Plugin(a.source)
    if base.masters != src.masters:
        raise SystemExit('the masters differ; a graft needs the same list in the same order')
    add, patches = plan_manifest(base, src, man, Mapper(Winners(base, a.data)))
    edits, ngroups = layout(base, src, add, patches)
    kinds = {}
    for fid, (_, _, kind, rtype) in add.items():
        kinds[(kind, rtype)] = kinds.get((kind, rtype), 0) + 1
    print('add ' + ', '.join(f'{n} {t} ({k})' for (k, t), n in sorted(kinds.items())) + f'; patch {len(patches)}; create {ngroups} group(s)')
    data = build(base, add, edits, ngroups)
    tmp = a.out + '.part'
    with open(tmp, 'wb') as fh:
        fh.write(data)
    try:
        o, fails = verify(base, src, tmp, add, patches, Plugin)
    except BaseException:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise
    if fails:
        os.remove(tmp)
        for f in fails[:40]:
            print('FAIL ' + f)
        return 1
    os.replace(tmp, a.out)
    print(f'ok   {a.out}: {len(o.records)} records, {len(o.groups)} groups (HEDR {o.count}), next id {o.next_id:06X}, {len(data)} bytes')
    return 0
