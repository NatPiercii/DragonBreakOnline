"""Builds server/faction-gear.json: which crafted items only a faction's own smiths and tailors may make (factiongear.js).

Nate, 2026-09-28: "legion armor can only be made by Imperial legion faction, hold armor per hold blacksmith, Orcish
Clan for the strongholds, etc", armor and weapons, and the unclear sets tied as he chose: Akaviri Samurai to the Blades,
Wolf and Skyforge to the Companions, vampire gear to the vampire clans, Penitus Oculatus to the Legion, and the modded
silver gear (not the base game's) to the Silver Hand.

Reads regions.json (ck-mcp/regions.py: every creation recipe with its product, name and bench) and matches each
recipe's product name, recipe editor id and plugin against the SETS below. Ammunition and anything not made at a forge,
the Skyforge, the Dawnguard forge, a loom or a tanning rack is left out. The result lists items, not recipes: some items
have recipes in several mods, and the gate is on what is made.
  python3 tools/faction_gear.py            (from server/, writes faction-gear.json)
"""
import json, re, sys, os

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.dirname(HERE)
recipes = json.load(open(os.path.join(SERVER, 'regions.json')))['recipes']

HOLDS = {'Falkreath': 'hold-falkreath', 'Hjaalmarch': 'hold-morthal', 'Markarth': 'hold-markarth', 'Pale': 'hold-dawnstar',
         'Riften': 'hold-riften', 'Solitude': 'hold-solitude', 'Whiterun': 'hold-whiterun', 'Windhelm': 'hold-windhelm',
         'Winterhold': 'hold-winterhold'}
CLANS = ['clan-gol-kharzum', 'clan-mor-khazgur', 'clan-dushnikh-yal', 'clan-largashbur', 'clan-narzulbur', 'clan-cracked-tusk']
VAMPIRES = ['clan-volkihar', 'cyrodiil-vampyrum-order', 'crimson-scars', 'bloodmist-clan']

# (set name, factions, name regex, extra test on (name, recipe edid, plugin))
SETS = [
    # Not 'Steel Imperial': those gauntlets are plain steel (ArmorSteelGauntletsB), not Legion work (faction parity, 6 Oct)
    ('Imperial Legion', ['imperial-legion'], r"^(Imperial (?!City Stew)|Heroic Imperial|General Tullius|Penitus Oculatus)", None),
    ('Stormcloaks', ['stormcloaks'], r"^(Stormcloak|Heroic Stormcloak|Ulfric's)", None),
    ('Dawnguard', ['dawnguard'], r"^Dawng(ua|au)rd", None),
    ('Blades', ['blades'], r"^(Blades |Akaviri Samurai|Dragonguard)", None),
    ('Companions', ['companions'], r"^(Wolf (Armor|Boots|Gauntlets|Helmet|Shield)|(Heavy|Light) Skyforge Shield)$", None),
    ('Thieves Guild', ['thieves-guild'], r"^(Thieves Guild|Guild Master's)", None),
    ('Nightingales', ['cult-nocturnal'], r"^(Nightingale|Karliah's)", None),
    ('Dark Brotherhood', ['dark-brotherhood'], r"^(Shrouded|Ancient Shrouded|Dark Brotherhood)", None),
    ('Thalmor', ['thalmor'], r"^(Hooded )?Thalmor", None),
    ('College of Winterhold', ['college-of-winterhold'], r"^((Hooded )?Arch-Mage's|College Boots|College of Winterhold)", None),
    ('Vampire clans (royal)', ['clan-volkihar'], r"^Vampire Royal Armor$", None),
    ('Vampire clans', VAMPIRES, r"^Vampire (Armor|Boots|Gauntlets|Gloves|Hood|Robes)$", None),
    ('Orcish', CLANS, r"^Orcish (?!Arrow|Bolt)", None),
    # Modded silver only: Immersive Weapons' silver weapons and Immersive Armors' mantles, not the base game's
    ('Silver Hand', ['silver-hand'], r"(Silver (Longsword|Battle Staff|War Axe|Battleaxe|Scimitar|Nodachi|Katana|Wakizashi|Tanto|Hawk Bow|Sword)|Mantle of the Silver Hand)$",
     lambda n, e, p: p in ('Immersive Weapons.esp', 'Hothtrooper44_ArmorCompilation.esp')),
]
HOLD_RX = re.compile(r"^(%s) Guard('s (Armor|Helmet|Shield)| Cloak)$" % '|'.join(HOLDS))
# War uniforms that are not crafted, for factions whose uniform no recipe makes (Nate, 2026-09-28: "with wars, people
# have to wear the faction uniforms"): worn, never gated. Found in the Beyond Skyrim plugins by editor id.
UNIFORM_EXTRA = {
    'county-bruma': ['723cd:BSHeartland.esm'],                          # CYRArmorGuardCuirassBruma
    'synod': ['602972:BSAssets.esm', '82c2f:BSHeartland.esm'],          # CYRSynodRobes, CYRClothesSynodRobes
    # Windhelm's own guard kit from Sentinel - City Guards (the base game dresses them in Stormcloak cuirasses and has
    # only an Eastmarch helmet and shield): the two cuirasses are the uniform, the three helmets go with it (Nate)
    'hold-windhelm': ['815:Sentinel - City Guards.esp', '816:Sentinel - City Guards.esp', '819:Sentinel - City Guards.esp',
                      '81a:Sentinel - City Guards.esp', '81b:Sentinel - City Guards.esp'],
}
BENCHES = {'CraftingSmithingForge': 'blacksmith', 'CraftingSmithingSkyforge': 'blacksmith', 'DLC1CraftingDawnguard': 'blacksmith',
           'MCE_CraftingLoom': 'tailor', 'CraftingTanningRack': 'tailor'}

items = {}
for desc, r in recipes.items():
    name, edid, bench = r.get('name', ''), r.get('edid', ''), r.get('bench', '')
    plugin = desc.split(':', 1)[1] if ':' in desc else ''
    if bench not in BENCHES or not r.get('item') or re.search(r'Temper', edid): continue
    hit = None
    m = HOLD_RX.match(name)
    if m: hit = ('%s Guard' % m.group(1), [HOLDS[m.group(1)]])
    else:
        for set_name, factions, rx, extra in SETS:
            if re.search(rx, name) and (extra is None or extra(name, edid, plugin)):
                hit = (set_name, factions); break
    if not hit: continue
    item = r['item']
    role = BENCHES[bench]
    cur = items.get(item)
    if cur:
        cur['recipes'].append(desc)
        if role != cur['role']: cur['role'] = 'blacksmith'   # made at a forge anywhere: the smith's work
        continue
    items[item] = {'name': name, 'set': hit[0], 'factions': hit[1], 'role': role, 'recipes': [desc]}

out = {
    '_comment': 'Faction gear (server/factiongear.js; built by tools/faction_gear.py from regions.json, edit the SETS there '
                'and re-run, or edit an entry here by hand). An item listed here may be crafted only by a member of one of '
                'its factions whose rank role is its role (blacksmith for forge work, tailor for the loom and tanning rack) '
                'or leader. Nate, 2026-09-28: faction armor and weapons. The Orcish Clan set (no recipe; staff hand it out) and '
                'later sets were added here by hand: this script no longer reproduces the file, so edit the file.',
    'items': dict(sorted(items.items(), key=lambda kv: (kv[1]['set'], kv[1]['name']))),
    '_uniformsComment': 'War uniforms (realm.js, config war.uniforms): in a battle only fighters wearing a body piece of their '
                        "faction's uniform count at a standard. A faction's uniform is its items above plus these worn-only "
                        'extras; a faction with neither (the Fighters Guild today) is not held to it.',
    'uniforms': UNIFORM_EXTRA,
}
json.dump(out, open(os.path.join(SERVER, 'faction-gear.json'), 'w'), indent=1, ensure_ascii=False)
from collections import Counter
print(len(items), 'items')
for s, n in sorted(Counter(v['set'] for v in items.values()).items()): print(' %-26s %d' % (s, n))
