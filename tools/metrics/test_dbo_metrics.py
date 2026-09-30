#!/usr/bin/env python3
# Tests for dbo_metrics.py on temp folders and a fake log (never the live files, never Discord).
#
#   python3 tools/metrics/test_dbo_metrics.py
import json
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
failures = 0


def check(label, ok, got=None):
    global failures
    print(('ok   ' if ok else 'FAIL ') + label + ('' if ok or got is None else '   ' + json.dumps(got, default=str)[:300]))
    if not ok:
        failures += 1


def main():
    tmp = tempfile.mkdtemp(prefix='claude-nate-metrics-test-')
    os.environ['DBO_METRICS_DIR'] = tmp
    os.environ['DBO_METRICS_LOG'] = os.path.join(tmp, 'server.log')
    os.environ['DBO_METRICS_CONFIG'] = os.path.join(tmp, 'none.json')
    os.environ['DBO_MONITOR_CHANNEL'] = ''
    import dbo_metrics as m
    try:
        log = m.LOG
        L = lambda t, msg: f'[2026-09-30 {t}.000] [console] [info] {msg}\n'
        E = lambda t, msg: f'[2026-09-30 {t}.000] [error] {msg}\n'
        with open(log, 'w') as fh:
            fh.write(L('00:00:00', 'old line before the first sample'))
        st = {}
        m.read_log(st)
        check('the first sample starts at the end of the log, not a month back', st['logPos'] == os.path.getsize(log))
        with open(log, 'a') as fh:
            fh.write(E('00:00:10', 'SendToNeighbours - No permission to update actor ff0001cf (not a hoster)'))
            fh.write(E('00:00:11', 'SendToNeighbours - No permission to update actor ff0001d0 (not a hoster)'))
            fh.write(L('00:00:12', 'Hoster of ff0001cf changed from ff00000f to ff000014'))
            fh.write(L('00:00:13', 'Hoster of ff0001cf released from ff00000f: its hoster no longer has it'))
            fh.write(E('00:00:14', 'ActionListener::OnHit - aggressor and targetRef are too distant. Aggressor: ff00000f'))
            fh.write(L('00:00:15', '[gamemode] npcDrift Old Man Rodd #AB12 split: {"kind":"split","hostedForMs":1200}'))
            fh.write(E('00:00:16', "Form with id 0xff000323 doesn't exist"))
            fh.write(E('00:00:17', 'resolved context with 2 entries (reason=exception):'))
            fh.write(E('00:00:18', 'something new broke'))
            fh.write(L('00:00:59', '[gamemode] ticks (ms, last 60 s, 3 online): npcGround 60x max 0.65 mean 0.14 | orphans 1x max 247.84 mean 247.84 slow 1 | event loop p99 12.5 max 260.2'))
        ticks, counts, errors = m.read_log(st)
        check('each line counts in its own series', counts == {'host_not_hoster': 2, 'host_granted': 1, 'host_rel_unsub': 1, 'hit_too_distant': 1, 'drift_split': 1, 'form_missing': 1}, counts)
        check('Papyrus context dumps are not errors; a new error is', errors == 1, errors)
        check('the ticks line gives players, the event loop and the slowest timer', ticks == {'online': 3, 'p99': 12.5, 'max': 260.2, 'slowest': {'timer': 'orphans', 'ms': 247.84}}, ticks)
        # copytruncate: the file shrinks, reading starts again from its start
        with open(log, 'w') as fh:
            fh.write(E('00:01:05', 'SendToNeighbours - No permission to update actor ff0001cf (not a hoster)'))
        _, counts, _ = m.read_log(st)
        check('after logrotate truncates the log, the new lines are read', counts == {'host_not_hoster': 1}, counts)

        # ---- alerts ----
        c = m.config()
        base = lambda **kw: {'t': '2026-09-30T00:01:00Z', 'players': 3, 'skymp': {'active': 'active', 'rssMB': kw.get('rss', 1200)},
                             'box': {'memTotalMB': 16384, 'memAvailMB': kw.get('avail', 12000), 'memAvailPct': round(kw.get('avail', 12000) * 100 / 16384, 1), 'load': [kw.get('load', 3.0), 3, 3], 'cores': 8},
                             'disk': {'usedPct': kw.get('disk', 61), 'freeGB': 45}, 'loop': {'p99': kw.get('p99', 10), 'max': 50, 'slowest': None}}
        st = {}
        got = [m.evaluate(base(), st, c) for _ in range(5)]
        check('a healthy box raises nothing', all(not g for g in got), got)
        st = {}
        got = [m.evaluate(base(rss=5000), st, c) for _ in range(3)]
        check('game server memory over 4 GB alerts after 3 minutes, not before', not got[0] and not got[1] and got[2] and got[2][0][:2] == ('rss', 'warn'), got)
        st = {}
        got = [m.evaluate(base(rss=7000), st, c) for _ in range(3)]
        check('over 6 GB it is critical', got[2][0][:2] == ('rss', 'crit'), got[2])
        st = {}
        check('disk at 96% is critical at once', m.evaluate(base(disk=96), st, c)[0][:2] == ('disk', 'crit'))
        st = {}
        got = [m.evaluate(base(p99=400), st, c) for _ in range(5)]
        check('event loop p99 over 250 ms for 5 minutes is lag', got[4] and got[4][0][0] == 'loop' and not got[3], got)
        st = {}
        got = [m.evaluate(base(avail=900), st, c) for _ in range(3)]
        check('box memory under 7% free is critical after 3 minutes', got[2][0][:2] == ('mem', 'crit'), got[2])

        # ---- dispatch: repeats, escalation, hourly cap, retry ----
        posted = []
        poster = lambda text: posted.append(text) or 'ok'
        st = {}
        m.dispatch([('rss', 'warn', 'A')], st, c, now=1000, poster=poster)
        m.dispatch([('rss', 'warn', 'A')], st, c, now=1060, poster=poster)
        check('the same warning is not repeated inside its hour', posted == ['A'], posted)
        m.dispatch([('rss', 'crit', 'B')], st, c, now=1120, poster=poster)
        check('a warning turning critical is posted at once', posted == ['A', 'B'], posted)
        m.dispatch([('rss', 'warn', 'C')], st, c, now=1120 + 3601, poster=poster)
        check('after its repeat time it may post again', posted[-1] == 'C', posted)
        posted.clear(); st = {}
        for i in range(12):
            m.dispatch([(f'k{i}', 'warn', f'x{i}')], st, c, now=5000 + i, poster=poster)
        check(f'no more than {c["maxPostsPerHour"]} posts an hour; the rest wait in the outbox', len(posted) == c['maxPostsPerHour'] and len(st['outbox']) == 12 - c['maxPostsPerHour'], {'posted': len(posted), 'kept': len(st['outbox'])})
        st = {}
        m.dispatch([('disk', 'crit', 'D')], st, c, now=9000, poster=lambda t: 'retry')
        check('a post Discord did not take is kept for next minute', st['outbox'] == ['D'])
        m.dispatch([], st, c, now=9060, poster=poster)
        check('...and sent then', posted[-1] == 'D' and st['outbox'] == [])

        # ---- files, summary, public status ----
        day = '2026-09-29'
        with open(m.day_file('20260829'), 'w') as fh:
            fh.write('{}\n')
        with open(m.day_file('20260929'), 'w') as fh:
            for i, (pl, rss, p99) in enumerate([(1, 1100, 8), (4, 1400, 30), (2, 1300, 12)]):
                s = base(rss=rss, p99=p99); s['t'] = f'{day}T20:0{i}:00Z'; s['players'] = pl
                s['skymp']['since'] = 'Tue 2026-09-29 17:15:00 UTC'
                s['log'] = {'host_not_hoster': 10 * (i + 1), 'host_granted': 12, 'hit_too_distant': 1, 'drift_split': 1, 'form_missing': 0}
                fh.write(json.dumps(s) + '\n')
        m.prune(now=__import__('time').mktime((2026, 9, 30, 12, 0, 0, 0, 0, 0)))
        check('files older than 30 days are pruned, newer kept', not os.path.exists(m.day_file('20260829')) and os.path.exists(m.day_file('20260929')))
        d = m.summarize(day, m.read_day(day), (2, 1))
        check('the day\'s peaks', d['peakPlayers'] == 4 and d['peakPlayersAt'] == '2026-09-29T20:01:00Z' and d['peakSkympRssMB'] == 1400 and d['peakLoopP99'] == 30 and d['restarts'] == 2 and d['crashes'] == 1, d)
        line = m.summary_line(d)
        check('the summary line keeps not-a-hoster apart, with its denominator', 'not a hoster 60 of 36 host grants' in line and 'hit refusals 3' in line and 'split 3' in line, line)
        pub = m.write_public(d, m.read_day(day)[-1])
        text = json.dumps(pub)
        check('public-status.json has state, since, players and yesterday only', set(pub) == {'updatedAt', 'state', 'since', 'playersOnline', 'yesterday'} and pub['yesterday']['peakPlayers'] == 4, pub)
        check('...and nothing like an address, a path or a token', not any(x in text for x in ('/', 'http', '127.', 'token')) or text.count('/') == 0, text)
        j = ['Started skymp.service - SkyMP dedicated server.', 'skymp.service: Main process exited, code=dumped, status=11/SEGV',
             'skymp.service: Failed with result \'core-dump\'.', 'Started skymp.service - SkyMP dedicated server.',
             'Stopping skymp.service - SkyMP dedicated server...', 'skymp.service: Main process exited, code=exited, status=1/FAILURE',
             'Stopped skymp.service.', 'Started skymp.service - SkyMP dedicated server.']
        check('the journal lines give 3 starts and 1 crash: a segfault is one, an exit after a stop is not', m.count_starts(j) == (3, 1), m.count_starts(j))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print('all passed' if not failures else f'{failures} FAILED')
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
