# DragonBreak Online: deities, shrines and prayer

**Status:** design, 2026-09-20 03:10. Nat's brief, taken down the night the point system went live. Nothing
below is built. **Most of it is already specified in `server\skills.json`** under `deities` and `praying` -
read those blocks before writing anything, because they are more detailed than this file in places.

## 1. The brief, as given

> A deity picker after the race menu. Shrine buff for all Daedra and Aedra. Anyone can use the pray
> emote / `/pray` to do a mini-game. A really rare chance to get the blessing from the shrine after praying.
> You can only pray at the shrine of your deity. You can only change deity once a week IRL, by a menu key.
> Priests have a higher chance per tier to get the blessing.

## 2. What already exists in skills.json (do not re-invent)

The `praying` block already specifies:

- **Own deity only** (`onlyOwnDeity: true`), other shrines answer with a notice and no roll.
- **The mini-game**: *"hold the prayer key through three verses; releasing early ends the prayer with no roll"*.
- **Blessing odds**: `everyone: 0.02`, `priestByTier: [0.05, 0.10, 0.15, 0.20, 0.30]`.
- **Blessing duration by tier**: 8 / 8 / 12 / 16 / 24 hours.
- **60 minute cooldown per shrine**, and `priestActivityPoint: true` so prayer credits the Priest skill.

The `deities` block already specifies the picker (*"a popup right after character creation, server packet
`deityMenu` -> client `deityChoose`, stored per character"*) and carries the nine Divines with their shrine
form ids and `BlessingOf*` spells.

**The `prayer` event kind is already wired**: `masterySystem` does `add("prayer", "priest")` in its candidate
map and `matches()` has a `case "prayer"`. Nothing emits it yet.

## 3. The three changes the brief actually asks for

1. **Conversion cooldown: 30 days -> 7 days.** `deities.conversionCooldownDays: 30` becomes `7`. The brief
   also moves conversion off `/convert`-at-a-shrine and onto **a menu key**, so this is a front widget
   (a deity menu) rather than a chat command. Keep "current blessing removed on conversion".
2. **Add the Daedric Princes.** The `deities.choices` list holds only the nine Divines. Aedra and Daedra
   should both be pickable.
3. **Nothing else.** The odds, the durations, the mini-game and the own-shrine rule are already what Nat
   described, which is a good sign the original design held up.

## 4. The problem that blocks all of it, found while looking up shrines

**Every shrine id in `skills.json` is a Skyrim shrine**, and the playtest is region-locked to Bruma
(`playtest.js`). A player cannot reach a single one of them, so prayer is unreachable today.

Beyond Skyrim ships its own, and they resolve cleanly:

| Deity | Cyrodiil wayshrine |
|---|---|
| Akatosh | `BSHeartland.esm:061B52` |
| Arkay | `BSHeartland.esm:061B53` |
| Dibella | `BSHeartland.esm:061B54` |
| Julianos | `BSHeartland.esm:061B55` |
| Kynareth | `BSHeartland.esm:061B56` |
| Mara | `BSHeartland.esm:061B57` |
| Stendarr | `BSHeartland.esm:061B58` |
| Talos | `BSHeartland.esm:061B59` |
| Zenithar | `BSHeartland.esm:061B5A` |

**Every shrine entry must become a list, holding both the Skyrim and the Cyrodiil base.** Until then,
shipping prayer means shipping something no player can use.

## 5. Daedric shrines that exist in this load order

Confirmed present, by editor id, via ck-mcp:

- `DragonBreak.esp:005DB6` **ShrineOfMalacath** (and a `...DUPLICATE001` at `0023BB` - check which is placed
  before wiring either; per the standing rule, a duplicate here may be deliberate).
- `Skyrim.esm:10E8B0` **ShrineOfNocturnal**, overridden by `man_DaedricShrines.esp`, which also adds its own
  `man_ShrineOfNocturnal` at `005A98`.
- `Dragonborn.esm:03A484` **Azura**, `03A481` **Mephala**, `039E34` **Boethiah** (all also overridden by
  Journey to Baan Malur).

**The other twelve Princes have no shrine activator in this load order.** That is the real scope of item 2:
either restrict the Daedric half of the picker to the Princes that have a shrine, or place new shrine
activators as plugin work. **Restricting is the recommendation** - a deity you cannot pray to is worse than a
deity you cannot pick, and Malacath alone gives the Orsimer somewhere to go, which pairs with the racial work
in `RACES_DESIGN.md`.

Blessings: the Divines have vanilla `BlessingOf*` spells. The Daedric Princes largely do not, so their
blessings need either new SPEL records (plugin work) or a reuse of an existing ability, decided per Prince.

## 6. Build order, by layer

1. **Data only, no code** (`skills.json`): add the Cyrodiil wayshrines to every Divine, set
   `conversionCooldownDays: 7`, and add the Daedric choices that have shrines. Read at boot, so a restart.
2. **Gamemode** (`server\*.js`, hot-reload): the shrine activation path. It belongs in the same
   `mp.onActivate` chain as `labour.js` - and note the lesson from that file: **a gate that refuses must
   `return false` and fall through, never `deny()` and stop the chain**, or the first-touch gate below it
   never runs (see the memory note `gamemode-activate-chain-runs-before-systems`). Emit the `prayer` event
   through `globalThis.__alduinakMasteryEvent('prayer', actorId, { refrId })` on a completed prayer, which
   is all `masterySystem` needs to credit the Priest.
3. **Front** (`fork\skymp5-front`): the deity picker widget and the three-verse prayer mini-game. Follow the
   `labour.js` pattern exactly - **the server issues the round and the server judges it**; a widget that
   decides its own verdict is the bug the competitive analysis lists as Tier 2 item 9.
4. **Client** only if the prayer needs a held key or an animation. The picker itself does not.

## 7. Decisions still needed from Nat

- **Which Daedric Princes** are pickable given only Malacath, Nocturnal, Azura, Mephala and Boethiah have
  shrines here. Restrict, or commission shrine placements?
- **What a Daedric blessing does**, since vanilla has no `BlessingOfMalacath` to borrow.
- **Whether a Daedric devotee is lawful.** `private.dboLawful` already exists and the guards read it; openly
  worshipping a Prince is a crime in the Empire, and Bruma is Imperial. This could be flavour, or it could be
  the first real faction consequence in the game. It is a bigger design question than the picker itself.
