"""Builds server\\dungeons.json from the load order: every LocTypeDungeon location with its
interior cells, the exterior entrance doors (via XTEL from the interior doors), the containers
(loot chests) and the vanilla enemy placements, each leveled actor resolved to its concrete
NPC_ options by level so the gamemode can pick a difficulty band. Reads the survey json."""
import sys, json, struct, collections, math
sys.path.insert(0, r"E:\DragonBreak Online Dev files\ck-mcp")
import core, esplib
S = r"E:\DragonBreak Online Dev files\ck-mcp\out"
lo = core.LoadOrder(r"E:\DragonBreak Online Dev files\Skyrim Special Edition - dev\Data", r"E:\DragonBreak Online Dev files\server\plugins.server.txt")
survey = json.load(open(S + r"\dungeons_survey.json"))
def edid(p, off, sz, fl): return esplib.edid_of(lo.body(p, off, sz, fl)) or ""
import re
def humanize(e):
    e = re.sub(r'(Location|Exterior|Interior|Zone)$', '', e or '')
    e = re.sub(r'^(DLC1|DLC2|DLC01|DLC02|CYR|BSK)', '', e)
    e = re.sub(r'(\d+)$', r' \1', e)
    e = re.sub(r'([a-z])([A-Z])', r'\1 \2', e)
    e = re.sub(r'([A-Z]+)([A-Z][a-z])', r'\1 \2', e)
    return e.strip() or 'Unknown'
def desc(canon):
    src, loc = canon.rsplit(':', 1)
    return "%x:%s" % (int(loc, 16), src)

# --- leveled actor lists and NPC bases (winning versions) ---
lvln, npcs, races = {}, {}, {}
for p in lo.plugins:
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ('LVLN', 'NPC_', 'RACE')):
        c = lo.canon(p, fid)
        if t == 'RACE':
            races[c] = edid(p, off, sz, fl); continue
        sub = lo.subrecords(p, off, sz, fl)
        if t == 'LVLN':
            body = lo.body(p, off, sz, fl)
            entries = []
            for s, v in esplib.subrecords(body):
                if s == b'LVLO' and len(v) >= 8:
                    lvl, _, ref = struct.unpack('<HHI', bytes(v[:8]))
                    cnt = struct.unpack('<H', bytes(v[8:10]))[0] if len(v) >= 10 else 1
                    entries.append((lvl, lo.canon(p, ref), max(1, cnt)))
            lvln[c] = entries
        else:
            acbs = sub.get(b'ACBS', b'')
            # ACBS: flags uint32 @0, magicka and stamina offsets int16 @4/@6, level uint16 @8 (a multiplier with PC Level Mult 0x80)
            flags = struct.unpack('<I', acbs[:4])[0] if len(acbs) >= 4 else 0
            lvl = struct.unpack('<H', acbs[8:10])[0] if len(acbs) >= 10 else 1
            tplt = sub.get(b'TPLT', b'')
            rnam = sub.get(b'RNAM', b'')
            npcs[c] = {"edid": edid(p, off, sz, fl), "level": lvl, "pcMult": bool(flags & 0x80), "tplt": lo.canon(p, struct.unpack('<I', tplt[:4])[0]) if len(tplt) >= 4 else None,
                       "race": lo.canon(p, struct.unpack('<I', rnam[:4])[0]) if len(rnam) >= 4 else None}

# Actors that are not enemies. 'Undead' is an enemy type (the Ayleid ruins' CYRLvlAyleidUndead*), so that word is
# taken out of the editor id before 'dead' is looked for; dunDeadMensRespite* and the Treas corpses still match.
UNDEAD = re.compile(r'Undead|undead|UNDEAD')
SKIP = ('corpse', 'dead', 'dummy', 'marker', 'rigid', 'testnpc', 'victim', 'prisoner', 'captive', 'sleeping')
def is_skip(edid):
    e = UNDEAD.sub('', edid).lower()
    return any(w in e for w in SKIP)
# Dragons are never spawned: they fly, and nothing in this server has ever hosted one (user decision, 2026-09-19,
# after dunLabyrinthianUndeadDragon turned up once the Undead fix let it resolve). Told apart by RACE, because the
# editor id would also catch dragon priests, who are a race of their own (DragonPriestRace) and stay.
DRAGON_RACE = re.compile(r'dragon(?!priest)', re.I)
def is_dragon(n):
    return bool(DRAGON_RACE.search(races.get(n["race"], "") or ""))
def resolve(canon, depth=0):
    """concrete NPC_ options as [(level, canon)] for a placement base"""
    if depth > 6: return []
    if canon in npcs:
        n = npcs[canon]
        if is_skip(n["edid"]) or is_dragon(n): return []
        # "Lvl*" template actors take their stats from a leveled list at spawn time; the list's
        # entries are the concrete options a difficulty can choose between.
        if n["tplt"] and n["tplt"] in lvln: return resolve(n["tplt"], depth + 1)
        if n["tplt"] and n["tplt"] in npcs and n["tplt"] != canon:
            deeper = resolve(n["tplt"], depth + 1)
            if len(deeper) > 1: return deeper
        return [(n["level"] if not n["pcMult"] else 0, canon)]
    out = []
    for lvl, ref, cnt in lvln.get(canon, []):
        for l2, c2 in resolve(ref, depth + 1):
            out.append((lvl if ref in npcs else max(lvl, l2), c2))
    # unique by canon, keep the lowest level seen
    best = {}
    for lvl, c2 in out:
        if c2 not in best or lvl < best[c2]: best[c2] = lvl
    return sorted((lvl, c2) for c2, lvl in best.items())

# --- interior doors' XTEL targets -> exterior entrance refs ---
wanted = {}
for e in survey:
    for c in e["cells"]:
        for d in c["doors"]:
            wanted[d["ref"]] = e["edid"]
targets = {}   # interior door canon -> target canon
exitTo = {}    # interior door canon -> arrival pos/rot outside (its own XTEL marker)
for p in lo.plugins:
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ('REFR',)):
        c = lo.canon(p, fid)
        if c not in wanted: continue
        sub = lo.subrecords(p, off, sz, fl)
        x = sub.get(b'XTEL', b'')
        if len(x) >= 4: targets[c] = lo.canon(p, struct.unpack('<I', x[:4])[0])
        if len(x) >= 28:
            v = struct.unpack('<6f', x[4:28]); exitTo[c] = {"pos": [round(q, 2) for q in v[:3]], "rot": [round(q, 4) for q in v[3:]]}
target_set = set(targets.values())
placed = {}   # target canon -> {world, cell, pos, rot, arrive}
for p in lo.plugins:
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ('REFR',)):
        c = lo.canon(p, fid)
        if c not in target_set: continue
        w, cell, g = ctx
        f = lo.ref_fields(p, off, sz, fl)
        sub = lo.subrecords(p, off, sz, fl)
        x = sub.get(b'XTEL', b'')
        arrive = None
        if len(x) >= 28:
            v = struct.unpack('<6f', x[4:28]); arrive = {"pos": [round(q, 2) for q in v[:3]], "rot": [round(q, 4) for q in v[3:]]}
        placed[c] = {"world": lo.canon(p, w) if w else None, "cell": lo.canon(p, cell) if cell else None, "pos": f["pos"], "rot": f["rot"], "arrive": arrive}

dungeon_cells = {c["cell"] for e in survey for c in e["cells"]}
# One-way load doors: an outside door that leads in while the inside door has no way back out
inbound = {}   # inside door canon -> the exterior door that targets it
for p in lo.plugins:
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ('REFR',)):
        w, cell, g = ctx
        if not w: continue
        sub = lo.subrecords(p, off, sz, fl)
        x = sub.get(b'XTEL', b'')
        if len(x) < 28: continue
        tgt = lo.canon(p, struct.unpack('<I', x[:4])[0])
        if tgt not in wanted or tgt in targets: continue
        f = lo.ref_fields(p, off, sz, fl)
        v = struct.unpack('<6f', x[4:28])
        inbound[tgt] = {"outside": lo.canon(p, fid), "world": lo.canon(p, w), "cell": lo.canon(p, cell) if cell else None, "pos": f["pos"], "rot": f["rot"],
                        "arrive": {"pos": [round(q, 2) for q in v[:3]], "rot": [round(q, 4) for q in v[3:]]}}
TYPE_BY_KEY = [("LocSetDwarvenRuin", "dwemer"), ("LocSetNordicRuin", "nordic"), ("LocSetCaveIce", "ice"), ("LocSetCave", "cave"), ("LocSetMilitaryFort", "fort"), ("LocSetMilitaryCamp", "camp")]
def dtype(keys):
    for k, v in TYPE_BY_KEY:
        if k in keys: return v
    return "cave"

def cluster(points, reach=900.0):
    """greedy clusters of placements within reach of a running centre"""
    groups = []
    for pt in points:
        for g in groups:
            cx, cy, cz = g["c"]
            if math.dist(pt["pos"], (cx, cy, cz)) <= reach and len(g["items"]) < 12:
                g["items"].append(pt)
                n = len(g["items"])
                g["c"] = [(cx * (n - 1) + pt["pos"][0]) / n, (cy * (n - 1) + pt["pos"][1]) / n, (cz * (n - 1) + pt["pos"][2]) / n]
                break
        else:
            groups.append({"c": list(pt["pos"]), "items": [pt]})
    return groups

out = []
stats = collections.Counter()
for e in survey:
    entrances = []
    for c in e["cells"]:
        for d in c["doors"]:
            tgt = targets.get(d["ref"])
            pl = placed.get(tgt) if tgt else None
            if not tgt and d["ref"] in inbound:
                ib = inbound[d["ref"]]
                if not ib["pos"]: continue
                entrances.append({"outside": ib["outside"], "outsideDesc": desc(ib["outside"]), "inside": d["ref"], "insideDesc": desc(d["ref"]), "world": desc(ib["world"]), "cell": desc(ib["cell"]) if ib["cell"] else None,
                                  "pos": ib["pos"], "rot": ib["rot"], "doorPos": ib["pos"], "insidePos": ib["arrive"]["pos"], "insideRot": ib["arrive"]["rot"], "insideCell": desc(c["cell"])})
                continue
            if not pl or not pl["pos"] or pl["cell"] in dungeon_cells: continue  # a door to another dungeon cell is not an entrance
            arrive = pl["arrive"] or {"pos": d["pos"], "rot": [0, 0, 0]}
            leave = exitTo.get(d["ref"]) or {"pos": pl["pos"], "rot": pl["rot"]}
            entrances.append({"outside": tgt, "outsideDesc": desc(tgt), "inside": d["ref"], "insideDesc": desc(d["ref"]), "world": desc(pl["world"]) if pl["world"] else None, "cell": desc(pl["cell"]) if pl["cell"] else None,
                              "pos": leave["pos"], "rot": leave["rot"], "doorPos": pl["pos"], "insidePos": arrive["pos"], "insideRot": arrive["rot"], "insideCell": desc(c["cell"])})
    cells, chests, zones = [], [], []
    for c in e["cells"]:
        cells.append({"desc": desc(c["cell"]), "edid": c["edid"], "name": humanize(c["edid"])})
        for ch in c["containers"]:
            if any(w in ch["edid"].lower() for w in ('barrel', 'sack', 'urn', 'bones', 'burial', 'satchel', 'knapsack', 'basket', 'chest') ) or True:
                chests.append({"ref": desc(ch["ref"]), "edid": ch["edid"], "cell": desc(c["cell"]), "pos": ch["pos"], "big": 'chest' in ch["edid"].lower() or 'boss' in ch["edid"].lower()})
        pts = []
        for n in c["npcs"]:
            opts = resolve(n["base"])
            if not opts or not n["pos"]: continue
            pts.append({"pos": n["pos"], "edid": n["edid"], "ref": desc(n["ref"]), "options": [[lvl, desc(cn)] for lvl, cn in opts]})
        for g in cluster(pts):
            radius = max((math.dist(it["pos"], g["c"]) for it in g["items"]), default=0)
            zones.append({"cell": desc(c["cell"]), "pos": [round(v, 1) for v in g["c"]], "size": round(radius + 1400), "npcs": [{"edid": it["edid"], "pos": [round(v, 1) for v in it["pos"]], "ref": it["ref"], "options": it["options"]} for it in g["items"]]})
    stats[dtype(e["keywords"])] += 1
    out.append({"id": e["edid"], "name": humanize(e["edid"]), "type": dtype(e["keywords"]), "keywords": e["keywords"], "cells": cells, "entrances": entrances, "chests": chests, "zones": zones})
out.sort(key=lambda d: d["name"])
json.dump({"_comment": "Generated by ck-mcp\\dungeons_build.py from the load order. One entry per LocTypeDungeon location: cells, exterior entrance doors (outside/inside pair), containers, and spawn zones built from the vanilla placements with each leveled actor resolved to concrete NPC_ options [level, desc]. Used by server\\dungeons.js.", "dungeons": out},
          open(r"E:\DragonBreak Online Dev files\server\dungeons.json", "w"), indent=0)
print("dungeons", len(out), dict(stats), "with entrances", sum(1 for d in out if d["entrances"]), "zones", sum(len(d["zones"]) for d in out), "chests", sum(len(d["chests"]) for d in out))
print("no entrance:", [d["id"] for d in out if not d["entrances"]][:20])
