#!/usr/bin/env python3
"""Builds server/gear-swap.json: for every weapon and armour of a family above the steel cap (loottiers.js 'capped', or a
never-loot family), the plain in-cap item a player gets in its place (gearswap.js; Nate, 1 Oct 2026: "replace the glass
armor/weapons/high-end ingots to the caps ... so steel/iron etc.").

The replacement keeps the kind: a weapon of the same type (sword, dagger, war axe, mace, greatsword, battleaxe, warhammer,
bow, crossbow) in steel or Imperial steel, heavy armour of the same slot (body, head, hands, feet, shield) in steel or
Imperial, light armour of the same slot in leather or hide. It comes from the loot pools (loot.json, plain items only) and
from the original's province (loot.json "p"; Beyond Skyrim's own plugins are Cyrodiil), so a Cyrodiil piece becomes a
Cyrodiil one. Ingots and ores above the cap are listed with their replacement (a steel ingot, iron ore) for Nate to edit.

    python3 tools/loot/steel_swap_map.py            # from server/, after loot_materials.py
Reads /opt/skyrim-data with ck-mcp's esplib, like loot_materials.py. Re-run after plugin changes and commit the result."""
import json, os, re, struct, sys

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.abspath(os.path.join(HERE, '..', '..'))
sys.path.insert(0, HERE)
from loot_materials import DATA, ORDER, ESPLIB, canon  # noqa: E402

# loottiers.js: the steel cap and the families never loot (kept in step by the harness)
CAP = {'iron', 'hide', 'leather', 'studded', 'wood', 'goblin', 'ancient_nord', 'falmer', 'forsworn', 'steel', 'imperial', 'silver'}
TIERED_ABOVE = {'dwarven', 'elven', 'bonemold', 'chitin', 'mithril', 'vampire', 'ancient_nord_honed', 'falmer_honed',
                'ancient_imperial', 'ayleid', 'steelplate', 'scaled', 'elven_gilded', 'nordic', 'glass'}
NEVER = {'DRAGON', 'DAEDRIC', 'EBONY', 'stalhrim', 'orcish', 'golden', 'aetherium'}
# The replacement for each kind, by province: plain vanilla steel and leather, Cyrodiil's Colovian steel and CYR leather
TABLE = {
    'skyrim': {
        'weapon Sword': 'SteelSword', 'weapon Dagger': 'SteelDagger', 'weapon WarAxe': 'SteelWarAxe', 'weapon Mace': 'SteelMace',
        'weapon Greatsword': 'SteelGreatsword', 'weapon Battleaxe': 'SteelBattleaxe', 'weapon Warhammer': 'SteelWarhammer',
        'weapon Bow': 'HuntingBow', 'weapon Crossbow': 'DLC1CrossBow',
        'heavy body': 'ArmorSteelCuirassA', 'heavy head': 'ArmorSteelHelmetA', 'heavy hands': 'ArmorSteelGauntletsA',
        'heavy feet': 'ArmorSteelBootsA', 'heavy shield': 'ArmorSteelShield',
        'light body': 'ArmorLeatherCuirass', 'light head': 'ArmorLeatherHelmet', 'light hands': 'ArmorLeatherGauntlets',
        'light feet': 'ArmorLeatherBoots', 'light shield': 'ArmorHideShield',
    },
    'cyrodiil': {
        'weapon Sword': 'CYRSteelSword', 'weapon Dagger': 'CYRSteelDagger', 'weapon WarAxe': 'CYRSteelWarAxe', 'weapon Mace': 'CYRSteelMace',
        'weapon Greatsword': 'CYRSteelGreatsword', 'weapon Battleaxe': 'CYRSteelBattleaxe', 'weapon Warhammer': 'CYRSteelWarhammer',
        'weapon Bow': 'HuntingBow', 'weapon Crossbow': 'DLC1CrossBow',
        'heavy body': 'CYRArmorColovianSteelCuirass', 'heavy head': 'CYRArmorColovianSteelHelmet',
        'heavy hands': 'CYRArmorColovianSteelGauntlets', 'heavy feet': 'CYRArmorColovianSteelBoots', 'heavy shield': 'CYRArmorColovianSteelShield',
        'light body': 'CYRArmorLeatherCuirassA', 'light head': 'CYRArmorLeatherHelmetA', 'light hands': 'CYRArmorLeatherGauntletsA',
        'light feet': 'CYRArmorLeatherBootsA', 'light shield': 'CYRArmorLeatherShieldA',
    },
}
WEAP_TYPES = ['Sword', 'Dagger', 'WarAxe', 'Mace', 'Greatsword', 'Battleaxe', 'Warhammer', 'Bow']
CYR_PLUGINS = ('bsheartland.esm', 'bsassets.esm')
# Ingots, ores and dragon parts above the cap: editor id pattern -> what replaces each one (by editor id). These are never
# loot at any cap, the cap lifted too (Nate, 4 Oct: "people should have to craft higher tiers and grind for it"). Meteoric
# Iron is not here on purpose: it is mined (Bleak-Frost Mine), so it is never swapped, and loottiers.js LOOT_ONLY_METALS
# keeps it out of loot.
METALS = [
    (r'^(Ingot(IMoonstone|Malachite|Ebony|Quicksilver|Orichalcum|Dwarven)|BSKIngotAdamantium|DLC2OreStalhrim|DragonBone|DragonScales)$', 'IngotSteel'),
    (r'^(Ore(Moonstone|Malachite|Ebony|Quicksilver|Orichalcum)|BSKOreAdamantium)$', 'OreIron'),
]


# Arrows and bolts above the cap (Jake, 2 Oct: "arrows received above base level ... replaced with the vanilla basic
# arrows"). Base level is the steel cap, as for gear: iron, steel, Forsworn, Draugr, Falmer, Ashlander, Imperial and
# Corkbulb arrows and iron, steel and silver bolts stay. Quest, test and bound ammo is never touched.
AMMO = [
    (r'^(ElvenArrow|GlassArrow|EbonyArrow|DaedricArrow|DaedricArrowXivkyn|DwarvenArrow|OrcishArrow|DLC2NordicArrow|DLC1DragonboneArrow|'
     r'DLC2StalhrimArrow|NordHeroArrow|CYRAyleidArrow|CYRAncientImperialArrow|ccBGSSSE025_(Amber|Madness|DarkSeducer|GoldenSaint)Arrow|'
     r'IW(AnXileel|Dariit|Dragonsteel|Exotic|Justiciar|Seeker)Arrow)$', 'IronArrow'),
    (r'^(DLC1BoltDwarven(ExplodingFire|ExplodingIce|ExplodingShock)?|DLC1BoltSteelExploding(Fire|Ice|Shock)|ccBGSSSE037_(Bonemold|Orcish)Bolt)$',
     'DLC1BoltSteel'),
]


def scan():
    sys.path.insert(0, ESPLIB)
    from esplib import Plugin, subrecords
    order = [l.strip().lstrip('*') for l in open(ORDER, encoding='utf-8-sig') if l.strip() and not l.startswith('#')]
    kywd, items, misc = {}, {}, {}
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
            if sig not in ('KYWD', 'WEAP', 'ARMO', 'MISC', 'AMMO'):
                continue
            c = cn(fid)
            if not c:
                continue
            d = p.data_at(fh, off, size, flags)
            r = {'edid': '', 'kw': [], 'ench': False, 'slots': 0, 'atype': None, 'anim': None, 'value': 0, 'np': False}
            for s, v in subrecords(d):
                if s == b'EDID':
                    r['edid'] = v.rstrip(b'\0').decode('cp1252', 'replace')
                elif s == b'KWDA':
                    r['kw'] = [cn(struct.unpack_from('<I', v, i)[0]) for i in range(0, len(v) - 3, 4)]
                elif s == b'EITM':
                    r['ench'] = True
                elif s == b'BOD2' and len(v) >= 8:
                    r['slots'], r['atype'] = struct.unpack_from('<II', v, 0)
                elif s == b'BODT' and len(v) >= 12:
                    r['slots'], _, r['atype'] = struct.unpack_from('<III', v, 0)
                elif s == b'DNAM' and sig == 'WEAP' and len(v) >= 1:
                    r['anim'] = v[0]
                elif s == b'DATA' and sig in ('WEAP', 'ARMO', 'MISC') and len(v) >= 4:
                    r['value'] = struct.unpack_from('<i', v, 0)[0]
            if sig == 'WEAP' and flags & 0x4:
                r['np'] = True
            if sig == 'ARMO' and flags & 0x4:
                r['np'] = True
            if sig == 'KYWD':
                kywd[c] = r['edid']
            elif sig in ('MISC', 'AMMO'):
                misc[c] = r['edid']
            else:
                r['sig'] = sig
                items[c] = r
    return kywd, items, misc


def weapon_type(r, K):
    names = {K.get(k, '') for k in r['kw'] if k}
    for t in WEAP_TYPES:
        if 'WeapType' + t in names:
            return 'Crossbow' if t == 'Bow' and r['anim'] == 9 else t
    return {1: 'Sword', 2: 'Dagger', 3: 'WarAxe', 4: 'Mace', 5: 'Greatsword', 6: 'Battleaxe', 7: 'Bow', 9: 'Crossbow'}.get(r['anim'])


def armour_slot(r):
    s = r['slots']
    if s & 0x200:
        return 'shield'
    if s & 0x4:
        return 'body'
    if s & 0x3:
        return 'head'
    if s & 0x8:
        return 'hands'
    if s & 0x80:
        return 'feet'
    return None


def kind_of(r, K):
    if r['sig'] == 'WEAP':
        t = weapon_type(r, K)
        return ('weapon', t) if t else None
    slot = armour_slot(r)
    if not slot or r['atype'] not in (0, 1):
        return None
    return ('heavy' if r['atype'] == 1 else 'light', slot)


def main():
    fams = {canon(k): v for k, v in json.load(open(os.path.join(SERVER, 'loot-materials.json')))['items'].items()}
    pools = json.load(open(os.path.join(SERVER, 'loot.json')))['pools']
    prov = {}
    for pool in ('weapons', 'armor', 'ench_weapons', 'ench_armor'):
        for it in pools.get(pool, []):
            prov[canon(it['id'])] = it.get('p') or []
    plain = {canon(it['id']) for pool in ('weapons', 'armor') for it in pools.get(pool, [])}
    faction = {canon(k) for k in json.load(open(os.path.join(SERVER, 'faction-gear.json'))).get('items', {})}
    order = [l.strip().lstrip('*') for l in open(ORDER, encoding='utf-8-sig') if l.strip() and not l.startswith('#')]
    cased = {n.lower(): n for n in order}

    def server_desc(key):
        local, plugin = key.split(':', 1)
        return '%s:%s' % (local, cased.get(plugin, plugin))
    K, items, misc = scan()
    K = {canon(k): v for k, v in K.items()}
    items = {canon(k): v for k, v in items.items()}

    def province_of(key):
        p = prov.get(key)
        if p:
            return 'cyrodiil' if 'cyrodiil' in p and 'skyrim' not in p else 'skyrim'
        return 'cyrodiil' if key.split(':', 1)[1] in CYR_PLUGINS else 'skyrim'

    def fits(key, province):
        p = prov.get(key) or []
        return not p or province in p or (province == 'skyrim' and 'solstheim' in p)

    by_edid_item = {}
    for key, r in items.items():
        by_edid_item.setdefault(r['edid'], key)
    best = {}
    for province, table in TABLE.items():
        for kind, edid in table.items():
            key = by_edid_item.get(edid)
            if not key or fams.get(key) not in CAP or items[key]['np'] or items[key]['ench'] or key in faction:
                sys.exit(f'replacement {edid} ({kind}, {province}) is missing, enchanted, non-playable, a uniform or above the cap: {fams.get(key)}')
            k = kind_of(items[key], K)
            if '%s %s' % k != kind:
                sys.exit(f'replacement {edid} is a {k}, not a {kind}')
            best[tuple(kind.split(' ')) + (province,)] = (0, 0, 0, edid, key)
    swap, missing = {}, {}
    for key, r in sorted(items.items()):
        f = fams.get(key)
        if f not in TIERED_ABOVE and f not in NEVER:
            continue
        if key in faction:
            continue
        k = kind_of(r, K)
        if not k:
            missing[key] = r['edid']
            continue
        province = province_of(key)
        b = best.get((k[0], k[1], province)) or best.get((k[0], k[1], 'skyrim'))
        if not b:
            missing[key] = r['edid']
            continue
        swap[key] = {'to': server_desc(b[4]), 'edid': r['edid'], 'toEdid': b[3], 'family': f, 'kind': '%s %s' % k, 'province': province}
    by_edid = {}
    for key, e in misc.items():
        by_edid.setdefault(e, canon(key))
    metals = {}
    for key, e in sorted(misc.items()):
        for pat, to in METALS:
            if re.search(pat, e) and by_edid.get(to):
                metals[canon(key)] = {'to': server_desc(by_edid[to]), 'edid': e, 'toEdid': to}
    ammo = {}
    for key, e in sorted(misc.items()):
        for pat, to in AMMO:
            if re.search(pat, e) and by_edid.get(to):
                ammo[canon(key)] = {'to': server_desc(by_edid[to]), 'edid': e, 'toEdid': to}
    out = {
        '_comment': 'Generated by tools/loot/steel_swap_map.py: what gearswap.js gives in place of each weapon and armour above '
                    'the steel cap (same type or slot, steel/Imperial or leather/hide, same province), and of each high-end '
                    'ingot, ore and dragon part. Do not edit "items" by hand; "metals" may be trimmed (Nate decides the list). '
                    '"metals" are never loot at any cap, cap "none" too (Nate, 4 Oct); "ammo" and "items" follow the cap.',
        'replacements': {'%s %s %s' % k: {'to': server_desc(v[4]), 'edid': v[3]} for k, v in sorted(best.items())},
        'items': swap,
        'metals': metals,
        'ammo': ammo,
        'unmapped': missing,
    }
    with open(os.path.join(SERVER, 'gear-swap.json'), 'w') as fh:
        json.dump(out, fh, indent=0)
        fh.write('\n')
    print(f'{len(swap)} items mapped, {len(missing)} unmapped, {len(metals)} metals, {len(ammo)} ammo; {len(best)} replacement kinds')


if __name__ == '__main__':
    main()
