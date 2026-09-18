// DragonBreak minimal gamemode.
//
// The build copies this file to build/dist/server/gamemode.js (see skymp5-functions-lib/CMakeLists.txt)
// when BUILD_GAMEMODE is OFF, so no GitHub token or private upstream gamemode is needed. The server
// loads it last (skymp5-server/ts/index.ts setupGamemode) and hot-reloads it when the file changes.
//
// The server calls mp.clear() before every (re)load, which drops every registered property. The
// fork's server systems and client read these custom properties, so they are registered here.
// Built-in properties (pos, inventory, consoleCommandsAllowed, ...) need no registration.
"use strict";

// owner: the actor's own client receives the value; neighbors: nearby clients do too
// (the engine ignores neighbors when owner is false).
const PROPERTIES = {
  // AdminSystem (skymp5-server/ts/systems/adminSystem.ts) mirrors admin modes; other clients
  // hide or ghost invisible admins from it (skymp5-client/src/view/formView.ts).
  ff_adminModes: { owner: true, neighbors: true },
  // NPC hostility set by npcSpawnSystem/companionSystem, read by formView for nearby NPCs.
  ff_hostile: { owner: true, neighbors: true },
  // Companion ownership set by companionSystem, read by formView for nearby companions.
  ff_companionOf: { owner: true, neighbors: true },
  // "#TAG" shown for other players (formView) and matched by admin commands. Nothing sets it yet.
  ff_charTag: { owner: true, neighbors: true },
  // Actor ids the player has been introduced to; real names instead of "Stranger" in formView,
  // interaction prompts, search and trade. Only the player's own client sees the list. Nothing sets it yet.
  ff_knownIds: { owner: true, neighbors: false },
};

let registered = 0;
for (const [name, visibility] of Object.entries(PROPERTIES)) {
  try {
    mp.makeProperty(name, {
      isVisibleByOwner: visibility.owner,
      isVisibleByNeighbors: visibility.neighbors,
      updateOwner: "",
      updateNeighbor: "",
    });
    registered++;
  } catch (e) {
    console.error(`[dragonbreak-gamemode] could not register ${name}: ${e}`);
  }
}
console.log(`[dragonbreak-gamemode] registered ${registered}/${Object.keys(PROPERTIES).length} properties`);
