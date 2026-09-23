"""
audit.py - the read-only repair passes.

Each of these was written by hand during the Aug 2026 audit and validated against
SSEEdit's own Check for Errors. Notes below record the mistakes that pass made, so
they are not repeated.
"""
import struct, collections, hashlib, zlib
import esplib

SAFE_REMOVE = {'REFR', 'ACHR', 'PHZD', 'PGRE', 'PMIS', 'STAT', 'ACTI', 'CONT', 'MISC',
               'FURN', 'BOOK', 'FLOR', 'TXST', 'WATR', 'MGEF', 'SPEL', 'MESG', 'KYWD',
               'LVLI', 'ARMO', 'ARMA', 'FACT', 'GLOB', 'COBJ', 'WTHR', 'TREE', 'LIGH',
               'DOOR', 'SOUN', 'IDLM', 'MSTT', 'ALCH', 'INGR'}

# Parent records whose children carry the real change. Never auto-remove these:
# a CELL header can be byte-identical while its refs differ.
REVIEW_ONLY = {'CELL', 'WRLD', 'DIAL', 'NAVM', 'NAVI', 'LAND'}

# FormIDs the engine defines rather than any file. They resolve at runtime and
# are never present in an ESM, so "missing" is the wrong verdict for them.
# PlayerRef in particular is the target of thousands of XESP enable-parents.
ENGINE_FORMS = {"Skyrim.esm:000014"}   # PlayerRef

# NAME is only a FormID inside reference records. In RACE it appears 32 times as
# a body-part name; in other record types it can be arbitrary data. Restricting
# it by record type removes that entire false-positive class.
NAME_IS_FORMID = {'REFR', 'ACHR', 'PGRE', 'PMIS', 'PHZD', 'PARW', 'PBAR', 'PBEA', 'PCON', 'PFLA'}

# Subrecords holding a FormID, and the byte offset of that FormID within them.
# MODS/MO2S..MO5S are handled separately - they are arrays, not a flat field.
# Missing MODS here during the audit left 3 dangling texture references that
# SSEEdit caught and I did not.
REF_FIELDS = {b'NAME': (0,), b'XTEL': (0,), b'XLKR': (4,), b'XESP': (0,), b'XLRL': (0,),
              b'XOWN': (0,), b'XEMI': (0,), b'XLRT': (0,), b'XPWR': (0,), b'XLIB': (0,),
              # quest alias FormIDs - unambiguous, verified against real data
              b'ALFR': (0,), b'ALCO': (0,), b'ALUA': (0,),
              b'XAPR': (0,),
              # portal -> room links. Verified against 3,068 portals across
              # Skyrim.esm, Dawnguard, DL and Edits: always exactly 8 bytes
              # (two FormIDs), only ever on PortalMarker refs, and every
              # resolving target is a RoomMarker.
              b'XPOD': (0, 4)}
# Deliberately NOT included, each verified against real data first:
#   INAM, PLDT, PTDA, PKID - type-tagged or context-dependent; treating them as
#     flat FormIDs produced 1,499 false hits.
#   ALFI - an alias INDEX, not a FormID. Every value across Skyrim.esm, Dawnguard
#     and Daedric Landscape is below 0x1B5; FormIDs are not distributed that way.
# A broken XPOD leaves a portal pointing at a room that is not there, which breaks
# occlusion culling in that cell - geometry vanishes as you cross the boundary.
# Any new field added here must be checked the same way before being trusted.
ALT_TEXTURE = {b'MODS', b'MO2S', b'MO3S', b'MO4S', b'MO5S'}

# Opaque binary - a 4-byte value in here is not a FormID. Scanning navmesh
# geometry produced false "reference" hits during the audit.
OPAQUE = {b'NVNM', b'NVMI', b'MODT', b'MODS', b'MO2T', b'MO3T', b'MO4T', b'MO5T',
          b'OBND', b'XSCL', b'VNML', b'VHGT', b'VCLR', b'VTXT', b'ATXT', b'BTXT',
          b'XCLW', b'EDID', b'FULL', b'DESC', b'ICON', b'MODL', b'SCTX', b'XRGD',
          b'XRGB', b'TVDT', b'MHDT', b'PFIG', b'DATA', b'HEDR', b'MAST', b'CNAM', b'SNAM'}


def alt_texture_refs(v):
    """yield offsets of TXST FormIDs inside an Alternate Textures subrecord"""
    if len(v) < 4:
        return
    n = struct.unpack_from('<I', v, 0)[0]
    i = 4
    for _ in range(n):
        if i + 4 > len(v):
            return
        ln = struct.unpack_from('<I', v, i)[0]
        i += 4 + ln
        if i + 8 > len(v):
            return
        yield i
        i += 8


def find_deleted(lo, plugin):
    """Deleted references (UDR) - the top cause of save corruption and CTDs."""
    p = lo.plugin(plugin)
    out = []
    for _, t, fid, fl, off, sz, ctx in lo.records(p):
        if not (fl & esplib.DEL):
            continue
        f = lo.ref_fields(p, off, sz, fl) if t in ('REFR', 'ACHR') else {}
        b = lo.base_info(f["base"]) if f.get("base") else None
        out.append({"id": lo.canon(p, fid), "type": t,
                    "base": f.get("base"), "base_editor_id": (b or {}).get("editor_id"),
                    "base_type": (b or {}).get("type"),
                    "cell": lo.canon(p, ctx[1]) if ctx[1] else None,
                    "has_own_position": f.get("pos") is not None})
    return out


def find_itm(lo, plugin):
    """Records byte-identical to the version they override.

    Compares body AND semantic header flags. Comparing only the body (or only the
    deleted bit) wrongly counts a disabled override as identical - that mistake
    inflated an earlier count from 1,549 to ~2,565.
    """
    p = lo.plugin(plugin)
    MASK = ~0x00040000 & 0xFFFFFFFF
    chain = collections.defaultdict(list)
    for q in lo.plugins:
        for _, t, fid, fl, off, sz, ctx in lo.records(q):
            chain[lo.canon(q, fid)].append((q.load_index, q, t, fl, off, sz, ctx))
    out = []
    for cid, entries in chain.items():
        if len(entries) < 2:
            continue
        entries.sort(key=lambda e: e[0])
        for i in range(1, len(entries)):
            _, q, t, fl, off, sz, ctx = entries[i]
            if q.key != p.key:
                continue
            _, pq, pt, pfl, poff, psz, pctx = entries[i - 1]
            same_flags = (fl & MASK) == (pfl & MASK)
            if same_flags and lo.body(q, off, sz, fl) == lo.body(pq, poff, psz, pfl):
                out.append({"id": cid, "type": t,
                            "identical_to": pq.name,
                            "safe_to_remove": t in SAFE_REMOVE,
                            "review_only": t in REVIEW_ONLY})
    return out


def find_duplicates(lo, plugin):
    """Same base object at the same position AND orientation in the same cell.

    The key needs all five parts: parent cell, base object, position, rotation and
    scale.

    - The parent cell MUST be included. Every interior has its own coordinate space;
      keying on position alone reported 9,508 duplicates where 1,463 existed.
    - Rotation and scale MUST be included. Level design routinely places several
      copies of one wall/floor/ceiling mesh at a shared origin, rotated to face
      different ways - that is how corners, rings and shafts are built. Omitting
      rotation flagged 511 structural pieces as redundant in DragonBreak.esp,
      and acting on that punched holes in Solitude Prison, the Solitude Sewers,
      Windhelm Sewers and three prison interiors.

    This is a REPORT. Never auto-disable what it returns - the user's placement is
    authoritative. Stacked geometry is theirs to judge.
    """
    p = lo.plugin(plugin)
    seen, out = {}, []
    for _, t, fid, fl, off, sz, ctx in lo.records(p, ('REFR', 'ACHR')):
        if fl & esplib.DEL or fl & 0x800:
            continue
        f = lo.ref_fields(p, off, sz, fl)
        if not f["base"] or not f["pos"] or f["pos"][2] < -25000:
            continue
        # Enable parent must be part of the key. Two refs sharing a spot but
        # answering to different enable markers are mutually exclusive at runtime,
        # never both visible. Fort Neugrad stacks the Imperial and Stormcloak
        # weapon racks this way; treating them as duplicates and removing one
        # would leave the fort bare under one civil-war outcome.
        sub = lo.subrecords(p, off, sz, fl)
        parent = None
        if len(sub.get(b'XESP', b'')) >= 8:
            parent = (lo.canon(p, struct.unpack_from('<I', sub[b'XESP'], 0)[0]),
                      struct.unpack_from('<I', sub[b'XESP'], 4)[0] & 1)
        key = (ctx[1], f["base"],
               round(f["pos"][0]), round(f["pos"][1]), round(f["pos"][2]),
               tuple(f["rot"]) if f["rot"] else None, f["scale"], parent)
        if key not in seen:
            seen[key] = lo.canon(p, fid)
            continue
        b = lo.base_info(f["base"])
        out.append({"id": lo.canon(p, fid), "keeper": seen[key],
                    "base": f["base"], "base_editor_id": (b or {}).get("editor_id"),
                    "base_type": (b or {}).get("type"),
                    "cell": lo.canon(p, ctx[1]) if ctx[1] else None,
                    "pos": f["pos"], "rot": f["rot"], "scale": f["scale"]})
    return out


def find_dangling(lo, plugin):
    """FormID references pointing at records that do not exist in the load order."""
    p = lo.plugin(plugin)
    out = []
    for _, t, fid, fl, off, sz, ctx in lo.records(p):
        if t in ('NAVM', 'NAVI', 'LAND'):
            continue
        for sg, v in esplib.subrecords(lo.body(p, off, sz, fl)):
            offs = []
            if sg in ALT_TEXTURE:
                offs = list(alt_texture_refs(v))
            elif sg == b'NAME':
                if t not in NAME_IS_FORMID:
                    continue
                offs = [0]
            elif sg in REF_FIELDS:
                offs = list(REF_FIELDS[sg])
            elif sg in OPAQUE:
                continue
            for o in offs:
                if len(v) < o + 4:
                    continue
                raw = struct.unpack_from('<I', v, o)[0]
                if raw == 0:          # null FormID means "none", not a broken link
                    continue
                target = lo.canon(p, raw)
                if target in ENGINE_FORMS:
                    continue
                if not lo.exists(target):
                    out.append({"id": lo.canon(p, fid), "type": t,
                                "field": sg.decode(), "missing_target": target})
    return out


def find_broken_doors(lo, plugin):
    """Load doors whose teleport destination no longer exists."""
    p = lo.plugin(plugin)
    out = []
    for _, t, fid, fl, off, sz, ctx in lo.records(p, ('REFR',)):
        sub = lo.subrecords(p, off, sz, fl)
        if len(sub.get(b'XTEL', b'')) < 4:
            continue
        dest = lo.canon(p, struct.unpack('<I', sub[b'XTEL'][:4])[0])
        if lo.exists(dest):
            continue
        f = lo.ref_fields(p, off, sz, fl)
        b = lo.base_info(f["base"]) if f["base"] else None
        c = lo.cell_info(lo.canon(p, ctx[1])) if ctx[1] else None
        out.append({"id": lo.canon(p, fid),
                    "base_editor_id": (b or {}).get("editor_id"),
                    "cell": (c or {}).get("name") or (c or {}).get("editor_id"),
                    "grid": (c or {}).get("grid"),
                    "pos": f["pos"], "missing_destination": dest})
    return out


def validate(lo, plugin):
    """Structural check: group/record walk, header counts, master resolution."""
    p = lo.plugin(plugin)
    buf = open(p.path, 'rb').read()
    hsize = struct.unpack_from('<I', buf, 4)[0]
    counts = {"records": 0, "groups": 0}

    def walk(pos, end):
        while pos < end:
            sig = buf[pos:pos + 4]
            size = struct.unpack_from('<I', buf, pos + 4)[0]
            if sig == b'GRUP':
                gend = pos + size
                if gend > end:
                    return "GRUP overruns its parent at offset %d" % pos
                counts["groups"] += 1
                err = walk(pos + 24, gend)
                if err:
                    return err
                pos = gend
            else:
                counts["records"] += 1
                pos += 24 + size
                if pos > end:
                    return "record overruns at offset %d" % pos
        return None

    err = walk(24 + hsize, len(buf))
    declared = p.hedr[1] if p.hedr else None
    actual = counts["records"] + counts["groups"]
    unresolved = sum(1 for _, t, fid, fl, o, s, c in lo.records(p)
                     if (fid >> 24) > len(p.masters) and (fid >> 24) != 0xFE)
    return {"plugin": p.name, "ok": err is None and declared == actual and unresolved == 0,
            "structure_error": err,
            "records": counts["records"], "groups": counts["groups"],
            "hedr_count": declared, "hedr_matches": declared == actual,
            "unresolvable_formids": unresolved,
            "masters": p.masters,
            "missing_masters": [m for m in p.masters if m.lower() not in
                                {q.key for q in lo.plugins}],
            "deleted_records": sum(1 for _, t, f, fl, o, s, c in lo.records(p) if fl & esplib.DEL)}
