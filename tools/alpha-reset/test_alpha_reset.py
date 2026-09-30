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


# ---- Nate, 2026-09-30: every character a plain mortal, no deity, no house, no business, no guild ----
TONE = 'Actors\\Character\\Character Assets\\TintMasks\\SkinTone.dds'
LIPS = 'Actors\\Character\\Character Assets\\TintMasks\\MaleLips.dds'
BLOOD_LIPS = ar.i32(0xc0500808)
BLESSING = 0x0A0000FF
OPEN_MS = int(__import__('datetime').datetime(2026, 10, 3, 5, 0, tzinfo=__import__('datetime').timezone.utc).timestamp() * 1000)


def world3_fixture(root):
    cf = os.path.join(root, 'state', 'world', 'changeForms'); os.makedirs(cf)
    srv = os.path.join(root, 'server'); os.makedirs(srv)

    def form(name, d, char=True):
        base = {'recType': 1 if char else 0, 'formDesc': name[:-5].replace('_', ':'), 'baseDesc': '7:Skyrim.esm', 'isDeleted': False,
                'isDisabled': char, 'baseContainerAdded': True, 'inv': {'entries': []}, 'dynamicFields': {}, 'profileId': -1, 'learnedSpells': []}
        base.update(d)
        with open(os.path.join(cf, name), 'w') as fh:
            fh.write(json.dumps(base, indent=2))
    tints = lambda tone, lips: [{'texturePath': TONE, 'type': 6, 'argb': tone}, {'texturePath': LIPS, 'type': 1, 'argb': lips}]
    # Rite: a pure-blood by Molag Bal's rite, stage 3, the crown's holder, blood on the lips, the vampire race and eyes
    form('70.json', {'profileId': 30, 'learnedSpells': [0x8D5C1, 0xED0A6, 0xC4DE1, 0xC4DE2],
                     'appearanceDump': {'name': 'Rite', 'raceId': 0x88794, 'isFemale': False, 'headpartIds': [0x51631, 0xE7AEB, 0x8555F],
                                        'skinColor': 14274253, 'tints': tints(-1, BLOOD_LIPS)},
                     'equipmentDump': {'rightSpell': 0x8D5C1, 'inv': {'entries': []}},
                     'dynamicFields': {'private.charTag': 'RITE', 'private.bloodRanks': {'blood': 20, 'fedOn': {}}, 'private.riteFailedAt': 5,
                                       'private.xpBoost': {'mult': 2, 'until': 9e12},
                                       'private.supernatural': {'kind': 'vampire', 'pure': True, 'stage': 3, 'lastFed': 45.7, 'spells': [0x8D5C1, 0xED0A6, 0xC4DE1, 0xC4DE2],
                                                                'look': {'eye': 0xE7AEB, 'kind': 'vampire', 'prevEye': 0x51630, 'prevExtras': [0x24238], 'prevSkin': 13021352, 'prevTone': -3755864},
                                                                'blood': {'prev': [{'texturePath': LIPS, 'type': 1, 'argb': 12345, 'applied': BLOOD_LIPS}]}}}})
    # Fever: Sanguinare Vampiris incubating, no curse yet
    form('71.json', {'profileId': 31, 'learnedSpells': [0xB8780], 'appearanceDump': {'name': 'Fever', 'raceId': 0x13745, 'headpartIds': [0x51616]},
                     'dynamicFields': {'private.charTag': 'FEVR', 'private.supernatural': {'kind': None, 'disease': {'kind': 'vampire', 'played': 0.03, 'by': 'Rite'}}}})
    # Wolf: a werewolf by Hircine's rite (a record from before prevExtras), the Hunt's renown
    form('72.json', {'profileId': 32, 'learnedSpells': [0x92C48, 0x12FD0], 'appearanceDump': {'name': 'Wolf', 'raceId': 0x13741, 'headpartIds': [0x51633, 0x24245]},
                     'dynamicFields': {'private.charTag': 'WOLF', 'private.greatHunt': {'renown': 2, 'changeDay': 46, 'changesPaid': 1},
                                       'private.supernatural': {'kind': 'werewolf', 'beastDay': 46, 'beastDayUses': 1, 'look': {'eye': 0x24245, 'kind': 'werewolf', 'prevEye': 0x51457}}}})
    # Granted: staff gave both beast powers, no curse on record
    form('73.json', {'profileId': 33, 'learnedSpells': [0x92C48, 0x0200283B], 'appearanceDump': {'name': 'Granted', 'raceId': 0x13746, 'headpartIds': []},
                     'dynamicFields': {'private.charTag': 'GRNT', 'private.werewolfGrant': True, 'private.vampireLordGrant': True}})
    # Beast: in werewolf form at the snapshot, the form's spells learned, the real look kept in private.beast
    form('74.json', {'profileId': 34, 'learnedSpells': [0x92C48, 0xCF791, 0xF3F0A],
                     'appearanceDump': {'name': 'Beast', 'raceId': 0xCDD84, 'headpartIds': [], 'tints': []},
                     'dynamicFields': {'private.charTag': 'BEST', 'private.beast': {'form': 'werewolf', 'at': 1, 'until': 2,
                                                                                    'original': {'name': 'Beast', 'raceId': 0x13741, 'headpartIds': [0x51633, 0x24245], 'skinColor': 5, 'tints': []}},
                                       'private.supernatural': {'kind': 'werewolf', 'look': {'eye': 0x24245, 'kind': 'werewolf', 'prevEye': 0x51457, 'prevExtras': []}}}})
    # Stuck: the werewolf race and a vampire's eyes in the record, with nothing kept to restore: a check by hand
    form('75.json', {'profileId': 35, 'appearanceDump': {'name': 'Stuck', 'raceId': 0xCDD84, 'headpartIds': [0xE7AEB]},
                     'dynamicFields': {'private.charTag': 'STUK'}})
    # Pilgrim: a faith with its blessing, an offering and shrine rests, a guild, a bed rented, a house and an inn
    form('76.json', {'profileId': 36, 'appearanceDump': {'name': 'Pilgrim', 'raceId': 0x13746, 'headpartIds': []}, 'learnedSpells': [BLESSING],
                     'dynamicFields': {'private.charTag': 'PILG', 'private.dboGuilds': ['fighters'], 'private.dboRentBed': {'bed': 0x1B004, 'until': 5},
                                       'private.dboDeity': {'id': 'arkay', 'name': 'Arkay', 'kind': 'divine', 'at': 1000, 'convertedAt': 1000},
                                       'private.dboBlessing': {'deity': 'arkay', 'spell': BLESSING, 'until': 9e12}, 'private.dboOffering': {'deityId': 'arkay', 'gold': 10, 'until': 9e12},
                                       'private.prayedShrines': {'shrine1': 1}}})
    # Property: a door pair (the record on the lower id, a pointer on the far side), a claimed chest, an old stub, a rented bed, a ledger
    form('1b000_Skyrim.esm.json', {'dynamicFields': {'private.housing': {'owner': 36, 'ownerName': 'Pilgrim #PILG', 'name': 'Home', 'locked': True, 'serial': 3,
                                                                         'partner': 0x1B001, 'containers': [], 'issued': ['Key to Home']},
                                                     'private.indexed.housingOwner': '36', 'private.dboRestOwed': 40, 'private.dboInnOwnerBed': {'bed': 0x1B004, 'owner': 36},
                                                     'private.dboRestOwedBy': {'36': 12}}}, char=False)
    # a door whose only trace is rent held per profile (hardening-inn-rent 0df483d0), its claim already given up
    form('1b005_Skyrim.esm.json', {'dynamicFields': {'private.housing': {'owner': 0, 'serial': 2, 'partner': 0}, 'private.dboRestOwedBy': {'30': 7}}}, char=False)
    form('1b001_Skyrim.esm.json', {'dynamicFields': {'private.housing': {'primary': 0x1B000}}}, char=False)
    form('1b002_Skyrim.esm.json', {'inv': {'entries': [{'baseId': 0xF, 'count': 99}]},
                                   'dynamicFields': {'private.housing': {'owner': 30, 'ownerName': 'Rite #RITE', 'name': None, 'locked': True, 'serial': 1, 'partner': 0, 'containers': [], 'issued': None},
                                                     'private.indexed.housingOwner': '30'}}, char=False)
    form('1b003_Skyrim.esm.json', {'dynamicFields': {'private.housing': {'owner': 0, 'ownerName': '', 'serial': 5, 'partner': 0}}}, char=False)
    form('1b004_Skyrim.esm.json', {'dynamicFields': {'private.dboRent': {'renter': 0xFF000076, 'name': 'Pilgrim', 'until': 5}}}, char=False)
    form('1dc.json', {'baseDesc': '106a68:Skyrim.esm', 'dynamicFields': {'private.dboBizLedger': '1b000'}}, char=False)
    form('1dd.json', {'baseDesc': '106a68:Skyrim.esm', 'dynamicFields': {'private.dboBizLedger': {'claim': '1b000'}}}, char=False)   # placed twice, forgotten
    games = {'gamemode-config.json': {}, 'skills.json': {'tierHours': [0, 10, 30, 70, 150], 'pointSystem': {'capPerSkill': 100}},
             'admin-powers.json': {'spells': [], 'werewolf': '92c48:Skyrim.esm', 'vampirelord': '283b:Dawnguard.esm'},
             'supernatural.json': {'crown': {'holder': 0xFF000070, 'name': 'Rite'}, 'revoke': []},
             'housing.json': [0x1B000, 0x1B002, 0x1B0FF],
             'businesses.json': {'businesses': {'1b000': {'name': 'The Inn', 'owner': 36, 'ownerName': 'Pilgrim #PILG', 'owed': 5, 'staff': [{'profile': 30, 'name': 'Rite'}],
                                                          'chests': {}, 'ledger': {'ref': 'ff0001dc', 'pos': [0, 0, 0]}, 'log': []}}, 'owedTo': {'7': 3}},
             'tenancy.json': {'listings': {'1b000': {'door': 0x1B000, 'zone': 'bruma', 'deposit': 100, 'weekly': 10, 'listedBy': {'profile': 5}, 'interest': [{'profile': 9}],
                                                     'offer': {'party': {'profile': 9}, 'until': 5}, 'tenant': {'profile': 36, 'name': 'Pilgrim'}, 'depositHeld': 100,
                                                     'paidUntil': 5, 'overdueSince': 4}}, 'owed': [{'tag': 'PILG', 'gold': 3}]},
             'guilds.json': {'fighters': {str(0xFF000076): {'rank': 'member', 'name': 'Pilgrim'}}},
             'faction-storage.json': {'fighters': {'ref': '1b002'}},
             # a staff test window before the opening, and a playtester's window from after it
             'playtester-boost.json': {'profiles': {'30': {'start': OPEN_MS - 3600000, 'until': OPEN_MS + 9e7, 'mult': 2, 'staff': True},
                                                    '36': {'start': OPEN_MS + 60000, 'until': OPEN_MS + 9e7, 'mult': 2, 'claimed': True}}}}
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
        check('the Blood Crown is released and its holder made mortal: the Vampire Lord power, the staff flag and the vampirism go',
              crown['removeSpells'] == [0x0200283B] and crown['clearFlags'] == ['private.vampireLordGrant'] and 'pure-blood vampire' in crown['cure']['was']
              and 'held the Blood Crown' in crown['cure']['was'] and 'private.supernatural' in crown['cure']['fields'], crown)
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
        check('business: closed as business.js closes one, no takings held for anyone', biz == {'businesses': {}, 'owedTo': {}}, biz)
        com = json.load(open(os.path.join(srv, 'commissions.json')))
        check('commissions: the open one cancelled, the finished one left, owed dropped', [c['state'] for c in com['list']] == ['cancelled', 'done'] and com['owed'] == [], com)
        check('contracts cleared', json.load(open(os.path.join(srv, 'contracts.json'))) == {'contracts': [], 'taken': {}})
        check('the Blood Crown is vacant', json.load(open(os.path.join(srv, 'supernatural.json'))) == {'crown': None, 'revoke': []})
        ten = json.load(open(os.path.join(srv, 'tenancy.json')))
        check('tenancy: the tenant and the deposit held go with the released house, the official\'s listing and terms stay',
              ten['listings']['x1']['depositHeld'] == 0 and 'tenant' not in ten['listings']['x1'] and ten['listings']['x1']['deposit'] == 100 and ten['owed'] == [], ten)
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
        check('earned mode: a vampire by rite is made mortal (the drain goes); its tome spell and its own scholar marker stay', set(fang['removeSpells']) == {DRAIN} and fang.get('cure'), fang['removeSpells'])
        check('the default is earned', q['stats'] == 'earned')
        full = ar.plan(ar.World(root2), t2, FakeLO2(), stats='full')
        cf2 = {c['name']: c for c in full['characters']}
        check('full: Fang loses the tome spell, the scholar marker and the drain; nothing is kept',
              set(cf2['Fang']['removeSpells']) == {TOME, MK[('scholar', 1)], DRAIN} and cf2['Fang']['keptSpells'] == [] and cf2['Fang'].get('cure'), cf2['Fang'])
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
        check('full: the vampire is mortal: no spells, no curse record', c62['learnedSpells'] == [] and 'private.supernatural' not in c62['dynamicFields'], c62)
        check('the deleted character\'s record is byte-identical', open(os.path.join(cf2d, '63.json')).read() == gone_before)
        # earned mode on a fresh copy: the lowered skill's rank and granted list follow
        root3 = os.path.join(tmp, 'sandbox3'); os.makedirs(root3)
        world2_fixture(root3)
        e3 = ar.plan(ar.World(root3), t2, FakeLO2())
        ar.apply(ar.World(root3), e3, tmp)
        m60 = json.load(open(os.path.join(root3, 'state', 'world', 'changeForms', '60.json')))['dynamicFields']['private.mastery']
        check('earned: scholar at 5, Novice, granted only its T1 marker; unarmed set aside',
              m60['skills']['scholar']['level'] == 5 and m60['skills']['scholar']['rank'] == 0 and m60['skills']['scholar']['granted'] == [MK[('scholar', 1)]] and 'unarmed' not in m60['skills'], m60)
        # ---- every character a plain mortal; no deity, house, business or guild (Nate, 2026-09-30) ----
        root4 = os.path.join(tmp, 'sandbox4'); os.makedirs(root4)
        world3_fixture(root4)
        empty = ar.parse_trail([])
        r = ar.plan(ar.World(root4), empty, FakeLO(), stats='full')
        rc = {c['name']: c for c in r['characters']}
        check('a pure-blood by rite, a fever, a werewolf, a staff grant and one in beast form are all to be made mortal',
              all(rc[x].get('cure') for x in ('Rite', 'Fever', 'Wolf', 'Granted', 'Beast')), {x: rc[x].get('cure') for x in rc})
        check('...and a record with a beast race and a curse\'s eyes but nothing kept is listed for a check by hand, not guessed',
              len(rc['Stuck']['cure']['check']) == 2 and rc['Stuck']['cure']['appearance'] is None, rc['Stuck'].get('cure'))
        hsg = r['world']['housing']
        check('every owned claim is to be released (the door pair\'s record and the chest), the stub and the pointer left; the stale registry id named',
              sorted(c['form'] for c in hsg['claims']) == ['1b000:Skyrim.esm', '1b002:Skyrim.esm'] and hsg['registryWithoutClaim'] == [0x1B0FF] and hsg['pointers'] == 1, hsg)
        check('the business\'s tagged ledger is found', r['files']['businesses.json']['businesses'][0]['ledgerFile'] == '1dc.json', r['files']['businesses.json'])
        cf4 = os.path.join(root4, 'state', 'world', 'changeForms')
        untouched = {n: open(os.path.join(cf4, n)).read() for n in ('1b001_Skyrim.esm.json', '1b003_Skyrim.esm.json')}
        ar.apply(ar.World(root4), r, tmp)
        J = lambda n: json.load(open(os.path.join(cf4, n)))
        rite = J('70.json'); app = rite['appearanceDump']; rdf = rite['dynamicFields']
        check('rite vampire: the mortal race, its own eyes with their extra part, skin and tone back, the blood washed off',
              app['raceId'] == 0x13746 and app['headpartIds'] == [0x51631, 0x51630, 0x24238, 0x8555F] and app['skinColor'] == 13021352
              and app['tints'][0]['argb'] == -3755864 and app['tints'][1]['argb'] == 12345, app)
        check('...no stage spells, no drain in hand, no curse, blood rank or rite clock', rite['learnedSpells'] == [] and rite['equipmentDump']['rightSpell'] == 0
              and not any(k in rdf for k in ('private.supernatural', 'private.bloodRanks', 'private.riteFailedAt')), rdf)
        fev = J('71.json')
        check('fever: Sanguinare Vampiris gone and the record cleared, the look untouched', fev['learnedSpells'] == [] and 'private.supernatural' not in fev['dynamicFields']
              and fev['appearanceDump'] == {'name': 'Fever', 'raceId': 0x13745, 'headpartIds': [0x51616]}, fev)
        wolf = J('72.json')
        check('werewolf: its own eyes back, no Beast Form power, no Hunt renown', wolf['appearanceDump']['headpartIds'] == [0x51633, 0x51457] and wolf['learnedSpells'] == []
              and 'private.greatHunt' not in wolf['dynamicFields'] and 'private.supernatural' not in wolf['dynamicFields'], wolf)
        gr = J('73.json')
        check('staff-granted beast: both powers and both grant flags gone', gr['learnedSpells'] == [] and not any(k in gr['dynamicFields'] for k in ('private.werewolfGrant', 'private.vampireLordGrant')), gr)
        be = J('74.json')
        check('in beast form: the kept look back (then its own eyes), the form\'s spells and the form record gone',
              be['appearanceDump']['raceId'] == 0x13741 and be['appearanceDump']['headpartIds'] == [0x51633, 0x51457] and be['appearanceDump']['skinColor'] == 5
              and be['learnedSpells'] == [] and 'private.beast' not in be['dynamicFields'], be)
        st = J('75.json')
        check('the unrecoverable record is left for the hand check', st['appearanceDump']['raceId'] == 0xCDD84 and st['appearanceDump']['headpartIds'] == [0xE7AEB])
        pg = J('76.json')['dynamicFields']
        check('faith set aside as prayer.js resetDeity does: no god, no conversion clock, the old faith in the history',
              pg['private.dboDeity'] is None and pg['private.dboDeityHistory'][-1]['id'] == 'arkay' and pg['private.dboDeityHistory'][-1]['resetBy'] == 'the alpha reset'
              and pg['private.dboBlessing'] is None and pg['private.dboOffering'] is None and pg['private.prayedShrines'] == {}, pg)
        check('no guild, no bed rented', pg['private.dboGuilds'] == [] and 'private.dboRentBed' not in pg, pg)
        door = J('1b000_Skyrim.esm.json')['dynamicFields']
        check('the house is released as housingSystem release() leaves it: an ownerless stub, serial on, no keys issued, unlocked, unnamed, index 0',
              door['private.housing'] == {'owner': 0, 'ownerName': '', 'name': None, 'locked': False, 'serial': 4, 'partner': 0x1B001, 'containers': [], 'issued': []}
              and door['private.indexed.housingOwner'] == '0', door)
        check('...its held rent (both forms, dboRestOwed and the per-profile dboRestOwedBy) and the inn owner\'s bed go with it',
              not any(k in door for k in ('private.dboRestOwed', 'private.dboRestOwedBy', 'private.dboInnOwnerBed')), door)
        check('rent held per profile on a door given up earlier is cleared too', 'private.dboRestOwedBy' not in J('1b005_Skyrim.esm.json')['dynamicFields'])
        chest = J('1b002_Skyrim.esm.json')
        check('the claimed chest is released and emptied', chest['dynamicFields']['private.housing']['owner'] == 0 and chest['dynamicFields']['private.housing']['serial'] == 2
              and chest['inv']['entries'] == [], chest)
        check('the far door\'s pointer and the old stub are byte-identical', all(open(os.path.join(cf4, n)).read() == v for n, v in untouched.items()))
        check('the bed\'s rent is gone', 'private.dboRent' not in J('1b004_Skyrim.esm.json')['dynamicFields'])
        check('the business\'s ledger is deleted, and the forgotten second ledger with it', J('1dc.json')['isDeleted'] is True and J('1dd.json')['isDeleted'] is True)
        srv4 = os.path.join(root4, 'server')
        G = lambda n: json.load(open(os.path.join(srv4, n)))
        check('housing.json, guilds.json and faction-storage.json are empty; the business is closed',
              G('housing.json') == [] and G('guilds.json') == {} and G('faction-storage.json') == {} and G('businesses.json') == {'businesses': {}, 'owedTo': {}})
        tl = G('tenancy.json')['listings']['1b000']
        check('the listing stays for the officials, with no tenant, offer, interest, deposit held or rent clock',
              tl == {'door': 0x1B000, 'zone': 'bruma', 'deposit': 100, 'weekly': 10, 'listedBy': {'profile': 5}, 'interest': [], 'depositHeld': 0}, tl)
        check('the crown is vacant', G('supernatural.json') == {'crown': None, 'revoke': []})
        check('full: nothing learned survives (a spell that is no tome, marker or staff grant included)', all(not c['keptSpells'] for c in r['characters']), [(c['name'], c['keptSpells']) for c in r['characters'] if c['keptSpells']])
        check('the skill boost on a character is cleared', 'private.xpBoost' not in rdf, rdf)
        pbo = G('playtester-boost.json')['profiles']
        check('a boost window starting before the opening (a staff test) is removed, a playtester\'s from after it kept', sorted(pbo) == ['36'], pbo)
        blk = ar.gates(r)
        check('gates: the record for a hand check blocks the launch, and nothing else does here', blk and all('Stuck' in x for x in blk), blk)
        kept = json.loads(json.dumps(r)); kept['characters'][0]['keptSpells'] = [1]; kept['characters'] = kept['characters'][:1]
        check('gates: a spell kept under the full reset blocks the launch', any('kept spells' in x for x in ar.gates(kept)), ar.gates(kept))
        watched = json.loads(json.dumps(kept)); watched['characters'][0]['keptSpells'] = []; watched['characters'][0]['watch'] = ['private.dboSentence']
        check('gates: a jailed character blocks the launch', any('dboSentence' in x for x in ar.gates(watched)), ar.gates(watched))
        live = json.loads(json.dumps(r)); live['world']['housing']['claims'] = live['world']['housing']['claims'][:1]; live['characters'] = live['characters'][1:]
        diff = ar.compare(r, live)
        check('compare: a claim and a character fewer than the dry run are named', any('claims: 2' in x for x in diff) and any('gone since' in x for x in diff), diff)
        check('compare: the same plan twice is clean', ar.compare(r, json.loads(json.dumps(r))) == [])
        fr, fc = os.path.join(tmp, 'r.json'), os.path.join(tmp, 'clean.json')
        json.dump(r, open(fr, 'w')); clean = json.loads(json.dumps(r)); clean['characters'] = [c for c in clean['characters'] if c['name'] != 'Stuck']; json.dump(clean, open(fc, 'w'))
        check('the gates and compare commands exit 1 on a blocked plan or a difference, 0 when clean',
              ar.main(['gates', fr]) == 1 and ar.main(['gates', fc]) == 0 and ar.main(['compare', fr, fc]) == 1 and ar.main(['compare', fc, fc]) == 0)
        # earned mode: the blessing's spell goes with the faith too
        root5 = os.path.join(tmp, 'sandbox5'); os.makedirs(root5)
        world3_fixture(root5)
        e5 = {c['name']: c for c in ar.plan(ar.World(root5), empty, FakeLO())['characters']}
        check('earned mode: a running blessing\'s spell is taken back with the faith', e5['Pilgrim']['removeSpells'] == [BLESSING], e5['Pilgrim']['removeSpells'])
        check('earned mode: a spell of no known source is kept (only full takes every spell)', 0x12FD0 in e5['Wolf']['keptSpells'], e5['Wolf']['keptSpells'])
        r2 = ar.plan(ar.World(root4), empty, FakeLO(), stats='full')
        check('planned again: nobody to cure but the hand-check record, no claims, no faith, no business',
              [c['name'] for c in r2['characters'] if c.get('cure')] == ['Stuck'] and not r2['world']['housing']['claims']
              and not any(c.get('faith') for c in r2['characters']) and r2['files']['businesses.json']['businesses'] == [], [c['name'] for c in r2['characters'] if c.get('cure')])
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print('all passed' if not failures else f'{failures} FAILED')
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
