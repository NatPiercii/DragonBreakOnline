#!/usr/bin/env python3
"""Graft new placed references from a PC build of DragonBreak Online Edits.esp into the live one, byte for byte.

    python3 tools/alpha/dle_graft.py <base esp> <source esp> <out esp> [--only <hex ids>] [--overrides]
                                     [--deleted | --disable-deleted --data <Data dir>] [--dry-run]

A PC build is a whole re-save of its own source, so it drops patches made on CT 115 and reorders records it never meant
to touch (memory pc-dle-builds-drop-server-side-patches, xedit-resave-mutates-unrelated-records). This copies only the
references the source adds and the base lacks: REFR and ACHR records that are the source's own, absent from the base, and
not flagged Deleted (--only narrows them to a list). Everything else in the output is the base's bytes, in its order.
--overrides also takes the source's overrides of a master's references that the base does not override; --deleted takes
those overrides even when they are flagged Deleted, which deletes the master's reference (an undeleted-reference risk in
the engine, so it is never the default). --disable-deleted (with --overrides and --data) writes each of those Deleted
overrides instead as the master's winning record, its form ids mapped to this file's masters, with Initially Disabled
set and nothing else changed: in place, as the base game's own disabled references are (Update.esm, Dawnguard.esm and
HearthFires.esm never move a disabled reference; the -30000 sink of tooling/xedit-scripts/DBO_RemovePuzzleGates.pas is
xEdit's convention for blockers, not theirs). The server skips an Initially Disabled reference as it skips a Deleted one
(WorldState.cpp AttachEspmRecord). A new reference of the file's own that is flagged Deleted is never taken.

Each reference goes into the same cell's group in the base, at the end of its Persistent, Temporary or Visible Distant
group; a missing one of those is created with the source group's header. A reference whose cell has no Cell Children
group in the base is refused: that would need the CELL record and its block groups too. Every enclosing group grows by
what goes in, and the TES4 header's record count (records plus groups) and next object id follow.

The output is checked before it is kept: the groups nest to the byte, the count matches, every base record is there
unchanged and in order, and every grafted record is identical to the source's. Masters must be the same list, and every
form id of the file's own that a grafted record names (base object, location) must be in the output.
"""
import argparse, os, struct, sys

# REFR/ACHR subrecords that hold a form id at the start (a graft is refused if one of the file's own is missing)
FORM_FIELDS = (b'NAME', b'XLRL', b'XLRT', b'XLCN', b'XEZN', b'XOWN', b'XESP', b'XLIB', b'XTEL', b'XAPR', b'XNDP', b'XMBR')
# --disable-deleted copies a master's record only when every subrecord is one of these: a form id at the start (mapped),
# or no form id at all. Anything else is refused rather than copied with ids in the master's numbering
MAP_AT_0 = (b'NAME', b'XLRL', b'XLRT', b'XLCN', b'XEZN', b'XOWN', b'XESP')
NO_IDS = (b'DATA', b'XSCL', b'EDID', b'XRGD', b'XRGB')
DISABLED = 0x800
COMPRESSED = 0x40000

DELETED = 0x20
CELL_CHILDREN = 6
REF_GROUPS = (8, 9, 10)   # persistent, temporary, visible when distant


class Plugin:
    """The group tree of a plugin: every record and group by offset, with its path of (group type, label)"""

    def __init__(self, path):
        self.path = path
        self.buf = open(path, 'rb').read()
        b = self.buf
        if b[:4] != b'TES4':
            raise SystemExit(f'{path}: not a plugin')
        self.head_size = 24 + struct.unpack_from('<I', b, 4)[0]
        self.masters, self.hedr_at = [], None
        i = 24
        while i < self.head_size:
            sig, n = b[i:i + 4], struct.unpack_from('<H', b, i + 4)[0]
            if sig == b'MAST':
                self.masters.append(b[i + 6:i + 6 + n].rstrip(b'\0').decode('cp1252').lower())
            elif sig == b'HEDR':
                self.hedr_at = i + 6
            i += 6 + n
        if self.hedr_at is None:
            raise SystemExit(f'{path}: no HEDR')
        self.version, self.count, self.next_id = struct.unpack_from('<fiI', b, self.hedr_at)
        self.records = []        # (form id, type, flags, offset, length with header, path)
        self.groups = {}         # path -> (offset, size)
        self.dup_groups = set()  # paths seen more than once: never a place to put a reference
        self._walk(self.head_size, len(b), ())

    def _walk(self, pos, end, path):
        b = self.buf
        while pos < end:
            sig, size = b[pos:pos + 4], struct.unpack_from('<I', b, pos + 4)[0]
            if sig == b'GRUP':
                label, gtype = struct.unpack_from('<Ii', b, pos + 8)
                key = path + ((gtype, label),)
                if pos + size > end or size < 24:
                    raise SystemExit(f'{self.path}: group at {pos} runs past its parent')
                if key in self.groups:
                    self.dup_groups.add(key)
                self.groups[key] = (pos, size)
                self._walk(pos + 24, pos + size, key)
                pos += size
            else:
                flags, fid = struct.unpack_from('<II', b, pos + 8)
                self.records.append((fid, sig.decode('ascii', 'replace'), flags, pos, 24 + size, path))
                pos += 24 + size
        if pos != end:
            raise SystemExit(f'{self.path}: group ends at {end} but its last entry at {pos}')

    def own(self, fid):
        return fid >> 24 == len(self.masters)

    def bytes_of(self, rec):
        return self.buf[rec[3]:rec[3] + rec[4]]


def candidates(base, src, overrides=False, deleted=False):
    """The source's references the base lacks, and the new ones of its own flagged Deleted (never taken)"""
    have = {r[0] for r in base.records}
    refs = [r for r in src.records if r[1] in ('REFR', 'ACHR') and r[0] not in have]
    take = [r for r in refs if (src.own(r[0]) and not r[2] & DELETED)
            or (overrides and not src.own(r[0]) and (deleted or not r[2] & DELETED))]
    junk = [r for r in refs if src.own(r[0]) and r[2] & DELETED]
    return take, junk, refs


def masters_of(path):
    """The master list from a plugin's TES4 header alone, lower case"""
    with open(path, 'rb') as fh:
        head = fh.read(24)
        body = fh.read(struct.unpack_from('<I', head, 4)[0])
    out, i = [], 0
    while i < len(body):
        sig, n = body[i:i + 4], struct.unpack_from('<H', body, i + 4)[0]
        if sig == b'MAST':
            out.append(body[i + 6:i + 6 + n].rstrip(b'\0').decode('cp1252').lower())
        i += 6 + n
    return out


class Winners:
    """The base's masters in a Data folder: the last of them that holds a reference is its winning record before the base"""

    def __init__(self, base, data):
        self.base, self.files, self.loaded = base, {n.lower(): os.path.join(data, n) for n in os.listdir(data)}, {}
        for m in base.masters:
            if m not in self.files:
                raise SystemExit(f'--data {data} has no {m}')
        self.heads = {m: masters_of(self.files[m]) for m in base.masters}

    def plugin(self, name):
        if name not in self.loaded:
            p = Plugin(self.files[name])
            p.by_id = {r[0]: r for r in p.records}
            self.loaded[name] = p
        return self.loaded[name]

    def winner(self, fid):
        owner, loc, found = self.base.masters[fid >> 24], fid & 0xFFFFFF, None
        for m in self.base.masters:
            ms = self.heads[m]
            idx = len(ms) if m == owner else (ms.index(owner) if owner in ms else None)
            if idx is None:
                continue
            r = self.plugin(m).by_id.get(idx << 24 | loc)
            if r:
                found = (m, r)
        return found

    def disabled(self, src_rec_bytes, fid):
        """The winning record of a master's reference, mapped to the base's masters, with Initially Disabled set"""
        hit = self.winner(fid)
        if not hit:
            raise SystemExit(f'{fid:08X}: no master holds this reference; graft refused')
        name, r = hit
        p = self.plugin(name)
        if r[2] & (DELETED | COMPRESSED):
            raise SystemExit(f'{fid:08X}: the winning record in {name} is deleted or compressed; graft refused')

        def remap(x):
            if not x:
                return 0
            owner = name if x >> 24 == len(p.masters) else (p.masters[x >> 24] if x >> 24 < len(p.masters) else None)
            if owner not in self.base.masters:
                raise SystemExit(f'{fid:08X}: names {x:08X} in {name}, whose plugin is not a master of the base; graft refused')
            return self.base.masters.index(owner) << 24 | (x & 0xFFFFFF)

        body = b''
        for sig, val in subrecords(p.bytes_of(r)):
            if sig in MAP_AT_0 and len(val) >= 4:
                val = struct.pack('<I', remap(struct.unpack_from('<I', val, 0)[0])) + val[4:]
            elif sig not in NO_IDS:
                raise SystemExit(f'{fid:08X}: {sig.decode()} in {name} may hold form ids this tool does not map; graft refused')
            if len(val) > 0xFFFF:
                raise SystemExit(f'{fid:08X}: {sig.decode()} is too long to copy; graft refused')
            body += sig + struct.pack('<H', len(val)) + val
        flags = (r[2] & ~DELETED) | DISABLED
        # the record header's tail (version control info and form version) is the source's, as the source wrote it
        return src_rec_bytes[:4] + struct.pack('<III', len(body), flags, fid) + src_rec_bytes[16:24] + body, name


def plan(base, src, only, overrides=False, deleted=False, content=None):
    take = candidates(base, src, overrides, deleted)[0]
    content = content or {}
    if only is not None:
        missing = only - {r[0] for r in take}
        if missing:
            raise SystemExit('not new live references in the source: ' + ', '.join(f'{x:08X}' for x in sorted(missing)))
        take = [r for r in take if r[0] in only]
    inserts = {}            # (offset in base, new group path or None, enclosing group path) -> [bytes]
    new_groups = {}         # group path -> header bytes (from the source)
    for r in take:
        path = r[5]
        if len(path) < 2 or path[-1][0] not in REF_GROUPS or path[-2][0] != CELL_CHILDREN:
            raise SystemExit(f'{r[0]:08X}: not in a cell\'s reference group ({path})')
        cell = path[:-1]
        if cell in base.dup_groups or path in base.dup_groups:
            raise SystemExit(f'{r[0]:08X}: the base has its cell group more than once; graft refused')
        if cell not in base.groups:
            raise SystemExit(f'{r[0]:08X}: the base has no Cell Children group for cell {path[-2][1]:08X}; graft refused')
        if path in base.groups:
            pos, size = base.groups[path]
            key = (pos + size, None, path)
        else:
            if path not in new_groups:
                gpos = src.groups[path][0]
                new_groups[path] = src.buf[gpos + 16:gpos + 24]
            # a new group goes after the cell's groups of a lower type, before any of a higher one
            cpos, csize = base.groups[cell]
            at = cpos + csize
            for sub, (spos, _) in base.groups.items():
                if len(sub) == len(path) and sub[:-1] == cell and sub[-1][0] > path[-1][0]:
                    at = min(at, spos)
            key = (at, path, cell)
        inserts.setdefault(key, []).append(content.get(r[0], src.bytes_of(r)))
    return take, inserts, new_groups


def build(base, take, inserts, new_groups):
    b = base.buf
    chunks = {}               # base offset -> bytes inserted there
    grow = {}                 # base group offset -> bytes added inside it: the enclosing group and each one above it
    for (at, gpath, inside), recs in inserts.items():
        body = b''.join(recs)
        if gpath is not None:
            label, gtype = gpath[-1][1], gpath[-1][0]
            body = b'GRUP' + struct.pack('<IIi', 24 + len(body), label, gtype) + new_groups[gpath] + body
        chunks[at] = chunks.get(at, b'') + body
        for depth in range(1, len(inside) + 1):
            gpos = base.groups[inside[:depth]][0]
            grow[gpos] = grow.get(gpos, 0) + len(body)
    out = bytearray(b)
    for gpos, extra in grow.items():
        struct.pack_into('<I', out, gpos + 4, struct.unpack_from('<I', b, gpos + 4)[0] + extra)
    count = base.count + len(take) + len(new_groups)
    next_id = max([base.next_id] + [(r[0] & 0xFFFFFF) + 1 for r in take if base.own(r[0])])
    struct.pack_into('<iI', out, base.hedr_at + 4, count, next_id)
    result = bytearray()
    last = 0
    for at in sorted(chunks):
        result += out[last:at] + chunks[at]
        last = at
    result += out[last:]
    return bytes(result)


def verify(base, src, out_path, take, content=None):
    content = content or {}
    o = Plugin(out_path)
    fails = []
    if o.masters != base.masters:
        fails.append('masters changed')
    if o.count != len(o.records) + len(o.groups):
        fails.append(f'HEDR count {o.count} but {len(o.records)} records and {len(o.groups)} groups')
    added = {r[0] for r in take}
    kept = [r for r in o.records if r[0] not in added]
    if [(r[0], o.bytes_of(r)) for r in kept] != [(r[0], base.bytes_of(r)) for r in base.records]:
        fails.append('the base records are not all there, unchanged and in order')
    src_by = {r[0]: r for r in take}
    got = {r[0]: r for r in o.records if r[0] in added}
    for fid, r in src_by.items():
        g = got.get(fid)
        if not g or o.bytes_of(g) != content.get(fid, src.bytes_of(r)) or g[5] != r[5]:
            fails.append(f'{fid:08X} not grafted as planned')
        elif fid in content and (g[2] & (DELETED | DISABLED)) != DISABLED:
            fails.append(f'{fid:08X} should be Initially Disabled and not Deleted')
    if o.buf[:base.hedr_at] != base.buf[:base.hedr_at] or o.buf[base.hedr_at + 12:o.head_size] != base.buf[base.hedr_at + 12:base.head_size]:
        fails.append('the TES4 header changed beyond the record count and next id')
    if o.next_id <= max([0] + [r[0] & 0xFFFFFF for r in o.records if o.own(r[0])]):
        fails.append(f'next object id {o.next_id:06X} is not past every record of its own')
    present = {r[0] for r in o.records}
    for r in take:
        for sig, val in subrecords(content.get(r[0], src.bytes_of(r))):
            if sig in FORM_FIELDS and len(val) >= 4:
                ref = struct.unpack_from('<I', val, 0)[0]
                if ref and o.own(ref) and ref not in present:
                    fails.append(f'{r[0]:08X} {sig.decode()} names {ref:08X}, which is not in the output')
    return o, fails


def subrecords(rec):
    """(signature, bytes) of an uncompressed record with its 24-byte header; XXXX sizes are honoured"""
    if struct.unpack_from('<I', rec, 8)[0] & 0x40000:
        raise SystemExit(f'{struct.unpack_from("<I", rec, 12)[0]:08X}: compressed; graft refused')
    i, big = 24, None
    while i < len(rec):
        sig, n = rec[i:i + 4], struct.unpack_from('<H', rec, i + 4)[0]
        if sig == b'XXXX':
            big = struct.unpack_from('<I', rec, i + 6)[0]; i += 6 + n; continue
        if big is not None:
            n, big = big, None
        yield sig, rec[i + 6:i + 6 + n]
        i += 6 + n


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('base'); ap.add_argument('source'); ap.add_argument('out')
    ap.add_argument('--only', help='comma-separated hex form ids to take (default: every new live reference)')
    ap.add_argument('--overrides', action='store_true', help="also take the source's overrides of master references the base lacks")
    ap.add_argument('--deleted', action='store_true', help='with --overrides, take Deleted overrides too (deletes the master reference)')
    ap.add_argument('--disable-deleted', action='store_true',
                    help="with --overrides and --data, write each Deleted override as the master's record, Initially Disabled")
    ap.add_argument('--data', help='the Data folder holding the masters (for --disable-deleted)')
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()
    if os.path.abspath(a.out) in (os.path.abspath(a.base), os.path.abspath(a.source)):
        raise SystemExit('the output must be a new file')
    base, src = Plugin(a.base), Plugin(a.source)
    if base.masters != src.masters:
        raise SystemExit('the masters differ; a graft needs the same list in the same order')
    only = {int(x, 16) for x in a.only.split(',')} if a.only else None
    if a.deleted and not a.overrides:
        raise SystemExit('--deleted needs --overrides')
    if a.disable_deleted and (not a.overrides or not a.data or a.deleted):
        raise SystemExit('--disable-deleted needs --overrides and --data, and replaces --deleted')
    with_deleted = a.deleted or a.disable_deleted
    content = {}
    if a.disable_deleted:
        w = Winners(base, a.data)
        for r in candidates(base, src, True, True)[0]:
            if not src.own(r[0]) and r[2] & DELETED and (only is None or r[0] in only):
                content[r[0]], name = w.disabled(src.bytes_of(r), r[0])
        print(f'disable {len(content)} Deleted override(s) instead, each copied from its winning master record')
    take, inserts, new_groups = plan(base, src, only, a.overrides, with_deleted, content)
    _, junk, refs = candidates(base, src, a.overrides, with_deleted)
    ids = {r[0] for r in take}
    left = [r for r in refs if r[0] not in ids and r not in junk]
    cells = {}
    for r in take:
        cells[r[5][-2][1]] = cells.get(r[5][-2][1], 0) + 1
    nover = sum(1 for r in take if not src.own(r[0]))
    print(f'take {len(take)} reference(s) ({len(take) - nover} new, {nover} override(s) of a master) in {len(cells)} cell(s): '
          + ', '.join(f'{c:08X} x{n}' for c, n in sorted(cells.items())))
    print(f'skip {len(junk)} new reference(s) of its own flagged Deleted; leave {len(left)} other(s) '
          f'({sum(1 for r in left if r[2] & DELETED)} Deleted override(s), {sum(1 for r in left if not r[2] & DELETED)} live override(s)); '
          f'create {len(new_groups)} group(s)')
    if a.dry_run or not take:
        return 0
    data = build(base, take, inserts, new_groups)
    tmp = a.out + '.part'
    with open(tmp, 'wb') as fh:
        fh.write(data)
    o, fails = verify(base, src, tmp, take, content)
    if fails:
        os.remove(tmp)
        for f in fails:
            print('FAIL ' + f)
        return 1
    os.replace(tmp, a.out)
    print(f'ok   {a.out}: {len(o.records)} records, {len(o.groups)} groups (HEDR {o.count}), next id {o.next_id:06X}, {len(data)} bytes')
    return 0


if __name__ == '__main__':
    sys.exit(main())
