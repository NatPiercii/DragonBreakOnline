"""Builds server/depths.json, the floor pool for the endless Dwemer dive (depths.js).

One entry per interior cell of a Dwemer ruin (LocSetDwarvenRuin) or a Falmer hive (LocTypeFalmerHive), each cell being
one possible floor. Enemies and chests per cell already live in dungeons.json, so this adds what that file lacks: every
load door in the cell (exits, with where each one leads) and every spot a player lands in the cell (arrivals, the XTEL
position of the doors that lead into it). A door's XTEL names the destination door and the position the player appears
at beside it, in the destination cell.

Runs on the dev server (plugins in /opt/skyrim-data) or on the PC (the dev Data folder), with the ck-mcp parser:
    python3 tools/depths_build.py [--data DIR] [--order FILE] [--ck-mcp DIR]
Takes about ten seconds; run it with nice on the live box."""
import sys, os, json, struct, argparse, collections, re

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.dirname(HERE)
ROOT = os.path.dirname(SERVER)
ap = argparse.ArgumentParser()
ap.add_argument('--data', default='/opt/skyrim-data' if os.path.isdir('/opt/skyrim-data') else os.path.join(ROOT, 'Skyrim Special Edition - dev', 'Data'))
ap.add_argument('--order', default=os.path.join(SERVER, 'plugins.server.txt'))
ap.add_argument('--ck-mcp', dest='ckmcp', default=os.path.join(ROOT, 'ck-mcp'))
ap.add_argument('--out', default=os.path.join(SERVER, 'depths.json'))
args = ap.parse_args()
sys.path.insert(0, args.ckmcp)
import core

DISABLED, DELETED = 0x800, 0x20
lo = core.LoadOrder(args.data, args.order)
if lo.missing_plugins: print("missing plugins:", lo.missing_plugins)

def desc(canon):
    src, loc = canon.rsplit(':', 1)
    return "%x:%s" % (int(loc, 16), src)
def canon_of_desc(d):
    loc, src = d.split(':', 1)
    return "%s:%06X" % (src, int(loc, 16))
def xtel(sub):
    x = sub.get(b'XTEL', b'')
    if len(x) < 28: return None
    v = struct.unpack('<6f', x[4:28])
    return {"target": struct.unpack('<I', x[:4])[0], "pos": [round(q, 2) for q in v[:3]], "rot": [round(q, 4) for q in v[3:]]}

# --- pass 1: every load door (a REFR with XTEL), winning version; DOOR base editor ids for naming ---
doors, door_edid = {}, {}
for p in lo.plugins:
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ('REFR', 'DOOR')):
        c = lo.canon(p, fid)
        if t == 'DOOR':
            door_edid[c] = core.esplib.edid_of(lo.body(p, off, sz, fl)) or ''
            continue
        sub = lo.subrecords(p, off, sz, fl)
        x = xtel(sub)
        if not x:
            doors.pop(c, None)  # an override that dropped XTEL is no longer a load door
            continue
        w, cell, g = ctx
        f = lo.ref_fields(p, off, sz, fl)
        doors[c] = {"cell": lo.canon(p, cell) if cell else None, "world": lo.canon(p, w) if w else None, "base": f["base"], "pos": f["pos"], "rot": f["rot"],
                    "target": lo.canon(p, x["target"]), "land": {"pos": x["pos"], "rot": x["rot"]}, "disabled": bool(fl & DISABLED), "deleted": bool(fl & DELETED)}
doors = {c: d for c, d in doors.items() if not d["deleted"]}

# --- pass 2: where one-way targets stand (a target with no XTEL of its own is not in doors) ---
missing = {d["target"] for d in doors.values()} - set(doors)
spots = {}
for p in lo.plugins:
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ('REFR',)):
        c = lo.canon(p, fid)
        if c not in missing: continue
        w, cell, g = ctx
        spots[c] = {"cell": lo.canon(p, cell) if cell else None, "world": lo.canon(p, w) if w else None}
def where(ref):
    d = doors.get(ref) or spots.get(ref)
    return (d["cell"], d["world"]) if d else (None, None)

# --- the pool, from dungeons.json ---
DUNGEONS = json.load(open(os.path.join(SERVER, 'dungeons.json')))['dungeons']
def kind_of(d):
    if 'LocTypeFalmerHive' in d['keywords']: return 'falmer'
    if d['type'] == 'dwemer': return 'dwemer'
    return None
pool = [d for d in DUNGEONS if kind_of(d)]
cell_dungeon = {}
for d in DUNGEONS:
    for c in d['cells']: cell_dungeon[canon_of_desc(c['desc'])] = d['id']
cell_to_doors = collections.defaultdict(list)
arrivals = collections.defaultdict(list)
for ref, d in doors.items():
    if d["cell"]: cell_to_doors[d["cell"]].append(ref)
    tcell, tworld = where(d["target"])
    if tcell and not d["disabled"]: arrivals[tcell].append((ref, d))

FALMER = re.compile(r'falmer|chaurus', re.I)
DWEMER = re.compile(r'dwarven|dwemer|centurion|sphere|spider|DweAutomaton', re.I)
out, skipped = [], collections.Counter()
for d in pool:
    own = {canon_of_desc(c['desc']) for c in d['cells']}
    for c in d['cells']:
        cc = canon_of_desc(c['desc'])
        exits = []
        for ref in cell_to_doors.get(cc, []):
            dr = doors[ref]
            tcell, tworld = where(dr["target"])
            # inner: another cell of this dungeon; outside: an exterior worldspace; other: an interior elsewhere
            to = 'outside' if tworld else ('inner' if tcell in own else ('other' if tcell else 'unknown'))
            exits.append({"ref": desc(ref), "base": door_edid.get(dr["base"], ''), "pos": dr["pos"], "rot": dr["rot"], "to": to,
                          "toCell": desc(tcell) if tcell else None, "toDungeon": cell_dungeon.get(tcell), "disabled": dr["disabled"]})
        lands = []
        seen = set()
        for ref, dr in arrivals.get(cc, []):
            if dr["target"] in seen: continue
            seen.add(dr["target"])
            fcell, fworld = dr["cell"], dr["world"]
            lands.append({"door": desc(dr["target"]), "pos": dr["land"]["pos"], "rot": dr["land"]["rot"],
                          "from": 'outside' if fworld else ('inner' if fcell in own else 'other')})
        zones = [z for z in d['zones'] if z['cell'] == c['desc']]
        chests = [ch for ch in d['chests'] if ch['cell'] == c['desc']]
        npcs = [n['edid'] for z in zones for n in z['npcs']]
        fal, dwe = sum(1 for n in npcs if FALMER.search(n)), sum(1 for n in npcs if DWEMER.search(n))
        # A floor's kind follows its own enemies, not its dungeon: Mzinchaleft is a Dwemer ruin whose second level is all
        # Falmer. "strays" are the rest (bandits, skeevers, the Afflicted, quest characters) for depths.js to leave out.
        kind = 'falmer' if fal > dwe else ('dwemer' if dwe else kind_of(d))
        strays = sorted({n for n in npcs if not FALMER.search(n) and not DWEMER.search(n)})
        entry = {"cell": c['desc'], "edid": c['edid'], "name": c['name'], "dungeon": d['id'], "dungeonName": d['name'], "set": kind_of(d), "kind": kind,
                 "enemies": {"placements": len(npcs), "falmer": fal, "dwemer": dwe, "other": len(npcs) - fal - dwe}, "strays": strays,
                 "zones": len(zones), "chests": len(chests), "bigChests": sum(1 for ch in chests if ch.get('big')),
                 "arrivals": lands, "exits": exits}
        usable_exits = [e for e in exits if not e['disabled']]
        reasons = []
        if not lands: reasons.append('no arrival spot')
        if not usable_exits: reasons.append('no usable exit door')
        if not fal + dwe: reasons.append('no Falmer or Dwemer enemies')
        entry["usable"] = not reasons
        if reasons: entry["why"] = reasons; skipped.update(reasons)
        out.append(entry)

json.dump({"_comment": "Generated by server/tools/depths_build.py from the load order. The floor pool for depths.js: one entry per interior cell of a Dwemer ruin or Falmer hive, with its load doors (exits: where each leads, and whether the plugins start it disabled) and its landing spots (arrivals: XTEL positions of the doors leading in). Enemies and chests come from dungeons.json by cell.",
           "cells": out}, open(args.out, 'w'), indent=1)
use = [e for e in out if e['usable']]
print("pool dungeons", len(pool), "cells", len(out), "usable", len(use), "by kind", dict(collections.Counter(e['kind'] for e in use)), "skipped", dict(skipped))
print("load doors indexed", len(doors), "one-way targets located", len(spots), "of", len(missing))
