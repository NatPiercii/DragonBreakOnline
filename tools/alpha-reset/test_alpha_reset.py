#!/usr/bin/env python3
# Tests for alpha_reset.py on temp folders only (never the live paths): the staff trail parser, the plan and apply on a
# small world with a known answer, the refusals. No plugins are read: a fake load order stands in.
#
#   python3 tools/alpha-reset/test_alpha_reset.py
import json
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import alpha_reset as ar  # noqa: E402

failures = 0


def check(label, ok, got=None):
    global failures
    print(('ok   ' if ok else 'FAIL ') + label + ('' if ok or got is None else '   ' + json.dumps(got, default=str)[:300]))
    if not ok:
        failures += 1


class FakeLO:
    # Skyrim.esm is 00, Dawnguard.esm 02; records by id
    RECS = {0x80697: ('ARMO', 'ClothesMinerClothes', 1), 0x80699: ('ARMO', 'ClothesMinerBoots', 1), 0xF: ('MISC', 'Gold001', 1),
            0xE3C16: ('WEAP', 'weapPickaxe', 5), 0x2F2F4: ('WEAP', 'Axe01', 5), 0x12FCD: ('SPEL', 'Candlelight', 0),
            0x12FD0: ('SPEL', 'Flames', 0), 0x92C48: ('SPEL', 'WerewolfChange', 0), 0x0200283B: ('SPEL', 'DLC1VampireChange', 0),
            0x1000: ('WEAP', 'IronSword', 25), 0x1d4ec: ('LIGH', 'Torch01', 2), 0x9151f: ('ACTI', 'RemovableTorch01', 0)}
    PLUG = {'skyrim.esm': 0x00, 'dawnguard.esm': 0x02}

    def id_of(self, desc):
        h, _, p = str(desc).partition(':')
        return (self.PLUG[p.lower()] << 24 | int(h, 16)) if p.lower() in self.PLUG else 0

    def record(self, fid):
        return self.RECS.get(fid)

    def name(self, fid):
        r = self.record(fid)
        return r[1] if r else '%08x' % fid


# Marker spells (DBO_Skill_<skill>_T<n>), 24 staff spells for the "give all" inference, a tome spell and a vampire's drain
MK = {('unarmed', t): 0x0A000100 + t for t in range(1, 6)}
MK.update({('scholar', t): 0x0A000200 + t for t in range(1, 6)})
STAFF24 = [0x0B000000 + i for i in range(24)]
TOME = 0x0C000001
DRAIN = 0x0008D5BF


class FakeLO2(FakeLO):
    RECS = dict(FakeLO.RECS)
    RECS.update({v: ('SPEL', f'DBO_Skill_{k[0]}_T{k[1]}', 0) for k, v in MK.items()})
    RECS.update({v: ('SPEL', f'StaffSpell{i}', 0) for i, v in enumerate(STAFF24)})
    RECS.update({TOME: ('SPEL', 'TomeSpell', 0), DRAIN: ('SPEL', 'VampireDrain01', 0)})
    PLUG = {'skyrim.esm': 0x00, 'dawnguard.esm': 0x02, 'staff.esp': 0x0B, 'tomes.esp': 0x0C}


def world2_fixture(root):
    """The 30 Sep review's cases: a deleted character, a Master set to 150, a lowered skill that keeps higher markers,
    an old-server "give all spells", powers with no flag, a masked character, a spell in hand, a vampire by rite."""
    cf = os.path.join(root, 'state', 'world', 'changeForms'); os.makedirs(cf)
    srv = os.path.join(root, 'server'); os.makedirs(srv)

    def form(name, d):
        base = {'recType': 1, 'formDesc': name[:-5], 'baseDesc': '7:Skyrim.esm', 'isDeleted': False, 'isDisabled': True, 'baseContainerAdded': True,
                'inv': {'entries': [{'baseId': 0xF, 'count': 5}]}, 'dynamicFields': {}, 'profileId': 20, 'learnedSpells': []}
        base.update(d)
        with open(os.path.join(cf, name), 'w') as fh:
            fh.write(json.dumps(base, indent=2))
    sk = lambda lvl, *tiers: {'level': lvl, 'xp': 0, 'rank': 0, 'granted': [MK[t] for t in tiers]}
    # Chef: staff set unarmed to Master (150 in the record) and scholar to 30; 5 scholar levels earned since
    form('60.json', {'appearanceDump': {'name': 'Chef'}, 'profileId': 21,
                     'learnedSpells': [MK[('unarmed', t)] for t in range(1, 6)] + [MK[('scholar', 1)], MK[('scholar', 2)], 0x0200283B, 0x92C48],
                     'equipmentDump': {'rightSpell': 0x0200283B, 'leftSpell': MK[('scholar', 1)], 'inv': {'entries': []}},
                     'dynamicFields': {'private.charTag': 'CHEF', 'maskName': 'Chef', 'private.maskItemId': 7, 'private.maskLost': 7,
                                       'private.dboLevel': {'level': 4, 'pending': 0, 'spent': {'health': 30, 'magicka': 0, 'stamina': 0}},
                                       'private.mastery': {'v': 2, 'skills': {'unarmed': sk(150, *[('unarmed', t) for t in range(1, 6)]),
                                                                             'scholar': sk(35, ('scholar', 1), ('scholar', 2))}}}})
    # Old: 22 of the 24 staff spells from a grant before the logs, a tome spell learned in study, no staff flags
    form('61.json', {'appearanceDump': {'name': 'Old'}, 'profileId': 22, 'learnedSpells': STAFF24[:22] + [TOME],
                     'dynamicFields': {'private.charTag': 'OLDS', 'private.dboStudied': {'arcane': ['1:tomes.esp']},
                                       'private.scholarReads': {'x': 1}, 'private.dboSchools': {'levels': {}}}})
    # Fang: a vampire by rite, with a scholar skill of its own and a tome spell
    form('62.json', {'appearanceDump': {'name': 'Fang'}, 'profileId': 23, 'learnedSpells': [DRAIN, TOME, MK[('scholar', 1)]],
                     'dynamicFields': {'private.charTag': 'FANG', 'private.supernatural': {'kind': 'vampire', 'spells': [DRAIN]},
                                       'private.dboStudied': {'arcane': ['1:tomes.esp']}, 'private.dboAvBonus': {'health': 10},
                                       'private.dboLevel': {'level': 2, 'pending': 0, 'spent': {'health': 10}},
                                       'private.mastery': {'v': 2, 'skills': {'scholar': sk(12, ('scholar', 1))}}}})
    # Gone: a deleted character, rich
    form('63.json', {'appearanceDump': {'name': 'Gone'}, 'profileId': 21, 'isDeleted': True,
                     'inv': {'entries': [{'baseId': 0xF, 'count': 9999}]}, 'dynamicFields': {'private.charTag': 'GONE'}})
    games = {'gamemode-config.json': {}, 'skills.json': {'tierHours': [0, 10, 30, 70, 150], 'pointSystem': {'capPerSkill': 100, 'firstTouchCost': 1}},
             'admin-powers.json': {'spells': [['%x:staff.esp' % (v & 0xFFFFFF), 'x'] for v in STAFF24], 'werewolf': '92c48:Skyrim.esm', 'vampirelord': '283b:Dawnguard.esm'},
             'spell-tomes.json': {'tomes': [{'spellId': 'tomes.esp:000001'}]}}
    for n, v in games.items():
        with open(os.path.join(srv, n), 'w') as fh:
            json.dump(v, fh)


TRAIL2 = [
    ('2026-09-23 18:00:00', 'GM Gaul #GAUL (profile 21, <@3>) admin panel: masterySetTier target=ff000060 skill=unarmed tier=4'),
    ('2026-09-28 20:00:00', 'GM Gaul #GAUL (profile 21, <@3>) admin panel: masterySetTier target=ff000060 skill=scholar tier=2'),
]


def world_fixture(root):
    cf = os.path.join(root, 'state', 'world', 'changeForms'); os.makedirs(cf)
    srv = os.path.join(root, 'server'); os.makedirs(srv)

    def form(name, d):
        base = {'recType': 0, 'formDesc': name[:-5].replace('_', ':'), 'isDeleted': False, 'isDisabled': False, 'baseContainerAdded': True,
                'inv': {'entries': []}, 'dynamicFields': {}, 'profileId': -1}
        base.update(d)
        with open(os.path.join(cf, name), 'w') as fh:
            fh.write(json.dumps(base, indent=2))
    tier_spell = 0x09000001
    # Hero: a playtester; staff set arcane to tier 2 (30) and then they earned 5; staff took up priest at tier 1 and
    # nothing was earned; staff gave all spells; they learned Candlelight themselves from a tome; staff gave werewolf
    form('53.json', {'recType': 1, 'profileId': 8, 'formDesc': '53', 'baseDesc': '7:Skyrim.esm',
                     'appearanceDump': {'name': 'Hero'},
                     'inv': {'entries': [{'baseId': 0xF, 'count': 800}, {'baseId': 0x1000, 'count': 2}]},
                     'equipmentDump': {'instantSpell': 0, 'inv': {'entries': [{'baseId': 0x1000, 'count': 1, 'worn': True}]}},
                     'learnedSpells': [0x12FCD, 0x12FD0, 0x92C48, tier_spell],
                     'dynamicFields': {'private.charTag': 'HERO', 'isAdmin': True, 'private.bankGold': 150, 'private.lastWorn': [[0x1000, 0]],
                                       'private.werewolfGrant': True, 'private.dboStudied': {'priest': ['12fcd:Skyrim.esm']},
                                       'private.dboLevel': {'level': 3, 'pending': 0, 'spent': {'health': 20, 'magicka': 0, 'stamina': 0}},
                                       'private.mastery': {'v': 2, 'order': ['arcane', 'priest', 'miner'], 'skills': {
                                           'arcane': {'level': 35, 'xp': 12, 'rank': 1, 'granted': []},
                                           'priest': {'level': 10, 'xp': 0, 'rank': 1, 'granted': [tier_spell]},
                                           'miner': {'level': 7, 'xp': 3, 'rank': 0, 'granted': []}}}}})
    # Bystander: nobody touched them
    form('54.json', {'recType': 1, 'profileId': 9, 'formDesc': '54', 'baseDesc': '7:Skyrim.esm', 'appearanceDump': {'name': 'Bystander'},
                     'inv': {'entries': [{'baseId': 0xF, 'count': 12}]}, 'learnedSpells': [0x12FD0],
                     'dynamicFields': {'private.charTag': 'BYST', 'private.mastery': {'v': 2, 'order': ['miner'], 'skills': {'miner': {'level': 40, 'xp': 0, 'rank': 1, 'granted': []}}}}})
    # Testy: a character named for testing, on a player's profile
    form('56.json', {'recType': 1, 'profileId': 12, 'formDesc': '56', 'baseDesc': '7:Skyrim.esm', 'appearanceDump': {'name': 'Testy'},
                     'dynamicFields': {'private.charTag': 'TSTY'}})
    # Crown: a vampire by rite who holds the Blood Crown, and a staff Vampire Lord grant on top
    form('55.json', {'recType': 1, 'profileId': 10, 'formDesc': '55', 'baseDesc': '7:Skyrim.esm', 'appearanceDump': {'name': 'Crown'},
                     'learnedSpells': [0x0200283B], 'dynamicFields': {'private.charTag': 'CRWN', 'private.vampireLordGrant': True,
                                                                     'private.supernatural': {'kind': 'vampire', 'pure': True}}})
    form('12ae13_DragonBreak Online Edits.esp.json', {'baseDesc': 'aaaa:Skyrim.esm', 'inv': {'entries': [{'baseId': 0x1000, 'count': 10000}]}})
    form('a1_Skyrim.esm.json', {'baseDesc': 'bbbb:Skyrim.esm', 'inv': {'entries': [{'baseId': 0xF, 'count': 40}]}})
    form('b2_Skyrim.esm.json', {'baseDesc': 'bbbb:Skyrim.esm'})
    form('3a0.json', {'recType': 1, 'baseDesc': 'cccc:Skyrim.esm', 'inv': {'entries': [{'baseId': 0x1000, 'count': 1}]}, 'dynamicFields': {'private.npcSpawner': 'wild:wolf:1'}})
    form('2a9.json', {'baseDesc': '1d4ec:Skyrim.esm', 'count': 1})
    form('1e1.json', {'baseDesc': '9151f:Skyrim.esm'})
    games = {
        'gamemode-config.json': {'starterKit': [{'id': 'e3c16:Skyrim.esm', 'count': 1}, {'id': '2f2f4:Skyrim.esm', 'count': 1}], 'banks': {}},
        'skills.json': {'tierHours': [0, 10, 30, 70, 150], 'pointSystem': {'capPerSkill': 100}},
        'admin-powers.json': {'spells': [['12fcd:Skyrim.esm', 'Candlelight'], ['12fd0:Skyrim.esm', 'Flames']], 'shouts': [], 'werewolf': '92c48:Skyrim.esm', 'vampirelord': '283b:Dawnguard.esm'},
        'supernatural.json': {'crown': {'holder': 0xFF000055, 'name': 'Crown'}},
        'zones.json': {'holds': [{'id': 'whiterun', 'treasury': 'x'}], 'regions': [{'id': 'bruma', 'treasury': 'y'}, {'id': 'nowhere'}]},
        'bank.json': {'factions': {'guild': 500}, 'zones': {'whiterun': 12000, 'bruma': 900}},
        'businesses.json': {'businesses': {'8000eeb': {'name': 'The Inn', 'owner': 8, 'ownerName': 'Hero', 'owed': 250,
                                                       'chests': {'aa': {'price': 5, 'renter': 9, 'renterName': 'Bystander', 'until': 1}, 'bb': {'price': 5}}, 'log': []}},
                             'owedTo': {'7': 40}},
        'tenancy.json': {'listings': {'x1': {'deposit': 100, 'depositHeld': 100, 'tenant': {'profile': 9}}}, 'owed': [{'tag': 'BYST', 'gold': 3}]},
        'commissions.json': {'next': 3, 'list': [{'id': 1, 'state': 'open', 'reward': 50}, {'id': 2, 'state': 'done', 'reward': 10}], 'owed': [{'tag': 'HERO', 'gold': 7}]},
        'contracts.json': {'contracts': [{'id': 'c1', 'held': 36}], 'taken': {'9': {'id': 'c1'}}},
        'economy.json': {'rates': {'x': 0.1}, 'owed': {'a': 5}, 'overdue': {'b': 1}},
    }
    for n, v in games.items():
        with open(os.path.join(srv, n), 'w') as fh:
            json.dump(v, fh)


TRAIL_LINES = [
    ('2026-09-22 05:00:00', 'SPELL Hero #HERO (profile 8, <@1>) took up priest by reading 9e2a7:Skyrim.esm (SpellTomeCandlelight) at a study point'),
    ('2026-09-22 05:00:01', 'SPELL Hero #HERO (profile 8, <@1>) learned 12fcd:Skyrim.esm Candlelight from tome 9e2a7:Skyrim.esm (priest 1/3)'),
    ('2026-09-23 10:00:00', 'GM Staffer #STAF (profile 2, <@2>) admin panel: masterySetTier target=ff000053 skill=arcane tier=2'),
    ('2026-09-23 10:00:01', 'GM profile 2 set arcane to tier 2 for Hero (profile 8)'),
    ('2026-09-23 10:00:05', 'GM Staffer #STAF (profile 2, <@2>) admin panel: masterySetTier target=ff000053 skill=priest tier=1'),
    ('2026-09-23 10:01:00', 'GM Staffer #STAF (profile 2, <@2>) admin panel: giveSpells'),
    ('2026-09-23 10:01:00', 'GM profile 2 gave 2 spells to Hero (profile 8)'),
    ('2026-09-23 10:02:00', 'GM Staffer #STAF (profile 2, <@2>) admin panel: giveWerewolf'),
    ('2026-09-23 10:02:00', 'GM profile 2 gave werewolf beast form to Hero (profile 8)'),
    ('2026-09-23 10:03:00', 'GM Staffer #STAF (profile 2, <@2>) admin panel: giveShouts'),
    ('2026-09-23 10:04:00', 'GM Staffer #STAF (profile 2, <@2>) admin panel: giveItem item=1000:Skyrim.esm count=2'),
]


def main():
    tmp = tempfile.mkdtemp(prefix='claude-nate-alpha-test-')
    try:
        # ---- the trail ----
        trail = ar.parse_trail(TRAIL_LINES)
        acts = [g['action'] for g in trail['grants']]
        check('the trail has the tier sets, the gives and the item', acts == ['masterySetTier', 'masterySetTier', 'giveSpells', 'giveWerewolf', 'giveShouts', 'giveItem'], acts)
        gs = [g for g in trail['grants'] if g['action'] == 'giveSpells'][0]
        check('a give names its recipient from the admin system line', gs.get('whom') == {'name': 'Hero', 'profile': 8}, gs)
        sh = [g for g in trail['grants'] if g['action'] == 'giveShouts'][0]
        check('a give with no recipient line is the GM themself, marked as guessed', sh.get('whom') == 'themself' and sh.get('guessed'), sh)
        check('what the player learned and took up is kept apart', '12fcd:skyrim.esm' in trail['learned'].get('HERO', []) and 'priest' in trail['tookUp'].get('HERO', []), trail)

        # ---- the plan ----
        root = os.path.join(tmp, 'sandbox'); os.makedirs(root)
        world_fixture(root)
        world = ar.World(root)
        p = ar.plan(world, trail, FakeLO())
        hero = [c for c in p['characters'] if c['name'] == 'Hero'][0]
        by = {x['skill']: x for x in hero['skills']}
        check('arcane set to 30 by staff, 35 now: 5 earned stay', by.get('arcane', {}).get('to') == 5, hero['skills'])
        check('priest taken up by staff but also by the player at a study point: kept at its first level (1), not set aside',
              'priest' not in hero['dropSkills'] and by.get('priest', {}).get('to') == 1, hero)
        check('a skill staff never touched is left alone', 'miner' not in by)
        check('the staff spells go, except the one learned from a tome and the kept tier spell', sorted(hero['removeSpells']) == [0x12FD0, 0x92C48], [hex(x) for x in hero['removeSpells']])
        check('the werewolf grant and the shouts flag are cleared', 'private.werewolfGrant' in hero['clearFlags'], hero['clearFlags'])
        check('a level earned partly from staff hours is reset', hero['levelReset'])
        by2 = [c for c in p['characters'] if c['name'] == 'Bystander'][0]
        check('a character nobody touched has no staff changes', not by2['skills'] and not by2['removeSpells'] and not by2['clearFlags'] and not by2['levelReset'])
        crown = [c for c in p['characters'] if c['name'] == 'Crown'][0]
        check('the Blood Crown is released: its holder gives up the Vampire Lord power and the staff flag, keeps the vampirism',
              crown['removeSpells'] == [0x0200283B] and crown['clearFlags'] == ['private.vampireLordGrant'] and 'vampire' in crown.get('keptSupernatural', ''), crown)
        conts = {c['form']: c for c in p['world']['containers']}
        check('containers with items are emptied, the supply chest flagged; empty ones and NPC bodies left',
              set(conts) == {'12ae13:DragonBreak Online Edits.esp', 'a1:Skyrim.esm'} and conts['12ae13:DragonBreak Online Edits.esp']['supply'], list(conts))
        check('an item lying in the world is removed; a removable torch activator is not', [d['form'] for d in p['world']['droppedItems']] == ['2a9'], p['world']['droppedItems'])
        check('bank: treasuries of zones with one go back to the seed, factions empty', p['files']['bank.json']['to'] == {'zones': {'whiterun': 10000, 'bruma': 10000}, 'factions': {}}, p['files']['bank.json'])
        check('the crown release is planned', p['files'].get('supernatural.json', {}).get('released') == 'Crown', p['files'].get('supernatural.json'))
        staff = {x['name']: x for x in p['staff']}
        check('staff and test characters are listed: the GM\'s profile and the test-named, not the bystander',
              set(staff) == {'Hero', 'Testy'} and any('GM actions' in w or 'admin' in w for w in staff['Testy']['why']) is False and 'named as a test or GM character' in staff['Testy']['why'], p['staff'])

        # A staff profile's own player character, marked in the config by tag and profile (Nate, 2026-09-30)
        marked = {'players': {('HERO', 8): {'tag': 'HERO', 'profile': 8, 'name': 'Hero', 'by': 'Nate'}, ('NOPE', 3): {'tag': 'NOPE', 'profile': 3, 'name': 'Typo'}}}
        pm = ar.plan(ar.World(root), trail, FakeLO(), settings=marked)
        check('a marked player character leaves the staff-only list for its own', [x['name'] for x in pm['staff']] == ['Testy'] and [x['name'] for x in pm['staffPlayers']] == ['Hero'], {'staff': pm['staff'], 'players': pm['staffPlayers']})
        hm = [c for c in pm['characters'] if c['name'] == 'Hero'][0]
        check('...and is still reset, its staff grants taken back', hm['removeSpells'] == hero['removeSpells'] and hm['skills'] == hero['skills'])
        check('an entry that matches no character is named', any('Typo' in n and 'no staff character' in n for n in pm['notes']), pm['notes'])
        shipped = ar.load_config()
        check('the shipped config marks Nilis Urnum\'s whole account and only Velisse Montclair on hers as not staff',
              not shipped['players'] and set(shipped['notStaff']) == {6, 7} and shipped['notStaff'][7].get('whole') is True and shipped['notStaff'][6].get('whole') is False and shipped['notStaff'][6]['tag'] == 'RWPS', shipped)
        # Only one character of an account plays: the account's other characters stay staff-only as test characters
        one = ar.plan(ar.World(root), trail, FakeLO(), settings={'players': {}, 'notStaff': {12: {'profile': 12, 'tag': 'ZZZZ', 'whole': False}, 8: {'profile': 8, 'tag': 'HERO', 'whole': False}}})
        tst = {x['name']: x for x in one['staff']}
        check('with a tag, only that character leaves the staff list; another on the account stays, as a test character',
              'Hero' not in tst and 'Testy' in tst and 'a test character on a player account that had admin while testing' in tst['Testy']['why'] and [x['characters'] for x in one['notStaff'] if x['profile'] == 8] == [['Hero #HERO']], {'staff': one['staff'], 'notStaff': one['notStaff']})
        check('...and a tagged entry with no such character is named', any('ZZZZ' in n for n in one['notes']), one['notes'])
        # A player account that had admin while testing: out of both staff tables, its grants still taken back
        ns = ar.plan(ar.World(root), trail, FakeLO(), settings={'players': {}, 'notStaff': {8: {'profile': 8, 'name': 'Hero', 'by': 'Nate'}}})
        hn = [c for c in ns['characters'] if c['name'] == 'Hero'][0]
        check('a not-staff account is in neither staff table, and listed as a player who had admin',
              [x['name'] for x in ns['staff']] == ['Testy'] and not ns['staffPlayers'] and ns['notStaff'][0]['characters'] == ['Hero #HERO'], {'staff': ns['staff'], 'notStaff': ns['notStaff']})
        check('...and its character is still reset, its grants taken back', hn['removeSpells'] == hero['removeSpells'] and hn['skills'] == hero['skills'])

        # ---- apply ----
        before_untouched = open(os.path.join(root, 'state', 'world', 'changeForms', 'b2_Skyrim.esm.json')).read()
        npc_before = open(os.path.join(root, 'state', 'world', 'changeForms', '3a0.json')).read()
        written = ar.apply(world, p, tmp)
        cf = os.path.join(root, 'state', 'world', 'changeForms')
        h = json.load(open(os.path.join(cf, '53.json')))
        kit = {(e['baseId'], e['count']) for e in h['inv']['entries']}
        check('Hero holds exactly the kit', kit == {(0x80697, 1), (0x80699, 1), (0xF, 50), (0xE3C16, 1), (0x2F2F4, 1)}, h['inv'])
        check('...wearing the clothes and boots only', sorted(e['baseId'] for e in h['equipmentDump']['inv']['entries']) == [0x80697, 0x80699] and all(e.get('worn') for e in h['equipmentDump']['inv']['entries']), h['equipmentDump'])
        dfh = h['dynamicFields']
        check('bank gold, last worn and the staff flag are gone; the kit is pending', 'private.bankGold' not in dfh and 'private.lastWorn' not in dfh and 'private.werewolfGrant' not in dfh and dfh.get('private.kitPending') is True, dfh)
        check('the spells taken back are gone, the tome spell and tier spell stay', sorted(h['learnedSpells']) == sorted([0x12FCD, 0x09000001]), h['learnedSpells'])
        m = dfh['private.mastery']
        check('arcane stands at 5 with no stray xp', m['skills']['arcane']['level'] == 5 and m['skills']['arcane']['xp'] == 0, m['skills']['arcane'])
        check('the level points are to be chosen anew', dfh['private.dboLevel'] == {'level': 1, 'pending': 0, 'spent': {'health': 0, 'magicka': 0, 'stamina': 0}} and dfh['private.dboAvBonus'] == {'health': 0, 'magicka': 0, 'stamina': 0})
        chest = json.load(open(os.path.join(cf, '12ae13_DragonBreak Online Edits.esp.json')))
        check('the supply chest is empty and will not refill from its base', chest['inv']['entries'] == [] and chest['baseContainerAdded'] is True and chest['dynamicFields'].get('private.dboEmptied') is True, chest)
        check('an untouched record is byte-identical', open(os.path.join(cf, 'b2_Skyrim.esm.json')).read() == before_untouched)
        check('a spawned NPC keeps what it carries', open(os.path.join(cf, '3a0.json')).read() == npc_before)
        check('the dropped item is marked deleted', json.load(open(os.path.join(cf, '2a9.json')))['isDeleted'] is True)
        srv = os.path.join(root, 'server')
        biz = json.load(open(os.path.join(srv, 'businesses.json')))
        b = biz['businesses']['8000eeb']
        check('business: takings 0, rentals ended, owedTo empty, a line in its log', b['owed'] == 0 and 'renter' not in b['chests']['aa'] and b['chests']['aa']['price'] == 5 and biz['owedTo'] == {} and b['log'], biz)
        com = json.load(open(os.path.join(srv, 'commissions.json')))
        check('commissions: the open one cancelled, the finished one left, owed dropped', [c['state'] for c in com['list']] == ['cancelled', 'done'] and com['owed'] == [], com)
        check('contracts cleared', json.load(open(os.path.join(srv, 'contracts.json'))) == {'contracts': [], 'taken': {}})
        check('the Blood Crown is vacant', json.load(open(os.path.join(srv, 'supernatural.json'))) == {'crown': None, 'revoke': []})
        ten = json.load(open(os.path.join(srv, 'tenancy.json')))
        check('tenancy: the deposit held is 0, the tenant stays', ten['listings']['x1']['depositHeld'] == 0 and ten['listings']['x1']['tenant'] == {'profile': 9} and ten['owed'] == [], ten)
        eco = json.load(open(os.path.join(srv, 'economy.json')))
        check('economy: owed and overdue dropped, rates kept', eco['owed'] == {} and eco['overdue'] == {} and eco['rates'] == {'x': 0.1}, eco)
        check('the originals are kept beside the world', os.path.exists(os.path.join(root, 'alpha-reset-originals', 'changeForms', '53.json')) and os.path.exists(os.path.join(root, 'alpha-reset-originals', 'server', 'bank.json')))
        # a second plan over the result has nothing left to take
        p2 = ar.plan(ar.World(root), trail, FakeLO())
        h2 = [c for c in p2['characters'] if c['name'] == 'Hero'][0]
        check('planned again, the world holds no containers to empty and Hero carries only the kit\'s gold',
              not p2['world']['containers'] and h2['gold'] == 50 and not h2['removeSpells'], {'containers': len(p2['world']['containers']), 'gold': h2['gold'], 'spells': h2['removeSpells']})
        check('...takes no skill down a second time, and knows the world was reset', not h2['skills'] and not h2['levelReset'] and len(p2['alreadyReset']) == 4, {'skills': h2['skills'], 'already': p2['alreadyReset']})
        try:
            ar.apply(ar.World(root), p2, tmp); ok = False
        except SystemExit:
            ok = True
        check('...and a second apply is refused', ok)

        # ---- refusals ----
        for bad, why in ((ar.LIVE_STATE, 'the live state'), (os.path.dirname(ar.LIVE_STATE), 'a folder holding the live state')):
            try:
                ar.check_root(bad, False, None); ok = False
            except SystemExit:
                ok = True
            check(f'{why} is refused without --live', ok)
        try:
            ar.check_root(None, False, None, root + '/state', ar.LIVE_SERVER, None); ok = False
        except SystemExit:
            ok = True
        check('the live gameplay folder given as --server is refused without --live', ok)
        try:
            ar.check_root(None, True, os.path.join(root, 'server', 'bank.json'), root + '/state', root + '/server', None); ok = False
        except SystemExit:
            ok = True
        check('--live with --state/--server needs --originals', ok)
        empty = os.path.join(tmp, 'empty'); os.makedirs(empty)
        try:
            ar.check_root(empty, False, None); ok = False
        except SystemExit:
            ok = True
        check('a folder without change forms is refused', ok)
        try:
            ar.check_root(root, True, None); ok = False
        except SystemExit:
            ok = True
        check('--live without a snapshot is refused', ok)
        # ---- the 30 Sep review: deleted characters, markers, old-server grants, powers, masks, hands, --stats full ----
        root2 = os.path.join(tmp, 'sandbox2'); os.makedirs(root2)
        world2_fixture(root2)
        w2 = ar.World(root2)
        check('a deleted character is not a character', '63.json' not in w2.chars and w2.deleted_chars == ['63.json'], sorted(w2.chars))
        t2 = ar.parse_trail(TRAIL2)
        q = ar.plan(w2, t2, FakeLO2())
        cq = {c['name']: c for c in q['characters']}
        check('...nor counted, and the count of skipped records is kept', set(cq) == {'Chef', 'Old', 'Fang'} and q['deletedCharacters'] == 1, sorted(cq))
        chef = cq['Chef']
        byc = {x['skill']: x for x in chef['skills']}
        check('a Master set by staff (150 in the record) with nothing earned is set aside, not left at 50', 'unarmed' in chef['dropSkills'] and byc['unarmed']['to'] is None, chef['skills'])
        check('scholar set to 30, 35 now: 5 stay', byc['scholar']['to'] == 5, chef['skills'])
        check('the markers above the tier a skill now stands at go (scholar T2), with every marker of a skill set aside',
              set(chef['removeSpells']) >= {MK[('scholar', 2)]} | {MK[('unarmed', t)] for t in range(1, 6)} and MK[('scholar', 1)] not in chef['removeSpells'], [hex(x) for x in chef['removeSpells']])
        check('the Vampire Lord and werewolf powers go with no flag and no crown (not a werewolf by rite)', {0x0200283B, 0x92C48} <= set(chef['removeSpells']), [hex(x) for x in chef['removeSpells']])
        old = cq['Old']
        check('22 of 24 staff spells with no line in the logs: an old-server "give all spells", taken back; the studied tome spell stays',
              set(old['removeSpells']) == set(STAFF24[:22]) and any('before the logs' in x for x in old['staff']), [hex(x) for x in old['removeSpells']])
        fang = cq['Fang']
        check('earned mode: a vampire by rite keeps its drain, its tome spell and its own scholar marker', not fang['removeSpells'], fang['removeSpells'])
        check('the default is earned', q['stats'] == 'earned')
        full = ar.plan(ar.World(root2), t2, FakeLO2(), stats='full')
        cf2 = {c['name']: c for c in full['characters']}
        check('full: Fang loses the tome spell and the scholar marker, keeps the drain from the rite',
              set(cf2['Fang']['removeSpells']) == {TOME, MK[('scholar', 1)]} and cf2['Fang']['keptSpells'] == [DRAIN] and 'vampire' in cf2['Fang'].get('keptSupernatural', ''), cf2['Fang'])
        check('full: every skill goes and the level fields are cleared', cf2['Fang']['dropSkills'] == ['scholar'] and set(cf2['Fang']['clearFields']) == {'private.mastery', 'private.dboLevel', 'private.dboAvBonus', 'private.dboStudied'}, cf2['Fang'])
        check('full: Old loses the staff spells and the studied tome spell, and its study and school records',
              set(cf2['Old']['removeSpells']) == set(STAFF24[:22]) | {TOME} and {'private.dboStudied', 'private.scholarReads', 'private.dboSchools'} <= set(cf2['Old']['clearFields']), cf2['Old'])
        try:
            ar.plan(ar.World(root2), t2, FakeLO2(), stats='most'); ok = False
        except SystemExit:
            ok = True
        check('an unknown --stats is refused', ok)
        gone_before = open(os.path.join(root2, 'state', 'world', 'changeForms', '63.json')).read()
        ar.apply(ar.World(root2), full, tmp)
        cf2d = os.path.join(root2, 'state', 'world', 'changeForms')
        c60 = json.load(open(os.path.join(cf2d, '60.json')))
        check('the masked character is unmasked in the record and the lost-mask memory is gone',
              c60['appearanceDump']['name'] == 'Chef' and c60['dynamicFields']['maskName'] == '' and 'private.maskLost' not in c60['dynamicFields'] and 'private.maskItemId' not in c60['dynamicFields'], c60['dynamicFields'])
        check('a spell taken back leaves the hand', c60['equipmentDump']['rightSpell'] == 0 and c60['equipmentDump']['leftSpell'] == 0, c60['equipmentDump'])
        check('full: no skill record, no level, the marker says full', 'private.mastery' not in c60['dynamicFields'] and 'private.dboLevel' not in c60['dynamicFields']
              and c60['dynamicFields']['private.alphaReset']['stats'] == 'full', c60['dynamicFields'])
        c62 = json.load(open(os.path.join(cf2d, '62.json')))
        check('full: the vampire keeps the drain and its rite state', c62['learnedSpells'] == [DRAIN] and c62['dynamicFields']['private.supernatural']['kind'] == 'vampire', c62)
        check('the deleted character\'s record is byte-identical', open(os.path.join(cf2d, '63.json')).read() == gone_before)
        # earned mode on a fresh copy: the lowered skill's rank and granted list follow
        root3 = os.path.join(tmp, 'sandbox3'); os.makedirs(root3)
        world2_fixture(root3)
        e3 = ar.plan(ar.World(root3), t2, FakeLO2())
        ar.apply(ar.World(root3), e3, tmp)
        m60 = json.load(open(os.path.join(root3, 'state', 'world', 'changeForms', '60.json')))['dynamicFields']['private.mastery']
        check('earned: scholar at 5, Novice, granted only its T1 marker; unarmed set aside',
              m60['skills']['scholar']['level'] == 5 and m60['skills']['scholar']['rank'] == 0 and m60['skills']['scholar']['granted'] == [MK[('scholar', 1)]] and 'unarmed' not in m60['skills'], m60)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print('all passed' if not failures else f'{failures} FAILED')
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
