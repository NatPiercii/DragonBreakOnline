#!/usr/bin/env python3
"""Fill the rooms of dungeons.json that have no enemies. ck-mcp/dungeons_build.py makes spawn zones only from a cell's
own enabled, living, generic placements, so a room whose occupants are quest actors, disabled at game start, or simply
never placed stays empty in every claim ("20 of 86 multi-room dungeons have a room with no enemies", Road to Alpha).

    sudo python3 tools/dungeons/fill_empty_rooms.py [--in dungeons.json] [--out dungeons.json] [--report]

For each cell of a multi-room dungeon that has no zone, and a one-room dungeon with no zone at all (Boreal Stone Cave,
8 Oct: its ogre is placed disabled for a quest to enable; only the own rule applies there, it has no kind to copy):
  unreachable   no load door from another cell of the same dungeon leads into it (templates such as 000EmptyCell and
                AbandonedPrisonDUPLICATE002, orphan cells, a Soul Cairn cell tagged to Reachcliff): left alone
  connector     its only load doors lead outside (Blackreach's lift rooms, Mzulft04z): left alone
  own           its own living enemy placements were disabled at game start, not quest-parented and not unique
                (Frostiron Mine's goblins, the Windhelm prison's bandit ghosts): those placements are used as they are
  family        otherwise: enemies of the dungeon's own kind (its most common ordinary placements, which dungeons.js
                turns into the province's archetypes as it does everywhere) at the arrival points of the load doors
                into the room and at its furniture, 1 per spot, 2 to 4 per room
Added zones carry "fill": "<reason>" so a rerun after a regeneration replaces them rather than stacking. Reads the
load order with esplib (sudo: /opt/skyrim-data).

Ambush, on purpose: an "own" fill keeps its placement's ref, so dungeons.js's isAmbusher() gives it whatever its vanilla
placement had (a linked coffin or pod). A "family" fill has no ref and so always prespawns standing: it stands at a
load-door arrival or beside the room's furniture, where no coffin or pod waits to hide it, so an ambush has nothing to
come out of.
"""
import argparse, collections, json, math, os, re, struct, sys

sys.path.insert(0, os.path.expanduser('~nate/dragonbreak/ck-mcp'))
DATA = '/opt/skyrim-data'
ORDER_FILE = os.path.expanduser('~nate/dragonbreak/fork/deploy/skyrim-data/loadorder.txt')
# the generator's own "not an enemy" words (dungeons_build.py SKIP), with Undead taken out first as it does
SKIP = ('corpse', 'dead', 'dummy', 'marker', 'rigid', 'testnpc', 'victim', 'prisoner', 'captive', 'sleeping')
UNDEAD = re.compile(r'Undead|undead|UNDEAD')
BOSSY = re.compile(r'boss', re.I)
QUESTY = re.compile(r'^(MQ|MG|DB|TG|CW|DA|DLC\dMQ|DLC\d[A-Z]*MQ)\d|Miraak|Caller', re.I)
MIN_PER_ROOM, MAX_PER_ROOM = 2, 4
BOSS_LCRT = ('skyrim.esm', 0x130F7)   # the Boss location ref type: an own placement with it is written boss: true
# An own boss with one fixed high level gets a Novice line (dungeons.js storyOptions), as Silorn's lich has; balance call
# for Nate. By placement ref: Boreal Stone Cave's level-32 ogre -> CYRLCharOgre's level-1 ogres (CYREncOgre01, 01a)
NOVICE = {'7cbd8:BSHeartland.esm': [[1, '5f056:BSHeartland.esm'], [1, 'd6b7f:BSHeartland.esm']]}
SPREAD = 350   # units between two fill spots of one room


def is_skip(edid):
    e = UNDEAD.sub('', edid).lower()
    return any(w in e for w in SKIP)


def load(order_file=ORDER_FILE):
    import esplib
    names = [l.strip() for l in open(order_file) if l.strip() and not l.startswith('#')]
    plugs = []
    for n in names:
        p = os.path.join(DATA, n)
        if os.path.exists(p):
            pl = esplib.Plugin(p); pl.fh = open(p, 'rb'); pl.proper = n; plugs.append(pl)
    return esplib, plugs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--in', dest='src', default=os.path.join(os.path.dirname(__file__), '..', '..', 'dungeons.json'))
    ap.add_argument('--out')
    ap.add_argument('--report', action='store_true')
    ap.add_argument('--config', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'gamemode-config.json'),
                    help='gamemode-config.json, for dungeons.exclude (the repo\'s own by default, wherever --in is)')
    a = ap.parse_args()
    data = json.load(open(a.src, encoding='utf-8'))
    D = data['dungeons']
    for d in D:   # a rerun replaces its own zones
        d['zones'] = [z for z in d['zones'] if not z.get('fill')]
    # Dungeons dungeons.js never offers for a claim (its own list plus gamemode-config dungeons.exclude) are not filled
    try:
        excluded = set(json.load(open(a.config, encoding='utf-8')).get('dungeons', {}).get('exclude') or [])
    except (OSError, ValueError) as e:
        sys.exit(f'cannot read dungeons.exclude from {a.config}: {e}')   # never fill a dungeon that cannot be claimed by accident
    excluded.add('CYRLakesideRetreatLocation')
    esplib, plugs = load()
    proper = {pl.key: pl.proper for pl in plugs}
    desc = lambda k: '%x:%s' % (k[1], proper.get(k[0], k[0]))
    key = lambda s: (s.split(':', 1)[1].lower(), int(s.split(':', 1)[0], 16))
    cell_of = {}   # cell key -> dungeon
    empty = {}
    for d in D:
        for c in d['cells']:
            cell_of[key(c['desc'])] = d
        if d['id'] in excluded:
            continue
        zc = {key(z['cell']) for z in d['zones']}
        if len(d['cells']) < 2 and zc:
            continue
        for c in d['cells']:
            if key(c['desc']) not in zc:
                empty[key(c['desc'])] = (d, c)
    # winners: refs and actors in the empty cells, every door (for arrivals), bases
    win, base = {}, {}
    for pl in plugs:
        for t, fid, fl, off, sz, ctx in pl.index:
            k = pl.modindex_source(fid)
            if k[0] is None:
                continue
            if t in ('REFR', 'ACHR'):
                ck = pl.modindex_source(ctx[1]) if ctx and ctx[1] else None
                win[k] = (t, pl, off, sz, fl, ck, pl.modindex_source(ctx[0]) if ctx and ctx[0] else None)
            elif t in ('NPC_', 'LVLN', 'DOOR', 'FURN', 'CONT', 'IDLM'):
                base[k] = (t, pl, off, sz, fl)
    subs = lambda r: dict(esplib.subrecords(r[1].data_at(r[1].fh, r[2], r[3], r[4])))
    bedid = lambda k: (subs(base[k]).get(b'EDID', b'').rstrip(b'\0').decode('cp1252', 'replace') if k in base else '')
    # load doors: which cell each door is in, and where its XTEL lands (the arrival spot lies in the target door's cell)
    doors_in = collections.defaultdict(list)     # cell -> [(door, target door)]
    arrivals = collections.defaultdict(list)     # cell -> [arrival pos]  (for doors that lead INTO that cell)
    furniture = collections.defaultdict(list)    # empty cell -> [pos]
    actors = collections.defaultdict(list)       # empty cell -> [(ref, base, flags, has parent, pos)]
    door_cell = {k: v[5] for k, v in win.items() if v[0] == 'REFR'}
    for k, v in win.items():
        t, pl, off, sz, fl, ck, ext = v
        if fl & 0x20:
            continue
        if t == 'REFR':
            s = subs(v)
            if len(s.get(b'XTEL', b'')) >= 16:
                tgt = pl.modindex_source(struct.unpack('<I', s[b'XTEL'][:4])[0])
                pos = struct.unpack('<3f', s[b'XTEL'][4:16])
                doors_in[ck if not ext else ('ext',)].append((k, tgt))
                if tgt in door_cell and door_cell[tgt] in empty:
                    arrivals[door_cell[tgt]].append((pos, ck, ext))   # ext: the source door's world, or None indoors
            elif ck in empty and len(s.get(b'NAME', b'')) >= 4 and len(s.get(b'DATA', b'')) >= 12:
                b = pl.modindex_source(struct.unpack('<I', s[b'NAME'][:4])[0])
                if base.get(b, ('',))[0] in ('FURN', 'IDLM'):
                    furniture[ck].append(struct.unpack('<3f', s[b'DATA'][:12]))
        elif t == 'ACHR' and ck in empty:
            s = subs(v)
            if len(s.get(b'NAME', b'')) < 4 or len(s.get(b'DATA', b'')) < 12:
                continue
            b = pl.modindex_source(struct.unpack('<I', s[b'NAME'][:4])[0])
            lrt = s.get(b'XLRT', b'')
            boss = any(pl.modindex_source(x) == BOSS_LCRT for x in struct.unpack('<%dI' % (len(lrt) // 4), lrt[:len(lrt) // 4 * 4]))
            actors[ck].append((k, b, fl, b'XESP' in s, struct.unpack('<3f', s[b'DATA'][:12]), boss))
    report, added = [], 0
    for ck, (d, c) in sorted(empty.items(), key=lambda kv: (kv[1][0]['id'], kv[1][1]['edid'])):
        from_inside = [p for p, src, ext in arrivals[ck] if not ext and src in cell_of and cell_of[src] is d and src != ck]
        from_outside = [p for p, src, ext in arrivals[ck] if ext or src not in cell_of]
        spots_in = from_inside or from_outside
        if not from_inside and not from_outside:
            report.append((d['id'], c['edid'], 'unreachable', 0)); continue
        # A room entered only from outside is the dungeon's entrance hall when that outside is the world its entrances
        # are in (the Abandoned Prison's WindhelmPrison01); a door into another worldspace makes it a lift room
        # between the dungeon and that world (Blackreach's Z-cells), which stays empty
        entrance_worlds = {key(e['world']) for e in d.get('entrances') or [] if e.get('world')}
        outside_worlds = {ext for p, src, ext in arrivals[ck] if ext}
        if not from_inside and not (outside_worlds & entrance_worlds):
            report.append((d['id'], c['edid'], 'connector', 0)); continue
        # own placements: living, generic, disabled at start, not quest-parented, not unique
        own = []
        for ref, b, fl, parent, pos, boss in actors[ck]:
            e = bedid(b)
            if fl & 0x200 or parent or is_skip(e) or QUESTY.search(e) or not fl & 0x800:
                continue
            if base.get(b, ('',))[0] == 'NPC_':
                acbs = subs(base[b]).get(b'ACBS', b'')
                if len(acbs) >= 4 and struct.unpack('<I', acbs[:4])[0] & 0x20:   # Unique
                    continue
            own.append((ref, b, e, pos, boss))
        family = collections.Counter()
        opts_of = {}
        for z in d['zones']:
            for n in z['npcs']:
                if BOSSY.search(n['edid']) or not n.get('options'):
                    continue
                family[n['edid']] += 1
                opts_of.setdefault(n['edid'], n['options'])
        npcs = []
        if own:
            for ref, b, e, pos, boss in own:
                opts = opts_of.get(e) or [[1, desc(b)]]
                npcs.append({'edid': e, 'pos': [round(v, 1) for v in pos], 'ref': desc(ref), 'options': opts})
                if boss:
                    npcs[-1]['boss'] = True
                if desc(ref) in NOVICE:
                    npcs[-1]['storyOptions'] = NOVICE[desc(ref)]
            why = 'own'
        elif family:
            spots = []
            for p in spots_in + [q for q in from_outside if q not in spots_in] + furniture[ck]:
                if all(math.dist(p[:2], q[:2]) >= SPREAD for q in spots):
                    spots.append(p)
            want = max(MIN_PER_ROOM, min(MAX_PER_ROOM, len(spots)))
            kinds = [e for e, _ in family.most_common()]
            for i in range(want):
                p = spots[i % len(spots)]
                off = 0 if i < len(spots) else 120 * (i // len(spots))
                e = kinds[i % min(len(kinds), 3)]
                npcs.append({'edid': e, 'pos': [round(p[0] + off, 1), round(p[1] + off, 1), round(p[2], 1)], 'options': opts_of[e]})
            why = 'family'
        else:
            report.append((d['id'], c['edid'], 'no family to draw from', 0)); continue
        cx = sum(n['pos'][0] for n in npcs) / len(npcs); cy = sum(n['pos'][1] for n in npcs) / len(npcs)
        cz = sum(n['pos'][2] for n in npcs) / len(npcs)
        radius = max(math.dist(n['pos'][:2], (cx, cy)) for n in npcs)
        # x, y, z like every other zone (dungeons.js places by each npc's own pos, but a reader expects three)
        d['zones'].append({'cell': c['desc'], 'pos': [round(cx, 1), round(cy, 1), round(cz, 1)], 'size': round(radius + 1400), 'fill': why, 'npcs': npcs})
        added += len(npcs)
        report.append((d['id'], c['edid'], why, len(npcs)))
    for r in report:
        print(f'{r[0]:36s} {r[1]:40s} {r[2]:12s} {r[3]}')
    c = collections.Counter(r[2] for r in report)
    print(f'{len(report)} empty rooms: ' + ', '.join(f'{v} {k}' for k, v in c.most_common()) + f'; {added} enemies added')
    if a.out:
        json.dump(data, open(a.out, 'w', encoding='utf-8'), indent=0, ensure_ascii=False)   # the generator's own layout
    return 0


if __name__ == '__main__':
    sys.exit(main())
