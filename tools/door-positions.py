# Writes doors-pos.json: each doors.json load door -> its position and the world or cell the server reports for it.
#   python3 -I tools/door-positions.py <ck-mcp dir> <plugin dir> <loadorder.txt> doors.json doors-pos.json
# The last override in the load order wins, as the server's CombineBrowser does; worldOrCell follows libespm
# GetWorldOrCell: the WRLD of an exterior ref's world-children group, else the CELL of its cell group. Deleted and
# initially disabled refs are left out, as the server never loads them.
import json, os, struct, sys
CK, DATA, ORDER, DOORS, OUT = sys.argv[1:6]
sys.path.insert(0, CK)
import esplib
wanted = set(json.load(open(DOORS))['doors'])
order = [l.strip() for l in open(ORDER) if l.strip() and not l.startswith('#')]
case = {n.lower(): n for n in order}
desc = lambda src, loc: '%x:%s' % (loc, case.get(src, src))
found, skipped = {}, set()
for name in order:
    p = esplib.Plugin(os.path.join(DATA, name))
    with open(p.path, 'rb') as fh:
        for t, fid, flags, off, size, ctx in p.index:
            if t != 'REFR': continue
            src, loc = p.modindex_source(fid)
            if src is None: continue
            key = desc(src, loc)
            if key not in wanted: continue
            # The server never loads a deleted or initially disabled ref (live: 3911 placed = 4049 less 138 disabled)
            if flags & (esplib.DEL | 0x800): found.pop(key, None); skipped.add(key); continue
            skipped.discard(key)
            data = dict(esplib.subrecords(p.data_at(fh, off, size, flags))).get(b'DATA', b'')
            if len(data) < 12: continue
            w, c, g = ctx
            parent = w or c
            if not parent: continue
            psrc, ploc = p.modindex_source(parent)
            if psrc is None: continue
            found[key] = [round(v, 2) for v in struct.unpack_from('<3f', data, 0)] + [desc(psrc, ploc).lower()]
json.dump({'_comment': 'Load door positions from the plugins (tools/door-positions.py), read by tenancy.js instead of loading every door at runtime',
           'doors': found, 'off': sorted(skipped)}, open(OUT, 'w'), separators=(',', ':'))
print(len(found), 'of', len(wanted), 'doors placed,', len(skipped), 'deleted or initially disabled')
