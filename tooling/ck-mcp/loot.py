"""Builds server\\loot.json: item pools for server-generated dungeon chest loot, Skyrim + DLC + Beyond Skyrim.
Pools: potions (by value band), ingredients, materials, gems, plain weapons and armour (by value
band), enchanted weapons and armour (records with an EITM enchantment, by value band), soul gems,
arrows, lockpicks, food. Every entry carries p = the provinces it may be produced or looted in; the
field is omitted when the item is Tamriel-wide, so a missing p means all three and an older loot.json
still works against the province-aware dungeons.js. dungeons.js draws from these per difficulty and
province. Run from the dev files folder:
    py ck-mcp\\loot.py [output path, default server\\loot.json]"""
import sys, json, struct, re, collections
sys.path.insert(0, r"E:\DragonBreak Online Dev files\ck-mcp")
import core, esplib
lo = core.LoadOrder(r"E:\DragonBreak Online Dev files\Skyrim Special Edition - dev\Data", r"E:\DragonBreak Online Dev files\server\plugins.server.txt")
VANILLA  = {"Skyrim.esm", "Dawnguard.esm", "HearthFires.esm", "Dragonborn.esm"}
CYRODIIL = {"BSHeartland.esm", "BSAssets.esm"}
SOURCES  = VANILLA | CYRODIIL
ALL      = ['cyrodiil', 'skyrim', 'solstheim']
def desc(canon):
    src, loc = canon.rsplit(':', 1); return "%x:%s" % (int(loc, 16), src)
def edid(p, off, sz, fl): return esplib.edid_of(lo.body(p, off, sz, fl)) or ""
# 'amulet' removed: it deleted 58 records, 36 of them legitimate, including the Nine Divines amulets
# Beyond Skyrim places in Bruma and 24 enchanted Ayleid amulets. The junk it used to catch is now
# caught by the Non-Playable flag and UNIQUE_JUNK below.
SKIP_WORDS = ('test', 'dummy', 'dunm', 'mq', 'da0', 'da1', 'ms0', 'ms1', 'unique', 'quest', 'skeletonkey', 'wedding', 'templat', 'dlc1vq', 'dlc2mq', 'lvl', 'cwmissi')

# ---- the Beyond Skyrim distribution overlay -----------------------------------------------------
# Beyond Skyrim's own leveled lists, containers, outfits and cell placements are the authority on what
# is legal in Cyrodiil; the name rules further down are only the fallback. Without this, every vanilla
# item with no material keyword falls through to Skyrim and Bruma loses gear BS itself hands out.
_ix = {}
for p in lo.plugins:
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ('WEAP', 'ARMO', 'AMMO', 'MISC', 'ALCH', 'INGR', 'SLGM', 'BOOK', 'LVLI', 'CONT', 'NPC_', 'OTFT', 'LVLN', 'KYWD')):
        c = lo.canon(p, fid)
        if lo.winner(c) != p.name: continue
        try: body = lo.body(p, off, sz, fl)
        except Exception: continue
        d = {"t": t, "origin": c.rsplit(':', 1)[0], "edid": "", "kids": []}
        for sig, val in esplib.subrecords(body):
            val = bytes(val)
            if sig == b'EDID': d["edid"] = val.rstrip(b'\x00').decode('cp1252', 'replace')
            elif sig == b'CNTO' and len(val) >= 8: d["kids"].append(lo.canon(p, struct.unpack('<II', val[:8])[0]))
            elif sig == b'LVLO' and len(val) >= 12: d["kids"].append(lo.canon(p, struct.unpack('<hxxIhxx', val[:12])[1]))
            elif sig == b'DOFT' and len(val) >= 4: d["kids"].append(lo.canon(p, struct.unpack('<I', val[:4])[0]))
            elif sig == b'INAM' and len(val) >= 4:
                for i in range(0, len(val) - 3, 4): d["kids"].append(lo.canon(p, struct.unpack_from('<I', val, i)[0]))
        _ix[c] = d
kw_edid = {c: d["edid"] for c, d in _ix.items() if d["t"] == 'KYWD'}
BS_OK, _seen = set(), set()
_stack = [c for c, d in _ix.items() if d["origin"] in CYRODIIL and d["t"] in ('LVLI', 'CONT', 'NPC_', 'OTFT')]
while _stack:
    cur = _stack.pop()
    if cur in _seen: continue
    _seen.add(cur)
    d = _ix.get(cur)
    if d is None: BS_OK.add(cur); continue
    if d["t"] in ('LVLI', 'CONT', 'NPC_', 'LVLN', 'OTFT'): _stack.extend(d["kids"])
    else: BS_OK.add(cur)
for p in lo.plugins:                      # loose loot placed in Beyond Skyrim's own cells
    if p.name not in CYRODIIL: continue
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ('REFR', 'ACHR')):
        try: nm = lo.subrecords(p, off, sz, fl).get(b'NAME')
        except Exception: continue
        if nm and len(nm) >= 4: BS_OK.add(lo.canon(p, struct.unpack('<I', bytes(nm)[:4])[0]))
# Deliberate exclusions: Blades relics, and the named-draugr route, which the Northfringe Sanctum
# context rule in dungeons.js owns instead.
# Dawnguard gear is allowed where Beyond Skyrim itself uses it: BS dresses its own Bruma vampires in
# DLC1 robes and armour, and two Bruma dungeons are vampire lairs (owner decision 2026-09-19). The overlay
# only admits what BS actually distributes, so crossbows and bolts - which BS lists nowhere - stay out.
OVERLAY_DENY = re.compile(r'^(?:Ench)?(?:Armor)?(?:Blades|Draugr|AncientNord|NordHero)', re.I)
def overlay(c, e, pr):
    if 'cyrodiil' in pr or c not in BS_OK or OVERLAY_DENY.match(e): return pr
    return ['cyrodiil'] + pr

# ---- province tagging ---------------------------------------------------------------------------
# Dragonborn spells it WeaponMaterial and USSEP inherited the typo "Materiel": both must match.
MAT_RE = re.compile(r'^(?:DLC1|DLC2|ccBGSSSE\d+_|ccBGS_|USKP|USLEEP|MCE_|WAF_|TH_|IAK)?'
                    r'(?:Armor|Weap|Weapon)Materia[lu](.+)$', re.I)
FAM_ALIAS = {'materielfalmerheavyoriginal': 'falmer', 'falmerheavyoriginal': 'falmer', 'falmerhardened': 'falmer'}
def family(kws):
    for k in kws:
        m = MAT_RE.match(k)
        if m:
            f = m.group(1).lower(); return FAM_ALIAS.get(f, f)
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
DUAL_FAM    = {'blades': ['skyrim'], 'penitus': list(ALL), 'vampire': list(ALL)}
EXC = {}
for _e in ('ArmorDraugrBoots', 'ArmorDraugrCuirass', 'ArmorDraugrGauntlets', 'ArmorDraugrHelmet',
           'DraugrHelmet01', 'DraugrHelmet02', 'DraugrHelmet03', 'ArmorThievesGuildCuirass',
           'ArmorThievesGuildBoots', 'ArmorThievesGuildGloves', 'ArmorThievesGuildHelmet',
           'ArmorCompanionsCuirass', 'ArmorCompanionsBoots', 'ArmorCompanionsGauntlets',
           'ArmorCompanionsHelmet'): EXC[_e.lower()] = ['skyrim']
for _e in ('AkaviriKatana', 'CYRWornAkaviriKatana', 'CYRArmorAkaviriBoots'): EXC[_e.lower()] = ['cyrodiil', 'skyrim']
for _e in ('MudcrabChitin', 'CYRMudcrabChitin'): EXC[_e.lower()] = list(ALL)   # a crab shell, not Dunmer armour
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
# A staff is a bound spell on a shaft, the Nine are the Imperial pantheon, and an enchanted ring is the
# same ring as the plain one: none of the three is a regional smithing tradition.
GENERIC = re.compile(r'^(ClothesCirclet\d+|ClothesFine(Clothes|Boots|Hat)|ClothesMerchant|'
                     r'ClothesCommon|ClothesFarm|ClothesPoor|ClothesMonk|ClothesMage|ClothesBarkeep|'
                     r'ClothesTavern|ClothesChild|ClothesRadiantRaiment|Jewelry(Ring|Necklace)|'
                     r'Ench(Ring|Necklace|Amulet|Circlet)|Religious|Staff)', re.I)
def marks(el):
    for w in SOLST_MARK:
        if w in el: return ['solstheim']
    if any(el.startswith(w) for w in CYR_PREFIX):
        for w in SOL_CULTURE:
            if w in el: return ['solstheim']
        for w in SKY_CULTURE:
            if w in el: return ['cyrodiil', 'skyrim']   # BS's own Nordic-flavoured Bruma gear
        return ['cyrodiil']
    for w in SKY_MARK:
        if w in el: return ['skyrim']
    for w in CYR_WORD:
        if w in el: return ['cyrodiil']
    return None
def base_provinces(e, kws, src):
    el = e.lower()
    if el in EXC: return list(EXC[el])                  # 1 explicit exceptions
    m = marks(el)                                       # 2 culture marks
    if m: return m
    fam = family(kws)                                   # 3 material family
    if fam:
        if fam in SOLST_FAM:   return ['solstheim']
        if fam in SKYRIM_FAM:  return ['skyrim']
        if fam in CYR_FAM:     return ['cyrodiil']
        if fam in DUAL_FAM:    return list(DUAL_FAM[fam])
        if fam in TAMRIEL_FAM: return list(ALL)
    if GENERIC.match(e): return list(ALL)               # 3b keyword-less civilian goods
    if src in CYRODIIL: return ['cyrodiil']             # 4 origin plugin
    if src == 'Dragonborn.esm': return ['solstheim']
    return ['skyrim']
def provinces_universal(e, src):      # alchemy: a recipe, not a region
    el = e.lower()
    if any(w in el for w in SOLST_MARK) or src == 'Dragonborn.esm': return ['solstheim']
    if any(el.startswith(w) for w in CYR_PREFIX): return ['cyrodiil']
    return list(ALL)
def provinces_local(e, src):          # flora, fauna, food: where it grows, then the overlay
    el = e.lower()
    if el in EXC: return list(EXC[el])
    if any(w in el for w in SOLST_MARK): return ['solstheim']
    if src in CYRODIIL: return ['cyrodiil']
    if src == 'Dragonborn.esm': return ['solstheim']
    return ['skyrim', 'solstheim']    # northern Solstheim shares Skyrim's taiga flora
COMMON_INGR = {'garlic', 'saltpile', 'wheat', 'chickensegg', 'honeycomb'}
COMMON_FOOD = re.compile(r'^food(bread|cheesewedge|cheesewheel|apple|potato|cabbage|leek|carrot|'
                         r'tomato|greenapple|redapple|salmon|venison|beef|chicken|sweetroll|'
                         r'pie|garlicbread|boiledcremetreat)|^foodale$|^foodwine|^foodmead', re.I)

# ---- pool hygiene -------------------------------------------------------------------------------
# No 'old$' alternative: it fired on 14 records, 6 legitimate (IngotGold, JewelryRingGold,
# JewelryNecklaceGold, three Winterhold guard pieces), because those names end in those letters.
DROP = re.compile(r'fxarmor|^fxdust|dragon_.*blood|prisonercuffs|horsesaddle|horseharness|unarmed|'
                  r'boundweapon|boundarrow|trapdwe|decapitatedhead|armormanakin|armorgag|'
                  r'cwcatapult|projectileweapon|elderscrollhandattach|detectlifebox|armoratronach|'
                  r'crwisp|duplicate|delete|placeholder|^cyrskin|nonplayable|proxy|'
                  r'^cyrclothesmageshoesold$', re.I)
BSP = r'(?:CYR|BSCYR|BSK|BSEDJE|ELS)?'
# CASE-SENSITIVE: these are CamelCase tokens. Under re.I a [A-Z] class also matches lowercase and
# 'POI' matches the 'Poi' inside 'WraithPoison' - that is how an earlier '^Cr[A-Z]' ate CreepClusterRoot.
UNIQUE_JUNK_CS = re.compile(
    r'^' + BSP + r'(dun|FF\d|FF[A-Z]|Favor|POI|MFD|SSD|DEMO|SU\d|T0\d|LD_|Follower|crD|'
    r'DLC1LD_|DLC2MK|MS\d|MG\d|TG\d|TG[A-Z]|DB\d|DBJeweled|WE\d|QST|Uniq|Ench[A-Z]?Test|CloudRuler)'
    r'|(?<=[a-z])(FF\d+|POI|QST|Uniq|MS\d\d|dun)[A-Z]'
    r'|^Cr(Giant|Dwarven|IceWraith|Totem)|^WERJ\d|^BYOHWooden')
UNIQUE_JUNK_I = re.compile(
    r'Freeform|ElderCouncil|^Whiterun|^Markarth|Museum|Nettlebane|Rocksplinter|Pickaxe$|'
    r'ExecutionerAxe|^Axe01$|^Scimitar$|Longhammer|WoodsmansFriend|GeneralTullius|BoneCrown|'
    r'^ClothesEmperor', re.I)
def unique_junk(e): return bool(UNIQUE_JUNK_CS.search(e) or UNIQUE_JUNK_I.search(e))
# A record whose only carriers are outfit lists is livery, not loot.
UNIFORM = re.compile(r'^CYRArmorGuard|^CYRClothes(CoW|SYN|Synod)|^BSKArmorAyleidLichHelmet|'
                     r'^ClothesThalmor', re.I)
# 53 Akaviri/eastern weapons Beyond Skyrim deliberately left unplaced: reserved for a deliberate home
# (admin catalog, a vendor, a Cloud Ruler relic source), not generic chests.
RESERVED = re.compile(r'^BSK74w', re.I)
# Vanilla potions are RestoreHealth01 / FortifyHealth03 / CureDisease - none contain "potion", so the
# old 'potion' substring test admitted nothing but junk and NO potion dropped at any difficulty.
POTION_RE = re.compile(r'^(?:DLC1|DLC2)?(Restore(Health|Magicka|Stamina|All)|Fortify[A-Za-z]+|'
                       r'Resist(Fire|Frost|Shock|Magic|Poison|Disease)|Cure(Disease|Poison)|'
                       r'Invisibility|Waterbreathing)\d*$', re.I)
pools = collections.defaultdict(list)
def add(key, c, e, value, pr):
    it = {"id": desc(c), "name": e, "value": value}
    if sorted(pr) != sorted(ALL): it["p"] = pr     # omitted == Tamriel-wide == every province
    pools[key].append(it)
for p in lo.plugins:
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ('ALCH', 'INGR', 'MISC', 'WEAP', 'ARMO', 'AMMO', 'SLGM')):
        c = lo.canon(p, fid)
        if lo.winner(c) != p.name: continue
        src = c.rsplit(':', 1)[0]
        if src not in SOURCES: continue
        sub = lo.subrecords(p, off, sz, fl)
        e = edid(p, off, sz, fl)
        el = e.lower()
        if not e or any(w in el for w in SKIP_WORDS): continue
        if fl & 0x04: continue                     # record header Non-Playable
        if DROP.search(el) or unique_junk(e) or UNIFORM.match(e) or RESERVED.match(e): continue
        kws = []
        k = sub.get(b'KWDA', b'')
        for i in range(0, len(k) - 3, 4):
            kws.append(kw_edid.get(lo.canon(p, struct.unpack_from('<I', k, i)[0]), ''))
        if t == 'ALCH':
            enit = sub.get(b'ENIT', b'')
            if len(enit) < 8: continue
            value, flags = struct.unpack('<II', enit[:8])
            if flags & 0x20000: continue  # poison
            if flags & 0x2:  # food and drink
                if 'skooma' not in el:
                    pr = list(ALL) if COMMON_FOOD.match(e) else provinces_local(e, src)
                    add('food', c, e, value, overlay(c, e, pr))
                continue
            if not POTION_RE.match(e): continue
            add('potions', c, e, value, overlay(c, e, provinces_universal(e, src)))
        elif t == 'INGR':
            d = sub.get(b'DATA', b''); value = struct.unpack('<I', d[:4])[0] if len(d) >= 4 else 0
            pr = list(ALL) if el in COMMON_INGR else provinces_local(e, src)
            add('ingredients', c, e, value, overlay(c, e, pr))
        elif t == 'MISC':
            d = sub.get(b'DATA', b''); value = struct.unpack('<I', d[:4])[0] if len(d) >= 8 else 0
            if 'ingot' in el or 'leather' in el or 'firewood' in el or el.startswith('charcoal'):
                pr = ['cyrodiil'] if src in CYRODIIL else (['solstheim'] if src == 'Dragonborn.esm' else list(ALL))
                add('materials', c, e, value, overlay(c, e, pr))
            elif el.startswith('gem') or 'flawless' in el or el in ('ruby', 'sapphire', 'emerald', 'diamond', 'amethyst', 'garnet'):
                add('gems', c, e, value, list(ALL))
            elif el == 'lockpick':
                add('lockpicks', c, e, value, list(ALL))
        elif t in ('WEAP', 'ARMO'):
            d = sub.get(b'DATA', b''); value = struct.unpack('<I', d[:4])[0] if len(d) >= 4 else 0
            if b'TNAM' in sub and t == 'ARMO' and not sub.get(b'BOD2'): continue
            if 'skin' in el or 'naked' in el or 'clothes' in el and t == 'ARMO' and value < 10: continue
            enchanted = b'EITM' in sub
            key = ('ench_' if enchanted else '') + ('weapons' if t == 'WEAP' else 'armor')
            add(key, c, e, value, overlay(c, e, base_provinces(e, kws, src)))
        elif t == 'AMMO':
            if 'arrow' in el or 'bolt' in el: add('arrows', c, e, 0, overlay(c, e, base_provinces(e, kws, src)))
        elif t == 'SLGM':
            add('soulgems', c, e, 0, list(ALL))
# DragonBreak's own finds that no rule above admits: recipe notes, rolled from their own pool by boss chests
EXTRA = [('recipes', '12ae17:DragonBreak Online Edits.esp', 'DBO_RecipeRevivePotion', 300)]
for key, did, e, value in EXTRA:
    pools[key].append({"id": did, "name": e, "value": value})
for k in pools: pools[k].sort(key=lambda x: (x["value"], x["name"]))
json.dump({"_comment": "Generated by ck-mcp/loot.py. Item pools (Skyrim + DLC + Beyond Skyrim) for dungeons.js chest loot; value = base record value so difficulty bands can slice each pool; p = the provinces the item may be produced or looted in, omitted when the item is Tamriel-wide. Beyond Skyrim's own leveled lists, containers, outfits and cell placements decide what is legal in Cyrodiil; the editor-id and material rules are the fallback.", "pools": pools},
          open(sys.argv[1] if len(sys.argv) > 1 else r"E:\DragonBreak Online Dev files\server\loot.json", "w"), indent=0)
print({k: len(v) for k, v in pools.items()})
for k, v in pools.items():
    print("%-14s %s" % (k, dict(collections.Counter(x for it in v for x in (it.get("p") or ALL)))))
