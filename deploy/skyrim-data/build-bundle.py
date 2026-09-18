"""Bundle the game server's plugins from a Skyrim SE 1.6.1170 Data folder that has the collection deployed."""
import argparse
import hashlib
import io
import os
import sys
import tarfile

HERE = os.path.dirname(os.path.abspath(__file__))
META = ("SHA256SUMS", "loadorder.txt")


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def read_sums():
    sums = {}
    with open(os.path.join(HERE, "SHA256SUMS"), encoding="utf-8") as f:
        for line in f:
            if line.strip():
                digest, name = line.rstrip("\r\n").split("  ", 1)
                sums[name] = digest
    return sums


def read_meta(name):
    with open(os.path.join(HERE, name), "rb") as f:
        return f.read().replace(b"\r\n", b"\n")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--data", required=True, help="Skyrim Special Edition Data folder")
    ap.add_argument("--out", default="dragonbreak-server-plugins.tar")
    args = ap.parse_args()

    sums = read_sums()
    order = [l for l in read_meta("loadorder.txt").decode("utf-8").split("\n") if l.strip()]
    unlisted = [n for n in order if n not in sums]
    if unlisted:
        sys.exit("loadorder.txt entries missing from SHA256SUMS: " + ", ".join(unlisted))

    present = {n.lower(): n for n in os.listdir(args.data)}
    problems = []
    for name, digest in sums.items():
        real = present.get(name.lower())
        if not real:
            problems.append("missing: " + name)
        elif sha256(os.path.join(args.data, real)) != digest:
            problems.append("different: " + name)
    if problems:
        sys.exit("Data folder does not match SHA256SUMS:\n  " + "\n  ".join(problems))

    with tarfile.open(args.out, "w", format=tarfile.GNU_FORMAT) as tar:
        for name in sums:
            path = os.path.join(args.data, present[name.lower()])
            info = tar.gettarinfo(path, arcname=name)
            info.uid = info.gid = 0
            info.uname = info.gname = "root"
            info.mode = 0o644
            with open(path, "rb") as f:
                tar.addfile(info, f)
        for name in META:
            data = read_meta(name)
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mode = 0o644
            tar.addfile(info, io.BytesIO(data))
    print("%s: %d files verified and bundled (%d plugins in load order)" % (args.out, len(sums), len(order)))


if __name__ == "__main__":
    main()
