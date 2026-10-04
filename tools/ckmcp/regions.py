"""Builds server\\regions.json: which province each place belongs to, where each spell tome is sold and where
each creation recipe may be crafted. Read by server\\regions.js (the craft gate and /region) and server\\spells.js
(the /tomes stock). Products are tagged by provinces.py, the classifier loot.py uses, so an item is made and
found in the same provinces; server\\regions-overrides.json holds the hand rules. Run from the dev files folder:
    py ck-mcp\\regions.py [output path, default server\\regions.json]"""
import sys, json, struct, re, collections
import os; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import linux_paths
from provinces import *
from bsastrings import Strings

SERVER = linux_paths.SERVER
STRINGS = Strings(linux_paths.DATA)
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(SERVER, "regions.json")
CORE_SPELLS = set(OVR.get('coreSpells') or [])
BENCHES = OVR.get('benches') or {}
def hand(table, *keys):
    t = {str(k).lower(): v for k, v in (OVR.get(table) or {}).items()}
    for k in keys:
        if k and str(k).lower() in t: return t[str(k).lower()]
    return None
def full(p, sub):
    v = bytes(sub.get(b'FULL', b''))
    if not v: return ""
    if p.hflags & 0x80:
        return (STRINGS.text(p.name, struct.unpack('<I', v)[0]) or "").strip() if len(v) == 4 else ""
    return v.rstrip(b'\0').decode('cp1252', 'replace').strip()

# ---- records ------------------------------------------------------------------------------------
ITEM_T = ('WEAP', 'ARMO', 'AMMO', 'MISC', 'ALCH', 'INGR', 'SLGM', 'BOOK', 'LIGH', 'SCRL', 'KEYM')
items, recipes = {}, {}
for p in lo.plugins:
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ITEM_T + ('COBJ',)):
        c = lo.canon(p, fid)
        if lo.winner(c) != p.name: continue
        sub = lo.subrecords(p, off, sz, fl)
        e = sub.get(b'EDID', b'').rstrip(b'\0').decode('cp1252', 'replace')
        if t == 'COBJ':
            if fl & 0x20: continue
            r = {"edid": e, "product": None, "bench": None, "inputs": []}
            if len(sub.get(b'CNAM', b'')) >= 4: r["product"] = lo.canon(p, struct.unpack('<I', sub[b'CNAM'][:4])[0])
            if len(sub.get(b'BNAM', b'')) >= 4: r["bench"] = lo.canon(p, struct.unpack('<I', sub[b'BNAM'][:4])[0])
            for sig, v in esplib.subrecords(lo.body(p, off, sz, fl)):
                if sig == b'CNTO' and len(v) >= 8: r["inputs"].append(lo.canon(p, struct.unpack('<I', bytes(v)[:4])[0]))
            recipes[c] = r
            continue
        kws = []
        k = sub.get(b'KWDA', b'')
        for i in range(0, len(k) - 3, 4): kws.append(kw_edid.get(lo.canon(p, struct.unpack_from('<I', k, i)[0]), ''))
        enit = sub.get(b'ENIT', b'')
        items[c] = {"t": t, "edid": e, "kws": kws, "name": full(p, sub),
                    "food": t == 'ALCH' and len(enit) >= 8 and bool(struct.unpack('<I', enit[4:8])[0] & 0x2)}
kw_name = lambda c: kw_edid.get(c) or ""

# ---- recipes ------------------------------------------------------------------------------------
TEMPER = {'CraftingSmithingArmorTable', 'CraftingSmithingSharpeningWheel'}
COOKING = {'CraftingCookpot', 'BYOHCraftingOven', 'Camping_CampfireCookingShared', 'CYRproxy_HF_BYOHCraftingOven', 'isGrainMill'}
GEAR = ('WEAP', 'ARMO', 'AMMO')
def kind(r):
    b = kw_name(r["bench"]) if r["bench"] else ""
    if not b: return 'nobench'
    if b in TEMPER: return 'temper'
    if b.startswith('BYOHBuilding'): return 'building'
    if b == 'CraftingSmelter' and any((items.get(i) or {}).get("t") in GEAR for i in r["inputs"]): return 'breakdown'
    return 'create'
def food_provinces(e, src):
    pc = PLUGIN_CULTURE.get(src.lower())
    if pc: return resolve(pc), pc, 'plugin'
    el = e.lower()
    if src.lower() in CYR_PLUGINS or any(el.startswith(w) for w in CYR_PREFIX): return ['cyrodiil'], 'cyrodiil', 'food'
    if src.lower() == 'dragonborn.esm' or 'dlc2' in el: return ['solstheim'], 'solstheim', 'food'
    return list(ALL), 'common', 'food'
def misc_provinces(c, e, src):
    pc = PLUGIN_CULTURE.get(src.lower())
    if pc: return resolve(pc), pc, 'plugin'
    m = marks(e.lower())
    if m: return m, m[0] if len(m) == 1 else 'nordic', 'mark'
    for k in sorted(CCO_CATS.get(c, ())):
        if k in CCO_CULTURE: return resolve(CCO_CULTURE[k]), CCO_CULTURE[k], 'cco'
    pr = provinces_material(e, src)
    return pr, tag_of(pr) if len(pr) != 1 else pr[0], 'material'
def product_provinces(c, bench):
    """(provinces, culture tag, why) of a crafted product, before the bench narrows it"""
    it = items.get(c) or {"t": None, "edid": "", "kws": [], "food": False}
    e, src = it["edid"], c.rsplit(':', 1)[0]
    o = item_override(e, c)
    if o is not None: return o, 'override', 'override'
    if it["t"] in GEAR: return item_provinces(c, e, it["kws"], src)
    if it["food"] or it["t"] == 'INGR' or bench in COOKING: return food_provinces(e, src)
    if it["t"] == 'MISC': return misc_provinces(c, e, src)
    return classify(e, it["kws"], src, c)
def narrow(pr, bench):
    b = resolve(BENCHES[bench]) if bench in BENCHES else None
    if b is None: return pr, False
    both = [x for x in pr if x in b]
    return (both or b), True

kinds = collections.Counter()
out_recipes, out_items = {}, {}
for c, r in recipes.items():
    k = kind(r)
    kinds[k] += 1
    if k != 'create' or not r["product"]: continue
    bench = kw_name(r["bench"])
    pr, tag, why = product_provinces(r["product"], bench)
    if why == 'origin':   # MCE names the culture only in the recipe: MCERecipeClothesDLC2DarkElfOutfit
        m, cw = marks(r["edid"].lower()), culture_word(r["edid"].lower())
        if m: pr, tag, why = m, m[0] if len(m) == 1 else 'nordic', 'recipe-mark'
        elif cw: pr, tag, why = resolve(cw), cw, 'recipe-culture'
    out_items[desc(r["product"])] = tag_of(pr)
    pr2, narrowed = narrow(pr, bench)
    ho = hand('recipes', r["edid"], desc(c))
    if ho is not None and resolve(ho) is not None: pr2, why, narrowed = resolve(ho), 'override', False
    it = items.get(r["product"]) or {}
    out_recipes[desc(c)] = {"edid": r["edid"], "item": desc(r["product"]), "name": it.get("name") or it.get("edid") or "",
                            "bench": bench, "p": tag_of(pr2), "c": tag, "why": why + ('+bench' if narrowed and pr2 != pr else '')}

# ---- spell tomes --------------------------------------------------------------------------------
TOMES = json.load(open(os.path.join(SERVER, "spell-tomes.json"), encoding='utf-8'))["tomes"]
EXCLUDED_TOME_PLUGINS = {'gray fox cowl.esm', 'surwr.esp'}
BS_CASTERS_MIN = 5
casters = collections.Counter()   # spell -> Beyond Skyrim NPCs (their own version) that cast it
_splo = {}
for p in lo.plugins:
    if p.key not in CYR_PLUGINS: continue
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ('NPC_',)):
        c = lo.canon(p, fid)
        if plugin_of(c) not in CYR_PLUGINS: continue
        _splo[c] = {lo.canon(p, struct.unpack('<I', bytes(v)[:4])[0]) for sig, v in esplib.subrecords(lo.body(p, off, sz, fl)) if sig == b'SPLO' and len(v) >= 4}
for spells in _splo.values():
    for s in spells: casters[s] += 1
def canon6(c): src, loc = c.rsplit(':', 1); return "%s:%06X" % (src, int(loc, 16))
def tome_provinces(t):
    bid, sid, src = canon6(t["id"]), canon6(t["spellId"]), t["id"].rsplit(':', 1)[0].lower()
    ho = hand('tomes', t["name"], desc(bid))
    if ho is not None and resolve(ho) is not None: return resolve(ho), 'override'
    if src in EXCLUDED_TOME_PLUGINS: return [], 'excluded-plugin'
    if src == 'skyrim.esm' and t["rank"] == 0 and t.get("spellName") in CORE_SPELLS: return list(ALL), 'core'
    if src in CYR_PLUGINS:
        if t["name"].lower().startswith('cyr'): return ['cyrodiil'], 'cyr-prefix'
        return ['cyrodiil'], 'bs-list' if bid in BS_LISTED else 'bs-placed' if bid in BS_PLACED else 'bs-undistributed'
    if src == 'dragonborn.esm': return ['solstheim'], 'dlc2'
    if src == 'dawnguard.esm': return ['skyrim'], 'dlc1'
    if src == 'skyrim.esm' and casters[sid] >= BS_CASTERS_MIN: return ['cyrodiil', 'skyrim'], 'bs-casters:%d' % casters[sid]
    pc = PLUGIN_CULTURE.get(src)
    if pc: return resolve(pc), 'plugin'
    return ['skyrim'], 'vanilla' if src == 'skyrim.esm' else 'origin'
out_tomes = {}
for t in TOMES:
    pr, why = tome_provinces(t)
    out_tomes[desc(canon6(t["id"]))] = {"p": tag_of(pr), "edid": t["name"], "spell": t.get("spellName") or t["spell"], "why": why}

# ---- places -------------------------------------------------------------------------------------
PLACE_PLUGINS = {'skyrim.esm': 'skyrim', 'update.esm': 'skyrim', 'dawnguard.esm': 'skyrim', 'hearthfires.esm': 'skyrim',
                 'dragonborn.esm': 'solstheim', 'bsheartland.esm': 'cyrodiil', 'bsassets.esm': 'cyrodiil'}
# Mods that are one land: Baan Malur's huts and Gray Fox Cowl's rooms whose doors lead nowhere a table knows
for _p in ('journey to baan malur.esp', 'journey to baan malur - dunmeth pass.esp', 'gray fox cowl.esm'):
    PLACE_PLUGINS[_p] = resolve(PLUGIN_CULTURE[_p])[0]
WORLD_RULES = [(re.compile(r'^VvardenfellWorld$', re.I), 'morrowind'), (re.compile(r'^mannyGF', re.I), 'hammerfell'),
               (re.compile(r'^(Sovngarde|DLC01SoulCairn)$', re.I), 'skyrim'), (re.compile(r'^DLC2ApocryphaWorld$', re.I), 'solstheim')]
def place_tag(culture):
    """one live province (or 'none') for a place"""
    pr = resolve(culture)
    return 'none' if not pr else pr[0]
worlds, cells_int = {}, {}
for p in lo.plugins:
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ('WRLD', 'CELL')):
        c = lo.canon(p, fid)
        if lo.winner(c) != p.name: continue
        sub = lo.subrecords(p, off, sz, fl)
        e = sub.get(b'EDID', b'').rstrip(b'\0').decode('cp1252', 'replace')
        if t == 'WRLD': worlds[c] = e
        elif len(sub.get(b'DATA', b'')) >= 1 and sub[b'DATA'][0] & 1 and not fl & 0x20: cells_int[c] = e
out_worlds = {}
for c, e in worlds.items():
    ho = hand('places', e, desc(c))
    if ho is not None: out_worlds[desc(c)] = {"p": place_tag(ho), "c": str(ho), "edid": e, "via": "override"}; continue
    rule = next((cul for rx, cul in WORLD_RULES if rx.search(e)), None)
    if rule: out_worlds[desc(c)] = {"p": place_tag(rule), "c": rule, "edid": e, "via": "edid"}; continue
    pl = PLACE_PLUGINS.get(plugin_of(c))
    out_worlds[desc(c)] = {"p": pl or 'skyrim', "c": pl or 'skyrim', "edid": e, "via": "plugin" if pl else "default"}
# Load doors: each ref's place, and the ref each door leads to (winning versions, enabled and not deleted)
where, leads = {}, {}
for p in lo.plugins:
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ('REFR',)):
        c = lo.canon(p, fid)
        w, cl, g = ctx
        where[c] = ('W', lo.canon(p, w)) if w else (('C', lo.canon(p, cl)) if cl else None)
        if fl & 0x820: leads.pop(c, None); continue
        x = lo.subrecords(p, off, sz, fl).get(b'XTEL', b'')
        if len(x) >= 4 and struct.unpack('<I', x[:4])[0]: leads[c] = lo.canon(p, struct.unpack('<I', x[:4])[0])
        else: leads.pop(c, None)
graph = collections.defaultdict(collections.Counter)
for door, target in leads.items():
    a, b = where.get(door), where.get(target)
    if a and b and a != b: graph[a][b] += 1
out_cells = {}
for c, e in cells_int.items():
    start = ('C', c)
    seen, frontier, found = {start}, [start], collections.Counter()
    for depth in range(8):
        nxt = []
        for node in frontier:
            for nb, n in graph.get(node, {}).items():
                if nb[0] == 'W': found[nb[1]] += n
                elif nb not in seen: seen.add(nb); nxt.append(nb)
        if found or not nxt: break
        frontier = nxt
    ho = hand('places', e, desc(c))
    if ho is not None: out_cells[desc(c)] = {"p": place_tag(ho), "c": str(ho), "edid": e, "via": "override"}; continue
    if not found: continue
    wc = sorted(found.items(), key=lambda x: (-x[1], x[0]))[0][0]
    wo = out_worlds.get(desc(wc))
    if not wo: continue
    out_cells[desc(c)] = {"p": wo["p"], "c": wo["c"], "edid": e, "via": "door", "world": wo["edid"]}

# ---- write --------------------------------------------------------------------------------------
def section(d):
    return "{\n" + ",\n".join("  %s: %s" % (json.dumps(k), json.dumps(d[k], ensure_ascii=False, separators=(',', ':'))) for k in sorted(d)) + "\n }"
doc = [("_comment", json.dumps("Generated by ck-mcp/regions.py from the load order and server/regions-overrides.json; do not edit, "
                              "put hand rules in the overrides file. Keys are mp descs. p: 'common' (every province), 'none', or a list "
                              "of live provinces; c: the culture or material family behind it; why: the rule that decided it. "
                              "places: worlds by edid rule or plugin, interior cells by their load doors out to a worldspace, plugins "
                              "for everything else. recipes: creation recipes only (never tempering, smelter breakdown or Hearthfire "
                              "building); items: each crafted product's provinces before a regional bench narrows its recipe.")),
       ("provinces", json.dumps(ALL)),
       ("places", "{\n \"plugins\": %s,\n \"worlds\": %s,\n \"cells\": %s\n}" % (json.dumps(PLACE_PLUGINS), section(out_worlds), section(out_cells))),
       ("tomes", section(out_tomes)), ("recipes", section(out_recipes)), ("items", section(out_items))]
with open(OUT, 'w', encoding='utf-8', newline='\n') as f:
    f.write("{\n" + ",\n".join('"%s": %s' % (k, v) for k, v in doc) + "\n}\n")
json.load(open(OUT, encoding='utf-8'))

# ---- report -------------------------------------------------------------------------------------
def has(tag, prov): return tag == 'common' or (isinstance(tag, list) and prov in tag)
print("recipe kinds:", dict(kinds))
print("creation recipes by tag:", dict(collections.Counter(r["p"] if isinstance(r["p"], str) else '+'.join(r["p"]) for r in out_recipes.values())))
print("craftable per province:", {pv: sum(1 for r in out_recipes.values() if has(r["p"], pv)) for pv in ALL})
print("recipes by rule:", dict(collections.Counter(r["why"].split(':')[0] for r in out_recipes.values())))
print("tomes by tag:", dict(collections.Counter(t["p"] if isinstance(t["p"], str) else '+'.join(t["p"]) for t in out_tomes.values())))
# The shop view spells.js builds: rank <= 3, quest and excluded tomes out, one tome per spell
EXC_T = re.compile(r'^(dun|MGR)|quest|FF\d\d', re.I)
def shop(prov):
    seen, n = set(), 0
    for t in sorted(TOMES, key=lambda t: (t["school"], t["rank"], {"BSHeartland.esm": 0, "BSAssets.esm": 1}.get(t["plugin"], 99), t.get("spellName") or "")):
        if t["rank"] > 3 or EXC_T.search(t["name"]) or t["plugin"].lower() in EXCLUDED_TOME_PLUGINS: continue
        if not has(out_tomes[desc(canon6(t["id"]))]["p"], prov) or t["spellId"] in seen: continue
        seen.add(t["spellId"]); n += 1
    return n
print("tome shop stock per province:", {pv: shop(pv) for pv in ALL})
print("places: %d worlds, %d interior cells by door (%d interiors unreached)" % (len(out_worlds), len(out_cells), len(cells_int) - len(out_cells)))
print("wrote", OUT)
