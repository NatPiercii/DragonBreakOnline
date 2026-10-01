#!/usr/bin/env python3
# NAVI (navmesh info map) parser for dle_ship_gate.py with every form-id field located, so entries can be compared and remapped by master
# name. NVMI layout (Skyrim SE, NVER 12):
#   u32 navmesh | u32 flags | f32 x,y,z | u32 preferredMergesFlag
#   u32 n + formid[n] (merged to) | u32 n + formid[n] (preferred merges) | u32 n + {u32 unknown, formid door}[n]
#   u8 isIsland; if isIsland: f32[6] bounds, u32 nTri + tri[nTri] (3x u16), u32 nVert + vert[nVert] (3x f32)
#   u32 unknown | formid worldspace | worldspace==0: formid cell, else i16 gridY, i16 gridX
# NVPP: u32 nSets + {u32 n + formid[n]}[nSets], then u32 n + {formid navmesh, u32 triangle}[n]
import struct


class Bad(Exception):
    pass


def parse_nvmi(v):
    """Returns (fields, formid offsets). Raises Bad unless every byte is accounted for."""
    o = 0
    ids = []

    def u32():
        nonlocal o
        if o + 4 > len(v): raise Bad('short')
        x = struct.unpack_from('<I', v, o)[0]; o += 4; return x

    def fid():
        ids.append(o); return u32()

    nav = fid(); flags = u32(); loc = v[o:o + 12]; o += 12; pmf = u32()
    merged = [fid() for _ in range(u32())]
    pref = [fid() for _ in range(u32())]
    doors = []
    for _ in range(u32()):
        u = u32(); doors.append((u, fid()))
    if o >= len(v): raise Bad('no island byte')
    island = v[o]; o += 1
    i0 = o
    if island:
        o += 24
        ntri = u32(); o += ntri * 6
        nvert = u32(); o += nvert * 12
    island_data = v[i0:o]
    unk = u32()
    world = fid()
    grid = None
    if world == 0:
        cell = fid()
    else:
        cell = None
        if o + 4 > len(v): raise Bad('short grid')
        grid = struct.unpack_from('<hh', v, o); o += 4
    if o != len(v): raise Bad(f'{len(v) - o} bytes left')
    return {'navmesh': nav, 'flags': flags, 'location': loc, 'preferred': pmf, 'merged': merged, 'pref': pref,
            'doors': doors, 'island': island, 'islandData': island_data, 'unknown': unk, 'world': world, 'cell': cell,
            'grid': grid}, ids


def parse_nvpp(v):
    o = 0; ids = []

    def u32():
        nonlocal o
        x = struct.unpack_from('<I', v, o)[0]; o += 4; return x

    sets = []
    for _ in range(u32()):
        n = u32(); s = []
        for _ in range(n): ids.append(o); s.append(u32())
        sets.append(s)
    pairs = []
    for _ in range(u32()):
        ids.append(o); f = u32(); t = u32(); pairs.append((f, t))
    if o != len(v): raise Bad(f'NVPP {len(v) - o} bytes left')
    return {'sets': sets, 'pairs': pairs}, ids


def remap(v, offsets, fn):
    """Rewrite the form ids at offsets with fn(formid) -> formid; everything else byte-for-byte."""
    b = bytearray(v)
    for o in offsets:
        struct.pack_into('<I', b, o, fn(struct.unpack_from('<I', v, o)[0]))
    return bytes(b)



def resolved(subs, norm):
    """{navmesh: entry} for the NVMI entries, and NVPP's navmeshes as one sorted list; norm(formid) -> a name key.
    An entry is {'links': (edge, preferred, doors, world, cell or ('grid', y, x)) with form ids by name, 'island': the
    Is Island flag, and the other fields by name}."""
    entries, nvpp = {}, None
    for s, v in subs:
        if s == b'NVMI':
            f, ids = parse_nvmi(v)
            links = (tuple(sorted(map(norm, f['merged']))), tuple(sorted(map(norm, f['pref']))),
                     tuple(sorted(norm(d) for u, d in f['doors'])), norm(f['world']),
                     norm(f['cell']) if f['cell'] is not None else ('grid',) + tuple(f['grid']))
            entries[norm(f['navmesh'])] = {
                'links': links, 'island': f['island'],
                'fields': {'island data': f['islandData'], 'flags': f['flags'], 'approximate location': f['location'],
                           'preferred %': f['preferred'], 'door link data': tuple(sorted(u for u, d in f['doors'])),
                           'trailing value': f['unknown']}}
        elif s == b'NVPP':
            f, ids = parse_nvpp(v)
            nvpp = (sorted(repr(norm(x)) for st in f['sets'] for x in st), sorted(repr((norm(a), t)) for a, t in f['pairs']), v)
    return entries, nvpp


LINK_NAMES = ('edge links', 'preferred edge links', 'door links', 'worldspace', 'cell or grid')


def compare(le, ne, lp=None, np_=None):
    """What differs between live's entries and a candidate's: blocking problems and notes"""
    missing = [k for k in le if k not in ne]
    extra = [k for k in ne if k not in le]
    relinked, flipped, notes = {}, [], {}
    for k in le:
        if k not in ne:
            continue
        a, b = le[k], ne[k]
        moved = [LINK_NAMES[i] for i in range(5) if a['links'][i] != b['links'][i]]
        if moved:
            relinked[k] = moved
        if a['island'] != b['island']:
            flipped.append(k)
        for name in a['fields']:
            if a['fields'][name] != b['fields'][name]:
                notes.setdefault(name, []).append(k)
    nvpp_moved = bool(lp and np_ and (lp[0] != np_[0] or lp[1] != np_[1]))
    nvpp_order = bool(lp and np_ and not nvpp_moved and lp[2] != np_[2])
    return {'missing': missing, 'extra': extra, 'relinked': relinked, 'flipped': flipped, 'notes': notes,
            'nvppMoved': nvpp_moved, 'nvppOrder': nvpp_order}
