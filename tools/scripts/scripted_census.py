#!/usr/bin/env python3
"""Census of the scripted objects a player can use inside the Bruma lock (Road to Alpha: "some scripted objects don't
work on the server"). Scope: references in the lock's worlds (Cyrodiil inside the 18-point border REGN 0B0CBCDD, and
the three small Bruma worlds), plus every interior reached by load doors from there in an allowed plugin. For each
ACTI/DOOR/FURN/CONT/FLOR with a script (base or reference VMAD): its scripts, whether the server's script store has
them (Skyrim - Misc.bsa, the one archive the server loads, plus data/scripts), and how often the logs name them.

    sudo python3 tools/scripts/scripted_census.py <rows.json>
    sudo python3 tools/scripts/pex_natives.py <rows.json>    which vanilla scripts call natives the server lacks

Read only. See REPORT_2026-09-30.md beside this file.
"""
import sys, os, struct, re, json, collections
sys.path.insert(0, os.path.expanduser('~nate/dragonbreak/ck-mcp'))
import esplib, bsastrings
DATA = '/opt/skyrim-data'
ORDER = [l.strip() for l in open(os.path.expanduser('~nate/dragonbreak/fork/deploy/skyrim-data/loadorder.txt')) if l.strip() and not l.startswith('#')]
VM = {k.split('/')[-1][:-4] for k in bsastrings._Bsa(os.path.join(DATA, 'Skyrim - Misc.bsa')).files if k.endswith('.pex')}
VM |= {f[:-4].lower() for f in os.listdir('/opt/alduinak/build/dist/server/data/scripts') if f.endswith('.pex')}
ALLOWED_WORLDS = {('bsheartland.esm', 0xa764b), ('bsheartland.esm', 0x6ade1), ('bsheartland.esm', 0x7f126), ('bsheartland.esm', 0xb95a6)}
ALLOWED_PLUGINS = {'bsheartland.esm', 'bsassets.esm'}
ALLOWED_CELLS = {('dragonbreak online edits.esp', 0x130040)}
USABLE = {'ACTI', 'DOOR', 'FURN', 'CONT', 'FLOR'}
plugs = []
for n in ORDER:
    p = os.path.join(DATA, n)
    if os.path.exists(p):
        pl = esplib.Plugin(p); pl.fh = open(p, 'rb'); pl.name_ = n; plugs.append(pl)
full = light = 0; gid = {}
for pl in plugs:
    if pl.esl: gid[pl.key] = (0xFE000000 | (light << 12), 0xFFF); light += 1
    else: gid[pl.key] = (full << 24, 0xFFFFFF); full += 1
G = lambda k: (gid[k[0]][0] | (k[1] & gid[k[0]][1])) & 0xFFFFFFFF if k[0] in gid else None
refs, bases = {}, {}
for pl in plugs:
    for t, fid, fl, off, sz, ctx in pl.index:
        k = pl.modindex_source(fid)
        if k[0] is None: continue
        if t in ('REFR', 'ACHR'): refs[k] = (t, pl, off, sz, fl, ctx)
        elif t in USABLE or t in ('TACT', 'REGN', 'BOOK', 'STAT', 'MSTT', 'LIGH', 'MISC'): bases[k] = (t, pl, off, sz, fl)
subs = lambda r: dict(esplib.subrecords(r[1].data_at(r[1].fh, r[2], r[3], r[4])))
def all_scripts(vmad):
    # every script name in a VMAD (walk properties properly)
    out = []
    if not vmad or len(vmad) < 6: return out
    def wstr(o): n = struct.unpack_from('<H', vmad, o)[0]; return vmad[o+2:o+2+n].decode('cp1252', 'replace'), o + 2 + n
    def val(o, typ):
        if typ == 1: return o + 8
        if typ == 2: return wstr(o)[1]
        if typ in (3, 4): return o + 4
        if typ == 5: return o + 1
        if typ in (11, 12, 13, 14, 15):
            c = struct.unpack_from('<I', vmad, o)[0]; o += 4
            for _ in range(c): o = val(o, typ - 10)
            return o
        raise ValueError
    try:
        n = struct.unpack_from('<H', vmad, 4)[0]; o = 6
        for _ in range(n):
            nm, o = wstr(o); o += 1; pc = struct.unpack_from('<H', vmad, o)[0]; o += 2; out.append(nm)
            for _ in range(pc):
                _, o = wstr(o); typ = vmad[o]; o += 2; o = val(o, typ)
    except Exception: pass
    return out
# border polygon
regn = None
for pl in plugs:
    for t, fid, fl, off, sz, ctx in pl.index:
        if t == 'REGN' and pl.modindex_source(fid) == ('bsheartland.esm', 0xcbcdd):
            regn = [v for s, v in esplib.subrecords(pl.data_at(pl.fh, off, sz, fl)) if s == b'RPLD'][0]
poly = [struct.unpack_from('<2f', regn, i) for i in range(0, len(regn), 8)]
def inside(x, y):
    c = False
    for i in range(len(poly)):
        x1, y1 = poly[i]; x2, y2 = poly[(i + 1) % len(poly)]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1: c = not c
    return c
# scope: exterior refs, then BFS through load doors into interiors
def where(r):
    t, pl, off, sz, fl, ctx = r
    w = pl.modindex_source(ctx[0]) if ctx and ctx[0] else None
    c = pl.modindex_source(ctx[1]) if ctx and ctx[1] else None
    return w, c
cell_refs = collections.defaultdict(list); in_scope = set(); door_target = {}
for k, r in refs.items():
    w, c = where(r)
    if r[4] & 0x20: continue
    s = subs(r)
    pos = struct.unpack('<3f', s[b'DATA'][:12]) if len(s.get(b'DATA', b'')) >= 12 else None
    if w: 
        if w in ALLOWED_WORLDS and pos and (w != ('bsheartland.esm', 0xa764b) or inside(pos[0], pos[1])): in_scope.add(k)
    elif c: cell_refs[c].append(k)
    if len(s.get(b'XTEL', b'')) >= 4: door_target[k] = r[1].modindex_source(struct.unpack('<I', s[b'XTEL'][:4])[0])
ref_cell = {}
for c, ks in cell_refs.items():
    for k in ks: ref_cell[k] = c
frontier = [door_target[k] for k in list(in_scope) if k in door_target]
cells = set()
while frontier:
    tgt = frontier.pop()
    c = ref_cell.get(tgt)
    if not c or c in cells: continue
    if c[0] not in ALLOWED_PLUGINS and c not in ALLOWED_CELLS: continue
    cells.add(c)
    for k in cell_refs[c]:
        in_scope.add(k)
        if k in door_target: frontier.append(door_target[k])
# activations from the logs
acts = collections.Counter(); missing = collections.Counter()
for L in ('/var/log/skymp-server.log.1', '/var/log/skymp-server.log'):
    for line in open(L, encoding='utf-8', errors='replace'):
        m = re.search(r'ProcessActivate ([0-9a-f]+) ', line)
        if m: acts[int(m.group(1), 16)] += 1
        m = re.search(r"Script '([^']+)' not found", line)
        if m: missing[m.group(1).lower()] += 1
rows = []
for k in in_scope:
    r = refs[k]
    s = subs(r)
    if len(s.get(b'NAME', b'')) < 4: continue
    b = r[1].modindex_source(struct.unpack('<I', s[b'NAME'][:4])[0])
    if b not in bases or bases[b][0] not in USABLE: continue
    bs = subs(bases[b])
    sc = all_scripts(bs.get(b'VMAD')) + all_scripts(s.get(b'VMAD'))
    if not sc: continue
    rows.append({'ref': '%x:%s' % (k[1], k[0]), 'gid': G(k), 'type': bases[b][0], 'base': bs.get(b'EDID', b'').rstrip(b'\0').decode('cp1252', 'replace'),
                 'scripts': sc, 'disabled': bool(r[4] & 0x800), 'acts': acts.get(G(k) or 0, 0)})
json.dump(rows, open(sys.argv[1], 'w'))
print(f'scope: {len(in_scope)} refs ({len(cells)} interior cells reached); scripted usable refs: {len(rows)}')
by = collections.defaultdict(lambda: {'refs': 0, 'enabled': 0, 'acts': 0, 'types': collections.Counter(), 'bases': collections.Counter()})
for r in rows:
    for scr in r['scripts']:
        g = by[scr.lower()]; g['refs'] += 1; g['enabled'] += not r['disabled']; g['acts'] += r['acts']; g['types'][r['type']] += 1; g['bases'][r['base']] += 1
print(f"{'script':44s} {'VM?':4s} {'refs':>5s} {'enab':>5s} {'acts':>5s} {'miss':>5s}  types / bases")
for scr, g in sorted(by.items(), key=lambda kv: (-kv[1]['acts'], -missing.get(kv[0], 0), -kv[1]['enabled'])):
    print(f"{scr:44s} {'yes' if scr in VM else 'NO':4s} {g['refs']:5d} {g['enabled']:5d} {g['acts']:5d} {missing.get(scr, 0):5d}  {dict(g['types'])} {', '.join(b for b, _ in g['bases'].most_common(3))}")
