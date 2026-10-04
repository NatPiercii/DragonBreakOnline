#!/usr/bin/env python3
"""Where the records dle_graft.py copies hold form ids, so a graft can check and remap every one of them.

The layouts are xEdit's (wbDefinitionsTES5.pas / wbDefinitionsCommon.pas, Skyrim SE): wbRefRecord REFR and ACHR, CELL,
LAND, NAVM (NVNM), NAVI (NVMI) and the VMAD of a placed reference. Anything not listed is refused by the caller rather
than guessed: a signature of no known layout, a VMAD or NVNM whose bytes do not add up to the end, a compressed body
that does not inflate. Every offset returned is into the record's (inflated) body, so a remap patches it in place.
"""
import struct, zlib

COMPRESSED = 0x40000


class Unreadable(Exception):
    pass


def unpack(rec):
    """(24-byte header, body) of a record with its header; a compressed body is inflated"""
    head, body = rec[:24], rec[24:]
    if struct.unpack_from('<I', head, 8)[0] & COMPRESSED:
        size = struct.unpack_from('<I', body, 0)[0]
        body = zlib.decompress(body[4:])
        if len(body) != size:
            raise Unreadable('compressed body inflates to the wrong size')
    return head, body


def pack(head, body):
    """A record from a header and an uncompressed body: the size is set and the compressed flag cleared"""
    flags = struct.unpack_from('<I', head, 8)[0] & ~COMPRESSED
    return head[:4] + struct.pack('<II', len(body), flags) + head[12:24] + body


def subs(body):
    """(signature, offset of the value in body, value) for every subrecord; XXXX sizes are honoured"""
    i, big = 0, None
    while i < len(body):
        if i + 6 > len(body):
            raise Unreadable('a subrecord header runs past the end')
        sig, n = body[i:i + 4], struct.unpack_from('<H', body, i + 4)[0]
        if sig == b'XXXX':
            big = struct.unpack_from('<I', body, i + 6)[0]; i += 6 + n; continue
        if big is not None:
            n, big = big, None
        if i + 6 + n > len(body):
            raise Unreadable(f'{sig!r} runs past the end')
        yield sig, i + 6, body[i + 6:i + 6 + n]
        i += 6 + n


# signature -> (offsets of form ids in the value, stride): stride 0 is one struct, otherwise an array of elements
_REF_COMMON = {
    b'NAME': ([0], 0), b'XEZN': ([0], 0), b'XLCN': ([0], 0), b'XLRL': ([0], 0), b'XOWN': ([0], 0), b'XESP': ([0], 0),
    b'XMBR': ([0], 0), b'XEMI': ([0], 0), b'XLKR': ([0, 4], 0), b'XAPR': ([0], 8), b'XLRT': ([0], 4), b'INAM': ([0], 0),
}
LAYOUT = {
    'REFR': {**_REF_COMMON, **{
        b'XLIB': ([0], 0), b'XTEL': ([0], 0), b'XLRM': ([0], 0), b'XNDP': ([0], 0), b'XTNM': ([0], 0),
        b'XSPC': ([0], 0), b'XATR': ([0], 0), b'XLTW': ([0], 0), b'XPWR': ([0], 0), b'XCZR': ([0], 0), b'XCZC': ([0], 0),
        b'LNAM': ([0], 0), b'XLOC': ([4], 0), b'XPOD': ([0, 4], 8), b'XORD': ([0], 4),
    }},
    'ACHR': {**_REF_COMMON, **{b'TNAM': ([0], 0), b'XMRC': ([0], 0), b'XHOR': ([0], 0)}},
    'CELL': {b'XCLR': ([0], 4), b'LTMP': ([0], 0), b'XLCN': ([0], 0), b'XCWT': ([0], 0), b'XOWN': ([0], 0),
             b'XILL': ([0], 0), b'XCCM': ([0], 0), b'XCAS': ([0], 0), b'XEZN': ([0], 0), b'XCMO': ([0], 0),
             b'XCIM': ([0], 0)},
    'LAND': {b'BTXT': ([0], 0), b'ATXT': ([0], 0)},
    'NAVM': {b'ONAM': ([0], 4)},
}
NO_IDS = {
    'REFR': {b'EDID', b'DATA', b'XSCL', b'XMBO', b'XPRM', b'XOCP', b'XPTL', b'XRMR', b'XMBP', b'XRGD', b'XRGB', b'XRDS',
             b'XLIG', b'XALP', b'XWCN', b'XWCU', b'XWCS', b'XCVL', b'XCVR', b'XCZA', b'XAPD', b'XLCM', b'XTRI', b'XIS2',
             b'XRNK', b'XCNT', b'XCHG', b'XPRD', b'XPPA', b'SCHR', b'SCTX', b'XACT', b'XHTW', b'XFVC', b'ONAM', b'XMRK',
             b'FNAM', b'FULL', b'TNAM', b'XLOD'},
    'ACHR': {b'EDID', b'DATA', b'XSCL', b'XPRD', b'XPPA', b'SCHR', b'SCDA', b'SCTX', b'QNAM', b'SCRO', b'XCNT', b'XRDS',
             b'XHLP', b'XAPD', b'XCLP', b'XIS2', b'XHTW', b'XFVC', b'XIBS', b'XRGD', b'XRGB', b'XLCM', b'XACT', b'XLOD',
             b'XRNK'},
    'CELL': {b'EDID', b'FULL', b'DATA', b'XCLC', b'XCLL', b'TVDT', b'MHDT', b'LNAM', b'XCLW', b'XNAM', b'XWCN', b'XWCS',
             b'XWCU', b'XWEM', b'XRNK'},
    'LAND': {b'DATA', b'VNML', b'VHGT', b'VCLR', b'VTXT', b'MPCD'},
    'NAVM': {b'EDID', b'PNAM', b'NNAM'},
}


def _vmad(v):
    """Form id offsets in a placed reference's VMAD (scripts only, no fragments); refused unless every byte is read"""
    o, ids = 0, []

    def take(n):
        nonlocal o
        if o + n > len(v):
            raise Unreadable('VMAD runs short')
        o += n
        return o - n

    def u(fmt):
        at = take(struct.calcsize(fmt)); return struct.unpack_from(fmt, v, at)[0]

    def lenstr():
        take(u('<H'))

    _version, objfmt = u('<h'), u('<h')
    if objfmt not in (1, 2):
        raise Unreadable(f'VMAD object format {objfmt}')
    obj_at = 4 if objfmt == 2 else 0

    def obj():
        at = take(8); ids.append(at + obj_at)

    for _ in range(u('<H')):
        lenstr(); take(1)
        for _ in range(u('<H')):
            lenstr(); kind = u('<B'); take(1)
            if kind == 0:
                pass
            elif kind == 1:
                obj()
            elif kind == 2:
                lenstr()
            elif kind in (3, 4):
                take(4)
            elif kind == 5:
                take(1)
            elif kind == 11:
                for _ in range(u('<I')):
                    obj()
            elif kind == 12:
                for _ in range(u('<I')):
                    lenstr()
            elif kind in (13, 14):
                take(4 * u('<I'))
            elif kind == 15:
                take(u('<I'))
            else:
                raise Unreadable(f'VMAD property type {kind}')
    if o != len(v):
        raise Unreadable(f'VMAD has {len(v) - o} bytes after its scripts (fragments are not read here)')
    return ids


def _nvnm(v):
    """Form id offsets in a navmesh's NVNM: parent world, parent cell, edge-link navmeshes, door refs"""
    o, ids = 0, []

    def u32():
        nonlocal o
        if o + 4 > len(v):
            raise Unreadable('NVNM runs short')
        o += 4; return struct.unpack_from('<I', v, o - 4)[0]

    def skip(n):
        nonlocal o
        if o + n > len(v):
            raise Unreadable('NVNM runs short')
        o += n

    u32(); u32()                      # version, CRC
    ids.append(o); world = u32()
    if world == 0:
        ids.append(o); u32()          # parent cell
    else:
        skip(4)                       # grid Y, X
    skip(12 * u32())                  # vertices
    skip(16 * u32())                  # triangles
    for _ in range(u32()):            # edge links: type, navmesh, triangle
        u32(); ids.append(o); u32(); skip(2)
    for _ in range(u32()):            # door links: triangle, CRC, door ref
        skip(2); u32(); ids.append(o); u32()
    skip(2 * u32())                   # cover triangles
    divisor = u32(); skip(8 + 24)     # grid size, bounds
    for _ in range(divisor * divisor):
        skip(2 * u32())
    if o != len(v):
        raise Unreadable(f'NVNM has {len(v) - o} bytes left over')
    return ids


def nvmi(v):
    """(navmesh id, form id offsets) of one NAVI NVMI entry (Skyrim SE, NVER 12), refused unless every byte is read.
    Layout as in Worker G's navilib.py: navmesh, flags, x y z, merge flag, merged[], preferred[], doors[{u32, door}],
    island byte (+ bounds, triangles, vertices), u32, world, then a cell id (interior) or the grid."""
    o, ids = 0, []

    def u32():
        nonlocal o
        if o + 4 > len(v):
            raise Unreadable('NVMI runs short')
        o += 4; return struct.unpack_from('<I', v, o - 4)[0]

    def fid():
        ids.append(o); return u32()

    nav = fid(); u32(); o += 12; u32()
    for _ in range(u32()):
        fid()
    for _ in range(u32()):
        fid()
    for _ in range(u32()):
        u32(); fid()
    if o >= len(v):
        raise Unreadable('NVMI has no island byte')
    island = v[o]; o += 1
    if island:
        o += 24
        ntri = u32(); o += 6 * ntri          # (o += 6 * u32() would read o before u32 moves it)
        nvert = u32(); o += 12 * nvert
    u32()
    if fid() == 0:
        fid()
    else:
        o += 4
    if o != len(v):
        raise Unreadable(f'NVMI has {len(v) - o} bytes left over')
    return nav, ids


def form_ids(rtype, body, what):
    """[(signature, offset in body, form id)] of a record body of type rtype; Unreadable for anything not known"""
    if rtype not in LAYOUT:
        raise Unreadable(f'{what}: no layout for {rtype} records')
    out = []
    for sig, at, val in subs(body):
        if sig == b'VMAD' and rtype in ('REFR', 'ACHR'):
            offs = _vmad(val)
        elif sig == b'NVNM' and rtype == 'NAVM':
            offs = _nvnm(val)
        elif sig == b'PDTO' and rtype in ('REFR', 'ACHR'):
            offs = [4] if len(val) >= 8 and struct.unpack_from('<I', val, 0)[0] == 0 else []
        elif sig in NO_IDS[rtype]:
            offs = []
        elif sig in LAYOUT[rtype]:
            offsets, stride = LAYOUT[rtype][sig]
            offs = [s + x for s in (range(0, len(val), stride) if stride else [0]) for x in offsets if s + x + 4 <= len(val)]
        else:
            raise Unreadable(f'{what}: {sig.decode("ascii", "replace")} in a {rtype} has no known layout')
        out += [(sig, at + x, struct.unpack_from('<I', val, x)[0]) for x in offs]
    return out
