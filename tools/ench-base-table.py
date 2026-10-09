# Writes ench-bases.json: python3 -I tools/ench-base-table.py /opt/skyrim-data <fork>/deploy/skyrim-data/loadorder.txt ench-bases.json
# Light plugins are skipped: the server form index counts full plugins only
# Base enchantments (ENCH with no base of their own that another ENCH names as its base) -> their effects, as server ids
import struct, zlib, sys, json, os
DATA, ORDER, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
def fields(buf):
    i = 0
    while i + 6 <= len(buf):
        t = buf[i:i+4]; n = struct.unpack_from('<H', buf, i+4)[0]
        yield t, buf[i+6:i+6+n]; i += 6+n
def header(data):
    size, flags = struct.unpack_from('<II', data, 4)
    masters = [v[:-1].decode('latin1') for k, v in fields(data[24:24+size]) if k == b'MAST']
    return flags, masters, 24 + size
def enchs(data, off, end, out):
    while off < end:
        t = data[off:off+4]
        if t == b'GRUP':
            size = struct.unpack_from('<I', data, off+4)[0]; label = data[off+8:off+12]; gtype = struct.unpack_from('<I', data, off+12)[0]
            if gtype != 0 or label == b'ENCH': enchs(data, off+24, off+size, out)
            off += size; continue
        size, flags, fid = struct.unpack_from('<III', data, off+4)
        if t == b'ENCH':
            body = data[off+24:off+24+size]
            if flags & 0x40000: body = zlib.decompress(body[4:])
            f = list(fields(body))
            edid = next((v[:-1].decode('latin1') for k, v in f if k == b'EDID'), '')
            enit = next((v for k, v in f if k == b'ENIT'), b'')
            base = struct.unpack_from('<I', enit, 28)[0] if len(enit) >= 32 else 0
            out.append((fid, edid, base, [struct.unpack_from('<I', v)[0] for k, v in f if k == b'EFID']))
        off += 24 + size
order = [l.strip() for l in open(ORDER) if l.strip() and not l.startswith('#')]
index, records = {}, []
n = 0
for name in order:
    data = open(os.path.join(DATA, name), 'rb').read()
    flags, masters, start = header(data)
    if flags & 0x200 or name.lower().endswith('.esl'): continue
    index[name.lower()] = n; own = n; n += 1
    def glob(fid, masters=masters, own=own):
        b = fid >> 24
        if b < len(masters):
            i = index.get(masters[b].lower())
            return None if i is None else (i << 24) | (fid & 0xffffff)
        return (own << 24) | (fid & 0xffffff)
    found = []
    enchs(data, start, len(data), found)
    for fid, edid, base, efids in found:
        records.append((glob(fid), edid, glob(base) if base else 0, [g for g in map(glob, efids) if g]))
final = {}
for fid, edid, base, efids in records: final[fid] = (edid, base, efids)
named = {base for _, base, _ in final.values() if base}
bases = {f'{fid:x}': {'editorId': final[fid][0], 'effects': [f'{e:x}' for e in final[fid][2]]} for fid in sorted(named) if fid in final and not final[fid][1]}
json.dump({'_comment': 'Base enchantments and their effects as server form ids (tools/ench-base-table.py over the server load order); the game marks these known when an item is disenchanted', 'bases': bases}, open(OUT, 'w'), indent=1)
print(len(bases), 'base enchantments')
