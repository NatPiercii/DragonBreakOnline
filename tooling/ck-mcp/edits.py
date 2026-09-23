"""
edits.py - safe write operations.

Every write goes through apply(): backup -> mutate -> verify -> commit.
If verification fails the file on disk is never touched.

Verification is not optional. During the Aug 2026 audit three real mistakes were
caught only because output was checked against a backup afterwards:
  - a skip-list that omitted MODS, leaving 3 dangling texture references
  - a raw-FormID comparison across plugins with different master orders
  - sed converting CRLF to LF across an entire config file
The checks below encode those lessons.
"""
import os, struct, shutil, datetime, collections
import esplib, tree


class EditError(Exception):
    pass


def _backup(path, backup_dir):
    os.makedirs(backup_dir, exist_ok=True)
    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    dst = os.path.join(backup_dir, "%s.%s.bak" % (os.path.basename(path), stamp))
    shutil.copy2(path, dst)
    return dst


def _index(buf):
    """(type, formid) -> (flags, body bytes) for every record, plus group count"""
    hsize = struct.unpack_from('<I', buf, 4)[0]
    out, groups = {}, [0]

    def walk(pos, end):
        while pos < end:
            sig = buf[pos:pos + 4]
            size = struct.unpack_from('<I', buf, pos + 4)[0]
            if sig == b'GRUP':
                groups[0] += 1
                walk(pos + 24, pos + size)
                pos += size
            else:
                fl = struct.unpack_from('<I', buf, pos + 8)[0]
                fid = struct.unpack_from('<I', buf, pos + 12)[0]
                out[(sig.decode('ascii', 'replace'), fid)] = (fl, bytes(buf[pos + 24:pos + 24 + size]))
                pos += 24 + size
    walk(24 + hsize, len(buf))
    return out, groups[0]


def _hedr(head, delta):
    hs = struct.unpack_from('<I', head, 4)[0]
    k = 24
    while k + 6 <= 24 + hs:
        sg = head[k:k + 4]
        size = struct.unpack_from('<H', head, k + 4)[0]
        k += 6
        if sg == b'HEDR':
            old = struct.unpack_from('<i', head, k + 4)[0]
            struct.pack_into('<i', head, k + 4, old + delta)
            return old, old + delta
        k += size
    return None, None


def apply(path, mutate, backup_dir, dry_run=False, expect=None):
    """
    mutate(head, nodes) -> dict describing what it did, including
        {"record_delta": int}  if records were added/removed.

    Returns a report. Nothing is written when dry_run is set or verification fails.
    """
    original = open(path, 'rb').read()
    head, nodes = tree.parse(original)
    if tree.serialize(head, nodes) != original:
        raise EditError("parser round-trip failed on %s - refusing to write" % path)

    result = mutate(head, nodes) or {}
    delta = result.pop("record_delta", 0)
    if delta:
        result["hedr"] = _hedr(head, delta)
    out = tree.serialize(head, nodes)

    before, gbefore = _index(original)
    after, gafter = _index(out)
    added = sorted("%s %08X" % k for k in set(after) - set(before))
    removed = sorted("%s %08X" % k for k in set(before) - set(after))
    flag_changed, body_changed = [], []
    for k in set(before) & set(after):
        if before[k][0] != after[k][0]:
            flag_changed.append("%s %08X" % k)
        elif before[k][1] != after[k][1]:
            body_changed.append("%s %08X" % k)

    op = esplib.Plugin(path)
    verify = {
        "masters_unchanged": True,
        "records_added": len(added), "records_removed": len(removed),
        "flags_changed": len(flag_changed), "bodies_changed": len(body_changed),
        "size_before": len(original), "size_after": len(out),
    }
    problems = []

    tmp = path + ".ckmcp-tmp"
    open(tmp, 'wb').write(out)
    try:
        np = esplib.Plugin(tmp)
        if np.masters != op.masters:
            problems.append("master list changed")
            verify["masters_unchanged"] = False
        declared = np.hedr[1] if np.hedr else None
        actual = len(np.index) + gafter
        verify["hedr_count"] = declared
        verify["hedr_matches"] = (declared == actual)
        if declared != actual:
            problems.append("HEDR count %s does not match %d records + %d groups"
                            % (declared, len(np.index), gafter))
        if expect:
            for key, want in expect.items():
                got = verify.get(key)
                if got != want:
                    problems.append("expected %s=%s but got %s" % (key, want, got))
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)

    report = {"plugin": os.path.basename(path), "dry_run": dry_run,
              "verification": verify, "problems": problems,
              "added": added[:40], "removed": removed[:40],
              **result}

    if problems:
        report["written"] = False
        report["reason"] = "verification failed - file left untouched"
        return report
    if dry_run:
        report["written"] = False
        report["reason"] = "dry run"
        return report

    report["backup"] = _backup(path, backup_dir)
    open(path, 'wb').write(out)
    report["written"] = True
    return report


# ---------------------------------------------------------------- operations

def set_flags(lo, plugin, ids, set_flags=(), clear_flags=(), backup_dir=".", dry_run=False):
    p = lo.plugin(plugin)
    ids = [lo.normalize_id(i) for i in ids]
    targets = {lo.raw(p, i) for i in ids}
    sm = sum(lo.FLAGS[f] for f in set_flags)
    cm = sum(lo.FLAGS[f] for f in clear_flags)

    def mutate(head, nodes):
        n = 0
        for nd in tree.walk_records(nodes):
            fid = struct.unpack_from('<I', nd[1], 12)[0]
            if fid not in targets:
                continue
            fl = struct.unpack_from('<I', nd[1], 8)[0]
            struct.pack_into('<I', nd[1], 8, (fl | sm) & ~cm)
            n += 1
        return {"records_matched": n, "records_requested": len(targets)}
    return apply(p.path, mutate, backup_dir, dry_run)


def undelete_and_disable(lo, plugin, ids=None, backup_dir=".", dry_run=False):
    """The standard UDR fix: clear Deleted, set Initially Disabled, restore position.

    Deleted records usually have no DATA of their own, so position is taken from
    the version this record overrides.
    """
    p = lo.plugin(plugin)
    want = {lo.normalize_id(i) for i in ids} if ids else {lo.canon(p, fid) for _, t, fid, fl, o, s, c
                                 in lo.records(p) if fl & esplib.DEL}
    pos = {}
    for q in lo.plugins:
        if q.load_index >= p.load_index:
            continue
        for _, t, fid, fl, off, sz, ctx in lo.records(q, ('REFR', 'ACHR')):
            cid = lo.canon(q, fid)
            if cid not in want:
                continue
            sub = lo.subrecords(q, off, sz, fl)
            if len(sub.get(b'DATA', b'')) >= 24:
                pos[cid] = sub[b'DATA'][:24]
    targets = {lo.raw(p, i): i for i in want}

    def mutate(head, nodes):
        fixed, skipped = 0, []
        for nd in tree.walk_records(nodes):
            fl = struct.unpack_from('<I', nd[1], 8)[0]
            fid = struct.unpack_from('<I', nd[1], 12)[0]
            if not (fl & 0x20) or fid not in targets:
                continue
            cid = targets[fid]
            old = {s: bytes(v) for s, v in esplib.subrecords(bytes(nd[2]))}
            data = old.get(b'DATA') or pos.get(cid)
            if data is None:
                skipped.append(cid)
                continue
            body = bytearray()

            def add(tag, val):
                body.extend(tag); body.extend(struct.pack('<H', len(val))); body.extend(val)
            for tag in (b'EDID', b'VMAD'):
                if tag in old:
                    add(tag, old[tag])
            if b'NAME' in old:
                add(b'NAME', old[b'NAME'])
            for tag, v in old.items():
                if tag in (b'EDID', b'VMAD', b'NAME', b'DATA'):
                    continue
                add(tag, v)
            add(b'DATA', data)
            nd[2] = body
            struct.pack_into('<I', nd[1], 8, (fl & ~0x20) | 0x800)
            fixed += 1
        return {"undeleted": fixed, "skipped_no_position": skipped}
    return apply(p.path, mutate, backup_dir, dry_run,
                 expect={"records_added": 0, "records_removed": 0})


def restore_position(lo, plugin, ids, backup_dir=".", dry_run=False):
    """Repair references whose DATA (position+rotation) has been zeroed.

    An override that carries an all-zero DATA wins the conflict and drags the object
    to its cell origin. The true transform is taken from the version this record
    overrides. DATA is always 24 bytes, so this patches in place - no record grows.

    Only records whose DATA is CURRENTLY all zeros are touched. A record with a real
    position is never modified, even if it is in the id list.
    """
    p = lo.plugin(plugin)
    want = {lo.normalize_id(i) for i in ids}
    ZERO = struct.pack('<6f', 0, 0, 0, 0, 0, 0)
    src = {}
    for q in lo.plugins:
        if q.load_index >= p.load_index:
            continue
        for _, t, fid, fl, off, sz, ctx in lo.records(q, ('REFR', 'ACHR')):
            cid = lo.canon(q, fid)
            if cid not in want:
                continue
            sub = lo.subrecords(q, off, sz, fl)
            d = sub.get(b'DATA', b'')
            if len(d) >= 24 and d[:24] != ZERO:
                src[cid] = (d[:24], q.name)
    targets = {}
    for i in want:
        try:
            targets[lo.raw(p, i)] = i
        except Exception:
            pass

    def mutate(head, nodes):
        fixed, no_source, not_zero = 0, [], 0
        for nd in tree.walk_records(nodes):
            fid = struct.unpack_from('<I', nd[1], 12)[0]
            if fid not in targets:
                continue
            cid = targets[fid]
            body = bytearray(); hit = False
            for sg, v in esplib.subrecords(bytes(nd[2])):
                v = bytearray(v)
                if sg == b'DATA' and len(v) >= 24:
                    if bytes(v[:24]) != ZERO:
                        not_zero += 1
                    elif cid not in src:
                        no_source.append(cid)
                    else:
                        v[:24] = src[cid][0]; hit = True
                body += sg + struct.pack('<H', len(v)) + v
            if hit:
                nd[2] = body; fixed += 1
        return {"positions_restored": fixed, "no_source_version": no_source[:20],
                "no_source_count": len(no_source), "skipped_not_zeroed": not_zero}
    return apply(p.path, mutate, backup_dir, dry_run,
                 expect={"records_added": 0, "records_removed": 0, "flags_changed": 0})


def edit_subrecords(lo, plugin, ids, drop=(), set_flags=(), clear_flags=(),
                    backup_dir=".", dry_run=False):
    """Remove named subrecords from specific records, and/or change header flags.

    Needed because some upstream fixes are not a flag alone. Disabling a reference
    that still carries an XESP does nothing at runtime - the enable parent drives
    its state - so matching a USSEP-style disable means dropping XESP as well.
    """
    p = lo.plugin(plugin)
    want = {lo.normalize_id(i) for i in ids}
    drop = {d if isinstance(d, bytes) else d.encode() for d in drop}
    sm = sum(lo.FLAGS[f] for f in set_flags)
    cm = sum(lo.FLAGS[f] for f in clear_flags)
    targets = {}
    for i in want:
        try:
            targets[lo.raw(p, i)] = i
        except Exception:
            pass

    def mutate(head, nodes):
        touched, removed = 0, collections.Counter()
        for nd in tree.walk_records(nodes):
            fid = struct.unpack_from('<I', nd[1], 12)[0]
            if fid not in targets:
                continue
            body = bytearray(); changed = False
            for sg, v in esplib.subrecords(bytes(nd[2])):
                if sg in drop:
                    removed[sg.decode()] += 1; changed = True
                    continue
                body += sg + struct.pack('<H', len(v)) + bytes(v)
            fl = struct.unpack_from('<I', nd[1], 8)[0]
            nf = (fl | sm) & ~cm
            if nf != fl:
                struct.pack_into('<I', nd[1], 8, nf); changed = True
            if changed:
                nd[2] = body; touched += 1
        return {"records_touched": touched, "subrecords_removed": dict(removed),
                "records_requested": len(targets)}
    return apply(p.path, mutate, backup_dir, dry_run,
                 expect={"records_added": 0, "records_removed": 0})


def insert_refs(lo, plugin, specs, backup_dir=".", dry_run=False):
    """Create new REFR records.

    specs: [{"base": canonical, "cell": canonical, "pos":[x,y,z],
             "rot":[x,y,z] radians, "scale": float}]

    New records go into the target cell's temporary-children group (type 9), which
    is where placed statics live. FormIDs are allocated above the plugin's highest
    existing local id. The record header's version bytes are copied from a sibling
    so the new records match what the CK writes.
    """
    p = lo.plugin(plugin)
    own = len(p.masters)
    high = 0
    for t, fid, fl, off, sz, ctx in p.index:
        src, loc = p.modindex_source(fid)
        if src == p.key and loc > high:
            high = loc
    made = []

    def mutate(head, nodes):
        # a sibling REFR header supplies the trailing version bytes
        vers = bytes([0,0,0,0,44,0,0,0])
        for nd in tree.walk_records(nodes):
            if nd[1][0:4] == b'REFR':
                vers = bytes(nd[1][16:24]); break
        groups = {}

        def find(ns):
            for nd in ns:
                if nd[0] != 'G':
                    continue
                gtype = struct.unpack_from('<I', nd[1], 12)[0]
                label = struct.unpack_from('<I', nd[1], 8)[0]
                if gtype == 9:
                    groups[label] = nd
                find(nd[2])
        find(nodes)
        nxt = high
        missing = []
        for spec in specs:
            craw = lo.raw(p, lo.normalize_id(spec["cell"]))
            g = groups.get(craw)
            if g is None:
                missing.append(spec["cell"]); continue
            nxt += 1
            fid = (own << 24) | nxt
            body = bytearray()

            def add(tag, val):
                body.extend(tag); body.extend(struct.pack('<H', len(val))); body.extend(val)
            add(b'NAME', struct.pack('<I', lo.raw(p, lo.normalize_id(spec["base"]))))
            if abs(spec.get("scale", 1.0) - 1.0) > 1e-6:
                add(b'XSCL', struct.pack('<f', float(spec["scale"])))
            add(b'DATA', struct.pack('<6f', *(list(spec["pos"]) + list(spec["rot"]))))
            hdr = bytearray(b'REFR' + struct.pack('<III', len(body), 0, fid) + vers)
            g[2].append(['R', hdr, body])
            made.append("%s:%06X" % (p.name, nxt))
        return {"record_delta": len(made), "created": made,
                "cell_group_missing": missing, "requested": len(specs)}
    return apply(p.path, mutate, backup_dir, dry_run,
                 expect={"records_removed": 0, "flags_changed": 0, "bodies_changed": 0})


def move_ref(lo, plugin, ref_id, pos=None, rot=None, scale=None, backup_dir=".", dry_run=False):
    p = lo.plugin(plugin)
    ref_id = lo.normalize_id(ref_id)
    target = lo.raw(p, ref_id)

    def mutate(head, nodes):
        for nd in tree.walk_records(nodes):
            if struct.unpack_from('<I', nd[1], 12)[0] != target:
                continue
            body = bytearray(); moved = False
            for sg, v in esplib.subrecords(bytes(nd[2])):
                v = bytearray(v)
                if sg == b'DATA' and len(v) >= 24:
                    cur = list(struct.unpack('<6f', v[:24]))
                    if pos: cur[0:3] = [float(x) for x in pos]
                    if rot: cur[3:6] = [float(x) for x in rot]
                    struct.pack_into('<6f', v, 0, *cur); moved = True
                if sg == b'XSCL' and scale is not None:
                    struct.pack_into('<f', v, 0, float(scale))
                body += sg + struct.pack('<H', len(v)) + v
            nd[2] = body
            return {"moved": moved, "ref": ref_id}
        raise EditError("reference not found in %s: %s" % (plugin, ref_id))
    return apply(p.path, mutate, backup_dir, dry_run,
                 expect={"records_added": 0, "records_removed": 0})


def repoint(lo, plugin, mapping, backup_dir=".", dry_run=False):
    """Repoint FormID references. mapping: {"old.esp:XXXXXX": "new.esp:YYYYYY"}

    Covers alternate-texture arrays as well as flat FormID fields - omitting
    those left dangling references during the audit.
    """
    import audit as A
    p = lo.plugin(plugin)
    mapping = {lo.normalize_id(k): lo.normalize_id(v) for k, v in mapping.items()}
    raw_map = {lo.raw(p, k): lo.raw(p, v) for k, v in mapping.items()}

    def mutate(head, nodes):
        n = 0
        for nd in tree.walk_records(nodes):
            body = bytearray(); changed = False
            for sg, v in esplib.subrecords(bytes(nd[2])):
                v = bytearray(v)
                offs = list(A.alt_texture_refs(v)) if sg in A.ALT_TEXTURE else \
                       list(A.REF_FIELDS.get(sg, ()))
                for o in offs:
                    if len(v) < o + 4:
                        continue
                    w = struct.unpack_from('<I', v, o)[0]
                    if w in raw_map:
                        struct.pack_into('<I', v, o, raw_map[w]); n += 1; changed = True
                body += sg + struct.pack('<H', len(v)) + v
            if changed:
                nd[2] = body
        return {"references_repointed": n}
    return apply(p.path, mutate, backup_dir, dry_run,
                 expect={"records_added": 0, "records_removed": 0})


def remove_records(lo, plugin, ids, backup_dir=".", dry_run=False):
    """Remove records, pruning any group left empty.

    Refuses if anything still references a record being removed - that check is
    what stops this becoming the very problem the audit was cleaning up.
    """
    import audit as A
    p = lo.plugin(plugin)
    ids = [lo.normalize_id(i) for i in ids]
    targets = {lo.raw(p, i) for i in ids}
    canon_targets = set(ids)

    referrers = []
    for q in lo.plugins:
        for _, t, fid, fl, off, sz, ctx in lo.records(q):
            if t in ('NAVM', 'NAVI', 'LAND'):
                continue
            for sg, v in esplib.subrecords(lo.body(q, off, sz, fl)):
                offs = list(A.alt_texture_refs(v)) if sg in A.ALT_TEXTURE else \
                       list(A.REF_FIELDS.get(sg, ()))
                for o in offs:
                    if len(v) < o + 4:
                        continue
                    tgt = lo.canon(q, struct.unpack_from('<I', v, o)[0])
                    if tgt in canon_targets and lo.canon(q, fid) not in canon_targets:
                        referrers.append({"referrer": lo.canon(q, fid), "in": q.name,
                                          "field": sg.decode(), "target": tgt})
    if referrers:
        return {"plugin": p.name, "written": False,
                "reason": "refusing to remove records that are still referenced",
                "referrers": referrers[:40], "referrer_count": len(referrers)}

    def mutate(head, nodes):
        removed = [0]; groups = [0]

        def prune(ns):
            out = []
            for nd in ns:
                if nd[0] == 'R':
                    if struct.unpack_from('<I', nd[1], 12)[0] in targets:
                        removed[0] += 1
                        continue
                    out.append(nd)
                else:
                    nd[2] = prune(nd[2])
                    if not nd[2]:
                        groups[0] += 1
                        continue
                    out.append(nd)
            return out
        nodes[:] = prune(nodes)
        return {"removed": removed[0], "empty_groups_pruned": groups[0],
                "record_delta": -(removed[0] + groups[0])}
    return apply(p.path, mutate, backup_dir, dry_run,
                 expect={"records_added": 0})
