#!/usr/bin/env python3
"""For the vanilla scripts on the census's usable objects: which natives each one names that the live server logged as
"Method not found" since 27 Sep 17:30 (when fork 9cf18be2 cut the server's script skip list to six and these scripts
started running). Reads each script's string table out of Skyrim - Misc.bsa. Read only.

    sudo python3 tools/scripts/pex_natives.py <rows.json from scripted_census.py>
"""
import sys, os, struct, re, json, collections
sys.path.insert(0, os.path.expanduser('~nate/dragonbreak/ck-mcp'))
import bsastrings
B = bsastrings._Bsa('/opt/skyrim-data/Skyrim - Misc.bsa')
def strings(name):
    key = next((k for k in B.files if k.endswith('/' + name.lower() + '.pex')), None)
    if not key: return None
    d = B.read(key)
    o = 4 + 1 + 1 + 2 + 8   # magic, major, minor, game id, compile time (the magic is big-endian 0xFA57C0DE)
    def ws(o): n = struct.unpack_from('>H', d, o)[0]; return d[o+2:o+2+n].decode('cp1252', 'replace'), o + 2 + n
    for _ in range(3): _, o = ws(o)          # source file, user, machine
    n = struct.unpack_from('>H', d, o)[0]; o += 2; out = []
    for _ in range(n): s, o = ws(o); out.append(s)
    return out
# natives logged missing since the skip list was cut (27 Sep 17:30)
missing = collections.Counter()
for line in open('/var/log/skymp-server.log', encoding='utf-8', errors='replace'):
    if line[1:17] < '2026-09-27 17:30': continue
    m = re.search(r"Method not found - '([^']+)'", line)
    if m: missing[m.group(1).lower()] += 1
rows = json.load(open(sys.argv[1]))
usable = collections.defaultdict(lambda: {'refs': 0, 'bases': collections.Counter()})
for r in rows:
    for s in r['scripts']:
        usable[s.lower()]['refs'] += 1; usable[s.lower()]['bases'][r['base']] += 1
out = []
for s, g in usable.items():
    st = strings(s)
    if st is None: continue
    calls = sorted({x for x in st if x.lower() in missing})
    out.append((s, g['refs'], ', '.join(b for b, _ in g['bases'].most_common(2)), calls, sum(missing[c.lower()] for c in calls)))
for s, n, b, calls, hits in sorted(out, key=lambda x: (-x[4], -x[1])):
    if calls: print(f'{s:40s} {n:4d} refs  {b[:50]:50s} missing natives: {", ".join(calls)} ({hits} log errors since 27 Sep)')
print('vanilla scripts on usable objects with no missing native in the log:', ', '.join(s for s, n, b, calls, hits in sorted(out, key=lambda x: -x[1]) if not calls)[:1500])
