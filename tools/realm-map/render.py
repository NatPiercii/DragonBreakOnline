#!/usr/bin/env python3
"""Realm Map terrain renderer (WAR_DESIGN.md section 3).

Reads the landscape of one worldspace from the plugins (the winning LAND/VHGT of every exterior cell, CELL water heights,
the WRLD defaults) and draws a shaded relief map of a square region of it, north up, with no text. Beside the image it
writes a JSON that maps game coordinates to image pixels, plus the places with a map marker that fall inside the region.

    python3 tools/realm-map/render.py                        Bruma, radius 20 cells, 16 px per cell -> out/bruma.png
    python3 tools/realm-map/render.py --name cyrodiil-west --centre 20000 180000 --radius 30 --ppc 12
    python3 tools/realm-map/render.py --world 3c:Skyrim.esm --name whiterun --centre 20000 -10000

Stdlib only (Pillow is not needed; the PNG encoder is below). Reads the plugins with mmap, so it does not load Skyrim.esm
into memory. The format notes it relies on were checked against the bytes; see README.md.
"""
import argparse, datetime, json, math, mmap, os, struct, sys, zlib

HERE = os.path.dirname(os.path.abspath(__file__))
CELL = 4096          # game units per exterior cell
STEP = 128           # game units between two LAND vertices (32 steps per cell)
VERTS = 33           # vertices per cell edge
VHGT_LEN = 4 + VERTS * VERTS
F_ESM, F_DELETED, F_LOCALIZED, F_COMPRESSED = 0x1, 0x20, 0x80, 0x40000
CELL_HAS_WATER = 0x2
NO_WATER = (0x7F7FFFFF, 0x4F7FFFC9, 0xCF000000)      # XCLW bit patterns UESP lists as "no water" or CK bugs
MAP_MARKER_STAT = ("skyrim.esm", 0x000010)          # base object of every map marker reference
MAP_MARKER_REF_TYPE = ("skyrim.esm", 0x10F63C)      # LCRT MapMarkerRefType
CENTER_MARKER_REF_TYPE = ("skyrim.esm", 0x01BDF1)   # LCRT LocationCenterMarker: the fallback for a place with no map marker


# ---------------------------------------------------------------------------------------------------------------- plugins

def subrecords(body):
    """[(signature, bytes)] of a record body. XXXX carries the size of the next subrecord when it exceeds 65535."""
    out, p, big = [], 0, None
    while p + 6 <= len(body):
        sig, size = struct.unpack_from("<4sH", body, p)
        p += 6
        if sig == b"XXXX":
            big = struct.unpack_from("<I", body, p)[0]
            p += size
            continue
        if big is not None:
            size, big = big, None
        out.append((sig, bytes(body[p:p + size])))
        p += size
    return out


def first(subs, sig):
    for s, v in subs:
        if s == sig:
            return v
    return None


def zstring(v):
    return v.split(b"\0", 1)[0].decode("cp1252", "replace") if v is not None else None


class Plugin:
    def __init__(self, path, order):
        self.path, self.name, self.order = path, os.path.basename(path), order
        self.f = open(path, "rb")
        self.m = mmap.mmap(self.f.fileno(), 0, access=mmap.ACCESS_READ)
        sig, size, self.flags = struct.unpack_from("<4sII", self.m, 0)
        if sig != b"TES4":
            raise ValueError("%s: not a plugin" % path)
        self.masters = [zstring(v) for s, v in subrecords(self.m[24:24 + size]) if s == b"MAST"]
        self.lmasters = [x.lower() for x in self.masters]
        self.esm = bool(self.flags & F_ESM) or self.name.lower().endswith((".esm", ".esl"))
        self.localized = bool(self.flags & F_LOCALIZED)
        self.top = 24 + size

    def canon(self, fid):
        """Raw form id in this plugin -> (origin plugin, lowercase; local id). The top byte indexes this plugin's
        own master list, and an index past its end means the plugin itself."""
        i = fid >> 24
        return (self.lmasters[i] if i < len(self.masters) else self.name.lower(), fid & 0xFFFFFF)

    def knows(self, origin):
        return origin == self.name.lower() or origin in self.lmasters

    def header(self, off):
        """(signature, size, flags, form id) of the record or group at off; for a group: (b'GRUP', total size,
        label as uint32, group type)."""
        sig = self.m[off:off + 4]
        if sig == b"GRUP":
            size, label, gtype = struct.unpack_from("<IIi", self.m, off + 4)
            return sig, size, label, gtype
        size, flags, fid = struct.unpack_from("<III", self.m, off + 4)
        return sig, size, flags, fid

    def body(self, off, size, flags):
        b = self.m[off + 24:off + 24 + size]
        if flags & F_COMPRESSED:
            n = struct.unpack_from("<I", b)[0]
            b = zlib.decompress(b[4:])
            if len(b) != n:
                raise ValueError("%s @%d: decompressed %d bytes, header says %d" % (self.name, off, len(b), n))
        return b

    def top_group(self, label):
        off = self.top
        while off < len(self.m):
            sig, size, lab, gtype = self.header(off)
            if sig != b"GRUP":
                raise ValueError("%s @%d: expected a top-level GRUP" % (self.name, off))
            if gtype == 0 and struct.pack("<I", lab) == label:
                return off, off + size
            off += size
        return None

    def children(self, start, end):
        """Direct children of a group body: (offset, signature, size, flags_or_label, fid_or_type)."""
        off = start
        while off < end:
            sig, size, a, b = self.header(off)
            yield off, sig, size, a, b
            off += size if sig == b"GRUP" else 24 + size


def load_order(data, order_file):
    names = []
    for line in open(order_file, encoding="utf-8-sig"):
        line = line.strip().lstrip("*")
        if line and not line.startswith("#"):
            names.append(line)
    plugins, missing = [], []
    for n in names:
        path = os.path.join(data, n)
        if os.path.exists(path):
            plugins.append(Plugin(path, len(plugins)))
        else:
            missing.append(n)
    # The engine loads ESM-flagged plugins (and .esm/.esl files) before plain ones, keeping the list order otherwise.
    plugins.sort(key=lambda p: (0 if p.esm else 1, p.order))
    for i, p in enumerate(plugins):
        p.order = i
    return plugins, missing


# ------------------------------------------------------------------------------------------------------------ worldspace

def parse_world_id(text):
    """'a764b:BSHeartland.esm' -> ('bsheartland.esm', 0x0A764B)."""
    local, plugin = text.split(":", 1)
    return plugin.lower(), int(local, 16) & 0xFFFFFF


class World:
    """Everything the renderer needs from one worldspace, overrides applied in load order (last plugin wins)."""

    def __init__(self, plugins, world_id, want_cells=None):
        self.id = world_id
        self.plugins = [p for p in plugins if p.knows(world_id[0])]
        self.names = {p.name.lower(): p.name for p in plugins}
        self.record = None          # winning WRLD subrecords
        self.record_src = None
        self.cells = {}             # cell id -> {grid, flags, water, src}
        self.lands = {}             # land id -> {cell, vhgt, src, order}
        self.refs = {}              # persistent ref id -> {base, pos, edid, name, src}
        self.locations = {}         # LCTN id -> {edid, name, markers: {"map"|"center": ref id}, src}
        self.want = want_cells      # None or a set of (x, y): only keep VHGT for these cells
        for p in self.plugins:
            self._scan_plugin(p)
        self._index()

    # A world's children group holds: the persistent CELL + its children (group 6 > 8), then exterior cell blocks
    # (group 4 > 5), each CELL followed by its children (group 6 > 8 persistent, 9 temporary); LAND sits in group 9.
    # Groups 6, 8 and 9 carry the parent cell's form id as their label.
    def _scan_plugin(self, p):
        g = p.top_group(b"WRLD")
        if g:
            for off, sig, size, a, b in p.children(g[0] + 24, g[1]):
                if sig == b"WRLD" and p.canon(b) == self.id:
                    if a & F_DELETED:
                        continue
                    self.record, self.record_src = subrecords(p.body(off, size, a)), p.name
                elif sig == b"GRUP" and b == 1 and p.canon(a) == self.id:
                    self._walk(p, off + 24, off + size, None, 1)
        g = p.top_group(b"LCTN")
        if g:
            for off, sig, size, flags, fid in p.children(g[0] + 24, g[1]):
                if sig != b"LCTN":
                    continue
                key = p.canon(fid)
                if flags & F_DELETED:
                    self.locations.pop(key, None)
                    continue
                subs = subrecords(p.body(off, size, flags))
                markers = {}
                for s, v in subs:
                    if s == b"LCSR":
                        # 16-byte entries: LCRT, reference, CELL or WRLD it sits in, then int16 grid Y, int16 grid X
                        for i in range(0, len(v) - 15, 16):
                            lcrt, ref, where = struct.unpack_from("<III", v, i)
                            if p.canon(where) != self.id:
                                continue
                            if p.canon(lcrt) == MAP_MARKER_REF_TYPE:
                                markers["map"] = p.canon(ref)
                            elif p.canon(lcrt) == CENTER_MARKER_REF_TYPE:
                                markers["center"] = p.canon(ref)
                full = first(subs, b"FULL")
                self.locations[key] = {
                    "edid": zstring(first(subs, b"EDID")),
                    "name": None if (full is None or p.localized) else zstring(full),
                    "markers": markers, "src": p.name,
                }

    def _walk(self, p, start, end, cell, gtype):
        for off, sig, size, a, b in p.children(start, end):
            if sig == b"GRUP":
                parent = p.canon(a) if b in (6, 8, 9) else cell
                self._walk(p, off + 24, off + size, parent, b)
            elif sig == b"CELL":
                key = p.canon(b)
                if a & F_DELETED:
                    self.cells.pop(key, None)
                    continue
                subs = subrecords(p.body(off, size, a))
                old = self.cells.get(key, {})
                xclc, data, xclw = first(subs, b"XCLC"), first(subs, b"DATA"), first(subs, b"XCLW")
                water = None
                if xclw is not None and len(xclw) >= 4 and struct.unpack_from("<I", xclw)[0] not in NO_WATER:
                    water = struct.unpack_from("<f", xclw)[0]
                self.cells[key] = {
                    "grid": struct.unpack_from("<ii", xclc) if xclc and len(xclc) >= 8 else old.get("grid"),
                    "flags": (data[0] | (data[1] << 8 if len(data) > 1 else 0)) if data else 0,
                    "water": water, "src": p.name,
                    # the world's persistent cell sits directly in the world children group (type 1); it carries an
                    # XCLC of 0,0 too, which is not its place on the grid
                    "persistent": gtype == 1,
                }
            elif sig == b"LAND":
                key = p.canon(b)
                if a & F_DELETED:
                    self.lands.pop(key, None)
                    continue
                grid = self.cells.get(cell, {}).get("grid")
                if self.want is not None and grid not in self.want:
                    self.lands[key] = {"cell": cell, "vhgt": None, "src": p.name, "order": p.order}
                    continue
                vhgt = first(subrecords(p.body(off, size, a)), b"VHGT")
                self.lands[key] = {"cell": cell, "vhgt": vhgt, "src": p.name, "order": p.order}
            elif sig == b"REFR" and gtype == 8:
                key = p.canon(b)
                if a & F_DELETED:
                    self.refs.pop(key, None)
                    continue
                subs = subrecords(p.body(off, size, a))
                name, data, full = first(subs, b"NAME"), first(subs, b"DATA"), first(subs, b"FULL")
                if name is None or data is None or len(data) < 24:
                    continue
                self.refs[key] = {
                    "base": p.canon(struct.unpack_from("<I", name)[0]),
                    "pos": struct.unpack_from("<fff", data), "edid": zstring(first(subs, b"EDID")),
                    "name": None if (full is None or p.localized) else zstring(full), "src": p.name,
                }

    def _index(self):
        if self.record is None:
            raise SystemExit("worldspace %06X:%s not found" % (self.id[1], self.id[0]))
        dnam = first(self.record, b"DNAM")
        self.default_land, self.default_water = struct.unpack_from("<ff", dnam) if dnam else (-2048.0, 0.0)
        self.edid = zstring(first(self.record, b"EDID"))
        self.parent = first(self.record, b"WNAM")
        self.by_grid = {}           # (x, y) -> cell id (the one whose record loads last)
        for key, c in self.cells.items():
            if c["grid"] is not None and not c["persistent"]:
                self.by_grid[tuple(c["grid"])] = key
        self.land_at = {}           # (x, y) -> land entry; if two LAND records claim one cell, the later plugin wins
        self.land_conflicts = []
        for key, l in self.lands.items():
            c = self.cells.get(l["cell"])
            if not c or c["grid"] is None:
                continue
            g = tuple(c["grid"])
            prev = self.land_at.get(g)
            if prev is not None:
                self.land_conflicts.append((g, prev["id"], key))
                if prev["order"] > l["order"]:
                    continue
            self.land_at[g] = dict(l, id=key)

    def water_at(self, grid):
        """Water surface height of an exterior cell, or None when the cell has no water."""
        key = self.by_grid.get(grid)
        if key is None:
            return self.default_water            # no CELL record: the engine fills it with the world defaults
        c = self.cells[key]
        if not c["flags"] & CELL_HAS_WATER:
            return None
        return c["water"] if c["water"] is not None else self.default_water


def decode_vhgt(v):
    """33x33 heights in game units, [row][col], row 0 = south edge, col 0 = west edge. The float anchor and the int8
    deltas are in units of 8: each row's first vertex adds to the previous row's first vertex, every other vertex adds to
    its west neighbour."""
    if v is None or len(v) < VHGT_LEN:
        return None
    anchor = struct.unpack_from("<f", v)[0]
    d = struct.unpack_from("<%db" % (VERTS * VERTS), v, 4)
    out, row = [], anchor
    for y in range(VERTS):
        row += d[y * VERTS]
        h, line = row, [row * 8.0]
        for x in range(1, VERTS):
            h += d[y * VERTS + x]
            line.append(h * 8.0)
        out.append(line)
    return out


class HeightField:
    """Vertex heights over a block of cells, 128 units apart, index [vy][vx] with vy = 0 on the south edge."""

    def __init__(self, world, cx0, cy0, cx1, cy1):
        self.cx0, self.cy0 = cx0, cy0
        self.nx, self.ny = (cx1 - cx0 + 1) * 32 + 1, (cy1 - cy0 + 1) * 32 + 1
        self.h = [[world.default_land] * self.nx for _ in range(self.ny)]
        self.missing, self.sources, self.seams, self.has = [], {}, [0, 0], set()
        filled = set()
        for cy in range(cy0, cy1 + 1):
            for cx in range(cx0, cx1 + 1):
                land = world.land_at.get((cx, cy))
                hts = decode_vhgt(land["vhgt"]) if land else None
                if hts is None:
                    self.missing.append((cx, cy))
                    continue
                self.sources[land["src"]] = self.sources.get(land["src"], 0) + 1
                self.has.add((cx, cy))
                ox, oy = (cx - cx0) * 32, (cy - cy0) * 32
                for j in range(VERTS):
                    row = self.h[oy + j]
                    for i in range(VERTS):
                        if (ox + i, oy + j) in filled and (i in (0, 32) or j in (0, 32)):
                            # a shared edge vertex written by the neighbour: the two cells must agree
                            self.seams[0] += 1
                            if abs(row[ox + i] - hts[j][i]) > 0.01:
                                self.seams[1] += 1
                        row[ox + i] = hts[j][i]
                        if i in (0, 32) or j in (0, 32):
                            filled.add((ox + i, oy + j))

    def at(self, gx, gy):
        """Bilinear height at a game position (clamped to the field)."""
        fx = min(max((gx - self.cx0 * CELL) / STEP, 0.0), self.nx - 1.000001)
        fy = min(max((gy - self.cy0 * CELL) / STEP, 0.0), self.ny - 1.000001)
        i, j = int(fx), int(fy)
        tx, ty = fx - i, fy - j
        r0, r1 = self.h[j], self.h[j + 1]
        return (r0[i] * (1 - tx) + r0[i + 1] * tx) * (1 - ty) + (r1[i] * (1 - tx) + r1[i + 1] * tx) * ty


# --------------------------------------------------------------------------------------------------------------- drawing

LAND_RAMP = [   # (fraction of the region's land height range, RGB): olive-brown lowland to pale parchment peaks
    (0.00, (104, 98, 72)),
    (0.30, (132, 120, 88)),
    (0.60, (160, 145, 110)),
    (0.85, (186, 173, 140)),
    (1.00, (206, 199, 178)),
]
WATER_SHALLOW, WATER_DEEP = (74, 100, 112), (40, 60, 76)


def ramp(stops, t):
    t = min(max(t, 0.0), 1.0)
    for (t0, c0), (t1, c1) in zip(stops, stops[1:]):
        if t <= t1:
            k = (t - t0) / (t1 - t0) if t1 > t0 else 0.0
            return tuple(c0[n] + (c1[n] - c0[n]) * k for n in range(3))
    return stops[-1][1]


def render(world, cx0, cy0, cx1, cy1, ppc, zfactor=1.0, altitude=45.0, azimuth=315.0, ambient=0.45):
    """RGBA rows of the region (cells cx0..cx1, cy0..cy1 inclusive), north up. Cells with no LAND at all (past the
    edge of the worldspace) are left transparent."""
    upp = CELL / ppc
    w, h = (cx1 - cx0 + 1) * ppc, (cy1 - cy0 + 1) * ppc
    xmin, ymax = cx0 * CELL, (cy1 + 1) * CELL
    field = HeightField(world, cx0 - 1, cy0 - 1, cx1 + 1, cy1 + 1)     # one cell of margin so the edges shade right
    # heights and water at pixel centres, with a one-pixel border for the slope kernel
    H = [[field.at(xmin + (px + 0.5) * upp, ymax - (py + 0.5) * upp) for px in range(-1, w + 1)] for py in range(-1, h + 1)]
    W = []
    for py in range(-1, h + 1):
        gy = ymax - (py + 0.5) * upp
        W.append([world.water_at((math.floor((xmin + (px + 0.5) * upp) / CELL), math.floor(gy / CELL)))
                  for px in range(-1, w + 1)])
    void = [[(math.floor((xmin + (px + 0.5) * upp) / CELL), math.floor((ymax - (py + 0.5) * upp) / CELL))
             not in field.has for px in range(-1, w + 1)] for py in range(-1, h + 1)]
    wet = [[W[y][x] is not None and H[y][x] < W[y][x] and not void[y][x] for x in range(w + 2)] for y in range(h + 2)]
    # a void pixel next to land takes the mean of its land neighbours, so the slope kernel sees no cliff at the edge
    for y in range(h + 2):
        for x in range(w + 2):
            if void[y][x]:
                near = [H[j][i] for j in range(max(0, y - 1), min(h + 2, y + 2))
                        for i in range(max(0, x - 1), min(w + 2, x + 2)) if not void[j][i]]
                if near:
                    H[y][x] = sum(near) / len(near)
    land = sorted(H[y][x] for y in range(1, h + 1) for x in range(1, w + 1) if not wet[y][x] and not void[y][x])
    lo = land[int(len(land) * 0.02)] if land else 0.0
    hi = land[int(len(land) * 0.995) - 1] if land else 1.0
    span = max(hi - lo, 1.0)
    # light from the azimuth (clockwise from north) at the altitude; x east, y north, z up
    az, alt = math.radians(azimuth), math.radians(altitude)
    L = (math.sin(az) * math.cos(alt), math.cos(az) * math.cos(alt), math.sin(alt))
    flat = L[2]
    rows = []
    for y in range(1, h + 1):
        a, b, c = H[y - 1], H[y], H[y + 1]          # north, this row, south
        row = bytearray()
        for x in range(1, w + 1):
            if void[y][x]:
                row += b"\0\0\0\0"
                continue
            # Horn's kernel: dz/d(east) and dz/d(north), per game unit, exaggerated by zfactor
            dzdx = ((a[x + 1] + 2 * b[x + 1] + c[x + 1]) - (a[x - 1] + 2 * b[x - 1] + c[x - 1])) / (8 * upp) * zfactor
            dzdy = ((a[x - 1] + 2 * a[x] + a[x + 1]) - (c[x - 1] + 2 * c[x] + c[x + 1])) / (8 * upp) * zfactor
            n = 1.0 / math.sqrt(dzdx * dzdx + dzdy * dzdy + 1.0)
            shade = max(0.0, (-dzdx * L[0] - dzdy * L[1] + L[2]) * n) / flat      # 1.0 on flat ground
            if wet[y][x]:
                depth = W[y][x] - b[x]
                col = ramp([(0.0, WATER_SHALLOW), (1.0, WATER_DEEP)], depth / 1200.0)
                k = 0.92 + 0.08 * min(shade, 1.3)
            else:
                col = ramp(LAND_RAMP, (b[x] - lo) / span)
                k = ambient + (1.0 - ambient) * min(shade, 1.4)
                if wet[y - 1][x] or wet[y + 1][x] or wet[y][x - 1] or wet[y][x + 1]:
                    k *= 0.8                         # shoreline
            row += bytes(min(255, max(0, int(col[i] * k + 0.5))) for i in range(3)) + b"\xff"
        rows.append(row)
    info = {"heightRange": [round(lo, 1), round(hi, 1)], "missing": field.missing, "sources": field.sources,
            "seams": field.seams}
    return w, h, rows, info, field


# --------------------------------------------------------------------------------------------------------------- PNG out

def write_png(path, w, h, rows):
    """8-bit RGBA PNG; each row gets the filter (None, Sub, Up, Average, Paeth) with the smallest sum of |bytes|."""
    out, prev = bytearray(), bytearray(4 * w)
    for r in rows:
        r = bytes(r)
        cand = [r,
                bytes((r[i] - (r[i - 4] if i >= 4 else 0)) & 255 for i in range(len(r))),
                bytes((r[i] - prev[i]) & 255 for i in range(len(r))),
                bytes((r[i] - (((r[i - 4] if i >= 4 else 0) + prev[i]) >> 1)) & 255 for i in range(len(r)))]
        paeth = bytearray(len(r))
        for i in range(len(r)):
            a, b, c = (r[i - 4] if i >= 4 else 0), prev[i], (prev[i - 4] if i >= 4 else 0)
            p = a + b - c
            pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
            paeth[i] = (r[i] - (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        cand.append(bytes(paeth))
        best = min(range(5), key=lambda k: sum(v if v < 128 else 256 - v for v in cand[k]))
        out.append(best)
        out += cand[best]
        prev = bytearray(r)

    def chunk(t, data):
        return struct.pack(">I", len(data)) + t + data + struct.pack(">I", zlib.crc32(t + data) & 0xFFFFFFFF)

    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(bytes(out), 9)) + chunk(b"IEND", b""))
    with open(path + ".tmp", "wb") as f:
        f.write(png)
    os.replace(path + ".tmp", path)


def dot(rows, w, h, x, y, radius, fill, ring=(20, 20, 20)):
    for py in range(int(y - radius - 2), int(y + radius + 3)):
        for px in range(int(x - radius - 2), int(x + radius + 3)):
            if 0 <= px < w and 0 <= py < h:
                d = math.hypot(px + 0.5 - x, py + 0.5 - y)
                col = fill if d <= radius else ring if d <= radius + 1.5 else None
                if col:
                    rows[py][4 * px:4 * px + 4] = bytes(col) + b"\xff"


# ------------------------------------------------------------------------------------------------------------------ main

def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--data", default="/opt/skyrim-data", help="folder with the plugins")
    ap.add_argument("--order", help="load order file (default: <data>/loadorder.txt)")
    ap.add_argument("--world", default="a764b:BSHeartland.esm", help="worldspace as localid:Plugin (default Cyrodiil)")
    ap.add_argument("--centre", nargs=2, type=float, default=[57750.0, 202700.0], metavar=("X", "Y"),
                    help="game position the region is centred on (default Bruma)")
    ap.add_argument("--radius", type=int, default=20, help="cells from the centre cell to each edge (default 20)")
    ap.add_argument("--ppc", type=int, default=16, help="pixels per cell (default 16)")
    ap.add_argument("--zfactor", type=float, default=1.0, help="vertical exaggeration of the hillshade (default 1)")
    ap.add_argument("--ambient", type=float, default=0.45, help="brightness of a slope facing away from the light (0..1)")
    ap.add_argument("--name", default="bruma", help="output base name (default bruma)")
    ap.add_argument("--out", default=os.path.join(HERE, "out"), help="output folder")
    ap.add_argument("--check", nargs="*", default=["Bruma", "Castle Bruma", "Applewatch", "Greenwood", "Aleswell",
                                                    "Pale Pass"],
                    help="places to mark in red on the debug image and print (LCTN name or editor id)")
    args = ap.parse_args()
    if args.ppc < 1 or args.radius < 0:
        ap.error("--ppc must be at least 1 and --radius at least 0")

    t0 = datetime.datetime.now()
    world_id = parse_world_id(args.world)
    plugins, missing = load_order(args.data, args.order or os.path.join(args.data, "loadorder.txt"))
    if missing:
        print("missing plugins (skipped): %s" % ", ".join(missing))
    ccx, ccy = math.floor(args.centre[0] / CELL), math.floor(args.centre[1] / CELL)
    cx0, cy0, cx1, cy1 = ccx - args.radius, ccy - args.radius, ccx + args.radius, ccy + args.radius
    want = {(x, y) for x in range(cx0 - 1, cx1 + 2) for y in range(cy0 - 1, cy1 + 2)}
    world = World(plugins, world_id, want)
    desc = "%x:%s" % (world_id[1], next(p.name for p in world.plugins if p.name.lower() == world_id[0]))
    print("%s (%s): %d cells, %d LAND, %d persistent refs, %d locations, from %s"
          % (desc, world.edid, len(world.by_grid), len(world.land_at), len(world.refs), len(world.locations),
             ", ".join(p.name for p in world.plugins) if len(world.plugins) <= 4 else "%d plugins" % len(world.plugins)))
    print("defaults: land %.1f, water %.1f (WRLD DNAM from %s)%s" % (
        world.default_land, world.default_water, world.record_src, "; has a parent world (WNAM)" if world.parent else ""))
    overridden = {}
    for g, l in world.land_at.items():
        if l["src"].lower() != world_id[0]:
            overridden[l["src"]] = overridden.get(l["src"], 0) + 1
    print("LAND overrides after %s: %s" % (world_id[0], overridden or "none"))
    for g, a, b in world.land_conflicts:
        print("  cell %s has two LAND records: %06X:%s and %06X:%s" % (g, a[1], a[0], b[1], b[0]))

    w, h, rows, info, field = render(world, cx0, cy0, cx1, cy1, args.ppc, args.zfactor, ambient=args.ambient)
    upp = CELL / args.ppc
    xmin, xmax, ymin, ymax = cx0 * CELL, (cx1 + 1) * CELL, cy0 * CELL, (cy1 + 1) * CELL
    aff = {"a": 1.0 / upp, "b": 0.0, "c": -xmin / upp, "d": 0.0, "e": -1.0 / upp, "f": ymax / upp}

    def to_px(x, y):
        return aff["a"] * x + aff["b"] * y + aff["c"], aff["d"] * x + aff["e"] * y + aff["f"]

    print("region cells %d,%d .. %d,%d -> %dx%d px, %d px/cell; land heights %.0f..%.0f; cells without LAND: %d"
          % (cx0, cy0, cx1, cy1, w, h, args.ppc, info["heightRange"][0], info["heightRange"][1],
             len([c for c in info["missing"] if cx0 <= c[0] <= cx1 and cy0 <= c[1] <= cy1])))
    print("cell seams checked: %d shared vertices, %d disagree" % tuple(info["seams"]))

    places = []
    for key, loc in world.locations.items():
        # a place is drawn at its map marker; a place without one (a hamlet like Aleswell) at its centre marker
        kind = "map" if "map" in loc["markers"] else "center" if "center" in loc["markers"] else None
        if kind is None:
            continue
        ref = loc["markers"][kind]
        r = world.refs.get(ref)
        if r is None:
            print("  %s: %s marker %06X:%s not found among persistent refs" % (loc["edid"], kind, ref[1], ref[0]))
            continue
        x, y, z = r["pos"]
        if not (xmin <= x < xmax and ymin <= y < ymax):
            continue
        px, py = to_px(x, y)
        ground = field.at(x, y)
        water = world.water_at((math.floor(x / CELL), math.floor(y / CELL)))
        places.append({"location": "%06X:%s" % (key[1], world.names.get(key[0], key[0])),
                       "edid": loc["edid"], "name": loc["name"] or r["name"], "markerType": kind,
                       "marker": "%06X:%s" % (ref[1], world.names.get(ref[0], ref[0])),
                       "game": [round(x, 1), round(y, 1), round(z, 1)], "pixel": [round(px, 1), round(py, 1)],
                       "ground": round(ground, 1), "onLand": water is None or ground >= water})
    places.sort(key=lambda p: p["edid"] or "")

    os.makedirs(args.out, exist_ok=True)
    png = os.path.join(args.out, args.name + ".png")
    write_png(png, w, h, rows)

    # checks: the centre (Bruma by default) and the named places
    bx, by = args.centre
    px, py = to_px(bx, by)
    ground, water = field.at(bx, by), world.water_at((math.floor(bx / CELL), math.floor(by / CELL)))
    inside = 0 <= px < w and 0 <= py < h
    on_land = water is None or ground >= water
    print("centre %.0f,%.0f -> pixel %.1f,%.1f (%s); terrain %.0f, water %s -> %s" % (
        bx, by, px, py, "inside" if inside else "OUTSIDE", ground, "none" if water is None else "%.0f" % water,
        "land" if on_land else "WATER"))
    debug = [bytearray(r) for r in rows]
    named = {n.lower() for n in args.check}
    for p in places:
        dot(debug, w, h, p["pixel"][0], p["pixel"][1], 2, (235, 235, 225))
    found = set()
    for p in places:
        hit = {(p["name"] or "").lower(), (p["edid"] or "").lower()} & named
        if hit:
            found |= hit
            dot(debug, w, h, p["pixel"][0], p["pixel"][1], 4, (220, 50, 40))
            print("  %-15s %-6s marker at %8.0f,%8.0f,%7.0f (%4.1f cells from the centre) -> pixel %5.1f,%5.1f, "
                  "ground %6.0f, %s" % (p["name"], p["markerType"], p["game"][0], p["game"][1], p["game"][2],
                                        math.hypot(p["game"][0] - bx, p["game"][1] - by) / CELL,
                                        p["pixel"][0], p["pixel"][1], p["ground"], "land" if p["onLand"] else "WATER"))
    for n in sorted(named - found):
        print("  %s: no place with that name inside the region" % n)
    dot(debug, w, h, px, py, 2, (60, 200, 255))
    write_png(os.path.join(args.out, args.name + "-debug.png"), w, h, debug)

    meta = {
        "world": desc, "worldEditorId": world.edid,
        "generated": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "generator": " ".join(["tools/realm-map/render.py"] + sys.argv[1:]),
        "landFrom": info["sources"],
        "cellUnits": CELL, "cellMin": [cx0, cy0], "cellMax": [cx1, cy1],
        "bounds": {"xMin": xmin, "xMax": xmax, "yMin": ymin, "yMax": ymax},
        "pixelsPerCell": args.ppc, "unitsPerPixel": upp, "width": w, "height": h,
        "affine": aff,
        "transform": "pixelX = a*gameX + b*gameY + c, pixelY = d*gameX + e*gameY + f; pixel (0,0) is the top-left "
                     "corner of the image, north (game +Y) is up, so gameX = xMin + pixelX*unitsPerPixel and "
                     "gameY = yMax - pixelY*unitsPerPixel",
        "heightRange": info["heightRange"], "defaultWater": world.default_water,
        "shading": {"azimuth": 315, "altitude": 45, "zFactor": args.zfactor, "ambient": args.ambient},
        "transparent": "cells with no LAND record (outside the worldspace's landscape) are fully transparent",
        "places": places,
    }
    with open(os.path.join(args.out, args.name + ".json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=1)
        f.write("\n")
    print("wrote %s (%d bytes), %s-debug.png, %s.json in %.1f s" % (
        png, os.path.getsize(png), args.name, args.name, (datetime.datetime.now() - t0).total_seconds()))
    return 0 if inside and on_land else 1


if __name__ == "__main__":
    sys.exit(main())
