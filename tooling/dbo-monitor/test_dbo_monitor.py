#!/usr/bin/env python3
"""Offline tests for dbo_monitor's alerts and Discord outbox: no network, no systemd, no real state dir or /proc.

Run: python3 tooling/dbo-monitor/test_dbo_monitor.py
The stall samples are the real tick summaries from /var/log/skymp-server.log on 2026-09-27 (00:33-02:11Z freeze).
"""
import calendar, os, sys, tempfile, threading, time, unittest, warnings
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dbo_monitor as dm

# Real line, verbatim: the last tick summary before the event loop stopped for 93 minutes
REAL_STALL_LINE = '[2026-09-27 00:33:57.172] [console] [info] [gamemode] ticks (ms, last 60 s, 1 online): worldStats 1x max 1607.82 mean 1607.82 slow 1 | debugSnap 6x max 446.21 mean 235.18 slow 4 | needs 1x max 1256.65 mean 1256.65 slow 1 | npcGround 15x max 205.80 mean 55.30 slow 6 | lawful 3x max 380.75 mean 210.26 slow 2 | tickSummary 1x max 444.08 mean 444.08 slow 1 | watch 6x max 180.88 mean 57.58 slow 2 | npcDirector 15x max 112.79 mean 19.87 slow 3 | charLevel 2x max 184.41 mean 119.60 slow 2 | updateSchedule 4x max 238.48 mean 59.65 slow 1 | superSilver 11x max 141.31 mean 12.87 slow 1 | deityPickerOffer 6x max 75.01 mean 20.25 slow 3 | moveTrace 34x max 110.27 mean 3.25 slow 1 | worldClock 3x max 86.74 mean 36.65 slow 2 | deathChill 15x max 82.31 mean 7.33 slow 2 | consoleRights 3x max 87.06 mean 29.05 slow 1 | meet 6x max 71.61 mean 12.03 slow 1 | economy 1x max 55.05 mean 55.05 slow 1 | playtest 6x max 34.19 mean 7.35 slow 1 | superFeral 1x max 25.00 mean 25.00 slow 1 | dungeons.tick 3x max 23.77 mean 7.93 slow 1 | jail 6x max 14.52 mean 2.43 | outside 4x max 13.97 mean 3.57 | discordRoles 3x max 9.96 mean 3.33 | rest 6x max 2.91 mean 0.51 | announce 6x max 0.16 mean 0.07 | beastForms 15x max 0.03 mean 0.01 | tenancy 1x max 0.13 mean 0.13 | audit 12x max 0.09 mean 0.01 | loginWait 17x max 0.01 mean 0.01 | superSlow 3x max 0.06 mean 0.03 | robbery 15x max 0.02 mean 0.01 | downedDelay 4x max 0.04 mean 0.02 | realm 11x max 0.01 mean 0.00 | superRevive 4x max 0.01 mean 0.01 | dungeons.arm 11x max 0.00 mean 0.00 | superSun 4x max 0.01 mean 0.01 | prayerBlessings 1x max 0.02 mean 0.02 | superMoon 6x max 0.00 mean 0.00 | raids 4x max 0.01 mean 0.00 | commissions 4x max 0.01 mean 0.00 | saves 6x max 0.00 mean 0.00 | moveTraceWrite 6x max 0.00 mean 0.00 | event loop p99 12968.8 max 12968.8 | gc 0x max 0.0 total 0.0'

# Real (time, online, p99, max) of every tick summary 00:30-02:14Z on 2026-09-27; none were logged 00:33:57-02:06:57
STALL = [
    ('2026-09-27 00:30:34', 1, 11.0, 21.4), ('2026-09-27 00:31:34', 1, 11.1, 242.2),
    ('2026-09-27 00:32:35', 1, 358.6, 8900.3), ('2026-09-27 00:33:57', 1, 12968.8, 12968.8),
    ('2026-09-27 02:06:57', 0, 0.0, 0.0), ('2026-09-27 02:07:57', 0, 194.9, 3737.1),
    ('2026-09-27 02:08:57', 0, 192.5, 2306.9), ('2026-09-27 02:10:00', 0, 1836.1, 4563.4),
    ('2026-09-27 02:11:00', 0, 36.2, 2514.5), ('2026-09-27 02:13:52', 0, 11.6, 167.1),
    ('2026-09-27 02:14:52', 0, 11.0, 11.6),
]


# Real readings on CT 115: /sys/fs/cgroup/io.pressure at 03:05Z, the container root cgroup at 02:34Z (memory.max is 'max')
REAL_PSI_IO = 'some avg10=0.00 avg60=0.60 avg300=1.13 total=7970387572\nfull avg10=0.00 avg60=0.58 avg300=1.10 total=7849741351\n'
REAL_CURRENT, REAL_INACTIVE_FILE, REAL_MEMTOTAL_KB = 8138911744, 3550515200, 16777216
REAL_PEAK = 17051009024    # memory.peak: what the runaway dev test reached during the stall
MB = 1048576


# Real `journalctl -u skymp -o cat` lines (unit description shortened)
UNIT = 'skymp.service - SkyMP dedicated server'
J_SEGV = [f'Started {UNIT}.', 'skymp.service: Main process exited, code=killed, status=11/SEGV',
          "skymp.service: Failed with result 'signal'.", 'skymp.service: Consumed 1min 57.303s CPU time.',
          'skymp.service: Scheduled restart job, restart counter is at 1.', f'Started {UNIT}.']    # 2026-09-25 21:39
J_STOP = [f'Started {UNIT}.', f'Stopping {UNIT}...', 'skymp.service: Deactivated successfully.', f'Stopped {UNIT}.',
          'skymp.service: Consumed 4min 58.829s CPU time, 849.0M memory peak, 230.9M memory swap peak.',
          f'Started {UNIT}.']    # 2026-09-27 02:11, after the stall
J_EXCEPTION = [f'Started {UNIT}.', 'skymp.service: Main process exited, code=exited, status=255/EXCEPTION',
               "skymp.service: Failed with result 'exit-code'.",
               'skymp.service: Scheduled restart job, restart counter is at 1.', f'Started {UNIT}.']    # 2026-09-18


def psi(full60, some60=None):
    some60 = full60 if some60 is None else some60
    return f'some avg10=0.00 avg60={some60:.2f} avg300=0.00 total=1\nfull avg10=0.00 avg60={full60:.2f} avg300=0.00 total=1\n'


def epoch(ts):
    return calendar.timegm(time.strptime(ts[:19], '%Y-%m-%d %H:%M:%S'))


def tick_line(ts, online, p99, mx):
    return (f'[{ts}.000] [console] [info] [gamemode] ticks (ms, last 60 s, {online} online): moveTrace 2977x max 0.08 '
            f'mean 0.00 | worldStats 1x max 1.75 mean 1.75 | event loop p99 {p99} max {mx} | gc 43x max 2.1 total 25.7')


class MonitorCase(unittest.TestCase):
    """A Monitor on a temp state dir with a fake clock; posts are captured, never sent."""

    def setUp(self):
        warnings.simplefilter('ignore', ResourceWarning)    # the state write leaves its file to the GC
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = tmp.name
        self.now = 0.0
        self.posts = []
        self.bugs = []
        self.active = True
        self.cause = ('', '')
        for target, value in [
            ('STATE_DIR', self.tmp), ('STATE', os.path.join(self.tmp, 'state.json')), ('CHANNEL', ''),
            ('post', lambda text, digest=False: self.posts.append(text)),
            ('post_bug', lambda *a: self.bugs.append(a)), ('token', lambda: ''),
            ('skymp_active', lambda: self.active), ('journal_start_cause', lambda: self.cause),
            ('PSI_IO', self.path('cg/io.pressure')), ('PSI_MEM', self.path('cg/memory.pressure')),
            ('CGROUP', self.path('cg')), ('MEMINFO', self.path('proc/meminfo')),
        ]:
            p = mock.patch.object(dm, target, value)
            p.start(); self.addCleanup(p.stop)
        for p in (mock.patch.object(dm.time, 'time', lambda: self.now),
                  mock.patch.object(dm.urllib.request, 'urlopen', side_effect=AssertionError('network use in a test'))):
            p.start(); self.addCleanup(p.stop)

        self.fake_system(io=REAL_PSI_IO, mem=psi(0), current=REAL_CURRENT, inactive=REAL_INACTIVE_FILE, limit='max')

    def path(self, rel):
        return os.path.join(self.tmp, rel)

    def write(self, rel, text):
        os.makedirs(os.path.dirname(self.path(rel)), exist_ok=True)
        with open(self.path(rel), 'w') as f:
            f.write(str(text))

    def fake_system(self, io=None, mem=None, current=None, inactive=None, limit=None):
        """Writes the fake /proc and /sys/fs/cgroup files the pressure check reads; None keeps a file as it is."""
        for rel, v in (('cg/io.pressure', io), ('cg/memory.pressure', mem), ('cg/memory.current', current),
                       ('cg/memory.max', limit), ('cg/memory.stat', inactive and f'anon 1\nfile 2\ninactive_file {inactive}\n')):
            if v is not None:
                self.write(rel, v)
        self.write('proc/meminfo', f'MemTotal:       {REAL_MEMTOTAL_KB} kB\nMemFree:          100 kB\n')
        for rel, mb in (('user.slice/user-1001.slice', 11843), ('user.slice/user-0.slice', 1163),
                        ('system.slice/skymp.service', 1064), ('system.slice/dbo-monitor.service', 9)):
            self.write(f'cg/{rel}/memory.current', mb * MB)
        self.write('cg/user.slice/memory.current', 13000 * MB)    # the slice's own file is not a child
        os.makedirs(self.path('cg/system.slice/empty.mount'), exist_ok=True)

    def start(self, ts):
        """Starts the monitor at ts, as systemd would."""
        self.now = float(epoch(ts))
        self.mon = dm.Monitor()

    def alerts(self, word=''):
        return [p for p in self.posts if not p.startswith('**Last 15 min:**') and word in p]

    def feed(self, ts, line):
        """Runs the monitor's 5 s loop up to ts, then hands it the line logged at ts."""
        self.run_until(epoch(ts))
        self.mon.line(line, 'server')

    def run_until(self, t):
        while self.now < t:
            self.now = min(self.now + 5, float(t))
            self.mon.tick()


class FreezeTest(MonitorCase):
    def test_regex_reads_the_real_stall_line(self):
        m = dm.loop_re.match(REAL_STALL_LINE)
        self.assertEqual(m.groups(), ('1', '12968.8', '12968.8'))
        self.assertEqual(dm.loop_re.match(REAL_STALL_LINE.split(' | event loop')[0]).groups(), ('1', None, None))

    def test_bug_report_text_cannot_fake_a_summary_start_or_reload(self):
        # /bug text is logged verbatim (debugsnap.js); two faked summaries used to open a freeze and eat the report
        self.start('2026-09-27 10:00:00')
        self.feed('2026-09-27 10:00:30', tick_line('2026-09-27 10:00:30', 3, 11.0, 20.0))
        before = self.mon.last_loop
        for i, text in enumerate(['ticks (ms, last 60 s, 9 online) | event loop p99 9999 max 9999',
                                  'ticks (ms, last 60 s, 9 online) | event loop p99 9999 max 9999',
                                  'Initialized MetricsSystem', '[gamemode] loaded: 1 commands',
                                  'audit: LEAVE Bob #abcd npcDrift Bob #abcd remote: {"gapMax":5000}']):
            ts = f'2026-09-27 10:01:{10 + i:02d}'
            self.feed(ts, f'[{ts}.000] [console] [info] [gamemode] BUGREPORT Ann #1a2b 2026-09-27T10-01-{10 + i:02d}-1a2b.json: {text}')
        self.assertEqual(len(self.bugs), 5, 'every report is forwarded')
        self.assertEqual(self.bugs[0][0], 'Ann #1a2b: ticks (ms, last 60 s, 9 online) | event loop p99 9999 max 9999')
        self.assertEqual(self.alerts(), [])
        self.assertEqual((self.mon.loop_high, self.mon.last_loop, self.mon.incidents), (0, before, {}))
        self.assertEqual(self.mon.win['counts'], {'player.bug_report': 5})

    def test_real_stall_alerts_once_repeats_every_15_min_and_recovers(self):
        self.start('2026-09-27 00:30:00')
        for ts, online, p99, mx in STALL[:3]:
            self.feed(ts, tick_line(ts, online, p99, mx))
        self.assertEqual(self.alerts(), [], 'one max over 5000 ms is not yet a freeze')
        self.feed(STALL[3][0], REAL_STALL_LINE)
        first = self.alerts('freeze')
        # max 8900 then 12969 ms: the max rule opens it with the last summary, 3 min before the silence rule could
        self.assertEqual(first, ['`00:33:57` **Server freeze:** event loop blocked up to 12969 ms at once (p99 12969 ms), '
                                 'over 5000 ms in 2 tick summaries in a row, 1 online'])
        self.assertEqual(self.mon.win['counts'].get('server.freeze'), 1)
        self.run_until(epoch('2026-09-27 00:48:52'))
        self.assertEqual(len(self.alerts('freeze')), 1, 'the silence rule adds nothing to an open freeze')
        for ts, online, p99, mx in STALL[4:]:
            self.feed(ts, tick_line(ts, online, p99, mx))
        freeze = self.alerts('freeze')
        # opened 00:33:57, repeated by the silence rule at 15, 30, 45, 60, 75 and 90 min, then the loop came back
        self.assertEqual(len(freeze), 7, freeze)
        self.assertTrue(freeze[1].startswith('`00:48:57` **Server freeze:** no tick summary for 15 min'), freeze[1])
        self.assertIn('(still going, 90 min)', freeze[-1])
        rec = self.alerts('recovered')
        self.assertEqual(len(rec), 1, 'the 0.0/0.0 summary at 02:06:57 is no data, the 194.9 ms one at 02:07:57 recovers')
        self.assertEqual(rec[0], '`02:07:57` Server recovered: event loop p99 195 ms (max 3737 ms), 94 min after the alert')
        self.assertEqual(self.mon.incidents, {})
        self.assertEqual(len(self.alerts()), 8, 'p99 1836 ms, max 4563 ms at 02:10:00 are under the lines: no new alert')

    def test_silence_alert_lands_3_min_after_the_last_summary(self):
        self.start('2026-09-27 00:30:00')
        self.feed('2026-09-27 00:31:34', tick_line('2026-09-27 00:31:34', 1, 11.1, 242.2))
        self.run_until(epoch('2026-09-27 00:34:33'))
        self.assertEqual(self.alerts(), [])
        self.run_until(epoch('2026-09-27 00:34:39'))
        self.assertEqual(len(self.alerts('no tick summary for 3 min')), 1, 'checked every 5 s loop, not every 60 s')

    def test_real_long_blocks_under_the_freeze_lines(self):
        # every tick summary from 2026-09-21 to 09-27 with max over 2000 ms or 10 s, outside the stall (p99 11 ms each)
        self.start('2026-09-25 05:20:00')
        prev = 0
        for ts, p99, mx in [('2026-09-25 05:25:46', 11.0, 11190.4), ('2026-09-25 05:35:57', 11.5, 31289.5),
                            ('2026-09-25 23:45:46', 11.2, 2042.6), ('2026-09-25 23:46:46', 11.4, 2713.7),
                            ('2026-09-26 08:18:26', 11.0, 2336.2), ('2026-09-26 08:19:26', 11.0, 5356.1),
                            ('2026-09-26 15:21:26', 11.5, 32027.7), ('2026-09-26 15:50:01', 10.9, 30819.7),
                            ('2026-09-26 15:52:01', 11.0, 12406.8)]:
            if epoch(ts) - prev > 60:    # jump ahead, then the ordinary summary the minute before
                self.mon.last_loop = self.mon.last_health = self.now = float(epoch(ts) - 65)
                before = time.strftime('%Y-%m-%d %H:%M:%S', time.gmtime(epoch(ts) - 60))
                self.feed(before, tick_line(before, 4, 11.0, 20.0))
            self.feed(ts, tick_line(ts, 4, p99, mx))
            prev = epoch(ts)
        self.assertEqual(self.alerts('freeze'), [], 'the only pair over 5000 ms in a row is the stall')
        self.assertEqual(self.alerts(), [
            '`05:35:57` **Server hitch:** the event loop was blocked 31.3 s at once in the minute to 05:35:57 (p99 12 ms), 4 online',
            '`15:21:26` **Server hitch:** the event loop was blocked 32.0 s at once in the minute to 15:21:26 (p99 12 ms), 4 online',
            '`15:50:01` **Server hitch:** the event loop was blocked 30.8 s at once in the minute to 15:50:01 (p99 11 ms), 4 online'])

    def test_two_summaries_over_2000_ms_open_one_incident(self):
        self.start('2026-09-27 09:59:30')
        base = epoch('2026-09-27 10:00:00')
        for i, p99 in enumerate([11.0, 2500.0, 3100.0, 4000.0, 2600.0]):
            ts = time.strftime('%Y-%m-%d %H:%M:%S', time.gmtime(base + 60 * i))
            self.feed(ts, tick_line(ts, 3, p99, p99 + 500))
        a = self.alerts('freeze')
        self.assertEqual(len(a), 1, a)
        self.assertIn('event loop p99 3100 ms (max 3600 ms), over 2000 ms in 2 tick summaries in a row, 3 online', a[0])
        for i in range(5, 21):    # stays frozen: one repeat after 15 min
            ts = time.strftime('%Y-%m-%d %H:%M:%S', time.gmtime(base + 60 * i))
            self.feed(ts, tick_line(ts, 3, 5000.0, 6000.0))
        self.assertEqual(len(self.alerts('freeze')), 2)
        ts = time.strftime('%Y-%m-%d %H:%M:%S', time.gmtime(base + 60 * 21))
        self.feed(ts, tick_line(ts, 3, 900.0, 1500.0))
        self.assertEqual(self.alerts('recovered'), [], '900 ms is under 2000 but not back under 200')
        ts = time.strftime('%Y-%m-%d %H:%M:%S', time.gmtime(base + 60 * 22))
        self.feed(ts, tick_line(ts, 3, 12.0, 30.0))
        self.assertEqual(len(self.alerts('recovered')), 1)
        self.assertIn('20 min after the alert', self.alerts('recovered')[0])

    def test_a_summary_without_event_loop_figures_still_counts_as_alive(self):
        self.start('2026-09-22 01:00:00')
        old = '[2026-09-22 01:{:02d}:46.264] [console] [info] [gamemode] ticks (ms, last 60 s, 0 online): worldStats 1x max 10.45 mean 10.45'
        for minute in range(1, 30):
            self.feed(f'2026-09-22 01:{minute:02d}:46', old.format(minute))
        self.assertEqual(self.alerts(), [])
        self.assertEqual(self.mon.loop_high, 0)

    def test_one_spike_is_not_a_freeze(self):
        self.start('2026-09-27 00:32:00')
        for ts, p99 in [('2026-09-27 00:32:35', 358.6), ('2026-09-27 00:33:57', 12968.8), ('2026-09-27 00:34:57', 11.0)]:
            self.feed(ts, tick_line(ts, 1, p99, p99))
        self.assertEqual(self.alerts(), [])

    def test_silence_while_skymp_is_stopped_is_quiet(self):
        self.start('2026-09-27 02:59:30')
        self.active = False
        self.feed('2026-09-27 03:00:00', tick_line('2026-09-27 03:00:00', 0, 11.0, 12.0))
        self.run_until(epoch('2026-09-27 04:00:00'))
        self.assertEqual(self.alerts(), [])

    def test_a_start_or_gamemode_reload_restarts_the_silence_clock(self):
        # real restart: last summary 02:11:00, MetricsSystem 02:11:34, first summary 02:13:52; here a slower boot
        self.start('2026-09-27 02:10:30')
        self.feed('2026-09-27 02:11:00', tick_line('2026-09-27 02:11:00', 0, 36.2, 2514.5))
        self.feed('2026-09-27 02:11:34', '[2026-09-27 02:11:34.367] [console] [info] Initialized MetricsSystem')
        self.run_until(epoch('2026-09-27 02:14:30'))
        self.assertEqual(self.alerts('freeze'), [])
        self.feed('2026-09-27 02:14:30', '[2026-09-27 02:14:30.000] [console] [info] [gamemode] loaded: 13 commands, 0 admin profile id(s)')
        self.run_until(epoch('2026-09-27 02:17:20'))
        self.assertEqual(self.alerts('freeze'), [])
        self.run_until(epoch('2026-09-27 02:18:30'))
        self.assertEqual(len(self.alerts('freeze')), 1)

    def test_a_start_after_a_long_stop_is_not_a_freeze(self):
        # skymp is active up to 9 s before MetricsSystem is logged; a check in that gap used to raise a freeze
        for started in ('2026-09-27 10:10:58', '2026-09-27 10:12:58'):    # just before a check, and before a clock reset
            with self.subTest(started=started):
                self.posts.clear()
                self.start('2026-09-27 10:00:00')
                self.feed('2026-09-27 10:00:30', tick_line('2026-09-27 10:00:30', 3, 11.0, 20.0))
                self.active = False    # stopped at 10:01
                self.run_until(epoch(started))
                self.active = True
                mt = time.strftime('%Y-%m-%d %H:%M:%S', time.gmtime(epoch(started) + 9))
                self.feed(mt, f'[{mt}.000] [console] [info] Initialized MetricsSystem')
                self.assertEqual(self.alerts(), ['`%s` Game server started' % mt[11:]])
                self.run_until(epoch(mt) + 170)
                self.assertEqual(len(self.alerts()), 1)

    def test_a_server_that_starts_but_never_logs_is_still_a_freeze(self):
        self.start('2026-09-27 10:00:00')
        self.active = False
        self.run_until(epoch('2026-09-27 10:10:00'))
        self.active = True    # started, then hung before MetricsSystem
        self.run_until(epoch('2026-09-27 10:17:00'))
        self.assertEqual(len(self.alerts('no tick summary')), 1)

    def test_a_restart_ends_an_open_freeze(self):
        self.start('2026-09-27 00:33:00')
        self.feed('2026-09-27 00:33:57', REAL_STALL_LINE)
        self.run_until(epoch('2026-09-27 00:40:00'))
        self.assertIn('freeze', self.mon.incidents)
        self.cause = ('restarted', '')
        self.feed('2026-09-27 02:11:34', '[2026-09-27 02:11:34.367] [console] [info] Initialized MetricsSystem')
        self.assertEqual(self.alerts()[-1], '`02:11:34` Game server restarted; that ends the freeze alert from 94 min ago')
        self.assertEqual(self.mon.incidents, {})


class PressureTest(MonitorCase):
    def setUp(self):
        super().setUp()
        self.active = False    # no game server here, so no tick summaries and no freeze alerts

    def test_readers_on_real_numbers(self):
        self.assertEqual(dm.psi_full60(self.path('cg/io.pressure')), 0.58, 'full, not some')
        self.assertIsNone(dm.psi_full60(self.path('cg/missing.pressure')))
        total = dm.mem_total()
        self.assertEqual(total, REAL_MEMTOTAL_KB * 1024)
        self.assertEqual(dm.mem_use(total), (REAL_CURRENT - REAL_INACTIVE_FILE, total), 'max -> MemTotal')
        self.assertEqual(dm.mem_use(None), (None, None), 'no MemTotal, no memory figure')
        self.write('cg/memory.max', 12884901888)
        self.assertEqual(dm.mem_use(None)[1], 12884901888)
        self.assertEqual(dm.top_cgroups(), ['user-1001.slice 11843 MB', 'user-0.slice 1163 MB', 'skymp.service 1064 MB'])

    def test_calm_real_system_is_quiet(self):
        self.start('2026-09-27 02:34:00')
        self.run_until(epoch('2026-09-27 03:34:00'))
        self.assertEqual(self.alerts(), [])

    def test_io_pressure_two_checks_alert_repeat_and_clear(self):
        self.start('2026-09-27 00:30:00')
        self.fake_system(io=psi(34.5))
        self.run_until(epoch('2026-09-27 00:31:00'))
        self.assertEqual(self.alerts(), [], 'one check over the line is not enough')
        self.run_until(epoch('2026-09-27 00:32:00'))
        a = self.alerts('pressure')
        self.assertEqual(a, ['`00:32:00` **Server under pressure:** io full avg60 34.5. '
                             'Biggest: user-1001.slice 11843 MB, user-0.slice 1163 MB, skymp.service 1064 MB'])
        self.assertEqual(self.mon.win['counts'].get('server.pressure'), 1)
        self.run_until(epoch('2026-09-27 00:46:00'))
        self.assertEqual(len(self.alerts('pressure')), 1, 'no repeat inside 15 min')
        self.run_until(epoch('2026-09-27 00:47:00'))
        self.assertEqual(len(self.alerts('pressure')), 2)
        self.assertIn('(still going, 15 min)', self.alerts('pressure')[-1])
        self.fake_system(io=psi(15.0))
        self.run_until(epoch('2026-09-27 00:50:00'))
        self.assertEqual(self.alerts('cleared'), [], '15 is under 20 but not calm yet')
        self.fake_system(io=psi(3.0))
        self.run_until(epoch('2026-09-27 00:51:00'))
        self.assertEqual(self.alerts('cleared'), ['`00:51:00` Pressure cleared: io full avg60 3.0, memory full avg60 0.0, '
                                                  'container memory 27%, 19 min after the alert'])

    def test_memory_full_at_the_stall_peak(self):
        self.start('2026-09-27 00:30:00')
        self.fake_system(current=REAL_PEAK, inactive=200 * MB, mem=psi(41.2))
        self.run_until(epoch('2026-09-27 00:32:00'))
        a = self.alerts('pressure')
        self.assertEqual(len(a), 1, a)
        self.assertIn('memory full avg60 41.2, container memory 15.7 of 16.0 GiB in use (98%). Biggest: user-1001.slice', a[0])

    def test_meminfo_is_read_once_at_start(self):
        # /proc/meminfo is lxcfs: the checks must not touch it after start, where a hung lxcfs would hang the monitor
        self.start('2026-09-27 00:30:00')
        self.fake_system(current=REAL_PEAK, inactive=200 * MB)
        os.remove(self.path('proc/meminfo'))
        self.run_until(epoch('2026-09-27 00:32:00'))
        self.assertIn('container memory 15.7 of 16.0 GiB in use (98%)', ''.join(self.alerts('pressure')))

    def test_page_cache_is_not_memory_in_use(self):
        self.start('2026-09-27 00:30:00')
        self.fake_system(current=16500 * MB, inactive=6000 * MB)
        self.run_until(epoch('2026-09-27 00:40:00'))
        self.assertEqual(self.alerts(), [])

    def test_unreadable_files_raise_nothing(self):
        self.start('2026-09-27 00:30:00')
        for rel in ('cg/io.pressure', 'cg/memory.pressure', 'cg/memory.current'):
            os.remove(self.path(rel))
        self.run_until(epoch('2026-09-27 00:40:00'))
        self.assertEqual(self.alerts(), [])


class StartTest(MonitorCase):
    def test_start_cause_from_real_journal_lines(self):
        self.assertEqual(dm.start_cause(J_SEGV), ('crashed', 'status=11/SEGV'))
        self.assertEqual(dm.start_cause(J_STOP), ('restarted', ''))
        self.assertEqual(dm.start_cause(J_EXCEPTION), ('crashed', 'status=255/EXCEPTION'))
        # with the LimitCORE=infinity drop-in a SIGSEGV now leaves a core: code=dumped
        dumped = [ln.replace('code=killed', 'code=dumped') for ln in J_SEGV]
        self.assertEqual(dm.start_cause(dumped), ('crashed', 'status=11/SEGV'))
        # a stop whose process then exits non-zero is still a stop; older history before the last start is ignored
        stop_255 = J_SEGV[:-1] + [f'Started {UNIT}.', f'Stopping {UNIT}...',
                                  'skymp.service: Main process exited, code=exited, status=255/EXCEPTION', f'Started {UNIT}.']
        self.assertEqual(dm.start_cause(stop_255), ('restarted', ''))
        self.assertEqual(dm.start_cause(J_STOP[-1:]), ('', ''), 'first start in the window')
        self.assertEqual(dm.start_cause([]), ('', ''))

    def test_start_alerts(self):
        self.start('2026-09-25 21:39:00')
        line = '[2026-09-25 21:39:28.000] [console] [info] Initialized MetricsSystem'
        for cause, text in [(('crashed', 'status=11/SEGV'), '`21:39:28` **Game server crashed** (status=11/SEGV) and started again'),
                            (('restarted', ''), '`21:39:28` Game server restarted'),
                            (('', ''), '`21:39:28` Game server started')]:
            self.posts.clear(); self.mon.alerted.clear(); self.cause = cause
            self.mon.line(line, 'server')
            self.assertEqual(self.alerts(), [text])
        self.assertEqual(self.mon.win['counts'].get('server.crash'), 1)
        self.assertEqual(self.mon.win['counts'].get('server.restart'), 3)


class OutboxTest(unittest.TestCase):
    """The Discord outbox on a fake clock, with a scripted discord() in place of the network."""

    def setUp(self):
        self.now = epoch('2026-09-27 00:37:00')
        self.sent, self.script = [], []
        for p in (mock.patch.object(dm.time, 'time', lambda: self.now),
                  mock.patch.object(dm.time, 'sleep', lambda s: None),
                  mock.patch.object(dm, 'CHANNEL', 'chan'), mock.patch.object(dm, 'BUG_FORUM', 'forum'),
                  mock.patch.object(dm, 'discord', self.discord),
                  mock.patch.object(dm.urllib.request, 'urlopen', side_effect=AssertionError('network use in a test'))):
            p.start(); self.addCleanup(p.stop)
        self.box = dm.Outbox()
        p = mock.patch.object(dm, 'OUTBOX', self.box)
        p.start(); self.addCleanup(p.stop)

    def discord(self, path, body):
        r = self.script.pop(0) if self.script else 'ok'
        if r == 'ok':
            self.sent.append((path, body.get('content') or body['message']['content']))
        return r

    def drain(self):
        while not self.box.q.empty():
            self.box.keep(self.box.q.get_nowait())
        self.box.pump()

    def test_post_only_queues(self):
        dm.post('`00:37:00` **Server freeze:** x')
        self.assertEqual(self.sent, [], 'post() never touches the network itself')
        self.assertEqual(self.box.q.qsize(), 1)

    def test_failed_post_is_kept_retried_and_marked_late(self):
        self.script = ['retry']
        dm.post('`00:37:00` **Server freeze:** x')
        dm.post('`00:38:00` **Server under pressure:** y')
        self.drain()
        self.assertEqual(self.sent, [])
        self.assertEqual(len(self.box.kept), 2)
        self.now += 10
        self.box.pump()
        self.assertEqual(self.sent, [], 'no retry before RETRY_S')
        self.now += dm.RETRY_S
        self.box.pump()
        self.assertEqual([c for _, c in self.sent], ['`00:37:00` **Server freeze:** x', '`00:38:00` **Server under pressure:** y'])
        self.sent.clear()
        self.script = ['retry', 'retry', 'retry']    # Discord still down for the next 90 s
        dm.post('**Last 15 min:** server.freeze 1', digest=True)
        self.drain()
        for _ in range(3):
            self.now += dm.RETRY_S
            self.box.pump()
        self.assertEqual(self.sent, [('channels/chan/messages', '(delayed, raised 00:37:40) **Last 15 min:** server.freeze 1')])

    def test_refused_post_is_dropped_not_retried(self):
        self.script = ['refused']
        dm.post('a'); dm.post('b')
        self.drain()
        self.assertEqual([c for _, c in self.sent], ['b'])
        self.assertEqual(self.box.kept, [])

    def test_outbox_keeps_at_most_20_and_drops_digests_first(self):
        self.script = ['retry']
        dm.post('first alert')
        dm.post('**Last 15 min:** d', digest=True)
        for i in range(20):
            dm.post(f'alert {i}')
        self.drain()
        texts = [m['text'] for m in self.box.kept]
        self.assertEqual(len(texts), dm.OUTBOX_MAX)
        self.assertNotIn('**Last 15 min:** d', texts)
        self.assertNotIn('first alert', texts, 'with no digest left the oldest goes')
        self.assertEqual(texts[-1], 'alert 19')

    def test_bug_report_goes_to_the_forum_or_falls_back_to_the_channel(self):
        dm.post_bug('Ann: wolf floats', 'Bug report body', 'fallback text')
        self.drain()
        self.assertEqual(self.sent, [('channels/forum/threads', 'Bug report body')])
        self.sent.clear()
        self.script = ['refused']
        dm.post_bug('Ann: wolf floats', 'Bug report body', 'fallback text')
        self.drain()
        self.assertEqual(self.sent, [('channels/chan/messages', 'fallback text')])

    def test_thread_sends_while_the_caller_moves_on(self):
        release, done = threading.Event(), threading.Event()
        def slow(path, body):    # Discord hanging, as the post raised at 00:52 on 2026-09-27 did for minutes
            release.wait(5)
            self.sent.append(body['content']); done.set()
            return 'ok'
        with mock.patch.object(dm, 'discord', slow):
            self.box.start()
            t0 = time.monotonic()
            dm.post('`00:37:00` **Server freeze:** x')
            self.assertLess(time.monotonic() - t0, 0.5)
            release.set()
            self.assertTrue(done.wait(5))
        self.assertEqual(self.sent, ['`00:37:00` **Server freeze:** x'])

    def test_test_mode_channel_posts_nothing(self):
        with mock.patch.object(dm, 'CHANNEL', ''):
            dm.post('x'); dm.post_bug('t', 'c', 'f')
        self.assertTrue(self.box.q.empty())


if __name__ == '__main__':
    unittest.main(verbosity=2)
