"""Builds server/buildings.json, the map of whole buildings (Nate, 4 Oct: "survey everything and constitute what is a whole
building so we don't keep having this property issue").

A building is a set of interior cells joined by interior-to-interior load doors (XTEL), with at least one way in: a load door
in a worldspace whose XTEL lands in one of those cells. Each building lists its cells, its ways in (the door outside and its
far half inside), its inner load doors (both halves), its other doors (hinged, no XTEL) and its containers, every one as the
server's desc ("<local id>:<plugin>"), winning versions only, deleted references left out. The fork's housing system
(housingSystem.ts) reads it as the definition of a whole building, for a claim and for the place migration.

Odd cases are listed, not resolved:
  dungeon      a cell of the building is in dungeons.json (a lease, not a house)
  large        more than LARGE cells
  rooms        its ways in land in more than one cell: two buildings joined inside, or a house with a yard door into a room
  oneWay       a load door whose far half does not lead back to it
  noTarget     a load door whose XTEL names a reference no plugin places (or one that is deleted)
  disabled     a load door the plugins start disabled (left out of the links, listed with its building)
  noWayIn      interior cells joined by load doors that no door from a worldspace leads into (a count, and the first few)

Runs on the dev server (plugins in /opt/skyrim-data) or on the PC, with the ck-mcp parser:
    python3 tools/buildings_build.py [--data DIR] [--order FILE] [--ck-mcp DIR] [--out FILE] [--check]
--check builds it in memory and exits 1 if the file differs (the plugins changed since it was written).
Run it with nice on the live box; it reads every plugin once."""
import sys, os, json, struct, argparse, collections, hashlib

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.dirname(HERE)
ROOT = os.path.dirname(SERVER)
ap = argparse.ArgumentParser()
ap.add_argument('--data', default='/opt/skyrim-data' if os.path.isdir('/opt/skyrim-data') else os.path.join(ROOT, 'Skyrim Special Edition - dev', 'Data'))
ap.add_argument('--order', default=os.path.join(SERVER, 'plugins.server.txt'))
ap.add_argument('--ck-mcp', dest='ckmcp', default=os.path.join(ROOT, 'ck-mcp') if os.path.isdir(os.path.join(ROOT, 'ck-mcp')) else os.path.expanduser('~/dragonbreak/ck-mcp'))
ap.add_argument('--out', default=os.path.join(SERVER, 'buildings.json'))
ap.add_argument('--check', action='store_true')
args = ap.parse_args()
sys.path.insert(0, args.ckmcp)
import core

DISABLED, DELETED = 0x800, 0x20
LARGE = 8
BRUMA = 'BSHeartland.esm:0A764B'
lo = core.LoadOrder(args.data, args.order)
if lo.missing_plugins: print("missing plugins:", lo.missing_plugins)

def desc(canon):
    src, loc = canon.rsplit(':', 1)
    return "%x:%s" % (int(loc, 16), src)
def canon_of_desc(d):
    loc, src = d.split(':', 1)
    return "%s:%06X" % (src, int(loc, 16))

# --- bases: which forms are doors and containers ---
kind = {}
for p in lo.plugins:
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ('DOOR', 'CONT')):
        kind[lo.canon(p, fid)] = t
cell_edid = {}
for p in lo.plugins:
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ('CELL',)):
        e = core.esplib.edid_of(lo.body(p, off, sz, fl))
        if e: cell_edid[lo.canon(p, fid)] = e

# --- every door and container reference, winning version ---
refs = {}
for p in lo.plugins:
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ('REFR',)):
        sub = lo.subrecords(p, off, sz, fl)
        c = lo.canon(p, fid)
        base = lo.canon(p, struct.unpack('<I', sub[b'NAME'][:4])[0]) if len(sub.get(b'NAME', b'')) >= 4 else None
        k = kind.get(base)
        if not k:
            refs.pop(c, None)
            continue
        x = sub.get(b'XTEL', b'')
        w, cell, g = ctx
        refs[c] = {"kind": k, "cell": lo.canon(p, cell) if cell and not w else None, "world": lo.canon(p, w) if w else None,
                   "target": lo.canon(p, struct.unpack('<I', x[:4])[0]) if len(x) >= 4 else None,
                   "disabled": bool(fl & DISABLED), "deleted": bool(fl & DELETED)}
refs = {c: r for c, r in refs.items() if not r["deleted"]}
loads = {c: r for c, r in refs.items() if r["kind"] == 'DOOR' and r["target"]}

dungeon_cells = set()
try:
    for d in json.load(open(os.path.join(SERVER, 'dungeons.json')))['dungeons']:
        for cl in d['cells']: dungeon_cells.add(canon_of_desc(cl['desc']))
except Exception as e:
    print("dungeons.json unreadable, no dungeon flags:", e)

# --- odd doors, and the links between interiors ---
one_way, no_target = [], []
parent = {}
def find(a):
    while parent.setdefault(a, a) != a:
        parent[a] = parent[parent[a]]; a = parent[a]
    return a
def union(a, b): parent[find(a)] = find(b)
for c, r in loads.items():
    t = refs.get(r["target"])
    if not t:
        no_target.append(c); continue
    if t.get("target") != c: one_way.append(c)
    if r["cell"]: find(r["cell"])
    if r["disabled"] or t["disabled"]: continue
    if r["cell"] and t["cell"]: union(r["cell"], t["cell"])

# --- buildings: the components with a way in ---
by_comp = collections.defaultdict(lambda: {"cells": set(), "entrances": [], "inner": set(), "disabled": set(), "doors": [], "containers": []})
for cell in list(parent): by_comp[find(cell)]["cells"].add(cell)
for c, r in loads.items():
    t = refs.get(r["target"])
    if not t: continue
    if r["world"] and t["cell"] and not r["disabled"] and not t["disabled"]:
        by_comp[find(t["cell"])]["entrances"].append((c, r["target"], r["world"], t["cell"]))
    elif r["cell"]:
        b = by_comp[find(r["cell"])]
        (b["disabled"] if (r["disabled"] or t["disabled"]) else b["inner"]).add(c)
for c, r in refs.items():
    if not r["cell"] or r["cell"] not in parent: continue
    b = by_comp[find(r["cell"])]
    if r["kind"] == 'CONT': b["containers"].append(c)
    elif c not in loads: b["doors"].append(c)

buildings, no_way_in = [], []
for root, b in by_comp.items():
    if not b["entrances"]:
        no_way_in.append(sorted(b["cells"])[0]); continue
    ents = sorted(b["entrances"])
    cells = sorted(b["cells"], key=lambda x: (x != ents[0][3], x))
    flags = []
    if b["cells"] & dungeon_cells: flags.append('dungeon')
    if len(cells) > LARGE: flags.append('large')
    if len({e[3] for e in ents}) > 1: flags.append('rooms')
    odd = [d for d in sorted(b["inner"]) + [e[0] for e in ents] if d in one_way]
    if odd: flags.append('oneWay')
    if b["disabled"]: flags.append('disabled')
    buildings.append({
        "id": desc(ents[0][0]), "name": cell_edid.get(cells[0], ''), "world": desc(ents[0][2]),
        "cells": [desc(x) for x in cells],
        "entrances": [{"door": desc(e[0]), "inside": desc(e[1]), "cell": desc(e[3])} for e in ents],
        "innerDoors": sorted(desc(x) for x in b["inner"]),
        "doors": sorted(desc(x) for x in b["doors"]),
        "containers": sorted(desc(x) for x in b["containers"]),
        **({"disabledDoors": sorted(desc(x) for x in b["disabled"])} if b["disabled"] else {}),
        **({"flags": flags} if flags else {}),
    })
buildings.sort(key=lambda x: (x["world"] != desc(BRUMA), x["id"]))
order = open(args.order, 'rb').read() if os.path.isfile(args.order) else b''
out = {
    "_comment": "Generated by server/tools/buildings_build.py from the load order (--check tells whether it is current). A building is the interior cells joined by interior load doors that a door from a worldspace leads into; the fork's housing system takes it as a whole building. Flags: dungeon, large, rooms (ways in land in several cells), oneWay, disabled; odd lists the doors that lead nowhere or one way.",
    "loadOrderSha1": hashlib.sha1(order).hexdigest(),
    "counts": {"buildings": len(buildings), "bruma": sum(1 for x in buildings if x["world"] == desc(BRUMA)),
               "flagged": dict(collections.Counter(f for x in buildings for f in x.get("flags", []))), "noWayIn": len(no_way_in),
               "oneWay": len(one_way), "noTarget": len(no_target)},
    "buildings": buildings,
    "odd": {"noTarget": sorted(desc(x) for x in no_target), "oneWay": sorted(desc(x) for x in one_way), "noWayIn": sorted(desc(x) for x in no_way_in)[:200]},
}
text = json.dumps(out, indent=0, separators=(',', ':')) + "\n"
if args.check:
    try: same = open(args.out).read() == text
    except Exception: same = False
    print("buildings.json is", "current" if same else "OUT OF DATE: run tools/buildings_build.py")
    sys.exit(0 if same else 1)
open(args.out, 'w').write(text)
print(json.dumps(out["counts"]))
