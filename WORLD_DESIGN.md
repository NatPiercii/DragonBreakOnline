# DragonBreak Online world systems (2026-09-14)

Companion to SKILLS_DESIGN.md. Everything here builds on systems Alduinak
already ships; each section says what exists and what changes.

## Notice boards (Manny's Notice Board) - BUILT 2026-09-14

Built as designed (see CHECKLIST 'late evening'): zone-keyed pools, three tabs, 30 gold, officials-only Hold Notices, removal, notice-boards.json.

Exists: Alduinak's BountyBoardSystem. Activating a board opens a CEF notice
menu; posting costs gold, notices expire after a week, boards hold a capped
number of notes, every post is logged, storage rides the character save. It is
keyed to the Missives mod's boards, which we do not run.

Change:
- Re-key it to Manny's `manny_up_NoticeBoardActivator` (14 placed boards in
  `notice board.esp`), each mapped to its hold or stronghold. The vanilla
  Manny script and its message containers are ignored; the server owns the
  board.
- Three tabs per board: **Hold Notices**, **Shop Ads**, **Citizen Notices**.
  A post carries the tab, the text, the poster's `Name #TAG` and the hold.
- Cost: 30 gold per post, taken on confirm. Half of it (server-settings
  `bountyBoardTreasuryPercent`, default 50) is deposited in the treasury of the
  zone the board stands in (zones.json `treasury`); zones without one keep
  nothing. Hold Notices are free and only
  officials may post there: Jarl, Steward, Hold Commander (stronghold:
  Chieftain, Bane). Everyone can read every tab.
- Boards are per hold: a Whiterun board shows Whiterun posts. A "Skyrim" tab
  that mirrors every hold's Hold Notices is optional and cheap.
- Keep: week expiry, cap per board (raise to 60), post log, poster account in
  the audit trail. Officials and admins can remove a post.

## Pigeons (player mail)

New. `/pigeon <name|#TAG> <text>` or the Pigeon button in the personal menu:
- one pigeon per sender every 35 minutes; free;
- recipient by in-game name or tag; offline recipients accepted. The server
  keeps an index of character names, so lookup works while they are away;
- online recipient: arrives in the Personal chat tab as "Pigeon from Name
  #TAG". Offline: stored on the recipient's character (up to 20 unread) and
  delivered on next login, oldest first;
- text capped at 240 characters; a block list per character so a pest can be
  silenced without admin help; every pigeon is logged (not to Discord, to the
  server log only, to keep the GM channel readable).

## Orc strongholds: sovereign holds - BUILT 2026-09-14 (housing + boards read zones.json; officials.json holds the ranks)

Exists: hold officials come from the backend faction whitelist (rank slots
per hold: jarl 1, steward 4, captain 4, court wizard 4 ...). Housing lets
`jarl` and `steward` manage property inside their hold, resolved today by a
table of interior cells.

Change:
- Six new factions, one per stronghold, each with ranks **Chieftain** (1)
  and **Bane** (1) plus warrior slots as you see fit: Gol-Kharzum,
  Mor Khazgur, Dushnikh Yal, Largashbur, Narzulbur, Cracked Tusk Keep.
- Sovereign zones: a radius around each stronghold's centre in Tamriel
  (the Malacath shrine positions already in skills.json mark them). Inside a
  zone the property manager is the stronghold's Chieftain or Bane; the
  surrounding hold's Jarl and Steward get no rights there, and stronghold
  officials get none outside. Locks inside the zone answer only to the
  owner, the Chieftain, the Bane, and admins.
- Hold Notices on a stronghold board are posted by Chieftain and Bane.
- Bounty boards, housing and the notice boards all read the same zone table,
  so one config file defines sovereignty.

## Gold: faucets and sinks (needs a decision)

NPCs are disabled on the server, so there are no merchants. Gold enters the
world only through: gold pouches (Harvesting), admin or official treasuries,
and whatever the gamemode grants. Sinks so far: 30 gold notice posts (half
returns to the hold treasury), 1,200 gold respecs. Before boards and respecs go live, decide the faucet: a daily
stipend, official payroll from a hold treasury, or harvest-only. Without a
faucet the first month is barter.

## Banks

Eight bank interiors exist in DragonBreak.esp (Whiterun, Riften, Solitude,
Windhelm, Markarth, Falkreath, Morthal, Winterhold; Dawnstar has none). Each
holds a `HoldChest` treasury, named per zone by the `treasury` field in
zones.json (Bruma uses the Lord's Manor safe in the castle, 79b22:BSHeartland.esm).
The gamemode seeds every treasury with 10,000
gold once (`private.treasurySeeded`), configurable via `banks.seedGold` in
gamemode-config.json, and logs the seed to the GM channel.

Exteriors: every bank's interior door has a teleport target that does not
exist in any plugin (the exteriors were never merged from DO).
To finish a bank in the Creation Kit: place the exterior shell and a door in
the city, then link that door to the interior door listed below and set the
interior door's target to it. Interior door references (DragonBreak.esp):

    WinterholdBank  door e685   WindhelmBank  door ba6f   MarkarthBank  door 61ad
    FalkreathBank   door 7bd3   WhiterunBank  door 1a99   MorthalBank   door 7dd2
    RiftenBank      door fb98   SolitudeBank  door 60c0

Access rules (proposal): the treasury chest is a property owned by the hold
(manager = Jarl/Steward, or Chieftain/Bane in a stronghold) so only officials
open it; tellers are players with guest access. Deposits and withdrawals are
plain container transfers the server already syncs, so a bank works the day
its exterior door exists.

## Dungeons (2026-09-14) - BUILT as leases (server\dungeons.js, dungeons.json)

Every dungeon gets lore-fitting enemies and chest loot, runs as a solo or
group instance with a one-hour timer, and locks out for an hour after.

What exists: NPCs are disabled globally, but Alduinak's NpcSpawnSystem spawns
server-owned NPCs in zones from `NPC-Spawns.json` (an admin panel edits zones
in game). Dungeons are already open (DragonBreak Dungeons.esp sinks the gates).
Loot chests are ordinary containers the server syncs and reloots on a timer.

Instancing, honestly: SkyMP has one world; a cell cannot be cloned per party.
The workable form is a **lease**: the first player or party to enter claims the
dungeon; the entrance refuses everyone else with "someone is inside" until the
hour ends or the party leaves; then a one-hour cooldown per participant before
they can claim it again. Others can still claim it in that window. This gives
the feel of instances without pretending the engine can do them.

- **Difficulty selector** at the entrance: Story / Normal / Hard / Nightmare.
  Chosen by the party leader when claiming. Scales enemy level and count,
  chest loot tier, and the number of locked chests. Higher difficulty does not
  change the timer.
- **Enemy sets by dungeon type**: Nordic ruins draugr and skeevers, Dwemer
  ruins Falmer and animunculi, forts bandits, caves animals and spiders,
  Forsworn redoubts Forsworn, vampire lairs vampires and thralls, necromancer
  towers mages and conjured dead, giant camps giants and mammoths. Bosses from
  the same lists. Authored as NPC-Spawns zones per dungeon, one file, and the
  spawn system already respawns them.
- **Chest loot**: reloot timer tied to the lease, so a chest refills for the
  next claim, not while a party is inside. Some chests locked (see Lockpicking).
- **Parties**: a small `/party` system (invite, leave, leader) is needed for
  group claims; it also feeds group instancing rules elsewhere later.
- **Timer**: at one hour everyone inside is teleported to the entrance and the
  lease ends; a five-minute warning in chat.

## Lockpicking (18th skill, Professions)

Only player-owned doors and dungeon loot chests can be picked; every other
lock in the world is refused. The vanilla lockpicking mini-game is client-side,
so the server gates the attempt: on activation of a locked target it checks the
skill and tier against the lock level (Novice to Master = Tier 1 to 5) and only
then lets the client mini-game run; the unlock result is validated
server-side. Picking a player's door is a crime: the owner and any guest online
get a notice, and it lands in the server log for officials. Picks are consumed
on failure, fewer at higher tiers.

## Needs and consumption (2026-09-14, evening)

Requested after the first skill test: a hunger system, and eating, drinking and
potion animations so nobody chugs potions mid-fight.

What the server core already does: every potion, food or ingredient use goes
through the server (`MpActor::OnEquip`). A second potion inside **10 seconds**
is refused, the local health/stamina/magicka gain is undone and the client
gets a `potionRefused` notice. Food and poisons are exempt. The 10 s is a C++
constant (`kPotionCooldown`), so changing it needs a CI build.

### Hunger (built, gamemode.js, config `needs` in gamemode-config.json)

- One meter, 0 sated to 100 starving, stored on the character
  (`private.needs`). It rises only while online (12 per hour by default, so a
  full day of play from sated to starving) and never kills.
- Stages: Sated 0, Peckish 50 (notice only), Hungry 75 (stamina regen -35%,
  health regen -50%), Starving 90 (stamina regen -70%, health regen off).
  Penalties are Papyrus `ModActorValue` on the owner's client, re-applied on
  every login because the client's values reset.
- Food restores by kind, decided server-side from the record: meals (stew,
  soup, steak, roast, pie, chop, cooked, grilled...) 35, other food 15,
  drinks (ale, mead, wine, milk...) 8, raw ingredients 4, potions and poisons
  0. Lists are editable in the config.
- `/hunger` shows the meter; `/sethunger <player> <n>` is admin, for tests.
- Not yet: a HUD bar (a small CEF widget is the next step), thirst as a
  separate meter, hunger affecting the K-skill activity clock.

### Eating, drinking and potion animations (built, client)

- The client plays the vanilla `IdleDrink` (tankard) for potions, poisons and
  drinks, and `IdleEatingStandingStart` for food and ingredients, through the
  emote system, for 2.5 or 3.5 seconds; movement keys break it like any emote.
  Other players see it through the animation sync.
- Trigger: the item leaving the player's inventory with no destination while
  the inventory or favourites menu is open, or within 0.7 s of a hotkey.
  Server-side removals (trade, refused potion) do not animate.
- Limits, stated plainly: the potion effect is still instant, and a vanilla
  idle will not play with weapons drawn. Combat potions are therefore capped
  by the 10 s server rule, not by the animation.

### Real anti-hot-potting (not built; needs C++ and a CI build)

Move the effect behind the animation in `MpActor::OnEquip`: on a potion,
immediately send the pre-potion values back (the same undo the refusal uses),
play the drink animation through a snippet, and apply the restore server-side
1.5 s later only if the actor was not hit and did not draw a weapon meanwhile;
otherwise the potion is wasted. Also make `kPotionCooldown` a server setting.
That is the version that stops hot-potting outright; the animation pack for a
proper bottle (instead of the tankard) is a client mod choice (an OAR set such
as Animated Potions), optional.
