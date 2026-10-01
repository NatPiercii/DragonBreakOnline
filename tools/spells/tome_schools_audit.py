#!/usr/bin/env python3
"""Every spell tome in spell-tomes.json and readables.json, reclassified from the winning SPEL record in the server's load
order. A spell's school and rank come from its first effect's MGEF (magic skill at DATA+0x0C, minimum skill level at
DATA+0x28; a half-cost perk's rank word wins, as ck-mcp/readables.py does), which is also its costliest effect for every
tome in this load order. ck-mcp/readables.py took the LAST effect instead: core.subrecords is a dict, so a second EFID
overwrote the first. Spectral Arrow, Command Daedra and Paralyze (whose last effect is a free Restoration stagger) came
out Restoration (#bugs 1555203751822762084, 1 Oct). Exit 1 on any tome recorded wrongly.

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
    efid = next((v for s, v in sb if s == b'EFID'), b'')   # the FIRST effect, as the game's main effect here
    mk = win.get(('MGEF', canon_in(k[0], struct.unpack('<I', efid)[0]))) if len(efid) == 4 else None
    d = next((v for s, v in subs(mk) if s == b'DATA'), b'') if mk else b''
    if len(d) < 44: return None
    return AVI.get(struct.unpack_from('<i', d, 12)[0]), rank(struct.unpack_from('<I', d, 40)[0], perk)

bad = 0
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
print('all tomes match their spells' if not bad else f'{bad} tome(s) recorded wrongly')
sys.exit(1 if bad else 0)
