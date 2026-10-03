#!/usr/bin/env python3
"""The interior cells behind the claimed house doors in housing.json (server form ids), as "local:Plugin" descs, for
tools/loot/gearswap_dryrun.js's count of what player houses hold. Read-only; ck-mcp's esplib.
    python3 tools/loot/house_cells.py <housing.json> <loadorder.txt> <data dir> > house-cells.json"""
import json, os, struct, sys
sys.path.insert(0, os.environ.get('DBO_ESPLIB', os.path.expanduser('~nate/dragonbreak/ck-mcp')))
from esplib import Plugin, subrecords  # noqa: E402


def main(housing, order_file, data):
    order = [l.strip().lstrip('*') for l in open(order_file, encoding='utf-8-sig') if l.strip() and not l.startswith('#')]
    full = []
    plugins = {}
    for n in order:
        p = Plugin(os.path.join(data, n))
        plugins[n] = p
        if not (p.esl or n.lower().endswith('.esl')):
            full.append(n)
    out = set()
    for door in json.load(open(housing)):
        door = int(door) & 0xffffffff
        if door >> 24 == 0xfe or door >> 24 >= len(full):
            continue
        name = full[door >> 24]
        p = plugins[name]
        own = len(p.masters)
        recs = {fid & 0xffffff: (sig, fl, off, sz, ctx) for sig, fid, fl, off, sz, ctx in p.index if fid >> 24 == own}
        r = recs.get(door & 0xffffff)
        if not r:
            continue
        # A house door is claimed on either side: the house is whichever side is an interior (no worldspace)
        if not r[4][0] and r[4][1]:
            csrc, cloc = p.modindex_source(r[4][1])
            out.add('%x:%s' % (cloc, next((n for n in order if n.lower() == csrc), csrc)))
            continue
        with open(p.path, 'rb') as fh:
            d = p.data_at(fh, r[2], r[3], r[1])
        dest = next((struct.unpack_from('<I', v, 0)[0] for s, v in subrecords(d) if s == b'XTEL'), None)
        if dest is None:
            continue
        src, loc = p.modindex_source(dest)
        dp = plugins.get(next((n for n in order if n.lower() == src), ''), None)
        if not dp:
            continue
        downer = len(dp.masters)
        dr = next((c for sig, fid, fl, off, sz, c in dp.index if fid >> 24 == downer and fid & 0xffffff == loc and sig == 'REFR'), None)
        if dr and not dr[0] and dr[1]:
            csrc, cloc = dp.modindex_source(dr[1])
            out.add('%x:%s' % (cloc, next((n for n in order if n.lower() == csrc), csrc)))
    json.dump(sorted(out), sys.stdout)


if __name__ == '__main__':
    main(*sys.argv[1:4])
