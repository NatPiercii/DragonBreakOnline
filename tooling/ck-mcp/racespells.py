"""Which spells does each playable RACE actually grant, in THIS load order?

The starting-spell bug (an Orc holding Battle Cry, Nord frost resistance, Flames and Healing) was
recorded as needing a C++ build. Before writing any client fix, this answers the only question that
matters: which of those four are RACE spells and which are not. A race spell can be removed
client-side by comparing the player's race against the other playable races; anything else needs a
different rule, so this must be measured and not assumed.

RACE spells live in SPLO subrecords (one form id each), read from the winning override.

usage: py ck-mcp\racespells.py
"""
import sys, os, struct, json
sys.path.insert(0, r"E:\DragonBreak Online Dev files\ck-mcp")
import core, esplib

DATA = r"E:\DragonBreak Online Dev files\Skyrim Special Edition - dev\Data"
PLUGINS = r"E:\DragonBreak Online Dev files\server\plugins.server.txt"

RACES = ["HighElfRace", "ArgonianRace", "WoodElfRace", "BretonRace", "DarkElfRace",
         "ImperialRace", "KhajiitRace", "NordRace", "OrcRace", "RedguardRace"]

lo = core.LoadOrder(DATA, PLUGINS)
names = [l.strip().lstrip("*") for l in open(PLUGINS, encoding="utf-8-sig")
         if l.strip() and not l.startswith("#")]

spell_names = {}
winners = {}
for name in names:
    try:
        p = lo.plugin(name)
    except Exception:
        continue
    for kind, store in (("SPEL", None), ("RACE", None)):
        try:
            for ri, t, fid, fl, off, sz, ctx in lo.records(p, (kind,)):
                body = lo.body(p, off, sz, fl)
                e = esplib.edid_of(body) or ""
                gid = lo.canon(p, fid)
                if kind == "SPEL":
                    if e:
                        spell_names[gid] = e
                elif e in RACES:
                    winners[e] = (p, body)      # later plugin in the order wins
        except Exception:
            pass

print(f"{len(spell_names)} SPEL records named; {len(winners)} of {len(RACES)} races found\n")

by_race = {}
for name in RACES:
    if name not in winners:
        print(f"{name}: NOT FOUND")
        continue
    p, body = winners[name]
    ids = []
    for tag, data in esplib.subrecords(body):
        if tag == b"SPLO" and len(data) >= 4:
            ids.append(lo.canon(p, struct.unpack_from("<I", data, 0)[0]))
    by_race[name] = ids
    shown = ", ".join(f"{spell_names.get(i, '?')}" for i in ids) or "(none)"
    print(f"{name:14s} [{os.path.basename(p.path)[:34]:34s}] {len(ids)}: {shown}")

print("\n--- the four in question ---")
WANTED = ("battlecry", "resistfrost", "flames", "healing", "berserker", "frostresist")
for name, ids in by_race.items():
    hits = [spell_names.get(i, "") for i in ids
            if any(w in spell_names.get(i, "").lower() for w in WANTED)]
    if hits:
        print(f"  {name}: {', '.join(hits)}")

print("\n--- granted by SOME races but not all (removable by race comparison) ---")
allids = set()
for ids in by_race.values():
    allids |= set(ids)
universal = [i for i in allids if all(i in ids for ids in by_race.values())]
for i in sorted(allids):
    owners = [n for n, ids in by_race.items() if i in ids]
    if len(owners) < len(by_race):
        print(f"  {spell_names.get(i, '?'):34s} <- {', '.join(owners)}")

print("\n--- granted by EVERY playable race (a race comparison can never remove these) ---")
for i in sorted(universal):
    print(f"  {spell_names.get(i, '?')}")

out = {"byRace": {k: [f"{i:08X}" for i in v] for k, v in by_race.items()},
       "names": {f"{k:08X}": v for k, v in spell_names.items() if k in allids}}
dest = r"E:\DragonBreak Online Dev files\server\race-spells.json"
open(dest, "w", encoding="utf-8").write(json.dumps(out, indent=1))
print("\nwrote", dest)
