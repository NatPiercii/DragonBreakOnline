#!/usr/bin/env python3
"""Owned spawns: every living creature a DragonBreak-owned plugin places Initially Disabled becomes a server spawn of its
own base at its own spot and heading (Nate, 30 Sep: "those living actors should be used as spawns for their respective
npc"; creatures only). Writes server/owned-spawns.json, which wildlife.js turns into wild:<kind>:p<id> zones.

    sudo python3 tools/spawns/owned_spawns.py [--data /opt/skyrim-data] [--order <loadorder.txt>]
        [--replace "DragonBreak Online Edits.esp=/home/nate/inbox/.../DragonBreak Online Edits.esp"] [--out owned-spawns.json]

What counts: an ACHR the owned plugin places itself (not an override), whose winning record is Initially Disabled
(0x800), not Starts Dead (0x200, a corpse stays a corpse) and not deleted, and whose base resolves (through leveled
lists and templates, as ck-mcp/wildlife.py does) to NPC_ records whose race lacks ActorTypeNPC. People are listed under
skipped.person and not spawned: merchants, guards and quest NPCs belong to the NPC and officials systems.

Anchors (the PlaceAtMe self) are REFRs of a non-static type from plugins that are NOT DragonBreak-owned and whose
winning record is not in one either, so no release of ours can move or remove them: a zone works before and after the
plugin that placed its creature ships. Spawns group by the nearest map marker within 3000 units (its name when the
plugin gives it as text), else by cell. A group with a Treas...Chest container of an owned plugin within reach is a
camp: its chests join the hourly per-player camp roll (wildlife.js).
"""
import argparse
import collections
import hashlib
import json
import math
import os
import re
import struct
import sys

sys.path.insert(0, os.path.expanduser('~nate/dragonbreak/ck-mcp'))
import esplib  # noqa: E402

OWNED = ['DragonBreak.esp', 'DragonBreak Built.esp', 'DragonBreak Dungeons.esp', 'DragonBreak Harvest.esp',
         'DragonBreak Hub.esp', 'DragonBreak Whiterun.esp', 'DragonBreak Online Edits.esp', 'LostArk_Kamen.esp',
         '[Kirax] Lost Ark Reborn Paladin Legendary.esp', 'DragonBreak Nexus Patches.esp']
# Anchor base types, as ck-mcp/wildlife.py: anything with a loadable 3D the server keeps, not a static
OK_TYPES = {'FURN', 'ACTI', 'DOOR', 'CONT', 'WEAP', 'ARMO', 'MISC', 'INGR', 'ALCH', 'BOOK', 'AMMO', 'KEYM', 'SLGM', 'SCRL',
            'LIGH'}
# wildlife.py's creature kinds, plus the ones DragonBreak places (Boar, Goblin, Horse)
CREATURE = re.compile(r'^(?:CYR|BSK|BS|DLC1|DLC2)?(?:Enc|Lvl)?(Boar|Goblin|Horse|Wolf|IceWolf|Deer|Elk|Bear|CaveBear|'
                      r'SnowBear|SabreCat|Skeever|Rat|Mudcrab|Horker|Giant|Mammoth|Troll|FrostTroll|Fox|Hare|Rabbit|Goat|'
                      r'Slaughterfish|Spider|FrostbiteSpider|Chaurus|Chicken|Cow|Dog|Netch|Riekling|Bristleback|Ashhopper|'
                      r'Lurker|Werebear|Ogre|Minotaur|MountainLion)', re.I)
DISABLED, STARTS_DEAD, DELETED = 0x800, 0x200, 0x20
MARKER_REACH = 3000
# Markers whose place is bigger than MARKER_REACH: every spawn and chest within the reach is one area around the marker
# (Sancre Tor Ruins, Nate 8 Oct: "this will be the new world dungeon", 21 minotaurs and 8 chests over 6 cells, 5,450 out)
AREA_REACH = {('dragonbreak online edits.esp', 0x1833E2): 6000}
ANCHOR_REACH = 2500
CELL = 4096
MAP_MARKER = ('skyrim.esm', 0x000010)
SKIP_TYPES = {'GRUP', 'REFR', 'NAVM', 'LAND', 'PGRE', 'PHZD', 'PMIS', 'PARW', 'PBAR', 'PBEA', 'PCON', 'PFLA', 'INFO', 'DIAL'}
KEEP_TYPES = {'NPC_', 'LVLN', 'RACE', 'KYWD', 'CELL', 'CONT', 'STAT', 'LCTN'}


def subs(data):
    return list(esplib.subrecords(data))


class LoadOrder:
    def __init__(self, data_dir, order_file, replace):
        names = [l.strip() for l in open(order_file, encoding='utf-8-sig') if l.strip() and not l.startswith('#')]
        names = [n.lstrip('*') for n in names]
        self.plugins, self.proper, self.gid = [], {}, {}
        full = light = 0
        for n in names:
            path = replace.get(n.lower()) or os.path.join(data_dir, n)
            if not os.path.exists(path):
                continue
            p = esplib.Plugin(path)
            p.key = n.lower()  # esplib keys by file name; a --replace copy keeps the load-order name
            p.srcpath = path
            p.fh = open(path, 'rb')
            self.plugins.append(p)
            self.proper[n.lower()] = n
            if p.esl:
                self.gid[n.lower()] = (0xFE000000 | (light << 12), 0xFFF); light += 1
            else:
                self.gid[n.lower()] = (full << 24, 0xFFFFFF); full += 1
        self.owned = {n.lower() for n in OWNED}
        self.types = {}      # (src, loc) -> record type, winner
        self.win = {}        # (src, loc) -> (plugin, type, off, size, flags, ctx), last in the load order wins
        # References are the bulk of the order: only the owned plugins' ACHRs are kept here; REFRs near a spawn are
        # walked later (refs_in), once it is known which worlds and cells hold one
        for p in self.plugins:
            for t, fid, fl, off, sz, ctx in p.index:
                if t in SKIP_TYPES:
                    continue
                k = self.source(p, fid)
                if k is None:
                    continue
                if t == 'ACHR':
                    if k[0] in self.owned:
                        self.win[k] = (p, t, off, sz, fl, ctx)
                    continue
                self.types[k] = t
                if t in KEEP_TYPES:
                    self.win[k] = (p, t, off, sz, fl, ctx)

    def refs_in(self, wanted):
        """The winning REFRs whose world (or interior cell) is in wanted: (key, plugin, off, size, flags, ctx)"""
        out = {}
        for p in self.plugins:
            for t, fid, fl, off, sz, ctx in p.index:
                if t != 'REFR' or not ctx:
                    continue
                w, c, g = ctx
                where = self.source(p, w) if w else self.source(p, c)
                if where not in wanted:
                    continue
                k = self.source(p, fid)
                if k:
                    out[k] = (p, off, sz, fl, ctx)
        return out

    def source(self, p, fid):
        src, loc = p.modindex_source(fid)
        if src is None:   # an index past the plugin's own: a broken reference
            return None
        return (src.lower(), loc & 0xFFFFFF)

    def desc(self, k):
        return '%x:%s' % (k[1], self.proper.get(k[0], k[0]))

    def load_id(self, k):
        base, mask = self.gid.get(k[0], (0, 0xFFFFFF))
        return (base | (k[1] & mask)) & 0xFFFFFFFF

    def data(self, k):
        w = self.win.get(k)
        if not w:
            return None
        p, t, off, sz, fl, ctx = w
        return subs(p.data_at(p.fh, off, sz, fl))

    def edid(self, k):
        s = self.data(k)
        return (dict(s).get(b'EDID', b'') if s else b'').rstrip(b'\0').decode('cp1252', 'replace')

    def ref(self, p, raw):
        return self.source(p, struct.unpack('<I', raw[:4])[0])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', default='/opt/skyrim-data')
    ap.add_argument('--order', default=os.path.expanduser('~nate/dragonbreak/fork/deploy/skyrim-data/loadorder.txt'))
    ap.add_argument('--replace', action='append', default=[], help='"<plugin name>=<path>": read this copy instead')
    ap.add_argument('--out', default='owned-spawns.json')
    ap.add_argument('--dungeons', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'dungeons.json'),
                    help='dungeons.json: placements a dungeon lease spawns are left to dungeons.js')
    a = ap.parse_args()
    replace = {}
    for r in a.replace:
        name, _, path = r.partition('=')
        replace[name.strip().lower()] = path.strip()
    lo = LoadOrder(a.data, a.order, replace)
    leased = set()
    try:
        # Every "<local id>:<plugin>" dungeons.json mentions, lowercased: a placement a lease spawns is not ours to spawn
        leased = {m.lower() for m in re.findall(r'[0-9a-fA-F]{1,6}:[^"\\]+?\.es[mpl]', open(a.dungeons, encoding='utf-8').read())}
    except OSError:
        print(f'note: {a.dungeons} not readable; no dungeon placements excluded')
    result = build(lo, leased)
    # Which copies of the owned plugins this was generated from (the gate checks the shipping plugin itself)
    result['sources'] = {lo.proper[p.key]: hashlib.sha256(open(p.srcpath, 'rb').read()).hexdigest()[:16] for p in lo.plugins if p.key in lo.owned}
    with open(a.out, 'w', encoding='utf-8') as f:
        json.dump(result, f, indent=1, ensure_ascii=False)
        f.write('\n')
    sk = result['skipped']
    print(f"owned spawns: {len(result['spawns'])} creature(s) in {len(result['groups'])} group(s), {len(result['camps'])} camp(s); "
          f"skipped {len(sk['person'])} person(s), {len(sk['startsDead'])} corpse(s), {len(sk['dungeon'])} dungeon, "
          f"{len(sk['interior'])} interior, {len(sk['unresolved'])} unresolved -> {a.out}")
    return 0


def build(lo, leased=frozenset()):
    # ---- the leveled and template chain, as wildlife.py resolve() --------------------------------------------------
    def npc_info(k):
        s = lo.data(k)
        if not s:
            return None
        d = dict(s)
        acbs = d.get(b'ACBS', b'')
        flags = struct.unpack('<I', acbs[:4])[0] if len(acbs) >= 4 else 0
        lvl = struct.unpack('<H', acbs[8:10])[0] if len(acbs) >= 10 else 1
        p = lo.win[k][0]
        tplt = lo.ref(p, d[b'TPLT']) if len(d.get(b'TPLT', b'')) >= 4 else None
        race = lo.ref(p, d[b'RNAM']) if len(d.get(b'RNAM', b'')) >= 4 else None
        return {'edid': d.get(b'EDID', b'').rstrip(b'\0').decode('cp1252', 'replace'), 'level': 0 if flags & 0x80 else lvl,
                'tplt': tplt, 'race': race}

    def lvln_entries(k):
        s = lo.data(k)
        p = lo.win[k][0]
        out = []
        for sig, v in s or []:
            if sig == b'LVLO' and len(v) >= 8:
                lvl, _, r = struct.unpack('<HHI', bytes(v[:8]))
                rk = lo.source(p, r)
                if rk:
                    out.append((lvl, rk))
        return out

    def resolve(k, depth=0):
        if depth > 8:
            return []
        t = lo.types.get(k)
        if t == 'NPC_':
            n = npc_info(k)
            if not n:
                return []
            if n['tplt'] and lo.types.get(n['tplt']) == 'LVLN':
                return resolve(n['tplt'], depth + 1)
            if n['tplt'] and lo.types.get(n['tplt']) == 'NPC_' and n['tplt'] != k:
                deeper = resolve(n['tplt'], depth + 1)
                if len(deeper) > 1:
                    return deeper
            return [(n['level'], k)]
        if t == 'LVLN':
            best = {}
            for lvl, r in lvln_entries(k):
                for l2, c2 in resolve(r, depth + 1):
                    v = lvl if lo.types.get(r) == 'NPC_' else max(lvl, l2)
                    if c2 not in best or v < best[c2]:
                        best[c2] = v
            return sorted((v, c) for c, v in best.items())
        return []

    race_kw = {}

    def is_person(npc_k, depth=0):
        """A race with ActorTypeNPC is a person; a template without its own race asks the template"""
        n = npc_info(npc_k)
        if not n:
            return False
        race = n['race']
        if not race and n['tplt'] and depth < 8 and lo.types.get(n['tplt']) == 'NPC_':
            return is_person(n['tplt'], depth + 1)
        if not race:
            return False
        if race not in race_kw:
            s = lo.data(race) or []
            kw = dict(s).get(b'KWDA', b'')
            p = lo.win[race][0]
            race_kw[race] = {lo.edid(lo.source(p, struct.unpack_from('<I', kw, i)[0])) for i in range(0, len(kw) - 3, 4)}
        return 'ActorTypeNPC' in race_kw[race]

    def kind_of(npc_k, options):
        for k in [npc_k] + [c for _, c in options]:
            n = npc_info(k) if lo.types.get(k) == 'NPC_' else None
            e = n['edid'] if n else lo.edid(k)
            m = CREATURE.match(e or '')
            if m:
                return m.group(1).lower()
        for _, c in options:
            n = npc_info(c)
            if n and n['race']:
                r = re.sub(r'Race$', '', re.sub(r'^(CYR|BSK|BS|DLC1|DLC2)', '', lo.edid(n['race'])))
                if r:
                    return r.lower()
        return 'creature'

    # ---- the owned plugins' disabled living ACHRs -----------------------------------------------------------------
    spawns, skipped = [], {'person': [], 'startsDead': [], 'unresolved': [], 'interior': [], 'dungeon': []}
    worlds_needed = collections.defaultdict(set)   # world/cell key -> {(gx, gy)}
    for p in lo.plugins:
        if p.key not in lo.owned:
            continue
        own = len(p.masters)
        for t, fid, fl, off, sz, ctx in p.index:
            if t != 'ACHR' or (fid >> 24) != own:
                continue
            k = (p.key, fid & 0xFFFFFF)
            wp, wt, woff, wsz, wfl, wctx = lo.win[k]
            if wfl & DELETED or not wfl & DISABLED:
                continue
            s = dict(subs(wp.data_at(wp.fh, woff, wsz, wfl)))
            if len(s.get(b'NAME', b'')) < 4 or len(s.get(b'DATA', b'')) < 24:
                continue
            base = lo.ref(wp, s[b'NAME'])
            pos = struct.unpack('<3f', s[b'DATA'][:12])
            rot = struct.unpack('<3f', s[b'DATA'][12:24])
            src = lo.desc(k)
            if src.lower() in leased:      # a dungeon lease's placement (dungeons.js spawns it while claimed)
                skipped['dungeon'].append(src)
                continue
            if not (wctx and wctx[0]):     # interiors are dungeons, expeditions and homes, each with its own spawner
                skipped['interior'].append(src)
                continue
            if wfl & STARTS_DEAD:
                skipped['startsDead'].append(src)
                continue
            options = resolve(base)
            if not options:
                skipped['unresolved'].append(f'{src} ({lo.edid(base)})')
                continue
            if any(is_person(c) for _, c in options):
                skipped['person'].append(f'{src} ({lo.edid(base)})')
                continue
            w, c, g = wctx if wctx else (0, 0, 0)
            world = lo.source(wp, w) if w else None
            cell = lo.source(wp, c) if c else None
            where = world or cell
            spawns.append({'k': k, 'src': src, 'loadId': '%08x' % lo.load_id(k), 'base': lo.desc(base), 'edid': lo.edid(base),
                           'kind': kind_of(base, options), 'where': where, 'interior': not world, 'cell': cell,
                           'pos': [round(x, 2) for x in pos], 'heading': round(math.degrees(rot[2]) % 360, 1),
                           'options': [[lvl, lo.desc(c)] for lvl, c in options]})
            worlds_needed[where].add((int(pos[0] // CELL), int(pos[1] // CELL)))

    # ---- nearby references: anchors (not ours), markers and camp chests --------------------------------------------
    # Only cells near a spawn are decoded: their grid comes from the CELL record's XCLC, persistent cells always.
    cell_grid = {}
    for k, (p, t, off, sz, fl, ctx) in lo.win.items():
        if t != 'CELL' or not ctx or not ctx[0]:
            continue
        wk = lo.source(p, ctx[0])
        if wk not in worlds_needed:
            continue
        x = dict(subs(p.data_at(p.fh, off, sz, fl))).get(b'XCLC', b'')
        cell_grid[k] = struct.unpack('<ii', x[:8]) if len(x) >= 8 else None

    def near_cell(where, ck):
        if where == ck:            # an interior spawn: its own cell
            return True
        grid = cell_grid.get(ck, 'absent')
        if grid == 'absent':
            return False
        if grid is None:           # the world's persistent cell
            return True
        return any(abs(grid[0] - gx) <= 2 and abs(grid[1] - gy) <= 2 for gx, gy in worlds_needed.get(where, ()))

    anchors = collections.defaultdict(list)   # where -> [(key, pos)]
    markers = collections.defaultdict(list)   # where -> [(key, pos, name)]
    chests = collections.defaultdict(list)    # where -> [(key, pos, edid)]
    for k, (p, off, sz, fl, ctx) in lo.refs_in(set(worlds_needed)).items():
        if fl & DELETED:
            continue
        w, c, g = ctx
        where = lo.source(p, w) if w else lo.source(p, c)
        ck = lo.source(p, c) if c else None
        # Persistent references (group type 8: map markers, most doors) are few and kept whatever their cell's grid says
        if g != 8 and not near_cell(where, ck):
            continue
        s = dict(subs(p.data_at(p.fh, off, sz, fl)))
        if len(s.get(b'NAME', b'')) < 4 or len(s.get(b'DATA', b'')) < 12:
            continue
        base = lo.ref(p, s[b'NAME'])
        pos = struct.unpack('<3f', s[b'DATA'][:12])
        bt = lo.types.get(base)
        if b'XMRK' in s or base == MAP_MARKER:
            text = s.get(b'FULL', b'').rstrip(b'\0')
            # A localized plugin stores a 4-byte string id here, not the name
            name = '' if not text or any(b < 32 or b > 126 for b in text) else text.decode('cp1252', 'replace')
            markers[where].append((k, pos, name))
        if bt == 'CONT' and k[0] in lo.owned and re.search(r'Treas\w*Chest', lo.edid(base), re.I):
            chests[where].append((k, pos, lo.edid(base)))
        # Ours neither placed it nor carries its winning record, so no release of ours moves or removes it
        if bt in OK_TYPES and k[0] not in lo.owned and p.key not in lo.owned:
            anchors[where].append((k, pos))

    groups = {}
    for sp in spawns:
        where, pos = sp['where'], sp['pos']
        best = min(anchors.get(where, []), key=lambda a: math.dist(a[1], pos), default=None)
        if best is None:
            skipped['unresolved'].append(f"{sp['src']} (no anchor of ours-free origin near it)")
            sp['drop'] = True
            continue
        sp['ref'] = lo.desc(best[0])
        sp['anchorDist'] = round(math.dist(best[1], pos))
        near = [m for m in markers.get(where, []) if math.dist(m[1][:2], pos[:2]) <= AREA_REACH.get(m[0], MARKER_REACH)]
        m = min(near, key=lambda m: math.dist(m[1][:2], pos[:2]), default=None)
        if m:
            gid = lo.desc(m[0])
            gname = m[2] or (lo.edid(sp['cell']) if sp['cell'] else '') or gid
        else:
            gid = lo.desc(sp['cell']) if sp['cell'] else lo.desc(where)
            gname = (lo.edid(sp['cell']) if sp['cell'] else '') or gid
        sp['group'] = gid
        g = groups.setdefault(gid, {'id': gid, 'name': gname, 'where': lo.desc(where), 'spawns': 0, 'kinds': collections.Counter(), 'pos': [],
                                    'area': (m[1], AREA_REACH[m[0]]) if m and m[0] in AREA_REACH else None})
        g['spawns'] += 1
        g['kinds'][sp['kind']] += 1
        g['pos'].append(pos)
    spawns = [sp for sp in spawns if not sp.get('drop')]

    camps = []
    for gid, g in sorted(groups.items()):
        cx = sum(p[0] for p in g['pos']) / len(g['pos'])
        cy = sum(p[1] for p in g['pos']) / len(g['pos'])
        where = next(sp['where'] for sp in spawns if sp['group'] == gid)
        centre, reach = (g['area'][0][:2], g['area'][1]) if g['area'] else ((cx, cy), MARKER_REACH)
        mine = [c for c in chests.get(where, []) if math.dist(c[1][:2], centre) <= reach]
        if mine:
            owner = g['kinds'].most_common(1)[0][0]
            camps.append({'id': 'owned:' + gid, 'name': g['name'], 'owners': owner + 's', 'group': gid,
                          'chests': [{'ref': lo.desc(k), 'loadId': '%08x' % lo.load_id(k), 'edid': e, 'pos': [round(v, 2) for v in pos]} for k, pos, e in mine]})

    out_spawns = []
    for sp in sorted(spawns, key=lambda s: (s['k'][0], s['k'][1])):
        out_spawns.append({'src': sp['src'], 'loadId': sp['loadId'], 'kind': sp['kind'], 'base': sp['base'], 'edid': sp['edid'],
                           'world': lo.desc(sp['where']), 'interior': sp['interior'], 'pos': sp['pos'], 'heading': sp['heading'],
                           'ref': sp['ref'], 'anchorDist': sp['anchorDist'], 'group': sp['group'], 'options': sp['options']})
    return {
        '_comment': 'Generated by tools/spawns/owned_spawns.py: every living creature a DragonBreak-owned plugin places Initially '
                    'Disabled, spawned by the server as wild:<kind>:p<local id> zones (wildlife.js). Do not edit by hand; '
                    'rerun the generator after a plugin changes, and tools/spawns/spawns_gate.py before shipping.',
        'spawns': out_spawns,
        'groups': [{'id': g['id'], 'name': g['name'], 'world': g['where'], 'spawns': g['spawns'], 'kinds': dict(g['kinds'])} for g in groups.values()],
        'camps': camps,
        'skipped': skipped,
    }


if __name__ == '__main__':
    sys.exit(main())
