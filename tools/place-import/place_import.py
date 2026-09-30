"""Bakes the Place tool's objects into a plugin as references (REFR), at the byte level, and proves nothing else changed.

    python place_import.py --plugin "<Data>/DragonBreak Online Edits.esp" --data "<Data>" \\
        --export placements-export.json --out "<Data>/DragonBreak Online Edits.new.esp" [--dry-run] [--report r.json]

placements-export.json is what /placeexport writes on the server: { placements: [{ base, name, kind,
cellOrWorldDesc, pos: [x, y, z], rot: [x, y, z] degrees, hostile }] }, descs in the server's form "hex:Plugin.esp".

Why not xEdit: an xEdit save re-serialises every record and has changed 93 unrelated ones in DragonBreak Online Edits.esp
(memory: xedit-resave-mutates-unrelated-records). Like add_records.py, this keeps every existing record byte for byte:
it reads the plugin's whole group tree, adds the new records and any groups they need, rewrites only group sizes and the
HEDR counters, and then compares every old record with the output.

What it places:
- objects (kind other than npc) whose base record's plugin is already a master of the target, or the target itself.
  A new master would shift the target's own form ids (memory: merging-into-dle-needs-sseedit), so a base from any other
  plugin is refused and reported.
- NPCs are skipped on purpose: the server spawns every living actor (memory: server-spawns-all-actors), so placed NPCs
  stay server zones (placed:* in NPC-Spawns.json).
- into the cell they stand in: an interior cell by its desc, a worldspace by the grid cell of the position (4096 units).
  A cell the target does not override yet is copied from the last of the target's masters that has it, with its form
  id fields moved to the target's master numbering (measured on 401 BSHeartland cells the target already overrides:
  LTMP XCWT XCAS XCCM XCIM XCMO XEZN XILL XLCN XOWN XCLR; everything else is plain data). A cell with any other
  subrecord is refused rather than guessed at. Blocks and sub-blocks follow the rules measured on all 911 cells of
  DragonBreak Online Edits.esp: interior block = local id % 10, sub-block = (local id // 10) % 10; exterior block =
  (gridY // 32, gridX // 32), sub-block = (gridY // 8, gridX // 8), each label two int16 with Y first.
- rotation: the server reads a reference's DATA rotation as radians * 180 / pi per axis (LocationalDataUtils.cpp), so
  the export's degrees are written back as degrees * pi / 180.

After a real import, the objects exist twice until the server's runtime copies are removed: remove them in the Place tab
(or with the ids in the report) once the new plugin is live.
"""
import sys, os, json, math, struct, zlib, argparse
HERE = os.path.dirname(os.path.abspath(__file__))

# ---- the group tree -------------------------------------------------------------------------------------------------
class Group:
    __slots__ = ('head', 'kids')
    def __init__(self, head, kids): self.head, self.kids = bytearray(head), kids
    @property
    def gtype(self): return struct.unpack_from('<i', self.head, 12)[0]
    @property
    def label(self): return bytes(self.head[8:12])
    def size(self): return 24 + sum(k.size() if isinstance(k, Group) else len(k) for k in self.kids)
    def emit(self, out):
        struct.pack_into('<I', self.head, 4, self.size())
        out += self.head
        for k in self.kids:
            if isinstance(k, Group): k.emit(out)
            else: out += k

def parse(buf, pos, end):
    kids = []
    while pos < end:
        sig, size = buf[pos:pos + 4], struct.unpack_from('<I', buf, pos + 4)[0]
        if sig == b'GRUP':
            kids.append(Group(buf[pos:pos + 24], parse(buf, pos + 24, pos + size))); pos += size
        else:
            kids.append(bytes(buf[pos:pos + 24 + size])); pos += 24 + size
    return kids

def rec_sig(r): return r[:4].decode('ascii', 'replace')
def rec_fid(r): return struct.unpack_from('<I', r, 12)[0]
def rec_body(r):
    flags = struct.unpack_from('<I', r, 8)[0]
    return zlib.decompress(r[28:]) if flags & 0x40000 else r[24:]
def subrecords(data):
    out, i = [], 0
    while i + 6 <= len(data):
        s, n = data[i:i + 4], struct.unpack_from('<H', data, i + 4)[0]
        if s == b'XXXX':
            big = struct.unpack_from('<I', data, i + 6)[0]; i += 10
            s, n = data[i:i + 4], big; out.append((s, data[i + 6:i + 6 + n])); i += 6 + n; continue
        out.append((s, data[i + 6:i + 6 + n])); i += 6 + n
    return out
def sub_bytes(pairs): return b''.join(s + struct.pack('<H', len(v)) + v for s, v in pairs)

# ---- a plugin -------------------------------------------------------------------------------------------------------
class Plugin:
    def __init__(self, path):
        self.path, self.name = path, os.path.basename(path)
        self.buf = open(path, 'rb').read()
        hsize = struct.unpack_from('<I', self.buf, 4)[0]
        self.tes4 = bytes(self.buf[:24 + hsize])
        self.flags = struct.unpack_from('<I', self.buf, 8)[0]
        self.masters = [bytes(v).rstrip(b'\0').decode('cp1252') for s, v in subrecords(self.tes4[24:]) if s == b'MAST']
        self.top = parse(self.buf, 24 + hsize, len(self.buf))
    def names(self): return [m.lower() for m in self.masters] + [self.name.lower()]
    def canon(self, fid):
        """(plugin name lowercased, local id) of a form id written in this file"""
        i = fid >> 24; n = self.names()
        return (n[i] if i < len(n) else n[-1], fid & 0xFFFFFF)

class Index:
    """A master read once, without building its tree: every record's offset by canon, and its exterior cells by grid"""
    def __init__(self, path):
        self.path, self.name = path, os.path.basename(path)
        self.buf = open(path, 'rb').read()
        hsize = struct.unpack_from('<I', self.buf, 4)[0]
        self.masters = [bytes(v).rstrip(b'\0').decode('cp1252') for s, v in subrecords(self.buf[24:24 + hsize]) if s == b'MAST']
        self.lmasters = [m.lower() for m in self.masters]
        self.recs, self.ext = {}, {}
        self._walk(24 + hsize, len(self.buf), None, 0)
    def canon(self, fid):
        i = fid >> 24; n = self.lmasters + [self.name.lower()]
        return (n[i] if i < len(n) else n[-1], fid & 0xFFFFFF)
    def _walk(self, pos, end, world, gtype):
        buf = self.buf
        while pos < end:
            sig, size = buf[pos:pos + 4], struct.unpack_from('<I', buf, pos + 4)[0]
            if sig == b'GRUP':
                gt = struct.unpack_from('<i', buf, pos + 12)[0]
                w = self.canon(struct.unpack_from('<I', buf, pos + 8)[0]) if gt == 1 else world
                self._walk(pos + 24, pos + size, w, gt); pos += size; continue
            fid = struct.unpack_from('<I', buf, pos + 12)[0]; c = self.canon(fid)
            self.recs[c] = (sig.decode('ascii', 'replace'), pos)
            if sig == b'CELL' and world and gtype == 5:
                for s, v in subrecords(rec_body(buf[pos:pos + 24 + size])):
                    if s == b'XCLC': gx, gy = struct.unpack_from('<ii', v, 0); self.ext[(world, gx, gy)] = c; break
            pos += 24 + size
    def record(self, canon):
        hit = self.recs.get(canon)
        if not hit: return None
        pos = hit[1]; size = struct.unpack_from('<I', self.buf, pos + 4)[0]
        return bytes(self.buf[pos:pos + 24 + size])

def walk(kids, path=()):
    """(record, enclosing groups) for every record under kids"""
    for k in kids:
        if isinstance(k, Group): yield from walk(k.kids, path + (k,))
        else: yield k, path

FORM_SUBS = {b'LTMP', b'XCWT', b'XCAS', b'XCCM', b'XCIM', b'XCMO', b'XEZN', b'XILL', b'XLCN', b'XOWN', b'XCLR'}
DATA_SUBS = {b'EDID', b'FULL', b'DATA', b'XCLC', b'XCLL', b'TVDT', b'MHDT', b'XCLW', b'XNAM', b'XWEM', b'XRNK', b'XWCN',
             b'XWCS', b'XWCU', b'LNAM'}
PLACEABLE = {'STAT', 'MSTT', 'FURN', 'CONT', 'ACTI', 'LIGH', 'MISC', 'WEAP', 'ARMO', 'BOOK', 'FLOR', 'TREE', 'DOOR', 'SCOL',
             'ALCH', 'INGR', 'KEYM', 'AMMO', 'SLGM', 'TACT', 'IDLM', 'SCRL', 'APPA', 'GRAS'}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--plugin', required=True); ap.add_argument('--data', required=True)
    ap.add_argument('--export', required=True); ap.add_argument('--out', required=True)
    ap.add_argument('--dry-run', action='store_true'); ap.add_argument('--report')
    a = ap.parse_args()
    T = Plugin(a.plugin)
    if T.flags & 0x80: sys.exit('target is localized; not supported')
    tnames = T.names(); own = len(T.masters)
    lower_masters = [m.lower() for m in T.masters]
    placements = json.load(open(a.export, encoding='utf-8'))['placements']
    report = {'imported': [], 'skipped': []}
    def skip(i, p, why):
        report['skipped'].append({'index': i, 'name': p.get('name'), 'base': p.get('base'), 'why': why}); print(f'  skip #{i} {p.get("name")}: {why}')

    # Masters are opened only when needed, from the Data folder
    cache = {}
    def master(name):
        k = name.lower()
        if k not in cache: cache[k] = Index(os.path.join(a.data, T.masters[lower_masters.index(k)]))
        return cache[k]
    def could_hold(name, plugin):
        """Whether a master can hold a copy of a form of plugin: it is that plugin, or has it as a master"""
        return name.lower() == plugin or plugin in master(name).lmasters
    def find_record(canon):
        """(master, record) of the winning copy of a form among the target's masters, last master first"""
        for name in reversed(T.masters):
            if not could_hold(name, canon[0]): continue
            r = master(name).record(canon)
            if r: return master(name), r
        return None
    def to_target(P, fid):
        c = P.canon(fid)
        return (tnames.index(c[0]) << 24) | c[1] if c[0] in tnames else None

    # The target's own index: cells by canon, each CELL's parent kid list, WRLD children groups by world canon
    cells = {}          # canon -> (kids list holding the CELL, index of the CELL in it)
    worlds = {}         # world canon -> type-1 group
    ext_cells = {}      # (world canon, gx, gy) -> canon of the cell
    def index(kids, world=None, gtype=0):
        for i, k in enumerate(kids):
            if isinstance(k, Group):
                w = world
                if k.gtype == 1:
                    w = T.canon(struct.unpack('<I', k.label)[0]); worlds[w] = k
                index(k.kids, w, k.gtype)
            elif rec_sig(k) == 'CELL':
                c = T.canon(rec_fid(k)); cells[c] = (kids, i)
                if not world or gtype != 5: continue      # the world's persistent cell carries a grid too
                for s, v in subrecords(rec_body(k)):
                    if s == b'XCLC': gx, gy = struct.unpack_from('<ii', v, 0); ext_cells[(world, gx, gy)] = c
    index(T.top)
    tail = next(r[16:24] for r, g in walk(T.top) if rec_sig(r) == 'REFR')

    hsize = struct.unpack_from('<I', T.buf, 4)[0]
    hpos = 24
    while T.buf[hpos:hpos + 4] != b'HEDR': hpos += 6 + struct.unpack_from('<H', T.buf, hpos + 4)[0]
    count, next_id = struct.unpack_from('<iI', T.buf, hpos + 10)
    used = {rec_fid(r) & 0xFFFFFF for r, g in walk(T.top) if rec_fid(r) >> 24 == own}
    new_records = new_groups = 0

    def new_group(label, gtype, like=None):
        nonlocal new_groups; new_groups += 1
        tail8 = like.head[16:24] if like is not None else b'\0' * 8
        return Group(b'GRUP' + struct.pack('<I', 24) + label + struct.pack('<i', gtype) + bytes(tail8), [])
    def child_group(kids, label, gtype):
        for k in kids:
            if isinstance(k, Group) and k.gtype == gtype and k.label == label: return k
        like = next((k for k in kids if isinstance(k, Group) and k.gtype == gtype), None)
        g = new_group(label, gtype, like); kids.append(g); return g

    def copy_cell(canon, world):
        """Adds an override of a master's cell to the target, in its block and sub-block; returns its canon or a reason"""
        nonlocal new_records
        hit = find_record(canon)
        if not hit: return None, f'cell {canon[1]:06x}:{canon[0]} is in none of the target masters'
        P, r = hit
        pairs = []
        for s, v in subrecords(rec_body(r)):
            if s in FORM_SUBS:
                vv = bytearray(v)
                for o in range(0, len(vv) - 3, 4):
                    f = struct.unpack_from('<I', vv, o)[0]
                    if f == 0: continue
                    t = to_target(P, f)
                    if t is None: return None, f'cell {canon[1]:06x}:{canon[0]} {s.decode()} names a form outside the target masters'
                    struct.pack_into('<I', vv, o, t)
                pairs.append((s, bytes(vv)))
            elif s in DATA_SUBS: pairs.append((s, bytes(v)))
            else: return None, f'cell {canon[1]:06x}:{canon[0]} has a {s.decode()} subrecord this importer does not know'
        body = sub_bytes(pairs)
        fid = (tnames.index(canon[0]) << 24) | canon[1]
        rec = b'CELL' + struct.pack('<III', len(body), struct.unpack_from('<I', r, 8)[0] & ~0x40000, fid) + r[16:24] + body
        new_records += 1
        if world is None:
            top = next((k for k in T.top if isinstance(k, Group) and k.label == b'CELL'), None)
            if top is None: return None, 'the target has no CELL group'
            block = child_group(top.kids, struct.pack('<i', canon[1] % 10), 2)
            sub = child_group(block.kids, struct.pack('<i', (canon[1] // 10) % 10), 3)
            holder = sub.kids
        else:
            gx, gy = next(struct.unpack_from('<ii', v, 0) for s, v in pairs if s == b'XCLC')
            wg = worlds.get(world)
            if wg is None: return None, f'the target does not override world {world[1]:06x}:{world[0]}'
            block = child_group(wg.kids, struct.pack('<hh', gy // 32, gx // 32), 4)
            sub = child_group(block.kids, struct.pack('<hh', gy // 8, gx // 8), 5)
            holder = sub.kids
            ext_cells[(world, gx, gy)] = canon
        holder.append(rec); cells[canon] = (holder, len(holder) - 1)
        return canon, None

    def master_ext_cell(world, gx, gy):
        for name in reversed(T.masters):
            if could_hold(name, world[0]) and (world, gx, gy) in master(name).ext: return master(name).ext[(world, gx, gy)]
        return None

    for i, p in enumerate(placements):
        if p.get('kind') == 'npc': skip(i, p, 'an NPC: placed NPCs stay server zones'); continue
        try:
            bh, bp = str(p['base']).split(':', 1); base = (bp.lower(), int(bh, 16))
            wh, wp = str(p['cellOrWorldDesc']).split(':', 1); where = (wp.lower(), int(wh, 16))
            pos = [float(x) for x in p['pos']]; rot = [float(x) for x in (p.get('rot') or [0, 0, 0])]
        except Exception as e: skip(i, p, f'unreadable entry ({e})'); continue
        if base[0] not in tnames: skip(i, p, f'base plugin {bp} is not a master of {T.name}'); continue
        bhit = None if base[0] == T.name.lower() else find_record(base)
        if base[0] != T.name.lower():
            if not bhit: skip(i, p, f'base {p["base"]} not found'); continue
            if rec_sig(bhit[1]) not in PLACEABLE: skip(i, p, f'base {p["base"]} is a {rec_sig(bhit[1])}, not a placeable object'); continue
        # The cell: an interior by its desc, a worldspace by the grid cell of the position
        wrec = None if where in worlds or where in cells else find_record(where)
        if where in worlds or (wrec and rec_sig(wrec[1]) == 'WRLD'):
            gx, gy = math.floor(pos[0] / 4096), math.floor(pos[1] / 4096)
            cell = ext_cells.get((where, gx, gy))
            if cell is None:
                mc = master_ext_cell(where, gx, gy)
                if mc is None: skip(i, p, f'no cell at grid {gx},{gy} of world {p["cellOrWorldDesc"]}'); continue
                cell, why = copy_cell(mc, where)
                if why: skip(i, p, why); continue
        else:
            cell = where
            if cell not in cells:
                cell, why = copy_cell(where, None)
                if why: skip(i, p, why); continue
        kids, ci = cells[cell]
        cfid = rec_fid(kids[ci])
        # The cell's children group follows the CELL record; references go in its temporary group
        nxt = kids[ci + 1] if ci + 1 < len(kids) else None
        if not (isinstance(nxt, Group) and nxt.gtype == 6 and struct.unpack('<I', nxt.label)[0] == cfid):
            nxt = new_group(struct.pack('<I', cfid), 6); kids.insert(ci + 1, nxt)
            for c2, (k2, i2) in list(cells.items()):
                if k2 is kids and i2 > ci: cells[c2] = (k2, i2 + 1)
        temp = child_group(nxt.kids, struct.pack('<I', cfid), 9)
        while next_id in used: next_id += 1
        fid = (own << 24) | next_id; used.add(next_id); next_id += 1
        bfid = (tnames.index(base[0]) << 24) | base[1]
        data = struct.pack('<6f', *pos, *[math.radians(x) for x in rot])
        body = sub_bytes([(b'NAME', struct.pack('<I', bfid)), (b'DATA', data)])
        temp.kids.append(b'REFR' + struct.pack('<III', len(body), 0, fid) + tail + body)
        new_records += 1
        report['imported'].append({'index': i, 'name': p.get('name'), 'ref': f'{fid & 0xFFFFFF:x}:{T.name}', 'cell': f'{cell[1]:x}:{cell[0]}'})
        print(f'  #{i} {p.get("name")} -> REFR {fid:08x} in cell {cell[1]:06x}:{cell[0]}')

    out = bytearray(T.tes4)
    struct.pack_into('<iI', out, hpos + 10, count + new_records + new_groups, next_id)
    for k in T.top:
        if isinstance(k, Group): k.emit(out)
        else: out += k
    print(f'{len(report["imported"])} imported, {len(report["skipped"])} skipped, {new_records} new records, {new_groups} new groups')
    if a.report: json.dump(report, open(a.report, 'w', encoding='utf-8'), indent=1)
    if a.dry_run: print('dry run, nothing written'); return report

    open(a.out, 'wb').write(out)
    # Proof: every record the target had is byte-identical, the new ones are all that was added, and the file walks
    before = {(rec_sig(r), rec_fid(r)): r for r, g in walk(Plugin(a.plugin).top)}
    after_p = Plugin(a.out)
    after = {}
    for r, g in walk(after_p.top): after[(rec_sig(r), rec_fid(r))] = r
    changed = [k for k in before if after.get(k) != before[k]]
    extra = [k for k in after if k not in before]
    if changed or len(extra) != new_records:
        sys.exit(f'VERIFY FAILED: {len(changed)} changed, {len(extra)} added (expected {new_records})')
    print(f'ok: {len(before)} records unchanged, {new_records} added, {new_groups} new group(s), next id {next_id:06x}')
    return report

if __name__ == '__main__':
    main()
