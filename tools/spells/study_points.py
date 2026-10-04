#!/usr/bin/env python3
"""The Study Magic activators as spell study points (Nate, 2026-09-30: "make StudyMagic activators the study points").

Finds every placed reference of the ACTI whose editor id is StudyMagic (DragonBreak Online Edits.esp, DLE v8) and writes
them into skills.json spellStudyPoints, one entry per cell or worldspace, with each reference's plugin position, so
spells.js measures a reader's distance without the reference being loaded. The entries carry `requires` (the base's
desc): spells.js uses them only once that record is in the server's load order, and the older points marked `until`
the same desc hold until then, so this data can ship before the plugin does.

    python3 tools/spells/study_points.py [--replace "DragonBreak Online Edits.esp=/path/to/new.esp"] [--check]

--replace reads a plugin not yet in /opt/skyrim-data under its load-order name. --check writes nothing and exits 1 when
skills.json would change. Only the entries this tool wrote (`_generated`) are replaced; hand-written ones are kept.
"""
import argparse, json, os, re, struct, sys

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.abspath(os.path.join(HERE, '..', '..'))
sys.path.insert(0, os.path.expanduser('~nate/dragonbreak/ck-mcp'))
import esplib  # noqa: E402

EDID = 'StudyMagic'
RADIUS_METERS = 4
SCHOOLS = ['Destruction', 'Conjuration', 'Illusion', 'Restoration', 'Alteration']
DELETED, DISABLED = 0x20, 0x800
# Names for the places; any other cell is named by its editor id
PLACES = {
    ('bsheartland.esm', 0x20ff): 'The Synod Conclave in Bruma',
    ('bsheartland.esm', 0x6ff7d): 'Frost Crag Spire',
    ('skyrim.esm', 0x13810): 'The Arcanaeum at the College of Winterhold',
}
ORDER = list(PLACES)
TAG = 'tools/spells/study_points.py'
# Other references that count as study spots of a place, beside its activators; their positions are read from the plugin
# too. Frost Crag Spire's one shelf stands by the alchemy table on the ground floor, while its study (the Scholars'
# Ledger by the enchanting table, the Class Lecterns) is about 21 m away on the floor above, where its mages read their
# tomes and were refused (Nate, 4 Oct: "Frostcrag needs to be able to have players learn spells").
EXTRA = {
    ('bsheartland.esm', 0x6ff7d): [('dragonbreak online edits.esp', 0x13f775), ('dragonbreak online edits.esp', 0x15e4c4)],
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', default='/opt/skyrim-data')
    ap.add_argument('--order', default=os.path.expanduser('~nate/dragonbreak/fork/deploy/skyrim-data/loadorder.txt'))
    ap.add_argument('--replace', action='append', default=[], help='"<load-order name>=<path>"')
    ap.add_argument('--skills', default=os.path.join(SERVER, 'skills.json'))
    ap.add_argument('--check', action='store_true')
    a = ap.parse_args()
    replace = {k.strip().lower(): v for k, v in (r.split('=', 1) for r in a.replace)}

    names = [l.strip().lstrip('*') for l in open(a.order, encoding='utf-8-sig') if l.strip() and not l.startswith('#')]
    plugins, proper = [], {}
    for n in names:
        path = replace.get(n.lower()) or os.path.join(a.data, n)
        if not os.path.exists(path):
            print(f'missing from the load order folder: {n}', file=sys.stderr)
            continue
        p = esplib.Plugin(path)
        p.key = n.lower()
        p.fh = open(path, 'rb')
        plugins.append(p)
        proper[n.lower()] = n

    def src(p, fid):
        s, loc = p.modindex_source(fid)
        return (s.lower(), loc & 0xFFFFFF) if s else None

    def desc(k):
        return '%x:%s' % (k[1], proper.get(k[0], k[0]))

    # The base: the winning ACTI with that editor id
    bases, cells = {}, {}
    for p in plugins:
        for t, fid, fl, off, sz, ctx in p.index:
            if t in ('ACTI', 'CELL', 'WRLD'):
                k = src(p, fid)
                if not k:
                    continue
                e = esplib.edid_of(p.data_at(p.fh, off, sz, fl)) or ''
                if t == 'ACTI':
                    if e == EDID and not fl & DELETED:
                        bases[k] = p.key
                    else:
                        bases.pop(k, None)
                else:
                    cells[k] = e
    if len(bases) != 1:
        sys.exit(f'expected one ACTI {EDID} in the load order, found {len(bases)}: {[desc(k) for k in bases]}')
    base = next(iter(bases))
    # Its references: only a plugin that is or masters the base's plugin can place one; the last one in the order wins
    refs, extra = {}, {}
    wanted = {r: where for where, rs in EXTRA.items() for r in rs}
    for p in plugins:
        if p.key != base[0] and base[0] not in (m.lower() for m in p.masters):
            continue
        for t, fid, fl, off, sz, ctx in p.index:
            if t != 'REFR':
                continue
            k = src(p, fid)
            d = dict(esplib.subrecords(p.data_at(p.fh, off, sz, fl)))
            if k in wanted:
                w, c, _g = ctx
                ok = not fl & (DELETED | DISABLED) and b'DATA' in d and (src(p, w) if w else src(p, c)) == wanted[k]
                extra[k] = [round(x, 1) for x in struct.unpack('<3f', d[b'DATA'][:12])] if ok else None
            if b'NAME' not in d or src(p, struct.unpack('<I', d[b'NAME'][:4])[0]) != base:
                refs.pop(k, None)
                continue
            w, c, _g = ctx
            where = src(p, w) if w else src(p, c)
            refs[k] = None if fl & (DELETED | DISABLED) or b'DATA' not in d else (where, [round(x, 1) for x in struct.unpack('<3f', d[b'DATA'][:12])])
    by_place = {}
    for k, v in sorted(refs.items()):
        if v:
            by_place.setdefault(v[0], []).append({'refr': desc(k), 'pos': v[1]})
    shelves = {where: len(places) for where, places in by_place.items()}
    for k, where in wanted.items():
        if not extra.get(k):
            sys.exit(f'{desc(k)}, a study spot of {desc(where)}, is missing, deleted, disabled or elsewhere in the load order')
        if where in by_place:  # a place counts only once its own activators are there
            by_place[where].append({'refr': desc(k), 'pos': extra[k]})
    entries = [{
        'name': PLACES.get(where) or re.sub(r'([a-z])([A-Z])', r'\1 \2', re.sub(r'^CYR', '', cells.get(where, desc(where)))),
        'requires': desc(base),
        'cell': desc(where),
        'radiusMeters': RADIUS_METERS,
        'places': places,
        'schools': SCHOOLS,
        '_generated': f'{TAG}: the {EDID} activators, {shelves[where]} here'
                      + (f', and {len(places) - shelves[where]} more study spots (EXTRA)' if len(places) > shelves[where] else '')
                      + '; within radiusMeters of one',
    } for where, places in sorted(by_place.items(), key=lambda kv: (ORDER.index(kv[0]) if kv[0] in ORDER else len(ORDER), desc(kv[0])))]

    text = open(a.skills, encoding='utf-8').read()
    m = re.search(r'\n "spellStudyPoints": (\[.*?\n \])', text, re.S)
    if not m:
        sys.exit('skills.json has no spellStudyPoints array at the top level')
    kept = [e for e in json.loads(m.group(1)) if not str(e.get('_generated', '')).startswith(TAG)]
    for e in kept:
        if 'until' not in e:
            print(f'note: "{e.get("name")}" has no "until": it stays a study point after the {EDID} activators arrive')
    arr = json.dumps(kept + entries, indent=1, ensure_ascii=False).replace('\n', '\n ')
    new = text[:m.start(1)] + arr + text[m.end(1):]
    json.loads(new)
    print(f'{EDID} {desc(base)}: {sum(shelves.values())} activators in {len(entries)} places, {sum(len(e["places"]) for e in entries) - sum(shelves.values())} more study spots')
    for e in entries:
        print(f'  {len(e["places"]):3d}  {e["name"]} ({e["cell"]})')
    if new == text:
        print('skills.json is current')
        return 0
    if a.check:
        print('skills.json would change')
        return 1
    open(a.skills, 'w', encoding='utf-8').write(new)
    print(f'wrote {a.skills}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
