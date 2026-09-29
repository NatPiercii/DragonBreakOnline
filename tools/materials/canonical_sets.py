# The canonical sets per material, read by editor id from the final override of the base game and DLC records
# (the census groups by keyword, where modded sets reusing vanilla keywords blur the numbers).
#   python3 tools/materials/canonical_sets.py > canon.txt
# Lines: A <editor id> <rating> <heavy|light> <plugin>  /  W <editor id> <damage> <value> <plugin>
import sys, os, re, struct
sys.path.insert(0, os.environ.get('ESPLIB_DIR', os.path.expanduser('~/dragonbreak/ck-mcp')))
import esplib
BASE = os.environ.get('DATA_DIR', '/opt/skyrim-data')
ORDER = [l.strip() for l in open(os.environ.get('LOADORDER', os.path.expanduser('~/dragonbreak/fork/deploy/skyrim-data/loadorder.txt'))) if l.strip() and not l.startswith('#')]
A = ['Iron', 'Steel', 'SteelA', 'Dwarven', 'Orcish', 'SteelPlate', 'Ebony', 'Dragonplate', 'Daedric', 'Hide', 'Leather', 'Elven', 'Scaled', 'Glass',
     'Dragonscale', 'Studded', 'ElvenLight', 'ImperialHeavy', 'Imperial', 'ImperialLight', 'Blades', 'Falmer', 'Stormcloak']
WANT_A = re.compile(r'^Armor(%s)(Cuirass|CuirassA|Boots|BootsA|Gauntlets|GauntletsA|Helmet|HelmetA|Shield)$' % '|'.join(A))
WANT_DLC = re.compile(r'^DLC2Armor(Stalhrim(Heavy|Light)|Nordic(Heavy|Carved)?|Bonemold(Heavy|Improved)?|Chitin(Heavy|Light))(Cuirass|Boots|Gauntlets|Helmet|Shield)$'
                      r'|^DLC1ArmorDawnguard(Cuirass|Boots|Gauntlets|Helmet)(Heavy|Light)?\d?$|^DLC1ArmorFalmer(Hardened|Heavy)(Cuirass|Boots|Gauntlets|Helmet)$'
                      r'|^CYRArmor.+(Cuirass|Boots|Gauntlets|Bracers|Helmet|Helm|Shield)$')
W = ['Iron', 'Steel', 'Orcish', 'Dwarven', 'Elven', 'Glass', 'Ebony', 'Daedric', 'Silver', 'Draugr', 'Falmer', 'Imperial', 'Forsworn']
WANT_W = re.compile(r'^(CYR)?(%s)(Sword|Dagger|WarAxe|Mace|Greatsword|Battleaxe|Warhammer|Bow)$|^(HuntingBow|LongBow)$'
                    r'|^DLC1Dragonbone(Sword|Dagger|WarAxe|Mace|Greatsword|Battleaxe|Warhammer|Bow)$|^DLC2(Stalhrim|Nordic)(Sword|Dagger|WarAxe|Mace|Greatsword|Battleaxe|Warhammer|Bow)$' % '|'.join(W))
SOURCES = {'skyrim.esm', 'dawnguard.esm', 'dragonborn.esm', 'update.esm', 'hearthfires.esm', 'bsheartland.esm', 'bsassets.esm'}
final = {}
for name in ORDER:
    path = os.path.join(BASE, name)
    if not os.path.exists(path):
        continue
    p = esplib.Plugin(path)
    with open(path, 'rb') as fh:
        for t, fid, fl, off, sz, ctx in p.index:
            if t not in ('ARMO', 'WEAP'):
                continue
            src, loc = p.modindex_source(fid)
            if src not in SOURCES:
                continue
            subs = dict((s, v) for s, v in esplib.subrecords(p.data_at(fh, off, sz, fl)))
            final[(src, loc)] = (t, subs.get(b'EDID', b'').rstrip(b'\0').decode('cp1252', 'replace'), subs, name)
for k, (t, e, s, plug) in sorted(final.items(), key=lambda kv: kv[1][1]):
    if t == 'ARMO' and (WANT_A.match(e) or WANT_DLC.match(e)) and b'DNAM' in s and b'TNAM' not in s:
        print('A', e, struct.unpack_from('<I', s[b'DNAM'], 0)[0] // 100, 'heavy' if struct.unpack_from('<I', s[b'BOD2'], 4)[0] == 1 else 'light', plug)
    if t == 'WEAP' and WANT_W.match(e) and b'DATA' in s and b'CNAM' not in s:
        print('W', e, struct.unpack_from('<H', s[b'DATA'], 8)[0], struct.unpack_from('<I', s[b'DATA'], 0)[0], plug)
