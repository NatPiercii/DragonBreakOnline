#!/usr/bin/env python3
"""Known issues (Jake, 1 Oct 2026, the "Bug and crash reporting" thread): every error the game server, the clients and
the launcher report, counted by kind, with one post per kind in the Dev forum #known-issues.

    knownissues.py                 dry run: reads what is new since the last saved run and prints what it would post or
                                   edit. Saves nothing and writes nothing to Discord (it reads the forum when it can).
    knownissues.py --collect       counts and saves the state; posts nothing (the timer, before posting goes live)
    knownissues.py --write         counts, saves, then posts and edits
    knownissues.py --list [N]      the N biggest kinds in the saved state, posted or not
    --offline                      with a dry run: no Discord at all (no token needed)

Sources, read from where the last saved run stopped:
- /var/log/skymp-server.log (and .1 after logrotate's copytruncate):
  - [error] and [critical] lines;
  - exception lines (JS error classes, "Error: ", "failed to load");
  - the client's [dboDiag] lines that report an error.
- The launcher's session ends (skymp5-backend data/session-ends.jsonl): outcome "crash" only. Only the outcome, the exit
  code, the versions and the time are read; names and Discord ids never are. The profile id is hashed to count players.
- /bug snapshots (/var/lib/dbo-monitor/bugs): the error kinds in each snapshot's log link the post to that report's
  #bug-tracker thread. They are copies of server log lines, so they add links, never counts.

A kind (signature) is the line with everything that varies masked: ids, form ids, numbers, quoted text, JSON, player
names, addresses. The multi-line "resolved context" dumps fold into one line, and a JS stack keeps its first file. Per
kind the state keeps:
- the count, and hourly counts for 8 days;
- first and last seen;
- how many players (hashed keys, never names; only lines that name a player can count one);
- one sample line, masked.
ignore.json lists known-harmless noise, each with its reason. Those kinds are counted but never posted.

Posting (--write): one post per kind in #known-issues, whose first message is EDITED with the current numbers. There is
never a new message per run.
- A run opens at most --max-new posts (10), only for kinds over the threshold in the last 24 h: launcher crashes first,
  then the biggest.
- The tags Known, Fixing, Fixed and Ignore are created on the forum if missing. A new post gets Known. Staff change the
  tag, and the tool reads it every run:
  - Known or Fixing: the numbers are kept current.
  - Fixed: the numbers are frozen. If the kind comes back, there is one reply saying so.
  - Ignore, a locked post or a deleted post: muted, and never posted again.
- Nothing pings: allowed_mentions is empty.
- A post that looks like it holds a secret (a token, an address, a Discord id) is skipped and logged instead.

Discord goes through dbdiscord (its bot token from backend.env, its retries), loaded from /opt/dragonbreak-tools, so this
adds no token. State: /opt/dragonbreak-tools/state/known-issues.json (root only). Runs as root: the log, the session ends,
the snapshots and the token are root-only. tools/knownissues/README.md has the timer and the install.
"""
import argparse
import contextlib
import datetime
import fcntl
import hashlib
import importlib.machinery
import importlib.util
import json
import os
import re
import secrets
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
FORUM = os.environ.get('KI_FORUM', '1555237156677754950')        # Council Chambers / known-issues (Jake, 1 Oct)
BUG_TRACKER = os.environ.get('KI_BUG_TRACKER', '1551740319974821949')
STATE = os.environ.get('KI_STATE', '/opt/dragonbreak-tools/state/known-issues.json')
LOG = os.environ.get('KI_LOG', '/var/log/skymp-server.log')
SESSION_ENDS = os.environ.get('KI_SESSION_ENDS', '/opt/alduinak/skymp5-backend/data/session-ends.jsonl')
BUGS_DIR = os.environ.get('KI_BUGS', '/var/lib/dbo-monitor/bugs')
IGNORE = os.environ.get('KI_IGNORE', os.path.join(HERE, 'ignore.json'))
DBDISCORD = os.environ.get('KI_DBDISCORD', '/opt/dragonbreak-tools/dbdiscord')
TAGS = ('Known', 'Fixing', 'Fixed', 'Ignore')
HOURS_KEPT = 8 * 24
PLAYERS_KEPT = 500            # hashed keys per kind; past this the count shows as "500+"
SNAPSHOTS_KEPT = 500
LINKS_SHOWN = 5
CONT_KEPT = 12                # continuation lines read per record
RECOVER_PER_RUN = 25          # first messages read per run to find posts the state lost
LINK_LOOKUPS_PER_RUN = 25     # #bug-tracker first messages read per run to place snapshots
WRITE_GAP_S = 0.5             # between Discord writes
SOURCE_LABEL = {'server': 'Server error', 'client': 'Client error (dboDiag)', 'launcher': 'Game crash (launcher)'}

# ---- reading the log ----------------------------------------------------------------------------------------------
TS_RE = re.compile(r'^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}):\d{2}(?:\.\d+)?\] ?(.*)$')
PREFIX_RE = re.compile(r'^(?:\[console\] )?(?:\[(trace|debug|info|warning|warn|error|err|critical)\] )?(?:\[gamemode\] )?')
JS_ERR_RE = re.compile(r'\b(?:TypeError|ReferenceError|RangeError|SyntaxError|EvalError|URIError)\b|\b\w*Error: '
                       r'|\bfailed to load\b|\bUncaught\b|\b[Uu]nhandled (?:rejection|exception|promise)'
                       r'|\bis not a function\b|\bCannot read propert')
# A client error the gamemode relays from a diagnostic packet: npcDrift <player> error: {"kind":"error",...,"error":"..."}
RELAYED_RE = re.compile(r'^(\w+) (?:.*? #[A-Z0-9]{4} )?error: (\{.*\})\s*$')
DIAG_RE = re.compile(r'^\[dboDiag\] (?:profile (\d+) (?:.*? #[A-Z0-9]{4} )?|user \d+ )(.*)$')
DIAG_ERR_RE = re.compile(r'\b(?:error|exception|uncaught|unhandled|rejection)\b', re.I)
# Player-typed text in the log: never read as an error, whatever it says
PLAYER_TEXT_RE = re.compile(r'BUGREPORT |\baudit: (?:CHAT|SAY|OOC|NAME|GM) ')
CTX_RE = re.compile(r'^resolved context with \d+ entries \(reason=(\w+)\):')
CTX_CUSTOM_RE = re.compile(r'\|\s*\(custom\)\s*(\S+)')
CTX_WHERE_RE = re.compile(r'╰--\s*(\S+?):(\d+)\s*-\s*(\S+)')
FRAME_RE = re.compile(r'^\s+at (?:.*? \()?(\S+?):\d+(?::\d+)?\)?\s*$')

# ---- masking --------------------------------------------------------------------------------------------------------
URL_RE = re.compile(r'\b(?:https?|wss?)://\S+', re.I)
IPV4_RE = re.compile(r'\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b')
EMAIL_RE = re.compile(r'\b[\w.+-]+@[\w-]+\.[\w.-]+\b')
JSON_RE = re.compile(r'\{[^{}]*\}')
MENTION_RE = re.compile(r'<@[!&]?\d+>')
SNOWFLAKE_RE = re.compile(r'\b\d{17,20}\b')
LONG_HEX_RE = re.compile(r'\b[0-9a-fA-F]{16,}\b')
TOKENISH_RE = re.compile(r'\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}\b|\b(?=[A-Za-z0-9_-]*\d)'
                         r'(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])[A-Za-z0-9_-]{32,}\b')
PLAYER_RE = re.compile(r"(?:[\w'’.-]+ ){0,3}[\w'’.-]+ #[A-Z0-9]{4}\b")
TAG_RE = re.compile(r"[\w'’.-] #([A-Z0-9]{4})\b")
FORM_RE = re.compile(r'\b[0-9a-fA-F]{1,8}:[^\s:\'"]{1,64}?\.es[mlp]\b', re.I)
HEX0X_RE = re.compile(r'\b0x[0-9a-fA-F]+\b')
HEXID_RE = re.compile(r'\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{5,8}\b')
DQ_RE = re.compile(r'"([^"\n]*)"')
SQ_RE = re.compile(r"(?<![\w])'([^'\n]*)'(?![\w])")
IDENT_RE = re.compile(r'[A-Za-z_][\w.]{0,60}')     # a quoted method or property name stays: it tells kinds apart
EDID_RE = re.compile(r'\b[A-Za-z_]\w*(?= \(<id>\))')  # an editor id beside its form id: CYRBrumaSynodConclave (<id>)
DIGIT_ID_RE = re.compile(r'\b\d{6,8}\b')           # a form id printed in hex that happens to have no letters
NUM_RE = re.compile(r'-?\d+(?:\.\d+)?')
# Checked on the whole post before it goes out: what must never be in one
SECRET_RES = (
    ('a bot token', re.compile(r'[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,}')),
    ('a webhook URL', re.compile(r'discord(?:app)?\.com/api/webhooks', re.I)),
    ('an IP address', IPV4_RE),
    ('a Discord id', re.compile(r'(?<![#<@&!\d])\d{17,20}(?!\d)')),
    ('a long hex string', LONG_HEX_RE),
    ('backend.env', re.compile(r'backend\.env|DISCORD_BOT_TOKEN|discordId', re.I)),
)


def mask(text):
    """The parts of a line that name someone or something private, masked; numbers and words kept (the sample)."""
    s = URL_RE.sub('<url>', text)
    s = EMAIL_RE.sub('<email>', s)
    s = IPV4_RE.sub('<ip>', s)
    for _ in range(4):                      # JSON nests: mask the innermost objects until none is left
        t = JSON_RE.sub('<json>', s)
        if t == s:
            break
        s = t
    s = MENTION_RE.sub('<@user>', s)
    s = TOKENISH_RE.sub('<secret>', s)
    s = LONG_HEX_RE.sub('<hex>', s)
    s = SNOWFLAKE_RE.sub('<discord-id>', s)
    s = PLAYER_RE.sub('<player>', s)
    s = FORM_RE.sub('<form>', s)
    s = HEX0X_RE.sub('<id>', s)
    s = HEXID_RE.sub('<id>', s)
    return s.replace('`', "'")


def normalise(text):
    """The kind of a line: masked, with quoted text and every number gone too, so one kind is one signature."""
    s = mask(text)
    s = DQ_RE.sub(lambda m: m.group(0) if IDENT_RE.fullmatch(m.group(1)) else '"<s>"', s)
    s = SQ_RE.sub(lambda m: m.group(0) if IDENT_RE.fullmatch(m.group(1)) else "'<s>'", s)
    s = EDID_RE.sub('<edid>', s)
    s = DIGIT_ID_RE.sub('<id>', s)
    s = NUM_RE.sub('<n>', s)
    return ' '.join(s.split())[:200]


def clip(s, n):
    s = str(s or '')
    return s if len(s) <= n else s[:n - 1] + '…'


def key_of(source, sig):
    return 'ki-' + hashlib.sha1(f'{source}\n{sig}'.encode()).hexdigest()[:12]


def classify(msg, cont):
    """(source, signature, sample, player keys) for an error record, or None. msg: the head line after its timestamp."""
    if PLAYER_TEXT_RE.search(msg):
        return None
    m = PREFIX_RE.match(msg)
    level, body = (m.group(1) or ''), msg[m.end():]
    players = set()
    d = DIAG_RE.match(body)
    if d:
        if not DIAG_ERR_RE.search(d.group(2)):
            return None
        if d.group(1):
            players.add('p' + d.group(1))
        return 'client', normalise(d.group(2)), clip(mask(d.group(2)), 400), players
    players |= {'t' + t for t in TAG_RE.findall(body)}
    r = RELAYED_RE.match(body)
    if r:
        try:
            err = json.loads(r.group(2)).get('error')
        except (ValueError, AttributeError):
            err = None
        if isinstance(err, str) and err.strip():
            return 'client', normalise(f'{r.group(1)}: {err}'), clip(mask(f'{r.group(1)} error: {err}'), 400), players
    if level not in ('error', 'err', 'critical') and not JS_ERR_RE.search(body):
        return None
    c = CTX_RE.match(body)
    if c:
        names = [x for line in cont for x in CTX_CUSTOM_RE.findall(line)]
        where = next((CTX_WHERE_RE.search(line) for line in cont if CTX_WHERE_RE.search(line)), None)
        at = f' @ {os.path.basename(where.group(1))} {where.group(3)}' if where else ''
        sig = f"resolved context (reason={c.group(1)}): custom {','.join(names) or '?'}{at}"
        sample = ' | '.join([body] + [line.strip().lstrip('╭╰|-─ ').strip() for line in cont if line.strip(' ╭╰|-─')])
        return 'server', sig, clip(mask(sample), 400), players
    sig, sample = normalise(body), mask(body)
    frame = next((FRAME_RE.match(line) for line in cont if FRAME_RE.match(line)), None)
    if frame:
        sig = f'{sig} @ {os.path.basename(frame.group(1))}'
        sample = f"{sample} | {mask(next(line for line in cont if FRAME_RE.match(line)).strip())}"
    return 'server', sig[:220], clip(sample, 400), players


# ---- the state ------------------------------------------------------------------------------------------------------
def new_state():
    return {'version': 1, 'salt': secrets.token_hex(16), 'log': {}, 'sessionEnds': {'lastAt': 0}, 'snapshots': {},
            'sigs': {}, 'threadKeys': {}, 'bugThreads': {}, 'runs': 0}


def load_state(path):
    try:
        with open(path, encoding='utf-8') as fh:
            st = json.load(fh)
        base = new_state()
        base.update(st)
        return base
    except FileNotFoundError:
        return new_state()


def save_state(path, st):
    """Atomic, root only (it holds hashed player keys and the salt that made them)."""
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    tmp = f'{path}.tmp{os.getpid()}'
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as fh:
        os.fchmod(fh.fileno(), 0o600)
        json.dump(st, fh, indent=1, sort_keys=True)
    os.replace(tmp, path)


@contextlib.contextmanager
def run_lock(path):
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    fh = open(path + '.lock', 'a')
    try:
        fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        fh.close()
        print('another known-issues run holds the lock; nothing done')
        sys.exit(0)
    try:
        yield
    finally:
        fcntl.flock(fh, fcntl.LOCK_UN)
        fh.close()


def hour_key(day, hm):
    return f'{day}T{hm[:2]}'


def hour_of(epoch):
    return time.strftime('%Y-%m-%dT%H', time.gmtime(epoch))


def window(sig, hours, now):
    since = hour_of(now - (hours - 1) * 3600)
    return sum(n for h, n in sig.get('hours', {}).items() if h >= since)


def player_hash(st, key):
    return hashlib.sha256(f"{st['salt']}:{key}".encode()).hexdigest()[:12]


def count(st, source, sig, sample, day, hm, players, version=None):
    """One occurrence of a kind at day/hm (UTC)."""
    k = key_of(source, sig)
    s = st['sigs'].get(k)
    if s is None:
        s = st['sigs'][k] = {'source': source, 'sig': sig, 'sample': sample, 'count': 0, 'first': f'{day} {hm}',
                             'last': f'{day} {hm}', 'hours': {}, 'players': [], 'playersMore': False}
    s['count'] += 1
    when = f'{day} {hm}'
    s['first'] = min(s['first'], when)
    if when >= s['last']:
        s['last'], s['sample'] = when, sample          # the newest sample: it shows the line as the code prints it now
    h = hour_key(day, hm)
    s['hours'][h] = s['hours'].get(h, 0) + 1
    for p in players:
        ph = player_hash(st, p)
        if ph not in s['players']:
            if len(s['players']) < PLAYERS_KEPT:
                s['players'].append(ph)
            else:
                s['playersMore'] = True
    if version:
        v = s.setdefault('versions', {})
        v[version] = v.get(version, 0) + 1
    return k


def prune(st, now):
    oldest = hour_of(now - HOURS_KEPT * 3600)
    for s in st['sigs'].values():
        s['hours'] = {h: n for h, n in s['hours'].items() if h >= oldest}
    if len(st['snapshots']) > SNAPSHOTS_KEPT:
        for name in sorted(st['snapshots'])[:len(st['snapshots']) - SNAPSHOTS_KEPT]:
            del st['snapshots'][name]


# ---- sources --------------------------------------------------------------------------------------------------------
def file_head(path, n):
    with open(path, 'rb') as fh:
        return fh.read(n)


def records(path, start, final):
    """(day, hm, head message, continuation lines, offset after) per error record from byte offset start. The last
    record of a live file (final False) is held back, since its continuation lines may still be coming."""
    pending = None          # [day, hm, msg, cont, start offset]
    pos = start
    with open(path, 'rb') as fh:
        fh.seek(start)
        for raw in fh:
            if not raw.endswith(b'\n'):
                break                                           # half a line: the writer is mid-line
            at = pos
            pos += len(raw)
            line = raw.decode('utf-8', 'replace').rstrip('\r\n')
            m = TS_RE.match(line)
            if not m:
                if pending is not None and len(pending[3]) < CONT_KEPT:
                    pending[3].append(line)
                continue
            if pending is not None:
                yield pending[0], pending[1], pending[2], pending[3], at
                pending = None
            msg = m.group(3)
            if ('[error]' in msg or '[critical]' in msg or '[err]' in msg or '[dboDiag]' in msg
                    or JS_ERR_RE.search(msg)):
                pending = [m.group(1), m.group(2), msg, [], at]
    if pending is not None:
        if final:
            yield pending[0], pending[1], pending[2], pending[3], pos
        else:
            yield None, None, None, None, pending[4]            # read it again next run, whole
            return
    yield None, None, None, None, pos


def read_log(st, path, final_live=False, notes=None):
    """Every new error record in the server log since the saved offset; follows logrotate's copytruncate into .1."""
    notes = notes if notes is not None else []
    out = []
    try:
        info = os.stat(path)
    except FileNotFoundError:
        notes.append(f'{path} not found')
        return out
    saved = st['log']
    head_len = min(4096, info.st_size)
    head = file_head(path, head_len)
    plan = []
    if not saved.get('headSha'):
        if os.path.exists(path + '.1'):
            plan.append((path + '.1', 0, True))
        plan.append((path, 0, final_live))
    else:
        same = (info.st_ino == saved.get('ino') and info.st_size >= saved.get('offset', 0)
                and len(head) >= saved['headLen'] and hashlib.sha1(head[:saved['headLen']]).hexdigest() == saved['headSha'])
        if same:
            plan.append((path, saved['offset'], final_live))
        else:
            old = path + '.1'
            try:
                old_head = file_head(old, saved['headLen'])
            except FileNotFoundError:
                old_head = b''
            if hashlib.sha1(old_head).hexdigest() == saved['headSha']:
                plan.append((old, saved['offset'], True))
            else:
                notes.append('the log was rotated and the rotated copy is not the file the last run read; '
                             'lines between that run and the rotation are not counted')
            plan.append((path, 0, final_live))
    for p, start, final in plan:
        end = start
        for day, hm, msg, cont, after in records(p, start, final):
            end = after
            if day is not None:
                out.append((day, hm, msg, cont))
        if p == path:
            saved.update(ino=info.st_ino, offset=end, headLen=head_len, headSha=hashlib.sha1(head).hexdigest())
    return out


EXIT_NAMES = {3221225477: '0xC0000005, access violation', 3221226505: '0xC0000409, stack buffer overrun',
              3221225725: '0xC00000FD, stack overflow', 3221225794: '0xC0000142, DLL failed to start',
              3221225501: '0xC000001D, illegal instruction', 3221225620: '0xC0000094, divide by zero'}


def read_session_ends(st, path):
    """Crashes the launcher reported since the last saved one: (day, hm, signature, sample, profile key, version)."""
    out = []
    last = st['sessionEnds'].get('lastAt', 0)
    newest = last
    try:
        fh = open(path, encoding='utf-8', errors='replace')
    except FileNotFoundError:
        return out
    with fh:
        for line in fh:
            try:
                r = json.loads(line)
            except ValueError:
                continue
            at = r.get('at') if isinstance(r.get('at'), (int, float)) else 0
            if at <= last:
                continue
            newest = max(newest, at)
            if r.get('outcome') != 'crash':
                continue
            code = r.get('exitCode')
            name = EXIT_NAMES.get(code)
            sig = f'Game crashed, exit code {code}' + (f' ({name})' if name else '')
            files, launcher = str(r.get('filesVersion') or '?')[:20], str(r.get('launcherVersion') or '?')[:20]
            sample = (f"crash, exit code {code}{f' ({name})' if name else ''}, client files {files}, launcher {launcher}, "
                      f"crash log {'written' if r.get('crashLog') else 'none'}")
            when = (r.get('endedAt') if isinstance(r.get('endedAt'), (int, float)) else at) / 1000
            t = time.gmtime(when)
            out.append((time.strftime('%Y-%m-%d', t), time.strftime('%H:%M', t), sig, mask(sample),
                        f"profile:{r.get('profileId')}" if r.get('profileId') is not None else None, files))
    st['sessionEnds']['lastAt'] = newest
    return out


SNAP_NAME_RE = re.compile(r'^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-([A-Z0-9]{4})\.json$')


def read_snapshots(st, folder, ignored):
    """New /bug snapshots: the kinds of the errors in each one's log (ignored kinds left out). Returns how many."""
    try:
        names = sorted(n for n in os.listdir(folder) if n.endswith('.json'))
    except FileNotFoundError:
        return 0
    added = 0
    for name in names:
        if name in st['snapshots'] or not SNAP_NAME_RE.match(name):
            continue
        try:
            with open(os.path.join(folder, name), encoding='utf-8') as fh:
                snap = json.load(fh)
        except (OSError, ValueError):
            continue
        keys = []
        lines = [str(x) for x in (snap.get('log') or []) if isinstance(x, str)][-400:]
        i = 0
        while i < len(lines):
            m = TS_RE.match(lines[i])
            i += 1
            if not m:
                continue
            cont = []
            while i < len(lines) and not TS_RE.match(lines[i]) and len(cont) < CONT_KEPT:
                cont.append(lines[i])
                i += 1
            got = classify(m.group(3), cont)
            if got:
                k = key_of(got[0], got[1])
                if k not in keys and not ignored(got[0], got[1]):
                    keys.append(k)
        st['snapshots'][name] = {'keys': keys, 'thread': None, 'tries': 0}
        added += 1
    return added


def load_ignore(path):
    """[(source or None, compiled pattern, reason)] from ignore.json; a broken file stops the run (it would post noise)."""
    with open(path, encoding='utf-8') as fh:
        raw = json.load(fh)
    out = []
    for e in raw.get('ignore', []):
        out.append((e.get('source'), re.compile(e['match']), e['reason']))
    return out


def ignore_reason(rules, source, sig):
    for src, rx, reason in rules:
        if (src is None or src == source) and rx.search(sig):
            return reason
    return None


def collect(st, args, now, notes):
    """Reads every source into the state. Returns {source: records counted, 'snapshots': n}."""
    rules = load_ignore(args.ignore)
    got = {'server': 0, 'client': 0, 'launcher': 0, 'skipped': 0}
    for day, hm, msg, cont in read_log(st, args.log, notes=notes):
        c = classify(msg, cont)
        if not c:
            got['skipped'] += 1
            continue
        source, sig, sample, players = c
        count(st, source, sig, sample, day, hm, players)
        got[source] += 1
    for day, hm, sig, sample, pkey, version in read_session_ends(st, args.session_ends):
        count(st, 'launcher', sig, sample, day, hm, [pkey] if pkey else [], version)
        got['launcher'] += 1
    got['snapshots'] = read_snapshots(st, args.bugs, lambda src, sig: ignore_reason(rules, src, sig))
    for s in st['sigs'].values():
        s['ignored'] = ignore_reason(rules, s['source'], s['sig'])
    prune(st, now)
    return got


# ---- the post -------------------------------------------------------------------------------------------------------
def links_for(st, key):
    """#bug-tracker threads whose /bug snapshot shows this kind, newest first."""
    out = []
    for name in sorted(st['snapshots'], reverse=True):
        e = st['snapshots'][name]
        if key in e.get('keys', []) and e.get('thread') and e['thread'] not in out:
            out.append(e['thread'])
    return out


def title_of(s):
    return clip(f"[{s['source']}] {s['sig']}", 100)


def render(st, key, now):
    s = st['sigs'][key]
    n24, n7 = window(s, 24, now), window(s, 7 * 24, now)
    lines = [f"**{SOURCE_LABEL[s['source']]}**: {n24:,} in the last 24 h · {n7:,} in 7 days · "
             f"{s['count']:,} since {s['first'][:10]}",
             f"First seen {s['first']} UTC · last seen {s['last']} UTC"]
    if s['players']:
        lines.append(f"Players affected: {len(s['players'])}{'+' if s.get('playersMore') else ''}")
    elif s['source'] == 'server':
        lines.append('Players affected: these lines name no player')
    if s.get('versions'):
        top = sorted(s['versions'].items(), key=lambda kv: (-kv[1], kv[0]))[:6]
        lines.append('By client files version: ' + ', '.join(f'{v} ×{n}' for v, n in top))
    lines += ['Sample, ids masked:', '```', clip(s['sample'], 500), '```']
    links = links_for(st, key)
    if links:
        more = f' and {len(links) - LINKS_SHOWN} more' if len(links) > LINKS_SHOWN else ''
        lines.append('/bug reports showing it: ' + ' '.join(f'<#{t}>' for t in links[:LINKS_SHOWN]) + more)
    lines.append(f"Signature `{clip(s['sig'], 220)}` · key `{key}`")
    lines.append('-# The tags steer this post: Known or Fixing keep these numbers current; Fixed freezes them (one reply '
                 'if it comes back); Ignore mutes it.')
    return clip('\n'.join(lines), 1900)


def secret_in(text):
    """The name of what makes text unsafe to post, or None. Channel mentions (<#id>) are thread links, not ids."""
    bare = re.sub(r'<#\d{17,20}>', '', text)
    for what, rx in SECRET_RES:
        if rx.search(bare):
            return what
    return None


def candidates(st, args, now):
    """Kinds that would get a new post: not ignored or muted, no post yet, over the threshold. Launcher crashes come
    first, ahead of every server and client kind, since they are what staff most need to see; then the biggest."""
    out = []
    for k, s in st['sigs'].items():
        if s.get('thread') or s.get('muted') or s.get('ignored'):
            continue
        n24 = window(s, 24, now)
        if n24 >= (args.crash_threshold if s['source'] == 'launcher' else args.threshold):
            out.append((s['source'] != 'launcher', -n24, -s['count'], k))
    out.sort()
    return [k for *_, k in out]


# ---- Discord --------------------------------------------------------------------------------------------------------
def load_dbdiscord(path):
    loader = importlib.machinery.SourceFileLoader('dbdiscord', path)
    spec = importlib.util.spec_from_loader('dbdiscord', loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


def snowflake_ms(i):
    return (int(i) >> 22) + 1420070400000


class Poster:
    """The Discord half: reads the forum, then (write) creates the tags, edits, replies and opens posts. dry: prints only."""

    def __init__(self, D, st, args, now, write, save):
        self.D, self.st, self.args, self.now, self.write, self.save = D, st, args, now, write, save
        self.acts = []

    def act(self, what):
        self.acts.append(what)
        print(('' if self.write else 'would ') + what)

    def soft(self, method, path, body=None):
        """A Discord call whose failure is reported, not fatal: (result, error)."""
        try:
            return self.D.call(method, path, body, soft=True), None
        except self.D.DiscordError as err:
            return None, err

    def wrote(self):
        self.save()
        time.sleep(self.args.gap)

    def ensure_tags(self):
        forum, err = self.soft('GET', f'/channels/{self.args.forum}')
        if err:
            sys.exit(f'cannot read the known-issues forum {self.args.forum}: {err}')
        have = {self.D.tag_key(t.get('name', '')): t for t in forum.get('available_tags') or []}
        missing = [t for t in TAGS if self.D.tag_key(t) not in have]
        if missing:
            self.act(f"create the forum tags {', '.join(missing)}")
            if self.write:
                keep = [{k: t[k] for k in ('id', 'name', 'moderated', 'emoji_id', 'emoji_name') if k in t}
                        for t in forum.get('available_tags') or []]
                res, err = self.soft('PATCH', f'/channels/{self.args.forum}',
                                     {'available_tags': keep + [{'name': n} for n in missing]})
                if err:
                    sys.exit(f'could not create the tags: {err}')
                have = {self.D.tag_key(t.get('name', '')): t for t in res.get('available_tags') or []}
                time.sleep(self.args.gap)
        self.tag_id = {n: str(have[self.D.tag_key(n)]['id']) for n in TAGS if self.D.tag_key(n) in have}
        self.tag_name = {v: k for k, v in self.tag_id.items()}

    def status_of(self, thread):
        names = {self.tag_name.get(str(t)) for t in thread.get('applied_tags') or []}
        for n in ('Ignore', 'Fixed', 'Fixing', 'Known'):
            if n in names:
                return n
        return 'Known'

    def recover(self, threads):
        """Posts the bot opened that the state does not know (a lost state, a run that died after posting): the key in
        their first message puts them back. Each thread is read once."""
        known = {s['thread'] for s in self.st['sigs'].values() if s.get('thread')}
        looked = left = 0
        for t in threads:
            tid = t['id']
            if tid in known or tid in self.st['threadKeys'] or t.get('owner_id') != self.me:
                continue
            if looked >= RECOVER_PER_RUN:
                left += 1
                continue
            looked += 1
            first, err = self.soft('GET', f'/channels/{tid}/messages/{tid}')
            m = re.search(r'key `(ki-[0-9a-f]{12})`', (first or {}).get('content') or '')
            self.st['threadKeys'][tid] = m.group(1) if m else None
            if m and m.group(1) in self.st['sigs'] and not self.st['sigs'][m.group(1)].get('thread'):
                self.st['sigs'][m.group(1)]['thread'] = tid
                print(f'found the post for {m.group(1)}: thread {tid}')
        return left

    def link_snapshots(self):
        """#bug-tracker threads for snapshots that show a kind: dbo-monitor's /bug post names its snapshot file."""
        todo = [(n, e) for n, e in sorted(self.st['snapshots'].items()) if e['keys'] and not e.get('thread')
                and e.get('tries', 0) < 3]
        if not todo:
            return
        threads = [t for t in self.D.forum_threads(self.gid, self.args.bug_tracker) if t.get('owner_id') == self.me]
        looked = 0
        for name, e in todo:
            m = SNAP_NAME_RE.match(name)
            at = datetime.datetime(*map(int, m.group(1).split('-')), int(m.group(2)), int(m.group(3)), int(m.group(4)),
                                   tzinfo=datetime.timezone.utc).timestamp() * 1000
            near = [t for t in threads if f'#{m.group(5)}:' in t.get('name', '')
                    and at - 60000 <= snowflake_ms(t['id']) <= at + 3600000]
            for t in near:
                if looked >= LINK_LOOKUPS_PER_RUN:
                    return
                tid = t['id']
                if tid not in self.st['bugThreads']:
                    looked += 1
                    first, err = self.soft('GET', f'/channels/{tid}/messages/{tid}')
                    snap = re.search(r'Snapshot: `([^`]+\.json)`', (first or {}).get('content') or '')
                    self.st['bugThreads'][tid] = snap.group(1) if snap else None
                if self.st['bugThreads'][tid] == name:
                    e['thread'] = tid
                    break
            if not e.get('thread'):
                e['tries'] = e.get('tries', 0) + 1

    def run(self):
        D = self.D
        self.me = str((D.call('GET', '/users/@me') or {}).get('id'))
        self.gid = D.guild_id()
        self.ensure_tags()
        threads = D.forum_threads(self.gid, self.args.forum)
        by_id = {t['id']: t for t in threads}
        unread = self.recover(threads)
        self.link_snapshots()
        if self.write:
            self.save()
        edits = 0
        for key, s in sorted(self.st['sigs'].items(), key=lambda kv: -kv[1]['count']):
            tid = s.get('thread')
            if not tid or s.get('muted'):
                continue
            t = by_id.get(tid)
            if t is None:
                got, err = self.soft('GET', f'/channels/{tid}')
                if err is not None and err.status == 404:
                    self.act(f"mute {key}: its post {tid} is gone")
                    if self.write:
                        s['muted'] = 'post deleted'
                        self.save()
                    continue
                if got is None or got.get('parent_id') != self.args.forum:
                    continue
                t = got
            meta = t.get('thread_metadata') or {}
            status = self.status_of(t)
            if meta.get('locked') or status == 'Ignore':
                if s.get('status') != ('locked' if meta.get('locked') else 'Ignore'):
                    print(f"{key} is {'locked' if meta.get('locked') else 'tagged Ignore'}: muted while it stays so")
                s['status'] = 'locked' if meta.get('locked') else 'Ignore'
                continue
            if status == 'Fixed':
                if s.get('status') != 'Fixed' or 'fixedCount' not in s:
                    s['fixedCount'], s['fixedAt'], s['regressionNoted'] = s['count'], hour_of(self.now), False
                s['status'] = 'Fixed'
                again = s['count'] - s['fixedCount']
                if again > 0 and not s.get('regressionNoted'):
                    text = (f"Seen again since this was tagged Fixed: {again:,} time(s), last at {s['last']} UTC. "
                            f"Tag it Known or Fixing to put the numbers back on.")
                    self.act(f'reply in {tid} ({key}): {text}')
                    if self.write:
                        if meta.get('archived'):
                            self.soft('PATCH', f'/channels/{tid}', {'archived': False})
                        _, err = self.soft('POST', f'/channels/{tid}/messages',
                                           {'content': text, 'allowed_mentions': {'parse': []}})
                        if err:
                            print(f'the reply in {tid} failed: {err}')
                            continue
                        s['regressionNoted'] = True
                        self.wrote()
                continue
            s['status'] = status
            for k in ('fixedCount', 'fixedAt', 'regressionNoted'):
                s.pop(k, None)
            body = render(self.st, key, self.now)
            if body == s.get('shown') or edits >= self.args.max_edits:
                continue
            if meta.get('archived') and s['count'] == s.get('shownCount'):
                continue                    # only the 24 h window moved: leave a quiet post archived
            bad = secret_in(body)
            if bad:
                print(f'NOT editing {tid} ({key}): the text looks like it holds {bad}')
                continue
            edits += 1
            self.act(f"edit {tid} ({key}, {status}): {body.splitlines()[0]}")
            if self.write:
                if meta.get('archived'):
                    _, err = self.soft('PATCH', f'/channels/{tid}', {'archived': False})
                    if err:
                        print(f'could not unarchive {tid}: {err}')
                        continue
                _, err = self.soft('PATCH', f'/channels/{tid}/messages/{tid}',
                                   {'content': body, 'allowed_mentions': {'parse': []}})
                if err:
                    print(f'the edit of {tid} failed: {err}')
                    continue
                s['shown'], s['shownCount'] = body, s['count']
                self.wrote()
        opened = 0
        if unread:              # one of those may be the post a candidate already has: open nothing until all are read
            print(f'{unread} earlier post(s) of the bot not read yet; new posts wait for the next run')
            return
        for key in candidates(self.st, self.args, self.now):
            if opened >= self.args.max_new:
                break
            s = self.st['sigs'][key]
            body = render(self.st, key, self.now)
            bad = secret_in(body) or secret_in(title_of(s))
            if bad:
                print(f'NOT posting {key}: the text looks like it holds {bad}')
                continue
            opened += 1
            self.act(f"open a post ({opened} of at most {self.args.max_new}), tagged Known: {title_of(s)}")
            if not self.write:
                print('\n'.join('    | ' + line for line in body.splitlines()))
                continue
            try:
                th = D.open_thread(self.args.forum, title_of(s), body,
                                   tags=[self.tag_id['Known']] if 'Known' in self.tag_id else (), soft=True)
            except D.DiscordError as err:
                print(f'the post for {key} failed: {err}')
                continue
            s.update(thread=str(th['id']), status='Known', shown=body, shownCount=s['count'], posted=hour_of(self.now))
            self.st['threadKeys'][str(th['id'])] = key
            self.wrote()


# ---- the report -----------------------------------------------------------------------------------------------------
def report(st, args, now, limit):
    rows = sorted(st['sigs'].items(), key=lambda kv: (-window(kv[1], 24, now), -kv[1]['count']))
    print(f"{len(rows)} kinds; 24 h / total / players / status, biggest in the last 24 h first")
    for key, s in rows[:limit]:
        state = (f"ignored: {s['ignored']}" if s.get('ignored') else f"muted: {s['muted']}" if s.get('muted')
                 else f"post {s['thread']} ({s.get('status', 'Known')})" if s.get('thread') else 'no post')
        print(f"{window(s, 24, now):>7,} {s['count']:>8,} {len(s['players']):>4}  {key}  [{s['source']}] "
              f"{clip(s['sig'], 110)}   [{state}]")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument('--write', action='store_true', help='save, then post and edit')
    mode.add_argument('--collect', action='store_true', help='save; post nothing')
    mode.add_argument('--list', type=int, nargs='?', const=40, metavar='N', help='the N biggest kinds in the saved state')
    ap.add_argument('--offline', action='store_true', help='dry run without reading Discord')
    ap.add_argument('--threshold', type=int, default=20, help='server and client lines in 24 h before a post (20)')
    ap.add_argument('--crash-threshold', type=int, default=3, help='launcher crashes in 24 h before a post (3)')
    ap.add_argument('--max-new', type=int, default=10, help='new posts per run: crashes first, then the biggest (10)')
    ap.add_argument('--max-edits', type=int, default=60, help='first-message edits per run (60)')
    ap.add_argument('--show', type=int, default=25, help='kinds listed at the end of a dry run (25)')
    ap.add_argument('--forum', default=FORUM)
    ap.add_argument('--bug-tracker', default=BUG_TRACKER)
    ap.add_argument('--state', default=STATE)
    ap.add_argument('--log', default=LOG)
    ap.add_argument('--session-ends', default=SESSION_ENDS)
    ap.add_argument('--bugs', default=BUGS_DIR)
    ap.add_argument('--ignore', default=IGNORE)
    ap.add_argument('--dbdiscord', default=DBDISCORD)
    ap.add_argument('--gap', type=float, default=WRITE_GAP_S, help=argparse.SUPPRESS)
    ap.add_argument('--now', type=float, default=None, help=argparse.SUPPRESS)        # the harness's clock
    args = ap.parse_args(argv)
    now = args.now or time.time()
    if args.list is not None:
        report(load_state(args.state), args, now, args.list)
        return 0
    save_ok = args.write or args.collect
    with run_lock(args.state) if save_ok else contextlib.nullcontext():
        st = load_state(args.state)
        notes = []
        try:
            got = collect(st, args, now, notes)
        except PermissionError as err:
            sys.exit(f'cannot read {err.filename} (run with sudo)')
        st['runs'] += 1
        st['lastRun'] = hour_of(now)
        for n in notes:
            print('note:', n)
        print(f"read: {got['server']:,} server, {got['client']:,} client and {got['launcher']:,} launcher error(s); "
              f"{got['snapshots']} new /bug snapshot(s); {len(st['sigs'])} kinds known")
        if save_ok:
            save_state(args.state, st)
        if args.collect:
            return 0
        if args.offline:
            print('offline: Discord not read')
            for i, key in enumerate(candidates(st, args, now)[:args.max_new], 1):
                print(f"would open a post ({i} of at most {args.max_new}), tagged Known: {title_of(st['sigs'][key])}")
                print('\n'.join('    | ' + line for line in render(st, key, now).splitlines()))
        else:
            D = load_dbdiscord(args.dbdiscord)
            Poster(D, st, args, now, args.write, (lambda: save_state(args.state, st)) if args.write else (lambda: None)).run()
            if args.write:
                save_state(args.state, st)          # what the run saw without writing: a Fixed tag's count, a mute
        if not args.write:
            print()
            report(st, args, now, args.show)
            print('dry run: nothing saved, nothing written to Discord')
    return 0


if __name__ == '__main__':
    sys.exit(main())
