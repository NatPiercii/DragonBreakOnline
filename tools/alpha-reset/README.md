# The alpha reset (one time, at the opening: Sat 3 October 2026, 05:00 UTC)

Status: built and tested on 30 September 2026, reviewed the same day (below). It has been run **only** against sandbox
copies of the world. It waits for Nate's go, and runs under a claim with 0 players and a backup taken first. The launch
script is `/home/nate/claude-nate-release/alpha-reset-launch.sh` (claude-nate).

## Two ways to treat stats: `--stats earned` or `--stats full`

The public announcement says: *"all character stats and items will be reset ... your characters will carry over into
alpha with their stats and inventories reset."* This tool was first built to keep the skills earned by playing.

| `--stats` | Skills (Wheel), character level and its points | Learned spells | Study records (schools, spellbook, prepared, manuals, recipes, scholar reads) |
|---|---|---|---|
| `earned` (default) | Kept, less what staff set or granted | Kept, less staff grants and the markers of lowered skills | Kept |
| `full` (the announcement) | Removed: every skill back to 0, level 1, no points | Every spell from a skill, a tome, a study or staff goes | Removed |

Either way everything in the tables below that is not a stat is treated the same, and spells a kept rite gave (a
vampire's stage spells, the werewolf's change, the vampirism disease) stay.

## Review of 30 September (claude-nate), fixed on `work-alpha-reset-fixes`

- **Deleted characters** (`isDeleted`, 14 of 51 records) were counted and rewritten as kept characters. They are skipped.
- **Tier marker spells** stayed after a skill was lowered: the server re-derives the rank from the level on load and so
  never takes a marker back (masterySystem read). A lowered skill now loses the markers above its new tier; a skill with
  nothing earned is set aside with all its markers rather than left at level 0.
- **Master set by staff**: adminSetTier writes 150, which the record keeps until its next write. It was read as 50
  earned (Gaul Iron-Chef, unarmed 150 -> 50); the level is capped before the sum, so it is set aside.
- **A skill the player took up themselves** keeps its first level (firstTouchCost 1) instead of 0.
- **"Give all spells" before the logs** (the old home server, before 21 Sep) was missed: Boris #7X44 kept all 133 staff
  spells. A character holding at least half of the staff set, and 20 or more, is treated as given them.
- **Beast powers without a flag**: the Vampire Lord power now goes from everyone (the crown is released), and the
  werewolf change from everyone who is not a werewolf by rite, flag or not.
- **Masks**: a masked character is unmasked in the record, and `private.maskLost`/`maskItemId` are cleared; a remembered
  lost mask would refuse every mask afterwards, since the item goes with the inventory.
- **Spells in hand** that are taken back leave the hand (equipmentDump left/right/voice/instant).
- **Admin modes** (`ff_adminModes`, god mode and the like) are cleared.
- Characters still restrained, jailed, in a beast form or permanently dead are listed under "check by hand" (none on 30 Sep).

`alpha_reset.py` keeps every character and what it earned by playing. It puts items, storage and gold back to the
start, and takes back what staff granted:

| Kept | Reset | Taken back (staff grants, from the audit log) |
|---|---|---|
| Name, race, look, character slot | Every inventory: the starter kit only (below) | Skill tiers set in the admin panel, and panel hour grants |
| House claims, businesses (ownership), tenancies | Every container with items: barrels, chests, business chests, faction strongboxes, dungeon chests, the staff supply chest (DLE 12ae13). They are left empty and never refill from their base | "Give all spells" (the 133 tome spells), unless the character learned a spell itself (a tome, a study point) |
| Faction and guild membership, offices | Gold: carried, banked (`private.bankGold`), treasuries back to their seed (10,000 per hold), faction treasuries 0 | The werewolf and Vampire Lord grants (flags and powers), unless earned in a rite. The Vampire Lord power goes from everyone: the Blood Crown is released |
| Skills earned by playing, spells learned by playing | Business takings, chest rentals, tenancy deposits held, commissions (cancelled, no refund), hunting contracts, owed wages | "Give every shout" (`private.dboAllShouts`) |
| Supernatural state from rites (vampirism, lycanthropy) | Items lying in the world (none on 30 Sep); the Blood Crown, released so the first to rise a pure-blood after the reset claims it | Items: they go with the inventories |
| Dungeon rests, needs, letters, deity, patron rerolls, scholar reads | | |

**The starter kit.** Miner's Clothes and Miner's Boots (worn), 50 gold, a Pickaxe and a Woodcutter's Axe. That is
spawn.ts's default kit plus gamemode.js's tools. It is written straight into each character: the clothes are dressed,
and `private.kitPending` has the spawn system dress them again at the next login. If `server-settings.json` ever gains
a `startingItems`, change `DEFAULT_KIT` to match first. The tool never reads that file, because it holds secrets.

## How staff skill grants are taken back

In the admin panel, "set tier" writes a fixed level (0/10/30/70/150, capped at 100) and forgets the old one. The
audit log names the skill, the tier and the time, not what was there before. So for each skill staff touched:

- **Kept:** what was earned after the last staff action, i.e. the level now minus what staff wrote (and minus any
  panel hour grants after it).
- **Lost:** what was earned before that staff action. It cannot be recovered, and the report says so on each line.
- **Set aside:** a skill that staff took up, where nothing was earned since and the player never took it up
  themselves (a study point or tome). Its tier spells go with it.
- **Levels at 100:** a skill staff set to Master sits at the 100 cap, so nothing earned afterwards can show. Those
  come out at 0.

A character whose skills drop has its character level points reset (`private.dboLevel`, `private.dboAvBonus`).
charlevel.js raises the level again from the kept skills at the next login, and the points are chosen anew.

Every character gets `private.alphaReset`. A second `apply` on the same world is refused, and a second `plan` takes
nothing back twice: taking a skill that went 35 → 5 back again would leave it at 0.

## Decisions (confirmed by Nate, 2026-09-30)

1. **Staff-set skills are taken back for everyone**, playtesters included, with no named skips. Flo'Riahn #Z7EG, whose
   skills staff set to Master on 22 Sep, keeps what she earned elsewhere; 14 of those skills are set aside and
   alchemy goes to 0.
2. **The Blood Crown is released.** `supernatural.json` gets `crown: null` and an empty revoke list. Its holder gives
   up the Vampire Lord power and keeps the vampirism from the rite. A vacant crown goes to the next character to
   become a pure-blood (supernatural.js, becomeVampire), so existing pure-bloods do not take it back by logging in.
3. **GM and test characters do not play in the alpha world.** They are reset like everyone else, and the report lists
   them for Nate and the staff under "Staff and test characters", by profile and name, with why. The list holds:
   - every character of a staff profile, meaning a profile with GM actions on record or a character flagged admin at
     a login;
   - any character named as a test or GM character.
   A staff member's own player character goes in `alpha-reset.json` under `playerCharacters` (by character tag and
   profile, never by name). It then moves to a table of its own as allowed to play, and is still reset with its staff
   grants taken back. There are none as of 2026-09-30.
   A player account that had admin rights while testing goes under `notStaff`, by profile:
   - With `whole: true`, all its characters play.
   - With `whole: false` and a tag, only that character plays, and the account's other characters stay staff-only
     as test characters.
   These accounts get their own table, "Players who had admin rights while testing", with their admin panel actions
   on record. Those grants are taken back like any staff grant. Nate (2026-09-30):
   - **Nilis Urnum #R4XY** (profile 7) is a player's character, not staff: 87 panel actions, 25-28 Sep, whole account.
   - **Velisse Montclair #RWPS** (profile 6) is a player's character, not staff. Naomi #HQHK and Goddess Dibella #NRD9,
     on the same account, were test characters and stay staff-only. The account made 78 panel actions, 22-26 Sep.
   An entry that matches no character is named in the report, so a mistyped tag or profile shows.
4. **Treasuries go back to the 10,000 seed.**

## The dry run (30 Sep 16:00 UTC snapshot, after the review's fixes)

- **Characters:** 37 kept (14 deleted records skipped). They carry 5,721 gold and 303 banked, plus 5,488 items in 962 stacks.
- **Containers:** 757 emptied, holding 105,626 items, the supply chest (81,125) among them.
- **`--stats earned`:** 1,735 spells and powers taken back from 18 characters; 23 characters with staff actions.
- **`--stats full`:** 1,828 spells taken back from 30 characters; 26 characters had skills (6,586 levels in all), 14 a
  character level. Spells kept: the vampires' and werewolves' from rites, and one vampirism disease.
- **Apply on a sandbox copy, both modes:** 799 files written, every record parses, a replan finds nothing left, a second
  apply is refused.

## The first dry run (30 Sep, before the review)

```
python3 tools/backups/dbo_backup.py snapshot --out /tmp/claude-nate-x/snap      # (world-backups branch), as root
python3 tools/backups/dbo_backup.py restore <archive> /tmp/claude-nate-x/sandbox
sudo python3 alpha_reset.py grants --out /tmp/claude-nate-x/grants.json          # the logs are root's
python3 alpha_reset.py plan --root /tmp/claude-nate-x/sandbox --grants /tmp/claude-nate-x/grants.json \
    --report /tmp/claude-nate-x/dryrun.md --json /tmp/claude-nate-x/dryrun.json
```

Result on 30 Sep:
- **Characters:** 45 kept. They carry 4,765 gold and 303 banked, plus 5,179 items in 932 stacks.
- **Containers:** 720 emptied, holding 105,273 items, the supply chest among them.
- **Staff grants:** 786 on record. 19 characters have grants to take back.
- **Items lying in the world:** none, since the item guards stop drops.
- **Apply on a second sandbox:** 769 files written, every record still parses, and a replan finds nothing left to
  take. A second apply is refused.

## On the day

The launch script (`/home/nate/claude-nate-release/alpha-reset-launch.sh`) does all of this with its gates, and
sets `DBO_LOADORDER=/opt/skyrim-data/loadorder.txt` (the live order). By hand:

Only with Nate's go, under a ledger claim on `game-server`, with 0 players (`/api/servers`) and a downtime notice.

```
touch /opt/skymp-dev-hold                                   # the updater waits
sudo python3 alpha_reset.py grants --out /opt/skymp-backups/alpha-reset/grants.json
sudo systemctl stop skymp
sudo python3 tools/backups/dbo_backup.py snapshot            # note the archive it names
sudo python3 alpha_reset.py plan  --state /opt/skymp-state --server /opt/alduinak/build/dist/server --live \
    --snapshot <archive> --originals /opt/skymp-backups/alpha-reset/originals \
    --grants /opt/skymp-backups/alpha-reset/grants.json --stats <earned|full> --report /opt/skymp-backups/alpha-reset/plan.md
#   read plan.md; if it matches the dry run:
sudo python3 alpha_reset.py apply --state /opt/skymp-state --server /opt/alduinak/build/dist/server --live \
    --snapshot <archive> --originals /opt/skymp-backups/alpha-reset/originals \
    --grants /opt/skymp-backups/alpha-reset/grants.json --stats <earned|full> --report /opt/skymp-backups/alpha-reset/applied.md
sudo systemctl start skymp
rm /opt/skymp-dev-hold
```

The tool refuses the live folders in three cases: without `--live`, while `skymp` is active, or without an existing
`--snapshot` and an `--originals` folder. Every file it replaces is copied into `--originals` first.

**Check after the start.**
- A character logs in wearing the kit, with a pickaxe, an axe and 50 gold.
- The bank shows 0, and the supply chest in Bruma is empty.
- The skills panel shows the kept skills.
- The server log has no load errors.

**Rollback.** Stop skymp, then copy `originals/changeForms/*` back to `/opt/skymp-state/world/changeForms/` and
`originals/server/*` back to the server folder, then start. Or restore the snapshot (tools/backups README,
"Restoring live"). Log the change and its rollback in the ops ledger.

## Files

| File | What |
|---|---|
| `alpha_reset.py` | `grants`, `plan`, `apply`. Standard library plus ck-mcp/esplib.py (names and record types from the load order) |
| `alpha-reset.json` | Settings: `playerCharacters` (a staff profile's own player character) and `notStaff` (player accounts that had admin while testing, whole or one character) |
| `test_alpha_reset.py` | 51 checks on a small world in a temp folder, with a fake load order: the trail parser, the plan, apply, a second run, the refusals |

The staff trail comes from `/var/log/skymp-server.log*`, rotations and `.gz` included. They are kept 8 weeks, so all
of it (from 21 Sep, when the world moved to CT 115) is still there on 13 Oct. `grants` saves it as JSON either way.
Grants from before 21 Sep were made on the old home server and are not in these logs.
