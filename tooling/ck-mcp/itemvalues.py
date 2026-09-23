"""Where an item's gold value and a spell's magicka cost actually live, measured not remembered.

`skillPoints.weightOf` scales a craft by the product's gold value and a cast by the spell's magicka
cost, and until 2026-09-20 no caller passed either. Before writing those lookups into
`masterySystem.ts` the byte offsets had to be *known*: a wrong offset reads a neighbouring field and
silently weights every craft the same, which is the bug being fixed rather than a new one.

Method: nothing is taken on faith. Every 4-aligned offset of the value-bearing field is scanned over
the whole load order and characterised - how many reads are plausible gold (0..200000), how many
distinct values, the maximum, and whether the same bytes read as a plausible float instead. A gold
field is the one where every read is sane, there are many distinct values and some exceed 255; a
float field gives itself away. This caught AMMO, where a first pass read flags@4 as the value: the
real value is at 12 (iron arrow 1 ... daedric 8) and offset 8 is the arrow's damage as a float.

usage: py ck-mcp/itemvalues.py    ->  server/item-value-layout.json
"""
import sys, struct, json, collections
sys.path.insert(0, r"E:\DragonBreak Online Dev files\ck-mcp")
import core, esplib

DATA = r"E:\DragonBreak Online Dev files\Skyrim Special Edition - dev\Data"
PLUGINS = r"E:\DragonBreak Online Dev files\server\plugins.server.txt"
OUT = r"E:\DragonBreak Online Dev files\server\item-value-layout.json"

# The field that carries the gold value, per record type. ALCH keeps weight alone in DATA.
FIELD = {"WEAP": b"DATA", "ARMO": b"DATA", "MISC": b"DATA", "INGR": b"DATA", "SLGM": b"DATA",
         "SCRL": b"DATA", "KEYM": b"DATA", "AMMO": b"DATA", "BOOK": b"DATA", "ALCH": b"ENIT"}
# What shipped in masterySystem.ts PRODUCT_VALUE_AT, so a re-run re-checks it rather than restating it.
SHIPPED = {"WEAP": 0, "ARMO": 0, "MISC": 0, "INGR": 0, "SLGM": 0, "SCRL": 0,
           "KEYM": 0, "AMMO": 12, "BOOK": 8, "ALCH": 0}

i32 = lambda b, o: struct.unpack_from("<i", b, o)[0]
f32 = lambda b, o: struct.unpack_from("<f", b, o)[0]

lo = core.LoadOrder(DATA, PLUGINS)

rows = collections.defaultdict(list)
for p in lo.plugins:
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, tuple(FIELD)):
        body = lo.body(p, off, sz, fl)
        subs = {}
        for tag, d in esplib.subrecords(body):
            subs.setdefault(tag, d)
        d = subs.get(FIELD[t])
        if d:
            rows[t].append((esplib.edid_of(body) or "", d))

report = {"types": {}, "spel": {}}
for t in FIELD:
    rs = rows.get(t) or []
    if not rs:
        continue
    size = min(len(d) for e, d in rs)
    offsets = []
    for o in range(0, size - 3, 4):
        vals = [i32(d, o) for e, d in rs if len(d) >= o + 4]
        fls = [f32(d, o) for e, d in rs if len(d) >= o + 4]
        si = sum(1 for v in vals if 0 <= v < 200000)
        sf = sum(1 for v in fls if v == v and 0.0 <= v < 1500.0)
        offsets.append({"offset": o, "intPlausible": si, "n": len(vals),
                        "nonZero": sum(1 for v in vals if v), "distinct": len(set(vals)),
                        "max": max(vals), "floatPlausible": sf,
                        "looksLikeGold": si == len(vals) and len(set(vals)) > 10 and any(v > 255 for v in vals)})
    gold = [o["offset"] for o in offsets if o["looksLikeGold"]]
    shipped = SHIPPED[t]
    # Two types cannot clear the ">255 gold" bar and are checked directly instead:
    # KEYM is all zeros (keys are worthless), and every arrow in the game is worth 1..16 gold.
    # For AMMO the vanilla arrow ladder is the proof, and it is an exact, ordered fingerprint.
    ladder_ok = None
    if t == "AMMO":
        want = {"IronArrow": 1, "SteelArrow": 2, "OrcishArrow": 3, "DwarvenArrow": 4,
                "ElvenArrow": 5, "GlassArrow": 6, "EbonyArrow": 7, "DaedricArrow": 8}
        seen = {e: i32(d, shipped) for e, d in rs if e in want and len(d) >= shipped + 4}
        ladder_ok = bool(seen) and all(seen.get(k) == v for k, v in want.items() if k in seen)
        report.setdefault("ammoLadder", {"expected": want, "read": seen, "matches": ladder_ok})
        agrees = ladder_ok
    else:
        agrees = (shipped in gold) or (t == "KEYM" and not gold)
    report["types"][t] = {"records": len(rs), "minFieldLen": size, "field": FIELD[t].decode(),
                          "offsets": offsets, "goldCandidates": gold,
                          "shippedOffset": shipped, "agreesWithShipped": agrees}
    print("%-5s n=%-6d field=%-4s gold offsets %-10s shipped %-3d %s%s"
          % (t, len(rs), FIELD[t].decode(), gold, shipped, "OK" if agrees else "MISMATCH",
             " (by arrow ladder)" if ladder_ok is not None else ""))

# ---- SPEL: SPIT.spellCost is a uint32 at offset 0 of a 36-byte block (libespm SPITData) ---------
TYPE = {0: "Spell", 1: "Disease", 2: "Power", 3: "LesserPower", 4: "Ability", 5: "Poison", 10: "Addiction", 11: "Voice"}
LADDER = ["Healing", "Flames", "Frostbite", "Sparks", "Candlelight", "Firebolt", "IceSpike",
          "FastHealing", "Fireball", "Oakflesh", "CloseWounds", "Incinerate", "GrandHealing",
          "IcySpear", "Ebonyflesh", "Thunderbolt", "Blizzard"]
agg = collections.defaultdict(lambda: [0, 0, 0])
ladder = {}
for p in lo.plugins:
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ("SPEL",)):
        body = lo.body(p, off, sz, fl)
        subs = {}
        for tag, d in esplib.subrecords(body):
            subs.setdefault(tag, d)
        d = subs.get(b"SPIT")
        if not d or len(d) < 36:
            continue
        cost, flags, st = struct.unpack_from("<III", d, 0)
        a = agg[TYPE.get(st, st)]
        a[0] += 1
        if cost:
            a[1] += 1
        if not (flags & 0x1):
            a[2] += 1
        e = esplib.edid_of(body) or ""
        if e in LADDER:
            ladder[e] = cost
report["spel"] = {"byType": {k: {"n": v[0], "costNonZero": v[1], "autoCalc": v[2]} for k, v in agg.items()},
                  "ladder": [{"edid": e, "cost": ladder.get(e)} for e in LADDER],
                  "monotonic": all(ladder.get(LADDER[i], 0) <= ladder.get(LADDER[i + 1], 0)
                                   for i in range(len(LADDER) - 1) if LADDER[i] in ladder and LADDER[i + 1] in ladder)}
print("SPEL ladder:", ", ".join("%s=%s" % (e, ladder.get(e)) for e in LADDER))
print("SPEL cost rises with spell power:", report["spel"]["monotonic"])

with open(OUT, "w", encoding="utf-8") as fh:
    json.dump(report, fh, indent=1)
print("wrote", OUT)
