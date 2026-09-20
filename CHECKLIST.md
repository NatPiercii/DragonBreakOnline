# DragonBreak Online checklist (2026-09-14)

## Added 2026-09-19 (evening): four dungeon-survey bugs fixed, dungeons.json and wildlife.json regenerated (LIVE 19:01)

Placements 4,244 -> 3,500 in `server\dungeons.json` and 3,329 -> 3,185 in `server\wildlife.json`. Full
before/after per dungeon: `server\_data-backup-survey-fixes-20260919-142041\per-dungeon-changes.txt`; that folder
also holds the previous dungeons.json, wildlife.json, dungeon-pools.json, NPC-Spawns.json and dungeons_survey.json.
Script backups are `ck-mcp\*.py.bak-20260919-141334`.

- [x] **Starts Dead corpses no longer spawn alive** (`ck-mcp\dungeons_survey.py`, `ck-mcp\wildlife.py`): an ACHR
  whose record flag has 0x200 is a corpse and is left out. 1,122 left the dungeon survey (Caius's body in Sedor,
  Tenilis Nonno in Unmarked Cave, Nchuand-Zel's 5 falmer + boss, Alftand's 7 dwarven spiders, Liar's Retreat's 4
  bandits, Potema's draugr) and 99 the wildlife file (dead deer, horkers, a frost troll, Karthspire's giant).
  Checked across every plugin version: nothing in the order sets or clears 0x200 on an override, so the winning
  version decides.
- [x] **`dead` no longer matches inside `Undead`** (`dungeons_build.py`, mirrored in `dungeon_pools.py`): the word
  Undead is taken out of the editor id before the skip words are looked for. A plain `(?<!un)dead` lookbehind is
  NOT enough: `dunDead...` ends in "un" too, and it let `MS05_dunDeadMensRespite_Svaknir` through. 47 Ayleid undead
  came back - Rielle 2 -> 22, Sedor 28 -> 51, and 3 more of the user's own Vilverin placements (25 -> 28, all still
  DragonBreak Online Edits refs).
- [x] **Dragons are never spawned** (`dungeons_build.py`, user decision 2026-09-19): the Undead fix surfaced
  `dunLabyrinthianUndeadDragon`, the one dragon a dungeon would ever have placed. `resolve` now drops any NPC whose
  RACE is a dragon race, told apart by race and not by editor id, because `DragonRace`, `DragonBlackRace`,
  `UndeadDragonRace`, `DLC1UndeadDragonRace`, `DLC2DragonBlackRace` and `dlc2SpectralDragonRace` are dragons while
  `DragonPriestRace` and `DLC2AcolyteDragonPriestRace` are not. Effect: exactly one placement removed (Labyrinthian
  34 -> 32), no option list changed, the 7 dragon priest placements all stay.
- [x] **Enable parents (XESP) decide the start state** (`dungeons_survey.py`, `wildlife.py`): a placement is kept
  only when its enable-parent chain leaves it enabled at game start (`enabled = parentEnabled XOR opposite`,
  parents followed to the root, `0x1` of the XESP flags uint32 = "set enable state opposite of parent", verified
  against UESP's REFR/ACHR pages). Flags and XESP come from the last version before `DragonBreak.esp` and
  `DragonBreak Online Edits.esp`, because DLE disabled the actors the server spawns and stripped the XESP off 17 of
  them. 470 dungeon placements and 45 creatures went: Driftshade keeps its 17 Silver Hand and loses the 38 bandits,
  Dres Slavers Camp goes from 26 soldiers at 13 posts to the 13 Ally refs, Gallows Rock from two LvlSilverhandBoss
  to one, Ansilvund keeps 30 draugr and loses 12 skeletons, Wolfskull loses the quest necromancers, Korvanjund the
  MQ103 soldiers. Every one of them follows an XMarker flagged 0xc00 (persistent + initially disabled) in the same
  state, so they are off on a fresh game.
- [x] **NPC level read from the right bytes** (`dungeons_survey.py`, `dungeons_build.py`, `wildlife.py`): ACBS is
  flags uint32 @0, magicka/stamina offsets int16 @4/@6, level uint16 @8. The old `<IH` read the magicka offset as
  an unsigned level, so `EncBandit01Melee1HNordM` was level 65511 (offset -25) instead of 1 and `EncTroll` 0 instead
  of 14. 776 dungeon and 833 wildlife placements now carry real levels; nothing is above 1000 any more (116 dungeon
  options and 440 wildlife options were). This changes which option each difficulty band picks.
- [x] **Checks before going live**: the unfixed generators were rerun first and reproduce the live files exactly
  (dungeons.json identical except Vilverin's record order, wildlife.json two anchors that moved to newer DLE refs),
  so every difference below is the fixes and not load-order drift. `dungeon_pools.py` reran clean after its expect
  values were updated (19 families, 215 placement types, 3,022 options, 177 kept refs; only
  `cyrodiil.ayleid_undead` gained members, 1 -> 6 ids / 6 -> 36 slots, all generic `CYRLvlAyleidUndead*` templates
  with 5-11 options each). Pools dry run over the live `zonesFor`, 217 dungeons x 4 difficulties x 20 trials =
  252,097 zones, 0 failures. Gamemode reloaded at 18:09 with no lease active: 217 dungeons, 19 pool families, 3,185
  wildlife zones, no errors.
- [x] **Survey rerun from scratch at 18:39 after the dragon rule** (29 min) to pick up any plugin edit since the
  first run: byte-identical to the 14:18 survey, so the other session's 18:06 DLE change (a sunk secret door in Red
  Ruby Cave) touches nothing here. Rebuilt, pools regenerated (same 19 families / 215 types; the dragon was never
  pooled, `dun*` is in NEVER), dry run 252,081 zones / 0 failures, gamemode reloaded 19:01 with no lease active and
  no errors. `server\dungeon-pools.json` carries sha1 `c0fb782b...` of the current dungeons.json.
- [ ] **Follow-ups for the user to decide**
  - Five dungeons now hold no enemies at all, because everything in them was a corpse or starts disabled:
    Mountainwatch Frostiron Mine (12 goblins, all behind the CYRMountainWatchMS02 marker), Boreal Stone Cave (4),
    Gyldenhul Barrow (2), Guldun Rock (2), Bthalft Aetherium Forge (1). They can still be claimed and their chests
    still fill. Frostiron Mine is in Bruma, so a player can meet it during the playtest.
  - Quest-gated dungeons are thin now: Kolbjorn Barrow 95 -> 8, Korvanjund 39 -> 9, Kagrumez 20 -> 1, Yngol Barrow
    10 -> 1, Swindler's Den 32 -> 15, Temple of Miraak 50 -> 24 (its 24 parentless draugr stay; every cultist sits
    behind a DLC2MQ02 marker, which is why `solstheim.cultist` now has no placements). If leases should show the
    post-quest state instead, that is a second start-state table, not a bug in the survey.
  - Bruma has 11 Starts Dead creatures that DLE disabled as "living" actors and wildlife replaced with live ones.
    Those spots now have neither a corpse nor a creature. Re-enabling the corpses is a DLE edit and is the user's
    call (the standing rule is to keep corpses, and never to restore a disable on my own).
  - `ck-mcp\dungeons_anchor.py` was NOT run. The live file has been build-only since c71ccaa (2026-09-18), so every
    `ref` is Bethesda's ACHR, which is what dungeons.js, `dungeon_pools.py` KEEP_REFS and the faction diagnostic all
    read. Running the anchor step would swap them for the nearest loadable ref and change where spawns appear.

## Added 2026-09-19 (afternoon): remote vitals go through a relay packet, HUD heartbeat restored (LIVE 14:42)

Items 2 and 3 of `_reviews\2026-09-19-daily-review.md`, both from `4937b4c`. Both were measured before and
after, not reasoned about; the harness that did it is `server\tools\bot\` (below).

- [x] **The stamina/magicka mirror in `4937b4c` did nothing, CONFIRMED by measurement.** Two headless bots
  (`server\tools\bot\bot.py`, which drives the game's own `MpClientPlugin.dll` through ctypes, so messages are
  serialized exactly as the real client does) against an isolated server on port 7790: the mover sent movement
  with `staminaPercentage 0.33 / magickaPercentage 0.66`, the observer received
  `['direction','healthPercentage','isBlocking','isDead','isInJumpState','isSneaking','isWeapDrawn','pos','rot','runMode','speed','worldOrCell']`.
  The C++ `UpdateMovementMessage::Data` has `healthPercentage` only, so the client's own serializer drops the
  other two before they leave the machine. The earlier entry below is corrected.
- [x] **Server relay instead (`fork\skymp5-server\ts\systems\vitalsRelaySystem.ts`, commit 7e127f3).** The
  server already holds all three percentages (the owner's `ChangeValues`), so nothing new is sent upstream and
  nothing is added to movement. Every 500 ms it sends each online player's neighbours
  `{ customPacketType: "dboVitals", v: [actorId, stamina%, magicka%, ...] }`, integer percent, on first sight
  and then only on a 5 point change or on reaching 0 or 100. One packet per recipient per tick at most
  (several neighbours share one packet), pairs pruned when out of range. Knobs: `TICK_MS`, `STEP`.
  Measured on the isolated server: first sight `[ff000001, 37, 66]`, then 31, 25, 19, 13, 7 as stamina fell,
  one 55-byte packet each, movement unchanged.
- [x] **Client applies them (`remoteVitalsService.ts`, commit d91b556).** Sets each clone's values with the
  shared `setActorValuePercentage`; a re-created clone gets the last values again without another packet;
  magicka is not lowered while the clone is casting, so a replayed concentration spell is not cut short.
  The first values per clone print a `Trace in RemoteVitalsService` console line. `staminaPercentage` /
  `magickaPercentage` are gone from `Movement`, `getMovement`, the `remoteServer` literal and the companion
  drive call. The sharp lerp on `healthPercentage` stays.
- [x] **HUD heartbeat fixed (`dboRelayService.ts`, commit ba92b2d).** `4937b4c`'s `widgetJsonCache` skipped any
  JSON identical to the last send, which is exactly what the 5 s re-push of `pushHudStatic` / `pushParty` is,
  so a widget dropped from the browser by anything other than a full reload stayed gone. Both callers already
  dedupe on `hudKey` / `partyKey`, so the cache is removed. Measured by running the real service under node
  with SkyrimPlatform stubbed (`scratchpad svc harness`): 12 s idle gave **1** HUD push before, **3** after
  (t=0, 5 s, 10 s), and a value change still pushes in both.
- [x] Deployed: client bundle built from main HEAD (which includes `ec62938`, the other session's
  `ff_factions` change) to the dev copy and `client-dist` at 14:39, backup in
  `_client-bundle-backups\before-vitals-relay-20260919-143844\`; `dist_back` rebuilt and the server restarted
  under `run-logged.cmd` at 14:42, backup in `_alduinak-build-before-vitals-relay-20260919-143929\`. The
  uncommitted `npcSpawnSystem.ts` change from the other session was already in the live bundle and still is.
- [ ] **In game (user), needs a relaunch** (a running game keeps the old bundle): two players in sight of each
  other, one sprints to drain stamina; the other's console shows `Trace in RemoteVitalsService: clone ff0000xx
  stamina ..% magicka ..%`. Nothing in the vanilla UI shows another actor's stamina or magicka, so the console
  line (or a future party-panel bar) is the only visible proof. HUD: it should survive a widget drop within 5 s.
- [ ] Follow-up: **the relay carries players only.** Hosted NPCs' stamina/magicka are not mirrored (the server
  never learns them; `sendActorValuePercentage` sends the player's own values even for hosted refs). Nothing
  in the UI needs them today.
- [ ] Follow-up: **`server\tools\bot\`** is the start of the load-test harness the review asked for (S-items).
  Today it logs in, sends movement and `ChangeValues`, and prints what it receives; N bots walking Bruma and
  a bytes/tick report are the next step.

## Added 2026-09-19 (afternoon): tick timing, and scaling fixes S2, S7, S8 (LIVE 14:37)

From `_reviews\2026-09-19-daily-review.md`, "Scaling to 100 concurrent players". Gameplay layer only, no rebuild.
- [x] **Tick timing** (`gamemode.js`, "timers" section). Repeating timers are registered by name with
  `every(name, ms, fn)` in `globalThis.__dboTimers` and replaced by name on reload. Modules get `every` and
  `stopTimer` through their api. Every tick is timed: over 20 ms logs `slow tick <name>: N ms`
  (`debug.slowTickMs` in gamemode-config.json overrides it), and once a minute one line
  `ticks (ms, last 60 s, N online): <name> <count>x max .. mean ..`, sorted by total time. `dungeons.js` still
  creates its own two timers. `requireTimed` wraps `setInterval` while that file loads, so they are timed as
  `dungeons.tick` and `dungeons.arm` and keep their real handles. Per-user login waits are timed as `loginWait`.
- [x] **S2 meet timer**: players are bucketed per place into a grid one say-range wide (1,400 units), and only the
  3x3 neighbouring cells are checked. Each online actor's `private.metActors` is read once into a Set cache and
  written only when the list grows. Synthetic benchmark, mock `mp` that copies values on get, same met lists as
  the old code: 100 players in a 6,000-unit square 58.9 ms -> 0.47 ms per tick (1,494 -> 200 reads);
  100 in one room 532 ms -> 1.4 ms; 50 in one room 136 ms -> 0.2 ms.
- [x] **S7**: the pigeon cooldowns and the contracts save go through `saveSoon(file, snapshot)`: one async temp
  write + rename per dirty file every 5 s (`saves` timer). A reload first writes out whatever the previous
  generation left dirty (`saved <file> before reload`). Before, a reload dropped up to 5 s of contract
  progress. A crash still loses up to 5 s.
- [x] **S8**: timer starts are spread over the first second (golden-ratio slots), so the 5 s timers (watch,
  meet, playtest, saves) no longer fire in the same turn, and neither does everything else every 60 s.
  Periods are unchanged; a first run comes at most 1 s later than before.
- [x] Live numbers, 0 players online (the only load available): before (14:34-14:37) and after (14:38-14:39),
  every tick under 0.35 ms max, no slow ticks. The live log cannot show S2 until real players are on.
- [x] **S1 (LIVE 18:02, `dungeons.js`)**: `readSpawnedIds()` reads `zone-spawns.json` once per timer tick and
  every lease of that tick uses it; `trackNpcs(lease, ids)` and `armLease(lease, ids)` take it as an optional
  argument, so `finish()` on a claim and the `/dungeon` status line still read it themselves. Both timers moved
  onto `every` (`dungeons.tick`, `dungeons.arm`, both staggered and timed), and `requireTimed` in `gamemode.js`
  is gone with them. Measured with 3 fake leases against a mock mp, same seen/armed result either way: 16 arm
  ticks + 2 dungeon ticks went from 54 file reads to 17. The faction session's `getAllForms` removal stays;
  never use it for liveness, the engine caches it forever.
- [ ] Read the `ticks` lines during the next multi-player playtest; any `slow tick` names the next target.
  14:42-18:02 with 1 player and 2 dungeon leases: no slow tick, every timer under 0.7 ms max.
- [ ] After the next server restart, delete the legacy-handle `for` line under "timers" in `gamemode.js` (it
  only matters on the first reload onto the registry).

## Added 2026-09-19 (afternoon): form id checker `ck-mcp\verify_formids.py`

- [x] **Built** (HANDOFF §7). It resolves every `'<hex>:<Plugin>'` desc in server JS/JSON and the skymp5-server TS against the
  load order, and exits 1 on a missing, deleted, unloaded or out-of-range record, or on the wrong record type where the code
  names the type. On `e7f66fc`'s dungeons.js: 46 errors, including every id the review found missing or not an NPC_.
- [x] **Pre-commit hook installed** (user OK): `server\.git\hooks\pre-commit`, a copy of `ck-mcp\git-hooks\pre-commit`.
- [x] **`doors.py` kept dead door refs, fixed**: it now uses each ref's winning version, so a ref deleted by a later plugin
  (7, all by DragonBreak Online Edits.esp) or overridden without XTEL (105, by the city mods and DLE) is not a load door.
  `doors.json` regenerated: 4,153 -> 4,045 (112 removed, 4 new DLE doors near Riften). Live on the next gamemode reload
  (DOOR_NAMES is read at load). Backup `ck-mcp\doors.py.bak-20260919-143948`.
- [x] Checker fix on the way: descs whose plugin name has an apostrophe (JK's Castle Volkihar, JK's Fort Dawnguard,
  JK's Whiterun's Outskirts, OCW_Obscure's...) were silently skipped (40 in doors.json); they are checked now.

## Added 2026-09-19 (afternoon): dungeon actors spawn without their placement template's factions

Step 2 (ff_factions) is deployed and needs an in-game pass; the user chose it after Red Ruby Cave 14:24.
- [x] **Server** (`dungeons.js`, live 14:35): `factionCheck` runs in the 2 s arm tick and once in
  `startLease`'s `finish()`, i.e. before the party is moved in. It sets the neighbour-visible `ff_factions` =
  `{ f: [[factionId, rank], ...], c: crimeFactionId }` on each spawned actor whose placement template supplies
  other factions than the spawned base. It logs one `dungeon <id> factions: <placement> (<kind>) spawned as
  <base> [had], given [...]` line per pair. `ff_factions` is registered in `gamemode.js` (live file).
- [x] **Client** (fork `ec62938`, `formView.applyFactions`, next to `applyHostility`): once per value,
  `removeFromAllFactions()`, `setFactionRank(f, rank)` per entry, `setCrimeFaction(c)`. It reports `npcDrift`
  kind `factions` with `sent`/`applied`, where applied = getFactionRank read back equal. Live bundle md5
  82a5b592 (ec62938 + the vitals commits) in the dev copy and client-dist. Relaunch needed.
- [ ] **In-game pass**: claim Red Ruby Cave again. Thralls should stand with the vampires, not fight them.
  `server.log` should show the `factions:` lines and `npcDrift ... factions: {"sent":1,"applied":1}`.
- [x] **Found on the way, fixed (`dungeons.js`)**: `mp.getAllForms(0xff)` fills a cache on its first call and
  never refreshes it (`WorldState.cpp` 897-925). The 09-18 `liveForms` filter in `armLease` and `trackNpcs`
  therefore skipped every actor spawned after the first call of a process. Since 09-18: no arming (the last
  "armed" lines were Serpent's Trail 09-17 and one Anga lease today at 10:41, which made the first call), and
  no "cleared" ends (every Anga lease ended "left"). Both now go through `spawnerTag`, which remembers ids that
  throw. Do not use getAllForms for liveness until the C++ cache is invalidated on AddForm.
- [ ] **Red Ruby Cave blockers** (user 14:30: "a blocked off door activated with a chain"): `BSHeartland.esm:083DBD`
  `CYRMineSecretDoor`, opened by pull chains `0885AC`/`0885B3`, gets sunk in DLE with `DBO_BrumaInteriors.pas`
  (op `sink`). Waiting on the game being closed, because Skyrim holds the dev DLE. Also chain-driven there and
  left alone: `083F5B` `NorRetractableBridge01NONAVCUT` (chain `083F8E`). Sinking a bridge leaves a gap; ask the
  user if it blocks the way.
- [ ] **Dev DLE and `server\data` DLE differ**: the dev copy was saved 2026-09-18 15:57 (240 records added,
  1,082 changed: Falkreath sawmill, notice board refs, Whiterun cells, 85 SPEL, 48 QUST, one NAVM). The server
  copy is still 2026-09-16 20:41. Not recorded anywhere; the user decides whether it ships.
- Still not covered: ambush packages (1,086 slots), outfits (618), spells (280). Separate follow-ups.

Step 1 (verify), done before step 2:
- [x] **Record data confirms it.** `dungeons.js` spawns the concrete NPC_ that a placement's leveled list resolves
  to. The placement's own Lvl* template, with Use Factions unset, never reaches the actor. Scratch analysis over
  every placement in `dungeons.json` walked the template flags (ACBS u16 @18) both ways. Result: 4,244 placements,
  and the spawned actor loses factions in 503 slots, AI packages in 1,086 (the draugr, dwarven, Falmer and
  riekling ambush sit packages), AI data in 1,076, inventory/outfit in 618, spells in 280 and scripts in 978.
  Examples: every `(CYR)LvlVampireThrall*` becomes CYREncBandit/EncBandit in BanditFaction instead of
  (CYR)VampireThrallFaction. Silver Hand becomes BanditFaction. Blackblood (MS07BanditFaction), Thorina's
  Cutters, Morag Tong and Dres slavers become plain bandits or reavers. `DLC2LvlCultist*` lose
  CreatureFaction, SkeletonFaction, DragonPriestFaction and DLC2ApocryphaFaction. Morr500 loses the Baan Malur
  outfit.
- [x] **Diagnostic LIVE 14:18** (`server\dungeons.js`, section "faction check"). It runs a one-time boot audit
  over the live server's own records (`dungeon faction audit: 529 of 4244 placements spawn without their
  template's factions (202 kinds)`, 382 ms, once per process). It also writes one line per placement kind per
  lease: `dungeon <id> factions: <placement> (<kind>) spawned as <base> <id>: server has [...]; placement
  template gives [...], LOST`.
- [x] **In-game check (user, done 14:24 on Master; user saw the vampires, rats and bears, then chose ff_factions)**: claim **Red Ruby Cave** on Adept. It is in Bruma's world; F7 Locations has
  "Red Ruby Cave" 826 units from the door. Expected if confirmed: its 7 generic thralls are
  bandit-looking, and they fight its 5 vampires with nobody provoking them. The reason: the thralls spawn in
  BanditFaction with Very Aggressive AI data (2), the vampires in CYRVampireFaction (2). BanditFaction has no
  relation to CYRVampireFaction, so the two are neutral, and Very Aggressive attacks neutrals. The placement
  faction CYRVampireThrallFaction is Ally (2) to CYRVampireFaction. Then read the `factions:` lines in
  `server.log`. Gutted Mine (19 thralls, 2 vampires) and Haemar's Shame (Skyrim) show the same thing.
- [ ] **Step 2 options, checked in code (none built yet):**
  - Spawn the placement's own Lvl* base: rejected. Server `PlaceAtMe` accepts it and `EnsureTemplateChainEvaluated`
    picks a chain with pcLevel 0, i.e. any entry of the whole list, so difficulty is ignored. The client
    ignores the server's chain: `formView.ts` has `getLeveledBase` commented out upstream ("crashes too
    often"), and `TESModPlatform::EvaluateLeveledNpc` is a leaky experiment. So each client's engine rolls its
    own pick at its own player level, and race, sex and gear differ per client and from the server's stats.
    The pools would lose their meaning too.
  - Faction changes made on the server alone: they do nothing in game. `PapyrusActor::AddToFaction` only edits the
    server's change form, `CreateActorMessage` carries no factions, and faction relations are evaluated by the
    host client's engine.
  - **Recommended**: the server decides and the client applies. `dungeons.js` puts the placement template's
    factions (+ crime faction) into a neighbour-visible `ff_factions` property on each spawned actor, set before
    the party is moved in. `formView.ts` applies it next to `applyHostility`: `removeFromAllFactions()`, then
    `setFactionRank(f, rank)` (vanilla `AddToFaction` is just `SetFactionRank(f, 0)`; `Actor.psc`:591). The
    typings have both. Pools keep working: a family is one faction, so every archetype gets the placement's
    faction. Needs a client rebuild and relaunch, plus the property registered in `gamemode.js` (live file).
  - Not covered by that fix: ambush packages (no vanilla Papyrus adds a package; that needs a baked NPC_ per
    placement/option in a plugin, or a working `evaluateLeveledNpc`), outfits (could go through the server
    inventory + EquipItem the way `armLease` does), spells (client `addSpell`).

## Added 2026-09-19: dungeon enemy pools rebuilt from the leveled lists (LIVE 14:10)

- [x] **`ck-mcp\dungeon_pools.py` -> `server\dungeon-pools.json`** replaces the hand-typed `DIVERSE_ARCHETYPES`
  table in `dungeons.js`. 15 families, each one faction in one province, each archetype a set of root leveled
  lists looked up by editor id and resolved like `dungeons_build.py` does: Skyrim bandit, Silver Hand, vampire
  thrall, warlock (conjurer + elemental), Forsworn, Falmer, witch; Cyrodiil bandit, smuggler, vampire thrall,
  goblin, Blue Scalp goblin, Ayleid undead; Solstheim reaver, Miraak cultist. 167 placement types, 2288 options,
  all accepted as NPC_ by the running server at boot ("dungeon pools:" log line, it drops and logs any that are not).
- [x] **Selection is per placement, not per dungeon**: a generic placement (Lvl*/Enc*, not quest, named or `dun*`)
  swaps only within its own faction family; bosses (edid /boss/ or options all *Boss*) only into boss archetypes;
  everything else stays as Bethesda placed it. The old keyword rule had replaced Solstheim's Dunmer reavers, Dres
  slavers, Ildari and Niyya, Anga's Namira cultists and Caius, Vaermina devotees, Vigilants, goblins, smugglers and
  hagravens with Skyrim bandits and warlocks. Refs placed by DragonBreak.esp / DragonBreak Online Edits.esp
  (sewers, Vilverin), Starts Dead corpses and the quest/set-piece refs in `KEEP_REFS` are never swapped.
- [x] **Left vanilla on purpose**: draugr (their lists are already varied), necromancers, vampires, zombies and
  skeletons (one list each, a swap would change nothing), Thalmor (only in the curated sewers), Fort Horunn's
  conjurers (the Cyrodiil conjurer lists are mostly unique NPCs).
- [x] Province per dungeon now comes from its entrance worldspace (written into the pools file); the text search
  had tagged a Windhelm warehouse as Solstheim. `provinceOfDungeon` (arming) is unchanged.
- [x] Checks: the generator writes nothing if a list is missing, a placement fits two families, or a family's
  placement count differs from its `expect` in SPEC. Dry run of the real `zonesFor` over 217 dungeons x 4
  difficulties x 20 trials (305,790 zones): 0 failures. Designed by three province agents, each checked by a data
  and a lore reviewer. After regenerating `dungeons.json`, rerun `py ck-mcp\dungeon_pools.py` and reload the gamemode.
- [x] **Independent review round (code, data re-derived from the plugins, lore; each finding checked by a skeptic)**.
  Confirmed and fixed: 60 Skyrim/Dawnguard quest-alias actors were swappable (Brurid at Treva's Watch, Krev the
  Skinner, Morvunskar's forge conjurers, the dun*QST scene bandits); the generator now keeps every ref a quest
  alias forces (ALFR) and every ref a quest fills through its location (ALFA + ALRT: scene actors such as Redwater
  Den's chatter thrall and the Knifepoint Ridge DA02 bandits, and bosses the quest names, like Rigel Strong-Arm at
  Pinewatch; an unnamed Boss alias is the generic clear-the-dungeon one and stays swappable), read from the load
  order instead of hand lists. Also: goblin boss kinds keep 'boss' so they are armed
  and E-looted as before; the pools file is written through a tmp file; `dungeons.js` never swaps a
  DragonBreak.esp / DLE ref even if the pools are stale, and logs "built from a different dungeons.json" when the
  pools' recorded sha1 does not match. Refuted: hold-position archers swapped into melee (58 of 60 perches share a
  navmesh component with the room, and hold packages never reach spawned actors anyway), so they stay pooled.
  Now 134 placement types, 136 kept refs. Refuted as well: race/sex-locked Skyrim placements (after the alias keep,
  the 10 left are unnamed generic bandits, Forsworn and warlocks whose vanilla lists mix races anyway). Witches now count as humanoid for arming/E-loot (they are people; the
  old regex just lacked 'witch'); `CYRLvlGoblinMeleeGuard` no longer does (it matched only through 'Guard').
- [x] **Draugr and riekling families added** (LIVE 18:03, 19 families, 226 placement types, 3022 options): skyrim /
  solstheim / cyrodiil draugr (roles melee 1H, melee 2H, archer, warlock, each combining the male and female lists;
  membership follows the template chain to `LCharDraugr(Melee|Missile|Warlock)`) and solstheim riekling (melee,
  missile). Draugr **bosses stay vanilla**: `LCharDraugrBoss` tops out at a dragon priest and the NoDragonPriest list
  has one role. Solstheim's and Bruma's barrows (Kolbjorn, Vahlok's Tomb, Temple of Miraak, CYRNorthfringeSanctum) are
  filled from Skyrim.esm draugr lists in vanilla and in Beyond Skyrim, so those two families carry a `plugins`
  allowance. Kinds keep 'draugr'/'riekling', so arming and E-loot are unchanged. Lore review: role and sex mixing is
  vanilla behaviour, and every lore-specific group (Yngvild, Folgunthur, Reachwater Rock, Red Eagle, Ustengrav,
  Ansilvund, Labyrinthian, Dimhollow, Korvanjund, the sewers) is held out by the dun*/quest/curation rules. Its one
  finding is fixed: three Thirsk riekling types chain to the hostile lists, so `deny: Thirsk|PillarBuilder` keeps the
  friendly tribe out if Thirsk ever enters dungeons.json. Dry run 305,821 zones, 0 failures.
- [ ] Old note, superseded by the entry above: draugr/riekling were absent (the old "nordic_draugr" table was invented
  ids, so nothing was lost). Draugr vary by look already (their lists hold 9-104 NPCs) but not by role: Dustman's
  Cairn is 27 one-handers and 17 two-handers. A family would use LCharDraugrMelee1H/2H/Missile/Warlock (male +
  female) with LCharDraugrBossNoDragonPriest, and needs a province exception because Solstheim's and Bruma's
  barrows use Skyrim.esm lists. Rieklings: DLC2LCharRieklingMelee/Missile, never the friendly Thirsk lists.
- [ ] Follow-ups found on the way (split out as separate tasks): Starts Dead corpses spawn alive (Caius's body in
  Sedor); `SKIP` 'dead' matches 'Undead' so ~55 Ayleid undead never spawn, Vilverin's curated roster included;
  XESP enable parents ignored (Driftshade Silver Hand + bandits together, Dres Slavers Camp spawns 26 soldiers);
  ACBS level read from the wrong offset in the generators; spawned actors lose their template's faction and outfit
  (thralls as plain bandits).
  The first four are fixed and live since 2026-09-19 evening, see that block in this file; the expect values in
  `dungeon_pools.py` were updated to the regenerated survey. The faction/outfit one is still open.
- [x] **Unarmed two-handed bosses got a one-hander** (Serpent's Trail smuggler boss: a mace): `armLease` now gives
  `weaponFor` the spawned record's editor id with the kind, so `EncBandit03Boss2HNordM` gets a two-hander. Checked
  on every boss, wizard and missile list: 35 two-handed bosses -> greatswords/axes/hammers, mages -> daggers,
  archers -> bows. Live 14:13.

## Added 2026-09-18 (afternoon): vitals fluidity, NPC variety, difficulty rename

- [ ] **CORRECTED 2026-09-19: the mirror never reached another client** (the fields are dropped by the C++ serializer; see the block at the top of this file, and the relay that replaces them). Original entry: **Stamina & magicka mirrored on remote clones** (`fork\skymp5-client\src\sync\movementApply.ts`, `movement.ts`, `movementGet.ts`, `companionService.ts`, `remoteServer.ts`): `staminaPercentage` and `magickaPercentage` added to the `Movement` interface and populated in `getMovement`. `applyStaminaPercentage` / `applyMagickaPercentage` helpers apply them on every `applyMovement` call using a **variable-lerp factor**: deltas ≤5 % use k=0.25 (smooth micro-change); deltas >5 % use k=0.6 so a big hit or a hard sprint drain snaps in within one or two ticks. `healthPercentage` upgraded to the same sharp-lerp. `companionService.drive()` passes own live stamina/magicka values. `remoteServer.ts` initial movement literal gains both fields defaulted to 1.0. Client built and deployed to both dev and `client-dist`; backup in `_client-bundle-backups\before-vitals-npcvar-173258`.
- [x] **Dungeon difficulty renamed to Skyrim screen names** (`server\dungeons.js`): `Story→Novice`, `Normal→Adept`, `Hard→Expert`, `Nightmare→Master`. Internal `id` fields unchanged so cooldowns and active leases are not affected.
- [ ] **REVERTED 2026-09-19: expanded NPC archetype pools.** The pool table and the pool selection in
  `zonesFor` are back to `c71ccaa`; the difficulty rename and the anchor fallback stay. Most of the new ids
  were invented or the wrong record type: the `2e504`-`2e50f:BSHeartland.esm` marauders do not exist, the
  "draugr" ladder was skeletons, a FACT, placed ACHRs/REFRs and two CELLs, and the warlock bosses were
  werewolves plus an LVLI. The commit also deleted `bandit_camp` while `poolKey` still selected it. Report:
  `_reviews\2026-09-19-daily-review.md`. **Still bad in the restored c71ccaa pools** (these were live before
  and after e7f66fc): `3cf5f` (LVLN) and `3cf60`-`3cf62` (REFRs) in `cultist_melee_2h` and
  `bandit_melee_2h`; `44ce0`, `44ce2` (REFRs) in `warlock_fire` and `bandit_mage`; `warlock_conjurer` is
  `EncWerewolf01`-`06` plus `a0930` (LVLI). **Superseded the same day by the leveled-list pools above.**
  Original entry: `DIVERSE_ARCHETYPES` gained `cyrodiil_bandit` (Heartland marauder/soldier types from BSHeartland.esm) selected automatically when `isBandit && province==='cyrodiil'`; `nordic_draugr` (full Draugr tier ladder from Skyrim.esm) for nordic-type dungeons; `*_boss` mini-pools for every group (bandit chief, cultist boss, warlock boss, draugr death overlord) so boss placements draw from appropriate high-level entries. Boss and non-boss placements now use separate cycling paths in `zonesFor`.
- [x] **Invalid anchor graceful fallback** (`server\dungeons.js`): `zonesFor` now wraps the `mp.getIdFromDesc(npc.ref)` call in a try/catch; if the anchor ref is not loaded in the server's ESM set (the root cause of "no enemies in dungeon" for some BSHeartland dungeons), the zone is still emitted using the baked `POS` coordinate instead of being silently skipped. Server hot-reloaded via `gamemode.js` touch.

## Added 2026-09-18 (morning): server authority, dungeon log noise & province arming
- [x] **Dungeon log noise silenced** (`server\dungeons.js`): `trackNpcs` and `armLease` check `liveForms = new Set(mp.getAllForms(0xff))` before querying properties on dynamic IDs, preventing native C++ exceptions ("resolved context with 1 entries (reason=exception)") when an actor was destroyed between polls.
- [x] **Province-gated dungeon arming** (`server\dungeons.js`): `provinceOfDungeon(d)` identifies Cyrodiil vs Solstheim vs Skyrim; `weaponFor` filters out `Dragonborn.esm` and `DLC2*` weapons unless the dungeon is in Solstheim, preventing Nordic/Solstheim weapons on Cyrodiil bandits. `^MFD` added to `BAD_WEAPON`.
- [x] **Host assignment policy LIVE** (`server\gamemode.js`): `onHostAttempt` hook enforces that a requester must be online, unrestrained (`boundHands`), in the same world/cell, and within 8,192 units of the target actor.
- [x] **Offline login admin privilege protection** (`fork\skymp5-server\ts\systems\login.ts`): in offline mode, non-loopback connections attempting to claim an `adminProfileIds` account are refused and assigned a non-admin session profile (`1000 + userId`). Loopback clients retain full admin access.
- [x] **Twin Souls server authority** (`fork\skymp5-server\ts\systems\companionSystem.ts`): `{ action: 'perks', twinSouls: true }` packet is now validated against `private.mastery` (`skills.arcane.rank >= 4`, Master Arcane Arts) before raising the summon limit.
- [x] Server TS rebuilt (`npm run build-ts`), `dist_back` deployed with backup (`_alduinak-build-backup-20260918-1030`), server restarted cleanly.

## Added 2026-09-17 evening: server authority audit (see `server\SERVER_AUTHORITY.md`)

Ten-agent audit against Jake's rule ("everything server side, relayed to everyone"). The rule holds once
split into authority (always server), execution (client, because only the engine has navmesh/physics) and
replication (the server's job through three channels: the hosted movement sample, neighbour-visible
properties, dbo* packets). 29 migrations ordered by risk in the doc; the ones that matter most:
- [x] **Login identity in offline mode**: guarded in `login.ts`.
- [ ] **Movement has no rate or speed validation**, only a per-packet 4096-unit delta, so every server-side
  proximity rule reads a position the client chose. C++ (belongs with the movement-validation task).
- [x] **Damage multipliers & combat adjudication clamped** (`server\gamemode.js`): `onHitDamageAttempt` hook blocks attacks from restrained aggressors (`boundHands`) and clamps unprivileged damage to 350 max. `mp.onActivate` enforces bound hands and 6.5m proximity.
- [ ] **Mini-game verdicts** (labour, skinning) are judged inside the CEF widget; the server only gets a hit
  count. Move the judging server-side; front rebuild, no client rebuild.
- [x] **Companion authority & replication** (`companionSystem.ts`, `gamemode.js`, `companionService.ts`, `formView.ts`, `worldCleanerService.ts`): `ff_companionOf` neighbor-visible property tells all clients actor is a player companion; attack orders derived server-side on owner hit; summon/vanish visual FX broadcast to all cell listeners via `dboCompanionFx`; leash consolidated to 2500 units; client protects all companions from world cleaner sweep.
- [x] **Creature arming & temp file safety** (`server\dungeons.js`): `ANIMAL` regex expanded to exclude ogres, minotaurs, gargoyles, and other creatures from humanoid weapon equipping; `SPAWNS_FILE` writes use `NPC-Spawns.dungeons.tmp` to prevent collision with `wildlife.js`.
- [x] **My bug (2026-09-17)**: `companionService.drive()` passes `healthPercentage: 1` into applyMovement,
  which heals the owner's own companion every step. (Fixed in commit a9f789f).
- [ ] Environmental damage (falls, traps, unarmed) never reaches the server, so dungeon clears, champion
  payouts and contract credit silently miss it.
- [x] **Twin Souls trusts `player.hasPerk()` from the client**: verified server-side via `mastery.skills.arcane.rank`.

## Added 2026-09-17 evening: Serpent's Trail drops enemies into the void (cause still OPEN)

- [ ] **Retracted the same evening: the "wrong cell" theory.** Serpent's Trail spans three cells
  (`CYRSerpentsTrail01/02/03`, descs `6a7bd`, `6a7bc`, `6a7ba`) and all 15 zones carry `cell: 6a7bd`, but
  the creation-kit MCP confirms the failing anchor refs (`82576`, `7e73c`) and the healthy boss ref
  (`6aae1`) all have `parent_cell` 06A7BD: Trail 01 is the big cavern, 02 and 03 are small side rooms with
  no NPCs. The survey's per-cell attribution is correct. Do not "fix" the generator for this.
- [ ] **What is established**: six spots in Trail 01 dropped two actors each in one Nightmare claim and were
  given up, all in the region x -6k..-9.7k, y -8.4k..-12.3k, z ~9100-9430: [-5936, -12327, 9157],
  [-7850, -8452, 9431], [-9069, -9592, 9152], [-9165, -9592, 9152], [-9720, -8991, 9191],
  [-7666, -8858, 9403], [-9623, -9064, 9199]. Actors land around z 6000-6500, about 3000 below. Spots in
  the other half of the same cell (x > -6k) hold. `refs_near` in the MCP is cell-blind (it returned
  Skyrim.esm interiors sharing those coordinates), so it cannot answer what floor is there.
- [ ] **Cell-aware scan (scratchpad `serpents_floor_scan.py`, 3,730 refs in the cell) rules out bad data**:
  every failing spot has 17-47 floor statics beneath it, all won by BSHeartland.esm, none disabled; DLE's
  only overrides in the cell are 20 disabled ACHRs and one sunk gate. The vanilla NPC stands on each spot.
  The remaining explanation, consistent with the timing (each fall came while the player was 3,000-3,500
  units away, on the far side of a room-culled cavern): **the copy is created before the client has that
  room's collision loaded, drops, and the net respawned it under the same conditions until it gave up.**
- [ ] **Stopgap applied 2026-09-17 (npcSpawnSystem)**: a spot that has dropped an actor is only refilled once
  a player is within 2,500 units of it, and a fall with nobody that close no longer counts toward giving
  the slot up. Proper fix belongs to rebuild invariant 4 (place where the actor can stand): the client
  should hold a freshly created copy still until its room is loaded, or the spawn handshake should wait
  for the client to confirm collision.
- [ ] Until then the nets hold: a spot that drops two NPCs is left empty for the rest of the lease
  (added 2026-09-17) and logs its coordinates.
- [x] Log noise to silence: while a lease runs, the dungeon enemy tracker reads `private.npcSpawner` on ids
  the spawn system has already destroyed. Fixed 2026-09-18 by filtering dynamic ids against `mp.getAllForms(0xff)`.


## Added 2026-09-17: the native (C++) NPC session, scoped and ready to pick up

Server-side C++ only. It rebuilds the SERVER binaries, so players download nothing and no client bundle
changes. Do NOT touch SkyrimPlatform for any of this: that would make every player re-download through the
launcher. Build with the manager's Native (C++) button (CMake configures into `build/`, writes `build/dist`
directly, game service stopped) or the CI flatrim build, which needs `DRAGONBREAK_GH_TOKEN` in
`skymp5-backend\.env`. See `fork\CLAUDE.md` "Deployment reality".

Do these in order; each stands alone and is testable on its own.

- [ ] **1. Let an NPC change cell, and correct a rejected move** (retires a whole class of bugs).
  `skymp5-server\cpp\server_guest_lib\MovementValidation.cpp:16-34` rejects an update when the cell differs or
  the jump is past 4096 units, and its corrective teleport is `isMe` only, with the comment "Not doing this to
  any NPCs at this moment". So an NPC whose real cell parts company with the server's copy is dropped from then
  on: `ActionListener.cpp:1479-1505` then refuses every hit as "different cells or world" and the creature is
  unkillable until it despawns. Change: accept a cell change from the actor's hoster (it is the authority for
  that actor), and send the correction to the hoster when a move is refused. The TypeScript net added
  2026-09-17 (`npcSpawnSystem.checkMisplaced` destroys and respawns a wrong-cell copy) is the workaround and can
  stay as a backstop. TEST: fight a creature through an interior door, then keep hitting it.
- [ ] **2. Server-chosen hosting by proximity.** The gamemode's `onHostAttempt` can only refuse a claim, never
  start one (`ActionListener.cpp:1060-1095`), so the first client to load an NPC drives it even from across a
  valley, and hosting only moves when the holder stops sending (`hostResetTimeout` 2 s). Add a server-side
  reassignment to the nearest eligible player. Biggest single win for NPC quality once more than one player is
  near the same creatures. `server\NPC_NOTES.md` already ranks this first among the techniques.
- [ ] **3. Stop echoing an actor's own movement and animations back to its host.**
  `ActionListener.cpp:393-398` forwards to every listener including the sender, which is why the client carries
  guards against replaying its own animations (`formView.ts:523-530`, restarted swings, a sit that turned
  collision off permanently). Fixing it server-side lets those client guards be deleted later.
- [ ] NOT worth doing: server-driven NPC movement. The server has no navmesh (libespm parses NAVM vertices,
  nothing consumes them, no triangles and no pathfinder), it cannot broadcast a movement message at all
  (`SendToNeighbours` only forwards bytes a client sent), and a server "move" is a Teleport delivered to ONE
  user (`MpActor.cpp:1635-1648` with `GetActorToSendTo`). Driving companions from the server would replace
  navmesh walking with straight-line sliding. Tilted Online (Skyrim Together) is client-authoritative for the
  same reasons. Keep the split we have: the server decides what (follow, fight, stay, lifetime), the owner's
  engine decides how.
- [ ] Also C++, already known and unrelated to the above: `PapyrusObjectReference::SetScale` is a stub, so
  champions cannot be made visibly bigger.

## Added 2026-09-17: region-locked gear and crafting (user decision, NOT built)

- [ ] **Gear belongs to its province.** Cyrodiil items are made and found in Cyrodiil, Skyrim items in
  Skyrim, Solstheim items on Solstheim. A Nordic or Stalhrim weapon should not turn up in a Bruma cave,
  and Cyrodiilic Legion gear should not drop in Whiterun. Decided 2026-09-17 after Bruma Caverns bandits
  were armed with `DLC2Nordic*` weapons.
- [ ] Places this has to be enforced, all of which currently draw from one world-wide pool:
  - `server\dungeons.js` `weaponFor` arms unarmed enemies from `LOOT.weapons`; the only filters are the
    `BAD_WEAPON` pattern, a shape by editor id, the draugr/falmer/forsworn factions and a value cap per
    difficulty. Needs a province filter from the dungeon's worldspace.
  - `server\loot.json` (from `ck-mcp\loot.py`) fills dungeon chests: armor, ench_armor, weapons,
    ench_weapons, arrows. Either tag every entry with its province at generation time or filter by the
    source plugin (BSAssets/BSHeartland = Cyrodiil, Dragonborn/DLC2 = Solstheim, Skyrim/Update = Skyrim).
  - Crafting: recipes are not gated by region at all yet, so a Skyrim smith could forge Cyrodiilic gear.
    Decide whether the gate is the crafting station's zone or a learned recipe (`SKILLS_DESIGN.md` has the
    recipe work under `HasSpell` gating, still unbuilt).
  - `server\admin-items.json` (admin panel catalog) may stay world-wide; it is a GM tool.
- [ ] Open question for the user: what about trade and travel? Simplest rule is that gear is only
  *produced and looted* in its own province but may be *carried* anywhere, which needs no extra work.
- [ ] Vanilla Skyrim gear in Bruma is the common case to check first: the leveled lists behind Cyrodiil's
  bandits already resolve to Skyrim bases in places, so some of this is Beyond Skyrim's own data.

## Added 2026-09-16 (afternoon): Bruma notice board, spawn and creation fixes
- [x] **Bruma notice board placed** in the Creation Kit with DLE active: `1164c7:DragonBreak Online Edits.esp`, base Manny's `manny_up_NoticeBoardActivator`, outdoors in BSHeartland at [59437, 202554, 7481] near the cathedral. Resolves to the `bruma` region (zones.ts `zoneAt` matches regions by worldspace). Deployed to `server\data` (previous DLE in `_ckmcp-dle-backup-20260916-144519`). NOT tested in game.
- [ ] **DLE gained three masters** in that save, 49 -> 52: `BSAssets.esm`, `BSHeartland.esm` (expected for anything placed in Bruma) and `Sentinel - Master Plugin.esp` (unexpected; DLE now cannot load without Sentinel). All load before DLE, and DLE still validates clean.
- [ ] **The Steam install and Jake's server still have the 09-14 DLE.** Clients and server must carry the same file or connects fail; update them together, not one at a time.
- [x] **Riverwood spawn fixed**: `startPoints` had been set to the hub, which HANDOFF records as impossible (the spawn save cannot load into it), so the client stayed in the base save's Sleeping Giant Inn. Restored to the Pale Pass arrival. The spawn loop also now requires the target cell, not just X/Y within 256 units: interiors and the hub both sit near the origin, so the old check passed on the wrong cell.
- [x] **Creation flow is arrival-driven**: new characters spawn at the Pale Pass behind a black screen (`dboFade`), the client reports `arrived` when its body is really in a world, the gamemode moves them into the hub on that and opens RaceMenu on the hub arrival. The old 8 s timers remain as fallbacks; the fade lifts on its own after 25 s.
- [x] **Unkillable creatures**: an NPC placed with PlaceAtMe on an anchor inside an interior could be born in that interior while rendering outdoors, so every hit was refused as `different cells or world`. `placeNpc` now verifies the cell, retries once, then frees the slot with a log line.
- [x] **`ff_hostile` was never registered** as a property anywhere, so its set in npcSpawnSystem was silently swallowed and clients fell back to plugin aggression. Registered in gamemode.js.
- [x] **Collision**: settled or dead copies and host grants now call `setCollision(true)`; `stopTranslation` alone did not hand the reference back to havok.
- Launcher note: it launches the Steam install pointed at `50.116.28.194` and rewrites the shared `Plugins.txt`. For a local test, launch the dev copy directly and run `sync-plugins.cmd` first.

## Added 2026-09-16 (late morning): contracts, review fixes, npc budget
- [x] **Hunting contracts LIVE** (`server\contracts.js`, state `contracts.json`, config `contracts`). Each zone with a treasury keeps 3 standing contracts drawn from the creatures that actually spawn there (from NPC-Spawns.json wild:* names; a hold with no worldspace of its own takes the fauna within 45,000 units of its capital). Danger tiers set both the count and the pay: 2 trolls at 120 gold, 9 mudcrabs at 108. `/contracts` lists the work where you stand, `/contract take <n>`, `/contract` shows progress, `/contract abandon`. **The reward comes out of the zone treasury**, so a hold that spends its coffers stops being able to post work, and a contract is never posted the treasury cannot cover. Officials of the zone post their own with `/contract post <creature> <count> <reward>`. A champion kill counts double. 27 contracts across 11 zones at first load.
- [x] **Review pass over the morning's untested code, three real bugs found:**
  - `onUi` kept ONE handler per event name in a Map, and three modules register `close` (reading, dungeon gate, labour). The last one loaded silently killed the others, so reading and dungeon-gate sessions have been leaking on close since before today. It now keeps a list and calls every handler.
  - The labour mini-game could be beaten by hammering the key, since a miss cost nothing. A strike now has a 250 ms cooldown and a miss staggers 600 ms.
  - Heartstone veins were mapped to stalhrim, which would have paid the wrong ore. Unknown ores are refused instead.
  - A champion that despawned without dying left its rim shader lit on every client. Cleared on despawn now.
- [x] **NPC budget (server)**: 1883 wildlife zones mean a player crossing the map trails actors that are each held four minutes after they leave. `fillSlots` now stops at `MAX_LIVE` 150 live NPCs across every zone and retries the slot in 10 s, logging at most once a minute. Respawning a slot that already exists is unaffected.
- [x] **`server\` is a git repo** (local only, no remote yet): 42 files, the gameplay layer and the design data. Secrets, `world/`, logs, builds, backups and runtime state are ignored. Commits `60eabb7`, `64a02be`, `c827ea8`.
- [x] Fork pushed through `6264832`.
- [ ] NOT tested in game: contracts, champions, labour, the budget.
- [ ] NPC merchants deliberately NOT built: the economy stays player-run shops (user decision 2026-09-16).

## Added 2026-09-16 (morning, third block): champions, the lite MMO layer
- [x] **Champions LIVE** (`server\champions.js`, config `champions`, no client build needed to tune). Every few seconds the module reads `zone-spawns.json`, and a hostile new spawn has a 5% (wild) / 8% (dungeon) chance of promotion: it gets a name through Papyrus `SetDisplayName` using the client's `%original_name%` token ("Ravening Wolf", "Elder Draugr", 20 epithets), a red rim from the glow service, and toughness. `/champions` lists what is abroad.
- [x] **Toughness without touching max health**: `SetActorValue` on the server is a documented no-op for server calculations, so a champion is healed back a share of every hit instead (`mp.set(id, 'percentages', ...)`, `toughness` 0.5 = roughly double health, capped at 0.8). The bar still drains, which reads correctly.
- [x] **Kill credit, MMO style**: `mp.onHitDamage` is now chained in gamemode.js and accumulates damage per player per champion. On death every player who did at least `creditShare` (10%) of the damage is paid personally: 25-120 gold each plus a 35% chance of a gem, with no race for the corpse. Audit line `CHAMPION <name> in <zone> killed by ...`.
- [x] **Client**: `dboGlowService` gained a third shader kind, `champion` = LifeDetectedEnemy `dc209` (red rim, no fill). Rebuilt and deployed to both copies, previous bundle in `_client-bundle-backups\before-champion-glow-*`.
- [ ] **Papyrus `SetScale` is a stub** in this server (`PapyrusObjectReference::SetScale` returns None). Champions cannot be made visibly bigger without a C++ change; the rim shader stands in for it.
- [ ] A gamemode hot reload empties the champion table: NPCs promoted before the reload keep their name and glow but stop being tough and pay nothing. Harmless, worth knowing during testing.
- [ ] NOT tested in game.

## Added 2026-09-16 (morning, second block): mini-games, NPC net, crash guard
- [x] **Mining and woodcutting mini-games LIVE** (`server\labour.js`, config `labour`, front widget `labour` id 33). Activate an ore vein (`MineOre*` / `CYRMineOre*` ACTI) as a Miner or a chopping block (`WoodChoppingBlock*` FURN) as a Woodcutter: a marker sweeps a bar, strike (Space, Enter or click) while it is in the band, band jumps after each landed strike. Mining needs 6 strikes and gives ore matching the seam, scaled by the miner's `yieldMultiplierByTier`; chopping needs `chopStrikesByTier` strikes (4/8/12/16/20) and gives firewood `firewoodByTier` (3/4/5/6/8). Band width and sweep speed both ease with tier. Vein rests 45 min per player, block 10 min, a failed round 2 min. Server judges: it refuses a report of more strikes than the round asked for, faster than 350 ms each, or past the 30 s clock. IN-GAME TEST: as a Miner use a copper vein near Bruma; as a non-Miner expect the refusal.
- [x] **Copper added to Miner tier 1** in skills.json (tier label now "Copper, iron, corundum"). Bruma's only veins are `CYRMineOreCopper01-04`, so without this mining is dead content for the whole playtest. Copper ore item is `601c50:BSAssets.esm`. Revisit if copper should be its own tier.
- [x] **Crash guard: the race creator is never shown over itself** (client). The 2026-09-15 16:48 crash was an access violation inside tbbmalloc `freeOwnObject` with RaceSexMenu, a BGSHeadPart and the Orc race on the stack, 43 s after launch, i.e. a second `showRaceMenu` freeing head parts twice. `openCreator` in gamemode.js sends setRaceMenuOpen false then true, and createActor can carry `isRaceMenuOpen` as well, so two shows were reachable.
- [x] **NPC net (server)**: `checkMisplaced` in npcSpawnSystem now also replaces an NPC hanging 600+ above its slot, within 384 units, unmoved for 3 polls, and frees the slot of one dragged past max(8000, radius*3) from its zone. Log lines: `hung ... above its spot`, `strayed ... from its zone`.
- [x] **`server\NPC_NOTES.md`**: the whole NPC pipeline written down (zone file -> PlaceAtMe anchor -> per-client copy -> host -> server), what is fixed, what is open, and a ranked table of techniques with their cost. Headline: the next real gain is server-chosen hosting by proximity, which is a C++ change and a native build, because the gamemode's `onHostAttempt` can only refuse a claim, never start one.
- [x] Server rebuilt and restarted twice (dist_back backed up to `_alduinak-build-9-backup-*`), front rebuilt and deployed to both UI folders (previous UI in `_ui-build-backups\before-labour-*`).
- [ ] NOT tested in game: everything in this block.

## Added 2026-09-16 (morning): client bundle, three fixes, deployed not tested
- [x] Floating / no-clip creatures: a translateTo runs with collision OFF until something stops it, and nothing did. formView only applies movement while `isHostedByOther`, so the moment a copy is hosted by us or by nobody its last translation kept running (X/Y parked at the target, Z creeping at the leftover speed). `settleTranslation()` in sync/movementApply.ts tracks translated copies and calls stopTranslation once when they settle, when they die, or when the server stops driving them (new call in view/formView.ts). Watch for: a hovering flier standing still would now drop until its next moving sample.
- [x] Race default spells: the one-shot removeAllSpells+learnSpells at 1 s missed anything the engine granted later. New `enforceSpells()` in sync/spell.ts diffs against the server list and is re-imposed at 1/3/6/10/15/20 s, logging only when it changes something.
- [ ] Starter kit items NOT changed: remoteServer.ts already force-applies the server inventory every 5 s and that apply removes anything off-list, paused only while RaceMenu is open +3 s. IN-GAME CHECK: close RaceMenu, wait 10 s, look in the pack. If iron gear/lockpicks survive, something is blocking that loop and it needs chasing.
- [x] Glow softened: dboGlowService SHADERS now LifeDetected `146` (loot) and LifeDetectedUndead `aaeb3` (locked), both no fill texture, instead of GhostFXShader `3b6cb` / GhostVioletFXShader `103129` which wash the chest white. If violet reads wrong for locked, LifeDetectedEnemy `dc209` is the red-rim alternative. Full shader list: `SSEEdit 4.1.5f\Edit Scripts\DBO_efsh.txt` (307 records, from DBO_DumpEffectShaders.pas).
- [x] Client rebuilt and deployed to the dev copy and client-dist (previous bundles in `_client-bundle-backups\before-settle-translation-20260916-073538`). tsc --noEmit clean, webpack successful. NOT tested in game.
- [x] Probe removed from gamemode.js, server restarted 23:28 under a Claude session with stdout to server.log again.
- Headless SSEEdit gotcha: with -D and -P the Module Selection dialog still appears and -autoload does NOT dismiss it; the run sat there 8 h. Clicking its OK button (BM_CLICK on the TButton child of TfrmModuleSelect) let it finish in under a minute.

## You (needs your credentials or your click)
- [ ] Discord webhook URL into gamemode-config.json under "discord": { "webhookUrl": "..." }, then save gamemode.js once to reload. Tells the GM log where to post while offline.
- [ ] Discord bot token: later, into skymp5-backend\.env (DISCORD_BOT_TOKEN) and server-settings.json discordAuth.botToken. See DISCORD_SETUP.md.
- [x] Fork pushed 2026-09-15: main = 87c8874 (board fees to treasuries, Count manages property). Nothing unpushed.
- [ ] Run RENAME-FOLDER-AFTER-CLOSING-CLAUDE.ps1 after closing the session.

## Done
- [x] Jiggle physics removed: 3BBB.esp out of both load orders, 32 CBPC files parked in server\_removed-client-mods. HDT-SMP kept for hair/cloaks.
- [x] Plugins/BSAs renamed to DragonBreak Online.*; fork rebranded; launcher built; UI built; chat gamemode; X interact key; RealmofLorkhan spawn + hold gates; DO overlay assets restored; Discord audit log (gamemode + backend).

## Added 2026-09-14 (late evening): boards, Scholars, strongholds, dungeons, palette
- [x] Notice boards LIVE: BountyBoardSystem re-keyed to Manny's `manny_up_NoticeBoardActivator` plus our Noticeboard / RP_NoticeBoard* activators; one post pool per zone (hold, stronghold or Solstheim) resolved from the board's position via zones.json; tabs Hold Notices (free, officials + admins only) / Shop Ads / Citizen Notices (30 gold); 60 posts, 7 days; posters shown as `Name #TAG, Rank`; officials, admins and the poster can take a post down. Storage `server\notice-boards.json`. 10 of Manny's 14 boards were placed Initially Disabled (his quest enables them) and are now enabled by overrides in DragonBreak Online Edits.esp (Edit Scripts\DBO_EnableNoticeBoards.pas); Riverwood and Riften keep our own boards instead. IN-GAME TEST: use the Riverwood or Whiterun board, post on Shop Ads, /officials.
- [x] Officials: `server\officials.json` (profile ids per zone and rank) managed with admin `/appoint <player|#TAG> <zone> <rank>` and `/dismiss`; `/officials [zone]` lists them. Backend faction rows (hold:<zone>:<rank>) still count when present. Ranks: jarl/steward/commander, chieftain/bane.
- [x] Strongholds sovereign + Jarl/Steward key powers: HousingSystem resolves a property's zone from its position (or its exterior door's) through zones.json, so inside a stronghold radius only Chieftain/Bane (and admins) are managers and hold officials have no say; managers (jarl, steward, chieftain, bane) can now cut keys as well as claim/revoke/rename/transfer/re-key. Old cell table kept as fallback.
- [x] Books are Scholar nodes: a placed BOOK can never be picked up; a Scholar who uses one gets the reading mini-game (front widget `reading`, 9 s candle, put the shuffled sentence in order, server judges). Win credits Scholar work and rolls skills.json `bookDropChanceByTier` (a copy of the book) and `tomeDropChanceByTier` (tier 4 scrolls, tier 5 scrolls or spell tomes from `server\readables.json`). 30 min per book per reader, 2 min after a fail. Config `reading` in gamemode-config.json. IN-GAME TEST: as a Scholar use a book on a shelf; as a non-Scholar expect the refusal.
- [x] Hunger XP penalty: Starving stage `xpMult 0.25` in gamemode-config.json; masterySystem stretches the work interval by 1/xpMult, so hours are counted four times slower while starving.
- [x] Dungeons LIVE as leases (`server\dungeons.js`, data `server\dungeons.json`, 209 dungeons, 364 entrances): party leader claims at the exterior door (widget `dungeonGate`: Story/Normal/Hard/Nightmare), party teleported in, others refused for 60 min, 5-min warning, kicked to the entrance at the hour, 60-min cooldown per member; lease ends early after 3 min with nobody inside. Enemies = vanilla placements resolved through their leveled lists, written as `dungeon:*` zones into NPC-Spawns.json only while leased (difficulty picks weakest/median/strongest option and scales counts 0.6/1/1.25/1.6). Locked chests per lease (Normal 20%, Hard 35%, Nightmare 50% of the big chests), Lockpicking tier vs Novice..Master, a lockpick breaks on failure. `/party invite|accept|decline|leave|kick`, `/dungeon`, admin `/dungeon end <name>`. IN-GAME TEST: claim Bleak Falls Barrow on Normal, check draugr spawn as you walk in, try a locked chest, wait for the 5-minute warning.
- [ ] Dungeon follow-ups: spawn slots are rings around cluster centres (not the exact vanilla spots); boss chests are only "big" by editor id; mining/woodcutting mini-games still not built; a Bruma/Baan Malur dungeon list needs the survey re-run (ck-mcp\dungeons_survey.py + dungeons_build.py + dungeons_anchor.py; intermediates in ck-mcp\out\). Bruma's 23 are already in.
- [x] Palette: every custom widget now uses the DragonBreak logo palette (skymp5-front/src/dbo-theme.scss: teal-black grounds, aqua glow, stone grey, silver serif titles, amber accents). Hourglass watermark top-right in the HUD (`dbo-watermark.png` next to index.html in Data\Platform\UI, source server\branding\watermark.png; `"hud": {"watermark": false}` hides it).
- [x] Client bundle: DboRelayService (generic server-driven widgets) and the board prompt re-keyed; front bundle: bountyBoard tabs, hud watermark, reading, dungeonGate. Installed in the dev copy and client-dist; previous UI in _ui-build-backups, previous client in _client-bundle-backups.

## Added 2026-09-14 (night): first dungeon playtest fixes
- [x] Dungeon names: dungeons.json now carries readable names from editor ids (the ESM FULL strings are localized ids); the gate shows "Bleak Falls Barrow", not "A 0".
- [x] Arrival: the party is put on the entrance door's own teleport marker (XTEL) instead of the interior door's position, so nobody spawns on the wrong side; kicks use the exit marker outside.
- [x] Enemies: one spawn zone per vanilla placement (Size 100000), so every enemy in a cell appears on Bethesda's spot the moment anyone enters the cell, not in rings around a cluster centre in front of the player. If anything still floats or clips it is the spawn system's +64 lift on that spot; report the dungeon and spot.
- [x] Loot: the engine's container loot is never added to dungeon chests. dungeons.js fills every big chest at claim time from `server\loot.json` (ck-mcp\loot.py) per difficulty: gold, potions, ingredients, materials, gems, arrows, lockpicks, soul gems, one plain weapon or armour piece 20% (boss chest always one), enchanted gear Story 0% / Normal 2% / Hard 5% / Nightmare 8% (boss chest 5/12/25/40%). Value bands per difficulty. `forbiddenReloot: ["CONT"]` in server-settings so nothing refills.
- [x] World containers outside dungeons are emptied on first opening (private.dboEmptied) and never refill; `worldContainers.emptyOutsideDungeons` in gamemode-config.json turns it off.
- [x] Corpses: on death a spawned enemy's inventory is trimmed (gamemode onDeath -> dungeons.js): gold capped, arrows capped, potions/ingredients/misc kept, one weapon 25%, each armour piece 10%, enchanted pieces by difficulty. Searching a body no longer hands over the kit.
- [x] Clear to finish: a lease ends early as "cleared" when every placed enemy is dead and every big chest has been opened (tracked from zone-spawns.json + isDead + chest activations); cooldown starts then. `/dungeon` shows enemies down and chests opened.
- [x] Glow: lootable chests get the vanilla LifeDetected shader (client DboGlowService, packet dboGlow) while the lease runs; it goes out per chest when opened.
- [x] Coin purses are Harvesting nodes: untouchableBaseIds emptied in server-settings, the client no longer hides leveled flora, gamemode rolls Harvesting chance/multiplier from skills.json (unskilled 25% at half), 8-30 gold, purse rests 45 min for everyone, credits Harvesting work. Config `coinPurses`.
- [x] UI: buttons are light translucent gold everywhere (theme mixin, housing, skills menu); skills menu enlarged (1440x860 max), description panel readable (book serif, 19px, on a teal gradient instead of black), groups with aqua headers, tier ladder restyled.
- [x] Keys: F1 toggles nametags, F2 hides the HUD (was F1), F6 focuses chat (T and Enter still do), F7 frees the cursor (was F6), V push to talk, a plain tap of Left Alt cycles Whisper / Talk / Shout with an on-screen notice (Alt+V still works). Report codes (F3) do not exist here.
- [x] Reading candle 25 s (`reading.seconds`), starter kit (pickaxe + woodcutter's axe on login, `starterKit`).
- [ ] Next playtest: claim Bleak Falls Barrow on Normal, confirm arrival inside, enemies at their spots, chest glow, a locked chest, loot a corpse, clear it, /dungeon.

## Added 2026-09-14 (night, second playtest): loot bands, party, wildlife, glow, keys
- [x] Swindler's Den spawned nothing: the anchors were Bethesda's placed NPCs, which the server never instantiates ("Form doesn't exist"). ck-mcp\dungeons_anchor.py now anchors every placement on the nearest ref the server does load in that cell (furniture, activator, door, container, item) and records the distance; the spawn appears on that ref's spot.
- [x] Loot bands: gold Story 3-12 / Normal 5-25 / Hard 10-45 / Nightmare 20-80 (boss chest x3); potions by strength word (Minor only on Story, no Plentiful/Vigorous below Hard, quest and Thieves Guild potions never); soul gems 0% / 3% petty-lesser / 6% up to common / 10% any, black and grand only on Nightmare; corpse gold capped at the band's top.
- [x] Party gold: gold taken from a dungeon chest or a dungeon corpse is split evenly across the party members inside; the finder keeps the remainder (gamemode onTakeItem -> dungeons.js).
- [x] Party panel: front widget `party` (id 32) fed by ff_party: names, leader star, health bars read on the client from the loaded actor, "far" when not loaded, red strike when dead. Movable by its bar and resizable by its corner while the cursor is free (F7); position saved per player.
- [x] Chat is already movable (drag bar) and resizable (bottom-right corner) while the cursor is free and "Lock chat" is off in the chat settings. Chat and emote wheel recoloured teal/gold (no red left).
- [x] Glow: lootable chests use the white-blue GhostFXShader, locked ones the violet GhostVioletFXShader; a picked lock switches the chest to white; opening it clears it.
- [x] Watermark: the hourglass art is now bundled inside the front build (src/img/dbo-watermark.png, CSS background), top-right at 45% opacity, so no runtime file path can fail. `"hud": {"watermark": false}` hides it.
- [x] Wildlife (server\wildlife.js, data server\wildlife.json from ck-mcp\wildlife.py): every vanilla outdoor creature placement in Tamriel and Solstheim becomes a permanent wild:* spawn zone anchored on the nearest server-loaded ref: appears when a player is within 6000 units, despawns after 4 min with nobody near, returns 30 min after a kill. Giants and mammoths come with their camps. Config `wildlife` in gamemode-config.json.
- [x] Giant camp chests are open-dungeon loot nodes: using one gives a roll of loot straight to the pack (gold, ingredients, materials, sometimes a gem, small soul gem or cheap weapon) once per player per chest per hour; the container never opens.
- [ ] Conjuration: Alduinak's ConjurationSystem handles SummonCreature casts through CompanionSystem, but the log shows no cast reaching it. `debug.logSpellCasts` is on: cast Conjure Flame Atronach once and the log will say whether the cast event arrives at all.
- [ ] Next playtest: Swindler's Den again on Normal (enemies on their spots, white/violet chest glow, loot amounts), a two-player party for the gold split and the party panel, wildlife around Whiterun plains and a giant camp chest, one conjuration cast for the log.

## Added 2026-09-14 (late night): login outfit, HUD route, conjuration lead
- [x] Naked on rejoin, root cause found with an equipment trace: the client reports its equipment during login while it is still undressed (an empty report, then the full inventory with nothing worn) and the engine stores that report as the outfit, so every save today held no worn items. Fix in gamemode.js: reports in the first 15 s after connect are ignored for our record, the last outfit with anything worn is kept in private.lastWorn, and 12 s after connect the client is told to EquipItem each remembered item it still owns (Papyrus snippet), which it then reports as worn. `debug.logEquipment` prints every report.
- [x] HUD and party panel now travel as packets (dboHud, dboParty) rendered by the client's DboRelayService, which adds the vitals and party health itself every second. The owner-side property route (ff_hud / ff_party) never produced a widget in game despite compiling and being delivered on paper; it stays registered but unused. First login after this: status panel bottom-left, vitals bottom-right, hourglass top-right.
- [ ] Conjuration: the client log shows "TESSpellCastEvent error! spell not a MagicItem" at the cast times, which is Skyrim Platform dropping the cast before the client can report it. That happens for scrolls and staves (not SpellItems). Cast the spell itself once with `debug.logSpellCasts` on; if the trace prints the cast, summons work and only scrolls/staves are unsupported (a platform change + CI build otherwise).
- [ ] Crash 23:28 (SkyrimSE+091611C, HUDMenu/FaderMenu with SkyrimSoulsRE and HDT-SMP on the stack, 1:48 after launch): not in our code paths; watch for a repeat. Vortex was open and had rewritten Plugins.txt again; the client still connected, so the load order matched at launch.

## Added 2026-09-15 (early morning): voice, vanilla bars, unarmed enemies, login flash, launcher icon
- [x] Login outfit flash: the client now holds back its equipment report while it dresses the player after spawn (globalThis.__dboDressUntil, set at spawn and 2.5 s after each applyPcInv), so the naked report never reaches the server. The gamemode re-dress stays as a safety net.
- [x] Voice: the server has no voiceChat settings, so voice chat itself is off (V does not transmit). The client used to set the voice mode only when a voice server answered, which made Left Alt do nothing; it now starts from the saved mode or Normal. The old TALK banner image is retired; the status panel's voice row lights up while V is held and shows Whisper / Normal / Yell with an L-Alt hint.
- [x] Vanilla health/magicka/stamina meters are forced to alpha 0 every frame while our vitals are on (they faded back in on sprint). Paths: _root.HUDMovieBaseInstance.Health/Magica/Stamina.
- [x] Vitals bars 300x16 (were 240x12); watermark opacity 62% (was 45%).
- [x] Unarmed dungeon enemies: every 2 s dungeons.js checks each new humanoid spawn of a lease and, if it has no weapon, gives one fitting its placement (archer: bow + 30 arrows; two-hander: greatsword/battleaxe/warhammer; caster: dagger; else sword/war axe/mace; draugr, falmer, forsworn get their own kind) within the difficulty band, then EquipItem. Logged as "armed".
- [x] Launcher icon: hourglass on a dark teal rounded tile (serverranding\launcher-icon.png, all Windows sizes in skymp5-launcherssets\icon.ico, old one kept as launcher-icon-old.ico). The source is watermark.png with the lettering cropped away; the plain line-art hourglass from chat is not on disk. Launcher rebuilt; previous exe kept as DragonBreakLauncher.exe.before-icon-*.bak.
- [ ] Voice chat needs a LiveKit server and `voiceChat` settings before V transmits anything.

## Added 2026-09-15 (morning): door names, overworld creatures, vanilla meters again
- [x] Doors name their destination: ck-mcp\doors.py writes server\doors.json (load door -> name from the destination's location editor id; exits onto unnamed outdoor cells use the hold the building belongs to, else "Skyrim"; stacked suffixes, mod prefixes and DUPLICATE tags stripped; Hearthfire homes mapped to Lakeview Manor / Windstad Manor / Heljarchen Hall). The client asks once per door (dboDoorName) and shows "Open <destination>"; hub gates answer with their hold. Names are editor-id based, so a few read oddly (the real names are in the localized .STRINGS files inside the BSAs).
- [x] Vanilla health/magicka/stamina meters: alpha alone lost to their fade animations, so they are now also scaled to 0 and parked at _y 5000 every frame. If they still show, the HUD swf uses other member names.
- [x] Vitals bars 360x20 (were 300x16).
- [ ] Overworld creatures floating with no collision: hypothesis is they were spawned beyond the area where the client runs physics (radius 6000). Wildlife radius is now 3000 (gamemode-config.json wildlife.radius). If they still float, the next suspect is the anchor: a creature spot up to 2500 units from its anchor ref is placed at the anchor first and then moved.

## Added 2026-09-15: Bruma playtest
- [x] Commit messages of 8cafa28 / 1eb4b6b / 503d148 rewritten and force-pushed (code unchanged; old head kept locally as branch backup/before-msgfix).
- [x] Playtest region lock (server\playtest.js, gamemode-config.json "playtest", ON): every hub gate sends players to the Cyrodiil side of the Pale Pass road (arrival marker of Skyrim border door 14df, a764b:BSHeartland.esm [48236.2, 260600.4, 20405.1], facing 135 deg, about 830 m north of Bruma city; changed 2026-09-15 afternoon at the user's request, was the Jerall View Inn); the two doors leading from Cyrodiil back to Skyrim (877c2 interior tunnel, 656df north edge) refuse; anyone outside the Bruma worlds (BSHeartland a764b, Frostfire Glade 6ade1, Crow's Wood 7f126, Green Leaf Glade b95a6) or a Beyond Skyrim interior is returned to Bruma after a 60 s connect grace. The hub and landing flow for new characters is unchanged. Admins are exempt and can /tp anywhere. /playtest shows the state. Set "enabled": false to reopen Skyrim.
- [x] Bruma zone (zones.json region "bruma", whole BSHeartland worldspace): ranks Count, Steward, Captain of the Guard; the Count manages property like a Jarl (housingSystem MANAGER_RANKS, server rebuilt and restarted). /appoint <player> bruma count.
- [x] Door names cover Bruma (476 Beyond Skyrim doors, e.g. Bruma Castle, Jerall View Inn); 23 Beyond Skyrim dungeons are already in the dungeon system (Underpall, Fort Horunn, Sedor, Serpents Trail ...).
- [x] Wildlife in the Bruma worlds: ck-mcp\wildlife.py includes BSHeartland and accepts Beyond Skyrim's CYR/BSK creature names; 183 spots there (53 wolves, 52 deer, 45 foxes, 12 mudcrabs, 3 trolls, 2 bears, ...), 1,883 in total, loaded.
- [x] Bruma essentials audit (ck-mcp\bruma_essentials.py -> ck-mcp\out\bruma_essentials.json, 2026-09-15): crafting stations all use vanilla bases and keywords, so every skill gate already applies (smith: Northern Arms forge + armour bench + wheel, Fort Pale Pass, the basement player house; alchemy/enchanting: Synod Conclave, White Pine Lodge, Ananril's, Galarynn's; cooking pots in most houses; tanning rack and two chopping blocks outdoors in the city; smelter + iron veins just west of the castle at ~53000, 200300). Harvesting covers every Beyond Skyrim FLOR/TREE (Harvesting gates by record type): ~280 flora nodes in and around the city, thousands across the Heartland, 214 coin purses (BSKAyleidCoinPurse included, isCoinPurse is unanchored).
- [x] Gate gaps fixed in skills.json (server restarted 16:29): `CYRMineOre` copper veins added to Miner, `FarmLumbermill` added to Woodcutter.
- [x] Treasury bug fixed in gamemode.js: world-container emptying skipped nothing, so the first opening of a seeded HoldChest would have wiped its 10,000 gold. Containers with private.treasurySeeded are now left alone.
- [ ] Bruma notice board (CK, you): no board activator exists in Bruma. Place RP_NoticeBoard (DragonBreak Harvest.esp 900) OUTDOORS in the city; interiors resolve to no zone, so an indoor board has no post pool. Suggested spot: the square in front of the Jerall View Inn, near [57394, 202249, 7875] in BSHeartland.
- [x] Bruma treasury: the Lord's Manor safe in Bruma Castle (79b22:BSHeartland.esm) is BANK_TREASURIES `BrumaCastleSafe`, seeded with 10,000 gold 2026-09-15 16:32. There is still no bank building.
- [ ] Bruma treasury lock (you, in game): appoint the Count, then have them claim and lock the safe. Until then anyone who walks into the castle can claim it or take the gold. Admins can check it first with /tp.
- [ ] Bruma ranks need appointing.
- [x] RaceMenu close crash (2026-09-15 16:48, same signature as 2026-09-14 14:28 and 21:50: EngineFixes tbbmalloc freeOwnObject, RaceSexMenu + BGSHeadPart on the stack): closing the menu sends the appearance, the server echoes it back to the owner (SendToNeighbours includes the actor itself) and finishCreation re-sends the inventory, so the next frame rebuilt the head while the menu was still freeing it. Client fix, fork 9bc0f5b: for 3 s after RaceMenu closes (and while open) the own-appearance echo is skipped and the inventory apply is held. Installed in the dev copy and client-dist (previous bundle in _client-bundle-backups\before-racemenu-guard-*). IN-GAME TEST: new character, pick a non-default race, press Done; expect no crash and the kit equipped a few seconds later.
- [x] Black screen on a new character's first load (2026-09-15 17:01, probably also the 16:47 session): the client's spawn loop re-sent the player to the landing point every second until within 256 units, and the gamemode's hub move arrived 1 s after the save loaded, so the loop and the move fought over worldspaces forever. Client fix, fork 21115cd: the loop stops once a server teleport for the player arrives and gives up after 30 attempts. Installed in the dev copy and client-dist (previous bundle in _client-bundle-backups\before-spawn-loop-fix-*). IN-GAME TEST: fresh character, expect the landing point, then the hub, then RaceMenu.
- [x] Playtest doors refuse admins too (playtest.js): the Pale Pass door let the admin tester into Skyrim because blocked doors exempted admins. Admins are still not bounced.
- [x] Ogres at the Pale Pass arrival: Beyond Skyrim's CYRLvlAnimalMountainSnowPredator list (wolf, mountain lion, bears, frost troll, three ogres) picked "mid" = CYREncOgre01 on the three spots ~10,000 units from the arrival. wildlife.js now takes `safeZones` ({world, pos, radius, pick}); the Pale Pass arrival has radius 25,000 with pick "low" (CYREncWolf). Spots beyond 25,000 still roll ogres; widen the radius if the road south still feels too harsh.
- [ ] Black screen for fresh characters (2026-09-15, four sessions): the game loads the save, then hangs (not responding, CPU busy, no client script activity) before the gamemode's hub move even matters. Ruled out: the spawn loop (fix kept, fork 21115cd), the per-frame vanilla meter writes (vitals-off test still hung), wildlife near the landing (nothing within 9,000 units). Existing characters loading in the hub or Bruma work. Suspect: the Whiterun-area landing point (22659, -8697) hangs since the 2026-09-14 evening plugin additions (Bruma, Baan Malur, Gray Fox Cowl, DLE 19:58). CONFIRMED 17:25: a fresh character starting at the Bruma arrival loads fine, so the Whiterun landing is the cause. FOLLOW-UP: find what hangs a load at Tamriel (22659, -8697, -3594) (plugins added or changed 2026-09-14 16:29-19:58) before Skyrim reopens. Current setup: server-settings.json startPoints now the Bruma arrival (0x080a764b, [48236.2, 260600.4, 20405.1], 135); gamemode-config.json "landing" matches, so the hub move still works from there. The login "moved from the landing point" path now only applies while kitPending. If this loads, keep it for the playtest and investigate the Whiterun landing in CK/xEdit; if it still hangs, the cause is client or new-character code.
- [ ] Bruma playtest findings 2026-09-15 17:25-17:36 (Argy #7F4Q): hub gate to Pale Pass OK; safe-zone wolves OK; Serpents Trail claimed on Story, 11 enemies spawned and armed, body searches and 300 s corpse cleanup OK, player death and respawn keep inventory. Open: (1) ~30 s of melee and bow hits both ways rejected "aggressor and targetRef are too distant" (server had ff00000b / ff00000c 6-7k units from the player; cause not found, ask what the tester saw); (2) dungeon enemies fall through the floor (ff000010 saved 10,800 units below its spawn, ff00000f 2,700), so the lease can never end as cleared; (3) searching a non-player body logs a harmless ff_knownIds exception (searchSystem nameShownTo on the body; skip the notice when the body has no user); (4) CYRLvlSmugglerWizard armed with a steel sword (dungeons.js caster detection misses "Wizard"); (5) hitting trees logs "MpObjectReference not found" (harmless).
- [x] Playtest fix batch 2026-09-15 evening (server bundle deployed 17:57, previous in _alduinak-build-7; client and UI installed in the dev copy and client-dist, previous in _client-bundle-backups\before-host-settle-* and _ui-build-backups\before-skinning-*; fork 012a929 / a802f8b / 69cd9df, unpushed):
  - Rejected "too distant" hits, damage that only sometimes landed, floating wolves: a spawned NPC was PlaceAtMe'd at its anchor (often thousands of units off), then moved on the server; the move never reached clients already watching, and the server silently drops NPC movement more than 4096 units from the stored position, so server and client copies stayed apart. placeNpc now disables and enables the actor after the move (clients re-create it on its spot); the client stops a copy's translation and re-evaluates its AI when hosting starts.
  - Enemies falling through the floor: NpcSpawnSystem places an NPC again when it is more than 3000 units below its spawn point.
  - Enemies spawning around the party: zones can be Prespawn; dungeons.js writes the lease, calls __alduinakNpcSpawnNow and teleports the party once every enemy stands on its spot (6 s fallback).
  - Pelt through X search: body search only works on player bodies. Spawned creature pelts and hides are set aside on death (private.dboPelts) and wild animal bodies are emptied; a Skinner pressing E on the body gets the skinning mini-game (front widget "skinning", id 33: 3 clean cuts, 2 slips, 15 s, easier by tier) and the pelts on success.
  - Every dungeon container is filled (big chests the full roll, urns/sacks/barrels a small roll with food) and glows until opened; "cleared" still counts big chests only. loot.json has a food pool (ck-mcp\loot.py).
  - Humanoid lease enemies are looted with E: a small roll by difficulty (gold, food, sometimes a potion or ingredients), once per body, gold shared with the party inside; their body keeps nothing. dungeons.js now receives giveItem, which also repairs the party gold split that was silently failing.
  - Starter kit (pickaxe, woodcutter's axe) is handed out 6 s after character creation finishes, not only on the next login.
  - Respawn at the temple of the area of death: Skyrim holds use their temple interiors (Winterhold/Dawnstar -> Windhelm, Morthal/Solstheim -> Windhelm/Solitude), Bruma wakes outside the Cathedral of St. Martin; deaths indoors use the last outdoor spot, Beyond Skyrim interiors count as Bruma. Override with gamemode-config.json "respawnTemples".
  - Wizard enemies get a dagger.
- [x] Border door "pops open" and the game freezes (2026-09-15 18:10): the server refusal only blocks its own teleport, so the engine opened the door and started loading the Skyrim cell behind it; that load hangs the same way the old Whiterun landing did. playtest.js now sends its blocked door refs (dboBlockedDoors) and the client blocks activation on them, showing "Closed" (fork commit, client rebuilt and installed). ck-mcp\border_doors2.py confirmed there are only 4 Bruma/Skyrim crossing doors and both "to Skyrim" ones (656df, 877c2) were already in the config, so nothing was missing from the list.
- [x] Temple respawns moved outside: each hold's temple door arrival marker (ck-mcp\temple_doors.py -> ck-mcp\out\temple_doors.json), e.g. Whiterun 1a26f [24224, -3424, -2973], Windhelm 1691d, Riften 16bb4, Solitude 37edf, Markarth 16d71, Falkreath Tamriel; Bruma already used the cathedral steps.
- [x] VERIFIED IN GAME 2026-09-15 19:44-19:47: title screen -> Create -> spawn straight into the hub -> RaceMenu opens there -> Done with no crash -> starter kit 6 s later. The hub start point works now; new characters no longer route through Bruma. Delete from the title screen works too (slot 0 freed at 19:44:08).
- [x] Quit to main menu did not reopen character select (2026-09-15 19:51, fork 3c742e3): the client quits to the main menu whenever its own actor is destroyed (remoteServer onDestroyActorMessage), and character select parks the body on purpose, so the connection dropped and the player landed on Skyrim's own menu. The client now skips that quit while the select screen is open (globalThis.__dboCharacterSelectOpen, set by characterSelectService). If a drop still happens the client auto-reconnects (networkingService) and the server sends the character list on login, so the worst case is a reconnect. NOT TESTED IN GAME.
- [x] Floating wolves, second attempt (fork 7c186b1): stopping the translation on host handover was not enough; the client now also re-seats the actor at its own position so havok takes it back. NOT TESTED IN GAME.
- [x] Vitals redrawn (fork 23ba3bb): cut-stone shards stepped diagonally, rune caps (Heart of Lorkhan, aetherial eight-pointed star, dragon wing), quarter ticks and a drifting sheen, in place of three plain bars.
- [x] Character select broke the gamemode's login work: it ran 8 s after CONNECT, so with the title screen in front the timer fired while the player had no character (spawned as a plain Nord, no RaceMenu, no kit, no hub move). gamemode.js now waits for the actor (up to 15 min, polled every 500 ms), runs the login block when a character is assigned, re-runs on a character switch, and the waiters survive a hot reload.
- [x] Earlier note, kept for history (2026-09-15 18:2x): hub as the start point again, server-settings.json startPoints = 0x25017482 [2122.2, 2079.6, 3] angleZ 22.9, so a fresh character spawns in RealmofLorkhan with no move at all (gamemode-config "landing" still points at the Bruma arrival, so nothing tries to move them). This crashed on 2026-09-14 ("the hub cannot be a spawn point, spawn save crashes on load"); retested because the client spawn loop and RaceMenu fixes landed since. ROLLBACK if it crashes: startPoints back to 0x080a764b [48236.2, 260600.4, 20405.1] angleZ 135 (the Bruma arrival).
- [ ] LOAD-IN HANG, now three cases (2026-09-15): the Whiterun landing point, the Skyrim cell behind the Pale Pass door, and logging in at the Bruma cathedral (19:58, after respawning there) all hang the client with the world still streaming: not responding, several cores busy, 5.6 GB working set, no crash log, and the server sees JOIN then silence. Clean loads: the hub, the Pale Pass road, and any of these places reached by walking or teleporting while already in world. So it is loading INTO a dense area that wedges, not the area itself. Ruled out: the host re-seat (no spawn or hosting happened in the 19:58 session), the vanilla meter writes, wildlife near the point, the spawn loop. A character saved in such a place is bricked until its position is edited (server\world\changeForms\<id>.json, done for argy #BHTJ at 20:01). Next ideas: capture a minidump while hung (the game was closed too fast twice), or bisect the client bundles from _client-bundle-backups against a save at the cathedral.
- [ ] Older note: loading a Tamriel cell hangs the client (the old start point, and now the door load). Bruma and the hub load fine. Find this before Skyrim reopens.
- [ ] IN-GAME TEST of the batch above: claim a dungeon (enemies already placed, no rejected hits, nothing falling), E on a dead bandit (a small roll, second E refused), X on an NPC body (refused), glowing urns and barrels, kill a wolf and skin it as a Skinner (and as a non-Skinner, refused), wolves outdoors walk instead of float, die in Bruma (wake at the cathedral) and in a Bruma dungeon, a fresh character gets the tools right after creation. Restart the game first: new client and UI.
- [x] Title screen and character select (2026-09-15 evening): Alduinak's characterSelect flow was already in spawn.ts (slots, play/create/delete, characterSelectMenu / characterSelectResult packets) but switched off and rendered through the generic `form` widget, which is why it looked like Keizaal's. Now: server-settings.json `characterSelect: true`, `characterSelectMaxCharacters: 1`; spawn.ts sends race, #TAG, masteries and worn-item counts per slot; the client pushes a real widget (type `characterSelect`, id 7) instead of form elements; new front feature `characterSelect` draws the DragonBreak plate (src/img/dbo-mainmenu.png), the hourglass mark, the wordmark, one card per slot with a diamond sigil, Play/Create and Delete with a confirm step, and Quit. Rollback: set characterSelect false in server-settings.json and restart. NOT TESTED IN GAME.
  - Deleting a character is now done from that screen, so no more hand-deleting world\changeForms\0.json.
  - Time played is not shown: nothing records it per character yet.
- [x] HUD layout 2026-09-15 evening (front rebuild): hunger card and the voice box now sit bottom-right (wrapper .dboCorner), vitals bottom-left. The voice row became its own DragonBreak-styled box (.dboVoice): mic icon, the three ranges as pips with the active one lit, hint reads L-Alt / On air, whole box glows while V is held. Dungeon gate panel enlarged (920px, difficulty cards 200px min, bigger label and blurb).
- [ ] Spell study sigil (asked 2026-09-15): the tester wants the floor sigil to be where spells are learned, in the mages guild. skills.json already reserves `spellStudyPoints` ({name, cell, refr, radiusMeters, schools}) with one entry for the College well, and masterySystem can grant spells (addSpell/removeSpell), but nothing implements studying yet: needs the activate hook, a tome check, the Arcane Arts / Priest tier gate and probably a front widget. Waiting on which building the screenshot was (the hub or Bruma's Mages Guild) to name the ref. The creation-kit MCP find_cells hung for 30 min, so use ck-mcp python scripts for the lookup.
- [x] TrueHUD player widget off (Data\MCM\Settings\TrueHUD.ini `[General] bEnablePlayerWidget = 0`, also in client-dist): its bars were the "vanilla" bars still showing; the real vanilla meters stay hidden by DboRelayService.
- [x] Board fees fund the hold (2026-09-15, fork 4a32b67, server bundle deployed, previous in _alduinak-build-6): a paid Shop Ads / Citizen Notices post puts `bountyBoardTreasuryPercent` (server-settings, default 50, so 15 of 30 gold) into the treasury of the zone the board stands in. Treasuries are now a "treasury" field per zone in zones.json (eight Skyrim bank HoldChests + the Bruma castle safe); the gamemode seeds from the same field. Dawnstar, strongholds and Solstheim have none, so their fees still vanish. Hold Notices stay free. IN-GAME TEST: post a Shop Ad, check the zone's treasury gained 15 and bounty.log names the deposit.
- [ ] IN-GAME TEST: new character through the hub, use any gate (expect Bruma), walk to the Pale Pass exit (expect refusal), /tp as a non-admin into Skyrim (expect return), claim Underpall, check creatures outside the walls.

## Queued work
- [ ] RaceMenu height slider: IMPLEMENTED in gamemode.js (synced ff_scale, clamped 0.94-1.06, configurable via gamemode-config.json "height": {"min","max"}). Needs an in-game test: set height in RaceMenu, close it, expect a snap-back notice if outside the band; a second player should see the change.
- [ ] K-key skill menu: design review + template written (SKILLS_DESIGN.md, skills.json). Next: your decisions on the 11 review points, then build plan steps 1-6 (marker spells, server mastery extension, front menu, client mini-games, recipe conditions, books as nodes).
- [ ] Vanilla level cap 5, perks stay disabled, vanilla skill XP driven by the chosen skills' tiers.
- [ ] Mini-games: mining nodes, woodcutting block, book reading (books become nodes, not pickups).
- [ ] Lumber mill: big firewood yield, 30-minute cooldown per player.
- [ ] Spell learning: Arcane Arts (3 spells at a time, study emote in the Arcanaeum), Priest (Restoration + Alteration).

## Distribution decision (2026-09-14): Nexus collection
- [ ] Curate the collection in Vortex from a clean profile: the 89 non-base plugins at pinned versions, in the server's exact load order. Start from the DO collection (nexusmods.com/games/skyrimspecialedition/collections/ptmvzi) and remove what we dropped (Mysticism, Ghostlight, Kad, evgnn, Mage Clothing, OCW_MaMO, 3BBB, CBPC, Torches, Common Clothing Expanded, Sentinel Priests/Bodyslide/MCE, CommonClothes, MCE Cloaks&Capes, COTN Winterhold interior tweaks, RP_CraftGates).
- [ ] Our plugins ship through the launcher, not Nexus: the backend's client-files package (skymp5-backend build-client) carries DragonBreak.esp/.bsa/Textures.bsa, DragonBreak Online Edits.esp/.bsa/Textures.bsa, the loose meshes, and the RP_* plugins; the launcher installs them into Data and appends them to Plugins.txt after the collection's plugins, in the server's order. Ownership of the RP_* files still needs settling.
- [ ] Nexus permissions check for every third-party mod that must be bit-identical (the server CRC-checks plugins and BSAs): normal collections are fine since players download the originals; nothing gets redistributed.
- [ ] Launcher rework: drop the MO2 + Nexus API install path; keep Discord login, SkyMP client files + our plugins, load order verification against the server manifest, SKSE launch. Point players at the collection for the rest. The launcher must detect Vortex's hardlink deployment and never fight it (write only our own files).
- [ ] Server data folder must match the collection revision exactly; every revision bump = server data update + manifest regen + launcher version bump.

## Added 2026-09-14 (school-day requests)
- [x] Daedric Shrines, All in One 2K installed, audited and on the server 2026-09-14; activator shrines built for Hircine, Sanguine, Sheogorath (Meridia uses the vanilla activator). See the shrine entries below.
- [ ] Housing menu on X (owned door or container): show the owner's name, then a scrollable guest list; "Add guest" by in-game name; remove guest. Replaces the key-item flow for day-to-day access (keys can stay as a physical RP item). Spec in SKILLS_DESIGN.md "Ownership menu".
- [x] Character tag: every character gets a 4-character random tag (e.g. Ysolda #K7Q2) at first spawn, shown in /whoami, name lookups and menus, so two "Ysolda"s never collide. Implemented in gamemode.js (private.charTag).
- [x] Spawn in RealmofLorkhan: startPoints already point at its marker; the nine gate doors (Whiterun, Riften, Solitude, Windhelm, Markarth, Falkreath, Morthal, Dawnstar, Winterhold) teleport to the matching hold via gamemode.js GATES. Banners match the door base records (RP_LorkhanGate<Hold>).
- [x] Character creation in the Realm (tested OK 2026-09-14 afternoon; a few seconds of Whiterun LOD before the move is unavoidable): the hub cannot be a spawn point (crash on save load) and a world reload with RaceMenu open crashes the client (RaceSexMenu head-part free, seen 14:28), so a fresh character now spawns at the Tamriel landing point with NO menu (`deferRaceMenu: true` in server-settings.json, honoured by spawn.ts, bundle rebuilt), the gamemode moves it into the hub 8 s after connect like any other character, and 8 s after that opens RaceMenu there (setRaceMenuOpen off/on). Creation finish (kit, creationPending) still runs through spawn.ts's `onUpdateAppearanceAttempt` when the menu closes. Worlds reset three times today; old ones in server\_world-backup-2026-09-14-*. Previous bundle in _alduinak-build-3. Decide which creator: vanilla RaceMenu (default now, has the height slider) or Alduinak's CEF creator (`charCreator.enabled`; presets, kits, no RaceMenu).
- [x] gamemode.js hot reload no longer stacks `mp.on` listeners (the reload's clear() resets properties, not the emitter); connect/disconnect/customPacket now register once and delegate. Symptom was three JOIN lines per login.
- [x] Hub teleport after spawn and the hold gate doors: confirmed in game 2026-09-14 (Windhelm gate used). A Havok collision crash near the Windhelm stables followed 46 s later, Precision.dll on the stack, nearest ref a JK's Skyrim crate with the vanilla mesh; not reproduced yet. If it repeats there, run once without Precision.dll.
- [ ] Deity popup right after the creator closes (charCreatorResult / RaceMenu close), before the player is released into the Realm. Spec in SKILLS_DESIGN.md.
- [x] /chargen #TAG and /rename #TAG <name> are admin-only gamemode commands, logged to the GM channel. Players cannot do either themselves.
- [ ] Standing stones = skill respec: first free, then 1,200 gold. Part of the skill system build (K menu respec mode + DoomStone activation hook). Spec in SKILLS_DESIGN.md.
- [ ] Harvesting skill (17th, Support) added to the template; gold pouches become harvest nodes; unskilled players get little or nothing from nodes.
- [ ] No-pickup rule: plugin-placed loose items cannot be taken with E; only nodes, containers, crafting, trade and player-dropped items. Extend Alduinak's untouchable system from a list to "every item-type base placed by a plugin". Part of the skill system build.
- [x] Decision: no Anniversary Edition requirement; base SE 1.6.1170 + the four free creations. Hanging rabbits/garlic/herb bundles are Harvesting nodes (template updated).

## Added 2026-09-14 (afternoon)
- [ ] Notice boards: re-key Alduinak's bounty board system to Manny's boards (14 placements), three tabs, 30 gold per post, Hold Notices official-only. WORLD_DESIGN.md.
- [ ] Pigeons: player mail by name or tag, 35-minute cooldown, offline delivery on login, block list. WORLD_DESIGN.md.
- [ ] Orc strongholds sovereign: six stronghold factions (Chieftain, Bane), sovereign zones by radius, locks and boards answer only to stronghold officials. WORLD_DESIGN.md.
- [ ] Decide the gold faucet (no NPC merchants): stipend, treasury payroll, or harvest-only.
- [x] Bank treasuries: gamemode seeds each of the 8 HoldChests with 10,000 gold once. Dawnstar has no bank interior.
- [ ] Bank exteriors (CK, you): place the shell + exterior door in each city and link it to the interior door (refs listed in WORLD_DESIGN.md). The interior doors currently point at targets that do not exist.
- [x] zones.json written: nine holds with officials (jarl, steward, commander) and six sovereign strongholds (chieftain, bane) with centres and radii. Shared by housing, boards, bounties and sovereignty once those systems read it.
- [x] Pigeons live in gamemode.js: /pigeon <name|#TAG> <text> (35-min cooldown, 240 chars, offline delivery on login, 20 unread cap) and /pigeonblock <name|#TAG>.
- [x] DO plugin names gone: RP_Custom -> DragonBreak Hub, RP_DungeonOpen -> DragonBreak Dungeons, RP_JKWhiterun -> DragonBreak Whiterun, RP_Built/RP_Harvest -> DragonBreak Built/Harvest; RP_Nexus (empty) removed. Masters patched in DragonBreak.esp and the Edits plugin. 98 plugins now. EditorIDs inside (RP_*, DBO_*) untouched.
- [ ] Dungeons: enemies per dungeon type via NPC-Spawns zones, lease-style instancing with 1h timer + 1h cooldown, difficulty selector, locked chests, /party. WORLD_DESIGN.md.
- [ ] Lockpicking skill (18th, Professions): player doors and dungeon chests only; server gates the mini-game by tier. Template updated.

## Skill system build (2026-09-14, afternoon)
- [x] 85 marker spells (17 skills x 5 tiers, DBO_Skill_<id>_T<n>) created in DragonBreak Online Edits.esp by Edit Scripts\DBO_SkillMarkers.pas; plugin validated.
- [x] Server: masterySystem.ts rewritten as the DragonBreak skill system (skills.json next to the server): up to 3 skills, 5 tiers by verified hours, marker spells granted per tier, vanilla actor values set per tier (15/tier), station gating in onActivate, Harvesting chance and extra yield, respec at standing stones (first free, then 1,200 gold), legacy record migration. Bundle built locally and installed (previous kept in _alduinak-build-2).
- [x] Client + front: K menu shows three groups, N/3 slots, description, five-tier ladder, Take up / Set aside (respec mode), confirm dialogs. Installed in the dev game folder.
- [x] IN-GAME TEST 2026-09-14: K menu works, three skills chosen, forge refused with "Blacksmith only". Still untested: harvesting with/without the skill, standing-stone respec.
- [ ] Recipes: add HasSpell(DBO_Skill_<id>_T<n>) conditions to gated COBJ records by tier (xEdit script, next).
- [ ] Prayer, lockpicking, mini-games, dungeons, boards: not started (contracts exist in the design docs).
- [x] Front-end install location fixed: the client loads Data\Platform\UI from the game folder (Skyrim Platform default), not the server's data\ui. Built UI copied there and into client-dist. Any future front rebuild goes to both.

## Added 2026-09-14 (evening): needs and consumption
- [ ] Hunger system: built in gamemode.js (config "needs" in gamemode-config.json): 0-100 meter, +12/h online, stages Sated / Peckish 50 / Hungry 75 / Starving 90 with StaminaRateMult and HealRateMult penalties re-applied on login, food restores by kind from the record (meal 35, snack 15, drink 8, ingredient 4, potions 0), /hunger and admin /sethunger. IN-GAME TEST: /sethunger #TAG 95, expect the starving notice and slow stamina regen; eat bread, expect the meter to drop; relog, expect the penalty to persist.
- [ ] Eating / drinking / potion animations: client ConsumeAnimationService (fork skymp5-client, bundle installed in the dev game and client-dist) plays IdleDrink for potions, poisons and drinks, IdleEatingStandingStart for food and ingredients, through the emote system, when an item is consumed from the inventory, favourites or a hotkey. IN-GAME TEST: drink a potion, eat bread, use a hotkeyed potion; a second player should see the idle.
- [ ] Anti-hot-potting: the server core already refuses a second potion within 10 s (C++ constant kPotionCooldown; food exempt). The animation does not delay the effect and vanilla idles do not play with weapons drawn. The real version (effect applied after the animation, cancelled on hit or weapon draw, cooldown as a setting) is a C++ change in MpActor::OnEquip plus a CI build. Spec in WORLD_DESIGN.md "Needs and consumption".
- [ ] Hunger bar HUD (bottom-left): front feature `hud` (widget type "hud", id 29) fed by the gamemode property ff_hud, re-pushed every 4 s owner-side so it survives a CEF reload. UI built and installed in the dev game + client-dist (previous build.js in server\_ui-build-backups). IN-GAME TEST: bar visible bottom-left after login, empties as hunger rises, colour shifts at Hungry/Starving; /sethunger #TAG 95 to see it fast. Vitals bars (health red, magicka blue, stamina green, Oblivion style, bottom-right) added the same evening in the same widget: percentages read client-side from the player actor values by the ff_hud owner code, pushed only on change. Turn off the vanilla or TrueHUD player bars in the TrueHUD MCM to avoid doubles; gamemode-config.json "hud": {"vitals": false} hides ours.

## Added 2026-09-14 (evening): Bruma, Daedric Shrines, Fort Dawnguard
- [x] Server load order now 105 plugins (BSAssets.esm, BSHeartland.esm, man_DaedricShrines.esp, JK's Fort Dawnguard.esp, three More Craftable Equipment patches). Server boots in 9 s, manifest regenerated, Plugins.txt rewritten from the order (backup beside it). Dev copy synced from the Vortex staging folders (4 GB of Bruma BSAs). COLLECTION_NOTES.md has the details.
- [x] man_DaedricShrines.esp audited: valid, no dangling refs, no stacked duplicates, no landscape or navmesh clash with any other plugin. It hides vanilla statues with plain "initially disabled" overrides (no scripts), so it works under SkyMP. Only clash: two trees at the Hircine site that DragonBreak.esp already disables (DragonBreak wins, fine). Nocturnal's new shrine is enable-parented to the quest marker and stays hidden; deliberate for now.
- [x] Activator shrines built 2026-09-14 evening (Edit Scripts\DBO_ShrineActivators.pas, result file beside it): DragonBreak Online Edits.esp now masters man_DaedricShrines.esp and holds DBO_ShrineOfHircine/Sanguine/Sheogorath (ACTI 1112c5/1112c8/1112cb) placed on the AIO statues (REFR 1112c6 Falkreath, 1112c7 Solstheim, 1112c9 Rift, 1112ca Misty Grove, 1112cc Morthal marsh), statue refs overridden as initially disabled. Meridia uses the vanilla Kilkreath activator 4e4d6:Skyrim.esm. skills.json deities updated. SSEEdit must be run with -D:"<dev Data>" -P:"server\plugins.server.txt" because Vortex rewrites Plugins.txt while it runs (see COLLECTION_NOTES). IN-GAME TEST: walk to the Sheogorath shrine near Morthal, expect an activation prompt "Shrine of Sheogorath".
- [ ] Bruma playtest lock (not started): gamemode refuses the Pale Pass border doors, bounces anyone in Tamriel outside the pass back to Bruma, and the hub gets a single Bruma gate. Spawn: keep the Tamriel landing and move into Bruma, or test a direct Bruma start point.
- [ ] IN-GAME TEST: log in, check the 105-plugin order passes the client check, walk to a shrine (Sheogorath at -47437,99695 near Morthal is closest to a gate), and /tp into Bruma to confirm it loads.

## Later: Journey to Baan Malur and Morrowind (nexusmods.com/skyrimspecialedition/mods/114518), requested by players 2026-09-14
- [ ] Feasible the same way as Bruma: it builds inside the Solstheim worldspace (no new worldspace, so no spawn-save problem), one 734 MB main file (v i1.1.9b, May 2025), plus the tiny "Dunmeth Pass" optional (border gate on the Windhelm road) and "Morrowind Map Fix" (must load last). Needs CC Fishing and Rare Curios (we have both), FSMP (we have it) or its No-SMP patch, and bBorderRegionsEnabled=0 in Skyrim.ini for every player: put that in the collection's INI Tweaks tab, or players get bounced at the border. Under SkyMP its 100+ NPCs, quests, ferries and scarab currency are inert; the ferry (Raven Rock / Cormaris / Baan Malur) becomes gamemode gate doors like the hub gates, the Windhelm road through Kalbthurz works as plain doors. It bundles Daedric Shrines and Armors of the Velothi assets, which we already run, so audit for duplicate base records before adding. Its creatures (alits, kagoutis, guars, nix-hounds, scamps, clannfears, daedroths) are usable as NPC-Spawns zone enemies for Morrowind dungeons. Not compatible with Worldspace Transition Tweaks (we don't use it). Edits Raven Rock (a boat).
- [x] Journey to Baan Malur added to the server (2026-09-14 evening): two plugins in the masters block, load order 107, dev copy synced, Map Fix folded into the Edits plugin instead of loading. Details in COLLECTION_NOTES.md. IN-GAME TEST: /tp east of Windhelm and walk through Kalbthurz, or /tp to Raven Rock; check the map shows the new region. Remember bBorderRegionsEnabled=0 (set on this PC).
- [ ] Vortex profile: remove "Morrowind Map Fix" (its data is now in our plugin); add the Velothi-after-Baan-Malur file rule; add the border-regions INI tweak to the collection.
- [ ] Maybe later: The Gray Cowl of Nocturnal SE (nexusmods.com/skyrimspecialedition/mods/4509, MannyGT, v1.3 2017, 194 MB ESM, no requirements). A quest mod: the vision start, the travel to the hidden Alik'r region of Hammerfell and the Coldharbour island, the bosses and the follower rules are all quest script, none of which runs under SkyMP. What survives is two new worldspaces of custom desert and ruins with their own weathers, reachable only through gamemode gate doors, plus scripted dungeon doors, traps and puzzles that would need the same disable-and-sink sweep as the DO dungeons. Worth it only if players want Hammerfell as an RP location; otherwise skip. Ends at a Nocturnal shrine, and Nocturnal is deliberately outside the deity system for now.

## Added 2026-09-14 (evening, late)
- [x] Male body: HIMBO dropped, Tempered Skins for Males (Dressed, v2.05, textures + vanilla-shape body/feet meshes, no plugin) in. HIMBO.esp and RaceMenuMorphsHIMBO.esp removed from the server order (nothing mastered them; parked in _removed-client-mods). Dev copy: HIMBO refit meshes reverted to the profile's current versions under armor_replacer, nordwar, pulcharmsolis, clothes and character assets; HIMBO-only body/hand/tri files and male skin textures deleted (log server\_himbo-removal-*.log). Immersive Armors / weapon / dragon priest meshes were left as the dev copy has them (they differ from the profile for DO reasons, not HIMBO). Collection: remove HIMBO V5 core, Sentinel HIMBO Refit, Velothi I/II HIMBO, HIMBO NordwarUA New Legion, Common Clothes HIMBO; add Tempered Skins for Males; Skysight Skins now overlaps TSM on male textures, pick one (TSM should win or drop Skysight).
- [x] The Gray Cowl of Nocturnal on the server: Gray Fox Cowl.esm in the masters block after Baan Malur (load order 106 with HIMBO gone), BSAs in the dev copy. Audit: 3 new worldspaces (mannyGFO, mannyGFL, mannyGFDesert), 2,119 new cells, no vanilla landscape overrides, 11 vanilla navmesh overrides, 16 vanilla cell overrides; its Skyrim-side content sits in cells (-2,-29)/(-3,-29)/(-2,-28)/(-2,-30) south of Falkreath (Tamriel, ~-8000,-118000 area) plus a few refs at (-30,-7), (-5,-20), (-9,-21) and (-16,23). Only real overlaps: cell (-9,-21) with Falkreath mods, cell (-16,23) with DragonBreak.esp, cell (-1,-28) with DragonBreak Dungeons; all cell-record level. Scripted content: 44 scripted activators, 231 scripted refs, 22 quests, 43 locked refs, 361 enable-parented refs of which 155 hang off 17 markers that start disabled (never appear without the quest), 32 initially-disabled refs. Gate/trap placements: AlikrGate 25, D5 BigGate 19, ColdharbourGate 5, GateToOasis 5, pressure traps 34, wall traps 22, light puzzle 4, four-key door 1. That is the disable-and-sink sweep for the map devs. Entrance: their Creation Kit door, or a gamemode gate.
- [ ] Vortex profile still to clean: Mage Clothing Expansion (main file still deployed, its plugin disabled); reinstall Sentinel without "More Craftable Equipment" and Obscure's College without the Mysticism patch (stray plugins on disk, disabled); 3BBB.esp and FNIS.esp on disk, disabled. Removed on 2026-09-14 evening: Moon Monk, Nirn, COTN Castle Interior, Map Fix, Skysight, HIMBO family, CBBE 3BA.
- [x] Female body swapped to CBBE SFW Edition 1.1.4 (replaces CBBE 2.0.3 and CBBE 3BA; Skysight removed). It ships CBBE.esp (identical to the server's) but no RaceMenuMorphsCBBE.esp, so that plugin is off the server order (parked in _removed-client-mods): no CBBE body sliders in RaceMenu any more. Load order 105. Dev copy synced (CBBE SFW, then Tempered Skins Females, Feminine Grey Cat, Tempered Skins Males, in Vortex's conflict order); female body meshes match the profile. 3BA-built outfits (Velothi, Immersive Armours, New Legion 3BA) stay and render on the CBBE body without physics.
- [x] DragonPriestArmor.esp: the DO copy differed from the Nexus file in 168 recipe records (crafting-station keyword). The server and dev copy now carry the Nexus file, because players get that one from the collection and the client check is byte-exact. DO's version is kept in ckmcp-backups\DragonPriestArmor.esp.daedric-online-version-*. If the DO stations were wanted, the same effect needs the matching FOMOD option in the collection, not a server-side edit.
- [x] Old-server branding removed 2026-09-14 evening: DO launcher uninstalled by the user (its DaedricData folder, plugins, archives and SkyMP client are gone from the Steam install; only a stray SkyrimPlatform.ini remains in SKSE\Plugins, harmless). Project side: backups, xEdit scripts (DOL_ -> DBO_), the dev copy's launcher-data folder, notes and memory all renamed. Folder rename + memory key: RENAME-FOLDER-AFTER-CLOSING-CLAUDE.ps1 (rewritten: stops the server, valid .mcp.json with CKMCP_PLUGINS, text replace). The Vortex collection copy still needs renaming by hand.
