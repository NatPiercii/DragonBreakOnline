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
- **A raid needs 5 defenders online.** During a raid, homes and containers in the raided land can be broken into.
- **Declaring war needs 10 members of each side online** (the declarer and the target) and a fee of **10,000 gold**.
- **A new faction has a week of protection from war.**
- **Faction colours on the map must be lore accurate.**
- **Land is taxed every week.** The faction leader or the hold's Jarl or Count sets the tax rate (at most 30%), and it
  applies to the property taxes collected every week.
- **A bank holds everyone's gold,** at the `TheBank` activators in each town: one account usable in every town, and a
  treasury tab for leaders that takes deposits and taxes but lets no one withdraw (section 8).
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
changes. At first each territory is owned by the faction its `owner` names in `territories.json`, else by its zone's
hold faction (`county-bruma`, `hold-whiterun`, ...). The Imperial Legion owns the forts (Nate, 2026-09-27): Fort
Caractacus and Pale Pass start as `imperial-legion`.

## 3. The Realm Map

A tab of the faction panel (F3), beside Members and War (Nate, 2026-09-26: no new key, no separate window).

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
- **Icons:** each place shows the in-game map's own icon for its map marker type (`territories.json` `icon`, from the
  marker REFR's TNAM; Castle Bruma's 224 and Bruma's 102 are Beyond Skyrim's own types). The art is exported from the
  game's `interface/map.swf` on the PC into the front's `img/mapicons/<type>.png` (request: `PC_REQUEST_map-icons.md`);
  until then a place is a coloured dot.
- **Who sees a hidden layer (Nate, 2026-09-26):** a secret faction's members, and the members of any faction in its
  circle: a werewolf pack sees the other packs, a vampire clan the other clans (Clan Volkihar counts as one). Cults see
  only their own, pending Nate's call. The faction list follows the same rule; members outside your own faction stay hidden.
- **It ships with the faction panel,** in the client package (the front), and needs no client script change.
- **Live:** when ownership or a war changes, the server pushes the change to every open map.

## 4. Official war

**Closed during the alpha** (Nate, 2026-09-26): war and raids stay switched off (`war.enabled`, `raids.enabled`) until
the holds and factions are set up. The map, the owners, the treasury and peace treaties work meanwhile.

0. **Capital** (Nate, 2026-09-27). A faction's leader, or a hold's ruler, chooses the capital in the Realm tab: one of its
   own territories (a hold: one in its own hold), or, for a faction that is not a hold, the spot where the leader stands
   (indoors, the room itself). Once every 7 days, never while at war; staff set any faction's with `/war seat`. A hold
   that has not chosen keeps its capital territory. Taking a hold's capital, chosen or not, takes the hold. The map
   crowns capital territories and marks seats with a banner in the faction's colour.
0. **Muster.** Every member of the declaring faction who is online must be at its capital when it declares (Nate,
   2026-09-26). A hold's capital is its capital territory: the grounds around the land marker (3000 units) and the
   castle's own rooms (for Bruma, Castle Bruma's six interiors). Another faction musters at a seat staff set
   (`/war seat <faction>`, where the admin stands) or at a capital it has taken; with none it cannot declare.
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
6b. **Peace treaty.** Two leaders not at war may swear peace for 1 to 8 weeks from the faction panel: one offers, the
   other accepts. While it holds, neither may declare war on the other. It is announced to everyone.
7. **Record.** Every war is kept: the declaration, each capture, the outcome. The map's history view shows it.

Limits against abuse:
- One offensive war at a time per faction.
- 10 members of the declaring faction and 10 of the target must be online when war is declared.
- A declaration fee of 10,000 gold, paid from the declarer's treasury, so it is not free to threaten.
- A new faction cannot be declared on for its first week.
- Two weeks before the same faction can be declared on again by the same declarer.
- The same Discord account cannot fight on both sides.

## 5. Raids and pillage

Smaller than war, and no land changes hands.

- **Raid:** a faction leader or a ruler sends a band against a territory's stores. No week's notice. The defenders are
  warned as the raid begins: a message to the territory's officials and guards, and a map ping.
- **Pillage:** during the raid, a raider who uses the door of a claimed home in the raided territory, or one of its
  containers, breaks in: the take comes straight out server-side (the housing system's locks are not opened). Each home or
  container gives up **3 items chosen at random** and **15% of the gold** in it, once per raid; a home counts its containers. Gold in
  the bank, personal or treasury, is safe: the bank cannot be raided.
- **Consequences:** raiders become wanted in that hold (the jail and bounty systems), and a territory cannot be raided again
  for **3 days**.
- **Fairness:** a raid can only start while **5** of the defending side are online (its officials, guards or members), so
  homes are never emptied while their owners sleep.

## 6. Death in war

Every fight goes through the down state first (`downed.js`).
- War deaths are **not** permanent by default.
- The declaring leader may propose a war **to the death**. It becomes one only if the defending leader accepts it in their
  panel before the war starts; if they refuse, the war goes ahead without permadeath. The announcement says which it is.
- Anyone who fights in a war to the death accepts the risk.

## 7. Taxes, wages and the treasury

Each hold's treasury becomes the centre of a small economy. Rent already goes into it (`tenancy.js`); with the bank
(section 8) the treasury is a bank balance rather than gold lying in a chest.
- **Tax rate.** The ruler of a hold (Jarl, Count, Chieftain), or the leader of a faction that owns land, sets one tax rate
  for their land, from 0% to 30%.
- **Weekly property tax.** Every week, every privately held property in their territories owes the tax rate times its
  assessed value into the owner's treasury: houses granted by officials and rented houses alike. It is taken from the
  holder's bank account. A property's assessed value is set by the steward, from a default by the kind of house. Unpaid
  tax works like overdue rent today: the holder and the officials are told, and an official may give a week's grace or
  seize the property.
- **Wages.** Guards and soldiers are paid every week from the treasury: every guard rank of a hold or stronghold, and a
  faction's soldier ranks. The ruler or leader sets the wage per rank. Wages go straight into the member's bank account,
  so nobody has to be online on payday. If the treasury cannot pay, the wage is owed and paid first once the treasury
  refills, and the ruler sees who is unpaid.
- **The weekly reckoning.** Once a week each treasury takes in its taxes and pays its wages, and its ruler gets a summary:
  income, wages, balance, and anyone overdue or unpaid.
- **Land that pays.** Taxes are why land matters: more territories mean more property to tax. This is also why a war over
  land is worth fighting.

## 8. The bank

Gold is carried on the body, where it can be lost to death, theft and raids, or kept in the bank, where it is safe.

- **Where:** the `TheBank` activator (an ACTI in `DragonBreak.esp`, placed in the bank building of each town). Today there
  are banks in Whiterun, Riften, Solitude, Windhelm, Markarth, Falkreath, Morthal and Winterhold (plus an old Whiterun
  bank cell), and **none in Bruma or Dawnstar**. Bruma needs one before the bank ships, since everyone is in Bruma: staff
  can place one with the Place tool (`placement.js`), or it is added to the plugin on the PC.
- **One account, every town:** gold deposited in Falkreath can be withdrawn in Bruma. Accounts are per character (a
  character's savings stay with that character, like their inventory; moving gold to another character means a trade).
- **The bank panel:** using the activator opens it: the account balance, deposit and withdraw, and the last transactions.
- **The treasury tab:** hold rulers (Jarl, Count, Chieftain) and faction leaders also see their treasury in the panel:
  - they can **deposit** their own gold into it;
  - **no one can withdraw** from it, to prevent corruption; its gold is spent only by the game itself: wages, the war fee,
    contracts and board fees;
  - taxes and rent are paid into it;
  - the leader sees its balance and the weekly reckoning (section 7).
- **The treasuries move into the bank.** Each hold's treasury chest today (seeded with 10,000 gold) becomes a treasury
  balance, moved over once; contracts, board fees and rent then read and write the bank instead of the chest.
- **Safe by design:** the bank is a server ledger, never a container in the world, so it cannot be looted, lockpicked or
  raided. Every deposit and withdrawal takes the gold from, or gives it to, the character in the same step, is written to
  disk before it is confirmed, and goes to the audit log. One transaction at a time per character, so a double click cannot
  pay out twice.

## 9. The leader's panel

No new key: the faction panel (F3, `guilds.js`) gains a leader's section.
- **Rulers and faction leaders:**
  - the tax rate and the wage for each rank;
  - the treasury: balance, last week's reckoning, and who is overdue or unpaid (deposits into it are made at the bank);
  - officials: appoint and dismiss (as `/appoint` and `/dismiss` do);
  - war: declare (target, goal, the three battle windows, to the death or not), accept or refuse a war to the death, make
    peace or surrender;
  - raids: send one, and see raids against their land.
- **Stewards and their equivalents:** property only: list houses for rent, offer, remind, grant grace, evict, and set a
  property's assessed value. No taxes, wages or war.
- **Members:** see their faction's land, wars and their own wage.

Faction colours are not in the panel: each faction's map colour comes from its lore heraldry (hold banners, guild colours),
set by staff in one table.

## 10. The Great Hunt fits on top

Werewolf pack territories are territories on a pack's secret layer. Territory wars between packs are wars with pack rules
(a week-long contest scored by hunting, feeding and fighting, per the Great Hunt design). The map, the ownership engine and
the war lifecycle are built once and reused.

## 11. Build order

Built 2026-09-26 (server branch `realm`, front on fork `client-0344`): phases 1 (the bank, live), 2 (map with the terrain
image from `tools/realm-map/render.py`), 3 (ownership), 4 (taxes, wages, the Treasury tab), 5 (war), 6 (raids) and 7
(hidden layers, Namira's shrine first). The terrain map, the icons and the war, raid and treasury tabs reach players with
client 0.3.50.

| Phase | What | Ships as |
|---|---|---|
| 0 | Vampire Lord remote body (Worker B, in progress) | gameplay |
| 1 | **The bank** (standalone, first): accounts, the bank panel at `TheBank`, the treasury tab (deposit only), treasuries moved from their chests; a bank placed in Bruma | gameplay + front (+ a placement) |
| 2 | Terrain map generator (Cyrodiil and Bruma first); `territories.json` for Bruma and its neighbours; Realm Map, read-only: territories, owners, rulers | generator + client package (widget, key) + gameplay |
| 3 | Ownership engine: land markers, `territory-owners.json`, nearest-marker borders driving housing, boards and treasuries; staff tools (`/territory`) | gameplay |
| 4 | Taxes (0-30%), wages and the weekly reckoning, paid through the bank; the leader's panel in F3; stewards' property section | gameplay + front |
| 5 | Official war: declaration (10 online each side, 10,000 gold, a week's protection, 2-week cooldown), week's notice, announcements (game, map, boards, Discord), three battle windows, capture, officials losing rank, peace, to-the-death agreement, history | gameplay + front |
| 6 | Raids and pillage: 5 defenders online, break-ins give 3 random items and 15% of the gold, 3-day cooldown | gameplay + front |
| 7 | Secret layers for cults, clans and packs | gameplay + front |
| 8 | The Great Hunt on this engine | per its own design |

Each phase is tested with harnesses like the other systems, reviewed, and shipped through the staged updates.

## 12. Numbers (Nate, 2026-09-26)

All in config, so they can change without code.

| Setting | Value |
|---|---|
| Battle windows | three per war, two hours each, chosen by the attacker from staff-set evening slots |
| Declaring war | 10 members online on each side; fee 10,000 gold from the declarer's treasury |
| New faction protection | one week |
| Declaring on the same faction again | after two weeks |
| Raid | 5 defenders online; break-ins give 3 random items and 15% of the gold; 3 days before the same land again |
| Tax rate | 0% to 30%, set by the ruler or leader |
| Faction colours | Nate's table in `gamemode-config.json` `war.colours` (the Companions red with a yellow stripe); the cults' and the Vigil's picked by motif |
| Muster | every online member at the capital (3000 units of its marker, or inside its rooms) |
| Peace treaty | 1 to 8 weeks |
| War and raids | off (`war.enabled`, `raids.enabled` false) until the alpha's holds and factions are set up |

Still open: the exact evening slots and their time zone, and the default property values by kind of house.
