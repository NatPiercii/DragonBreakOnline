#!/usr/bin/env python3
"""Carry what one plugin change does to doors.json / regions.json into the committed files, and nothing else.

Run the generator twice on CT 115 (old plugin, then the new one through DBO_REPLACE), then:

    python3 tools/ckmcp/apply_plugin_delta.py doors   OLD/doors.json   NEW/doors.json   [--write]
    python3 tools/ckmcp/apply_plugin_delta.py regions OLD/regions.json NEW/regions.json [--write]

Entries the new run adds, changes or drops relative to the old run are applied to the committed file (doors.json or
regions.json beside tools/); everything else stays as committed. That keeps hand edits (the Bank of Bruma door) and
everything the PC computes differently (localized names: CT 115 has no STRINGS tables) out of the change. Both files
are written the way their generators write them; a committed file that does not round-trip is refused."""
import json, os, sys

SERVER = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))


def dump_doors(d):
    return json.dumps(d, indent=0)   # doors.py: json.dump(..., indent=0), no trailing newline


def dump_regions(d):   # regions.py's writer
    def section(s):
        return "{\n" + ",\n".join("  %s: %s" % (json.dumps(k), json.dumps(s[k], ensure_ascii=False, separators=(',', ':'))) for k in sorted(s)) + "\n }"
    p = d['places']
    doc = [("_comment", json.dumps(d['_comment'])), ("provinces", json.dumps(d['provinces'])),
           ("places", "{\n \"plugins\": %s,\n \"worlds\": %s,\n \"cells\": %s\n}" % (json.dumps(p['plugins']), section(p['worlds']), section(p['cells']))),
           ("tomes", section(d['tomes'])), ("recipes", section(d['recipes'])), ("items", section(d['items']))]
    return "{\n" + ",\n".join('"%s": %s' % (k, v) for k, v in doc) + "\n}\n"


KINDS = {'doors': (dump_doors, [('doors',)]),
         'regions': (dump_regions, [('places', 'worlds'), ('places', 'cells'), ('tomes',), ('recipes',), ('items',)])}


def at(d, path):
    for k in path: d = d[k]
    return d


def main():
    kind, old_p, new_p = sys.argv[1:4]
    dump, sections = KINDS[kind]
    target = os.path.join(SERVER, kind + '.json')
    text = open(target, encoding='utf-8').read()
    cur = json.loads(text)
    if dump(cur) != text:
        sys.exit('%s does not round-trip through the generator format; refusing to rewrite it' % target)
    old, new = json.load(open(old_p, encoding='utf-8')), json.load(open(new_p, encoding='utf-8'))
    changes = 0
    for path in sections:
        o, n, c = at(old, path), at(new, path), at(cur, path)
        for k in n:
            if o.get(k) != n[k]:
                print('%s %s %s: %s -> %s' % ('add' if k not in o else 'change', '.'.join(path), k, json.dumps(c.get(k)), json.dumps(n[k], ensure_ascii=False)))
                c[k] = n[k]; changes += 1
        for k in o:
            if k not in n:
                print('drop %s %s (was %s)' % ('.'.join(path), k, json.dumps(c.get(k), ensure_ascii=False)))
                c.pop(k, None); changes += 1
    print('%d change(s)' % changes)
    if '--write' in sys.argv:
        with open(target, 'w', encoding='utf-8', newline='\n') as f: f.write(dump(cur))
        print('wrote', target)


main()
