#!/usr/bin/env python3
"""dbo_backup.py against a fake state and server dir in a temp folder (never the live paths).
    python3 tools/backups/test_dbo_backup.py
Checks: a snapshot verifies and restores; a record the save thread renames over right after the hard-link pass keeps
the linked (older) version in the snapshot; a gameplay file being rewritten in place is retried, never archived torn;
a torn world record refuses the snapshot; restore refuses live paths and non-empty targets; the settings file with the
bot token is left out; prune keeps the newest and the retention plan."""
import datetime, importlib.util, json, os, subprocess, sys, tempfile, threading, time

here = os.path.dirname(os.path.abspath(__file__))
tmp = tempfile.mkdtemp(prefix='claude-nate-dbobackup-')
state, server, out = (os.path.join(tmp, d) for d in ('state', 'server', 'out'))
os.environ.update(DBO_STATE=state, DBO_SERVER=server, DBO_BACKUP_OUT=out)
spec = importlib.util.spec_from_file_location('dbo_backup', os.path.join(here, 'dbo_backup.py'))
B = importlib.util.module_from_spec(spec); spec.loader.exec_module(B)

fails = 0
def ok(cond, what):
    global fails
    print(('PASS ' if cond else 'FAIL ') + what)
    fails += 0 if cond else 1

cf = os.path.join(state, 'world', 'changeForms')
os.makedirs(cf); os.makedirs(server)
def record(i, gold):
    return json.dumps({'formDesc': f'{i:x}', 'recType': 1, 'inv': {'entries': [{'baseId': 15, 'count': gold}]}})
for i in range(200):
    open(os.path.join(cf, f'{i}.json'), 'w').write(record(i, 100))
open(os.path.join(cf, '7.json.tmp'), 'w').write('{"half')          # the save thread mid-write
open(os.path.join(state, 'zone-spawns.json'), 'w').write('[]')
open(os.path.join(server, 'bank.json'), 'w').write(json.dumps({'accounts': {'1': 500}}))
open(os.path.join(server, 'server-settings.json'), 'w').write('{"discordAuth": {"botToken": "SECRET"}}')

# 1. a plain snapshot
a = B.snapshot(out)
m = B.verify(a, quiet=True)
ok(m['records'] == 200, 'a snapshot holds every world record, and the .tmp is left out')
ok('bank.json' in m['gameplayFiles'] and 'server-settings.json' not in m['gameplayFiles'], 'gameplay state is in; the settings with the bot token are not')

# 1b. the Character Journal's files, and the ones moved aside, come along; strays in the folder do not
jd = os.path.join(server, 'journal')
os.makedirs(os.path.join(jd, 'removed'))
open(os.path.join(jd, '0123456789abcdef.json'), 'w').write(json.dumps({'v': 1, 'downs': 2}))
open(os.path.join(jd, 'removed', 'fedcba9876543210.json'), 'w').write(json.dumps({'v': 1}))
open(os.path.join(jd, '0123456789abcdef.json.tmp'), 'w').write('{"half')
a2 = B.snapshot(out)
m2 = B.verify(a2, quiet=True)
ok('journal/0123456789abcdef.json' in m2['gameplayFiles'] and 'journal/removed/fedcba9876543210.json' in m2['gameplayFiles']
   and not any(g.endswith('.tmp') for g in m2['gameplayFiles']), "the journal's files are in, the .tmp is not")
os.remove(a2); os.remove(a2[:-len('.tar.gz')] + '.manifest.json')
# 1c. a journal file that does not parse does not stop the world backup; it is kept raw and listed
open(os.path.join(jd, '1111111111111111.json'), 'w').write('{"torn')
a3 = B.snapshot(out)
m3 = B.verify(a3, quiet=True)
ok(m3['records'] == 200 and m3['badJournal'] == ['journal/1111111111111111.json'] and 'journal/0123456789abcdef.json' in m3['gameplayFiles'],
   'a journal file that does not parse is kept as it is and listed as badJournal; the snapshot still verifies')
os.remove(a3); os.remove(a3[:-len('.tar.gz')] + '.manifest.json'); os.remove(os.path.join(jd, '1111111111111111.json'))
# 1d. a journal file moved aside between the listing and the read is skipped
real_open = open
def vanishing_open(p, *args, **kw):
    if str(p).endswith('0123456789abcdef.json') and os.sep + 'journal' + os.sep in str(p) and 'stage' not in str(p) and str(p).startswith(server):
        raise FileNotFoundError(p)
    return real_open(p, *args, **kw)
B.open = vanishing_open
try:
    a4 = B.snapshot(out)
finally:
    del B.open
m4 = B.verify(a4, quiet=True)
ok('journal/0123456789abcdef.json' not in m4['gameplayFiles'] and m4['records'] == 200, 'a journal file that vanishes mid-snapshot is skipped, and the snapshot is kept')
os.remove(a4); os.remove(a4[:-len('.tar.gz')] + '.manifest.json')

# 2. a record renamed over right after the link pass keeps the version at link time
real_run = subprocess.run
def run_then_save(cmd, **kw):
    r = real_run(cmd, **kw)
    if cmd[:2] == ['cp', '-al']:
        p = os.path.join(cf, '5.json'); t = p + '.tmp'
        open(t, 'w').write(record(5, 999)); os.rename(t, p)      # exactly as FileDatabase::UpsertImpl writes
    return r
B.subprocess.run = run_then_save
b = B.snapshot(out)
B.subprocess.run = real_run
sb = os.path.join(tmp, 'sb1'); B.restore(b, sb)
got = json.load(open(os.path.join(sb, 'state', 'world', 'changeForms', '5.json')))['inv']['entries'][0]['count']
ok(got == 100, f'a record saved after the link pass keeps its linked version in the snapshot (got {got})')
ok(json.load(open(os.path.join(cf, '5.json')))['inv']['entries'][0]['count'] == 999, '...and the live record is untouched')

# 3. a gameplay file rewritten in place while copied: retried, never archived torn
stop = threading.Event()
def writer():
    p = os.path.join(server, 'bank.json'); n = 0
    while not stop.is_set():
        with open(p, 'w') as fh:                          # in place, like writeFileSync
            fh.write('{"accounts": {'); fh.flush(); time.sleep(0.01)
            fh.write(f'"1": {n}' + '}}')
        n += 1; time.sleep(0.12)
t = threading.Thread(target=writer); t.start()
try:
    c = B.snapshot(out); torn = False
except RuntimeError:
    c = None; torn = True
stop.set(); t.join()
if c:
    sb2 = os.path.join(tmp, 'sb2'); B.restore(c, sb2)
    json.load(open(os.path.join(sb2, 'server', 'bank.json')))
    ok(True, 'a gameplay file rewritten in place during the copy is archived whole (retried until stable)')
else:
    ok(torn, 'a gameplay file that never settles refuses the snapshot instead of archiving it torn')

# 4. a torn world record refuses the snapshot
open(os.path.join(cf, '9.json'), 'w').write('{"formDesc": "9", "recT')
try:
    B.snapshot(out); refused = False
except RuntimeError:
    refused = True
ok(refused, 'a world record that does not parse refuses the snapshot')
open(os.path.join(cf, '9.json'), 'w').write(record(9, 100))

# 5. restore refuses live paths and a non-empty target
for target in (state, cf, server):
    try:
        B.restore(a, target); r = False
    except SystemExit:
        r = True
    ok(r, f'restore refuses {os.path.relpath(target, tmp)}')
try:
    B.restore(a, sb); r = False
except SystemExit:
    r = True
ok(r, 'restore refuses a target that is not empty')

# 6. prune: the newest always stays; hourly for 48 h, one a day for 30 days, one a month for a year
now = datetime.datetime.now(datetime.timezone.utc)
pd = os.path.join(tmp, 'prune'); os.makedirs(pd)
def touch(hours_ago):
    t = now - datetime.timedelta(hours=hours_ago)
    open(os.path.join(pd, f'world-{t:%Y%m%dT%H%M%SZ}.tar.gz'), 'w').write('x')
for h in range(0, 24 * 60, 1):
    touch(h)
B.prune(pd, apply=True)
left = sorted(os.listdir(pd))
ok(48 <= len(left) <= 48 + 31 + 3, f'prune keeps 48 hourly, about 30 daily and the months ({len(left)} left of {24 * 60})')
ok(any(f'{now:%Y%m%d}' in n for n in left), 'the newest snapshot survives')

print('all checks passed' if not fails else f'{fails} FAILED')
subprocess.run(['rm', '-rf', tmp])
sys.exit(1 if fails else 0)
