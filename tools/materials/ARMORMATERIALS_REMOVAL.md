# Removing the interim `armorMaterials` override, once the ladder is in the records

The server override was the stopgap that made Dragonscale beat Ebony before the records said so. Once
`DBO_BlacksmithTiers.pas` has run and the plugins are live, it must go — but **not for the reason it is usually given**,
so it is worth being exact about what it does.

## It does not double-count

`gamemode.js`, `armorPieceOf`:

```js
piece.counted = Math.max(piece.rating, materialRatingOf(r, slot));
```

It takes the **larger** of the record's rating and the override's, never the sum. The config sets
`ArmorMaterialDragonscale` to `body 44, hands 17, feet 17, head 22, shield 33`, and the ladder sets exactly the same
numbers into the records. So the moment the records land, `Math.max(44, 44) = 44` and the override is already a no-op.
Nothing is double-counted, and nothing breaks if it is left in for a while.

## Why it still has to go

1. **Two sources of truth for one number.** The next time anyone changes Dragonscale they will change one of the two
   and not the other, and the server and the records will disagree with no error anywhere.
2. **It can only ever raise, so it silently masks a lowering.** This is the real hazard. If a later ladder decides
   Dragonscale should come *down* — to 41 again, say — editing the records alone would do nothing: `Math.max(41, 44)`
   still counts 44. The change would appear not to work, and the cause is in a config block nobody is looking at.
   That is exactly the failure mode `project foundation.txt` warns about, and it costs a play session to find.
3. **It costs work per armor piece for nothing.** `materialRatingOf` walks every `KWDA` entry and resolves each keyword
   to a record, on the first look at each base item. Cached, but pointless once the records are right.

## What to remove

- `gamemode-config.json`: the whole `"armorMaterials"` block (including its `_comment`).
- `gamemode.js`: `ARMOR_MATERIALS`, `materialRatingOf`, and the `slotOfMask` helper if nothing else uses it. Then
  `piece.counted` becomes `piece.rating`, or drop `counted` and use `rating` at its call sites — check them all, the
  inventory numbers and `defenseDamageMult` both read it.
- The `armorPieceCache` global is versioned (`__dboArmorPiece3`). **Bump it** to `__dboArmorPiece4` in the same commit,
  or a hot reload keeps entries whose `counted` came from the override (memory
  `shared-gameplay-modules-need-cache-busting`).

## One behaviour change to expect

The override only names `ArmorMaterialDragonscale`. The ladder also sets **`IAKMaterialDragonScale`** (Immersive
Armors' own dragonscale, 34 records) to the same numbers, which the server does not raise today. So after the ladder
lands, Immersive Armors dragonscale gets stronger — that is intended by choice 9, but it is a change no one asked for
in those words, so it belongs in the patch note.

## Order

Records first, then this removal. Doing it the other way round drops Dragonscale back to 41 for however long the gap
lasts, and players will see it.
