#!/usr/bin/env python3
"""Can every input of every smithing recipe be had on our server, and inside the Bruma lock? (Nate, 9 Oct: "make sure
everything is obtainable and can be crafted, like the ores/ingots".)

    nice python3 tools/crafting/obtainability.py [--replace "<load-order name>=<path>" ...] [--json out.json] [--md out.md]

Reads the plugins (the live order, --replace swaps in a plugin, as tools/labour/salt_deposits.py) and the server's own
data beside it. The recipes are every winning COBJ at a smithing bench (forge, Skyforge, Dawnguard, Aetherium, armour
table, grindstone, smelter, tanning rack, loom; a recipe with no bench keyword counts as the forge, as the fork does).
Each input gets the sources a player has here:
  mine      labour.js: an ore in skills.json miner.oreByTier (or labour.extraOreTier), a gem geode, a salt deposit, with
            the placed nodes counted (and those inside the lock: the border polygon in Tamriel, an allowed plugin's interior
            or an allowed cell, playtest.js)
  wood      labour.js woodcutting (firewood)
  craft     the product of another recipe at any bench whose inputs are all obtainable (smelter, tanning rack, forge...)
  skin      gamemode.js skinning (pelt-values.json)
  body      the inventory or death item of a creature the server spawns (wildlife.json, dungeon-pools.json), leveled lists
            resolved
  flora     a placed flora or tree whose harvest (PFIG) is the item
  loot      a loot.json pool item that loottiers.js lets drop (ingots and ores above steel never, dragon parts never)
  salvage   salvage.js breaking down gear (salvage.json)
  placed    a reference of the item itself in the world (picked up once; informational only, never counts as a source)
Status per item: OK (a source inside the lock), OUTSIDE (only outside it), NONE. A craft is as good as its worst input.
Read only.
"""
import argparse, json, os, re, struct, sys, collections

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.abspath(os.path.join(HERE, '..', '..'))
sys.path.insert(0, os.environ.get('ESPLIB_DIR', os.path.expanduser('~nate/dragonbreak/ck-mcp')))
import esplib  # noqa: E402

DELETED, DISABLED = 0x20, 0x800
SMITH_BENCH = re.compile(r'^(CraftingSmithingForge|CraftingSmithingSkyforge|DLC1CraftingDawnguard|DLC2.*Aetherium|.*AetheriumForge|'
                         r'CraftingSmithingArmorTable|CraftingSmithingSharpeningWheel|CraftingSmelter|CraftingTanningRack|.*Loom.*)$', re.I)
ITEM_T = ('MISC', 'INGR', 'SLGM', 'ALCH', 'WEAP', 'ARMO', 'AMMO', 'BOOK', 'KEYM', 'LIGH', 'SCRL')
RANK = {'OK': 2, 'OUTSIDE': 1, 'NONE': 0}


def jl(name, dflt):
    try:
        return json.load(open(os.path.join(SERVER, name)))
    except Exception:
        return dflt


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', default='/opt/skyrim-data')
    ap.add_argument('--order', default=os.path.expanduser('~nate/dragonbreak/fork/deploy/skyrim-data/loadorder.txt'))
    ap.add_argument('--replace', action='append', default=[])
    ap.add_argument('--json')
    ap.add_argument('--md')
    a = ap.parse_args()
    replace = {k.strip().lower(): v for k, v in (r.split('=', 1) for r in a.replace)}
    names = [l.strip().lstrip('*') for l in open(a.order, encoding='utf-8-sig') if l.strip() and not l.startswith('#')]
    plugins, proper = [], {}
    for n in names:
        path = replace.get(n.lower()) or os.path.join(a.data, n)
        if os.path.exists(path):
            p = esplib.Plugin(path)
            p.fh = open(path, 'rb')
            p.key = n.lower()
            plugins.append(p)
            proper[n.lower()] = n

    def src(p, fid):
        s, loc = p.modindex_source(fid)
        return (s.lower(), loc & 0xFFFFFF) if s else None

    def desc(k):
        return '%x:%s' % (k[1], proper.get(k[0], k[0]))

    def u32(v, i=0):
        return struct.unpack_from('<I', v, i)[0]

    # ---- the winning records we need -------------------------------------------------------------------------
    rec = {}     # key -> (type, edid, [(sig, value)], plugin)
    want = set(ITEM_T) | {'KYWD', 'COBJ', 'LVLI', 'NPC_', 'FLOR', 'TREE', 'ACTI', 'LVLN', 'CELL'}
    for p in plugins:
        for t, fid, fl, off, sz, ctx in p.index:
            if t not in want:
                continue
            k = src(p, fid)
            if not k:
                continue
            if fl & DELETED:
                rec.pop(k, None)
                continue
            d = p.data_at(p.fh, off, sz, fl)
            subs = list(esplib.subrecords(d))
            # form ids inside the record resolved through this plugin's masters
            rec[k] = (t, esplib.edid_of(d) or '', subs, p)
    edid = {k: v[1] for k, v in rec.items()}
    by_edid = {v[1].lower(): k for k, v in rec.items() if v[1]}

    def ref(p, v, i=0):
        return src(p, u32(v, i))

    # ---- recipes ------------------------------------------------------------------------------------------------
    recipes = []
    for k, (t, e, subs, p) in rec.items():
        if t != 'COBJ':
            continue
        prod = bench = None
        n = 1
        ins = []
        for s, v in subs:
            if s == b'CNAM' and len(v) >= 4:
                prod = ref(p, v)
            elif s == b'BNAM' and len(v) >= 4:
                bench = ref(p, v)
            elif s == b'NAM1' and len(v) >= 2:
                n = struct.unpack_from('<H', v)[0]
            elif s == b'CNTO' and len(v) >= 8:
                ins.append((ref(p, v), struct.unpack_from('<i', v, 4)[0]))
        b = edid.get(bench, '') if bench else ''
        if bench and not b:
            b = '(unresolved %s)' % desc(bench)
        recipes.append({'id': k, 'edid': e, 'product': prod, 'count': n, 'bench': b or '(none: forge)', 'inputs': [x for x in ins if x[0]]})
    smith = [r for r in recipes if SMITH_BENCH.match(r['bench']) or r['bench'] == '(none: forge)' or r['bench'].startswith('(unresolved')]

    def key_of(d):
        i = d.index(':')
        return (d[i + 1:].lower(), int(d[:i], 16) & 0xFFFFFF)

    DESC = re.compile(r'"([0-9a-fA-F]{1,8}:[^"]+?\.es[mpl])"')
    # ---- the lock -----------------------------------------------------------------------------------------------
    cfg = jl('gamemode-config.json', {})
    pt = cfg.get('playtest', {})
    border = pt.get('border') or {}
    poly = border.get('points') or []
    bworld = border.get('world', '').lower()
    allowed_plugins = {x.lower() for x in pt.get('allowedPlugins', [])}
    allowed_cells = {x.lower() for x in pt.get('allowedCells', [])}

    def inside(x, y):
        c = False
        for i in range(len(poly)):
            (x1, y1), (x2, y2) = poly[i], poly[i - 1]
            if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
                c = not c
        return c

    def in_lock(world, cell, pos):
        if world:
            return desc(world).lower() == bworld and pos is not None and inside(pos[0] / 4096, pos[1] / 4096)
        if cell:
            return cell[0] in allowed_plugins or desc(cell).lower() in allowed_cells
        return False

    # ---- mining nodes and flora: the placed references ------------------------------------------------------------
    skills = jl('skills.json', {})
    def find(o, key):
        if isinstance(o, dict):
            if key in o:
                return o[key]
            for v in o.values():
                r = find(v, key)
                if r is not None:
                    return r
        if isinstance(o, list):
            for v in o:
                r = find(v, key)
                if r is not None:
                    return r
        return None
    ore_by_tier = find(skills, 'oreByTier') or []
    lab = cfg.get('labour', {})
    labsrc = open(os.path.join(SERVER, 'labour.js')).read()
    extra = dict(re.findall(r'(\w+): (\d)', re.search(r'extraOreTier: \{([^}]*)\}', labsrc).group(1)))
    extra.update(lab.get('extraOreTier') or {})
    mineable = {o.lower() for t in ore_by_tier for o in t} | {o.lower() for o in extra}
    items_js = dict(re.findall(r"^\s+(\w+): '([0-9a-f]+:[^']+)'", labsrc[labsrc.index('const ITEMS'):labsrc.index('CFG.gemOre || {}, CFG.items')], re.M))
    gem_ore = dict(re.findall(r"(\w+): '([0-9a-f]+:[^']+)'", re.search(r'gemOre: \{([^}]*)\}', labsrc).group(1)))
    items_js.update(lab.get('items') or {})
    gem_ore.update(lab.get('gemOre') or {})

    # labour.js VEIN: MineOre, CYRMineOre, DLC2MineOre and BSKMineOre, the ore name ending at a digit, "_" or the end;
    # other prefixes (BSBMMineOre, the Bruma mod's veins) are counted and said to be outside labour.js
    def ore_of(e):
        m = re.match(r'^(CYR|DLC2|BSK|BSBM)?MineOre([A-Za-z]+?)(?:\d|_|$)', e)
        if not m:
            return ''
        o = m.group(2).lower()
        o = 'geode' if o == 'blackreach' else o
        return o if m.group(1) != 'BSBM' else o + '(BSBM, not labour.js)'

    def node_of(e):
        if re.search('SeaSalt', e, re.I):
            return 'salt'
        m = re.match(r'^(?:CYR|BSK)MineGem([A-Za-z]+?)\d', e, re.I)
        return m.group(1).lower() if m and m.group(1).lower() in gem_ore else ''

    node_base = {}
    for k, (t, e, subs, p) in rec.items():
        if t == 'ACTI':
            o = ore_of(e) or node_of(e)
            if o:
                node_base[k] = o
    flora_base = {}
    for k, (t, e, subs, p) in rec.items():
        if t in ('FLOR', 'TREE'):
            for s, v in subs:
                if s == b'PFIG' and len(v) >= 4:
                    flora_base[k] = ref(p, v)
    item_keys = {k for k, v in rec.items() if v[0] in ITEM_T}
    nodes = collections.defaultdict(lambda: [0, 0])     # ore -> [placed, in lock]
    flora = collections.defaultdict(lambda: [0, 0])     # ingredient key -> [placed, in lock]
    placed = collections.defaultdict(lambda: [0, 0])    # item key -> [placed, in lock]
    seen = {}
    for p in plugins:
        for t, fid, fl, off, sz, ctx in p.index:
            if t != 'REFR':
                continue
            k = src(p, fid)
            d = p.data_at(p.fh, off, sz, fl)
            base = name_pos = None
            for s, v in esplib.subrecords(d):
                if s == b'NAME' and len(v) >= 4:
                    base = ref(p, v)
                elif s == b'DATA' and len(v) >= 12:
                    name_pos = struct.unpack_from('<3f', v)
            if base not in node_base and base not in flora_base and base not in item_keys:
                seen.pop(k, None)
                continue
            if fl & (DELETED | DISABLED):
                seen.pop(k, None)
                continue
            w, c, g = ctx
            seen[k] = (base, src(p, w) if w else None, src(p, c) if c else None, name_pos)
    by_ref = {key_of(d): o for d, o in (lab.get('oreByRef') or dict(re.findall(r"'([0-9a-f]+:[^']+)': '(\w+)'", labsrc[labsrc.index('oreByRef: {'):labsrc.index('\n    },', labsrc.index('oreByRef: {'))]))).items()}
    lock_nodes = []
    for k, (base, w, c, pos) in seen.items():
        if k in by_ref:
            base = ('ref', by_ref[k])
            node_base[base] = by_ref[k]
        lk = in_lock(w, c, pos)
        tgt = nodes[node_base[base]] if base in node_base else flora[flora_base[base]] if base in flora_base else placed[base]
        tgt[0] += 1
        tgt[1] += 1 if lk else 0
        if lk and base in node_base:
            lock_nodes.append({'ref': desc(k), 'ore': node_base[base], 'base': edid.get(base, str(base)), 'where': desc(w or c), 'cell': edid.get(c, '') if c else '',
                               'pos': [round(x) for x in pos] if pos else None})

    # ---- the sources --------------------------------------------------------------------------------------------
    sources = collections.defaultdict(list)   # key -> [(kind, detail, status)]

    def add(k, kind, detail, st):
        if k:
            sources[k].append((kind, detail, st))

    for ore, d in list(items_js.items()) + list(gem_ore.items()):
        k = key_of(d)
        if ore in ('firewood',):
            add(k, 'wood', 'chopping blocks', 'OK')
            continue
        if ore == 'charcoal':
            continue
        n, nl = nodes.get(ore, (0, 0))
        if ore in gem_ore or ore == 'salt' or ore in mineable:
            st = 'OK' if nl else 'OUTSIDE' if n else 'NONE'
            add(k, 'mine', f'{ore}: {n} nodes, {nl} in the lock' + ('' if ore in mineable or ore in gem_ore or ore == 'salt' else ' (not in oreByTier)'), st)
        elif n:
            add(k, 'mine', f'{ore}: {n} nodes ({nl} in the lock) but not in oreByTier, so not mineable', 'NONE')
    for ing, (n, nl) in flora.items():
        add(ing, 'flora', f'{n} placed, {nl} in the lock', 'OK' if nl else 'OUTSIDE')

    for d in jl('pelt-values.json', {}):
        if ':' in d:
            plug, loc = d.split(':', 1)
            add((plug.lower(), int(loc, 16) & 0xFFFFFF), 'skin', 'skinning', 'OK')

    # dungeon chest loot, as loottiers.js lets it drop
    lt = open(os.path.join(SERVER, 'loottiers.js')).read()
    loot_only = {key_of(d) for d in re.findall(r"'([0-9a-f]+:[^']+\.es[mp])'", lt[lt.index('LOOT_ONLY_METALS'):lt.index('LOOT_ONLY_METALS') + 4000])}
    swap = jl('gear-swap.json', {})
    never = {key_of(d) for d in (swap.get('metals') or {}) if ':' in d} | loot_only
    dm = jl('dragon-materials.json', {})
    never |= {key_of(d) for d in DESC.findall(json.dumps(dm.get('materials', [])))}
    # creatures the server spawns: their inventories and death items, leveled lists resolved
    def lvl_items(k, depth=0, acc=None):
        acc = set() if acc is None else acc
        r = rec.get(k)
        if not r or depth > 8:
            return acc
        t, e, subs, p = r
        if t in ITEM_T:
            acc.add(k)
        elif t == 'LVLI':
            for s, v in subs:
                if s == b'LVLO' and len(v) >= 8:
                    lvl_items(ref(p, v, 4), depth + 1, acc)
        return acc

    def npc_drops(k, depth=0):
        r = rec.get(k)
        out = set()
        if not r or depth > 6:
            return out
        t, e, subs, p = r
        if t == 'LVLN':
            for s, v in subs:
                if s == b'LVLO' and len(v) >= 8:
                    out |= npc_drops(ref(p, v, 4), depth + 1)
            return out
        if t != 'NPC_':
            return out
        for s, v in subs:
            if s == b'CNTO' and len(v) >= 8:
                out |= lvl_items(ref(p, v))
            elif s == b'INAM' and len(v) >= 4:
                out |= lvl_items(ref(p, v))
        return out

    wild = jl('wildlife.json', {})
    for pl in wild.get('placements', []):
        world = pl.get('world', '').lower()
        pos = pl.get('pos') or [0, 0]
        lk = world == bworld and inside(pos[0] / 4096, pos[1] / 4096)
        for d in set(DESC.findall(json.dumps(pl))):
            for it in npc_drops(key_of(d)) - never:
                add(it, 'body', f"{pl.get('kind', 'creature')} ({edid.get(key_of(d), d)})", 'OK' if lk else 'OUTSIDE')
    pools = jl('dungeon-pools.json', {})
    for fam_name, fam in (pools.get('families') or {}).items():
        lk = 'cyrodiil' in fam_name.lower()
        for d in set(DESC.findall(json.dumps(fam))):
            for it in npc_drops(key_of(d)) - never:
                add(it, 'body', f'dungeon {fam_name} ({edid.get(key_of(d), d)})', 'OK' if lk else 'OUTSIDE')

    for pool, items in (jl('loot.json', {}).get('pools') or {}).items():
        for it in items:
            k = key_of(it['id'])
            if k in never:
                continue
            prov = it.get('p')
            add(k, 'loot', f'loot.json {pool}', 'OK' if not prov or 'cyrodiil' in prov else 'OUTSIDE')

    # dragon bone and scales: a slain dragon's own body, nothing else (dragon-materials.json; Nate, 30 Sep)
    for d in DESC.findall(json.dumps(dm.get('materials', []))):
        add(key_of(d), 'dragon', "a slain dragon's body only (dragons do not fly over Bruma)", 'OUTSIDE')
    # salvage: as good as the gear broken down (circular otherwise: Madness gear needs Madness ingots)
    salvage_from = collections.defaultdict(set)
    for gear, (station, tier, mats) in (jl('salvage.json', {}).get('items') or {}).items():
        for m, n in mats:
            if key_of(m) not in never:
                salvage_from[key_of(m)].add(key_of(gear))

    # crafted: the product of a recipe at any bench, as good as its worst input
    by_product = collections.defaultdict(list)
    # Tempering makes nothing new, and breaking gear down at the smelter is salvage.js's path (salvage.json, which never
    # hands out the never-loot metals), not a source here
    def is_source(r):
        if re.match(r'CraftingSmithing(ArmorTable|SharpeningWheel)$', r['bench']):
            return False
        return not (r['bench'] == 'CraftingSmelter' and any(rec.get(i, ('',))[0] in ('WEAP', 'ARMO') for i, n in r['inputs']))
    for r in recipes:
        if r['product'] and is_source(r):
            by_product[r['product']].append(r)

    def base_status(k):
        st = [RANK[s] for kind, d, s in sources.get(k, [])]
        return max(st) if st else 0

    status = {}
    for _ in range(12):
        changed = False
        allk = set(sources) | set(by_product) | set(salvage_from)
        for k in allk:
            best = base_status(k)
            for g in salvage_from.get(k, ()):
                best = max(best, status.get(g, base_status(g)))
            for r in by_product.get(k, []):
                if r['inputs']:
                    worst = min(status.get(i, base_status(i)) for i, n in r['inputs'])
                    best = max(best, worst)
            if status.get(k) != best:
                status[k] = best
                changed = True
        if not changed:
            break

    def st_of(k):
        return {2: 'OK', 1: 'OUTSIDE', 0: 'NONE'}[status.get(k, base_status(k))]

    # ---- the report: every input of every smithing recipe ----------------------------------------------------
    used = collections.defaultdict(lambda: {'recipes': 0, 'benches': collections.Counter(), 'examples': []})
    for r in smith:
        if not is_source(r):
            continue
        for i, n in r['inputs']:
            u = used[i]
            u['recipes'] += 1
            u['benches'][r['bench']] += 1
            if len(u['examples']) < 3:
                u['examples'].append(edid.get(r['product'], '?'))
    rows = []
    for k, u in used.items():
        srcs = [f'{kind}: {d}' for kind, d, s in sources.get(k, [])]
        good = sorted((g for g in salvage_from.get(k, ()) if status.get(g, 0) > 0), key=lambda g: -status.get(g, 0))
        if good:
            srcs.append('salvage of %d obtainable pieces (e.g. %s)' % (len(good), ', '.join(edid.get(g, desc(g)) for g in good[:3])))
        for r in by_product.get(k, [])[:3]:
            srcs.append('craft: %s at %s from %s' % (r['edid'], r['bench'], ' + '.join('%d %s' % (n, edid.get(i, desc(i))) for i, n in r['inputs'])))
        pl = placed.get(k)
        rows.append({'item': desc(k), 'edid': edid.get(k, '?'), 'type': rec.get(k, ('?',))[0], 'status': st_of(k), 'recipes': u['recipes'],
                     'benches': dict(u['benches']), 'examples': u['examples'], 'sources': srcs[:12],
                     'placed': pl and f'{pl[0]} placed, {pl[1]} in the lock'})
    rows.sort(key=lambda r: (RANK[r['status']], -r['recipes']))
    cnt = collections.Counter(r['status'] for r in rows)
    print(f"{len(recipes)} recipes, {len(smith)} at smithing benches, {len(rows)} distinct inputs: " + ', '.join(f'{k} {v}' for k, v in cnt.items()))
    print('mining nodes: ' + ', '.join(f'{o} {n}/{nl}' for o, (n, nl) in sorted(nodes.items())))
    # per smithing family: its creation recipes (forge, Skyforge, Dawnguard, Aetherium) and how many have every input
    # inside the lock / anywhere, with the inputs that block the rest
    lm = jl('loot-materials.json', {}).get('items') or {}
    fams = {}
    for r in smith:
        if not is_source(r) or r['bench'] in ('CraftingSmelter', 'CraftingTanningRack') or not r['product']:
            continue
        f = lm.get(desc(r['product']).lower()) or lm.get('%x:%s' % (r['product'][1], r['product'][0]))
        if not f:
            continue
        x = fams.setdefault(f, {'recipes': 0, 'inLock': 0, 'anywhere': 0, 'blockers': collections.Counter()})
        x['recipes'] += 1
        worst = min((status.get(i, base_status(i)) for i, n in r['inputs']), default=2)
        x['inLock'] += worst == 2
        x['anywhere'] += worst >= 1
        for i, n in r['inputs']:
            if status.get(i, base_status(i)) < 2:
                x['blockers'][edid.get(i, desc(i))] += 1
    for f, x in fams.items():
        x['blockers'] = dict(x['blockers'].most_common(6))
    if a.json:
        json.dump({'families': fams, 'rows': rows, 'lockNodes': lock_nodes, 'nodes': {o: v for o, v in nodes.items()}, 'mineable': sorted(mineable)}, open(a.json, 'w'), indent=1)
    if a.md:
        with open(a.md, 'w') as fh:
            fh.write('| Status | Item | Type | Recipes | Sources |\n|---|---|---|---|---|\n')
            for r in rows:
                fh.write(f"| {r['status']} | {r['edid']} `{r['item']}` | {r['type']} | {r['recipes']} | {'; '.join(r['sources']) or '-'}{' (placed: ' + r['placed'] + ')' if r['placed'] else ''} |\n")
    return 0


if __name__ == '__main__':
    sys.exit(main())
