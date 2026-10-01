#!/usr/bin/env python3
"""Road to Alpha, "finish Bruma": every system's anchor inside the Bruma lock, counted in the plugins.

    python3 tools/alpha/bruma_anchors.py [--dle <another DragonBreak Online Edits.esp>] [--out docs/alpha/bruma-anchors.md]

The lock is what a player can reach: references in Cyrodiil inside the 18-point border region (REGN 0B0CBCDD) and in
the three small Bruma worlds (gamemode-config playtest.allowedWorlds), plus every interior reached from there through
load doors, taking only cells from playtest.allowedPlugins or allowedCells (playtest.js returns anyone elsewhere).
Deleted and initially-disabled references never count. Each system's anchor is read from the file the server reads it
from (skills.json, gamemode-config.json, beds.json, jail-cells.json, notice-board-spots.json, dungeons.json,
expeditions.json, the module defaults), so a row says MISSING when a player in Bruma cannot reach one. With --dle the
census runs twice, the live plugin and the given one (DLE v8), side by side. Read only.
"""
import argparse, collections, json, os, re, struct, sys

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.abspath(os.path.join(HERE, '..', '..'))
sys.path.insert(0, os.environ.get('ESPLIB_DIR', os.path.expanduser('~nate/dragonbreak/ck-mcp')))
import esplib  # noqa: E402

DLE = 'dragonbreak online edits.esp'
BORDER = ('bsheartland.esm', 0xcbcdd)
DELETED, DISABLED = 0x20, 0x800
BASE_TYPES = ('ACTI', 'FURN', 'CONT', 'DOOR', 'STAT', 'MSTT', 'TACT', 'FLOR', 'LIGH', 'BOOK', 'MISC', 'NPC_')
# The crafting benches, by the workbench keyword a recipe names (BNAM) and the menu the bench opens
BENCHES = [('Forge and anvil', ['CraftingSmithingForge']), ('Smelter', ['CraftingSmelter']),
           ('Workbench (armour improving)', ['CraftingSmithingArmorTable']),
           ('Grindstone (weapon improving)', ['CraftingSmithingSharpeningWheel']),
           ('Tanning rack', ['CraftingTanningRack']), ('Loom', ['MCE_CraftingLoom']),
           ('Alchemy lab', ['CraftingAlchemyWorkbench', 'isAlchemy']), ('Enchanter', ['CraftingEnchanting', 'isEnchanting']),
           ('Cooking pot, spit or oven', ['CraftingCookpot', 'BYOHCraftingOven'])]


def dkey(desc):
    """'1a2b:Plugin.esp' -> ('plugin.esp', 0x1a2b)"""
    h, p = str(desc).split(':', 1)
    if re.fullmatch(r'[0-9A-Fa-f]{1,8}', p) and not re.fullmatch(r'[0-9A-Fa-f]{1,8}', h):
        h, p = p, h                       # 'Plugin.esp:001A2B'
    return (p.lower(), int(h, 16) & 0xFFFFFF)


class World:
    def __init__(self, dle_path=None):
        order = [l.strip().lstrip('*') for l in open(os.path.expanduser('~nate/dragonbreak/fork/deploy/skyrim-data/loadorder.txt'), encoding='utf-8-sig')
                 if l.strip() and not l.startswith('#')]
        cfg = json.load(open(os.path.join(SERVER, 'gamemode-config.json')))
        pt = cfg.get('playtest') or {}
        self.allowed_worlds = {dkey(d) for d in pt.get('allowedWorlds', [])}
        self.allowed_plugins = {p.lower() for p in pt.get('allowedPlugins', [])}
        self.allowed_cells = {dkey(d) for d in pt.get('allowedCells', [])}
        self.arrival = pt.get('arrival') or {}
        self.proper, self.refs, self.base, self.cells, self.kwd = {}, {}, {}, {}, {}
        plugs = []
        for n in order:
            path = dle_path if (dle_path and n.lower() == DLE) else os.path.join('/opt/skyrim-data', n)
            if not os.path.exists(path):
                continue
            p = esplib.Plugin(path)
            p.fh = open(path, 'rb')
            p.key = n.lower()
            plugs.append(p)
            self.proper[n.lower()] = n
        for p in plugs:
            for t, fid, fl, off, sz, ctx in p.index:
                s, loc = p.modindex_source(fid)
                if s is None:
                    continue
                k = (s.lower(), loc & 0xFFFFFF)
                if t in ('REFR', 'ACHR'):
                    self.refs[k] = (p, off, sz, fl, ctx)
                elif t in BASE_TYPES:
                    self.base[k] = (t, p, off, sz, fl)
                elif t in ('CELL', 'WRLD'):
                    self.cells[k] = (t, p, off, sz, fl)
                elif t == 'KYWD':
                    self.kwd[k] = esplib.edid_of(p.data_at(p.fh, off, sz, fl)) or ''
                elif t == 'REGN' and k == BORDER:
                    rp = [v for sg, v in esplib.subrecords(p.data_at(p.fh, off, sz, fl)) if sg == b'RPLD']
                    self.poly = [struct.unpack_from('<2f', rp[0], i) for i in range(0, len(rp[0]), 8)]
        self.kwd_by_name = {v.lower(): k for k, v in self.kwd.items()}
        self._edid, self._kw = {}, {}
        self._scope()
        self.refs = None          # the scope is all the census needs; the raw index is large

    def src(self, p, raw):
        s, loc = p.modindex_source(raw)
        return (s.lower(), loc & 0xFFFFFF) if s else None

    def desc(self, k):
        return '%x:%s' % (k[1], self.proper.get(k[0], k[0]))

    def edid(self, k):
        if k not in self._edid:
            r = self.base.get(k) or self.cells.get(k)
            self._edid[k] = (esplib.edid_of(r[1].data_at(r[1].fh, *r[2:5])) or '') if r else ''
        return self._edid[k]

    def base_keywords(self, k):
        if k not in self._kw:
            t, p, off, sz, fl = self.base[k]
            v = dict(esplib.subrecords(p.data_at(p.fh, off, sz, fl))).get(b'KWDA', b'')
            self._kw[k] = {self.src(p, x) for (x,) in struct.iter_unpack('<I', v[:len(v) // 4 * 4])}
        return self._kw[k]

    def inside(self, x, y):
        c = False
        for i in range(len(self.poly)):
            x1, y1 = self.poly[i]; x2, y2 = self.poly[(i + 1) % len(self.poly)]
            if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
                c = not c
        return c

    def in_world(self, w, x, y):
        return w in self.allowed_worlds and (w != ('bsheartland.esm', 0xa764b) or self.inside(x, y))

    def _scope(self):
        """in_scope: refs a player can reach; reached: interior cells; placed: ref -> (base, where, pos, flags)"""
        cell_refs, door_to, self.placed = collections.defaultdict(list), {}, {}
        self.in_scope = set()
        for k, (p, off, sz, fl, ctx) in self.refs.items():
            if fl & DELETED:
                continue
            s = dict(esplib.subrecords(p.data_at(p.fh, off, sz, fl)))
            base = self.src(p, struct.unpack('<I', s[b'NAME'][:4])[0]) if len(s.get(b'NAME', b'')) >= 4 else None
            pos = struct.unpack('<3f', s[b'DATA'][:12]) if len(s.get(b'DATA', b'')) >= 12 else (0, 0, 0)
            w = self.src(p, ctx[0]) if ctx and ctx[0] else None
            c = self.src(p, ctx[1]) if ctx and ctx[1] else None
            self.placed[k] = (base, w or c, pos, fl)
            if len(s.get(b'XTEL', b'')) >= 4:
                door_to[k] = self.src(p, struct.unpack('<I', s[b'XTEL'][:4])[0])
            if w:
                if self.in_world(w, pos[0], pos[1]) and not fl & DISABLED:
                    self.in_scope.add(k)
            elif c:
                cell_refs[c].append(k)
        ref_cell = {k: c for c, ks in cell_refs.items() for k in ks}
        frontier = [door_to[k] for k in list(self.in_scope) if k in door_to]
        self.reached = set()
        while frontier:
            c = ref_cell.get(frontier.pop())
            if not c or c in self.reached:
                continue
            if c[0] not in self.allowed_plugins and c not in self.allowed_cells:
                continue
            self.reached.add(c)
            for k in cell_refs[c]:
                if self.placed[k][3] & DISABLED:
                    continue
                self.in_scope.add(k)
                if k in door_to:
                    frontier.append(door_to[k])
        self.by_base = collections.defaultdict(list)
        for k in self.in_scope:
            b = self.placed[k][0]
            if b:
                self.by_base[b].append(k)
        # only what the census reads is kept: in-scope placements
        self.placed = {k: self.placed[k] for k in self.in_scope}

    def where_name(self, k):
        w = self.placed[k][1]
        return self.edid(w) or (self.desc(w) if w else '?')

    # ---- queries -------------------------------------------------------------------------------------------------
    def refs_of_bases(self, bases):
        out = []
        for b in bases:
            out += self.by_base.get(b, [])
        return out

    def bases_matching(self, keywords=(), prefixes=(), edids=(), types=BASE_TYPES):
        kws = {self.kwd_by_name[n.lower()] for n in keywords if n.lower() in self.kwd_by_name}
        pre = [x.lower() for x in prefixes]
        eds = {x.lower() for x in edids}
        out = set()
        for k, r in self.base.items():
            if r[0] not in types:
                continue
            e = self.edid(k).lower() if (pre or eds) else ''
            if (pre and any(e.startswith(x) for x in pre)) or (eds and e in eds) or (kws and self.base_keywords(k) & kws):
                out.add(k)
        return out


def row(system, anchors, refs, w, note='', need=1):
    """anchors: what the server reads; refs: reachable refs (or cells as ('cell', key))"""
    names = collections.Counter(w.where_name(k) if not (isinstance(k, tuple) and k and k[0] == 'cell') else w.edid(k[1]) for k in refs)
    where = ', '.join(f'{n} ×{c}' if c > 1 else n for n, c in names.most_common(3))
    return {'system': system, 'anchors': anchors, 'count': len(refs), 'where': where, 'ok': len(refs) >= need, 'note': note}


def census(w):
    rows = []
    sk = json.load(open(os.path.join(SERVER, 'skills.json')))
    cfg = json.load(open(os.path.join(SERVER, 'gamemode-config.json')))
    # the arrival spot
    a = w.arrival
    ok = bool(a) and w.in_world(dkey(a['world']), a['pos'][0], a['pos'][1])
    rows.append({'system': 'Arrival spot', 'anchors': 'playtest.arrival', 'count': int(ok), 'where': f"{a.get('world')} {a.get('pos')}", 'ok': ok, 'note': ''})
    # trades: skills.json gates.stations, keyword first, editor-id prefix for the rest (masterySystem's two tests)
    for s in sk['skills']:
        st = (s.get('gates') or {}).get('stations') or []
        if not st:
            continue
        kw = [n for n in st if n.lower() in w.kwd_by_name]
        pre = [n for n in st if n.lower() not in w.kwd_by_name]
        bases = w.bases_matching(keywords=kw, prefixes=pre)
        rows.append(row(f"Trade: {s.get('label', s['id'])} (first touch)", 'skills.json gates.stations', w.refs_of_bases(bases), w,
                        f"{len(bases)} base(s)"))
    # crafting benches
    for label, kws in BENCHES:
        bases = w.bases_matching(keywords=kws, types=('FURN',))
        rows.append(row(f'Bench: {label}', ' / '.join(kws), w.refs_of_bases(bases), w))
    # deities: each deity's shrines, a base or a placed reference
    for c in sk['deities']['choices']:
        ks = [dkey(d) for d in c.get('shrines', [])]
        refs = w.refs_of_bases([k for k in ks if k in w.base]) + [k for k in ks if k in w.in_scope]
        if c.get('prayAnywhere'):
            rows.append({'system': f"Shrine: {c['name']} ({c.get('kind', '')})", 'anchors': 'prayAnywhere: no shrine needed',
                         'count': len(refs), 'where': 'anywhere', 'ok': True, 'note': ''})
            continue
        rows.append(row(f"Shrine: {c['name']} ({c.get('kind', '')})", 'skills.json deities.choices[].shrines', refs, w))
    # jails
    J = json.load(open(os.path.join(SERVER, 'jail-cells.json')))
    jcells = {dkey(d) for d in J['cells'] + ((cfg.get('jail') or {}).get('cells') or [])}
    reached = [('cell', c) for c in jcells if c in w.reached]
    rows.append(row('Jails (cells a guard locks you in)', 'jail-cells.json + jail.cells', reached, w, f'{len(jcells)} jails in all'))
    # inns: rentable beds in a reachable inn
    B = json.load(open(os.path.join(SERVER, 'beds.json')))
    inns = [('cell', dkey(c)) for c, v in B['inns'].items() if dkey(c) in w.reached and v.get('rentBedRefs')]
    rows.append(row('Inns with a rentable bed', 'beds.json inns[].rentBedRefs', inns, w, f"{len(B['inns'])} inns in all"))
    # notice boards
    N = json.load(open(os.path.join(SERVER, 'notice-board-spots.json')))
    boards = [dkey(s['ref']) for s in N['spots'] if dkey(s['ref']) in w.in_scope]
    rows.append(row('Notice boards', 'notice-board-spots.json', boards, w, f"{len(N['spots'])} boards in all"))
    # expeditions: their entrance (where the party sets out) must be reachable
    X = json.load(open(os.path.join(SERVER, 'expeditions.json')))['expeditions']
    exp = [('cell', dkey(e['cell'])) for x in X for e in x.get('entrances', []) if e.get('expedition') and dkey(e['cell']) in w.reached]
    rows.append(row('Expeditions (set out from)', 'expeditions.json entrances', exp, w, f'{len(X)} expeditions'))
    # the bank, the Scholars' Ledger, the Class Lectern, Study Magic
    rows.append(row('Bank', "bank.js activators ['5:DragonBreak.esp'] (TheBank)", w.refs_of_bases([dkey('5:DragonBreak.esp')]), w))
    rows.append(row("Scholars' Ledger", 'salvage.js bookBreakdownBases (BookBreakdown)', w.refs_of_bases(w.bases_matching(edids=['BookBreakdown'])), w))
    off = '' if (cfg.get('schools') or {}).get('enabled', True) else 'schools.js is off in gamemode-config'
    rows.append(row('Class Lectern', "schools.js classes.edid (ClassLectern)", w.refs_of_bases(w.bases_matching(edids=['ClassLectern'])), w, off))
    rows.append(row('Study Magic (schools)', "schools.js study.edid (StudyMagic)", w.refs_of_bases(w.bases_matching(edids=['StudyMagic'])), w, off))
    # the Synod tome shop and the college cells
    sp = cfg.get('spells') or {}
    shop = [('cell', dkey(c)) for c in sp.get('shopCells', []) if dkey(c) in w.reached]
    rows.append(row('Synod tome shop (/tomes)', 'spells.shopCells', shop, w))
    # spell study points: the entries spells.js would use with this plugin
    pts = []
    for p in sk.get('spellStudyPoints', []):
        has = lambda d: dkey(d) in w.base or dkey(d) in w.cells or dkey(d) in w.kwd
        if p.get('requires') and not has(p['requires']):
            continue
        if p.get('until') and has(p['until']):
            continue
        if p.get('places'):
            pts += [dkey(q['refr']) for q in p['places'] if dkey(q['refr']) in w.in_scope]
        elif p.get('refr'):
            pts += [dkey(p['refr'])] if dkey(p['refr']) in w.in_scope else []
        else:
            pts += [('cell', dkey(c)) for c in [p.get('cell')] + p.get('cells', []) if c and dkey(c) in w.reached]
    rows.append(row('Spell study points (tomes)', 'skills.json spellStudyPoints', pts, w))
    # dungeons a party can claim: an outside entrance door in reach, not excluded
    D = json.load(open(os.path.join(SERVER, 'dungeons.json')))['dungeons']
    excl = set((cfg.get('dungeons') or {}).get('exclude') or [])
    # and the ids dungeons.js itself drops (its EXCLUDED set: Lakeside Retreat, Fort Caractacus)
    m = re.search(r"const EXCLUDED = new Set\(\[([^\]]*)\]", open(os.path.join(SERVER, 'dungeons.js')).read())
    if m: excl |= set(re.findall(r"'([^']+)'", m.group(1)))
    claim = []
    for d in D:
        if d['id'] in excl:
            continue
        doors = [dkey(e['outsideDesc']) for e in d.get('entrances', []) if e.get('outsideDesc')]
        hit = [k for k in doors if k in w.in_scope]
        if hit:
            claim.append((d['id'], hit[0]))
    r = row('Dungeons claimable', 'dungeons.json entrances (minus dungeons.exclude and dungeons.js EXCLUDED)', [k for _, k in claim], w, f'{len(D)} dungeons in all')
    r['where'] = ', '.join(sorted(i for i, _ in claim))[:400]
    rows.append(r)
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dle', help='a DragonBreak Online Edits.esp to compare with the live one (DLE v8)')
    ap.add_argument('--out', default=os.path.join(SERVER, 'docs', 'alpha', 'bruma-anchors.md'))
    a = ap.parse_args()
    runs = []
    for name, path in [('live', None)] + ([('v8', a.dle)] if a.dle else []):
        w = World(path)
        runs.append((name, {'refs': len(w.in_scope), 'cells': len(w.reached)}, census(w)))
        del w                     # one load order in memory at a time
    live = runs[0][1]
    print(f"scope (live): {live['refs']} references, {live['cells']} interior cells reached")
    # the markdown
    L = ['# Bruma anchors: what a player can reach inside the region lock', '',
         f'Generated by `tools/alpha/bruma_anchors.py` (read only). Scope: Cyrodiil inside the border region '
         f'REGN 0B0CBCDD, the three small Bruma worlds, and the {live["cells"]} interiors reached from them by load '
         f'doors (live DLE: {live["refs"]} references). Deleted and initially-disabled references do not count. '
         'A row is MISSING when a player in Bruma cannot reach one of its anchors.', '']
    head = '| System | Anchor (what the server reads) | In Bruma (live) | Where (live) | Live |' + (' v8 count | v8 |' if len(runs) > 1 else '')
    L += [head, '|' + '---|' * (head.count('|') - 1)]
    for i, r in enumerate(runs[0][2]):
        line = f"| {r['system']} | {r['anchors']} | {r['count']}{(' (' + r['note'] + ')') if r['note'] else ''} | {r['where'] or '-'} | {'OK' if r['ok'] else '**MISSING**'} |"
        if len(runs) > 1:
            r2 = runs[1][2][i]
            line += f" {r2['count']} | {'OK' if r2['ok'] else '**MISSING**'} |"
        L.append(line)
    L.append('')
    for name, _, rows in runs:
        missing = [r['system'] for r in rows if not r['ok']]
        L.append(f"**MISSING ({name}): {len(missing)}**" + (': ' + '; '.join(missing) if missing else '') + '  ')
    single = [f"{r['system']} ({r['where']})" for r in runs[-1][2] if r['ok'] and r['count'] == 1 and r['where'] != 'anywhere']
    L += ['', f"**One anchor only ({runs[-1][0]})**, where a single broken or moved reference closes the system: " + '; '.join(single), '']
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    open(a.out, 'w').write('\n'.join(L) + '\n')
    print(f'wrote {a.out}')
    for name, _, rows in runs:
        print(f"{name}: MISSING " + ('; '.join(r['system'] for r in rows if not r['ok']) or 'none'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
