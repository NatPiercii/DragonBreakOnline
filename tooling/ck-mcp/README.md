# Creation Kit MCP

Systematic repair tools for Skyrim SE plugin files. Operates directly on
`.esp`/`.esm` records — the Creation Kit is not required and is not driven.
Use the CK to *look* at the result.

## Why not automate the CK itself

The Creation Kit is an MFC application with no scripting API for level design.
Automating it means driving dialogs: brittle, slow, and it crashes often.
Everything these tools do — placing, moving, disabling, repointing — is a record
edit. The CK is just one editor for those records.

## Setup

Registered in `../.mcp.json`. Requires `pip install mcp` (2.x).

Environment:

| Variable | Meaning |
|---|---|
| `CKMCP_DATA` | Data folder to operate on (required) |
| `CKMCP_PLUGINS` | plugins/loadorder txt (optional, autodetected) |
| `CKMCP_BACKUPS` | backup folder (default `<data>/../ckmcp-backups`) |

Point `CKMCP_DATA` at the install you intend to change. This repo has two
(dev and Steam) and they hold different revisions.

## FormIDs are strings

Always `"plugin.esp:XXXXXX"`, never a bare hex number.

A raw FormID's top byte indexes *that plugin's own master list*, and two plugins
can order masters differently. During the August 2026 audit this produced two
separate wrong answers — 662 phantom "base object changed" hits and 823 phantom
record differences — because raw IDs were compared across files. Canonical
strings are immune. Both `Skyrim.esm:00009B41` and `Skyrim.esm:9B41` are
accepted and normalize to the same key.

## Tools

**Discovery** — `load_order`, `find_cells`, `find_base_objects`, `resolve`,
`cell_contents`, `refs_near`

**Audits** (read-only) — `validate`, `find_deleted`, `find_itm`,
`find_duplicates`, `find_dangling`, `find_broken_doors`

**Writes** — `undelete_and_disable`, `set_flags`, `move_ref`, `repoint`,
`remove_records`, plus `reload` after editing elsewhere

## Safety

Every write is `backup → mutate → verify → commit`. **Verification failure means
the file is never touched.** Checks: parser round-trip before mutating, master
list unchanged, HEDR count matches records+groups, and per-operation expectations
(e.g. a flag change must add and remove zero records).

`dry_run` defaults to **true** on every write tool. Call once to see the report,
then again with `dry_run=false`.

`remove_records` refuses outright if anything still references a target.

### Lessons encoded here

These were real mistakes made during the audit that the checks now prevent:

- **Alternate textures hold FormIDs.** `MODS`/`MO2S`–`MO5S` are arrays of TXST
  references. Treating them as opaque binary left 3 dangling references that
  SSEEdit caught afterwards. `repoint` and the dangling scan both walk them.
- **Compare semantic flags, not just bodies.** Ignoring the Initially Disabled
  bit counted disabled overrides as identical-to-master, inflating an ITM count
  from 1,549 to ~2,565. Acting on that would have undone earlier work.
- **Duplicate detection needs the parent cell.** Every interior has its own
  coordinate space; keying on position alone reported 9,508 duplicates where
  1,463 existed.
- **Never auto-remove CELL/WRLD/DIAL/NAVM/LAND.** A parent can be byte-identical
  while its children carry the change. `find_itm` flags these `review_only`.
- **Reference fields must be verified, not guessed.** `find_dangling` first
  reported 1,120 for `DragonBreak.esp` against SSEEdit's 63; adding fields
  speculatively then pushed it to 1,552. Each field was checked against real
  data before being trusted. It now reports exactly 48 — every one matching an
  SSEEdit finding.

  Three distinct false-positive classes were involved:
  - `NAME` is only a FormID in reference records. RACE carries 32 `NAME`
    subrecords holding body-part names.
  - `Skyrim.esm:000014` (PlayerRef) is an engine form present in no file. It is
    the target of thousands of `XESP` enable-parents.
  - A null FormID (`0x00000000`) means "none", not a broken link.
  - `ALFI` is an alias *index*, not a FormID — every observed value is below
    0x1B5.

  `XPOD` was added later by the same method: 3,068 portals across Skyrim.esm,
  Dawnguard, DL and Edits all carry exactly 8 bytes (two FormIDs), only ever on
  `PortalMarker` refs, and every resolving target is a `RoomMarker`. A broken one
  leaves a portal pointing at a room that is not there, which breaks occlusion
  culling — geometry vanishes as you cross the boundary. Check *winning* records
  only: losing override versions routinely point at ids that never load.

## Limits

These tools verify that an edit is *structurally* sound. They cannot tell you it
*looks* right — there is no visual channel. Good for systematic repair; not a
substitute for eyes on the geometry.

Navmesh is not edited. NAVM triangle data needs graph recomputation; getting it
wrong causes CTDs and broken pathing.

`find_dangling` covers `XTEL`, `XLKR`, `XESP`, `XAPR`, `XOWN`, `XLRL`, `XEMI`,
`XPWR`, `XLIB`, `XLRT`, `XPOD`, quest alias `ALFR`/`ALCO`/`ALUA`, alternate
textures, and `NAME` on reference records. **Out of scope:** VMAD script
properties, `PACK` location data, and NAVM door links — all type-tagged or nested formats that need
a real parser rather than a field offset. SSEEdit finds those; this tool does not
claim to.

Validation here is not SSEEdit. Run **Check for Errors** in SSEEdit before
anything reaches a live server.
