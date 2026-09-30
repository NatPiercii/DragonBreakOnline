#!/usr/bin/env python3
"""The gate for the crafting tiers, on CT 115, after the PC run of DBO_BlacksmithTiers.pas and before deploy-plugins.

    python3 tools/recipes/recipe_census.py before.json                       # before the PC run (the live plugins)
    python3 tools/recipes/recipe_census.py after.json --replace "DragonBreak Online Edits.esp=<new>" \
        --replace "DragonBreak Nexus Patches.esp=<new>"
    python3 tools/recipes/verify_recipes.py before.json after.json --dle <new DLE> [--manuals-json server/manuals.json]

Checks, against recipe_tiers.tsv and manuals.tsv:
  every listed recipe  no HasPerk left; exactly one HasSpell(tier marker) == 1 and, when the table names a manual,
                       exactly one HasSpell(manual marker) == 1, neither ORed; no other DBO marker; every other
                       condition, the ingredients, the result, the bench and the count as they were before
  every other recipe   at the Cook's and the Blacksmith's stations: unchanged, condition for condition
  every manual         its marker SPEL and its BOOK exist in the new DLE, the book has the table's title and value, the
                       text of manuals/<manual>.txt, and DATA flags 0 (it teaches no skill, can be taken, and above all does not
                       carry Teaches Spell 0x04, which would give the marker and eat the book around the tier gate)
Conditions are compared decoded (function, operator, OR, value, parameter editor id, run-on), because a recipe that
moved into Nexus Patches has different record-local form ids. Exit 0 when all hold, 1 with every failure listed.
--manuals-json writes the manuals as Worker G's manuals.js reads them, with the form ids the new DLE gave them.
The stats half is checked by t4_below_t5.py on the new plugins: it must say "0 record(s) to move" and exit 0.
"""
import argparse, json, os, re, struct, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.environ.get('ESPLIB_DIR', os.path.expanduser('~nate/dragonbreak/ck-mcp')))

DBO = re.compile(r'^DBO_(Skill|Manual)_')


def cond_key(c):
    comp = c['comp'] if c['compIsGlobal'] else round(float(c['comp']), 4)
    return (c['func'], c['op'], c['or'], comp, c['param'], c['runOn'])


def shape(r):
    return (r['bench'], r['resultEdid'], r['count'], tuple((i['item'], i['count']) for i in r['ingredients']))


def load_table():
    rows = {}
    for line in open(os.path.join(HERE, 'recipe_tiers.tsv'), encoding='utf-8'):
        if line.startswith('#') or not line.strip():
            continue
        origin, local, edid, tier, manual = line.rstrip('\n').split('\t')
        rows['%x:%s' % (int(local, 16), origin)] = (edid, tier, None if manual == '-' else manual)
    return rows


def load_manuals():
    out = []
    for line in open(os.path.join(HERE, 'manuals.tsv'), encoding='utf-8'):
        if line.startswith('#') or not line.strip():
            continue
        f = line.rstrip('\n').split('\t')
        out.append({'manual': f[0], 'marker': f[1], 'book': f[2], 'title': f[3], 'tier': int(f[4]), 'value': int(f[5])})
    return out


def check_recipes(before, after, table):
    fails = []
    b = {r['key']: r for r in before['recipes']}
    a = {r['key']: r for r in after['recipes']}
    for key in sorted(set(b) | set(a)):
        rb, ra = b.get(key), a.get(key)
        if rb is None or ra is None:
            fails.append(f'{key}: {"new" if rb is None else "gone"} after the run')
            continue
        if shape(rb) != shape(ra):
            fails.append(f'{key} {ra["edid"]}: ingredients, result, bench or count changed')
        want = table.get(key)
        if want is None:
            if [cond_key(c) for c in rb['conditions']] != [cond_key(c) for c in ra['conditions']]:
                fails.append(f'{key} {ra["edid"]}: not in the table, but its conditions changed')
            continue
        edid, tier, manual = want
        conds = ra['conditions']
        if any(c['func'] == 'HasPerk' for c in conds):
            fails.append(f'{key} {edid}: a HasPerk is left')
        for marker in [tier] + ([manual] if manual else []):
            hits = [c for c in conds if c['func'] == 'HasSpell' and c['param'] == marker]
            if len(hits) != 1:
                fails.append(f'{key} {edid}: {len(hits)} HasSpell({marker}), want 1')
            elif hits[0]['op'] != '==' or float(hits[0]['comp']) != 1.0 or hits[0]['or'] or hits[0]['compIsGlobal']:
                fails.append(f'{key} {edid}: HasSpell({marker}) is not "== 1" on its own')
        extra = [c['param'] for c in conds if c['func'] == 'HasSpell' and DBO.match(str(c['param'])) and c['param'] not in (tier, manual)]
        if extra:
            fails.append(f'{key} {edid}: other DBO markers {extra}')
        keep_b = [cond_key(c) for c in rb['conditions'] if c['func'] != 'HasPerk' and not DBO.match(str(c['param']))]
        keep_a = [cond_key(c) for c in conds if c['func'] != 'HasPerk' and not DBO.match(str(c['param']))]
        if keep_b != keep_a:
            fails.append(f'{key} {edid}: its other conditions changed')
        for c in conds:
            if c['or'] and conds.index(c) == len(conds) - 1:
                fails.append(f'{key} {edid}: the last condition carries an OR')
    missing = [k for k in table if k not in a]
    for k in missing:
        fails.append(f'{k} {table[k][0]}: in recipe_tiers.tsv but not in the load order')
    return fails


def check_manuals(dle_path, manuals):
    import esplib
    p = esplib.Plugin(dle_path)
    fh = open(dle_path, 'rb')
    found = {}
    for t, fid, fl, off, sz, ctx in p.index:
        if t not in ('SPEL', 'BOOK'):
            continue
        d = dict(esplib.subrecords(p.data_at(fh, off, sz, fl)))
        e = d.get(b'EDID', b'').rstrip(b'\0').decode('cp1252', 'replace')
        if e.startswith('DBO_Manual_') or e.startswith('DBO_BookManual'):
            found[e] = (t, fid, d)
    fails, rows = [], []
    norm = lambda x: re.sub(r'\s+', ' ', x).strip()
    for m in manuals:
        s, bk = found.get(m['marker']), found.get(m['book'])
        if not s or s[0] != 'SPEL':
            fails.append(f'manual {m["manual"]}: no SPEL {m["marker"]} in the DLE')
        if not bk or bk[0] != 'BOOK':
            fails.append(f'manual {m["manual"]}: no BOOK {m["book"]} in the DLE')
            continue
        d = bk[2]
        title = d.get(b'FULL', b'').rstrip(b'\0').decode('cp1252', 'replace')
        text = d.get(b'DESC', b'').rstrip(b'\0').decode('cp1252', 'replace')
        data = d.get(b'DATA', b'')
        want = open(os.path.join(HERE, 'manuals', m['manual'] + '.txt'), encoding='utf-8').read()
        if title != m['title']:
            fails.append(f'manual {m["manual"]}: title {title!r}, want {m["title"]!r}')
        if norm(text) != norm(want):
            fails.append(f'manual {m["manual"]}: the book text differs from manuals/{m["manual"]}.txt')
        if len(data) < 12:
            fails.append(f'manual {m["manual"]}: DATA is {len(data)} bytes')
        elif data[0] != 0:
            fails.append(f'manual {m["manual"]}: DATA flags {data[0]:#04x}, want 0'
                         + (' (0x04 Teaches Spell: the engine would hand the marker over and eat the book on a read, around the tier gate)' if data[0] & 4 else ''))
        elif struct.unpack('<i', data[8:12])[0] != m['value']:
            fails.append(f'manual {m["manual"]}: value {struct.unpack("<i", data[8:12])[0]}, want {m["value"]}')
        if s:
            local = lambda fid: '%x:DragonBreak Online Edits.esp' % (fid & 0xFFFFFF)
            name = re.sub(r'(?<=[a-z])(?=[A-Z])', ' ', m['manual']).replace(' And ', ' and ')
            rows.append({'material': m['manual'].lower(), 'name': name, 'tier': m['tier'], 'title': m['title'],
                         'book': local(bk[1]), 'marker': local(s[1]), 'bookEdid': m['book'], 'markerEdid': m['marker']})
    return fails, rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('before')
    ap.add_argument('after')
    ap.add_argument('--dle', help='the new DragonBreak Online Edits.esp (checks the manual records)')
    ap.add_argument('--manuals-json')
    a = ap.parse_args()
    table = load_table()
    fails = check_recipes(json.load(open(a.before)), json.load(open(a.after)), table)
    rows = []
    if a.dle:
        f2, rows = check_manuals(a.dle, load_manuals())
        fails += f2
    else:
        print('no --dle: the manual records were not checked')
    for f in fails[:200]:
        print('FAIL', f)
    if len(fails) > 200:
        print(f'... and {len(fails) - 200} more')
    print(f'{len(table)} recipes in the table; {len(fails)} failure(s)')
    if a.manuals_json and rows and not fails:
        json.dump({'_comment': 'Written by tools/recipes/verify_recipes.py from the shipped DragonBreak Online Edits.esp. '
                               'tier is 1-based (skills.json blacksmith tiers); a recipe also checks its own tier marker.',
                   'manuals': rows}, open(a.manuals_json, 'w'), indent=1)
        print(f'wrote {a.manuals_json}: {len(rows)} manuals')
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
