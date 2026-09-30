# Owned spawns

Every living creature a DragonBreak-owned plugin places **Initially Disabled** becomes a server spawn of its own base,
at its own spot and heading. Nate, 30 Sep: "those living actors should be used as spawns for their respective npc",
creatures only.

- `owned_spawns.py` reads the load order with esplib and writes `server/owned-spawns.json`: spawns, groups (by the
  nearest map marker within 3000 units, else the cell) and camps (a group with a `Treas...Chest` of ours). It skips
  people (race with ActorTypeNPC), Starts Dead corpses, interiors and anything `dungeons.json` places.
  - Anchors come only from plugins that are not ours, so no release of ours can move them.
  - `--replace "<plugin>=<path>"` reads a copy that has not shipped yet.
  - It takes a few seconds on CT 115: `sudo`, since it reads `/opt/skyrim-data`.
- `wildlife.js` turns each spawn into a `wild:<kind>:p<local id>-<plugin>` zone and adds the camps' chests to the
  camp chest roll. `gamemode-config.json` `animalBody` decides what the bodies give (goblins keep their gear).
- `spawns_gate.py` is the release gate. Every creature in the list must be in the shipping plugin, Initially Disabled,
  and every camp chest present; an empty list passes. Exit 0 prints `ok`; exit 1 gives a one-line reason.
- `test_owned_spawns.py`: `sudo python3 tools/spawns/test_owned_spawns.py` runs both against the live order and DLE v5.

Release: regenerate with the shipping copy, commit `owned-spawns.json`, run the gate, then ship the plugin and the
gameplay together. See `CHECKLIST.md` (30 Sep, "placing creatures in our plugins").
