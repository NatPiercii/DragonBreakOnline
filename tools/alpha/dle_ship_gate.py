#!/usr/bin/env python3
"""The ship gate for a DragonBreak Online Edits.esp from the PC: every build is checked the same way before install.

    python3 tools/alpha/dle_ship_gate.py <new esp> [--live <esp>] [--spawns owned-spawns.json]

--live defaults to the installed /opt/skyrim-data copy. Exit 0 with "ok" lines, or 1 with one line per failure.
The PC's source esp has repeatedly come without patches made on CT 115 (memory pc-dle-builds-drop-server-side-patches),
so each check is one of those, or an anchor a player in Bruma cannot do without (docs/alpha/bruma-anchors.md):
  border      the border REGN 0B0CBCDD override is there at 214 bytes (18 points) and the live polygon (the same points
              in either winding; every other field byte-identical), and the set
              of border cells (WRLD cells whose XCLR names it) is the live set: any added or removed cell is listed
  spawns      the 21 living ACHRs the server spawns itself (Dusk Thorn goblins, the v5 boars) are Initially Disabled
              and Dusk Thorn's chest is there (dle-v5-gate); then tools/spawns/spawns_gate.py on owned-spawns.json
  markers     one enabled map marker each for Aleswell and Fort Caractacus (two made both towns show twice)
  schools     the ClassLectern and StudyMagic activators, and no fewer of their references than live has
  anchors     the references a Bruma system rests on alone (the loom, the bank, the notice board, Dibella, Auri-El,
              each Daedric shrine): present, not deleted, not disabled, on the same base
  manuals     every DBO_BookManual* BOOK has DATA flags 0: TeachesSpell (0x04) would let the engine hand over the
              marker and eat the book on a read, around the tier gate
Records are this file's own by local id (master index = its master count), so a build that gains a master still matches.
"""
import argparse, os, struct, subprocess, sys, zlib

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.abspath(os.path.join(HERE, '..', '..'))
sys.path.insert(0, os.environ.get('ESPLIB_DIR', os.path.expanduser('~nate/dragonbreak/ck-mcp')))
import esplib  # noqa: E402
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import navi_info  # noqa: E402

BORDER = ('bsheartland.esm', 0xCBCDD)
NAVI = ('skyrim.esm', 0x012FB4)       # the navmesh info map
BORDER_SIZE = 214
DELETED, DISABLED = 0x20, 0x800
CHEST = 0x154079
LIVING = [0x154071, 0x154072, 0x154073, 0x154074, 0x154075, 0x154076, 0x154077, 0x154078,          # goblins
          0x15404F, 0x154051, 0x154052, 0x154055, 0x154056, 0x15405D, 0x15405E, 0x154063, 0x154064,  # boars
          0x154069, 0x15406A, 0x15406F, 0x154070]
MARKERS = {'Aleswell': ('aleswell',), 'Fort Caractacus': ('caractacus', 'caracatus')}
# the single-reference anchors (bruma-anchors.md, 30 Sep): (plugin, local id, base editor id, what)
ANCHORS = [
    ('dragonbreak online edits.esp', 0x12AE20, 'MCECraftingLoomMarker', "the loom (Tailor's only station)"),
    ('dragonbreak online edits.esp', 0x1300C3, 'TheBank', 'the bank'),
    ('dragonbreak online edits.esp', 0x1164C7, 'manny_up_NoticeBoardActivator', 'the notice board'),
    ('bsheartland.esm', 0x0012F3, 'ShrineofDibella', "Dibella's shrine"),
    ('dragonbreak online edits.esp', 0x12AE03, 'DLC1ShrineofAuriel', "Auri-El's shrine"),
] + [('dragonbreak online edits.esp', lid, edid, f'the shrine of {who}') for lid, edid, who in [
    (0x125BF7, 'ShrineOfMalacath', 'Malacath'), (0x125BC9, 'DBO_ShrineOfAzura', 'Azura'),
    (0x125BFB, 'DBO_ShrineOfBoethiah', 'Boethiah'), (0x125BCB, 'DBO_ShrineOfMephala', 'Mephala'),
    (0x125BE2, 'DBO_ShrineOfMehrunesDagon', 'Mehrunes Dagon'), (0x125BCC, 'DBO_ShrineOfMolagBal', 'Molag Bal'),
    (0x125BD2, 'DBO_ShrineOfNocturnal', 'Nocturnal'), (0x125BCA, 'DBO_ShrineOfHircine', 'Hircine'),
    (0x125BF8, 'DA09MeridiaStatue', 'Meridia'), (0x125BD4, 'DBO_ShrineOfSanguine', 'Sanguine'),
    (0x125BD5, 'DBO_ShrineOfSheogorath', 'Sheogorath'), (0x125BF9, 'DA03ClavicusVileShrine', 'Clavicus Vile'),
    (0x125BCD, 'DBO_ShrineOfHermaeusMora', 'Hermaeus Mora'), (0x125BCF, 'DBO_ShrineOfNamira', 'Namira'),
    (0x125BD3, 'DBO_ShrineOfPeryite', 'Peryite'), (0x125BD6, 'DBO_ShrineOfVaermina', 'Vaermina')]]


# REGN subrecords that hold a form id: compared by (plugin, local id), since a plugin saved with its masters in
# another order numbers the same worldspace differently (DLE v9 moved BSHeartland from master 11 to 6)
REGN_FORM_IDS = (b'WNAM',)


def same_region(a, b, norm_a=None, norm_b=None):
    """The same border: every subrecord byte-identical except RPLD, whose points must be the same polygon - the same
    cycle, from any start, in either direction (DLE v8 came with v4's 18 points wound the other way round), and the
    form-id subrecords, which must name the same record through each file's own master list"""
    if [x for x, _ in a] != [x for x, _ in b]:
        return False
    for (s1, v1), (s2, v2) in zip(a, b):
        if s1 in REGN_FORM_IDS and norm_a and norm_b and len(v1) == len(v2) == 4:
            if norm_a(struct.unpack('<I', v1)[0]) != norm_b(struct.unpack('<I', v2)[0]):
                return False
            continue
        if s1 != b'RPLD':
            if v1 != v2:
                return False
            continue
        p = [v1[i:i + 8] for i in range(0, len(v1), 8)]
        q = [v2[i:i + 8] for i in range(0, len(v2), 8)]
        if len(p) != len(q) or not p:
            return False
        rotations = lambda pts: [pts[i:] + pts[:i] for i in range(len(pts))]
        if q not in rotations(p) and q not in rotations(p[::-1]):
            return False
    return True


class Esp:
    def __init__(self, path):
        self.path = path
        self.p = esplib.Plugin(path)
        self.fh = open(path, 'rb')
        self.own = len(self.p.masters)
        self.rec = {}                     # (source plugin, local id) -> (type, flags, off, size)
        for t, fid, fl, off, sz, ctx in self.p.index:
            s, loc = self.p.modindex_source(fid)
            if s:
                self.rec[(s.lower(), loc & 0xFFFFFF)] = (t, fl, off, sz)
        self.me = self.p.key

    def norm(self, fid):
        """A form id by name: (master, local id), or ('self', local id) for the file's own records, so a candidate
        under another file name compares the same (review G5)"""
        if fid >> 24 >= len(self.p.masters):
            return ('self', fid & 0xFFFFFF)
        s, loc = self.p.modindex_source(fid)
        return ((s or '?').lower(), loc & 0xFFFFFF)

    def subs(self, k):
        t, fl, off, sz = self.rec[k]
        return list(esplib.subrecords(self.p.data_at(self.fh, off, sz, fl)))

    def raw(self, k):
        t, fl, off, sz = self.rec[k]
        self.fh.seek(off)
        return self.fh.read(sz)

    def edid(self, k):
        return (dict(self.subs(k)).get(b'EDID', b'').rstrip(b'\0')).decode('cp1252', 'replace') if k in self.rec else ''

    def ref_base(self, k):
        n = dict(self.subs(k)).get(b'NAME')
        if not n:
            return None
        s, loc = self.p.modindex_source(struct.unpack('<I', n[:4])[0])
        return (s.lower(), loc & 0xFFFFFF) if s else None

    def own_of(self, t, edid):
        return [k for k, v in self.rec.items() if v[0] == t and k[0] == self.me and self.edid(k) == edid]

    def border_cells(self):
        out = set()
        for k, (t, fl, off, sz) in self.rec.items():
            if t != 'CELL':
                continue
            for s, v in self.subs(k):
                if s == b'XCLR' and any((x & 0xFFFFFF) == BORDER[1] for x in struct.unpack_from('<%dI' % (len(v) // 4), v)):
                    out.add(k)
                    break
        return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('esp')
    ap.add_argument('--live', default='/opt/skyrim-data/DragonBreak Online Edits.esp')
    ap.add_argument('--spawns', default=os.path.join(SERVER, 'owned-spawns.json'))
    ap.add_argument('--allow-navi', action='store_true', help='this build edits navmeshes on purpose: report navmesh-info differences without failing')
    a = ap.parse_args()
    fails, oks = [], []
    try:
        new, live = Esp(a.esp), Esp(a.live)
    except Exception as e:
        print(f'FAIL cannot read the plugins: {e}')
        return 1
    me = new.me

    # ---- border ------------------------------------------------------------------------------------------------------
    r = new.rec.get(BORDER)
    if not r or r[0] != 'REGN':
        fails.append('border: no REGN 0B0CBCDD override (the Bruma border) in this file')
    elif r[1] & DELETED:
        fails.append('border: REGN 0B0CBCDD is deleted')
    else:
        if r[3] != BORDER_SIZE:
            fails.append(f'border: REGN 0B0CBCDD is {r[3]} bytes, want {BORDER_SIZE} (border v4, 18 points)')
        if BORDER in live.rec and not same_region(new.subs(BORDER), live.subs(BORDER), new.norm, live.norm):
            fails.append('border: REGN 0B0CBCDD is not the live border (points, or another field, differ)')
    bn, bl = new.border_cells(), live.border_cells()
    fmt = lambda ks: ', '.join('%06X %s' % (k[1], new.edid(k) or live.edid(k)) for k in sorted(ks)[:12]) + (' ...' if len(ks) > 12 else '')
    if bn - bl:
        fails.append(f'border: {len(bn - bl)} border cell(s) not in live: {fmt(bn - bl)}')
    if bl - bn:
        fails.append(f'border: {len(bl - bn)} live border cell(s) missing: {fmt(bl - bn)}')
    if not fails:
        oks.append(f'border: REGN 0B0CBCDD {BORDER_SIZE} bytes as live, {len(bn)} border cells as live')

    # ---- spawns ------------------------------------------------------------------------------------------------------
    n0 = len(fails)
    chest = new.rec.get((me, CHEST))
    if not chest or chest[0] != 'REFR' or chest[1] & DELETED:
        fails.append(f'spawns: Dusk Thorn camp chest {new.own:02X}{CHEST:06X} missing')
    gone = [x for x in LIVING if new.rec.get((me, x), ('',))[0] != 'ACHR']
    on = [x for x in LIVING if x not in gone and not new.rec[(me, x)][1] & DISABLED]
    if gone:
        fails.append(f'spawns: {len(gone)} server-spawned ACHR(s) missing: ' + ', '.join(f'{new.own:02X}{x:06X}' for x in gone))
    if on:
        fails.append(f'spawns: {len(on)} of {len(LIVING)} server-spawned ACHRs lack Initially Disabled (0x800): '
                     + ', '.join(f'{new.own:02X}{x:06X}' for x in on) + ' (flip a copy with /tmp/claude-nate-v7flag/flip.py)')
    sg = subprocess.run([sys.executable, os.path.join(SERVER, 'tools', 'spawns', 'spawns_gate.py'), '--spawns', a.spawns,
                         '--replace', f'DragonBreak Online Edits.esp={a.esp}'], capture_output=True, text=True)
    line = (sg.stdout.strip().splitlines() or [sg.stderr.strip()])[-1]
    if sg.returncode:
        fails.append(f'spawns: owned-spawns.json: {line}')
    if len(fails) == n0:
        oks.append(f'spawns: the {len(LIVING)} server-spawned ACHRs Initially Disabled, camp chest present; {line}')

    # ---- markers -----------------------------------------------------------------------------------------------------
    n0 = len(fails)
    found = {m: [] for m in MARKERS}
    for k, (t, fl, off, sz) in new.rec.items():
        if t != 'REFR' or fl & (DELETED | DISABLED):
            continue
        subs = new.subs(k)
        seen = False
        for s, v in subs:
            if s == b'XMRK':
                seen = True
            elif seen and s == b'FULL':
                nm = v.rstrip(b'\0').decode('cp1252', 'replace').lower()
                for m, keys in MARKERS.items():
                    if any(x in nm for x in keys):
                        found[m].append(k)
                break
    for m, ks in found.items():
        if len(ks) != 1:
            fails.append(f'markers: {len(ks)} enabled map marker(s) for {m} in this file, want exactly 1'
                         + (': ' + ', '.join('%06X' % k[1] for k in ks) if ks else ''))
    if len(fails) == n0:
        oks.append('markers: one each for ' + ', '.join(f"{m} {found[m][0][1]:06X}" for m in MARKERS))

    # ---- schools -----------------------------------------------------------------------------------------------------
    n0 = len(fails)
    for edid in ('ClassLectern', 'StudyMagic'):
        def count(e):
            bases = set(e.own_of('ACTI', edid))
            return bases, sum(1 for k, v in e.rec.items() if v[0] == 'REFR' and not v[1] & (DELETED | DISABLED) and e.ref_base(k) in bases)
        nb, nc = count(new)
        lb, lc = count(live)
        if lb and not nb:
            fails.append(f'schools: the {edid} activator is gone (live has it)')
        elif nc < lc:
            fails.append(f'schools: {nc} {edid} reference(s), live has {lc}')
        else:
            oks.append(f'schools: {edid} ' + (f'{nc} reference(s) (live {lc})' if nb else 'not in this file, nor in live'))

    # ---- anchors -----------------------------------------------------------------------------------------------------
    n0 = len(fails)
    for plugin, lid, base, what in ANCHORS:
        k = (plugin, lid)
        if plugin == me and k not in new.rec:
            fails.append(f'anchors: {what} ({lid:06X}) is gone')
            continue
        if k not in new.rec:
            continue                      # a master's reference this file does not touch
        t, fl = new.rec[k][:2]
        if fl & DELETED:
            fails.append(f'anchors: {what} ({lid:06X}) is deleted')
        elif fl & DISABLED:
            fails.append(f'anchors: {what} ({lid:06X}) is Initially Disabled')
        else:
            b = new.ref_base(k)
            e = new.edid(b) if b in new.rec else (live.edid(b) if b in live.rec else '')
            if b and e and e != base:
                fails.append(f'anchors: {what} ({lid:06X}) now stands on {e}, not {base}')
    if len(fails) == n0:
        oks.append(f'anchors: all {len(ANCHORS)} single-reference anchors present and enabled')

    # ---- manuals -----------------------------------------------------------------------------------------------------
    books = [k for k, v in new.rec.items() if v[0] == 'BOOK' and k[0] == me and new.edid(k).startswith('DBO_BookManual')]
    bad = []
    for k in books:
        d = dict(new.subs(k)).get(b'DATA', b'')
        if len(d) < 1 or d[0] != 0:
            bad.append(f"{new.edid(k)} flags {d[0]:#04x}" if d else f'{new.edid(k)} has no DATA')
    if bad:
        fails.append('manuals: DATA flags must be 0 (0x04 TeachesSpell hands the marker over on a read): ' + ', '.join(bad))
    else:
        oks.append(f'manuals: {len(books)} DBO_BookManual book(s), DATA flags 0' if books else 'manuals: none in this file yet')

    # ---- navmesh info map -------------------------------------------------------------------------------------------
    # NAVI 00012FB4 lists every navmesh's links (merges, doors, its cell). A Creation Kit re-save with other plugins loaded
    # drops entries for other mods' towns (DLE v9: 217 gone), which breaks NPC pathing between cells there. Entries are
    # compared by navmesh, every form id resolved through each file's own master list.
    n0 = len(fails)
    try:
        nl = live.rec.get(NAVI); nn = new.rec.get(NAVI)
        if nl and not nn:
            fails.append('navmesh info: live has NAVI 00012FB4 and this file has none')
        elif nl and nn:
            le, lp = navi_info.resolved(live.subs(NAVI), live.norm)
            ne, np_ = navi_info.resolved(new.subs(NAVI), new.norm)
            c = navi_info.compare(le, ne, lp, np_)
            show = lambda ks: ', '.join('%s %06X' % k for k in sorted(ks)[:8]) + (' ...' if len(ks) > 8 else '')
            plural = lambda n, one, many: f'{n} {one if n == 1 else many}'
            msgs = []
            if c['missing']:
                msgs.append(f"{plural(len(c['missing']), 'live entry', 'live entries')} missing: {show(c['missing'])}")
            if c['relinked']:
                by = {}
                for k, names in c['relinked'].items():
                    for n in names:
                        by.setdefault(n, []).append(k)
                msgs.append(f"{plural(len(c['relinked']), 'entry', 'entries')} with other links ("
                            + '; '.join(f'{n}: {show(ks)}' for n, ks in sorted(by.items())) + ')')
            if c['flipped']:
                msgs.append(f"{plural(len(c['flipped']), 'entry', 'entries')} with the Is Island flag flipped: {show(c['flipped'])}")
            if c['nvppMoved']:
                msgs.append('the preferred pathing (NVPP) names other navmeshes or triangles')
            # Everything else is reported by field, not failed: a CK save recomputes island data, and NVPP's order
            notes = [f'{len(ks)} with other {name}' for name, ks in sorted(c['notes'].items())] + \
                    (['NVPP in another order'] if c['nvppOrder'] else []) + ([f"{len(c['extra'])} new"] if c['extra'] else [])
            present = len(le) - len(c['missing'])
            if msgs and not a.allow_navi:
                fails.append('navmesh info: ' + '; '.join(msgs) + ' (a Creation Kit re-save? rebuild with live\'s NAVI, or --allow-navi if this build edits navmeshes)')
            else:
                oks.append(f'navmesh info: {present} of {len(le)} live entries present'
                           + (' with their links' if not c['relinked'] else '')
                           + (' (' + ', '.join(notes) + ')' if notes else '')
                           + (' (--allow-navi: ' + '; '.join(msgs) + ')' if msgs else ''))
    except navi_info.Bad as e:
        fails.append(f'navmesh info: NAVI 00012FB4 does not parse ({e})')

    for o in oks:
        print('ok  ', o)
    for f in fails:
        print('FAIL', f)
    print(f"{'PASS' if not fails else 'FAIL'}: {a.esp} against {a.live}")
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
