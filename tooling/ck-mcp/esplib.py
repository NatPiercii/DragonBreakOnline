import struct, zlib, os

REC_HDR = 24
CMP = 0x00040000
DEL = 0x00000020
IGN = 0x00001000
ESM_FLAG = 0x00000001
ESL_FLAG = 0x00000200

def subrecords(data):
    i=0; n=len(data); pending=None
    while i+6 <= n:
        sig = data[i:i+4]
        size = struct.unpack_from('<H', data, i+4)[0]
        i += 6
        if sig == b'XXXX':
            pending = struct.unpack_from('<I', data, i)[0]; i += size; continue
        if pending is not None:
            size = pending; pending = None
        yield sig, data[i:i+size]
        i += size

def edid_of(data):
    for sig, val in subrecords(data):
        if sig == b'EDID':
            return val.rstrip(b'\x00').decode('cp1252','replace')
    return None

class Plugin:
    def __init__(self, path):
        self.path = path
        self.name = os.path.basename(path)
        self.key  = self.name.lower()
        buf = open(path,'rb').read()
        self._size = len(buf)
        hsize = struct.unpack_from('<I', buf, 4)[0]
        self.hflags = struct.unpack_from('<I', buf, 8)[0]
        hdata = buf[REC_HDR:REC_HDR+hsize]
        self.masters=[]; self.hedr=None; self.cnam=None; self.snam=None
        for sig,val in subrecords(hdata):
            if sig==b'MAST': self.masters.append(val.rstrip(b'\x00').decode('cp1252','replace'))
            elif sig==b'HEDR': self.hedr = struct.unpack('<fiI', val[:12])
            elif sig==b'CNAM': self.cnam = val.rstrip(b'\x00').decode('cp1252','replace')
            elif sig==b'SNAM': self.snam = val.rstrip(b'\x00').decode('cp1252','replace')
        self.esm = bool(self.hflags & ESM_FLAG)
        self.esl = bool(self.hflags & ESL_FLAG)
        # index: list of (type, formid, flags, offset, size, groupctx)
        self.index = []
        self._walk(buf, REC_HDR+hsize, len(buf), (0,0,0))
        del buf

    def _walk(self, buf, pos, end, ctx):
        idx = self.index
        while pos < end:
            sig = buf[pos:pos+4]
            size = struct.unpack_from('<I', buf, pos+4)[0]
            if sig == b'GRUP':
                gend = pos+size
                gtype = struct.unpack_from('<I', buf, pos+12)[0]
                lab   = struct.unpack_from('<I', buf, pos+8)[0]
                w,c,g = ctx if ctx else (0,0,0)
                if gtype == 1: w = lab                    # world children
                elif gtype in (6,8,9,10): c = lab         # cell children
                g = gtype
                self._walk(buf, pos+REC_HDR, gend, (w,c,g))
                pos = gend
            else:
                flags = struct.unpack_from('<I', buf, pos+8)[0]
                fid   = struct.unpack_from('<I', buf, pos+12)[0]
                idx.append((sig.decode('ascii','replace'), fid, flags, pos+REC_HDR, size, ctx))
                pos += REC_HDR + size

    def data_at(self, fh, off, size, flags):
        fh.seek(off); d = fh.read(size)
        if flags & CMP:
            try: d = zlib.decompress(d[4:])
            except Exception: return b''
        return d

    def modindex_source(self, fid):
        """Return (source_plugin_key, localid). None source if unresolvable."""
        mi = fid >> 24
        loc = fid & 0xFFFFFF
        if mi < len(self.masters):
            return self.masters[mi].lower(), loc
        if mi == len(self.masters):
            return self.key, loc
        return None, loc
