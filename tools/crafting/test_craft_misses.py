#!/usr/bin/env python3
"""Checks for craft_misses.py's parser and classifier on synthetic log lines (no load order, no sudo):
    python3 tools/crafting/test_craft_misses.py"""
import datetime, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import craft_misses as cm

fails = 0


def ok(c, what, got=None):
    global fails
    print(('PASS  ' if c else 'FAIL  ') + what + ('' if c or got is None else f'   {got!r}'))
    fails += 0 if c else 1


def miss(t, inputs, bench, result):
    ent = ','.join('{"baseId":%d,"count":%d}' % (i, c) for i, c in inputs)
    return f'[{t}.000] [error] Recipe not found: inputObjects={{"entries":[{ent}]}}, workbenchId=0x{bench:x}, resultObjectId=0x{result:x}'


LAB, FORGE, RACK = 0x0807114D, 0x3C12AE11, 0x08067F96
LAB_KW, FORGE_KW, RACK_KW = ['isAlchemy', 'WICraftingAlchemy'], ['isBlacksmithForge', 'CraftingSmithingForge'], ['isTanning', 'CraftingTanningRack']
A, B, POTION = 0x0004DA00, 0x076018D7, 0xFF001496
IRON, STRIPS, HELM, PELT, LEATHER = 0x0005ACE4, 0x000800E4, 0x05000821, 0x080A0001, 0x000DB5D2
lines = [
    miss('2026-09-29 22:00:00', [(A, 1), (B, 1)], LAB, POTION),
    '[2026-09-29 22:00:00.100] [console] [info] [gamemode] alchemy: Someone #AAAA brewed RestoreHealth01 (Restore Health, tier 1) from A + B',
    miss('2026-09-29 22:00:05', [(A, 1), (A, 1)], LAB, POTION),
    miss('2026-09-23 20:00:00', [(A, 1), (B, 1)], LAB, POTION),
    miss('2026-09-29 22:01:00', [(A, 1), (B, 1)], LAB, POTION),
    '[2026-09-29 22:01:00.200] [console] [info] [gamemode] alchemy: Someone #AAAA mixed A + B and nothing matched; effects x',
    miss('2026-09-25 22:47:24', [(IRON, 3), (STRIPS, 2)], FORGE, HELM),
    miss('2026-09-25 22:47:30', [(HELM, 1)], FORGE, STRIPS),
    miss('2026-09-23 22:25:10', [(PELT, 1)], RACK, LEATHER),
    miss('2026-09-23 22:30:00', [(IRON, 9)], FORGE, 0x0000DEAD),
    '[2026-09-29 22:02:00.000] [console] [info] something else entirely',
]
ev = cm.parse(lines)
ok(len(ev) == 8, 'parse: 8 "Recipe not found" lines, other lines ignored', len(ev))
ok(ev[0]['inputs'] == [(A, 1), (B, 1)] and ev[0]['bench'] == LAB and ev[0]['result'] == POTION, 'parse: inputs, bench and result read back')
ok(len(ev[0]['after']) == 1 and 'brewed' in ev[0]['after'][0], 'parse: the alchemy line within 3 s is attached to its craft')
ok(ev[1]['after'] == [], 'parse: a later craft\'s alchemy line is not attached to an earlier one outside 3 s')
RECIPES = {HELM: [(None, {IRON: 3, STRIPS: 2}), ('CraftingSmithingArmorTable', {IRON: 1})], LEATHER: [('CraftingTanningRack', {PELT: 1})]}
recent = set()
kw = {LAB: LAB_KW, FORGE: FORGE_KW, RACK: RACK_KW}
got = []
for e in ev:
    c = cm.classify(e, kw[e['bench']], lambda r: RECIPES.get(r, []), recent)
    if c in ('no-bench-keyword', 'recipe-exists', 'no-recipe'):
        recent.add(e['result'])
    got.append(c)
ok(got[0] == 'lab-brewed', 'a lab mix alchemy.js brewed is a success logged as a miss', got[0])
ok(got[1] == 'lab-repeated', 'one ingredient reported twice at a lab is the client report problem', got[1])
ok(got[2] == 'lab-before-module', 'a lab mix before alchemy.js loaded (23 Sep 23:36)', got[2])
ok(got[3] == 'lab-refused', 'a lab mix alchemy.js refused on purpose', got[3])
ok(got[4] == 'no-bench-keyword', 'a forge craft matching a recipe with no workbench keyword (Sentinel)', got[4])
ok(got[5] == 'rollback-echo', 'crafting the item a refused craft just gave back is an echo', got[5])
ok(got[6] == 'recipe-exists', 'a tanning craft whose recipe exists at this bench was refused by a server rule', got[6])
ok(got[7] == 'no-recipe', 'nothing makes this product from these inputs: a COBJ is missing', got[7])
print('all checks passed' if not fails else f'{fails} FAILED')
sys.exit(1 if fails else 0)
