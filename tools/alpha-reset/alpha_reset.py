#!/usr/bin/env python3
# DragonBreak Online: the one-time reset at the alpha opening (13 Oct 2026, Nate's alpha decision). Every character stays
# (name, race, look, house claims, factions) with the skills it earned by playing; every inventory, container and store,
# all gold and the bank go back to the start; what staff granted (skill tiers, spells, beast forms, shouts, items) is
# reverted. The starter kit is written into each character and dressed at the next login.
#
#   python3 alpha_reset.py grants [--logs GLOB] --out grants.json            the staff trail, from the server logs
#   python3 alpha_reset.py plan  --root DIR [--grants grants.json] [--stats earned|full] --report report.md [--json plan.json]
#   python3 alpha_reset.py apply --root DIR [--grants grants.json] [--stats earned|full] --report report.md         writes
#
# --stats full is the alpha announcement ("all character stats and items will be reset"): every skill, level point and
# learned spell goes as well. --stats earned (the default) keeps the skills earned by playing.
#
# DIR has the layout of a world snapshot (tools/backups/dbo_backup.py restore): DIR/state/world/changeForms/*.json,
# DIR/state/*.json and DIR/server/*.json. The live paths are refused unless --live is given, the game server is
# stopped and --snapshot names the snapshot taken just before (README.md). Standard library plus ck-mcp/esplib.py.
import argparse
import collections
import datetime
import glob
import gzip
import json
import os
import re
import shutil
import struct
import subprocess
import sys

LIVE_STATE = '/opt/skymp-state'
LIVE_SERVER = '/opt/alduinak/build/dist/server'
DATA = os.environ.get('DBO_DATA', '/opt/skyrim-data')
ORDER = os.environ.get('DBO_LOADORDER', os.path.expanduser('~nate/dragonbreak/fork/deploy/skyrim-data/loadorder.txt'))
ESPLIB = os.environ.get('ESPLIB_DIR', os.path.expanduser('~nate/dragonbreak/ck-mcp'))

GOLD = 0x0000000F
# spawn.ts DEFAULT_STARTING_ITEMS (Miner's Clothes, Miner's Boots, 50 gold; server-settings "startingItems" overrides)
# and gamemode.js STARTER_KIT (gamemode-config "starterKit": Pickaxe, Woodcutter's Axe). The two clothes are worn.
DEFAULT_KIT = [(0x00080697, 1, True), (0x00080699, 1, True), (GOLD, 50, False)]
DEFAULT_TOOLS = [('e3c16:Skyrim.esm', 1), ('2f2f4:Skyrim.esm', 1)]
ITEM_TYPES = {'WEAP', 'ARMO', 'MISC', 'INGR', 'ALCH', 'BOOK', 'AMMO', 'SLGM', 'SCRL', 'KEYM', 'LIGH'}
SUPPLY_CHEST = '12ae13:dragonbreak online edits.esp'   # the staff supply chest (economy audit, 29 Sep)
DAY = 86400000
CONFIG = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'alpha-reset.json')
# fork skillPoints.ts tierOfLevel: Novice 1-24, Apprentice 25-49, Journeyman 50-74, Expert 75-89, Master 90-100; 0 is none.
# The marker spell of tier index t is DBO_Skill_<skill>_T<t+1> (masterySystem.ts loadRules).
TIER_FLOORS = [1, 25, 50, 75, 90]
MARKER = re.compile(r'^DBO_Skill_(\w+?)_T(\d+)$')
# A character holding at least this share of admin-powers.json's spells had "Give all spells", even with no line in the
# logs: those start on 21 Sep, and the grants made on the old home server before then are not in them (Boris #7X44).
ADMIN_SET_SHARE = 0.5
ADMIN_SET_MIN = 20   # and at least this many of them: a handful is what a player could have read from tomes
# --stats full (the alpha announcement: "all character stats and items will be reset"): what a character learned or
# earned goes with the skills. Removed from every character, the skill record and the level points included.
FULL_STATS_FIELDS = ('private.mastery', 'private.dboLevel', 'private.dboAvBonus', 'private.dboStudied', 'private.dboPrepared',
                     'private.dboSchools', 'private.dboManuals', 'private.dboSkillBooks', 'private.dboManualsOwed', 'private.dboRecipes',
                     'private.scholarReads', 'private.scholarTomes', 'private.scholarScrolls', 'private.scholarCopies',
                     'private.dboTomeBoughtAt')
HAND_SLOTS = ('leftSpell', 'rightSpell', 'voiceSpell', 'instantSpell')


def tier_of_level(level):
    level = int(level or 0)
    if level < 1:
        return -1
    return max(i for i, f in enumerate(TIER_FLOORS) if level >= f)


def marker_of(lo, fid):
    """(skill, tier index) of a DBO_Skill_<skill>_T<n> marker spell, else None."""
    if not lo:
        return None
    m = MARKER.match(lo.name(fid) or '')
    return (m.group(1), int(m.group(2)) - 1) if m else None


def desc_key(s):
    """'Skyrim.esm:012FCD' (spell-tomes.json) or '12fcd:Skyrim.esm' -> '12fcd:skyrim.esm'."""
    s = str(s)
    a, _, b = s.partition(':')
    if '.' in a and '.' not in b:
        a, b = b, a
    try:
        return '%x:%s' % (int(a, 16), b.lower())
    except ValueError:
        return s.lower()


def load_config(path=CONFIG):
    """alpha-reset.json: playerCharacters, the staff profiles' own player characters (by tag and profile)."""
    try:
        with open(path, encoding='utf-8') as fh:
            cfg = json.load(fh)
    except FileNotFoundError:
        cfg = {}
    players = {}
    for x in cfg.get('playerCharacters') or []:
        players[(str(x['tag']), int(x['profile']))] = x
    # profile -> entry; 'whole' false: only the character with that tag plays, the account's others stay staff-only
    not_staff = {int(x['profile']): x for x in cfg.get('notStaff') or []}
    return {'players': players, 'notStaff': not_staff}


def log(msg):
    print(msg, file=sys.stderr, flush=True)


# ---- the load order: descs ("hex:Plugin.esm") <-> runtime form ids, and what a record is ---------------------------------
class LoadOrder:
    """Full plugins count 00.. in order; light ones (.esl, or ESL-flagged) are FE xxx yyy, as the server numbers them."""

    def __init__(self, data=DATA, order=ORDER):
        sys.path.insert(0, ESPLIB)
        import esplib   # noqa: E402 (only when plugins are read)
        self.esplib = esplib
        self.data = data
        names = [l.strip() for l in open(order, encoding='utf-8') if l.strip() and not l.startswith('#')]
        self.slot, self.names, self.plugins = {}, {}, {}
        self.by_full, self.by_light = {}, {}   # runtime top byte / light slot -> plugin name
        full = light = 0
        for n in names:
            p = os.path.join(data, n)
            if not os.path.exists(p):
                continue
            with open(p, 'rb') as fh:
                flags = struct.unpack_from('<I', fh.read(12), 8)[0]
            if n.lower().endswith('.esl') or flags & 0x200:
                self.slot[n.lower()] = (0xFE000000 | (light << 12), 0xFFF); self.by_light[light] = n; light += 1
            else:
                self.slot[n.lower()] = (full << 24, 0xFFFFFF); self.by_full[full] = n; full += 1
            self.names[n.lower()] = n
        self.cache = {}

    def id_of(self, desc):
        hexpart, _, plugin = str(desc).partition(':')
        slot = self.slot.get(plugin.lower())
        if not slot:
            return 0
        return (slot[0] | (int(hexpart, 16) & slot[1])) & 0xFFFFFFFF

    def desc_of(self, fid):
        fid &= 0xFFFFFFFF
        if fid >> 24 == 0xFE:
            n = self.by_light.get((fid >> 12) & 0xFFF)
            return '%x:%s' % (fid & 0xFFF, n) if n else ''
        n = self.by_full.get(fid >> 24)
        return '%x:%s' % (fid & 0xFFFFFF, n) if n else ''

    def _own(self, name):
        """A plugin's own new records: local id -> (type, flags, offset, size), built once per plugin."""
        own = self.plugins.get(name)
        if own is None:
            p = self.esplib.Plugin(os.path.join(self.data, name))
            top = len(p.masters)
            own = {'p': p, 'recs': {rid & 0xFFFFFF: (t, fl, off, sz) for t, rid, fl, off, sz, ctx in p.index if rid >> 24 == top and t != 'GRUP'}}
            self.plugins[name] = own
        return own

    def record(self, fid):
        """(type, edid, value) of the record a runtime id names, from its own plugin; None when unknown."""
        fid &= 0xFFFFFFFF
        if fid in self.cache:
            return self.cache[fid]
        desc = self.desc_of(fid)
        out = None
        if desc:
            hexpart, _, name = desc.partition(':')
            own = self._own(name)
            hit = own['recs'].get(int(hexpart, 16))
            if hit:
                t, fl, off, sz = hit
                with open(os.path.join(self.data, name), 'rb') as fh:
                    subs = dict(self.esplib.subrecords(own['p'].data_at(fh, off, sz, fl)))
                edid = subs.get(b'EDID', b'').rstrip(b'\0').decode('cp1252', 'replace')
                data = subs.get(b'DATA') or b''
                value = struct.unpack_from('<I', data, 0)[0] if t in ('WEAP', 'ARMO', 'MISC', 'INGR', 'BOOK', 'SLGM', 'KEYM', 'LIGH') and len(data) >= 4 else 0
                out = (t, edid, value)
        self.cache[fid] = out
        return out

    def name(self, fid):
        r = self.record(fid)
        return r[1] if r and r[1] else ('%08x' % (fid & 0xFFFFFFFF))


# ---- the staff trail: audit lines in the server logs -----------------------------------------------------------------
AUDIT = re.compile(r'^\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)(?:\.\d+)?\] .*?\[gamemode\] audit: (.*)$')
PANEL = re.compile(r'^GM (.+?) #(\w+) \(profile (\d+)[^)]*\) admin panel: (\w+)(.*)$')
ADMINLOG = re.compile(r'^GM profile (\d+) (.*)$')
SPELL = re.compile(r'^SPELL (.+?) #(\w+) \(profile \d+[^)]*\) (learned|took up|prepared) (\S+)')
WHOM = re.compile(r' to (themself|(.+?) \(profile (\d+)\))')


def read_logs(pattern):
    paths = sorted(glob.glob(pattern), key=lambda p: os.path.getmtime(p))
    lines = []
    for p in paths:
        opener = gzip.open if p.endswith('.gz') else open
        try:
            with opener(p, 'rt', encoding='utf-8', errors='replace') as fh:
                for line in fh:
                    m = AUDIT.match(line.rstrip('\n'))
                    if m:
                        lines.append((m.group(1), m.group(2)))
        except OSError as e:
            log(f'log {p} unreadable: {e}')
    lines.sort(key=lambda x: x[0])
    # one line can appear in two rotations only if copytruncate raced; drop exact repeats
    out, seen = [], set()
    for x in lines:
        if x not in seen:
            seen.add(x); out.append(x)
    return out


def parse_trail(lines):
    """Staff grants in time order, and what players learned or took up themselves (by character tag)."""
    grants, learned, took = [], collections.defaultdict(set), collections.defaultdict(set)
    pending = []   # give* panel lines waiting for the admin system's line that names who got it
    for ts, text in lines:
        m = SPELL.match(text)
        if m:
            tag, verb, what = m.group(2), m.group(3), m.group(4)
            (learned if verb in ('learned', 'prepared') else took)[tag].add(what.lower() if verb != 'took up' else what)
            continue
        m = PANEL.match(text)
        if m:
            gm_name, gm_tag, gm_profile, action, rest = m.group(1), m.group(2), int(m.group(3)), m.group(4), m.group(5)
            args = dict(re.findall(r'(\w+)=(\S+)', rest))
            g = {'at': ts, 'gm': f'{gm_name} #{gm_tag} (profile {gm_profile})', 'gmProfile': gm_profile, 'gmTag': gm_tag, 'action': action}
            if action in ('masterySetTier', 'masteryDrop', 'masteryGrant'):
                try:
                    g['target'] = int(args.get('target', ''), 16)
                except ValueError:
                    continue
                g['skill'] = args.get('skill')
                if 'tier' in args:
                    g['tier'] = int(args['tier'])
                if 'amount' in args:
                    g['amount'] = int(args['amount'])
                grants.append(g)
            elif action in ('giveSpells', 'giveWerewolf', 'giveVampireLord', 'giveShouts'):
                pending.append(g)
            elif action == 'giveItem':
                g['item'] = args.get('item'); g['count'] = int(args.get('count', '1') or 1)
                grants.append(g)
            continue
        m = ADMINLOG.match(text)
        if m and pending:
            profile, what = int(m.group(1)), m.group(2)
            if not re.match(r'gave (\d+ spells|werewolf beast form|Vampire Lord form|every shout) to ', what):
                continue
            for i, g in enumerate(pending):
                if g['gmProfile'] != profile:
                    continue
                w = WHOM.search(what)
                if w:
                    g['whom'] = 'themself' if w.group(1) == 'themself' else {'name': w.group(2), 'profile': int(w.group(3))}
                grants.append(g)
                pending.pop(i)
                break
    for g in pending:   # no line named who got it: the GM themself, as the panel defaults to
        g['whom'] = 'themself'; g['guessed'] = True
        grants.append(g)
    grants.sort(key=lambda g: g['at'])
    return {'grants': grants, 'learned': {k: sorted(v) for k, v in learned.items()}, 'tookUp': {k: sorted(v) for k, v in took.items()}}


# ---- the world as a snapshot holds it ---------------------------------------------------------------------------------
class World:
    def __init__(self, root, state=None, server=None, originals=None):
        self.root = root
        self.cf_dir = os.path.join(state or os.path.join(root, 'state'), 'world', 'changeForms')
        self.server = server or os.path.join(root, 'server')
        self.originals = originals or os.path.join(root, 'alpha-reset-originals')
        self.forms = {}
        for n in sorted(os.listdir(self.cf_dir)):
            if n.endswith('.json'):
                with open(os.path.join(self.cf_dir, n), encoding='utf-8') as fh:
                    self.forms[n] = json.load(fh)
        owned = {n: d for n, d in self.forms.items() if (d.get('profileId') if isinstance(d.get('profileId'), int) else -1) >= 0}
        # A deleted character (isDeleted) is gone from its account: spawn.ts's slot list never offers it, so it is
        # neither kept nor written (14 of 51 records on 30 Sep)
        self.chars = {n: d for n, d in owned.items() if not d.get('isDeleted')}
        self.deleted_chars = sorted(n for n, d in owned.items() if d.get('isDeleted'))

    def game_json(self, name, fallback=None):
        p = os.path.join(self.server, name)
        if not os.path.exists(p):
            return fallback
        with open(p, encoding='utf-8-sig') as fh:
            return json.load(fh)


def char_file_of(world, actor_id):
    """A character's change form by its runtime actor id (ff000053 -> 53.json)."""
    n = '%x.json' % (actor_id & 0xFFFFFF)
    return n if n in world.chars else None


def name_of(d):
    app = d.get('appearanceDump') or {}
    return (app.get('name') if isinstance(app, dict) else None) or (d.get('dynamicFields') or {}).get('private.indexed.charName') or '?'


def tag_of(d):
    return (d.get('dynamicFields') or {}).get('private.charTag') or '?'


# ---- the plan -------------------------------------------------------------------------------------------------------
def build_kit(world, lo):
    # server-settings.json is never read here (it holds secrets); it had no "startingItems" on 30 Sep, so the kit is
    # spawn.ts's default. If that setting is ever added, change DEFAULT_KIT to match before the reset.
    settings_items = None
    cfg = world.game_json('gamemode-config.json', {}) or {}
    kit = [{'baseId': b, 'count': c} for b, c, _ in DEFAULT_KIT]
    worn = {b for b, _, w in DEFAULT_KIT if w}
    tools = cfg.get('starterKit') if isinstance(cfg.get('starterKit'), list) else [{'id': d, 'count': c} for d, c in DEFAULT_TOOLS]
    for t in tools:
        fid = lo.id_of(t.get('id', '')) if lo else 0
        if fid:
            kit.append({'baseId': fid, 'count': max(1, int(t.get('count') or 1))})
    return kit, worn, settings_items


def staff_events(trail, world):
    """Per character file: the staff events that touch it."""
    by_char = collections.defaultdict(list)
    tag_to_file = {tag_of(d): n for n, d in world.chars.items()}
    for g in trail['grants']:
        f = None
        if 'target' in g:
            f = char_file_of(world, g['target'])
        elif g.get('whom') == 'themself':
            f = tag_to_file.get(g['gmTag'])
        elif isinstance(g.get('whom'), dict):
            cands = [n for n, d in world.chars.items() if d.get('profileId') == g['whom']['profile'] and name_of(d) == g['whom']['name']]
            if not cands:
                cands = [n for n, d in world.chars.items() if d.get('profileId') == g['whom']['profile']]
            f = cands[0] if len(cands) == 1 else None
        if f:
            by_char[f].append(g)
    return by_char


def plan_mastery(d, events, skills_cfg, tag, trail):
    """What the staff actions on each skill are taken back to; returns (changes, removed spells, dropped skills)."""
    df = d.get('dynamicFields') or {}
    rec = df.get('private.mastery')
    if not isinstance(rec, dict) or not isinstance(rec.get('skills'), dict):
        return [], set(), []
    tier_levels = (skills_cfg or {}).get('tierHours') or [0, 10, 30, 70, 150]
    cap = ((skills_cfg or {}).get('pointSystem') or {}).get('capPerSkill', 100)
    first_touch = max(1, int(((skills_cfg or {}).get('pointSystem') or {}).get('firstTouchCost', 1) or 1))
    order = list(rec.get('order') or [])
    per_skill = collections.defaultdict(list)
    for g in events:
        if g['action'] == 'masteryGrant':
            per_skill[g.get('skill') or (order[0] if order else None)].append(g)
        elif g['action'] in ('masterySetTier', 'masteryDrop') and g.get('skill'):
            per_skill[g['skill']].append(g)
    changes, spells, dropped = [], set(), []
    took = set(trail['tookUp'].get(tag, []))
    for skill, evs in per_skill.items():
        if not skill:
            continue
        prog = rec['skills'].get(skill)
        now = int((prog or {}).get('level') or 0)
        # adminSetTier writes tierHours[4] = 150 for Master, and the record keeps it until the next write; the server
        # reads any level as at most the cap (masterySystem read), so 150 and 100 are the same Master with nothing earned
        now_c = min(now, cap)
        last_set = max((i for i, g in enumerate(evs) if g['action'] in ('masterySetTier', 'masteryDrop')), default=-1)
        written = 0
        if last_set >= 0 and evs[last_set]['action'] == 'masterySetTier':
            t = evs[last_set].get('tier', 0)
            written = min(tier_levels[t] if 0 <= t < len(tier_levels) else 0, cap)
        added = sum(g.get('amount', 0) for g in evs[last_set + 1:] if g['action'] == 'masteryGrant')
        earned = max(0, now_c - written - added)
        first_is_staff = evs[0]['action'] == 'masterySetTier'
        if prog is None:   # set aside, by staff or since: nothing left to take back
            continue
        # A skill the player took up themselves (a study point, a tome) keeps that first level (skills.json firstTouchCost)
        if skill in took and earned < first_touch:
            earned = first_touch
        # Level 0 is "never touched" (skillPoints.ts): the server drops it from the order and never syncs its tier spells,
        # so a skill with nothing earned is set aside, spells and all, rather than left at 0 with its markers
        if earned == 0 and (first_is_staff or now > 0):
            dropped.append(skill)
            spells.update(int(s) for s in (prog.get('granted') or []))
            when = evs[last_set]['at'] if last_set >= 0 else evs[-1]['at']
            changes.append({'skill': skill, 'from': now, 'to': None, 'why': (f'taken up by staff (last set {when})' if first_is_staff else f'staff actions (last {when})')
                            + '; nothing earned since, so set aside'})
        elif earned != now:
            changes.append({'skill': skill, 'from': now, 'to': earned,
                            'why': (f'staff set it to {written} on {evs[last_set]["at"]}' if last_set >= 0 else 'staff hours')
                            + (f' and granted {added} hours' if added else '') + '; only what was earned after stays'
                            + ('; what was earned before the staff action cannot be recovered' if last_set >= 0 else '')})
    return changes, spells, dropped


def plan(world, trail, lo, seed_default=10000, settings=None, stats='earned'):
    """stats 'earned': skills earned by playing stay and only staff grants are taken back (the tool's first design).
    stats 'full': every skill, level point and learned spell goes too (the alpha announcement: "all character stats and
    items will be reset"); what a kept rite gave (vampirism, lycanthropy, the disease) stays."""
    if stats not in ('earned', 'full'):
        raise SystemExit(f'--stats must be earned or full, not {stats}')
    settings = settings or {'players': {}, 'notStaff': {}}
    settings.setdefault('notStaff', {})
    cfg = world.game_json('gamemode-config.json', {}) or {}
    skills_cfg = world.game_json('skills.json', {}) or {}
    powers = world.game_json('admin-powers.json', {}) or {}
    super_state = world.game_json('supernatural.json', {}) or {}
    crown_holder = int(((super_state.get('crown') or {}).get('holder')) or 0)
    crown_revoke = {int(x) for x in (super_state.get('revoke') or []) if str(x).isdigit() or isinstance(x, int)}
    kit, worn, _ = build_kit(world, lo)
    admin_spells = {lo.id_of(s[0]) for s in powers.get('spells') or [] if lo and lo.id_of(s[0])}
    werewolf_power = lo.id_of(powers['werewolf']) if lo and powers.get('werewolf') else 0
    vl_power = lo.id_of(powers['vampirelord']) if lo and powers.get('vampirelord') else 0
    tomes = world.game_json('spell-tomes.json', {}) or {}
    tome_spells = {lo.id_of(desc_key(t['spellId'])) for t in (tomes.get('tomes') or [] if isinstance(tomes, dict) else [])
                   if lo and isinstance(t, dict) and t.get('spellId')} - {0}
    events = staff_events(trail, world)
    out = {'kit': kit, 'characters': [], 'world': {}, 'files': {}, 'notes': [], 'alreadyReset': [], 'stats': stats,
           'deletedCharacters': len(getattr(world, 'deleted_chars', []))}

    # ---- characters ----
    for n, d in world.chars.items():
        df = d.get('dynamicFields') or {}
        tag = tag_of(d)
        ents = ((d.get('inv') or {}).get('entries')) or []
        gold = sum(int(e.get('count') or 0) for e in ents if e.get('baseId') == GOLD)
        removed = [(int(e.get('baseId')), int(e.get('count') or 0)) for e in ents if e.get('baseId') != GOLD]
        c = {'file': n, 'name': name_of(d), 'tag': tag, 'profile': d.get('profileId'),
             'gold': gold, 'bankGold': int(df.get('private.bankGold') or 0), 'items': removed,
             'worn': [int(e.get('baseId')) for e in ((d.get('equipmentDump') or {}).get('inv') or {}).get('entries') or [] if e.get('worn') or e.get('wornLeft')],
             'staff': [f'{g["at"]} {g["action"]}' + (f' {g.get("skill")}' if g.get('skill') else '') + (f' tier {g["tier"]}' if 'tier' in g else '')
                       + (f' {g["amount"]:+d}h' if 'amount' in g else '') + (f' {g.get("count", 1)}x {g.get("item")}' if g['action'] == 'giveItem' else '') + f' by {g["gm"]}'
                       + (' (recipient guessed)' if g.get('guessed') else '') for g in events.get(n, [])]}
        # A character this tool already reset: the staff trail was taken back once, and taking it again would take
        # the skills down a second time (a set to 30 read against 5 left)
        done = bool(df.get('private.alphaReset'))
        if done:
            out['alreadyReset'].append(f'{c["name"]} #{tag}')
        rec = df.get('private.mastery') if isinstance(df.get('private.mastery'), dict) else {}
        skills_rec = rec.get('skills') if isinstance(rec.get('skills'), dict) else {}
        spells_now = [int(s) for s in d.get('learnedSpells') or []]
        # skills
        ch, spells_from_skills, dropped = plan_mastery(d, [] if done else events.get(n, []), skills_cfg, tag, trail)
        # spells: the staff "give all spells" minus what the character learned itself
        got_spells = not done and any(g['action'] == 'giveSpells' for g in events.get(n, []))
        held_admin = [s for s in spells_now if s in admin_spells]
        if not done and not got_spells and len(held_admin) >= max(ADMIN_SET_MIN, ADMIN_SET_SHARE * len(admin_spells)):
            got_spells = True
            c['staff'].append(f'giveSpells before the logs (holds {len(held_admin)} of the {len(admin_spells)} staff spells; '
                              'a grant on the old server before 21 Sep)')
        learned_desc = set(trail['learned'].get(tag, []))
        studied = df.get('private.dboStudied') if isinstance(df.get('private.dboStudied'), dict) else {}
        for lst in studied.values():
            learned_desc.update(str(x).lower() for x in (lst or []))
        kept_ids = {lo.id_of(x) for x in learned_desc} if lo else set()
        for sk, prog in skills_rec.items():
            if sk not in dropped:
                kept_ids.update(int(s) for s in (prog or {}).get('granted') or [])
        # Tier marker spells above the tier a lowered skill now stands at, and every marker of a skill set aside: the
        # server re-derives the rank from the level on load and so never takes them back itself (masterySystem read)
        lowered = {x['skill']: x['to'] for x in ch if x.get('to') is not None}
        markers = set()
        for s in set(spells_now) | {int(x) for p in skills_rec.values() for x in ((p or {}).get('granted') or [])}:
            mk = marker_of(lo, s)
            if mk and (mk[0] in dropped or (mk[0] in lowered and mk[1] > tier_of_level(lowered[mk[0]]))):
                markers.add(s)
        remove = (set(spells_from_skills) - kept_ids) | markers
        if got_spells:
            remove |= {s for s in spells_now if s in admin_spells and s not in kept_ids}
        flags = []
        werewolf_by_rite = ((df.get('private.supernatural') or {}).get('kind') == 'werewolf')
        if df.get('private.werewolfGrant') or (not done and any(g['action'] == 'giveWerewolf' for g in events.get(n, []))):
            flags.append('private.werewolfGrant')
        # The beast forms: taken back unless a rite made the character a werewolf. The Vampire Lord power goes from
        # everyone, since the Blood Crown is released (Nate, 2026-09-30) and staff grants are taken back; vampirism from
        # a rite stays. A grant made before the flags existed shows only as the power itself.
        if werewolf_power and not werewolf_by_rite:
            remove.add(werewolf_power)
        actor_id = 0xFF000000 | int(n[:-5], 16) if re.match(r'^[0-9a-f]+\.json$', n) else 0
        if df.get('private.vampireLordGrant') or (not done and any(g['action'] == 'giveVampireLord' for g in events.get(n, []))):
            flags.append('private.vampireLordGrant')
        if vl_power:
            remove.add(vl_power)
        if df.get('private.dboAllShouts') or (not done and any(g['action'] == 'giveShouts' for g in events.get(n, []))):
            flags.append('private.dboAllShouts')
        modes = df.get('ff_adminModes')
        if isinstance(modes, dict) and any(modes.values()):
            flags.append('ff_adminModes')   # god mode and the like, switched on from the admin panel
        c['clearFields'] = []
        if stats == 'full':
            # Every skill and level point back to the start, and every spell that came from a skill, a tome, a study or
            # staff; spells a kept rite gave (the vampire's stage spells, the werewolf's change, the disease) stay
            c['statsWere'] = {'skills': {k: int((p or {}).get('level') or 0) for k, p in skills_rec.items() if int((p or {}).get('level') or 0) > 0},
                              'level': (df.get('private.dboLevel') or {}).get('level') if isinstance(df.get('private.dboLevel'), dict) else None,
                              'avBonus': {k: v for k, v in (df.get('private.dboAvBonus') or {}).items() if v} if isinstance(df.get('private.dboAvBonus'), dict) else {}}
            ch, dropped = [], sorted(skills_rec)
            studied_ids = {lo.id_of(desc_key(x)) for lst in studied.values() for x in (lst or [])} if lo else set()
            prepared = df.get('private.dboPrepared') if isinstance(df.get('private.dboPrepared'), list) else []
            studied_ids |= {lo.id_of(desc_key(x)) for x in prepared} if lo else set()
            remove |= {s for s in spells_now if marker_of(lo, s) or s in admin_spells or s in tome_spells or s in studied_ids}
            c['clearFields'] = [k for k in FULL_STATS_FIELDS if k in df]
        c['skills'] = ch
        c['dropSkills'] = dropped
        c['removeSpells'] = sorted(s for s in remove if s in spells_now)
        c['revokeGranted'] = sorted(remove)
        c['keptSpells'] = [s for s in spells_now if s not in remove]
        c['clearFlags'] = flags
        # A level earned partly from staff hours is earned again from the kept skills (charlevel.js only ever raises it)
        c['levelReset'] = stats != 'full' and any((x.get('to') or 0) < (x.get('from') or 0) for x in ch) and isinstance(df.get('private.dboLevel'), dict)
        sup = df.get('private.supernatural') or {}
        if sup.get('kind'):
            c['keptSupernatural'] = sup['kind'] + (' (pure-blood)' if sup.get('pure') else '') + ('; gives up the Blood Crown' if crown_holder == actor_id else '')
        # A masked character is unmasked in the record: the mask item goes with the inventory, and a remembered lost
        # mask (private.maskLost) would refuse every mask from then on (playermenu.js mask)
        if str(df.get('maskName') or ''):
            c['unmask'] = str(df.get('maskName'))
        # Still in a state the reset does not undo: listed so the reviewer sees it (none on 30 Sep)
        c['watch'] = [k for k in ('private.restrained', 'private.beast', 'private.dboSentence', 'private.dboCell', 'private.permaDead') if df.get(k)]
        out['characters'].append(c)

    # ---- the world: every container and store emptied, items lying on the ground removed ----
    containers, dropped_items = [], []
    for n, d in world.forms.items():
        if n in world.chars or d.get('recType') == 1 or d.get('isDeleted'):
            continue
        ents = ((d.get('inv') or {}).get('entries')) or []
        if ents:
            containers.append({'file': n, 'form': d.get('formDesc'), 'base': d.get('baseDesc'), 'entries': [(int(e.get('baseId')), int(e.get('count') or 0)) for e in ents],
                               'supply': str(d.get('formDesc', '')).lower() == SUPPLY_CHEST})
            continue
        form = str(d.get('formDesc', ''))
        if ':' not in form and lo:   # a dynamic reference: an item a player dropped, if its base is an item
            base = lo.id_of(d.get('baseDesc', '')) if ':' in str(d.get('baseDesc', '')) else 0
            r = lo.record(base) if base else None
            if r and r[0] in ITEM_TYPES:
                dropped_items.append({'file': n, 'form': form, 'base': d.get('baseDesc'), 'what': r[1], 'count': int(d.get('count') or 1)})
    out['world']['containers'] = containers
    out['world']['droppedItems'] = dropped_items

    # ---- the gameplay files that hold gold or items ----
    zones = world.game_json('zones.json', {}) or {}
    seed = int(((cfg.get('banks') or {}).get('seedGold')) or seed_default)
    treasury_zones = [z['id'] for k in ('holds', 'strongholds', 'regions') for z in zones.get(k, []) if z.get('treasury')]
    files = out['files']
    bank = world.game_json('bank.json')
    if isinstance(bank, dict):
        files['bank.json'] = {'from': {'zones': bank.get('zones'), 'factions': bank.get('factions')},
                              'to': {'zones': {z: seed for z in treasury_zones}, 'factions': {}}}
    biz = world.game_json('businesses.json')
    if isinstance(biz, dict):
        rows = []
        for k, b in (biz.get('businesses') or {}).items():
            rented = [ref for ref, ch in (b.get('chests') or {}).items() if isinstance(ch, dict) and ch.get('renter') is not None]
            rows.append({'business': b.get('name'), 'owner': b.get('ownerName'), 'owed': b.get('owed', 0), 'rentalsEnded': rented})
        files['businesses.json'] = {'businesses': rows, 'owedTo': biz.get('owedTo') or {}}
    ten = world.game_json('tenancy.json')
    if isinstance(ten, dict):
        files['tenancy.json'] = {'deposits': {k: v.get('depositHeld', 0) for k, v in (ten.get('listings') or {}).items() if v.get('depositHeld')}, 'owed': ten.get('owed') or []}
    com = world.game_json('commissions.json')
    if isinstance(com, dict):
        files['commissions.json'] = {'cancelled': [c.get('id') for c in com.get('list') or [] if c.get('state') in ('open', 'taken', 'refused')], 'owed': com.get('owed') or []}
    con = world.game_json('contracts.json')
    if isinstance(con, dict):
        files['contracts.json'] = {'cleared': len(con.get('contracts') or []), 'released': sorted((con.get('taken') or {}).keys())}
    eco = world.game_json('economy.json')
    if isinstance(eco, dict):
        files['economy.json'] = {'owed': eco.get('owed') or {}, 'overdue': eco.get('overdue') or {}}
    if isinstance(super_state, dict) and (super_state.get('crown') or super_state.get('revoke')):
        files['supernatural.json'] = {'released': (super_state.get('crown') or {}).get('name'), 'holder': crown_holder, 'revoke': sorted(crown_revoke)}

    # ---- staff and test characters: staff-only from the opening (Nate, 2026-09-30) ----
    # A staff profile is one that made a GM action on record or had a character flagged admin at its last login;
    # every character on it is listed with why, and a character named for testing is listed whatever its profile
    # A player account that had admin rights while testing (notStaff) is not a staff profile, whatever it did
    not_staff = settings['notStaff']
    whole = {p for p, x in not_staff.items() if x.get('whole', True) is not False}
    exempt = {(str(x.get('tag')), p) for p, x in not_staff.items() if x.get('tag')}
    gm_profiles = {g['gmProfile'] for g in trail['grants'] if 'gmProfile' in g} - whole
    gm_tags = {g['gmTag'] for g in trail['grants'] if 'gmTag' in g}
    admin_profiles = {d.get('profileId') for d in world.chars.values() if (d.get('dynamicFields') or {}).get('isAdmin') is True} - whole
    staff, players = [], []
    for n, d in world.chars.items():
        df = d.get('dynamicFields') or {}
        why = []
        if d.get('profileId') in whole or (tag_of(d), d.get('profileId')) in exempt:
            continue
        if d.get('profileId') in not_staff:
            why.append('a test character on a player account that had admin while testing')
        elif d.get('profileId') in gm_profiles:
            why.append('staff profile (GM actions on record)')
        elif d.get('profileId') in admin_profiles:
            why.append('staff profile (admin at a login)')
        if df.get('isAdmin') is True:
            why.append('admin at its last login')
        if tag_of(d) in gm_tags:
            why.append('GM actions made from this character')
        modes = df.get('ff_adminModes')
        if isinstance(modes, dict) and any(modes.values()):
            why.append('admin modes on (' + ', '.join(k for k, v in modes.items() if v) + ')')
        if re.search(r'test|^GM\b', name_of(d), re.I):
            why.append('named as a test or GM character')
        if not why:
            continue
        row = {'profile': d.get('profileId'), 'name': name_of(d), 'tag': tag_of(d), 'file': n, 'why': why}
        mark = settings['players'].get((tag_of(d), d.get('profileId')))
        if mark:
            row['exception'] = mark.get('by') or 'alpha-reset.json'
            players.append(row)
        else:
            staff.append(row)
    out['staff'] = sorted(staff, key=lambda x: (x['profile'], x['name']))
    out['staffPlayers'] = sorted(players, key=lambda x: (x['profile'], x['name']))
    # a listed exception that matches no character is named, so a typo in the tag is seen
    found = {(x['tag'], x['profile']) for x in players}
    for key, x in settings['players'].items():
        if key not in found:
            out['notes'].append(f'alpha-reset.json lists {x.get("name")} #{key[0]} (profile {key[1]}) as a player character, but no staff character has that tag and profile.')
    out['notStaff'] = []
    for prof, x in sorted(not_staff.items()):
        mine = [d for d in world.chars.values() if d.get('profileId') == prof and (prof in whole or tag_of(d) == str(x.get('tag')))]
        panel = sum(1 for g in trail['grants'] if g.get('gmProfile') == prof)
        out['notStaff'].append({'profile': prof, 'characters': [f'{name_of(d)} #{tag_of(d)}' for d in mine], 'panelActions': panel, 'by': x.get('by') or 'alpha-reset.json'})
        if not mine:
            out['notes'].append(f'alpha-reset.json lists profile {prof} ({x.get("name")}{" #" + str(x.get("tag")) if x.get("tag") else ""}) as not staff, but no such character exists.')
    return out


# ---- apply ----------------------------------------------------------------------------------------------------------
def apply(world, p, report_dir):
    """Writes the plan into the world's files; the originals go to <root>/alpha-reset-originals first."""
    if p.get('alreadyReset'):
        raise SystemExit(f'refused: {len(p["alreadyReset"])} character(s) already carry private.alphaReset ({", ".join(p["alreadyReset"][:5])}); this world was reset once')
    keep = world.originals
    os.makedirs(os.path.join(keep, 'changeForms'), exist_ok=True)
    os.makedirs(os.path.join(keep, 'server'), exist_ok=True)
    written = []

    def save_form(n, d):
        src = os.path.join(world.cf_dir, n)
        if not os.path.exists(os.path.join(keep, 'changeForms', n)):
            shutil.copy2(src, os.path.join(keep, 'changeForms', n))
        tmp = src + '.alpha.tmp'
        with open(tmp, 'w', encoding='utf-8') as fh:
            fh.write(json.dumps(d, indent=2))
        os.replace(tmp, src)
        written.append(n)

    def save_game(name, v, indent=1):
        src = os.path.join(world.server, name)
        if os.path.exists(src) and not os.path.exists(os.path.join(keep, 'server', name)):
            shutil.copy2(src, os.path.join(keep, 'server', name))
        tmp = src + '.alpha.tmp'
        with open(tmp, 'w', encoding='utf-8') as fh:
            fh.write(json.dumps(v, indent=indent))
        os.replace(tmp, src)
        written.append('server/' + name)

    kit = [dict(e) for e in p['kit']]
    worn = {b for b, _, w in DEFAULT_KIT if w}
    for c in p['characters']:
        d = world.forms[c['file']]
        df = d.setdefault('dynamicFields', {})
        d['inv'] = {'entries': [dict(e) for e in kit]}
        eq = d.get('equipmentDump') if isinstance(d.get('equipmentDump'), dict) else {}
        eq['inv'] = {'entries': [dict(e, worn=True) for e in kit if e['baseId'] in worn]}
        # a spell or shout in hand that was taken back leaves the hand too
        gone = set(c.get('revokeGranted') or c['removeSpells'])
        for k in HAND_SLOTS:
            if isinstance(eq.get(k), int) and (eq[k] in gone or (k == 'voiceSpell' and 'private.dboAllShouts' in c['clearFlags'])):
                eq[k] = 0
        d['equipmentDump'] = eq
        for k in ('private.lastWorn', 'private.bankGold', 'private.bankLog', 'private.starterKitAt', 'private.maskLost', 'private.maskItemId'):
            df.pop(k, None)
        if c.get('unmask'):
            app = d.get('appearanceDump') if isinstance(d.get('appearanceDump'), dict) else None
            if app is not None:
                app['name'] = c['unmask']
            df['maskName'] = ''
        df['private.kitPending'] = True
        df['private.alphaReset'] = {'at': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), 'tool': 'alpha_reset.py',
                                    'stats': p.get('stats', 'earned')}
        for k in c['clearFlags']:
            df.pop(k, None)
        for k in c.get('clearFields') or []:
            df.pop(k, None)
        if c['removeSpells']:
            d['learnedSpells'] = [s for s in d.get('learnedSpells') or [] if int(s) not in gone]
        rec = df.get('private.mastery')
        if isinstance(rec, dict) and isinstance(rec.get('skills'), dict):
            for ch in c['skills']:
                prog = rec['skills'].get(ch['skill'])
                if prog is None or ch['to'] is None:
                    continue
                prog['level'] = ch['to']
                prog['rank'] = max(0, tier_of_level(ch['to']))
                if ch['to'] < ch['from']:
                    prog['xp'] = 0
            for sk in c['dropSkills']:
                rec['skills'].pop(sk, None)
                rec['order'] = [x for x in rec.get('order') or [] if x != sk]
            for prog in rec['skills'].values():
                if isinstance(prog, dict) and isinstance(prog.get('granted'), list):
                    prog['granted'] = [s for s in prog['granted'] if int(s) not in gone]
        if c['levelReset']:
            df['private.dboLevel'] = {'level': 1, 'pending': 0, 'spent': {'health': 0, 'magicka': 0, 'stamina': 0}}
            df['private.dboAvBonus'] = {'health': 0, 'magicka': 0, 'stamina': 0}
        save_form(c['file'], d)
    for ct in p['world']['containers']:
        d = world.forms[ct['file']]
        d['inv'] = {'entries': []}
        d['baseContainerAdded'] = True   # the engine never adds the base container's items again
        d.setdefault('dynamicFields', {})['private.dboEmptied'] = True
        save_form(ct['file'], d)
    for it in p['world']['droppedItems']:
        d = world.forms[it['file']]
        d['isDeleted'] = True
        save_form(it['file'], d)
    files = p['files']
    if 'bank.json' in files:
        bank = world.game_json('bank.json')
        bank['zones'] = files['bank.json']['to']['zones']; bank['factions'] = {}
        save_game('bank.json', bank)
    if 'businesses.json' in files:
        biz = world.game_json('businesses.json')
        for b in (biz.get('businesses') or {}).values():
            b['owed'] = 0
            for ch in (b.get('chests') or {}).values():
                if isinstance(ch, dict):
                    for k in ('renter', 'renterName', 'until', 'lapsed'):
                        ch.pop(k, None)
            b['log'] = (b.get('log') or []) + [{'at': int(datetime.datetime.now().timestamp() * 1000), 'text': 'The alpha reset cleared the takings and ended every chest rental'}]
        biz['owedTo'] = {}
        save_game('businesses.json', biz)
    if 'tenancy.json' in files:
        ten = world.game_json('tenancy.json')
        for v in (ten.get('listings') or {}).values():
            if v.get('depositHeld'):
                v['depositHeld'] = 0
        ten['owed'] = []
        save_game('tenancy.json', ten)
    if 'commissions.json' in files:
        com = world.game_json('commissions.json')
        for c in com.get('list') or []:
            if c.get('state') in ('open', 'taken', 'refused'):
                c['state'] = 'cancelled'; c['verdict'] = {'by': None, 'at': int(datetime.datetime.now().timestamp() * 1000), 'to': 'nobody (alpha reset)'}
        com['owed'] = []
        save_game('commissions.json', com)
    if 'contracts.json' in files:
        save_game('contracts.json', {'contracts': [], 'taken': {}}, indent=2)
    if 'economy.json' in files:
        eco = world.game_json('economy.json')
        eco['owed'] = {}; eco['overdue'] = {}
        save_game('economy.json', eco)
    if 'supernatural.json' in files:
        sup = world.game_json('supernatural.json')
        sup['crown'] = None; sup['revoke'] = []
        save_game('supernatural.json', sup)
    return written


# ---- the report -----------------------------------------------------------------------------------------------------
def report(p, lo, path, applied=None):
    nm = (lambda fid: lo.name(fid)) if lo else (lambda fid: '%08x' % fid)
    L = []
    chars = p['characters']
    total_gold = sum(c['gold'] for c in chars)
    total_bank = sum(c['bankGold'] for c in chars)
    staff_touched = [c for c in chars if c['staff'] or c['skills'] or c['clearFlags'] or (p.get('stats') != 'full' and c['removeSpells'])]
    L.append('# Alpha reset: ' + ('applied' if applied is not None else 'dry run'))
    L.append('')
    if p.get('alreadyReset'):
        L.append(f'**This world was reset already: {len(p["alreadyReset"])} character(s) carry the marker. Staff actions are not taken back again, and apply refuses.**')
        L.append('')
    L.append('Stats: ' + ('**full** (the alpha announcement: every skill, level point and learned spell back to the start; spells from a kept rite stay).'
                          if p.get('stats') == 'full' else '**earned** (skills earned by playing stay; staff grants are taken back).'))
    L.append('')
    L.append(f'{len(chars)} characters kept' + (f' ({p["deletedCharacters"]} deleted character record(s) skipped: not on any account)' if p.get('deletedCharacters') else '')
             + '. Everyone starts with the kit: ' + ', '.join(f'{e["count"]} x {nm(e["baseId"])}' for e in p['kit']) + ' (the clothes worn).')
    L.append(f'- Gold carried now: {total_gold:,}; in the bank: {total_bank:,}. Both go to the kit\'s 50 gold.')
    L.append(f'- Items carried now: {sum(sum(n for _, n in c["items"]) for c in chars):,} in {sum(len(c["items"]) for c in chars):,} stacks.')
    L.append(f'- Characters with staff actions to take back: {len(staff_touched)}.')
    L.append(f'- Spells and powers taken back: {sum(len(c["removeSpells"]) for c in chars):,} from {sum(1 for c in chars if c["removeSpells"])} character(s).')
    if p.get('stats') == 'full':
        L.append(f'- Stats reset: {sum(1 for c in chars if (c.get("statsWere") or {}).get("skills"))} character(s) had skills '
                 f'({sum(sum(c["statsWere"]["skills"].values()) for c in chars if c.get("statsWere")):,} levels in all), '
                 f'{sum(1 for c in chars if (c.get("statsWere") or {}).get("level"))} a character level.')
    masked = [f'{c["name"]} #{c["tag"]}' for c in chars if c.get('unmask')]
    if masked:
        L.append(f'- Unmasked in the record (the mask goes with the inventory): {", ".join(masked)}.')
    watch = [f'{c["name"]} #{c["tag"]} ({", ".join(c["watch"])})' for c in chars if c.get('watch')]
    if watch:
        L.append(f'- **Left as they are, check by hand:** {"; ".join(watch)}.')
    w = p['world']
    L.append(f'- Containers emptied: {len(w["containers"])} holding {sum(sum(n for _, n in c["entries"]) for c in w["containers"]):,} items'
             + ('' if not any(c['supply'] for c in w['containers']) else ', the staff supply chest among them') + '.')
    L.append(f'- Items lying in the world removed: {len(w["droppedItems"])}.')
    for f, v in p['files'].items():
        if f == 'bank.json':
            L.append(f'- bank.json: every hold treasury back to its seed ({", ".join(f"{k} {v2:,}" for k, v2 in v["to"]["zones"].items())}); faction treasuries emptied (were {json.dumps(v["from"]["factions"])}); hold balances were {json.dumps(v["from"]["zones"])}.')
        elif f == 'businesses.json':
            L.append(f'- businesses.json: takings cleared and chest rentals ended in {len(v["businesses"])} business(es); held takings for former owners {json.dumps(v["owedTo"])}.')
        elif f == 'tenancy.json':
            L.append(f'- tenancy.json: deposits held set to 0 ({json.dumps(v["deposits"])}), {len(v["owed"])} owed payment(s) dropped. Tenants keep their houses.')
        elif f == 'commissions.json':
            L.append(f'- commissions.json: {len(v["cancelled"])} live commission(s) cancelled without refund, {len(v["owed"])} owed payment(s) dropped.')
        elif f == 'contracts.json':
            L.append(f'- contracts.json: {v["cleared"]} posted contract(s) cleared (their treasuries are reset), {len(v["released"])} hunter(s) released; the board posts fresh ones.')
        elif f == 'economy.json':
            L.append(f'- economy.json: owed wages {json.dumps(v["owed"])} and overdue {json.dumps(v["overdue"])} dropped.')
        elif f == 'supernatural.json':
            L.append(f'- supernatural.json: the Blood Crown is released' + (f' by {v["released"]}' if v['released'] else '') + '; the first to rise a pure-blood after the reset claims it. Its holder keeps their vampirism and gives up the Vampire Lord power.')
    if p['notes']:
        L.append('')
        L.append('## Decisions to confirm')
        for n in p['notes']:
            L.append(f'- {n}')
    if p.get('staff'):
        L.append('')
        L.append(f'## Staff and test characters: staff-only from the opening ({len(p["staff"])})')
        L.append('')
        L.append('Reset like every other character. They do not play in the alpha world (Nate, 2026-09-30). A staff member\'s own player character, if any, is for Nate to mark as the exception.')
        L.append('')
        L.append('| Profile | Character | Why |')
        L.append('|---|---|---|')
        for x in p['staff']:
            L.append(f'| {x["profile"]} | {x["name"]} #{x["tag"]} | {"; ".join(x["why"])} |')
    if p.get('staffPlayers'):
        L.append('')
        L.append(f'## Staff members\' own player characters: play in the alpha ({len(p["staffPlayers"])})')
        L.append('')
        L.append('On a staff profile, but their owners\' own characters (alpha-reset.json playerCharacters). Reset like everyone else, staff grants on them taken back; they are not staff-only.')
        L.append('')
        L.append('| Profile | Character | Marked by |')
        L.append('|---|---|---|')
        for x in p['staffPlayers']:
            L.append(f'| {x["profile"]} | {x["name"]} #{x["tag"]} | {x["exception"]} |')
    if p.get('notStaff'):
        L.append('')
        L.append(f'## Players who had admin rights while testing: not staff ({len(p["notStaff"])})')
        L.append('')
        L.append('Player accounts (alpha-reset.json notStaff). They are in neither staff table. What they granted with the admin panel is taken back like any staff grant, and they are reset like everyone else.')
        L.append('')
        L.append('| Profile | Characters who play | Admin panel actions on record (the whole account) | Marked by |')
        L.append('|---|---|---|---|')
        for x in p['notStaff']:
            L.append(f'| {x["profile"]} | {", ".join(x["characters"]) or "none"} | {x["panelActions"]} | {x["by"]} |')
    L.append('')
    L.append('## Per character')
    for c in sorted(chars, key=lambda c: (-len(c['staff']), c['name'])):
        L.append('')
        L.append(f'### {c["name"]} #{c["tag"]} (profile {c["profile"]}, {c["file"]})')
        top = sorted(c['items'], key=lambda x: -x[1])
        L.append(f'- Gold {c["gold"]:,} carried' + (f', {c["bankGold"]:,} banked' if c['bankGold'] else '') + f'; {len(c["items"])} item stack(s) removed'
                 + (': ' + ', '.join(f'{n} x {nm(b)}' for b, n in top[:8]) + (' ...' if len(top) > 8 else '') if top else ''))
        if c['worn']:
            L.append('- Worn now: ' + ', '.join(nm(b) for b in c['worn'][:8]))
        for ch in c['skills']:
            L.append(f'- Skill {ch["skill"]}: {ch["from"]} -> {"set aside" if ch["to"] is None else ch["to"]} ({ch["why"]})')
        if c.get('statsWere') and (c['statsWere']['skills'] or c['statsWere']['level'] or c['statsWere']['avBonus']):
            sw = c['statsWere']
            L.append('- Stats reset: ' + (', '.join(f'{k} {v}' for k, v in sorted(sw['skills'].items(), key=lambda x: -x[1])) or 'no skills')
                     + (f'; character level {sw["level"]}' if sw['level'] else '') + (f'; level points {json.dumps(sw["avBonus"])}' if sw['avBonus'] else ''))
        if p.get('stats') == 'full' and c.get('clearFields'):
            L.append('- Cleared: ' + ', '.join(k.replace('private.', '') for k in c['clearFields']))
        if c.get('keptSpells') and (p.get('stats') == 'full' or c['removeSpells']):
            L.append(f'- Spells kept ({len(c["keptSpells"])}): ' + ', '.join(nm(s) for s in c['keptSpells'][:12]) + (' ...' if len(c['keptSpells']) > 12 else ''))
        if c['removeSpells']:
            L.append(f'- Spells and powers taken back ({len(c["removeSpells"])}): ' + ', '.join(nm(s) for s in c['removeSpells'][:12]) + (' ...' if len(c['removeSpells']) > 12 else ''))
        if c['clearFlags']:
            L.append('- Staff flags cleared: ' + ', '.join(c['clearFlags']))
        if c['levelReset']:
            L.append('- Character level points reset: the level is earned again from the kept skills at the next login and its points chosen anew')
        if c.get('keptSupernatural'):
            L.append(f'- Kept (earned in a rite): {c["keptSupernatural"]}')
        if c['staff']:
            L.append(f'- Staff actions on record ({len(c["staff"])}): ' + '; '.join(c['staff'][:6]) + (' ...' if len(c['staff']) > 6 else ''))
    L.append('')
    L.append('## Containers emptied (largest first)')
    for ct in sorted(w['containers'], key=lambda c: -sum(n for _, n in c['entries']))[:30]:
        L.append(f'- {ct["form"]} (base {ct["base"]}): {sum(n for _, n in ct["entries"]):,} items' + (' - the staff supply chest' if ct['supply'] else ''))
    if len(w['containers']) > 30:
        L.append(f'- ... and {len(w["containers"]) - 30} more')
    if w['droppedItems']:
        L.append('')
        L.append('## Items lying in the world, removed')
        for it in w['droppedItems'][:40]:
            L.append(f'- {it["form"]}: {it["count"]} x {it["what"]}')
    if applied is not None:
        L.append('')
        L.append(f'Files written: {len(applied)}. The originals are in alpha-reset-originals/ beside them.')
    with open(path, 'w', encoding='utf-8') as fh:
        fh.write('\n'.join(L) + '\n')
    return L


# ---- safety ---------------------------------------------------------------------------------------------------------
def check_root(root, live, snapshot, state=None, server=None, originals=None):
    livep = [os.path.realpath(x) for x in (LIVE_STATE, LIVE_SERVER)]
    dirs = [d for d in (root, state, server, originals) if d]
    touches_live = any(any(os.path.realpath(d) == x or os.path.realpath(d).startswith(x + os.sep) or x.startswith(os.path.realpath(d) + os.sep) for x in livep) for d in dirs)
    cf = os.path.join(state or os.path.join(root or '', 'state'), 'world', 'changeForms')
    if not os.path.isdir(cf):
        raise SystemExit(f'{cf} is not there: give a snapshot-layout --root (dbo_backup.py restore), or --state and --server')
    if live and not originals and not root:
        raise SystemExit('refused: --live needs --originals <a folder outside the live paths> for the files it replaces')
    if touches_live and not live:
        raise SystemExit(f'refused: {", ".join(dirs)} is or holds the live state; work on a sandbox restore, or see README "On the day"')
    if live:
        if not snapshot or not os.path.exists(snapshot):
            raise SystemExit('refused: --live needs --snapshot <the snapshot taken just before>')
        state = subprocess.run(['systemctl', 'is-active', 'skymp'], capture_output=True, text=True).stdout.strip()
        if state in ('active', 'activating', 'reloading'):
            raise SystemExit(f'refused: skymp is {state}; stop the game server first (under the claim)')


def main(argv=None):
    ap = argparse.ArgumentParser(description='The one-time alpha reset (README.md)')
    sub = ap.add_subparsers(dest='cmd', required=True)
    g = sub.add_parser('grants'); g.add_argument('--logs', default='/var/log/skymp-server.log*'); g.add_argument('--out', required=True)
    for name in ('plan', 'apply'):
        s = sub.add_parser(name)
        s.add_argument('--root', help='a snapshot-layout folder (state/, server/)')
        s.add_argument('--state', help='instead of --root: the state folder (holds world/changeForms)')
        s.add_argument('--server', help='instead of --root: the folder with the gameplay files')
        s.add_argument('--originals', help='where the replaced files are kept (default <root>/alpha-reset-originals)')
        s.add_argument('--grants', help='from the grants command; read from --logs when absent')
        s.add_argument('--logs', default='/var/log/skymp-server.log*')
        s.add_argument('--report', required=True)
        s.add_argument('--json')
        s.add_argument('--live', action='store_true')
        s.add_argument('--snapshot')
        s.add_argument('--no-plugins', action='store_true', help='skip the load order (tests): no names, no dropped-item check')
        s.add_argument('--config', default=CONFIG, help='alpha-reset.json (playerCharacters)')
        s.add_argument('--stats', choices=('earned', 'full'), default='earned',
                       help='earned: skills earned by playing stay, staff grants go; full: every skill, level point and learned '
                            'spell goes too (the alpha announcement). Spells from a kept rite stay either way')
    a = ap.parse_args(argv)
    if a.cmd == 'grants':
        trail = parse_trail(read_logs(a.logs))
        with open(a.out, 'w', encoding='utf-8') as fh:
            json.dump(trail, fh, indent=1)
        log(f'{len(trail["grants"])} staff grants, spells learned by {len(trail["learned"])} characters -> {a.out}')
        return 0
    if not a.root and not (a.state and a.server):
        raise SystemExit('give --root, or --state and --server')
    check_root(a.root, a.live, a.snapshot, a.state, a.server, a.originals)
    world = World(a.root, a.state, a.server, a.originals)
    if a.grants:
        with open(a.grants, encoding='utf-8') as fh:
            trail = json.load(fh)
    else:
        trail = parse_trail(read_logs(a.logs))
    lo = None if a.no_plugins else LoadOrder()
    p = plan(world, trail, lo, settings=load_config(a.config), stats=a.stats)
    if a.json:
        with open(a.json, 'w', encoding='utf-8') as fh:
            json.dump(p, fh, indent=1)
    applied = apply(world, p, os.path.dirname(a.report)) if a.cmd == 'apply' else None
    lines = report(p, lo, a.report, applied)
    for line in lines[:12]:
        print(line)
    return 0


if __name__ == '__main__':
    sys.exit(main())
