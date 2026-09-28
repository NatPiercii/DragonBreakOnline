#!/usr/bin/env python3
"""Check a built startmenu.swf: the header agrees with the file, and the tag stream parses to exactly the end.

This is what can be verified without Skyrim. Whether the engine is content with an empty main menu can only be
answered by running the game; see MAINMENU_INVESTIGATION.md for that test.

    python3 tooling/mainmenu/check-startmenu-swf.py tooling/mainmenu/startmenu.swf
"""
import struct
import sys

TAGS = {0: 'End', 1: 'ShowFrame', 9: 'SetBackgroundColor'}


def check(path):
    d = open(path, 'rb').read()
    ok = True

    if d[:3] == b'CWS' or d[:3] == b'ZWS':
        print(f'FAIL {path} is compressed ({d[:3].decode()}); this builder writes uncompressed FWS')
        return False
    if d[:3] != b'FWS':
        print(f'FAIL bad signature {d[:3]!r}')
        return False

    declared = struct.unpack('<I', d[4:8])[0]
    print(f'ok   signature FWS, version {d[3]}')
    if declared != len(d):
        print(f'FAIL header says {declared} bytes, file is {len(d)}')
        ok = False
    else:
        print(f'ok   length {declared} matches the file')

    i = 8
    nbits = d[i] >> 3
    i += (5 + nbits * 4 + 7) // 8      # RECT
    i += 4                              # frame rate (8.8) + frame count
    codes = []
    while i < len(d):
        th = struct.unpack('<H', d[i:i + 2])[0]
        code, ln = th >> 6, th & 0x3f
        i += 2
        if ln == 0x3f:
            ln = struct.unpack('<I', d[i:i + 4])[0]
            i += 4
        codes.append(code)
        print(f'ok   tag {code} ({TAGS.get(code, "?")}), {ln} bytes')
        i += ln
    if i != len(d):
        print(f'FAIL the tag stream ended at {i} of {len(d)}')
        ok = False
    else:
        print('ok   the tag stream ends exactly at the end of the file')

    # Nothing may be placed on the stage and no code may run, or the menu would draw or do something
    PLACE = {4: 'PlaceObject', 26: 'PlaceObject2', 70: 'PlaceObject3'}
    CODE = {12: 'DoAction', 59: 'DoInitAction', 72: 'DoABC (AS3)', 82: 'DoABC'}
    for c in codes:
        if c in PLACE:
            print(f'FAIL {PLACE[c]}: something is placed on the stage')
            ok = False
        if c in CODE:
            print(f'FAIL {CODE[c]}: the menu would run code')
            ok = False
    if not any(c in PLACE or c in CODE for c in codes):
        print('ok   nothing is placed on the stage and no ActionScript is present')
    print('PASS' if ok else 'FAILED')
    return ok


if __name__ == '__main__':
    sys.exit(0 if check(sys.argv[1] if len(sys.argv) > 1 else 'startmenu.swf') else 1)
