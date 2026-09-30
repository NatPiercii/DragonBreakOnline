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
        check('priest taken up by staff but also by the player at a study point: kept at 0, not set aside',
              'priest' not in hero['dropSkills'] and by.get('priest', {}).get('to') == 0, hero)
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
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print('all passed' if not failures else f'{failures} FAILED')
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
