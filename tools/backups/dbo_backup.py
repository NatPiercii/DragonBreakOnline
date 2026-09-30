#!/usr/bin/env python3
"""DragonBreak world backups: consistent snapshots of the live world, verification, sandbox restore, a retention
plan, a report on /opt/skymp-backups, and a disk check. Standard library only; run as root (the state is root-owned).

    dbo_backup.py snapshot [--out DIR]          one snapshot -> DIR/world-<UTC stamp>.tar.gz (+ .manifest.json)
    dbo_backup.py verify <tar.gz|dir>           every world record and gameplay file parses; counts match the manifest
    dbo_backup.py restore <tar.gz> <target>     extract into an EMPTY sandbox dir and verify (refuses live paths)
    dbo_backup.py prune [--out DIR] [--apply]   world snapshots past the retention plan (dry run unless --apply)
    dbo_backup.py report [--root DIR]           /opt/skymp-backups by kind, and what dedupe/compress/keep-N would free
    dbo_backup.py disk [--warn 90 --crit 95]    exit 1 at warn, 2 at crit; logs through `logger`

How the world is kept (fork skymp5-server/cpp/server_guest_lib/database_drivers/FileDatabase.cpp, databaseDriver
"file"): one JSON file per change form in <state>/world/changeForms, written by the save thread as <name>.json.tmp and
then renamed over <name>.json. A reader therefore always sees a whole file, old or new, but never a torn one; the
files are not one transaction, so any copy can hold form A after a change and form B before it, exactly as a crash at
that moment would. The snapshot keeps that window as small as possible: `cp -al` hard-links every record into a
staging directory in well under a second (the server's rename replaces its own directory entry and leaves the
linked inode, the version at link time, untouched), and the archive is written from the links at leisure.

The gameplay layer's own state (bank.json, businesses.json, tenancy.json, housing.json, dungeon-cooldowns.json and
the rest, beside dbo-gamemode.js) is written by Node, some of it in place with writeFileSync, so a hard link could
change under us: those files are copied, parsed, and copied again until two copies agree and parse (3 tries).
server-settings*.json hold the Discord bot token and are left out on purpose (the updater snapshots settings).
"""
import argparse, datetime, gzip, hashlib, io, json, os, re, shutil, subprocess, sys, tarfile, tempfile, time

STATE = os.environ.get('DBO_STATE', '/opt/skymp-state')
SERVER = os.environ.get('DBO_SERVER', '/opt/alduinak/build/dist/server')
OUT = os.environ.get('DBO_BACKUP_OUT', '/opt/skymp-backups/world')
SECRET = re.compile(r'^server-settings.*\.json$')
JOURNAL = re.compile(r'^[0-9a-f]{16}\.json$')
# Retention for world snapshots only (this script's own files): every snapshot for 48 h, then the first of each day
# for 30 days, then the first of each month for a year. Pruning runs only with --apply (see README: ops rule 9).
KEEP_ALL_HOURS, KEEP_DAILY_DAYS, KEEP_MONTHLY_DAYS = 48, 30, 365
NAME = re.compile(r'^world-(\d{8}T\d{6}Z)\.tar\.gz$')


def log(msg):
    print(msg, flush=True)


def stable_copy(src, dst, tries=3):
    """Copy a file Node may be rewriting in place; returns the parsed JSON (or raises)."""
    last = None
    for _ in range(tries):
        a = open(src, 'rb').read()
        time.sleep(0.05)
        b = open(src, 'rb').read()
        if a == b:
            try:
                parsed = json.loads(a.decode('utf-8-sig')) if a.strip() else None
            except ValueError as e:
                last = e
                time.sleep(0.2)
                continue
            with open(dst, 'wb') as fh:
                fh.write(a)
            shutil.copystat(src, dst)
            return parsed
        last = RuntimeError('changed while copying')
        time.sleep(0.2)
    raise RuntimeError(f'{src}: no stable, parseable copy after {tries} tries ({last})')


def check_record(path):
    with open(path, 'rb') as fh:
        d = json.loads(fh.read().decode('utf-8'))
    if not isinstance(d, dict) or 'formDesc' not in d or 'recType' not in d:
        raise ValueError('not a change form (no formDesc/recType)')
    return d


def snapshot(out):
    os.makedirs(out, exist_ok=True)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    stage = tempfile.mkdtemp(prefix=f'.staging-{stamp}-', dir=out)
    try:
        t0 = time.time()
        os.makedirs(os.path.join(stage, 'state'))
        # 1. world records: hard links, near point-in-time; *.tmp are the save thread's half-written files
        subprocess.run(['cp', '-al', os.path.join(STATE, 'world'), os.path.join(stage, 'state', 'world')], check=True)
        link_ms = (time.time() - t0) * 1000
        cf = os.path.join(stage, 'state', 'world', 'changeForms')
        for n in os.listdir(cf):
            if not n.endswith('.json'):
                os.unlink(os.path.join(cf, n))
        # 2. other files in the state dir (companions.json, zone-spawns.json)
        for n in sorted(os.listdir(STATE)):
            p = os.path.join(STATE, n)
            if os.path.isfile(p) and n.endswith('.json'):
                stable_copy(p, os.path.join(stage, 'state', n))
        # 3. the gameplay layer's files beside dbo-gamemode.js (every top-level *.json but the settings)
        os.makedirs(os.path.join(stage, 'server'))
        gameplay = []
        for n in sorted(os.listdir(SERVER)):
            p = os.path.join(SERVER, n)
            if n.endswith('.json') and not SECRET.match(n) and os.path.isfile(p) and not os.path.islink(p):
                stable_copy(p, os.path.join(stage, 'server', n))
                gameplay.append(n)
        # 3b. the Character Journal's files (journalstats.js), journal/<key>.json and journal/removed/<key>.json. Node
        # replaces each one whole by rename, never in place, so one read that parses is a whole file
        for sub in ('journal', os.path.join('journal', 'removed')):
            src_dir = os.path.join(SERVER, sub)
            if not os.path.isdir(src_dir) or os.path.islink(src_dir):
                continue
            os.makedirs(os.path.join(stage, 'server', sub), exist_ok=True)
            for n in sorted(os.listdir(src_dir)):
                p = os.path.join(src_dir, n)
                if JOURNAL.match(n) and os.path.isfile(p) and not os.path.islink(p):
                    data = open(p, 'rb').read()
                    json.loads(data.decode('utf-8'))
                    with open(os.path.join(stage, 'server', sub, n), 'wb') as fh:
                        fh.write(data)
                    gameplay.append(os.path.join(sub, n))
        # 4. check every record and write the manifest
        records, bad = 0, []
        digests = {}
        for n in sorted(os.listdir(cf)):
            p = os.path.join(cf, n)
            try:
                check_record(p)
                records += 1
                digests['state/world/changeForms/' + n] = hashlib.sha256(open(p, 'rb').read()).hexdigest()
            except Exception as e:
                bad.append(f'{n}: {e}')
        if bad:
            raise RuntimeError(f'{len(bad)} world record(s) failed to parse, snapshot refused: {bad[:5]}')
        manifest = {'stamp': stamp, 'linkMs': round(link_ms, 1), 'records': records, 'gameplayFiles': gameplay,
                    'stateFiles': sorted(n for n in os.listdir(os.path.join(stage, 'state')) if n.endswith('.json')),
                    'sha256': digests}
        with open(os.path.join(stage, 'MANIFEST.json'), 'w') as fh:
            json.dump(manifest, fh, indent=1)
        # 5. archive, then check the archive itself before it gets its final name
        final = os.path.join(out, f'world-{stamp}.tar.gz')
        part = final + '.part'
        with tarfile.open(part, 'w:gz', compresslevel=6) as tar:
            for n in ('MANIFEST.json', 'state', 'server'):
                tar.add(os.path.join(stage, n), arcname=n)
        verify(part, quiet=True)
        os.rename(part, final)
        os.chmod(final, 0o600)
        with open(final[:-len('.tar.gz')] + '.manifest.json', 'w') as fh:
            json.dump({k: v for k, v in manifest.items() if k != 'sha256'}, fh, indent=1)
        log(f'snapshot {final}: {records} world records (linked in {link_ms:.0f} ms), {len(gameplay)} gameplay files, '
            f'{os.path.getsize(final) / 1e6:.1f} MB')
        return final
    finally:
        shutil.rmtree(stage, ignore_errors=True)   # the staging links only; the live state is never touched


def _members(src):
    """(name, bytes) for every file in a snapshot archive or directory."""
    if os.path.isdir(src):
        for dp, _, fn in os.walk(src):
            for f in fn:
                p = os.path.join(dp, f)
                yield os.path.relpath(p, src), open(p, 'rb').read()
    else:
        with tarfile.open(src, 'r:gz') as tar:
            for m in tar:
                if m.isfile():
                    yield m.name.lstrip('./'), tar.extractfile(m).read()


def verify(src, quiet=False):
    files = dict(_members(src))
    if 'MANIFEST.json' not in files:
        raise RuntimeError(f'{src}: no MANIFEST.json')
    man = json.loads(files['MANIFEST.json'])
    records, bad = 0, []
    for name, data in files.items():
        if name.startswith('state/world/changeForms/'):
            try:
                d = json.loads(data.decode('utf-8'))
                if 'formDesc' not in d or 'recType' not in d:
                    raise ValueError('not a change form')
                if hashlib.sha256(data).hexdigest() != man['sha256'].get(name):
                    raise ValueError('checksum differs from the manifest')
                records += 1
            except Exception as e:
                bad.append(f'{name}: {e}')
        elif name.endswith('.json') and name != 'MANIFEST.json':
            try:
                if data.strip():
                    json.loads(data.decode('utf-8-sig'))
            except Exception as e:
                bad.append(f'{name}: {e}')
    if records != man['records']:
        bad.append(f'{records} world records, manifest says {man["records"]}')
    missing = [g for g in man['gameplayFiles'] if f'server/{g}' not in files]
    if missing:
        bad.append(f'gameplay files missing: {missing}')
    if bad:
        raise RuntimeError(f'{src}: {len(bad)} problem(s): {bad[:8]}')
    if not quiet:
        log(f'verify {src}: OK, {records} world records, {len(man["gameplayFiles"])} gameplay files, '
            f'{len(man["stateFiles"])} state files')
    return man


def restore(src, target):
    target = os.path.realpath(target)
    live = [os.path.realpath(p) for p in (STATE, SERVER, os.path.join(SERVER, 'world'))]
    if any(target == p or target.startswith(p + os.sep) or p.startswith(target + os.sep) for p in live):
        raise SystemExit(f'refused: {target} is or holds the live state; restore into a sandbox directory')
    if os.path.exists(target) and os.listdir(target):
        raise SystemExit(f'refused: {target} is not empty')
    man = verify(src, quiet=True)
    os.makedirs(target, exist_ok=True)
    with tarfile.open(src, 'r:gz') as tar:
        tar.extractall(target, filter='data') if sys.version_info >= (3, 12) else tar.extractall(target)
    verify(target)
    log(f'restore {src} -> {target}: {man["records"]} world records. For the live server see README "Restoring live".')


def prune(out, apply=False):
    now = datetime.datetime.now(datetime.timezone.utc)
    snaps = []
    for n in os.listdir(out):
        m = NAME.match(n)
        if m:
            snaps.append((datetime.datetime.strptime(m.group(1), '%Y%m%dT%H%M%SZ').replace(tzinfo=datetime.timezone.utc), n))
    snaps.sort()
    keep, seen_day, seen_month = set(), set(), set()
    for t, n in snaps:
        age = (now - t).total_seconds() / 3600
        if age <= KEEP_ALL_HOURS:
            keep.add(n)
        elif age <= KEEP_DAILY_DAYS * 24 and t.date() not in seen_day:
            keep.add(n); seen_day.add(t.date())
        elif age <= KEEP_MONTHLY_DAYS * 24 and (t.year, t.month) not in seen_month:
            keep.add(n); seen_month.add((t.year, t.month))
    if snaps:
        keep.add(snaps[-1][1])   # never the newest
    drop = [n for _, n in snaps if n not in keep]
    freed = sum(os.path.getsize(os.path.join(out, n)) for n in drop)
    log(f'prune {out}: {len(snaps)} snapshots, keep {len(keep)}, {"removing" if apply else "would remove"} {len(drop)} '
        f'({freed / 1e6:.1f} MB)')
    for n in drop:
        log(f'  {n}')
        if apply:
            os.unlink(os.path.join(out, n))
            mf = os.path.join(out, n[:-len('.tar.gz')] + '.manifest.json')
            if os.path.exists(mf):
                os.unlink(mf)


def report(root):
    kinds = {}
    ino_seen = {}
    dup_bytes = 0
    for n in sorted(os.listdir(root)):
        p = os.path.join(root, n)
        size, text = 0, 0
        for dp, _, fn in (os.walk(p) if os.path.isdir(p) else [(root, None, [n])]):
            for f in fn:
                q = os.path.join(dp, f)
                try:
                    st = os.lstat(q)
                except OSError:
                    continue
                size += st.st_size
                if q.endswith(('.json', '.js', '.log', '.txt', '.md')):
                    text += st.st_size
        k = re.sub(r'[-_]?\d{8}T?\d{0,6}Z?.*$', '', n)
        k = re.sub(r'\d+\.\d+\.\d+.*$', 'X', k)
        k = 'release bundles' if k.startswith('release') else k
        kinds.setdefault(k, []).append((os.path.getmtime(p), size, text, n))
    total = sum(s for v in kinds.values() for _, s, _, _ in v)
    log(f'{root}: {total / 1e9:.2f} GB in {sum(len(v) for v in kinds.values())} entries')
    for k, v in sorted(kinds.items(), key=lambda kv: -sum(x[1] for x in kv[1])):
        v.sort(reverse=True)
        s = sum(x[1] for x in v)
        beyond5 = sum(x[1] for x in v[5:])
        compressible = sum(x[2] for x in v)
        log(f'  {s / 1e9:6.2f} GB  {len(v):4d}  {k:28s} older than the newest 5: {beyond5 / 1e9:5.2f} GB; text {compressible / 1e9:5.2f} GB')


def disk(warn, crit, path='/'):
    st = os.statvfs(path)
    used = 100 * (1 - st.f_bavail / st.f_blocks)
    level = 2 if used >= crit else 1 if used >= warn else 0
    msg = f'DragonBreak disk {path}: {used:.1f}% used, {st.f_bavail * st.f_frsize / 1e9:.1f} GB free'
    if level:
        subprocess.run(['logger', '-t', 'dbo-disk', '-p', 'user.crit' if level == 2 else 'user.warning', msg])
    log(msg)
    return level


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)
    s = sub.add_parser('snapshot'); s.add_argument('--out', default=OUT)
    v = sub.add_parser('verify'); v.add_argument('src')
    r = sub.add_parser('restore'); r.add_argument('src'); r.add_argument('target')
    p = sub.add_parser('prune'); p.add_argument('--out', default=OUT); p.add_argument('--apply', action='store_true')
    rp = sub.add_parser('report'); rp.add_argument('--root', default='/opt/skymp-backups')
    d = sub.add_parser('disk'); d.add_argument('--warn', type=float, default=90); d.add_argument('--crit', type=float, default=95)
    a = ap.parse_args()
    if a.cmd == 'snapshot':
        snapshot(a.out)
    elif a.cmd == 'verify':
        verify(a.src)
    elif a.cmd == 'restore':
        restore(a.src, a.target)
    elif a.cmd == 'prune':
        prune(a.out, a.apply)
    elif a.cmd == 'report':
        report(a.root)
    elif a.cmd == 'disk':
        sys.exit(disk(a.warn, a.crit))


if __name__ == '__main__':
    main()
