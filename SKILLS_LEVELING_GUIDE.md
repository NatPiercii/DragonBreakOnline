# Time to Mastery - how long a skill takes

Player-facing guide. Figures generated 2026-09-20 from the live engine (`skillPoints.ts` bands and the
`pointSystem` block of `skills.json`), not estimated. Design rationale is in `SKILLS_DESIGN.md`.

## The short answer

Progress is measured in **hours of validated work on that one skill**, not hours logged in. Wandering,
talking and travelling are worth nothing.

| Level | Hours of work | 1 h/day | 2 h/day | 4 h/day |
|---|---:|---:|---:|---:|
| 1 - first touch | 0.3 | 1 day | 1 day | 1 day |
| 10 | 3 | 4 days | 2 days | 1 day |
| 25 - Apprentice | 8 | 9 days | 5 days | 3 days |
| 50 - Journeyman | 25 | 25 days | 13 days | 7 days |
| 75 - Expert | 58 | 59 days | 30 days | 15 days |
| 90 - Master | 98 | 99 days | 50 days | 25 days |
| 95 - ebony | 132 | 132 days | 66 days | 41 days |
| 100 - daedric | 198 | 199 days | 100 days | 75 days |

The 4 h/day column stops pulling ahead near the top, because past level 90 a skill accepts only two
hours of work a day and ignores the rest.

## What one hour of work actually holds

Each skill carries its own bucket that fills at **30 units an hour** and holds 20 at most. Every act
spends from that bucket; when it is empty the work still happens, it just stops counting until the
bucket refills.

- Refill: 30 units per hour, per skill
- Stored while away: 20 units (about forty minutes of work waiting at login)
- Most acts: 0.5 units each
- To saturate an hour: about 60 acts, one a minute

The bucket is **per skill**, so alternating between the forge and the mine costs neither one anything.
Two skills can run at full rate in the same hour.

## The four things that slow you down

1. **Doing the same thing over and over.** Repeating the same recipe, vein or target is worth less each
   time: the ninth in an hour is worth half, bottoming out at a third. Grinding one iron dagger needs
   roughly 180 acts an hour to fill the same bucket 60 varied acts fill.
2. **Starving.** At hunger 90 your work counts for a quarter until you eat. Hunger climbs 12 an hour
   online, so a long unbroken session reaches starving in under eight hours.
3. **Not having taken up the trade.** Nothing counts until you open the skill at its own station - a
   forge, a vein, a tanning rack. Opening a trade costs one point from your pool.
4. **The daily ceiling, once you are high.** Below 75 it is 360 units (twelve hours on one skill, so
   effectively no limit). From 75 it is 180 (six hours). From 90 it is 60 (two hours).

## What a single level costs

| Levels | Work | Varied acts | Same thing repeated | Fastest possible |
|---|---:|---:|---:|---:|
| 1 - 24 | 20 min | 20 | 60 | - |
| 25 - 49 | 40 min | 40 | 120 | - |
| 50 - 74 | 1 h 20 | 80 | 240 | - |
| 75 - 89 | 2 h 40 | 160 | 480 | 2 a day |
| 90 - 94 | 6 h 40 | 400 | 1,200 | 1 per 3 1/3 days |
| 95 - 99 | 13 h 20 | 800 | 2,400 | 1 per 6 2/3 days |

**90 to 100 takes fifty days, minimum.** Three thousand units against a ceiling of sixty a day. Played
perfectly, with no wasted act and no day missed, that is seven weeks.

## Breadth or depth

You hold **300 points** across all seventeen skills, one point per level. Two hours a day for a month
buys either:

| How you spend it | After 30 days |
|---|---|
| All 2 h on one skill | That skill at **75** - Expert, one of your three |
| 30 min each on four skills | Four skills at **35** - all Apprentice, none notable |

Only three skills may sit above 75, and only one of those may pass 90. In practice the pool binds
first: a Seat at 100 with two Experts at 89 spends 278 of 300, leaving 22 points for everything else.

Points leave a skill only when a gain would push you past 300, and you choose which gives way: mark
skills **Waning** to spend them, **Held** to protect them. Nothing falls below 25, nothing decays
offline, and if nothing can give way the gain is refused with a notice rather than taken silently.

## Working it efficiently

- **Eat first.** A quarter rate is worse than any other mistake on this list.
- **Bring variety, not volume.** Sixty different acts beat two hundred identical ones.
- **Work two trades in one session.** Separate buckets, no penalty - smelt while the mine respawns.
- **An hour a day beats seven hours on Sunday** once past 75; the ceiling resets daily and unspent days
  are gone.
- **Stop at the ceiling.** Past 90, two hours is the whole day's allowance.

## What may still change

Every act is currently worth its base value - 0.5 units, or 1 for prayer and picking a lock. The
intended rule is that heavier work counts for more (a valuable craft up to 3 units, ebony ore more than
copper, a hard kill more than a rat), but those inputs are not wired in yet. So the **act counts are
floors and the hour counts are what really holds**. The hours-to-level ladder is not expected to
change; what changes is how few acts it takes to fill an hour.
