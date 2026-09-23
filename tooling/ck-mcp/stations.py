"""Where every trade station in skills.json actually stands.

Eight of the eighteen skills are opened by setting a hand on a station: masterySystem's activate loop
tests `gates.stations` as a keyword on the base record first, and as an editor-id prefix for whatever
does not resolve to a KYWD. A trade whose stations are all outside the playtest region cannot be taken
up at all while the Bruma lock is on - which is exactly the hole the deity pass found for prayer, where
every shrine id in the file was a Skyrim shrine.

This answers, per skill: which base objects satisfy its gate, how many REFRs place them, and how many
of those are reachable under the region lock.

usage: py ck-mcp/stations.py
"""
import sys, json, struct, collections
sys.path.insert(0, r"E:\DragonBreak Online Dev files\ck-mcp")
import core, esplib

DATA = r"E:\DragonBreak Online Dev files\Skyrim Special Edition - dev\Data"
PLUGINS = r"E:\DragonBreak Online Dev files\server\plugins.server.txt"
SKILLS = r"E:\DragonBreak Online Dev files\server\skills.json"
OUT = r"E:\DragonBreak Online Dev files\server\station-placements.json"

# The worlds gamemode-config's playtest block allows. Same set shrines.py uses.
ALLOWED = {"BSHeartland.esm:0A764B", "BSHeartland.esm:06ADE1",
           "BSHeartland.esm:07F126", "BSHeartland.esm:0B95A6"}

# A station is a thing you touch: FURN and ACTI are what the activate loop reads keywords from, and a
# prefix gate can also land on a static or a movable.
BASE_SIGS = ("FURN", "ACTI", "TACT", "MSTT", "STAT", "CONT")

lo = core.LoadOrder(DATA, PLUGINS)

sk = json.load(open(SKILLS, encoding="utf-8"))
gates = {}                                     # skill id -> [station names]
for k in sk["skills"]:
    names = (k.get("gates") or {}).get("stations") or []
    if names:
        gates[k["id"]] = list(names)

wanted_names = set()
for names in gates.values():
    wanted_names.update(n.lower() for n in names)

# ---- resolve the station names that are keywords ---------------------------------------------
kwd = {}                                       # lower editor id -> canonical KYWD id
for p in lo.plugins:
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ("KYWD",)):
        e = (esplib.edid_of(lo.body(p, off, sz, fl)) or "").lower()
        if e in wanted_names:
            kwd[e] = lo.canon(p, fid)

# ---- every base object that satisfies some gate ----------------------------------------------
# Keyword match, or editor-id prefix for a station name that is not a keyword - the same two tests
# masterySystem makes (`gateStations` then `gatePrefixes`).
prefixes = {}                                  # skill id -> [lowercase prefixes]
keywords = {}                                  # skill id -> set of canonical KYWD ids
for sid, names in gates.items():
    prefixes[sid] = [n.lower() for n in names if n.lower() not in kwd]
    keywords[sid] = set(kwd[n.lower()] for n in names if n.lower() in kwd)

bases = {}                                     # canonical base -> {"edid","type","skills":set}
for p in lo.plugins:
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, BASE_SIGS):
        body = lo.body(p, off, sz, fl)
        e = esplib.edid_of(body) or ""
        el = e.lower()
        kws = set()
        for sig, val in esplib.subrecords(body):
            if sig != b"KWDA":
                continue
            for i in range(0, len(val) - 3, 4):
                kws.add(lo.canon(p, struct.unpack("<I", val[i:i + 4])[0]))
        hit = set()
        for sid in gates:
            if kws & keywords[sid] or any(el.startswith(q) for q in prefixes[sid]):
                hit.add(sid)
        c = lo.canon(p, fid)
        if hit:
            # later plugin wins, and a base only needs to satisfy the gate in its winning override
            bases[c] = {"edid": e, "type": t, "skills": hit, "from": p.name}
        elif c in bases:
            # the winning override dropped the keyword - the station stops being one
            del bases[c]

# ---- cell and world names ---------------------------------------------------------------------
names = {}
for p in lo.plugins:
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ("WRLD", "CELL")):
        e = esplib.edid_of(lo.body(p, off, sz, fl)) or ""
        if e:
            names[lo.canon(p, fid)] = e

# ---- every placement ---------------------------------------------------------------------------
places = collections.defaultdict(list)
for p in lo.plugins:
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ("REFR",)):
        sub = lo.subrecords(p, off, sz, fl)
        nm = sub.get(b"NAME", b"")
        if len(nm) < 4:
            continue
        base = lo.canon(p, struct.unpack("<I", nm[:4])[0])
        if base not in bases:
            continue
        w, cl, g = ctx
        data = sub.get(b"DATA", b"")
        pos = struct.unpack("<3f", data[:12]) if len(data) >= 12 else (0.0, 0.0, 0.0)
        places[base].append({
            "refr": lo.canon(p, fid),
            "world": lo.canon(p, w) if w else None,
            "cell": lo.canon(p, cl) if cl else None,
            "pos": [round(v, 1) for v in pos],
            "from": p.name,
            "off": bool(b"XESP" in sub or (fl & 0x800) != 0),
        })


def reachable(q):
    """Inside a playtest world, or an interior that came from the Bruma plugins."""
    if q["world"] in ALLOWED:
        return True
    return bool(q["cell"]) and q["cell"].split(":")[0].lower() in ("bsheartland.esm", "bsassets.esm")


dump = {"_comment": "Generated by ck-mcp\\stations.py. Every base object that satisfies a skill's "
                    "gates.stations, and where it is placed. 'inPlaytest' counts placements inside "
                    "the playtest allowedWorlds or a Bruma-plugin interior - a trade with 0 there "
                    "cannot be taken up while the Bruma region lock is on.",
        "measured": "2026-09-20", "skills": {}}

print("=" * 100)
for sid in sorted(gates):
    mine = [b for b, v in bases.items() if sid in v["skills"]]
    total = sum(len(places[b]) for b in mine)
    reach = []
    for b in mine:
        for q in places[b]:
            if reachable(q):
                reach.append((b, q))
    unresolved = [n for n in gates[sid] if n.lower() not in kwd and
                  not any(bases[b]["edid"].lower().startswith(n.lower()) for b in mine)]
    print("%-13s %d base object(s), %d placement(s), %d in the playtest region" %
          (sid, len(mine), total, len(reach)))
    if unresolved:
        print("    station name(s) that match nothing at all: %s" % ", ".join(unresolved))
    seen = collections.Counter()
    for b, q in reach:
        seen[(bases[b]["edid"], names.get(q["world"] or q["cell"] or "", "?"))] += 1
    for (e, where), n in seen.most_common(8):
        print("      %-40s %-34s x%d" % (e, where, n))
    if not reach:
        print("      NONE REACHABLE - this trade cannot be opened under the region lock")
    print("-" * 100)
    dump["skills"][sid] = {
        "stations": gates[sid],
        "unmatchedStationNames": unresolved,
        "baseObjects": sorted(bases[b]["edid"] for b in mine),
        "placements": total,
        "inPlaytest": len(reach),
        "sample": [{"refr": q["refr"], "base": bases[b]["edid"],
                    "where": names.get(q["world"] or q["cell"] or "", ""), "pos": q["pos"]}
                   for b, q in reach[:6]],
    }

with open(OUT, "w", encoding="utf-8", newline="\r\n") as fh:
    json.dump(dump, fh, indent=2)
    fh.write("\n")
print("wrote", OUT)
