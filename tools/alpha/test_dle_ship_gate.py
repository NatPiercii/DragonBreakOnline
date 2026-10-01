#!/usr/bin/env python3
"""Self-test for dle_ship_gate.py: the live DLE and v8 pass; a copy of v8 broken in one way at a time fails on that check.

    python3 tools/alpha/test_dle_ship_gate.py [--v8 <esp>]

Each broken copy is v8 with a few bytes changed in place (a record's flags, a border point, a region link), written
under /tmp/claude-nate-gate-*, removed afterwards. Read only on every real plugin.
"""
import argparse, os, shutil, struct, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import dle_ship_gate as G  # noqa: E402

LIVE = '/opt/skyrim-data/DragonBreak Online Edits.esp'
fails = 0


def ok(cond, what, got=''):
    global fails
    print(('ok   ' if cond else 'FAIL ') + what + ('' if cond else f'   {got}'))
    fails += 0 if cond else 1


def gate(esp):
    r = subprocess.run([sys.executable, os.path.join(HERE, 'dle_ship_gate.py'), esp], capture_output=True, text=True)
    return r.returncode, [l for l in r.stdout.splitlines() if l.startswith('FAIL ')]


def mutate(src, dst, fn):
    shutil.copyfile(src, dst)
    e = G.Esp(src)
    with open(dst, 'r+b') as fh:
        fn(e, fh)


def set_flags(key, on=0, off=0):
    def fn(e, fh):
        t, fl, off_, sz = e.rec[key]
        fh.seek(off_ - 16)                       # the record header's flags: 8 bytes into the 24-byte header
        fh.write(struct.pack('<I', (fl | on) & ~off))
    return fn


def swap_border_points(e, fh):
    t, fl, off, sz = e.rec[G.BORDER]
    body = e.raw(G.BORDER)
    at = body.index(b'RPLD') + 6                 # the first point's 8 bytes, then the second's
    fh.seek(off + at)
    fh.write(body[at + 8:at + 16] + body[at:at + 8])


def navi_entry(e, want_island=False):
    """(file offset of the record data, offset of an NVMI's data inside it, its parsed fields and form-id offsets)"""
    import navi_info
    t, fl, off, sz = e.rec[G.NAVI]
    body = e.raw(G.NAVI)
    i = 0
    while i < len(body):
        sig, n = body[i:i + 4], struct.unpack_from('<H', body, i + 4)[0]
        if sig == b'NVMI':
            f, ids = navi_info.parse_nvmi(body[i + 6:i + 6 + n])
            if f['island'] or not want_island:
                return off, i + 6, f, ids, body[i + 6:i + 6 + n]
        i += 6 + n
    raise AssertionError('no NVMI')


def navi_drop_entry(e, fh):                      # the entry now names another navmesh: the live one is missing
    off, at, f, ids, v = navi_entry(e)
    fh.seek(off + at)
    fh.write(struct.pack('<I', f['navmesh'] ^ 0x7FFF))


def navi_relink(e, fh):                          # the entry's cell or worldspace points elsewhere
    off, at, f, ids, v = navi_entry(e)
    o = ids[-1]
    fh.seek(off + at + o)
    fh.write(struct.pack('<I', struct.unpack_from('<I', v, o)[0] ^ 0x1))


def navi_island_geometry(e, fh):                 # a float of the island bounds nudged, as a CK re-save does
    off, at, f, ids, v = navi_entry(e, want_island=True)
    start = 4 + 4 + 12 + 4                       # navmesh, flags, x/y/z, merges flag
    for key in ('merged', 'pref'):
        start += 4 + 4 * len(f[key])
    start += 4 + 8 * len(f['doors']) + 1         # doors, then the isIsland byte: the bounds start here
    x = struct.unpack_from('<f', v, start)[0]
    fh.seek(off + at + start)
    fh.write(struct.pack('<f', x + 2.0))


def rebuild_nvmi(src, dst, change):
    """Writes dst = src with one NVMI entry replaced by change(fields, bytes) -> new bytes or None (skip to the next
    entry); the record's and the NAVI group's sizes follow"""
    import navi_info
    e = G.Esp(src)
    t, fl, off, sz = e.rec[G.NAVI]
    assert not fl & 0x40000
    buf = bytearray(open(src, 'rb').read())
    body = bytes(buf[off:off + sz])
    out, i, done = [], 0, False
    while i < len(body):
        sig, n = body[i:i + 4], struct.unpack_from('<H', body, i + 4)[0]
        v = body[i + 6:i + 6 + n]
        if sig == b'NVMI' and not done:
            w = change(navi_info.parse_nvmi(v)[0], v)
            if w is not None:
                v, done = w, True
        out.append(sig + struct.pack('<H', len(v)) + v)
        i += 6 + n
    assert done, 'no entry to change'
    data = b''.join(out)
    p = buf.rfind(b'GRUP', 0, off)
    while bytes(buf[p + 8:p + 12]) != b'NAVI':
        p = buf.rfind(b'GRUP', 0, p)
    struct.pack_into('<I', buf, p + 4, struct.unpack_from('<I', buf, p + 4)[0] + len(data) - sz)
    struct.pack_into('<I', buf, off - 20, len(data))
    buf[off:off + sz] = data
    open(dst, 'wb').write(buf)


def nvmi_layout(f):
    """Offsets inside an NVMI: (edge count, island flag)"""
    edge_at = 4 + 4 + 12 + 4
    island_at = edge_at + 4 + 4 * len(f['merged']) + 4 + 4 * len(f['pref']) + 4 + 8 * len(f['doors'])
    return edge_at, island_at


def grid_x_plus_one(f, v):                       # an exterior entry's grid X moves one cell
    if f['world'] == 0:
        return None
    y, x = struct.unpack_from('<hh', v, len(v) - 4)
    return v[:-4] + struct.pack('<hh', y, x + 1)


def edge_to_preferred(f, v):                     # the last edge link becomes a preferred edge link
    if not f['merged'] or f['pref']:
        return None
    edge_at, _ = nvmi_layout(f)
    k = len(f['merged'])
    last = v[edge_at + 4 * k:edge_at + 4 + 4 * k]
    after = edge_at + 4 + 4 * k + 4               # past the edge list and the (empty) preferred count
    return v[:edge_at] + struct.pack('<I', k - 1) + v[edge_at + 4:edge_at + 4 * k] + struct.pack('<I', 1) + last + v[after:]


def island_flag_off(f, v):                       # Is Island cleared (and its island data with it)
    if not f['island']:
        return None
    _, at = nvmi_layout(f)
    return v[:at] + b'\x00' + v[at + 1 + len(f['islandData']):]


def unlink_border_cell(e, fh):
    for k in sorted(e.border_cells()):
        t, fl, off, sz = e.rec[k]
        if fl & 0x40000:
            continue                             # compressed: the next one
        body = e.raw(k)
        i = body.index(b'XCLR') + 6
        n = struct.unpack_from('<H', body, i - 2)[0] // 4
        for j in range(n):
            v = struct.unpack_from('<I', body, i + 4 * j)[0]
            if (v & 0xFFFFFF) == G.BORDER[1]:
                fh.seek(off + i + 4 * j)
                fh.write(struct.pack('<I', v ^ 0x000001))
                return
    raise SystemExit('no uncompressed border cell to break')


def main():
    ap = argparse.ArgumentParser()
    # A PC build that passes every check (DLE v9b), kept outside /tmp, which a reboot wipes (review G4)
    ap.add_argument('--candidate', '--v8', dest='v8',
                    default=os.path.expanduser('~nate/claude-nate-release/gate-fixtures/dle-v9b/DragonBreak Online Edits.esp'))
    a = ap.parse_args()
    rc, f = gate(LIVE)
    ok(rc == 0, 'the live DLE passes against itself', f)
    if not os.path.exists(a.v8):
        ok(False, f'the candidate build exists ({a.v8}); without it nothing below is tested')
        print(f'\n{fails} FAILED')
        return 1
    rc, f = gate(a.v8)
    ok(rc == 0, 'the candidate (DLE v9b) passes against live (its border is the live polygon wound the other way, its masters in another order)', f)
    me = G.Esp(a.v8).me
    cases = [
        ('a server-spawned goblin not Initially Disabled', set_flags((me, 0x154071), off=0x800), 'spawns:'),
        ('the bank Initially Disabled', set_flags((me, 0x1300C3), on=0x800), 'anchors: the bank'),
        ("a Daedric shrine deleted", set_flags((me, 0x125BCC), on=0x20), 'anchors: the shrine of Molag Bal'),
        ('the Aleswell map marker disabled', set_flags((me, 0x13F779), on=0x800), 'markers: 0 enabled map marker(s) for Aleswell'),
        ('two border points swapped', swap_border_points, 'border: REGN 0B0CBCDD is not the live border'),
        ('a border cell no longer on the border', unlink_border_cell, 'live border cell(s) missing'),
        ('a navmesh-info entry gone (a CK re-save)', navi_drop_entry, 'navmesh info: 1 live entry missing'),
        ('a navmesh-info entry relinked', navi_relink, 'navmesh info: 1 entry with other links'),
    ]
    d = tempfile.mkdtemp(prefix='claude-nate-gate-')
    try:
        for what, fn, expect in cases:
            dst = os.path.join(d, 'DragonBreak Online Edits.esp')
            mutate(a.v8, dst, fn)
            rc, f = gate(dst)
            ok(rc == 1 and any(expect in x for x in f), f'fails on {what}', f)
    finally:
        shutil.rmtree(d, ignore_errors=True)
    # entries rebuilt (their size changes): each is a real breakage and must fail (review G1)
    d = tempfile.mkdtemp(prefix='claude-nate-gate-')
    try:
        for what, change, expect in [
            ("an exterior entry's grid X + 1", grid_x_plus_one, 'cell or grid:'),
            ('an edge link moved into the preferred links', edge_to_preferred, 'preferred edge links:'),
            ('the Is Island flag cleared', island_flag_off, 'Is Island flag flipped'),
        ]:
            dst = os.path.join(d, 'DragonBreak Online Edits.esp')
            rebuild_nvmi(a.v8, dst, change)
            rc, f = gate(dst)
            ok(rc == 1 and any(expect in x for x in f), f'fails on {what}', f)
    finally:
        shutil.rmtree(d, ignore_errors=True)
    # recomputed island data alone passes, with a note
    d = tempfile.mkdtemp(prefix='claude-nate-gate-')
    try:
        dst = os.path.join(d, 'DragonBreak Online Edits.esp')
        mutate(a.v8, dst, navi_island_geometry)
        r = subprocess.run([sys.executable, os.path.join(HERE, 'dle_ship_gate.py'), dst], capture_output=True, text=True)
        ok(r.returncode == 0 and '1 with other island data' in r.stdout, 'passes on recomputed island data, and names it', r.stdout[-400:])
    finally:
        shutil.rmtree(d, ignore_errors=True)
    # the polygon comparison on its own
    pts = [struct.pack('<2f', x, y) for x, y in [(0, 0), (10, 0), (10, 10), (0, 10)]]
    sub = lambda ps: [(b'EDID', b'x\0'), (b'RPLD', b''.join(ps))]
    ok(G.same_region(sub(pts), sub(pts[2:] + pts[:2])), 'same_region: the same cycle from another start is the same border')
    ok(G.same_region(sub(pts), sub(pts[::-1])), 'same_region: the other winding is the same border')
    ok(not G.same_region(sub(pts), sub([pts[1], pts[0]] + pts[2:])), 'same_region: two points swapped is not')
    # a worldspace link named through each file's own master list (DLE v9 put BSHeartland at master 6, live at 11)
    w = lambda fid: [(b'EDID', b'x\0'), (b'WNAM', struct.pack('<I', fid)), (b'RPLD', b''.join(pts))]
    live_m = lambda fid: ({0x0B: 'bsheartland.esm', 0x06: 'ccqdrsse001-survivalmode.esl'}.get(fid >> 24, '?'), fid & 0xFFFFFF)
    v9_m = lambda fid: ({0x06: 'bsheartland.esm', 0x0B: 'ccqdrsse001-survivalmode.esl'}.get(fid >> 24, '?'), fid & 0xFFFFFF)
    ok(G.same_region(w(0x0B0A764B), w(0x060A764B), live_m, v9_m), 'same_region: the same worldspace through reordered masters is the same border')
    ok(not G.same_region(w(0x0B0A764B), w(0x0B0A764B), live_m, v9_m), 'same_region: the same bytes naming another plugin is not (live bytes copied into v9)')
    ok(not G.same_region(w(0x0B0A764B), w(0x060A764C), live_m, v9_m), 'same_region: another worldspace is not')
    ok(not G.same_region(w(0x0B0A764B), w(0x060A764B)), 'same_region: without master lists, bytes still have to match')
    print('\nall checks passed' if not fails else f'\n{fails} FAILED')
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
