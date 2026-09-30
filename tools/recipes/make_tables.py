#!/usr/bin/env python3
"""The Cook's and the Blacksmith's recipe tiers: proposes them, keeps Nate's edits, and writes what the PC script reads.

    python3 tools/recipes/make_tables.py propose <census.json>   write/refresh cook_tiers.csv and forge_tiers.csv
    python3 tools/recipes/make_tables.py tsv                     cook_tiers.csv + forge_tiers.csv -> recipe_tiers.tsv

`propose` reads a recipe_census.py census. A recipe already in a CSV keeps the tier in its `tier` column (so a hand
edit survives a refresh after a plugin change); a new recipe gets the proposed tier; `proposed` always shows what the
rules say, so a hand edit is the rows where the two differ. Recipes that left the load order are dropped and named.
`tsv` validates the CSVs (tier 1-5, a manual that manuals.tsv lists, no duplicate) and writes recipe_tiers.tsv, the one
file DBO_BlacksmithTiers.pas and verify_recipes.py read: origin plugin, local form id, recipe editor id, tier marker
spell, manual marker spell (or -).

Cook tiers (skills.json cook.tiers: Simple meals, Hearty meals, Feast dishes, Restorative dishes, Banquet fare with
long buffs), the first rule that fits from the top:
  5  a Fortify effect lasting 5 minutes or more
  4  a restore-over-time effect (the ...Duration food effects) or a potion-like one (resist, fortify, cure)
  3  baked at the oven, a Morrowind dish (Journey to Baan Malur), a poisoner's dish, five or more ingredients, or a
     rare catch or dish worth 15 gold or more
  2  three or four ingredients
  1  the rest: salt and one thing, or a plain drink
Survival Mode's hunger and warmth effects are ignored (they come with every dish when that mode is on).
Forge tiers and manuals: forge_rules.tsv. Cooking has no manuals.
"""
import csv, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
COOK_CSV = os.path.join(HERE, 'cook_tiers.csv')
FORGE_CSV = os.path.join(HERE, 'forge_tiers.csv')
RULES = os.path.join(HERE, 'forge_rules.tsv')
MANUALS = os.path.join(HERE, 'manuals.tsv')
TSV = os.path.join(HERE, 'recipe_tiers.tsv')
MARKER = 'DBO_Skill_%s_T%d'
COOK_COLS = ['tier', 'proposed', 'why', 'recipe', 'recipeEdid', 'file', 'bench', 'result', 'value', 'ingredients',
             'effects', 'shownToday']
FORGE_COLS = ['tier', 'manual', 'proposed', 'proposedManual', 'how', 'review', 'recipe', 'recipeEdid', 'file', 'bench', 'result', 'resultType',
              'materials', 'perks', 'otherConditions']


def cook_tier(r):
    eff = [e for e in r.get('effects', []) if not e['effect'].startswith('Survival_')]
    n = len(r['ingredients'])
    if any('Fortify' in e['effect'] and e.get('duration', 0) >= 300 for e in eff):
        return 5, 'a Fortify effect of 5 minutes or more'
    if any(e['effect'].endswith('Duration') and 'Damage' not in e['effect'] for e in eff):
        return 4, 'restores over time'
    if any(e['effect'].startswith('Alch') and 'Damage' not in e['effect'] for e in eff):
        return 4, 'a potion-like effect'
    if r['bench'] == 'BYOHCraftingOven':
        return 3, 'baked at the oven'
    if r['file'].lower().startswith('journey to baan malur'):
        return 3, 'a Morrowind dish'
    if 'poison' in (r.get('resultEdid') or '').lower():
        return 3, "a poisoner's dish"
    if n >= 5:
        return 3, 'five or more ingredients'
    if (r.get('value') or 0) >= 15:
        return 3, 'a rare catch or rich dish (15 gold or more)'
    if n >= 3:
        return 2, 'three or four ingredients'
    return 1, 'salt and one thing, or a plain drink'


def load_rules():
    rules = {'edid': [], 'keyword': {}, 'perk': {}, 'default': 1}
    for line in open(RULES, encoding='utf-8'):
        if not line.strip() or line.startswith('#'):
            continue
        f = line.rstrip('\n').split('\t')
        kind, sel, tier = f[0], f[1], int(f[2])
        manual = f[3].strip() if len(f) > 3 else ''
        if kind == 'edid':
            rules['edid'].append((re.compile('^' + '.*'.join(map(re.escape, sel.split('*'))) + '$', re.I), tier, sel, manual))
        elif kind in ('keyword', 'perk'):
            if sel in rules[kind]:
                sys.exit(f'forge_rules.tsv: {kind} {sel} is listed twice')
            rules[kind][sel] = (tier, manual)
        elif kind == 'default':
            rules['default'] = tier
        else:
            sys.exit(f'forge_rules.tsv: unknown kind {kind!r}')
    return rules


def forge_tier(r, rules):
    """(tier, how, review, manual) for a forge recipe"""
    edid = r.get('resultEdid') or ''
    for rx, tier, sel, manual in rules['edid']:
        if rx.match(edid):
            return tier, f'edid {sel}', '', manual
    for kind, found, how in (('keyword', [k for k in r.get('resultKeywords', []) if k in rules['keyword']], 'keyword'),
                             ('perk', sorted({c['param'] for c in r['conditions'] if c['func'] == 'HasPerk' and c['param'] in rules['perk']}), 'perk')):
        if found:
            # the highest tier decides, and its manual; among equals, the first that has one
            best = max(rules[kind][x][0] for x in found)
            manual = next((rules[kind][x][1] for x in found if rules[kind][x][0] == best and rules[kind][x][1]), '')
            return best, how + ' ' + '+'.join(found), '', manual
    return rules['default'], 'default', 'review', ''


def load_manuals():
    out = {}
    if os.path.exists(MANUALS):
        for line in open(MANUALS, encoding='utf-8'):
            if line.strip() and not line.startswith('#'):
                f = line.rstrip('\n').split('\t')
                out[f[0]] = f
    return out


def shown_today(r):
    why = sorted({c['func'] for c in r['conditions']})
    return 'yes' if not why else 'gated: ' + ','.join(why)


def read_csv(path):
    if not os.path.exists(path):
        return {}
    with open(path, newline='', encoding='utf-8') as fh:
        return {row['recipe']: row for row in csv.DictReader(fh)}


def write_csv(path, cols, rows):
    with open(path, 'w', newline='', encoding='utf-8') as fh:
        w = csv.DictWriter(fh, fieldnames=cols, lineterminator='\n')
        w.writeheader()
        for row in rows:
            w.writerow(row)


def propose(census):
    recipes = json.load(open(census))['recipes']
    rules = load_rules()
    old = {'cook': read_csv(COOK_CSV), 'blacksmith': read_csv(FORGE_CSV)}
    rows = {'cook': [], 'blacksmith': []}
    for r in recipes:
        base = {'recipe': r['key'], 'recipeEdid': r['edid'], 'file': r['file'], 'bench': r['bench'], 'result': r['resultEdid']}
        if r['skill'] == 'cook':
            t, why = cook_tier(r)
            row = dict(base, proposed=t, why=why, value=r.get('value'),
                       ingredients='; '.join(f"{i['item']}x{i['count']}" if i['count'] > 1 else i['item'] for i in r['ingredients']),
                       effects='; '.join(f"{e['effect']} {e.get('magnitude', 0):g}/{e.get('duration', 0)}s" for e in r.get('effects', []) if not e['effect'].startswith('Survival_')),
                       shownToday=shown_today(r))
        else:
            t, how, review, manual = forge_tier(r, rules)
            row = dict(base, proposed=t, proposedManual=manual, how=how, review=review, resultType=r['resultType'],
                       materials='+'.join(k for k in r.get('resultKeywords', []) if 'Material' in k),
                       perks='+'.join(sorted({c['param'] for c in r['conditions'] if c['func'] == 'HasPerk'})),
                       otherConditions='; '.join(f"{c['func']} {c['param']} {c['op']} {c['comp']}" for c in r['conditions'] if c['func'] != 'HasPerk'))
        prev = old[r['skill']].pop(r['key'], None)
        row['tier'] = prev['tier'] if prev and prev.get('tier') else t
        if r['skill'] == 'blacksmith':
            row['manual'] = prev['manual'] if prev and 'manual' in prev else row['proposedManual']
        rows[r['skill']].append(row)
    for skill, path, cols in (('cook', COOK_CSV, COOK_COLS), ('blacksmith', FORGE_CSV, FORGE_COLS)):
        rows[skill].sort(key=lambda x: (int(x['tier']), x['bench'], x['file'].lower(), x['result'] or ''))
        write_csv(path, cols, rows[skill])
        gone = old[skill]
        edited = sum(1 for x in rows[skill] if str(x['tier']) != str(x['proposed']) or x.get('manual', '') != x.get('proposedManual', ''))
        counts = [sum(1 for x in rows[skill] if int(x['tier']) == t) for t in range(1, 6)]
        print(f'{os.path.basename(path)}: {len(rows[skill])} recipes, by tier 1-5: {counts}; {edited} set by hand'
              + (f'; {sum(1 for x in rows[skill] if x.get("review"))} to review' if skill == 'blacksmith' else ''))
        for k in gone:
            print(f'  left the load order, dropped: {k} {gone[k].get("recipeEdid")}')


def tsv():
    out, seen = [], set()
    manuals = load_manuals()
    for skill, path in (('cook', COOK_CSV), ('blacksmith', FORGE_CSV)):
        for key, row in read_csv(path).items():
            t = str(row['tier']).strip()
            if t not in ('1', '2', '3', '4', '5'):
                sys.exit(f'{os.path.basename(path)}: {key} has tier {t!r}; it must be 1 to 5')
            if key in seen:
                sys.exit(f'{key} is in both tables')
            seen.add(key)
            man = (row.get('manual') or '').strip()
            if man and man not in manuals:
                sys.exit(f'{os.path.basename(path)}: {key} names manual {man!r}, which manuals.tsv does not list')
            local, origin = key.split(':', 1)
            out.append((origin, local.rjust(6, '0').upper(), row['recipeEdid'], MARKER % (skill, int(t)),
                        manuals[man][1] if man else '-'))
    out.sort(key=lambda x: (x[0].lower(), x[1]))
    with open(TSV, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write('# Written by make_tables.py tsv from cook_tiers.csv and forge_tiers.csv - edit those, never this file.\n')
        fh.write('# origin plugin\tlocal form id\trecipe editor id\ttier marker\tmanual marker (both HasSpell == 1; - = no manual)\n')
        for o in out:
            fh.write('\t'.join(o) + '\n')
    print(f'{os.path.basename(TSV)}: {len(out)} recipes, {sum(1 for o in out if o[4] != "-")} of them also need a manual')


if __name__ == '__main__':
    if len(sys.argv) >= 3 and sys.argv[1] == 'propose':
        propose(sys.argv[2])
    elif len(sys.argv) == 2 and sys.argv[1] == 'tsv':
        tsv()
    else:
        sys.exit(__doc__)
