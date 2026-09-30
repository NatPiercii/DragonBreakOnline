#!/usr/bin/env python3
"""Boot test for a world backup: does the game server actually start from a restored world? The restore test proved
the bytes (every record parses, counts match); this boots the real server bundle and gamemode on them.

    sudo python3 tools/backups/boot_test.py [--backup /opt/skymp-backups/world/world-<stamp>.tar.gz] [--seconds 120]
        [--max-players 2] [--keep]

What it does, and why it cannot touch the live server:
  1. Refuses unless https://dragonbreakonline.com/api/servers shows at most --max-players online, and checks again
     every 20 s while the sandbox runs (a busy server stops the sandbox, not the other way round).
  2. Restores the newest (or the given) world-*.tar.gz with dbo_backup.py restore into /tmp/claude-nate-boot-<stamp>/
     restore (dbo_backup refuses live paths), copies the server dist beside it, and replaces the dist's three symlinks
     into /opt/skymp-state (world, companions.json, zone-spawns.json) with the restored copies, and its gameplay JSON
     with the backup's. /opt is only read.
  3. Writes the sandbox's own server-settings.json from the live one in memory: no master, masterKey, API tokens,
     Discord auth, voice or metrics credentials; offlineMode on; port 17777 bound to 127.0.0.1; its own name. Any
     remaining string that looks like a URL or a token is refused. The gamemode-config gets its Discord, roles,
     tickets and updater sections switched off and debugsnap/monitor pointed into the sandbox.
  4. Runs node as the unprivileged user nate (no write access to anything root-owned: /opt, /var/lib/dbo-monitor,
     /var/log), inside a private network namespace with only its own loopback (no DNS, no route out, no reach to the
     live backend on 127.0.0.1:4000 either), in a transient systemd scope capped at 50% of one CPU and 3 GB, at nice
     19 and idle I/O priority, and stops it after --seconds (SIGINT, SIGKILL 15 s later).
  5. Passes only if the log shows the world load ("loaded N ChangeForms (Including M player characters)") with N and
     M equal to what the restored records say, "[gamemode] loaded:", and no crash: the process must still be running
     when the timer stops it. Then the sandbox is removed (--keep leaves it) and a summary is printed.
"""
import argparse, glob, json, os, pwd, re, shutil, subprocess, sys, tempfile, threading, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DIST = os.environ.get('DBO_SERVER', '/opt/alduinak/build/dist/server')
STATE = os.environ.get('DBO_STATE', '/opt/skymp-state')
BACKUPS = os.environ.get('DBO_BACKUP_OUT', '/opt/skymp-backups/world')
# The backend on this box first (the public URL sits behind Cloudflare, which refuses Python's default client)
SERVERS_API = ('http://127.0.0.1:4000/api/servers', 'https://dragonbreakonline.com/api/servers')
RUN_AS = 'nate'
PORT = 17777
# Settings keys that reach the network or hold a credential: never copied into the sandbox
DROP_KEYS = {'master', 'masterKey', 'masterApiAuthToken', 'discordAuth', 'voiceChat', 'metricsAuth', 'listenHost'}
LOOKS_SECRET = re.compile(r'https?://|wss?://|^[A-Za-z0-9_\-.]{40,}$')


def log(msg):
    print(msg, flush=True)


def players_online():
    last = None
    for url in SERVERS_API:
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'curl/8 dbo-boot-test'})
            with urllib.request.urlopen(req, timeout=10) as r:
                return sum(int(s.get('online') or 0) for s in json.load(r))
        except Exception as e:
            last = e
    raise RuntimeError(f'no player count from {", ".join(SERVERS_API)}: {last}')


def sanitize_settings(live):
    s = {k: v for k, v in live.items() if k not in DROP_KEYS}
    s.update({'offlineMode': True, 'port': PORT, 'listenHost': '127.0.0.1', 'name': 'DBO boot test (sandbox)', 'maxPlayers': 2})
    bad = []

    def scan(o, path):
        if isinstance(o, dict):
            for k, v in o.items():
                scan(v, f'{path}.{k}')
        elif isinstance(o, list):
            for i, v in enumerate(o):
                scan(v, f'{path}[{i}]')
        elif isinstance(o, str) and LOOKS_SECRET.search(o):
            bad.append(path)
    scan(s, 'settings')
    if bad:
        raise SystemExit(f'refused: sandbox settings still hold URL- or token-like strings at {", ".join(bad)}')
    return s


def sandbox_gamemode_config(path, box):
    cfg = json.load(open(path, encoding='utf-8'))
    cfg['discord'] = {}
    cfg['discordRoles'] = dict(cfg.get('discordRoles') or {}, enabled=False)
    cfg['tickets'] = dict(cfg.get('tickets') or {}, enabled=False)
    cfg['updates'] = dict(cfg.get('updates') or {}, enabled=False)
    os.makedirs(os.path.join(box, 'monitor'), exist_ok=True)
    cfg['debugSnap'] = dict(cfg.get('debugSnap') or {}, dir=os.path.join(box, 'monitor'), logFile=os.path.join(box, 'boot.log'))
    cfg['monitor'] = dict(cfg.get('monitor') or {}, stateFile=os.path.join(box, 'monitor', 'state.json'))
    json.dump(cfg, open(path, 'w', encoding='utf-8'), indent=1, ensure_ascii=False)


def expected_counts(world):
    """What the restored records say the server should load: live change forms and player characters"""
    forms = chars = deleted = 0
    for f in glob.glob(os.path.join(world, 'changeForms', '*.json')):
        d = json.load(open(f, encoding='utf-8'))
        if d.get('isDeleted') is True:
            deleted += 1
            continue
        forms += 1
        if int(d.get('profileId', -1)) >= 0:
            chars += 1
    return forms, chars, deleted


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--backup', help='a world-*.tar.gz (default: the newest in %s)' % BACKUPS)
    ap.add_argument('--seconds', type=int, default=120)
    ap.add_argument('--max-players', type=int, default=2)
    ap.add_argument('--keep', action='store_true', help='leave the sandbox folder for inspection')
    a = ap.parse_args()
    if os.geteuid() != 0:
        raise SystemExit('run with sudo: the backups and the dist are root-owned, and the network namespace needs root')

    try:
        online = players_online()
    except RuntimeError as e:
        raise SystemExit(f'refused: {e}')
    if online > a.max_players:
        raise SystemExit(f'refused: {online} player(s) online on the live server (limit {a.max_players}); try when it is quieter')
    backup = a.backup or max(glob.glob(os.path.join(BACKUPS, 'world-*.tar.gz')), key=os.path.getmtime)
    stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
    box = tempfile.mkdtemp(prefix=f'claude-nate-boot-{stamp}-', dir='/tmp')
    os.chmod(box, 0o700)
    log(f'boot test {stamp}: backup {os.path.basename(backup)}, sandbox {box}, live players {online}')
    ok = False
    try:
        # 1. restore
        subprocess.run([sys.executable, os.path.join(HERE, 'dbo_backup.py'), 'restore', backup, os.path.join(box, 'restore')], check=True,
                       stdout=subprocess.DEVNULL)
        restored = os.path.join(box, 'restore')
        # 2. the dist, without its settings (they hold credentials) and without cores or logs
        server = os.path.join(box, 'server')
        shutil.copytree(DIST, server, symlinks=True, ignore=shutil.ignore_patterns('server-settings*', 'core.*', '*.log', 'C:*'))
        for name in os.listdir(server):
            p = os.path.join(server, name)
            if not os.path.islink(p):
                continue
            target = os.readlink(p)
            os.unlink(p)
            if target.startswith(STATE + os.sep):
                src = os.path.join(restored, 'state', os.path.relpath(target, STATE))
                if os.path.isdir(src):
                    shutil.copytree(src, p)
                elif os.path.exists(src):
                    shutil.copy2(src, p)
            else:
                raise SystemExit(f'refused: {name} in the dist links to {target}, outside the state the backup restores')
        for f in glob.glob(os.path.join(restored, 'server', '*')):
            shutil.copy2(f, os.path.join(server, os.path.basename(f)))
        live_settings = json.load(open(os.path.join(DIST, 'server-settings.json'), encoding='utf-8'))
        json.dump(sanitize_settings(live_settings), open(os.path.join(server, 'server-settings.json'), 'w'), indent=1)
        sandbox_gamemode_config(os.path.join(server, 'gamemode-config.json'), box)
        want_forms, want_chars, deleted = expected_counts(os.path.join(server, 'world'))
        user = pwd.getpwnam(RUN_AS)
        subprocess.run(['chown', '-R', f'{user.pw_uid}:{user.pw_gid}', box], check=True)
        log(f'restored: {want_forms} live change forms ({want_chars} player characters, {deleted} deleted) in the sandbox world')

        # 3. boot, isolated and capped
        out = open(os.path.join(box, 'boot.log'), 'wb')
        unit = f'claude-nate-boottest-{stamp.lower()}'
        inner = (f'ip link set lo up && exec setpriv --reuid={user.pw_uid} --regid={user.pw_gid} --init-groups -- '
                 f'prlimit --nofile=65535 -- nice -n 19 ionice -c3 timeout -k 15 -s INT {a.seconds} /usr/bin/node dist_back/skymp5-server.js')
        cmd = ['systemd-run', '--scope', '-q', f'--unit={unit}', '-p', 'CPUQuota=50%', '-p', 'MemoryMax=3G', '-p', 'IOWeight=10',
               '--', 'unshare', '--net', '--', 'sh', '-c', inner]
        started = time.time()
        proc = subprocess.Popen(cmd, cwd=server, stdout=out, stderr=subprocess.STDOUT)
        stop = {'why': ''}

        def watch():
            while proc.poll() is None:
                time.sleep(20)
                try:
                    n = players_online()
                except Exception as e:
                    n = None
                    log(f'  player check failed ({e}); carrying on')
                if n is not None and n > a.max_players and proc.poll() is None:
                    stop['why'] = f'{n} players came online'
                    subprocess.run(['systemctl', 'stop', f'{unit}.scope'], check=False)
                    return
        threading.Thread(target=watch, daemon=True).start()
        code = proc.wait()
        out.close()
        took = time.time() - started
        text = open(os.path.join(box, 'boot.log'), encoding='utf-8', errors='replace').read()

        # 4. judge
        m = re.search(r'AttachSaveStorage took .*?loaded (\d+) ChangeForms \(Including (\d+) player characters\)', text)
        got_forms, got_chars = (int(m.group(1)), int(m.group(2))) if m else (None, None)
        gm = re.search(r'\[gamemode\] loaded: .*', text)
        world_file = re.search(r"Using file with name '([^']+)'", text)
        path_line = re.search(r'Gamemode path is "([^"]+)"', text)
        errors = [l for l in text.splitlines() if re.search(r'Uncaught|FATAL|Segmentation|Aborted|terminate called', l)]
        # timeout exits 124 after its SIGINT, 137 if the SIGKILL 15 s later was needed; either way the server was up until then
        ran_full = code in (124, 137, 0, 130, 143) and took >= a.seconds - 1
        checks = [
            ('the world loads from the restored records', m is not None and got_forms == want_forms and got_chars == want_chars,
             f'loaded {got_forms} change forms, {got_chars} player characters; the backup holds {want_forms} and {want_chars}'),
            ('the gamemode loads', gm is not None, gm.group(0)[:160] if gm else 'no "[gamemode] loaded:" line'),
            ('it runs from the sandbox, not /opt', bool(path_line) and path_line.group(1).startswith(box), path_line.group(1) if path_line else 'no gamemode path line'),
            ('it is still running when the timer stops it', ran_full and not stop['why'],
             stop['why'] or f'exit {code} after {took:.0f} s' + ('' if ran_full else ' (stopped early: a crash?)')),
            ('no crash lines', not errors, '; '.join(errors[:3]) or 'none'),
        ]
        for name, good, detail in checks:
            log(f'  {"PASS" if good else "FAIL"}  {name}: {detail}')
        log(f'  world file: {world_file.group(1) if world_file else "?"}; ran {took:.0f} s; log {len(text.splitlines())} lines')
        ok = all(g for _, g, _ in checks)
        excerpt = [l for l in text.splitlines() if re.search(r'Initialized|AttachSaveStorage|Using file|Gamemode path|\[gamemode\] (loaded|discord|wildlife on)|NpcSpawnSystem: \d+/\d+ zone|listen|error|Error|refused|ENOTFOUND|ECONNREFUSED', l)]
        log('  --- boot log excerpt ---')
        for l in excerpt[:80]:
            log('  ' + l[:220])
    finally:
        if a.keep:
            log(f'sandbox kept: {box}')
        else:
            shutil.rmtree(box, ignore_errors=True)
            log(f'sandbox removed: {box}' + (' (some files remain!)' if os.path.exists(box) else ''))
    log('boot test ' + ('PASSED' if ok else 'FAILED'))
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
