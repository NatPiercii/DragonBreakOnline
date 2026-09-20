# The Wheel of Skills - skill system brief

Written 2026-09-20. Short version of `SKILLS_DESIGN.md`, meant to be handed to someone who has not
been in the design sessions. Full design, rejected options and open decisions are in that file.

## The shape of it

Every skill runs 0 to 100. Level 0 means untouched, and you take up a trade simply by using its
station. A character holds **300 points total** across all seventeen skills, so holding every skill
at Novice costs 17 points, while one master costs a third of everything you have.

- Pool: **300** points across all skills
- Per skill: **100** hard ceiling
- Above 90: **one** skill only (the Seat)
- Above 75: **three** skills only

That last pair is the point of the design. Ebony is meant to need a Miner at 95 and daedric a
Blacksmith at 95 to 100, and since one character can hold only one skill above 90, a daedric cuirass
needs a master smith, a master miner and a master conjurer who are three different people. Scarcity
is what forces players to deal with each other.

## How points are earned

Only the server grants points, and only from events it validated itself: a craft where it checked
the bench and the ingredients, a kill where it checked the cell and the distance, an ore vein where
it judged the swings. A modified client cannot inject progress.

Work is metered by a **token bucket**: 20 units held at most, refilling 30 an hour. The bucket
decides how much progress an hour can hold; the act's weight (0.5 to 3.0) only decides which work
fills it. Hunger slows it, the same multiplier the old system used. Doing the same thing to the same
target repeatedly decays - the ninth identical act in an hour is worth half - and that counter is
stored on the character, so relogging does not reset it.

Time to climb, played saturated:

| Tier | Level | Hours | Daily ceiling |
|---|---|---|---|
| Novice | 1 | - | 360 units |
| Apprentice | 25 | 8 | 360 units |
| Journeyman | 50 | 25 | 360 units |
| Expert | 75 | 58 | 180 units |
| Master | 90 | 98 | 60 units |
| Ebony | 95 | 132 | 60 units |
| Daedric | 100 | 198 | 60 units |

The daily ceiling at the top is deliberate. Even played perfectly, 90 to 100 takes about **50 real
days**, which no amount of grinding or AFK macroing can buy down. The five tiers survive as bands of
level, so every existing gate, marker spell and recipe condition keeps working untouched.

## How points are lost

Nothing decays while you are offline, ever. A skill only falls when another rises past your 300 and
has to take the points from somewhere. The player decides where from, using the moons - Masser and
Secunda being Lorkhan's sundered flesh, which is the conceit the menu runs on.

- **Waxing** - rises with use, gives way only when nothing is waning
- **Held** - never falls; your trade is safe while you swing a sword
- **Waning** - the first to give way when something else rises

Nothing ever drops below level 25, and if no skill can give, the gain is refused with a notice
rather than silently lost. A standing stone still opens the respec window for deliberate reshaping.

## What happens to existing characters

Old records convert the first time they are read, at 30 units per hour worked. Every character lands
inside the tier they already hold, slightly above its floor:

| Old record | Hours | Becomes level | Tier |
|---|---|---|---|
| Apprentice | 10 | 27 | Apprentice, unchanged |
| Journeyman | 30 | 53 | Journeyman, unchanged |
| Expert | 70 | 79 | Expert, unchanged |
| Master | 150 | 96 | Master, unchanged |

Three maxed skills convert to 288 of the 300 pool, so no existing character can be over cap and
nobody needs a refund. Their old three skills start Waxing, everything else Held, so nobody starts
bleeding progress they did not agree to. Two changes are pure gifts: they can hold more than three
skills now, and the old "drop a skill and lose every hour" rule is gone.

## Running it

- `server/skills.json` -> `pointSystem.enabled`. Set `false` and restart to fall back to the old
  ladder; the record keeps both shapes, so nothing is lost either way. Currently **on**.
- That file is read **at boot**, so flipping it needs a server restart, not a gamemode reload.
- Engine lives in `masterySystem.ts` with the arithmetic split into `skillPoints.ts` (server
  rebuild). The menu is a front rebuild; the lock control needed a client rebuild too, so players
  re-download.
- Progress is stored per character in `private.mastery` as a v2 record. `order` and `rank` are still
  written as derived fields, which is why no other system needed changing.

What to watch in the log:

- `[skills] ready: ... point system ON: pool 300, cap 100 ...` at boot confirms which mode is live.
- A credit-rate line every 15 minutes: events by kind, points credited by skill, and how many came
  from characters with no skill yet. That is the tuning data.

## Honest status

- **Done and verified.** The arithmetic has 110 tests covering the bands, the caps, the bucket,
  repetition decay, donor selection and the migration. The server boots clean in both modes, and the
  menu is rebuilt around levels, the pool and the moons.
- **Not proven yet.** No player has earned a point in game. The next session's first job is to log
  in, take a trade at a forge or a vein, work it, and watch the levels move.
- **Weights are provisional.** Every act currently uses its base weight; the real inputs (product
  value, target health, magicka cost, damage taken, ore band) are not wired in. A week of the credit
  log should set them, rather than guessing the numbers.
- **Crafting is not gated yet.** "Ebony and daedric are crafted only, never found" holds on the loot
  side, but no recipe carries its skill condition yet. All 85 marker spells exist in the plugin;
  nothing reads them at a forge. That is plugin work.
