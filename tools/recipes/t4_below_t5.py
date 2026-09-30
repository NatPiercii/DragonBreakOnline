#!/usr/bin/env python3
"""Nate, 2026-09-30: "keep ebony at tier 4, stat wise it needs to be less than tier 5, and tier 5 needs to be better".

Checks that every tier 4 item (glass, ebony, stalhrim, amber) is below every tier 5 item (Daedric, dragon, madness) of
the same slot and weight class, in what the server counts:
  armor    the record's rating AFTER the Blacksmith ladder (ladder.tsv, applied here the way DBO_BlacksmithTiers.pas
           applies it), raised by gamemode-config.json armorMaterials where that is higher (gamemode.js armorPieceOf)
  weapons  base damage after the ladder, times 1 + gamemode-config.json weaponMaterials.byKeyword
Tiers are forge_rules.tsv's keyword tiers. Playable records only (ARMO record flag 0x4, WEAP DNAM flag 0x80 mark the
non-playable ones), and only gear a player can get as a material item: a forge result or leveled-list loot, directly or
through the template it was made from. Artifacts (artifacts.json) and named uniques that are neither (Chillrend, the
Nightingale Blade) are staff-granted RP items: they are listed, never changed.

The bands come from the vanilla records (Skyrim, Update, Dawnguard, HearthFires, Dragonborn) after the ladder: the tier
4 ceiling is the highest vanilla tier 4 value of the group as the server counts it, the tier 5 floor the lowest vanilla
tier 5 one. A tier 4 record above the ceiling is brought down to it and a tier 5 record below the floor up to it (a
weapon's whole-number base damage is solved for through its material bonus); everything between is left as its mod
made it. --write puts those changes in stat_clamps.tsv, which DBO_BlacksmithTiers.pas applies after the
ladder. The check is then run again on the clamped values: exit 0 when every group holds, 1 when one does not.

    python3 tools/recipes/t4_below_t5.py [--write] [--replace "<load-order name>=<path>" ...]
"""
import argparse, collections, json, math, os, re, struct, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
sys.path.insert(0, os.environ.get('ESPLIB_DIR', os.path.expanduser('~nate/dragonbreak/ck-mcp')))
import esplib  # noqa: E402

WEAP_TYPES = {1: 'sword', 2: 'dagger', 3: 'waraxe', 4: 'mace', 5: 'greatsword', 7: 'bow', 9: 'crossbow'}


def armor_slot(flags):
    # the same order as DBO_BlacksmithTiers.pas ArmorSlot
    if flags & 0x200: return 'shield'
    if flags & 0x4: return 'body'
    if flags & 0x8: return 'hands'
    if flags & 0x80: return 'feet'
    if flags & 0x1 or flags & 0x1000: return 'head'
    return ''


def load_tiers():
    tiers = {}
    for line in open(os.path.join(HERE, 'forge_rules.tsv'), encoding='utf-8'):
        f = line.rstrip('\n').split('\t')
        if len(f) >= 3 and f[0] == 'keyword':
            tiers[f[1]] = int(f[2])
    return tiers


def load_ladder():
    kw, pat = {}, []
    for line in open(os.path.join(ROOT, 'tools', 'materials', 'ladder.tsv'), encoding='utf-8'):
        if not line.strip() or line.startswith('#'):
            continue
        kind, sel, how, slot, val = [x.strip() for x in line.rstrip('\n').split('\t')[:5]]
        if '*' in sel:
            pat.append((kind, re.compile('^' + '.*'.join(map(re.escape, sel.split('*'))) + '$', re.I), slot, float(val)))
        else:
            kw[(kind, sel, slot)] = float(val)
    return kw, pat


def ladder_value(kind, slot, kws, edid, kw, pat):
    # keyword rules first, then editor-id patterns, as RuleFor in the .pas
    for k in kws:
        if (kind, k, slot) in kw:
            return kw[(kind, k, slot)]
    for kd, rx, sl, v in pat:
        if kd == kind and sl == slot and rx.match(edid or ''):
            return v
    return None


# Named uniques that artifacts.json does not list yet, and one vanilla keyword oddity. They are not material gear, so they
# neither set the bands nor move: quest items by their quest prefix, Immersive Weapons' IWC artifact copies, DragonBreak
# Hub's RP_ artifacts, anything carrying vanilla's DaedricArtifact keyword, and the enchanted Draugr helmets that
# vanilla tags ArmorMaterialDaedric.
UNIQUE = re.compile(r'^(DA\d\d|TG\d\d|MS\d\d|C0\d|DB\d\d|MG\d\d|MQ|IWC|RP_)|^OrcishClanScourge$|^IWAzurasMoon|^EnchArmorDraugr', re.I)
VANILLA = {'skyrim.esm', 'update.esm', 'dawnguard.esm', 'hearthfires.esm', 'dragonborn.esm'}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', default='/opt/skyrim-data')
    ap.add_argument('--order', default=os.path.expanduser('~nate/dragonbreak/fork/deploy/skyrim-data/loadorder.txt'))
    ap.add_argument('--config', default=os.path.join(ROOT, 'gamemode-config.json'))
    ap.add_argument('--artifacts', default=os.path.join(ROOT, 'artifacts.json'))
    ap.add_argument('--replace', action='append', default=[])
    ap.add_argument('--write', action='store_true', help='write stat_clamps.tsv')
    a = ap.parse_args()
    replace = {k.strip().lower(): v for k, v in (r.split('=', 1) for r in a.replace)}
    tiers = load_tiers()
    kwrules, patrules = load_ladder()
    cfg = json.load(open(a.config))
    am = (cfg.get('armorMaterials') or {})
    am = am.get('ratingBySlot', {}) if am.get('enabled') else {}
    wm = (cfg.get('weaponMaterials') or {})
    wm = wm.get('byKeyword', {}) if wm.get('enabled') else {}
    artifacts = [re.compile(x, re.I) for x in json.load(open(a.artifacts)).get('patterns', [])]

    names = [l.strip().lstrip('*') for l in open(a.order, encoding='utf-8-sig') if l.strip() and not l.startswith('#')]
    proper = {n.lower(): n for n in names}
    win, obtainable = {}, set()
    for n in names:
        path = replace.get(n.lower()) or os.path.join(a.data, n)
        if not os.path.exists(path):
            continue
        p = esplib.Plugin(path)
        p.fh = open(path, 'rb')
        for t, fid, fl, off, sz, ctx in p.index:
            if t not in ('ARMO', 'WEAP', 'KYWD', 'LVLI', 'COBJ'):
                continue
            s, loc = p.modindex_source(fid)
            if s is None:
                continue
            k = (s.lower(), loc & 0xFFFFFF)
            if fl & esplib.DEL:
                win.pop(k, None)
            else:
                win[k] = (t, p, off, sz, fl, n)

    def ref(p, raw):
        s, loc = p.modindex_source(raw)
        return (s.lower(), loc & 0xFFFFFF) if s else None
    kwname = {}
    for k, (t, p, off, sz, fl, n) in win.items():
        if t == 'KYWD':
            kwname[k] = esplib.edid_of(p.data_at(p.fh, off, sz, fl)) or ''
        elif t in ('LVLI', 'COBJ'):
            for sig, v in esplib.subrecords(p.data_at(p.fh, off, sz, fl)):
                if sig == b'LVLO' and len(v) >= 8:
                    obtainable.add(ref(p, struct.unpack('<I', v[4:8])[0]))
                elif sig == b'CNAM' and t == 'COBJ':
                    obtainable.add(ref(p, struct.unpack('<I', v[:4])[0]))

    items = []
    for k, (t, p, off, sz, fl, n) in win.items():
        if t not in ('ARMO', 'WEAP'):
            continue
        d = dict(esplib.subrecords(p.data_at(p.fh, off, sz, fl)))
        kv = d.get(b'KWDA', b'')
        kws = [kwname.get(ref(p, raw), '?') for (raw,) in struct.iter_unpack('<I', kv[:len(kv) // 4 * 4])]
        tier = max((tiers[x] for x in kws if x in tiers), default=0)
        if tier not in (4, 5):
            continue
        edid = (d.get(b'EDID', b'').rstrip(b'\0')).decode('cp1252', 'replace')
        tmpl = ref(p, struct.unpack('<I', d[b'TNAM' if t == 'ARMO' else b'CNAM'][:4])[0]) if (b'TNAM' if t == 'ARMO' else b'CNAM') in d else None
        it = {'sig': t, 'key': k, 'edid': edid, 'file': n, 'tier': tier, 'kws': kws,
              'artifact': any(rx.search(edid) for rx in artifacts) or bool(UNIQUE.search(edid)) or 'DaedricArtifact' in kws,
              'obtainable': k in obtainable or (tmpl in obtainable if tmpl else False)}
        if t == 'ARMO':
            if fl & 0x4 or b'BOD2' not in d or b'DNAM' not in d:
                continue
            flags, atype = struct.unpack('<II', d[b'BOD2'][:8])
            slot = armor_slot(flags)
            if not slot or atype > 1:
                continue
            it['group'] = ('armor', ['light', 'heavy'][atype], slot)
            it['now'] = struct.unpack('<i', d[b'DNAM'][:4])[0] / 100
            lad = ladder_value('armor', slot, kws, edid, kwrules, patrules)
            it['after'] = it['now'] if lad is None else lad
            it['raise'] = max([am[x][slot] for x in kws if x in am and slot in am[x]] or [0])
        else:
            if b'DNAM' not in d or b'DATA' not in d:
                continue
            dn = d[b'DNAM']
            if len(dn) > 13 and struct.unpack('<H', dn[12:14])[0] & 0x80:
                continue
            wtype = 'warhammer' if dn[0] == 6 and 'WeapTypeWarhammer' in kws else 'battleaxe' if dn[0] == 6 else WEAP_TYPES.get(dn[0])
            if not wtype:
                continue
            it['group'] = ('weapon', '', wtype)
            it['now'] = struct.unpack('<H', d[b'DATA'][8:10])[0]
            lad = ladder_value('weapon', wtype, kws, edid, kwrules, patrules)
            it['after'] = it['now'] if lad is None else lad
            it['bonus'] = max([wm[x] for x in kws if x in wm] or [0])
        items.append(it)

    def counted(it, base):
        return max(base, it['raise']) if it['sig'] == 'ARMO' else round(base * (1 + it['bonus']), 2)
    groups = collections.defaultdict(list)
    for it in items:
        groups[it['group']].append(it)
    clamps, fails, listed = [], [], []
    for g in sorted(groups):
        scope = [it for it in groups[g] if it['obtainable'] and not it['artifact']]
        out = [it for it in groups[g] if not (it['obtainable'] and not it['artifact'])]
        # the bands, in what the server counts (armor: the rating or the override; weapons: damage x the material bonus)
        v4 = [counted(it, it['after']) for it in scope if it['tier'] == 4 and it['key'][0] in VANILLA]
        v5 = [counted(it, it['after']) for it in scope if it['tier'] == 5 and it['key'][0] in VANILLA]
        if not v4 or not v5:
            v4 = v4 or [counted(it, it['after']) for it in scope if it['tier'] == 4]
            v5 = v5 or [counted(it, it['after']) for it in scope if it['tier'] == 5]
        if not v4 or not v5:
            continue
        ceil4, floor5 = max(v4), min(v5)
        if ceil4 >= floor5:
            fails.append(f'{g}: the ladder itself counts tier 4 up to {ceil4:g} and tier 5 from {floor5:g}')
            continue
        for it in scope:
            it['final'] = it['after']
            c = counted(it, it['after'])
            if it['sig'] == 'ARMO':
                if it['tier'] == 4 and c > ceil4:
                    it['final'] = ceil4
                elif it['tier'] == 5 and c < floor5:
                    it['final'] = floor5
            else:
                # base damage is a whole number; the server multiplies it by 1 + the material bonus
                if it['tier'] == 4 and c > ceil4:
                    it['final'] = int(math.floor(ceil4 / (1 + it['bonus']) + 1e-9))
                elif it['tier'] == 5 and c < floor5:
                    it['final'] = int(math.ceil(floor5 / (1 + it['bonus']) - 1e-9))
            if it['final'] != it['after']:
                clamps.append(it)
        t4 = max((it for it in scope if it['tier'] == 4), key=lambda it: counted(it, it['final']))
        t5 = min((it for it in scope if it['tier'] == 5), key=lambda it: counted(it, it['final']))
        ok = counted(t4, t4['final']) < counted(t5, t5['final'])
        if not ok:
            fails.append(f"{g}: {t4['edid']} counts {counted(t4, t4['final'])}, {t5['edid']} {counted(t5, t5['final'])}")
        n4 = sum(1 for it in clamps if it['group'] == g and it['tier'] == 4)
        n5 = sum(1 for it in clamps if it['group'] == g and it['tier'] == 5)
        print(f"{'ok  ' if ok else 'FAIL'} {g[0]:6s} {g[1]:5s} {g[2]:10s} tier 4 up to {ceil4:g}, tier 5 from {floor5:g}; "
              f"counted {counted(t4, t4['final']):g} < {counted(t5, t5['final']):g}; {n4} lowered, {n5} raised")
        lo5 = min(counted(it, it['after']) for it in scope if it['tier'] == 5)
        hi4 = max(counted(it, it['after']) for it in scope if it['tier'] == 4)
        for it in out:
            c = counted(it, it['after'])
            if (it['tier'] == 4 and c >= lo5) or (it['tier'] == 5 and c <= hi4):
                listed.append((g, it))
    print(f'{len(clamps)} record(s) to move: {sum(1 for c in clamps if c["tier"] == 4)} tier 4 lowered, {sum(1 for c in clamps if c["tier"] == 5)} tier 5 raised')
    if listed:
        print(f'{len(listed)} artifact or unique record(s) outside the bands, left alone (staff-granted, not crafted or looted):')
        for g, it in sorted(listed, key=lambda x: (x[0], x[1]['edid']))[:60]:
            print(f"    {g[2]:10s} tier {it['tier']} {it['edid'][:40]:40s} {counted(it, it['after']):g}{' (artifact or unique)' if it['artifact'] else ''}")
    if a.write:
        path = os.path.join(HERE, 'stat_clamps.tsv')
        with open(path, 'w', encoding='utf-8', newline='\n') as fh:
            fh.write('# Written by t4_below_t5.py --write: tier 4 gear above the tier 4 ceiling and tier 5 gear below the tier 5 floor,\n')
            fh.write('# per slot and weight class (Nate, 2026-09-30). DBO_BlacksmithTiers.pas applies these after ladder.tsv. Do not edit.\n')
            fh.write('# sig\torigin plugin\tlocal form id\teditor id\tslot or type\tvalue now\tvalue after the ladder\tset to\n')
            for it in sorted(clamps, key=lambda it: (it['sig'], it['group'], it['edid'])):
                fh.write('\t'.join([it['sig'], proper.get(it['key'][0], it['key'][0]), '%06X' % it['key'][1], it['edid'], it['group'][2],
                                     f"{it['now']:g}", f"{it['after']:g}", f"{it['final']:g}"]) + '\n')
        print(f'wrote {path}')
    for f in fails:
        print('FAIL', f)
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
