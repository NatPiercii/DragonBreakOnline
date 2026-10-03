#!/usr/bin/env python3
"""Self-test for dle_graft.py on small plugins built here: what it takes, where it puts it, what it refuses.

    python3 tools/alpha/test_dle_graft.py

The plugins are written under /tmp/claude-nate-graft-test-* and removed afterwards; no real plugin is read. Each graft is
then proved by dle_graft_check.py, so this also tests the proof.
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


def plugin(path, cells, next_id):
    """cells: {cell id: {group type: [record bytes]}} in one exterior block of world 3C"""
    kids = []
    for cid, groups in cells.items():
        kids.append(rec(b'CELL', cid, sub(b'DATA', b'\x02\x00')))
        kids.append(grp(cid, 6, *[grp(cid, t, *rs) for t, rs in sorted(groups.items())]))
    world = grp(0x4C525757, 0, rec(b'WRLD', WRLD, sub(b'EDID', b'W\0')), grp(WRLD, 1, grp(0, 4, grp(0, 5, *kids))))
    n = 0
    i = 0
    while i < len(world):                                       # count records and groups the honest way
        size = struct.unpack_from('<I', world, i + 4)[0]
        n += 1
        i += 24 if world[i:i + 4] == b'GRUP' else 24 + size
    head = sub(b'HEDR', struct.pack('<fiI', 1.7, n, next_id)) + sub(b'MAST', b'Skyrim.esm\0') + sub(b'DATA', b'\0' * 8)
    with open(path, 'wb') as fh:
        fh.write(rec(b'TES4', 0, head) + world)


def run(*args):
    r = subprocess.run([sys.executable, os.path.join(HERE, 'dle_graft.py'), *args], capture_output=True, text=True)
    return r.returncode, r.stdout + r.stderr


def check(base, src, out, n):
    r = subprocess.run([sys.executable, os.path.join(HERE, 'dle_graft_check.py'), base, src, out, '--expect', str(n)],
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
finally:
    shutil.rmtree(tmp, ignore_errors=True)

print('all passed' if not fails else f'{fails} failed')
sys.exit(1 if fails else 0)
