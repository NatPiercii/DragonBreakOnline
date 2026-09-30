# override_values.py (Option B): design note

Status: design only; nothing is built. It exists to decide between xEdit on Nat's PC (A) and a byte-level writer (B)
once Nate has answered the nine choices in BLACKSMITH_TIERS_PROPOSAL.md.

## What it does

The input is a change spec, for example:

```json
{"armor":   {"DLC2ArmorMaterialNordicHeavy": {"body": 41, "shield": 28}},
 "weapons": {"WeapMaterialOrcish": {"sword": 11, "dagger": 8}}}
```

For every record in the load order that carries the material keyword, whether a base item or an enchanted (templated)
variant, it writes an override. The override is a copy of the record that currently wins. Only one value changes:
- **ARMO:** DNAM bytes 0..3, the armor rating x 100 as a u32. Slot comes from the BOD2 mask and type from BOD2 +4.
- **WEAP:** DATA bytes 8..9, the base damage as a u16. The kind comes from DNAM byte 0.

Every templated variant carries its own copy of the value; in Skyrim.esm all 4,267 equal their template's. So a
variant is changed exactly like its base item. For the proposed set that is about 1,100 records.

## Where each override goes

| Record's source plugin | Target | Notes |
|---|---|---|
| Skyrim, Update, Dawnguard, Dragonborn, USSEP | DragonBreak Online Edits.esp (DLE) | Plain, not localized, 52 masters |
| Anything else (Beyond Skyrim, Immersive Armors, Saints & Seducers, ...) | DragonBreak Nexus Patches.esp | Plain, 10 masters, no ARMO/WEAP group yet |

If the winning record already sits in the target file, its bytes are edited in place. Otherwise the override is
added. Both targets load after every plugin that could hold a winner (Nexus Patches is last, DLE just before it).
The script checks this for every record instead of assuming it.

**The target must already have each plugin as a master.** That means the record's source plugin and every plugin its
form ids point to. If one is missing, the script stops. Adding a master shifts the file's own index (memory
merging-into-dle-needs-sseedit), so masters are added in xEdit first (option A for that step only), then B runs.

## Building one override, byte by byte

1. **Header** (24 bytes).
   - Signature and version fields are copied.
   - Flags are copied except the compressed flag (0x00040000). The override is written uncompressed, and the size
     field is set to the new length.
   - The form id becomes `(index of the source plugin in target.masters) << 24 | local id`, the same key as
     `esplib.Plugin.modindex_source`.
2. **Form-id fields** are remapped by plugin name, from the winner's master index to the plugin name to the target's
   master index, as merge_into_dle.py does for cells.
   - Every subrecord in the winner must be on one of the lists below. An unknown subrecord stops the script rather
     than guessing (merge_into_dle's rule).
   - The lists come from every subrecord seen on ARMO and WEAP in Skyrim.esm (census, 2026-09-29). They must be
     checked against xEdit's `wbDefinitionsTES5` for the SSE layout before coding.
   - **ARMO, form ids:**
     - RNAM (race), EITM (enchantment), ETYP (equip type), BIDS, BAMT (block impact and material), TNAM (template),
       YNAM and ZNAM (sounds), MODL (armor addon, repeated): u32 at offset 0.
     - KWDA: an array of u32 (KSIZ gives the count).
     - MO2S and MO4S (alternate textures): each entry holds a TXST form id. It is rare, 90 and 48 records.
   - **ARMO, data only:** EDID, OBND, MOD2, MO2T, MOD4, MO4T, BOD2, BODT, DATA (value, weight), DNAM, KSIZ, and
     FULL and DESC (strings, see step 3).
   - **WEAP, form ids:**
     - EITM, ETYP, BIDS, BAMT, INAM (impact set), WNAM (first-person model), TNAM, NAM9, NAM8, SNAM, UNAM, NNAM
       (sounds), CNAM (template): u32 at offset 0.
     - KWDA: an array.
     - MODS: alternate textures.
     - CRDT: the critical effect is a form id inside this 24-byte subrecord. Its offset must be confirmed from xEdit's
       definitions. In all 2,484 Skyrim.esm weapons, bytes 16..23 are zero, so a wrong offset would not show on
       vanilla records and would corrupt modded ones.
   - **WEAP, data only:** EDID, OBND, MODL, MODT, EAMT, DESC, DATA, DNAM, VNAM, KSIZ, FULL.
   - **VMAD** (scripts, 8 ARMO and 8 WEAP in Skyrim.esm): property values hold form ids. v1 skips these records and
     lists them for xEdit.
3. **Strings.** Skyrim.esm, Update.esm, Dawnguard and Dragonborn are localized, so FULL and DESC are u32 string ids.
   DLE and Nexus Patches are plain, and copying a string id into a plain file shows garbage as the item's name. The
   script resolves each id through the STRINGS / DLSTRINGS tables (`ck-mcp/bsastrings.py` reads them out of the BSAs)
   and writes the text as a zstring. Winners from plain plugins (USSEP, Beyond Skyrim) are copied as they are.
4. **The value.** ARMO: `DNAM[0:4] = u32(rating * 100)`. WEAP: `DATA[8:10] = u16(damage)`. Nothing else in the
   record changes.
5. **Insertion.** The override goes into the target's top-level ARMO or WEAP group. If the group is missing, it is
   created at its place in the SE group order (the `GROUP_ORDER` in add_records.py), and the group size is updated.
   HEDR's record count goes up by the number of records added. The next-object id is untouched, because overrides
   use the source's local id.

## Proving each record changed only that value

Each check runs on the output file before it replaces anything. Any failure stops the run and nothing is written.

1. **Per override:**
   - Parse the winner and the override into (signature, bytes) lists.
   - Turn every form-id field in both into (plugin name, local id).
   - The two lists must be equal except for the value bytes (DNAM 0..3 or DATA 8..9).
   - FULL and DESC must equal the resolved text of the winner's strings.
2. **Per target file:** every record the run does not touch must come out byte-identical, compared by
   (signature, form id). Record and group counts must add up (merge_into_dle's closing proof).
3. **Load order:** re-run `material_census.py` against a copy of the data folder holding the new targets.
   - Every changed key's final override must now be the target, with the proposed value.
   - The census before and after must differ only in the groups the spec names.
   - `--all` must show the same record counts.
4. **In game:** before shipping, the stat display (dboStatDisplay) and a hit on a test character show the new
   numbers for one base item and one enchanted variant of each changed material.

## Shipping

- The output files are new files. They replace DLE and Nexus Patches only through the PC's `deploy-plugins`. That
  updates /opt/skyrim-data, SHA256SUMS and the launcher's extra files; clients and server must load the same plugins.
- **DLE's source of truth is the PC.** A DLE built there later drops edits made only on the server (memory
  pc-dle-builds-drop-server-side-patches). So either the script runs on the PC too (esplib is pure Python and runs on
  Windows), or its change spec is kept in git and re-applied after every PC DLE build. Checking the census after each
  build catches a drop.
- After the records ship: remove `armorMaterials` from gamemode-config.json and its code from gamemode.js, update the
  skills.json tier text, restart, and publish the patch note.

## A or B

| | A: xEdit script on Nat's PC | B: override_values.py |
|---|---|---|
| Strings, masters, all form-id fields | Handled by xEdit's definitions | Field lists to build and verify (above); strings via bsastrings |
| Unrelated records | A save re-serialises every record: 93 changed once (memory xedit-resave-mutates-unrelated-records) | Byte-identical by construction, and proven |
| Repeatable after a PC DLE build | Re-run the script by hand | Re-run the spec from git, same bytes |
| New masters for Nexus Patches | Yes | No (stops) |
| Where it runs | PC only | CT 115 or PC |

**Suggestion:**
- Use A once, for anything needing new masters in Nexus Patches and for the few VMAD records.
- Use B for the vanilla and DLC values in DLE (about 1,000 records, including every enchanted variant), with the
  proofs above.
- If Nate keeps most vanilla numbers (the proposal changes only Orcish, Elven, Silver, Nordic, Stalhrim, Mithril,
  chainmail and the third-party outliers), A alone may be cheaper: a small, reviewed xEdit script plus the census diff
  as proof.
