#!/usr/bin/env python3
"""Build a main menu that draws nothing and takes no input.

Skyrim loads Data/Interface/startmenu.swf into the "Main Menu" state. A replacement with an empty stage leaves the
state itself intact - it still opens, still carries the name "Main Menu", still fires menuOpen/menuClose - while
nothing of Bethesda's menu is drawn and none of its buttons exist to be clicked. Our CEF title screen is then the
only thing on the screen.

No Flash tooling is needed and none exists on CT 115: an empty SWF is a header plus three tags, written here by hand
against the SWF File Format Specification (version 19). JPEXS Free Flash Decompiler is the usual tool for this and
runs on Linux under Java, but it is not needed for a file with nothing in it.

    python3 tooling/mainmenu/make-startmenu-swf.py [out.swf]

The result is 30 bytes. Verify it with tooling/mainmenu/check-startmenu-swf.py.
"""
import struct
import sys

STAGE_W, STAGE_H = 1280, 720   # twips are 20 per pixel; nothing is drawn, so this is only the stage box
FRAME_RATE = 60
SWF_VERSION = 9


def rect(xmin, xmax, ymin, ymax):
    """A bit-packed SWF RECT: a 5-bit field width, then four signed fields of that width."""
    vals = [xmin, xmax, ymin, ymax]
    nbits = max(max(abs(v).bit_length() + 1 for v in vals), 1)
    bits = format(nbits, '05b') + ''.join(format(v & ((1 << nbits) - 1), '0%db' % nbits) for v in vals)
    bits += '0' * ((8 - len(bits) % 8) % 8)
    return bytes(int(bits[i:i + 8], 2) for i in range(0, len(bits), 8))


def tag(code, body=b''):
    if len(body) < 0x3f:
        return struct.pack('<H', (code << 6) | len(body)) + body
    return struct.pack('<HI', (code << 6) | 0x3f, len(body)) + body


def build():
    body = rect(0, STAGE_W * 20, 0, STAGE_H * 20)
    body += struct.pack('<H', FRAME_RATE << 8)   # 8.8 fixed point
    body += struct.pack('<H', 1)                 # one frame
    body += tag(9, b'\x00\x00\x00')              # SetBackgroundColor black; nothing is on the stage to cover it
    body += tag(1)                               # ShowFrame
    body += tag(0)                               # End
    return b'FWS' + bytes([SWF_VERSION]) + struct.pack('<I', 8 + len(body)) + body


if __name__ == '__main__':
    out = sys.argv[1] if len(sys.argv) > 1 else 'startmenu.swf'
    data = build()
    with open(out, 'wb') as f:
        f.write(data)
    print(f'{out}: {len(data)} bytes, SWF version {SWF_VERSION}, stage {STAGE_W}x{STAGE_H}')
