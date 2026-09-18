"""Read-only MessagePack decoder for Vortex deployment manifests (vortex.deployment*.msgpack)."""
import struct

_FIXEXT = {0xD4: 1, 0xD5: 2, 0xD6: 4, 0xD7: 8, 0xD8: 16}
_NUM = {0xCA: ("f", 4), 0xCB: ("d", 8), 0xCC: ("B", 1), 0xCD: ("H", 2), 0xCE: ("I", 4), 0xCF: ("Q", 8),
        0xD0: ("b", 1), 0xD1: ("h", 2), 0xD2: ("i", 4), 0xD3: ("q", 8)}


class _Reader:
    def __init__(self, data):
        self.d = data
        self.i = 0

    def take(self, n):
        b = self.d[self.i:self.i + n]
        if len(b) != n:
            raise ValueError("truncated msgpack data")
        self.i += n
        return b

    def u(self, fmt, n):
        return struct.unpack(">" + fmt, self.take(n))[0]

    def obj(self):
        t = self.take(1)[0]
        if t <= 0x7F:
            return t
        if t <= 0x8F:
            return self.map(t & 0x0F)
        if t <= 0x9F:
            return self.arr(t & 0x0F)
        if t <= 0xBF:
            return self.str(t & 0x1F)
        if t >= 0xE0:
            return t - 0x100
        if t == 0xC0:
            return None
        if t in (0xC2, 0xC3):
            return t == 0xC3
        if t in (0xC4, 0xC5, 0xC6):
            return self.take(self.u(*{0xC4: ("B", 1), 0xC5: ("H", 2), 0xC6: ("I", 4)}[t]))
        if t in (0xC7, 0xC8, 0xC9):
            n = self.u(*{0xC7: ("B", 1), 0xC8: ("H", 2), 0xC9: ("I", 4)}[t])
            self.take(1)
            return self.take(n)
        if t in _NUM:
            return self.u(*_NUM[t])
        if t in _FIXEXT:
            self.take(1)
            return self.take(_FIXEXT[t])
        if t in (0xD9, 0xDA, 0xDB):
            return self.str(self.u(*{0xD9: ("B", 1), 0xDA: ("H", 2), 0xDB: ("I", 4)}[t]))
        if t in (0xDC, 0xDD):
            return self.arr(self.u(*{0xDC: ("H", 2), 0xDD: ("I", 4)}[t]))
        if t in (0xDE, 0xDF):
            return self.map(self.u(*{0xDE: ("H", 2), 0xDF: ("I", 4)}[t]))
        raise ValueError("unsupported msgpack type 0x%02x at %d" % (t, self.i - 1))

    def str(self, n):
        return self.take(n).decode("utf-8", errors="replace")

    def arr(self, n):
        return [self.obj() for _ in range(n)]

    def map(self, n):
        out = {}
        for _ in range(n):
            k = self.obj()
            out[k if isinstance(k, (str, int)) else repr(k)] = self.obj()
        return out


def load(path):
    with open(path, "rb") as f:
        return _Reader(f.read()).obj()
