#!/usr/bin/env python3
"""Self-test for dle_graft.py on small plugins built here: what it takes, where it puts it, what it refuses.

    python3 tools/alpha/test_dle_graft.py

The plugins are written under /tmp/claude-nate-graft-test-* and removed afterwards; no real plugin is read. Each graft is
then proved by dle_graft_check.py, so this also tests the proof. The --manifest part builds a master, a base and a source
with a new compressed interior CELL, its compressed NAVM (NVNM door link) and NVMI, a VMAD naming a new door, a LAND,
an exterior CELL override re-saved in the source, a moved tree, a Deleted REFR and a Deleted ACHR with an enable parent.
"""
import os, shutil, struct, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import dle_graft as D  # noqa: E402

fails = 0


def ok(cond, what, got=''):
    global fails
    print(('ok   ' if cond else 'FAIL ') + what + ('' if cond else f'   {got}'))
    fails += 0 if cond else 1


def sub(sig, data):
    return sig + struct.pack('<H', len(data)) + data


def rec(sig, fid, body, flags=0):
    return sig + struct.pack('<IIIII', len(body), flags, fid, 0, 44) + body


def grp(label, gtype, *kids):
    body = b''.join(kids)
    return b'GRUP' + struct.pack('<IIiII', 24 + len(body), label, gtype, 0, 0) + body


def refr(fid, x, flags=0, base=0x00000F00):
    return rec(b'REFR', fid, sub(b'NAME', struct.pack('<I', base)) + sub(b'DATA', struct.pack('<6f', x, 0, 0, 0, 0, 0)), flags)


CELL_A, CELL_B, CELL_C, WRLD = 0x00000100, 0x00000200, 0x00000300, 0x0000003C


def plugin(path, cells, next_id, masters=('Skyrim.esm',), stats=()):
    """cells: {cell id: {group type: [record bytes]}} in one exterior block of world 3C; stats: STAT ids in a top group"""
    kids = []
    for cid, groups in cells.items():
        kids.append(rec(b'CELL', cid, sub(b'DATA', b'\x02\x00')))
        kids.append(grp(cid, 6, *[grp(cid, t, *rs) for t, rs in sorted(groups.items())]))
    world = grp(0x4C525757, 0, rec(b'WRLD', WRLD, sub(b'EDID', b'W\0')), grp(WRLD, 1, grp(0, 4, grp(0, 5, *kids))))
    if stats:
        world = grp(0x54415453, 0, *[rec(b'STAT', x, sub(b'EDID', b'S\0')) for x in stats]) + world
    n = 0
    i = 0
    while i < len(world):                                       # count records and groups the honest way
        size = struct.unpack_from('<I', world, i + 4)[0]
        n += 1
        i += 24 if world[i:i + 4] == b'GRUP' else 24 + size
    head = sub(b'HEDR', struct.pack('<fiI', 1.7, n, next_id))
    for m in masters:
        head += sub(b'MAST', m.encode() + b'\0') + sub(b'DATA', b'\0' * 8)
    with open(path, 'wb') as fh:
        fh.write(rec(b'TES4', 0, head) + world)


def run(*args):
    r = subprocess.run([sys.executable, os.path.join(HERE, 'dle_graft.py'), *args], capture_output=True, text=True)
    return r.returncode, r.stdout + r.stderr


def check(base, src, out, n, *extra):
    r = subprocess.run([sys.executable, os.path.join(HERE, 'dle_graft_check.py'), base, src, out, '--expect', str(n), *extra],
                       capture_output=True, text=True)
    return r.returncode, r.stdout


tmp = tempfile.mkdtemp(prefix='claude-nate-graft-test-')
try:
    base, src = os.path.join(tmp, 'base.esp'), os.path.join(tmp, 'src.esp')
    b800, b801 = refr(0x01000800, 1.0), refr(0x01000801, 2.0)
    plugin(base, {CELL_A: {9: [b800]}, CELL_B: {8: [b801]}}, 0x000802)
    plugin(src, {
        CELL_A: {9: [refr(0x01000800, 99.0),                 # the source moved a base ref: never taken
                     refr(0x01000802, 3.0), refr(0x01000804, 4.0, D.DELETED),
                     refr(0x00000900, 5.0), refr(0x00000901, 6.0, D.DELETED)]},
        CELL_B: {8: [b801], 9: [refr(0x01000803, 7.0)]},     # B has no temporary group in the base
    }, 0x000805)
    B, S = D.Plugin(base), D.Plugin(src)

    take, junk, _ = D.candidates(B, S)
    ok(sorted(r[0] for r in take) == [0x01000802, 0x01000803], 'default: the new live refs of its own only', [hex(r[0]) for r in take])
    ok([r[0] for r in junk] == [0x01000804], 'a new ref of its own flagged Deleted is junk, never taken')
    ok(sorted(r[0] for r in D.candidates(B, S, True)[0]) == [0x00000900, 0x01000802, 0x01000803], '--overrides adds the live override of a master ref')
    ok(sorted(r[0] for r in D.candidates(B, S, True, True)[0]) == [0x00000900, 0x00000901, 0x01000802, 0x01000803], '--deleted adds the Deleted override too')

    out = os.path.join(tmp, 'out.esp')
    rc, text = run(base, src, out)
    ok(rc == 0 and os.path.exists(out), 'the default graft is written and verified', text)
    O = D.Plugin(out)
    ok(O.bytes_of(next(r for r in O.records if r[0] == 0x01000800)) == b800, "the base's own copy of a ref the source moved is kept")
    paths = {r[0]: r[5] for r in O.records}
    ok(paths[0x01000803][-1] == (9, CELL_B) and paths[0x01000802][-1] == (9, CELL_A), 'each ref is in its cell\'s temporary group')
    kids_b = [k for k in O.groups if len(k) == len(paths[0x01000803]) and k[:-1] == paths[0x01000803][:-1]]
    ok([k[-1][0] for k in sorted(kids_b, key=lambda k: O.groups[k][0])] == [8, 9], 'a new temporary group follows the persistent one')
    ok(O.next_id == 0x000804, 'the next object id is past the new refs', hex(O.next_id))
    rc, text = check(base, src, out, 2)
    ok(rc == 0, 'dle_graft_check passes the graft', text)
    rc, text = check(base, src, out, 3)
    ok(rc == 1 and 'expected 3' in text, 'dle_graft_check fails a wrong count', text)
    rc, text = check(base, src, src, 4)
    ok(rc == 1 and 'changed' in text, 'dle_graft_check fails the source itself (a moved base ref)', text)

    out2 = os.path.join(tmp, 'out2.esp')
    rc, text = run(base, src, out2, '--overrides', '--deleted')
    O2 = D.Plugin(out2) if rc == 0 else None
    ok(rc == 0 and O2.next_id == 0x000804, '--overrides --deleted: written; an override does not move the next id', text)
    rc, text = check(base, src, out2, 4)
    ok(rc == 0 and 'flagged Deleted' in text, 'dle_graft_check passes it and notes the Deleted override', text)

    rc, text = run(base, src, os.path.join(tmp, 'x.esp'), '--deleted')
    ok(rc != 0 and '--deleted needs --overrides' in text, '--deleted alone is refused')
    rc, text = run(base, src, os.path.join(tmp, 'x.esp'), '--only', '01000804')
    ok(rc != 0 and 'not new live references' in text, '--only naming a Deleted ref is refused')
    rc, text = run(base, src, base)
    ok(rc != 0 and 'new file' in text, 'the output may not overwrite the base')

    src3 = os.path.join(tmp, 'src3.esp')
    plugin(src3, {CELL_A: {9: [b800]}, CELL_B: {8: [b801]}, CELL_C: {9: [refr(0x01000805, 8.0)]}}, 0x000806)
    rc, text = run(base, src3, os.path.join(tmp, 'x.esp'))
    ok(rc != 0 and 'graft refused' in text, 'a ref in a cell the base does not have is refused')

    src4 = os.path.join(tmp, 'src4.esp')
    plugin(src4, {CELL_A: {9: [b800, refr(0x01000802, 3.0, base=0x01000999)]}, CELL_B: {8: [b801]}}, 0x000803)
    rc, text = run(base, src4, os.path.join(tmp, 'x.esp'))
    ok(rc == 1 and 'not in the output' in text and not os.path.exists(os.path.join(tmp, 'x.esp')),
       'a ref naming a base object of its own that the output lacks is refused, and nothing is written', text)

    # --disable-deleted: base masters Skyrim, Extra, Update. The Skyrim ref 901 is overridden by Update (moved, its base
    # object Update's own F01, which is index 1 in Update and index 2 in the base); the source deletes it
    data = os.path.join(tmp, 'Data')
    os.mkdir(data)
    xs = sub(b'XSCL', struct.pack('<f', 1.5))
    def ref(fid, x, base_, extra=b''):
        return rec(b'REFR', fid, sub(b'NAME', struct.pack('<I', base_)) + sub(b'DATA', struct.pack('<6f', x, 0, 0, 0, 0, 0)) + extra)
    plugin(os.path.join(data, 'Skyrim.esm'), {CELL_A: {9: [ref(0x00000901, 6.0, 0x00000F00), ref(0x00000902, 6.5, 0x00000F00, sub(b'VMAD', b'\0' * 8))]}},
           0x000903, masters=(), stats=(0x00000F00,))
    plugin(os.path.join(data, 'Extra.esm'), {}, 0x000800, masters=('Skyrim.esm',))
    plugin(os.path.join(data, 'Update.esm'), {CELL_A: {9: [ref(0x00000901, 60.0, 0x01000F01, xs)]}}, 0x000F02,
           masters=('Skyrim.esm',), stats=(0x01000F01,))
    M3 = ('Skyrim.esm', 'Extra.esm', 'Update.esm')
    base3, src3 = os.path.join(tmp, 'base3.esp'), os.path.join(tmp, 'src3d.esp')
    plugin(base3, {CELL_A: {9: [refr(0x03000800, 1.0)]}}, 0x000801, masters=M3)
    plugin(src3, {CELL_A: {9: [refr(0x03000800, 1.0), refr(0x03000801, 2.0),
                               rec(b'REFR', 0x00000901, sub(b'NAME', struct.pack('<I', 0x02000F01)), D.DELETED),
                               rec(b'REFR', 0x00000902, sub(b'NAME', struct.pack('<I', 0x00000F00)), D.DELETED)]}},
           0x000802, masters=M3)
    out3 = os.path.join(tmp, 'out3.esp')
    rc, text = run(base3, src3, out3, '--overrides', '--disable-deleted', '--data', data, '--only', '03000801,00000901')
    ok(rc == 0, '--disable-deleted writes the graft', text)
    O3 = D.Plugin(out3) if rc == 0 else None
    r901 = next((r for r in O3.records if r[0] == 0x00000901), None) if O3 else None
    if r901:
        body = dict(D.subrecords(O3.bytes_of(r901)))
        ok(r901[2] == D.DISABLED, 'the override is Initially Disabled and not Deleted', hex(r901[2]))
        ok(struct.unpack('<f', body[b'DATA'][:4])[0] == 60.0 and body.get(b'XSCL') == struct.pack('<f', 1.5),
           "it is the winning master's record (Update.esm's, moved and scaled), in place", body)
        ok(struct.unpack('<I', body[b'NAME'])[0] == 0x02000F01, "its base object is mapped from Update.esm's numbering to the base's",
           hex(struct.unpack('<I', body[b'NAME'])[0]))
    else:
        ok(False, 'the disabled override is in the output')
    rc, text = check(base3, src3, out3, 2, '--expect-disabled', '1', '--data', data)
    ok(rc == 0 and 'disabled: 1' in text and "'update.esm': 1" in text, 'dle_graft_check proves it against the master', text)
    rc, text = check(base3, src3, out3, 2, '--data', data)
    ok(rc == 1 and 'expected 0' in text, 'dle_graft_check fails it when no disabled override is expected', text)
    rc, text = run(base3, src3, os.path.join(tmp, 'x.esp'), '--overrides', '--disable-deleted', '--data', data, '--only', '00000902')
    ok(rc != 0 and 'VMAD' in text and 'graft refused' in text, 'a master record with a subrecord it cannot map is refused', text)
    rc, text = run(base3, src3, os.path.join(tmp, 'x.esp'), '--overrides', '--disable-deleted')
    ok(rc != 0 and 'needs --overrides and --data' in text, '--disable-deleted without --data is refused')

    # (H-L1review a) at one offset: records appended to the group that ends there go inside it, a new sibling group after
    base5, src5 = os.path.join(tmp, 'base5.esp'), os.path.join(tmp, 'src5.esp')
    plugin(base5, {CELL_A: {9: [b800]}, CELL_B: {8: [b801]}}, 0x000802)
    plugin(src5, {CELL_A: {9: [b800]}, CELL_B: {8: [b801, refr(0x01000806, 9.0)], 9: [refr(0x01000807, 10.0)], 10: [refr(0x01000808, 11.0)]}}, 0x000809)
    B5, S5 = D.Plugin(base5), D.Plugin(src5)
    take5, ins5, ng5 = D.plan(B5, S5, None)
    ok(len({k[0] for k in ins5}) == 1 and len(ins5) == 3, 'the three inserts share one offset (the end of the cell)', list(ins5))
    for name, ins in (('source order', ins5), ('reversed', dict(reversed(list(ins5.items()))))):
        o5 = os.path.join(tmp, f'o5-{len(name)}.esp')
        with open(o5, 'wb') as fh:
            fh.write(D.build(B5, take5, ins, ng5))
        try:
            O5 = D.Plugin(o5)
            p5 = {r[0]: r[5][-1] for r in O5.records}
            got = (p5[0x01000806], p5[0x01000807], p5[0x01000808])
            ok(got == ((8, CELL_B), (9, CELL_B), (10, CELL_B)), f'{name}: each ref lands in its own group, nested to the byte', got)
            cellkids = sorted((O5.groups[k][0], k[-1][0]) for k in O5.groups if k[-1][1] == CELL_B and k[-1][0] in (8, 9, 10))
            ok([t for _, t in cellkids] == [8, 9, 10], f'{name}: the cell\'s groups in type order', cellkids)
        except SystemExit as e:
            ok(False, f'{name}: the output parses', str(e))

    # (b) a verify that cannot parse its output leaves no .part behind
    real_build = D.build
    D.build = lambda *a_: real_build(*a_)[:-10]
    argv = sys.argv
    out6 = os.path.join(tmp, 'out6.esp')
    sys.argv = ['dle_graft.py', base, src, out6]
    try:
        D.main(); ok(False, 'a truncated output is refused')
    except SystemExit:
        ok(not os.path.exists(out6 + '.part') and not os.path.exists(out6), 'a truncated output is refused, and its .part removed')
    finally:
        D.build, sys.argv = real_build, argv

    # (c) a compressed source record; (d) own ids beyond the first, and layouts it cannot read
    def refused(cells, expect, what):
        sp = os.path.join(tmp, 'srcx.esp')
        plugin(sp, {**{CELL_A: {9: [b800]}, CELL_B: {8: [b801]}}, **cells}, 0x000A00)
        if os.path.exists(os.path.join(tmp, 'x.esp')):
            os.remove(os.path.join(tmp, 'x.esp'))
        rc, text = run(base, sp, os.path.join(tmp, 'x.esp'))
        ok(rc != 0 and expect in text and not os.path.exists(os.path.join(tmp, 'x.esp')), what, text)
    comp = refr(0x01000809, 1.0)
    comp = comp[:8] + struct.pack('<I', D.COMPRESSED) + comp[12:]
    refused({CELL_A: {9: [b800, comp]}}, 'compressed in the source', 'a compressed source record is refused before anything is built')
    xlkr = sub(b'XLKR', struct.pack('<II', 0x00000F00, 0x01000999))
    refused({CELL_A: {9: [b800, rec(b'REFR', 0x01000809, sub(b'NAME', struct.pack('<I', 0xF00)) + sub(b'DATA', b'\0' * 24) + xlkr)]}},
            'XLKR names 01000999', 'an own id in the second half of an XLKR is checked')
    xloc = sub(b'XLOC', struct.pack('<B3xI3x8x', 1, 0x01000998))
    refused({CELL_A: {9: [b800, rec(b'REFR', 0x01000809, sub(b'NAME', struct.pack('<I', 0xF00)) + sub(b'DATA', b'\0' * 24) + xloc)]}},
            'XLOC names 01000998', "an own id as an XLOC's key is checked")
    xapr = sub(b'XAPR', struct.pack('<If', 0x01000801, 0.0)) + sub(b'XAPR', struct.pack('<If', 0x01000997, 0.0))
    refused({CELL_A: {9: [b800, rec(b'REFR', 0x01000809, sub(b'NAME', struct.pack('<I', 0xF00)) + sub(b'DATA', b'\0' * 24) + xapr)]}},
            'XAPR names 01000997', 'every XAPR is checked')
    refused({CELL_A: {9: [b800, rec(b'REFR', 0x01000809, sub(b'NAME', struct.pack('<I', 0xF00)) + sub(b'DATA', b'\0' * 24) + sub(b'ZZZZ', b'\0' * 4))]}},
            'no known layout', 'a subrecord of no known layout is refused')
    refused({CELL_A: {9: [b800, rec(b'REFR', 0x01000809, sub(b'VMAD', b'\0' * 6) + sub(b'NAME', struct.pack('<I', 0xF00)) + sub(b'DATA', b'\0' * 24))]}},
            'VMAD', 'a script (VMAD) is refused')
    sp = os.path.join(tmp, 'srcok.esp')
    plugin(sp, {CELL_A: {9: [b800, rec(b'REFR', 0x01000809, sub(b'NAME', struct.pack('<I', 0xF00)) + sub(b'DATA', b'\0' * 24) + sub(b'XAPR', struct.pack('<If', 0x01000800, 0.0)))]}, CELL_B: {8: [b801]}}, 0x000A00)
    rc, text = run(base, sp, os.path.join(tmp, 'ok.esp'))
    ok(rc == 0, 'an XAPR naming a record the output has is fine', text)

    # (e) --disable-deleted refuses a master record with an enable parent
    plugin(os.path.join(data, 'Skyrim.esm'), {CELL_A: {9: [ref(0x00000901, 6.0, 0x00000F00), ref(0x00000902, 6.5, 0x00000F00, sub(b'VMAD', b'\0' * 8)),
                                                        ref(0x00000903, 7.5, 0x00000F00, sub(b'XESP', struct.pack('<IB3x', 0x00000901, 0)))]}},
           0x000904, masters=(), stats=(0x00000F00,))
    src7 = os.path.join(tmp, 'src7.esp')
    plugin(src7, {CELL_A: {9: [refr(0x03000800, 1.0), rec(b'REFR', 0x00000903, sub(b'NAME', struct.pack('<I', 0x00000F00)), D.DELETED)]}}, 0x000801, masters=M3)
    rc, text = run(base3, src7, os.path.join(tmp, 'x.esp'), '--overrides', '--disable-deleted', '--data', data)
    ok(rc != 0 and 'enable parent' in text, '--disable-deleted refuses a master ref with an enable parent (XESP)', text)

    # ---- --manifest: a new interior with its navmesh and NVMI, terrain, CELL overrides from the master, ACHR disables
    import json, zlib
    def crec(sig, fid, body, flags=0):            # a compressed record
        z = struct.pack('<I', len(body)) + zlib.compress(body)
        return sig + struct.pack('<IIIII', len(z), flags | 0x40000, fid, 0, 44) + z
    def head_plugin(path, masters, next_id, tops):
        allb = b''.join(tops)
        n, i = 0, 0
        while i < len(allb):
            n += 1
            i += 24 if allb[i:i + 4] == b'GRUP' else 24 + struct.unpack_from('<I', allb, i + 4)[0]
        h = sub(b'HEDR', struct.pack('<fiI', 1.7, n, next_id))
        for m in masters:
            h += sub(b'MAST', m.encode() + b'\0') + sub(b'DATA', b'\0' * 8)
        with open(path, 'wb') as fh:
            fh.write(rec(b'TES4', 0, h) + allb)
    def nvmi(nav, cell):
        return struct.pack('<II3fI', nav, 0, 0, 0, 0, 0) + struct.pack('<III', 0, 0, 0) + b'\0' + struct.pack('<III', 0, 0, cell)
    def navi(*entries):
        return rec(b'NAVI', 0x00012FB4, sub(b'NVER', struct.pack('<I', 12)) + b''.join(sub(b'NVMI', e) for e in entries) + sub(b'NVPP', struct.pack('<II', 0, 0)))
    def nvnm(cell, door):
        return (struct.pack('<IIII', 12, 0, 0, cell) + struct.pack('<III', 0, 0, 0) + struct.pack('<I', 1) + struct.pack('<hII', 0, 0, door)
                + struct.pack('<I', 0) + struct.pack('<I', 0) + b'\0' * 32)
    def vmad(target):
        return struct.pack('<hhH', 5, 2, 1) + struct.pack('<H', 1) + b'S' + b'\0' + struct.pack('<H', 1) + struct.pack('<H', 1) + b'P' + bytes([1, 1]) + struct.pack('<HhI', 0, -1, target)
    def mref(fid, x, base_, *extra, flags=0):
        return rec(b'REFR', fid, sub(b'NAME', struct.pack('<I', base_)) + b''.join(extra) + sub(b'DATA', struct.pack('<6f', x, 0, 0, 0, 0, 0)), flags)
    def ext_world(cells):
        kids = b''.join(c for c in cells)
        return grp(0x4C525757, 0, rec(b'WRLD', WRLD, sub(b'EDID', b'W\0')), grp(WRLD, 1, grp(0, 4, grp(0, 5, kids))))
    def ext_cell(cid, body, groups):
        return rec(b'CELL', cid, body) + grp(cid, 6, *[grp(cid, t, *rs) for t, rs in sorted(groups.items())])
    def interior(*cells):
        return grp(0x4C4C4543, 0, grp(0, 2, grp(0, 3, *cells)))
    XCLR_M = sub(b'XCLR', struct.pack('<II', 0x00000500, 0x00000501))
    md = os.path.join(tmp, 'MData'); os.mkdir(md)
    REG = rec(b'REGN', 0x500, b'') + rec(b'REGN', 0x501, b'')
    LAND_M = rec(b'LAND', 0x210, sub(b'DATA', b'\0' * 4) + sub(b'BTXT', struct.pack('<IBBh', 0, 0, 0, 0)))
    head_plugin(os.path.join(md, 'Skyrim.esm'), (), 0x1000, [
        grp(0x54415453, 0, rec(b'STAT', 0xF00, b''), rec(b'STAT', 0xF01, b'')), grp(0x4E474552, 0, REG), grp(0x5F43504E, 0, rec(b'NPC_', 0xF10, b'')),
        ext_world([ext_cell(0x100, sub(b'DATA', b'\2\0'), {9: [mref(0x900, 1.0, 0xF00)]}),
                   ext_cell(0x200, sub(b'DATA', b'\2\0') + XCLR_M, {9: [LAND_M, mref(0x901, 2.0, 0xF00, sub(b'XSCL', struct.pack('<f', 1.5))),
                                                                            rec(b'ACHR', 0x902, sub(b'NAME', struct.pack('<I', 0xF10)) + sub(b'XESP', struct.pack('<II', 0x900, 0)) + sub(b'DATA', b'\0' * 24)),
                                                                            mref(0x903, 3.0, 0xF00)]})])])
    own = 0x01000000
    base_cellA = ext_cell(0x100, sub(b'DATA', b'\2\0'), {9: [mref(own | 0x600, 5.0, 0xF00)]})
    base_int = rec(b'CELL', own | 0x700, sub(b'EDID', b'Old\0') + sub(b'DATA', b'\1\0')) + grp(own | 0x700, 6, grp(own | 0x700, 9, mref(own | 0x701, 0.0, 0xF00)))
    N1, N2 = nvmi(0x00000990, 0x100), nvmi(0x00000991, 0x100)
    b6 = os.path.join(tmp, 'b6.esp'); s6 = os.path.join(tmp, 's6.esp')
    head_plugin(b6, ('Skyrim.esm',), 0x000800, [interior(base_int), ext_world([base_cellA]), grp(0x4956414E, 0, navi(N2, N1))])
    NEWCELL = crec(b'CELL', own | 0x800, sub(b'EDID', b'NewMine\0') + sub(b'DATA', b'\1\0'))
    NAVM = crec(b'NAVM', own | 0x803, sub(b'NVNM', nvnm(own | 0x800, own | 0x801)))
    new_int = NEWCELL + grp(own | 0x800, 6, grp(own | 0x800, 8, mref(own | 0x801, 0.0, 0xF01, sub(b'XTEL', struct.pack('<I', own | 0x802) + b'\0' * 28))),
                            grp(own | 0x800, 9, NAVM, mref(own | 0x804, 1.0, 0xF00, sub(b'VMAD', vmad(own | 0x801)))))
    src_cellA = ext_cell(0x100, sub(b'DATA', b'\2\0'), {9: [mref(own | 0x600, 5.0, 0xF00), mref(own | 0x802, 9.0, 0xF01, sub(b'XTEL', struct.pack('<I', own | 0x801) + b'\0' * 28))]})
    LAND_S = crec(b'LAND', 0x210, sub(b'DATA', b'\1\0\0\0') + sub(b'BTXT', struct.pack('<IBBh', 0, 0, 0, 0)))
    src_cellB = ext_cell(0x200, sub(b'DATA', b'\2\0') + sub(b'XCLR', struct.pack('<II', 0x501, 0x500)),     # the re-save swapped the regions
                         {9: [LAND_S, mref(0x901, 2.5, 0xF00, sub(b'XLRL', struct.pack('<I', 0x500)), sub(b'XSCL', struct.pack('<f', 1.5))),
                              rec(b'ACHR', 0x902, sub(b'NAME', struct.pack('<I', 0xF10)), D.DELETED), rec(b'REFR', 0x903, sub(b'NAME', struct.pack('<I', 0xF00)), D.DELETED),
                              mref(own | 0x805, 4.0, 0xF00)]})
    N3 = nvmi(own | 0x803, own | 0x800)
    head_plugin(s6, ('Skyrim.esm',), 0x000806, [interior(base_int, new_int), ext_world([src_cellA, src_cellB]), grp(0x4956414E, 0, navi(N2, N3, N1))])
    man = {'copy': ['01000800', '01000801', '01000802', '01000803', '01000804', '01000805', '00000210'], 'master': ['00000200'],
           'master_with': {'00000901': ['DATA']}, 'disable': ['00000903'], 'disable_drop_parent': ['00000902'],
           'patch': {'01000600': {'data': [7.0, 0, 0, 0, 0, 0], 'flags_or': 2048}}, 'navi_add': ['01000803']}
    mp = os.path.join(tmp, 'm6.json'); json.dump(man, open(mp, 'w'))
    o6 = os.path.join(tmp, 'o6.esp')
    r = subprocess.run([sys.executable, os.path.join(HERE, 'dle_graft.py'), '--manifest', mp, b6, s6, o6, '--data', md], capture_output=True, text=True)
    ok(r.returncode == 0, 'manifest: the graft is written and verified', r.stdout + r.stderr)
    if r.returncode == 0:
        O6, S6 = D.Plugin(o6), D.Plugin(s6)
        by = {x[0]: x for x in O6.records}
        sby = {x[0]: x for x in S6.records}
        ok(all(O6.bytes_of(by[f]) == S6.bytes_of(sby[f]) and by[f][5] == sby[f][5] for f in (own | 0x800, own | 0x803, 0x210)),
           'the new interior CELL, its NAVM and the LAND stay byte-identical (compressed) in the source\'s groups')
        ok(by[own | 0x800][5] == ((0, 0x4C4C4543), (2, 0), (3, 0)) and (by[own | 0x801][5][-1], by[own | 0x804][5][-1]) == ((8, own | 0x800), (9, own | 0x800)),
           'the interior cell sits in the sub-block, its refs in its new persistent and temporary groups')
        kids = sorted((O6.groups[k][0], k[-1]) for k in O6.groups if len(k) == 4 and k[:3] == ((0, 0x4C4C4543), (2, 0), (3, 0)))
        ok([k for _, k in kids] == [(6, own | 0x700), (6, own | 0x800)] and O6.groups[((0, 0x4C4C4543), (2, 0), (3, 0), (6, own | 0x800))][0] == by[own | 0x800][3] + by[own | 0x800][4],
           'its Cell Children group follows its CELL record, after the old cell', kids)
        import dle_layouts as LL
        cellb = LL.unpack(O6.bytes_of(by[0x200]))[1]
        ok(dict((s_, v) for s_, _, v in LL.subs(cellb)).get(b'XCLR') == struct.pack('<II', 0x500, 0x501), "the CELL override is the master's (the regions in its order), not the re-save")
        t = dict((s_, v) for s_, _, v in LL.subs(LL.unpack(O6.bytes_of(by[0x901]))[1]))
        ok(struct.unpack('<f', t[b'DATA'][:4])[0] == 2.5 and b'XLRL' not in t and t.get(b'XSCL') == struct.pack('<f', 1.5), 'master_with: the source\'s DATA on the master record, without the XLRL', t)
        a2 = dict((s_, v) for s_, _, v in LL.subs(LL.unpack(O6.bytes_of(by[0x902]))[1]))
        ok(by[0x902][2] & D.DISABLED and not by[0x902][2] & D.DELETED and b'XESP' not in a2 and by[0x902][1] == 'ACHR', 'an ACHR comes over Initially Disabled with its enable parent dropped')
        ok(by[0x903][2] & D.DISABLED and not by[0x903][2] & D.DELETED, 'a deleted REFR comes over Initially Disabled')
        p6 = dict((s_, v) for s_, _, v in LL.subs(LL.unpack(O6.bytes_of(by[own | 0x600]))[1]))
        ok(struct.unpack('<f', p6[b'DATA'][:4])[0] == 7.0 and by[own | 0x600][2] & D.DISABLED, 'a patch moves and disables a base record in place')
        nv = [LL.nvmi(v)[0] for s_, _, v in LL.subs(LL.unpack(O6.bytes_of(by[0x12FB4]))[1]) if s_ == b'NVMI']
        ok(nv == [0x991, own | 0x803, 0x990], 'NAVI: the new NVMI goes after the entry the source has before it, the rest in the base\'s order', ['%08X' % x for x in nv])
        lg = [x for x in O6.records if x[5] and x[5][-1] == (9, 0x200)]
        ok([x[1] for x in lg][:1] == ['LAND'], 'the LAND is first in its cell\'s group')
        c6 = subprocess.run([sys.executable, os.path.join(HERE, 'dle_graft_check.py'), '--manifest', mp, b6, s6, o6, '--data', md, '--live', b6, '--live-expect', '11'], capture_output=True, text=True)
        ok(c6.returncode == 0, 'dle_graft_check --manifest proves it', c6.stdout + c6.stderr)
        # the checker catches a tampered NVMI and a planned record left out
        bad = bytearray(open(o6, 'rb').read()); i = bytes(bad).index(N1); bad[i + 8] ^= 1
        open(o6 + '.bad', 'wb').write(bad)
        c7 = subprocess.run([sys.executable, os.path.join(HERE, 'dle_graft_check.py'), '--manifest', mp, b6, s6, o6 + '.bad', '--data', md], capture_output=True, text=True)
        ok(c7.returncode == 1 and 'NAVI' in c7.stdout, 'dle_graft_check fails a NAVI with another entry changed', c7.stdout)
        man2 = dict(man); man2['copy'] = man['copy'][:-1]; mp2 = os.path.join(tmp, 'm7.json'); json.dump(man2, open(mp2, 'w'))
        c8 = subprocess.run([sys.executable, os.path.join(HERE, 'dle_graft_check.py'), '--manifest', mp2, b6, s6, o6, '--data', md], capture_output=True, text=True)
        ok(c8.returncode == 1 and 'added' in c8.stdout, 'dle_graft_check fails a record the manifest does not name', c8.stdout)
    for what, change, expect in (("a 'disable' of a master record with an enable parent", {'disable': ['00000903', '00000902'], 'disable_drop_parent': []}, 'enable parent'),
                                 ('a copy of a record the base has', {'copy': man['copy'] + ['01000600']}, 'already has it'),
                                 ('a NVMI the source lacks', {'navi_add': ['01000999']}, 'no NVMI')):
        m3 = dict(man); m3.update(change); mp3 = os.path.join(tmp, 'm8.json'); json.dump(m3, open(mp3, 'w'))
        r = subprocess.run([sys.executable, os.path.join(HERE, 'dle_graft.py'), '--manifest', mp3, b6, s6, os.path.join(tmp, 'x6.esp'), '--data', md], capture_output=True, text=True)
        if expect:
            ok(r.returncode != 0 and expect in (r.stdout + r.stderr) and not os.path.exists(os.path.join(tmp, 'x6.esp')), f'manifest: {what} is refused', r.stdout + r.stderr)
finally:
    shutil.rmtree(tmp, ignore_errors=True)

print('all passed' if not fails else f'{fails} failed')
sys.exit(1 if fails else 0)
