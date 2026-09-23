"""Builds server\\wildlife.json: every vanilla creature placement in the Tamriel and Solstheim
exteriors (wolves, deer, bears, sabre cats, giants, mammoths, trolls, horkers, ...), each leveled
actor resolved to a concrete NPC_, with the nearest server-loaded ref in the same cell as its
spawn anchor. Also the giant camps (LocTypeGiantCamp) with their chests, for the open-dungeon
loot nodes. gamemode.js turns this into permanent wild:* zones for NpcSpawnSystem."""
import sys, json, struct, math, collections, re
sys.path.insert(0, r"E:\DragonBreak Online Dev files\ck-mcp")
import core, esplib
lo = core.LoadOrder(r"E:\DragonBreak Online Dev files\Skyrim Special Edition - dev\Data", r"E:\DragonBreak Online Dev files\server\plugins.server.txt")
WORLDS = {"Skyrim.esm:00003C": "3c:Skyrim.esm", "Dragonborn.esm:000800": "800:Dragonborn.esm", "BSHeartland.esm:0A764B": "a764b:BSHeartland.esm",
          "BSHeartland.esm:06ADE1": "6ade1:BSHeartland.esm", "BSHeartland.esm:07F126": "7f126:BSHeartland.esm", "BSHeartland.esm:0B95A6": "b95a6:BSHeartland.esm"}
CREATURE = re.compile(r"^(?:CYR|BSK|BS|DLC1|DLC2)?(?:Enc|Lvl)?(Wolf|IceWolf|Deer|Elk|Bear|CaveBear|SnowBear|SabreCat|Skeever|Mudcrab|Horker|Giant|Mammoth|Troll|FrostTroll|Fox|Hare|Goat|Slaughterfish|Spider|FrostbiteSpider|Chaurus|Chicken|Cow|Dog|Netch|Riekling|Bristleback|Ashhopper|Lurker|Werebear)", re.I)
BAD = ("corpse", "dead", "dummy", "marker", "unique", "quest", "companion", "follower", "pet", "child", "summon", "test", "vampire", "werewolf", "ghost", "spirit", "dragon", "dwarven", "draugr", "falmer", "bandit", "forsworn", "skeleton", "hagraven", "spriggan", "wisp", "atronach", "daedra", "ash", "mage", "necro", "warlock", "cultist", "thalmor", "guard", "soldier", "farmer")
OK_TYPES = {"FURN", "ACTI", "DOOR", "CONT", "WEAP", "ARMO", "MISC", "INGR", "ALCH", "BOOK", "AMMO", "KEYM", "SLGM", "SCRL", "LIGH"}
def edid(p, off, sz, fl): return esplib.edid_of(lo.body(p, off, sz, fl)) or ""
def desc(canon): src, loc = canon.rsplit(":", 1); return "%x:%s" % (int(loc, 16), src)
lvln, npcs, kywd, lctn = {}, {}, {}, {}
for p in lo.plugins:
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ("LVLN", "NPC_", "KYWD", "LCTN")):
        c = lo.canon(p, fid)
        if t == "KYWD": kywd[c] = edid(p, off, sz, fl); continue
        sub = lo.subrecords(p, off, sz, fl)
        if t == "LVLN":
            entries = []
            for s, v in esplib.subrecords(lo.body(p, off, sz, fl)):
                if s == b"LVLO" and len(v) >= 8:
                    lvl, _, ref = struct.unpack("<HHI", bytes(v[:8])); entries.append((lvl, lo.canon(p, ref)))
            lvln[c] = entries
        elif t == "NPC_":
            # ACBS: flags uint32 @0, magicka and stamina offsets int16 @4/@6, level uint16 @8 (a multiplier with PC Level Mult 0x80)
            acbs = sub.get(b"ACBS", b""); flags = struct.unpack("<I", acbs[:4])[0] if len(acbs) >= 4 else 0
            lvl = struct.unpack("<H", acbs[8:10])[0] if len(acbs) >= 10 else 1
            tplt = sub.get(b"TPLT", b"")
            npcs[c] = {"edid": edid(p, off, sz, fl), "level": lvl, "pcMult": bool(flags & 0x80), "tplt": lo.canon(p, struct.unpack("<I", tplt[:4])[0]) if len(tplt) >= 4 else None}
        else:
            kw = sub.get(b"KWDA", b"")
            lctn[c] = {"edid": edid(p, off, sz, fl), "keywords": [kywd.get(lo.canon(p, struct.unpack_from("<I", kw, i)[0]), "?") for i in range(0, len(kw) - 3, 4)]}
def resolve(canon, depth=0):
    if depth > 6: return []
    if canon in npcs:
        n = npcs[canon]
        if any(w in n["edid"].lower() for w in BAD): return []
        if n["tplt"] and n["tplt"] in lvln: return resolve(n["tplt"], depth + 1)
        if n["tplt"] and n["tplt"] in npcs and n["tplt"] != canon:
            deeper = resolve(n["tplt"], depth + 1)
            if len(deeper) > 1: return deeper
        return [(0 if n["pcMult"] else n["level"], canon)]
    out = []
    for lvl, ref in lvln.get(canon, []):
        for l2, c2 in resolve(ref, depth + 1): out.append((lvl if ref in npcs else max(lvl, l2), c2))
    best = {}
    for lvl, c2 in out:
        if c2 not in best or lvl < best[c2]: best[c2] = lvl
    return sorted((lvl, c2) for c2, lvl in best.items())
def kind_of(canon, depth=0):
    if depth > 6: return None
    n = npcs.get(canon)
    if n:
        if any(w in n["edid"].lower() for w in BAD): return None
        m = CREATURE.match(n["edid"])
        if m: return m.group(1).lower()
        # "LvlPredator", "LvlAnimal" template actors: the kind lives in the leveled list they draw from
        if n["tplt"]: return kind_of(n["tplt"], depth + 1)
        return None
    for lvl, ref in lvln.get(canon, [])[:8]:
        k = kind_of(ref, depth + 1)
        if k: return k
    return None
# exterior cells: XLCN -> location keywords (giant camps)
cell_loc = {}
for p in lo.plugins:
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ("CELL",)):
        sub = lo.subrecords(p, off, sz, fl); x = sub.get(b"XLCN", b"")
        if len(x) >= 4: cell_loc[lo.canon(p, fid)] = lo.canon(p, struct.unpack("<I", x[:4])[0])
placements = []   # (world, cell, refCanon, pos, baseCanon)
cands = collections.defaultdict(dict)
world_cands = collections.defaultdict(lambda: collections.defaultdict(list))   # world -> grid bucket -> [(key, pos)]
GRID = 8192
# Vanilla creature ACHRs disabled in DragonBreak Online Edits.esp because the server spawns them instead
# (they hang logins client-side). They still count as placements here, or a rerun would drop them.
SERVER_REPLACED = set(json.load(open(r"E:\DragonBreak Online Dev files\ck-mcp\wildlife_server_replaced.json"))["refs"])
seen = {}
# Enable parents decide which placements exist when the game starts (as in dungeons_survey.py). DragonBreak's plugins
# disable the creatures the server spawns and strip their enable parents, so flags and XESP come from the last
# version before those plugins (or the plugin that placed the ref).
CURATION = {"DragonBreak.esp", "DragonBreak Online Edits.esp"}
enable = {}   # ref -> (record flags, enable parent, set opposite of parent)
def note_enable(p, fid, fl, sub):
    key = lo.canon(p, fid)
    if p.name in CURATION and key in enable: return
    # XESP: parent formid uint32, flags uint32 (0x1 = enable state opposite of parent; the high bits can be junk)
    x = sub.get(b"XESP", b"")
    parent = lo.canon(p, struct.unpack("<I", x[:4])[0]) if len(x) >= 4 else None
    enable[key] = (fl, parent, len(x) >= 8 and bool(struct.unpack("<I", x[4:8])[0] & 1))
for p in lo.plugins:
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ("ACHR", "REFR")):
        w, c, g = ctx
        if not w or not c: continue
        wc = lo.canon(p, w)
        if wc not in WORLDS: continue
        key = lo.canon(p, fid)
        f = lo.ref_fields(p, off, sz, fl)
        seen[key] = (t, wc, lo.canon(p, c), f, fl)
        if t == "ACHR": note_enable(p, fid, fl, lo.subrecords(p, off, sz, fl))
# the parents (and their parents) can sit anywhere in the load order
todo = {e[1] for e in enable.values() if e[1]} - set(enable)
while todo:
    for p in lo.plugins:
        for ri, t, fid, fl, off, sz, ctx in lo.records(p, ("ACHR", "REFR")):
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
left_out = collections.Counter()
for key, (t, wc, cc, f, fl) in seen.items():
    if fl & 0x20 or not f["base"] or not f["pos"]: continue
    if fl & 0x800 and not (t == "ACHR" and key in SERVER_REPLACED): continue
    if t == "ACHR":
        if fl & 0x200:  # Starts Dead: a carcass, not a living creature
            left_out["starts dead"] += 1; continue
        e = enable.get(key)
        if e and e[1] and enabled_at_start(e[1]) == e[2]:  # disabled at game start by its enable parent
            left_out["enable parent off at start"] += 1; continue
        placements.append((wc, cc, key, f["pos"], f["base"]))
    else:
        bi = lo.base_info(f["base"])
        if bi and bi["type"] in OK_TYPES:
            cands[cc][key] = f["pos"]
            world_cands[wc][(int(f["pos"][0] // GRID), int(f["pos"][1] // GRID))].append((key, f["pos"]))
        if bi and bi["type"] == "CONT": cands[("CONT", cc)] = cands.get(("CONT", cc), {}); cands[("CONT", cc)][key] = (f["pos"], bi["editor_id"])
def nearest_in_world(wc, pos, max_ring=6):
    # PlaceAtMe only needs a loadable self ref in the same worldspace: the actor is moved to its spot and
    # checked against the world right after, so an anchor in a neighbouring cell works as well
    gx, gy = int(pos[0] // GRID), int(pos[1] // GRID); best = None
    for ring in range(max_ring + 1):
        for dx in range(-ring, ring + 1):
            for dy in range(-ring, ring + 1):
                if max(abs(dx), abs(dy)) != ring: continue
                for k2, p2 in world_cands[wc].get((gx + dx, gy + dy), ()):
                    dd = math.dist(p2, pos)
                    if best is None or dd < best[1]: best = (k2, dd)
        if best and best[1] <= ring * GRID: break
    return best
out = []; kinds = collections.Counter(); skipped = collections.Counter()
for wc, cc, key, pos, base in placements:
    kind = kind_of(base)
    if not kind: continue
    opts = resolve(base)
    if not opts: skipped["no concrete npc"] += 1; continue
    best = None
    for k2, p2 in cands.get(cc, {}).items():
        dd = math.dist(p2, pos)
        if best is None or dd < best[1]: best = (k2, dd)
    if not best or best[1] > 2500:
        best = nearest_in_world(wc, pos)
        if not best: skipped["no anchor in world"] += 1; continue
        skipped["anchored outside own cell"] += 1
    kinds[kind] += 1
    out.append({"kind": kind, "edid": npcs.get(base, {}).get("edid") or kind, "world": WORLDS[wc], "cell": desc(cc), "pos": pos, "src": desc(key), "ref": desc(best[0]), "anchorDist": round(best[1]), "options": [[lvl, desc(cn)] for lvl, cn in opts]})
camps = []
for cc, loc in cell_loc.items():
    L = lctn.get(loc)
    if not L or "LocTypeGiantCamp" not in L["keywords"]: continue
    chests = [{"ref": desc(k), "edid": e, "pos": p} for k, (p, e) in cands.get(("CONT", cc), {}).items() if "chest" in e.lower()]
    if chests: camps.append({"id": L["edid"], "name": re.sub(r"([a-z])([A-Z])", r"\1 \2", re.sub(r"Location$", "", L["edid"])), "cell": desc(cc), "chests": chests})
json.dump({"_comment": "Generated by ck-mcp/wildlife.py: exterior creature placements (Tamriel, Solstheim, Bruma worlds) with concrete NPC options and a server-loadable anchor ref; giant camps with their chests. gamemode.js writes wild:* spawn zones from this and treats camp chests as per-player loot nodes.", "placements": out, "giantCamps": camps},
          open(sys.argv[1] if len(sys.argv) > 1 else r"E:\DragonBreak Online Dev files\server\wildlife.json", "w"), indent=0)
print("wildlife placements", len(out), "skipped/fallback", dict(skipped), dict(kinds.most_common(30)))
print("actors left out (all ACHRs, creature or not):", dict(left_out))
print("per world", dict(collections.Counter(o["world"] for o in out)))
print("giant camps", len(camps), [c["name"] for c in camps][:12])
