"""Checks every spawn, landing, gate and respawn point the server can put a character at, and reports how
far the nearest LIVING actor placement is. A login near one hangs the client: a placed creature's pathing
hands the engine a NaN heading and SkyrimSE spins in its angle normaliser forever (HANDOFF section 14,
diagnosed with two cdb dumps). Being alive near one is fine; only loading in next to one hangs.

Reference points from the evidence: the Bruma cathedral hang had creatures 7.7k away, the old Whiterun
landing 9.2k, and the Pale Pass arrival works at 170k. uGridsToLoad 5 loads roughly 10k units around the
player, so anything inside ~12k is in the grid that loads with the character.

    py ck-mcp\login_spot_check.py            checks the points below
    py ck-mcp\login_spot_check.py --safe X Y searches Tamriel near X,Y for a spot with nothing in the grid
"""
import sys, json, struct, math, collections
sys.path.insert(0, r"E:\DragonBreak Online Dev files\ck-mcp")
import core

lo = core.LoadOrder(r"E:\DragonBreak Online Dev files\Skyrim Special Edition - dev\Data",
                    r"E:\DragonBreak Online Dev files\server\plugins.server.txt")

GRID_UNITS = 12288      # what loads with the character
WARN_UNITS = 20480      # comfortable margin

# desc used by the server  ->  canonical worldspace record
WORLDS = {
    "3c:Skyrim.esm": "Skyrim.esm:00003C",
    "1a26f:Skyrim.esm": "Skyrim.esm:01A26F",     # Whiterun
    "1691d:Skyrim.esm": "Skyrim.esm:01691D",     # Windhelm
    "16bb4:Skyrim.esm": "Skyrim.esm:016BB4",     # Riften
    "16d71:Skyrim.esm": "Skyrim.esm:016D71",     # Markarth
    "37edf:Skyrim.esm": "Skyrim.esm:037EDF",     # Solitude
    "a764b:BSHeartland.esm": "BSHeartland.esm:0A764B",
}

# Everything gamemode.js can put a character at, with how it gets there
POINTS = [
    ("landing (gamemode default, old Whiterun spot)", "3c:Skyrim.esm", (22659, -8697), "login"),
    ("landing (configured: Pale Pass arrival)", "a764b:BSHeartland.esm", (48236.2, 260600.4), "login"),
    ("respawn temple: whiterun", "1a26f:Skyrim.esm", (24224, -3424), "respawn"),
    ("respawn temple: windhelm", "1691d:Skyrim.esm", (133991.62, 38708.79), "respawn"),
    ("respawn temple: riften", "16bb4:Skyrim.esm", (176322.81, -97021.73), "respawn"),
    ("respawn temple: markarth", "16d71:Skyrim.esm", (-176860, 4485), "respawn"),
    ("respawn temple: solitude", "37edf:Skyrim.esm", (-58718.41, 110638.56), "respawn"),
    ("respawn temple: falkreath", "3c:Skyrim.esm", (-34460.36, -84385.39), "respawn"),
    ("respawn temple: bruma (Pale Pass)", "a764b:BSHeartland.esm", (48236.2, 260600.4), "respawn"),
    ("hub gate: Whiterun", "3c:Skyrim.esm", (18313, -10665), "gate"),
    ("hub gate: Riften", "3c:Skyrim.esm", (173137, -90912), "gate"),
    ("hub gate: Solitude", "3c:Skyrim.esm", (-74344, 96470), "gate"),
    ("hub gate: Windhelm", "3c:Skyrim.esm", (135039, 33143), "gate"),
    ("hub gate: Markarth", "3c:Skyrim.esm", (-171097, 6922), "gate"),
    ("hub gate: Falkreath", "3c:Skyrim.esm", (-30296, -86284), "gate"),
    ("hub gate: Morthal", "3c:Skyrim.esm", (-38640, 66734), "gate"),
    ("hub gate: Dawnstar", "3c:Skyrim.esm", (30808, 106138), "gate"),
    ("hub gate: Winterhold", "3c:Skyrim.esm", (109208, 102864), "gate"),
]

# The winning override decides what the game loads, so the last plugin in the load order wins here.
# wildlife.py does the opposite on purpose (it counts placements the server replaced, before curation);
# copying that rule here would report actors DragonBreak has already switched off.
enable = {}
def note_enable(p, fid, fl, sub):
    key = lo.canon(p, fid)
    x = sub.get(b"XESP", b"")
    parent = lo.canon(p, struct.unpack("<I", x[:4])[0]) if len(x) >= 4 else None
    enable[key] = (fl, parent, len(x) >= 8 and bool(struct.unpack("<I", x[4:8])[0] & 1))

wanted = set(WORLDS.values())
seen = {}
for p in lo.plugins:
    for ri, t, fid, fl, off, sz, ctx in lo.records(p, ("ACHR",)):
        w, c, g = ctx
        if not w or not c:
            continue
        wc = lo.canon(p, w)
        if wc not in wanted:
            continue
        f = lo.ref_fields(p, off, sz, fl)
        if not f["pos"]:
            continue
        seen[lo.canon(p, fid)] = (wc, f, fl)
        note_enable(p, fid, fl, lo.subrecords(p, off, sz, fl))

todo = {e[1] for e in enable.values() if e[1]} - set(enable)
rounds = 0
while todo and rounds < 4:
    rounds += 1
    for p in lo.plugins:
        for ri, t, fid, fl, off, sz, ctx in lo.records(p, ("ACHR", "REFR")):
            if lo.canon(p, fid) in todo:
                note_enable(p, fid, fl, lo.subrecords(p, off, sz, fl))
    found = todo & set(enable)
    todo = {enable[k][1] for k in found if enable[k][1]} - set(enable)

def enabled_at_start(key, depth=0):
    e = enable.get(key)
    if e is None:
        return True
    fl, parent, opposite = e
    if fl & 0x20:
        return False
    if parent and depth < 16:
        return enabled_at_start(parent, depth + 1) != opposite
    return not fl & 0x800

living = collections.defaultdict(list)   # world -> [(x, y, ref, base)]
skipped = collections.Counter()
for key, (wc, f, fl) in seen.items():
    if fl & 0x20:
        skipped["deleted"] += 1; continue
    if fl & 0x200:
        skipped["starts dead"] += 1; continue
    if not enabled_at_start(key):
        skipped["disabled at game start"] += 1; continue
    bi = lo.base_info(f["base"]) or {}
    living[wc].append((f["pos"][0], f["pos"][1], key, bi.get("editor_id", "?")))

print(f"living actor placements: " + ", ".join(f"{d} {len(living[w])}" for d, w in WORLDS.items()))
print(f"not counted: {dict(skipped)}\n")

def nearest(world_desc, x, y):
    rows = living.get(WORLDS[world_desc], [])
    best, bestrow = 1e12, None
    for ax, ay, ref, base in rows:
        d = math.hypot(ax - x, ay - y)
        if d < best:
            best, bestrow = d, (ref, base)
    return best, bestrow

if "--safe" in sys.argv:
    i = sys.argv.index("--safe")
    cx, cy = float(sys.argv[i + 1]), float(sys.argv[i + 2])
    print(f"searching Tamriel around ({cx:.0f}, {cy:.0f}) for a spot with nothing living within {GRID_UNITS}:")
    found = []
    for gx in range(-8, 9):
        for gy in range(-8, 9):
            px, py = cx + gx * 4096, cy + gy * 4096
            d, _ = nearest("3c:Skyrim.esm", px, py)
            if d >= GRID_UNITS:
                found.append((d, px, py))
    found.sort(reverse=True)
    for d, px, py in found[:10]:
        print(f"  [{px:.0f}, {py:.0f}]  nearest living actor {d:.0f} units, {math.hypot(px-cx, py-cy):.0f} from the centre")
    if not found:
        print("  none: every candidate has a living actor in its loaded grid")
    sys.exit(0)

rows = []
for name, world, (x, y), how in POINTS:
    d, who = nearest(world, x, y)
    verdict = "HANGS A LOGIN" if d < GRID_UNITS else ("thin margin" if d < WARN_UNITS else "clear")
    if how != "login":
        verdict += " (not a login point today)"
    rows.append((name, world, round(d), who[1] if who else "-", verdict))

w = max(len(r[0]) for r in rows)
print(f"{'point'.ljust(w)}  nearest  base                              verdict")
for name, world, d, base, verdict in sorted(rows, key=lambda r: r[2]):
    print(f"{name.ljust(w)}  {d:7d}  {base[:32].ljust(32)}  {verdict}")
out = r"E:\DragonBreak Online Dev files\server\login-spot-check.json"
json.dump([{"point": n, "world": wd, "nearestLivingActor": d, "base": b, "verdict": v} for n, wd, d, b, v in rows],
          open(out, "w"), indent=1)
print("\nwrote", out)
