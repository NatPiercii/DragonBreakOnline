#!/usr/bin/env python3
"""Checks for owned_spawns.py and spawns_gate.py against the real load order (reads /opt/skyrim-data, so run with sudo):

    sudo python3 tools/spawns/test_owned_spawns.py

1. The live order: no owned creature spawns yet; the 28 disabled Vilverin undead DLE places are left to dungeons.js,
   placed people are listed, not spawned; the gate passes an empty list.
2. DLE v5 (~/inbox/2026-09-29-esp-v5, if still there) with its 21 goblins and boars set Initially Disabled in a scratch
   copy, as the PC session will: 21 spawns, one camp named from its marker, anchors outside our plugins; the gate passes
   that copy and refuses v5 as it came (not disabled) and the live DLE (missing).
"""
import json
import os
import struct
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
GEN, GATE = os.path.join(HERE, 'owned_spawns.py'), os.path.join(HERE, 'spawns_gate.py')
V5 = os.path.expanduser('~nate/inbox/2026-09-29-esp-v5/DragonBreak Online Edits.esp')
DLE = 'DragonBreak Online Edits.esp'
V5_LIVING = [0x154071, 0x154072, 0x154073, 0x154074, 0x154075, 0x154076, 0x154077, 0x154078, 0x15404F, 0x154051, 0x154052,
             0x154055, 0x154056, 0x15405D, 0x15405E, 0x154063, 0x154064, 0x154069, 0x15406A, 0x15406F, 0x154070]
OWNED = {'dragonbreak.esp', 'dragonbreak built.esp', 'dragonbreak dungeons.esp', 'dragonbreak harvest.esp', 'dragonbreak hub.esp',
         'dragonbreak whiterun.esp', 'dragonbreak online edits.esp', 'lostark_kamen.esp',
         '[kirax] lost ark reborn paladin legendary.esp', 'dragonbreak nexus patches.esp'}
fails = 0


def ok(cond, what, got=None):
    global fails
    print(('PASS  ' if cond else 'FAIL  ') + what + ('' if cond or got is None else '   ' + repr(got)[:400]))
    if not cond:
        fails += 1


def run(*args):
    r = subprocess.run([sys.executable, *args], capture_output=True, text=True)
    return r.returncode, (r.stdout + r.stderr).strip()


def generate(tmp, name, *replace):
    out = os.path.join(tmp, name)
    code, text = run(GEN, '--out', out, *[x for r in replace for x in ('--replace', r)])
    return code, text, (json.load(open(out)) if code == 0 else None)


def flag_disabled(src, dst, own_index, ids):
    """Sets 0x800 on the ACHR record headers with these local ids (records are not compressed)"""
    b = bytearray(open(src, 'rb').read())
    n = 0
    for x in ids:
        key = struct.pack('<I', (own_index << 24) | x)
        i = b.find(key)
        while i >= 0:
            if b[i - 12:i - 8] == b'ACHR':
                struct.pack_into('<I', b, i - 4, struct.unpack_from('<I', b, i - 4)[0] | 0x800)
                n += 1
            i = b.find(key, i + 1)
    open(dst, 'wb').write(b)
    return n


with tempfile.TemporaryDirectory(prefix='claude-nate-owned-') as tmp:
    code, text, live = generate(tmp, 'live.json')
    ok(code == 0 and live is not None, 'the generator runs on the live order', text)
    if live:
        ok(live['spawns'] == [] and live['camps'] == [], 'live: no owned creature spawns yet', live['spawns'][:3])
        ok(len(live['skipped']['dungeon']) == 28, 'live: the 28 disabled Vilverin undead are left to dungeons.js', len(live['skipped']['dungeon']))
        ok(any('Guard' in p for p in live['skipped']['person']) and not any('Guard' in s['edid'] for s in live['spawns']),
           'live: placed people (the Solitude guards DragonBreak.esp places) are listed under skipped.person, not spawned', live['skipped']['person'])
        code, text = run(GATE, '--spawns', os.path.join(tmp, 'live.json'))
        ok(code == 0 and 'nothing to check' in text, 'the gate passes an empty list (it never blocks an unrelated release)', text)

    if not os.path.exists(V5):
        print(f'SKIP  {V5} is gone: the v5 checks need it')
    else:
        flagged = os.path.join(tmp, 'v5-disabled.esp')
        sys.path.insert(0, os.path.expanduser('~nate/dragonbreak/ck-mcp'))
        import esplib
        own = len(esplib.Plugin(V5).masters)
        ok(flag_disabled(V5, flagged, own, V5_LIVING) == 21, 'a scratch copy of v5 gets Initially Disabled on its 21 goblins and boars')
        code, text, v5 = generate(tmp, 'v5.json', f'{DLE}={flagged}')
        ok(code == 0 and v5 is not None, 'the generator runs with the flagged v5 in place of the live DLE', text)
        if v5:
            kinds = {}
            for s in v5['spawns']:
                kinds[s['kind']] = kinds.get(s['kind'], 0) + 1
            ok(kinds == {'goblin': 8, 'boar': 13}, 'v5: 8 goblins and 13 boars become spawns', kinds)
            ok({int(s['src'].split(':')[0], 16) for s in v5['spawns']} == set(V5_LIVING), 'v5: exactly the 21 placed creatures, by id')
            ok(all(s['ref'].split(':', 1)[1].lower() not in OWNED for s in v5['spawns']), 'v5: no anchor is a reference of ours')
            ok(all(s['anchorDist'] <= 2500 for s in v5['spawns']), 'v5: every anchor within 2500 units', [s['anchorDist'] for s in v5['spawns']])
            ok(len(v5['camps']) == 1 and v5['camps'][0]['name'] == 'Dusk Thorn Camp' and v5['camps'][0]['owners'] == 'goblins'
               and [c['ref'] for c in v5['camps'][0]['chests']] == [f'154079:{DLE}'], 'v5: one camp, Dusk Thorn Camp (its marker\'s name), the goblins\' chest', v5['camps'])
            ok(any(s['heading'] != 0 for s in v5['spawns']), 'v5: headings come from the placements')
            code, text = run(GATE, '--spawns', os.path.join(tmp, 'v5.json'), '--replace', f'{DLE}={flagged}')
            ok(code == 0 and text.startswith('ok: 21'), 'the gate passes the flagged copy', text)
            code, text = run(GATE, '--spawns', os.path.join(tmp, 'v5.json'), '--replace', f'{DLE}={V5}')
            ok(code == 1 and text.startswith('not disabled: 21'), 'the gate refuses v5 as it came (its creatures enabled)', text[:120])
            code, text = run(GATE, '--spawns', os.path.join(tmp, 'v5.json'))
            ok(code == 1 and text.startswith('missing: 22'), 'the gate refuses the live DLE (no camp, no creatures)', text[:120])

print('all checks passed' if not fails else f'{fails} FAILED')
sys.exit(1 if fails else 0)
