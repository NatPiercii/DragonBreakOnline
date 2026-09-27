#!/usr/bin/env python3
"""Offline tests for dbo_monitor's freeze and pressure alerts: no network, no systemd, no real state dir or /proc.

Run: python3 tooling/dbo-monitor/test_dbo_monitor.py
The stall samples are the real tick summaries from /var/log/skymp-server.log on 2026-09-27 (00:33-02:11Z freeze).
"""
import calendar, os, sys, tempfile, time, unittest, warnings
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


# Real readings on CT 115, 2026-09-27 02:34Z: /proc/pressure/io, and the container root cgroup (memory.max is 'max')
REAL_PSI_IO = 'some avg10=0.97 avg60=3.45 avg300=4.62 total=21872940245\nfull avg10=0.70 avg60=3.28 avg300=4.47 total=21231469191\n'
REAL_CURRENT, REAL_INACTIVE_FILE, REAL_MEMTOTAL_KB = 8138911744, 3550515200, 16777216
REAL_PEAK = 17051009024    # memory.peak: what the runaway dev test reached during the stall
MB = 1048576


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
        self.active = True
        self.cause = ('', '')
        for target, value in [
            ('STATE_DIR', self.tmp), ('STATE', os.path.join(self.tmp, 'state.json')), ('CHANNEL', ''),
            ('post', self.posts.append), ('post_thread', lambda *a: False), ('token', lambda: ''),
            ('skymp_active', lambda: self.active),
            ('PSI_IO', self.path('proc/pressure/io')), ('PSI_MEM', self.path('proc/pressure/memory')),
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
        for rel, v in (('proc/pressure/io', io), ('proc/pressure/memory', mem), ('cg/memory.current', current),
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
        m = dm.loop_re.search(REAL_STALL_LINE)
        self.assertEqual(m.groups(), ('1', '12968.8', '12968.8'))

    def test_real_stall_alerts_once_repeats_every_15_min_and_recovers(self):
        self.start('2026-09-27 00:30:00')
        for ts, online, p99, mx in STALL[:4]:
            self.feed(ts, tick_line(ts, online, p99, mx) if p99 != 12968.8 else REAL_STALL_LINE)
        self.assertEqual(self.alerts(), [], 'one sample over 2000 ms is not yet a freeze')
        self.run_until(epoch('2026-09-27 00:37:57'))
        first = self.alerts('freeze')
        self.assertEqual(len(first), 1)
        self.assertIn('no tick summary for 3 min while skymp.service is active', first[0])
        self.assertIn('p99 12969 ms, max 12969 ms at 00:33:57', first[0])
        self.assertEqual(self.mon.win['counts'].get('server.freeze'), 1)
        for ts, online, p99, mx in STALL[4:]:
            self.feed(ts, tick_line(ts, online, p99, mx))
        freeze = self.alerts('freeze')
        # opened ~00:37, repeated at 15, 30, 45, 60, 75 min, then the loop came back before the 90 min repeat
        self.assertEqual(len(freeze), 6, freeze)
        self.assertIn('(still going, 75 min)', freeze[-1])
        rec = self.alerts('recovered')
        self.assertEqual(len(rec), 1, 'the 0.0/0.0 summary at 02:06:57 is no data, the 194.9 ms one at 02:07:57 recovers')
        self.assertTrue(rec[0].startswith('`02:07:57` Server recovered: event loop p99 195 ms (max 3737 ms)'), rec[0])
        self.assertEqual(self.mon.incidents, {})
        self.assertEqual(len(self.alerts()), 7, 'p99 1836 ms at 02:10:00 is under the 2000 ms line: no new alert')

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


class PressureTest(MonitorCase):
    def setUp(self):
        super().setUp()
        self.active = False    # no game server here, so no tick summaries and no freeze alerts

    def test_readers_on_real_numbers(self):
        self.assertEqual(dm.psi_full60(self.path('proc/pressure/io')), 3.28, 'full, not some')
        self.assertIsNone(dm.psi_full60(self.path('proc/pressure/missing')))
        self.assertEqual(dm.mem_use(), (REAL_CURRENT - REAL_INACTIVE_FILE, REAL_MEMTOTAL_KB * 1024), 'max -> MemTotal')
        self.write('cg/memory.max', 12884901888)
        self.assertEqual(dm.mem_use()[1], 12884901888)
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

    def test_page_cache_is_not_memory_in_use(self):
        self.start('2026-09-27 00:30:00')
        self.fake_system(current=16500 * MB, inactive=6000 * MB)
        self.run_until(epoch('2026-09-27 00:40:00'))
        self.assertEqual(self.alerts(), [])

    def test_unreadable_files_raise_nothing(self):
        self.start('2026-09-27 00:30:00')
        for rel in ('proc/pressure/io', 'proc/pressure/memory', 'cg/memory.current'):
            os.remove(self.path(rel))
        self.run_until(epoch('2026-09-27 00:40:00'))
        self.assertEqual(self.alerts(), [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
