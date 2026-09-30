#!/usr/bin/env python3
"""Every "Recipe not found" in the server logs, explained. The C++ CraftService logs that line (at error level) for
every craft no recipe matches and then hands the craft to the gamemode (onCraftUnmatched), so the raw count mixes
real misses with the normal alchemy path. This resolves each one and sorts it:

    sudo python3 tools/crafting/craft_misses.py [--logs /var/log/skymp-server.log.1 /var/log/skymp-server.log] [--json out.json]

Classes (see classify()):
  lab-brewed         an alchemy lab mix alchemy.js brewed: a success, logged as a miss by design
  lab-refused        a lab mix alchemy.js refused on purpose (no shared effect, not a mix, a created object only)
  lab-repeated       the client reported one ingredient twice, so alchemy.js saw one ingredient and made nothing,
                     while the player's own lab brewed (a client craft-report problem; see the report)
  lab-before-module  a lab mix before alchemy.js existed (23 Sep, before 23:36)
  no-bench-keyword   a recipe with no workbench keyword (Sentinel.esp), refused until fork 0a4d4c82 (25 Sep 23:20)
  rollback-echo      "crafting" the items a refused craft just gave back (inputs are that craft's products)
  recipe-exists      a recipe for the product and inputs exists at this station: refused by a server rule of its time
  no-recipe          nothing in the load order makes this product from these inputs here: a COBJ is missing
Read only.
"""
import argparse, collections, datetime, json, os, re, struct, sys

LINE = re.compile(r'^\[(\S+ \S+)\] \[error\] Recipe not found: inputObjects=(\{.*\}), workbenchId=0x([0-9a-f]+), resultObjectId=0x([0-9a-f]+)')
STAMP = re.compile(r'^\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)')
ALCHEMY_LOADED = datetime.datetime(2026, 9, 23, 23, 36, 50)
NO_BNAM_FIX = datetime.datetime(2026, 9, 25, 23, 20)
DYNAMIC = 0xFF000000


def parse(lines):
    """The miss lines and, for each, the alchemy.js lines within 3 s after it"""
    out = []
    for i, l in enumerate(lines):
        m = LINE.match(l)
        if not m:
            continue
        t = datetime.datetime.strptime(m.group(1)[:19], '%Y-%m-%d %H:%M:%S')
        after = []
        for l2 in lines[i + 1:i + 80]:
            s = STAMP.match(l2)
            if s and (datetime.datetime.strptime(s.group(1), '%Y-%m-%d %H:%M:%S') - t).total_seconds() > 3:
                break
            if 'alchemy:' in l2 or 'ALCHEMY ' in l2:
                after.append(l2)
        out.append({'t': t, 'inputs': [(int(e['baseId']), int(e.get('count', 1))) for e in json.loads(m.group(2))['entries']],
                    'bench': int(m.group(3), 16), 'result': int(m.group(4), 16), 'after': after})
    return out


def classify(ev, bench_keywords, recipes_for, recent_products):
    """bench_keywords: keyword edids of the workbench's base. recipes_for(result) -> [(bench keyword or None, {item: count})].
    recent_products: items refused crafts had just made at this bench (for rollback echoes)."""
    real = [i for i, _ in ev['inputs'] if i < DYNAMIC]
    lab = 'isAlchemy' in bench_keywords or any('Alchemy' in k for k in bench_keywords)
    if lab:
        text = ' '.join(ev['after'])
        if 'brewed' in text:
            return 'lab-brewed'
        if ev['t'] < ALCHEMY_LOADED:
            return 'lab-before-module'
        if len(real) != len(set(real)) and len(set(real)) < 2:
            return 'lab-repeated'
        return 'lab-refused'
    if real and all(i in recent_products for i in real):
        return 'rollback-echo'
    have = collections.Counter()
    for i, c in ev['inputs']:
        if i < DYNAMIC:
            have[i] += c
    for bnam, comps in recipes_for(ev['result']):
        if dict(have) == comps:
            if bnam is None:
                return 'no-bench-keyword'
            if bnam in bench_keywords:
                return 'recipe-exists'
    return 'no-recipe'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--logs', nargs='+', default=['/var/log/skymp-server.log.1', '/var/log/skymp-server.log'])
    ap.add_argument('--json')
    a = ap.parse_args()
    events = []
    for f in a.logs:
        if os.path.exists(f):
            events += parse(open(f, encoding='utf-8', errors='replace').read().splitlines())
    sys.path.insert(0, os.path.expanduser('~nate/dragonbreak/ck-mcp'))
    import esplib
    data = '/opt/skyrim-data'
    order = [l.strip() for l in open(os.path.expanduser('~nate/dragonbreak/fork/deploy/skyrim-data/loadorder.txt')) if l.strip() and not l.startswith('#')]
    gid, plugs = {}, []
    full = light = 0
    for n in order:
        p = os.path.join(data, n)
        if not os.path.exists(p):
            continue
        pl = esplib.Plugin(p); pl.fh = open(p, 'rb'); plugs.append(pl)
        gid[pl.key] = ((0xFE000000 | (light << 12), 0xFFF) if pl.esl else (full << 24, 0xFFFFFF))
        light, full = (light + 1, full) if pl.esl else (light, full + 1)

    def g(pl, raw):
        src, loc = pl.modindex_source(raw)
        if src is None or src not in gid:
            return None
        b, m = gid[src]
        return (b | (loc & m)) & 0xFFFFFFFF
    win, edid, cobj = {}, {}, {}
    for pl in plugs:
        for t, fid, fl, off, sz, ctx in pl.index:
            G = g(pl, fid)
            if G is None:
                continue
            if t in ('REFR', 'FURN', 'KYWD', 'COBJ', 'ARMO', 'WEAP', 'MISC', 'INGR', 'ALCH', 'AMMO', 'SLGM', 'BOOK'):
                if t == 'REFR' and G not in {e['bench'] for e in events}:
                    continue
                win[G] = (t, pl, off, sz, fl)
    subs = lambda G: dict(esplib.subrecords(win[G][1].data_at(win[G][1].fh, *win[G][2:]))) if G in win else {}
    listsubs = lambda G: list(esplib.subrecords(win[G][1].data_at(win[G][1].fh, *win[G][2:])))
    name = lambda G: 'dynamic' if G >= DYNAMIC else (subs(G).get(b'EDID', b'').rstrip(b'\0').decode('cp1252', 'replace') or f'{G:08x}')
    for G, (t, pl, *_rest) in win.items():
        if t != 'COBJ':
            continue
        s = listsubs(G); d = dict(s)
        if b'CNAM' not in d:
            continue
        res = g(pl, struct.unpack('<I', d[b'CNAM'][:4])[0])
        bnam = name(g(pl, struct.unpack('<I', d[b'BNAM'][:4])[0])) if b'BNAM' in d else None
        comps = {g(pl, struct.unpack('<I', v[:4])[0]): struct.unpack('<i', v[4:8])[0] for sig, v in s if sig == b'CNTO'}
        cobj.setdefault(res, []).append((bnam, comps))
    benchkw = {}
    for e in events:
        if e['bench'] in benchkw:
            continue
        d = subs(e['bench'])
        base = g(win[e['bench']][1], struct.unpack('<I', d[b'NAME'][:4])[0]) if b'NAME' in d else None
        kw = subs(base).get(b'KWDA', b'') if base else b''
        benchkw[e['bench']] = (name(base) if base else '?', [name(g(win[base][1], struct.unpack_from('<I', kw, i)[0])) for i in range(0, len(kw), 4)])
    recent = collections.defaultdict(set)
    rows = []
    for e in sorted(events, key=lambda e: e['t']):
        base, kws = benchkw[e['bench']]
        cls = classify(e, kws, lambda r: cobj.get(r, []), recent[e['bench']])
        if cls in ('no-bench-keyword', 'recipe-exists', 'no-recipe'):
            recent[e['bench']].add(e['result'])
        rows.append({'t': e['t'].isoformat(sep=' '), 'class': cls, 'bench': f"{e['bench']:08x}", 'benchBase': base,
                     'result': name(e['result']), 'inputs': [f'{name(i)}x{c}' for i, c in e['inputs']]})
    c = collections.Counter(r['class'] for r in rows)
    print(f'{len(rows)} "Recipe not found" lines in {", ".join(a.logs)}')
    for k, v in c.most_common():
        print(f'  {v:4d}  {k}')
    by = collections.Counter((r['class'], r['benchBase'], r['result']) for r in rows if not r['class'].startswith('lab-'))
    for (k, b, r), v in sorted(by.items()):
        print(f'        {v:3d}  {k:18s} {b:28s} -> {r}')
    last_real = max((r['t'] for r in rows if r['class'] in ('no-recipe', 'recipe-exists', 'no-bench-keyword')), default='none')
    print(f'  last miss outside an alchemy lab: {last_real}')
    if a.json:
        json.dump(rows, open(a.json, 'w'), indent=1)
    return 0


if __name__ == '__main__':
    sys.exit(main())
