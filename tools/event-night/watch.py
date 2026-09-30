#!/usr/bin/env python3
# The live watch for the event night (docs/alpha/event-night.md, section 2): one line a minute with the players online,
# event-loop lag, game server and box memory, disk, the sync errors of that minute and player crashes, and a NOTE or STOP
# flag when a figure crosses the runbook's lines. Counts only, no names. Run as root in its own terminal; Ctrl+C ends it.
#
#   sudo python3 tools/event-night/watch.py
#
# It reads what is already written: the gamemode's tick summary in the server log (each minute), dbo-metrics' sample
# (each minute) and the launcher's session-end notes. It changes nothing.
import datetime
import glob
import json
import os
import re
import sys
import time
from collections import Counter, deque

SERVER_LOG = '/var/log/skymp-server.log'
MONITOR_DIR = '/var/lib/dbo-monitor'
SESSION_ENDS = '/opt/alduinak/skymp5-backend/data/session-ends.jsonl'

# The runbook's lines (section 2): NOTE is written down, STOP is for the event lead to call
NOTE = {'p99_ms': 250, 'p99_minutes': 3, 'block_ms': 2000, 'rss_mb': 4096, 'mem_free_pct': 15, 'disk_pct': 90,
        'not_hoster_per_grant': 3, 'too_distant': 20, 'new_error_kind': 20}
STOP = {'p99_ms': 1000, 'p99_minutes': 3, 'rss_mb': 6144, 'mem_free_pct': 7, 'disk_pct': 95, 'crashes_15min': 5,
        'disconnects_2min': 5}

TICKS = re.compile(r'\[gamemode\] ticks \(ms, last 60 s, (\d+) online\)')
P99 = re.compile(r'event loop p99 ([\d.]+) max ([\d.]+)')
ERROR = re.compile(r'\] \[(?:error|critical)\] ')
KNOWN = re.compile(r"resolved context with \d+ entries|Form with id 0x[0-9a-f]+ doesn't exist|No permission to update actor|Refr pointer expired|Target actor doesn.t exist|Method not found|Recipe not found|CastPrimitivePropertyValue|Error updating info on master server")
MINUTE = {
    'not_hoster': re.compile(r'No permission to update actor [0-9a-f]+ \(not a hoster\)'),
    'granted': re.compile(r'Hoster of [0-9a-f]+ changed from'),
    'too_distant': re.compile(r'aggressor and targetRef are too distant'),
    'budget': re.compile(r'at the budget of'),
    'vlbreaker': re.compile(r'vlbreaker: tripped'),
    'vlwatch': re.compile(r'vlwatch'),
    'start': re.compile(r'Using master server on'),
    'disconnect': re.compile(r'\] disconnect \d+$'),
    'load_failed': re.compile(r'failed to load'),
}


def follow(path):
    fh = open(path, errors='replace')
    fh.seek(0, os.SEEK_END)
    ino = os.fstat(fh.fileno()).st_ino
    while True:
        line = fh.readline()
        if line:
            yield line.rstrip('\n')
            continue
        try:
            if os.stat(path).st_ino != ino:      # rotated: start on the new file
                fh.close()
                fh = open(path, errors='replace')
                ino = os.fstat(fh.fileno()).st_ino
                continue
        except OSError:
            pass
        yield None


def last_sample():
    files = sorted(glob.glob(os.path.join(MONITOR_DIR, 'metrics-*.jsonl')))
    if not files:
        return {}
    try:
        with open(files[-1], 'rb') as fh:
            fh.seek(max(0, os.path.getsize(files[-1]) - 4096))
            return json.loads(fh.read().decode(errors='replace').strip().splitlines()[-1])
    except (OSError, ValueError, IndexError):
        return {}


def crashes_since(ms):
    n = 0
    try:
        with open(SESSION_ENDS) as fh:
            for line in fh:
                try:
                    d = json.loads(line)
                except ValueError:
                    continue
                n += 1 if d.get('outcome') == 'crash' and (d.get('at') or 0) >= ms else 0
    except OSError:
        pass
    return n


def main():
    counts, kinds = Counter(), Counter()
    high_p99 = 0
    stop_p99 = 0
    disconnects = deque()
    started = time.time() * 1000
    crashes_total = crashes_since(started)
    print('time  online  p99/max ms   rss MB  free%  disk%  hoster-err/grants  too-far  crashes(15m)  flags', flush=True)
    for line in follow(SERVER_LOG):
        if line is None:
            time.sleep(0.5)
            continue
        for k, r in MINUTE.items():
            if r.search(line):
                counts[k] += 1
                if k == 'disconnect':
                    disconnects.append(time.time())
        if ERROR.search(line) and not KNOWN.search(line):
            kind = re.sub(r'^\[[^]]*\] ', '', line)
            kinds[re.sub(r'\d+', 'N', re.sub(r'0x[0-9a-f]+|\b[0-9a-f]{6,8}\b', 'X', kind))[:100]] += 1
        t = TICKS.search(line)
        if not t:
            continue
        # One tick summary a minute: report the minute that just ended
        m = P99.search(line)
        p99, mx = (float(m.group(1)), float(m.group(2))) if m else (None, None)
        s = last_sample()
        sk, box, disk = s.get('skymp') or {}, s.get('box') or {}, s.get('disk') or {}
        rss, free, used = sk.get('rssMB') or 0, box.get('memAvailPct') or 100, disk.get('usedPct') or 0
        now = time.time()
        while disconnects and now - disconnects[0] > 120:
            disconnects.popleft()
        crashes15 = crashes_since(now * 1000 - 15 * 60000)
        flags = []
        high_p99 = high_p99 + 1 if p99 is not None and p99 > NOTE['p99_ms'] else 0
        stop_p99 = stop_p99 + 1 if p99 is not None and p99 > STOP['p99_ms'] else 0
        if stop_p99 >= STOP['p99_minutes']: flags.append(f'STOP lag: p99 over {STOP["p99_ms"]} ms for {stop_p99} min')
        elif high_p99 >= NOTE['p99_minutes']: flags.append(f'NOTE lag: p99 over {NOTE["p99_ms"]} ms for {high_p99} min')
        if mx is not None and mx > NOTE['block_ms']: flags.append(f'NOTE one block of {mx / 1000:.1f} s')
        if rss > STOP['rss_mb']: flags.append('STOP game server memory')
        elif rss > NOTE['rss_mb']: flags.append('NOTE game server memory')
        if free < STOP['mem_free_pct']: flags.append('STOP box memory')
        elif free < NOTE['mem_free_pct']: flags.append('NOTE box memory')
        if used > STOP['disk_pct']: flags.append('STOP disk')
        elif used > NOTE['disk_pct']: flags.append('NOTE disk')
        if counts['start']: flags.append('STOP the game server started again (crash or restart)')
        if counts['load_failed']: flags.append('STOP a gameplay module failed to load')
        if crashes15 >= STOP['crashes_15min']: flags.append(f'STOP {crashes15} player crashes in 15 min')
        elif crashes_since(started) > crashes_total: flags.append('NOTE a player crash')
        crashes_total = crashes_since(started)
        if len(disconnects) >= STOP['disconnects_2min']: flags.append(f'STOP {len(disconnects)} disconnects in 2 min (check how many quit from the menu)')
        if counts['granted'] >= 10 and counts['not_hoster'] > NOTE['not_hoster_per_grant'] * counts['granted']: flags.append('NOTE hoster errors')
        if counts['too_distant'] > NOTE['too_distant']: flags.append('NOTE hits refused as too distant')
        if counts['budget']: flags.append(f'NOTE NPC budget reached ({counts["budget"]}x)')
        if counts['vlbreaker']: flags.append('NOTE vlbreaker tripped')
        if counts['vlwatch']: flags.append(f'NOTE vlwatch {counts["vlwatch"]} line(s)')
        for kind, n in kinds.most_common(2):
            if n > NOTE['new_error_kind']: flags.append(f'NOTE {n}x {kind[:70]}')
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%H:%M')
        lag = f'{p99:.0f}/{mx:.0f}' if p99 is not None else '?'
        print(f'{stamp}  {t.group(1):>6}  {lag:>11}  {rss:>7}  {free:>5}  {used:>5}  {counts["not_hoster"]:>7}/{counts["granted"]:<9}  {counts["too_distant"]:>7}  {crashes15:>12}  {"; ".join(flags)}', flush=True)
        counts.clear()
        kinds.clear()


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
