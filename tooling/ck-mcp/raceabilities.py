"""What does each race's ability actually DO, effect by effect?

Before authoring anything for the Bloodlines codex, this reads the magic effects behind every RACE
spell in the live load order and prints their magnitude. Most of the codex's hard traits may already
exist as working vanilla abilities, in which case the job is a short list of gaps rather than ten new
records.

usage: py ck-mcp\raceabilities.py
"""
import sys, os, struct
sys.path.insert(0, r"E:\DragonBreak Online Dev files\ck-mcp")
import core, esplib

DATA = r"E:\DragonBreak Online Dev files\Skyrim Special Edition - dev\Data"
PLUGINS = r"E:\DragonBreak Online Dev files\server\plugins.server.txt"

RACES = ["HighElfRace", "ArgonianRace", "WoodElfRace", "BretonRace", "DarkElfRace",
         "ImperialRace", "KhajiitRace", "NordRace", "OrcRace", "RedguardRace"]

lo = core.LoadOrder(DATA, PLUGINS)
names = [l.strip().lstrip("*") for l in open(PLUGINS, encoding="utf-8-sig")
         if l.strip() and not l.startswith("#")]

spells, mgefs, races = {}, {}, {}
for n in names:
    try:
        p = lo.plugin(n)
    except Exception:
        continue
    for sig, store in (("SPEL", spells), ("MGEF", mgefs), ("RACE", races)):
        try:
            for ri, t, fid, fl, off, sz, ctx in lo.records(p, (sig,)):
                b = lo.body(p, off, sz, fl)
                store[lo.canon(p, fid)] = (p, b, esplib.edid_of(b) or "")
        except Exception:
            pass


def subs(body, tag):
    return [d for t, d in esplib.subrecords(body) if t == tag]


print(f"{len(spells)} SPEL, {len(mgefs)} MGEF\n")

for name in RACES:
    hit = None
    for gid, (p, b, e) in races.items():
        if e == name:
            hit = (p, b)
    if not hit:
        print(f"{name}: NOT FOUND")
        continue
    p, body = hit
    print(f"--- {name}")
    ids = [lo.canon(p, struct.unpack_from("<I", d, 0)[0]) for d in subs(body, b"SPLO") if len(d) >= 4]
    if not ids:
        print("    (no spells at all)")
    for sid in ids:
        ent = spells.get(sid)
        if not ent:
            print(f"    {sid}: not a SPEL in the order")
            continue
        sp, sbody, sedid = ent
        # SPIT: type at offset 8 (0 spell, 1 disease, 2 power, 3 lesser power, 4 ability, ...)
        spit = subs(sbody, b"SPIT")
        kind = "?"
        if spit and len(spit[0]) >= 12:
            t = struct.unpack_from("<I", spit[0], 8)[0]
            kind = {0: "Spell", 1: "Disease", 2: "Power", 3: "LesserPower",
                    4: "Ability", 5: "Poison", 6: "Addiction", 7: "Voice"}.get(t, str(t))
        print(f"    {sedid}  [{kind}]")
        # effects: EFID (the MGEF) then EFIT (magnitude, area, duration)
        pend = None
        for tg, d in esplib.subrecords(sbody):
            if tg == b"EFID" and len(d) >= 4:
                pend = lo.canon(sp, struct.unpack_from("<I", d, 0)[0])
            elif tg == b"EFIT" and pend is not None and len(d) >= 12:
                mag, area, dur = struct.unpack_from("<fII", d, 0)
                me = mgefs.get(pend)
                mn = me[2] if me else str(pend)
                print(f"        {mn:38s} magnitude={mag:g} dur={dur}")
                pend = None
    print()
