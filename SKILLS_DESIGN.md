# DragonBreak Online skills: design review and build plan

Written 2026-09-14 from your spec. Template: `skills.json`. Read this before the
template; the review changes a few things.

## What already exists (and why the plan reuses it)

Alduinak ships a mastery system on the K key today:

- one profession per character, eight professions, four ranks;
- rank comes from **server-verified activity points** (a craft the server
  validated, a vein you struck, an animal you killed) with a minimum interval
  between points, so a modified client cannot farm it;
- each rank grants an inert **marker spell**; recipes carry a `HasSpell`
  condition on that spell. That is the only gate Skyrim's crafting menu and the
  server both honour. Perks cannot be used: SkyMP never syncs perks and the
  server treats `HasPerk` as true, so a forged craft would pass.
- vanilla skill XP and level XP are switched off on the client
  (`disableSkillAdvanceService`).

Your system is that machinery with three chosen skills, five tiers and sixteen
skills. Everything below is phrased as changes to it.

## Review of the spec

Keep as written:
- Sixteen skills in three groups, three chosen. Good spread, and three is the
  right number for an economy where nobody is self-sufficient.
- Five tiers. Alchemy, Smithing and spells already have five natural steps
  (Novice to Master spell ranks, iron to Daedric), so the ladders line up.
- Stations usable only with the skill. The server's `onActivate` hook can
  refuse a station cleanly with a notice, the same way housing refuses a
  locked door.
- Scholar's "books are nodes" idea. It turns 900 static books into content and
  makes the Scholar a real trade.

Change or decide:
1. **Tier progress source.** Do not tie tier progress to vanilla skill XP; it
   is client-side and forgeable. Use the activity points the mastery system
   already validates. Proposed thresholds per skill: Tier 2 at 10 h of that
   activity, Tier 3 at 30 h, Tier 4 at 70 h, Tier 5 at 150 h. Three maxed
   skills is roughly 450 hours of play, which is the right length for an RP
   server year.
2. **Vanilla skills follow the tier, not the other way round.** When a tier is
   reached the server sets the linked vanilla actor value (Tier 1 = 15,
   Tier 2 = 30, 45, 60, 75). Proficiency then works through the vanilla
   damage and crafting formulas for free, and the number is server-owned.
3. **Swapping skills.** "Three at a time" needs a rule for changing your mind.
   Proposal: dropping a skill wipes its tier progress and starts a 7-day
   cooldown before that slot can be filled. Without this people rotate skills
   before each craft.
4. **Vanilla level cap 5, perks off.** Level should come from the skills, not
   from a separate XP track: level = floor(sum of the three tiers / 3). Each
   level grants +10 to Health, Magicka or Stamina, chosen by the player. That
   makes level a summary of mastery instead of a fourth thing to grind.
5. **Smelter belongs to Blacksmith, not Woodcutter.** Smelting ore into ingots
   is metalwork; Miners hand ore to Blacksmiths. Give Woodcutter a charcoal
   kiln instead (a retextured smelter placed at lumber mills). If you want
   Woodcutters to feed the forge, charcoal becomes an ingredient in steel
   recipes. That is a stronger economic loop than sharing the smelter.
6. **Shield: rename to Block** in the UI. It is the Block skill and covers
   weapon blocking too.
7. **Armor tiers as permission to wear, not just a bonus.** Tier 1 light,
   Tier 2 medium (Tailor's scaled and studded), Tier 3 heavy, then rating
   bonuses. Wearing above your tier works but at a stiff penalty (say -40%
   rating and stamina drain) so it is a choice, not a wall.
8. **Arcane Arts and Priest share one spell-learning mechanic.** Three known
   spells per skill, learned by studying a tome at a place: the Arcanaeum for
   Arcane, a temple of the Divines for Priest. Tome rank maps one-to-one onto
   tier (Novice tome needs Tier 1, Master tome Tier 5). Forgetting a spell to
   learn another is free but takes a study session. The server grants the
   spell through Papyrus so it is recorded in the character's learned spells
   and survives relogs.
9. **Enchanter, weapon-only.** Fine. Also let Tier 5 keep the soul gem on a
   failed enchant so the top tier has a flavour bonus, not just a bigger list.
10. **Skinner** covers hunting kills and tanning. Consider letting Tier 4+
    skin humanoid-race creatures (trolls, spriggans) for rare materials.
11. **Cook and Alchemist overlap** on ingredient gathering. Gathering stays
    open to everyone; only the stations are gated. Otherwise nobody can pick a
    flower.

## Mini-games

Keep each under eight seconds and make the server the judge of the outcome:

- **Mining**: a moving marker on a bar; a hit inside the green zone counts a
  strike. Strikes per vein by Miner tier. The client reports the number of
  good hits; the server clamps it to the tier maximum and rolls yield.
- **Woodcutting**: rhythm presses on a beat; each hit is a strike, four to
  twenty by tier. Same clamp server-side.
- **Reading**: put the sentence in order or turn pages before the candle
  gutters. A win rolls the Scholar tables (book copy, scroll, tome).
- **Lumber mill**: no game. Activate once, get the tier's firewood, thirty
  minutes of cooldown per player per mill. Woodcutter only.

The pattern is the same for all four: the client runs the game and sends a
score, the server ignores anything above the tier's ceiling, decides the
loot, and hands it over. A cheated client can at best get the maximum an
honest player of that tier gets.

## Build plan, in order

1. **Marker spells**: 16 skills x 5 tiers = 80 inert Ability spells in
   `DragonBreak Online Edits.esp` (`DBO_Skill_<id>_T<n>`). Scriptable in xEdit;
   the existing `DBO_*.pas` scripts show the pattern.
2. **Server (TypeScript, local build)**: extend `masterySystem.ts` to hold up
   to three skills per character, five tiers, categories, per-skill activity
   rules from `skills.json`, station gating in `onActivate`, vanilla actor
   value sync on tier change, swap cooldown. The server bundle rebuilds with
   `npm run build-ts` in `skymp5-server`; no C++ change.
3. **Front (React, local build)**: the K menu shows three groups, three slots,
   tier ladder per skill, confirm on choose and on drop.
4. **Client (TypeScript, local build)**: menu plumbing is already there; add
   the mini-game widgets and the study emote.
5. **Recipes**: add `HasSpell` conditions to every gated COBJ in the plugin,
   by tier. Also scriptable.
6. **Books as nodes**: mark BOOK base forms untouchable (existing
   `untouchableBaseIds` mechanism), catch their activation, run the reading
   game, spawn the reward.

Estimated effort: step 2 is the big one, two or three sessions. Steps 1 and 5
are an afternoon with scripts. Steps 3 and 4 are a session each.

## Height slider (separate, small)

SkyMP does not sync character scale, so the RaceMenu height slider today is
invisible to everyone else and resets on relog. Fix: a gamemode property
`ff_scale` visible to neighbours. The client reports its own scale after
RaceMenu, the server clamps it to 0.94 to 1.06 and stores it, every client
applies it to that actor. Anything outside the band snaps back on the owner's
own screen too, so nobody can be a giant locally.

## Additions from the 2026-09-14 follow-up

### Spell study points, not the Arcanaeum

The blue well in the Hall of the Elements is a movable static
(`MGMagicFirePillar01`, `108d6f:Skyrim.esm`), not an activator, so nobody can
"use" it. Study is therefore a **place**: `spellStudyPoints` in `skills.json`
lists a reference plus a radius. Standing within six metres of the well and
using the study action (the K-menu button or `/study`) with a tome in your
inventory learns the spell, subject to the Arcane Arts or Priest tier. More
places later are one entry each: a temple altar for Priests, a court wizard's
study, a hedge mage's hut. No plugin edit needed.

### Praying at shrines

Anyone may pray at a shrine of the Divines; it is not gated. The vanilla
activation is blocked (it would hand out the blessing every time) and a short
prayer runs instead: hold the key through three verses, release early and the
prayer ends with no roll. Then:

- everyone: 2% chance of that shrine's blessing;
- Priests: 5 / 10 / 15 / 20 / 30% by tier, and the prayer counts as Priest
  activity, so praying is a way to rank up alongside casting;
- blessing lasts 8 hours at the low end and a full day for a Tier 5 Priest;
- one prayer per shrine per player per hour, so shrine-hopping is a pilgrimage,
  not a farm.

The nine shrine activators are already known by form id (see `praying.shrines`
in `skills.json`); Nocturnal's shrine is deliberately left out until you decide
whether Daedric shrines belong in the same system.

### Deity choice after character creation

A popup right after the character creator closes: pick the god you worship.
The list is `deities.choices` in `skills.json`: the Nine, Auri-El, and the
Daedric Princes. Daedra are allowed. The choice is stored on the character
and decides which shrines answer your prayers; every other shrine gives a
notice and no roll.

Wire contract, same shape as the character select menu:

    Server -> Client: { customPacketType: "deityMenu", deities: [{ id, name, kind, note? }] }
    Client -> Server: { customPacketType: "deityChoose", deity: "<id>" }

Conversion: `/convert` while praying at the new deity's shrine, 30-day
cooldown, current blessing stripped. That keeps a change of faith an event.

Shrines that exist as activators today: the nine Divines, Auri-El (Forgotten
Vale), Malacath (your custom shrine at six strongholds and Gol-Kharzum), Azura
(Skyrim and Solstheim), Boethiah and Mephala (Solstheim only), Mehrunes Dagon,
Molag Bal, Nocturnal. Hircine, Meridia, Sanguine and Sheogorath are choosable
but have no usable shrine until one is placed; the template marks them.

Blessings: the Divines and Nocturnal use the vanilla blessing spells. Every
other Daedric boon has to be authored in the plugin (a placeholder per deity is
in the template). Suggested flavour: Malacath +stamina and power-attack cost,
Azura night vision and magicka regen, Boethiah sneak damage, Mephala poison
duration, Mehrunes Dagon fire damage, Molag Bal absorb health on hit.

Talos is worth an RP hook: worship is illegal under the Concordat. Nothing
mechanical yet, just a note on the choice so players know what they are
signing up for.

## Ownership menu on X (2026-09-14)

Today the housing menu (Alduinak) offers claim, abandon, lock, unlock, rename,
transfer, cut key, revoke keys, grant container. Guest access is a physical key
item. The requested change:

- When X is pressed on an owned door or container the menu shows, under the
  actions: **Owner: <name #tag>**, then **Guests** as a scrollable list of
  `<name #tag>` rows with a remove button on each (owner and hold officials
  only), then **Add guest**.
- Add guest opens a text field. Typing resolves against online characters
  first (exact name, then name #tag), then against the property's known
  players. Ambiguous names show the candidates with their tags.
- Server side: `propertyRequest` gains `addguest` and `removeguest` with a
  `guest` field (`"Name #TAG"` or a profile id); `propertyMenu` gains
  `owner: {name, tag}` and `guests: [{name, tag, profileId}]`. Access checks
  treat a listed guest like a key holder. Keys keep working as an RP item.
- Guest lists are capped at 50 per property; the list scrolls in the widget.

### Character tag

Every character gets a four-character tag from the set A-Z 2-9 (no 0/O/1/I) at
first spawn, stored on the actor (`private.charTag`) and never changed. Every
place a name is shown to another player (menus, guest lists, admin panel,
/players) prints `Name #TAG`. Name changes keep the tag, so a rename cannot be
used to impersonate. Implemented in gamemode.js; the menus pick it up as they
are built.

### Respec at standing stones

The standing stones are the only place to change the three chosen skills.
Activating a stone (the vanilla DoomStone activators) opens the K menu in
respec mode: drop any of the three, pick replacements, confirm. The first
respec on a character is free; every one after costs 1,200 gold, taken from
the inventory when the choice is confirmed. Dropped skills lose all tier
progress. The stone replaces the 7-day swap cooldown proposed earlier: the
gold is the cost. Deity choice is untouched.

### Admin-only character edits

Players cannot reopen character creation or rename themselves. Admins do it
for them by tag, and both land in the Discord GM log:

    /chargen <player|#TAG>              opens character creation for that player
    /rename  <player|#TAG> <new name>   renames the character, tag unchanged

Both are live in gamemode.js.

### Harvesting (17th skill, Support) and the no-pickup rule

Harvesting gates the world's resource nodes: plants, mushrooms, nests, and
gold pouches. Unskilled players get a 25% chance at half yield; tiers raise
the chance to certain and the yield to double. This supersedes the earlier
note that gathering stays open to everyone: Harvesters supply the Alchemists
and Cooks, which is the intended economy.

Nothing lying in the world can be picked up with E. Loose items placed by the
plugins (clutter, weapons on tables, ingredients on shelves) are not loot.
Resources come only from nodes, containers, crafting and trade. Items dropped
by players stay pickable, since those are dynamic references the server
created, so trading and dropping keep working.

Build note: Alduinak already has the pieces for this. The untouchable system
blocks activation of listed base forms on both client and server (no prompt,
no pickup), and the gathering system owns node yields. The change is to make
the untouchable rule "every item-type base form placed by a plugin" instead of
a short list, and to move coin purses from untouchable to harvestable.

### Farms stay open

Crops, orchards and gardens are not claimable. Anyone with Harvesting can take from any field; keeping thieves off a Jarl's farmland is a job for guards, patrol routes and bounties, decided in play.

### Shield merged into Defense

Block, Light Armor and Heavy Armor are one skill, Defense. Every melee build is weapon + Defense + one free slot; mages are Arcane + Priest + one free slot. Combat is five skills, sixteen in total.
