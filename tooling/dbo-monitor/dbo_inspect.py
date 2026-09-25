#!/usr/bin/env python3
"""dbo-inspect: the story of one NPC or player, the bug reports, and the live picture, from the game server's log and
the files debugsnap.js writes. For whoever investigates a problem during play. Run as root (the log is root-only):

  dbo-inspect npc <id> [minutes]        everything about one NPC: spawn, hosts, drift reports, ground, jumps, death
  dbo-inspect player <name> [minutes]   joins, leaves, pause menu, client errors, bug reports, hosting, crashes
  dbo-inspect around <HH:MM:SS> [secs]  every meaningful line in a window around a moment (noise dropped)
  dbo-inspect bugs [n]                  the latest /bug reports, one line each
  dbo-inspect bug <file|n>              one report: text, the picture around the player, and its log lines
  dbo-inspect live                      who is online and the NPCs around each, from live.json
  dbo-inspect summary [minutes]         the dbo-monitor counts over a window
"""
import json, os, re, sys, time
from collections import Counter

LOG = '/var/log/skymp-server.log'
DIR = '/var/lib/dbo-monitor'
NOISE = re.compile(r"Method not found|Refr pointer expired|Recipe not found|Target actor doesn.t exist|CastPrimitivePropertyValue|Metrics|MovementValidation|ticks \(ms|Skipping script")
TS = re.compile(r'^\[(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)')


def tail_lines(minutes):
    """Log lines from the last `minutes` (reads backwards in chunks, so an hour costs little)."""
    since = time.strftime('%Y-%m-%d %H:%M:%S', time.gmtime(time.time() - minutes * 60))
    out, chunk = [], 1 << 20
    with open(LOG, 'rb') as f:
        f.seek(0, 2); pos = f.tell(); rest = b''
        while pos > 0:
            step = min(chunk, pos); pos -= step; f.seek(pos)
            data = f.read(step) + rest
            lines = data.split(b'\n'); rest = lines[0]
            block = [l.decode('utf8', 'replace') for l in lines[1:]]
            out = block + out
            first = next((l for l in block if TS.match(l)), None)
            if first and first[1:20] < since:
                break
        if pos == 0 and rest:
            out = [rest.decode('utf8', 'replace')] + out
    return [l for l in out if l[1:20] >= since]


def short(line):
    m = TS.match(line)
    t = m.group(2) if m else '??:??:??'
    body = re.sub(r'^\[[^\]]*\] (\[[a-z]+\] )?(\[[a-z]+\] )?(\[gamemode\] )?', '', line)
    body = re.sub(r'"(node|rehostClock|target|grade|bleed|settles2s|v10|sit|anims|windowMs|standDrift|loadedForMs|srv|attempt|splitForMs)":(\[[^]]*\]|\{[^}]*\}|[^,]*),', '', body)
    return f'{t}  {body[:260]}'


def npc(nid, minutes):
    nid = nid.lower().lstrip('0x')
    rx = re.compile(r'\b' + re.escape(nid) + r'\b|"remoteId":"' + re.escape(nid) + '"')
    rows = [l for l in tail_lines(minutes) if rx.search(l) and not NOISE.search(l)]
    if not rows:
        print(f'nothing about {nid} in the last {minutes} min'); return
    kinds = Counter()
    for l in rows:
        k = re.search(r'"kind":"(\w+)"', l)
        kinds[k.group(1) if k else re.sub(r'.*(Hoster|npcGround \w+|NpcJump|spawned|respawned|placing it again|died|lifted).*', r'\1', l)[:24] if re.search(r'Hoster|npcGround|NpcJump|spawned|respawned|placing it again|died|lifted', l) else 'other'] += 1
    print(f'{nid}: {len(rows)} lines in {minutes} min  ' + ', '.join(f'{k} {v}' for k, v in kinds.most_common(10)))
    # Heartbeats list every hosted id each 30 s: one line only when who holds it or whether it is loaded changes
    shown, last = [], None
    for l in rows:
        if '"kind":"heartbeat"' in l:
            who = re.search(r'npcDrift (.+?) #', l)
            d = re.search(re.escape(nid) + r':(-?\d+)', l)
            state = (who.group(1) if who else '?', 'not loaded' if d and d.group(1) == '-1' else 'loaded')
            if state != last:
                last = state
                shown.append(f'{short(l)[:8]}  hosted by {state[0]}, {state[1]}' + (f' at {d.group(1)} u' if d and d.group(1) != '-1' else ''))
            continue
        shown.append(short(l))
    for l in shown[-80:]:
        print(l)


def player(name, minutes):
    rows = [l for l in tail_lines(minutes) if name.lower() in l.lower() and not NOISE.search(l)
            and re.search(r'JOIN|LEAVE|clientState|"kind":"(error|heartbeat)"|BUGREPORT|crash|disconnect|re-dressed|DUNGEON|equipment', l)]
    beats = [l for l in rows if '"kind":"heartbeat"' in l]
    other = [l for l in rows if '"kind":"heartbeat"' not in l]
    print(f'{name}: {len(other)} events and {len(beats)} heartbeats in {minutes} min')
    for l in other[-60:]:
        print(short(l))
    if beats:
        b = beats[-1]
        h = re.search(r'"hosted":(\d+)', b); u = b.count(':-1')
        print(f'last heartbeat {short(b)[:8]}: hosts {h.group(1) if h else "?"} NPCs, {u} of them not loaded')


def around(hms, secs):
    day = time.strftime('%Y-%m-%d', time.gmtime())
    t0 = time.mktime(time.strptime(f'{day} {hms}', '%Y-%m-%d %H:%M:%S'))
    lo = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(t0 - secs)); hi = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(t0 + secs))
    minutes = int((time.time() - (t0 - secs - time.timezone)) / 60) + 5
    for l in tail_lines(max(5, minutes)):
        if lo <= l[1:20] <= hi and not NOISE.search(l) and '"kind":"heartbeat"' not in l:
            print(short(l))


def bug_files():
    d = os.path.join(DIR, 'bugs')
    return sorted(os.listdir(d)) if os.path.isdir(d) else []


def bugs(n):
    for f in bug_files()[-n:]:
        try:
            b = json.load(open(os.path.join(DIR, 'bugs', f)))
            print(f'{f}  {b.get("by")}: {b.get("text", "")[:120]}')
        except Exception as e:
            print(f, 'unreadable', e)


def bug(which):
    files = bug_files()
    f = files[-int(which)] if which.isdigit() and int(which) <= len(files) else which
    b = json.load(open(os.path.join(DIR, 'bugs', os.path.basename(f))))
    v = b['view']
    print(f'{b["at"]}  {b["by"]}: {b["text"]}')
    print(f'  at {v["world"]} {v["pos"]} (terrain dz {v.get("terrainDz")}), hosting {v.get("hosting")}')
    for n in v['npcs'][:20]:
        print(f'  {n["id"]} {n["base"]:28} {str(n["dist"]):>6} u  host {n["host"]}  dz {n.get("terrainDz")}{"  DEAD" if n["dead"] else ""}')
    print('  log:')
    for l in b.get('log', [])[-40:]:
        print('   ', short(l))


def live():
    st = json.load(open(os.path.join(DIR, 'live.json')))
    print('live.json', st['at'])
    for p in st['players']:
        print(f'{p["name"]} at {p["world"]} {p["pos"]} (terrain dz {p.get("terrainDz")}), hosting {p.get("hosting")}')
        for n in p['npcs'][:12]:
            print(f'   {n["id"]} {n["base"]:28} {str(n["dist"]):>6} u  host {n["host"]}  dz {n.get("terrainDz")}{"  DEAD" if n["dead"] else ""}')


def summary(minutes):
    st = json.load(open(os.path.join(DIR, 'state.json')))
    since = time.time() - minutes * 60
    c = Counter(); worst = {}
    for w in st.get('windows', []):
        if w['start'] + 300 < since:
            continue
        c.update(w.get('counts', {}))
        for k, v in w.get('worst', {}).items():
            if k not in worst or v[0] > worst[k][0]:
                worst[k] = v
    for k, v in c.most_common():
        print(f'{v:6}  {k}' + (f'   worst {worst[k][0]}: {worst[k][1]}' if k in worst and worst[k][0] else ''))
    print('recent alerts:')
    for r in st.get('recent', [])[-10:]:
        print('  ', r)


def main(a):
    if not a:
        print(__doc__); return
    cmd, rest = a[0], a[1:]
    num = lambda i, d: int(rest[i]) if len(rest) > i and rest[i].isdigit() else d
    if cmd == 'npc' and rest: npc(rest[0], num(1, 60))
    elif cmd == 'player' and rest: player(' '.join(x for x in rest if not x.isdigit()), num(len(rest) - 1, 120) if rest[-1].isdigit() else 120)
    elif cmd == 'around' and rest: around(rest[0], num(1, 30))
    elif cmd == 'bugs': bugs(num(0, 20))
    elif cmd == 'bug' and rest: bug(rest[0])
    elif cmd == 'live': live()
    elif cmd == 'summary': summary(num(0, 60))
    else: print(__doc__)


if __name__ == '__main__':
    main(sys.argv[1:])
