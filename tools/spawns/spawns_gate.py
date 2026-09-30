#!/usr/bin/env python3
"""Release gate for owned spawns: every creature owned-spawns.json spawns must be placed Initially Disabled by the plugin
that ships, and every camp chest it names must be there, or players see the plugin's copy and the server's side by side
(or a camp with no chest). An empty list passes, so the gate never blocks a release that adds no creatures.

    sudo python3 tools/spawns/spawns_gate.py [--spawns owned-spawns.json] [--data /opt/skyrim-data]
        [--replace "DragonBreak Online Edits.esp=/path/to/the/copy/that/ships.esp"]

Exit 0 with one "ok" line, or 1 with a one-line reason naming the ids. Ids are the plugin's own records by local id
(the file's own master index), so a plugin that gains a master still matches.
"""
import argparse
import collections
import json
import os
import sys

sys.path.insert(0, os.path.expanduser('~nate/dragonbreak/ck-mcp'))
import esplib  # noqa: E402

DISABLED, STARTS_DEAD, DELETED = 0x800, 0x200, 0x20


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--spawns', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'owned-spawns.json'))
    ap.add_argument('--data', default='/opt/skyrim-data')
    ap.add_argument('--replace', action='append', default=[], help='"<plugin name>=<path>": check this copy instead')
    a = ap.parse_args()
    try:
        spec = json.load(open(a.spawns, encoding='utf-8'))
    except (OSError, ValueError) as e:
        print(f'cannot read {a.spawns}: {e}')
        return 1
    spawns, camps = spec.get('spawns') or [], spec.get('camps') or []
    if not spawns and not camps:
        print('ok: owned-spawns.json lists no creatures and no camps; nothing to check')
        return 0
    replace = {}
    for r in a.replace:
        name, _, path = r.partition('=')
        replace[name.strip().lower()] = path.strip()
    wanted = collections.defaultdict(lambda: {'achr': set(), 'refr': set()})
    for sp in spawns:
        loc, plugin = sp['src'].split(':', 1)
        wanted[plugin]['achr'].add(int(loc, 16))
    for c in camps:
        for ch in c.get('chests') or []:
            loc, plugin = ch['ref'].split(':', 1)
            wanted[plugin]['refr'].add(int(loc, 16))
    missing, enabled, dead = [], [], []
    for plugin, w in wanted.items():
        path = replace.get(plugin.lower()) or os.path.join(a.data, plugin)
        try:
            p = esplib.Plugin(path)
        except Exception as e:
            print(f'cannot read {plugin} at {path}: {e}')
            return 1
        own = len(p.masters)
        found = {}
        for t, fid, fl, off, sz, ctx in p.index:
            if (fid >> 24) == own and (fid & 0xFFFFFF) in w['achr'] | w['refr']:
                found[fid & 0xFFFFFF] = (t, fl)
        tag = lambda x: f'{own:02X}{x:06X} ({plugin})'
        for x in sorted(w['refr']):
            if found.get(x, ('', 0))[0] != 'REFR' or found[x][1] & DELETED:
                missing.append('chest ' + tag(x))
        for x in sorted(w['achr']):
            t, fl = found.get(x, ('', 0))
            if t != 'ACHR' or fl & DELETED:
                missing.append(tag(x))
            elif fl & STARTS_DEAD:
                dead.append(tag(x))
            elif not fl & DISABLED:
                enabled.append(tag(x))
    if missing:
        print(f'missing: {len(missing)} record(s) owned-spawns.json names are not in the plugin that ships: ' + ', '.join(missing))
        return 1
    if enabled:
        print(f'not disabled: {len(enabled)} of {len(spawns)} creatures lack Initially Disabled (0x800): ' + ', '.join(enabled))
        return 1
    if dead:
        print(f'starts dead: {len(dead)} creature(s) the server would spawn alive are corpses in the plugin (regenerate owned-spawns.json): ' + ', '.join(dead))
        return 1
    print(f'ok: {len(spawns)} owned creature spawn(s) all Initially Disabled, {sum(len(c.get("chests") or []) for c in camps)} camp chest(s) present')
    return 0


if __name__ == '__main__':
    sys.exit(main())
