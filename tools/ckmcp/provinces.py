"""Province classifier shared by the generators: which provinces (cyrodiil, skyrim, solstheim) an item
belongs to, from its editor id, material keywords, origin plugin and Beyond Skyrim's own distribution.
Imported by loot.py (loot pools) and regions.py (crafting and spell tome regions), so an item is made and
found in the same provinces. server\\regions-overrides.json supplies the family table, the culture aliases
and hand-moved items."""
import sys, json, struct, re, collections
import os; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import linux_paths
import core, esplib
lo = linux_paths.load_order()
OVERRIDES_PATH = os.path.join(linux_paths.SERVER, "regions-overrides.json")
VANILLA  = {"Skyrim.esm", "Dawnguard.esm", "HearthFires.esm", "Dragonborn.esm"}
CYRODIIL = {"BSHeartland.esm", "BSAssets.esm"}
SOURCES  = VANILLA | CYRODIIL
ALL      = ['cyrodiil', 'skyrim', 'solstheim']
CYR_PLUGINS = {'bsheartland.esm', 'bsassets.esm'}
# The plugins Beyond Skyrim was built against: its own view of a leveled list is the last version among these
BS_VIEW = {'skyrim.esm', 'update.esm', 'dawnguard.esm', 'hearthfires.esm', 'dragonborn.esm'} | CYR_PLUGINS

# A master named in another case ('ccbgssse025-advdsgs.esm') would give the same record a second key
_NAME = {p.key: p.name for p in lo.plugins}
_raw_canon = lo.canon
def _canon(p, fid):
    src, loc = _raw_canon(p, fid).rsplit(':', 1)
    return "%s:%s" % (_NAME.get(src.lower(), src), loc)
lo.canon = _canon

def desc(canon):
    src, loc = canon.rsplit(':', 1); return "%x:%s" % (int(loc, 16), src)
def edid(p, off, sz, fl): return esplib.edid_of(lo.body(p, off, sz, fl)) or ""
def plugin_of(canon): return canon.rsplit(':', 1)[0].lower()

# ---- hand rules (server\regions-overrides.json) ---------------------------------------------------
try: OVR = json.load(open(OVERRIDES_PATH, encoding='utf-8'))
except (OSError, ValueError): OVR = {}
ALIASES  = OVR.get('aliases') or {}
FAMILIES = OVR.get('families') or {}
ITEM_OVR = {str(k).lower(): v for k, v in (OVR.get('items') or {}).items()}
def ordered(ps): return [x for x in ALL if x in set(ps)]
def resolve(tag, depth=0):
    """Live provinces of a province, culture, family, 'common' or 'none' (or a list of them); None if unknown."""
    if depth > 5: return None
    if isinstance(tag, list):
        out = [resolve(t, depth + 1) for t in tag]
        return None if any(o is None for o in out) else ordered([x for o in out for x in o])
    t = str(tag).lower()
    if t == 'common': return list(ALL)
    if t == 'none': return []
    if t in ALL: return [t]
    if t in FAMILIES: return resolve(FAMILIES[t], depth + 1)
    if t in ALIASES: return resolve(ALIASES[t], depth + 1)
    return None
def tag_of(ps):
    """'common' for all three provinces, 'none' for none, else the list"""
    return 'common' if sorted(ps) == sorted(ALL) else ordered(ps) if ps else 'none'

# ---- the Beyond Skyrim distribution overlay -----------------------------------------------------
# Beyond Skyrim's own leveled lists, containers, outfits and cell placements are the authority on what
# is legal in Cyrodiil; the name rules further down are only the fallback. Without this, every vanilla
# item with no material keyword falls through to Skyrim and Bruma loses gear BS itself hands out.
# Lists are walked as Beyond Skyrim sees them, so items a later mod injects into a list stay out.
LIST_T = ('LVLI', 'CONT', 'NPC_', 'OTFT', 'LVLN')
_ix, _bs_kids = {}, {}
def _kids(p, body):
    out = []
    for sig, val in esplib.subrecords(body):
        val = bytes(val)
        if sig == b'CNTO' and len(val) >= 8: out.append(lo.canon(p, struct.unpack('<II', val[:8])[0]))
        elif sig == b'LVLO' and len(val) >= 12: out.append(lo.canon(p, struct.unpack('<hxxIhxx', val[:12])[1]))
        elif sig == b'DOFT' and len(val) >= 4: out.append(lo.canon(p, struct.unpack('<I', val[:4])[0]))
        elif sig == b'INAM' and len(val) >= 4:
            for i in range(0, len(val) - 3, 4): out.append(lo.canon(p, struct.unpack_from('<I', val, i)[0]))
    return out
for p in lo.plugins:
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ('WEAP', 'ARMO', 'AMMO', 'MISC', 'ALCH', 'INGR', 'SLGM', 'BOOK') + LIST_T + ('KYWD',)):
        c = lo.canon(p, fid)
        win = lo.winner(c) == p.name
        bs = t in LIST_T and p.key in BS_VIEW
        if not (win or bs): continue
        try: body = lo.body(p, off, sz, fl)
        except Exception: continue
        if bs: _bs_kids[c] = _kids(p, body)
        if not win: continue
        _ix[c] = {"t": t, "origin": c.rsplit(':', 1)[0], "edid": esplib.edid_of(body) or "", "kids": _kids(p, body)}
kw_edid = {c: d["edid"] for c, d in _ix.items() if d["t"] == 'KYWD'}
BS_LISTED, BS_PLACED, _seen = set(), set(), set()
_stack = [c for c, d in _ix.items() if d["origin"].lower() in CYR_PLUGINS and d["t"] in ('LVLI', 'CONT', 'NPC_', 'OTFT')]
while _stack:
    cur = _stack.pop()
    if cur in _seen: continue
    _seen.add(cur)
    d = _ix.get(cur)
    if d is None: BS_LISTED.add(cur); continue
    if d["t"] in LIST_T: _stack.extend(_bs_kids.get(cur, d["kids"]))
    else: BS_LISTED.add(cur)
for p in lo.plugins:                      # loose loot placed in Beyond Skyrim's own cells
    if p.key not in CYR_PLUGINS: continue
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ('REFR', 'ACHR')):
        try: nm = lo.subrecords(p, off, sz, fl).get(b'NAME')
        except Exception: continue
        if nm and len(nm) >= 4: BS_PLACED.add(lo.canon(p, struct.unpack('<I', bytes(nm)[:4])[0]))
BS_OK = BS_LISTED | BS_PLACED
# Deliberate exclusions: Blades relics, and the named-draugr route, which the Northfringe Sanctum
# context rule in dungeons.js owns instead.
# Dawnguard gear is allowed where Beyond Skyrim itself uses it: BS dresses its own Bruma vampires in
# DLC1 robes and armour, and two Bruma dungeons are vampire lairs (owner decision 2026-09-19). The overlay
# only admits what BS actually distributes, so crossbows and bolts - which BS lists nowhere - stay out.
OVERLAY_DENY = re.compile(r'^(?:Ench)?(?:Armor)?(?:Blades|Draugr|AncientNord|NordHero)', re.I)
def overlay(c, e, pr):
    if 'cyrodiil' in pr or c not in BS_OK or OVERLAY_DENY.match(e): return pr
    return ['cyrodiil'] + pr

# ---- Complete Crafting Overhaul categories ------------------------------------------------------
# CCO files each recipe under GetGlobalValue(CCO_Category*) conditions: the only culture signal many
# Immersive Armors pieces carry. Keyed by the product of every winning recipe.
_glob = {}
for p in lo.plugins:
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ('GLOB',)):
        _glob[lo.canon(p, fid)] = edid(p, off, sz, fl)
CCO_CATS = collections.defaultdict(set)
for p in lo.plugins:
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ('COBJ',)):
        if lo.winner(lo.canon(p, fid)) != p.name or fl & 0x20: continue
        product, cats = None, set()
        for sig, val in esplib.subrecords(lo.body(p, off, sz, fl)):
            val = bytes(val)
            if sig == b'CNAM' and len(val) >= 4: product = lo.canon(p, struct.unpack('<I', val[:4])[0])
            elif sig == b'CTDA' and len(val) >= 16 and struct.unpack_from('<H', val, 8)[0] == 74:
                g = _glob.get(lo.canon(p, struct.unpack_from('<I', val, 12)[0]), '')
                if g.startswith('CCO_Category'): cats.add(g[12:].lower())
        if product and cats: CCO_CATS[product] |= cats
CCO_CULTURE = {'nordic': 'skyrim', 'nordicancient': 'skyrim', 'factionstormcloak': 'skyrim', 'factioncompanions': 'skyrim',
               'factionhold': 'skyrim', 'factiondarkbrotherhood': 'skyrim', 'factionimperial': 'imperial',
               'exoticakaviri': 'akavir', 'exoticredguard': 'hammerfell', 'chitin': 'morrowind'}
CCO_MATERIAL = {'iron': 'iron', 'steel': 'steel', 'hide': 'hide', 'leather': 'leather', 'silver': 'silver', 'gold': 'silver',
                'elven': 'elven', 'glass': 'glass', 'ebony': 'ebony', 'dwarven': 'dwarven', 'orcish': 'orcish',
                'daedric': 'daedric', 'dragon': 'dragonplate', 'bone': 'hide', 'corundum': 'steel',
                'quicksilver': 'steel', 'moonstone': 'elven'}

# ---- province tagging ---------------------------------------------------------------------------
# Dragonborn spells it WeaponMaterial and USSEP inherited the typo "Materiel": both must match.
# Immersive Armors and WAF name theirs IAKMaterialSteel and WAF_MaterialChitin.
MAT_RE = re.compile(r'^(?:DLC1|DLC2|ccBGSSSE\d+_|ccBGS_|USKP|USLEEP|MCE_|WAF_|TH_|IAK)?'
                    r'(?:Armor|Weap|Weapon)Materia[lu](.+)$|^(?:IAK|WAF_)Material(.+)$', re.I)
FAM_ALIAS = {'materielfalmerheavyoriginal': 'falmer', 'falmerheavyoriginal': 'falmer', 'falmerhardened': 'falmer',
             'advancedplate': 'steelplate', 'advancedscale': 'scaled', 'advanced': 'steelplate', 'steelchain': 'steel',
             'penitus': 'imperial', 'dark': 'shiveringisles', 'golden': 'shiveringisles', 'amber': 'shiveringisles',
             'madness': 'shiveringisles'}
# Immersive Weapons puts the Ancient Nord keyword on its steel-tier blades (their recipes take steel ingots)
NORDIC_WORD = ('nord', 'draugr', 'ancient', 'viking', 'skyforge', 'ysgramor')
def family(kws, e='', src=''):
    iw = src.lower() == 'immersive weapons.esp'
    for k in kws:
        m = MAT_RE.match(k)
        if m:
            f = (m.group(1) or m.group(2)).lower(); f = FAM_ALIAS.get(f, f)
            if iw and f in ('draugr', 'draugrhoned') and not any(w in e.lower() for w in NORDIC_WORD): return 'steel'
            if f in ('faction', 'auxiliaryarmors'): continue
            return f
    return None
TAMRIEL_FAM = {'iron', 'ironbanded', 'steel', 'steelplate', 'leather', 'hide', 'studded', 'scaled', 'wood',
               'silver', 'imperial', 'imperiallight', 'imperialheavy', 'imperialstudded', 'elven',
               'elvengilded', 'glass', 'ebony', 'orcish', 'orcishlight', 'dwarven', 'daedric',
               'dragonplate', 'dragonscale', 'dragonbone'}
SKYRIM_FAM  = {'draugr', 'draugrhoned', 'falmer', 'falmerhoned', 'forsworn', 'ms02forsworn', 'stormcloak',
               'bearstormcloak', 'dawnguard', 'hunter', 'thievesguild', 'thievesguildleader',
               'thievesguildalt', 'thievesguildkarliah', 'linwe', 'blackguard', 'wolf', 'tsun', 'giant',
               'nightingale'}
SOLST_FAM   = {'stalhrim', 'stalhrimheavy', 'stalhrimlight', 'nordic', 'nordicheavy', 'nordiclight',
               'bonemold', 'bonemoldheavy', 'bonemoldlight', 'chitin', 'chitinheavy', 'chitinlight',
               'moragtong'}
CYR_FAM     = {'mithril'}
DUAL_FAM    = {'blades': ['skyrim'], 'vampire': list(ALL)}
def family_key(fam):
    """The family-table key a material family belongs to (dragonscale -> dragon), or None"""
    if fam in FAMILIES or fam in ALIASES: return fam
    for k in FAMILIES:
        if fam.startswith(k): return k
    return None
EXC = {}
for _e in ('ArmorDraugrBoots', 'ArmorDraugrCuirass', 'ArmorDraugrGauntlets', 'ArmorDraugrHelmet',
           'DraugrHelmet01', 'DraugrHelmet02', 'DraugrHelmet03', 'ArmorThievesGuildCuirass',
           'ArmorThievesGuildBoots', 'ArmorThievesGuildGloves', 'ArmorThievesGuildHelmet',
           'ArmorCompanionsCuirass', 'ArmorCompanionsBoots', 'ArmorCompanionsGauntlets',
           'ArmorCompanionsHelmet'): EXC[_e.lower()] = ['skyrim']
for _e in ('AkaviriKatana', 'CYRWornAkaviriKatana', 'CYRArmorAkaviriBoots'): EXC[_e.lower()] = ['cyrodiil', 'skyrim']
for _e in ('MudcrabChitin', 'CYRMudcrabChitin'): EXC[_e.lower()] = list(ALL)   # a crab shell, not Dunmer armour
for _e in ('DLC1ClothesMothPriestRobes', 'DLC1ClothesMothPriestSandals', 'DLC1ClothesMothPriestBlindfold'): EXC[_e.lower()] = ['cyrodiil', 'skyrim']
# Immersive Armors sets whose pieces carry different material keywords, tagged as one set
IA_SETS = (('dwarvenmage', 'dwarven'), ('ebonymage', 'ebony'), ('ritualboethiah', 'dragon'), ('warchief', 'orcish'),
           ('shaman', 'steel'))
# Plugins whose whole content is one culture
PLUGIN_CULTURE = {'dragonpriestarmor.esp': 'dragon', 'dis_heavy_legion.esp': 'imperial',
                  'journey to baan malur.esp': 'morrowind', 'journey to baan malur - dunmeth pass.esp': 'morrowind',
                  'armors of the velothi.esp': 'morrowind', 'armors of the velothi pt2.esp': 'morrowind',
                  'gray fox cowl.esm': 'hammerfell', 'ccbgssse025-advdsgs.esm': 'shiveringisles'}
# 'chitin' and 'bonemold' are NOT marks: every Solstheim record carrying them also carries the DLC2
# prefix or the material family, while 'chitin' as a bare substring exiles mudcrab shells.
SOLST_MARK = ('dlc2', 'stalhrim', 'nordicheavy', 'nordiclight', 'moragtong', 'riekling', 'skaal',
              'cultistmask', 'reaver', 'ashspawn', 'netch')
SKY_MARK   = ('dlc1', 'guardshield', 'dragonpriest', 'ancientnord', 'draugr', 'falmer', 'forsworn',
              'stormcloak', 'eastmarch', 'nightingale', 'thievesguild', 'dbarmor', 'armorastrid',
              'armorcompanions', 'armorafflicted', 'armorbriarheart', 'armortsun', 'dlc1armordawnguard',
              'dlc1armorhunter', 'dlc01soulcairn', 'dlc1wrathman', 'clothescollege', 'clothesulfric',
              'clothesjarl', 'clothesgreybeard', 'summersetshadows', 'shrouded', 'nordhero', 'ysgramor',
              'skyforge', 'wolfarmor', 'blackguard', 'linwe')
CYR_WORD   = ('colovian', 'nibenese', 'ayleid', 'mithril', 'chainmail', 'synod', 'goblin', 'minotaur',
              'ogre', 'cyrodilic', 'cyrodiilic')
CYR_PREFIX = ('cyr', 'bscyr', 'bsk', 'bsedje', 'els')
SKY_CULTURE = ('draugr', 'ancientnord', 'nordhero')
SOL_CULTURE = ('stalhrim', 'riekling', 'skaal')
# Cultures named in editor ids, checked after the marks above; aliases fold them into live provinces
HOLDS = ('whiterun', 'riften', 'windhelm', 'solitude', 'markarth', 'falkreath', 'dawnstar', 'winterhold', 'morthal',
         'hjaalmarch', 'haafingar')
CULTURE_WORDS = (
    ('shiveringisles', ('goldensaint', 'darkseducer', 'madness')),
    ('morrowind', ('tribunal', 'vvardenfell', 'velothi', 'indoril', 'hlaalu', 'redoran', 'telvanni', 'sixthhouse')),
    ('hammerfell', ('redguard', 'alikr', 'hammerfell', 'yokudan', 'strosmkai')),
    ('akavir', ('akaviri', 'tsaesci')),
    ('elsweyr', ('khajiit', 'elsweyr')),
    ('blackmarsh', ('argonian', 'blackmarsh', 'anxileel')),
    ('summerset', ('thalmor', 'altmer', 'summerset', 'aldmeri', 'justiciar', 'alinor')),
    ('valenwood', ('bosmer', 'valenwood', 'camoran')),
    ('imperial', ('imperial', 'legion', 'penitus', 'tullius', 'mythicdawn', 'emperor')),
    ('skyrim', HOLDS + ('companions', 'einherjar', 'stormlord', 'primitivenord', 'nordmail', 'darkbrotherhood', 'dawnguard')),
)
# A staff is a bound spell on a shaft, the Nine are the Imperial pantheon, and an enchanted ring is the
# same ring as the plain one: none of the three is a regional smithing tradition.
GENERIC = re.compile(r'^(?:Template|MCE|Ench)?(ClothesCirclet\d+|ClothesFine(Clothes|Boots|Hat)|ClothesMerchant|'
                     r'ClothesCommon|ClothesFarm|ClothesPoor|ClothesMonk|ClothesMage|ClothesBarkeep|'
                     r'ClothesTavern|ClothesChild|ClothesRadiantRaiment|ClothesRobesMage|'
                     r'ClothesRobes(Black|Blue|Grey|Brown|Green|Red)|ClothesWedding|ClothesMourner|ClothesNecromancer|'
                     r'ClothesBeggar|ClothesBlackSmith|ClothesChef|ClothesMiner|ClothesPrisoner|ClothesWench|ClothesBoots\d|'
                     r'Jewelry(Ring|Necklace)|'
                     r'Ench(Ring|Necklace|Amulet|Circlet)|Religious|Staff|ccBGSSSE001_(FishingRod|ClothesFishing))', re.I)
def marks(el, skip_dlc1=False):
    for w in SOLST_MARK:
        if w in el: return ['solstheim']
    if any(el.startswith(w) for w in CYR_PREFIX):
        for w in SOL_CULTURE:
            if w in el: return ['solstheim']
        for w in SKY_CULTURE:
            if w in el: return ['cyrodiil', 'skyrim']   # BS's own Nordic-flavoured Bruma gear
        return ['cyrodiil']
    for w in SKY_MARK:
        if w in el and not (skip_dlc1 and w == 'dlc1'): return ['skyrim']
    for w in CYR_WORD:
        if w in el: return ['cyrodiil']
    return None
def culture_word(el):
    for c, words in CULTURE_WORDS:
        if any(w in el for w in words): return c
    return None
def fam_provinces(fam):
    """(provinces, culture tag, why) of a material family, or None"""
    k = family_key(fam)
    if k: return resolve(k), k, 'family-table'
    if fam in SOLST_FAM:   return ['solstheim'], fam, 'family'
    if fam in SKYRIM_FAM:  return ['skyrim'], fam, 'family'
    if fam in CYR_FAM:     return ['cyrodiil'], fam, 'family'
    if fam in DUAL_FAM:    return list(DUAL_FAM[fam]), fam, 'family'
    if fam in TAMRIEL_FAM: return list(ALL), fam, 'family'
    return None
def item_override(e, c):
    v = ITEM_OVR.get(e.lower()) or (ITEM_OVR.get(desc(c).lower()) if c else None)
    return resolve(v) if v is not None else None
def classify(e, kws, src, c=None):
    """(provinces, culture or family tag, why) of a weapon, armour or ammunition record"""
    el = e.lower()
    o = item_override(e, c)
    if o is not None: return o, 'override', 'override'
    if el in EXC: return list(EXC[el]), 'exception', 'exception'                  # 1 explicit exceptions
    pc = PLUGIN_CULTURE.get(src.lower())
    if pc: return resolve(pc), pc, 'plugin'                                       # 2 one-culture plugins
    if src.lower() == 'hothtrooper44_armorcompilation.esp':
        for w, f in IA_SETS:
            if w in el: return fam_provinces(f)
    fam = family(kws, e, src)
    m = marks(el, skip_dlc1=bool(fam and fam.startswith('dragon')))              # 3 culture marks
    if m: return m, m[0] if len(m) == 1 else 'nordic', 'mark'
    cw = None if GENERIC.match(e) else culture_word(el)                          # 4 culture words
    if cw: return resolve(cw), cw, 'culture'
    cats = CCO_CATS.get(c, ()) if c else ()
    for k in sorted(cats):                                                        # 5 CCO culture category
        if k in CCO_CULTURE: return resolve(CCO_CULTURE[k]), CCO_CULTURE[k], 'cco'
    if fam:                                                                       # 6 material family
        r = fam_provinces(fam)
        if r: return r
    for k in sorted(cats):                                                        # 7 CCO material category
        if k in CCO_MATERIAL:
            r = fam_provinces(CCO_MATERIAL[k])
            if r: return r[0], r[1], r[2] + '-cco'
    if GENERIC.match(e): return list(ALL), 'common', 'generic'                   # 8 keyword-less civilian goods
    s = src.lower()                                                               # 9 origin plugin
    if s in CYR_PLUGINS: return ['cyrodiil'], 'cyrodiil', 'origin'
    if s == 'dragonborn.esm': return ['solstheim'], 'solstheim', 'origin'
    return ['skyrim'], 'skyrim', 'origin'
def base_provinces(e, kws, src, c=None): return classify(e, kws, src, c)[0]
def item_provinces(c, e, kws, src):
    """classify plus the Beyond Skyrim overlay, which never widens a family-table or hand decision"""
    pr, tag, why = classify(e, kws, src, c)
    return (pr if why in ('override', 'family-table') else overlay(c, e, pr)), tag, why
def provinces_universal(e, src):      # alchemy: a recipe, not a region
    el = e.lower()
    if any(w in el for w in SOLST_MARK) or src.lower() == 'dragonborn.esm': return ['solstheim']
    if any(el.startswith(w) for w in CYR_PREFIX): return ['cyrodiil']
    return list(ALL)
def provinces_local(e, src):          # flora, fauna, food: where it grows, then the overlay
    el = e.lower()
    if el in EXC: return list(EXC[el])
    if any(w in el for w in SOLST_MARK): return ['solstheim']
    if src.lower() in CYR_PLUGINS: return ['cyrodiil']
    if src.lower() == 'dragonborn.esm': return ['solstheim']
    return ['skyrim', 'solstheim']    # northern Solstheim shares Skyrim's taiga flora
def provinces_material(e, src):       # ingots, leather, firewood: where they are worked
    pc = PLUGIN_CULTURE.get(src.lower())
    if pc: return resolve(pc)
    if src.lower() in CYR_PLUGINS: return ['cyrodiil']
    if src.lower() == 'dragonborn.esm' or any(w in e.lower() for w in SOLST_MARK): return ['solstheim']
    return list(ALL)
COMMON_INGR = {'garlic', 'saltpile', 'wheat', 'chickensegg', 'honeycomb'}
COMMON_FOOD = re.compile(r'^food(bread|cheesewedge|cheesewheel|apple|potato|cabbage|leek|carrot|'
                         r'tomato|greenapple|redapple|salmon|venison|beef|chicken|sweetroll|'
                         r'pie|garlicbread|boiledcremetreat)|^foodale$|^foodwine|^foodmead', re.I)
