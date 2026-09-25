# DragonBreak Online checklist (2026-09-14)

## Added 2026-09-25 (23:15 UTC): death and revive HUD text - FRONT WORK, NOT STARTED

Player feedback, #bugs thread 1553180540029501470 (athny), with a HUD.png attached. The gameplay half is done
and live (`downed.js` `0ac74971`: short banner on screen, full detail in chat). What is left needs a front
build on Nat's PC, and two of the three are Nat's design calls, not ours.

- [ ] **System messages in a colour of their own.** athny suggests yellow for death and server info. Today
      every `personal()` line renders the same as player chat, so death text competes with conversation.
      Needs a message class carried through the relay and styled in `fork/skymp5-front/src/dbo-theme.scss`.
      Nat: confirm the colour, and whether it applies to all system lines or only death and law.
- [ ] **Move the revive text lower.** The banner sits centre-screen. athny wants it nearer the bottom and
      more condensed. Position lives in the front banner widget.
- [ ] **A live countdown to revival or death.** The banner takes a static string and a duration, so a ticking
      number cannot come from the gameplay layer without a packet per second. It belongs in the front widget:
      send the deadline once and let the widget count down. `C.bleedoutSeconds` is 60.
- [ ] Check whether the end-of-effect notice is enough. "The chill of the grave leaves you" already fires
      (`downed.js` `liftChill`), so athny may simply not have seen it behind the other text.

Not a bug: the text was already going to chat as well as the banner. `banner()` sends `dboBanner`, a
`dboStatus` notice and `personal()` all three.

## Added 2026-09-24 (20:05 UTC): newbrumacityedits (2).esp merged into DragonBreak Online Edits.esp - DEPLOYED 20:08 UTC

- [x] Nat's `newbrumacityedits (2).esp` (141 records) is (1) plus 35 records: Fighters Guild + basement and Icewind
  Traders cells, 11 new REFRs, 21 BSHeartland REFR overrides (16 of them deletions, as authored), 14 of (1)'s records
  edited. Merged with `ck-mcp\merge_into_dle.py`, which now takes `--previous <old child> --previous-dle <DLE before
  that merge>`: it replays the first merge's id assignment and checks every id against DLE, so (1)'s 18 new REFRs kept
  `DLE:12AE04..12AE15` instead of being added twice. New REFRs `DLE:12AE18..12AE22`. Proof OK (300 form id windows,
  0 wrong; every untouched DLE record byte-identical); 29,433 -> 29,465 records; creation-kit validate ok, 0
  unresolvable, 0 dangling, 0 broken doors, deletions now 2,556.
- [x] **One conflict resolved by hand: BSHeartland WRLD `0B0A764B` object bounds.** After the first merge another session
  raised DLE's NAM9 max y 266240 -> 299008 (undocumented); (2) lowers NAM0 min y 122880 -> -4096. The result keeps
  the union: NAM0 (-16384, -4096), NAM9 (262144, 299008). Nat: say if either edit was not meant.
- [x] Installed in dev Data and `server\data` (identical, sha `522294fc`). Backup: `ckmcp-backups\pre-brumacity2-20260924-150221\`.
- [x] **Deployed 20:08 UTC (Nat's go)**: `deploy-plugins` replaced DLE on the game server (restart, 0 `[error]` at boot) and in the launcher's extra files (`/api/files/extra` serves `522294fc`); old copy in `/opt/skymp-backups/plugins-20260924T200826Z`. Client package **0.3.36** (20:17 UTC) carries it too: built on CT 115 from the live 0.3.35 zip, only the plugin changed, adm-zip readback 278/278 through the public URL. Was: `deploy-plugins` (+ restart, launcher sync, commit the `SHA256SUMS`) and the
  client package need Nat's go. `_release\DragonBreak-plugins-20260924.zip` not built (the step was declined).
- [ ] Not looked at in game. Do not load `newbrumacityedits*.esp` alongside DLE.

## Added 2026-09-24 (evening, with Nat: "finish everything"): regions, PvP rebalance, keys, jail, Gray Fox, DevTools

Nat said push both and deploy gameplay. Every harness passes (run them all with `for f in tests/*-harness.js`).

- [x] **Regions committed** (server `fc3e290b`, `1d54bbee`): the paused regions work from `HANDOFF_CLOUD_2026-09-24.md`
  item 1 was complete on disk (harness 61/61) and only needed committing. The tome filter is on (`/tomes` sells Cyrodiil
  tomes); **the craft gate stays off** (`regions.craft: false`) until one in-game test shows a refused craft keeps its
  materials: `/region test`, try a Skyrim-only recipe in Bruma, leave the forge, count the ingots.
- [x] **PvP rebalance** (server `8273a192`, config `mastery` / `pvp`). Measured first from the live log: a naked player
  has 150 health; a Master two-hander hit for 25.6 + 7.7 (x1.30), 5 hits to kill. Now weapon tiers are
  +35/+65/+100% (4 hits, 2 with power attacks), fists use the Unarmed tier (source `0x1f4` never mapped to a skill,
  so Unarmed's advertised bonus was never paid), and **Defense** makes worn armor count x1.25/1.75/2.5/3.5 by tier: the
  engine takes armor at rating x 0.12 % with no skill, so the hit is scaled from the engine's reduction to the boosted
  one and the difference given back as health after the hit. Full Daedric heavy (108) at Master Defense: 45 % off a hit
  instead of 13 %. `pvp.damageMult` scales player-on-player hits (1). skills.json tier text says the new numbers.
  Harness 43/43. **Watch**: `mastery damage ... x0.xx` lines (below 1 = armor gave health back); the website's Skills
  guide still says +10/20/30 (Jake's package).
- [x] **Housing: a rename can no longer hand keys to another property** (fork `130e83b`). Each property records the key
  names it has cut (`rec.issued`, cleared on re-key); a door opens to those or the credential suffix. Old records are
  frozen to the name their keys were cut under on the first update after boot (`[housing] recorded key names for n/m`).
  A rename now keeps old keys working. New cuts take the lowest `Key to the X[, the Nth]` no other property answers to.
  `server\tests\housing-keys-harness.js` 15/15; the same harness fails 5 checks on the old code (A's key opens B, B's
  own keyholders locked out).
- [x] **Jail uncuffs a bound prisoner as the door locks** (fork `ce847a4` `__dboUncuff`, server `6f5b8627`). Until the
  server build lands the guard is still told to uncuff through the bars. Jail harness 48/48.
- [x] `/wipechars` parses a bare profile id (`/^\d+$/`), server `0bd9b87b`.
- [x] **Gray Fox libespm fix**: already on `main` as `4ddc32e` / `4c46a06` and live since the 16:08 build (Combiner.cpp.o
  16:05 on the box); merging the side branch added nothing. Watch for `Record 0xffffffff` after an Ancient Vision cast.
- [x] **Shipped 19:57-20:05 UTC** (Nat's go): server `e3c506d3` deployed, fork `276a721` built and restarted OK, 0
  `[error]` lines at boot, patch notes "Skill and Steel" published. Logged in `OPS_HANDOFF_2026-09-24_claude-nate.md`.
- [x] **Incident, fixed**: the first housing build (`4badca9`) ran the key-name migration on the first tick after boot,
  before the doors' records had loaded, and `liveClaims()` pruned all 4 claims from `housing.json`. Restored by hand;
  `276a721` migrates only before a rename or key cut and never prunes (harness 17/17 covers it).
- [ ] **Hazard left as it was**: `liveClaims()` (decor push on every join) still drops any registry id whose record
  reads as null. If a player joins before a claimed door's record loads, the claim leaves the index the same way. Watch
  for `[housing] dropped` after a restart; the safer rule is to prune only records that read as ownerless stubs.
- [x] **CEF DevTools closed in release** (fork `efd145b`): both browser backends opened remote debugging on 9000;
  now only when `SKYMP_CEF_DEBUG_PORT` names a port (NirnLab passes it straight to CEF, where 0 is off). **C++ in
  SkyrimPlatformImpl.dll: needs a CI flatrim build and a client package**, not compiled here.
- [x] Client package 0.3.35 (server session) and 0.3.36, launcher 2.1.29 (released 20:24 UTC, backend offers it) are out. Still open from the handoff:
  the deferred C++ list; Beyond Skyrim BSAs in the server's `archives` (a server-settings change and restart, Nat's call);
  the Revival brew lab test.

## Added 2026-09-24 (16:10 UTC, unattended `daily-code-review` run): brief is stale, nothing changed

- [x] Earlier sessions already finished everything in the brief's queue (written 2026-09-20). Checked in the code:
  `labour.js` emits `'mine'` with the ore band and `'chop'` (lines ~356-362); `skills.json` has the wayshrine lists,
  `conversionCooldownDays: 7` and the Daedric deities with Imperial law; `prayer.js` emits `'prayer'` on a completed
  prayer; the live boot reports `18 skills have marker spells` (Unarmed's T1-T5 exist). No code or data edited.
- [x] Live boot 16:08:53 UTC (fork `2452c662`, lever gates): **0 `[error]` lines** and no JS error in the 417 lines since;
  only the usual `weaponStaminaModifiers field is missing` info line. `online: 0` at 16:11.
- [ ] **Nat: rewrite or retire the `daily-code-review` brief** (STATE.md already says so). It still points at the
  Windows server, the 18-line error baseline and a finished queue; unattended runs spend their time rediscovering that.

## Added 2026-09-24 (14:50 UTC, unattended run): live-log verification, rename notice, nothing pushed

- [x] **Non-Skyrim.esm spells deal damage now (verified from the live log).** `OnSpellHit ... damage` lines with a
  nonzero amount for Dawnguard spells `20126b7` (68 hits), `20059a1` (14), `2019324` (11), `200e7da` (5). The EFID
  record-local fix is proven in play. No `Record 0x...` line since the 22 Sep 19:08 restart except Gray Fox's
  `0xffffffff` (last 23 Sep 04:25).
- [x] Gray Fox fix (`claude-nate/overrange-self-index`, `097a75e` / `102ee39`) is **still not merged or pushed**.
- [x] Supernatural / beast audit lines now appear (33): BEAST took Vampire Lord / Beast Form, SUPERNATURAL
  Hircine-blessed werewolf, a revive.json permadeath restore; Howl of Terror logs terrified counts. No JS error
  (`TypeError` / `is not a function` / `Cannot read`) anywhere in the live log. Power-attack stamina not checkable from
  the log (no stamina line exists); needs a player report.
- [x] **The 721 `resolved context ... (reason=exception)` errors since 23 Sep are log noise, not dropped packets.**
  They are `mp.get(id, "isDead")` (645), `profileId`, `type`, `baseDesc` on stale ids or on a door/activator
  (`formId=0x8086814` door, `0x3c12ae13` activator, both at activation). The Antigo context in `ScampServer::Get`
  prints on unwind whether or not JS catches, and every `isDead` read in `server\*.js` / `ts\systems` on an activation
  path is inside `try`. Real dropped actions in that window: 12 `Bad hoster is attached to caster` and 3
  `WorldSpace doesn't match` (dungeon <-> BSHeartland).
- [x] Log noise with a vanilla cause: 3x `CallStatic - Function not found - 'StopInstance'` (Papyrus `Sound.StopInstance`
  from a vanilla script, right after dungeon hosts are granted). Nothing of ours calls it.
- [x] **Housing: rename notice** (fork `587ef69`, local `main`, **not pushed, not built**). A named key is matched by
  its whole name (`Key to the <name>`), so renaming a named property orphans every key cut before it; the owner is
  now told `Keys cut before the rename ("...") no longer open it: cut new ones.` Unnamed `Property Key (TAG)` keys
  end in the credential and keep working, so no warning there. `tsc --noEmit` clean.
- [x] **Housing (fixed 2026-09-24 evening, fork `130e83b`): a rename can hand keys to another property.** Two properties sharing a
  name are ranked by ref id (`labelRank`): the lower is `Key to the X`, the higher `Key to the X, the second`. If the
  lower one is renamed away, the higher one becomes rank 1 and its expected key becomes `Key to the X` - which is
  exactly the key the renamed property's old keyholders carry. They now open the other property, and its own
  keyholders are locked out. Same when a lower-id property is renamed *to* an existing name. Fix options: match on
  the credential suffix always (keys carry `(TAG)` again), or store the key name issued at cut time on the record.
- [x] `ck-mcp\markerspells.py` canonicalises the SPIT perk and the EFID effect through DragonBreak Online Edits.esp's
  own master list (it used `lo.plugins[0]` for the perk and printed EFID raw). Ran it: 90 markers, output unchanged
  (no marker has a perk or an effect). ck-mcp is not in git.
- [x] **Four new client crashes on this PC, 23 Sep (local times, `C:\DragonBreak\skyrim`), none is the jump crash:**
  16:04 `SkyrimSE+0AC1782` (id 58524, `cmp [rcx+0x18]`) during `WerewolfBeastProject` with OpenAnimationReplacer
  `Hooks.cpp:206` on the stack - a beast-form transform; 19:01 `EXCEPTION_BREAKPOINT` `+0B7544F` (id 62402) under
  hdtSMP64 `ActorManager::setSkeletonsActive`; 20:53 the known EngineFixes tbbmalloc `freeOwnObject` with
  SkyrimPlatformImpl on the stack (ids 36544/36601); 21:44 jump to `0x1` in a BSJobs thread with a `BSLight*` in RAX
  (ids 63997/63980). Not resolved further; the werewolf one is worth a repro (transform with OAR loaded).

## Added 2026-09-24 (03:30 UTC): play session 01:25-03:02 UTC, issues noted (nothing fixed or pushed yet, Nat: hold)

Players: Argosh, Goddess Dibella, Elder Uriel, Huntan Elmgrove, Hircine, Lizard-chef, Falcius Octavio, Velisse
Montclair, Vaelis Duskwood, plus new characters. Evidence is `/var/log/skymp-server.log` for that window.

- [x] **Fixed in code 2026-09-24, not deployed (Nat: hold).** Dungeon enemies bunched on players / not taking damage:
  measured on bandit `ff000084` (Serpents Trail 02:39:16) - placed at its zone spot (-2841,-6251), then jumped 6290
  units to 248 from its host Lizard-chef, who streamed that to the server; everyone else's hits were "too distant".
  Same birthplace bug as the fox bounce: every copy is `placeAtMe`'d on the player. `SpawnProcess` now seats the new
  copy natively (`TESModPlatform.moveRefrToPosition`) before its first enable; `/driftspawn moveTo|setPosition`
  switches it live, jump reports carry `spawn`. Needs client 0.3.34. Verify: jump reports with `fromPlayer` under
  ~400 should stop; "too distant" count in a dungeon run should fall.
- [x] Fixed in code: party HUD after a crash (dungeons.js `__dboPartyLogin/Logout`, harness
  `tests/party-reconnect-harness.js`); gameplay deploy only.
- [x] Fixed in code: Healing Hands retargets the caster's restoration channel from `OnSpellHit`, keep-alives keep the
  target; magicka/health regen gap capped at 5 s with a timer per vital, client sends vitals every 1 s. C++ never
  compiled locally (no build tree): CI flatrim build must pass `[CropRegeneration]` and `[ChangeValues]`.
- [x] Fixed in code: trade menu search bar (front build only). deploy-gameplay no longer copies `NPC-Spawns.json`
  (a regenerated wildlife file must now be copied by hand).
- [x] Fixed in code (C++, needs the CI build): Nat wants dungeon enemies present everywhere in the dungeon, not only
  near you. Visibility was a 3x3 block of 4096-unit squares in interiors too (Serpents Trail is ~9000 across); an
  interior cell is now one square (`WorldState::IsInteriorCell`, `MpObjectReference::GridPosOf`), its records load from
  +-16 squares, `mp.getNeighborsByPosition` follows. Watch client frame rate in the biggest interiors.
- [ ] **Crash 2026-09-24 00:09 local (Vaelis Duskwood, Maw of Sedor `CYRSedorV202`):** access violation `jmp [rax]` at
  SkyrimSE+0A883CE in Havok ragdoll stepping on an Ayleid Skeleton (`DraugrBehavior.hkb`, `hkbRagdollDriver`), with
  Precision.dll in the call chain. Common thread across the 20:44, 20:58, 22:59 and 00:09 crashes: physical memory at
  14.3-15.2 of 16 GB used in every one; three of the four are in Havok/animation. Next: ask Vaelis for pagefile size and
  settings; test Precision ragdoll settings; watch memory now that every dungeon NPC is visible to everyone inside.
- [ ] New from Nat: looting a webbed body (bodies in general) crashed - need the crash log.
- [ ] Favorites: waiting on Nat - never sets, or lost after relog/pickup.

- [ ] **Dungeon enemies "only in one room, leave the room and they despawn" (Serpents Trail 02:35-02:54).** Server side
  all 17 prespawned enemies stayed up for the whole lease (no despawn line until the 02:53:55 release), so the
  vanishing is on the clients. 188 "aggressor and targetRef are too distant" hit refusals, all 02:30-02:50 (the
  dungeon run), and "not a hoster" errors climbing 6 -> 19 per 10 min: the enemies' server positions disagree with
  what players see. Suspects, unmeasured: (a) the 0.3.32 rule that sends no movement for a hosted actor without 3D,
  if actors across the cave count as unloaded; (b) interior neighbour streaming range. Next: npcDrift report of
  host id, 3D state and server-vs-client distance for dungeon actors. Note Serpents Trail's zones are all in cell 01
  because cells 02/03 have no placements in BSHeartland (02 is the jail room); 20 of 86 multi-cell dungeons have
  a cell with no enemies at all (list: node one-liner over dungeons.json `cells` vs `zones[].cell`).
- [x] **A gameplay deploy ends running dungeon leases.** `NPC-Spawns.json` is tracked, so `deploy-gameplay` copies it
  over the live one; at 01:56:20 that wiped the Plundered Mine lease zones mid-run (all 9 zones despawned, then
  "released (left)"). Exclude `NPC-Spawns.json` from deploy-gameplay like the other runtime files, or refuse to
  deploy while a `dungeon:*` zone exists.
- [x] **Healing Hands does not heal other players (code proven).** The cast event's target is always the caster
  (SkyrimPlatform `EventHandler.cpp` reads the caster's MagicTarget), so `OnSpellCast` opens the restoration channel
  on the caster; and `OnSpellHit` returns for anything not FireAndForget (`ActionListener.cpp` ~1932), so the hit
  with the real target is dropped. Heal Other works, Healing Hands heals the caster. 288 restoration-channel lines
  this session. Fix is C++ (let concentration restoratives re-target the caster's channel from `OnSpellHit`), so a
  CI flatrim build.
- [x] **Magicka bar fills then drops back ("regens faster than it should") (code proven).** The client reports vitals
  every 2000 ms at the earliest; `CropPeriodAfterLastRegen` treats any gap over 2.0 s as 1.0 s, so nearly every
  report is cut to about half and the server sends the lower value back. Real regen is about half the intended rate;
  the bar shows full rate for 2 s and snaps. Server-side stamina drains share the health/magicka clock. Fix: C++ cap
  the gap (e.g. at 5 s) instead of dropping to 1 s, separate clocks per vital; optionally client sends every 1 s.
- [ ] **Favorites bar doesn't set / keep.** Nothing blocks the menu or keys 1-8 (vanilla controlmap). Favorites are not
  stored anywhere: login removes every item and spell and re-adds them without favorite data, and server inventory
  rewrites re-apply the inventory mid-session. Nat to say which: never sets, or lost after relog / after picking
  something up. Test: favorite an item + spell, wait 5 s, pick up gold, relog.
- [ ] **Vitals don't sync well** (Nat). Largely the magicka item above; health follows the same rule at a rate too
  small to see. Remote clones' bars come from `remoteVitalsService`, not checked yet.
- [x] **Trade menu needs a search bar** (Nat, feature). Front widget `skymp5-front/src/features/trade`; front build only.
- [ ] **Quick relogs (crash or disconnect under 2 min):** Goddess Dibella 01:35:57 (108 s) and 01:48:00 (26 s),
  Falcius Octavio 02:24:57, Velisse Montclair 02:33:47, Lizard-chef 02:46:09. Vaelis Duskwood left 03:01:08 = the
  22:59:59 local crash (Havok, Freezewind Hollow, same as 20:58). Ask the others for crash logs.
- [ ] Log noise with a cause: 16 each `setStage` / `isRunning` / `EnableLinkChain`, 8 `GetCurrentPackage`, 6
  `setMotionType` Papyrus methods not found; 13 `CYRBrumaMS11BonfireActivatorScript` not found; 9 "Negative Magicka
  found" for base `2ebe2` (offset -25); 219 "resolved context ... (reason=exception)".
- [ ] Still open from before: main menu -> character select not reopening; fox bounce (birth-position report +
  spawn-at-position, awaiting go); preset streamlining for the character creator; crash 20:44 (animation load).

## Added 2026-09-24 (01:30 UTC): NPC stability before launch - the split repair swaps, measured

Nat: wildlife "hop up and down in place", "float and phase under the map", "rubber band too sometimes". Launch blocker.

- [x] **Measured from the 52 split reports since 21 Sep: the `setPosition` repair in `hostedDriftService` swaps body and
  reference instead of joining them.** 7 of 7 repairs followed by another report within a minute moved the visible body
  to the old reference and the reference to where the body was (chicken `ff00000e` 21:48: ref A / body B, 10 s later
  ref B / body A; Master Conjurers, Deer, a rabbit the same). Players see the body jump between two spots: rubber band,
  and a hop when the gap is mostly vertical. 43 of 52 splits are thousands of units sideways, not a sink.
- [x] The server is not the cause: it re-placed spawned NPCs 9 times in the whole log (`checkMisplaced`).
- [x] Fork `afb754e0` (client, **not pushed, not built**): the repair method comes from the gamemode
  (`npcDriftConfig`: `setPosition` default, `none`, `moveTo`, `disableEnable`); 1 s after each repair the host reports
  `repairResult` joined / swapped / apart; hosted actors whose body jumps 384+ units in a poll or bobs 40+ up and down
  with the reference still are reported as `jump` / `hop`. Server `44eecab1` (**not pushed, not deployed**): admin
  `/driftrepair <mode>`, re-sent at every join; npcDrift lines log 900 chars.
- [ ] **Test session** (after the next client package): 10 min near Bruma wildlife per mode, `/driftrepair none`,
  `moveTo`, `disableEnable`, then read `repairResult` / `hop` / `jump` in the log. Ship the mode that joins; if none
  does, the stray body's origin (where the copy was first created, `SpawnProcess`: PlaceAtMe at the player, setPosition,
  enable, resurrect) is next.
- [ ] Not yet explained: why a body separates in the first place. The Conjurers' stray bodies sat together at one point,
  consistent with where the copy was created rather than where it belongs.

## Added 2026-09-24 (00:30 UTC): floating after a teleport, then the crash on jump (third time)

Argosh floated over the Alik'r terrain right after an admin-panel `teleportLoc` to Ben Erai, then crashed on jump
at `SkyrimSE.exe+079F43C`, the same null-character-controller crash as 20 and 21 September. Detail in
`HUB_SPAWN_BUG.md` item 3.

- [x] Crash guard: fork `00c29dee` hooks `JumpHandler::ProcessButton` and skips the jump when the player has no
  character controller. Pushed 2026-09-24 00:18 UTC (server restart 00:21 was clean), **not built**: it is in `SkyrimPlatformImpl.dll`, so it needs a CI
  flatrim (or Native) build and a client package on the PC.
- [ ] The floating itself: which step of the teleport (ragdoll removal, `moveRefrToPosition`) leaves the player
  without a controller is unmeasured. Once the guard ships, its `jump ignored` warning in the SkyrimPlatform log
  marks each occurrence.

## Added 2026-09-23 (late): the endless Dwemer dive - ON HOLD (Nat, 23:40 UTC)

A playtester's Discord to-do "Endless Dungeons" (elevators into chained random Dwemer/Falmer floors, harder and
better-looted with depth, boss floors). Nat asked how feasible it is, then put it on hold after the first step.

- [x] Floor pool: `tools\depths_build.py` (force-added, `tools\` is ignored) writes `depths.json` from the load order,
  ~10 s: 72 interior cells of the Dwemer ruins and Falmer hives, 60 usable (28 Dwemer, 32 Falmer), each with its load
  doors (where each leads) and landing spots (XTEL). Real cells, nothing duplicated; enemies and chests stay in
  `dungeons.json`. Server `bad2077e`, committed, **not pushed** (the server session's key is not on GitHub yet).
  Nothing reads `depths.json`.
- [ ] Not started: `depths.js` (a floor claims its cell like a lease, spawns depth-scaled enemies, exits glow on
  clear, the exit door moves the party to the next free cell); check that internal load doors reach the server's
  activate handler; boss-wave data for the Aetherium Forge (no placements of its own); the elevator.

## Added 2026-09-23 (evening, with Nat): jails, cell doors and sentences - LIVE (loaded 22:47:45 UTC, 27 jail zones)

Nat: jail/prison zones with no /unstuck; a cell door takes a prisoner for a set time, unlocks when it is served,
can be lockpicked, logging out does not count, and the prisoner is told when the time is served.

- [x] `server\jail.js` (new module, hot reload) + four hooks in `gamemode.js` (activate chain before rest, `/unstuck`,
  login notice, loader), config `"jail"`. Server `0d6e9bf7`. `tests\jail-harness.js` 47/47.
- [x] **Every jail and prison is a jail zone** (Nat: "alllllll jails and prisons, even skyrims"), server `aa1cfed6`:
  `jail-cells.json` from the new `ck-mcp\jails.py`, **25 cells**: interiors named Jail/Prison plus Bruma's and Kvatch's
  castle dungeons, Cidhna Mine and the cells under Dragonsreach; dungeon-lease interiors excluded. Measured and
  rejected as signals: a FACT's `JAIL` is the release marker outside (Bruma's is in the Great Hall), and jail-door
  models sit in banks, shops, sewers and bandit forts. Re-run the generator after a plugin change.
- [x] **`WindhelmPrison01` (`21594:Skyrim.esm`) is a jail** (Nat): `AbandonedPrisonLocation` is in
  `dungeons.exclude` (gamemode-config), `ck-mcp\jails.py` honours that list, 27 jails. The spare template cell
  `AbandonedPrisonDUPLICATE002` counts as a jail too now (named Prison); nothing in it changed.
- [x] **Jail zones**: interior cells. Admins add more in game with `/jail add`,
  `/jail remove`, `/jail list`, kept in `jails.json` (runtime, **gitignored**). No `/unstuck` inside a jail or anywhere
  while serving (admins exempt).
- [x] **Cell door** = a door in a jail zone that is not a load door (`doors.json`). A guard/official
  (`private.dboLawful`) or admin with a player within 8 m gets "Imprison <name>" -> 5/10/15/30/60/120 min; the door
  closes (`isOpen`), `private.dboCell` on the door, `private.dboSentence` on the prisoner. An empty cell door is an
  ordinary door. At an occupied door a guard can release early, add 10 min, relock a picked door, or open it.
- [x] **Time served** counts only online **and inside the jail** (5 s ticks, at most one tick credited across any
  gap, nothing persisted between logins). Served -> "Your time is served. The cell door is unlocked." `/sentence` shows
  what is left. An escape leaves the sentence standing and not counting.
- [x] **Lockpicking**: the client unlocks every engine lock and sends door activations to the server, so this is the
  `dungeons.js` model, a server roll: 15% without the Lockpicking skill, 35% at Novice +10% a tier, max 85%; a failure
  breaks a lockpick, 3 s between tries. A success credits the Lockpicking skill (`lock` event).
- [x] **Found on the way: `deploy-gameplay` would have wiped the live housing claims.** `housing.json` is tracked in
  git (it is `[]`), and the deploy copies every tracked `*.json` over the live one. `dev-server.sh` (root, not in git)
  now skips `housing.json` and `jails.json`. Refresh `server\tooling\` with `bash server/tooling/refresh.sh`.
- [x] Not built: bound hands are not freed by the jail (captureSystem has no hook the gamemode can call); the guard
  uncuffs through the bars with X, and the guard is reminded. No engine lock is shown on the door (the "Locked" text
  comes from the server's refusal message).
- [ ] Untested in game.

## Added 2026-09-23 (evening, with Nat): enemies float, sink, slide and hurt each other - measured; both fixes LIVE (server hot reload, client 0.3.28)

Nat: "they float still and phase under maps", "slide around without walking animations sometimes", Florain testing a
dungeon (Plundered Mine on Master, claimed 21:58:56 UTC, live while this was written).

- [x] **Measured, live log since 21 Sep**: the client's split detector (`hostedDriftService`, host only) fired 49 times:
  body **below** its reference 24, **above** 22, sideways 3; 13 needed a 2nd or 3rd repair. Not only wildlife: Master
  Conjurer x8, Bandit Erudite, Frost Troll, Ogre Groundling (21:57 today, in combat, sunk 275 straight down). The server's
  own checks (`checkMisplaced`) fired only 9 times, 5 of them a translation sinking with x/y frozen: the server sees the
  host's stream only, so most floating/sinking happens on a screen without the server noticing.
- [x] **Enemies hurt each other** (seen live): `ff000062`'s Chain Lightning (`Skyrim.esm:045F9D`) hit five of its own
  allies for 40 each, every cast, plus Florain. `gamemode.js` `dungeonAllies`: `onHitDamageAttempt` refuses a hit when
  both sides are non-player, non-companion actors in the same dungeon cell. Server `f497f995`, hot reload.
- [x] **A host kept driving actors it could not see.** `sendInputsService.sendMovement` sent every hosted actor with a
  local form, 3D loaded or not. Florain in the mine still hosted 18 outdoor animals and kept broadcasting their frozen
  last positions; the server counted that as a live host (takeover needs 2 s of silence, `ActionListener.cpp`), so
  anyone outside saw them frozen or gliding with no AI. Now a hosted actor that is not 3D loaded gets no movement sent,
  and the nearest player who can simulate it takes over. Fork `b9642b3`, client build.
- [x] Split reports now carry `hostedForMs`, `loadedForMs`, `fromPlayer` (fork `b183d2e`), to tell a body lost at
  load / host change from one lost mid-fight or at the edge of the loaded area. **The root cause of the split is still
  not proven**; this is the measurement for it.
- [x] Checked and ruled out: `setCollision(true)` (run on every echoed packet on the host) only clears
  `kCollisionsDisabled` on the reference (CommonLibSSE-NG `b93280e` `TESObjectREFR::SetCollision`), so it is not what
  pulls a body away. No periodic StartCombat/EvaluatePackage on enemies.
- [ ] Known, not changed: observers apply each packet at once with a 200 ms TranslateTo and no jitter buffer
  (`movementApply.ts`); the server echoes a host's own movement back to it (`SendToNeighbours` has no sender exclusion).
  Candidates for the sliding once the new reports come in; both are the fragile `formView`/`movementApply` path
  (HANDOFF 17, 19), so not touched blind.
- [ ] **Deploy**: server fix = push `server` + `deploy-gameplay` (no lease open, nobody mid-dungeon); client fixes need a
  client package. Client bundle built (`fork\build\dist\client`), NOT copied to the package staging folder.

## Added 2026-09-23 (evening, with Nat): the reading mini-game overhaul - LIVE (server 22:47:45 UTC, reading screen in client 0.3.28)

Nat: "overhaul the book reading mini game. make the time go slower".

- [x] **Slower candle**: 30 s + 6 s a word, so 66 s for six words where it was a flat 25 s (config `reading`:
  `baseSeconds`, `secondsPerWord`; the old `seconds` key is gone).
- [x] **A wrong reading costs time, not the round**: -8 s of candle (`wrongPenaltySeconds`), the words already right
  from the start lock in, the line shakes, the round goes on. The server holds the deadline and sends what is left
  (`endsInMs`) with each verdict. A lost round shows the sentence. No auto-submit on the last word; Enter reads it
  out, Backspace takes back the last unlocked word.
- [x] **Length by Scholar tier** (`wordsByTier`, Novice 5-7 to Master 9-12) and **36 Cyrodiil lines** for books from
  BSHeartland/BSAssets (every book the Bruma lock reaches); 7 more Skyrim lines so each band has some.
- [x] Two bugs fixed: the order was judged by card, so two cards of the same word ("the", "Legion") could not swap;
  a round nobody answered (disconnect mid-read) blocked every book for that character until a restart.
- [x] Server `f576bafc` (gamemode.js, gamemode-config.json, `tests\reading-harness.js` 16-17/17, it cuts the reading
  section out of gamemode.js and runs it); fork `5724cf1` (front). Front built and rendered in the browser pane with
  mock payloads (fresh round, wrong-reading verdict with locks, lost round); copied to `fork\build\client-files\root`,
  the dev install and `server\client-dist`.
- [ ] **Deploy order matters**: the new front must reach players with or before the gameplay change. An old front on
  the new server freezes after a wrong reading until "Give up" (it never un-sends). The new front on the old server
  is fine. So: client package with the front, then `deploy-gameplay`. Needs Nat's go and the owner's claims.
- [ ] Untested in game.

## Added 2026-09-23 (evening, with Nat): Well Rested, Well Fed and inn beds - LIVE (loaded 22:47:45 UTC)

Nat's spec: a bed you own or rent at an inn logs you out from a prompt; 30 minutes away gives Well Rested for the
next 2 real hours (faster health regen) and Well Fed (slower hunger, 2 hours); rent is paid at the bed, the inn's
owner gets it and 10% goes to the hold; a rented bed is locked to its renter.

- [x] `server\rest.js` (new module, hot reload), four hooks in `gamemode.js` (activate chain after prayer, login
  before `needsOnConnect`, the hunger tick's appetite, the loader). `server\beds.json` from the new `ck-mcp\beds.py`:
  200 bed FURN (editor id names a bed/bedroll, child beds excluded) and 21 inn cells. **Bruma: Jerall View (1 bed +
  3 in the basement) and the Restful Watchman (4)**; the Watchman's cell is `CYRBrumaTheRestfulWatchman`, so it is
  listed by hand. Server `5ced67ff`.
- [x] **The heal is server-side on purpose.** Hunger's regen penalties use Papyrus `SetActorValue`, which runs only on
  the client ("will not affect server calculations", PapyrusActor.cpp), and `CropRegeneration` caps regen at the
  race's base rate, so a *faster* client HealRateMult would be cut back to normal. Well Rested instead adds
  0.4% of max health per second through `percentages` every 5 s (races regenerate 0.5-1.0, DLE RACE DATA), paused
  60 s after PvP. Well Fed multiplies hunger by 0.5, stacking with Sanguine's boon.
- [x] Rent: 10 gold for 24 real hours (Nat named no price; vanilla's room is 10). Owner = whoever holds a housing
  claim whose door or partner stands in the inn's interior; no owner (every inn today: `housing.json` is `[]` live)
  means the hold treasury gets all 10. Sleeping is refused while restrained, dead or within 60 s of PvP.
  The prompt reuses the front's context menu through the relay (`dbo:restChoose`), so no client or front rebuild.
  `/rest` shows time left. All tunable under `"rest"` in gamemode-config (defaults in rest.js).
- [x] `tests\rest-harness.js` 40/40 (caught a real bug: an owned house's exterior door counted the whole worldspace as
  "your house"; only interior cells count now). prayer and labour harnesses still pass.
- [ ] **Deploy**: `backup-git.cmd`, push `server`, `bash dev-server.sh deploy-gameplay`, then patch notes. Needs Nat's
  go and the owner's `game-server` claim.
- [ ] Untested in game: the kick message, the context menu opened from a bed, the heal pulse's feel.

## Added 2026-09-23 (19:15 UTC, with Nat): beast form rework, dungeon loot, Ash Rune, Gray Fox; all pushed

Pushed on Nat's word with `online:0`: fork `main` (the Gray Fox libespm fix merged from `claude-nate/overrange-self-index`,
plus the client commits another session's push had already carried), server `b7de125e`..`3d1674e5` + `086b775b`.

- [x] **Beast spells never worked for anyone else**: the server strips an unlearned spell from the reported equipment and
  refuses its casts and hits (live log: Drain and Raise Dead stripped, 285 refused Night Cloak bites, 14 Poison Talons).
  `beastform.js ABILITIES` is now the one list: learned server-side on the change, unlearned on the revert, sent in
  `dboBeast`; the client equips from it and binds keys 1-9 (left-hand spell, then the Shout-key power), with a notice
  per pick and a legend on the change (`/forms`). Drain05Alt (65 a hit) replaces 09Alt (175, a whole health bar).
  Summon Wolves dropped (Papyrus places its wolves). Revert Form is key 9, last, so the default power never ends the form.
- [x] **Vampire Lord crashed other clients (likely)**: they rebuilt him from the Orc's head parts, tints and morphs on a
  headless body. The broadcast beast appearance is bare now. Unconfirmed without Grimgor's or Leerod's crash log.
- [x] **Menus stayed shut after a revert**: `Game.SetBeastForm` was set by nothing we run and cleared by nothing. Client
  sets and clears it with the race swap (fork `55b6874`).
- [x] **Vampire Lord looks the part**: Harkon's royal robes + the cape, given on the change, taken back on the revert,
  never saved as `lastWorn` (the revert re-dresses from it).
- [x] **Beast melee x2.5 (werewolf) / x3.5 (Vampire Lord)** on top of race unarmed 20 / 10 (`supernatural.beastMeleeMult`).
  First claw hit per form logs its source id: confirm it reads `0x1f4`.
- [x] **Vampire Lord's hands empty on the ground** so he fights with claws, re-armed in flight (vanilla GroundStart).
- [x] **Ash Rune paralyses**: its paralysis is on projectile -> explosion -> EITM; `gamemode.js onSpellHit` follows it and
  sends `dboParalyse` (30 s), the client's `ParalysisService` holds the player. Ash Shell stays on the C++ path; the
  17:38 test that "failed" was on Grimgor with god mode toggled seconds before.
- [x] **Dungeons**: no Ebony or Daedric loot anywhere a dungeon hands out (chests, bodies, corpse kit; 868 entries, the
  ingot included); Lakeside Retreat dropped from the dungeon list (`dungeons.exclude` for more).
- [x] **Gray Fox Cowl.esm** over-range self index mapped to the file itself (libespm `Combiner.cpp`).
- [ ] Untested in game, all of it. Watch for: `supernatural: <form> claw hit carries source`, `paralysis: ... held 30 s`,
  no more `OnHit ... cannot hit with spell 20126b7`, no `Record 0xffffffff` after Ancient Vision, boot time with the
  10k Hammerfell refs now resolvable.
- [ ] Not done: Vampire Lord bite/blood, level-based beast abilities (health, resist damage), howl as a real shout,
  server-spawned Summon Wolves, health floor on revert. Argonian tail/feet (`Smooth Argonians.esp` tail TXST over FVAR)
  waits on Nat's go for a DLE override. Launcher window mode: needs Leerod's answer (greyed out, or no effect?).
  Ebony Ingot: Nat to say whether it should stay lootable.

## Added 2026-09-23 (17:10 UTC, unattended run `dragonbreak-continue-build`): the Gray Fox fix exists, on a side branch

Nothing pushed, nothing deployed, no live or gitignored file changed. This ran alongside the 16:55 run below and
reached the same finding independently.

- [x] **The Combiner.cpp edit the 16:55 block saw appear and vanish was this run.** It is committed on the local
  branch **`claude-nate/overrange-self-index`** (fork `097a75e` + `102ee39`, 8 lines in `libespm/src/Combiner.cpp`
  pass 2: raw indices from own+1 through 0xFD map to the file's own slot in `toComb` only). It was kept off `main`
  on purpose so no push can take it by accident. `main`'s working tree is clean. **Not compiled** (no C++ build here).
  Nat, to ship it: `git merge claude-nate/overrange-self-index` on `main`, then `backup-git.cmd`, `/api/servers`
  `online:0`, push, and the updater's native build. After that, `Record 0xffffffff` after an Ancient Vision cast should
  stop, and the boot's world state gains the 10,321 Hammerfell REFRs + 311 ACHRs whose bases now resolve. Watch boot
  time and memory once. Side effect worth knowing: Skyrim.esm's one out-of-range header (`GMST 0x0123C00E`) now maps to
  `0x0023C00E` in by-type listings; it is a GMST and nothing reads it.
- [x] **Scope, the other fields as well**: the scan over every plugin in `plugins.server.txt` covered EFID, EITM,
  REFR/ACHR NAME, LVLO, CNTO, SPLO, PKID, COBJ CNAM, TPLT, RNAM, NPC SNAM/INAM, XLKR. **Gray Fox Cowl.esm is the only
  plugin with any**: 10,992 references (REFR NAME 10,321, ACHR NAME 311, NPC PKID 181, SNAM 84, CNTO 39, SPEL/ENCH EFID
  24, EITM 8, COBJ 7, LVLO 7, SPLO 6, INAM 4).
- [x] **Record-local id sweep of everything the C++ sweep left out: no live bug.** Client (`skymp5-client\src` never
  parses espm data), server `ts` systems (`formIdUtil.ts` helpers map through `toGlobalRecordId`; espmMagic,
  craftedExtras, mastery, npcSpawn, soulTrap, gathering, housing, bountyBoard all mapped), `server\*.js`
  (`globalIdAt`/`globalOf`/PFIG mapped, JSON ids read through `getIdFromDesc`), `ck-mcp\*.py` (every generator emits
  `hex:plugin` descs through `LoadOrder.canon`, never numeric global ids). Only blemishes: `ck-mcp\markerspells.py:60`
  canonicalises a DLE SPEL's perk against Skyrim.esm's master list (a print-only script), and two unreachable local-id
  fallbacks (`craftedExtrasSystem.ts:498`, `gamemode.js:1606`). Note for future code: `lookupEspmRecordById(...).record.id`
  is the raw file-local id; use the id you passed in.
- [x] **The record-local C++ fixes of 22 Sep are live** (`c7c2057`, `65207b1`): since the 19:08 restart the only
  `Record 0x...` line is Gray Fox's `0xffffffff`. **Still unverified**: no non-Skyrim.esm spell has hit anything since
  (spells hit: `10f7ed`, `2dd29`, `12fd0`, `1c789`, all Skyrim.esm), so "a modded spell deals damage" awaits a player.
- [x] Live log otherwise: the 85 `reason=exception` blocks are `isDead` read off a door ref after a door activation;
  every JS caller catches it, the C++ just logs before rethrowing. `Refr pointer expired` (28) follows corpse clean-up.
  Neither drops a player action. Supernatural, beast and faction code: loaded, 0 players have used any of it, so
  nothing to measure yet. No new client crash logs on this PC since 21 Sep; the jump crash is unchanged.
- [ ] Nat's open decisions: none answered in this file since the last run (deities, Tailor loom, Scholar books,
  skinning weight, dual casting, Hufsa / rob / Barons / charcoal).

## Added 2026-09-23 (16:55 UTC, scheduled run): Gray Fox Cowl.esm cannot be read server-side

Nothing edited in code, nothing deployed, nothing committed. **The brief's queue was already done, for the fourth
run running.** Checked on the live box, not from notes: `labour.js:328` emits `'mine'` (ore band) / `'chop'`;
`skills.json` pairs every divine with its `BSHeartland.esm:061B5x` wayshrine, cooldown 7, Daedric entries present;
`prayer.js:441` emits `'prayer'`; boot 04:21 reads `18 skills have marker spells` and `prayer on: 26 deities, 45 shrine
ids, 26 reachable`. **Nat: the `daily-code-review` brief still describes 20 Sep; rewrite or retire it.** So the run
measured instead.

- [x] **Log sweep since the 04:21 boot**: one 6-minute session, 3 `[error]` lines. Two are the known
  `reason=exception` noise; the third is `Record 0xffffffff doesn't exist`, same millisecond as a cast of
  `manny_GF_Spell_AncientVision`. The 22 Sep EFID fix did land (`0x3020119`, `0x1007982` stopped after 22 Sep 05:00),
  but `0xffffffff` has come after every Ancient Vision cast before and since (18 in the whole log).
- [x] **Cause, measured: Gray Fox Cowl.esm writes its own references one index too high.** It has 2 masters,
  its record headers use `0x02` (31,713 records), but its references to its own records use `0x03`.
  libespm's `IdMapping` (fork `libespm/src/Combiner.cpp`, pass 2) maps only index == master count to the file itself,
  so `0x03......` maps to `kInvalid` (`0xFFFFFFFF`) and `espm::GetData` throws. xEdit's FAQ gives the rule the
  engine follows: with 3 masters, "everything starting with 03 (or higher!) belongs to the file you are dumping"
  (tes5edit.github.io/docs/10-fo3edit-faq.html, 10.4.11). That is why the mod works in single player.
  **It is the Nexus original**: sha256 `f9fa7c18...`, identical to `E:\Vortex Mods\...\Gray Fox Cowl.esm`,
  the dev Data copy and `SHA256SUMS`. We did not break it.
- [x] **Scope, measured over all 104 plugins in `server\data`** (scratch `efid_scan.py`, EFID in SPEL/ENCH/ALCH/SCRL/INGR):
  only Gray Fox Cowl.esm has out-of-range effect ids, in 22 of its 29 magic records. Its spells, its enchantments (the
  Gray Cowl itself, Umbra, Eagle Eye, Springheel Jak's boots, Ocato) and its three standing stones all fail server-side.
  `DuneripperFireball` deals no damage, and `PraetorianRegen` never heals. **Wider than magic**: 10,321 REFRs and
  311 ACHRs in the plugin name their base object with `0x03`, so the Hammerfell worlds' placed objects are
  unresolvable server-side too. **Harmless today**: Hammerfell is outside the Bruma region lock. **It will break the
  day Hammerfell opens**, and it matters now only for anyone carrying a Gray Fox item into Bruma.
- [x] **The fix is C++ in libespm**: in `Combiner.cpp` pass 2, also map every raw index above the file's own to the
  file itself (`toComb` only; `toRaw` keeps mapping back to the own slot). **Another session was editing exactly this
  during the run**: at 16:46 UTC the file held that loop with a comment naming Gray Fox Cowl, and by 16:47:36 it was back
  to HEAD. I did not touch it. Nat: find out whose it is before anyone writes it again. It needs a push to fork `main`
  (native rebuild; `/api/servers` `online:0` first). After it ships, `Record 0xffffffff` after an Ancient Vision cast
  should stop. Also watch whether the 10k newly resolvable Hammerfell refs change anything at boot.

## Added 2026-09-23: tooling handover for Jake's dependency audit

- [x] `server\tooling\` (commit `01818f63`): snapshot of ck-mcp (45 py), 31 DBO xEdit scripts,
  `dev-server.sh` + `backup-git.cmd`, `CLIENT_BUILD.md`. Refresh with `bash server/tooling/refresh.sh` after
  editing the originals; it blocks IP addresses and credential-shaped text. `dev-server.sh` no longer names the host.
- [x] Six third-party plugins in `server\data` differ from the Nexus copies (recipes in 4, disabled refs in 2),
  same records and masters. `py ck-mcp\thirdparty_diff.py`; table in `tooling\README.md`.
- [x] **DragonBreak Nexus Patches.esp built** (xEdit `DBO_NexusPatches.pas`, 783 records + 40 winning CELL/WRLD,
  36 records skipped because a later plugin already wins; byte-verified; creation-kit validate ok, 0 dangling; local
  boot identical to 21 Sep). `server\data` + dev Data now hold the Nexus originals (edited copies in
  `server\_nexus-edited-backup-20260923\`), the patch is last in `plugins.server.txt`, local `server-settings.json`,
  fork `loadorder.txt`/`SHA256SUMS` (`c6f1248`, not pushed until the server is empty).
- [x] Production 18:40 UTC: live on CT115, healthy, patch in `/api/files/extra` (see `OPS_HANDOFF_2026-09-23_claude-nate.md`).
  The fork push also shipped 3 beast-form/paralysis commits from another session (`55b6874`, `b750abd`, `2541a7c`);
  their client half needs a client package before players see it.
- [x] Client package **0.3.22** published 19:16 UTC with that client half (only `skymp5-client.js` changed; fork
  `4354d87`, cherry-picked so the unpushed libespm commits `edd9bac`/`c4acc47` stayed local). Local `main` still has
  the pre-cherry-pick copy `1ddd1c1`: `git pull --rebase` drops it before the next push of `main`.
- [x] No patch note for the beast-form work: Nat wants players to discover it (2026-09-23).
- [x] **Centred banner, client 0.3.26** (live 22:07 UTC): `window.__dboBanner(text, seconds)` in the front
  (`utils/Banner.js`), a `dboBanner` packet in the client relay; `supernatural.js`/`beastform.js` send it for cooldowns and
  the permadeath notice. **Next package builder:** pull `main` first (`50f9cce`) and build the front and the client from
  it. The local `fork\build\client-files\root\Data\Platform\UI\build.js` is the reading-desk build **without** the banner.
  Shipping it as is would take the banner away again (the client script in that folder is already 0.3.27's).
- [x] **Client 0.3.27** (22:28 UTC): companion panel clears when the last summon goes; a summon leashes out of an
  unreachable attack order past 1500 units; summons not loaded near the owner are reported (`loaded:false`, `cell`,
  `ownerCell` in the `npcDrift ... companion:` lines).
- [ ] **Summon won't follow until you leave the dungeon** (Nat, 2026-09-23): not reproduced in today's logs (all four
  summons were outdoors). The panel's "FAR" means the summon was not loaded near the owner. Next time it happens, read
  the `companion:` lines for that player: `loaded:false` with `cell` differing from `ownerCell` means the server placed
  it in the wrong cell (`companionSystem.locationNear` uses the owner's `worldOrCellDesc` at the moment of the summon).
- [x] Rites log every round (`supernatural: rite <who> <rite> round n/5 hit|miss ...`), permadeath logs the player out
  with a notice, `/curse <#TAG> restore` + `revive.json` lift it (`10714e79`, live 21:54). Flo'Riahn #Z7EG restored.
- [ ] Watch the first rite rounds in the log: two real attempts scored 1/5 and 2/5. Tune `rite.latencyMs`/`slackMs` from
  the "struck N ms in, marker a/b/c" numbers, not by guess. The logout-after-permadeath is untested in game.
- [x] `gamemode.js` `/wipechars`: `/^d+$/` should be `/^\d+$/`, so a bare profile id never parses (name/#TAG works).
  The load-test sandbox's `data\` follows dev Data by hardlink but its own `loadOrder` (100 entries) lacks the patch.
- [x] Decide whether players get the server's six edited copies through the extra-files channel. **Not through
  extra files:** they land in the real `Data`, and under MO2 (launcher default) the Nexus copy in `mods\<mod>\`
  overrides them, so MO2 players would keep the old records. Options: a DragonBreak patch plugin appended last
  (recommended: no third-party redistribution, server goes back to Nexus originals), or the edited copies as their
  own archive in the install manifest (needs a manifest rebuild from `C:\DragonBreak`, and re-hosts Nexus files).
- [ ] Reply to Jake: draft `REPLY_TO_JAKE_2026-09-23.md` in the root, `[Nat: ...]` lines open.
- [x] Pushed to `server` 2026-09-23 (`ae8543ff..a3a567c1`, backup `backup/pre-push-20260923-115119`).

## Added 2026-09-23 (02:25 UTC): newbrumacityedits.esp merged into DragonBreak Online Edits.esp

- [x] Nat's `newbrumacityedits (1).esp` (106 records) overlaid onto DLE, the child winning: 18 new REFRs renumbered
  `DLE:12AE04..12AE15`, 87 BSHeartland overrides, 1 DLE override (`341164C7`), 15 deletions, 4 LAND, 2 PACK, 12 CELL
  (12 of the 106 replaced records DLE already had). The child's master order differed from DLE's in 41 places, so
  every form id was remapped by master name. Tool: `ck-mcp\merge_into_dle.py` (byte-level, no xEdit re-save).
  Proof: 247 changed form id fields each name the same record; every other DLE record byte-identical; creation-kit
  validate ok (29,326 -> 29,420 records, HEDR matches, 0 unresolvable), 0 dangling, 0 broken doors, deletions
  2,525 -> 2,540. DLE sha `3397aa4e`.
- [x] Installed in dev Data and `server\data`; dev server (`deploy-plugins`, restart 02:19, 0 errors), launcher sync,
  client package 0.3.17 (another session had just shipped its own 0.3.16; this is theirs plus the merged DLE), `_release\DragonBreak-plugins-20260922.zip` rebuilt. Backups:
  `ckmcp-backups\pre-brumacity-20260922-211913\`, `/opt/skymp-backups/plugins-20260923T021952Z`.
- [ ] Not looked at in game. The 15 deletions are real deletions (as authored), not disable-and-sink.
- [ ] Do not load `newbrumacityedits.esp` alongside DLE: its records now live inside DLE.

## Added 2026-09-23 (02:15 UTC): the character screen, the N hotkey, client package 0.3.16

Nat: "needs to look better". Rendered the real built bundle at 1080p in headless Chrome with a mock
widget payload rather than reading the SCSS, which is how the first two of these were found.

- [x] **The Play button was below the fold.** `__panel` scrolled as one piece with
  `max-height: 48vh`, so at seven slots the only way to start the game was to scroll down for it.
  The panel is a fixed frame now: heading and the Play row are `flex: 0 0 auto`, only `__slots`
  scrolls (`min-height: 0`), with a styled thumb instead of the white default scrollbar Nat's
  screenshot showed and a `mask-image` fade at the cut. Rows tightened; three slots and Play fit at 1080p.
- [x] **Every diamond sigil was rotated 45 degrees.** The diamond is made by rotating the box and
  counter-rotating `> *`, but the glyph is a bare text node so `> *` never matched it. Initials sat on
  their side and the `+` on an empty slot read as a stray `×`. The diamond is a `::before` now
  (`z-index: -1`) and the glyph is never rotated.
- [x] **Exit to main menu reopens character select.** It was already written and had never once fired:
  **zero `Reopening character select` lines in the whole server log.** The gate is `sawGameplay`, a plain
  field, and quitting to the main menu can reload the script context, resetting it to false for the rest
  of the session. It lives in `sp.storage` now and `gameLoad` sets it as well as the first `update`.
  `spawn.ts` also gained a log line for a menu request that arrives before authentication, which used to
  be dropped in silence. **`spawn.ts` is on claude-dragonbreak's list; the owner has been told.**
- [x] **Notice board N hotkey removed** (Nat: "we dont need N"). E has worked on every board since the
  zones fix, boot reads `28 of 28 placed boards known` and there are no `outside every zone` lines left.
  Gone from the client service, the launcher settings, its UI row and the key list. The server still
  accepts `bountyBoardOpenRequest` because `/board` reaches the same handler.
- [x] **Client package 0.3.16 published.** `populate` deliberately skipped (this box has no CI client
  build; the guide's second trap). Staged files copied over `build/client-files/root`, all 9 plugins
  sha-matched against `server\data` first, `npm run merge`, **verified readable by the launcher's own
  adm-zip** (267 entries, no harness leaked) before upload. Uploaded to a temp path with the backend
  still serving the old zip, swapped with the backend stopped, sha `8a46d09f...` identical end to end.
  `/api/version` reads 0.3.16 and `/api/files/zip` serves 182,856,198 bytes.
- [ ] **Untested in game.** The character screen was judged from a headless render, not a launch; and
  nobody has yet exited to the main menu on 0.3.16 to confirm the reopen fires. If it still does not,
  the new `spawn.ts` log line says whether the request is arriving at all.

## Added 2026-09-23 (01:30 UTC): voice settings, per-panel resize, Patreon slots, rerolls and reserved places

Live: fork `6e20da3`, server `patrons` deploy 01:24, client 0.3.15, launcher 2.1.28 (GitHub release, offered by
`/api/version`), boot clean (0 `[error]`).

- [x] **Voice, client side done.** Front mixes every voice through WebAudio into one `<audio>` (Chromium 108 has no
  `AudioContext.setSinkId`), so per-player gain can go past 100%; mic through its own gain, published as a processed
  track, push-to-talk / voice activation mute and unmute it; devices matched by **name** (ids are salted per origin);
  LiveKit's own mic stays as fallback. X menu: Voice louder / quieter / Mute voice (only while voice is on).
  Launcher Voice tab: devices, volumes, activation, meter with sensitivity line. Voice range key configurable.
- [ ] **Voice server: installed, switched off.** LiveKit 1.13.7 (`livekit.service`, checksum verified,
  `/etc/livekit.yaml` 0600) on 7880/tcp 7881/tcp 7882/udp; `voiceChat` in server-settings with `enabled: false`.
  **Needs Jake to forward those three ports** (request in `OPS_HANDOFF_2026-09-22_claude-nate.md`), then
  `enabled: true` and restart `skymp`. Nobody has heard a voice yet: untested end to end.
  **2026-09-23 17:10 UTC: Nat reported the ports forwarded, but nothing arrives.** From outside, 50.116.28.194:2222
  answers while 7880/7881 tcp are closed, and a tcpdump on CT115 during probes of all three ports (7882 udp included)
  caught 0 packets. LiveKit itself answers locally (`10.10.10.2:7880` HTTP 200; `node_ip: 50.116.28.194`). The forward
  stops at the router or the Proxmox host. Voice left `enabled: false`, no restart.
  **2026-09-24 00:05 UTC, re-checked: unchanged.** Inside CT115 every hop passes (livekit up, no container firewall,
  the `voiceChat` key/secret accepted by LiveKit's `/rtc/validate`); from outside 7880/7881 tcp are refused 0/3 and
  7882 udp never arrives, with 2222 at 3/3 as control. The path is Linode VPS -> WireGuard -> Proxmox host, both hops
  need the three ports; the host half is written (`claude-dragonbreak`, `/root/dragonbreak-work/voice-forwards/`) and
  waits on Jake. Re-test with `sudo bash ~/claude-nate-handover/voice-2026-09-23/voice-check.sh` (all PASS, then
  enable). Rotate the LiveKit key before enabling (printed into a session's output; not posted).
- [x] **Every panel resizable**: Ctrl + wheel over it, 50-250%, per panel type, multiplies the global size; a
  resized panel becomes its own zoomed screen (fixed + zoom + transform), so centred panels stay centred and corner
  pieces stay in corners. Checked in the browser pane on the dungeon gate (centred) and the HUD (corners).
  Launcher: Interface size (the client read `uiScale`, nothing wrote it) and "reset every panel". The HUD is one
  panel: vitals, hunger and the voice indicator size together.
- [x] **Every hotkey in the launcher**, including Interact (moves both property and player menus), Mask, Voice Range.
- [x] **Patreon tiers** (`server\patron-tiers.json`, tracked; role ids from Nat): slots = 1 + best tier's extra
  (Traveler 1 .. Owner 5) + Pre-Alpha's 1, capped at 10; a lapsed tier hides characters past its slots, never
  deletes them. **40 reserved places**: non-priority players are refused (with a reason) once only 40 of maxPlayers
  (100) are left; priority = Owner, GM, Grand Champion tiers and every `adminRoles` role. No waiting line (Nat's
  choice). **Rerolls**: `/reroll` (+ `confirm`) reopens RaceMenu in place, spent only when the creator closes;
  `/tokens`. Owner/GM unlimited, Grand Champion 1 per character, Pathfinder 2 and Adventurer 1 in total.
  Tests: `tests\patrons-harness.js` 15/15, slot rules 10/10 against the real file.
- [ ] **Nat: tell the owner that `spawn.ts` changed** (it is on claude-dragonbreak's feature/website-profiles list).
  The change is a hook: `slotsFor()`, a `max` argument to `slotMap()`, and `admit()` at the top of `spawnAllowed`.
- [ ] Untested in game: a reroll on a real character (race change leaves the old race's abilities until the
  C++ starting-spell fix ships), slot counts per tier at character select, the refusal message.
- [ ] Launcher needs players to install 2.1.28 once; older launchers do not write `voice`, `uiScale` or the new keys.

## Added 2026-09-23 (00:45 UTC): no attack ever cost stamina; Leerod's launch crash

- [x] **Power attacks cost stamina again** (Nat: "Duel Wield Power Attack doesn't use any stamina").
  It was never about dual wield. **Every** attack stamina cost lives in `AnimationSystem::
  InitAdditionalCallbacks` behind `if (hasSweetpie)`, and `hasSweetpie` is
  `worldState->HasEspmFile("SweetPie.esp")`, which this server has never loaded. The whole table was dead
  code: no attack, jump, bow draw, sprint or block has ever drained the bar here.
  The eight power attack callbacks now register unconditionally at the 30 points they already carried
  (`DamageActorValue` takes raw points and divides by max, so 30 of a 100 pool = three power attacks,
  close to vanilla). SweetPie's own economy, where every ordinary swing and jump costs stamina, stays
  behind the flag: that is its design, not vanilla's. fork main `3de5dbc`.
  Checked before shipping: the client relays every animation event except empty ones and `DrinkPotion_*`
  (`sendInputsService.ts`), so `attackPowerStartDualWield` does reach the callback, and the client's own
  `updateActorValuesAfterAnimation` only resyncs on landing and death, so nothing is charged twice.
- [ ] **Unverified in play:** whether the player's own engine *also* deducts stamina locally for a power
  attack, which would double the cost. Nat's report says it currently costs nothing at all, so the
  server charge should be the only one, but that needs one swing in game to confirm.
- [x] **Leerod's launch crash, second occurrence** (2026-09-22 17:16, 20 s in, before the main menu).
  `std::invalid_argument: "invalid stoull argument"` in `InstalledContent` on the `InitTESThread`.
  Launcher 2.1.26 emptied `<game>\Creations`, but the file the engine actually parses is
  **`%LOCALAPPDATA%\Skyrim Special Edition\ContentCatalog.txt`**, which the launcher never touched. His
  stack carries that path next to `CSV2_a12aacea-74b0-4260-9b63-dddc8f30ec79` and "Dawnfang & Duskfang",
  so the engine is calling `stoull` on a uuid. **Launcher 2.1.27** renames it to
  `ContentCatalog.txt.dbo-disabled` rather than deleting it, because it belongs to the player's own
  Skyrim and is rebuilt the next time they open the Creations menu. Evidence it is the right fix: a
  machine with no catalog at all (Nat's) launches fine.
- [ ] **2.1.27 is committed, not released.** It needs a launcher build, a GitHub release and
  `LATEST_VERSION` / `DOWNLOAD_URL` in `skymp5-backend/routes/version.js`. Until then Leerod is still on
  2.1.26 and will still crash; the manual workaround is to rename that file himself.

## Added 2026-09-22 (19:30 UTC): Heart and Hourglass UI; voice plan

- [x] **Palette A live in client 0.3.14** (fork `639d8ae`, `820831c`). Each widget wears its domain's hue via a
  `data-domain` wrapper in `constructor.js`: aedric gold (prayer, deity picker), lorkhan crimson (rite, bounty
  board, dungeon gate, death), dragonbreak violet (mastery, reading), bronze (labour, skinning, housing, pigeon,
  mail, trade), aqua for the rest. 142 teal literals in 19 widgets now follow `dbo-accent()` at runtime; `dbo-panel`
  has the fracture line and the Heart's glow. Checked by rendering the same panel in all five domains.
  Package check: only `UI/build.js` changed (plus the DLE that another session had already published to `extra/`,
  same sha `9ea0ae21`); adm-zip opens all 267 entries; public manifest and zip size match.
- [ ] **Launcher (commit `377e24a`) is not released**: the same palette on its sections, plus Skills (K), Bounty
  Board (N), Emote Wheel (B) and Nametags (F1) hotkeys. Needs a launcher build + GitHub release + `LATEST_VERSION`.
- [ ] Not moved to the theme: skillsMenu/testMenu/animList (upstream dev widgets), login (already grey/crimson).
  X (player interact) and the Alt voice-mode tap are still hard-coded in the client.

### Voice chat: what exists and what is left
Built and never switched on: `voiceSystem.ts` mints LiveKit tokens, `VoiceManager.js` (CEF) joins the room with
push-to-talk, whisper/talk/shout (Left Alt), distance falloff and lip sync. **The live server has no `voiceChat`
block and no LiveKit server runs anywhere.** The shipped `SkyrimPlatformImpl.dll` has `enable-media-stream` and
`use-fake-ui-for-media-stream`, so the game's browser can open a mic without a native build.
Nat chose **self-hosting on Jake's box**. Remaining, in order:
1. Jake: forward TCP 7881 and one UDP port (7882, LiveKit `rtc.udp_port`) to CT115, plus a TLS route for the
   signal port 7880 (or a public nginx `location` for it). This is `host-network`: claim through Nat.
2. Install `livekit-server` in CT115 as a systemd unit, `node_ip` = the public address; add
   `voiceChat { enabled, url, apiKey, apiSecret, room }` to server-settings (restart).
3. Launcher Voice tab: mic and speaker picker (store device **labels**, not ids: Chromium device ids are salted
   per origin, so an id from the launcher means nothing in CEF), mic volume, incoming volume, push-to-talk or
   voice activation plus sensitivity, test meter; written to `skymp5-client-settings.txt`.
4. Client/CEF: apply the label to `getUserMedia` / `setSinkId`, a GainNode for mic volume, master volume.
5. Per-player louder/quieter/mute on the existing X menu (a local preference, no new panel); a HUD mode marker.

## Added 2026-09-22 (19:10 UTC): shock magic stopped one-shotting, magicka 150, corpse looting

All live, with Nat present and approving. Rollbacks are in `OPS_HANDOFF_2026-09-21_claude-nate.md`.

- [x] **Shock spells were hitting for +200.** Every shock spell carries a hidden `PerkDisintegrate*`
  effect at magnitude 200. That number is the disintegrate perk's health threshold, not damage, but the
  effect is flagged Hostile + Detrimental with `primaryAV = Health`, which is exactly the test
  `GetBaseSpellDamage` used. The live log reconciles to the point: **Sparks 8+200=208, Lightning Bolt
  25+0.2+200=225, Chain Lightning 40+0.2+200=240, Lightning Storm 75+200=275**, against 150 health.
  Fire and frost were never wrong because their riders use Confidence and SpeedMult, not Health, which
  is why Flames logged 8, Firebolt 25 and Fireball 40 all along.
- [x] **The fix is "damage is what the spell card shows".** Of the effects on those spells every rider
  and perk gate carries `HideInUI` and no real damage effect does. **A blanket skip was wrong and the
  simulation caught it**: run over all 1,800 SPEL records in the load order it zeroed **60** spells whose
  only damage effect is hidden, including every `VampireSunDamage` stage, `DLC1VampireLordSunDamage`,
  Expel and Banish Daedra, the Miraak breath streams and the modded creature spit attacks. With a
  fallback to the whole total when nothing is visible, **exactly 11 spells change and none reaches zero**.
  fork main `c7c2057`, native build, restart 19:08:59, **0 `[error]` lines since**.
  Harness: `scratchpad simdamage.py`, worth keeping for the next damage change.
- [x] **Magicka 100 -> 150** (DLE Player record, one record changed of 29,326). Nat: "i just dont want
  people to feel like they have an unlimited pool". At 100 an adept spell was **uncastable**, not merely
  expensive: base costs from the records are Fireball 86 and Chain Lightning 124, which the engine's
  low-skill multiplier turns into roughly 133 and 192. 150 makes Fireball castable at ~89% of the bar and
  leaves Chain Lightning out of reach without a racial or an enchant. **Health 150 and stamina 100 are
  unchanged, so no NPC damage re-scaling.**
- [ ] **Raising base magicka dilutes racial variety**, it does not create it: an Altmer's +50 is +50% of
  a 100 pool, +33% of 150, +17% of 300. If races should feel distinct, widen the RACE deltas. Nat's note
  asked for both from one change; they pull opposite ways.
- [ ] **Magicka regeneration is unverified.** Pool size is the floor; regen is what decides whether the
  pool feels unlimited. Nobody has measured what a player actually gets back per second here.
- [x] **A dead player's body yields two random stacks and 15% of their coin** (Nat), keys never taken,
  body spent after one search, searchable again on the next death, remainder returns when they rise.
  server `0aa1fb2c`, hot reload.
- [x] **UI auto-scale** and **property key names** went out on the parallel session's push (`2c91c22`,
  `1b0fb3d`). Keys now read "Key to the Jerall View Inn"; old keys still open their door.
- [x] **Renaming a property invalidates its keys** under the new naming. Defensible, but the notice does
  not say so yet.
- [ ] **Dual wield power attack costs no stamina** (Nat). Still open: the investigation into where a
  stamina charge belongs had not returned when this shipped.
- [ ] Vanilla Lightning Bolt is **25**, not 40. 40 is Chain Lightning. An earlier note in this file had it
  wrong.

## Added 2026-09-22 (19:05 UTC): the admin panel, real location names, beast forms

Live: fork `e961201`, gameplay deploy 18:49 UTC, game server restart 18:52:36 UTC, **client package 0.3.13**
published 18:59 UTC. Nothing else on the box was touched. `online:0` at every push.

- [x] **Beast Form granted from the admin panel did not let anyone morph, and the log said nothing.**
  The grant itself was never the problem: `adminSystem.ts:606` sets `private.werewolfGrant` and AddSpell
  lands. `transform()` in `beastform.js` returned a bare `false` at four separate exits, and the
  `dboBeastRequest` relay logged nothing at all, so **a client that never relayed looked exactly like a
  server that refused**. Now `tryTransform()` returns the reason, which goes to the player and the log, and
  the relay logs every arrival with the actor and the spell id.
- [x] **The panel drives the change itself**, for werewolf and Vampire Lord both: Grant power / Transform now
  / Revert / Revoke (`__dboBeastAdmin`, action `beastForm`). Transform now goes straight to `beastform.js`
  and **does not depend on the power's cast reaching the server**, so an admin can always change shape.
  The tab shows, per character, whether each power is not granted, held, or worn right now (`__dboBeastHolds`).
- [ ] **Still unknown: whether the client's cast relay works at all.** The client *is* shipped with it (the
  published `skymp5-client.js` has `dboBeastRequest`) and the ids match (`beastform on: werewolf ... power
  92c48`), but no `beast request from user` line has ever appeared. Next time somebody casts the power,
  that line either appears (server-side problem, now with a reason attached) or it does not
  (`BeastFormService.onSpellCast` never fires for a power). One cast settles it.

- [x] **376 of 737 teleport points were named after map coordinates.** A localized plugin stores FULL as a
  uint32 string id, so `admin_catalog.py` fell back to the editor id or to the cell coordinates. New
  `ck-mcp\bsastrings.py` reads the `.STRINGS`/`.DLSTRINGS`/`.ILSTRINGS` tables, loose or out of a BSA
  (Skyrim.esm's are in `Skyrim - Interface.bsa`, 67,414 strings). **376 -> 2**, and those two markers have no
  name in the data. 718 rows, down from 737 only because door-derived duplicates of a now-named marker are
  dropped; every old name survives except "Hags End", which is "Hag's End". Item names improved with them
  ("cc BGSSSE025 Amber Battleaxe" -> "Amber Battleaxe", "Favor Amren Iron Sword" -> "Amren's Family Sword").
- [x] **The Teleport tab hid 341 Skyrim locations**: it stopped dead at 250 rows with "narrow the search".
  Lists now reveal a page at a time, teleport groups by worldspace under the region chips, search covers
  name + world + region, and a region present in the data but missing from the hardcoded list is no longer
  invisible.
- [x] Skills, Items and Powers share one target dropdown (you, then everyone online) instead of three
  free-text "name or #TAG" boxes; a target who logs out resets it. Delete character, IP ban and temp ban ask
  once. The panel imports `dbo-theme` instead of its own copy of the palette; filter rows wrap.
- [x] Fire on a vampire and silver on a werewolf apply again: `superBonusDamage()` read health as a bare
  identifier, `mp.get(tgt, percentages)`, and its own catch swallowed the ReferenceError.
  `server\tests\super-damage-harness.js` is 18 checks, 8 of which fail against the previous revision.

### The client package publish path is booby-trapped - read before publishing

The dev server **cannot** build a client package. `/opt/alduinak/skymp5-backend/sources/client` and
`/opt/alduinak/build/client-files/root` both hold the **18 September** client (no `dboBeastRequest`), and the
Linux build never produces `Platform/UI` at all ("Building client-deps is disabled on non-Windows setups").
**Running the documented `npm run populate && npm run merge` there would publish a four-day-old client to
every player.** `LAUNCHER_FILES_GUIDE.md` line 88 also says to copy the 9 plugins in after populate, and that
is still true: `populate-files.js` skips them on purpose and the published zip does contain all 9.

How 0.3.13 was published instead, which is how 0.3.11 must have been done:
1. The local `fork\build\client-files\root` was checked against the live `data/files-version.json`: **247
   files, byte-identical**, so a local merge could only change what was deliberately changed.
2. The new front build replaced `root\Data\Platform\UI\`; the manifest diff was **one file**,
   `Data/Platform/UI/build.js`, nothing added, nothing removed. (`dbo-watermark.png` sits loose in that
   folder and is not produced by webpack, so it is left alone.)
3. `CLIENT_VERSION` 0.3.12 -> **0.3.13**, `npm run merge` locally, opened with adm-zip as the launcher does
   (267 entries, all readable, 9 plugins present, the UI bundle carrying the new code).
4. Uploaded to `/tmp` while the backend was still serving, then backend stopped, backup taken
   (`/opt/skymp-backups/skymp-client.zip.bak-20260922T185910Z` and the matching
   `files-version.json.bak-`), files installed, version bumped, backend started: **downtime under 10 s**.
5. Verified through the public URL: `/api/version` reports clientVersion 0.3.13, `/api/files/version` has 247
   files with the new UI sha256 `cf4fa332...` matching the local file, and `/api/files/zip` is
   182,847,780 bytes, the exact size of the uploaded zip.
- [ ] **Worth fixing properly**: either teach the Linux build to produce the front, or move the package build
  into a script on this PC so it is not a sequence of remembered steps. Also note `files-version.json` was
  stamped **0.3.11** while `routes/version.js` already said 0.3.12, so the const had been bumped without a
  re-merge; the two agree again at 0.3.13.

### Open

- [ ] Nobody has pressed the new buttons in game. Grant, Transform now, Revert and Revoke are untested, as is
  the reworked Teleport tab. The server side is verified only by type-check and by the boot log being clean.
- [ ] `/api/manifest` and `/api/files-version` are 404 on this backend; the launcher uses `/api/files/version`
  and `/api/files/zip`. `LAUNCHER_FILES_GUIDE.md` names `/api/manifest`, which no longer exists.

## Added 2026-09-22 (18:45 UTC): UI scale, corpse looting, key names, log sweep

With Nat, from the live log plus his notes doc and the Discord reports. Nothing pushed or deployed yet.

- [x] **UI auto-scale** (Athny, 3840x2160; notes p3/p4 "maybe an auto-scale for GUI?"). The widgets are laid
  out in px against 1920x1080, so a 4K screen halved them. `main.scss` now puts `zoom: var(--dbo-ui-scale)`
  on `html` and shrinks the root's own box by the same factor, and all 66 raw `vw`/`vh` became
  `--dbo-vw`/`--dbo-vh` (measured: Chromium does **not** rescale viewport units under `zoom`, so `100vw`
  would have overflowed 2x). `utils/UiScale.js` picks `min(w/1920, h/1080)` clamped to 1..3, remembers a
  manual `window.dboSetUiScale(n)` in localStorage, and `uiScaleService.ts` carries a launcher `uiScale`
  override across. **Verified on the built bundle in a real browser**: a fixed 100x40 box measures
  100x40 / 150x60 / 200x80 at scale 1 / 1.5 / 2 while staying pinned to the true screen corner.
  Front + client rebuilt and copied to the dev install and `server\client-dist`.
- [x] **A dead player's body yields two things and a cut of the coin** (Nat). Two random stacks plus 15% of
  the purse, keys never taken, body marked searched so it cannot be farmed, flag cleared on each death.
  `gamemode.js`, commit `0aa1fb2c`, hot-reloadable.
- [x] **Key names** (Nat: "keys need proper names too, i think the numbers are ugly", screenshot
  `CATFIGHT GUILD KEY (8000EEB)`). `housingSystem.ts` now cuts **"Key to the Catfight Guild"**; a mark is
  added only when two properties share a name (", the second", ordered by ref id so it is stable) or the
  locks were re-cut (" (recut)"). Old keys still open their door, because the credential suffix is still
  accepted. An unnamed property keeps the old form. **Renaming a property now invalidates its keys** -
  that needs saying in the notice text, it is not said yet.
- [ ] **Key theft "extremely rare"** (Nat) is not done. Nothing pickpockets a key today, and corpse looting
  now excludes them, so the only route left is a live-robbery rule when one exists.
- [x] **Log sweep, 15,118 `[error]` lines.** Biggest live source was 2,074 x `Unable to change values
  without Actor attached`: the client sends `UpdateAnimVariables` twice a second from the moment it
  connects, and `OnUpdateAnimVariables` threw for every one until the character loaded. It is a pure relay
  with nothing to relay, so it now returns quietly (`ActionListener.cpp`).
- [x] `Expected record 0x10012c6 to be MGEF, but found REFR` (6x after BSK casts) is the record-local id
  bug from the 17:40 block, already fixed in the working tree. The 11,374 `TickSaveStorage` UTF-8 parse
  failures are historical: all of them fall in 19:07-19:26 on 21 Sep and none has recurred.
- [ ] **Gray Fox Cowl doors go nowhere.** `366c0/366c1/366c2:Gray Fox Cowl.esm` each logged
  `No destination found for this teleport door` while a player tried them in turn (04:21 on 22 Sep). Same
  class as the known orphan door destinations; it is quest-mod content, so it needs a plugin decision.
- [ ] Left from Nat's notes doc, not started: Khajiit customisation, the god picker being small and a
  floating menu, skinning too tedious, roadside bandit scenes, sprint changing voice distance on repeat,
  respawn at the temple door instead of by the shrine, pigeons reaching people who never introduced
  themselves, the mining minigame's space bar, vitals to ~300 each, and the launcher items (lag,
  "Discord Login Required" after login, "Read More", the Installing hover).
- [ ] **Rielle: the button that progresses the dungeon does nothing.** Not in the log; needs a look at
  whether it is one of the 209 puzzle blockers disabled in DLE or an unimplemented script.

## Added 2026-09-22 (18:00 UTC, unattended run): the crash on jump is a null character controller

Nothing pushed, nothing deployed, nobody was here to ask. One gitignored live file was changed, see the
warning at the end of this block. The run's brief queued three items; **two of them were already closed**
by work on 20-21 Sep, so the run spent itself on the third plus a review that found a second half of the
bug the 17:40 block above describes.

- [x] **Client crash on jump: measured, not theorised** (`HUB_SPAWN_BUG.md` item 3, rewritten in full).
  `42423` is **`JumpHandler::ProcessButton`** and `42338` is **`PlayerControls::ProcessEvent`** - read out of
  `SkyrimSE.exe`'s own vtables (`VTABLE_JumpHandler` AE id 208731 slot 4; `VTABLE_PlayerControls[0]` slot 1)
  after parsing `versionlib-1-6-1170-0.bin`, which resolves 42423 -> `0x79F380` and matches the crash log's
  `+0xBC` exactly. `+0x218` is **`bhkCharacterController::flags`**, so `rax = 0` is
  `Actor::GetCharController()` returning null. **It has happened twice**, 23 minutes apart, identical to the
  register: 2026-09-20 23:58:11 at 74 s uptime in `RiverwoodSleepingGiantInn` (where a character sits before
  the spawn move lands) and 2026-09-21 00:21:05 at Pale Pass (the playtest arrival spot itself). Both are our
  own teleport boundaries, and both of our teleport paths keep the player in control with no loading screen:
  the 30 x 1 s `moveRefrToPosition` spawn loop in `remoteServer.ts`, and
  `safeRemoveRagdollFromWorld` -> `Actor.ForceRemoveRagdollFromWorld()` -> `.then()` -> `once("update")`
  before every other move.
- [ ] **No fix shipped, on purpose.** The reliable one is a C++ hook on 42423 that returns early on a null
  controller (CI flatrim build). The cheap one is blocking movement input across a teleport, but whether that
  stops `ProcessButton` being reached is unread engine behaviour. Reproduce first: connect and hold space for
  the first 30 s. **Static disassembly is off the table** - the retail exe has a `.bind` Steam section and
  `.text` measures 7.997 bits of entropy, so it is encrypted on disk; this needs a live debugger.
- [x] The two readers are saved as `server\tools\crashlog\versionlib.py` and `vtable.py`, with the format and
  the caveats in their docstrings. **`server\tools\` is gitignored**, so they live on this PC only; move them
  if they should survive a clone.
- [x] **The record-local id bug also bites worn enchantments** (fork working tree, uncommitted, complements the
  17:40 block above and does not overlap it). `TES5DamageFormulaImpl::CalcArmorRatingComponent` looked an
  `ARMO`'s `EITM` up raw, and `CalcMagicEffects` did the same with every `ENCH` effect. Proof from the live log:
  a GM spawned `17ae5:Gray Fox Cowl.esm`, equipped it, and the server logged `Record 0x3020119 doesn't exist`
  in bursts of three from then on - `0x020119` is `manny_GF_Ench_GrayCowl`, the cowl's own enchantment, and
  `Gray Fox Cowl.esm` sits at global index `0x0A`. Both now map through the owning record's
  `LookupResult::ToGlobalId`, and `CalcOpponentArmorRating` wraps each worn item in a try/catch, **because
  `ScampServer::Tick` logs and abandons the whole packet on a throw**: one unreadable worn item made its wearer
  unkillable. That is a candidate cause for "invulnerable spawns" further down this file.
- [x] Same bug in `MpActor::RefusePotionOnCooldown` (`MpActor.cpp:607`): the ALCH effect ids it reads to undo a
  cooldown-refused drink were raw, so drinking a modded potion twice inside the cooldown threw and dropped the
  packet. Mapped through `lookupRes.ToGlobalId`. A full scan of every `espm::GetData<...>` call site in
  `skymp5-server/cpp` found no other unmapped field read; the rest take global ids (`entry.baseId`,
  `hitData.source`, `spellCastData.spell`).
- [ ] **All of it is C++ and none of it is committed.** `TES5DamageFormula.cpp` holds this run's hunks *and* the
  17:40 run's spell-path hunk, so committing it would commit another session's work; left in the working tree
  deliberately. Nat: `backup-git.cmd`, check `/api/servers` shows `"online":0`, then one push of fork `main`
  and let the updater's native build restart the server.
- [x] **Brief item "RaceMenu shows the stock menu" was already solved on 2026-09-21** and the leading theory in
  `HUB_SPAWN_BUG.md` was wrong: not MO2's `archives.txt`, not timing - `SkyUI_SE.bsa` ships its own
  `racesex_menu.swf` and the later plugin's archive wins (fork `85673a0`). Doc corrected.
- [x] **Brief item "Orc with Nord frost resistance" was already solved on 2026-09-20 21:00** (RACE spells off
  client-side in `RaceSpellsService`, Player `NPC_` spells off in DLE). `DBO_PlayerRecord.pas` does not need the
  spell-element path after all. Doc corrected.
- [x] **`server\data\DragonBreak Online Edits.esp` refreshed** - it had been stuck on `a13379...` since 11:23 on
  21 Sep because a local server held it open, while the dev `Data\` copy, `/opt/skyrim-data`, the launcher's
  extra-files folder and `fork\deploy\skyrim-data\SHA256SUMS` all carry `315769e4...`. **`deploy-plugins`
  defaults to `server\data` as its source**, so the next run of it without `DBO_PLUGIN_SRC` would have pushed
  the old file to the live server and to every launcher, silently undoing the Orcish Blood description fix and
  the 150/100/100 Player vitals. All nine deployed plugins now match the dev `Data\` copy byte for byte.
  **This file is gitignored and live - Nat, no commit carries it.** Old copy kept beside it as
  `.bak-20260922-124418`. Note `server\tools\loadtest\sandbox\data\` was hard-linked to it and keeps the old
  version; left alone as bot-testing scope.

## Added 2026-09-22 (17:40 UTC, unattended run): no modded spell has ever dealt damage

Nothing was pushed and nothing was deployed: Nat was asleep, players had been online 30 minutes earlier, and
`game-server` was unclaimed. Everything below is committed locally and waits on Nat for the push and the deploy.

**The run's queue was already finished before it started.** The brief still described the state of 2026-09-20 03:20
and asked for the `'mine'`/`'chop'` emit, the deity shrine lists, the shrine mastery event and the five Unarmed
marker spells. All four shipped on 20-21 Sep; the live boot line reads `18 skills have marker spells` and
`prayer on: 26 deities, 45 shrine ids, 26 reachable under the region lock ... conversion every 7 day(s)`. The
run went to a review of the code that shipped on 21-22 Sep and has never been played.

- [x] **Every spell from a plugin other than Skyrim.esm is silently dropped, hit and all.**
  `TES5SpellDamageFormulaImpl::GetBaseSpellDamage` looked a magic effect up by the raw `EFID` value, which is a
  **record-local** id. Upstream's own `GetRestorativeEffects` maps the same field with `spellLookup.ToGlobalId()`;
  this one did not. For a spell in BSAssets.esm (load index 0x07, one master) the self-index 0x01 is never
  remapped, so `BSKGreaterToxicMissile`'s effect `BSAssets.esm:007982` is looked up as `0x01007982`, `espm::GetData`
  throws, and nothing catches it between there and the packet handler: no damage, no ward check, no
  `onHitDamageAttempt`/`onHitDamage`, so no mastery credit and no supernatural infection either.
  **Measured, not argued**: of the 23 distinct spells that have ever produced an `OnSpellHit ... damage` line in
  `/var/log/skymp-server.log`, **every single one is a Skyrim.esm id** (index 0x00, where the mapping is the
  identity by luck). The modded casts appear only as `[console] [error] Record 0x1007982 doesn't exist`.
- [x] The same class of bug in `EatItemEvent::OnFireSuccess`: ALCH effects go straight from `Effects::GetData`
  (which stores the raw `EFID` bytes) into `ApplyMagicEffects`, so **a potion or food from any non-vanilla plugin
  applies no effect server-side**. Both fixes are in the fork working tree, four lines each, mirroring code that
  already works in `ActionListener.cpp`.
- [ ] **Neither is built, and neither is committed.** A parallel session is editing `TES5DamageFormula.cpp` at the
  same time (`CalcMagicEffects`/`CalcArmorRatingComponent`, the same record-local id bug on ARMO enchantments, plus
  a try/catch so an unreadable worn item cannot abandon a hit). Their work and these two hunks sit together,
  uncommitted, and do not overlap. **Nat: this is C++, so it needs the push to fork `main` and the updater's
  native build.** Check `/api/servers` shows `"online":0` first.
- This corrects the 2026-09-22 log sweep block below, which recorded finding (a) as "the caller is still unlocated
  (32/day, cosmetic)". The caller is located and it is not cosmetic.

- [x] **The vampire fire weakness and the werewolf silver weakness never applied** (gameplay layer, hot reload).
  `gamemode.js superBonusDamage()` read and wrote health as a bare identifier, `mp.get(tgt, percentages)` instead
  of `mp.get(tgt, 'percentages')`. That is a ReferenceError, and the function's own `catch` swallowed it and
  returned 0, so the multiplier `__dboSuperDamageMult` computes was thrown away and **not one line was ever
  logged**. Nobody had been cursed yet (0 `SUPERNATURAL`/`BLOODCROWN` audit lines in the whole log), so no play
  session could have caught it.
  New `server\tests\super-damage-harness.js` lifts the real function out of `gamemode.js` and runs it against a
  stub `mp`: 18 checks pass on the fix and 8 of them fail on `git show HEAD:gamemode.js`, including
  "x1.5 leaves health at: got 0.9, want 0.85" and "reports extra damage: got 0, want 10".
- [x] **Anyone could take a beast form they were never granted.** `__dboBeastRequest` (the client's
  `dboBeastRequest` relay, added yesterday) went straight to `__dboBeastCast`, which calls `transform()` with no
  `holdsPower` check, while `/beast` checks it. `__dboBeastAllow` only gates the daily limit for an actor who is
  *already* a werewolf, so a request from anyone else was allowed. The check now lives in `__dboBeastCast`, so
  both the cast hook and the relay are covered; `/beastform ... now` and the full-moon change pass `forced` and
  are unaffected.
- [x] A refused transform no longer spends one of the day's four changes: `transform()` reads the appearance
  before `__dboBeastAllow`, which is what records the use.

### Read in review, left alone, for whoever plays it first

- A vampire or a werewolf in beast form who activates a humanoid corpse less than 10 minutes old **feeds instead
  of looting** (`__dboSuperActivate` sits above `__dboCorpseLoot` and `__dboSkin` in the activate chain) and the
  loot window never opens. The second press loots, because `fedOn` has the corpse by then. Left as it is: it
  reads like a deliberate order, but it will surprise.
- `globalThis.__dboSuperForfeitIfDead` is defined in `supernatural.js` and called from nowhere.
- `supernatural.js` dereferences `stateOf()` without a guard in `becomeVampire`, `becomeWerewolf`, `feed`,
  `/rite` and `/curse`; `stateOf` returns null when `mp.get` throws. Only reachable for an actor that has just
  gone, and every path is already inside a caught handler, so it is noise rather than a bug.
- `guilds.js __dboGuildPackChallenge` demotes the old pack leader before `setMember` can fail, which on the error
  branch would leave the pack with nobody leading it.
- The 11,374 `TickSaveStorage ... ill-formed UTF-8 byte ... re-saving` lines are all from the known 19:07-19:26
  incident on 21 Sep and none since. Worth knowing why it matters if it comes back: one bad string in one change
  form failed the whole upsert, the retry ran ten times a second for nineteen minutes, and only the restart
  cleared it. While it runs, nothing is being saved for anybody.
- Today's error budget is 2,986 lines, 2,074 of them `Unable to change values without Actor attached`. That is
  `ActionListener::OnUpdateAnimVariables` throwing for a client with no actor attached yet (login, or just after
  a disconnect). Harmless, C++, and the message is from the neighbouring `OnSpellCast` and describes the wrong thing.

## Added 2026-09-22 (05:00): enemy damage is physical-only, property is granted

- [x] **Nat, in play: "npc magic damage is good".** `damageMultFormulaSettings.multiplier` scales NPC spells as well as
  hits (both `DamageMultFormula::CalculateDamage` overloads), so the x2 from 04:45 had doubled NPC magic too. New
  optional `magicMultiplier` key (C++, defaults to `multiplier` when absent); live settings are
  `{ multiplier: 2, magicMultiplier: 1 }`. Read at boot only: magic stays x2 until the updater's build restarts the server.
- [x] **"anyone is able to claim any buildings."** housingSystem let any player claim any unowned door or container. Now a
  claim needs a manager (Jarl/Steward/Chieftain/Bane/Count of the zone, or any admin tier); they Claim, then Grant ownership
  to the player from the same widget. Everyone else sees "Unowned. Property is granted by the hold's Jarl, Steward or
  Chieftain." `housingOpenClaims: true` in server-settings restores open claims. Existing records untouched. Front rebuilt.
- [ ] Property claimed before this change stays with whoever grabbed it; a manager can Revoke it from the door.
- [x] Nat 05:10: "only barons/stewards and jarls/count should be able to assign containers and houses in their respective area."
  MANAGER_RANKS = jarl, baron, steward, count (+ chieftain, bane for sovereign strongholds), any admin tier. No zone has a
  `baron` office yet (Bruma's Count stands in, gamemode.js APPOINT_RULES); "baron" added to MANAGER_RANKS for when one exists.


## Added 2026-09-22 (night): Discord feedback of 21 Sep 23:00

- [x] **Enemy damage buffed** (Nat, Boris): `damageMultFormulaSettings.multiplier` 1 -> **2** in the live `server-settings.json` (NPC hits on players only; restart 04:2x UTC). Not tracked in git.
- [x] **Prayer "Rise" did nothing** (Boris): after the verdict the round is gone, so the cancel event was ignored and the window stayed; Rise now closes it.
- [ ] **Beast forms**: engine-native change archetypes (36/46) start the client's own transformation and lock the controls; client 0.3.11 dispels the effect on cast and asks the server. First real test of the server race swap still pending.
- [ ] "Visage of Mizund does not shoot steam" (Boris): a modded item's projectile/effect not showing; unverified, needs the item id and a second observer (is it the caster or others who see nothing?).
- [ ] Dual casting (Boris, Johann, Athny): today double flames does not do double damage server-side. Suggestion from the players: dual cast = 50% magicka cost instead of double damage, or a mage specialization toggle. Design call for Nat.
- [ ] Trade request popup screenshot (Athny, 23:15): nothing broken reported, keep an eye on it.

## Added 2026-09-22 (late): vitals, beast forms, arrows, log sweep

- [x] **Player vitals**: DLE Player record (NPC_ 000007) ACBS offsets 50/50/50 -> 150/100/100 (`scratchpad player_vitals.py`, one subrecord changed, verified against the backup over all 29,326 records). Races keep their deltas in the RACE records. Damage stays server-authoritative.
- [x] **Beast forms**: the hand-cast relay never carries powers, so casts of Beast Form / Vampire Lord never reached the server (9 grants, 0 casts). Now: the client relays a beast power cast as `dboBeastRequest`, and `/beast [werewolf|vampirelord|revert]` works for anyone granted (`private.werewolfGrant` / `vampireLordGrant`, set by the admin panel and /beastform), pack werewolves and the Blood Crown holder.
- [x] **Arrows**: applyInventory re-equips the player's ammo after each inventory apply (the quiver stack add/remove unequipped it).
- [x] **Announcements**: `bash dev-server.sh announce '<text>'` (announce.json watched every 5 s) and admin `/announce`; on screen and in chat.
- [x] worldstats no longer probes every dynamic form at boot (ids persist in server-stats.json; one-time fallback seed).
- [ ] **Log sweep findings (2026-09-22)**: (a) "Record 0x3020119 / 0x1007982 doesn't exist" via console.error after BSKGreaterToxicMissile / manny_GF_Spell_AncientVision casts: raw plugin-local ids; espmMagic, masterySystem and the gamemode all map through toGlobalRecordId and catch, so the caller is still unlocated (32/day, cosmetic). **Located 2026-09-22 17:40 and it is not cosmetic: `TES5SpellDamageFormulaImpl::GetBaseSpellDamage` in the C++, and it costs the whole hit. See the top block.** (b) 12 x HTTP 403 logins at 01:42 UTC from one session: a non-whitelisted account. (c) Known noise: hosting handoffs, Bruma scripts calling unimplemented Papyrus, "too distant" hits.

## Added 2026-09-22: Blood and Moonlight (world clock, vampires, werewolves, raids)

Design pages: Factions https://claude.ai/artifact/WrQiufHXqnBbL7irYWbkYq , Supernatural https://claude.ai/artifact/S7e61j2TcVREcS1NUrn6dp (research in the 2026-09-22 session: engine, feasibility, UESP lore).

- [x] `server\worldclock.js`: the server owns GameDaysPassed (epoch + timescale 6 = a game day per 4 real hours), calendar, moon phase (8 phases x 3 days, phase 0 full) and per-zone weather kinds; `dboClock` every 20 s and on login; client `timeService.ts` writes the globals and forces the region's weather of that kind outdoors. `/time`, admin `/settime`, `/timescale`, `/setweather`. State `worldclock.json`.
- [x] `server\supernatural.js`: infection on hits (vampire 10%, werewolf bite 5%), 3 game days incubation, cure by Cure Disease potion (eat hook) or a Divine prayer; fever opens the **rite** widget (timed strike bar, 5 rounds); `/rite` at Molag Bal (Embrace, pure-blood) / Hircine (Great Hunt, blessed) with a 33% perma-death on failure (`private.permaDead`), Arkay/Stendarr cure for a filled black soul gem. Vampire stages 1-4 (sun damage outdoors by day via percentages, fire weakness after the hit, vampire race variant look), feeding on restrained players (X menu) or fresh humanoid corpses (activate). Blood Crown in `supernatural.json`: one Vampire Lord power holder, passes to a vampire killer. Werewolf: Beast Form 4 changes per real day, full-moon forced changes (1 in 10 per game hour, night, outdoors, unblessed), silver weakness, +30 s per corpse, pack leader pale coat (`dboPale`, GhostWolfSpiritFXShader), pack challenge. Admin `/curse`.
- [x] `server\beastform.js` asks `__dboBeastAllow` first, witnesses within 3000 units, `__dboBeastChanged` hook.
- [x] Factions: 50 (vampire clans + Hircine's Pack of the Jerall with `requires`), guard offices and titles, Jarl/Count lead the hold factions; rulers appoint Guard Captain + 20 Guards (Bruma: `captain`), chieftains a Stronghold Guard Commander + 20 Stronghold Guards.
- [x] Parties: 6, raids 7-12 at `raidXpMult` 0.5 (`private.partyXpMult`, read by masterySystem), X-menu Remove from Party.
- [x] Live: client 0.3.8, fork `bff017c`, server `9bd8d8af`+.
- [ ] **Untested in game**: every transform path (setRace on the own client, remote rebuild, re-dress on revert), the rite timing (latency 120 ms + slack 160 ms may need tuning), weather forcing per region (BSHeartland uses DefaultClimate: only clear/cloudy exist there, so rain/snow fall back to cloudy), sun damage rate (0.6%/10 s per stage), forced change at full moon. Needs a two-player session.
- [ ] Vampire Lord flight/levitation and the feeding animation are not synced (design note); the form is a race swap plus claws.
- [ ] Website: the Guides section + invite fix wait on the owner (`claude-nate-handover/website-guides`). The Supernatural artifact is still private: Nat must share it ("Anyone with the link") before the website links to it.

## Added 2026-09-21 (late): the faction system

Nat's spec is in the memory note `nat-design-decisions-2026-09-21`. Faction leaders are separate from hold officials.

- [x] `server\guild-defs.json` (tracked): 46 factions. 9 holds, the county of Bruma, 6 orc clans, 12 guilds (the College of Winterhold is independent of its hold), and 3 secret guilds. Plus 15 secret Daedric cults, one per Prince except Malacath. Each faction has lore titles over the shared roles leader/officer/sergeant/mage/blacksmith/tailor/member. Caps: 1 leader, 3 blacksmiths, 3 tailors.
- [x] `server\guilds.js`: membership in `guilds.json` (runtime, gitignored, keyed by actor id). Invites last 2 minutes. Leaders set ranks, and naming a new leader steps the old one down. Officers kick lower ranks. Secret rosters are hidden from outsiders. Admins see every faction and name the first leader with `/faction leader <player> <id>`.
- [x] F3 opens the menu (front widget `faction`, id 37; the prayer picker already had 36). X on a player lists "Invite to <faction>".
- [x] Offices: rulers appoint 2 Court Mages, and chieftains a Shaman and a Wise-Woman. Those offices carry no guard powers.
- [x] Live: client 0.3.6, gameplay deploy 23:37 UTC.
- [ ] **Launcher 2.1.19 release**: the build carries the F3 default, and the old hotkey defaults no longer clash (hide UI was F1, the same key as nametags). Players who saved launcher settings keep G for factions until then. Needs Nat to approve a gh device code; then bump `LATEST_VERSION`/`DOWNLOAD_URL` in `routes/version.js`.
- [ ] Name the first leaders in game (`/faction leader`). Nobody leads anything yet.
- [ ] Office mechanics are still only proposals. Court Mage: advises and acts for the ruler, posts decrees and bounties, draws a stipend. Shaman: Malacath rites that bless nearby clan members. Wise-Woman: healer and brewer. Faction Mage: enchants faction gear and supplies potions.
- [ ] Faction gear crafting (marker spell per faction and role, and `HasSpell` recipes) waits until Nat reopens crafting.
- [ ] To watch: 101 "resolved context ... reason=exception" lines at 23:19 UTC, a `profileId` read on the vanished actor 0xff000004 (before this deploy).

## Added 2026-09-21 (13:00 CDT): the dev server now runs DragonBreak

The dev server (`ssh dragonbreak-dev`, the `skymp` LXC on Jake's host, also what `dragonbreakonline.com`
serves the launcher from) was running a different world: Jake's 96-plugin order without any DragonBreak
plugin, and the fork's 2 KB placeholder gamemode. Nat chose the full switch. How to work with the box is
in the root `CLAUDE.md`, section "The development server".

- [x] **GitHub first**: `backup-git.cmd`, then `fork` `14c0cd9` (`deploy/skyrim-data` `loadorder.txt` +
  `SHA256SUMS` = our 105 plugins, the source of truth Jake's tooling reads) and this commit.
- [x] **Switched 17:44 UTC**: 105 plugins verified by SHA-256 in `/opt/skyrim-data`; the gameplay layer beside
  the build with `gamemodePath: dbo-gamemode.js` (the auto-updater's build overwrites `gamemode.js` with the
  placeholder); settings merged (loadOrder, startPoints, blockedSpells, characterSelect, movementValidation...,
  Discord `master`/auth keys untouched); **fresh world**. Backup `/opt/skymp-backups/pre-dragonbreak-20260921T174415Z`,
  old plugins `/opt/skyrim-data.bak-20260921T174415Z`. Record: `fork\deploy\skyrim-data\switch-ct-to-dragonbreak.sh`.
- [x] Boot: skills 113/129 resolved, 18 skills with marker spells, hub found, Bruma lock on, prayer 26/26
  reachable, **1 `[error]`** (`discordAuth is missing, skipping Discord ban system` - pre-existing).
  The 17:49 auto-update left it alone; a `deploy-gameplay` hot reload works.
- [x] `bash dev-server.sh deploy-gameplay` (new): tracked `server\*.js/json` -> live, one reload, keeps the
  server's `admins`.

### Later the same day: the launcher delivers DragonBreak's own files

- [x] **Client package 0.3.3 published** (18:08 UTC) with the current 9 plugins; adm-zip opened all 246
  files with matching hashes, and a download through `dragonbreakonline.com` was byte-identical. Launchers
  now find the plugins the 105-plugin load order lists, so players can start the game again.
- [x] **Per-file sync built** (fork `4531516`, `8aaecfe`, `9ad72e3`): `GET /api/files/extra` lists 148 files
  (9 plugins, 4 BSAs, 135 loose assets, 930.5 MB) with sha256; the launcher's `syncExtraFiles` downloads
  only what differs. Files live under `/api/files/extra/<path>` because **the public nginx forwards only
  `/api` paths** (a first test got its 404 on `/files/extra`). A harness ran the real function against the
  live server: 148/148 downloaded and verified in 193 s, recheck 0.2 s, repairs exactly the damaged files.
- [x] `bash dev-server.sh deploy-plugins` (new): the 9 plugins -> game server (restart only if changed) +
  sync folder + `SHA256SUMS`. No-op run verified.
- [x] **Launcher 2.1.17 RELEASED** 18:5x UTC: GitHub `launcher-v2.1.17` (asset sha256 `230cafdc...`, identical to the build), `routes/version.js` offers it (`6d7e70a`); `dragonbreakonline.com/api/version` confirms. Nat tested it first. Was: built, not released (`fork\build\launcher\DragonBreakLauncher.exe`, contents
  checked). Nat: install it, press Play once, then publish GitHub release `launcher-v2.1.17` with that exe
  and bump `LATEST_VERSION` + `DOWNLOAD_URL` in `skymp5-backend/routes/version.js`. Until then players still
  need `_release\DragonBreak-assets-*.zip` by hand for the BSAs and meshes.

- [x] **Launcher said OFFLINE for everyone** (every version): the public nginx sends `/api/status` to
  `skymp-api` (`/status/public`), which answered `{service, port_bound}`, while the launcher shows online only
  on `status: "online"`. `/usr/local/bin/skymp-api.py` `live()` now adds `status` (backup in
  `/opt/skymp-backups/skymp-api.py.*`). **Jake: that script is outside git** - keep the field if you replace it.

- [x] **19:21-19:48 UTC, from play reports**: RaceMenu loads after SkyUI (SkyUI_SE.bsa shipped its own `racesex_menu.swf`, fork `85673a0`, SurWR blocked spell `0x18315AA6` -> `0x16315AA6`); `discordAuth` added on the dev server so Discord roles reach the game (admin panel); Orcish Blood description fixed in DLE (`9c5d676c`, fork `a5dc516`, one record changed, an xEdit re-save that altered 93 records was rejected). All in `OPS_HANDOFF_2026-09-21_claude-nate.md`.
- [ ] **`serverdataDragonBreak Online Edits.esp` is still the old `a13379...`**: the local game server started at 11:23 by another session holds it open. Copy the dev Data file over once that server is stopped. The dev server, the launcher sync and `_release` already have `9c5d676c`.
- [ ] `DBO_OrcAbility.pas` header claims the Breton copy needs no text change; it did (SPEL DESC). Fixed in data; the script comment is now wrong if it is ever rerun.

- [x] **21:02 UTC, from the Pale Pass wolf report**: the spawn watcher on the Linux server died after the first rename-over save, so dungeon leases and wildlife changes stopped reaching the spawner (fork `c07e1b8`, verified 3 of 3 saves reload). 33 Cyrodiil wildlife placements on cells with no navmesh are skipped (`de35f801`); BSHeartland navmeshes only 524 of 2381 Cyrodiil cells, the rest is Beyond Skyrim work in progress. The Pale Pass wolves themselves stand on navmeshed cells; the server spawned exactly 1 per zone, so the extra and sunken wolves a second player saw are client-side copies of the known spawn desync (NPC_REBUILD.md phase 1), not extra spawns.
- [ ] **Measure the duplicate wolves with two players**: npcDrift on the wolf ids while the second player walks in; compare what each client shows against the one server actor.

### 22:55 UTC playtest batch (Nat report of 2026-09-21 evening) - live, not yet played

- [x] Sparks/Flames: concentration spells sent ~10 hits/s each at the full per-second magnitude (80 dps vs vanilla 8); now 1 accepted hit/s. NPC hits on players were x2 by default; `damageMultFormulaSettings.multiplier` 1.
- [x] Body gold 40% at 0.3x the difficulty range; dungeon food replaced by salt, produce filtered from ingredient pools.
- [x] Dungeon time-out walks everyone inside to the entrance (was members only) and converts XTEL radians to degrees.
- [x] Dungeon scaling: enemy level band from the highest character level at the door (vanillaLevel rule), count x party size (0.7 solo..1.8 six) x difficulty.
- [x] Jarls/Counts/Barons appoint Stewards, Chieftains Banes, 5 each (`/appoint`, config appointRules). No Baron rank exists yet; the Count of Bruma stands in.
- [x] Pigeons: stored always, read by opening any notice board; login says how many wait. Stored letters were never delivered before.
- [x] Client 0.3.4: lingering race ability dispelled (Nord frost resist on Orcs), party window finds members, nameplate above the health bar, chat no longer steals focus in game menus (stuck Tab).
- [ ] Needs Nat: Hufsa form id (not in any plugin or data); rob-a-player design; Baron rank zones; charcoal tier table (skills.json and SKILLS_DESIGN disagree), blacksmith or woodcutter; Orc Clan armor recipes reverse ORC_CLAN_RECORDS.md (relics never craftable).
- [ ] Planned, one DLE plugin pass: orcish recipes need a DBO_Office_Chieftain marker, province markers gate recipes by region, charcoal grades as ingot ingredients.
- [ ] Sync, needs two-player measurement: summon abilities (flame cloak hitting party), scamps wandering, daedra lords following, invulnerable spawns / too-distant hits, Pale Pass wolf duplicates.
- [ ] Save errors 19:07-19:26 (invalid UTF-8 in one actor field, cleared by restart); watch for recurrence.

### Open - decisions for Nat

- [x] ~~**Players cannot launch until the plugins reach them.**~~ Fixed by 0.3.3 above. The backend still serves the 2026-09-18 client
  zip (v0.3.2) with none of the 9 DragonBreak/Lost Ark plugins, and the launcher refuses to start the game
  when a load-order plugin is missing. Today only a manual install of `_release\DragonBreak-plugins-*.zip`
  gets someone in. Fix: rebuild the zip (LAUNCHER_FILES_GUIDE) now, and build the per-file launcher sync
  (memory note `launcher-must-sync-non-nexus-files`) for plugins + BSAs + assets.
- [x] **Admins on the dev server** (18:03 UTC): `adminRoles` in its server-settings = senior Owners
  `1494126527489507369`, developer Dragon Break Dev `1494491999305338981`, gm GM `1494126618065506425` (names
  checked through the Discord API). Boot: `tier roles senior 1 / developer 1 / gm 1`. `admins` stays empty.
- [ ] **Whitelist**: already enforced by the backend with the role **"Whitlisted"** (`WHITELIST_ROLE_ID` in
  `/opt/dragonbreak/backend.env`). The id Nat gave, `234362720420364288`, is **not a role in the guild**
  (a 2016 snowflake; the guild is 2026) - not applied, because an unknown role locks everyone out. Admins
  need the whitelist role too to join. Override lives in `skymp5-backend/data/server-access.json` (read per login).
- [ ] `discordAuth` is missing from the server settings, so the Discord ban system is off.
- [ ] Old characters on the dev server were not migrated (fresh world; 13 files backed up).

## Added 2026-09-21 (11:25): Auri-El has a shrine in Bruma

- [x] **Nat placed `DLC1ShrineofAuriel`** (`Dawnguard.esm:00C86B`, the base `skills.json` already names)
  as `DragonBreak Online Edits.esp:12AE03`, BSHeartland cell `09FF1A`, at (57257, 205947, 7716),
  scale 1.87, not disabled. `py ck-mcp\shrines.py` re-run: Auri-El 4 placements -> 5, **1 in the
  playtest region and 1 in Bruma county** (was 0).
- [x] **`skills.json` auriel `inBruma`/`inPlaytest` 0 -> 1**, `placements` 5, note rewritten. This is
  not cosmetic: `prayer.js` reads `inBruma` for the boot count *and* for the picker's `reachable` flag,
  so without it the picker would still have marked Auri-El unreachable.
- [x] **Plugin copied into `server\data\`** (node stopped first; `cmp` identical to the dev copy). The
  hard link to `tools\loadtest\sandbox\data\` got the new version too.
- [x] Restarted 11:23 with 0 online and no lease open: **12 `[error]` lines (baseline)**, boot now reads
  `26 deities, 45 shrine ids, 26 reachable under the region lock` (was 25).
- [ ] **Unplayed.** Test: a character with Auri-El (or Akatosh) kneels at the new shrine; the prayer
  widget should open and a completed prayer should credit Priest.
- [ ] **The client package is stale.** `server\client-dist\Data\` (20:48 yesterday) and
  `forkuild\client-files\` hold the old DLE, so a remote player would not see the shrine and their
  plugin would differ from the server's. Left alone on purpose: repackaging is Nat's call. Jake's
  `server\data\` needs the new file too.
- [x] `DEITY_DESIGN.md` corrected (it said Auri-El has no shrine here and the boot line reads 25).

## Added 2026-09-21 (10:40): every notice board works

- [x] **Root cause: no board in Skyrim had ever worked.** `zones.ts` listed Tamriel and the city
  worldspaces as `"3c:Skyrim.esm"`, but `zoneAt` compares against `normDesc`, which lowercases the
  plugin. Every Skyrim position therefore resolved to no zone, and each board activation logged
  "outside every zone" and fell through to vanilla. Only Bruma worked, because regions match by
  worldspace. The same fix makes `housingSystem`'s zone lookup return Skyrim holds for the first time.
- [x] **Every placed board is seeded at boot** from the new `server\notice-board-spots.json`
  (generated by `py ck-mcp\board_spots.py`). The N hotkey, `/board` and pigeons used to find only
  boards someone had clicked since the restart. Boot line: `[board] 28 of 28 placed boards known`.
- [x] **Static boards are usable through N and `/board`**: the 7 College of Winterhold bulletin boards
  and the 3 boards in Fort Greymoor. The engine cannot activate a static, so walking up and pressing
  E still does nothing on those.
- [x] **The Hammerfell board** (Gray Fox Cowl's `manny_GF_Cont_AlikrNoticeBoard`, a container) is a
  board base now, and `zones.json` has an `alikr` region (Alik'r Desert, no officials) for it.
- [x] Pools per hold: whiterun 7, winterhold 6, markarth 3, riften 2, falkreath 2, solitude 2, and one
  each for bruma, morthal, dawnstar, windhelm, solstheim, alikr. The 5 disabled boards (Riverwood,
  Morthal, Riften, 2 Harvest) stay disabled; they are curation.
- [x] Verified: `build-ts` clean, local server booted at 10:36 with 12 `[error]` lines (baseline).
  Backup `_dist_back-backups\before-boards-20260921-103500`.
- [ ] **Unplayed.** Test: press E on a Whiterun board, which should open the menu. Press N standing
  next to a College bulletin board.
- [ ] Jake's server needs the new bundle plus `notice-board-spots.json` and `zones.json` (both tracked).

## Added 2026-09-21: hosting moves to Jake; the home server PC is retired

Nat's home server PC (`10.0.0.132`) will not host the game - movement was laggy
on it. **Jake runs the server side on his own.** Every "copy this to the server PC" note below is
superseded; read it as "Jake's setup needs this". Production uses Discord verification and role-based
admin (`adminRoles`). Two things Jake's setup must get right that git will not bring him:
`server\data\` byte-identical to the client plugins (the ESL lesson in `HUB_SPAWN_BUG.md`), and a
`server-settings.json` whose `startPoints` matches the client's computed index.

## Added 2026-09-21 (07:15): a won skinning round now credits the Skinner (scheduled run)

The scheduled brief's queue (mining event kind, deity data, shrine path, Unarmed marker spells) is
**stale - all four were already shipped**, and I re-checked each rather than trusting the 20:25 note:
`labour.js:328` emits `'mine'` with the ore band and `'chop'`; `skills.json` holds 9 BSHeartland
wayshrines, `conversionCooldownDays: 7` and the Daedric entries; `prayer.js:439` emits `'prayer'`;
boot says `18 skills have marker spells` with no "missing". **The brief should be rewritten before
it runs again.** Its other two premises are also out of date (see the 21:00 handover below): the
starting-spell bug was not C++ and is fixed, and the error baseline is 12, not 18.

So the run took the one open item of the same shape as queue item 1, from the 21:00 handover.

- [x] **Measured first, and the handover overstated it.** It said skinner "maps to no kind at all" and
  ranks 1-4 are unreachable. Wrong: `skinner.counts` has `killKeywords: ActorTypeAnimal` and
  `craftKeywords: CraftingTanningRack`, so a held Skinner *was* credited for animal kills and tanning.
  What was true: **the skinning itself credited nothing** - `"skin"` was not an activity kind and the
  won round emitted no event.
- [x] **The fix, in four places that must agree** (the harness now checks all four):
  `masterySystem.ts` `ACTIVITY_KINDS` + `matches` (`skillId === "skinner"`, like prayer/priest) +
  `indexCandidates` (`add("skin", "skinner")`); `skillPoints.ts` `weightOf` `"skin"` =
  `clampW(1 + min(1, value / 100))`, value being the best pelt's gold (`peltsWorth`, 0..300), so a fox
  is 1.0, like a chop, and a 100g+ pelt is 2.0, like ebony ore; `gamemode.js` emits
  `'skin'` on a **won** round only, after the pelts are given.
- [x] **Only a held trade is credited.** Skinner has a station, so the unopened branch skips it; a
  non-Skinner who skins a fox (allowed since Nat's 2026-09-20 call) earns nothing toward Skinner until
  they touch a tanning rack. Deliberate: it keeps the "a trade is opened at its station" rule intact.
- [x] Verified: `build-ts` type-check clean; `"prayer","lock","skin"]`, `case"skin":return r==="skinner"`
  and the weight present in the **deployed** `server\dist_back\skymp5-server.js`; skillPoints 151,
  skill-openings (5 new checks), mastery-values 46, prayer, labour, skinning, mastery-damage all pass.
  **Local server booted 07:11: 12 `[error]` lines (the baseline), skills/prayer/stations boot lines
  unchanged**, then stopped again because it was not running before. Backup
  `_dist_back-backups\before-skin-20260921-071049`.
- [ ] **Not deployed to production.** This run only reached the local copy. (The home server PC
  `10.0.0.132` was retired later on 2026-09-21; production is Jake's host.) To go live: copy `server\dist_back\skymp5-server.js(.map)` and `server\gamemode.js`, restart node.
  The bundle change needs the restart; `gamemode.js` alone would emit an event the old bundle drops.
- [ ] **Unplayed.** Ready to test: take up Skinner at a tanning rack, skin a fox, the K menu should move.
- [ ] Committed locally in both repos, **not pushed** (no say-so this run).

## Added 2026-09-21 (01:00): the hub spawn is SOLVED - one ESL flag on one plugin

The block below was written at 00:15 with the spawn unsolved. It is solved; full account in
**`server\HUB_SPAWN_BUG.md`**. Two players, on separate machines, are now in the game together.

- [x] **Cause:** `AlternateHighPolyHead_SE.esp` was ESL-flagged in the copy the client loads and not in
  `server\data\` - otherwise byte-for-byte the same plugin. The client put it in the `0xFE` space, so
  every later index was one lower on the client alone. The hub was `0x25` server side and `0x24`
  client side; `startPoints` pointed at a form that did not exist on the client, the move was a no-op,
  and every player stayed at the player's default editor location: Riverwood's Sleeping Giant Inn.
- [x] **Found from a crash log's `PLUGINS:` block**, which prints the runtime load order with indices,
  after eleven static hypotheses had all come back "correct". Ask for a crash log before computing
  plugin indices from files on disk.
- [x] **Fixed**: ESL copy into `server\data\` and dev `Data\`, `startPoints` -> `0x24017482`.
  Blast radius checked first - all generated data uses desc-style ids, and the only hard-coded
  numeric at a shifted index was `startPoints` itself.
- [x] **Gates confirmed working** (*"You step through the gate to Bruma"*). A finished character is now
  also sent to the arrival automatically, since the hub is allowed by the region lock and nothing else
  would ever move them.
- [x] **Admin confirmed working** - but it lives in **two files**. See below.

### Open, for tomorrow - details in HUB_SPAWN_BUG.md

- [ ] **RaceMenu shows the stock menu, not its sliders.** Everything on the DBO side checks out:
  `skee64.dll` loads, both RaceMenu plugins are active, `RaceMenu.bsa` is installed and holds the only
  copy of `racesex_menu.swf`. **First check: the MO2 Archives tab** - the profile's `archives.txt` is
  empty, and `RaceMenu.bsa` probably is not ticked. If it is, test `showracemenu` in the console to
  separate "archive not loading" from "server opens the menu too early".
- [ ] **Orc still has Nord frost resistance.** The client fix is deployed; retest on a character
  created now that the spawn works before treating it as new. Deeper fix `DBO_PlayerRecord.pas` is
  scoped and not promoted.
- [ ] **Admin lives in two files.** `gamemode-config.json` `admins` hot-reloads and covers the gamemode
  and `/whoami`; `server-settings.json` `adminProfileIds` is **boot only** and is what the **admin
  panel** reads. Being `tier senior` in chat while the panel refuses you means the second list is
  missing your id. Menu key is **Insert** (launcher `adminMenuKeyCode` 210), not the client's F7.
- [x] **`spawnTrace` removed** from `gamemode.js` (2026-09-21, dev box).
- [ ] **Client crash on jump at Pale Pass** (00:21:05, `SkyrimSE.exe+079F43C`, `JumpHandler`, null
  read at `+0x218`). Unexplained; see `HUB_SPAWN_BUG.md` item 3.
- [x] **The `1001` profile explained**: `login.ts:275` refuses an admin profile id from a non-loopback IP
  in offline mode and substitutes `1000 + userId`. Adding your own id to `adminProfileIds` and
  connecting over the LAN therefore *removes* your admin. Keep test ids in `gamemode-config.json`
  `admins` only. **Production will use Discord verification and role-based admin** (`adminRoles`),
  which closes this and the unguarded `admins` list together.

## Added 2026-09-21 (00:15): the first two-player session - the server is reachable, the spawn is not

Nat and a friend both reached character creation on a server running on a **second machine**, from the
internet, through the launcher. That is the thing that had never happened. What does not work is the
spawn into the hub, and it has its own write-up: **`server\HUB_SPAWN_BUG.md`** - read that before
touching the spawn path, most of the obvious causes are already eliminated there.

### Shipped and verified

- [x] **The server runs on the server PC** (`10.0.0.132`), reachable at `68.63.59.17`. `listenHost`
  `0.0.0.0`; `uiListenHost` stays `127.0.0.1` because port 3000 exposes `/rpc/:rpcClassName`.
  Ports opened and forwarded: **UDP 7777** and **TCP 4000** only.
- [x] **Three launcher fixes for offline-mode servers** (`abca872`, `817741f`, pushed). This is the
  first server run with `offlineMode` on and two guards assumed every server has Discord auth and a
  certificate: the download guard refused plain http, and both the profile id and the PLAY button
  demanded a Discord login that **no Discord application existed to satisfy**. The download guard now
  allows plain http from the exact origin the build is configured for and nothing else; the installer
  stays https-only. An offline server mints a profile id once and keeps it, never `1`.
- [x] **The install manifest is published** - 106 mods, 100 plugins, compiled from Nat's reference MO2
  install at `C:\DragonBreak`. The first compile failed wanting to inline 1058 MB of base64: ten mods
  ship as `.rar` and the bundled `7za` cannot read RAR, so it fell back to embedding the extracted
  files. Pointing `DRAGONBREAK_7Z` at the full 7-Zip the launcher already ships fixed it.
- [x] **The client package carries the nine plugins that are on no Nexus page** - the seven
  DragonBreak ones and the two LostArk ones, which sat loose in the game Data and were therefore in
  no MO2 mod. They are **not** removed from the load order on purpose: at positions 63-64, and form
  ids here are `plugin index << 24 | local id`, so dropping them shifts every later index and
  invalidates the ids baked into `dungeons.json`, `loot.json` and the rest.
- [x] **`HUB_SPAWN_WAIT_MS` 12000 -> 35000** (`4f458f05`). The client's spawn loop retries 30 times a
  second; the server gave up at twelve and its fallback teleport aborted the client mid-spawn. The
  direct hub spawn could never complete. Fixed, proven by the trace, **and the symptom remains** -
  which is what makes the rest of it interesting.
- [x] **`charCreator` disabled** (`server-settings.json`, boot only). Nat prefers RaceMenu to the
  custom creator widget, and the widget would not close.

### A mistake worth recording

Adding two plugins to `skymp-client.zip` with .NET's `ZipArchive` in **Update** mode corrupted it for
`adm-zip`, which is what the launcher extracts with: a clean 174.3 MB download then
`Install failed: ADM-ZIP: No descriptor present`, for both players. **Never patch that zip in place.**
Add the files to its source under `build\client-files\root\` and rebuild with `npm run merge`, which
uses `archiver`. The rebuilt zip was validated by opening it with `adm-zip` itself and extracting all
267 entries before shipping - that check is the one that should have run the first time.

### Open

- [ ] **The hub spawn.** Every character lands in Riverwood; the server thinks they are in the hub.
  See `HUB_SPAWN_BUG.md`. The missing reading is the in-game console (`~`) line
  `Spawn loop gave up: still in <hex>` - `printConsole` goes nowhere else, which was checked.
- [ ] **RaceMenu shows the vanilla menu.** `skee64.dll` loads and `RaceMenu.bsa` is installed, and the
  full UI was seen earlier the same evening. Test `showracemenu` in the console first.
- [ ] **A temporary `spawnTrace` diagnostic is live in `gamemode.js`.** Remove it, or set
  `"spawnTrace": false` in `gamemode-config.json`, once the spawn is fixed.
- [ ] **`world-old\`** on the server PC is the pre-wipe world. Delete it when nobody wants it back.

## HANDOVER to the daily-code-review session (written 2026-09-20 21:00, read this first)

Nat asked me to talk to you directly. `send_message` refuses to deliver to a scheduled-task session
and this session is one itself, so this block is the channel. **Three things your brief tells you are
true are now false** - it is worth correcting them before you plan a run around them.

### Your brief is wrong on three counts, and one of them will waste your whole run

- **"The starting-spell bug ... fix is C++. Do not re-investigate."** It was not C++ and it is
  **fixed and confirmed in game**. Battle Cry and `RaceNord` (which is what carries the 50% frost
  resistance) are RACE spells, removable client-side with `Actor.removeSpell` + `dispelSpell`;
  Flames and Healing are on the vanilla Player NPC_ `Skyrim.esm:000007` and came off with an xEdit
  override in DLE. `RaceSpellsService` derives its strip set from the race records at runtime, so it
  needs no per-race list.
- **"The clean baseline is 18 `[error]` lines."** It is **12** since the Player record override.
  Same single `ScampServer.cpp:1084` type, fewer of them. Do not treat 12 as a regression.
- **`SERVER_AUTHORITY.md` says to clamp damage in `onHitDamageAttempt`.** It cannot -
  `gamemode.js:1896` states it only returns a bool. But `masteryBonusDamage` shows the working
  technique: let the hit land, read the health lost, then write `percentages`. **Resistances are
  therefore enforceable with no C++**, which contradicts the Bloodlines codex's "waiting on the
  damage judge". Nat has not decided whether to build it.

### What I left half-built, deliberately, in case it is yours

**Skinning is open to everyone now** (Nat's call): rank no longer gates entry, it gates which beast
and how well. Bands are keyed on the pelt's own gold value from a census (`ck-mcp\pelts.py`, 38 hides
0-300g), configured in `gamemode-config.json` -> `skinning.tierValueCap` / `bonusByTier`.

**But the ladder has no first rung, and I did not build it because it looks like your work.** A
successful skin emits no mastery event; `"skin"` is not in `ACTIVITY_KINDS` (`masterySystem.ts:165`,
dropped at `:325`); and `skinner` maps to no kind at all. Ranks 1-4 are unreachable, so every band
above Novice is theoretical. If your skill-openings pass already covers it, take it.

### Weight my claims accordingly

I shipped **two regressions tonight**, both from "safety" guards I added, both caught only because
Nat retested rather than trusting my verification. The second is the instructive one: I checked
`hasSpell` in the same frame as `removeSpell`, the engine updates the list later, so every spell
looked unremovable and was written off permanently. **My record-level and file-level verification was
sound; my reasoning about engine timing was not.** When I write "verified but unplayed" in these
blocks, read it as ready-to-test, not done.

### Not claimed by me, still open

- **620+ `OnHit ... too distant` in one 40-minute session** (759 `[error]` against the 18 baseline of
  the time). That single line is the ogre-not-attacking, invulnerable-on-spawn and floating-wolves
  cluster - one root cause, needs the actor-layer rebuild, not a patch.
- **Crash 19:39:25**: a `kDeleted` Flame Atronach inside `MovementControllerNPC`, `rcx = 0`. An
  unguarded sibling of `Refr pointer expired`.
- `tests\labour-harness.js` carries a check named **`KNOWN GAP`** that asserts today's behaviour on
  purpose: the slow-motion guard is a flat 2500 ms, so a round shorter than that can be played at
  half speed undetected. Tighten the guard and that test fails by design, pointing at the reasoning.

## Added 2026-09-20 (20:25): four whole systems credited nobody, and Tailor cannot be opened in Bruma

Every item in this session's brief (the mining event kind, the deity data, the shrine activation path,
the unarmed marker spells) was already shipped by the sessions between 03:20 and 20:10, so the run went
looking for the next hole of the same shape instead. It found two, one of them proved by Nat's own
change form.

### Prayer, reading, lockpicking and harvesting credited nothing, to anyone, ever

`creditPoints` skips a skill with no record - *"a trade is opened at its station, not by accident"* - and
the 03:15 shadow-banking pass carved out one exception, `category === "combat"`. The other four
stationless skills were left in the hole: **priest, scholar, harvesting and lockpicking have no
`gates.stations`, so `firstTouch` can never fire for them, and the banking branch refused them.** Every
`prayer`, `read`, `lock` and plant `activate` event was enqueued, matched, and dropped on the floor.

- [x] **Measured before changing anything.** `world\changeForms\b.json` after tonight's playtest:
  `private.dboDeity: { name: "Malacath" }` - Nat prayed and took a deity - and the mastery record holds
  `arcane` (shadow 0.84), `onehanded` and `miner`. **There is no `priest` key at all.** The combat
  skills banked; the prayer did not.
- [x] **The fix is one condition, not a new rule**: the unopened branch now skips a skill that *has* a
  station and banks for one that does not, instead of testing the category. Combat keeps behaving
  exactly as it did. Nothing was invented - this is the mechanism Nat already accepted and played, now
  applied to the family it was always the answer for.
- [x] The offer line was worded for fighting in both the server notice and the front widget; both now
  branch on category. `masterySystem.ts` type-check clean, verified in the built bundle
  (`You have done this often enough` present, the `category !== "combat"` test gone), deployed,
  **server restarted 20:20:57, 12 `[error]` lines - all the known ScampServer boot noise, nothing new.**
- [x] **`server\tests\skill-openings-harness.js` (new, 60 checks)** holds it shut: it reads the live
  `skills.json` and the live TS and asserts every skill has exactly one opening move, that the branch
  did not get its category test back, and that each banking skill answers to a kind something actually
  emits. **All harnesses pass**: skill-openings 60, skillPoints 148, mastery-values 46, prayer, labour,
  skinning, mastery-damage.

**The numbers Nat's balance call needs** (a level's worth is 10 units, and banking does not apply the
repetition decay):

| skill | acts before the take-up offer |
|---|---|
| priest | 10 prayers (60 min per shrine, 25 shrines reachable) |
| lockpicking | 10 locks |
| scholar | 10 books - **at 30 minutes a book that is five hours**, effectively still out of reach |
| harvesting | 20 plants |
| the six combat skills | 20 hits / casts / blows taken (unchanged) |

- [ ] **Scholar's ten books is the one that looks wrong.** Either `read` is worth more than 1, or a book
  should credit per page rather than per book. Nat's call.

### Tailor cannot be taken up anywhere in Bruma - the same shape as the shrine bug

`ck-mcp\stations.py` (new) censuses every base object that satisfies a skill's `gates.stations` - keyword
first, editor-id prefix for the rest, exactly as `masterySystem` tests them - and counts placements inside
the playtest region. Output: `server\station-placements.json`.

| trade | base objects | placements | reachable under the lock |
|---|---|---|---|
| miner | 579 | 4153 | 516 |
| cook | 7 | 660 | 106 |
| blacksmith | 37 | 887 | 59 |
| alchemist | 3 | 293 | 40 |
| skinner | 3 | 294 | 26 |
| woodcutter | 8 | 275 | 26 |
| enchanter | 8 | 181 | 25 |
| **tailor** | **1** | **13** | **0** |

- [x] **Tailor's only station base is `MCECraftingLoomMarker`, and all 13 of its placements are in
  Skyrim** (Radiant Raiment, Dragonsreach, the Blue Palace, Understone Keep…). `MCE_Loom` and
  `TailorBench` match no record in this load order at all. A loom census over every FURN/ACTI/STAT found
  nothing usable in Bruma either: `bskSpinningwheel` is reachable but is a **STAT**, which the engine
  never fires an activation for, and `CYRMerchantBrumaTailorChest` is a merchant container. **So Tailor
  is dead content for the whole playtest**, and its `counts` are `craftKeywords` on the same absent loom,
  so it cannot even be credited once held.
- [x] **It is no longer silent.** `gamemode.js` reads the census at boot and logs
  `trade stations: 8 gated trade(s), 1 unreachable under the region lock (tailor - CANNOT BE TAKEN UP),
  station name(s) matching no record: BYOHOven, MCE_Loom, TailorBench, CharcoalKiln, LumberMill`.
  Re-run `py ck-mcp\stations.py` after any station or region change.
- [ ] **Nat's call**: place a loom in Bruma through DLE (content authoring), point Tailor at a station
  that does exist there, or accept that Tailor is closed until Skyrim opens and say so in the menu.
  `CharcoalKiln` and `LumberMill` matching nothing is expected - they are the charcoal chain's
  aspirational names, not a bug.

### "Skinning is broken" was a dead-end message

Report #6 from the playtest, now answered: **a Skinner is made at a tanning rack**, and there are 26
reachable ones. The corpse said only *"Only a Skinner can take the pelt"*, which names no way forward -
a corpse is not a gated station and never can be one.

- [x] `gamemode.js` now says *"Only a Skinner can take the pelt. Set your hand to a tanning rack to take
  up the trade."* Hot-reloaded 20:17, 0 new errors.
- [x] **The K menu tells you how each skill opens.** `sendMenu` carries `openable: "station" | "work"`
  and a `hint` per skill; `skills.json` gained a player-facing `gates.hint` for all eight trades ("an ore
  vein", "a tanning rack", "an arcane enchanter"…). The menu's line for an untaken skill was *"Set your
  hand to its work"* for everything, including skills whose work is a deer corpse or a prayer. Front
  rebuilt and deployed to both UI paths, backup `_ui-build-backups\before-openable-20260920-202028`.
  **No client rebuild was needed** - `masteryService` mirrors `skills` as an opaque array, so the two new
  fields ride through untouched.

### Still open from this run

- [ ] **None of it has been played.** The take-up offer for a Priest or a Scholar, the new menu lines and
  the tanning-rack hint are all verified statically and in the built bundles, never on screen.
- [ ] **`gates.nodes` is still a dead field** (`harvesting` declares it, `ResolvedRules` carries it,
  nothing reads it). Harvesting now opens by banking instead, so the field is superseded rather than
  broken - delete it or wire it, but do not leave it looking load-bearing.
- [ ] Deliberately not touched: anything needing the native build, the join path, `Refr pointer expired`,
  bot load testing, and the `DBO_PlayerRecord.pas` re-run the 20:10 session left in flight.

## Added 2026-09-20 (20:10): the first real playtest, and the starting-spell bug was never C++

Nat played for ~40 minutes as **Argosh, an Orc**, and reported nine things. Several long-standing
claims in HANDOFF turned out to be wrong, and the headline is that **the point system works in play**.

### The gate passed, and nobody had watched it before

`world\changeForms\b.json` after the session: `miner: { level: 1, points: 1, xp: 10, spentToday: 1 }`
and `arcane: { shadow: 0.84 }`. **`level` and `points` are both written and agree**, which is exactly
what the 01:25 fix was for, and the level survived a logout. Also confirmed in play:
`labour win Argosh mining/iron t1 6/6 of 8 err=0.36` (an `err` of 0.36 is a human playing, not a
computed round), the racial stat spread (**105/80/115** on screen), prayer, and the deity picker.

### The starting-spell bug was fixed client side, and the "C++ only" verdict was wrong

HANDOFF said this needed the native build. It did not, and it also had the mechanism wrong.

- [x] **Measured first** with the new `py ck-mcp\racespells.py`, which dumps the SPLO list of every
  playable RACE from the winning override. **Battle Cry and Resist Frost are RACE spells**
  (`PowerNordBattleCry`, and `RaceNord` is the record that carries the 50% frost resistance).
  **Flames and Healing are on no race at all** - HANDOFF claimed they came from the RACE record.
- [x] **`RaceSpellsService` (new, client)**: derives the strip set from the race records at runtime -
  every spell some other playable race grants that yours does not - so nothing is hardcoded per race
  and a plugin retune needs no code change. It `dispelSpell`s as well as `removeSpell`s, because an
  ability keeps its active effect until a cell change. Type-check clean, verified in the built
  bundle, deployed to both paths. Backup `_client-bundle-backups\before-racespells-20260920-194833`.
- [x] **Confirmed in game**: Battle Cry and Resist Frost gone, Berserker Rage kept.
- [x] **A bug in the first build, caught by the retest**: Flames and Healing could not be removed, so
  the service retried and re-dispelled them **every 4 seconds forever**. It now gives up after one
  failed attempt. The cause is a hard engine rule: **Papyrus `RemoveSpell` cannot remove a spell
  inherited from the actor's base record**, the same rule as the server's `IsSpellLearnedFromBase`.

### One vanilla record was causing two separate complaints

`Skyrim.esm:000007` (the Player NPC_) carries `SPLO: Flames, Healing, PCHealRateCombat` **and** a
16-entry `CNTO`: iron weapons, shield, 2 torches, lockpicks, potions, The Book of the Dragonborn and
**140 gold**. The engine applies both client side when it builds the player, which is exactly Nat's
*"it adds this stuff then takes it away"* - the server then overwrites the inventory with its own.

- [ ] **`DBO_PlayerRecord.pas` (new) overrides that record in DLE** and strips both, keeping
  `PCHealRateCombat` (combat health regen, not a starting spell). First run removed **16 of 16 items
  but 0 spells** - the `Spells` element path does not exist on NPC_. The script now reports the real
  element names and handles a flat SPLO layout. **Not promoted**: the live plugin is untouched
  (md5 `8e615b1f`, identical to the backup) and the incomplete output is parked at
  `ckmcp-backups\pre-playerrecord-20260920-200421\partial-items-only.esp.save`. Re-running.

### Orcs have no passive ability, and that is correct

Nat expected one. The dump settles it: every playable race has a `Race<Name>` ability **and** a
`Power<Name>` power except **OrcRace, which has only `RaceOrcBerserk`**. That is vanilla. **The Orc
passive that was added is the stat spread**, which lives in RACE `DATA` and never shows under Active
Effects - and it is working (105/80/115). A visible Orc ability would be a new record and a design
call.

### 620 refused hits explain three of the nine reports at once

The session logged **759 `[error]` lines against a baseline of 18**, and they are almost all one line:

```
364x  OnHit - aggressor and targetRef are too distant. Aggressor: ff00000b
119x  ... ff00008a      117x  ... ff00002c
```

That is the documented failure - a spawned NPC's cell is never updated by movement, the disagreeing
update is dropped, and **every hit on that actor is refused from then on**. So **#3 "the ogre was on
the ground but not attacking", #5 "enemies are invulnerable for a moment" and #7 "floating timber
wolves that no-clip" are one bug with a number on it**, and Nat's own read was right: it needs the
actor-layer rebuild in `NPC_REBUILD.md`, not a patch. Rats inside a wall at Anga (#8) is the same
missing floor check.

### Gold, and the rest

- [x] **#9 gold cut 74%**, hot-reloaded 19:49, 0 new errors. Coin was in **every** container by three
  separate guaranteed paths. Now `goldChance: 0.35` / `goldMult: 0.6` under `dungeons` in
  `gamemode-config.json`. Simulated over 4,000 leases at Adept: **523 -> 135 gold**, containers
  carrying coin **78/88 -> 33/88**. Boss chests still always carry coin.
- [x] **#6 skinning is not broken**: the character's record is `order: ["miner"]`, so `skinnerTier`
  returns -1 and `__dboSkin` answers *"Only a Skinner can take the pelt"* - a personal message with
  no log line, which is why nothing was captured. **Open question: is there any way to become a
  Skinner?** `firstTouch` only fires at a gated station and a deer corpse is not one. If there is
  none this is the same family as the mining first-touch deadlock.
- [ ] **#4 Discord streaming lags the in-game UI.** Untouched, lowest value of the nine.
- [ ] **The crash** (19:39:25, `EXCEPTION_ACCESS_VIOLATION`): a **`kDeleted` Flame Atronach** inside
  `MovementControllerNPC`, `rcx = 0`. A destroyed actor still being driven by its movement
  controller - a conjurer's summon in Anga. Same family as `Refr pointer expired` but unguarded.

## Added 2026-09-20 (16:14): login hang measured, and the landing trap removed

**User decision: leave the content fix for now** (2026-09-20). Skyrim is closed by the playtest lock and no
live path reaches a Skyrim login point, so nothing is urgent. Do not re-open this without asking.

What the measurement says, from `ck-mcp\login_spot_check.py` (new, reads the whole load order and reports
the nearest **placed living actor** to every spawn, landing, gate and temple; `--safe X Y` searches Tamriel
for a clear spot). Results in `server\login-spot-check.json`.
- The rule that predicts the hang is **placed living actors in the loaded grid (~12,288 units)**, not
  distance to chickens. Bruma's worlds now hold **0** living placed actors, which is why logins there work;
  Tamriel still holds **3,691**. Server-spawned creatures do not trigger it - Bruma logs in fine with 3,329
  spawn zones running - so the trigger is specifically plugin-placed ACHRs loading with the cell.
- Old Whiterun landing: 0 living actors within 4,096, 8 within 8,192, **44 within 12,288** (11 cows, 8
  chickens, 5 goats, guards, horses, the carriage driver, JK's Outskirts NPCs). Nearest is
  `WhiterunPlayerHorse` at 4,685.
- **Every Skyrim respawn temple has living actors inside the loaded grid** (Windhelm 616, Riften 1,299,
  Whiterun 1,629, Falkreath 2,127, Solitude 2,490, Markarth 833). Hub gates too, but a gate is a teleport
  while alive and only a *login* hangs. The temples matter the moment Skyrim opens: die in Skyrim, log in
  later, hang.
- The nearest hang-free spot to Whiterun is about **35,000 units** away, so a landing cannot be both near
  the city and clear without a content change.
- [x] **Trap removed (LIVE 16:14)**: `gamemode.js`'s hardcoded landing default was the old Whiterun spot, so
  a missing or reset `gamemode-config.json` sent every fresh character into the hang. It now defaults to the
  Pale Pass arrival, matching the live config.
- [ ] When Skyrim opens, the options are: disable the ~44 actors around one landing (scoped, the Bruma
  precedent), or all 3,691 in Tamriel (the "server spawns all actors" rule applied to Skyrim, which needs
  server-side humanoid spawns first, or Skyrim is empty of guards and citizens), or land in wilderness 35k
  out. Re-run `login_spot_check.py` after any curation pass to confirm the points are clear.

## Added 2026-09-20 (15:50): Daedra worship is not one crime, and a permission allowlist

Nat, awake: *"for the unlawful list, be lore accurate please, certain daedra are fine like malacath"*.
Server restarted **15:49:30**, **18 `[error]` lines**, `prayer on: 26 deities, 45 shrine ids, 25
reachable`, `blessings 22 resolved, 0 broken`. `skills.json` backed up to `skills.json.bak-lawful-154716`
first. Prayer harness **all checks passing**.

- [x] **The blanket `lawful: false` on all sixteen Princes is gone.** It was one boilerplate string
  repeated sixteen times, which is both wrong and useless. **Malacath, Azura and Meridia are now
  `lawful: true`** with no `unlawfulWhere` at all: Orc strongholds worship Malacath in the open and
  Orsinium is an Imperial vassal; Azura's shrine is a public pilgrimage site with a resident
  priestess; Meridia's sphere is the destruction of undead, which runs *with* Arkay and Stendarr.
- [x] **The other thirteen each carry their own reason**, and the harness now asserts all thirteen
  are **distinct**. Severity is carried in the prose, so there was **no schema change and no front
  rebuild** - `lawful` is still the boolean `prayer.js` and the picker already read.
  Hunted: Mehrunes Dagon, Molag Bal, Namira, Boethiah, Vaermina. Criminal: Mephala, Nocturnal,
  Hircine. Forbidden on paper and ignored in practice: Sanguine, Sheogorath, Hermaeus Mora, Clavicus
  Vile, Peryite.
- [x] **Mehrunes Dagon's line is Bruma-specific**, which is the best hook on the list: the Great Gate
  of 3E 433 opened outside these walls, and Beyond Skyrim has already renamed the Great Chapel of
  Talos here to the **Cathedral of St Martin**, after the man who died ending that invasion.
- [x] **`prayer.js` now says the deity's own reason** instead of one generic line for every Prince,
  and says nothing at all at the three legal shrines. Hot reload, no rebuild.
- [x] **The Tribunal's "good Daedra" were not used as the model, deliberately.** Azura, Boethiah and
  Mephala are Dunmer temple doctrine; two of that three are among the most criminal under Imperial
  law. `skills.json` carries a `_lawComment` saying so, because it is the obvious wrong turn for the
  next person.
- [x] **Two harness checks rewritten, not worked around.** "every Prince is marked unlawful" was
  asserting exactly the behaviour this changes; it is now three checks (the legal three, the
  proscribed thirteen, and the distinctness of their reasons).

- [ ] **Nothing still acts on any of it.** No guard reads `lawful`; the player is told once and
  nobody stops them. Making it a real crime is a faction decision and a big change.
- [ ] **Not tested in play**, like the rest of prayer.

### Found on the way out: the slow-motion guard has a hole, and a "flaky" test was reporting it

`tests\labour-harness.js` failed **5 runs in 25**, always on the same check, *"a sweep played at half
speed is refused"*. It is not a bad assertion - it was **intermittently revealing a real hole**, and
passing whenever the random bands happened to make the round long enough.

- **The slow-motion guard is the same flat `lagGraceMs: 2500` that pays for transport**
  (`labour.js:293`, `judge()`), and at half speed the excess *equals the round's own length*. So the
  cheat is only caught once a round runs longer than 2,500 ms. A **6-strike tier-5 round finishes in
  roughly 1,800-2,400 ms**, under the grace - so a player can draw the whole sweep out to double
  length, which makes a timing game trivial, and nothing fires. High tier is the *easiest* to cheat,
  which is backwards.
- **`gamemode.js`'s skinning judge is the same shape** (`judgeSkin`, `SKIN.lagGraceMs: 2500`, 3 cuts),
  so it has the same property by construction. Not separately measured.
- **Not fixed, deliberately.** Catching it needs a proportional test - the excess measured against
  the round's own length rather than one absolute - and `labour.js:36` says in as many words to
  *"read a playtest's worth out of server.log before tightening this"*. **Nobody has played yet, so
  there is no `lag=` distribution to calibrate against**, and a threshold guessed now would refuse
  honest players on a bad connection. This is a balance call that wants real latency data first.
- [x] **The test is deterministic now**, 30 runs of 30 passing: one check that slow motion *is*
  refused once the round outlasts the grace, and one named `KNOWN GAP` asserting today's behaviour
  with the reasoning inline, so whoever tightens the guard gets a failing test pointing at it.
- [ ] Separately, `tests\skinning-harness.js` is still the **other** flaky one (~1 run in 30, the
  evenly-spaced forgery case) and is untouched - that one really is a test asserting an absolute over
  a random seam.

### A permission allowlist, replacing seventy dead one-liners

- [x] `.claude\settings.local.json` rewritten. The old list was ~70 command strings recorded verbatim
  from past sessions (`node fixwheel.js`, a specific `grep -o` with an escaped brace count, a
  scratchpad path from a dead session id) - none could ever match again. It is now general rules:
  the file tools, read-only shell, `node`/`py`/`npm run`, read-only git plus `add`/`commit`, the
  read-only creation-kit MCP tools, and the documented hidden `run-logged.cmd` start.
- [x] **`git push` is in `ask`, not `allow`**, so it always stops for a human - the standing "back up
  the local git before a push" rule made structural rather than remembered.
- [x] `git reset --hard`, `git clean -fd` and `Remove-Item -Recurse` are in **`ask`, not `deny`**, on
  purpose: `git reset --hard backup/pre-push-<stamp>` is the documented rollback, and denying it
  would block the recovery it exists for. Only `rm -rf` is denied outright.

## Added 2026-09-20 (14:44): floating and clipping NPCs, four fixes (LIVE, client rebuild included)

Diagnosis first, from `formView.ts`, `movementApply.ts` and `npcSpawnSystem.ts`. A `translateTo` moves a
reference with collision off for the whole translation (the project's own finding, commit `853117b`); the
symptom in HANDOFF section 15 is "x/y parked at the target, z creeping at the leftover speed". Five client
fixes had been layered on that since 09-15 and it still happened, so the gap was in **when** the nets fire.
- [x] **Ragdoll leak** (`client\src\sync\movementApply.ts`). The ragdoll early return (`Variable10 < -999`)
  bailed out without stopping the in-flight translation or restoring collision, so a knocked-down copy whose
  get-up event was lost slid on with collision off for as long as it lived. It now settles first. Combat
  knockdowns are common, so this was the main suspect for floating during a fight.
- [x] **Stale sit pose** (`client\src\sync\animation.ts`). `restoreSitCollisionIfMoving` only recovered a lost
  get-up for a *moving* copy; a standing one kept collision off for life. It now also recovers when the engine
  does not hold the actor in furniture (`getSitState() !== 0`), which is the honest test for "the get-up was
  lost". A copy the engine really has sitting still keeps collision off.
- [x] **`isSliding` detector** (`npcSpawnSystem.ts`). `isStranded` needs `dz >= 600` AND `dxy <= 384`, so a
  float offset sideways matches nothing: **it has never fired once in this project's log history**. The new
  test flags x/y frozen while z creeps 0.5-64 units per poll, at least 250 off the slot, for three polls -
  the signature of a translation nobody stopped, in either direction, so it catches sinking too.
- [x] **Void spots are remembered** (`npcSpawnSystem.ts`). `fallenSpots` was in-memory and was *wiped on every
  despawn*, so each lease and each restart re-learned the same floorless spots at two dropped NPCs apiece
  (the log shows Serpent's Trail slot 5 falling on four separate occasions). Now persisted to
  `server\npc-fallen-spots.json`, kept across despawns and restarts, forgotten only on an admin reset.
  Seeded from the log evidence with the 11 spots already proved floorless (Serpent's Trail x7, Red Ruby
  Cave, Bleak Falls Barrow). Delete the file to make the server try every spot again.

**Verification, since the user could not test in game:**
- Client fixes driven against the real compiled code with a stubbed engine (`esbuild` bundle of the two
  modules): 9 checks pass. **Control**: the same tests against the pre-fix sources from HEAD fail exactly the
  4 checks that target the fixes and pass the other 5, so the tests can fail.
- Detector: 8 offline checks - fires within 10 s on a float in either direction, and does **not** fire for an
  NPC standing on a ledge 700 above its slot, one walking, a real fall, jitter near the slot, or a drift that
  changes direction. False fires were the risk: a wrong one destroys an NPC mid-fight.
- **Live, via the bot harness** (`--host-npcs --drift-hosted`): 12 fires on the real server, each at 278-286
  off its spot (FLOAT_LIFT 250 plus three polls, as designed), each followed by destroy-and-replace and a
  refill, and no false fires across 48 other zones of standing NPCs.
- [ ] **Still unverified, and only a player can**: whether havok actually re-takes the body, i.e. whether the
  NPC stops floating on screen. `stopTranslation` plus collision-on is the one engine fact in this chain with
  no primary source - the CK wiki is behind a bot check and creationkit.com is down - and
  `movementApply.ts:175` already warns "stopTranslation does not reliably hand the reference back to havok".
- [ ] Measured, not fixed: spawn placement is **not** the cause. Every zone holds one NPC, so the invented
  ring slots are never used, and both generators anchor on the placement's own vanilla ACHR, so `PlaceAtMe`
  births each actor on Bethesda's spot. 36 falls and 11 void slots in all logs, 0 strands.
- [ ] From the harness, worth knowing before a 100-player night: 34 hosted NPCs raised the movement fan-out
  from 66,643 to 77,117 messages a second (+16%), about 43x each hosted actor's own rate. At the live budget
  of 150 NPCs all hosted that is roughly another 46,000 a second on top of the players.

## Added 2026-09-20 (15:40): the wildlife faction gap does not exist, and now it is measured

The handed queue (mining kinds, deity data, the shrine path, Unarmed's markers) was already finished
by the three runs before this one, so this run took the one open item nobody had checked: the
`_reviews` note that **the `ff_factions` repair lives only in `dungeons.js`, so `wildlife.js` and
generic `NPC-Spawns.json` zones get no faction repair.** Hot reload only, no rebuild. Nobody online,
no lease open, **18 `[error]` lines** before and after.

**The answer is that there is nothing to repair.** `wildlife faction audit: 0 of 3185 placements
spawn without their template's factions, 3185 defer to the leveled pick (0 kinds, 45 ms)`.

- [x] **Every one of the 3,185 wildlife wrappers defers.** `LvlAnimalMountainSnowPredator` and its
  kind *are* NPC_ records, not leveled lists - I guessed they were LVLNs and the measurement said
  otherwise - but all 3,185 carry ACBS template flag `Use Factions` **set** and template down to an
  LVLN, so the faction walk leaves the NPC_ chain with nothing of its own to give. Resolving the
  leveled list therefore loses nothing. **This is the whole difference from the dungeons**, where
  2,320 of 3,500 defer and the other 1,180 own their factions - 390 of which disagree with what gets
  spawned.
- [x] **There are no generic zones either.** `NPC-Spawns.json` holds `wild:` 3185 and nothing else;
  `dungeon:*` entries exist only while a lease runs. So the "generic zones get no repair" half of the
  note is empty too.

### The zero was checked against a known answer before it was believed

A clean audit result and an audit that reads nothing look identical. So the same module was run over
`dungeons.json` as a negative control and reproduced **390 of 3500**, matching `dungeons.js`'s own
boot audit of 390 exactly (its 3501 counts one slot whose option resolves to id 0, which this one
skips). Only then was the wildlife zero trusted. The control has been removed again.

### What shipped

- [x] **`server\factions.js` (new)**: the espm side of the faction question as one module - the TPLT
  walk to the record whose SNAM list actually applies, `factionLoss`, the `ff_factions` payload
  shape, and a reusable `audit()`. Pure: give it `mp` and it answers questions about records. It
  **cache-busts itself** on require, because a hot reload re-requires `wildlife.js` but would
  otherwise keep a stale copy of this - that cost two reload cycles to notice (`undefined deferred`).
- [x] **`wildlife.js`**: a once-per-process audit and a clause on the boot line. The verdict is kept
  on `globalThis` so the summary still carries it after a reload, when the audit itself is skipped.
- [x] It audits **the option actually picked** (`pickOption` with the placement's own safe-zone
  pick), not `options[0]` as the dungeon audit does. The pick is what spawns.

- [ ] **`dungeons.js` still carries its own copy of this logic** (~30 lines, lines 501-540). The two
  are now proven to agree, so the swap is safe, but it was left alone deliberately: the file had been
  written by another session at 14:54 and there is no functional gain from touching a system that is
  verified in game.
- [ ] **Unchanged and still true**: `applyFactions` landing the factions on the actor has never been
  seen in game. Bots have no engine, so no bot run can ever show it. It needs one player standing in
  a vampire lair watching whether the thralls still fight the vampires.
- [ ] The other half of the same root cause is untouched and still open: ambush AI packages (967
  slots), AI data (994), scripts (910), outfits/inventory (460), spells (244).

## Added 2026-09-20 (15:00): every Prince is prayable, at one test site

Nat placed a statue of every Daedric Prince at the Namira shrine site in the Creation Kit, as one
central place to test worship, and saved to `DragonBreak Online Edits.tes` because the CK could not
rename over the plugin. Server restarted 14:52:26, **18 `[error]` lines**, `unresolved: none`,
harnesses green. The boot line moved **`9 reachable` -> `24 reachable`**.

### The save was fine; the shrines were not

- [x] **Nothing was lost in the CK round-trip**, checked before promoting with the new
  `py ck-mcp\comparesave.py`: all 101 `DBO_*` spells, all 10 RACE overrides, same 52 masters. The
  file came back **25 KB smaller** purely because the CK recompacts what it rewrites - worth knowing,
  because a smaller file after a save looks exactly like data loss.
- [x] **Thirteen of the fifteen statues were STATICS.** The engine fires no activation on a static,
  so `prayer.js` never hears about it: they were scenery. Only `ShrineOfMalacath` and the vanilla
  `DA09MeridiaStatue` were activators. This is the single easiest mistake to make in the CK, because
  a STAT and an ACTI look identical once placed.
- [x] **Meridia needed only data**: she is named by *reference* on purpose, so the new placement was
  added beside the Kilkreath one rather than switching her to the base, which would have turned her
  four Crowhaven scenery twins into shrines.

### The fix

- [x] **`DBO_ShrineActivators2.pas`**: ten new `DBO_ShrineOf<Prince>` ACTI records at
  `125BFC-125C05`, each **cloned from `DBO_ShrineOfHircine` and given the exact mesh of the statue
  Nat chose**, so nothing changed visually. Hircine, Sanguine and
  Sheogorath already had DBO activators on those same meshes and were reused, not duplicated.
- [x] **All thirteen references repointed** at their activator, so the statue *is* the shrine rather
  than something standing next to one. Verified in the written plugin before promoting: 13 of 13,
  masters still 52.
- [x] Every mesh comes from `man_DaedricShrines.esp` or `Skyrim.esm`, both already masters of DLE,
  so no master was added and DLE's self-index could not shift.
- [x] `skills.json` gained the ten new ids; census re-run; **24 of 26 deities now reachable**.

### Clavicus Vile was already there, and I missed him twice

Nat: *"should be a shrine here already at the namira place in bruma, it uses the quest one from that
cave is skyrim."* He was right. `DA03ClavicusVileShrine` (`Skyrim.esm:01C4E8`, the Haemar's Shame
shrine) has been sitting at **[94521.9, 193547.5, 2328.8]** since his 14:10 save, in the middle of
the ring.

**It is a `TACT` - a talking activator - and both of my surveys only scanned ACTI/STAT/FURN/MSTT/
LIGH.** So it reported as an unresolved `?` base and fell into the "dressing" line, twice. It was
even visible in the very first comparison as `+1 base 01C4E8 ?`. **An activator is not always an
ACTI**; a TACT is activated exactly the same way.

- [x] `ck-mcp\shrines.py` and `ck-mcp\newshrines.py` now share a `BASE_SIGS` list that includes
  **TACT**, SCOL, ADDN and the rest, and `newshrines.py` treats TACT as activatable when it decides
  what is prayable.
- [x] Clavicus Vile wired by **data alone** - no plugin work. The base is named, so the Haemar's
  Shame shrine counts too, which is right: both are genuinely his.
- [x] The `DBO_ShrineOfClavicusVile` activator I had started creating was **killed mid-run** and
  never saved; the plugin is untouched by it. It was not needed.
- [x] The stale 14:10 `.tes` was moved out of `Data\` into
  `ckmcp-backups\pre-ckshrines-20260920-141648\`. It was a pre-activator state sitting beside the
  live plugin - promoting it would have silently undone the ten activators and thirteen repoints.

**Boot: `45 shrine ids, 25 reachable`. Only Auri-El has no shrine of his own here**, and it costs
his worshippers nothing: he is Akatosh under the Aldmeri name and `prayer.js` treats the two as one
faith, so any Akatosh chapel in Bruma will hear him. **Every character on the server has somewhere
to pray.**

- [ ] **One thing to watch in the first play test:** whether `mp.onActivate` fires for a **TACT** at
  all. A talking activator is activator-derived and the player activates it in vanilla to speak to
  Clavicus, so it should - but that is reasoning, not a measurement, and Clavicus is the only shrine
  on the server that depends on it.

- [ ] Two placements look accidental and are worth a glance in the CK: `BSMApoHMShrine01` sits at
  **[0, 0, 0]** in cell `0A7646`, and `DA07ShrineofMehrunesDagonExitTrigger` is a quest trigger
  rather than a shrine. Neither is wired to anything.
- [ ] **Still nothing knelt at.** Twenty-four gods now have somewhere to pray and not one prayer has
  been said.

### The runner missed two error dialogs

`tools\run-sseedit-script.ps1` reads error dialogs so a compile failure shows in the console, but it
only matched boxes titled `SSEScript 4.1.5f`. xEdit's rename failures come up titled plainly
**`Error`**, so two went unread and the diagnosis came from the log instead. Now matches `Error` and
`Warning` too.

## Added 2026-09-20 (13:40): the deity picker, the last piece of the brief

Front widget `deityPicker` (id 36), built and deployed to both UI folders; `prayer.js` drives it.
Reloaded 13:37:52, **18 `[error]` lines**, harness **74 checks, all passing**. Backup in
`_ui-build-backups\before-deitypicker-20260920-133448`. No client rebuild - the relay passes a widget
payload through verbatim.

- [x] **Two columns of names beside a reading pane**: Divines keyed aqua, Princes amber, the same
  split the prayer widget uses. Each name carries its marks - **yours**, **no shrine**, **unlawful** -
  and the pane gives the sphere, the boon, whether there is anywhere to pray, and the aspect line for
  Auri-El.
- [x] **The server decides everything.** The widget sends only `dbo:deityChoose <nonce> <id>`; the
  server judges it and re-sends the whole payload with a notice, so the panel never works anything
  out for itself and a stale nonce changes nothing. Same contract as the labour and prayer rounds.
- [x] **Offered by a watcher, not a creation hook.** `private.creationPending` is cleared in a TS
  system with no gamemode callback, so a 7 s tick offers the menu to any online character who is out
  of the race menu and holds no god. That covers the new character *and* every existing one, which a
  creation hook would not have.

### One rule changed, and it is the brief's

**The first god is now free and needs no shrine**; only a later turn is gated. The brief says "a
deity picker after the race menu" and "you can only change deity once a week IRL, **by a menu key**",
so conversion through the menu is gated by the **cooldown alone** - no pilgrimage. A character who
has just left the race menu is standing in the hub and could not reach a shrine anyway.

- `/deity` on its own now **opens the menu**. `/deity <name>` still works and still keeps the older
  at-the-shrine rule for a *turn*, for anyone who would rather type; a first pick by chat is free too.
- Two harness cases were testing the old behaviour and were rewritten, not worked around.

- [ ] **A real menu key is still client work.** `/deity` is the key for now. Adding a hotkey means a
  client rebuild and a player re-download, so it should ride along with the next one rather than
  cost a relaunch of its own.
- [ ] **Untested in play, like everything else here.** 74 harness checks and a boot line
  (`deity menu opened for ...`), and nothing else.

## Added 2026-09-20: headless load-test harness `server\tools\loadtest` (LIVE, sandbox only)

Answers the daily review's "Load test before any real 100-player night". Full write-up with the numbers:
`_reviews\2026-09-20-load-test-harness.md`. **No change to `fork\` or `server\` was needed to build it, and
no bot has ever logged into the live server on 7777.**

- [x] **Bots speak the real protocol.** Each bot drives the game's own `MpClientPlugin.dll` (real SLikeNet
  client, real `MessageSerializerFactory`) through a small C# host, ten bots per process, each with its own
  copy of the DLL because it keeps one client in a file-static. Node drives the bot logic; no npm packages,
  and the C# is built by the `csc.exe` that ships with Windows.
- [x] **A bot walks the player's path**: offline login with its own profileId (900001+, never 1 or an admin
  id), character select, arrival report, race menu closed by sending an appearance, out of the hub through
  a Realm of Lorkhan gate, then waypoints at run speed with `UpdateMovement` every 130 ms, chat every
  45-150 s, `ChangeValues`, and a dungeon claim (gate widget -> `dungeonClaim`). Verified in the sandbox:
  Serpent's Trail claimed, 20 enemies prespawned, 88 containers filled, party moved in.
- [x] **Isolated sandbox** (`node loadtest.js sandbox init`): the same bundle, gamemode and data files on
  port 7787 with its own world folder, `/metrics` on and plugins hardlinked from `server\data`. It is a
  snapshot, so it never disturbs the live gamemode and a run measures the code as of the last `init`.
- [x] **Measured, not guessed**: server tick histogram and event-loop lag from the server's own `/metrics`,
  CPU and RSS, machine-wide UDP datagram rates, exact message counts and per-type breakdown from the bots,
  and the gamemode's own `ticks (ms, last 60 s, N online)` lines pulled out of `server.log` per step.
  Windows has no per-process network byte counter without ETW (measured: 10 MB of UDP on loopback moves
  `Win32_Process.WriteTransferCount` by 0), so bytes/s needs bots on a second machine.
- [ ] **The wall is the movement fan-out, and it is quadratic.** Every player in the same 3x3 block of
  4,096-unit grid squares is a listener (`MpObjectReference.cpp:158`, `WorldState::GetNeighborsByPosition`),
  and Bruma city fits inside one block, so each player's ~7.1 messages a second are copied to everyone
  present, including back to the sender (self-subscription is deliberate, `MpObjectReference.cpp:745`).
  Fixes, cheapest first: stop echoing the sender's own movement; interest management by distance instead of
  by grid block; a per-listener rate ladder by distance. The last two are C++.
- [x] **First sweep done** (10/25/50/100, five minutes a step, four dungeon leases open): one error line in
  25 minutes, no disconnects, memory flat at ~1 GB, and 61,951 messages a second leaving the server at 100
  players against 736 arriving. Real wire bytes, measured through the harness's counting relay: 8.8 KiB/s
  per player, so about 3.8 MB/s out at 100. JSON is 4.6x the wire size.
- [x] **Re-measured after three per-player timer fixes the same afternoon** (`6f68fc3` officials cache,
  `e07b09c` movetrace gate, `86da0d6` dungeon id walk): at 100 players `lawful` 6.99 -> 1.0-2.0 ms mean,
  `moveTrace` 0.47 -> 0.00, `dungeons.arm` 1.53 -> 0.80, `dungeons.tick` 2.09 -> 1.11, and the whole
  gameplay timer layer 1.1 s -> 0.07 s of CPU a minute. Traffic and CPU did not move across the three runs
  (61,951 / 60,742 / 61,253 msg/s at 20.6 / 20.3 / 17.4% CPU), which is the point: the cost was never in
  the gameplay layer. A forced hot reload with 100 bots connected costs `meet` 2.48 ms, once.
- [x] **Many-lease check** (the four-lease numbers could not show a leases-times-ids cost): 100 bots on
  twenty dungeon doors, thirteen leases granted holding 225 living enemies against the four-lease run's 135.
  `dungeons.arm` 0.80 -> 0.86 ms mean, `dungeons.tick` 1.11 -> 1.53 ms; still linear in leases it would have
  been 2.6 and 3.6. Growth now tracks enemies, not leases.
- [x] **The sandbox server that "vanished" was killed from outside, not a crash.** Restarting the live
  server by sweeping `CommandLine -like '*skymp5-server*'` matches every copy of the bundle, so it stopped
  the sandbox too - three times, each within a second of a `server-exit.log` line (14:16:48, 14:28:36,
  14:43:52). The perf session owns the last two; **14:16:48 is unattributed** (an earlier note pinned it on
  a plugin sync, which was withdrawn: the ESP it cited has been written again since, so its timestamp
  proves nothing). There is **no** evidence of a server dying with many dungeons open.
  Fixed on the harness side: the sandbox's copy of the bundle is now `dbo-loadtest-server.js`, so no sweep
  for the live server can hit it. Worth adopting the other half too: **restart sweeps should match on the
  working directory or the port, never on the bundle name.** (A marker argument is not an option -
  `settings.ts:95` runs argparse's `parse_args()` with no arguments defined, so the server refuses any
  unknown flag.)
- [ ] **Orphan dungeon zones after an unclean stop**: a lease that was open when the server died leaves its
  zones in `NPC-Spawns.json`, and `npcSpawnSystem` tries to place them for the ~13 s until `dungeons.js`
  clears them at load (73 `failed to spawn` lines measured in one boot). Self-correcting, but it will look
  alarming in the log after any crash during a dungeon evening. The harness strips them before it starts
  the sandbox; the server could do the same one step earlier in boot.
- [x] **NPC hosting measured** (`--host-npcs`, 100 bots, 240 s each): no seeded npcs 60,742 msg/s out ->
  npcs present but unhosted 66,643 -> npcs hosted by the bots **77,117**. Only **34** hosted npcs and 243
  extra inbound messages a second produced **10,474 more outbound**, i.e. ~43 listeners per hosted actor.
  At the live npc budget of 150 all hosted that is roughly **another 46,000 messages a second on top of the
  players' 62,000**. Whatever interest management is chosen must cover hosted actors, not just players.
- [x] **`isSliding` verified on the live path** (the detector added 2026-09-20 14:44): four bots took host of
  a zone npc each and reported it with x/y frozen and z rising 6 u/s. It fired 12 times, each at 278-286
  units off the spot (FLOAT_LIFT 250 plus its three confirming polls), destroyed and replaced each one, and
  never fired on the npcs standing still in the same world.
- [ ] **Three traps found while doing it**, all worth knowing outside the harness:
  - **Bruma has almost no wildlife where the players are**: of 3,185 `wild:*` zones, 2,612 are in Tamriel and
    345 in the Bruma worldspace, with exactly **one** within 5,000 units of the city. Every other number in
    the review is therefore player-to-player traffic in a world with no npcs near the crowd.
  - **A zone that leaves `NPC-Spawns.json` while its npcs live orphans them forever**: they stay alive,
    streamed and hostable, but `checkMisplaced` only walks `zone.spawned`, so no detector can correct them.
    (Found because `wildlife.js` deleted seeded zones named `wild:*` - it owns that prefix, as `dungeons.js`
    owns `dungeon:*`.)
  - **A server killed while players are connected leaves their characters enabled in the world**: on the next
    boot they stream to everybody and any client can take host of them. Same family as the orphan dungeon
    zones; the logout grace never ran.
- [x] **Sweep run against the LIVE server** (user asked; world snapshotted and restored, nothing left behind):
  10/25/50/100 bots, five minutes a step, no dungeon claims and no NPC hosting. **Zero errors in 25 minutes,
  no disconnects, memory flat at ~1 GB.** 100 players = **67,454 messages a second out** against 737 in,
  20.2% of one core, loop lag p99 24.9 ms, createActor churn 307/s.
  - The gameplay timers matched the sandbox at 100 players (`meet` 1.15 ms mean vs 0.71-1.12, `lawful` 1.09
    vs 1.04-2.03, `moveTrace` 0.00 in both), so the real character data behind `meet` and `lawful` costs
    nothing now that both are caches. **The sandbox is a fair stand-in: nobody needs to touch live again for
    load work.**
  - The relay was ~10% heavier than the sandbox (67,454 vs 61,951) because this run held no leases, so all
    100 bots stayed in one worldspace instead of four sitting in interiors.
  - Restore verified by counting: `changeForms` back to 650, `starter-grants.json` 101 rows -> 1,
    `npc-fallen-spots.json` still 11, `metricsAuth` removed, no `LOADTEST` string anywhere in the world.
    Recipe and cautions are in the review, section 6. The bot characters were never flushed to disk at all.
  - Cost: the live server was down ~100 s during a false start (my restart did not launch; nobody was online),
    and restarted four times in total.
  - **Cleaned up afterwards, on request.** The snapshot folder and the pre-run settings backup are both gone;
    each was checked against the live copy first rather than taken on trust. All 650 change forms were
    byte-identical to the snapshot (0 differing, 0 missing) and `server-settings.json` matched its backup by
    SHA-256, so neither deletion could lose anything. Both were gitignored (`_*/` and `*.bak-*`), so nothing
    about the cleanup shows in this repo. A residue grep for `9000[0-9][0-9]` matched 10 files and was a red
    herring - floating-point coordinates like `110.9000015258789`, present in the pre-run snapshot too. The
    check that means something is `"profileId": 9000xx`, and that was zero.
- [x] **20-door refusal check against the evening build** (ambush `90bfec3` + refusal logging `73fb0e5`).
  It found a gameplay problem worth acting on:
  - **A claim pre-spawns nothing once the live-npc budget is full.** Every one of the seven doors claimed in
    the second run reported `0 prespawned` - Underpall with 69 enemies, Anga with 21, Fort Caractacus with
    15, all zero. `zone-spawns.json` sat at exactly **150**, the default `npcLiveBudget`, with the log
    repeating `budget of 150; 'dungeon:CYRSedorLocation:10' waits for room`. **Fourteen concurrent leases
    exhaust it.** Nothing errors: the claim succeeds, the party is moved in, the line still reads
    `N enemies, 0 prespawned`, and the party walks into an empty dungeon while enemies trickle in as other
    actors despawn elsewhere. `SCALING_NOTES.md` already calls 150 a playtest number; this is the measured
    threshold behind that sentence. Raising it is one line plus a restart - watch memory and change-form
    count, which is the cost the budget exists to bound.
  - The ambush change holds back 68 of 210 actors (32%), which softens the budget problem by accident and
    means a late claimant's ambushers may be what finally spawns.
  - **The refusal logging earned itself immediately.** First run: 14 granted, 6 refused, and all six said
    `claim from beyond 2500 units of the entrance` - a harness bug, not a server one (`tickTravel` steered
    each bot back to its home patch while the dungeon code warped it to the door, so it pressed claim a warp
    step short). Fixed with `driveTo` plus a settle tick; the verification run claimed **21 of 21** with zero
    distance refusals, its 14 refusals being honest `claimed by another party for 56 more min` ones.
  - Fort Caractacus was then claimed on its own for the faction session (15/15 prespawned, 7 `factions:`
    lines), because on a saturated budget it had spawned nothing and would have told them nothing.
- [ ] **Still to run**: bots on a second machine for real bytes/s without the relay hop.

## Added 2026-09-20 (13:30): every scale term in weightOf is live, and the offsets were measured

Unattended run, nobody online, no lease open. Server restarted **13:22:58**, **18 `[error]` lines, the
known baseline**, boot lines unchanged (`resolved 113/129`, `18 skills have marker spells`, `prayer on:
26 deities ... blessings 22 resolved, 0 broken`). Warnings identical to the previous boot.

**The queue I was handed was already done by the three runs before me** (mining kinds, the deity data,
the shrine path, the Unarmed markers). So this run took the item those runs left behind, which HANDOFF
section 0 still lists as open: **`weightOf`'s `value` was passed by nobody, so craft, kill, hurt and
cast all sat at the flat 0.5 base whatever they were worth.** Mining was fixed at 11:00; the rest were not.

### What now carries a value

| kind | scale term | where it comes from |
|---|---|---|
| `craft` | product gold value | COBJ `CNAM` -> product record, by measured offset per type |
| `cast` | magicka cost | `SPIT.spellCost`, uint32 at offset 0 |
| `hurt` | damage taken | the 4th argument of `onHitDamage`, which was being discarded |
| `kill` | victim's ACBS level | `npcLevel()`, the existing helper conjurationSystem uses |
| `hit` | **deliberately flat** | too hot a path to price per blow; repetition decay already covers it |

- [x] `masterySystem.ts`: `productValue()` and `spellCost()`, both cached by form id like the
  `benchCache`/`schoolCache` beside them, because plugin data never changes at runtime.
- [x] **`hurt` was free.** `onHitDamage(aggressorId, targetId, sourceId, damage)` always carried the
  damage and masterySystem destructured only the first three. C++ never fires the event for a hit of
  zero or less (`ActionListener::FireHitDamageEvent` returns early), so the value is always > 0.
- [x] **`kill` is scaled by level, not health, and that is not a shortcut.** Max health is *not
  readable server-side*: `percentages` is a 0..1 fraction and `GetBaseActorValues` has **no property
  binding** in `cpp\addon\property_bindings\` at all. Reading it needs C++, which is blocked. `npcLevel`
  is the honest measure available. `weightOf`'s kill case was split from hit and rescaled to levels
  (`min(1.5, v/40)`), so a levelled bandit sits near the base and a fixed-level giant earns the top.
- [x] Type-check clean, built, **verified in the minified bundle**, deployed with node stopped, and the
  deployed file's md5 matches a fresh build of the current source. Backup in
  `server\_dist_back-backups\before-weights-20260920-132241`.

### No offset was guessed, and the one that was guessed was caught

`py ck-mcp\itemvalues.py` (new) scans **every 4-aligned offset** of the value-bearing field across the
whole load order and characterises it: how many reads are plausible gold, how many distinct, the max,
and whether the same bytes read as a plausible float instead. Results in `server\item-value-layout.json`.

- **AMMO was wrong on the first pass and the measurement caught it.** A narrow candidate list picked
  `value@4`, which is the *flags* field. The real value is at **12** and offset 8 is the arrow's
  **damage as a float** - which is why "iron arrow weighs 8.0" looked wrong and was worth chasing.
  Proved by the vanilla arrow ladder: iron 1, steel 2, orcish 3, dwarven 4, elven 5, glass 6, ebony 7,
  daedric 8. The script now re-checks that ladder on every run.
- **BOOK's offset 0 is a 4-value flag enum, not gold**; gold is at 8 (Spell Tome of Icy Spear 725,
  Candlelight 44). **ALCH keeps weight alone in DATA and the gold value in ENIT.** Everything else is
  `value@0`, at 100% against a runner-up scoring 2-44%.
- **`SPIT.spellCost` tracks spell power exactly**, which is the whole requirement: Healing 12, Flames 14,
  Frostbite 16, Sparks 19, Candlelight 21, Firebolt 41, Ice Spike 48, Fast Healing 73, Fireball 86,
  Oakflesh 103, Close Wounds 126, Incinerate 171, Grand Healing 254, Icy Spear 320, Ebonyflesh 341,
  Thunderbolt 343, Blizzard 1106. Monotonic, and the script asserts that. 748 of the 986 castable
  Spell-type records carry one; the rest are auto-calculated at 0 and fall back to the flat base.
- **6687 of the 6695 COBJ recipes** in this load order resolve to a product with a known layout.

### Tested, including a test that can fail

- [x] `tests\skillPoints.test.js`: **110 -> 148 checks, all passing.** New: each kind rises with its
  value, `hit` stays flat however large the value it is handed, a kind with **no** value still returns
  the old 0.5 base (so an emitter that sends none never regresses), and NaN/Infinity/negative/1e12 all
  stay inside the clamp.
- [x] **`tests\mastery-values-harness.js` (new), 46 checks.** A measurement in Python only proves where
  a number is, not that the TypeScript reads it. So `py ck-mcp\valuefixtures.py` dumps the **raw bytes of
  real records out of the real plugins** into `tests\value-fixtures.json`, and the harness runs the real
  `productValue()`/`spellCost()` against them: 12 recipes covering WEAP/ARMO/MISC/ALCH/AMMO/INGR and
  7 spells, plus the guards (unknown recipe, unmapped master, unlisted product type, truncated field).
- [x] **Negative control run**: AMMO's offset was deliberately put back to 4 and the harness failed 5 of
  46 checks, naming both arrows. It would have caught the original mistake.
- [x] Whole suite re-run: labour 37, prayer, skinning, mastery-damage 33, all passing.

### Two corrections to earlier blocks

- **"Tin and stalhrim can never be mined" (11:00 block) is true but is not a bug.** There is **no
  `MineOreTin` or `MineOreStalhrim` vein anywhere in this load order** - no base object and no
  placement - so their absence from `oreByTier` is correct and adding them would do nothing. The tin
  entry in `labour.js`'s `ITEMS` is dead data. The ores that really are **placed but unmineable** are
  **blackreach (41 placements)** and **heartstone (37)**, both outside the Bruma lock, so no player
  impact today. Census: bases and placements counted per ore over the whole load order.
- **Copper has only 7 placements in the entire load order** while being the tier-1 starter ore. A Novice
  is not blocked (iron 849 and corundum 287 are also tier 1), but "go mine copper" is near-impossible
  advice. Worth knowing before anyone writes a copper-gated tutorial.

### Open, and needing Nat

- [ ] **Nothing here is tested in play.** Harness, bundle grep and boot lines only. First check: craft
  something cheap and something expensive and confirm the expensive one moves the bar further.
- [ ] **`kill` scaling is a balance call I made alone.** Level/40 capped at 1.5 was chosen so a fixed-level
  giant reaches the top of the band; most levelled NPCs report their calculated minimum and sit near the
  base. Say if kills should be worth more or less than a vein.
- [ ] **`hit` is flat on purpose.** If a per-blow scale is wanted it needs a cheap toughness number that
  is not an espm walk per swing.
- [ ] **`tests\skinning-harness.js` is flaky, and it is flaky for a real reason.** "evenly spaced forgery
  is refused or slips out" fails about **1 run in 30**. Measured over 20000 rounds per spacing, a forger
  who sends evenly spaced cut times with **no knowledge of the seam** still wins **0.16% to 6.3%** of
  rounds (best at 300 ms spacing). That is worse than playing honestly, so it buys a *player* nothing -
  but a headless bot that cannot play the mini-game could farm pelts at ~6% per attempt for free. Either
  tighten the judge or make the test probabilistic; it should not assert an absolute over a random seam.
- [ ] **Widget id 33 is still used twice** (`gamemode.js` `SKIN_WIDGET_ID`, `labour.js` `WIDGET_ID`), and
  the front has **separate `skinning` and `labour` features**, so they are two different widgets on one
  id. Not touched: fixing it is a front rebuild plus an id allocation, and I could not confirm unattended
  whether the two can ever be open at once. Prayer took 35 to stay clear of it.
- [ ] Left alone deliberately, per the brief: the native build, the starting-spell bug, the join path,
  `Refr pointer expired`, bot load testing. **Nothing was pushed to git and nothing was committed.**

## Added 2026-09-20 (13:00): the plugin debt is paid - 16 records authored in xEdit

Server restarted 12:58:25. **18 `[error]` lines.** Boot now reads `resolved 113/129 form(s),
unresolved: none` and **`18 skills have marker spells`** - the `5 marker spell(s) missing` line that
has been there since Unarmed shipped is gone. `prayer.js` gained a boot check that resolves every
blessing id against the live load order: **`blessings 22 resolved, 4 server-side, 0 broken`.**

- [x] **Eleven `DBO_BlessingOf*` SPELs** at `DragonBreak Online Edits.esp:1209BF-1209C9`, written by
  `SSEEdit 4.1.5f\Edit Scripts\DBO_Blessings.pas`. Each is a copy of `AltarNocturnalSpell` with one
  effect swapped and `CureDiseaseEffect` kept, duration 28800. Namira is the deliberate exception:
  Fortify Sneak **plus Night Eye**, and no cure disease, which suits the Prince of decay.
- [x] **Unarmed's five marker spells** at `1209CA-1209CE` (`DBO_UnarmedMarkers.pas`), copies of the
  onehanded markers. `masterySystem` resolves them purely by editor id (`masterySystem.ts:904`), so
  the name is the whole contract; a marker is an empty Ability with a null EFID and carries no magic
  effect at all.
- [x] Verified **before** promoting anything: 16 records present in the written plugin, read back with
  `esplib`, and **52 masters, unchanged** - no new master, so no DLE self-index shift.
- [x] Promoted the `.save` over the original, synced `server\data\` with node stopped, hashes match.
  Backups in `ckmcp-backups\pre-blessings-*` and `pre-markers-*`.
- [x] `skills.json` points at the new records; `blessingSource` is now **vanilla 22 / server 4**, with
  **nothing pending**.

### Two boons changed on the way, both for cause

- [x] **Talos: shout cooldown -> Two-handed +10** (Nat's call). The shout boon was the fifth dead stat
  nobody had confirmed works here. Tiber Septim took Tamriel with a blade in both hands.
- [x] **Meridia: "the undead flee you" -> health regenerates 25% faster.** Found by dumping the
  template byte for byte before writing the script: **a shrine blessing is a fire-and-forget SELF
  spell carrying an 8-hour effect, not a constant-effect ability.** A mass-self-area turn undead in
  that shape fires once, at the shrine, and never again. Health regeneration is also closer to her
  actual sphere, which the lore states as the energies of living things.

### The xEdit pipeline is a tool now, and it cost three gotchas to get there

`tools\run-sseedit-script.ps1` runs a script headless and answers the dialogs `-autoexit` does not.
All three of these produced a silent exit 0 with nothing done:

- **`-D:` and `-P:` must be quoted into the command line.** Passing them as separate PowerShell
  `-ArgumentList` elements does not quote them: xEdit reads the data path as `E:\DragonBreak`, logs
  `Warning: Could not find plugin list`, and exits having run nothing.
- **`-script:` wants the script's full path**, not its unit name. Given a bare name it falls back to
  a "Select a script to execute" file picker and waits for a human. The runner now detects that and
  kills the run instead of hanging - this is the failure that once sat for eight hours.
- **`template` is a reserved identifier** in xEdit's script engine: `Identifier redeclared: 'template'`.
  The runner now reads error dialogs itself and prints them, so a compile error shows up in the
  console instead of needing someone to look at the screen.
- The known `.save` behaviour held exactly as the memory note says: xEdit cannot rename its output
  over a plugin the creation-kit MCP has open, so it leaves `<plugin>.save.<stamp>` beside it. The
  runner reports leftovers and **deliberately does not promote them itself** - overwriting a plugin
  is not a helper's decision.
- A run immediately after a plugin change is **slow** (~25 min, I/O-bound): xEdit rebuilds and re-saves
  its reference cache for the changed file. It is working, not hung - check CPU rather than assuming.

- [ ] **Nothing is tested in play.** Sixteen records exist and resolve; not one has been cast.

### Another session had written to the same plugin, and it survived

A race retune landed at **11:36**, before my passes: Khajiit `Unarmed Damage` **4 -> 14** (Argonian stays
10), and Altmer / Orc / Redguard restatted. `RACES_DESIGN.md` carries it and is **still uncommitted** -
left alone, it is not mine.

- [x] **Verified my writes did not clobber it**, rather than assuming: `py ck-mcp\raceverify.py` compares
  every RACE record against the pre-blessings backup and reports **10 of 10 byte-identical**. It also
  reads Unarmed Damage without guessing the RACE DATA layout - it derives the offset (0x60) by finding
  the one position where every race lands on a sane float and the known shape holds. Live values:
  **Khajiit 14, Argonian 10, everyone else 4.**
- This is the parallel-session hazard the memory note warns about, and the check is cheap. Re-run
  `raceverify.py` after any future plugin pass.

### The published artifacts were corrected to match

- [x] **The Wheel of Skills** - said Unarmed Damage was "10 for Khajiit and Argonian", said mining still
  reported itself as a 0.5 activation, and said Unarmed's five markers did not exist. All three were
  true this morning and none is now.
- [x] **Time to Mastery** - said "seventeen skills", and that no weight input was wired in.
- [x] **Bloodlines of Tamriel** - checked, already current with the 11:36 retune. No change.
- [x] **The Nine and the Sixteen** - the deity sheet, written today and kept current.

## Added 2026-09-20 (12:20): no boon may be a dead stat

Nat: *"change sanguine, there is no NPCs"* / *"like everything is player ran so."* Hot-reload only;
reloaded 11:55:36, **18 `[error]` lines**, no `needs tick failed`. Harness **56 checks, all passing**.

**It was four boons, not one.** Persuasion, Speechcraft and Pickpocket do nothing here - no merchants,
no dialogue, no barter, and no speech skill among the eighteen. That killed Sanguine's, which was
mine, **and Dibella's, Zenithar's and Mephala's, which are Bethesda's**.

| | was | is now |
|---|---|---|
| Sanguine | Persuasion +10 | **hunger comes on half as fast**, implemented, no spell at all |
| Dibella | Persuasion +10 (vanilla) | Illusion +10 |
| Zenithar | Speechcraft +10 (vanilla) | **Carry weight +50** |
| Mephala | Speechcraft +10 (vanilla) | Alchemy +10 |

- [x] **Bethesda's records are left untouched on disk.** `skills.json` stops pointing at the vanilla
  `Altar*Spell` and points at a `<pending: DBO_BlessingOf*>` instead, so reverting is one line and no
  plugin was edited. Every changed entry keeps a `replacedBoon` line saying what went and why.
- [x] **Zenithar is the one that matters.** The god of work and honest trade, on a server whose entire
  economy is players hauling ore, ingots and firewood to each other - carry weight is the most
  Zenithar thing that exists here, and no shrine in the game uses it.
- [x] **Sanguine stopped being a spell.** The Prince of indulgence belongs on the one system this
  server has that is about appetite. While the boon is worn hunger accrues at half rate: `prayer.js`
  exposes `__dboPrayerHungerMult` and the needs tick multiplies by it. No plugin, no record, nothing
  for the Creation Kit; `grantBlessing` now wears a boon that has no spell behind it. Harness covers
  that it applies, that no spell is cast, and that it lapses.
- [x] **`deities._deadStats` records the rule** so the next pass does not re-introduce one, and a
  harness check fails if any boon mentions persuasion, speechcraft, pickpocket or barter.

### The palette turned out to be much wider, and it closed both open questions

`AltarMaraSpellWHAnvil` (WindhelmSSE.esp) uses **`AlchFortifySmithing`** - proof that an
**alchemy-family MGEF works inside a shrine spell**. That was the unlock:

- [x] **Mehrunes Dagon** takes `AlchFortifyDestruction` (`3eb26`) and no longer shares Malacath's
  Damage - the school of ruin itself, in the county whose Great Gate he opened.
- [x] **Molag Bal** takes `AlchFortifyConjuration` (`3eb25`) - binding, thralldom and soul trap, and
  he is the reason a black soul gem is black. **So no deity needs a new magic effect any more**; the
  absorb-health that was going to have to be authored is not needed.
- [x] **Peryite** takes `AlchResistPoison` (`90041`). There is no resist-disease effect anywhere in
  this load order - only `CureDiseaseEffect`, which cures - and poison is real here because players
  brew it.

**What remains on the boons is labour, not design**: eight `pending` SPELs, each with a
`blessingRecipe` in `skills.json` naming the record to copy and the effect to point at.

- [ ] Open question I did not act on: **Talos gives a shout-cooldown boon and I have not confirmed
  shouts work on this server at all.** Worth one in-game check before it counts as a real boon.

## Added 2026-09-20 (12:00): the lore pass on the deities, and every boon designed

Nat, on waking: *"make everything lore accurate, especially with the boons. As for the daedric shrines,
I can add them as hidden ones throughout cyrodiil in creation kit."* That second sentence changes the
roster from "whoever already had a statue" to the canonical one. Hot-reload only; server reloaded
11:47:33, **18 `[error]` lines**, `prayer on: 26 deities, 33 shrine ids, 9 reachable`.
`tests\prayer-harness.js` now **49 checks, all passing**.

### The roster is canonical now, not opportunistic

- [x] **26 deities**: the Nine Divines plus Auri-El, and **Oblivion's fifteen Cyrodiil Daedric shrines**
  plus Mephala. Five Princes added: **Clavicus Vile, Hermaeus Mora, Namira, Peryite, Vaermina**.
- [x] **Jyggalag is deliberately absent and the data says why.** He was Sheogorath until the Greymarch
  ended in 3E 433 and has walked free since, but he has no cult, no shrine and no worshippers in
  4E 201. He is the one entry in the whole list that lore actively forbids.
- [x] **Auri-El carries `aspectOf: akatosh`** - he is the Aldmeri name for Akatosh, not a second god,
  and `prayer.js` now lets a worshipper of either kneel at either's shrine. This is not decoration:
  Auri-El's only shrine is in the Forgotten Vale, so without it a Snow-Elf-faithed character could
  never pray at all. Covered by the harness both ways.
- [x] Every Divine carries `alsoKnownAs` where the same god has other names - Kyne, Jhunal, Stuhn,
  Tu'whacca, Z'en, Ysmir.

### Every boon designed, and every one buildable from an effect that already exists

Measured first: `py ck-mcp\blessings.py` -> `server\blessing-effects.json`, what all 18 `Altar*Spell`
records in this load order actually do. **There is no `BlessingOf*` record anywhere** - the real one is
`Altar<Deity>Spell`, always one `Fortify<X>FFSelf` plus `CureDiseaseEffect` for 8 hours.

- [x] **The Divines are left mechanically alone, on purpose.** These are the blessings every Skyrim
  player knows and every other mod assumes; rewriting them is a change lore does not ask for. What was
  added is `sphere` and `alsoKnownAs`.
- [x] **All sixteen Princes now have a boon**, each grounded in their sphere, and **every one is built
  from an MGEF that already exists** - so the Creation Kit work is "a new SPEL pointing at an existing
  effect", never "a new effect". The single exception is called out: Molag Bal's absorb-health.
- [x] **Sheogorath's boon is implemented and needed no plugin at all.** The Madgod has no blessing of
  his own and should not have one, so `prayer.js` hands over **another god's blessing, rolled fresh
  every prayer**. `skills.json` marks him `capricious: true`. The one boon in the list that is more
  lore-accurate as code than as a record.
- [x] **A useful accident**: `FortifyStaminaRateFFSelf` (`fb98b:Skyrim.esm`) is in Bethesda's own
  shrine-blessing family and **no shrine in the game uses it**. It went to Hircine - the hunt never
  tires - so that boon needs a SPEL and nothing more.
- [x] Each entry now carries `blessingSource` (**vanilla** 15 / **server** 3 / **pending** 8) and, for
  the pending ones, a `blessingRecipe` naming the exact record to copy and the exact MGEF to point at.

### Lawfulness, written as data and nothing else

- [x] Every Prince **and Talos** carry `lawful: false` and an `unlawfulWhere` line. The White-Gold
  Concordat outlawed Talos and Bruma is Imperial - Beyond Skyrim has already renamed its Great Chapel
  of Talos to the **Cathedral of St Martin** for exactly that reason.
- [x] `prayer.js` warns the worshipper **once per character** and nothing else happens. No guard reads
  the flag. Wiring it to `private.dboLawful` would make Talos and Daedra worship the first real crimes
  in the game; that is a faction decision for Nat and is left in `DEITY_DESIGN.md` section 8.

### What the Creation Kit pass has waiting for it (DEITY_DESIGN.md section 7)

`py ck-mcp\daedricsites.py` -> `server\daedric-sites.json`, a census of what Beyond Skyrim already built.

- [x] **Namira's shrine is finished.** `CYRNamirasShrineExterior`, `BSHeartland.esm:0A009B`, grid
  **(23, 47)**, **99 references** already placed - snow, bone piles, cobwebs, red-eye lights, evil
  cairns. The shrine itself, `CYRMountainCliffNamira` at **[95612.3, 195219.2, 3297.2]**, is a **STAT**,
  so nothing can activate it. **It needs an ACTI standing at it and nothing else.** Cheapest shrine in
  the list by a wide margin.
- [x] `CYRStatueAzuraSnow` stands in the open world at **[198151.7, 178842.1, 1872.6]**. Same case.
- [x] `CYRShrineMephalaTEMP` is placed 9x inside `CYRNagastaniSilaseli`; the "TEMP" suggests Beyond
  Skyrim intends to replace it.
- [x] **There is no Daedric shrine *activator* anywhere in Beyond Skyrim Cyrodiil.** A STAT cannot be
  prayed at, so every site needs an ACTI: reuse the vanilla one for the five Princes that have one, or
  copy `DBO_ShrineOfHircine/Sanguine/Sheogorath` (`1112C5 / 1112C8 / 1112CB`) for the rest.
- The three steps after placing are in section 7, and the middle one is the trap: **copy the plugin
  into `server\data\` AND the dev Data with node stopped**, then restart, then `py ck-mcp\shrines.py`.

### Still open after this pass

- [ ] **Molag Bal is the one boon needing a new magic effect** (absorb-health-on-strike; nearest vanilla
  `AbsorbHealthConstant 91f7a`). `FortifyHealthFFSelf` at 25 is the stand-in if it is not worth it.
- [ ] **Mehrunes Dagon duplicates half of Malacath's boon** (Damage +10%) because the shrine family has
  no Fortify Destruction. A new Destruction MGEF would be truer to the Prince whose Great Gate opened
  at Bruma, which is the one place in Tamriel where that matters.
- [ ] **Hermaeus Mora's boon is the best next build and is not CK work.** "What you read teaches you
  more" lands exactly on the Scholar skill and the reading mini-game; no other Prince's sphere maps
  onto an existing system that cleanly. It needs the read weight multiplied in `masterySystem`, a TS
  rebuild. Clavicus Vile's bargain is the other server-side one and needs a choice step in the widget.
- [ ] Eight `pending` SPELs to author. Fold them into the same xEdit/CK pass that still owes Unarmed
  its five marker spells.
- [ ] **Nothing here is tested in play either.** The lore pass is data plus 12 new harness checks.

## Added 2026-09-20 (11:00): mining is weighed as mining, and prayer exists

Unattended run, nobody online, no lease open. Server restarted 10:39:10, **18 `[error]` lines, the known
baseline**, `[skills] ready: 18 skills`. Everything below is verified by harness and by log line;
**nothing is verified in play, because nobody was in the game.**

### Mining and chopping report the kind the point system actually weighs

`labour.js` emitted `'activate'` when a round completed - flat 0.5 units - so `weightOf`'s `'mine'` case
(1.0 to 2.0 by ore band) was dead code and a Novice miner cost twenty separate veins. **It needed a TS
rebuild, not just a hot reload**, which the queue asked me to say plainly: `enqueue()` drops any kind
outside `ACTIVITY_KINDS`, and `matches()` had no case for `mine`/`chop`, so emitting `'mine'` alone would
have credited *nothing at all* - strictly worse than the bug.

- [x] `masterySystem.ts`: `mine`, `chop` and `read` added to `ACTIVITY_KINDS`; `matches()` falls through
  to the `activate` case for all three (same reach, same prefix and type rules); `indexCandidates()` adds
  them wherever it adds `activate`. `tsc --noEmit` clean, **110/110 skillPoints maths checks still pass**,
  all four changes verified in the **minified** bundle before deploying.
- [x] **The wider bug behind it: `weightOf`'s `value` was never passed by anyone.** Both call sites read
  `P.weightOf({ kind: ev.kind })` with no value, so *every* kind sat at its `v = 0` base - craft 0.5
  whatever the product is worth, kill/hit 0.5 whatever the target's health, cast 0.5 whatever the magicka
  cost, hurt 0.5 whatever the damage. Every scaling term in that function was dead, not just the ore band.
  Both call sites now pass `ev.detail["value"]`; an emitter that sends none still gets the old base, so
  only mining changes today. **Craft, kill, hit, hurt and cast still emit no value and are still flat** -
  that is the next weight-tuning job and it is gamemode/TS work, not design work.
- [x] `labour.js`: a finished round emits `'mine'` with the ore band (0..4, the index in
  `miner.oreByTier`) as `value`, or `'chop'`. Copper 1.0 units, ebony 2.0, chopping 1.0, against 0.5 for
  everything before. A Novice level is 10 units, so a Novice miner is now **10 copper veins, not 20**.
- [x] `gamemode.js:1414`: the reading mini-game emitted `'activate'` too; now `'read'` (1.0). Same one-line
  bug, same fix, included because it is the same rebuild. The coin purse at `:1486` stays `'activate'` -
  there is no better kind for it.
- [x] `tests\labour-harness.js` grew five cases: the kind, the ore band as `value`, the refrId, `chop`,
  and that a *refused* round emits nothing. **All 37 checks pass.**

### Shrines, deities and prayer - built end to end, untested in play

- [x] **`server\prayer.js`** (new, hot-reloads like `labour.js`): the shrine index, the own-shrine rule,
  the three-verse hold, the blessing roll, the per-shrine hour, the conversion cooldown, and
  `__alduinakMasteryEvent('prayer', a, { refrId })` on a completed prayer. Hooked into the activate chain
  right after `__dboLabour`; a target that is not a shrine `return false`s and the chain carries on, per
  `gamemode-activate-chain-runs-before-systems`. Boots: `prayer on: 21 deities, 33 shrine ids, 9 reachable
  under the region lock`. Added to `/selftest`.
- [x] **Front widget `prayer`** (id 35), `fork\skymp5-front\src\features\prayer`. Built, deployed to both
  `Skyrim Special Edition - dev\Data\Platform\UI\` and `server\client-dist\...`, both greps confirm
  `prayer__shrine` in the deployed bundle; backup in `_ui-build-backups\before-prayer-20260920-103728`.
  **No client rebuild was needed** - `dboRelayService` passes a widget payload through verbatim, so the
  three-hop rule does not bite a widget with no typed client mirror.
- [x] **`tests\prayer-harness.js`** (new), the same pattern as the labour harness: 37 checks, all passing.
  It covers the honest hold, a 300 ms flicker forgiven and a 3 s release refused, a report that outruns
  the server's clock, one played in slow motion, one that arrives ten minutes late, spans that overlap,
  leave the round, are fractional, are still open at the report, start late, or flood; a replayed nonce;
  the shrine's hour; the conversion cooldown and the blessing taken back on conversion; a round surviving
  a gamemode reload; and a shrine named by reference not matching its base's other statues.

### Three things the deity design said that were not true

`DEITY_DESIGN.md` was written at 03:10 from a reading of the data rather than a measurement of it. All
three are corrected in the doc, with the measurement beside them.

- **"Every shrine id in skills.json is a Skyrim shrine, so prayer is unreachable under the Bruma lock."**
  **No.** The ids are *base objects*, and Beyond Skyrim Cyrodiil places the vanilla Skyrim shrine bases
  through its own chapels. `ShrineofAkatosh` stands 39 times, 17 inside the lock, one in
  `CYRBrumaCathedralofStMartin`. **All nine Divines already had reachable shrines in Bruma county.**
  There was no blocker.
- **"The choices list holds only the nine Divines."** **No.** It has held 21 entries since `60eabb7` on
  2026-09-16, including eleven Princes. The doc was written from `praying.shrines`, a nine-entry duplicate
  index sitting beside the real list. That duplicate is now labelled; `deities.choices` is what the server
  reads.
- **"The Divines have vanilla `BlessingOf*` spells."** **No such record exists anywhere in this load
  order.** The real one is `Altar<Deity>Spell`. Fifteen of the 21 deities have one; six do not.

### The census the above rests on

- [x] **`ck-mcp\shrines.py`** (new) writes **`server\shrine-placements.json`**: for every shrine named in
  `skills.json`, how many REFRs place it, how many are inside `playtest.allowedWorlds`, and how many are
  in Bruma county (the only released, walkable part of BS Cyrodiil - Kvatch is in the plugin and is not).
  Re-run it with `py ck-mcp\shrines.py` whenever the load order changes.
- **Not one Daedric Prince has a shrine in Bruma county.** Nine of eleven have one somewhere; Mehrunes
  Dagon and Molag Bal have none placed at all. Under the region lock, only the Divines can be prayed to.
- Seven of the nine Cyrodiil wayshrine bases (`BSHeartland.esm:061B53`-`061B5A` bar Dibella) have **zero
  placements**. They were added to the Divines anyway - correct bases, no cost - but they were never the
  thing that made prayer reachable.
- **A shrine id may be a base or a reference and both are deliberate.** Meridia names the Kilkreath REFR
  on purpose (this file, 2026-09-14) because its base `DA09MeridiaStatue` also stands four times in
  `CYRCrowhavenBurialHalls` as scenery. `prayer.js` indexes both and matches the reference first; a first
  pass that "fixed" Meridia to its base was reverted when this entry was found.

### skills.json, changed and read at boot

- [x] Every Divine's `shrines` is a list holding the Skyrim base and the Cyrodiil wayshrine.
- [x] `conversionCooldownDays` 30 -> **7**.
- [x] `blessing` is now a real form id on the 15 deities that have one, with `blessingEditorId` beside it;
  the other six keep their `<author: ...>` placeholder and a prayer to them logs "no spell record".
- [x] Every choice carries measured `placements` / `inPlaytest` / `inBruma`, so a picker can grey out a
  god nobody can reach without re-deriving anything.
- Backup: `skills.json.bak-20260920-102553`. **This is a live file outside git.**

### Not done, and why

- [ ] **Unarmed's five marker spells** (`DBO_Skill_unarmed_T1..T5`) - boot still says
  `5 marker spell(s) missing`. **I stopped at the measurement.** `ck-mcp\markerspells.py` (new) dumps the
  exact record: an **empty Ability** - `EDID`, zeroed `OBND`, `FULL` = "Skill: <id> tier <n>",
  `ETYP 443f0100`, empty `DESC`, `SPIT` type 4 / ConstantEffect / Self / cost 0 / no perk, `EFID` null and
  a zeroed `EFIT`. No magic effect at all; it exists only to be a `HasSpell` condition target. 85 of them
  live at `DragonBreak Online Edits.esp:111270`-`1112C4`, contiguous, and the shrine activators start at
  `1112C5`. So the write is `wbCopyElementToFile(DBO_Skill_onehanded_T<n>, target, AsNew, Deep)` five
  times with a new EDID and FULL. **I did not run it** because headless SSEEdit still needs a
  `BM_CLICK` on the Module Selection dialog that once cost an 8-hour hang, a plugin edit must be copied
  into `server\data\` *and* the dev Data with node stopped, and the payoff is currently zero - nothing
  authors a `HasSpell` condition on Unarmed yet. Worth folding into the next xEdit pass, alongside the
  six Daedric blessing SPELs.
- [ ] **The deity picker after the race menu** (Nat's brief) - front work, not built. `/deity <name>`,
  said while standing at that god's shrine, is the stopgap and is the only way to take a god today.
- [ ] **Nothing knelt at a shrine.** The whole prayer path is harness-verified and log-verified only.
  First in-game test: stand at any shrine in Bruma Cathedral of St Martin, expect the widget; the boot
  line and `prayer held/refused(...)` in `server.log` are the instruments.
- [ ] Left alone deliberately: the native build, the starting-spell bug, the join path,
  `Refr pointer expired`, bot load testing. Nothing here was pushed to git.

### Two observations worth a look, not acted on

- **Widget id 33 is used twice**: `gamemode.js` `SKIN_WIDGET_ID = 33` and `labour.js` `WIDGET_ID = 33`.
  Sharing one modal slot may well be deliberate, but opening one while the other is live would replace
  the widget and strand the first session server-side. Prayer took 35 to stay clear of it.
- **Tin and stalhrim can never be mined.** Both are in `labour.js`'s `ITEMS` and `oreYieldByOre` but in no
  tier of `miner.oreByTier`, and `oresUpTo()` refuses anything absent from that list.
  **Checked 2026-09-20 13:30: not a bug, do not "fix" it.** There is no `MineOreTin` or
  `MineOreStalhrim` vein in this load order at all, so there is nothing for a tier to unlock. The ores
  that are placed but unmineable are **blackreach** and **heartstone**. See the 13:30 block.

## Added 2026-09-20 (03:15): unarmed, combat openings, the Lorkhan menu pass and the racial stat spread

All four shipped and deployed in one client/front/server/plugin round. Server restarted 02:53:20, boots
clean at the known 18-error baseline, `[skills] ready: 18 skills`.

- [x] **Unarmed, "The Closed Fist"** - skill 18, combat. `skills.json` entry plus a guard in
  `masterySystem.weaponClass` that names `Skyrim.esm:0001F4` directly rather than trusting its DNAM byte,
  matching the test the C++ damage formula itself uses (`TES5DamageFormula.cpp` `IsUnarmedAttack`).
  `WEAPON_CLASS` already mapped DNAM 0 to `HandToHand`, so this was mostly data.
- [x] **Combat skills can be opened at last** (the nine-skill hole, now six of it). Shadow progress: an
  unopened combat skill banks its units in `prog.shadow` at level 0 - costing no pool and staying out of
  `order` - and at a level's worth (`P.unitsForLevel(1)` = 10 at Novice) offers itself. `masteryTakeUp`
  spends the pool point and **replays the banked units**, so work done before accepting is credited.
  Three hops wired: `masterySystem.onTakeUp` + `offers` in the menu payload, `masteryService` events map
  and packet, front button.
- [x] **K menu, Lorkhan pass** - an eight-spoke Wheel behind the pool count whose spokes light as it fills,
  locks coloured as Masser (amber, Waxing) and Secunda (silver, Held), the take-up offer as a warm call to
  action. Appended as its own block at the end of `masteryMenu/styles.scss` so the pass lifts out cleanly.
  **Confirmed in game by screenshot.**
- [x] **The racial stat spread is live** (`RACES_DESIGN.md` section 2). Ten RACE overrides written into
  `DragonBreak Online Edits.esp` by `SSEEdit 4.1.5f\Edit Scripts\DBO_RaceStats.pas`, verified by re-running
  the read-only report, **and confirmed in game: an Orc reads MAGICKA 80 / HEALTH 105 / STAMINA 115.**

**Three facts the plugin pass established, all measured:**

- **Vanilla RACE DATA is `50/50/50`, carry 300, regen 0.7/3.0/5.0 - identical across all ten races.** The
  player's 100 is race(50) + the **Player NPC_ offset of +50** (`DBO_PlayerOffsets.pas`), so the script
  writes *target minus 50*. Writing the design numbers directly would have made every race 50 points strong.
- **`Unarmed Damage` is already 10 for Khajiit and Argonian against 4 for everyone else**, and
  `CalcUnarmedDamage` returns exactly that field. Khajiit claws were server-authoritative before the skill
  existed. The pass leaves the field alone.
- **`server\data\` is a separate copy of every plugin**, not a junction to the dev Data folder. The pass
  edited the dev copy; the server would have kept vanilla values while the client showed the new ones, with
  nothing logged. Synced both. The running server memory-maps its copy, so node must be stopped first.
  Memory note: `server-data-is-a-separate-plugin-copy`.

- [ ] **Unarmed's five marker spells do not exist** - boot says `5 marker spell(s) missing`. Harmless for
  damage and crediting (both read `rank`), but plugin-side conditions cannot key on Unarmed until
  `DBO_Skill_unarmed_T1..T5` are created.

## Added 2026-09-20 (03:15): the starting-spell bug is C++, and the cause is now known exactly

**Nat's observation closed it: a character spawns as the Player record - which is a Nord - and is only then
thrown into the race menu.** Everything follows from that.

- `MpActor::GetBaseSpells()` draws from the base NPC_ record (`7:Skyrim.esm`, the vanilla **Player**, whose
  `RACE` is **NordRace** - confirmed by dumping the record, not inferred) and from the chosen race via
  `appearance->raceId`.
- `playersInheritBaseSpells: false` **is set, is read, and works** - but it filters only the NPC_ list. The
  race loop at the end of the function pushes `raceData.spells` **unfiltered**.
- The CreateActor message is built **at login, while the character is still a Nord**, so its spell list
  carries Nord abilities. That is why an Orc holds **Battle Cry and "Your Nord blood gives you 50%
  resistance to Frost"** - screenshotted.
- It also defeats the client fix shipped earlier tonight: `rememberServerSpells` stores that login-time list,
  so re-enforcing after the creator faithfully re-applies the Nord spells.

- [ ] **Fix (C++, native build):** apply `skipCastable` to the race loop as well, **and** recompute the
  spell list after character creation rather than reusing the login one. The client half is already correct
  and will match whatever list arrives.

## Added 2026-09-20 (03:15): the native binary is six days stale - highest-value single action

Every `scam_native.node` on disk is dated **2026-09-13 23:44** and none contains `movementValidation` or
`snapBackIntervalMs`. Three commits sit in source, built into nothing:

- `d6f39a2` movement: validate a player's own packet before relaying it
- `e1678f4` movement validation: time-aware per-actor rate check
- `4f97e32` movement validation: speed ceilings in server-settings

`HANDOFF.md` recorded movement rate validation as **landed** on 09-19; it landed in *source* and has never
run, while the competitive analysis calls it the top remaining security hole. Caught because the C++ logs
`movementValidation:` unconditionally at boot and that line is absent from `server.log`.

- [ ] **One native build (CI flatrim, or the manager's Native button) ships the movement validation, the
  starting-spell fix and `vanillaLevel` together.** Claude cannot run it.

## Added 2026-09-20 (03:15): deities designed, not built

`server\DEITY_DESIGN.md` written from Nat's brief. **Most of it already existed** in `skills.json` under
`deities` and `praying` - the own-shrine rule, the hold-through-three-verses mini-game, 2% for everyone
against a priest's 5/10/15/20/30% by tier, the 60-minute per-shrine cooldown, and `priestActivityPoint`.
The `prayer` event kind is already in `masterySystem`'s candidate map; nothing emits it.

- [ ] Three changes asked for: conversion cooldown **30 days -> 7**, conversion moved onto a menu key rather
  than `/convert`, and the Daedric Princes added to the picker.
- [ ] **Blocker found while looking up shrines: every shrine id in `skills.json` is a Skyrim shrine, and the
  playtest is region-locked to Bruma.** Prayer is unreachable today. Beyond Skyrim's wayshrines cover all
  nine Divines (`BSHeartland.esm:061B52`-`061B5A`); each shrine entry must become a list of both.
- [ ] Only Malacath, Nocturnal, Azura, Mephala and Boethiah have shrine activators in this load order. The
  other twelve Princes would need placements. Recommendation in the doc: restrict the picker rather than
  offer a deity nobody can pray to.

## Added 2026-09-20 (02:00): four client fixes from the first real play session - built, deployed, UNTESTED

One client build (02:01) carries all four; they need a relaunch, not a reload. Deployed to both
`Skyrim Special Edition - dev\Data\Platform\Plugins\` and `server\client-dist\...`, identical, type-check
clean.

- [ ] **Spells stick on a freshly created character.** `SPELL_ENFORCE_PASSES = [1, 3, 6, 10, 15, 20]` runs
  only after CreateActor, and the race menu grants race + Player-record spells as it *closes*. Measured on
  the live log: JOIN 01:49:31.838, last pass +20 s = 01:49:51.8, "Character creation finished" 01:49:52.078 -
  **240 ms too late**, so nothing ever reconciles again. The earlier character was 165 s out, same result.
  This is also why a plain login *did* strip them ("gives you stuff then takes it away") - same cause,
  opposite symptom. Fix: `sync/spell.ts` gained `rememberServerSpells`/`reenforceServerSpells`, `remoteServer`
  remembers the list from CreateActor, and `charCreatorService.close()` re-runs enforcement at 1/3/6/10 s.
  **Correct regardless of the server flag**, because the client simply matches whatever list arrives.
- [ ] **The bare "E" on doors was an unreachable guard.** `doorNameFor` has a 2 s timeout so "a lost answer
  must not hide the door for good", but the only caller that can fire it is the 500 ms poll in `onUpdate`,
  and that poll was gated on `this.promptShown` - which is false precisely because the prompt is hidden. The
  recovery was guarded by the condition the bug creates. Fix: ungated the poll. Note the service keeps the
  vanilla key glyph on purpose ("the vanilla key glyph stays"), so a null prompt shows a bare E rather than
  nothing. The **container** case is NOT diagnosed - `verbFor` handles Container, so it is a different path.
- [ ] **The HUD painted over the vanilla race menu.** `Menu.RaceSex` is already in `browserService.badMenus`,
  so the browser *is* hidden for it - but `interactionPromptService.apply()` called `browser.setVisible(true)`
  guarded only by `isUiHidden`, which is the **F2 manual toggle** and knows nothing about blocking menus. On
  every crosshair change and every poll it repainted the whole HUD over the creator. `chatService` does the
  same once at mount, which is exactly when the race menu is open on a new character. Both now check
  `isGameInputBlocked` (browser focus + console + blocking menu). Nothing is lost by skipping: `browserService`
  re-shows the browser when the last blocking menu closes.

**Server-side, applied and restarted 01:46:31:** `"playersInheritBaseSpells": false` added to
`server-settings.json` (a live file outside git; backup at `server-settings.json.bak-20260920-014618`).
The C++ reads it beside `serverKey`/`movementValidation`, the live `scam_native.node` carries it (built
2026-09-13 23:44, after `MpActor.cpp` was last touched at 23:05), and `enforceSpells` genuinely removes -
it builds a `toRemove` list of everything not on the server's list. **Still unverified in play**: the only
test since was another fresh character, which the creation-timing bug above defeats.

**What the spell plumbing actually is**, corrected from two earlier wrong guesses in this session:
`learnedSpells` on the change form is the list of spells **the server granted** (admin grants, mastery
marker spells) - which is why the admin character had 131 and a fresh one has 0. Race and Player-record
spells never enter it; `MpActor::GetBaseSpells()` adds them to the CreateActor *message* only, deliberately
("Base NPC_/race spells ride along so the client's spell reconciliation does not wipe Flames/Healing").
Race spells come from `appearance->raceId` (the chosen race, correctly giving an Orc Berserker Rage); the
base NPC_ is `7:Skyrim.esm`, the vanilla **Player** record, which is a Nord - **that is where Battle Cry on
an Orc comes from**, and `playersInheritBaseSpells: false` will not remove it because the filter only drops
`SpellType::Spell`, not powers.

## Added 2026-09-20 (01:15): the level/points mismatch is FIXED, built, deployed, server restarted

`SkillProgress.level` is now the canonical field in `masterySystem.ts`, and `points` is written beside it as a
**derived legacy shim** on every save, exactly as `order` and `rank` already are - so `gamemode.js`,
`labour.js` and `dungeons.js` read what they always read and needed no change. The v2 read takes
`src.level ?? src.points`, so a record written by the broken build degrades to its old value instead of
resetting. 27 sites changed, all in one file; no other TS file referenced `.points`.

- [x] `tsc --noEmit` clean, **110/110 maths checks still pass**, bundle deployed to `server\dist_back\`.
- [x] Verified in the *minified* bundle, not just the source: `.level??l.points` (the read fallback),
  `.points=i.level` (the shim) and `rises to ${d.level}` (the notice) are all present.
- [x] Server restarted 01:11:49, boots clean: "point system ON: pool 300, cap 100...", **18 errors, the same
  count as the last known-good boot** (the `ScampServer.cpp:1084` context noise).
- [x] **Phase 0 instrumentation fixed in the same pass**: `creditPoints` now counts `out.units` into
  `creditStats.credits` and increments `suppressed` when a character has no record, so the credit-rate log
  reports something under point mode. It measures **units**, not levels - a level is far too rare to tune
  weights against - and the formatter now rounds to one decimal.
- [x] **PROVEN IN PLAY, 01:38-01:41**, on a fresh character (`Stranger #GKFP`, mastery null at creation).
  First touch wrote `woodcutter { level: 1, points: 1, xp: 0 }` - both the canonical field and the derived
  shim. **Re-read 90 s later the level was still 1**, with `xp: 5`, `spentToday: 0.5`, a populated `ring`,
  and `miner` opened alongside it; `order` derived to `["woodcutter", "miner"]`. Under the bug the level came
  back 0/null on every read. The `xp: 5` also confirms the predicted arithmetic exactly: one `activate`-weighted
  round is 0.5 units and a Novice unit is 10 xp.
- [x] **The Phase 0 fix is proven too**, same session: `credit rate (last 15 min, 1 character(s)): events
  activate 10 | credited miner 2, woodcutter 0.5`. That line read "credited none" every time under the old
  code. First real tuning datum: **10 activate events, 5 units credited** - half the activations were on
  things that are neither vein nor block.

## Added 2026-09-20 (01:20): the charcoal chain (Nat's side note) - designed, not built

Ingots should require charcoal, better ingots better charcoal; firewood feeds a kiln; a tiered Woodcutter may
work a saw mill for bulk wood every 30 minutes. Written up as **`SKILLS_DESIGN.md` §13** with what already
exists checked rather than assumed:

- The **woodcutting mini-game already exists** (`chop()`, 4/8/12/16/20 strikes by tier, pays 3-8 firewood).
- The **30-minute saw mill is already the written design** (`skills.json` §minigames `lumberMill`), and
  `LumberMill`/`FarmLumbermill` are already in the woodcutter's gates and activate prefixes - but
  `__dboLabour` dispatches only `MineOre*` and `WoodChoppingBlock*`, so a mill does nothing today.
- **Charcoal grades are half designed**: the tier names already say rough/good/fine charcoal and `CharcoalKiln`
  is gated, but there is no charcoal item, no kiln handler and nothing consumes it.

- [ ] The genuinely new work is the **dependency**: charcoal items (plugin), a kiln handler, a mill handler,
  and ingot recipes that spend charcoal by grade. The recipe gating belongs in the same xEdit pass as the
  crafted-only ebony/daedric `HasSpell` conditions, not a separate one.
- [ ] **Do not start before the point system keeps a level.** A supply chain resting on a skill system that
  discards progress cannot be tested.

## Added 2026-09-20 (01:10): the point system does not persist a level - BLOCKER, found in play

Two in-game sessions tonight (01:00-01:07). Mining and the forge both work; **nothing is kept**.

**The bug: the two modules disagree on the field name for a skill's level.**
`masterySystem.SkillProgress` calls it `points` (`:104`, commented "the level itself under pointSystem").
`skillPoints.PointSkill` calls it `level`, and every function writes `s.level` (`:266`, `:273`, `:277`, `:287`).
They meet through four `as unknown as P.PointRecord` casts (`:352`, `:424`, `:1097`, `:1121`), which switch
off type checking at exactly the seam. The fatal line is `:1083`, inside the **v2** branch:

    const level = v2 ? Math.floor(Number(src.points) || 0) : ...

`firstTouch` writes `level: 1`; the next `read()` asks for `src.points`, gets undefined, and the level is 0.

**Measured, not inferred.** Argy's record right after first touch was clean
(`miner: { level: 1, xp: 0, lock: "raise", rank: 0 }`, `order: ["miner"]`). After six mined veins and six
forge uses it read:

    "blacksmith": { "level": null, "points": 0, "xp": 0, "spentToday": 2.35 },
    "miner":      {                "points": 0, "xp": 0, "spentToday": 0.5  },
    "order": [], "spentToday": 5.35

Both names on one object. `order` is empty because `derivedOrder` filters `level >= 1`. **`spentToday: 5.35`
is the proof of waste: the daily meter counted the work, the level never kept it.**

Knock-on: an empty `order` sends `labour.js`'s `tierOf` back to -1 on every activation, so first touch is
re-granted every single time.

Why the 110 tests missed it: they exercise `skillPoints.ts` alone, against `level`, where it is internally
consistent. The bug exists only at the boundary.

- [ ] **Fix (TS rebuild + dist_back + restart, not hot-reload):** make `level` canonical in `SkillProgress`
  and write `points` as a derived legacy field on save, exactly as `order` and `rank` already are, so
  `gamemode.js`, `labour.js` and `dungeons.js` keep reading what they read today. Make the v2 read take
  `src.level ?? src.points` so tonight's damaged records recover rather than reset.
- [ ] **Fold in while rebuilding:** `creditPoints` never touches `creditStats.credits`/`.suppressed` (they
  are only incremented at `:475`/`:462`, inside the old `creditHours` path below the `:460` early return),
  so the Phase 0 credit-rate log always prints "credited none | no skill chosen 0" under point mode. Phase 0
  measures nothing while the flag is on.

## Added 2026-09-20 (01:00): the first-touch deadlock in the hot-reload layer - FIXED, live

Mining refused with "Only a Miner can read a seam well enough to work it." and the trade could never be
taken up. `gamemode.js:638` runs `__dboLabour` **before** `__dboPrevActivate` - the chained hook
`masterySystem` installs at `masterySystem.ts:257`, which is the only thing that can grant first touch. When
`mine()` found no miner skill it called `deny()`, and **`deny()` returns `true`** (`labour.js:95`), so
gamemode returned false and stopped the chain. Refused for not being a miner; could not become one because
the refusal preceded the code that grants it.

Verified rather than assumed: no KYWD named `MineOre` exists, so the gate falls to an editor-id prefix;
veins are ACTI `MineOreIron01_LReachGrass` and friends, which do match `mineore`; and `private.mastery` was
absent from the change form after the attempts, proving the gate never ran.

- [x] **Fixed in `labour.js`**, hot-reloaded 00:58:27 clean: `mine()` and `chop()` now `return false`
  (not handled) instead of denying when the tier is -1, so the chain reaches the first-touch gate. Costs one
  extra activation: the first opens the trade, the second starts the minigame. Confirmed working in play.
- [ ] **Same shape, not fixed, and falling through would not help:** `gamemode.js:1388` ("Only a Scholar may
  read the books of the world") - scholar has no gate station at all, so there is nothing downstream to open
  it; `gamemode.js:1650` ("Only a Skinner can take the pelt") - skinner opens at a **tanning rack** only,
  never from a corpse.

## Added 2026-09-20 (00:55): nine skills have no opening move under point mode

`creditPoints` skips any skill with no record (`:418`, "a trade is opened at its station, not by accident")
and `firstTouch` fires only from the station loop at `:349`, which tests `gateStations`/`gatePrefixes`.
Checking `gates.stations` across `skills.json`:

- **Can be opened (8):** blacksmith, alchemist, woodcutter, miner, tailor, skinner, enchanter, cook.
- **Cannot be opened (9):** twohanded, onehanded, archery, defense, arcane (**all five combat**), plus
  scholar, priest, lockpicking, harvesting.

Harvesting is a near miss: it declares `gates.nodes: true`, and `gateNodes` is parsed (`:837`) and carried
into `ResolvedRules` (`:870`) - and **read nowhere**. The same dead-field shape as `blockEvents`, already
flagged in `SKILLS_DESIGN.md` §5.

Under the old system these opened by being chosen in the menu. Point mode removed choosing, and design §5.3
solved only the mirror case - the station that refuses a skill you do not hold. A skill with *no* station
fell through.

- [ ] **Design call, for Nat, not to be picked unilaterally:** opening a skill on its first credited act is
  the obvious mirror of §5.3, but it contradicts the "not by accident" rule - one stray arrow would spend a
  pool point on Archery. Combat probably needs a different opening rule than trades do.

## Added 2026-09-20 (01:05): mining credits at half weight, and the ore band is dead code

`labour.js:311` emits the event as kind **`activate`**, not `mine`. In `weightOf`, `mine` is
`1 + min(1, band/4)` (1.0-2.0) while `activate` is a flat **0.5**. Nothing anywhere emits `mine`, so the
ore-band term never runs. Sharper than the existing "per-act inputs are not wired" note: the *kind* is wrong,
not just the value. At Novice (10 units per level) one vein is 5 xp, so a level is **20 different veins**
(each rests 45 minutes).

## Added 2026-09-20 (01:08): no crash after either logout tonight

Logouts at 00:57:44 and 01:07:28, server up continuously since 00:34:48. The 00:32:51 heap corruption did
not repeat. Still one data point, still no dump.

## Added 2026-09-20 (00:45): the K menu chain verified statically, end to end

Not an in-game proof - a static trace of every hop, done before the next launch so that if the menu is
still wrong the fault is runtime, not deployment. All five links carry point mode:

- `server\skills.json` -> `pointSystem.enabled: true`.
- `sendMenu` emits `points: { enabled: true, pool: 300, ... }`; present in `server\dist_back\skymp5-server.js`
  (built 00:27, and the running process started 00:34:48, so it has it).
- The client mirror (`points: content["points"] ?? null`) and the browserside setter (`points: info.points`)
  are both in the deployed `skymp5-client.js` (00:38), byte-identical in the dev install and `client-dist`.
- `build.js` gates on `t.points && t.points.enabled` and holds the string "spokes of the Wheel"; deployed to
  both UI folders (00:27).

**Why it read "Skills 0/3" last night:** the client bundle carrying hops 2 and 3 was written at 00:38 and the
player's last session ended at 00:32. That bundle has never been loaded by a running game. The next fresh
launch is the first one that can show point mode.

**Crash, one theory killed:** the corpse-cleanup `Refr pointer expired` path is not involved - the crashing run
(`_server-logs\server-20260920-003210.log`) contains zero such lines. That run logs a clean disconnect at
00:32:09.34, one tick summary at 00:32:10.95, then 40 s of silence before the heap-corruption exit at 00:32:51.09.
The 09-17 access violation (14:31:39) has **no surviving log** - its run was rotated out of `_server-logs`, so
there is one data point, not a pattern. Nothing more is learnable without a dump.

## Added 2026-09-20 (early): skill point system, phases 0 and 1 of the engine

- [x] **Phase 0, credit-rate logging, LIVE in the bundle** (`masterySystem.ts`): one line per 15 minutes with
  events by kind, points credited by skill, characters involved, and how many events came from a character
  with no skill chosen. Nothing about crediting changed. This exists because every events-per-hour number in
  `SKILLS_DESIGN.md` is an estimate; one evening of real play replaces the guesses. Built, deployed and booted
  clean (0 errors beyond the known boot noise), then the server was stopped at the owner's request.
- [x] **The point arithmetic, as a tested module** (`fork\skymp5-server\ts\systems\skillPoints.ts`): levels and
  bands, xp per unit by band, the token bucket, daily caps, repetition decay on a persisted ring, structural
  caps (one Seat above 90, three above 75), donor selection for pool overflow, `applyGain` over a whole record,
  first touch, the derived `order`/`rank` shim, and the migration from the hours record. Kept pure and separate
  from `masterySystem.ts` so it can be exercised with no server: **110 checks in `server\tests\skillPoints.test.js`**
  (`node server\tests\skillPoints.test.js <bundled skillPoints.js>`; bundle it with
  `./node_modules/.bin/esbuild ts/systems/skillPoints.ts --bundle --platform=node --format=cjs --outfile=...`).
  Confirmed against the design's own numbers: 250/750/1750/2950/3950/5950 units per band edge, 8.3 to 198 hours
  saturated, 90->95 at least 17 days and 95->100 at least 34 at the Master daily cap, and every live character
  migrating into exactly the tier it already holds (10h->27, 70h->79, 150h->96, three maxed skills = 288 of 300).
- [x] **Wired into `masterySystem.ts` behind `pointSystem.enabled` in skills.json, which is OFF**: the live
  three-chosen-skills ladder is untouched until it is flipped. What the flag turns on: record v2 with lazy
  migration inside `read()` (hours to levels at 30 units an hour, locks set to raise for the old chosen skills
  and hold for the rest, `granted`/`respecs` carried over); `creditPoints` replacing the hourly tick, which tests
  every skill that could match the act through a new kind-to-skills index, weighs it, applies repetition decay
  from the persisted ring, meters it through the bucket and the daily caps, and takes pool overflow from a skill
  marked to fall; first touch at a gated station taking up a trade for one level instead of refusing; and
  `order`/`rank` written as derived fields on every save, so `gamemode.js`, `labour.js` and `dungeons.js` need no
  change. `rankFor` returns the band of the level when the flag is on.
- [x] Verified: type-check clean, 110 maths checks pass, and the server boots clean both ways (flag off reports
  "3 chosen, tiers at 0/10/30/70/150h"; flag on reports "point system ON: pool 300, cap 100, one skill over 90,
  3 over 75"), zero errors beyond the known boot noise in each. The bundle is deployed and the flag is off.
- [x] **The K menu was rebuilt for point mode and the flag is now ON** (`pointSystem.enabled: true`). The menu
  shows spokes of the Wheel out of 300, per-skill levels with a moon glyph, the level with a progress bar, three
  locks (Waxing / Held / Waning, after Masser and Secunda) and a level ladder instead of hours. Server sends
  `points` in `masteryMenu`, `masteryLock` sets a lock, and the client carries the field through all three hops.
- [ ] **Not yet proven in game**: no point has been earned by a player. First session next: launch fresh, open K
  (it must read "0/300 spokes"), use a forge or vein for first touch, work it for credits, then set a lock.
- [ ] **A widget field must be copied in three places** or it silently vanishes: `sendMenu` (server),
  `onCustomPacketMessage` mirror plus the `MasteryInfo` interface and its initialiser (client), and
  `browsersideWidgetSetter` (client, no spread allowed). This cost two rebuilds and two relaunches tonight.
  Memory note: `widget-payload-has-three-hops`.
- [ ] **Native crash, unexplained**: exit -1073740940 (heap corruption) at 00:32:51, ~40 s after a logout, no JS
  error. Watch for a repeat after logout; capture a dump rather than theorising.
- [ ] Still true before the flag is trusted: the weights use base values only - the per-act inputs (product
  value, target health, magicka cost, damage taken, ore band) are not wired, and the Phase 0 credit log is what
  should tune them.

## Added 2026-09-19 (late): four advertised-but-inert systems settled, each one measured

The four bugs the competitive analysis calls "confirmed" were each re-confirmed independently before
anything was touched, on an **isolated measuring server** (port 7790, the live `dist_back`, five base
masters) driven by the real-protocol bot in `server\tools\bot`. Everything below is a wire measurement or a
named line of C++, never an inference. The probe gamemodes and bot patches are throwaway and live in the
session scratchpad; the bot gained three roles worth keeping if it is ever rebuilt: it can now send
`UpdateEquipment` (needs `idx`, or the serializer throws), `OnHit` and `Host`.

- [x] **1. Mastery's combat half now changes damage. Fixed, measured, live in the hot-reload layer.**
  Confirmed inert first: `TES5DamageFormula` reads the weapon's base damage, the target's worn armour, the
  race's unarmed damage and the client's power/sneak/block flags — no skill and no mastery record — and
  `masterySystem`'s `SetActorValue` is a client-local snippet by the C++'s own admission. The audit's
  proposed home for the fix does not work: `onHitDamageAttempt` is a veto (`FireHitDamageEvent` returns a
  bool) and the engine applies its own number right after it. So `gamemode.js` notes the target's health in
  the attempt hook and takes the tier's extra share off in `onHitDamage` with `mp.set(id,'percentages')`
  (registered, server-side, delivered as `ChangeValues`). `MASTERY_DMG` is `{enabled, byTier:[0,0,.10,.20,
  .30], log}`, overridable from `gamemode-config.json` under `"mastery": {"damage": {...}}`; the weapon is
  classified from WEAP `DNAM[0]` exactly as `masterySystem` does, so only One-Handed, Two-Handed and Archery
  count. **Before/after, same target, real weapon hits from a bot:** Novice 6.71 damage = 19.2% of health
  per hit (100 -> 80.8 -> 61.6 -> 42.5); Master 6.72 engine damage dealt as 8.74 = 25.0% per hit (100 ->
  75.0 -> 50.1 -> 25.1). **+30.1%.** The bonus is clamped so it can never land the killing blow — a
  percentages kill reaches `MpActor::Kill` with no aggressor and champions, contracts and the mastery kill
  credit all read the killer. Seen firing: fourth hit, bonus cut 2.0 -> 1.7, health left at exactly 1.00%,
  and the engine's next hit took the kill.
- [ ] **In-game pass for mastery damage**: two characters, one with a chosen weapon skill at Journeyman or
  above, trade hits; `server.log` prints one `mastery damage <name> x1.30 on <name>: 6.7 + 2.0 (health ...)`
  line per boosted hit. Set `"mastery": {"damage": {"log": false}}` once it is trusted.
- [x] **2. Hunger's regen penalties now actually leave the server. Fixed, mechanism measured.**
  `ModActorValue` is not in the registered Actor method table (`PapyrusActor.cpp` registers `SetActorValue`,
  `RestoreActorValue`, `DamageActorValue`). Measured: the call logged `VirtualMachine::CallMethod - Method
  not found - 'ModActorValue'`, returned null, threw nothing (so the JS catch never fired) and put nothing on
  the wire, while `applyNeedsStage` recorded the penalty as applied. Every stage since the meter was built
  changed only the HUD number. The audit's suggested fix — regen caps in the ChangeValues path — is not
  reachable from JS either: `CropRegeneration` takes `max(baseValues.healRateMult, actorValues.healRateMult)`,
  so a lowered actor value cannot pull regen below the vanilla base, and no `mp` property writes those rate
  fields. `gamemode.js` now calls `SetActorValue` with an absolute `100 + stage%` and re-sends both rates on
  **every** login (the client's own save keeps the last value written, so a player who logged out Starving
  would otherwise keep a zeroed heal rate after eating). Measured: `SetActorValue` on the same actor arrives
  at the client as `{"class":"Actor","function":"SetActorValue","arguments":["HealRateMult",50]}`. One
  `needs <name> HealRateMult -> 50 (Hungry, -50%)` line per change in `server.log`. Honest limit: regen is
  computed on the owner's client, so this is the engine executing a server verdict; the server's own ceiling
  still caps a lying client, but a server-*enforced* cap needs C++.
- [ ] **In-game pass for hunger**: `/sethunger #TAG 95`, then watch health and stamina crawl back after a
  fight; expect the `needs ... -> 0 (Starving, -100%)` lines. Rejoin and confirm the rates are re-sent.
- [x] **3. NPC arming never reached anybody, and the CHECKLIST was wrong to call it verified.** A spawned
  `EncBandit01Melee1H` was given an iron sword and the exact `armLease` `EquipItem` call: the server's
  `equipment` change form was identical before and after (`numChanges` 1) and **nothing** reached the client
  — no SpSnippet, no UpdateEquipment, no SetInventory — while the same call on a player produced both. The
  mechanism is `SpSnippet::Execute`, which returns without sending for any actor that is not "created as
  player" (`formId >= 0xff000000 && baseId <= 0x7`); a spawned NPC's baseId is its NPC_ record. The old
  `armed` log lines only ever proved the JS ran. `dungeons.js` `armLease` now writes the inventory, drops the
  two dead Papyrus calls, and logs `armed ... (inventory; worn on the next host grant)`. See the two
  corrected entries further down this file (2026-09-15 and 2026-09-18).
- [x] **Found while testing it: a reproducible server segfault on the host-grant path (C++, one line).**
  `ActionListener::OnHostAttempt` writes `partOne.worldState.lastMovUpdateByIdx[remoteIdx] = now` at
  `ActionListener.cpp:1113` with no bounds check; the identical write in `OnUpdateMovement` (`:502-506`)
  resizes first, and movement updates are the only thing that ever grows that vector. Granting host of a
  reference whose idx is past the end is therefore an out-of-bounds vector write. Reproduced twice, both
  times a segfault about 30 ms after `Hoster of ff000001 changed from 0 to ...`: once with a spawned NPC
  (idx 61, vector length 1) and once with a placed **non-actor** (idx 61), which never reaches
  `EquipBestWeapon` and so rules that out as the cause. This is the likely identity of the open "segfault on
  granting host of a summon". Fix: resize exactly as `OnUpdateMovement` does.
- [ ] **C++ task queued with it: make server-side equipment reach clients** (`SERVER_AUTHORITY.md`
  migration 14). `MpActor::EquipBestWeapon` is the only function that turns inventory into worn equipment and
  fans `UpdateEquipmentMessage` out to every listener, and today it runs only at actor Init and on a host
  (re)grant — the crash above sits on that same path, so both belong in one session. Until then a spawned
  NPC's added weapon becomes visible only if a client takes the actor over after the inventory write.
- [x] **4. The third docs-vs-code contradiction (stamina/magicka on remote clones): the code was right, the
  CHECKLIST entry was wrong, and today's correction to it is now verified too.** Measured both halves on the
  wire. Old path: the bot sends `staminaPercentage` and `magickaPercentage` in its movement and the copy that
  reaches another client carries `['direction','healthPercentage','isBlocking','isDead','isInJumpState',
  'isSneaking','isWeapDrawn','pos','rot','runMode','speed','worldOrCell']` — both fields dropped by the C++
  serializer, exactly as the 2026-09-18 entry was corrected to say. New path: the observer bot receives
  `dboVitals` for the mover, `{"v":[4278190083,30,66]}` then 24, 18, 12, 6 as the mover ramped its stamina
  down. The relay works; no doc change needed beyond this confirmation.

## Added 2026-09-19 (late): SKILLS_DESIGN.md rewritten, two skills.json bugs fixed

- [x] **`server\SKILLS_DESIGN.md` replaced** with the point-system design the owner asked for (use-based
  0-100 per skill, pool 300, one skill above 90, gains only from server-verified events through a token
  bucket, no offline decay, five tiers kept as bands so every existing gate still works). Designed by three
  agents from different angles, scored by three judges, written against a read-only pass over the live code.
- [x] **Mining could be farmed for free** (`skills.json`): Bruma holds 169 `PickaxeMining*` FURN markers and
  `PickaxeMining` was in the Miner's `counts.activatePrefixes`, so a bare activation credited the skill with
  no minigame and no ore. Removed from `counts`, kept in `gates.stations` so the markers stay miner-only.
  **Needs a server restart** to take effect: `masterySystem.ts` reads skills.json at boot, not on reload.
- [x] **Ore tiers corrected** (`skills.json`, live on reload through `labour.js`): ebony was reachable at
  tier 3 (Expert) and is now Master-only; gold appeared in no tier at all, so Bruma's 22 gold veins refused
  every miner, and it now sits at tier 2 with orichalcum and moonstone. Tin is in no plugin, so it is not listed.
- [ ] **Correction to an earlier note**: Cyrodiil is not ebony-free and mining in Bruma is not copper-only
  (`CHECKLIST.md` said so). Beyond Skyrim places vanilla iron (120), corundum (66), silver (52), moonstone (28),
  gold (22), copper (14), malachite (12) and **ebony (4 refs, 2 veins) in `CYRRedRubyCave01`** - already a
  leased vampire lair. Tell players there is one ebony seam in the province rather than none.
- [ ] Blocking the "ebony and daedric are crafted only" rule: **no recipe carries a `HasSpell` condition yet**.
  All 85 marker spells exist in DLE, but nothing gates a forge recipe on them, so the crafting side is unenforced.

## Added 2026-09-19 (evening): swinging-axe trap arches re-enabled (plugin edit, NOT yet deployed)

Reported in game as "walls moving where the swinging axe trap should be, there's nothing there".
- [x] **Cause**: the blocker pass disabled and sank (z -30000) the arch a swinging blade hangs in
  (`STAT NorHallExSmPortcullis01`) along with the lever gates, while leaving every blade
  (`ACTI TrapBladeSwinging01`, 130 refs, none disabled) live. Axes swing in a bare corridor.
  The arch is the housing, the grate is a separate animated `NorPortcullis`: 39 of the 151 arches have
  their own gate at the same x,y, and a blade cannot swing through a solid panel.
- [x] **Fixed** with `ck-mcp\restore_axe_arches.py --apply` (2026-09-19 19:0x): removed DLE's override of the
  **45 arches that sit where a live blade swings** (15 cells: 3 + 3 in Bleak Falls Barrow, 5 Dawnguard,
  3 Solstheim, the rest Skyrim), so the vanilla record wins again - enabled, original z, same position,
  rotation, scale. Each target is re-derived from the records at run time and must be a two-version chain
  whose override differs from vanilla only in the disabled flag and z. DLE 29,287 -> 29,242 records; validate
  ok, HEDR matches, 0 unresolvable form ids; inventory diff shows exactly 45 removed, nothing else altered.
  Backup in `ckmcp-backups`.
- [x] **Gate grates stay out** as the user asked: 147 `NorPortcullis` and 39 `NorPortcullisLarge01` still
  disabled. The **75 arches with no blade** at their spot were left alone (27 are housings for a removed gate;
  the rest may block a route) - revisit only if something looks wrong in game.
- [x] **Deployed 2026-09-19 23:2x**: both servers and the loadtest harness stopped (they hold the plugin open),
  then the dev copy copied over `server\data\`. All three paths are md5 `23deb7f4`, 3,986,835 bytes.
  Note `server\tools\loadtest\sandbox\data\DragonBreak Online Edits.esp` is a **hard link** to `server\data\`'s copy
  (one inode, two links), so the sandbox always sees the same file - and its `server-settings.json` carries the
  full 105-plugin load order, so both servers lock the plugin while they run.
- [x] **Survived the 2026-09-20 14:50 rewrite of DLE** (md5 8e615b1f, 4,339,991 bytes, 29,316 records; someone
  resaved the plugin in the CK). Re-checked 15:01: `restore_axe_arches.py` finds 0 arches to re-enable and the
  three Bleak Falls arches resolve to Skyrim.esm alone, enabled at z -2304. Diff against the post-edit inventory:
  74 records added (37 REFR, 16 SPEL, 10 RACE, 10 ACTI), 0 removed, 858 modified - but the modified ones are
  mostly CELL/REFR bodies re-serialised with identical flags, which is what a CK resave does. **When diffing this
  plugin, compare meaning (flags, position, base), not body hashes.**
- [ ] **Still unverified in game**: relaunch the client and look at Bleak Falls Barrow's axe corridor. The arches
  are statics, so the client's copy is what shows them.
- [ ] **Still open**: the pale blue panel in the two screenshots is NOT this and is unidentified. Ruled out:
  DragonBreak curation (Toadstool Hollow has no overrides at all), broken trap/marker/fog meshes (no loose
  copies), a missing black-plane texture (`textures\Black.dds` is in Skyrim - Textures0.bsa). Need `/whereami`
  standing at one, then `refs_near`.

## Added 2026-09-19 (late): province-locked loot, and two live loot bugs fixed (LIVE 23:01)

- [x] **`ck-mcp\loot.py` now tags every entry with `p` = the provinces it may be looted or made in**, and
  includes Beyond Skyrim items for the first time (the old `VANILLA` set had none, so Bruma chests held only
  Skyrim and Solstheim gear). A missing `p` means Tamriel-wide, so an older `loot.json` still works. The rule is
  ordered: explicit exceptions, then culture marks in the editor id, then the material keyword family, then the
  origin plugin — **material cannot come first** (`ForswornSword` carries `WeapMaterialIron`) and origin cannot
  decide alone (BS hands out vanilla iron and steel in Bruma).
- [x] **Beyond Skyrim's own distribution is the authority for Cyrodiil**: the generator flattens every LVLI,
  CONT, NPC_ and OTFT owned by BSHeartland/BSAssets plus everything placed in BS cells (5,009 roots to 7,153 leaf
  items) and unions `cyrodiil` onto them. Without it, vanilla items with no material keyword fell through to
  Skyrim and Bruma lost 544 records BS itself distributes, including Nirnroot, the Amulets of the Nine and every
  staff. It cannot import Solstheim: zero Dragonborn.esm records appear in BS lists.
- [x] **`server\dungeons.js` filters by province and by context**: chest, urn and corpse loot and `weaponFor` /
  `arrowFor` all draw through `lootOk(lease)`. Three context rules: the one Cyrodiil nordic ruin
  (CYRNorthfringeSanctum) admits draugr gear, Ayleid and Ancient Imperial arms appear only in Ayleid ruins (Anga,
  Rielle, Sedor, Vilverin), goblin gear only in goblin dens (Silvertooth). A faction's own gear bypasses the
  province test, but the filter is applied to the whole weapon pool first, so an empty faction filter can no
  longer fall back to Solstheim weapons in Bruma.
- [x] **Live bug: no potion dropped from any chest at any difficulty.** The generator admitted an ALCH only if
  its editor id contained "potion", but vanilla potions are `RestoreHealth01`, `CureDisease`; the 37-record pool
  was all junk and `potionPool` returned an empty array at all four tiers. Potions are now admitted by name
  pattern and ranked numerically (01 Minor to 06 Ultimate, Resist 25/50/75/100): tiers per province now 5 / 8 /
  138 / 151.
- [x] **Live bug: 149 non-playable records were being handed out as chest loot** (house-building tokens, Dremora
  gear, gags). The record header's Non-Playable flag is now honoured, along with prop/dev-leftover and
  quest/unique filters that are prefix-tolerant for BS ids (the Cloud Ruler Blades swords were reachable).
  County guard livery, order regalia and the 53-weapon Akaviri pack are held out of generic chests.
- [x] `GEAR_BY_DIFF.story` 45 -> 60: the cheapest two-hander is IronGreatsword at 50, so Novice two-handed NPCs
  had an empty weapon band (true before this change too).
- [x] Checks: generator output is byte-identical to the reviewing agent's independent build except one food item;
  a simulation of the real draw code over six province/context cases at every difficulty had 0 out-of-province
  items and no empty pool. Reviews: one data, one lore, then a full revision that re-measured everything.
- [ ] Owner decisions still open: Dawnguard gear stays out of Cyrodiil although BS dresses its own Bruma vampires
  in 19 of those pieces (two Bruma dungeons are vampire lairs) — deleting `|^DLC1` from `OVERLAY_DENY` admits
  exactly those; the Akaviri pack needs a deliberate home (admin catalog, vendor or a Cloud Ruler relic source);
  out-of-province gear on vendors at a markup when vendors exist.

## Added 2026-09-19 (evening): movement rate validation in C++ (built, NOT deployed, NOT measured)

Closes the top half of `SERVER_AUTHORITY.md` migration 2. Branch `movement-rate-validation`; it is C++, so it
needs a CI flatrim build and only `scam_native.node` is copied out of the artifact (see the deploy note below).

- [x] **The check.** `MovementValidation` keeps, per player actor, the last position it accepted and a token
  bucket of allowance that refills at the speed ceiling. A packet spends the distance it claims; one that
  cannot pay is refused with the existing `isMe` snap-back (one per 250 ms), and refusals are logged at most
  once per 5 s per actor with a count. Horizontal, up and down budgets are separate. The 4096-unit single
  packet cap and the cell check are unchanged and still run first.
- [x] **Server teleports do not trip it.** A teleport is detected by the server's own position having moved
  since the last accepted packet, which covers `MpActor::Teleport` (every `mp.set locationalData`, Papyrus
  MoveTo), door activation, respawn and the login change-form load without hooking any of them. It reseeds
  the bucket at the destination and opens a 5 s grace in which the player's in-flight packets from the old
  spot are dropped WITHOUT a snap-back, which also fixes the old race where such a packet reverted the
  server's position. The carry/restraint slide renews the grace on every move, so it never rubber-bands.
- [x] **Hosted NPCs are left alone** (`isMe` only): refusing an NPC's move with no correction path is exactly
  the frozen-copy, unkillable-enemy bug in C++ task 1 below. Fix that first, then consider NPCs here.
- [x] **A player's own movement is validated before it is relayed** (`SendToNeighbours` used to run first), so
  a refused packet no longer reaches other clients. Hosted actors keep the old order.
- [x] **Ceilings come from the game data, not a guess** (`ck-mcp` load order, MOVT records): the player's own
  movement types are `NPC_Default_MT` 370 u/s run / 80 walk and `NPC_Sprinting_MT` 500 forward;
  `Horse_Default_MT` 450 run and `Horse_Sprint_MT` 600 are the fastest a player can legitimately be;
  `WerewolfBeastSprint_MT` 531, `VampireLordSprint_MT` 600. `fJumpFallVelocityMin` 700 is where fall damage
  starts. First ceiling: 1000 horizontal, 2000 up, 4000 down, 3 s burst.
- [x] **Tunable without a rebuild**: `server-settings.json` `movementValidation` (live file, read at boot).
  Shipping with `"enforce": false`, which logs "would refuse" and changes nothing, plus `peakLogFraction` 0.5
  so every player peak above 500 u/s is logged for calibration.
- [ ] **Measure (user, in game).** `server\movetrace.js` is loaded and records per-player speed from the
  server's accepted positions: `/mv <label>` before each activity (walk, run, sprint, sneak, jump, fall,
  shout, door, tp, dungeon, bounce), `/mv report` at the end. Output: `movetrace` lines in `server.log` and
  `server\_diagnostics\movetrace.json`. Delete `movetrace.js` and its require block in `gamemode.js` after.
- [ ] **Then set the real ceiling** from the measured maxima plus lag slack, flip `"enforce": true`, restart.
- [ ] **Deploy note**: take ONLY `scam_native.node` from the CI `server-dist` artifact into `server\` (back up
  the old one first). Do NOT copy `dist_back\` from the artifact: the bundle now running was built with
  another session's uncommitted `npcSpawnSystem.ts` fix, which is not on the branch.
- [ ] **In-game test list after deploy**: sprint, a long fall, a horse if one exists, a door both ways, `/tp`,
  an F7 Locations jump, a dungeon claim (party move), the Pale Pass bounce, and a carry/restrain. Watch for
  `MovementValidation:` lines in `server.log` and for any rubber-banding.

## Added 2026-09-19 (evening): labour and skinning rounds are issued and judged by the server (LIVE 18:30, needs a client relaunch)

SERVER_AUTHORITY.md migration 7, both halves. Each widget used to roll its own band or seam and report a
count, so the server could only check that the count had not arrived too fast: in labour, waiting
`strikes * 350 ms` and claiming a perfect round won at any tier; skinning was weaker still, taking the pelt
for three cuts claimed after 1.5 s, with no clamp at all and the slips computed in the widget and never sent.
Both rounds are the server's now, in the same shape.

- [x] **The server issues the round** (`server\labour.js`): a 32-bit seed from `crypto`, the band centre for
  every strike derived from it with mulberry32, the sweep, the round length and both staggers go out in the
  widget packet (`bands`, `sweepMs`, `totalMs`, `hitMs`, `missMs`). Nothing in the packet says where a strike
  should fall or whether one landed. The seed is in every verdict line, so a round can be rebuilt from the log.
- [x] **The widget reports evidence, not a score** (`fork\skymp5-front\src\features\labour\index.tsx`): it sends
  `JSON.stringify(strikeMs)` — the millisecond of every strike it took, hit or miss — plus its own clock at the
  moment it submitted. The server replays the sweep at those milliseconds, counts the hits against its own band
  list and pays from that count.
- [x] **The verdict is the same number the player saw**: both sides run the identical `markerAt()` on the same
  integer millisecond, and the widget times a strike at the frame on screen rather than at the keypress, so
  there is no latency term in the scoring and no tolerance to tune. Verified end to end: the built bundle driven
  in a browser, its real report judged by the real module, agreed strike for strike (`hit,miss,hit,miss,hit,hit,
  hit,miss,hit`, 6/6) — and 40 randomly played rounds in the harness never disagreed once.
- [x] **Impossible reports are refused and logged**: strikes inside the stagger (`cooldown`), after the round was
  already won (`extra`), outside `0..totalMs` or not whole (`range`), more strikes than the stagger allows
  (`flood`), a strike later than the report itself (`submit`), a clock that has seen more time pass than the
  server has (`future`), a widget clock further behind the server's than transport can explain — slow motion or
  a report from minutes ago (`late`), and unparseable payloads (`malformed`). A repeat of a judged nonce logs
  `labour replay` and pays nothing.
- [x] **An interface from before the change** (a hit count, no times) is refused with "Your interface is out of
  date. Rejoin the server to pick up the new one." and costs no rest timer. **Every player must relaunch** to get
  the new UI; until they do, mining and woodcutting refuse rather than pay.
- [x] **One line per verdict** in `server.log`: `labour win Name #TAG mining/iron t3 6/6 of 9 last=12513 at=12518
  lag=180 err=0.91 seed=4e4a46e4`. `err` is the mean distance of the landed strikes from the band centre, 0 dead
  centre to 1 at the edge. Played by hand it wanders (0.4-0.9); a script that aims lands on 0.00 every round, and
  one that takes the first feasible millisecond lands on 1.00 every round. Neither is a hand.
- [x] **Rounds survive a gamemode reload** (`globalThis.__dboLabourRounds`) and expire on their own, so a report
  that never comes back no longer locks the player out of that seam for the rest of the session.
- [x] **Skinning got the same treatment** (`server\gamemode.js` 1575-1701, widget `skinning`): `skinRound()` rolls
  the seed and the seam for every cut, `skinPacket()` sends the seams, the blade's period and the time limit, and
  `judgeSkin()` replays the blade at the cut times the widget reports. The widget now reports every cut it took,
  so the slips are counted here instead of being invisible to the server. Same refusals as labour plus `order`
  (this game has no stagger, so order is the only rule between cuts); the corpse checks — already skinned, pelts
  still on it, within 400 units — are unchanged and still run after the judge. Tier curves are untouched: tier 1
  is a 0.12 seam and an 870 ms blade, tier 5 a 0.26 seam and 1493 ms. Verdict line: `skinning win Name #TAG wolf
  t3 3/3 cuts 1 slips of 4 last=4104 at=4113 lag=150 err=0.60 seed=aa6ea4d7 -> wolf pelt`. Noticed while
  working on it, not fixed: `SKIN_WIDGET_ID` and labour's `WIDGET_ID` are both 33, so the `close` event from one
  clears the other's session. Harmless today because a vein and a corpse cannot be activated at once, but a
  third widget on 33 would not be.
- [x] **Deployed**: `labour.js` and `gamemode.js` both live, last reload 18:30 and clean; front rebuilt and copied
  to `Skyrim Special Edition - dev\Data\Platform\UI\` and `server\client-dist\Data\Platform\UI\` (previous bundles
  in `_ui-build-backups\before-labour-verdicts-20260919-181035\` and `...\before-skinning-verdicts-20260919-183015\`).
  The reload nudges left a few more blank lines at the end of `gamemode.js`, which another session had open.
- [x] **Regression tests**, no server and no game: `node tests\labour-harness.js` (32 checks) loads the real
  module with a mock api and plays rounds the way the widget does; `node tests\skinning-harness.js` (23 checks)
  lifts `skinRng`, `bladeAt`, `skinRound`, `skinPacket` and `judgeSkin` straight out of `gamemode.js` and runs
  them in a sandbox, because that file cannot be required without a live `mp`. Both fire the forgeries above.
  60 simulated skinning attempts across the tiers, no disagreement; the built widget driven in a browser agreed
  cut for cut on a clean run (3/3) and on a mixed one (`clean,slip,clean,slip,slip`, 2 cuts 3 slips, a loss).
- [ ] **Tune the lag grace from a playtest** (`cfg.labour.lagGraceMs` and `cfg.skinning.lagGraceMs`, both 2500 ms,
  the old labour grace kept unchanged). It is the one number still unmeasured in game: how far behind the server's
  clock the widget's may sit — the packet out, the mount, the report back. The browser's own share measured 5-9 ms
  plus up to one 16 ms frame (six runs against the built bundle in Chromium); the two network legs and the
  client's frame pacing need a real round. Read `lag=` out of a playtest's verdict lines and lower both to
  comfortably above the worst honest value. It is what bounds drawing the round out in real time and scaling the
  reported times back down, and it bites hardest in skinning, where an attempt is short: the harness prints the
  exposure — at 2500 ms a 3.1 s attempt can be stretched to 5.6 s, a 1.8x slower blade.

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
- [x] **dungeons.js read every spawned id once per lease, found by the bot harness (LIVE 2026-09-20 14:07)**.
  At 100 bots with 4 leases open, `dungeons.tick` (1.67-2.05 ms mean) and `dungeons.arm` (1.38-1.41) were the
  two most expensive gameplay timers. `trackNpcs` and `armLease` each walked every id in `zone-spawns.json`, so
  an id belonging to another lease or to wildlife cost an `mp.get` per lease per tick, forever: leases x ids
  engine reads where ids is enough. The swept-corpse check was also `ids.includes(id)` per remembered NPC.
  Now one snapshot per timer tick carries the id list, a Set of it for the sweep, and each id's zone read once
  and kept (`private.npcSpawner` is written once at spawn, npcSpawnSystem.ts:668, and never changes). An id
  that leaves the sidecar is dropped from the cache, and a gap longer than 10 s between snapshots (no lease
  running) throws both caches away, so a form id the engine reuses in that gap cannot inherit a stale zone.
  Measured with 4 fake leases and 600 ids against a mock mp, identical seen/armed sets either way: 10 arm ticks
  plus a dungeon tick went from **24,617 engine reads to 420**. `lease.gone` became a module-level `gone` with
  the same meaning. **Verified by the harness at 100 bots with 4 leases**: `dungeons.arm` 1.38-1.41 -> 0.80 mean
  (max 2.06 -> 1.37), `dungeons.tick` 1.67-2.05 -> 1.11 mean (max 2.60 -> 1.40), and that run carried more
  spawned actors than the before-run (Sedor 36 zones, Rielle and Red Ruby 19 each), so the gain is understated.
  What is left per lease is real work: one `isDead` read per living enemy per tick. A 20-lease run is queued to
  confirm it now scales with enemies rather than with leases x ids.
- [x] **officials.json read per player, found by the bot harness (LIVE 2026-09-20 13:35)**. The 25-bot step of
  `server\tools\loadtest` reported `lawful` at 2.5 ms max against every other timer under 0.3 ms. Cause: playermenu's
  15 s lawful tick calls `refreshLawful` per online player, and that reaches `ranksOf` -> `readOfficials`, which
  was a `readFileSync` + `JSON.parse` per call. One blocking disk read per player per tick. Measured warm:
  25 players 1.44 ms, 100 players 4.66 ms, and worse under IO contention. `readOfficials` now keeps the file as
  text, re-checks it by mtime at most once a second, and `writeOfficials` refreshes the cache so `/appoint` and
  `/dismiss` stay instant: 100 players per tick 4.66 ms -> 0.054 ms. Checked that it returns the same content as
  a direct read, that a caller mutating the returned object cannot poison the cache (`/appoint` mutates it), and
  that an edit from outside is picked up within a second. **Pattern to grep for at scale: a per-player sync read
  inside a timer.** The harness will re-measure it as a `lawful` delta after a `sandbox init`.
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

## Added 2026-09-20: a placement's own outfit reaches the actor again

- [x] **What was actually lost.** Most "outfit" differences are not losses: the placement supplies none and the
  spawned base brings its own. The real set is **193 placements in 37 dungeons**, and they are the identity
  ones: Morag Tong in Solstheim bandit armour, the Baan Malur bandits without `MorrowindLvlBanditArmourOutfit`,
  Ysgramor's Tomb ghosts in bandit gear instead of draugr armour, the Windhelm vampire knights, the Silver Hand
  shield variants. Boot line: `dungeon outfit audit: 193 placements in 37 dungeons ... (restoreOutfits on)`.
- [x] **The server cannot dress a spawned actor.** Found by bot test after the first version logged what it gave
  and changed nothing: an npc's inventory is only ever sent to the npc's own user (`VisitPropertiesMode::All`,
  `PartOne.cpp` 826-830) and `SpSnippet::Execute` returns early unless the actor was created as a player
  (`SpSnippet.cpp` 25-31), so neither the items nor an `EquipItem` call leaves the server.
  **The same limit applies to the weapons `armLease` hands out**, which means enemy arming has only ever
  changed the corpse, not what the enemy fights with. Worth its own look.
- [x] **How it works now** (server `f79fd71`, fork `02fa1a1`): `giveWorn` puts the pieces in the actor's
  inventory for the corpse and names them in the neighbour-visible `ff_outfit`; `formView.applyOutfit` adds and
  equips them client-side, once per value, next to `applyFactions`. Nothing is removed, because the client's
  `applyEquipment` strips an actor bare and would lose the skins draugr and falmer wear as outfits.
- [x] **A leveled list with Use All is a whole outfit**, not a choice between pieces (`LeveledListBase.h`
  `UseAll = 0x04`). Before reading LVLF, a full soldier outfit resolved to a single helmet.
- [x] **Verified on the wire**: a Fort Caractacus claim sends `ff_outfit` lists of five and six pieces to a real
  client, e.g. `[81623, 81625, 81626, 81627, 80562]`, alongside the faction lists. What only the game can show
  is the equip itself, the same boundary as the factions.
- [x] Live: `dungeons.restoreOutfits` is **on** in `gamemode-config.json` (a live file, not in git). Set it to
  false and touch `gamemode.js` to turn it off. The client half needs a relaunch: bundle md5 `7009ed45`,
  previous one in `_client-bundle-backupsefore-outfit-20260920-181437\`.
- [ ] Not done: the 994 AI data, 910 script and 244 spell losses, and the pose an ambusher should hold.

## Added 2026-09-20: ambushers wait for you again

The same template loss as the factions, the other half of it. A vanilla ambusher gets `ambushSleepPackage`,
`AmbushPatrolLinkCustom01` and `AmbushSandboxEditorLocation512` from its own `Lvl*` template, plus an XLKR link
on the placement to the thing it hides in: `CreatureAlcoveBgMarker` for draugr, `FalmerWallPod01` for falmer,
patrol idle markers elsewhere. 871 of 888 such placements carry that link. A PlaceAtMe spawn gets neither the
packages nor the link, so they stood in the open and charged as soon as the cell loaded.

- [ ] **The packages themselves cannot be restored.** Vanilla Papyrus has no call that adds a package
  (`AddPackageOverride` is PapyrusUtil, which is not installed), the typings have `getLinkedRef` but no setter,
  so a spawned actor cannot be linked to its coffin, and `formView` cannot put it in the furniture either.
  Baking the packages into new NPC_ records in a plugin would still leave the per-reference link missing.
- [x] **What is restored is the timing** (fork `90bfec3`, server `2ed07b3`): a zone may be marked `Ambush`, and
  such a zone ignores both the dungeon-wide fill and the pre-spawn, waiting for a player within its own radius.
  `zonesFor` marks a placement from the records, not the editor id: walk the template chain to the record that
  supplies packages and look for one whose name says ambush. 971 placements in 95 dungeons qualify, most in
  Dustman's Cairn (50), Forelhost (32) and Nchardak (30); those zones are written with `Size` 1200 and no
  pre-spawn. Boot line: `dungeon ambush audit: 971 placements in 95 dungeons wait in ambush`.
- [x] **Verified with the bot harness on the sandbox**, since the user could not test in game:
  a Northfringe Sanctum claim went from `33 prespawned` to `15 prespawned, 18 held back`, and the bot counted
  exactly 15 dynamic actors. Then an A/B on one spot: two zones, one ordinary and one `Ambush`. With the bot
  1,500 units away only the ordinary one existed; walking in produced exactly one new actor, the ambush one.
- [ ] **Staged, not live**: `server\dist_back\skymp5-server.js` holds the new bundle (backup in
  `server\_alduinak-build-before-ambush-20260920-171034\`) but the running server still has the old one, so
  the flag is ignored until it restarts. The restart needs the user; a deploy is blocked for me.
- [ ] Not covered by this: the pose. An ambusher still stands rather than lying in its alcove, and the other
  aspects the template loses (994 AI data, 910 script, 460 inventory or outfit, 244 spells) are untouched.
- Worth knowing: interior cells have independent coordinates, so an ambush spot 3,000 units away in the list
  may be in another cell entirely. Two probe runs were wasted walking a bot at coordinates from a cell it was
  not in.

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
- [x] **Verified on the wire with the bot harness 2026-09-20 15:2x** (the user could not test in game). A probe
  built on `server\tools\loadtest` (`lib/` used read-only, driver in the session scratchpad, sandbox on 7787, live
  server untouched) logged in one bot, claimed Gutted Mine on Adept and recorded every message it received
  through the real `MpClientPlugin.dll`. Result: 985 `createActor` messages, 63 for dynamic actors, and
  **38 of them carry `ff_factions`**, value `{"f":[[135085873,0]],"c":0}`. 135085873 is `0x080D3F31` =
  BSHeartland.esm `CYRVampireThrallFaction`, rank 0, no crime faction, which is exactly what the 19 thrall
  placements there should be given. The server log for the same claim shows the matching 19 `factions:` lines.
  So the server sets it, the property survives the neighbour filter (`PartOne.cpp:838-853` drops a custom prop
  unless it is visible by owner AND by neighbours; `makeProp('ff_factions', true)` sets both), and it reaches a
  real client's network layer inside the actor's own creation message.
  Worth knowing for the next probe: custom properties travel in `customPropsJsonDumps`, NOT in `props`, and an
  NPC `createActor` carries no `baseRecordType` (that field belongs to `UpdatePropertyMessage`). Two wrong
  assumptions about those cost two empty runs.
- [ ] **Still unverified, and only the game can show it**: that the client's `applyFactions` actually puts the
  factions on the actor, and that thralls then leave the vampires alone. Bots have no engine, so nothing applies
  them and no `npcDrift ... factions` line can appear in a bot run. In game, claim Red Ruby Cave or Gutted Mine
  and look for `npcDrift ... factions: {"sent":1,"applied":1}` plus thralls standing with the vampires.
- [x] **Found on the way, fixed (`dungeons.js`)**: `mp.getAllForms(0xff)` fills a cache on its first call and
  never refreshes it (`WorldState.cpp` 897-925). The 09-18 `liveForms` filter in `armLease` and `trackNpcs`
  therefore skipped every actor spawned after the first call of a process. Since 09-18: no arming (the last
  "armed" lines were Serpent's Trail 09-17 and one Anga lease today at 10:41, which made the first call), and
  no "cleared" ends (every Anga lease ended "left"). Both now go through `spawnerTag`, which remembers ids that
  throw. Do not use getAllForms for liveness until the C++ cache is invalidated on AddForm.
- [x] **Red Ruby Cave chain door removed 2026-09-19 18:06** (user 14:30: "a blocked off door activated with a
  chain"): `BSHeartland.esm:083DBD` `CYRMineSecretDoor`, opened by pull chains `0885AC`/`0885B3`, is now
  Initially Disabled at Z -30000 in DLE, XESP absent, via `DBO_BrumaInteriors.pas` op `sink` (result kept as
  `Edit Scripts\DBO_BrumaInteriors_result.redruby.txt`, one-line list as `DBO_BrumaInteriorsList.txt.redruby-run`,
  the 28-line Vilverin list restored). DLE 3,988,898 -> 3,991,389 bytes, 52 masters unchanged, MCP validate ok,
  deleted_records 2521 unchanged. Backup `server\_ckmcp-dle-backup-redruby-20260919-180400\`. The 09-16 pass
  missed it because it is an ACTI, not a DOOR, and the gate sweeps keyed on door and portcullis bases.
  **Dev copy only so far**; `server\data` not touched, see the next item.
- [ ] Also chain-driven in that cave and left alone: `083F5B` `NorRetractableBridge01NONAVCUT` (chain `083F8E`),
  over the water at [-347, -4208, -884]. Sinking a bridge leaves a gap, so it needs a different fix if it blocks
  the way. User to confirm.
- [x] **DLE synced to the server and node restarted 18:22** (user's call). `server\data\DragonBreak Online
  Edits.esp` was still the 2026-09-16 20:41 copy; the dev copy carried the user's unrecorded 2026-09-18 15:57
  save (240 records added, 1,082 changed: Falkreath sawmill, notice board refs, Whiterun cells, 85 SPEL,
  48 QUST, one NAVM) plus the Red Ruby door. Both are now md5 eee55dce. Previous server copy in
  `server\_ckmcp-dle-backup-serverdata-20260919-182005\`. Of the 110 plugins in `server\data`, DLE was the only
  one whose content differed; HIMBO.esp and the two RaceMenuMorphs plugins exist only on the server side.
  Boot clean at 18:22: VitalsRelaySystem up, 3,185 wildlife zones, 19 pool families, playtest lock on,
  `dungeon faction audit: 390 of 3501 placements`. The 18 `resolved context` errors at 18:22:14 are the
  companion sweep reading last run's ids, the known noise family, not new.
- [ ] **The Steam install and Jake's server still carry the older DLE.** Clients and server must hold the same
  file, so they need this one before anyone connects from there. Run `server\sync-plugins.cmd` with Vortex
  closed before the next client test.
- Note: the server now runs detached (`cmd /c run-logged.cmd`, node PID 30124), not as a background task of a
  Claude session, so it survives the session ending. `server-exit.log` records how it stops.
- **Counts re-measured 18:12 over the regenerated `dungeons.json`** (3,501 placements after the survey session
  dropped Starts Dead and enable-parent placements): 398 slots in 155 placement kinds lose their template's
  factions, 967 lose AI packages, 994 AI data, 910 scripts, 460 inventory/outfit, 244 spells. The earlier
  503/1,086/618/978/280 figures were over the old 4,244-placement file.
- Still not covered: ambush packages (967 slots), outfits (460), spells (244). Separate follow-ups.

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
  **CORRECTED 2026-09-19 (late): the weapon choice is right, the delivery was not.** `armLease` set the
  inventory and called Papyrus EquipItem, which SpSnippet drops for every server-spawned actor, so no client
  ever saw any of it. Measured on the probe server; see the block at the top of this file.

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
- [x] Unarmed dungeon enemies: every 2 s dungeons.js checks each new humanoid spawn of a lease and, if it has no weapon, gives one fitting its placement (archer: bow + 30 arrows; two-hander: greatsword/battleaxe/warhammer; caster: dagger; else sword/war axe/mace; draugr, falmer, forsworn get their own kind) within the difficulty band, then EquipItem. Logged as "armed". **CORRECTED 2026-09-19 (late): the EquipItem half reached nobody** (SpSnippet is dropped for actors that are not created as player), so unarmed enemies stayed unarmed on every screen unless a host grant happened after the inventory write. The "armed" log line only proved the JS ran. See the block at the top of this file.
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