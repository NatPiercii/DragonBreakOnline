# Wars, raids and the Realm Map: design

Status: **design, nothing built.** Written 2026-09-26 by claude-nate from Nate's direction. It comes before "The Great Hunt"
werewolf rework, because pack territories are the same system with a hidden layer.

Nate's decisions, 2026-09-26:
- **Rulers and faction leaders declare war.** A hold's ruler (Jarl, Count, Chieftain) or a faction's leader rank; no one else.
- **An official war gives one week's notice.**
- **The map is our own window, drawn from the game's terrain.** It is not the vanilla world map, and it uses no borrowed map art.
- **Three evening battle windows** per war.
- **A captured capital's officials lose their ranks.**
- **A war to the death needs both leaders to agree.**
- **A raid needs a minimum number of defenders online.**
- **Declaring war needs a minimum faction size and a gold fee.**
- **A new faction has a week of protection from war.**
- **Faction colours on the map must be lore accurate.**
- **Land is taxed every week.** The faction leader or the hold's Jarl or Count sets the tax rate, and it applies to the
  property taxes collected every week.
- **Guards and soldiers are paid a wage.**
- **Leaders set all of this themselves in their own panel,** the existing faction panel (F3), so it costs no new key.
  Stewards and their equivalents manage property only.

## 1. What exists today (the foundation)

| Piece | Where | What it gives this design |
|---|---|---|
| Zones | `zones.json`: 9 Skyrim holds, 3 regions (Bruma, Solstheim, Alik'r) and 6 orc strongholds | Who a place belongs to. Rule today: inside a stronghold radius it is the stronghold's, otherwise the nearest hold capital's; regions own whole worldspaces |
| Officials | `officials.json`, `/appoint`, `/dismiss`, `APPOINT_RULES` in `gamemode.js` | Who rules each zone (Jarl, Count, Chieftain, Steward, captains, guards) |
| Factions | `guild-defs.json`, `guilds.js`: 50 factions (18 guilds, 15 cults, 10 hold factions, 6 stronghold clans, 1 pack), 22 of them secret | Who fights: every war is faction against faction. Secret factions are hidden from non-members already |
| Treasuries | a treasury chest per hold (`zones.json` `treasury`), seeded with 10,000 gold; contracts and board fees use it | What pillage takes from |
| Warbands and raids | `warband.js` (GM-raised NPC bands, unleashed as raiders) | NPC defenders and attackers for events |
| Down state, friendly fire | `downed.js` | How a fight ends before death |
| Planned restarts with a countdown | `updates.js` | The pattern for timed, announced events |
| Discord bot, notice boards, pigeons | `dbdiscord`, boards, `pigeons` | Where declarations are announced |
| Map marker discovery | client `characterProgressService.ts`, `MAP_MARKER_REFS` | City and landmark icons for the map |

## 2. Territories and land markers

A **territory** is a named piece of land with one **land marker**: a war standard placed at its seat (a keep, a fort, a
village square, a stronghold's longhouse). Whoever holds the marker owns the territory.

- Every zone today becomes at least one territory: its capital. Holds are then split into smaller territories (forts,
  villages, mines, farms) so a war can take land piece by piece. The list is curated by hand in `territories.json` and
  starts with Bruma and the nearby Cyrodiil lands while the playtest is locked to Bruma.
- **Borders follow the markers.** A point on the map belongs to the nearest land marker, which is the rule zones use today
  with capitals ("nearest capital"), now applied to every marker. Stronghold radii keep their override. So when a marker
  changes hands, its whole area changes colour on the map and the border moves, as Nate described. Where the nearest-marker
  line looks wrong (it crosses a river, cuts a village in half), a territory can carry a hand-drawn outline instead.
- **Gameplay follows the map.** The ownership table replaces "nearest capital" everywhere zones are used today: housing
  managers, notice and bounty boards, treasuries and the officials who may act there. Taking a fort's marker moves its
  land into the new owner's hold for all of these.

`territories.json` (static, curated): `id`, `name`, `zone` (the hold, region or stronghold it starts in), `kind` (capital,
fort, village, mine, wild), `marker` {worldspace, position}, optional `outline`, `layer` (public, or the secret factions
that can see it). A territory earns its owner nothing by itself; the property on it pays tax (section 7).

`territory-owners.json` (runtime, written by the server): `territoryId` gives the owning faction, since when, and the last
changes. At first each territory is owned by its zone's hold faction (`county-bruma`, `hold-whiterun`, ...).

## 3. The Realm Map

Our own map window, opened by a key, `/map`, or the X menu.

- **Why not the vanilla map:** Skyrim's world map cannot have borders drawn on it. SkyrimPlatform can add or rename
  markers there, not paint areas. A window of our own can colour each territory by its owner, redraw borders live, and
  show different layers to different people.
- **The artwork is ours, drawn from the game's terrain.** A generator reads the landscape heights and water levels from
  the plugins on CT 115 (`/opt/skyrim-data`) and renders a shaded relief image per worldspace (Cyrodiil and Bruma first,
  then Skyrim and Solstheim), plus city and landmark icons from the map markers. It needs no one's permission, and it
  updates when our landscape does. It runs once per plugin change, like the other generators, and its output ships in
  the client package.
- **What it shows:** each territory filled in its owner's colour, with its name, owner and ruler; land markers; wars
  (who, where, when the next battle window opens); your own position.
- **Layers:**
  - Public: territories, owners, wars.
  - Your faction: your own markers and rally points, seen by members only.
  - Secret: one layer per secret faction, seen only by its members. A cult's shrines, a vampire clan's lairs, a pack's
    hunting grounds.
  - Staff: every layer.

  The server decides which layers a viewer gets, so a hidden layer never reaches a client that should not see it.
- **The keybinding:** the window itself is a front widget (the relay pattern: a `dboMap` packet from the gameplay code),
  but the front ships in the client package, and a new key needs a client update too. So the map, the key and `/map`
  arrive together in one client package. Suggested key: Shift+M, next to the vanilla map's M; to be confirmed in game.
- **Live:** when ownership or a war changes, the server pushes the change to every open map.

## 4. Official war

1. **Declare.** A hold ruler or a faction leader declares war on another faction:
   `/war declare <faction> <territory|all> <reason>`, or from the map. The declaration names the war goal: one territory,
   several, or the whole hold.
2. **One week's notice.** The war is announced at once, in game (a banner and chat), on the map (the contested land is
   hatched, with a countdown), on the notice boards of both sides, and in the Discord announcements channel. Both sides
   have seven days to recruit allies, hire mercenaries and fortify.
3. **Battle windows.** Land can only change hands inside three evening battle windows during the war, so nobody wakes up
   to find their keep taken at 4 AM. Staff set the evening slots (two hours each); the attacker picks three of them when
   declaring, and they are announced with the declaration in each player's local time.
4. **Capture.** In a battle window, an attacker plants their standard at a contested land marker and holds it: a few
   minutes with no defender within reach of the marker. Defenders stop the capture by standing at the marker. A captured
   marker flips its territory to the attacker, and the map and the gameplay rules follow at once.
5. **The capital.** Taking a hold's capital takes the hold: its treasury, its notice board, and its seat of power. Every
   official of the defeated hold loses their rank, and the winner's leader appoints new ones.
6. **End.** A war ends when its goal is taken, when the last battle window closes, or when the leaders make peace:
   `/war peace <terms>` with a tribute in gold, accepted by the other leader. Surrender is the same with no terms.
7. **Record.** Every war is kept: the declaration, each capture, the outcome. The map's history view shows it.

Limits against abuse:
- One offensive war at a time per faction.
- A cooldown before declaring on the same faction again.
- A minimum faction size to declare (proposal: 5 members).
- A declaration fee in gold from the declarer's treasury (proposal: 2,000), so it is not free to threaten.
- A new faction cannot be declared on for its first week.
- The same Discord account cannot fight on both sides.

## 5. Raids and pillage

Smaller than war, and no land changes hands.

- **Raid:** a faction leader or a ruler sends a band against a territory's stores. No week's notice. The defenders are
  warned as the raid begins: a message to the territory's officials and guards, and a map ping.
- **Pillage:** raiders who reach the stores and hold them for a few minutes take a share of the treasury, 15% by Nat's
  earlier robbery decision (2026-09-21), plus some of the stock.
- **Consequences:** raiders become wanted in that hold (the jail and bounty systems), and a territory cannot be raided again
  for some days.
- **Fairness:** a raid can only start while a minimum number of the defending side is online (its officials, guards or
  members; proposal: 2), so stores are never emptied while their owners sleep.

## 6. Death in war

Every fight goes through the down state first (`downed.js`).
- War deaths are **not** permanent by default.
- The declaring leader may propose a war **to the death**. It becomes one only if the defending leader accepts it in their
  panel before the war starts; if they refuse, the war goes ahead without permadeath. The announcement says which it is.
- Anyone who fights in a war to the death accepts the risk.

## 7. Taxes, wages and the treasury

The treasury chest each hold already has becomes the centre of a small economy. Rent already goes into it (`tenancy.js`).
- **Tax rate.** The ruler of a hold (Jarl, Count, Chieftain), or the leader of a faction that owns land, sets one tax rate
  for their land.
- **Weekly property tax.** Every week, every privately held property in their territories owes the tax rate times its
  assessed value into the owner's treasury: houses granted by officials and rented houses alike. A property's assessed
  value is set by the steward, from a default by the kind of house. Unpaid tax works like overdue rent today: the holder
  and the officials are told, and an official may give a week's grace or seize the property.
- **Wages.** Guards and soldiers are paid every week from the treasury: every guard rank of a hold or stronghold, and a
  faction's soldier ranks. The ruler or leader sets the wage per rank. A wage is paid when the member next comes online,
  as owed gold is today. If the treasury cannot pay, the wage is owed and paid first once the treasury refills, and the
  ruler sees who is unpaid.
- **The weekly reckoning.** Once a week each treasury takes in its taxes and pays its wages, and its ruler gets a summary:
  income, wages, balance, and anyone overdue or unpaid.
- **Land that pays.** Taxes are why land matters: more territories mean more property to tax. This is also why a war over
  land is worth fighting.

## 8. The leader's panel

No new key: the faction panel (F3, `guilds.js`) gains a leader's section.
- **Rulers and faction leaders:**
  - the tax rate and the wage for each rank;
  - the treasury: balance, last week's reckoning, and who is overdue or unpaid;
  - officials: appoint and dismiss (as `/appoint` and `/dismiss` do);
  - war: declare (target, goal, the three battle windows, to the death or not), accept or refuse a war to the death, make
    peace or surrender;
  - raids: send one, and see raids against their land.
- **Stewards and their equivalents:** property only: list houses for rent, offer, remind, grant grace, evict, and set a
  property's assessed value. No taxes, wages or war.
- **Members:** see their faction's land, wars and their own wage.

Faction colours are not in the panel: each faction's map colour comes from its lore heraldry (hold banners, guild colours),
set by staff in one table.

## 9. The Great Hunt fits on top

Werewolf pack territories are territories on a pack's secret layer. Territory wars between packs are wars with pack rules
(a week-long contest scored by hunting, feeding and fighting, per the Great Hunt design). The map, the ownership engine and
the war lifecycle are built once and reused.

## 10. Build order

| Phase | What | Ships as |
|---|---|---|
| 0 | Vampire Lord remote body (Worker B, in progress) | gameplay |
| 1 | Terrain map generator (Cyrodiil and Bruma first); `territories.json` for Bruma and its neighbours; Realm Map, read-only: territories, owners, rulers | generator + client package (widget, key) + gameplay |
| 2 | Ownership engine: land markers, `territory-owners.json`, nearest-marker borders driving housing, boards and treasuries; staff tools (`/territory`) | gameplay |
| 3 | Taxes, wages and the weekly reckoning; the leader's panel in F3 (tax, wages, treasury, officials), stewards' property section | gameplay + front |
| 4 | Official war: declaration (size, fee, protection), week's notice, announcements (game, map, boards, Discord), three battle windows, capture, officials losing rank, peace, to-the-death agreement, history | gameplay + front |
| 5 | Raids and pillage | gameplay + front |
| 6 | Secret layers for cults, clans and packs | gameplay + front |
| 7 | The Great Hunt on this engine | per its own design |

Each phase is tested with harnesses like the other systems, reviewed, and shipped through the staged updates.

## 11. Numbers still to confirm (Nate)

The decisions are made; these are the numbers inside them. Each has a proposal and lives in config, so it can change without
code.
1. The evening battle-window slots (times and time zone).
2. Minimum faction size to declare war (proposal 5) and the declaration fee (proposal 2,000 gold).
3. Minimum defenders online for a raid (proposal 2), and a territory's raid cooldown (proposal 3 days).
4. The cooldown before declaring on the same faction again (proposal 2 weeks).
5. The highest tax rate a ruler may set (proposal 20%), and the default property values by kind of house.
6. The lore colour for each faction (staff table, checked against the game's heraldry).
