"""Survey every dungeon location in the load order: its cells, location keywords, the vanilla
NPC placements (ACHR base editor IDs, positions), containers and locked refs. Output:
ck-mcp\\out\\dungeons_survey.json (intermediate data for the dungeon zone generator)."""
import sys, json, struct, collections
sys.path.insert(0, r"E:\DragonBreak Online Dev files\ck-mcp")
import core, esplib
lo = core.LoadOrder(r"E:\DragonBreak Online Dev files\Skyrim Special Edition - dev\Data", r"E:\DragonBreak Online Dev files\server\plugins.server.txt")
def edid(p, off, sz, fl): return esplib.edid_of(lo.body(p, off, sz, fl)) or ""
kywd = {}
for p in lo.plugins:
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ('KYWD',)):
        kywd[lo.canon(p, fid)] = edid(p, off, sz, fl)
# locations: winning override
lctn = {}
for p in lo.plugins:
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ('LCTN',)):
        sub = lo.subrecords(p, off, sz, fl)
        kw = sub.get(b'KWDA', b'')
        keys = [kywd.get(lo.canon(p, struct.unpack_from('<I', kw, i)[0]), '?') for i in range(0, len(kw) - 3, 4)]
        parent = sub.get(b'PNAM', b'')
        lctn[lo.canon(p, fid)] = {"edid": edid(p, off, sz, fl), "name": sub.get(b'FULL', b'').rstrip(b'\0').decode('cp1252', 'replace'), "keywords": keys, "parent": lo.canon(p, struct.unpack('<I', parent[:4])[0]) if len(parent) >= 4 else None, "cells": [], "from": p.name}
# NPC bases: edid, level, race/class? keep edid + level (ACBS level) + name
npcs = {}
for p in lo.plugins:
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ('NPC_',)):
        sub = lo.subrecords(p, off, sz, fl)
        acbs = sub.get(b'ACBS', b'')
        # ACBS: flags uint32 @0, magicka and stamina offsets int16 @4/@6, level uint16 @8 (a multiplier with PC Level Mult 0x80)
        flags = struct.unpack('<I', acbs[:4])[0] if len(acbs) >= 4 else 0
        lvl = struct.unpack('<H', acbs[8:10])[0] if len(acbs) >= 10 else 0
        npcs[lo.canon(p, fid)] = {"edid": edid(p, off, sz, fl), "name": sub.get(b'FULL', b'').rstrip(b'\0').decode('cp1252', 'replace'), "level": lvl, "pcLevelMult": bool(flags & 0x80)}
lvln = {}
for p in lo.plugins:
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ('LVLN',)):
        lvln[lo.canon(p, fid)] = edid(p, off, sz, fl)
# cells -> location (XLCN), interior flag
cells = {}
for p in lo.plugins:
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ('CELL',)):
        sub = lo.subrecords(p, off, sz, fl)
        c = lo.canon(p, fid)
        x = sub.get(b'XLCN', b'')
        loc = lo.canon(p, struct.unpack('<I', x[:4])[0]) if len(x) >= 4 else None
        interior = len(sub.get(b'XCLC', b'')) < 8
        prev = cells.get(c, {})
        cells[c] = {"edid": edid(p, off, sz, fl) or prev.get("edid", ""), "name": sub.get(b'FULL', b'').rstrip(b'\0').decode('cp1252', 'replace') or prev.get("name", ""), "loc": loc if loc else prev.get("loc"), "interior": interior}
for c, v in cells.items():
    if v["loc"] in lctn and v["interior"]:
        lctn[v["loc"]]["cells"].append(c)
DUNGEON_KEYS = {"LocTypeDungeon"}
dungeons = {k: v for k, v in lctn.items() if v["cells"] and any(x in DUNGEON_KEYS for x in v["keywords"])}

# Dungeons the plugins never tagged LocTypeDungeon (or never gave a location), named by their entrance cell.
# Every interior reached through their own load doors joins them, so deeper levels come along.
EXTRA_DUNGEON_CELLS = json.load(open(r"E:\DragonBreak Online Dev files\ck-mcp\dungeons_extra.json"))["cells"]
if EXTRA_DUNGEON_CELLS:
    cell_by_edid = {v["edid"]: c for c, v in cells.items() if v["interior"]}
    door_dest, door_cell = {}, {}
    for p in lo.plugins:
        for ri, t, fid, fl, off, sz, ctx in lo.records(p, ('REFR',)):
            w, c, g = ctx
            if w or not c: continue
            sub = lo.subrecords(p, off, sz, fl)
            x = sub.get(b'XTEL', b'')
            key = lo.canon(p, fid)
            door_cell[key] = lo.canon(p, c)
            if len(x) >= 4 and not fl & 0x20: door_dest[key] = lo.canon(p, struct.unpack('<I', x[:4])[0])
            else: door_dest.pop(key, None)
    doors_in = collections.defaultdict(list)
    for d, c in door_cell.items():
        if d in door_dest: doors_in[c].append(d)
    taken = {c for v in dungeons.values() for c in v["cells"]}
    for root_edid in EXTRA_DUNGEON_CELLS:
        root = cell_by_edid.get(root_edid)
        if not root or root in taken:
            print("extra dungeon skipped (missing or already a dungeon):", root_edid)
            continue
        group, todo = {root}, [root]
        while todo:
            c = todo.pop()
            for d in doors_in[c]:
                nxt = door_cell.get(door_dest[d])
                # a cell with its own door to the outside is a building of its own (a house cellar joining the caverns)
                opens_outside = any(door_dest[x] not in door_cell for x in doors_in.get(nxt, []))
                if nxt and nxt not in group and cells.get(nxt, {}).get("interior") and nxt not in taken and not opens_outside:
                    group.add(nxt); todo.append(nxt)
        loc = cells[root]["loc"]
        base = lctn.get(loc, {}) if loc else {}
        keys = list(base.get("keywords", []))
        if not any(k.startswith("LocSet") for k in keys):
            keys.append("LocSetMilitaryFort" if "Fort" in root_edid else "LocSetCave")
        dungeons["cell:" + root] = {"edid": base.get("edid") or (root_edid + "Location"), "name": base.get("name", ""), "keywords": keys + ["LocTypeDungeon"],
                                    "parent": base.get("parent"), "cells": sorted(group), "from": "dungeons_extra.json"}
        taken |= group
        print("extra dungeon", root_edid, "cells", [cells[c]["edid"] for c in sorted(group)])

# Actors disabled in DragonBreak Online Edits.esp because the server spawns them: still placements here
SERVER_REPLACED = set(json.load(open(r"E:\DragonBreak Online Dev files\ck-mcp\actors_server_replaced.json"))["refs"])
# refs per cell: ACHR (npc placements), CONT refs, locked refs (XLOC)
refs = collections.defaultdict(lambda: {"npcs": [], "containers": [], "locked": 0, "doors": []})
wanted_cells = {c for d in dungeons.values() for c in d["cells"]}
ref_seen = {}
# Enable parents decide which of a dungeon's placements exist when the game starts (bandits before a quest, others
# after). DragonBreak's plugins disable the actors the server spawns and strip their enable parents, so each ref's
# record flags and XESP are taken from the last version before those plugins (or the plugin that placed it).
CURATION = {"DragonBreak.esp", "DragonBreak Online Edits.esp"}
enable = {}   # ref -> (record flags, enable parent, set opposite of parent)
def note_enable(p, fid, fl, sub):
    key = lo.canon(p, fid)
    if p.name in CURATION and key in enable: return
    # XESP: parent formid uint32, flags uint32 (0x1 = enable state opposite of parent; the high bits can be junk)
    x = sub.get(b'XESP', b'')
    parent = lo.canon(p, struct.unpack('<I', x[:4])[0]) if len(x) >= 4 else None
    enable[key] = (fl, parent, len(x) >= 8 and bool(struct.unpack('<I', x[4:8])[0] & 1))
for p in lo.plugins:
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ('ACHR', 'REFR')):
        w, c, g = ctx
        if not c: continue
        cid = lo.canon(p, c)
        if cid not in wanted_cells: continue
        key = lo.canon(p, fid)
        f = lo.ref_fields(p, off, sz, fl)
        sub = lo.subrecords(p, off, sz, fl)
        ref_seen[key] = (t, cid, f, fl, b'XLOC' in sub, sub.get(b'XLOC', b''))
        if t == 'ACHR': note_enable(p, fid, fl, sub)
# the parents (and their parents) can sit anywhere in the load order
todo = {e[1] for e in enable.values() if e[1]} - set(enable)
while todo:
    for p in lo.plugins:
        for ri, t, fid, fl, off, sz, ctx in lo.records(p, ('ACHR', 'REFR')):
            if lo.canon(p, fid) in todo: note_enable(p, fid, fl, lo.subrecords(p, off, sz, fl))
    found = todo & set(enable)
    todo = {enable[k][1] for k in found if enable[k][1]} - set(enable)
def enabled_at_start(key, depth=0):
    """a parent's state when the game starts: through its own enable parent if it has one, else its own flag"""
    e = enable.get(key)
    if e is None: return True   # not a placed ref (the player) or missing: no opinion
    fl, parent, opposite = e
    if fl & 0x20: return False
    if parent and depth < 16: return enabled_at_start(parent, depth + 1) != opposite
    return not fl & 0x800
skipped = collections.Counter()
for key, (t, cid, f, fl, locked, xloc) in ref_seen.items():
    if fl & 0x20: continue  # deleted
    if fl & 0x800 and not (t == 'ACHR' and key in SERVER_REPLACED): continue  # initially disabled, unless the server took it over
    if t == 'ACHR':
        if fl & 0x200:  # Starts Dead: a corpse, not an enemy
            skipped["starts dead"] += 1; continue
        e = enable.get(key)
        if e and e[1] and enabled_at_start(e[1]) == e[2]:  # disabled at game start by its enable parent
            skipped["enable parent off at start"] += 1; continue
        b = npcs.get(f["base"])
        if b: refs[cid]["npcs"].append({"ref": key, "base": f["base"], "edid": b["edid"], "level": b["level"], "pos": f["pos"]})
        else: refs[cid]["npcs"].append({"ref": key, "base": f["base"], "edid": lvln.get(f["base"], "?"), "pos": f["pos"]})
    else:
        bi = lo.base_info(f["base"]) if f["base"] else None
        if bi and bi["type"] == 'CONT':
            refs[cid]["containers"].append({"ref": key, "edid": bi["editor_id"], "pos": f["pos"], "locked": locked, "lockLevel": xloc[0] if xloc else 0})
        elif bi and bi["type"] == 'DOOR':
            refs[cid]["doors"].append({"ref": key, "edid": bi["editor_id"], "pos": f["pos"], "locked": locked})
        if locked: refs[cid]["locked"] += 1
out = []
for k, d in dungeons.items():
    entry = {"loc": k, "edid": d["edid"], "name": d["name"], "keywords": d["keywords"], "parent": lctn.get(d["parent"], {}).get("edid"), "cells": []}
    for c in d["cells"]:
        r = refs.get(c, {"npcs": [], "containers": [], "locked": 0, "doors": []})
        entry["cells"].append({"cell": c, "edid": cells[c]["edid"], "name": cells[c]["name"], "npcs": r["npcs"], "containers": r["containers"], "doors": r["doors"]})
    out.append(entry)
out.sort(key=lambda e: e["edid"])
json.dump(out, open(r"E:\DragonBreak Online Dev files\ck-mcp\out\dungeons_survey.json", "w"), indent=0)
types = collections.Counter()
for e in out:
    for kw in e["keywords"]:
        if kw.startswith("LocSet"): types[kw] += 1
print("dungeons", len(out), "cells", sum(len(e["cells"]) for e in out), "npc placements", sum(len(c["npcs"]) for e in out for c in e["cells"]), "containers", sum(len(c["containers"]) for e in out for c in e["cells"]))
print("actors left out:", dict(skipped))
print(dict(types))
