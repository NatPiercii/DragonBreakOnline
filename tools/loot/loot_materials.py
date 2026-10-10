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
    (r'Madness', 'madness'), (r'Daedric|_ArmorMaterialGolden$|_WeapMaterialGolden$|_ArmorMaterialDark$|_WeapMaterialDark$', 'DAEDRIC'),
    (r'Ebony', 'EBONY'),
    (r'Stalhrim', 'stalhrim'), (r'Aetherium', 'aetherium'),
    (r'Amber', 'amber'), (r'Glass', 'glass'), (r'ElvenGilded', 'elven_gilded'), (r'Elven', 'elven'), (r'Dwarven', 'dwarven'), (r'Orcish', 'orcish'),
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
    (r'Madness', 'madness'), (r'Daedric', 'DAEDRIC'), (r'Ebony', 'EBONY'), (r'Stalhrim', 'stalhrim'), (r'GlacialCrystal', 'glacial_crystal'),
    (r'Amber', 'amber'), (r'Glass', 'glass'),
    (r'ElvenGilded', 'elven_gilded'), (r'Elven|Thalmor', 'elven'), (r'Dwarven|Dwemer', 'dwarven'), (r'Orcish|Orichalcum', 'orcish'),
    (r'Ayleid', 'ayleid'), (r'AncientImperial', 'ancient_imperial'), (r'Goblin', 'goblin'),
    (r'Nordic', 'nordic'), (r'Draugr|AncientNord', 'ancient_nord'), (r'Falmer', 'falmer'), (r'Forsworn', 'forsworn'),
    (r'Bonemold', 'bonemold'), (r'Chitin', 'chitin'), (r'SteelPlate', 'steelplate'), (r'Scaled', 'scaled'), (r'Steel', 'steel'),
    (r'Imperial|Legion|Colovian', 'imperial'), (r'Silver', 'silver'), (r'Mithril', 'mithril'), (r'Iron', 'iron'),
    (r'Fur|Hide', 'hide'), (r'Leather', 'leather'),
    (r'Cloth|Robe|Hood|Boots|Shoes|Gloves|Hat|Circlet|Ring|Amulet|Necklace|Jewel|Clothes', 'clothing'),
]
# The families a borrowed keyword gets wrong, and the editor-id test an item of them must pass to stay
LOOKS = {'ancient_nord': r'Draugr|AncientNord|Nordic|Ancient ?Nord', 'ancient_nord_honed': r'Draugr|AncientNord|Ancient ?Nord',
         'dwarven': r'Dwarven|Dwemer|Dwarf'}
# A recipe input's editor id -> its metal's family (first match)
METAL = [(r'^IngotSteel$|^IngotCorundum$', 'steel'), (r'^IngotIron$', 'iron'), (r'^ingotSilver$|^IngotSilver$', 'silver'),
         (r'^IngotEbony$', 'EBONY'), (r'^IngotIMoonstone$|^IngotQuicksilver$', 'elven'), (r'^IngotOrichalcum$', 'orcish'),
         (r'^IngotMalachite$', 'glass'), (r'^IngotDwarven$', 'dwarven'), (r'^BSKIngotBronze$', 'ancient_nord'),
         (r'^DLC2OreStalhrim$', 'stalhrim'), (r'^DragonBone$|^DragonScales$', 'DRAGON'), (r'^DaedraHeart$', 'DAEDRIC'),
         (r'ChitinPlate$|^ChaurusChitin$', 'chitin'), (r'^BSKIngotMeteoricIron$', 'ayleid'), (r'^Leather01$', 'leather')]
BANNED = ('DRAGON', 'DAEDRIC', 'madness', 'EBONY', 'stalhrim', 'orcish')
# Sets whose editor id names them although their keywords borrow another material's (BS Heartland's Ancient Imperial
# weapons carry WeapMaterialSteel, Immersive Armors' Glacial Crystal IAKMaterialGlass/Ebony): the smithing families
# (smithing.json; Nate, 9 Oct) go by the set
EDID_FIRST = [(r'AncientImperial', 'ancient_imperial'), (r'GlacialCrystal', 'glacial_crystal'),
              # the PC's metal reskins (Nexus Patches DBORS_*, 9 Oct) carry their shape's keywords (Ebony on Adamantium...)
              (r'^DBORS_Bronze', 'bronze'), (r'^DBORS_Copper', 'copper'), (r'^DBORS_Brass', 'brass'),
              (r'^DBORS_Adamantium', 'adamantium'), (r'^DBORS_Mithril', 'mithril')]
# Sets named by editor id whose metal pieces borrow another material's keyword (the Ayleid gear Elven, the Goblin gear
# Iron or Leather); their robes and staves stay clothing and staves
SET_BY_NAME = [(r'Ayleid', 'ayleid'), (r'Goblin', 'goblin')]
BANNED_NAME = re.compile(r'Ebony|Daedric|Dragon(?:plate|scale|bone|hide)|DLC1Keeper|Dragonsteel|DragonPriestDagger|Orcish|Orichalcum|Stalhrim', re.I)


def canon(desc):
    a, b = desc.split(':', 1)
    return '%x:%s' % (int(a, 16), b.lower())


def scan():
    sys.path.insert(0, ESPLIB)
    from esplib import Plugin, subrecords
    order = [l.strip().lstrip('*') for l in open(ORDER, encoding='utf-8-sig') if l.strip() and not l.startswith('#')]
    kywd, items, misc, recipes = {}, {}, {}, {}
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
            if sig not in ('KYWD', 'WEAP', 'ARMO', 'MISC', 'COBJ'):
                continue
            d = p.data_at(fh, off, size, flags)
            c = cn(fid)
            if not c:
                continue
            edid, kw, tmpl = '', [], None
            if sig == 'COBJ':
                r = {'product': None, 'bench': None, 'inputs': []}
                for s, v in subrecords(d):
                    if s == b'CNAM' and len(v) >= 4:
                        r['product'] = cn(struct.unpack('<I', v[:4])[0])
                    elif s == b'BNAM' and len(v) >= 4:
                        r['bench'] = cn(struct.unpack('<I', v[:4])[0])
                    elif s == b'CNTO' and len(v) >= 8:
                        r['inputs'].append([cn(struct.unpack_from('<I', v)[0]), struct.unpack_from('<i', v, 4)[0]])
                recipes[c] = r
                continue
            for s, v in subrecords(d):
                if s == b'EDID':
                    edid = v.rstrip(b'\0').decode('cp1252', 'replace')
                elif s == b'KWDA':
                    kw = [cn(struct.unpack_from('<I', v, i)[0]) for i in range(0, len(v) - 3, 4)]
                elif (s == b'CNAM' and sig == 'WEAP') or (s == b'TNAM' and sig == 'ARMO'):
                    tmpl = cn(struct.unpack('<I', v[:4])[0])
            if sig == 'KYWD':
                kywd[c] = edid
            elif sig == 'MISC':
                misc[c] = edid
            else:
                items[c] = {'sig': sig, 'edid': edid, 'kw': [k for k in kw if k], 'tmpl': tmpl}
    return {'kywd': kywd, 'items': items, 'misc': misc, 'recipes': recipes}


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
        for pat, f in EDID_FIRST:
            if re.search(pat, r.get('edid') or ''):
                return f
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
    # A Draugr or Dwarven material keyword on an item that is neither (Immersive Weapons' katanas and cutlasses, Immersive
    # Armors' Boiled Chitin, artifacts) was set for the vanilla perks, not the look: such an item takes the metal its own
    # editor id names (IWSilverKatana: silver), else the family of the main metal of its own creation recipe instead (the PC's 9 Oct follow-ups; Nate: "do it"), and stays as it is
    # without one. The main metal is the ingot or metal input with the largest count (leather only without one).
    M = {canon(k): v for k, v in (scan_data.get('misc') or {}).items()}
    made = {}
    for r in (scan_data.get('recipes') or {}).values():
        bench = K.get(canon(r['bench'])) if r.get('bench') else ''
        if r.get('product') and (not bench or re.match(r'CraftingSmithing(Forge|Skyforge)$|DLC1CraftingDawnguard$', bench)):
            made.setdefault(canon(r['product']), r)

    def main_metal(key):
        r = made.get(key)
        best = None
        for i, n in (r or {}).get('inputs', []):
            e = M.get(canon(i)) if i else None
            f = e and next((f for pat, f in METAL if re.search(pat, e)), None)
            # leather only when the recipe has no metal at all
            rank = (f != 'leather', n) if f else None
            if f and (best is None or rank > best[1]):
                best = (f, rank)
        return best[0] if best else None

    def classify_fixed(key):
        f = classify(key)
        e = (I.get(key) or {}).get('edid') or ''
        if f not in ('clothing', 'staff', 'unclassified') + BANNED:
            for pat, fam in SET_BY_NAME:
                if re.search(pat, e):
                    return fam
        if f in LOOKS and not re.search(LOOKS[f], e):
            by_name = fam_edid(e)
            return (by_name if by_name and by_name not in LOOKS and by_name != 'clothing' else None) or main_metal(key) or f
        return f
    return I, classify_fixed


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
