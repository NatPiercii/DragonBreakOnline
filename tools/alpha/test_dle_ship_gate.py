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
    ap.add_argument('--v8', default='/tmp/claude-nate-v8flag/DragonBreak Online Edits.esp')
    a = ap.parse_args()
    rc, f = gate(LIVE)
    ok(rc == 0, 'the live DLE passes against itself', f)
    if not os.path.exists(a.v8):
        print(f'skip: no v8 at {a.v8}')
        return 1 if fails else 0
    rc, f = gate(a.v8)
    ok(rc == 0, 'DLE v8 passes against live (its border is the live polygon wound the other way)', f)
    me = G.Esp(a.v8).me
    cases = [
        ('a server-spawned goblin not Initially Disabled', set_flags((me, 0x154071), off=0x800), 'spawns:'),
        ('the bank Initially Disabled', set_flags((me, 0x1300C3), on=0x800), 'anchors: the bank'),
        ("a Daedric shrine deleted", set_flags((me, 0x125BCC), on=0x20), 'anchors: the shrine of Molag Bal'),
        ('the Aleswell map marker disabled', set_flags((me, 0x13F779), on=0x800), 'markers: 0 enabled map marker(s) for Aleswell'),
        ('two border points swapped', swap_border_points, 'border: REGN 0B0CBCDD is not the live border'),
        ('a border cell no longer on the border', unlink_border_cell, 'live border cell(s) missing'),
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
