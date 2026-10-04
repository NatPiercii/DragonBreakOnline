"""Paths for running the ck-mcp generators on CT 115 instead of Nat's PC (the copies beside this file are
ck-mcp's own with their E:\\ paths routed through here; nothing else in them changed).

    DBO_DATA     the plugin folder, read only (default /opt/skyrim-data)
    DBO_ORDER    the load order (default ~nate/dragonbreak/fork/deploy/skyrim-data/loadorder.txt)
    DBO_SERVER   the server folder the generators read hand data from (default: this worktree)
    DBO_REPLACE  "Load order name=path", several joined by '|': reads a plugin not yet in DBO_DATA under
                 its load-order name, e.g. DBO_REPLACE="DragonBreak Online Edits.esp=/path/graft-v13.esp"

    python3 tools/ckmcp/doors.py   /tmp/claude-nate-x/doors.json
    python3 tools/ckmcp/regions.py /tmp/claude-nate-x/regions.json

Always pass an output path: the defaults write into DBO_SERVER. /opt/skyrim-data has no STRINGS tables (no
"Skyrim - Interface.bsa"), so localized FULL names come out empty here: regions.json's recipe "name" falls back
to the editor id. Compare two runs made here (old plugin, new plugin) to see what a plugin changes."""
import os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(1, os.path.join(HERE, '..', '..', 'tooling', 'ck-mcp'))   # core, esplib, bsastrings
import core, esplib  # noqa: E402

DATA = os.environ.get('DBO_DATA') or '/opt/skyrim-data'
ORDER = os.environ.get('DBO_ORDER') or os.path.expanduser('~nate/dragonbreak/fork/deploy/skyrim-data/loadorder.txt')
SERVER = os.path.abspath(os.environ.get('DBO_SERVER') or os.path.join(HERE, '..', '..'))
REPLACE = {k.strip().lower(): v.strip() for k, v in
           (r.split('=', 1) for r in (os.environ.get('DBO_REPLACE') or '').split('|') if r.strip())}


def load_order():
    lo = core.LoadOrder(DATA, ORDER)
    if lo.missing_plugins:
        sys.exit('missing from %s: %s' % (DATA, lo.missing_plugins))
    for i, p in enumerate(lo.plugins):
        path = REPLACE.pop(p.key, None)
        if not path: continue
        q = esplib.Plugin(path)
        if q.esm != p.esm or q.masters != p.masters:
            sys.exit('%s: %s has other flags or masters than the plugin it replaces' % (p.name, path))
        q.name, q.key, q.load_index = p.name, p.key, p.load_index
        lo.plugins[i] = q; lo._by_key[q.key] = q
        print('replaced %s with %s' % (p.name, path), file=sys.stderr)
    if REPLACE:
        sys.exit('DBO_REPLACE names plugins not in the load order: %s' % list(REPLACE))
    return lo
