#!/usr/bin/env python3
"""Every crafting recipe at the Cook's and the Blacksmith's stations, as the server's load order ends up with it.

    python3 tools/recipes/recipe_census.py <out.json> [--replace "<load-order name>=<path>" ...]

One entry per winning COBJ (the last override; deleted ones dropped), keyed by where the record was first defined
(origin plugin + local id), which is how DBO_BlacksmithTiers.pas finds it on the PC. It holds the bench keyword, the
result (type, value, keywords, armor type, and for a dish its effects), the ingredients and every condition, decoded
and as raw bytes. make_tables.py builds the tier tables from it; verify_recipes.py compares a census taken before
the PC run with one taken after. --replace reads a plugin not yet in /opt/skyrim-data under its load-order name.
Read only.
"""
import argparse, json, os, struct, sys

sys.path.insert(0, os.environ.get('ESPLIB_DIR', os.path.expanduser('~nate/dragonbreak/ck-mcp')))
import esplib  # noqa: E402

# The stations each skill's recipes are made at: skills.json counts.craftKeywords, plus the Survival Mode campfire,
# whose shared recipes a player's menu shows at any campfire that carries the keyword
BENCHES = {
    'cook': ['CraftingCookpot', 'BYOHCraftingOven', 'Camping_CampfireCookingShared'],
    'blacksmith': ['CraftingSmithingForge', 'CraftingSmithingSkyforge', 'DLC2CraftingSmithingSkaalForge', 'DLC1CraftingDawnguard'],
}
TYPES = ('COBJ', 'KYWD', 'PERK', 'SPEL', 'GLOB', 'QUST', 'FACT', 'RACE', 'FLST', 'MGEF', 'ALCH', 'INGR', 'ARMO', 'WEAP',
         'AMMO', 'MISC', 'SLGM', 'BOOK', 'LIGH', 'SCRL')
# Condition functions by index, each one checked against the record type its first parameter points at in this load
# order (HasPerk's parameter is a PERK in 3,920 recipes, HasSpell's a SPEL, GetItemCount's an item, and so on)
FUNCS = {448: 'HasPerk', 264: 'HasSpell', 47: 'GetItemCount', 74: 'GetGlobalValue', 543: 'GetQuestCompleted',
         59: 'GetStageDone', 58: 'GetStage', 182: 'GetEquipped', 130: 'GetPCIsRace', 132: 'GetInFaction', 71: 'GetFactionRank'}
OPS = ['==', '!=', '>', '>=', '<', '<=']


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('out')
    ap.add_argument('--data', default='/opt/skyrim-data')
    ap.add_argument('--order', default=os.path.expanduser('~nate/dragonbreak/fork/deploy/skyrim-data/loadorder.txt'))
    ap.add_argument('--replace', action='append', default=[])
    a = ap.parse_args()
    replace = {k.strip().lower(): v for k, v in (r.split('=', 1) for r in a.replace)}
    names = [l.strip().lstrip('*') for l in open(a.order, encoding='utf-8-sig') if l.strip() and not l.startswith('#')]
    proper, win, used = {}, {}, []
    for n in names:
        path = replace.get(n.lower()) or os.path.join(a.data, n)
        if not os.path.exists(path):
            continue
        p = esplib.Plugin(path)
        p.key = n.lower()
        p.fh = open(path, 'rb')
        proper[n.lower()] = n
        used.append({'name': n, 'path': path, 'size': os.path.getsize(path)})
        for t, fid, fl, off, sz, ctx in p.index:
            if t not in TYPES:
                continue
            s, loc = p.modindex_source(fid)
            if s is None:
                continue
            k = (s.lower(), loc & 0xFFFFFF)
            if fl & esplib.DEL:
                win.pop(k, None)
            else:
                win[k] = (t, p, off, sz, fl)

    cache = {}

    def subs(k):
        if k not in cache:
            t, p, off, sz, fl = win[k]
            cache[k] = list(esplib.subrecords(p.data_at(p.fh, off, sz, fl)))
        return cache[k]

    def first(k, sig):
        for s, v in subs(k):
            if s == sig:
                return v
        return None

    def ref(p, raw):
        s, loc = p.modindex_source(raw)
        return (s.lower(), loc & 0xFFFFFF) if s else None

    def desc(k):
        return '%x:%s' % (k[1], proper.get(k[0], k[0])) if k else None

    def edid(k):
        if not k or k not in win:
            return None
        v = first(k, b'EDID')
        return v.rstrip(b'\0').decode('cp1252', 'replace') if v else ''

    def kwds(k):
        v = first(k, b'KWDA') or b''
        p = win[k][1]
        return [edid(ref(p, x)) or '?' for (x,) in struct.iter_unpack('<I', v[:len(v) // 4 * 4])]

    bench_of = {}
    for skill, lst in BENCHES.items():
        for b in lst:
            bench_of[b] = skill
    out = []
    for k, (t, p, off, sz, fl) in win.items():
        if t != 'COBJ':
            continue
        d = subs(k)
        bn = next((v for s, v in d if s == b'BNAM'), None)
        cn = next((v for s, v in d if s == b'CNAM'), None)
        if bn is None or cn is None:
            continue
        bench = edid(ref(p, struct.unpack('<I', bn[:4])[0]))
        if bench not in bench_of:
            continue
        res = ref(p, struct.unpack('<I', cn[:4])[0])
        conds = []
        for s, v in d:
            if s != b'CTDA' or len(v) < 24:
                continue
            flags = v[0]
            fn = struct.unpack('<H', v[8:10])[0]
            p1 = ref(p, struct.unpack('<I', v[12:16])[0])
            rt = win[p1][0] if p1 in win else None
            use_glob = bool(flags & 0x04)
            comp = edid(ref(p, struct.unpack('<I', v[4:8])[0])) if use_glob else struct.unpack('<f', v[4:8])[0]
            conds.append({'func': FUNCS.get(fn, '#%d' % fn), 'fn': fn, 'op': OPS[flags >> 5] if flags >> 5 < 6 else '?',
                          'or': bool(flags & 0x01), 'comp': comp, 'compIsGlobal': use_glob,
                          'param': edid(p1) if rt else struct.unpack('<I', v[12:16])[0], 'paramType': rt,
                          'runOn': struct.unpack('<I', v[20:24])[0], 'raw': v.hex()})
        ings = []
        for s, v in d:
            if s == b'CNTO':
                ik = ref(p, struct.unpack('<I', v[:4])[0])
                ings.append({'item': edid(ik) or desc(ik), 'type': win[ik][0] if ik in win else None, 'count': struct.unpack('<i', v[4:8])[0]})
        r = {'key': desc(k), 'edid': edid(k), 'file': proper.get(p.key, p.key), 'skill': bench_of[bench], 'bench': bench,
             'result': desc(res), 'resultEdid': edid(res), 'resultType': win[res][0] if res in win else None,
             'count': struct.unpack('<H', next((v for s, v in d if s == b'NAM1'), b'\1\0')[:2])[0],
             'ingredients': ings, 'conditions': conds,
             'raw': {s.decode(): v.hex() for s, v in d if s in (b'CNAM', b'BNAM', b'NAM1', b'COCT')},
             'rawCNTO': [v.hex() for s, v in d if s == b'CNTO']}
        if res in win:
            rt = win[res][0]
            r['resultKeywords'] = kwds(res) if rt in ('ARMO', 'WEAP', 'AMMO', 'MISC', 'ALCH', 'INGR') else []
            if rt == 'ALCH':
                enit = first(res, b'ENIT')
                r['value'] = struct.unpack('<i', enit[:4])[0] if enit else None
                eff, cur = [], None
                for s, v in subs(res):
                    if s == b'EFID':
                        cur = {'effect': edid(ref(win[res][1], struct.unpack('<I', v[:4])[0]))}
                        eff.append(cur)
                    elif s == b'EFIT' and cur is not None:
                        cur['magnitude'], cur['area'], cur['duration'] = struct.unpack('<fII', v[:12])
                r['effects'] = eff
            elif rt == 'ARMO':
                dat = first(res, b'DATA')
                r['value'] = struct.unpack('<i', dat[:4])[0] if dat else None
                bod2 = first(res, b'BOD2')
                r['armorType'] = ['light', 'heavy', 'clothing'][struct.unpack('<I', bod2[4:8])[0]] if bod2 and len(bod2) >= 8 and struct.unpack('<I', bod2[4:8])[0] < 3 else None
            elif rt in ('WEAP', 'AMMO', 'MISC', 'INGR'):
                dat = first(res, b'DATA')
                r['value'] = struct.unpack('<i', dat[:4])[0] if dat and len(dat) >= 4 else None
        out.append(r)
    out.sort(key=lambda r: (r['skill'], r['key'].split(':', 1)[1].lower(), int(r['key'].split(':', 1)[0], 16)))
    json.dump({'plugins': used, 'recipes': out}, open(a.out, 'w'), indent=0)
    by = {}
    for r in out:
        by[(r['skill'], r['bench'])] = by.get((r['skill'], r['bench']), 0) + 1
    print(f'{len(out)} recipes at the Cook\'s and the Blacksmith\'s stations -> {a.out}')
    for (s, b), n in sorted(by.items()):
        print(f'  {n:5d}  {s:10s} {b}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
