#!/usr/bin/env python3
"""Faction gear recipes for the PC run (DBO_BlacksmithTiers.pas DoFactionRecipes).

faction-gear.json names, per faction item, the recipes that make it; factiongear.js refuses the craft to anyone outside
the faction or role. The vanilla and mod locks on those recipes (quest stages, the civil war side, a vampire race) are
then only in the way, so the PC run removes every OR group holding a condition that names a quest or a faction.

  python3 tools/recipes/faction_recipes.py tsv      writes faction_recipes.tsv (what the PC script reads)
  python3 tools/recipes/faction_recipes.py check    reads the server's plugins and prints, per recipe, the conditions
                                                    that go and the ones that stay, by the same rule as the script;
                                                    exits 1 when a lock would stay or a recipe is missing
"""
import json
import os
import struct
import sys
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.abspath(os.path.join(HERE, '..', '..'))
TSV = os.path.join(HERE, 'faction_recipes.tsv')
DATA = '/opt/skyrim-data/'
LOADORDER = os.path.expanduser('~/dragonbreak/fork/deploy/skyrim-data/loadorder.txt')
LOCK_TYPES = (b'QUST', b'FACT')   # race checks stay: only Orcs craft Orcish, a vampire wears the vampire race
# Only for printing: the census's names (recipe_census.py FUNCS) and the ones it leaves as numbers
FUNCS = {448: 'HasPerk', 264: 'HasSpell', 47: 'GetItemCount', 74: 'GetGlobalValue', 543: 'GetQuestCompleted',
         59: 'GetStageDone', 58: 'GetStage', 182: 'GetEquipped', 130: 'GetPCIsRace', 132: 'GetInFaction', 71: 'GetFactionRank'}


def faction_recipes():
    items = json.load(open(os.path.join(SERVER, 'faction-gear.json')))['items']
    rows = {}
    for item, v in items.items():
        for r in v.get('recipes', []):
            local, plugin = r.split(':', 1)
            key = (plugin.lower(), '%06X' % int(local, 16))
            rows.setdefault(key, (plugin, '%06X' % int(local, 16), v['name'], v.get('set', ''), ','.join(v.get('factions', [])), v.get('role', '')))
    return [rows[k] for k in sorted(rows)]


def write_tsv():
    rows = faction_recipes()
    with open(TSV, 'w', newline='\n') as f:
        f.write('# Written by faction_recipes.py tsv from faction-gear.json - edit that, never this file.\n')
        f.write('# origin plugin\tlocal form id\titem\tset\tfactions\trole\n')
        for r in rows:
            f.write('\t'.join(r) + '\n')
    print('%d faction gear recipes -> %s' % (len(rows), TSV))


def subs(b):
    o = 0
    while o + 6 <= len(b):
        t = b[o:o + 4]
        s = struct.unpack_from('<H', b, o + 4)[0]
        yield t, b[o + 6:o + 6 + s]
        o += 6 + s


def read_plugin(name):
    d = open(DATA + name, 'rb').read()
    hs = struct.unpack_from('<I', d, 4)[0]
    masters = [v.rstrip(b'\0').decode() for t, v in subs(d[24:24 + hs]) if t == b'MAST']
    return d, hs, masters


def top_groups(d, hs, want):
    o = 24 + hs
    while o < len(d):
        gsz = struct.unpack_from('<I', d, o + 4)[0]
        label = d[o + 8:o + 12]
        if label in want:
            q = o + 24
            while q < o + gsz:
                sz, fl, fid = struct.unpack_from('<III', d, q + 4)
                yield label, fid, fl, d[q + 24:q + 24 + sz]
                q += 24 + sz
        o += gsz


def check():
    order = [l.strip() for l in open(LOADORDER) if l.strip() and not l.startswith('#')]
    want = {(r[0].lower(), r[1]): r for r in faction_recipes()}
    lock_ids = set()      # (origin plugin lower, local id) of every QUST, FACT and RACE
    winners = {}
    for p in order:
        d, hs, masters = read_plugin(p)
        def owner(fid):
            mi = fid >> 24
            return (masters[mi] if mi < len(masters) else p).lower()
        for label, fid, fl, rec in top_groups(d, hs, LOCK_TYPES + (b'COBJ',)):
            key = (owner(fid), '%06X' % (fid & 0xffffff))
            if label != b'COBJ':
                lock_ids.add(key)
                continue
            if key not in want:
                continue
            if fl & 0x40000:
                rec = zlib.decompress(rec[4:])
            conds = []
            for t, v in subs(rec):
                if t == b'CTDA':
                    flags = v[0]
                    fn = struct.unpack_from('<H', v, 8)[0]
                    p1 = struct.unpack_from('<I', v, 12)[0]
                    conds.append({'fn': fn, 'or': bool(flags & 1), 'param': (owner(p1), '%06X' % (p1 & 0xffffff)) if p1 else None,
                                  'comp': struct.unpack_from('<f', v, 4)[0]})
            winners[key] = (p, conds)
    bad = 0
    for key, row in want.items():
        if key not in winners:
            print('MISSING  %s %s (%s)' % (row[0], row[1], row[2]))
            bad += 1
            continue
        plugin, conds = winners[key]
        drop, group, lock = set(), [], False
        for i, c in enumerate(conds):
            group.append(i)
            if c['param'] in lock_ids:
                lock = True
            if not c['or']:
                if lock:
                    drop.update(group)
                group, lock = [], False
        if lock:
            drop.update(group)
        name = lambda c: '%s(%s)' % (FUNCS.get(c['fn'], '#%d' % c['fn']), ':'.join(c['param']) if c['param'] else '')
        gone = [name(conds[i]) for i in sorted(drop)]
        kept = [name(c) for i, c in enumerate(conds) if i not in drop and c['fn'] != 448]
        left_lock = [name(c) for i, c in enumerate(conds) if i not in drop and c['param'] in lock_ids]
        if left_lock:
            bad += 1
        print('%-36s %-30s gone: %s | stays: %s%s' % (row[2][:36], row[3][:30], ' '.join(gone) or '-', ' '.join(kept) or '-',
                                                    '  LOCK LEFT' if left_lock else ''))
    print('\n%d faction gear recipes, %d problem(s)' % (len(want), bad))
    return 1 if bad else 0


if __name__ == '__main__':
    if sys.argv[1:] == ['tsv']:
        write_tsv()
    elif sys.argv[1:] == ['check']:
        sys.exit(check())
    else:
        print(__doc__)
        sys.exit(2)
