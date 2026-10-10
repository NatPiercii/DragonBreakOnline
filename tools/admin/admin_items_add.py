#!/usr/bin/env python3
"""Adds every new playable item of the DragonBreak-owned plugins to admin-items.json (Nate, 10 Oct: "make sure all new
items are added to the admin panel, always"). The full catalogue comes from ck-mcp/admin_catalog.py on the PC; this
keeps it complete between those runs, with the same rules (types, playable, BAD names, body slot, categories).
    python3 tools/admin/admin_items_add.py [--data /opt/skyrim-data] [--catalog admin-items.json] [--check] [plugin ...]
Default plugins: DragonBreak Online Edits.esp, DragonBreak Nexus Patches.esp, DragonBreak.esp, DragonBreak Harvest.esp.
Only records a plugin creates itself (form id index = its master count). --check writes nothing and exits 1 when
anything is missing (the release gate). Existing entries are never changed or removed."""
import sys, os, json, struct, zlib, re, argparse
TYPES = {b"WEAP", b"ARMO", b"AMMO", b"ALCH", b"INGR", b"MISC", b"BOOK", b"SLGM", b"KEYM", b"SCRL"}
BAD = re.compile(r"dummy|test|unarmed|skin|naked|^fx|nopickup|npconly|_npc|npc_|delete|unused|zzz|removed", re.I)
def subs(b):
    j = 0; r = {}
    while j < len(b) - 6:
        n = b[j:j+4]; l = struct.unpack("<H", b[j+4:j+6])[0]; r.setdefault(n, b[j+6:j+6+l]); j += 6 + l
    return r
def humanize(e):
    e = re.sub(r"^(DBO_?|DBORS_|DBOBAG_|DBOSM_)", "", e); e = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", e)
    return e.replace("_", " ").strip() or "Unknown"
def category(t, s):
    if t == b"WEAP": return "Enchanted Weapons" if b"EITM" in s else "Weapons"
    if t == b"ARMO":
        bod = s.get(b"BOD2") or s.get(b"BODT") or b""
        biped = struct.unpack("<I", bod[:4])[0] if len(bod) >= 4 else 0
        atype = struct.unpack("<I", bod[4:8])[0] if len(s.get(b"BOD2") or b"") >= 8 else 2
        if not biped: return None
        if biped & (0x20 | 0x40): return "Jewelry"
        if atype == 2: return "Clothing"
        return "Enchanted Armor" if b"EITM" in s else "Armor"
    if t == b"ALCH":
        enit = s.get(b"ENIT") or b""; return "Food" if len(enit) >= 8 and struct.unpack("<I", enit[4:8])[0] & 0x2 else "Potions"
    if t == b"BOOK":
        d = s.get(b"DATA") or b""; return "Spell Tomes" if d and d[0] & 0x04 else "Books"
    return {b"AMMO": "Arrows", b"INGR": "Ingredients", b"MISC": "Misc", b"SLGM": "Soul Gems", b"KEYM": "Keys", b"SCRL": "Scrolls"}[t]
def scan(path, plugin):
    d = open(path, "rb").read(); hs = struct.unpack("<I", d[4:8])[0]
    hdr = d[24:24+hs]; masters = 0; j = 0
    while j < len(hdr) - 6:
        n = hdr[j:j+4]; l = struct.unpack("<H", hdr[j+4:j+6])[0]
        if n == b"MAST": masters += 1
        j += 6 + l
    localized = bool(struct.unpack("<I", d[8:12])[0] & 0x80)
    i = 24 + hs; out = []
    while i < len(d) - 24:
        t = d[i:i+4]
        if t == b"GRUP": i += 24; continue
        sz, fl, fid = struct.unpack("<III", d[i+4:i+16])
        if t in TYPES and (fid >> 24) == masters and not fl & 0x20 and not fl & 0x4:
            body = d[i+24:i+24+sz]
            if fl & 0x40000: body = zlib.decompress(body[4:])
            s = subs(body); e = (s.get(b"EDID") or b"")[:-1].decode("cp1252", "replace")
            cat = category(t, s)
            if e and cat and not BAD.search(e):
                full = s.get(b"FULL")
                name = full[:-1].decode("cp1252", "replace") if full and not localized and len(full) > 1 else humanize(e)
                out.append((cat, ["%x:%s" % (fid & 0xffffff, plugin), name, plugin]))
        i += 24 + sz
    return out
ap = argparse.ArgumentParser(); ap.add_argument("--data", default="/opt/skyrim-data"); ap.add_argument("--catalog", default="admin-items.json")
ap.add_argument("--check", action="store_true"); ap.add_argument("plugins", nargs="*")
a = ap.parse_args()
plugins = a.plugins or ["DragonBreak Online Edits.esp", "DragonBreak Nexus Patches.esp", "DragonBreak.esp", "DragonBreak Harvest.esp"]
cat = json.load(open(a.catalog))
have = {it[0].lower() for c in cat["categories"] for it in c["items"]}
byid = {c["id"]: c for c in cat["categories"]}
added = []
for p in plugins:
    path = p if os.path.isabs(p) else os.path.join(a.data, p)
    if not os.path.exists(path): print("missing plugin", path); continue
    name = os.path.basename(path)
    for c, item in scan(path, name):
        if item[0].lower() in have: continue
        have.add(item[0].lower()); added.append((c, item))
        if not a.check:
            if c not in byid: byid[c] = {"id": c, "label": c, "items": []}; cat["categories"].append(byid[c])
            byid[c]["items"].append(item)
counts = {}
for c, _ in added: counts[c] = counts.get(c, 0) + 1
if a.check:
    print("admin-items: %d new item(s) missing %s" % (len(added), counts) if added else "admin-items: complete"); sys.exit(1 if added else 0)
for c in byid.values(): c["items"].sort(key=lambda x: (x[1].lower(), x[2]))
tmp = a.catalog + ".tmp"; json.dump(cat, open(tmp, "w"), separators=(",", ":")); os.replace(tmp, a.catalog)
print("admin-items: added %d %s" % (len(added), counts))
