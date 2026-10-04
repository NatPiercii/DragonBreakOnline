#!/usr/bin/env python3
"""Independent proof for a dle_graft.py --manifest graft (dle_graft_check.py --manifest). It reads the plugins with
ck-mcp's esplib, its own group walker and Worker G's NVMI layout, and shares no code with dle_graft*.py or dle_layouts.py.

    python3 tools/alpha/dle_graft_check.py --manifest <plan.json> <base esp> <source esp> <out esp> --data <dir>
                                           [--live <esp> --live-expect <n>]

Against the base the graft was made on, every manifest entry is checked for what it says:
  copy        byte-identical to the source's record (compressed stays compressed), in the source's group path
  copy_flags  the same but for the header's flags, which are the source's plus the named ones
  master      the winning record among the base's masters: same subrecords in the same order and the same bytes,
              except 4-byte words that are form ids naming the same record through each file's masters
  master_with the same, with the named subrecords as the source has them
  disable     as master, with Initially Disabled added; disable_drop_parent also has no XESP
  patch       the base's record with only the named change: flags, DATA position, or the named subrecords as the source's
  navi_add    the base NAVI with only those NVMI entries added, byte-identical to the source's; NVER, NVPP, every other
              NVMI entry and their order unchanged
and nothing else: no base record removed or changed, no other record added. Groups are walked to the byte, HEDR's count
is records plus groups, a cell's child groups are in type order, each new group is one the source has. Every REFR/ACHR
added or patched names a base object that exists (output or a master); every door's XTEL target exists.
With --live, the same output is diffed against live: added records by type and kind, changed records, NAVI = live + the
manifest's NVMI entries.
"""
import collections, json, os, struct, sys, zlib

sys.path.insert(0, os.environ.get('ESPLIB_DIR', os.path.expanduser('~nate/dragonbreak/ck-mcp')))
import esplib  # noqa: E402

CMP, DEL, DIS = 0x40000, 0x20, 0x800


class File:
    def __init__(self, path):
        self.path, self.p = path, esplib.Plugin(path)
        self.buf = open(path, 'rb').read()
        self.masters = [m.lower() for m in self.p.masters]
        self.name = os.path.basename(path).lower()
        self.rec, self.order, self.groups, self.problems, self.cells = {}, [], {}, [], []
        head = 24 + struct.unpack_from('<I', self.buf, 4)[0]
        self.head = head
        self._walk(head, len(self.buf), ())

    def _walk(self, pos, end, path):
        b, kids = self.buf, []
        while pos < end:
            sig, size = b[pos:pos + 4], struct.unpack_from('<I', b, pos + 4)[0]
            if sig == b'GRUP':
                label, gtype = struct.unpack_from('<Ii', b, pos + 8)
                if size < 24 or pos + size > end:
                    self.problems.append(f'group ({gtype},{label:08X}) at {pos} runs past its parent'); return kids
                key = path + ((gtype, label),)
                if key in self.groups:
                    self.problems.append(f'group {key[-1]} twice')
                self.groups[key] = (pos, size)
                inner = self._walk(pos + 24, pos + size, key)
                if gtype == 6:
                    self.cells.append((key, inner))
                kids.append(gtype); pos += size
            else:
                flags, fid = struct.unpack_from('<II', b, pos + 8)
                raw = b[pos:pos + 24 + size]
                if fid in self.rec:
                    self.problems.append(f'{fid:08X} twice')
                self.rec[fid] = (sig.decode('ascii', 'replace'), flags, raw, path)
                self.order.append(fid); pos += 24 + size
        if pos != end:
            self.problems.append(f'{path}: contents end at {pos}, the group at {end}')
        return kids

    def body(self, fid):
        raw = self.rec[fid][2]
        return zlib.decompress(raw[28:]) if self.rec[fid][1] & CMP else raw[24:]

    def resolve(self, x):
        """(plugin, local id) a form id names in this file's numbering"""
        i = x >> 24
        return (self.masters[i] if i < len(self.masters) else self.name, x & 0xFFFFFF)

    def count(self):
        return struct.unpack_from('<iI', self.buf, self.buf.index(b'HEDR', 24, self.head) + 10)


def subs(body):
    return list(esplib.subrecords(body))


def same_but_ids(fa, ba, fb, bb):
    """two bodies whose subrecords match in order and bytes, but for 4-byte words naming the same record"""
    sa, sb = subs(ba), subs(bb)
    if [s for s, _ in sa] != [s for s, _ in sb]:
        return 'subrecords differ: %s vs %s' % ([s.decode() for s, _ in sa], [s.decode() for s, _ in sb])
    for (sig, va), (_, vb) in zip(sa, sb):
        if len(va) != len(vb):
            return f'{sig.decode()} size differs'
        for i in range(0, len(va) - len(va) % 4 if va != vb else 0, 4):
            wa, wb = va[i:i + 4], vb[i:i + 4]
            if wa != wb and fa.resolve(struct.unpack('<I', wa)[0]) != fb.resolve(struct.unpack('<I', wb)[0]):
                return f'{sig.decode()} word {i} names different records'
        if va != vb and any(va[i] != vb[i] for i in range(len(va) - len(va) % 4, len(va))):
            return f'{sig.decode()} tail differs'
    return ''


def nvmi_key(v):
    return struct.unpack_from('<I', v, 0)[0]


def navi_entries(f):
    fid = [x for x in f.order if f.rec[x][0] == 'NAVI']
    if len(fid) != 1:
        return None, None
    return fid[0], subs(f.body(fid[0]))


def main(argv):
    import argparse
    ap = argparse.ArgumentParser(prog='dle_graft_check.py --manifest')
    ap.add_argument('manifest'); ap.add_argument('base'); ap.add_argument('source'); ap.add_argument('out')
    ap.add_argument('--data', required=True); ap.add_argument('--live'); ap.add_argument('--live-expect', type=int)
    a = ap.parse_args(argv)
    raw = json.load(open(a.manifest))
    hx = lambda x: int(x, 16)
    man = {k: ([hx(x) for x in v] if isinstance(v, list) else {hx(i): w for i, w in v.items()}) for k, v in raw.items() if not k.startswith('_')}
    B, S, O = File(a.base), File(a.source), File(a.out)
    fails, oks = [], []
    files = {n.lower(): os.path.join(a.data, n) for n in os.listdir(a.data)}
    loaded = {}

    def master(name):
        if name not in loaded:
            loaded[name] = File(files[name])
        return loaded[name]

    def winner(fid):
        owner, loc, hit = B.masters[fid >> 24], fid & 0xFFFFFF, None
        for m in B.masters:
            with open(files[m], 'rb') as fh:
                hd = fh.read(24); hb = fh.read(struct.unpack_from('<I', hd, 4)[0])
            if m != owner and owner.encode('cp1252') + b'\0' not in hb.lower():
                continue
            f = master(m)
            idx = len(f.masters) if m == owner else (f.masters.index(owner) if owner in f.masters else None)
            if idx is not None and (idx << 24 | loc) in f.rec:
                hit = (f, idx << 24 | loc)
        return hit

    for f in (B, S, O):
        if f.problems:
            fails.append(f'{f.name}: {len(f.problems)} group problem(s), e.g. {f.problems[0]}')
    if O.masters != B.masters:
        fails.append('masters differ from the base')
    hb, ho = B.buf, O.buf
    at = hb.index(b'HEDR', 24, B.head) + 6
    if hb[:at + 4] + hb[at + 12:B.head] != ho[:at + 4] + ho[at + 12:O.head]:
        fails.append('TES4 header differs beyond HEDR count and next id')
    n_rec, n_grp = len(O.rec), len(O.groups)
    if O.count()[0] != n_rec + n_grp:
        fails.append(f'HEDR count {O.count()[0]} but {n_rec} records + {n_grp} groups')

    planned = {}
    for k in ('copy', 'master', 'disable', 'disable_drop_parent'):
        for fid in man.get(k, []):
            planned[fid] = k
    for fid in man.get('master_with', {}):
        planned[fid] = 'master_with'
    for fid in man.get('copy_flags', {}):
        planned[fid] = 'copy_flags'
    added = [x for x in O.order if x not in B.rec]
    removed = [x for x in B.order if x not in O.rec]
    changed = [x for x in B.order if x in O.rec and O.rec[x][2] != B.rec[x][2]]
    if removed:
        fails.append(f'{len(removed)} base record(s) removed')
    if set(added) != set(planned):
        fails.append(f'added {len(added)} record(s), the manifest names {len(planned)}; extra {len(set(added) - set(planned))}, missing {len(set(planned) - set(added))}')
    navi_fid, _ = navi_entries(B)
    allowed = set(man.get('patch', {})) | ({navi_fid} if man.get('navi_add') else set())
    if set(changed) != allowed:
        fails.append(f'changed base records {sorted("%08X" % x for x in set(changed) ^ allowed)} differ from the manifest\'s patches')
    order_ok = [x for x in O.order if x in B.rec] == B.order
    if not order_ok:
        fails.append('base records not in their order')
    moved = [x for x in B.order if x in O.rec and O.rec[x][3] != B.rec[x][3]]
    if moved:
        fails.append(f'{len(moved)} base record(s) in another group')

    kinds, bad = collections.Counter(), []
    for fid in added:
        k = planned.get(fid)
        if k is None:
            continue
        t, fl, rawo, path = O.rec[fid]
        kinds[(k, t)] += 1
        if fid not in S.rec or S.rec[fid][3] != path:
            bad.append((fid, 'not in the source\'s group path')); continue
        if k == 'copy':
            if rawo != S.rec[fid][2]:
                bad.append((fid, 'not byte-identical to the source'))
            continue
        if k == 'copy_flags':
            sraw, want = S.rec[fid][2], S.rec[fid][1] | int(man['copy_flags'][fid])
            if fl != want or rawo[:8] != sraw[:8] or rawo[12:] != sraw[12:]:
                bad.append((fid, f'not the source\'s record with flags {want:X}'))
            continue
        hit = winner(fid)
        if not hit:
            bad.append((fid, 'no master holds it')); continue
        mf, mid = hit
        mfl = mf.rec[mid][1]
        want_fl = (mfl & ~(CMP | DEL)) | (DIS if k.startswith('disable') else 0)
        if fl & ~CMP != want_fl:
            bad.append((fid, f'flags {fl:X}, expected {want_fl:X}')); continue
        mb, ob = mf.body(mid), O.body(fid)
        if k == 'disable_drop_parent':
            mb = b''.join(s + struct.pack('<H', len(v)) + v for s, v in subs(mb) if s != b'XESP')
            if any(s == b'XESP' for s, _ in subs(ob)):
                bad.append((fid, 'still has an enable parent')); continue
        if k == 'master_with':
            sigs = [s.encode() for s in man['master_with'][fid]]
            sv = {s: [v for x, v in subs(S.body(fid)) if x == s] for s in sigs}
            ov = {s: [v for x, v in subs(ob) if x == s] for s in sigs}
            if sv != ov:
                bad.append((fid, 'taken subrecords are not the source\'s')); continue
            ob = b''.join(s + struct.pack('<H', len(v)) + v for s, v in subs(ob) if s not in sigs)
            mb = b''.join(s + struct.pack('<H', len(v)) + v for s, v in subs(mb) if s not in sigs)
        why = same_but_ids(mf, mb, O, ob)
        if why:
            bad.append((fid, why))
    if bad:
        fails.append(f'{len(bad)} added record(s) wrong, e.g. {bad[0][0]:08X}: {bad[0][1]}')
    else:
        oks.append('added: ' + ', '.join(f'{n} {t} ({k})' for (k, t), n in sorted(kinds.items())) + ', each as its manifest kind says')

    pbad = []
    for fid, p in man.get('patch', {}).items():
        if fid not in O.rec or fid not in B.rec:
            pbad.append((fid, 'missing')); continue
        bt, bfl, _, _ = B.rec[fid]; ot, ofl, _, _ = O.rec[fid]
        if ofl & ~CMP != (bfl & ~CMP) | int(p.get('flags_or', 0)):
            pbad.append((fid, f'flags {bfl:X} -> {ofl:X}')); continue
        bs, os_ = subs(B.body(fid)), subs(O.body(fid))
        take = [s.encode() for s in p.get('subs_from_source', [])] + ([b'DATA'] if 'data' in p else [])
        if [s for s, _ in bs] != [s for s, _ in os_]:
            pbad.append((fid, 'subrecords differ')); continue
        for (s, bv), (_, ov) in zip(bs, os_):
            if s not in take and bv != ov:
                pbad.append((fid, f'{s.decode()} changed')); break
            if s in take and 'data' in p and s == b'DATA':
                if [round(x, 1) for x in struct.unpack('<6f', ov)] != [round(x, 1) for x in p['data']]:
                    pbad.append((fid, 'DATA not the planned position')); break
            elif s in take and ov != [v for x, v in subs(S.body(fid)) if x == s][0]:
                pbad.append((fid, f'{s.decode()} not the source\'s')); break
    if pbad:
        fails.append(f'{len(pbad)} patch(es) wrong, e.g. {pbad[0][0]:08X}: {pbad[0][1]}')
    elif man.get('patch'):
        oks.append(f'patches: {len(man["patch"])} base record(s) changed only as planned')

    def navi_check(base_file, label):
        bf, be = navi_entries(base_file)
        of, oe = navi_entries(O)
        sf, se = navi_entries(S)
        new = set(man.get('navi_add', []))
        src_nv = {nvmi_key(v): v for s, v in se if s == b'NVMI'}
        rest = [(s, v) for s, v in oe if not (s == b'NVMI' and nvmi_key(v) in new)]
        added_nv = [(s, v) for s, v in oe if s == b'NVMI' and nvmi_key(v) in new]
        if rest != be:
            return f'NAVI against {label}: something other than the new NVMI entries differs'
        if sorted(nvmi_key(v) for _, v in added_nv) != sorted(new) or any(v != src_nv[nvmi_key(v)] for _, v in added_nv):
            return f'NAVI against {label}: the new NVMI entries are not the source\'s'
        nb = sum(1 for s, _ in be if s == b'NVMI')
        return '', nb, len(oe) - len(be)

    if man.get('navi_add'):
        r = navi_check(B, 'the base')
        if isinstance(r, str):
            fails.append(r)
        else:
            oks.append(f'navi: the base\'s NAVI ({r[1]} NVMI) + {r[2]} entry, every other subrecord byte-identical and in order')

    # group order and new groups
    order_bad = [k for k, kids in O.cells if [t for t in kids if t in (8, 9, 10)] != sorted(t for t in kids if t in (8, 9, 10))]
    if order_bad:
        fails.append(f'{len(order_bad)} cell(s) with child groups out of order')
    newg = [k for k in O.groups if k not in B.groups]
    if any(k not in S.groups for k in newg) or any(k not in O.groups for k in B.groups):
        fails.append('a new group is not the source\'s, or a base group is missing')
    else:
        oks.append(f'groups: {len(B.groups)} -> {len(O.groups)} (+{len(newg)}, each the source\'s); HEDR {O.count()[0]} = '
                   f'{n_rec} records + {n_grp} groups; walked to the byte; child groups in type order in all {len(O.cells)} cells')

    # bases and doors resolve
    unresolved, nbase, ndoor = [], 0, 0
    for fid in list(planned) + list(man.get('patch', {})):
        t = O.rec[fid][0]
        if t not in ('REFR', 'ACHR'):
            continue
        sv = dict(subs(O.body(fid)))
        for sig in (b'NAME', b'XTEL'):
            if sig not in sv:
                continue
            x = struct.unpack_from('<I', sv[sig], 0)[0]
            plug, loc = O.resolve(x)
            ok = (x in O.rec) if plug == O.name else (plug in files and ((len(master(plug).masters) << 24) | loc) in master(plug).rec)
            if not ok:
                unresolved.append((fid, sig.decode(), x))
            nbase += sig == b'NAME'; ndoor += sig == b'XTEL'
    if unresolved:
        fails.append(f'{len(unresolved)} unresolved, e.g. {unresolved[0][0]:08X} {unresolved[0][1]} {unresolved[0][2]:08X}')
    else:
        oks.append(f'resolve: all {nbase} base objects and {ndoor} door targets of the added and patched references exist')

    if a.live:
        Lv = File(a.live)
        lad = [x for x in O.order if x not in Lv.rec]
        lrm = [x for x in Lv.order if x not in O.rec]
        lch = [x for x in Lv.order if x in O.rec and O.rec[x][2] != Lv.rec[x][2]]
        by = collections.Counter((O.rec[x][0], 'own' if x >> 24 == len(O.masters) else 'override',
                                  'disabled' if O.rec[x][1] & DIS else 'live') for x in lad)
        line = (f'live: {len(Lv.rec)} -> {len(O.rec)} records: +{len(lad)} ' + ', '.join(f'{n} {t} {o} {d}' for (t, o, d), n in sorted(by.items()))
                + f'; {len(lrm)} removed; {len(lch)} changed (' + ', '.join(f'{O.rec[x][0]} {x:08X}' for x in lch) + ')')
        if lrm or (a.live_expect is not None and len(lad) != a.live_expect):
            fails.append(line)
        else:
            oks.append(line)
        if man.get('navi_add'):
            r = navi_check(Lv, 'live')
            if isinstance(r, str):
                fails.append(r)
            else:
                oks.append(f'navi: live NAVI ({r[1]} NVMI) + {r[2]} entry, NVER, NVPP and every other NVMI byte-identical and in order')

    for x in oks:
        print('ok   ' + x)
    for x in fails:
        print('FAIL ' + x)
    print(('PASS' if not fails else 'FAIL') + f': {a.out}')
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
