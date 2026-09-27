#!/usr/bin/env python3
"""DragonBreak Online monitor: follows the game server and updater logs, keeps rolling statistics of every problem
(NPCs first), posts alerts and digests to the staff #server-monitor channel, and writes a state file the gamemode's
/monitor command reads. Runs as the dbo-monitor systemd unit (root: the logs and the bot token are root-only).

Classes of event it knows:
  server   starts (crashed or restarted, from systemd's journal), updater results, gamemode load failures, script
           errors, C++ errors (known noise counted only), freezes (event loop p99 over 2 s twice, or no tick summary
           for 3 min while skymp.service is active), pressure (io or memory PSI 'full avg60' over 20, or container
           memory over 90%, twice, with the 3 biggest cgroups)
  players  joins, leaves, and likely crashes (a player whose game went silent 45 s or more before the disconnect)
  npc      npcDrift split/sink/jump/remote/snap/bounce/error, npcGround under/over/lifted, hosts released,
           jumps refused, NPCs stuck in one spot, and players hosting many NPCs they no longer have loaded

State: /var/lib/dbo-monitor/state.json  { updatedAt, windows: [ { start, counts, worst, players } ...288 x 5 min ],
       recent: [ last 50 alerts ], online: { name: { lastSeen, hosted, unloaded } } }
"""
import json, os, re, subprocess, sys, time, urllib.request
from collections import Counter, defaultdict

LOG = '/var/log/skymp-server.log'
UPDATE_LOG = '/var/log/skymp-update.log'
SETTINGS = '/opt/alduinak/build/dist/server/server-settings.json'
STATE_DIR = '/var/lib/dbo-monitor'
STATE = os.path.join(STATE_DIR, 'state.json')
CHANNEL = os.environ.get('DBO_MONITOR_CHANNEL', '1553093452529532929')
# Player /bug reports: one thread each in the staff error-report forum (Jake, 2026-09-26); #server-monitor keeps the
# server warnings. A report the forum refuses falls back to #server-monitor, so none is lost.
BUG_FORUM = os.environ.get('DBO_BUG_FORUM', '1551740319974821949')
bugreport_re = re.compile(r'BUGREPORT (.+? #\w{4}) (\S+\.json): (.*)$')
WINDOW_S = 300
KEEP_WINDOWS = 288            # 24 h
DIGEST_S = 900
CRASH_SILENCE_S = 45             # drift heartbeats come every 30 s, so a clean quit can look 30 s quiet
UNLOADED_ALERT = 20
BIG_SNAP = 1000
ALERT_REPEAT_S = 600          # the same alert key at most once in this long
# Freeze alert: the 2026-09-27 95-minute stall raised nothing because skymp.service stayed active
FREEZE_P99_MS = 2000          # event loop p99 above this in 2 tick summaries in a row is a freeze
FREEZE_OK_MS = 200            # p99 back under this closes it
FREEZE_SILENCE_S = 180        # no tick summary this long while skymp.service is active is a freeze too
INCIDENT_REPEAT_S = 900       # an open incident re-alerts this often
HEALTH_S = 60                 # how often the silence, pressure and memory checks run
PSI_FULL_AVG60 = 20           # io or memory PSI 'full avg60' over this in 2 checks in a row is pressure
MEM_PCT = 90                  # container memory in use over this share of its limit in 2 checks in a row too
PSI_IO, PSI_MEM = '/proc/pressure/io', '/proc/pressure/memory'
CGROUP, MEMINFO = '/sys/fs/cgroup', '/proc/meminfo'

ts_re = re.compile(r'^\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)')
loop_re = re.compile(r'ticks \(ms, last 60 s, (\d+) online\)(?:.*\| event loop p99 ([\d.]+) max ([\d.]+))?')
drift_re = re.compile(r'npcDrift (.+?) #\w{4} (\w+): (\{.*)')
ground_re = re.compile(r'npcGround (under|over|lifted) (ff[0-9a-f]+) (\S+) at (\S+) terrain \S+ dz (-?\d+), near (.+?) #')
NOISE = re.compile(r"Method not found|Refr pointer expired|No permission to update actor|Recipe not found|Target actor doesn.t exist|CastPrimitivePropertyValue")


def token():
    try:
        return json.load(open(SETTINGS)).get('discordAuth', {}).get('botToken', '')
    except Exception:
        return ''


def post_thread(forum, title, content):
    """Opens a forum thread; True when Discord accepted it."""
    tok = token()
    if not tok or not CHANNEL or not forum:    # an empty DBO_MONITOR_CHANNEL (test mode) disables every post
        return False
    body = {'name': title[:100] or 'Bug report', 'message': {'content': content[:1900], 'allowed_mentions': {'parse': []}}}
    req = urllib.request.Request(f'https://discord.com/api/v10/channels/{forum}/threads', method='POST',
                                 data=json.dumps(body).encode(),
                                 headers={'Authorization': f'Bot {tok}', 'Content-Type': 'application/json',
                                          'User-Agent': 'dbo-monitor (DragonBreak, 1)'})
    try:
        urllib.request.urlopen(req, timeout=10).read()
        return True
    except Exception as e:
        print('discord forum post failed:', e, flush=True)
        return False


def post(text):
    tok = token()
    if not tok or not CHANNEL:
        return
    for chunk in [text[i:i + 1900] for i in range(0, len(text), 1900)]:
        req = urllib.request.Request(f'https://discord.com/api/v10/channels/{CHANNEL}/messages', method='POST',
                                     data=json.dumps({'content': chunk, 'allowed_mentions': {'parse': []}}).encode(),
                                     headers={'Authorization': f'Bot {tok}', 'Content-Type': 'application/json',
                                              'User-Agent': 'dbo-monitor (DragonBreak, 1)'})
        try:
            urllib.request.urlopen(req, timeout=10).read()
        except Exception as e:
            print('discord post failed:', e, flush=True)
        time.sleep(1)


def jload(s):
    for cut in (s, s[:s.rfind('}') + 1]):
        try:
            return json.loads(cut)
        except Exception:
            pass
    d = {}
    for k in ('kind', 'base', 'remoteId', 'error'):
        m = re.search(r'"%s":"([^"]*)"' % k, s)
        if m:
            d[k] = m.group(1)
    for k in ('dz', 'errZ', 'refDrop', 'gapMax', 'hosted', 'loaded', 'bounces', 'snaps'):
        m = re.search(r'"%s":(-?[\d.]+)' % k, s)
        if m:
            d[k] = float(m.group(1))
    return d


def skymp_active():
    try:
        return subprocess.run(['systemctl', 'is-active', '--quiet', 'skymp'], timeout=15).returncode == 0
    except Exception:
        return True    # systemctl stuck (as under heavy pressure) must not hide a freeze


def start_cause(lines):
    """How skymp's latest start came about, from its systemd journal lines: ('crashed', 'status=11/SEGV') after an exit
    nobody asked for, ('restarted', '') after a stop, ('', '') when the journal does not say."""
    last = max((i for i, ln in enumerate(lines) if 'Started skymp' in ln), default=None)
    exited = None
    for ln in reversed(lines[:last] if last is not None else []):
        if 'Stopping skymp' in ln:
            return 'restarted', ''
        if 'Started skymp' in ln:
            break
        exited = exited or re.search(r'Main process exited, code=(\w+), status=(\S+)', ln)
    if exited and not (exited.group(1) == 'exited' and exited.group(2).startswith('0/')):
        return 'crashed', 'status=' + exited.group(2)
    return '', ''


def journal_start_cause():
    try:
        out = subprocess.run(['journalctl', '-u', 'skymp', '-o', 'cat', '-n', '40', '--no-pager'],
                             capture_output=True, text=True, timeout=15).stdout
        return start_cause(out.splitlines())
    except Exception:
        return '', ''


def psi_full60(path):
    """'full avg60' of a /proc/pressure file, None when unreadable."""
    try:
        m = re.search(r'^full .*\bavg60=([\d.]+)', open(path).read(), re.M)
        return float(m.group(1)) if m else None
    except Exception:
        return None


def mem_use():
    """(bytes in use, limit) of the container: memory.current less inactive file cache, against memory.max or MemTotal."""
    try:
        cur = int(open(os.path.join(CGROUP, 'memory.current')).read())
        cache = re.search(r'^inactive_file (\d+)', open(os.path.join(CGROUP, 'memory.stat')).read(), re.M)
        lim = open(os.path.join(CGROUP, 'memory.max')).read().strip()
        if lim == 'max':
            lim = int(re.search(r'^MemTotal:\s+(\d+) kB', open(MEMINFO).read(), re.M).group(1)) * 1024
        return cur - (int(cache.group(1)) if cache else 0), int(lim)
    except Exception:
        return None, None


def top_cgroups(n=3):
    """The n biggest cgroups right under user.slice and system.slice by memory.current, as 'name N MB'."""
    rows = []
    for sl in ('user.slice', 'system.slice'):
        base = os.path.join(CGROUP, sl)
        for name in (os.listdir(base) if os.path.isdir(base) else []):
            try:
                rows.append((int(open(os.path.join(base, name, 'memory.current')).read()), name))
            except Exception:
                pass    # a plain file, or no memory controller
    return [f'{name} {b // 1048576} MB' for b, name in sorted(rows, reverse=True)[:n]]


class Monitor:
    def __init__(self):
        os.makedirs(STATE_DIR, exist_ok=True)
        try:
            self.state = json.load(open(STATE))
        except Exception:
            self.state = {'windows': [], 'recent': [], 'online': {}}
        self.state.setdefault('windows', []); self.state.setdefault('recent', []); self.state.setdefault('online', {})
        self.win = None
        self.new_window(time.time())
        self.digest_counts = Counter()
        self.digest_worst = {}
        self.last_digest = time.time()
        self.alerted = {}
        self.ground = defaultdict(list)
        self.stuck_told = set()
        self.last_activity = {}      # player name -> last time their client reported anything
        self.journal = {}            # player name -> Journal (pause) menu open, from clientState (client 0.3.40+)
        self.reports_journal = set() # players whose client says when the Journal opens, so silence means a crash
        self.incidents = {}          # 'freeze' / 'pressure' -> {since, last}: at most one open incident of each kind
        self.last_loop = time.time() # last tick summary, or server or gamemode (re)start
        self.loop_high = 0           # tick summaries in a row with p99 over FREEZE_P99_MS
        self.last_p99 = 'unknown'
        self.last_health = time.time()
        self.pressure_high = 0       # checks in a row over a pressure or memory line
        self.dirty = True

    def new_window(self, now):
        self.win = {'start': int(now - now % WINDOW_S), 'counts': {}, 'worst': {}, 'players': {}}
        self.state['windows'].append(self.win)
        del self.state['windows'][:-KEEP_WINDOWS]

    def count(self, key, value=None, detail=''):
        self.win['counts'][key] = self.win['counts'].get(key, 0) + 1
        self.digest_counts[key] += 1
        if value is not None:
            v = abs(float(value))
            if v > self.win['worst'].get(key, [0])[0]:
                self.win['worst'][key] = [round(v), detail]
            if v > self.digest_worst.get(key, (0, ''))[0]:
                self.digest_worst[key] = (round(v), detail)
        self.dirty = True

    def alert(self, key, text, t):
        now = time.time()
        if now - self.alerted.get(key, 0) < ALERT_REPEAT_S:
            return
        self.alerted[key] = now
        self.say(text, t)

    def say(self, text, t):
        line = f'`{t[11:19]}` {text}'
        self.state['recent'].append(line)
        del self.state['recent'][:-50]
        print('ALERT', line, flush=True)
        post(line)
        self.dirty = True

    def incident(self, key, text, t):
        """Opens incident key with an alert, then re-alerts every INCIDENT_REPEAT_S while it stays open."""
        now = time.time()
        inc = self.incidents.get(key)
        if inc is None:
            self.incidents[key] = {'since': now, 'last': now}
            self.count('server.' + key)
            self.say(text, t)
        elif now - inc['last'] >= INCIDENT_REPEAT_S:
            inc['last'] = now
            self.say(f'{text} (still going, {int((now - inc["since"]) // 60)} min)', t)

    def resolve(self, key, text, t):
        inc = self.incidents.pop(key, None)
        if inc:
            self.say(f'{text}, {int((time.time() - inc["since"]) // 60)} min after the alert', t)

    def loop_sample(self, p99, mx, online, t):
        self.last_loop = time.time()
        if mx is None:    # a gamemode from before 2026-09-24 logs no event loop figures, but the loop runs
            return self.resolve('freeze', 'Server recovered: tick summaries are back', t)
        if mx <= 0:
            return    # 0.0/0.0 is a window with no samples (first summary after the 2026-09-27 stall), not health
        self.last_p99 = f'p99 {p99:.0f} ms, max {mx:.0f} ms at {t[11:19]}'
        self.loop_high = self.loop_high + 1 if p99 > FREEZE_P99_MS else 0
        if self.loop_high >= 2:
            self.incident('freeze', f'**Server freeze:** event loop p99 {p99:.0f} ms (max {mx:.0f} ms), over {FREEZE_P99_MS} ms in {self.loop_high} tick summaries in a row, {online} online', t)
        elif p99 < FREEZE_OK_MS:
            self.resolve('freeze', f'Server recovered: event loop p99 {p99:.0f} ms (max {mx:.0f} ms)', t)

    def health(self, now):
        t = time.strftime('%Y-%m-%d %H:%M:%S', time.gmtime(now))
        quiet = now - self.last_loop
        if quiet >= FREEZE_SILENCE_S and skymp_active():
            self.incident('freeze', f'**Server freeze:** no tick summary for {int(quiet // 60)} min while skymp.service is active (last event loop {self.last_p99})', t)
        io, mem = psi_full60(PSI_IO), psi_full60(PSI_MEM)
        used, lim = mem_use()
        pct = 100 * used / lim if used and lim else 0
        hot = [f'{k} full avg60 {v:.1f}' for k, v in (('io', io), ('memory', mem)) if v is not None and v > PSI_FULL_AVG60]
        if pct > MEM_PCT:
            hot.append(f'container memory {used / 2**30:.1f} of {lim / 2**30:.1f} GiB in use ({pct:.0f}%)')
        self.pressure_high = self.pressure_high + 1 if hot else 0
        if self.pressure_high >= 2:
            self.incident('pressure', '**Server under pressure:** ' + ', '.join(hot) + '. Biggest: ' + ', '.join(top_cgroups()), t)
        elif max(io or 0, mem or 0) < PSI_FULL_AVG60 / 2 and pct < MEM_PCT - 10:    # clears well under the lines, no flapping
            self.resolve('pressure', f'Pressure cleared: io full avg60 {io or 0:.1f}, memory full avg60 {mem or 0:.1f}, container memory {pct:.0f}%', t)

    def bug_report(self, line, t):
        key = 'bug:' + line[-80:]
        if key in self.alerted:
            return
        self.alerted[key] = time.time()
        m = bugreport_re.search(line)
        who, snap, text = (m.group(1), m.group(2), m.group(3)) if m else ('someone', '', re.sub(r'.*BUGREPORT ', '', line)[:300])
        short = re.sub(r'\s+', ' ', text).strip()
        title = f"{who}: {short[:80]}{'...' if len(short) > 80 else ''}"
        content = (f'**Bug report** from {who} at {t} UTC (in-game /bug)\n\n> {text[:1500]}\n\n'
                   + (f'Snapshot: `{snap}` (dbo_inspect.py reads it)' if snap else ''))
        self.state['recent'].append(f'`{t[11:19]}` Bug report from {who}')
        del self.state['recent'][:-50]
        self.dirty = True
        print('BUGREPORT', who, snap, flush=True)
        if not post_thread(BUG_FORUM, title, content):
            post(f'`{t[11:19]}` **Bug report** from {who} (the error-report forum refused it): {text[:300]}')

    def seen(self, who, t):
        self.last_activity[who] = time.time()
        o = self.state['online'].setdefault(who, {})
        o['lastSeen'] = t
        self.dirty = True

    def line(self, line, source):
        m = ts_re.match(line)
        t = m.group(1) if m else time.strftime('%Y-%m-%d %H:%M:%S', time.gmtime())
        if source == 'update':
            if 'OK - now' in line:
                self.count('server.update')
                self.alert('update:' + line[-40:], 'Updater: ' + line.strip()[21:120], t)
            elif re.search(r'fail|error|rolled back|rollback', line, re.I):
                self.count('server.update_failed')
                self.alert('updatefail:' + line[-60:], '**Updater problem:** ' + line.strip()[:200], t)
            return
        lm = loop_re.search(line)
        if lm:
            p99, mx = (float(g) if g else None for g in lm.group(2, 3))
            self.loop_sample(p99, mx, lm.group(1), t)
            return
        if 'Initialized MetricsSystem' in line:
            self.count('server.restart')
            self.last_loop = time.time(); self.loop_high = 0    # the first tick summary comes 1-3 min after a start
            how, why = journal_start_cause()
            if how == 'crashed':
                self.count('server.crash')
                self.alert('restart:' + t, f'**Game server crashed** ({why}) and started again', t)
            else:
                self.alert('restart:' + t, 'Game server restarted' if how else 'Game server started', t)
        elif '[gamemode] loaded: ' in line:
            self.last_loop = time.time()    # a gamemode reload restarts the 60 s summary timer
        elif 'audit: JOIN ' in line:
            who = re.sub(r'.*audit: JOIN (.+?) #.*', r'\1', line.strip())
            self.count('player.join'); self.seen(who, t)
        elif 'clientState ' in line and ' journal ' in line:
            m2 = re.search(r'clientState (.+?) #\w{4} journal (open|closed)', line)
            if m2:
                self.journal[m2.group(1)] = m2.group(2) == 'open'
                self.reports_journal.add(m2.group(1))
                self.seen(m2.group(1), t)
        elif 'audit: LEAVE ' in line:
            who = re.sub(r'.*audit: LEAVE (.+?) #.*', r'\1', line.strip())
            silent = time.time() - self.last_activity.get(who, time.time())
            self.count('player.leave')
            if self.journal.pop(who, False):
                self.count('player.quit_menu')
            elif silent >= CRASH_SILENCE_S:
                self.count('player.crash', silent, who)
                # A quit through the menus opens the Journal, which clients from 0.3.40 report; an older client cannot say
                if who in self.reports_journal:
                    self.alert('crash:' + who + t[:16], f'**Likely crash:** {who} went silent {int(silent)} s before disconnecting, not from the pause menu', t)
                else:
                    self.alert('crash:' + who + t[:16], f'**Possible crash** (or a quit through the menus, older client): {who} went silent {int(silent)} s before disconnecting', t)
            self.state['online'].pop(who, None)
        elif 'BUGREPORT ' in line:
            self.count('player.bug_report')
            self.bug_report(line.strip(), t)
        elif 'failed to load' in line:
            self.count('server.load_failed')
            self.alert('load:' + line[-80:], '**Gameplay module failed to load:** ' + line.strip()[27:230], t)
        elif re.search(r'TypeError|ReferenceError|RangeError|SyntaxError', line):
            self.count('server.script_error')
            self.alert('js:' + re.sub(r'\d', '', line[-120:]), '**Script error:** ' + line.strip()[27:230], t)
        elif NOISE.search(line):
            self.count('noise')
        elif '[error]' in line and 'npcDrift' not in line:
            self.count('server.cpp_error')
            self.alert('cpp:' + re.sub(r'[0-9a-f]{6,}|\d+', '#', line[27:140]), 'Server error: ' + line.strip()[27:230], t)
        elif re.search(r'Hoster of \w+ released', line):
            self.count('npc.host_released')
        elif 'NpcJump' in line:
            self.count('npc.jump_refused')
            if 'taking it' in line:
                self.count('npc.jump_insisted')
        elif 'MovementValidation: actor' in line:
            pass
        dm = drift_re.search(line)
        if dm:
            who, kind, body = dm.groups()
            self.seen(who, t)
            if kind in ('config', 'locomotion'):
                return
            d = jload(body)
            base = str(d.get('base', '?')).rsplit(' ', 1)[0]
            if kind == 'heartbeat':
                o = self.state['online'].setdefault(who, {})
                ids = re.search(r'"ids":"([^"]*)"', body)
                unloaded = ids.group(1).count(':-1') if ids else 0
                o['hosted'] = int(d.get('hosted', 0)); o['unloaded'] = unloaded
                if unloaded >= UNLOADED_ALERT:
                    self.alert('unloaded:' + who, f'{who} holds {unloaded} NPCs they no longer have loaded (hosted {o["hosted"]})', t)
                return
            if kind == 'error':
                err = str(d.get('error', ''))
                self.count('client.error_keyword' if 'indexInPool' in err else 'client.error')
                if 'indexInPool' not in err:
                    self.alert('clienterr:' + err[:60], f'Client error from {who}: {err[:160]}', t)
                return
            val = d.get('dz', d.get('errZ', d.get('refDrop', 0))) or 0
            self.count('npc.' + kind, val, f'{base} near {who} {t[11:19]}')
            if kind == 'remote' and float(d.get('gapMax', 0) or 0) > BIG_SNAP:
                self.count('npc.big_snap', d.get('gapMax'), f'{base} on {who} {t[11:19]}')
                self.alert('snap:' + str(d.get('remoteId')), f'NPC snap: {base} {d.get("remoteId")} jumped {int(float(d.get("gapMax")))} units on {who}\'s screen', t)
        gm = ground_re.search(line)
        if gm:
            way, nid, base, pos, dz, who = gm.groups()
            self.count('npc.ground_' + way, dz, f'{base} near {who} {t[11:19]}')
            h = self.ground[nid]
            h.append((time.time(), pos)); del h[:-6]
            same = [x for x in h if x[1] == pos]
            if len(same) >= 3 and same[-1][0] - same[0][0] >= 60 and nid not in self.stuck_told:
                self.stuck_told.add(nid)
                self.count('npc.stuck')
                self.alert('stuck:' + nid, f'NPC stuck: {nid} ({base}) has not moved for {int(same[-1][0] - same[0][0])} s near {who}', t)

    def tick(self):
        now = time.time()
        if now - self.win['start'] >= WINDOW_S:
            self.new_window(now)
        if now - self.last_digest >= DIGEST_S:
            self.last_digest = now
            real = {k: v for k, v in self.digest_counts.items() if k not in ('noise', 'player.join', 'player.leave')}
            if real:
                parts = []
                for k, v in sorted(real.items(), key=lambda kv: -kv[1]):
                    w = self.digest_worst.get(k)
                    parts.append(f'{k} {v}' + (f' (worst {w[0]}: {w[1]})' if w and w[0] else ''))
                post('**Last 15 min:** ' + ' | '.join(parts))
            self.digest_counts.clear(); self.digest_worst.clear()
        if now - self.last_health >= HEALTH_S:
            self.last_health = now
            try:
                self.health(now)
            except Exception as e:
                print('health check failed:', e, flush=True)
        if self.dirty:
            self.state['updatedAt'] = int(now)
            try:
                tmp = STATE + '.tmp'
                json.dump(self.state, open(tmp, 'w'))
                os.chmod(tmp, 0o644)
                os.replace(tmp, STATE)
            except Exception as e:
                print('state write failed:', e, flush=True)
            self.dirty = False


def main():
    mon = Monitor()
    procs = {
        'server': subprocess.Popen(['tail', '-n', '0', '-F', LOG], stdout=subprocess.PIPE, text=True, errors='replace'),
        'update': subprocess.Popen(['tail', '-n', '0', '-F', UPDATE_LOG], stdout=subprocess.PIPE, text=True, errors='replace'),
    }
    import selectors
    sel = selectors.DefaultSelector()
    for name, p in procs.items():
        sel.register(p.stdout, selectors.EVENT_READ, name)
    print('dbo-monitor running', flush=True)
    while True:
        for key, _ in sel.select(timeout=5):
            line = key.fileobj.readline()
            if line:
                try:
                    mon.line(line, key.data)
                except Exception as e:
                    print('line failed:', e, line[:120], flush=True)
        mon.tick()


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--test':
        # Feed stdin through the classifier without Discord or the state dir (DBO_MONITOR_CHANNEL= disables posting)
        STATE_DIR = os.environ.get('DBO_MONITOR_STATE', '/tmp/dbo-monitor-test'); STATE = os.path.join(STATE_DIR, 'state.json')
        mon = Monitor()
        for ln in sys.stdin:
            mon.line(ln, 'update' if ln.startswith('UPDATE ') else 'server')
        mon.tick()
        print(json.dumps({'counts': mon.win['counts'], 'recent': mon.state['recent']}, indent=1))
    else:
        main()
