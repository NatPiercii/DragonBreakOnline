"""
core.py - load order indexing and canonical FormID resolution.

The single most important idea here is the CANONICAL FORMID.

A raw FormID like 0x0E06C7BD means nothing on its own: the top byte is an index
into *that plugin's own master list*, and two plugins can order their masters
differently. During the Aug 2026 audit this caused two separate wrong answers -
662 phantom "base object changed" results and 823 phantom record differences -
because raw FormIDs were compared across files with different master orders.

So every FormID crossing a tool boundary is a string:  "plugin.esp:06C7BD"
That is stable no matter which plugin is looking at it.
"""
import os, struct, collections, functools
import esplib

class LoadOrder:
    def __init__(self, data_dir, plugins_txt=None):
        self.data_dir = data_dir
        self.plugins = []
        self._by_key = {}
        self._fh = {}
        self._base_cache = {}
        self._cell_cache = {}
        self._chain = None
        self._load(plugins_txt)

    # ---------- loading ----------
    def _order_file(self, plugins_txt):
        if plugins_txt and os.path.exists(plugins_txt):
            return plugins_txt
        la = os.environ.get('LOCALAPPDATA', '')
        for name in ('loadorder.txt', 'Plugins.txt'):
            p = os.path.join(la, 'Skyrim Special Edition', name)
            if os.path.exists(p):
                return p
        return None

    def _load(self, plugins_txt):
        order, missing = [], []
        f = self._order_file(plugins_txt)
        if f:
            for line in open(f, encoding='utf-8-sig'):
                line = line.strip().lstrip('*')
                if not line or line.startswith('#'):
                    continue
                (order if os.path.exists(os.path.join(self.data_dir, line))
                       else missing).append(line)
        else:
            order = sorted(x for x in os.listdir(self.data_dir)
                           if x.lower().endswith(('.esp', '.esm', '.esl')))
        self.missing_plugins = missing
        for name in order:
            try:
                self.plugins.append(esplib.Plugin(os.path.join(self.data_dir, name)))
            except Exception as e:
                missing.append("%s (parse failed: %s)" % (name, e))
        # engine order: ESM-flagged first, stable otherwise. The ESL flag alone
        # does NOT move a plugin into the master block.
        self.plugins.sort(key=lambda p: 0 if p.esm else 1)
        for i, p in enumerate(self.plugins):
            p.load_index = i
            self._by_key[p.key] = p

    def fh(self, p):
        if p.load_index not in self._fh:
            self._fh[p.load_index] = open(p.path, 'rb')
        return self._fh[p.load_index]

    def plugin(self, name):
        p = self._by_key.get(name.lower())
        if p is None:
            raise KeyError("plugin not loaded: %s" % name)
        return p

    # ---------- canonical FormIDs ----------
    @staticmethod
    def normalize_id(canonical):
        """'Skyrim.esm:00009B41' and 'Skyrim.esm:009B41' are the same record.
        Always emit the 6-digit form so ids compare and hash consistently."""
        src, loc = canonical.rsplit(':', 1)
        return "%s:%06X" % (src, int(loc, 16) & 0xFFFFFF)

    def canon(self, p, fid):
        """raw FormID in plugin p  ->  'origin.esp:XXXXXX'"""
        mi, loc = fid >> 24, fid & 0xFFFFFF
        src = p.masters[mi] if mi < len(p.masters) else p.name
        return "%s:%06X" % (src, loc)

    def raw(self, p, canonical):
        """'origin.esp:XXXXXX' -> raw FormID usable inside plugin p"""
        src, loc = canonical.rsplit(':', 1)
        loc = int(loc, 16) & 0xFFFFFF
        low = [m.lower() for m in p.masters]
        if src.lower() == p.key:
            return (len(p.masters) << 24) | loc
        if src.lower() not in low:
            raise ValueError("%s is not a master of %s" % (src, p.name))
        return (low.index(src.lower()) << 24) | loc

    # ---------- record access ----------
    def records(self, p, types=None):
        for ri, (t, fid, fl, off, sz, ctx) in enumerate(p.index):
            if types and t not in types:
                continue
            yield ri, t, fid, fl, off, sz, ctx

    def body(self, p, off, sz, fl):
        return p.data_at(self.fh(p), off, sz, fl)

    def subrecords(self, p, off, sz, fl):
        return {s: bytes(v) for s, v in esplib.subrecords(self.body(p, off, sz, fl))}

    # ---------- override chains ----------
    def chain(self):
        """canonical id -> [plugin names, in load order]"""
        if self._chain is None:
            c = collections.defaultdict(list)
            for p in self.plugins:
                for _, t, fid, fl, off, sz, ctx in self.records(p):
                    c[self.canon(p, fid)].append(p.name)
            self._chain = dict(c)
        return self._chain

    def winner(self, canonical):
        ch = self.chain().get(canonical)
        return ch[-1] if ch else None

    def exists(self, canonical):
        return canonical in self.chain()

    # ---------- friendly names ----------
    def base_info(self, canonical):
        """EditorID / type / model for a base object, from its winning version"""
        if canonical in self._base_cache:
            return self._base_cache[canonical]
        res = None
        SKIP = ('REFR', 'ACHR', 'NAVM', 'LAND', 'INFO', 'CELL', 'WRLD', 'DIAL', 'PHZD')
        for p in reversed(self.plugins):
            for _, t, fid, fl, off, sz, ctx in self.records(p):
                if t in SKIP or self.canon(p, fid) != canonical:
                    continue
                sub = self.subrecords(p, off, sz, fl)
                res = {"editor_id": esplib.edid_of(self.body(p, off, sz, fl)) or "",
                       "type": t,
                       "model": sub.get(b'MODL', b'').rstrip(b'\0').decode('cp1252', 'replace'),
                       "name": sub.get(b'FULL', b'').rstrip(b'\0').decode('cp1252', 'replace')}
                break
            if res:
                break
        self._base_cache[canonical] = res
        return res

    def cell_info(self, canonical):
        if canonical in self._cell_cache:
            return self._cell_cache[canonical]
        res = None
        for p in self.plugins:
            for _, t, fid, fl, off, sz, ctx in self.records(p, ('CELL',)):
                if self.canon(p, fid) != canonical:
                    continue
                sub = self.subrecords(p, off, sz, fl)
                grid = struct.unpack('<ii', sub[b'XCLC'][:8]) if len(sub.get(b'XCLC', b'')) >= 8 else None
                res = {"editor_id": esplib.edid_of(self.body(p, off, sz, fl)) or "",
                       "name": sub.get(b'FULL', b'').rstrip(b'\0').decode('cp1252', 'replace'),
                       "grid": list(grid) if grid else None,
                       "interior": grid is None}
                break
            if res:
                break
        self._cell_cache[canonical] = res
        return res

    # ---------- reference helpers ----------
    def ref_fields(self, p, off, sz, fl):
        """position / rotation / scale / base of a REFR or ACHR"""
        sub = self.subrecords(p, off, sz, fl)
        out = {"base": None, "pos": None, "rot": None, "scale": 1.0}
        if b'NAME' in sub:
            out["base"] = self.canon(p, struct.unpack('<I', sub[b'NAME'][:4])[0])
        if len(sub.get(b'DATA', b'')) >= 24:
            v = struct.unpack('<6f', sub[b'DATA'][:24])
            out["pos"] = [round(x, 2) for x in v[:3]]
            out["rot"] = [round(x, 4) for x in v[3:]]
        if b'XSCL' in sub:
            out["scale"] = round(struct.unpack('<f', sub[b'XSCL'][:4])[0], 3)
        return out

    FLAGS = {"deleted": 0x20, "persistent": 0x400, "initially_disabled": 0x800,
             "visible_when_distant": 0x8000, "compressed": 0x40000, "ignored": 0x1000}

    def flag_names(self, fl):
        return sorted(k for k, b in self.FLAGS.items() if fl & b)

    def close(self):
        for f in self._fh.values():
            try: f.close()
            except Exception: pass
        self._fh.clear()
