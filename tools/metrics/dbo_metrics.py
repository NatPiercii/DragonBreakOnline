#!/usr/bin/env python3
# DragonBreak Online: server load and memory over time, with alerts to staff (Road to Alpha: "track memory and server
# load over time and add alerts"). Runs as root on CT 115 from systemd timers; standard library only.
#
#   dbo_metrics.py sample     one sample (every minute): one JSON line in /var/lib/dbo-monitor/metrics-YYYYMMDD.jsonl,
#                             alerts for what crossed a line, files older than 30 days pruned
#   dbo_metrics.py daily      the summary of yesterday (UTC): one line in daily.jsonl, a post to #server-monitor, and
#                             public-status.json (what a public status page may show)
#   dbo_metrics.py report [DAY]   the summary of a day, printed, nothing posted
#
# Skymp crashes, restarts and event-loop freezes of 2 s and more are alerted by dbo-monitor already (dbo_monitor.py);
# this adds the time series, memory, disk and sustained-lag alerts, and the daily summary. Alerts go to the same staff
# channel with the same bot, each kind at most once per its repeat time, and never with an address, a path or a token.
import datetime
import glob
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

STATE_DIR = os.environ.get('DBO_METRICS_DIR', '/var/lib/dbo-monitor')
STATE = os.path.join(STATE_DIR, 'metrics-state.json')
LOG = os.environ.get('DBO_METRICS_LOG', '/var/log/skymp-server.log')
SETTINGS = '/opt/alduinak/build/dist/server/server-settings.json'   # read only for the bot token, as dbo-monitor does
CHANNEL = os.environ.get('DBO_MONITOR_CHANNEL', '1553093452529532929')   # #server-monitor, dbo-monitor's channel
CONFIG = os.environ.get('DBO_METRICS_CONFIG', '/etc/dragonbreak/dbo-metrics.json')
KEEP_DAYS = 30
READ_MAX = 64 * 1024 * 1024        # at most this much new log per sample (a burst is counted next minute)

DEFAULTS = {
    'skympRssWarnMB': 4096, 'skympRssCritMB': 6144, 'skympRssMinutes': 3,
    'memAvailWarnPct': 15, 'memAvailCritPct': 7, 'memMinutes': 3,
    'diskWarnPct': 90, 'diskCritPct': 95,
    'loopP99WarnMs': 250, 'loopMinutes': 5,
    'loadPerCore': 2.0, 'loadMinutes': 10,
    'repeatMinutes': {'warn': 60, 'crit': 20},
    'maxPostsPerHour': 8,
    'dailyPost': True,
}

# Log lines counted each minute, each in its own series (a line counts in the first series it matches). The sync
# series are Worker B's (the NPC sync blocker, 2026-09-30). host_not_hoster is the figure the Road to Alpha page quotes:
# it stays a series of its own and is never folded into a total. host_granted is its denominator (from 26 Sep the
# errors roughly equal the grants), and the two release reasons mean different things. Group 'other' is counted but
# is not sync: form_missing is a gameplay bug that polls a gone id (0xff000323 about once a second on 30 Sep).
SIGNATURES = [
    ('host_not_hoster', 'host', r"SendToNeighbours - No permission to update actor [0-9a-f]+ \(not a hoster\)"),
    ('host_target_missing', 'host', r"SendToNeighbours - Target actor doesn't exist"),
    ('host_granted', 'hostEvent', r'Hoster of [0-9a-f]+ changed from'),
    ('host_rel_unsub', 'hostEvent', r'Hoster of [0-9a-f]+ released from [0-9a-f]+: its hoster no longer has it'),
    ('host_rel_stale', 'hostEvent', r'Hoster of [0-9a-f]+ released from [0-9a-f]+: no movement'),
    ('hit_too_distant', 'hit', r'ActionListener::OnHit - aggressor and targetRef are too distant'),
    ('hit_diff_cell', 'hit', r'ActionListener::OnHit - aggressor and targetRef are in different cells or world'),
    ('hit_worldspace', 'hit', r"WorldSpace doesn't match"),
    ('hit_target_missing', 'hit', r'ActionListener::OnHit - MpObjectReference not found for hitData\.target'),
    ('cast_bad_hoster', 'hit', r'Bad hoster is attached to caster'),
    ('drift_split', 'drift', r'npcDrift .*"kind":"split"'),
    ('drift_jump', 'drift', r'npcDrift .*"kind":"jump"'),
    ('drift_other', 'drift', r'npcDrift .*"kind":"(?:sink|bounce|pinned|locomotion)"'),
    ('form_missing', 'other', r"Form with id 0x[0-9a-f]+ doesn't exist"),
    ('refr_expired', 'other', r'Refr pointer expired'),
]
SIG_RE = [(k, re.compile(p)) for k, _, p in SIGNATURES]
GROUP = {k: g for k, g, _ in SIGNATURES}
TICKS_RE = re.compile(r'\[gamemode\] ticks \(ms, last 60 s, (\d+) online\):(.*?)(?:\| event loop p99 ([\d.]+) max ([\d.]+))?\s*$')
TIMER_RE = re.compile(r'(\w+) \d+x max ([\d.]+) mean [\d.]+')
ERROR_RE = re.compile(r'\] \[(?:error|critical)\] ')
# Not counted as errors: dbo-monitor's known noise, the Papyrus VM's context dumps, and master-server connectivity
NOISE_RE = re.compile(r"Method not found|Refr pointer expired|No permission to update actor|Recipe not found|Target actor doesn.t exist|CastPrimitivePropertyValue|resolved context with \d+ entries \(reason=exception\)|Error updating info on master server")


def config():
    c = json.loads(json.dumps(DEFAULTS))
    try:
        with open(CONFIG) as fh:
            c.update(json.load(fh))
    except (FileNotFoundError, ValueError):
        pass
    return c


def load_state():
    try:
        with open(STATE) as fh:
            return json.load(fh)
    except (FileNotFoundError, ValueError):
        return {}


def save_state(st):
    os.makedirs(STATE_DIR, exist_ok=True)
    tmp = STATE + '.tmp'
    with open(tmp, 'w') as fh:
        json.dump(st, fh)
    os.replace(tmp, STATE)


# ---- readings ---------------------------------------------------------------------------------------------------------
def systemd(unit, props):
    try:
        out = subprocess.run(['systemctl', 'show', unit, '-p', ','.join(props)], capture_output=True, text=True, timeout=10).stdout
    except Exception:
        return {}
    return dict(line.split('=', 1) for line in out.splitlines() if '=' in line)


def proc_stats(pid):
    """(rss MB, cpu ticks utime+stime, threads) of a process, or None."""
    try:
        with open(f'/proc/{pid}/stat') as fh:
            f = fh.read().rsplit(')', 1)[1].split()
        with open(f'/proc/{pid}/status') as fh:
            st = fh.read()
        rss = int(re.search(r'VmRSS:\s+(\d+)', st).group(1)) / 1024
        return round(rss), int(f[11]) + int(f[12]), int(f[17])
    except Exception:
        return None


def meminfo():
    vals = {}
    with open('/proc/meminfo') as fh:
        for line in fh:
            k, _, v = line.partition(':')
            vals[k] = int(v.split()[0]) // 1024
    return vals.get('MemTotal', 0), vals.get('MemAvailable', 0)


def read_log(st):
    """New log lines since the last sample: (ticks line fields, sync counts, error count). Follows rotation."""
    pos, ino = st.get('logPos', 0), st.get('logIno')
    try:
        s = os.stat(LOG)
    except FileNotFoundError:
        return None, {}, 0
    if s.st_ino != ino or s.st_size < pos:   # rotated, or truncated by logrotate's copytruncate
        pos = 0 if ino is not None else s.st_size   # first run: start at the end, not a month back
    counts, errors, ticks = {}, 0, None
    with open(LOG, 'rb') as fh:
        fh.seek(pos)
        data = fh.read(READ_MAX)
        st['logPos'], st['logIno'] = pos + len(data), s.st_ino
    for raw in data.decode('utf-8', 'replace').splitlines():
        m = TICKS_RE.search(raw)
        if m:
            timers = [(n, float(x)) for n, x in TIMER_RE.findall(m.group(2))]
            slow = max(timers, key=lambda t: t[1]) if timers else None
            ticks = {'online': int(m.group(1)), 'p99': float(m.group(3)) if m.group(3) else None,
                     'max': float(m.group(4)) if m.group(4) else None,
                     'slowest': {'timer': slow[0], 'ms': slow[1]} if slow else None}
            continue
        for k, rx in SIG_RE:
            if rx.search(raw):
                counts[k] = counts.get(k, 0) + 1
                break
        else:
            if ERROR_RE.search(raw) and not NOISE_RE.search(raw):
                errors += 1
    return ticks, counts, errors


def players_online():
    """Players online from the backend's own /api/servers on this box (no auth, the launcher's figure)."""
    try:
        with urllib.request.urlopen('http://127.0.0.1:4000/api/servers', timeout=3) as r:
            d = json.load(r)
        return int((d[0] or {}).get('online') or 0) if d else 0
    except Exception:
        return None


def sample_now(st):
    now = time.time()
    s = {'t': datetime.datetime.fromtimestamp(now, datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}
    sd = systemd('skymp', ['ActiveState', 'MainPID', 'ActiveEnterTimestamp', 'NRestarts'])
    pid = int(sd.get('MainPID') or 0)
    sk = {'active': sd.get('ActiveState'), 'since': sd.get('ActiveEnterTimestamp') or None, 'restarts': int(sd.get('NRestarts') or 0)}
    ps = proc_stats(pid) if pid else None
    if ps:
        rss, ticks, threads = ps
        sk.update({'pid': pid, 'rssMB': rss, 'threads': threads})
        last = st.get('cpu')
        if last and last.get('pid') == pid and now > last['t']:
            sk['cpuPct'] = round((ticks - last['ticks']) / os.sysconf('SC_CLK_TCK') / (now - last['t']) * 100, 1)
        st['cpu'] = {'pid': pid, 'ticks': ticks, 't': now}
    s['skymp'] = sk
    total, avail = meminfo()
    load = [float(x) for x in open('/proc/loadavg').read().split()[:3]]
    s['box'] = {'memTotalMB': total, 'memAvailMB': avail, 'memAvailPct': round(avail * 100 / total, 1) if total else None,
                'load': load, 'cores': os.cpu_count()}
    vfs = os.statvfs('/')
    s['disk'] = {'usedPct': round((1 - vfs.f_bavail / vfs.f_blocks) * 100, 1), 'freeGB': round(vfs.f_bavail * vfs.f_frsize / 2 ** 30, 1)}
    ticks, counts, errors = read_log(st)
    online = players_online()
    s['players'] = online if online is not None else (ticks or {}).get('online')
    s['loop'] = {k: ticks[k] for k in ('p99', 'max', 'slowest')} if ticks else None
    s['log'] = counts    # per series; see SIGNATURES (no blended total: host_not_hoster stays comparable)
    s['errors'] = errors
    return s


# ---- alerts -----------------------------------------------------------------------------------------------------------
def token():
    try:
        with open(SETTINGS) as fh:
            return json.load(fh).get('discordAuth', {}).get('botToken', '')
    except Exception:
        return ''


def discord_post(text):
    if not CHANNEL:
        return 'off'
    tok = token()
    if not tok:
        return 'notoken'
    req = urllib.request.Request(f'https://discord.com/api/v10/channels/{CHANNEL}/messages', method='POST',
                                 data=json.dumps({'content': text[:1900], 'allowed_mentions': {'parse': []}}).encode(),
                                 headers={'Authorization': f'Bot {tok}', 'Content-Type': 'application/json',
                                          'User-Agent': 'dbo-metrics (DragonBreak, 1)'})
    try:
        urllib.request.urlopen(req, timeout=10).read()
        return 'ok'
    except urllib.error.HTTPError as e:
        return 'retry' if e.code == 429 or e.code >= 500 else f'refused-{e.code}'
    except Exception:
        return 'retry'


def streak(st, key, cond):
    """Minutes in a row cond has held."""
    n = st.setdefault('streaks', {})
    n[key] = n.get(key, 0) + 1 if cond else 0
    return n[key]


def evaluate(s, st, c):
    """The alerts this sample raises: [(key, level, text)]. Texts carry figures only, no addresses or paths."""
    out = []
    sk, box, disk = s['skymp'], s['box'], s['disk']
    rss = sk.get('rssMB')
    if rss is not None:
        if streak(st, 'rssCrit', rss >= c['skympRssCritMB']) >= c['skympRssMinutes']:
            out.append(('rss', 'crit', f'**Game server memory critical:** {rss / 1024:.1f} GB for {c["skympRssMinutes"]} minutes (limit {c["skympRssCritMB"] / 1024:.0f} GB); {s["players"]} online. A restart at 0 players frees it.'))
        elif streak(st, 'rssWarn', rss >= c['skympRssWarnMB']) >= c['skympRssMinutes']:
            out.append(('rss', 'warn', f'**Game server memory high:** {rss / 1024:.1f} GB for {c["skympRssMinutes"]} minutes (warning at {c["skympRssWarnMB"] / 1024:.0f} GB); {s["players"]} online.'))
    ap = box.get('memAvailPct')
    if ap is not None:
        if streak(st, 'memCrit', ap <= c['memAvailCritPct']) >= c['memMinutes']:
            out.append(('mem', 'crit', f'**Box memory critical:** {box["memAvailMB"] / 1024:.1f} GB free of {box["memTotalMB"] / 1024:.0f} GB ({ap:.0f}%) for {c["memMinutes"]} minutes.'))
        elif streak(st, 'memWarn', ap <= c['memAvailWarnPct']) >= c['memMinutes']:
            out.append(('mem', 'warn', f'**Box memory low:** {box["memAvailMB"] / 1024:.1f} GB free of {box["memTotalMB"] / 1024:.0f} GB ({ap:.0f}%) for {c["memMinutes"]} minutes.'))
    if disk['usedPct'] >= c['diskCritPct']:
        out.append(('disk', 'crit', f'**Disk critical:** {disk["usedPct"]:.0f}% used, {disk["freeGB"]:.0f} GB free. World saves and logs fail when it fills.'))
    elif disk['usedPct'] >= c['diskWarnPct']:
        out.append(('disk', 'warn', f'**Disk filling:** {disk["usedPct"]:.0f}% used, {disk["freeGB"]:.0f} GB free.'))
    p99 = (s.get('loop') or {}).get('p99')
    if streak(st, 'loop', p99 is not None and p99 >= c['loopP99WarnMs']) >= c['loopMinutes']:
        slow = (s['loop'] or {}).get('slowest') or {}
        out.append(('loop', 'warn', f'**Server lagging:** event loop p99 {p99:.0f} ms for {c["loopMinutes"]} minutes (line {c["loopP99WarnMs"]} ms); {s["players"]} online'
                    + (f'; slowest timer {slow.get("timer")} {slow.get("ms"):.0f} ms' if slow.get('timer') else '') + '.'))
    load1, cores = box['load'][0], box['cores'] or 1
    if streak(st, 'load', load1 >= c['loadPerCore'] * cores) >= c['loadMinutes']:
        out.append(('load', 'warn', f'**Box load high:** {load1:.1f} on {cores} cores for {c["loadMinutes"]} minutes.'))
    return out


def dispatch(alerts, st, c, now=None, poster=discord_post):
    """Posts what is due: one key at most once per its level's repeat time, a crit may follow a warn at once, and no
    more than maxPostsPerHour in all. Unsent posts are kept (20 at most) and tried again next minute."""
    now = now or time.time()
    sent = st.setdefault('sent', {})
    hour = [t for t in st.get('postTimes', []) if now - t < 3600]
    queue = st.get('outbox', [])
    for key, level, text in alerts:
        prev = sent.get(key)
        rep = c['repeatMinutes'][level] * 60
        if prev and now - prev['t'] < rep and not (level == 'crit' and prev['level'] == 'warn'):
            continue
        sent[key] = {'t': now, 'level': level}
        queue.append(text)
    kept = []
    for text in queue[:20]:
        if len(hour) >= c['maxPostsPerHour']:
            kept.append(text)
            continue
        r = poster(text)
        if r == 'ok':
            hour.append(now)
        elif r == 'retry':
            kept.append(text)
    st['outbox'], st['postTimes'] = kept, hour
    # a kind that has cleared can alert again at once the next time
    for key in list(sent):
        if key not in {k for k, _, _ in alerts} and now - sent[key]['t'] > 600:
            sent.pop(key)


# ---- files ------------------------------------------------------------------------------------------------------------
def day_file(day):
    return os.path.join(STATE_DIR, f'metrics-{day}.jsonl')


def append_sample(s):
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(day_file(s['t'][:10].replace('-', '')), 'a') as fh:
        fh.write(json.dumps(s, separators=(',', ':')) + '\n')


def prune(now=None):
    cutoff = (datetime.datetime.fromtimestamp(now or time.time(), datetime.timezone.utc) - datetime.timedelta(days=KEEP_DAYS)).strftime('%Y%m%d')
    for p in glob.glob(os.path.join(STATE_DIR, 'metrics-2*.jsonl')):
        if os.path.basename(p)[8:16] < cutoff:
            os.remove(p)


# ---- the daily summary --------------------------------------------------------------------------------------------------
def journal_restarts(day):
    """(starts, crashes) of skymp on a UTC day, from its journal: a start after an exit nobody asked for is a crash."""
    nxt = (datetime.date.fromisoformat(day) + datetime.timedelta(days=1)).isoformat()
    try:
        lines = subprocess.run(['journalctl', '-u', 'skymp', '--since', f'{day} 00:00:00 UTC', '--until', f'{nxt} 00:00:00 UTC', '-o', 'cat', '--no-pager'],
                               capture_output=True, text=True, timeout=30).stdout.splitlines()
    except Exception:
        return None, None
    return count_starts(lines)


def count_starts(lines):
    """(starts, crashes) from skymp journal lines (-o cat): an exit with a failure status nobody asked for is a crash."""
    starts = crashes = 0
    asked = False
    for ln in lines:
        if ln.startswith('Stopping ') or 'Stopping skymp' in ln:
            asked = True
        elif re.search(r'Main process exited, code=(killed|dumped|exited), status=(?!0/|15/TERM|9/KILL)', ln) and not asked:
            crashes += 1
        elif 'Started skymp' in ln or ln.startswith('Started '):
            starts += 1
            asked = False
    return starts, crashes


def summarize(day, samples, restarts=(None, None)):
    """One day's figures from its samples (day as YYYY-MM-DD)."""
    def mx(get):
        vals = [v for v in (get(x) for x in samples) if v is not None]
        return max(vals) if vals else None
    starts, crashes = restarts
    series = {}
    for x in samples:
        for k, v in (x.get('log') or {}).items():
            series[k] = series.get(k, 0) + v
    peak_players = mx(lambda x: x.get('players'))
    peak_at = next((x['t'] for x in samples if x.get('players') == peak_players), None) if peak_players else None
    mins = [x.get('box', {}).get('memAvailPct') for x in samples if x.get('box', {}).get('memAvailPct') is not None]
    return {'day': day, 'samples': len(samples), 'peakPlayers': peak_players, 'peakPlayersAt': peak_at,
            'peakSkympRssMB': mx(lambda x: x.get('skymp', {}).get('rssMB')),
            'minMemAvailPct': min(mins) if mins else None,
            'peakLoad': mx(lambda x: (x.get('box', {}).get('load') or [None])[0]),
            'peakLoopP99': mx(lambda x: (x.get('loop') or {}).get('p99')), 'peakLoopMax': mx(lambda x: (x.get('loop') or {}).get('max')),
            'peakDiskPct': mx(lambda x: x.get('disk', {}).get('usedPct')),
            'restarts': starts, 'crashes': crashes, 'log': series,
            'errors': sum(x.get('errors', 0) for x in samples)}


def read_day(day):
    out = []
    try:
        with open(day_file(day.replace('-', ''))) as fh:
            for line in fh:
                try:
                    out.append(json.loads(line))
                except ValueError:
                    pass
    except FileNotFoundError:
        pass
    return out


def summary_line(d):
    f = lambda v, unit='': '?' if v is None else f'{v:g}{unit}'
    lg = d.get('log') or {}
    grp = lambda g: sum(v for k, v in lg.items() if GROUP.get(k) == g)
    return (f'**Daily summary {d["day"]}:** peak {f(d["peakPlayers"])} players' + (f' at {d["peakPlayersAt"][11:16]} UTC' if d.get('peakPlayersAt') else '')
            + f'; game server memory peak {f(round((d["peakSkympRssMB"] or 0) / 1024, 1) if d["peakSkympRssMB"] else None, " GB")}'
            + f'; box memory free down to {f(d["minMemAvailPct"], "%")}; load peak {f(d["peakLoad"])}'
            + f'; event loop p99 peak {f(d["peakLoopP99"], " ms")}; disk {f(d["peakDiskPct"], "%")}'
            + f'; restarts {f(d["restarts"])}, crashes {f(d["crashes"])}'
            + f'; not a hoster {lg.get("host_not_hoster", 0):,} of {lg.get("host_granted", 0):,} host grants'
            + f'; hit refusals {grp("hit"):,}; drift reports {grp("drift"):,} (split {lg.get("drift_split", 0):,}, jump {lg.get("drift_jump", 0):,})'
            + (f'; missing-form lines {lg.get("form_missing", 0):,}' if lg.get('form_missing') else '') + f'; {d["samples"]} samples.')


def write_public(d, s_last):
    """public-status.json: only what a public status page may show (the phase 2 route reads it). No addresses, no
    paths, no names."""
    pub = {'updatedAt': s_last.get('t') if s_last else None,
           'state': 'online' if s_last and s_last.get('skymp', {}).get('active') == 'active' else 'down',
           'since': (s_last or {}).get('skymp', {}).get('since'),
           'playersOnline': (s_last or {}).get('players'),
           'yesterday': {'day': d['day'], 'peakPlayers': d['peakPlayers'], 'restarts': d['restarts'], 'crashes': d['crashes']}}
    tmp = os.path.join(STATE_DIR, 'public-status.json.tmp')
    with open(tmp, 'w') as fh:
        json.dump(pub, fh)
    os.replace(tmp, os.path.join(STATE_DIR, 'public-status.json'))
    return pub


def main(argv):
    cmd = argv[1] if len(argv) > 1 else 'sample'
    c = config()
    if cmd == 'sample':
        st = load_state()
        s = sample_now(st)
        append_sample(s)
        dispatch(evaluate(s, st, c), st, c)
        save_state(st)
        prune()
        return 0
    if cmd in ('daily', 'report'):
        day = argv[2] if len(argv) > 2 else (datetime.datetime.now(datetime.timezone.utc).date() - datetime.timedelta(days=1)).isoformat()
        samples = read_day(day)
        d = summarize(day, samples, journal_restarts(day))
        line = summary_line(d)
        print(line)
        if cmd == 'daily':
            with open(os.path.join(STATE_DIR, 'daily.jsonl'), 'a') as fh:
                fh.write(json.dumps(d, separators=(',', ':')) + '\n')
            today = read_day(datetime.datetime.now(datetime.timezone.utc).date().isoformat())
            write_public(d, today[-1] if today else (samples[-1] if samples else None))
            if c.get('dailyPost'):
                st = load_state()
                dispatch([('daily-' + day, 'warn', line)], st, dict(c, repeatMinutes={'warn': 1440, 'crit': 1440}))
                save_state(st)
        return 0
    print(__doc__ or 'dbo_metrics.py sample | daily | report [YYYY-MM-DD]')
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv))
