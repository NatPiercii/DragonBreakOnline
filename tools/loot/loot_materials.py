#!/usr/bin/env python3
"""Builds server/loot-materials.json: the material family of every weapon and armour in the load order, for the dungeon
loot tiers (loottiers.js; Nate, 1 Oct 2026). Read from the plugins on CT 115 (/opt/skyrim-data, the deployed load order)
with ck-mcp's esplib; the winning record of each WEAP and ARMO counts.

A family comes from the item's material keywords, else its template chain (WEAP CNAM, ARMO TNAM), else its editor id.
A banned material anywhere wins: Ebony, Daedric, Dragon (bone, plate, scale, Keeper, hide, steel), Stalhrim, Orcish.
Clothing, jewellery and staves get families of their own; what none of these places is "unclassified".

    python3 tools/loot/loot_materials.py                 # scan the plugins (a minute or two; nice it)
    python3 tools/loot/loot_materials.py --scan s.json   # reuse a saved scan ({kywd, items}), e.g. the census's
    python3 tools/loot/loot_materials.py --save-scan s.json
Run from server/. Re-run after any plugin change that adds or changes weapons or armour, and commit the result."""
import argparse, json, os, re, struct, sys

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.abspath(os.path.join(HERE, '..', '..'))
DATA = os.environ.get('DBO_DATA', '/opt/skyrim-data')
ORDER = os.environ.get('DBO_LOADORDER', os.path.expanduser('~nate/dragonbreak/fork/deploy/skyrim-data/loadorder.txt'))
ESPLIB = os.environ.get('DBO_ESPLIB', os.path.expanduser('~nate/dragonbreak/ck-mcp'))

# keyword editor id -> family (first match wins, except that a banned family anywhere in the list wins)
KWFAM = [
    (r'Dragonbone|Dragonplate|Dragonscale|DragonPlate|DragonScale', 'DRAGON'),
    (r'Daedric|Madness|_ArmorMaterialGolden$|_WeapMaterialGolden$|_ArmorMaterialDark$|_WeapMaterialDark$', 'DAEDRIC'),
    (r'Ebony', 'EBONY'),
    (r'Stalhrim', 'stalhrim'), (r'Aetherium', 'aetherium'),
    (r'Glass|Amber', 'glass'), (r'ElvenGilded', 'elven_gilded'), (r'Elven', 'elven'), (r'Dwarven', 'dwarven'), (r'Orcish', 'orcish'),
    (r'Nordic', 'nordic'), (r'Golden', 'golden'),
    (r'DraugrHoned', 'ancient_nord_honed'), (r'Draugr', 'ancient_nord'), (r'FalmerHoned|FalmerHardened', 'falmer_honed'), (r'Falmer', 'falmer'),
    (r'Bonemold', 'bonemold'), (r'Chitin|MoragTong', 'chitin'),
    (r'SteelPlate|AdvancedPlate|WAF_ArmorMaterialAdvanced', 'steelplate'), (r'AdvancedScale|Scaled', 'scaled'),
    (r'Silver', 'silver'), (r'Mithril', 'mithril'),
    (r'Vampire', 'vampire'), (r'Dawnguard', 'dawnguard'), (r'Blades', 'blades'), (r'Penitus', 'penitus'), (r'Thalmor', 'elven'),
    (r'ThievesGuild|Linwe|Blackguard', 'thievesguild'),
    (r'SteelChain|Steel', 'steel'), (r'Imperial', 'imperial'),
    (r'Stormcloak', 'stormcloak'), (r'Studded', 'studded'), (r'Forsworn', 'forsworn'),
    (r'Iron', 'iron'), (r'Hunter|Hide|Fur|Wolf', 'hide'), (r'Leather', 'leather'), (r'Wood', 'wood'),
    (r'TH_MaterialAltmer', 'elven'), (r'TH_Material(Bosmer|Dunmer|Common|Guard)|WAF_MaterialFaction', 'guard'),
    (r'Executioner|Giant|Tsun', 'misc'),
]
# editor id fallback (order matters)
EDFAM = [
    (r'Dragon(bone|plate|scale|Bone|Plate|Scale|hide|Hide)|Dragonsteel|DLC1Keeper|DragonPriestDagger', 'DRAGON'),
    (r'Daedric', 'DAEDRIC'), (r'Ebony', 'EBONY'), (r'Stalhrim', 'stalhrim'), (r'Glass|Amber', 'glass'),
    (r'ElvenGilded', 'elven_gilded'), (r'Elven|Thalmor', 'elven'), (r'Dwarven|Dwemer', 'dwarven'), (r'Orcish|Orichalcum', 'orcish'),
    (r'Ayleid', 'ayleid'), (r'AncientImperial', 'ancient_imperial'), (r'Goblin', 'goblin'),
    (r'Nordic', 'nordic'), (r'Draugr|AncientNord', 'ancient_nord'), (r'Falmer', 'falmer'), (r'Forsworn', 'forsworn'),
    (r'Bonemold', 'bonemold'), (r'Chitin', 'chitin'), (r'SteelPlate', 'steelplate'), (r'Scaled', 'scaled'), (r'Steel', 'steel'),
    (r'Imperial|Legion|Colovian', 'imperial'), (r'Silver', 'silver'), (r'Mithril', 'mithril'), (r'Iron', 'iron'),
    (r'Fur|Hide', 'hide'), (r'Leather', 'leather'),
    (r'Cloth|Robe|Hood|Boots|Shoes|Gloves|Hat|Circlet|Ring|Amulet|Necklace|Jewel|Clothes', 'clothing'),
]
BANNED = ('DRAGON', 'DAEDRIC', 'EBONY', 'stalhrim', 'orcish')
BANNED_NAME = re.compile(r'Ebony|Daedric|Dragon(?:plate|scale|bone|hide)|DLC1Keeper|Dragonsteel|DragonPriestDagger|Orcish|Orichalcum|Stalhrim', re.I)


def canon(desc):
    a, b = desc.split(':', 1)
    return '%x:%s' % (int(a, 16), b.lower())


def scan():
    sys.path.insert(0, ESPLIB)
    from esplib import Plugin, subrecords
    order = [l.strip().lstrip('*') for l in open(ORDER, encoding='utf-8-sig') if l.strip() and not l.startswith('#')]
    kywd, items = {}, {}
    for name in order:
        path = os.path.join(DATA, name)
        if not os.path.exists(path):
            continue
        p = Plugin(path)
        fh = open(path, 'rb')

        def cn(fid):
            src, loc = p.modindex_source(fid)
            return '%x:%s' % (loc, src) if src else None
        for (sig, fid, flags, off, size, ctx) in p.index:
            if sig not in ('KYWD', 'WEAP', 'ARMO'):
                continue
            d = p.data_at(fh, off, size, flags)
            c = cn(fid)
            if not c:
                continue
            edid, kw, tmpl = '', [], None
            for s, v in subrecords(d):
                if s == b'EDID':
                    edid = v.rstrip(b'\0').decode('cp1252', 'replace')
                elif s == b'KWDA':
                    kw = [cn(struct.unpack_from('<I', v, i)[0]) for i in range(0, len(v) - 3, 4)]
                elif (s == b'CNAM' and sig == 'WEAP') or (s == b'TNAM' and sig == 'ARMO'):
                    tmpl = cn(struct.unpack('<I', v[:4])[0])
            if sig == 'KYWD':
                kywd[c] = edid
            else:
                items[c] = {'sig': sig, 'edid': edid, 'kw': [k for k in kw if k], 'tmpl': tmpl}
    return {'kywd': kywd, 'items': items}


def classifier(scan_data):
    K = {canon(k): v for k, v in scan_data['kywd'].items()}
    I = {canon(k): v for k, v in scan_data['items'].items()}

    def fam_kw(e):
        for pat, f in KWFAM:
            if re.search(pat, e):
                return f
        return None

    def fam_edid(e):
        for pat, f in EDFAM:
            if re.search(pat, e or ''):
                return f
        return None

    def classify(key, depth=0):
        r = I.get(key)
        if not r:
            return None
        if BANNED_NAME.search(r.get('edid') or ''):
            f = fam_edid(r.get('edid'))
            return f if f in BANNED else 'EBONY'
        names = [K.get(canon(x)) or '' for x in r.get('kw', [])]
        fams = [f for f in (fam_kw(n) for n in names if 'Material' in n) if f]
        if fams:
            for b in BANNED:
                if b in fams:
                    return b
            return fams[0]
        if r.get('tmpl') and depth < 5:
            f = classify(canon(r['tmpl']), depth + 1)
            if f:
                return f
        if any(n in ('ArmorClothing', 'ArmorJewelry', 'VendorItemJewelry', 'VendorItemClothing') or n.startswith('Clothing') for n in names):
            return 'clothing'
        if 'WeapTypeStaff' in names:
            return 'staff'
        return fam_edid(r.get('edid')) or 'unclassified'
    return I, classify


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--scan', help='a saved scan to reuse instead of reading the plugins')
    ap.add_argument('--save-scan', help='write the scan here too')
    ap.add_argument('--out', default=os.path.join(SERVER, 'loot-materials.json'))
    a = ap.parse_args()
    data = json.load(open(a.scan)) if a.scan else scan()
    if a.save_scan:
        json.dump(data, open(a.save_scan, 'w'))
    I, classify = classifier(data)
    fams = {}
    for key in sorted(I):
        fams[key] = classify(key) or 'unclassified'
    counts = {}
    for f in fams.values():
        counts[f] = counts.get(f, 0) + 1
    out = {
        '_comment': 'Generated by tools/loot/loot_materials.py from the plugins (winning WEAP/ARMO records): the material family '
                    'of every weapon and armour, keyword first, then template chain, then editor id; a banned material anywhere '
                    'wins. Read by loottiers.js for the dungeon loot tiers. Do not edit by hand; re-run after plugin changes.',
        'counts': dict(sorted(counts.items(), key=lambda x: -x[1])),
        'items': fams,
    }
    with open(a.out, 'w') as fh:
        json.dump(out, fh, indent=0, sort_keys=False)
        fh.write('\n')
    print(f'{len(fams)} items -> {a.out}; ' + ', '.join(f'{k} {v}' for k, v in list(out["counts"].items())[:12]))


if __name__ == '__main__':
    main()
