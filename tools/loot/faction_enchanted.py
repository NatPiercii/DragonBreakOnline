"""Keeps enchanted copies of faction gear out of loot (Nate, 11 Oct: "PEOPLE NEED TO NOT GET ENCHANTED IMPERIAL SWORD FROM A DUNGEON").

faction-gear.json names the base items (the Imperial Sword); an enchanted copy (EnchImperialSwordFire1) is its own record
whose template (CNAM, TNAM for armour) is that base, so loottiers.js never saw it as faction gear. This reads every
enchanted weapon and armour in loot.json's ench_ pools, follows its template to a faction-gear.json item, and writes each
one still lootable into loot-overrides.json `never`, keeping every hand entry. Rerun after faction-gear.json or loot.json
change.

  nice python3 tools/loot/faction_enchanted.py [--dry]      (from server/; reads /opt/skyrim-data and the PC's load order)
"""
import json, os, struct, sys

SERVER = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.environ.get('ESPLIB_DIR', os.path.expanduser('~nate/dragonbreak/ck-mcp')))
import esplib  # noqa: E402

DATA = os.environ.get('SKYRIM_DATA', '/opt/skyrim-data')
ORDER = os.environ.get('LOAD_ORDER', os.path.expanduser('~nate/dragonbreak/fork/deploy/skyrim-data/loadorder.txt'))
TAG = 'faction gear, enchanted'


def norm(desc):
    local, plugin = desc.split(':', 1)
    return '%x:%s' % (int(local, 16), plugin.lower())


def main():
    dry = '--dry' in sys.argv
    pools = json.load(open(os.path.join(SERVER, 'loot.json')))['pools']
    faction = {norm(k): v for k, v in json.load(open(os.path.join(SERVER, 'faction-gear.json')))['items'].items()}
    wanted = {}
    for pool in ('ench_weapons', 'ench_armor'):
        for it in pools.get(pool, []):
            wanted[norm(it['id'])] = (it['id'], it['name'])
    template = {}
    names = [l.strip().lstrip('*') for l in open(ORDER, encoding='utf-8-sig') if l.strip() and not l.startswith('#')]
    for n in names:
        path = os.path.join(DATA, n)
        if not os.path.exists(path):
            continue
        p = esplib.Plugin(path)
        with open(path, 'rb') as fh:
            for t, fid, fl, off, sz, ctx in p.index:
                if t not in ('WEAP', 'ARMO'):
                    continue
                src = p.modindex_source(fid)
                if not src[0]:
                    continue
                key = '%x:%s' % (src[1] & 0xFFFFFF, src[0].lower())
                if key not in wanted:
                    continue
                for s, v in esplib.subrecords(p.data_at(fh, off, sz, fl)):
                    if s in (b'CNAM', b'TNAM') and len(v) >= 4:
                        rs = p.modindex_source(struct.unpack_from('<I', v)[0])
                        if rs[0]:
                            template[key] = '%x:%s' % (rs[1] & 0xFFFFFF, rs[0].lower())
    path = os.path.join(SERVER, 'loot-overrides.json')
    text = open(path, encoding='utf-8').read()
    overrides = json.loads(text)
    never = overrides.setdefault('never', {})
    # Entries this tool wrote before are rebuilt; hand entries stay as they are
    kept = {k: v for k, v in never.items() if TAG not in str(v)}
    added = {}
    for key, base in sorted(template.items()):
        if base not in faction:
            continue
        desc, edid = wanted[key]
        if any(norm(k) == key for k in kept if not k.startswith('_')):
            continue
        g = faction[base]
        added[desc] = '%s: %s of %s (%s), never loot like its base (Nate, 11 Oct)' % (edid, TAG, g.get('name', base), g.get('set', '?'))
    overrides['never'] = dict(kept, **added)
    by = {}
    for v in added.values():
        s = v.split('(')[1].split(')')[0]
        by[s] = by.get(s, 0) + 1
    print('%d enchanted faction pieces never loot: %s' % (len(added), ', '.join('%s %d' % kv for kv in sorted(by.items()))))
    if not dry:
        open(path, 'w', encoding='utf-8').write(json.dumps(overrides, indent=2, ensure_ascii=False) + '\n')


if __name__ == '__main__':
    main()
