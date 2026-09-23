"""Are the RACE records in DragonBreak Online Edits.esp exactly as another session left them?

Two passes wrote to that plugin on 2026-09-20: a race retune at 11:36 (someone else's) and the
blessing/marker spells at 12:21 and 12:57 (mine). Mine only ADD SPEL records, so every RACE record
must be byte-identical to the backup taken before them. This proves that rather than assuming it.

It also reads Unarmed Damage per race WITHOUT guessing the DATA layout: the offset is derived by
finding the one position at which every race's float lands on a plausible value and the known pair
(Khajiit high, Argonian 10) holds.

usage: py ck-mcp\raceverify.py
"""
import sys, struct, hashlib, glob, os
sys.path.insert(0, r"E:\DragonBreak Online Dev files\ck-mcp")
import core, esplib

DATA = r"E:\DragonBreak Online Dev files\Skyrim Special Edition - dev\Data"
PLUGINS = r"E:\DragonBreak Online Dev files\server\plugins.server.txt"
LIVE = os.path.join(DATA, "DragonBreak Online Edits.esp")

backups = sorted(glob.glob(r"E:\DragonBreak Online Dev files\ckmcp-backups\pre-blessings-*\*DragonBreak Online Edits.esp"))
if not backups:
    raise SystemExit("no pre-blessings backup found")
BEFORE = backups[-1]
print("comparing against", BEFORE)

lo = core.LoadOrder(DATA, PLUGINS)

RACES = ["HighElfRace", "ArgonianRace", "WoodElfRace", "BretonRace", "DarkElfRace",
         "ImperialRace", "KhajiitRace", "NordRace", "OrcRace", "RedguardRace"]


def race_records(path):
    p = esplib.Plugin(path)
    p.load_index = 0xFE
    out = {}
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ("RACE",)):
        body = lo.body(p, off, sz, fl)
        e = esplib.edid_of(body) or ""
        if e in RACES:
            out[e] = body
    lo._fh.pop(0xFE, None)
    return out


a = race_records(BEFORE)
b = race_records(LIVE)

print("\n=== RACE records: before my passes vs now ===")
same = 0
for r in RACES:
    x, y = a.get(r), b.get(r)
    if x is None or y is None:
        print("  %-14s MISSING (%s / %s)" % (r, x is not None, y is not None))
        continue
    ok = hashlib.sha1(x).hexdigest() == hashlib.sha1(y).hexdigest()
    same += 1 if ok else 0
    print("  %-14s %s" % (r, "unchanged" if ok else "*** CHANGED ***"))
print("  -> %d of %d identical" % (same, len(RACES)))

# ---- Unarmed Damage, offset derived rather than guessed -----------------------------------------
# Walk every 4-byte position in DATA and keep the one where each race reads a small sane float and
# the races differ from one another in the way the design says they should.
subs = {}
for r in RACES:
    p = esplib.Plugin(LIVE)
    p.load_index = 0xFD
    body = b[r]
    # re-split the body's subrecords by hand; DATA is the one we want
    i, data = 0, None
    while i + 6 <= len(body):
        tag = body[i:i + 4]
        ln = struct.unpack_from("<H", body, i + 4)[0]
        if tag == b"DATA":
            data = body[i + 6:i + 6 + ln]
        i += 6 + ln
    subs[r] = data
    lo._fh.pop(0xFD, None)

n = min(len(d) for d in subs.values())
print("\n=== looking for the Unarmed Damage field in RACE DATA (%d bytes) ===" % n)
candidates = []
for off in range(0, n - 3, 4):
    vals = {}
    ok = True
    for r in RACES:
        v = struct.unpack_from("<f", subs[r], off)[0]
        if not (0.0 <= v <= 100.0) or v != v:
            ok = False
            break
        vals[r] = v
    if not ok:
        continue
    # the field we want: most races share one low value, and Khajiit/Argonian are above it
    others = [vals[r] for r in RACES if r not in ("KhajiitRace", "ArgonianRace")]
    if len(set(others)) == 1 and vals["KhajiitRace"] > others[0] and vals["ArgonianRace"] > others[0]:
        candidates.append((off, dict(vals)))

if not candidates:
    print("  no offset matches the expected shape - read it in xEdit instead of trusting this")
else:
    for off, vals in candidates:
        print("  offset 0x%02X:" % off)
        for r in RACES:
            print("      %-14s %g" % (r, vals[r]))
