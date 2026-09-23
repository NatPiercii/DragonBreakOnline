"""Dumps the DBO_Skill_* marker SPEL records byte for byte.

Unarmed's five markers (DBO_Skill_unarmed_T1..T5) do not exist and the server logs
"5 marker spell(s) missing" at every boot. Before writing them, this prints exactly what one of
the fifteen that DO exist is made of - every subrecord, its length and its value - so the new
records can be copies rather than guesses.

usage: py ck-mcp\markerspells.py
"""
import sys, struct, collections
sys.path.insert(0, r"E:\DragonBreak Online Dev files\ck-mcp")
import core, esplib

DATA = r"E:\DragonBreak Online Dev files\Skyrim Special Edition - dev\Data"
PLUGINS = r"E:\DragonBreak Online Dev files\server\plugins.server.txt"
TARGET = "DragonBreak Online Edits.esp"

lo = core.LoadOrder(DATA, PLUGINS)

# SPIT is the spell's own data block; these are the fields the Creation Kit shows for a spell.
SPEL_TYPE = {0: "Spell", 1: "Disease", 2: "Power", 3: "LesserPower", 4: "Ability",
             5: "Poison", 10: "Addiction", 11: "Voice"}
CAST_TYPE = {0: "ConstantEffect", 1: "FireAndForget", 2: "Concentration", 3: "Scroll"}
DELIVERY = {0: "Self", 1: "Contact", 2: "Aimed", 3: "TargetActor", 4: "TargetLocation"}

found = collections.OrderedDict()
for p in lo.plugins:
    if p.name != TARGET:
        continue
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ("SPEL",)):
        body = lo.body(p, off, sz, fl)
        e = esplib.edid_of(body) or ""
        if not e.startswith("DBO_Skill_"):
            continue
        found[e] = (lo.canon(p, fid), fl, lo.subrecords(p, off, sz, fl), body)

print("%d DBO_Skill_* marker spells in %s" % (len(found), TARGET))
print("skills covered:", sorted({e.split("_")[2] for e in found}))
print()

if not found:
    raise SystemExit("none found - nothing to copy from")

name, (cid, flags, sub, body) = next(iter(found.items()))
print("=== %s  %s  record flags 0x%08X ===" % (name, cid, flags))
for tag, raw in sub.items():
    label = tag.decode("ascii")
    if label == "EDID":
        shown = raw.split(b"\0")[0].decode("ascii", "replace")
    elif label == "FULL":
        shown = repr(raw)
    elif label == "SPIT" and len(raw) >= 32:
        # SSE SPIT is 36 bytes with the trailing perk, 32 without it
        cost, spit_flags, stype, charge, cast, delivery, ctime = struct.unpack("<IIIfIIf", raw[:28])
        perk = struct.unpack("<I", raw[28:32])[0] if len(raw) >= 32 else 0
        shown = ("cost=%d flags=0x%08X type=%s(%d) chargeTime=%g castType=%s(%d) delivery=%s(%d) "
                 "castDuration=%g perk=%s" % (cost, spit_flags, SPEL_TYPE.get(stype, "?"), stype,
                                              charge, CAST_TYPE.get(cast, "?"), cast,
                                              DELIVERY.get(delivery, "?"), delivery, ctime,
                                              lo.canon(lo.plugins[0], perk) if perk else "none"))
    elif label == "EFID" and len(raw) >= 4:
        mgef = struct.unpack("<I", raw[:4])[0]
        shown = "MGEF -> %s" % (mgef and hex(mgef) or "none")
    elif label == "EFIT" and len(raw) >= 12:
        mag, area, dur = struct.unpack("<fII", raw[:12])
        shown = "magnitude=%g area=%d duration=%d" % (mag, area, dur)
    else:
        shown = raw.hex()
    print("  %-6s %4d bytes  %s" % (label, len(raw), shown))

print()
print("=== every marker, so a new one can be numbered into the same run ===")
for e, (cid, flags, sub, body) in found.items():
    full = sub.get(b"FULL", b"")
    print("  %-28s %s  FULL=%s" % (e, cid, repr(full) if full else "(none)"))
