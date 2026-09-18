"""Build an MO2-shaped reference install from a Vortex install of the collection, for compile-manifest.js."""
import argparse
import glob
import hashlib
import json
import os
import sys

import vortex_msgpack

REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".."))
BASE_MASTERS = {"skyrim.esm", "update.esm", "dawnguard.esm", "hearthfires.esm", "dragonborn.esm"}
PLUGIN_EXT = (".esp", ".esm", ".esl")


def newest(paths):
    return max(paths, key=os.path.getmtime) if paths else None


def link(src, dst):
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    if not os.path.exists(dst):
        os.link(src, dst)


def md5(path):
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 22), b""):
            h.update(chunk)
    return h.hexdigest()


def write_text(path, lines):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines) + "\n")


def add_archive(out, path, mod_id, file_id):
    dst = os.path.join(out, "downloads", os.path.basename(path))
    link(path, dst)
    write_text(dst + ".meta", ["[General]", "modID=%s" % (mod_id or 0), "fileID=%s" % (file_id or 0)])


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--vortex", default=os.path.join(os.environ.get("APPDATA", ""), "Vortex"))
    ap.add_argument("--game", default="skyrimse")
    ap.add_argument("--out", default=r"C:\dbref", help="new, empty folder on the same drive as Vortex (files are hardlinked)")
    ap.add_argument("--loadorder", default=os.path.join(REPO, "deploy", "skyrim-data", "loadorder.txt"))
    ap.add_argument("--search", action="append", default=[os.path.join(os.path.expanduser("~"), "Downloads")],
                    help="extra folder holding collection archives Vortex no longer keeps (repeatable)")
    ap.add_argument("--add-file", action="append", default=[], metavar="MOD/REL=SRC",
                    help="put a file into a reference mod that Vortex has not deployed (repeatable)")
    args = ap.parse_args()

    out = os.path.abspath(args.out)
    if os.path.isdir(out) and os.listdir(out):
        sys.exit("%s is not empty; remove it or pass another --out" % out)

    state_file = newest(glob.glob(os.path.join(args.vortex, "temp", "state_backups_full", "*.json")))
    if not state_file:
        sys.exit("No Vortex state backup under temp/state_backups_full; open Vortex once and retry.")
    with open(state_file, encoding="utf-8") as f:
        state = json.load(f)
    staging = os.path.join(args.vortex, args.game, "mods")
    dep = vortex_msgpack.load(os.path.join(staging, "vortex.deployment.msgpack"))
    game_root = os.path.dirname(dep["targetPath"])

    mod_ids = {}
    for key, mod in state["persistent"]["mods"].get(args.game, {}).items():
        mod_ids[mod.get("installationPath") or key] = (mod.get("attributes") or {}).get("modId")

    per_mod = {}
    for e in dep["files"]:
        if not e["relPath"].lower().endswith(".log"):
            per_mod.setdefault(e["source"], []).append(e["relPath"])
    for mod, rels in per_mod.items():
        for rel in rels:
            link(os.path.join(staging, mod, rel), os.path.join(out, "mods", mod, rel))
        write_text(os.path.join(out, "mods", mod, "meta.ini"), ["[General]", "modid=%s" % (mod_ids.get(mod) or 0)])
    for spec in args.add_file:
        target, src = spec.split("=", 1)
        mod, rel = target.replace("\\", "/").split("/", 1)
        link(os.path.abspath(src), os.path.join(out, "mods", mod, rel))
        per_mod.setdefault(mod, []).append(rel)
    print("mods: %d folders, %d files (only the files each mod won in the Vortex deployment)"
          % (len(per_mod), sum(len(v) for v in per_mod.values())))

    dl_root = state["settings"]["downloads"]["path"].replace("{USERDATA}", args.vortex)
    have = set()
    for d in state["persistent"]["downloads"]["files"].values():
        path = os.path.join(dl_root, args.game, d.get("localPath") or "")
        if args.game not in (d.get("game") or []) or d.get("state") != "finished" or not os.path.isfile(path):
            continue
        ids = ((d.get("modInfo") or {}).get("nexus") or {}).get("ids") or {}
        add_archive(out, path, ids.get("modId"), ids.get("fileId"))
        have.add((d.get("fileMD5") or "").lower())
    print("downloads: %d archives from Vortex" % len(have))

    collection = newest(glob.glob(os.path.join(staging, "*", "collection.json")))
    with open(collection, encoding="utf-8") as f:
        wanted = [m for m in json.load(f)["mods"] if (m["source"].get("md5") or "").lower() not in have]
    by_size = {}
    for m in wanted:
        by_size.setdefault(int(m["source"]["fileSize"]), []).append(m)
    found = set()
    for folder in args.search + [os.path.join(dl_root, args.game)]:
        for name in os.listdir(folder) if os.path.isdir(folder) else []:
            path = os.path.join(folder, name)
            if not os.path.isfile(path) or os.path.getsize(path) not in by_size:
                continue
            digest = md5(path)
            for m in by_size[os.path.getsize(path)]:
                if m["source"]["md5"].lower() == digest and m["source"]["fileId"] not in found:
                    add_archive(out, path, m["source"]["modId"], m["source"]["fileId"])
                    found.add(m["source"]["fileId"])
    missing = [m for m in wanted if m["source"]["fileId"] not in found]
    print("collection archives found outside Vortex: %d, still missing: %d" % (len(found), len(missing)))

    implicit = set(BASE_MASTERS)
    ccc = os.path.join(game_root, "Skyrim.ccc")
    if os.path.isfile(ccc):
        with open(ccc, encoding="utf-8") as f:
            implicit |= {l.strip().lower() for l in f if l.strip()}
    with open(args.loadorder, encoding="utf-8") as f:
        enabled = [l.strip() for l in f if l.strip() and l.strip().lower() not in implicit]
    shipped = {r for rels in per_mod.values() for r in rels
               if "/" not in r.replace("\\", "/") and r.lower().endswith(PLUGIN_EXT)}
    shipped_lower = {p.lower(): p for p in shipped}
    absent = [p for p in enabled if p.lower() not in shipped_lower]
    disabled = sorted(p for p in shipped if p.lower() not in {e.lower() for e in enabled})
    profile = os.path.join(out, "profiles", "DragonBreak")
    write_text(os.path.join(profile, "plugins.txt"), ["*" + p for p in enabled] + disabled)
    write_text(os.path.join(profile, "modlist.txt"), ["+" + m for m in sorted(per_mod, key=str.lower)])
    print("profile: %d enabled plugins from %s, %d shipped but disabled" % (len(enabled), args.loadorder, len(disabled)))

    root = vortex_msgpack.load(os.path.join(staging, "vortex.deployment.dinput.msgpack"))
    root_files = sorted({e["relPath"].replace("\\", "/") for e in root["files"]
                         if not e["relPath"].lower().startswith("skse64_")})
    sources_path = os.path.join(REPO, "skymp5-backend", "data", "manifest-sources.json")
    sources = {"urls": {}, "rootInclude": []}
    if os.path.isfile(sources_path):
        with open(sources_path, encoding="utf-8") as f:
            sources.update(json.load(f))
    sources["rootInclude"] = sorted(set(sources.get("rootInclude") or []) | {r for r in root_files if "/" not in r})
    with open(sources_path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(sources, f, indent=2)
    print("rootInclude: %s" % (", ".join(sources["rootInclude"]) or "none"))

    for m in missing:
        print("  MISSING archive: %s  https://www.nexusmods.com/%s/mods/%s?tab=files&file_id=%s"
              % (m["name"], m.get("domainName") or "skyrimspecialedition", m["source"]["modId"], m["source"]["fileId"]))
    for p in absent:
        print("  MISSING plugin: %s is in loadorder.txt but no deployed mod ships it" % p)
    if missing or absent:
        sys.exit(1)
    print("\nNext:\n  node skymp5-backend/scripts/compile-manifest.js --mo2 \"%s\" --game \"%s\" --no-modlist" % (out, game_root))


if __name__ == "__main__":
    main()
