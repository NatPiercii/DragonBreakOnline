#!/usr/bin/env python3
"""Every spell tome in spell-tomes.json and readables.json, reclassified from the winning SPEL record in the server's load
order. A spell's school and rank come from its COSTLIEST effect, as the engine picks it (GetCostliestEffectIndex): the
effect's MGEF magic skill (DATA+0x0C) and minimum skill level (DATA+0x28). A half-cost perk's rank word wins, as
ck-mcp/readables.py does.
- Effect cost: base cost (DATA+0x04) x max(magnitude, 1)^1.1 x max(duration / 10, 1)^1.1 (the CK and UESP formula); the
  first of equal costs wins.
- The first effect is not always the costliest. Calm, Harmony and Bane of the Undead open with a free perk rider of their
  own school (Worker F's review). So the first effect only happens to give the same school and rank for every tome here.
- ck-mcp/readables.py took the LAST effect instead: core.subrecords is a dict, so a second EFID overwrote the first.
  Spectral Arrow, Command Daedra and Paralyze (whose last effect is a free Restoration stagger) came out Restoration
  (#bugs 1555203751822762084, 1 Oct).
Exit 1 on any tome recorded wrongly. A spell whose two costliest effects are within 10% of each other but of different
schools is printed for a person to judge, without failing.

    python3 tools/spells/tome_schools_audit.py [--data /opt/skyrim-data] [--order <loadorder.txt>] [--server <server dir>]
"""
import argparse, json, os, struct, sys

ap = argparse.ArgumentParser()
ap.add_argument('--data', default='/opt/skyrim-data')
ap.add_argument('--order', default='')
ap.add_argument('--server', default=os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..')))
ap.add_argument('--esplib', default=os.path.expanduser('~nate/dragonbreak/ck-mcp'))
a = ap.parse_args()
sys.path.insert(0, a.esplib)
import esplib  # noqa: E402

order_file = a.order or next((f for f in [os.path.join(os.environ.get('FORK', ''), 'deploy', 'skyrim-data', 'loadorder.txt'),
    os.path.expanduser('~nate/dragonbreak/fork/deploy/skyrim-data/loadorder.txt')] if os.path.isfile(f)), '')
if not order_file: sys.exit('no loadorder.txt (give --order)')
order = [l.strip() for l in open(order_file) if l.strip() and not l.startswith('#')]
AVI = {18: 'Alteration', 19: 'Conjuration', 20: 'Destruction', 21: 'Illusion', 22: 'Restoration'}
WORDS = ['Novice', 'Apprentice', 'Adept', 'Expert', 'Master']
def rank(level, perk=''):
    for i, w in enumerate(WORDS):
        if w.lower() in perk.lower(): return i
    return 0 if level < 25 else 1 if level < 50 else 2 if level < 75 else 3 if level < 100 else 4

plugins, win = {}, {}
for name in order:
    p = esplib.Plugin(os.path.join(a.data, name)); plugins[name] = p
    for sig, fid, flags, off, size, ctx in p.index:
        if sig in ('SPEL', 'MGEF', 'PERK'):
            src, loc = p.modindex_source(fid)
            win[(sig, ((src or name).lower(), loc & 0xFFFFFF))] = (name, flags, off, size)
fhs = {}
def subs(k):
    name, flags, off, size = k
    return list(esplib.subrecords(plugins[name].data_at(fhs.setdefault(name, open(os.path.join(a.data, name), 'rb')), off, size, flags)))
def canon_in(name, fid):
    src, loc = plugins[name].modindex_source(fid); return ((src or name).lower(), loc & 0xFFFFFF)
def edid(sb): return next((v.rstrip(b'\0').decode('cp1252', 'replace') for s, v in sb if s == b'EDID'), '')
def classify(spell_canon):
    k = win.get(('SPEL', spell_canon))
    if not k: return None
    sb = subs(k)
    spit = next((v for s, v in sb if s == b'SPIT'), b'')
    pid = struct.unpack_from('<I', spit, 32)[0] if len(spit) >= 36 else 0
    pk = win.get(('PERK', canon_in(k[0], pid))) if pid else None
    perk = edid(subs(pk)) if pk else ''
    effs, cur = [], None
    for s, v in sb:
        if s == b'EFID' and len(v) == 4: cur = {'id': struct.unpack('<I', v)[0], 'mag': 0.0, 'dur': 0}; effs.append(cur)
        elif s == b'EFIT' and cur is not None and len(v) >= 12: cur['mag'], _, cur['dur'] = struct.unpack_from('<fII', v, 0)
    rows = []
    for e in effs:
        mk = win.get(('MGEF', canon_in(k[0], e['id'])))
        d = next((v for s, v in subs(mk) if s == b'DATA'), b'') if mk else b''
        if len(d) < 44: continue
        base = struct.unpack_from('<f', d, 4)[0]
        cost = base * max(e['mag'], 1.0) ** 1.1 * max(e['dur'] / 10.0, 1.0) ** 1.1
        rows.append((cost, AVI.get(struct.unpack_from('<i', d, 12)[0]), struct.unpack_from('<I', d, 40)[0], edid(subs(mk))))
    if not rows: return None
    best = max(range(len(rows)), key=lambda i: (rows[i][0], -i))   # the costliest; the first of equal costs
    top = sorted(rows, key=lambda r: -r[0])
    if len(top) > 1 and top[0][1] != top[1][1] and top[0][0] > 0 and top[1][0] >= 0.9 * top[0][0]:
        close.append((edid(sb), [(r[3], r[1], round(r[0], 1)) for r in top[:2]]))
    if best != 0: first_not_costliest.append(edid(sb))
    return rows[best][1], rank(rows[best][2], perk)

bad = 0
close, first_not_costliest = [], []
spell_of = {}
for t in json.load(open(os.path.join(a.server, 'spell-tomes.json')))['tomes']:
    src, loc = t['spellId'].rsplit(':', 1); spell_of[t['id']] = (src.lower(), int(loc, 16))
for fname in ('spell-tomes.json', 'readables.json'):
    tomes = json.load(open(os.path.join(a.server, fname)))['tomes']
    for t in tomes:
        sc = spell_of.get(t['id'])
        got = classify(sc) if sc else None
        if got is None: print(f'{fname}: {t["name"]}: its spell is not in this load order'); continue
        if (t['school'], int(t['rank'])) != got:
            bad += 1
            print(f'{fname}: {t["name"]} is recorded {t["school"]} {WORDS[int(t["rank"])]}, its spell is {got[0]} {WORDS[got[1]]}')
    print(f'{fname}: {len(tomes)} tomes checked')
for name, two in sorted(set((n, tuple(t)) for n, t in close)):
    print(f'judge by hand: {name}: its two costliest effects are close and of different schools: {list(two)}')
print(f'the first effect is not the costliest for: {", ".join(sorted(set(first_not_costliest))) or "none"}')
print('all tomes match their spells' if not bad else f'{bad} tome(s) recorded wrongly')
sys.exit(1 if bad else 0)
