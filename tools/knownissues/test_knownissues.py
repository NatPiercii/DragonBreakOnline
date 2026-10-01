#!/usr/bin/env python3
"""Self-test for knownissues.py: signatures and masking, the log reader (offsets, a record still being written,
copytruncate), crashes from the launcher's session ends without names, /bug snapshot links, and the posts against a
stub forum (tags, one post per kind, edits not messages, Fixed, Ignore, locked, deleted, archived, a lost state).

    python3 tools/knownissues/test_knownissues.py

Fixtures only: every file is written under /tmp/claude-nate-ki-test-*, removed afterwards. The stub stands in for Discord.
The real dbdiscord (/opt/dragonbreak-tools/dbdiscord) is loaded only to check its open_thread pings nobody; its call()
is replaced first, so nothing is sent.
"""
import json, os, shutil, subprocess, sys, tempfile, time, io, contextlib, re, calendar

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import knownissues as K  # noqa: E402

fails = 0
checks = 0


def ok(cond, what, got=''):
    global fails, checks
    checks += 1
    print(('ok   ' if cond else 'FAIL ') + what + ('' if cond else f'   {str(got)[:400]}'))
    fails += 0 if cond else 1


NOW = calendar.timegm((2026, 10, 1, 15, 30, 0))
FORUM, TRACKER = 'F1', 'BT1'


class Fake:
    """Discord, as much of it as the tool uses: one forum, the tracker, threads with a first message."""

    class DiscordError(Exception):
        def __init__(self, status):
            super().__init__(f'HTTP {status}')
            self.status, self.code = status, None

    def __init__(self):
        self.calls, self.next = [], 5000
        self.tags = [{'id': '900', 'name': 'Old tag', 'moderated': True}]
        self.threads = {}

    @staticmethod
    def tag_key(name):
        return ' '.join(str(name).casefold().split())

    def guild_id(self):
        return 'G'

    def add_thread(self, parent, name, content, owner='BOT', tid=None):
        tid = tid or str(self.next)
        self.next += 1
        self.threads[tid] = {'id': tid, 'parent_id': parent, 'owner_id': owner, 'name': name, 'applied_tags': [],
                             'thread_metadata': {'archived': False, 'locked': False},
                             'messages': [{'id': tid, 'content': content}]}
        return tid

    def forum_threads(self, gid, forum):
        return [json.loads(json.dumps({k: v for k, v in t.items() if k != 'messages'}))
                for t in self.threads.values() if t['parent_id'] == forum]

    def open_thread(self, forum, title, body, tags=(), soft=False):
        self.calls.append(('OPEN', forum, title, body, list(tags)))
        tid = self.add_thread(forum, title, body[:1900])
        self.threads[tid]['applied_tags'] = list(tags)
        return {'id': tid}

    def call(self, method, path, body=None, tries=4, soft=False):
        self.calls.append((method, path, body))
        parts = path.strip('/').split('/')
        if path == '/users/@me':
            return {'id': 'BOT'}
        if parts[0] == 'channels' and parts[1] == FORUM and len(parts) == 2:
            if method == 'PATCH':
                for t in body['available_tags']:
                    if 'id' not in t:
                        t['id'] = str(self.next)
                        self.next += 1
                self.tags = body['available_tags']
            return {'id': FORUM, 'available_tags': self.tags}
        th = self.threads.get(parts[1])
        if th is None:
            raise self.DiscordError(404)
        if len(parts) == 2:
            if method == 'PATCH':
                th['thread_metadata'].update(body)
            return {k: v for k, v in th.items() if k != 'messages'}
        if method == 'GET' and len(parts) == 4:
            return dict(th['messages'][0])
        if method == 'PATCH' and len(parts) == 4:
            if th['thread_metadata']['archived']:
                raise self.DiscordError(400)          # Discord refuses an edit in an archived thread
            th['messages'][0]['content'] = body['content']
            return dict(th['messages'][0])
        if method == 'POST' and len(parts) == 3:
            th['messages'].append({'id': str(self.next), 'content': body['content'], 'allowed_mentions': body.get('allowed_mentions')})
            self.next += 1
            th['thread_metadata']['archived'] = False
            return th['messages'][-1]
        raise AssertionError(f'unexpected call {method} {path}')

    def writes(self, since=0):
        return [c for c in self.calls[since:] if c[0] in ('OPEN', 'POST', 'PATCH', 'PUT', 'DELETE')]


FAKE = Fake()
K.load_dbdiscord = lambda path: FAKE


def ts(hm, sec=0, day='2026-10-01'):
    return f'[{day} {hm}:{sec:02d}.123]'


def run(d, *extra, now=NOW):
    """knownissues.main with every path in the fixture folder; returns (exit code, output)."""
    argv = ['--state', f'{d}/state.json', '--log', f'{d}/server.log', '--session-ends', f'{d}/session-ends.jsonl',
            '--bugs', f'{d}/bugs', '--forum', FORUM, '--bug-tracker', TRACKER, '--gap', '0', '--now', str(now)]
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        try:
            rc = K.main(argv + list(extra))
        except SystemExit as e:
            rc = e.code
    return rc, buf.getvalue()


def state(d):
    with open(f'{d}/state.json') as fh:
        return json.load(fh)


def sig_of(st, needle):
    return next((k for k, s in st['sigs'].items() if needle in s['sig']), None)


def quiet(hm):
    """An ordinary line: it ends the error record before it, which a run holds back while it is the log's last."""
    return f"{ts(hm, 59)} [console] [info] [gamemode] npcGround player fine\n"


def append(path, text):
    with open(path, 'a') as fh:
        fh.write(text)


def main():
    d = tempfile.mkdtemp(prefix='claude-nate-ki-test-', dir='/tmp')
    try:
        signatures()
        reading(d)
        posting(d)
        dbdiscord_pings_nobody()
    finally:
        shutil.rmtree(d, ignore_errors=True)
    print(f'{checks - fails} of {checks} checks passed' if fails else f'all {checks} checks passed')
    return 1 if fails else 0


# ---- signatures ---------------------------------------------------------------------------------------------------
def cls(line, cont=()):
    return K.classify(line, list(cont))


def signatures():
    a = cls('[console] [error] Form with id 0x80d0598 doesn\'t exist')
    b = cls('[console] [error] Form with id 80c83a0 doesn\'t exist')
    ok(a and b and a[1] == b[1] == "Form with id <id> doesn't exist", 'form ids, 0x or bare hex, make one kind', (a, b))
    c1 = cls('[error] SendToNeighbours - No permission to update actor ff000bac (not a hoster)')
    c2 = cls('[error] SendToNeighbours - No permission to update actor ff000c01 (not a hoster)')
    ok(c1[1] == c2[1] == 'SendToNeighbours - No permission to update actor <id> (not a hoster)', 'actor ids fold', c1)
    rules = K.load_ignore(K.IGNORE)
    ok(K.ignore_reason(rules, 'server', c1[1]) is not None, '...and "not a hoster" is on the ignore list, with a reason')
    burst = cls('[error] SendToNeighbours - No permission to send OnSpellCast with caster actor ff000bb5')
    ok(K.ignore_reason(rules, 'server', burst[1]) is not None, 'SendToNeighbours permission bursts are ignored')
    ctx = ['  ╭--------', '  | (custom) baseDesc', '  | (uint) 4278190336',
           '  ╰-- /opt/alduinak/skymp5-server/cpp/addon/ScampServer.cpp:1156 - Get']
    base = cls('[console] [error] resolved context with 1 entries (reason=exception):', ctx)
    ok(base[1] == 'resolved context (reason=exception): custom baseDesc @ ScampServer.cpp Get',
       'a "resolved context" dump folds into one line: the property, the file and the function', base)
    ok(K.ignore_reason(rules, 'server', base[1]) is not None, '...the baseDesc trace B triaged is ignored')
    wc = cls('[console] [error] resolved context with 1 entries (reason=exception):', [x.replace('baseDesc', 'worldOrCellDesc') for x in ctx])
    ok(K.ignore_reason(rules, 'server', wc[1]) is None and 'worldOrCellDesc' in wc[1], '...the worldOrCellDesc one is not')
    ok('ScampServer.cpp:1156 - Get' in base[2] and '(custom) baseDesc' in base[2], '...its sample keeps the dump, one line', base[2])
    login = cls('[console] [error] Error logging in client: {"session":"28d06c8b3e0341f14b0059e8fe72103d03fd224bcedd8e2f4232d43f63ad17f4"} '
                'Error: getUserProfile: HTTP error 403 clientOutdated',
                ['    at lM.getUserProfile (/opt/skymp5-server/ts/systems/login.ts:80:15)', '    at processTicksAndRejections (node:internal)'])
    ok(login[1] == 'Error logging in client: <json> Error: getUserProfile: HTTP error <n> clientOutdated @ login.ts',
       'a stack keeps its first file, without line numbers', login[1])
    ok('28d06c8b' not in login[2] and '<json>' in login[2] and 'login.ts:80' in login[2], '...the session id is masked in the sample', login[2])
    named = cls('[console] [error] something failed for Aldemar Vauclaire #8HSY near Lord Velas Silvershaft #Z7EG')
    ok('Aldemar' not in named[1] + named[2] and 'Velas' not in named[1] + named[2] and named[3] == {'t8HSY', 'tZ7EG'},
       'player names are masked, and each tag counts a player', named)
    ip = cls('[console] [error] Error updating info on master server: Error: connect ECONNREFUSED 127.0.0.1:3000')
    ok('<ip>' in ip[1] and '127.0.0.1' not in ip[2], 'addresses are masked', ip)
    who = cls('[console] [error] role sync failed for <@123456789012345678> (discord 123456789012345678) at https://discord.com/api/webhooks/1/abc')
    ok('123456789012345678' not in who[2] and 'webhooks' not in who[2], 'Discord ids, mentions and URLs are masked', who[2])
    m1 = cls("[error] VirtualMachine::CallMethod - Method not found - 'Add'")
    m2 = cls("[error] VirtualMachine::CallMethod - Method not found - 'GetAngleZ'")
    ok(m1[1] != m2[1] and "'Add'" in m1[1], 'a quoted method name stays: two methods are two kinds', (m1[1], m2[1]))
    z1 = cls("[console] [error] NpcSpawnSystem: 'wild:fox:2943' failed to spawn 2ebe2:Skyrim.esm: Error: Form with id 0x2ebe2 doesn't exist")
    z2 = cls("[console] [error] NpcSpawnSystem: 'dungeon:bandit:12' failed to spawn 5f056:BSHeartland.esm: Error: Form with id 0x5f056 doesn't exist")
    ok(z1[1] == z2[1], 'quoted text that is not a name, and form descs, fold', (z1[1], z2[1]))
    w1 = cls("[error] WorldSpace doesn't match: caster is in CYRBawn02 (0x80a764b), target is in CYRBrumaSynodConclave (0x806a7bd)")
    w2 = cls("[error] WorldSpace doesn't match: caster is in BSHeartland (0x80a764b), target is in CYRSilorn (0x806a7bd)")
    ok(w1[1] == w2[1] == "WorldSpace doesn't match: caster is in <edid> (<id>), target is in <edid> (<id>)", 'cell editor ids fold', w1[1])
    diag = cls('[console] [info] [gamemode] [dboDiag] profile 21 Dar #U6T6 window error: Uncaught TypeError: x is undefined at app.js:12')
    ok(diag and diag[0] == 'client' and diag[3] == {'p21'} and 'Dar' not in diag[2], 'a client dboDiag error counts its profile', diag)
    ok(cls('[console] [info] [gamemode] [dboDiag] profile 21 Dar #U6T6 lag beat=5 drift=0ms worst=1ms') is None,
       '...a dboDiag line that reports no error is not one')
    rel = cls('[console] [info] [gamemode] npcDrift Argosh gro-Shatul #4X3G error: {"kind":"error","remoteId":"ff00001e",'
              '"error":"Error: SP3NativeValueCasts::JsObjectToNativeObject - Invalid _skyrimPlatform_indexInPool: 1086957, expected to be in [1208173, 1208259) range"}')
    ok(rel and rel[0] == 'client' and rel[1].startswith('npcDrift: Error: SP<n>NativeValueCasts') and 'Argosh' not in rel[2]
       and rel[3] == {'t4X3G'}, 'an error the client relays through npcDrift is a client error', rel)
    ok(cls('[console] [info] [gamemode] BUGREPORT Dar #U6T6 2026-10-01T13-04-28-U6T6.json: TypeError everywhere') is None,
       "a player's /bug text is never read as an error")
    ok(cls('[console] [info] [gamemode] supernatural: Flo\'Riahn #Z7EG failed Molag Bal\'s Embrace (1/3)') is None,
       'a failed rite is not an error')
    ok(cls('[console] [info] [gamemode] naming.js failed to load: ReferenceError: Cannot access \'onUi\' before initialization')[0] == 'server',
       'an exception at the info level is one')
    fake_token = '.'.join(['MTA5ODc2NTQz' + 'MjEwOTg3NjU0', 'GaBc' + 'De', 'abcdefghijklm' + 'nopqrstuvwxyz0123456'])  # built, so no token is in the file
    ok(K.secret_in(f'a token {fake_token}') == 'a bot token'
       and K.secret_in('from 10.10.10.2') == 'an IP address' and K.secret_in('<#1555237156677754950> and key `ki-0123456789ab`') is None
       and K.secret_in('user 155523715667775495') == 'a Discord id', 'the last check before a post: tokens, addresses and ids, not thread links')


# ---- reading ------------------------------------------------------------------------------------------------------
def reading(d):
    os.makedirs(f'{d}/bugs')
    log = f'{d}/server.log'
    with open(log, 'w') as fh:
        fh.write(f"{ts('14:00')} [console] [info] Server started\n")
        for i in range(25):
            fh.write(f"{ts('14:01', i)} [console] [error] Form with id 0x80d05{i:02x} doesn't exist\n")
        fh.write(f"{ts('14:02')} [console] [error] resolved context with 1 entries (reason=exception):\n"
                 "  ╭--------\n  | (custom) worldOrCellDesc\n  | (uint) 4278190336\n"
                 "  ╰-- /opt/alduinak/skymp5-server/cpp/addon/ScampServer.cpp:1156 - Get\n")
        fh.write(f"{ts('14:03')} [error] SendToNeighbours - No permission to update actor ff000bac (not a hoster)\n")
        fh.write(f"{ts('14:04')} [console] [error] resolved context with 1 entries (reason=exception):\n  ╭--------\n")
    rc, out = run(d, '--collect')
    st = state(d)
    form = sig_of(st, 'Form with id')
    ok(rc == 0 and st['sigs'][form]['count'] == 25, 'a first run reads the whole log: 25 of one kind', out)
    ok(sig_of(st, 'custom ?') is None and st['log']['offset'] < os.path.getsize(log),
       'a dump still being written at the end of the log is held back, not counted half', st['log'])
    append(log, "  | (custom) profileId\n  | (uint) 4278190336\n  ╰-- /opt/alduinak/skymp5-server/cpp/addon/ScampServer.cpp:1156 - Get\n"
                f"{ts('14:05')} [console] [error] Form with id 0x80d0599 doesn't exist\n" + quiet('14:05')
                + f"{ts('14:06')} [console] [error] Form with id 0x80d")
    run(d, '--collect')
    st = state(d)
    prof = sig_of(st, 'custom profileId')
    ok(prof and st['sigs'][prof]['count'] == 1 and st['sigs'][form]['count'] == 26,
       'the next run counts it once, whole, and only the new lines', {k: v['count'] for k, v in st['sigs'].items()})
    ok(st['sigs'][form]['first'] == '2026-10-01 14:01' and st['sigs'][form]['last'] == '2026-10-01 14:05'
       and st['sigs'][form]['hours'] == {'2026-10-01T14': 26}, 'first and last seen, and the hourly counts', st['sigs'][form])
    ok(st['sigs'][form]['count'] == 26, 'half a line at the end is left for the next run')
    hold = f'{d}/hold.log'
    with open(hold, 'w') as fh:
        fh.write(f"{ts('14:00')} [console] [error] Refr pointer expired\n")
    st_h = K.new_state()
    first = K.read_log(st_h, hold)
    append(hold, quiet('14:00'))
    second = K.read_log(st_h, hold)
    ok(first == [] and len(second) == 1, "the log's last error line waits for the next line before it counts, then counts once", (first, second))
    # logrotate's copytruncate: the lines written after our last run end up in .1
    append(log, "0598 doesn't exist\n" + f"{ts('14:07')} [console] [error] Refr pointer expired\n")
    shutil.copyfile(log, log + '.1')
    open(log, 'w').close()
    append(log, f"{ts('14:08')} [console] [error] Refr pointer expired\n" + quiet('14:08'))
    run(d, '--collect')
    st = state(d)
    refr = sig_of(st, 'Refr pointer')
    ok(st['sigs'][form]['count'] == 27 and st['sigs'][refr]['count'] == 2,
       'after a copytruncate the rest of .1 is read, then the new log from its start, nothing twice',
       {st['sigs'][k]['sig']: st['sigs'][k]['count'] for k in st['sigs']})
    run(d, '--collect')
    ok(state(d)['sigs'][refr]['count'] == 2, 'a run with nothing new counts nothing')
    os.remove(log + '.1')
    with open(log, 'w') as fh:
        fh.write(f"{ts('14:09')} [console] [info] Server started again, a different file\n")
    rc, out = run(d, '--collect')
    ok('the log was rotated' in out, 'a rotation whose .1 is not the file read last time says what it could not count', out)

    # the launcher's session ends: crashes only, never a name or a Discord id
    rows = [dict(at=1790859000000 + i, profileId=40 + i % 3, discordId='998877665544332211', name='Secret Name',
                 outcome='crash' if i % 2 == 0 else 'closed', exitCode=3221225477 if i % 2 == 0 else 0,
                 crashLog=True, startedAt=0, endedAt=1790859000000 + i, launcherVersion='2.1.35', filesVersion='0.3.72')
            for i in range(8)]
    with open(f'{d}/session-ends.jsonl', 'w') as fh:
        fh.write(''.join(json.dumps(r) + '\n' for r in rows))
    run(d, '--collect')
    st = state(d)
    crash = sig_of(st, 'Game crashed')
    ok(crash and st['sigs'][crash]['count'] == 4 and st['sigs'][crash]['source'] == 'launcher'
       and st['sigs'][crash]['sig'] == 'Game crashed, exit code 3221225477 (0xC0000005, access violation)',
       'session ends: the four crashes, by exit code; the clean closes are not counted', st['sigs'].get(crash))
    ok(len(st['sigs'][crash]['players']) == 3 and st['sigs'][crash]['versions'] == {'0.3.72': 4},
       '...three players (hashed profile ids) and the client version', st['sigs'][crash])
    raw = open(f'{d}/state.json').read()
    ok('Secret Name' not in raw and '998877665544332211' not in raw and '"41"' not in raw,
       '...and the saved state holds no name, Discord id or profile id')
    ok(oct(os.stat(f'{d}/state.json').st_mode & 0o777) == '0o600', 'the state is readable by its owner only')
    append(f'{d}/session-ends.jsonl', json.dumps(dict(rows[0], at=1790859999999)) + '\n')
    run(d, '--collect')
    ok(state(d)['sigs'][crash]['count'] == 5, '...the next run reads only the new session ends')

    # /bug snapshots: their error kinds, ignored ones left out
    snap = {'at': 0, 'by': 'Dar #U6T6', 'text': 'x', 'view': {}, 'voice': [], 'log': [
        f"{ts('14:30')} [error] SendToNeighbours - No permission to update actor ff000bac (not a hoster)",
        f"{ts('14:30')} [console] [error] Refr pointer expired",
        f"{ts('14:30')} [console] [info] [gamemode] npcGround fine"]}
    with open(f'{d}/bugs/2026-10-01T14-31-00-U6T6.json', 'w') as fh:
        json.dump(snap, fh)
    run(d, '--collect')
    st = state(d)
    e = st['snapshots'].get('2026-10-01T14-31-00-U6T6.json')
    ok(e and e['keys'] == [refr] and st['sigs'][refr]['count'] == 2,
       'a /bug snapshot keeps the kinds of its errors (not the ignored one) and adds no count', e)


# ---- posting ------------------------------------------------------------------------------------------------------
def posting(d):
    st = state(d)
    form, refr, crash = sig_of(st, 'Form with id'), sig_of(st, 'Refr pointer'), sig_of(st, 'Game crashed')
    log = f'{d}/server.log'
    lines = []
    for i in range(30):            # fourteen more kinds over the threshold, and the not-a-hoster noise
        for j in range(21 + i):
            lines.append(f"{ts('15:00', j % 60)} [console] [error] Kind number {chr(65 + i % 26)}{chr(65 + i // 26)} broke ff0000{j:02x}\n")
    lines += [f"{ts('15:01', j)} [error] SendToNeighbours - No permission to update actor ff000bac (not a hoster)\n" for j in range(50)]
    lines.append(quiet('15:01'))
    append(log, ''.join(lines))
    FAKE.add_thread(TRACKER, 'Dar #U6T6: the fox is floating', '**Bug report** from Dar #U6T6\n\nSnapshot: `2026-10-01T14-31-00-U6T6.json` (dbo_inspect.py reads it)',
                    tid=str((int((calendar.timegm((2026, 10, 1, 14, 31, 5)) * 1000) - 1420070400000) << 22)))
    before = open(f'{d}/state.json').read()
    rc, out = run(d)
    ok(rc == 0 and not FAKE.writes() and open(f'{d}/state.json').read() == before,
       'a dry run writes nothing to Discord and saves nothing', FAKE.writes())
    ok('would create the forum tags Known, Fixing, Fixed, Ignore' in out and out.count('would open a post') == 10,
       '...it says it would create the four tags and open ten posts', out[:600])
    ok('not a hoster' not in ''.join(l for l in out.splitlines() if 'would open' in l), '...none for an ignored kind')

    rc, out = run(d, '--write')
    st = state(d)
    patch = [c for c in FAKE.calls if c[0] == 'PATCH' and c[1] == f'/channels/{FORUM}']
    names = [t['name'] for t in FAKE.tags]
    ok(len(patch) == 1 and names == ['Old tag', 'Known', 'Fixing', 'Fixed', 'Ignore'] and FAKE.tags[0]['id'] == '900'
       and FAKE.tags[0]['moderated'] is True, 'the four tags are created once, the forum\'s own tag kept as it was', FAKE.tags)
    opens = [c for c in FAKE.calls if c[0] == 'OPEN']
    known = next(t['id'] for t in FAKE.tags if t['name'] == 'Known')
    ok(len(opens) == 10 and all(c[4] == [known] for c in opens), 'a write run opens at most ten posts, each tagged Known', len(opens))
    big = sorted((K.window(s, 24, NOW), k) for k, s in st['sigs'].items() if not s.get('ignored'))[::-1][:10]
    ok({st['sigs'][k]['thread'] for _, k in big} == {c[2] and FAKE.threads[t]['id'] for t in FAKE.threads for c in opens
                                                       if FAKE.threads[t]['name'] == c[2]} and all(st['sigs'][k].get('thread') for _, k in big),
       '...the ten biggest of the last 24 h', [st['sigs'][k]['sig'] for _, k in big])
    first = opens[0]
    ok(len(first[2]) <= 100 and len(first[3]) <= 1900 and f"key `{sig_of(st, first[2].split('] ', 1)[1][:30])}`" in first[3]
       and 'Sample, ids masked:' in first[3], 'a post: the kind as its title, the numbers, a sample and its key', first[3])
    refr_thread = st['sigs'][refr].get('thread')
    if refr_thread is None:                # the fixture's Refr kind is small; post it to check its link
        rc, out = run(d, '--write', '--threshold', '1', '--max-new', '40')
        st = state(d)
        refr_thread = st['sigs'][refr]['thread']
    body = FAKE.threads[refr_thread]['messages'][0]['content']
    tracker_tid = next(t for t in FAKE.threads if FAKE.threads[t]['parent_id'] == TRACKER)
    ok(f'/bug reports showing it: <#{tracker_tid}>' in body, "a post links the #bug-tracker thread of a /bug snapshot showing it", body)
    ok(st['sigs'][crash].get('thread') and 'By client files version: 0.3.72 ×5' in FAKE.threads[st['sigs'][crash]['thread']]['messages'][0]['content'],
       'a launcher crash post counts by client version', st['sigs'][crash])
    n = len(FAKE.calls)
    run(d, '--write')
    ok(not FAKE.writes(n), 'a run with nothing new writes nothing', FAKE.writes(n))

    # new occurrences: the first message is edited; no new message
    ftid = st['sigs'][form]['thread']
    append(log, f"{ts('15:10')} [console] [error] Form with id 0x80d0777 doesn't exist\n" + quiet('15:10'))
    n = len(FAKE.calls)
    run(d, '--write')
    w = FAKE.writes(n)
    ok(len(w) == 1 and w[0][0] == 'PATCH' and w[0][1] == f'/channels/{ftid}/messages/{ftid}' and w[0][2].get('allowed_mentions') == {'parse': []}
       and ' 1 in 7 days' not in w[0][2]['content'], 'new lines edit the first message of the post, pinging nobody', w)
    ok(len(FAKE.threads[ftid]['messages']) == 1, '...and add no message')

    # Fixed: frozen, one reply when it comes back, then quiet
    fixed = next(t['id'] for t in FAKE.tags if t['name'] == 'Fixed')
    FAKE.threads[ftid]['applied_tags'] = [fixed]
    n = len(FAKE.calls)
    run(d, '--write')
    ok(not FAKE.writes(n), 'tagged Fixed: nothing is written while it stays away', FAKE.writes(n))
    append(log, f"{ts('15:20')} [console] [error] Form with id 0x80d0778 doesn't exist\n" + quiet('15:20'))
    run(d, '--write')
    append(log, f"{ts('15:21')} [console] [error] Form with id 0x80d0779 doesn't exist\n" + quiet('15:21'))
    run(d, '--write')
    msgs = FAKE.threads[ftid]['messages']
    ok(len(msgs) == 2 and msgs[1]['content'].startswith('Seen again since this was tagged Fixed: 1 time(s)')
       and msgs[1]['allowed_mentions'] == {'parse': []}, 'when it comes back: one reply, once, pinging nobody', msgs[1:])
    FAKE.threads[ftid]['applied_tags'] = [known]
    n = len(FAKE.calls)
    run(d, '--write')
    w = FAKE.writes(n)
    ok(len(w) == 1 and w[0][1] == f'/channels/{ftid}/messages/{ftid}', 'tagged Known again: the numbers come back on', w)

    # Ignore and locked: muted
    ignore = next(t['id'] for t in FAKE.tags if t['name'] == 'Ignore')
    FAKE.threads[ftid]['applied_tags'] = [ignore]
    append(log, f"{ts('15:22')} [console] [error] Form with id 0x80d0780 doesn't exist\n" + quiet('15:22'))
    n = len(FAKE.calls)
    run(d, '--write')
    ok(not FAKE.writes(n), 'tagged Ignore: muted', FAKE.writes(n))
    FAKE.threads[ftid]['applied_tags'] = [known]
    FAKE.threads[ftid]['thread_metadata']['locked'] = True
    n = len(FAKE.calls)
    run(d, '--write')
    ok(not FAKE.writes(n), 'a locked post: muted', FAKE.writes(n))

    # archived: left alone when only the window moved, unarchived and edited when it happens again
    st = state(d)
    big2 = next(k for k, s in st['sigs'].items() if s.get('thread') and 'Kind number' in s['sig'])
    t2 = st['sigs'][big2]['thread']
    FAKE.threads[t2]['thread_metadata']['archived'] = True
    n = len(FAKE.calls)
    run(d, '--write', now=NOW + 30 * 3600)
    ok(not [c for c in FAKE.writes(n) if t2 in c[1]], 'an archived post whose numbers only aged stays archived', FAKE.writes(n))
    append(log, f"{ts('15:40')} [console] [error] {st['sigs'][big2]['sample'].replace('<id>', 'ff000abc')}\n" + quiet('15:40'))
    n = len(FAKE.calls)
    run(d, '--write', now=NOW + 30 * 3600)
    w = [c for c in FAKE.writes(n) if t2 in c[1]]
    ok([c[1] for c in w] == [f'/channels/{t2}', f'/channels/{t2}/messages/{t2}'] and w[0][2] == {'archived': False},
       '...and is unarchived, then edited, when it happens again', w)

    # deleted: muted for good
    st = state(d)
    gone_key = next(k for k, s in st['sigs'].items() if s.get('thread') and 'Kind number' in s['sig'] and k != big2)
    del FAKE.threads[st['sigs'][gone_key]['thread']]
    run(d, '--write', '--threshold', '1', '--max-new', '40')
    st = state(d)
    ok(st['sigs'][gone_key].get('muted') == 'post deleted', 'a deleted post mutes its kind', st['sigs'][gone_key])
    n = len(FAKE.calls)
    run(d, '--write', '--threshold', '1', '--max-new', '40')
    ok(not [c for c in FAKE.calls[n:] if c[0] == 'OPEN' and c[2] == K.title_of(st['sigs'][gone_key])], '...and it is never posted again')

    # a lost state: the posts are found again by their key, none twice
    os.rename(f'{d}/state.json', f'{d}/state.lost.json')
    posts_before = len([t for t in FAKE.threads.values() if t['parent_id'] == FORUM])
    with open(f'{d}/server.log', 'w') as fh:
        fh.writelines(lines)
    run(d, '--write')
    st = state(d)
    posts_after = len([t for t in FAKE.threads.values() if t['parent_id'] == FORUM])
    ok(posts_after == posts_before and sum(1 for s in st['sigs'].values() if s.get('thread')) >= 10,
       'with the state lost, the posts are found again by their key: no post twice', (posts_before, posts_after))

    # the lock: a second run while one holds it does nothing
    import fcntl
    with open(f'{d}/state.json.lock', 'a') as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        n = len(FAKE.calls)
        rc, out = run(d, '--write')
        ok(rc == 0 and 'holds the lock' in out and len(FAKE.calls) == n, 'a run while another holds the lock does nothing', out)


def dbdiscord_pings_nobody():
    path = K.DBDISCORD
    if not os.access(path, os.R_OK):
        print(f'skip  dbdiscord is not at {path}')
        return
    import importlib.machinery, importlib.util
    loader = importlib.machinery.SourceFileLoader('dbdiscord_check', path)
    spec = importlib.util.spec_from_loader('dbdiscord_check', loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    sent = []
    mod.call = lambda method, p, body=None, tries=4, soft=False: sent.append((method, p, body)) or {'id': 'T1'}
    mod.open_thread('F', 'title', 'body', tags=['1'], soft=True)
    ok(sent and sent[0][2]['message']['allowed_mentions'] == {'parse': []} and sent[0][2]['applied_tags'] == ['1'],
       "dbdiscord's open_thread, which opens the posts, pings nobody and sets the tag", sent)


if __name__ == '__main__':
    sys.exit(main())
