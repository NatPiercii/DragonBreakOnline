"""Regenerate skymp5-backend/data/modlist.json from the collection, using each mod's Nexus page name."""
import argparse
import glob
import json
import os
import urllib.request

REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".."))
QUERY = "query($ids:[CompositeDomainWithIdInput!]!){legacyModsByDomain(ids:$ids){nodes{modId name}}}"


def nexus_names(domain, mod_ids):
    names = {}
    for i in range(0, len(mod_ids), 20):
        body = {"query": QUERY, "variables": {"ids": [{"gameDomain": domain, "modId": m} for m in mod_ids[i:i + 20]]}}
        req = urllib.request.Request("https://api.nexusmods.com/v2/graphql", data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json", "User-Agent": "dragonbreak-modlist"})
        with urllib.request.urlopen(req, timeout=60) as r:
            for node in json.loads(r.read())["data"]["legacyModsByDomain"]["nodes"]:
                names[node["modId"]] = node["name"]
    return names


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    staging = os.path.join(os.environ.get("APPDATA", ""), "Vortex", "skyrimse", "mods")
    ap.add_argument("--collection", default=max(glob.glob(os.path.join(staging, "*", "collection.json")) or [""],
                                                   key=lambda p: os.path.getmtime(p) if p else 0))
    ap.add_argument("--out", default=os.path.join(REPO, "skymp5-backend", "data", "modlist.json"))
    args = ap.parse_args()

    with open(args.collection, encoding="utf-8") as f:
        col = json.load(f)
    domain = col["info"].get("domainName") or "skyrimspecialedition"
    ids = sorted({m["source"]["modId"] for m in col["mods"] if m["source"].get("modId")})
    names = nexus_names(domain, ids)
    lost = [m for m in ids if m not in names]
    if lost:
        raise SystemExit("Nexus returned no name for mod ids: %s" % lost)

    entries = [{"name": "SkyMP Client", "required": True, "enabled": True, "source": "backend"}]
    for mod_id in sorted(ids, key=lambda m: names[m]):
        entries.append({"name": names[mod_id], "required": True, "enabled": True, "source": "nexus", "nexusId": mod_id})
    with open(args.out, "w", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(entries, indent=2, ensure_ascii=False) + "\n")
    print("%s: SkyMP Client + %d mods" % (args.out, len(ids)))


if __name__ == "__main__":
    main()
