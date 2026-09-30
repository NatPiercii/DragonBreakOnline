#!/usr/bin/env python3
"""Self-test for tools/recipes: the tier rules, the tables in step with each other, and the gate.

    python3 tools/recipes/test_recipes.py [census.json]

With no census it takes one of the live plugins first (recipe_census.py, a few seconds, read only). The gate is tested
by simulating a correct PC run on that census (every listed recipe loses its HasPerk and gains its markers) and
checking it passes, then breaking it in each way the gate must catch.
"""
import copy, json, os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import make_tables as mt  # noqa: E402
import verify_recipes as vr  # noqa: E402

fails = 0


def ok(cond, what, got=None):
    global fails
    print(('ok   ' if cond else 'FAIL ') + what + ('' if cond or got is None else f'   {got}'))
    if not cond:
        fails += 1


# ---- the cook rules -------------------------------------------------------------------------------------------------
dish = lambda **k: dict({'bench': 'CraftingCookpot', 'file': 'Skyrim.esm', 'resultEdid': 'FoodX', 'value': 5,
                         'ingredients': [{}, {}], 'effects': []}, **k)
ok(mt.cook_tier(dish())[0] == 1, 'salt and one meat is tier 1')
ok(mt.cook_tier(dish(ingredients=[{}] * 3))[0] == 2, 'three ingredients is tier 2')
ok(mt.cook_tier(dish(bench='BYOHCraftingOven'))[0] == 3, 'anything baked at the oven is tier 3')
ok(mt.cook_tier(dish(file='Journey to Baan Malur.esp'))[0] == 3, 'a Morrowind dish is tier 3')
ok(mt.cook_tier(dish(value=40))[0] == 3, 'a rare catch is tier 3')
ok(mt.cook_tier(dish(effects=[{'effect': 'FoodRestoreHealthDuration', 'duration': 720}]))[0] == 4, 'restoring over time is tier 4')
ok(mt.cook_tier(dish(effects=[{'effect': 'ccBGSSSE037_AlchDamageHealthDuration', 'duration': 60}]))[0] == 1, 'a damaging effect is not restorative')
ok(mt.cook_tier(dish(effects=[{'effect': 'FoodFortifyStamina', 'duration': 720}]))[0] == 5, 'a long Fortify is tier 5')
ok(mt.cook_tier(dish(effects=[{'effect': 'Survival_FoodFortifyWarmth', 'duration': 300}]))[0] == 1, "Survival Mode's warmth is ignored")

# ---- the forge rules ------------------------------------------------------------------------------------------------
rules = mt.load_rules()
rec = lambda edid='X', kws=(), perks=(): {'resultEdid': edid, 'resultKeywords': list(kws),
                                        'conditions': [{'func': 'HasPerk', 'param': p} for p in perks]}
ok(mt.forge_tier(rec(kws=['ArmorMaterialIron']), rules)[:1] == (1,), 'iron is tier 1')
ok(mt.forge_tier(rec(kws=['ArmorMaterialElven']), rules)[0] == 2, 'elven is tier 2, as the players read it')
ok(mt.forge_tier(rec(kws=['ArmorMaterialScaled']), rules)[0] == 3, 'scaled is tier 3, as the players read it')
ok(mt.forge_tier(rec(kws=['ArmorMaterialEbony']), rules)[0] == 4, 'ebony is tier 4')
ok(mt.forge_tier(rec(kws=['WeapMaterialDaedric']), rules)[0] == 5, 'Daedric is tier 5')
t = mt.forge_tier(rec(edid='CYRArmorChainmailCuirass', kws=['ArmorMaterialIron']), rules)
ok(t[0] == 2 and t[3] == 'Chainmail', 'Beyond Skyrim chainmail is tier 2 with the Chainmail manual, whatever its keyword says', t)
t = mt.forge_tier(rec(kws=['ArmorMaterialDragonplate', 'IAKMaterialSteel']), rules)
ok(t[0] == 5 and t[3] == 'Dragon', 'the highest keyword decides, and brings its manual', t)
t = mt.forge_tier(rec(kws=['WAF_MaterialFaction'], perks=['SteelSmithing', 'EbonySmithing']), rules)
ok(t[0] == 4 and t[3] == 'Ebony' and t[1].startswith('perk'), 'an unlisted material falls back to its perks, the highest', t)
t = mt.forge_tier(rec(), rules)
ok(t == (1, 'default', 'review', ''), 'nothing known: tier 1, marked for review', t)
ok(mt.forge_tier(rec(kws=['ArmorMaterialIron']), rules)[3] == '', 'tier 1 metals need no manual')

# ---- the tables agree -----------------------------------------------------------------------------------------------
manuals = {m['manual'] for m in vr.load_manuals()}
ok(all(os.path.exists(os.path.join(HERE, 'manuals', m + '.txt')) for m in manuals), 'every manual has its text')
used = {row['manual'] for row in mt.read_csv(mt.FORGE_CSV).values() if row['manual']}
ok(used <= manuals, 'every manual the forge table names is in manuals.tsv', used - manuals)
ok(not (manuals - used), 'every manual in manuals.tsv is used by a recipe', manuals - used)
with tempfile.TemporaryDirectory() as d:
    keep = mt.TSV
    mt.TSV = os.path.join(d, 'x.tsv')
    mt.tsv()
    ok(open(mt.TSV).read() == open(keep).read(), 'recipe_tiers.tsv is what make_tables.py tsv makes of the CSVs (run it after editing them)')
    mt.TSV = keep

# ---- the gate -------------------------------------------------------------------------------------------------------
census = sys.argv[1] if len(sys.argv) > 1 else None
if not census:
    census = os.path.join(tempfile.mkdtemp(prefix='claude-nate-recipes-'), 'census.json')
    subprocess.run([sys.executable, os.path.join(HERE, 'recipe_census.py'), census], check=True, stdout=subprocess.DEVNULL)
before = json.load(open(census))
table = vr.load_table()


def marker(name):
    return {'func': 'HasSpell', 'fn': 264, 'op': '==', 'or': False, 'comp': 1.0, 'compIsGlobal': False,
            'param': name, 'paramType': 'SPEL', 'runOn': 0, 'raw': ''}


def run(after):
    for r in after['recipes']:
        w = table.get(r['key'])
        if w:
            r['conditions'] = [c for c in r['conditions'] if c['func'] != 'HasPerk'] + [marker(w[1])] + ([marker(w[2])] if w[2] else [])
    return after


good = run(copy.deepcopy(before))
ok(vr.check_recipes(before, good, table) == [], 'a correct run passes', vr.check_recipes(before, good, table)[:3])
perked = [r for r in good['recipes'] if r['key'] in table and any(c['func'] == 'HasPerk' for c in
          next(x for x in before['recipes'] if x['key'] == r['key'])['conditions'])][0]
listed = [r for r in good['recipes'] if r['key'] in table and table[r['key']][2]][0]


def broken(change):
    after = copy.deepcopy(good)
    change({r['key']: r for r in after['recipes']})
    return vr.check_recipes(before, after, table)


f = broken(lambda a: a[perked['key']]['conditions'].append(dict(marker('SteelSmithing'), func='HasPerk', fn=448)))
ok(any('HasPerk is left' in x for x in f), 'a HasPerk left behind is caught', f[:2])
f = broken(lambda a: a[listed['key']]['conditions'].__setitem__(-2, marker('DBO_Skill_blacksmith_T1')))
ok(any('HasSpell' in x or 'other DBO' in x for x in f), 'the wrong tier marker is caught', f[:2])
f = broken(lambda a: a[listed['key']]['conditions'].pop())
ok(any(table[listed['key']][2] in x for x in f), 'a missing manual marker is caught', f[:2])
f = broken(lambda a: a[listed['key']]['conditions'][-1].__setitem__('or', True))
ok(any('== 1' in x or 'OR' in x for x in f), 'an ORed marker is caught', f[:2])
f = broken(lambda a: a[listed['key']]['ingredients'][0].__setitem__('count', 99))
ok(any('ingredients' in x for x in f), 'a changed ingredient is caught', f[:2])
f = broken(lambda a: a[listed['key']]['conditions'].insert(0, dict(marker('x'), func='GetItemCount', param='IronOre')))
ok(any('other conditions' in x for x in f), 'an added unrelated condition is caught', f[:2])
# every recipe at these stations is in the table, so take one out of a copy of it: that recipe was then changed
# without the table asking
one = listed['key']
t2 = {k: v for k, v in table.items() if k != one}
f = vr.check_recipes(before, good, t2)
ok(any(one in x and 'not in the table' in x for x in f), 'a recipe outside the table that changed is caught', f[:2])

print(f'\n{"all checks passed" if not fails else str(fails) + " FAILED"}')
sys.exit(1 if fails else 0)
