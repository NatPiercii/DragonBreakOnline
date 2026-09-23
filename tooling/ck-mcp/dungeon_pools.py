"""Builds server\\dungeon-pools.json: the enemy families server\\dungeons.js may swap a vanilla dungeon placement
between, so a cave of identical archers gets the rest of its own faction instead.

A family is one faction in one province. Each archetype is one or more root leveled lists (LVLN editor ids)
resolved to concrete NPC_ options the same way dungeons_build.py resolves placements. Nothing is typed as a form
id: every list is looked up by editor id and must originate in a plugin of the family's province (gear and people
are region-locked).

A placement joins a family when its base NPC is not DragonBreak's own, it is a generic encounter (a Lvl*/Enc*
editor id that is not quest, named or dungeon-specific), none of its options is unique, the family's rule accepts
it (the leveled list its template chain ends at, or its editor id), and every NPC it can resolve to is one of the
family's NPCs. Refs placed by DragonBreak's own
plugins are curation, refs flagged Starts Dead are corpses, and refs a quest alias forces (ALFR) or fills through
its location (ALFA + ALRT: scene actors, named bosses) are that quest's actors; all are listed in "keep" and never swapped, as are the set-piece refs in KEEP_REFS. Everything else stays as Bethesda placed it.

Run from the dev files folder after dungeons_build.py (reads server\\dungeons.json):
    py ck-mcp\\dungeon_pools.py
then reload the gamemode. Writes nothing and exits non-zero when a list is missing, a placement fits two
families, or a family's placement count differs from the "expect" in SPEC."""
import sys, os, json, struct, re, collections, hashlib
sys.path.insert(0, r"E:\DragonBreak Online Dev files\ck-mcp")
import core, esplib
SERVER = r"E:\DragonBreak Online Dev files\server"
lo = core.LoadOrder(r"E:\DragonBreak Online Dev files\Skyrim Special Edition - dev\Data", SERVER + r"\plugins.server.txt")
def edid(p, off, sz, fl): return esplib.edid_of(lo.body(p, off, sz, fl)) or ""
def desc(canon):
    src, loc = canon.rsplit(':', 1)
    return "%x:%s" % (int(loc, 16), src)
def canon_of(d):
    loc, src = d.split(':', 1)
    return "%s:%06X" % (src, int(loc, 16))
origin = lambda canon: canon.rsplit(':', 1)[0]

# Plugins whose leveled lists and NPCs belong to each province (by the form id's origin, not the winning override)
PROVINCE_PLUGINS = {
    "skyrim": {"Skyrim.esm", "Update.esm", "Dawnguard.esm"},
    "solstheim": {"Dragonborn.esm"},
    "cyrodiil": {"BSHeartland.esm", "BSAssets.esm"},
}
PROVINCE_OF_PLUGIN = {pl: prov for prov, pls in PROVINCE_PLUGINS.items() for pl in pls}
# Refs placed by these plugins are the server's own curation and are never swapped
CURATION = {"DragonBreak.esp", "DragonBreak Online Edits.esp"}
# Only generic encounter placements can be swapped
GENERIC = re.compile(r"^(DLC1|DLC2|CYR|BSK)?(Lvl|Enc)")
# Quests, named characters and dungeon-specific lists stay vanilla
NEVER = re.compile(r"^(MS\d|DA\d|DB\d|TG|MQ|DLC1Dun|CYRBruma)|[Dd]un[A-Z_]|Unique|Named")
STARTS_DEAD = 0x200
# Placed refs that are scripted set pieces although their editor id is generic (quest aliases are found in the data)
KEEP_REFS = {
    "BSHeartland.esm:0E59C7", "BSHeartland.esm:0E59C3",   # Mountainwatch goblin shaman and chief (CYRMountainWatchMS02)
    "BSHeartland.esm:0CB9E1",                             # Rielle boss (CYRDunRielleQuest alias)
    "BSHeartland.esm:0CC55B", "BSHeartland.esm:0CC55C", "BSHeartland.esm:0CC55D", "BSHeartland.esm:0CC55E",  # Sedor ambush
    "BSHeartland.esm:087611", "BSHeartland.esm:0CBAF2", "BSHeartland.esm:0D31F1", "BSHeartland.esm:0D31F2",  # Rielle trap chain
}

# family id "<province>.<faction>":
#   archetypes / boss: [(kind, [root LVLN edids])]
#   chain: the first leveled list the placement's template chain reaches must match (editor id regex)
#   edid: the placement's editor id must match;  deny: must not match
#   chainNpc / notChainNpc: some / no NPC_ in the placement's template chain (itself included) matches
#   plugins: where this family's lists and NPCs may come from, when not its province's own plugins
#   expect: (placement editor ids, placement slots) the rule must select, or nothing is written
SPEC = {
    # Reavers: Solstheim's Dunmer bandits. Dragonborn.esm has no two-handed reaver. Dres slavers, the Morag Tong and
    # Journey to Baan Malur's Dulan tower trio borrow reaver faces but are other people; the Commoner/Cynical
    # reavers are the voiced actors of the Hrodulf's House and Damphall Mine scenes.
    "solstheim.bandit": {
        "archetypes": [("reaver_melee_1h", ["DLC2LCharBanditMelee1H"]), ("reaver_missile", ["DLC2LCharBanditMissile"]), ("reaver_mage", ["DLC2LCharBanditMagic"])],
        "boss": [("reaver_boss", ["DLC2LCharBanditBoss"])],
        "chain": r"^DLC2LCharBandit", "deny": r"^(DresSlaver|DulanTower|DulanBanditTower)|MoragTong|DarkElfM(Commoner|Cynical)$",
        "expect": (11, 30),
    },
    # Miraak's cultists in his temple: a cultist mage may become a summoner of the same order. Empty since
    # 2026-09-19, when the survey started reading enable parents: every cultist placement in the temple starts
    # disabled behind DLC2MQ02's markers. Kept so the expect guard fires if that ever changes.
    "solstheim.cultist": {
        "archetypes": [("cultist_miraak", ["DLC2LCharCultist"]), ("cultist_miraak_summoner", ["DLC2LCharCultistSummoner"])],
        "chain": r"^DLC2LCharCultist", "expect": (0, 0),
    },
    # Skyrim's bandits. Silver Hand, vampire thralls, Blackblood marauders and the dun* ghosts use the same
    # bandit lists but are other people, so they are told apart by the NPCs in their template chain.
    "skyrim.bandit": {
        "archetypes": [("bandit_melee_1h", ["LCharBanditMelee1H"]), ("bandit_melee_tank", ["LCharBanditMelee1HTank"]),
                       ("bandit_melee_2h", ["LCharBanditMelee2H"]), ("bandit_berserker_2h", ["LCharBanditMelee2HBerserk"]),
                       ("bandit_missile", ["LCharBanditMissile"]), ("bandit_mage", ["LCharBanditWizard"])],
        "boss": [("bandit_boss", ["LCharBanditBoss"])],
        "chain": r"^LCharBandit", "edid": r"^(DLC1)?Lvl", "notChainNpc": r"(?i)silver ?hand|VampireThrall|Blackblood|Ghost",
        "expect": (24, 140),
    },
    "skyrim.silverhand": {
        "archetypes": [("silverhand_melee_1h", ["LCharBanditMelee1H"]), ("silverhand_melee_2h", ["LCharBanditMelee2H"]),
                       ("silverhand_missile", ["LCharBanditMissile"])],
        "boss": [("silverhand_boss", ["LCharBanditBoss"])],
        "chain": r"^LCharBandit", "edid": r"^(DLC1)?Lvl", "chainNpc": r"(?i)silver ?hand",
        "expect": (6, 33),
    },
    "skyrim.vampirethrall": {
        "archetypes": [("vampire_thrall_melee_1h", ["LCharBanditMelee1H"]), ("vampire_thrall_melee_tank", ["LCharBanditMelee1HTank"]),
                       ("vampire_thrall_melee_2h", ["LCharBanditMelee2H"]), ("vampire_thrall_berserker_2h", ["LCharBanditMelee2HBerserk"]),
                       ("vampire_thrall_missile", ["LCharBanditMissile"]), ("vampire_thrall_mage", ["LCharBanditWizard"])],
        "chain": r"^LCharBandit", "edid": r"^(DLC1)?Lvl", "chainNpc": r"(?i)VampireThrall",
        "expect": (10, 14),
    },
    # Conjurers and elemental mages. Necromancers keep their own lairs (one list, so they stay vanilla).
    "skyrim.warlock": {
        "archetypes": [("warlock_conjurer", ["LCharWarlockConjurer"]), ("warlock_fire_mage", ["LCharWarlockFire"]),
                       ("warlock_frost_mage", ["LCharWarlockIce"]), ("warlock_storm_mage", ["LCharWarlockStorm"])],
        "boss": [("warlock_boss_conjurer", ["LCharWarlockBossConjurer"]), ("warlock_boss_fire_mage", ["LCharWarlockBossFire"]),
                 ("warlock_boss_frost_mage", ["LCharWarlockBossIce"]), ("warlock_boss_storm_mage", ["LCharWarlockBossStorm"])],
        "chain": r"^LCharWarlock(?!.*(Necro|Atronach|Familiar|Companion))", "edid": r"^(DLC1)?Lvl",
        "expect": (10, 25),
    },
    "skyrim.forsworn": {
        "archetypes": [("forsworn_melee", ["LCharForswornMelee1H"]), ("forsworn_missile", ["LCharForswornMissile"]), ("forsworn_shaman", ["LCharForswornShaman"])],
        "boss": [("forsworn_boss_shaman", ["LCharForswornBossShaman"]), ("forsworn_boss_melee", ["LCharForswornBossMelee1H"])],
        "chain": r"^LCharForsworn", "edid": r"^(DLC1)?Lvl",
        "expect": (12, 29),
    },
    "skyrim.falmer": {
        "archetypes": [("falmer_melee", ["LCharFalmerMelee"]), ("falmer_missile", ["LCharFalmerMissile"]),
                       ("falmer_shaman", ["LCharFalmerShaman"]), ("falmer_spellsword", ["LCharFalmerSpellsword"])],
        "boss": [("falmer_boss", ["LCharFalmerBoss"])],
        "chain": r"^LCharFalmer(Melee|Missile|Shaman|Spellsword|Boss)$", "edid": r"^(DLC1)?Lvl",
        "expect": (17, 233),
    },
    # Heartland bandits, smugglers and vampire thralls share Beyond Skyrim's bandit lists, so the editor id decides
    "cyrodiil.bandit": {
        "archetypes": [("bandit_melee_1h", ["CYRLCharBanditMelee1H"]), ("bandit_tank_1h", ["CYRLCharBanditMelee1HTank"]),
                       ("bandit_melee_2h", ["CYRLCharBanditMelee2H"]), ("bandit_berserker_2h", ["CYRLCharBanditMelee2HBerserk"]),
                       ("bandit_missile", ["CYRLCharBanditMissile"]), ("bandit_wizard", ["CYRLCharBanditWizard"])],
        "boss": [("bandit_boss", ["CYRLCharBanditBoss"])],
        "edid": r"^CYRLvlBandit(?!Ghost)", "expect": (8, 41),
    },
    "cyrodiil.smuggler": {
        "archetypes": [("smuggler_melee_1h", ["CYRLCharBanditMelee1H"]), ("smuggler_tank_1h", ["CYRLCharBanditMelee1HTank"]),
                       ("smuggler_melee_2h", ["CYRLCharBanditMelee2H"]), ("smuggler_berserker_2h", ["CYRLCharBanditMelee2HBerserk"]),
                       ("smuggler_missile", ["CYRLCharBanditMissile"]), ("smuggler_wizard", ["CYRLCharBanditWizard"])],
        "boss": [("smuggler_boss", ["CYRLCharBanditBoss"])],
        "edid": r"^CYRLvlSmuggler", "expect": (5, 16),
    },
    "cyrodiil.vampire_thrall": {
        "archetypes": [("vampire_thrall_melee_1h", ["CYRLCharBanditMelee1H"]), ("vampire_thrall_tank_1h", ["CYRLCharBanditMelee1HTank"]),
                       ("vampire_thrall_melee_2h", ["CYRLCharBanditMelee2H"]), ("vampire_thrall_berserker_2h", ["CYRLCharBanditMelee2HBerserk"]),
                       ("vampire_thrall_missile", ["CYRLCharBanditMissile"]), ("vampire_thrall_wizard", ["CYRLCharBanditWizard"])],
        "edid": r"^CYRLvlVampireThrall", "expect": (9, 26),
    },
    # Goblins stay within their tribe: each named tribe has its own faction and lists. Boss kinds keep 'boss' so
    # dungeons.js still arms and E-loots goblin chiefs as it did before the pools.
    "cyrodiil.goblin": {
        "archetypes": [("goblin_melee", ["CYRLCharGoblinMelee"]), ("goblin_missile", ["CYRLCharGoblinMissile"]), ("goblin_berserker", ["CYRLCharGoblinBerserker"])],
        "boss": [("goblin_boss_warlord", ["CYRLCharGoblinBossMelee"]), ("goblin_boss_shaman", ["CYRLCharGoblinBossMagic"])],
        "edid": r"^CYRLvlGoblin", "deny": r"BaldTail|BloodyHand|BlueScalp|CrackedSkull|DeepRoot|FireBelly|GoldFinger|RedFace|VenomVein", "expect": (9, 36),
    },
    "cyrodiil.goblin_bluescalp": {
        "archetypes": [("goblin_bluescalp_melee", ["CYRLCharGoblinMeleeBlueScalp"]), ("goblin_bluescalp_missile", ["CYRLCharGoblinMissileBlueScalp"]),
                       ("goblin_bluescalp_berserker", ["CYRLCharGoblinBerserkerBlueScalp"])],
        "boss": [("goblin_bluescalp_boss_warlord", ["CYRLCharGoblinBossMeleeBlueScalp"]), ("goblin_bluescalp_boss_shaman", ["CYRLCharGoblinBossMagicBlueScalp"])],
        "edid": r"^CYRLvlGoblin.*BlueScalp", "expect": (3, 6),
    },
    # The undead of the Ayleid ruins; their HoldPosition snipers are separate stationary NPCs and keep their post
    "cyrodiil.ayleid_undead": {
        "archetypes": [("ayleid_undead_melee_1h", ["CYRLCharAyleidUndeadMelee1H"]), ("ayleid_undead_melee_2h", ["CYRLCharAyleidUndeadMelee2H"]),
                       ("ayleid_undead_spellsword", ["CYRLCharAyleidUndeadMagic"]), ("ayleid_undead_archer", ["CYRLCharAyleidUndeadMissile"])],
        "boss": [("ayleid_undead_champion", ["CYRLCharAyleidUndeadBossMelee"]), ("ayleid_undead_lich", ["CYRLCharAyleidUndeadBossMagic"])],
        "edid": r"^CYRLvlAyleid(Undead|Skeleton)", "deny": r"HoldPos|SkeletonBow", "expect": (6, 36),
    },
    # The Nordic dead: a barrow's draugr may take any of the four roles. Their bosses stay as placed, because
    # LCharDraugrBoss tops out at a dragon priest and the other boss list has a single role. Solstheim's and
    # Bruma's barrows are filled from Skyrim.esm's draugr lists, hence the plugin allowance there.
    "skyrim.draugr": {
        "archetypes": [("draugr_melee_1h", ["LCharDraugrMelee1HMale", "LCharDraugrMelee1HFemale"]),
                       ("draugr_melee_2h", ["LCharDraugrMelee2HMale", "LCharDraugrMelee2HFemale"]),
                       ("draugr_missile", ["LCharDraugrMissileMale", "LCharDraugrMissileFemale"]),
                       ("draugr_warlock", ["LCharDraugrWarlockMale", "LCharDraugrWarlockFemale"])],
        "chain": r"^LCharDraugr(Melee|Missile|Warlock)", "edid": r"^(DLC1|DLC2)?LvlDraugr", "expect": (36, 502),
    },
    "solstheim.draugr": {
        "archetypes": [("draugr_melee_1h", ["LCharDraugrMelee1HMale", "LCharDraugrMelee1HFemale"]),
                       ("draugr_melee_2h", ["LCharDraugrMelee2HMale", "LCharDraugrMelee2HFemale"]),
                       ("draugr_missile", ["LCharDraugrMissileMale", "LCharDraugrMissileFemale"]),
                       ("draugr_warlock", ["LCharDraugrWarlockMale", "LCharDraugrWarlockFemale"])],
        "chain": r"^LCharDraugr(Melee|Missile|Warlock)", "edid": r"^(DLC1|DLC2)?LvlDraugr", "expect": (19, 50),
        "plugins": {"Skyrim.esm", "Update.esm", "Dawnguard.esm", "Dragonborn.esm"},
    },
    "cyrodiil.draugr": {
        "archetypes": [("draugr_melee_1h", ["LCharDraugrMelee1HMale", "LCharDraugrMelee1HFemale"]),
                       ("draugr_melee_2h", ["LCharDraugrMelee2HMale", "LCharDraugrMelee2HFemale"]),
                       ("draugr_missile", ["LCharDraugrMissileMale", "LCharDraugrMissileFemale"]),
                       ("draugr_warlock", ["LCharDraugrWarlockMale", "LCharDraugrWarlockFemale"])],
        "chain": r"^LCharDraugr(Melee|Missile|Warlock)", "edid": r"^(DLC1|DLC2)?LvlDraugr", "expect": (14, 24),
        "plugins": {"Skyrim.esm", "Update.esm", "Dawnguard.esm", "BSHeartland.esm", "BSAssets.esm"},
    },
    # Solstheim's rieklings on foot. The boar riders have their own list, but most of the friendly Thirsk tribe chain to
    # these same hostile lists, so they are held out by editor id.
    "solstheim.riekling": {
        "archetypes": [("riekling_melee", ["DLC2LCharRieklingMelee"]), ("riekling_missile", ["DLC2LCharRieklingMissile"])],
        "chain": r"^DLC2LCharRiekling(Melee|Missile)$", "edid": r"^DLC2LvlRiekling", "deny": r"Thirsk|PillarBuilder",
        "expect": (13, 104),
    },
    "skyrim.witch": {
        "archetypes": [("witch_fire_mage", ["LCharWitchFire"]), ("witch_frost_mage", ["LCharWitchIce"]), ("witch_storm_mage", ["LCharWitchStorm"])],
        "chain": r"^LCharWitch", "edid": r"^(DLC1)?Lvl",
        "expect": (3, 6),
    },
}

# --- leveled actor lists and NPC bases (winning versions); levels as dungeons_build.py resolves them ---
lvln, npcs, lvln_by_edid, lvln_edid, npc_by_edid = {}, {}, {}, {}, {}
for p in lo.plugins:
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ('LVLN', 'NPC_')):
        c = lo.canon(p, fid)
        sub = lo.subrecords(p, off, sz, fl)
        e = edid(p, off, sz, fl)
        if t == 'LVLN':
            body = lo.body(p, off, sz, fl)
            entries = []
            for s, v in esplib.subrecords(body):
                if s == b'LVLO' and len(v) >= 8:
                    lvl, _, ref = struct.unpack('<HHI', bytes(v[:8]))
                    entries.append((lvl, lo.canon(p, ref)))
            lvln[c] = entries
            lvln_by_edid[e] = c; lvln_edid[c] = e
        else:
            acbs = sub.get(b'ACBS', b'')
            # ACBS: flags uint32 @0, level uint16 @8 (a multiplier when PC Level Mult 0x80 is set)
            flags = struct.unpack('<I', acbs[:4])[0] if len(acbs) >= 4 else 0
            lvl = struct.unpack('<H', acbs[8:10])[0] if len(acbs) >= 10 else 1
            tplt = sub.get(b'TPLT', b'')
            npcs[c] = {"edid": e, "level": lvl, "pcMult": bool(flags & 0x80), "unique": bool(flags & 0x20),
                       "tplt": lo.canon(p, struct.unpack('<I', tplt[:4])[0]) if len(tplt) >= 4 else None}
            npc_by_edid[e] = c
# placed actors' record flags (winning version), for Starts Dead
achr_flags = {}
for p in lo.plugins:
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ('ACHR',)):
        achr_flags[lo.canon(p, fid)] = fl
# refs a quest alias forces (ALFR) in any version of any quest, and the (location, location ref type) pairs a quest
# fills through a location alias (ALFA + ALRT): scene actors (dunSceneRef*), and a Boss only when the quest names it
# (ALDN), like Pinewatch's boss shown as Rigel Strong-Arm. An unnamed Boss alias is the generic "clear the dungeon" one.
alias_refs, named_slots = set(), set()
for p in lo.plugins:
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ('QUST',)):
        loc_alias, ref_aliases, cur = {}, [], None
        for sig, v in esplib.subrecords(lo.body(p, off, sz, fl)):
            v = bytes(v)
            if sig == b'ALLS': cur = {"loc": struct.unpack('<I', v[:4])[0]}
            elif sig == b'ALST': cur = {}; ref_aliases.append(cur)
            elif cur is None or len(v) < 4: continue
            elif sig == b'ALFL' and "loc" in cur: loc_alias[cur["loc"]] = lo.canon(p, struct.unpack('<I', v[:4])[0])
            elif sig == b'ALFR': alias_refs.add(lo.canon(p, struct.unpack('<I', v[:4])[0]))
            elif sig == b'ALFA': cur["alfa"] = struct.unpack('<I', v[:4])[0]
            elif sig == b'ALRT': cur["alrt"] = lo.canon(p, struct.unpack('<I', v[:4])[0])
            elif sig == b'ALDN': cur["named"] = True
        for a in ref_aliases:
            if a.get("alrt") and a.get("alfa") in loc_alias:
                named_slots.add((loc_alias[a["alfa"]], a["alrt"], bool(a.get("named"))))
BOSS_REF_TYPE = next(lo.canon(p, fid) for p in lo.plugins for ri, t, fid, fl, off, sz, ctx in lo.records(p, ('LCRT',))
                     if edid(p, off, sz, fl) == "Boss")
named_slots = {(loc, rt) for loc, rt, named in named_slots if named or rt != BOSS_REF_TYPE}
# dungeon ids are location editor ids; placed actors' location ref types (XLRT)
lctn_by_edid = {}
for p in lo.plugins:
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ('LCTN',)):
        lctn_by_edid[edid(p, off, sz, fl)] = lo.canon(p, fid)

# same as dungeons_build.py: the word 'Undead' is an enemy type, so it comes out before 'dead' is looked for
UNDEAD = re.compile(r'Undead|undead|UNDEAD')
SKIP = ('corpse', 'dead', 'dummy', 'marker', 'rigid', 'testnpc', 'victim', 'prisoner', 'captive', 'sleeping')
def is_skip(edid):
    e = UNDEAD.sub('', edid).lower()
    return any(w in e for w in SKIP)
def resolve(canon, depth=0):
    """concrete NPC_ options as [(level, canon)] for a leveled list or NPC"""
    if depth > 6: return []
    if canon in npcs:
        n = npcs[canon]
        if is_skip(n["edid"]): return []
        if n["tplt"] and n["tplt"] in lvln: return resolve(n["tplt"], depth + 1)
        if n["tplt"] and n["tplt"] in npcs and n["tplt"] != canon:
            deeper = resolve(n["tplt"], depth + 1)
            if len(deeper) > 1: return deeper
        return [(n["level"] if not n["pcMult"] else 0, canon)]
    out = []
    for lvl, ref in lvln.get(canon, []):
        for l2, c2 in resolve(ref, depth + 1):
            out.append((lvl if ref in npcs else max(lvl, l2), c2))
    best = {}
    for lvl, c2 in out:
        if c2 not in best or lvl < best[c2]: best[c2] = lvl
    return sorted((lvl, c2) for c2, lvl in best.items())

def template_chain(canon):
    """(NPC_ editor ids along the TPLT chain, itself first; editor id of the first leveled list reached)"""
    names, seen = [], set()
    while canon in npcs and canon not in seen:
        seen.add(canon); names.append(npcs[canon]["edid"])
        canon = npcs[canon]["tplt"]
    return names, lvln_edid.get(canon, "")

errors, warnings = [], []
def archetype(fid, province, kind, lists):
    allowed = SPEC[fid].get("plugins") or PROVINCE_PLUGINS[province]
    options = {}
    for name in lists:
        c = lvln_by_edid.get(name)
        if not c:
            errors.append(f"{fid} {kind}: leveled list {name} not in the load order"); continue
        if origin(c) not in allowed:
            errors.append(f"{fid} {kind}: {name} comes from {origin(c)}, not {province}")
        for lvl, n in resolve(c):
            # a later plugin can inject other provinces' NPCs or a unique into a list; drop those, keep the rest
            if npcs[n]["unique"]: warnings.append(f"{fid} {kind}: {name} dropped unique {npcs[n]['edid']}"); continue
            if origin(n) not in allowed:
                warnings.append(f"{fid} {kind}: {name} dropped {npcs[n]['edid']} from {origin(n)}"); continue
            if n not in options or lvl < options[n]: options[n] = lvl
    if not options: errors.append(f"{fid} {kind}: no options")
    return {"kind": kind, "lists": lists, "options": [[lvl, desc(n), npcs[n]["edid"]] for n, lvl in sorted(options.items(), key=lambda x: (x[1], x[0]))]}

families = {}
for fid, spec in SPEC.items():
    if not (spec.get("chain") or spec.get("edid")): errors.append(f"{fid}: needs a chain or edid rule")
    province = fid.split('.', 1)[0]
    families[fid] = {"province": province,
                     "archetypes": [archetype(fid, province, k, l) for k, l in spec["archetypes"]],
                     "boss": [archetype(fid, province, k, l) for k, l in spec.get("boss", [])]}
union = {fid: {o[1] for a in f["archetypes"] + f["boss"] for o in a["options"]} for fid, f in families.items()}
rx = lambda fid, key: re.compile(SPEC[fid][key]) if SPEC[fid].get(key) else None

# --- province of each dungeon: its entrances' worldspace, else what its records come from ---
DUNGEONS_BYTES = open(SERVER + r"\dungeons.json", "rb").read()
DUNGEONS = json.loads(DUNGEONS_BYTES)["dungeons"]
placed_refs = {canon_of(n["ref"]) for d in DUNGEONS for z in d["zones"] for n in z["npcs"]}
ref_types = collections.defaultdict(set)
for p in lo.plugins:
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ('ACHR',)):
        c = lo.canon(p, fid)
        if c not in placed_refs: continue
        ref_types[c] = {lo.canon(p, struct.unpack_from('<I', v, i)[0]) for sig, v in esplib.subrecords(lo.body(p, off, sz, fl))
                        if sig == b'XLRT' for i in range(0, len(v) - 3, 4)}
def province_of(d):
    votes = collections.Counter(PROVINCE_OF_PLUGIN.get((e.get("world") or ":").split(':', 1)[1]) for e in d["entrances"])
    votes.pop(None, None)
    top = votes.most_common(2)
    if top and (len(top) == 1 or top[0][1] > top[1][1]): return top[0][0]
    s = json.dumps(d)
    if re.search(r"BSHeartland|BSAssets", s, re.I): return "cyrodiil"
    if re.search(r"Dragonborn|DLC2Solstheim", s, re.I): return "solstheim"
    return "skyrim"
provinces = {d["id"]: province_of(d) for d in DUNGEONS}

# --- membership, decided once per (province, placement editor id) ---
def family_for(province, pedid, opts):
    base = npc_by_edid.get(pedid)
    if not base or origin(base) in CURATION: return None
    if not GENERIC.search(pedid) or NEVER.search(pedid): return None
    if not opts or any(npcs.get(canon_of(o), {}).get("unique") for o in opts): return None
    names, first_list = template_chain(base)
    hits = []
    for fid in families:
        if not fid.startswith(province + '.'): continue
        # every family has a positive rule (chain or edid); the subset test below is the safety net
        r = rx(fid, "edid")
        if r and not r.search(pedid): continue
        r = rx(fid, "deny")
        if r and r.search(pedid): continue
        r = rx(fid, "chain")
        if r and not r.search(first_list): continue
        r = rx(fid, "chainNpc")
        if r and not any(r.search(n) for n in names): continue
        r = rx(fid, "notChainNpc")
        if r and any(r.search(n) for n in names): continue
        if not opts <= union[fid]:
            warnings.append(f"{province}|{pedid} matches {fid}'s rule but resolves outside it, left vanilla"); continue
        hits.append(fid)
    if len(hits) > 1: errors.append(f"{province}|{pedid} fits several families: {hits}")
    return hits[0] if len(hits) == 1 else None

placements, keep, seen = {}, set(), {}
slots, edids = collections.Counter(), collections.defaultdict(set)
for d in DUNGEONS:
    province = provinces[d["id"]]
    location = lctn_by_edid.get(d["id"])
    for z in d["zones"]:
        for n in z["npcs"]:
            key = f"{province}|{n['edid']}"
            if key not in seen: seen[key] = family_for(province, n["edid"], {o[1] for o in n["options"]})
            fid = seen[key]
            if not fid: continue
            ref = canon_of(n["ref"])
            named = any((location, rt) in named_slots for rt in ref_types.get(ref, ()))
            if origin(ref) in CURATION or achr_flags.get(ref, 0) & STARTS_DEAD or ref in alias_refs or named or ref in KEEP_REFS:
                keep.add(n["ref"]); continue
            opts = [canon_of(o[1]) for o in n["options"]]
            boss = bool(re.search("boss", n["edid"], re.I)) or all("boss" in npcs[o]["edid"].lower() for o in opts if o in npcs)
            placements[key] = {"family": fid, "boss": boss}
            slots[fid] += 1; edids[fid].add(n["edid"])
for fid, spec in SPEC.items():
    got = (len(edids[fid]), slots[fid])
    if spec.get("expect") and tuple(spec["expect"]) != got:
        errors.append(f"{fid}: expected {spec['expect'][0]} placement ids / {spec['expect'][1]} slots, rule selects {got[0]} / {got[1]}: {sorted(edids[fid])}")
    for a in families[fid]["archetypes"] + families[fid]["boss"]:
        if len(a["options"]) < 3: warnings.append(f"{fid} {a['kind']}: only {len(a['options'])} options")

for w in warnings: print("warning: " + w)
if errors:
    print("NOT WRITTEN, %d problem(s):" % len(errors))
    for e in errors: print("  " + e)
    sys.exit(1)
out = sys.argv[1] if len(sys.argv) > 1 else SERVER + r"\dungeon-pools.json"
with open(out + ".tmp", "w") as f:   # replaced in one step, so a gamemode reload never reads half a file
    json.dump({"_comment": "Generated by ck-mcp\\dungeon_pools.py from the load order's leveled lists. families: one faction in one province, each archetype a set of root leveled lists resolved to concrete NPC_ options [level, desc, editor id]. placements: '<province>|<placement editor id>' -> {family, boss}; such a placement may become any archetype of its family (boss placements only boss archetypes). keep: refs never swapped (DragonBreak curation, Starts Dead corpses, quest alias actors, set pieces). provinces: dungeon id -> province by entrance worldspace. source: sha1 of the dungeons.json this was built from; dungeons.js warns when it differs. Unlisted placements stay vanilla. Used by server\\dungeons.js.",
               "source": {"dungeons.json": hashlib.sha1(DUNGEONS_BYTES).hexdigest()},
               "provinces": provinces, "families": families, "placements": dict(sorted(placements.items())), "keep": sorted(keep)}, f, indent=1)
os.replace(out + ".tmp", out)
for fid, f in families.items():
    print(f"{fid}: {len(edids[fid])} placement ids, {slots[fid]} slots |", ", ".join(f"{a['kind']} {len(a['options'])}" for a in f["archetypes"]), "| boss", ", ".join(f"{a['kind']} {len(a['options'])}" for a in f["boss"]) or "-")
print("families", len(families), "placement ids", len(placements), "kept refs", len(keep))
