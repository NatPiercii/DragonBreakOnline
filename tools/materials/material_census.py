# Census of armor and weapon materials across the DragonBreak load order (final override wins).
# Output: JSON with per-material armor ratings by slot/type and weapon damage by type, sources, and smithing perks.
#   python3 tools/materials/material_census.py <out.json> [--all]
# --all counts every record, templated (enchanted) variants included, instead of one per base item.
# Paths: ESPLIB_DIR (ck-mcp copy with esplib.py), DATA_DIR (plugins), LOADORDER (fork deploy/skyrim-data/loadorder.txt).
import sys, os, struct, json, collections, re
sys.path.insert(0, os.environ.get('ESPLIB_DIR', os.path.expanduser('~/dragonbreak/ck-mcp')))
import esplib

BASE = os.environ.get('DATA_DIR', '/opt/skyrim-data')
ORDER = [l.strip() for l in open(os.environ.get('LOADORDER', os.path.expanduser('~/dragonbreak/fork/deploy/skyrim-data/loadorder.txt'))) if l.strip() and not l.startswith('#')]
ALL = '--all' in sys.argv

final = {}      # (srcplugin, loc) -> (type, plugin, edid, flags, subs list, pluginobj)
for name in ORDER:
    path = os.path.join(BASE, name)
    if not os.path.exists(path):
        continue
    try:
        p = esplib.Plugin(path)
    except Exception as e:
        print('skip', name, e, file=sys.stderr); continue
    with open(path, 'rb') as fh:
        for t, fid, fl, off, sz, ctx in p.index:
            if t not in ('ARMO', 'WEAP', 'KYWD', 'COBJ', 'PERK'):
                continue
            src, loc = p.modindex_source(fid)
            if src is None:
                continue
            d = p.data_at(fh, off, sz, fl)
            if fl & esplib.DEL:
                final.pop((src, loc), None); continue
            subs = list(esplib.subrecords(d))
            edid = None
            for s, v in subs:
                if s == b'EDID':
                    edid = v.rstrip(b'\x00').decode('cp1252', 'replace'); break
            final[(src, loc)] = (t, name, edid or '', fl, subs, p)

def key_of(p, raw):
    return p.modindex_source(raw)

def sub(subs, sig):
    for s, v in subs:
        if s == sig:
            return v
    return None

kwname = {k: v[2] for k, v in final.items() if v[0] == 'KYWD'}
perkname = {k: v[2] for k, v in final.items() if v[0] == 'PERK'}

def keywords(rec):
    t, plug, edid, fl, subs, p = rec
    out = []
    v = sub(subs, b'KWDA')
    if v:
        for (raw,) in struct.iter_unpack('<I', v[: len(v) // 4 * 4]):
            out.append(kwname.get(key_of(p, raw), '?'))
    return out

SLOT = lambda m: 'body' if m & 0x4 else 'shield' if m & 0x200 else 'hands' if m & 0x8 else 'feet' if m & 0x80 else 'head' if m & 0x1003 else ''
ANIM = {1: 'sword', 2: 'dagger', 3: 'waraxe', 4: 'mace', 5: 'greatsword', 6: 'battleaxe/warhammer', 7: 'bow', 8: 'staff', 9: 'crossbow'}
SKIP_ALL = re.compile(r'Dummy|Test|Skin|Naked|Trap|Summoned|Bound|FX', re.I)
SKIP = re.compile(r'^(DLC\d|CYR|BSK?)?Ench|NPC|Trap|Summoned|Bound|Dummy|Test|Unused|Broken|Skin|Naked|^Clothes|Visual|FX', re.I)

armor = collections.defaultdict(lambda: collections.defaultdict(list))   # (mat, type) -> slot -> [(rating, edid, plugin)]
weap = collections.defaultdict(lambda: collections.defaultdict(list))    # mat -> anim -> [(dmg, edid, plugin)]
items_by_key = {}
for k, rec in final.items():
    t, plug, edid, fl, subs, p = rec
    if t == 'ARMO':
        if fl & 0x4 or (not ALL and sub(subs, b'TNAM')) or (SKIP_ALL if ALL else SKIP).search(edid):
            continue
        dn, bod2 = sub(subs, b'DNAM'), sub(subs, b'BOD2')
        if not dn or not bod2 or len(bod2) < 8:
            continue
        rating = struct.unpack_from('<I', dn, 0)[0] / 100
        atype = struct.unpack_from('<I', bod2, 4)[0]
        slot = SLOT(struct.unpack_from('<I', bod2, 0)[0])
        if atype == 2 or not slot or rating <= 0:
            continue
        mats = [x for x in keywords(rec) if re.search(r'ArmorMaterial|Material', x, re.I)] or ['(no material keyword)']
        for m in mats[:1]:
            armor[(m, 'heavy' if atype == 1 else 'light')][slot].append((rating, edid, plug))
        items_by_key[k] = (t, edid, mats[0])
    elif t == 'WEAP':
        if (not ALL and sub(subs, b'CNAM')) or (SKIP_ALL if ALL else SKIP).search(edid):
            continue
        dn, data = sub(subs, b'DNAM'), sub(subs, b'DATA')
        if not dn or not data or len(data) < 10:
            continue
        anim = ANIM.get(dn[0])
        if not anim:
            continue
        # Battleaxes and warhammers share animation type 6 but carry different damage in the ladder, so the type
        # keyword splits them. Without this the two cannot be told apart, and verify_ladder.py cannot prove the split.
        if anim == 'battleaxe/warhammer':
            kws = keywords(rec)
            if 'WeapTypeWarhammer' in kws:
                anim = 'warhammer'
            elif 'WeapTypeBattleaxe' in kws:
                anim = 'battleaxe'
        flags2 = struct.unpack_from('<I', dn, 0x30)[0] if len(dn) > 0x33 else 0
        dmg = struct.unpack_from('<H', data, 8)[0]
        if dmg <= 0:
            continue
        mats = [x for x in keywords(rec) if re.search(r'WeapMaterial|Material', x, re.I)] or ['(no material keyword)']
        weap[mats[0]][anim].append((dmg, edid, plug))
        items_by_key[k] = (t, edid, mats[0])

# Smithing perks per material: the HasPerk conditions (function 448) on recipes that make an item of that material
perks = collections.defaultdict(collections.Counter)
for k, rec in final.items():
    t, plug, edid, fl, subs, p = rec
    if t != 'COBJ':
        continue
    cnam = sub(subs, b'CNAM')
    if not cnam:
        continue
    made = items_by_key.get(key_of(p, struct.unpack_from('<I', cnam, 0)[0]))
    if not made:
        continue
    bnam = sub(subs, b'BNAM')
    bench = kwname.get(key_of(p, struct.unpack_from('<I', bnam, 0)[0]), '?') if bnam else '?'
    if 'Tempering' in bench or 'Sharpening' in bench or 'Armor' == bench:
        continue
    found = False
    for s, v in subs:
        if s == b'CTDA' and len(v) >= 16:
            func = struct.unpack_from('<H', v, 8)[0]
            if func == 448:
                pk = perkname.get(key_of(p, struct.unpack_from('<I', v, 12)[0]), '?')
                perks[made[2]][pk] += 1; found = True
    if not found:
        perks[made[2]]['(no perk)'] += 1

def summarize(lst):
    vals = collections.Counter(x[0] for x in lst)
    top = vals.most_common(1)[0][0]
    ex = next(x for x in lst if x[0] == top)
    return {'value': top, 'n': len(lst), 'range': [min(x[0] for x in lst), max(x[0] for x in lst)], 'example': ex[1], 'plugin': ex[2],
            'plugins': sorted(set(x[2] for x in lst))}

out = {'armor': {}, 'weapons': {}, 'perks': {}}
for (m, ty), slots in armor.items():
    out['armor'][f'{m}|{ty}'] = {s: summarize(v) for s, v in slots.items()}
for m, anims in weap.items():
    out['weapons'][m] = {a: summarize(v) for a, v in anims.items()}
for m, c in perks.items():
    out['perks'][m] = dict(c.most_common(4))
json.dump(out, open(sys.argv[1], 'w'), indent=1)
print('armor materials', len(out['armor']), 'weapon materials', len(out['weapons']))
