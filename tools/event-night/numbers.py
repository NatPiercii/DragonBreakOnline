#!/usr/bin/env python3
# The numbers of one stretch of play on CT 115, for the event night's go/no-go (docs/alpha/event-night.md): players,
# server crashes and restarts, player crashes, sync errors per player-hour, memory, event-loop lag, NPC budget hits,
# Vampire Lord breakers, error lines by kind and bug reports. Counts only: no names, accounts or addresses are printed,
# so the output can be pasted into the results table. Run as root (the sources are root-only):
#
#   sudo python3 tools/event-night/numbers.py --from "2026-10-04 19:00" --to "2026-10-04 22:00"
#   sudo python3 tools/event-night/numbers.py --from ... --to ... --baseline-from "2026-10-03 19:00" --baseline-to "2026-10-03 22:00"
#
# Times are UTC. dbo-monitor keeps only its last 24 hours of counters, so run it the same night.
import argparse
import datetime
import glob
import json
import os
import re
import sys
from collections import Counter

MONITOR_DIR = '/var/lib/dbo-monitor'
SERVER_LOG = '/var/log/skymp-server.log'
SESSION_ENDS = '/opt/alduinak/skymp5-backend/data/session-ends.jsonl'

P99 = re.compile(r'event loop p99 ([\d.]+) max ([\d.]+)')
TICKS = re.compile(r'\[gamemode\] ticks \(ms, last 60 s, (\d+) online\)')
ERROR = re.compile(r'\] \[(?:error|critical)\] ')
# Error lines that are always there: counted apart, so a new kind stands out
KNOWN = re.compile(r"resolved context with \d+ entries|Form with id 0x[0-9a-f]+ doesn't exist|No permission to update actor|Refr pointer expired|Target actor doesn.t exist|Method not found|Recipe not found|CastPrimitivePropertyValue|Error updating info on master server")
LINES = {
    'server_starts': re.compile(r'Using master server on'),
    'budget_hits': re.compile(r'at the budget of'),
    'vlbreaker_trips': re.compile(r'vlbreaker: tripped'),
    'vlwatch_lines': re.compile(r'vlwatch'),
    'connects': re.compile(r'\] connect \d+$'),
    'disconnects': re.compile(r'\] disconnect \d+$'),
    'gamemode_load_failed': re.compile(r'failed to load'),
}
# The sync series, read from the log as dbo_metrics.py counts them (a line counts in the first that matches), so a window
# from before the metrics began can still be a baseline
SYNC = [
    ('host_not_hoster', re.compile(r"SendToNeighbours - No permission to update actor [0-9a-f]+ \(not a hoster\)")),
    ('host_target_missing', re.compile(r"SendToNeighbours - Target actor doesn't exist")),
    ('host_granted', re.compile(r'Hoster of [0-9a-f]+ changed from')),
    ('hit_too_distant', re.compile(r'ActionListener::OnHit - aggressor and targetRef are too distant')),
    ('hit_diff_cell', re.compile(r'ActionListener::OnHit - aggressor and targetRef are in different cells or world')),
    ('hit_worldspace', re.compile(r"WorldSpace doesn't match")),
    ('hit_target_missing', re.compile(r'ActionListener::OnHit - MpObjectReference not found for hitData\.target')),
    ('cast_bad_hoster', re.compile(r'Bad hoster is attached to caster')),
    ('drift_split', re.compile(r'npcDrift .*"kind":"split"')),
    ('drift_jump', re.compile(r'npcDrift .*"kind":"jump"')),
    ('drift_other', re.compile(r'npcDrift .*"kind":"(?:sink|bounce|pinned|locomotion)"')),
]
MONITOR_KEYS = ['player.join', 'player.leave', 'player.quit_menu', 'player.crash', 'player.bug_report', 'server.crash', 'server.restart', 'server.load_failed']


def utc(s):
    return datetime.datetime.strptime(s, '%Y-%m-%d %H:%M').replace(tzinfo=datetime.timezone.utc)


def days(t0, t1):
    d = t0.date()
    while d <= t1.date():
        yield d
        d += datetime.timedelta(days=1)


def metrics(t0, t1):
    rows = []
    for d in days(t0, t1):
        for path in glob.glob(os.path.join(MONITOR_DIR, f'metrics-{d:%Y%m%d}.jsonl')):
            with open(path) as fh:
                for line in fh:
                    try:
                        r = json.loads(line)
                    except ValueError:
                        continue
                    t = datetime.datetime.strptime(r['t'], '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=datetime.timezone.utc)
                    if t0 <= t < t1:
                        rows.append(r)
    out = {'samples': len(rows)}
    if not rows:
        return out
    sk = [r.get('skymp') or {} for r in rows]
    box = [r.get('box') or {} for r in rows]
    players = [r.get('players') or 0 for r in rows]
    peak = max(players)
    out.update({
        'peak_players': peak,
        'peak_players_at': next(r['t'] for r in rows if (r.get('players') or 0) == peak)[11:16],
        'player_hours': round(sum(players) / 60, 2),
        'skymp_rss_start_mb': sk[0].get('rssMB'),
        'skymp_rss_peak_mb': max((x.get('rssMB') or 0) for x in sk),
        'box_mem_free_min_pct': min((x.get('memAvailPct') or 100) for x in box),
        'disk_used_peak_pct': max(((r.get('disk') or {}).get('usedPct') or 0) for r in rows),
        'skymp_restarts_systemd': (sk[-1].get('restarts') or 0) - (sk[0].get('restarts') or 0),
        'skymp_inactive_samples': sum(1 for x in sk if x.get('active') != 'active'),
        'error_lines_metrics': sum(r.get('errors') or 0 for r in rows),
    })
    series = Counter()
    for r in rows:
        series.update(r.get('log') or {})
    out['series'] = dict(series)
    return out


def server_log(t0, t1):
    lo, hi = '[' + t0.strftime('%Y-%m-%d %H:%M'), '[' + t1.strftime('%Y-%m-%d %H:%M')
    counts, kinds, known, sync = Counter(), Counter(), 0, Counter()
    p99s, maxes, online = [], [], []
    for path in [SERVER_LOG + '.1', SERVER_LOG]:
        if not os.path.exists(path):
            continue
        with open(path, errors='replace') as fh:
            for line in fh:
                if not line.startswith('[20') or line < lo or line >= hi:
                    continue
                line = line.rstrip('\n')
                for k, r in LINES.items():
                    if r.search(line):
                        counts[k] += 1
                for k, r in SYNC:
                    if r.search(line):
                        sync[k] += 1
                        break
                t = TICKS.search(line)
                if t:
                    online.append(int(t.group(1)))
                    m = P99.search(line)
                    if m:
                        p99s.append(float(m.group(1)))
                        maxes.append(float(m.group(2)))
                if ERROR.search(line):
                    if KNOWN.search(line):
                        known += 1
                    else:
                        kind = re.sub(r'^\[[^]]*\] ', '', line)
                        kind = re.sub(r'0x[0-9a-f]+|\b[0-9a-f]{6,8}\b', 'X', kind)
                        kinds[re.sub(r'\d+', 'N', kind)[:140]] += 1
    out = dict(counts)
    out['series'] = dict(sync)
    out['player_hours'] = round(sum(online) / 60, 2)
    out['peak_players'] = max(online) if online else None
    out['loop_minutes'] = len(p99s)
    if p99s:
        out['loop_p99_peak_ms'] = max(p99s)
        out['loop_minutes_p99_over_250ms'] = sum(1 for v in p99s if v > 250)
        out['loop_max_peak_ms'] = max(maxes)
        out['loop_minutes_max_over_2s'] = sum(1 for v in maxes if v > 2000)
    out['error_lines_known_noise'] = known
    out['error_lines_other'] = sum(kinds.values())
    out['error_kinds_other'] = kinds.most_common(8)
    return out


def session_ends(t0, t1):
    a, b = t0.timestamp() * 1000, t1.timestamp() * 1000
    c, logs, accounts = Counter(), 0, set()
    if not os.path.exists(SESSION_ENDS):
        return {}
    with open(SESSION_ENDS) as fh:
        for line in fh:
            try:
                d = json.loads(line)
            except ValueError:
                continue
            if not a <= (d.get('at') or 0) < b:
                continue
            c[d.get('outcome')] += 1
            logs += 1 if d.get('outcome') == 'crash' and d.get('crashLog') else 0
            accounts.add(d.get('discordId') or d.get('profileId'))
    total = sum(c.values())
    return {'sessions_ended': total, 'crash': c.get('crash', 0), 'closed': c.get('closed', 0), 'ended_other': c.get('ended', 0),
            'crash_with_crash_log': logs, 'accounts': len(accounts),
            'crash_rate_pct': round(100 * c.get('crash', 0) / total, 1) if total else None}


def monitor(t0, t1):
    try:
        with open(os.path.join(MONITOR_DIR, 'state.json')) as fh:
            windows = json.load(fh).get('windows') or []
    except (OSError, ValueError):
        return {}
    a, b = t0.timestamp(), t1.timestamp()
    inside = [w for w in windows if a <= (w.get('start') or 0) < b]
    c = Counter()
    for w in inside:
        c.update(w.get('counts') or {})
    out = {k: c.get(k, 0) for k in MONITOR_KEYS}
    oldest = min((w.get('start') or 0) for w in windows) if windows else None
    out['covered'] = bool(oldest and oldest <= a)
    return out


def bug_reports(t0, t1):
    n = 0
    for path in glob.glob(os.path.join(MONITOR_DIR, 'bugs', '*.json')):
        stamp = os.path.basename(path)[:19]
        try:
            t = datetime.datetime.strptime(stamp, '%Y-%m-%dT%H-%M-%S').replace(tzinfo=datetime.timezone.utc)
        except ValueError:
            continue
        n += 1 if t0 <= t < t1 else 0
    return n


def collect(t0, t1):
    return {'window': f'{t0:%Y-%m-%d %H:%M} to {t1:%H:%M} UTC', 'metrics': metrics(t0, t1), 'log': server_log(t0, t1),
            'launcher': session_ends(t0, t1), 'monitor': monitor(t0, t1), 'bug_reports_in_game': bug_reports(t0, t1)}


def rates(r):
    m, lg = r['metrics'], r['log']
    ph = m.get('player_hours') or lg.get('player_hours') or 0
    s = lg.get('series') or {}
    per = lambda n: round(n / ph, 1) if ph else None
    granted = s.get('host_granted', 0)
    return {
        'not_hoster_per_player_hour': per(s.get('host_not_hoster', 0)),
        'not_hoster_per_host_grant': round(s.get('host_not_hoster', 0) / granted, 2) if granted else None,
        'hit_refusals_per_player_hour': per(sum(v for k, v in s.items() if k.startswith('hit_') or k == 'cast_bad_hoster')),
        'drift_reports_per_player_hour': per(sum(v for k, v in s.items() if k.startswith('drift_'))),
    }


def show(title, r):
    print(f'== {title}: {r["window"]}')
    m, lg, la, mo = r['metrics'], r['log'], r['launcher'], r['monitor']
    print(f'  players: peak {m.get("peak_players", lg.get("peak_players"))} at {m.get("peak_players_at", "?")} UTC, {m.get("player_hours") or lg.get("player_hours")} player-hours, {m.get("samples")} one-minute samples')
    print(f'  server: {lg.get("server_starts", 0)} starts in the log, {m.get("skymp_restarts_systemd")} systemd restarts, monitor crashes {mo.get("server.crash")} restarts {mo.get("server.restart")}, {m.get("skymp_inactive_samples")} minutes not active')
    print(f'  player crashes (launcher): {la.get("crash")} of {la.get("sessions_ended")} sessions ended ({la.get("crash_rate_pct")}%), {la.get("crash_with_crash_log")} with a Crash Logger log, {la.get("accounts")} accounts')
    print(f'  player crashes (monitor, silence before disconnect): {mo.get("player.crash")} of {mo.get("player.join")} joins; quits from the menu {mo.get("player.quit_menu")}' + ('' if mo.get('covered') else '  [monitor window not fully covered: run it within 24 h]'))
    print(f'  memory: game server {m.get("skymp_rss_start_mb")} MB at the start, peak {m.get("skymp_rss_peak_mb")} MB; box memory free down to {m.get("box_mem_free_min_pct")}%; disk peak {m.get("disk_used_peak_pct")}%')
    print(f'  event loop: p99 peak {lg.get("loop_p99_peak_ms")} ms, {lg.get("loop_minutes_p99_over_250ms")} minutes over 250 ms, max peak {lg.get("loop_max_peak_ms")} ms, {lg.get("loop_minutes_max_over_2s")} minutes with a block over 2 s ({lg.get("loop_minutes")} minutes read)')
    s = lg.get('series') or {}
    print(f'  sync (from the log): not a hoster {s.get("host_not_hoster", 0)} of {s.get("host_granted", 0)} host grants; hit too distant {s.get("hit_too_distant", 0)}; drift split {s.get("drift_split", 0)} jump {s.get("drift_jump", 0)}')
    print(f'  rates: {rates(r)}')
    print(f'  NPC budget hits {lg.get("budget_hits", 0)}; vlbreaker trips {lg.get("vlbreaker_trips", 0)}; vlwatch lines {lg.get("vlwatch_lines", 0)}; gamemode load failures {lg.get("gamemode_load_failed", 0)}')
    print(f'  errors: {lg.get("error_lines_other")} lines of other kinds, {lg.get("error_lines_known_noise")} known noise')
    for kind, n in lg.get('error_kinds_other') or []:
        print(f'    {n:6d}  {kind}')
    print(f'  bug reports: {r["bug_reports_in_game"]} /bug in game, {mo.get("player.bug_report")} counted by the monitor')


def main(argv):
    ap = argparse.ArgumentParser(description='Numbers for one stretch of play (UTC), counts only')
    ap.add_argument('--from', dest='t0', required=True)
    ap.add_argument('--to', dest='t1', required=True)
    ap.add_argument('--baseline-from', dest='b0')
    ap.add_argument('--baseline-to', dest='b1')
    ap.add_argument('--json', action='store_true', help='print JSON instead of text')
    a = ap.parse_args(argv)
    runs = [('event', collect(utc(a.t0), utc(a.t1)))]
    if a.b0 and a.b1:
        runs.append(('baseline', collect(utc(a.b0), utc(a.b1))))
    if a.json:
        print(json.dumps({k: dict(v, rates=rates(v)) for k, v in runs}, indent=1))
        return 0
    for title, r in runs:
        show(title, r)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
