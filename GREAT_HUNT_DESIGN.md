# The Great Hunt: werewolves reworked

Status: **stage 1 built on branch `great-hunt-1`, not live.** Design by swag and the DragonBreak team (patch note "The Great
Hunt: werewolves reworked (planned)"). Stage 1 is gameplay only: no plugin, no client package. Everything below is
config (`gamemode-config.json` `greatHunt`), so the numbers can change without code.

## Stage 1 (built): ranks from living as a werewolf

**Renown** (kept on the character, `private.greatHunt`; a cure or the end of the curse resets it):

| Earned by | Renown |
|---|---|
| Feeding in beast form on a fresh animal | 5 |
| Feeding in beast form on a fresh humanoid NPC | 10 |
| Feeding in beast form on a player this werewolf slew | 60 |
| A creature or NPC slain in beast form | 2 |
| Each transformation | 2 |

A werewolf in beast form now feeds on any fresh corpse, beast or person (it was people only). A vampire still feeds only on
people.

**The farming rules for players** (from the 2026-09-26 review): a player counts only when this werewolf dealt the killing
blow, outdoors and outside a city (Bruma: 3500 units around its map marker; `greatHunt.cities`), once per victim account per
real day, and never a partymate or another character of the werewolf's own account. A refused feed says why.

**Ranks and what they set** (index 0-4):

| Rank | Renown | Beast form | A feed adds | Changes a game day | Forced changes | Hits taken / dealt in beast form |
|---|---|---|---|---|---|---|
| Fledgling | 0 | 150 s | 30 s | 1 | as now | x1 / x1 |
| Prowler | 100 | 180 s | 35 s | 1 | x0.85 | x0.95 / x1.05 |
| Hunter | 300 | 210 s | 40 s | 2 | x0.7 | x0.9 / x1.1 |
| Blood-Howler | 700 | 240 s | 45 s | 2 | x0.5 | x0.85 / x1.15 |
| Elder | 1500 | 300 s | 60 s | 3 | x0.25 | x0.8 / x1.2 |

- "Forced changes" multiplies both the feral chance (hunger, night, full moon) and the full-moon hourly chance.
- The damage factors ride the same hit multiplier as the skill tiers and silver (gamemode.js).
- A pack's Alpha keeps the pale coat and is still spared forced changes, as before. "Alpha" stays the pack leader's title,
  so the top renown rank is Elder.
- Rank-ups are announced to the werewolf (chat and banner) and audited. `/hunt` shows the rank, renown and next rank.

**Howls are heard across the land:** when a werewolf howls (Howl of Terror today), everyone else online reads "A howl echoes
through <region>", at most once a minute per werewolf.

## Stage 2 (needs a client package)

- New howls by rank: Howl of Rage (speed and regeneration; the speed half needs the client, since it can only slow players
  today), Howl of the Hunt (track your prey), and Howl of the Pack for the Alpha (packmates get the rage).
- Changing back at will for the top ranks (a revert power for werewolves, like the Vampire Lord's).
- A howl sound for everyone in the region.

## Stage 3: pack territories

Packs claim territories on the Realm map's hidden layer and hunt there for more renown; rival packs declare a territory war
over a week (WAR_DESIGN.md section 10). Starts near Bruma while the region lock is on.

## Stage 4 and later

- Rank looks (needs the rank textures: More Werewolves SE's author's permission, or a required Nexus download plus our
  patch plugin; PC work).
- Growls and the voice filter, after voice chat goes live.
- "Silver ends a werewolf for good" and feral changes that must feed before changing back: both need Nate's rules first
  (which silver deaths are permanent, and a time limit so no one is stuck as a beast).

## Decisions for Nate

1. The rank names and thresholds above (Fledgling, Prowler, Hunter, Blood-Howler, Elder at 0/100/300/700/1500).
2. Whether the damage factors apply in PvP too (they do now, like silver).
3. The permanent-death rule for silver (stage 4).
