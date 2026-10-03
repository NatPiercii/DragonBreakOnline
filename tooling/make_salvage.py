# Builds server/salvage.json (salvage.js): what each weapon and piece of armour breaks down into, at which station and
# from which tier. Nate, 2026-09-28: "we need a way to breakdown armor, weapons, and any books into materials".
#
# An item gives back the materials of the recipe that makes it (a forge, skyforge, tanning rack or loom COBJ; the last
# override in the load order wins). An enchanted or variant item with no recipe of its own takes its template's (WEAP
# CNAM, ARMO TNAM), and one with neither takes the cheapest recipe of an item of its type, shape (WEAP DNAM animation type,
# ARMO BOD2 slots) and material keyword. Only materials come back: ingots, ore, bone and scales, chitin, leather, strips, hides and pelts,
# cloth and thread. Ingredients, soul gems, gems, gold and firewood never do, so nothing rare is laundered through a
# breakdown. The station follows the recipe's main material (its main metal if it has one, else the one it takes most of): metal at the smelter
# (Blacksmith), leather and hide at the tanning rack (Skinner), cloth at the loom (Tailor). A Blacksmith needs the tier
# that works the main metal (skills.json blacksmith tiers); a recipe with a Daedra heart needs Master.
# Books are not listed: salvage.js reads them from their own record.
#
# Recipe (CT 115, 2026-09-28, about a second):
#   python3 tooling/make_salvage.py salvage.json [/opt/skyrim-data] [../fork/deploy/skyrim-data/loadorder.txt]
import json, os, re, struct, sys, zlib

OUT = sys.argv[1] if len(sys.argv) > 1 else 'salvage.json'
DATA = sys.argv[2] if len(sys.argv) > 2 else '/opt/skyrim-data'
ORDER = sys.argv[3] if len(sys.argv) > 3 else os.path.join(os.path.dirname(__file__), '..', '..', 'fork', 'deploy', 'skyrim-data', 'loadorder.txt')

CREATE = {'CraftingSmithingForge', 'CraftingSmithingSkyforge', 'DLC2CraftingSmithingSkaalForge', 'DLC1CraftingDawnguard',
          'CraftingTanningRack', 'MCE_CraftingLoom', 'TailorBench'}
# Material classes, by the material's editor id; the first that matches decides
METAL = re.compile(r'^(Ingot|ingot)|Ingot|^Ore|OreStalhrim|^DragonBone$|^DragonScales$|ChitinPlate|ChaurusChitin|GlacialCrystal|DwarvenScrap|FurPlate', re.I)
LEATHER = re.compile(r'Leather|Strips|Hide$|Hide\d*$|Pelt', re.I)
CLOTH = re.compile(r'Thread|Linen|Cloth', re.I)
STATION = [('smelter', 'blacksmith', METAL), ('tanning', 'skinner', LEATHER), ('loom', 'tailor', CLOTH)]
# The Blacksmith tier (0 Novice .. 4 Master) that works each main metal, from the skills.json tiers: iron; steel, elven,
# dwarven; orcish, glass, scaled; ebony, dragon; daedric. A metal not listed needs Journeyman.
METAL_TIER = {'ingotiron': 0, 'bskingotcopper': 0, 'bskingotbronze': 0, 'bskingotbrass': 0, 'dwarvenscrapmetal': 0,
              'ingotsteel': 1, 'ingotimoonstone': 1, 'ingotdwarven': 1, 'ingotcorundum': 1, 'ingotquicksilver': 1,
              'ingotsilver': 1, 'ingotgold': 1,
              'ingotorichalcum': 2, 'ingotmalachite': 2, 'dlc2chitinplate': 2, 'chauruschitin': 2, 'iamiboiledchitinplate': 2,
              'iamiingotglacialcrystal': 2, 'ccbgssse025_ingotamber': 2, 'iamifurplate': 0,
              'ingotebony': 3, 'dragonbone': 3, 'dragonscales': 3, 'dlc2orestalhrim': 3, 'ccbgssse025_ingotmadness': 3}
MASTER_IF = {'daedraheart'}


def subrecords(data):
    i, n, pending = 0, len(data), None
    while i + 6 <= n:
        sig = data[i:i + 4]; size = struct.unpack_from('<H', data, i + 4)[0]; i += 6
        if sig == b'XXXX':
            pending = struct.unpack_from('<I', data, i)[0]; i += size; continue
        if pending is not None:
            size, pending = pending, None
        yield sig, data[i:i + size]
        i += size


order = [l.strip() for l in open(ORDER) if l.strip() and not l.startswith('#')]
case = {n.lower(): n for n in order}
recs = {}  # (plugin lower, local id) -> record, the last override winning


def load(name):
    path = os.path.join(DATA, name)
    if not os.path.exists(path):
        return
    buf = open(path, 'rb').read()
    hsize = struct.unpack_from('<I', buf, 4)[0]
    masters = [v.rstrip(b'\0').decode('cp1252') for s, v in subrecords(buf[24:24 + hsize]) if s == b'MAST']

    def res(f):
        m = f >> 24
        return ((masters[m] if m < len(masters) else name).lower(), f & 0xffffff)
    pos = 24 + hsize
    while pos < len(buf):
        size = struct.unpack_from('<I', buf, pos + 4)[0]; lab = buf[pos + 8:pos + 12]
        if lab in (b'COBJ', b'WEAP', b'ARMO', b'MISC', b'INGR', b'KYWD'):
            q, end = pos + 24, pos + size
            while q < end:
                sig = buf[q:q + 4]; rs = struct.unpack_from('<I', buf, q + 4)[0]
                if sig == b'GRUP':
                    q += rs; continue
                fl, fid = struct.unpack_from('<II', buf, q + 8)
                d = buf[q + 24:q + 24 + rs]
                if fl & 0x40000:
                    try: d = zlib.decompress(d[4:])
                    except zlib.error: d = b''
                subs = list(subrecords(d))
                one = lambda t: next((v for s, v in subs if s == t), None)
                e = {'t': sig.decode(), 'del': bool(fl & 0x20), 'ed': (one(b'EDID') or b'').rstrip(b'\0').decode('cp1252', 'replace'), 'full': one(b'FULL') is not None}
                if sig == b'COBJ':
                    e['items'] = [(res(struct.unpack_from('<I', v, 0)[0]), struct.unpack_from('<i', v, 4)[0]) for s, v in subs if s == b'CNTO']
                    c, b, n1 = one(b'CNAM'), one(b'BNAM'), one(b'NAM1')
                    e['n'] = struct.unpack_from('<H', n1, 0)[0] if n1 and len(n1) >= 2 else 1
                    e['cnam'] = res(struct.unpack_from('<I', c, 0)[0]) if c else None
                    e['bnam'] = res(struct.unpack_from('<I', b, 0)[0]) if b else None
                elif sig in (b'WEAP', b'ARMO'):
                    t = one(b'CNAM' if sig == b'WEAP' else b'TNAM')
                    e['tmpl'] = res(struct.unpack_from('<I', t, 0)[0]) if t else None
                    kw = one(b'KWDA')
                    e['kw'] = [res(struct.unpack_from('<I', kw, j)[0]) for j in range(0, len(kw) - 3, 4)] if kw else []
                    # The shape a stand-in recipe must share: WEAP DNAM animation type, ARMO BOD2 slots
                    shape = one(b'DNAM') if sig == b'WEAP' else one(b'BOD2')
                    e['shape'] = (shape[0] if sig == b'WEAP' else struct.unpack_from('<I', shape, 0)[0]) if shape and len(shape) >= 4 else None
                recs[res(fid)] = e
                q += 24 + rs
        pos += size


for n in order:
    load(n)
ed = lambda k: (recs.get(k) or {}).get('ed', '')
desc = lambda k: '%x:%s' % (k[1], case.get(k[0], k[0]))

# item -> [(material, count per item)], the cheapest creation recipe for it. A recipe that makes several at once (NAM1:
# rings are 2 per ingot) costs its materials divided by that count, or salvage would give back more than the craft took
# (review A5-1, 2026-09-28: 1 ingot became 32 in 5 cycles).
recipe = {}
multi = []  # recipes making more than one, for the log
for e in recs.values():
    if e['t'] != 'COBJ' or e['del'] or not e.get('cnam') or ed(e['bnam']) not in CREATE:
        continue
    if (recs.get(e['cnam']) or {}).get('t') not in ('WEAP', 'ARMO'):
        continue
    mats = [(i, c) for i, c in e['items'] if c > 0 and (recs.get(i) or {}).get('t') in ('MISC', 'INGR')]
    master = any(ed(i).lower() in MASTER_IF for i, c in mats)
    mats = [(i, c) for i, c in mats if recs[i]['t'] == 'MISC' and any(rx.search(ed(i)) for _, _, rx in STATION)]
    if not mats:
        continue
    made = max(1, e.get('n', 1))
    if made > 1:
        multi.append((ed(e['cnam']), made, [(ed(i), c) for i, c in mats]))
    mats = [(i, round(c / made, 4)) for i, c in mats]
    old = recipe.get(e['cnam'])
    if old is None or sum(c for _, c in mats) < sum(c for _, c in old[0]):
        recipe[e['cnam']] = (mats, master)

# An item with no recipe and no template (Beyond Skyrim's own copies, Sentinel's Northern Iron: recipes without a bench)
# takes the cheapest recipe of an item of the same type, shape and material keyword (WeapMaterialElven, ArmorMaterialIron)
MATERIAL_KW = re.compile(r'(Weap|Weapon|Armor)Material', re.I)
material = lambda e: next((ed(k) for k in e.get('kw', []) if MATERIAL_KW.search(ed(k))), None)
standin = {}
for k, e in recs.items():
    if e['t'] not in ('WEAP', 'ARMO') or e['del'] or k not in recipe or e.get('shape') is None:
        continue
    m = material(e)
    if not m:
        continue
    key = (e['t'], m.lower(), e['shape'])
    if key not in standin or sum(c for _, c in recipe[k][0]) < sum(c for _, c in standin[key][0]):
        standin[key] = recipe[k]

# The station follows the main metal whenever the recipe has one: a steel helmet's leather strips never send it to the
# tanning rack (3 Oct, #bugs: Elven and Steel at the rack); otherwise the material it takes most of
def main_of(mats):
    metal = [x for x in mats if METAL.search(ed(x[0]))]
    # Equal counts go to the harder metal: an Elven axe's one moonstone, not its one iron
    return max(metal or mats, key=lambda x: (x[1], METAL_TIER.get(ed(x[0]).lower(), 2) if metal else 0))[0]

items, stats = {}, {'smelter': 0, 'tanning': 0, 'loom': 0, 'fromTemplate': 0, 'byMaterial': 0}
for k, e in recs.items():
    if e['t'] not in ('WEAP', 'ARMO') or e['del'] or not e['full']:
        continue
    r, t, hops = recipe.get(k), e.get('tmpl'), 0
    while r is None and t and hops < 4:
        r = recipe.get(t); t = (recs.get(t) or {}).get('tmpl'); hops += 1
    if r is None and material(e) and e.get('shape') is not None:
        r = standin.get((e['t'], material(e).lower(), e['shape']))
        stats['byMaterial'] += 1 if r is not None else 0
    if r is None:
        continue
    mats, master = r
    main = main_of(mats)
    station, skill, _ = next(s for s in STATION if s[2].search(ed(main)))
    tier = 4 if master else (METAL_TIER.get(ed(main).lower(), 2) if station == 'smelter' else 0)
    items[desc(k)] = [station, tier, [[desc(i), c] for i, c in sorted(mats, key=lambda x: (x[0] != main, -x[1]))]]
    stats[station] += 1
    stats['fromTemplate'] += 1 if hops else 0

names = {}
for v in items.values():
    for d, _ in v[2]:
        k = (d.split(':', 1)[1].lower(), int(d.split(':', 1)[0], 16))
        names[d] = ed(k)
for name, made, mats in sorted(multi):
    print('makes %d: %s from %s' % (made, name, ', '.join('%d %s' % (c, m) for m, c in mats)))
json.dump({'_comment': 'Generated by tooling/make_salvage.py (see its header): item desc -> [station, tier 0..4, [[material desc, count per item]...]], the main material first; a count below 1 is a recipe that makes several at once. materialEditorIds for the log. Read by salvage.js.',
           'items': items, 'materialEditorIds': names}, open(OUT, 'w'), separators=(',', ':'))
print(len(items), 'items', stats, len(names), 'materials')
