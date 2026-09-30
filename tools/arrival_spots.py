"""Checked spots around the Bruma arrival marker for new characters (gamemode.js ARRIVAL_SPOTS).

Reads the live plugins in /opt/skyrim-data through ck-mcp/esplib.py, in load order:
  - terrain: the LAND/VHGT of the winning plugin for each cell, heights interpolated between grid points;
  - obstacles: every placed REFR/ACHR in the Cyrodiil world near the marker, from every plugin (DLE included), with
    its base's object bounds (OBND) scaled, skipping deleted and initially disabled references;
  - the border: DLE's CYRBrumaReleaseBorderRegion polygon (REGN RPLD), which is the invisible wall.
A spot qualifies when the ground is gentle (rise under SLOPE_MAX per 64 units in every direction), no reference origin
is within CLEAR units and no object's bounds reach within MARGIN of it, and it lies inside the border by BORDER_MIN.
Prints the survey and writes the chosen spots as JSON. Run: python3 tools/arrival_spots.py [out.json]

The marker stands on the border gate's road pieces (RoadStraight01Snow, WalkwayCWallGate01Snow), 50-76 units above
the terrain, so the terrain alone finds nothing: VHGT is not the walking surface there, and the road's own bounds cover
the ground around it. --observed reads the server log's "npcGround player ... at x,y,z" lines on stdin instead and
keeps positions where a player stood still across two samples 5 s apart (measured walkable ground), clustered within
40 units, seen at least MIN_SEEN times, SPACING apart; each is then checked against VHGT (the surface is at or above
the terrain), the border, and the nearest placed objects, and printed. The log holds player names: only the spots
are written out.
  sudo grep -a "npcGround player" /var/log/skymp-server.log* | python3 tools/arrival_spots.py --observed out.json
"""
import sys, os, struct, math, json

sys.path.insert(0, os.path.expanduser('~/dragonbreak/ck-mcp'))
from esplib import Plugin, subrecords, edid_of

DATA = '/opt/skyrim-data'
LOADORDER = os.path.expanduser('~/dragonbreak/fork/deploy/skyrim-data/loadorder.txt')
MARKER = (48236.2, 260600.4, 20405.1)
WORLD_LOCAL = 0x0A764B          # BSHeartland's Cyrodiil world
BORDER_LOCAL = 0x0CBCDD         # CYRBrumaReleaseBorderRegion
RADIUS = 700                    # search this far from the marker
STEP = 32
SLOPE_MAX = 24                  # units of rise per 64 across (about 20 degrees)
CLEAR = 150                     # no reference origin this close
MARGIN = 60                     # no object's bounds this close
BORDER_MIN = 400                # this far inside the border wall
SPACING = 110                   # spots at least this far apart
WANT = 12

order = [l.strip() for l in open(LOADORDER) if l.strip() and not l.startswith('#')]
plugins = []
for name in order:
    p = os.path.join(DATA, name)
    if os.path.exists(p):
        try:
            plugins.append(Plugin(p))
        except Exception as e:
            print('unreadable', name, e)
by_key = {p.key: p for p in plugins}

def local_to(p, key, local):
    """This plugin's form id for (plugin key, local id), or None when it does not master that plugin."""
    ms = [m.lower() for m in p.masters]
    if key == p.key:
        return (len(ms) << 24) | local
    if key in ms:
        return (ms.index(key) << 24) | local
    return None

def resolve(p, fid):
    """(plugin key, local id) of a form id written in plugin p."""
    src, loc = p.modindex_source(fid)
    return src, loc

# ---- terrain: the last plugin in load order that has a LAND for the cell wins ----
cells = {}                      # (key of plugin, cell fid) -> grid
land = {}                       # grid -> (plugin name, VHGT)
for p in plugins:
    W = local_to(p, 'bsheartland.esm', WORLD_LOCAL)
    if W is None:
        continue
    with open(p.path, 'rb') as fh:
        grid_of = {}
        for sig, fid, flags, off, size, ctx in p.index:
            if sig == 'CELL' and ctx[0] == W:
                for s, v in subrecords(p.data_at(fh, off, size, flags)):
                    if s == b'XCLC':
                        grid_of[fid] = struct.unpack_from('<ii', v)
        for sig, fid, flags, off, size, ctx in p.index:
            if sig == 'LAND' and ctx[0] == W and ctx[1] in grid_of:
                g = grid_of[ctx[1]]
                if abs(g[0] * 4096 - MARKER[0]) > 12000 or abs(g[1] * 4096 - MARKER[1]) > 12000:
                    continue
                for s, v in subrecords(p.data_at(fh, off, size, flags)):
                    if s == b'VHGT':
                        land[g] = (p.name, v)

def heights(v):
    off = struct.unpack('<f', v[:4])[0]
    d = struct.unpack('<1089b', v[4:4 + 1089])
    out = [[0.0] * 33 for _ in range(33)]
    row = off
    for y in range(33):
        row += d[y * 33]; col = row; out[y][0] = col * 8
        for x in range(1, 33):
            col += d[y * 33 + x]; out[y][x] = col * 8
    return out

hcache = {}
def terrain(x, y):
    g = (math.floor(x / 4096), math.floor(y / 4096))
    if g not in hcache:
        hcache[g] = heights(land[g][1]) if g in land else None
    t = hcache[g]
    if t is None:
        return None
    lx = (x - g[0] * 4096) / 128.0; ly = (y - g[1] * 4096) / 128.0
    c0, r0 = min(int(lx), 31), min(int(ly), 31)
    fx, fy = lx - c0, ly - r0
    return (t[r0][c0] * (1 - fx) * (1 - fy) + t[r0][c0 + 1] * fx * (1 - fy)
            + t[r0 + 1][c0] * (1 - fx) * fy + t[r0 + 1][c0 + 1] * fx * fy)

# ---- obstacles: every placed reference near the marker, from every plugin ----
obnd_cache = {}
def bounds_radius(key, local):
    """Horizontal half-diagonal of the base's OBND, from the last plugin in load order that defines it."""
    if (key, local) in obnd_cache:
        return obnd_cache[(key, local)]
    r = None; edid = ''
    for p in plugins:
        fid = local_to(p, key, local)
        if fid is None:
            continue
        for sig, f, flags, off, size, ctx in p.index:
            if f == fid and sig not in ('REFR', 'ACHR', 'CELL', 'LAND', 'NAVM'):
                with open(p.path, 'rb') as fh:
                    d = p.data_at(fh, off, size, flags)
                edid = edid_of(d) or edid
                for s, v in subrecords(d):
                    if s == b'OBND' and len(v) >= 12:
                        x1, y1, z1, x2, y2, z2 = struct.unpack('<6h', v[:12])
                        r = math.hypot(max(abs(x1), abs(x2)), max(abs(y1), abs(y2)))
                break
    obnd_cache[(key, local)] = (r, edid)
    return obnd_cache[(key, local)]

refs = {}                        # (key, local) of the ref -> latest (plugin, base, pos, scale, flags)
for p in plugins:
    W = local_to(p, 'bsheartland.esm', WORLD_LOCAL)
    if W is None:
        continue
    with open(p.path, 'rb') as fh:
        for sig, fid, flags, off, size, ctx in p.index:
            if sig not in ('REFR', 'ACHR') or ctx[0] != W:
                continue
            d = p.data_at(fh, off, size, flags)
            base = None; pos = None; scale = 1.0
            for s, v in subrecords(d):
                if s == b'NAME': base = struct.unpack('<I', v[:4])[0]
                elif s == b'DATA' and len(v) >= 24: pos = struct.unpack_from('<6f', v)
                elif s == b'XSCL': scale = struct.unpack('<f', v[:4])[0]
            if pos is None or math.hypot(pos[0] - MARKER[0], pos[1] - MARKER[1]) > RADIUS + 3000:
                continue
            refs[resolve(p, fid)] = (p.name, resolve(p, base) if base is not None else None, pos, scale, flags)

obstacles = []
for rid, (pname, base, pos, scale, flags) in refs.items():
    if flags & 0x20 or flags & 0x800:          # deleted, initially disabled
        continue
    r, edid = bounds_radius(*base) if base else (None, '')
    obstacles.append((pos, (r or 0) * scale, edid, pname))

# ---- the border: DLE's region polygon ----
poly = None
for p in plugins:
    fid = local_to(p, 'bsheartland.esm', BORDER_LOCAL)
    if fid is None:
        continue
    for sig, f, flags, off, size, ctx in p.index:
        if f == fid and sig == 'REGN':
            with open(p.path, 'rb') as fh:
                d = p.data_at(fh, off, size, flags)
            pts = []
            for s, v in subrecords(d):
                if s == b'RPLD':
                    pts = [struct.unpack_from('<ff', v, i) for i in range(0, len(v) - 7, 8)]
            if pts:
                poly = (p.name, pts)

def inside(x, y, pts):
    c = False
    j = len(pts) - 1
    for i in range(len(pts)):
        xi, yi = pts[i]; xj, yj = pts[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            c = not c
        j = i
    return c

def edge_distance(x, y, pts):
    best = float('inf')
    for i in range(len(pts)):
        (x1, y1), (x2, y2) = pts[i], pts[(i + 1) % len(pts)]
        dx, dy = x2 - x1, y2 - y1
        t = max(0, min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy or 1)))
        best = min(best, math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)))
    return best

MIN_SEEN = 3
OBS_MAX = 560                   # the last standing cluster seen this far down the road

def observed_spots(lines):
    import re
    last, stand = {}, []
    for line in lines:
        m = re.search(r'npcGround player (.+?) at (-?\d+),(-?\d+),(-?\d+) terrain', line)
        if not m:
            continue
        who = m.group(1); x, y, z = int(m.group(2)), int(m.group(3)), int(m.group(4))
        prev = last.get(who); last[who] = (x, y, z)
        d = math.hypot(x - MARKER[0], y - MARKER[1])
        if prev and d <= OBS_MAX and math.hypot(x - prev[0], y - prev[1]) < 15 and abs(z - prev[2]) < 10:
            stand.append((d, x, y, z))
    clusters = []
    for d, x, y, z in sorted(stand):
        for c in clusters:
            if math.hypot(x - c['x'], y - c['y']) < 40:
                c['n'] += 1; c['zmax'] = max(c['zmax'], z); break
        else:
            clusters.append({'d': d, 'x': x, 'y': y, 'zmax': z, 'n': 1})
    chosen = [{'x': MARKER[0], 'y': MARKER[1], 'zmax': MARKER[2] - 10, 'n': 0, 'd': 0}]
    for c in clusters:
        if c['n'] >= MIN_SEEN and all(math.hypot(c['x'] - k['x'], c['y'] - k['y']) >= SPACING for k in chosen):
            chosen.append(c)
    return chosen

if len(sys.argv) > 1 and sys.argv[1] == '--observed':
    spots = observed_spots(sys.stdin)
    out = []
    print('observed standing spots, spaced %d, seen %d+ times:' % (SPACING, MIN_SEEN))
    for c in spots:
        t = terrain(c['x'], c['y'])
        near = min(((math.hypot(o[0][0] - c['x'], o[0][1] - c['y']), o[2]) for o in obstacles), default=(0, ''))
        edge = edge_distance(c['x'], c['y'], poly[1])
        ok = t is not None and c['zmax'] >= t - 8 and inside(c['x'], c['y'], poly[1]) and edge >= BORDER_MIN
        print('  %s (%d, %d) z %d: %.0f from the marker, seen %d, %.0f above the terrain (VHGT %.0f), border %.0f in, nearest object %.0f (%s)' % (
            'ok ' if ok else 'NO ', c['x'], c['y'], c['zmax'], c['d'], c['n'], c['zmax'] - (t or 0), t or 0, edge, near[0], near[1]))
        if ok:
            out.append([round(c['x'], 1), round(c['y'], 1), round(c['zmax'] + 10, 1)])
    if len(sys.argv) > 2:
        json.dump({'marker': MARKER, 'spots': out, 'method': 'observed standing positions, VHGT and border checked',
                   'rules': {'spacing': SPACING, 'minSeen': MIN_SEEN, 'borderMin': BORDER_MIN}}, open(sys.argv[2], 'w'), indent=1)
    sys.exit(0)

# ---- the survey ----
print('terrain from:', sorted({v[0] for v in land.values()}))
print('border polygon from:', poly[0] if poly else None, len(poly[1]) if poly else 0, 'points')
mz = terrain(MARKER[0], MARKER[1])
print('marker z %.1f, terrain under it %.1f' % (MARKER[2], mz))
print('marker inside the border:', inside(MARKER[0], MARKER[1], poly[1]), 'distance to the edge %.0f' % edge_distance(MARKER[0], MARKER[1], poly[1]))
near = sorted((math.hypot(o[0][0] - MARKER[0], o[0][1] - MARKER[1]), o) for o in obstacles)[:12]
for dist, (pos, r, edid, pname) in near:
    print('  obstacle %5.0f away, bounds %4.0f: %s (%s) at %s' % (dist, r, edid, pname, [round(c) for c in pos[:3]]))

def slope_ok(x, y, z):
    for dx, dy in ((64, 0), (-64, 0), (0, 64), (0, -64), (45, 45), (-45, 45), (45, -45), (-45, -45)):
        t = terrain(x + dx, y + dy)
        if t is None or abs(t - z) > SLOPE_MAX:
            return False
    return True

cands = []
for ix in range(-RADIUS, RADIUS + 1, STEP):
    for iy in range(-RADIUS, RADIUS + 1, STEP):
        x, y = MARKER[0] + ix, MARKER[1] + iy
        dm = math.hypot(ix, iy)
        if dm > RADIUS:
            continue
        z = terrain(x, y)
        if z is None or not slope_ok(x, y, z):
            continue
        if not poly or not inside(x, y, poly[1]) or edge_distance(x, y, poly[1]) < BORDER_MIN:
            continue
        ok = True
        for pos, r, edid, pname in obstacles:
            d = math.hypot(pos[0] - x, pos[1] - y)
            if d < CLEAR or d < r + MARGIN:
                ok = False; break
        if ok:
            cands.append((dm, x, y, z))

cands.sort()
chosen = []
for dm, x, y, z in cands:
    if all(math.hypot(x - c[0], y - c[1]) >= SPACING for c in chosen):
        chosen.append((round(x, 1), round(y, 1), round(z + 8, 1)))
    if len(chosen) >= WANT:
        break
print('%d candidate grid points; chose %d:' % (len(cands), len(chosen)))
for c in chosen:
    print('  ', c, 'from the marker %.0f, ground %.1f' % (math.hypot(c[0] - MARKER[0], c[1] - MARKER[1]), c[2] - 8))
if len(sys.argv) > 1:
    json.dump({'marker': MARKER, 'spots': chosen, 'rules': {'slopeMax': SLOPE_MAX, 'clear': CLEAR, 'margin': MARGIN,
               'borderMin': BORDER_MIN, 'spacing': SPACING}}, open(sys.argv[1], 'w'), indent=1)
