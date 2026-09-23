"""Localized names: the .STRINGS tables a localized plugin's FULL fields point at.

Why this exists: a plugin whose header carries the localized flag (0x80) stores every FULL, DESC and
similar field as a uint32 string id, not as text. Every generator in this folder used to give up there and
fall back to the editor id or, for map markers, to the cell coordinates, which is how 376 of the 737 admin
teleport points ended up called "Solstheim World 11,11".

The tables live in Data\\Strings when a translation is installed loose, and otherwise inside a BSA
(Skyrim.esm's are in "Skyrim - Interface.bsa"). Both are read here.

  from bsastrings import Strings
  s = Strings(r"...\\Data")
  s.text("Skyrim.esm", 0x00013A1B)   ->  "Whiterun"  (or None)

Formats, both little endian:
  BSA v105 header  "BSA\\0", version, offset, archiveFlags, folderCount, fileCount,
                   totalFolderNameLength, totalFileNameLength, fileFlags
                   archiveFlags 0x1 folder names, 0x2 file names, 0x4 compressed by default.
                   A file's size field toggles compression with 0x40000000 and, with archiveFlags 0x100,
                   the data starts with a length-prefixed name. Compressed entries are refused loudly
                   rather than guessed at, because SSE uses LZ4 here and Skyrim LE used zlib.
  STRINGS          count, dataSize, count x (id, offset), then the data block; entries are
                   null terminated in .STRINGS and uint32 length prefixed in .DLSTRINGS / .ILSTRINGS.
"""
import os
import struct
import zlib

_LANGS = ("english", "en")


class BsaError(Exception):
    pass


class _Bsa:
    def __init__(self, path):
        self.path = path
        self.files = {}  # "folder/name" (lowercase, forward slashes) -> (offset, rawSize)
        self._read_index()

    def _read_index(self):
        with open(self.path, "rb") as f:
            head = f.read(36)
            if len(head) < 36 or head[:4] != b"BSA\0":
                raise BsaError("%s is not a BSA" % self.path)
            (version, offset, flags, folder_count, file_count,
             folder_name_len, file_name_len, _file_flags) = struct.unpack("<8I", head[4:36])
            if version not in (103, 104, 105):
                raise BsaError("%s has unsupported BSA version %d" % (self.path, version))
            self.flags = flags
            self.version = version
            f.seek(offset)
            rec = 24 if version >= 105 else 16
            folders = []
            for _ in range(folder_count):
                b = f.read(rec)
                if version >= 105:
                    _hash, count, _pad, block = struct.unpack("<QIIQ", b)
                else:
                    _hash, count, block = struct.unpack("<QII", b)
                folders.append((count, block - file_name_len))
            entries = []
            for count, block in folders:
                f.seek(block)
                folder_name = ""
                if flags & 0x1:
                    n = f.read(1)[0]
                    folder_name = f.read(n).rstrip(b"\0").decode("cp1252", "replace")
                folder_name = folder_name.replace("\\", "/").lower()
                for _ in range(count):
                    _hash, size, data_off = struct.unpack("<QII", f.read(16))
                    entries.append((folder_name, size, data_off))
            names = []
            if flags & 0x2:
                blob = f.read(file_name_len)
                names = [x.decode("cp1252", "replace").lower() for x in blob.split(b"\0") if x]
            for i, (folder_name, size, data_off) in enumerate(entries):
                name = names[i] if i < len(names) else "%d" % i
                self.files["%s/%s" % (folder_name, name) if folder_name else name] = (data_off, size)

    def read(self, key):
        where = self.files.get(key.lower())
        if where is None:
            return None
        data_off, raw_size = where
        compressed = bool(raw_size & 0x40000000) != bool(self.flags & 0x4)
        size = raw_size & 0x3FFFFFFF
        with open(self.path, "rb") as f:
            f.seek(data_off)
            if self.flags & 0x100:  # the entry's own name is embedded ahead of the data
                n = f.read(1)[0]
                f.read(n)
                size -= n + 1
            blob = f.read(size)
        if not compressed:
            return blob
        if self.version >= 105:
            # SSE compresses with LZ4 frame, which the standard library cannot read
            raise BsaError("%s: %s is LZ4 compressed, extract it loose to Data\\Strings" % (self.path, key))
        return zlib.decompress(blob[4:])


def _parse_strings(blob, length_prefixed):
    count, _data_size = struct.unpack("<II", blob[:8])
    directory = blob[8:8 + count * 8]
    data = blob[8 + count * 8:]
    out = {}
    for i in range(count):
        sid, off = struct.unpack("<II", directory[i * 8:i * 8 + 8])
        if off >= len(data):
            continue
        if length_prefixed:
            n = struct.unpack("<I", data[off:off + 4])[0]
            raw = data[off + 4:off + 4 + n]
        else:
            end = data.find(b"\0", off)
            raw = data[off:end if end >= 0 else len(data)]
        out[sid] = raw.rstrip(b"\0").decode("cp1252", "replace")
    return out


class Strings:
    """Every string table of every plugin under one Data folder, loaded on first use."""

    def __init__(self, data_dir, language=None):
        self.data_dir = data_dir
        self.langs = (language.lower(),) if language else _LANGS
        self._bsas = None
        self._tables = {}   # plugin name lowercase -> {string id: text}
        self.misses = set()

    def _archives(self):
        if self._bsas is None:
            self._bsas = []
            for name in sorted(os.listdir(self.data_dir)):
                if not name.lower().endswith(".bsa"):
                    continue
                try:
                    bsa = _Bsa(os.path.join(self.data_dir, name))
                except (BsaError, OSError, struct.error):
                    continue
                if any(k.startswith("strings/") for k in bsa.files):
                    self._bsas.append(bsa)
        return self._bsas

    def _load(self, plugin):
        stem = os.path.splitext(plugin)[0].lower()
        table = {}
        for ext, prefixed in ((".strings", False), (".dlstrings", True), (".ilstrings", True)):
            blob = None
            for lang in self.langs:
                loose = os.path.join(self.data_dir, "Strings", "%s_%s%s" % (stem, lang, ext))
                if os.path.exists(loose):
                    blob = open(loose, "rb").read()
                    break
                key = "strings/%s_%s%s" % (stem, lang, ext)
                for bsa in self._archives():
                    got = bsa.read(key)
                    if got is not None:
                        blob = got
                        break
                if blob is not None:
                    break
            if blob:
                try:
                    table.update(_parse_strings(blob, prefixed))
                except (struct.error, IndexError):
                    pass
        self._tables[stem] = table
        return table

    def text(self, plugin, string_id):
        """The text a plugin's uint32 string id stands for, or None."""
        if not string_id:
            return None
        stem = os.path.splitext(plugin)[0].lower()
        table = self._tables.get(stem)
        if table is None:
            table = self._load(stem)
        hit = table.get(int(string_id))
        if hit is None:
            self.misses.add((stem, int(string_id)))
        return hit or None

    def count(self, plugin):
        stem = os.path.splitext(plugin)[0].lower()
        if stem not in self._tables:
            self._load(stem)
        return len(self._tables[stem])


if __name__ == "__main__":
    import sys
    data = sys.argv[1] if len(sys.argv) > 1 else r"E:\DragonBreak Online Dev files\Skyrim Special Edition - dev\Data"
    s = Strings(data)
    for bsa in s._archives():
        print("strings in", os.path.basename(bsa.path), sorted(k for k in bsa.files if k.startswith("strings/")))
    for plugin in ("Skyrim.esm", "Dawnguard.esm", "Dragonborn.esm", "HearthFires.esm", "Update.esm"):
        print("%-18s %6d strings" % (plugin, s.count(plugin)))
    print("Whiterun test:", s.text("Skyrim.esm", 0x13A1B))
