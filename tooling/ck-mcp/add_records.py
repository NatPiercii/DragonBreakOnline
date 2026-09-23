"""Append new records to a plugin at the byte level, copied from vanilla templates, and prove nothing else changed.

    py ck-mcp\\add_records.py <spec.json> [--dry-run]

Why not xEdit: an xEdit save re-serialises every record and has changed 93 unrelated ones in DragonBreak Online Edits.esp
(memory: xedit-resave-mutates-unrelated-records). This touches only the records it adds, the group they go into and the
HEDR counters.

spec: {"target": "<path to plugin>", "out": "<path to write>",
       "records": [{"template": "<plugin path>", "id": "<hex local id>", "sig": "ALCH", "edid": "...",
                    "set": {"FULL": {"str": "..."}, "EFIT": {"hex": "..."}, "DESC": {"str": "..."}}, "drop": ["YNAM"]}]}
A template's form ids are copied as they are, so templates come from a masterless file (Skyrim.esm) that is the target's
master 0 (checked). String subrecords become plain zstrings, which needs a target that is not localized.
"""
import sys, json, struct, argparse
sys.path.insert(0, r"E:\DragonBreak Online Dev files\ck-mcp")
import esplib

# Top-level group order of a Skyrim SE plugin (UESP, Mod File Format)
GROUP_ORDER = ("GMST KYWD LCRT AACT TXST GLOB CLAS FACT HDPT HAIR EYES RACE SOUN ASPC MGEF SCPT LTEX ENCH SPEL SCRL ACTI "
               "TACT ARMO BOOK CONT DOOR INGR LIGH MISC APPA STAT SCOL MSTT PWAT GRAS TREE CLDC FLOR FURN WEAP AMMO NPC_ "
               "LVLN KEYM ALCH IDLM COBJ PROJ HAZD SLGM LVLI WTHR CLMT SPGD RFCT REGN NAVI CELL WRLD DIAL QUST IDLE PACK "
               "CSTY LSCR LVSP ANIO WATR EFSH EXPL DEBR IMGS IMAD FLST PERK BPTD ADDN AVIF CAMS CPTH VTYP MATT IPCT IPDS "
               "ARMA ECZN LCTN MESG RGDL DOBJ LGTM MUSC FSTP FSTS SMBN SMQN SMEN DLBR MUST DLVW WOOP SHOU EQUP RELA SCEN "
               "ASTP OTFT ARTO MATO MOVT SNDR DUAL SNCT SOPM COLL CLFM REVB").split()


def raw_record(path, local_id, sig):
    p = esplib.Plugin(path)
    with open(path, 'rb') as fh:
        for s, f, fl, o, z, c in p.index:
            if s == sig and (f & 0xFFFFFF) == local_id:
                fh.seek(o - 24); head = fh.read(24)
                return p, head, p.data_at(fh, o, z, fl), fl
    sys.exit(f"{sig} {local_id:06x} not found in {path}")


def build(rec, target, next_id):
    tp, head, data, flags = raw_record(rec['template'], int(rec['id'], 16), rec['sig'])
    # A master file's form ids all start 00, which names the same file in the target only if it is the target's master 0
    if tp.masters or [m.lower() for m in target.masters[:1]] != [tp.name.lower()]:
        sys.exit(f"{tp.name}: templates must come from a masterless file that is master 0 of {target.name}")
    subs = [(s, bytes(v)) for s, v in esplib.subrecords(data)]
    sets, drop = rec.get('set', {}), set(rec.get('drop', []))
    sets['EDID'] = {'str': rec['edid']}
    out, seen = [], set()
    for s, v in subs:
        k = s.decode()
        if k in drop: continue
        if k in sets:
            seen.add(k); x = sets[k]
            v = (x['str'].encode('cp1252') + b'\0') if 'str' in x else bytes.fromhex(x['hex'])
        out.append((s, v))
    for k in sets:
        if k not in seen: sys.exit(f"{rec['edid']}: template has no {k} to set")
    body = b''.join(s + struct.pack('<H', len(v)) + v for s, v in out)
    fid = (len(target.masters) << 24) | next_id
    # Same header as the template (form version, version control), uncompressed, under the target's own id
    return rec['sig'].encode() + struct.pack('<III', len(body), flags & ~0x40000, fid) + head[16:24] + body, fid


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('spec'); ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args(); spec = json.load(open(a.spec, encoding='utf-8'))
    buf = bytearray(open(spec['target'], 'rb').read())
    target = esplib.Plugin(spec['target'])
    if target.hflags & 0x80: sys.exit('target is localized; plain strings would be read as string ids')
    hsize = struct.unpack_from('<I', buf, 4)[0]
    # HEDR sits first in the TES4 data: version float, record+group count, next object id
    hpos = 24
    while bytes(buf[hpos:hpos + 4]) != b'HEDR': hpos += 6 + struct.unpack_from('<H', buf, hpos + 4)[0]
    count, next_id = struct.unpack_from('<iI', buf, hpos + 10)
    with open(spec['target'], 'rb') as fh:
        before = {(s, f): (fl, target.data_at(fh, o, z, fl)) for s, f, fl, o, z, c in target.index}

    new = {}
    for rec in spec['records']:
        raw, fid = build(rec, target, next_id); next_id += 1
        new.setdefault(rec['sig'], []).append(raw)
        print(f"  {rec['sig']} {rec['edid']} -> {fid:08x} ({target.name}:{fid & 0xFFFFFF:06x})")
    added_groups = 0
    for sig, raws in new.items():
        blob = b''.join(raws)
        pos, groups = 24 + hsize, []
        while pos < len(buf):
            groups.append((bytes(buf[pos + 8:pos + 12]).decode('ascii', 'replace'), pos))
            pos += struct.unpack_from('<I', buf, pos + 4)[0]
        hit = [g for g in groups if g[0] == sig]
        if hit:
            gpos = hit[0][1]; gsize = struct.unpack_from('<I', buf, gpos + 4)[0]
            buf[gpos + gsize:gpos + gsize] = blob
            struct.pack_into('<I', buf, gpos + 4, gsize + len(blob))
        else:
            rank = GROUP_ORDER.index(sig)
            later = [p for l, p in groups if l in GROUP_ORDER and GROUP_ORDER.index(l) > rank]
            at = later[0] if later else len(buf)
            head = b'GRUP' + struct.pack('<I', 24 + len(blob)) + sig.encode() + struct.pack('<iHHHH', 0, 0, 0, 0, 0)
            buf[at:at] = head + blob; added_groups += 1
    records = sum(len(r) for r in new.values())
    struct.pack_into('<iI', buf, hpos + 10, count + records + added_groups, next_id)

    if a.dry_run: print('dry run, nothing written'); return
    open(spec['out'], 'wb').write(buf)
    # Proof: every record the target had is byte-identical, and only the new ones were added
    after_p = esplib.Plugin(spec['out'])
    with open(spec['out'], 'rb') as fh:
        after = {(s, f): (fl, after_p.data_at(fh, o, z, fl)) for s, f, fl, o, z, c in after_p.index}
    changed = [k for k in before if after.get(k) != before[k]]
    extra = [k for k in after if k not in before]
    if changed or len(extra) != records: sys.exit(f'VERIFY FAILED: {len(changed)} changed, {len(extra)} added (expected {records})')
    print(f"ok: {len(before)} records unchanged, {records} added, {added_groups} new group(s), HEDR {count} -> {count + records + added_groups}, next id {next_id:06x}")


if __name__ == '__main__':
    main()
