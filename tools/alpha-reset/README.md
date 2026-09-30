# The alpha reset (one time, at the 13 October opening)

Status: built and tested on 30 September 2026. It has been run **only** against sandbox copies of the world.
It waits for Nate's go, and runs under a claim with 0 players and a backup taken first.

`alpha_reset.py` keeps every character and what it earned by playing. It puts items, storage and gold back to the
start, and takes back what staff granted:

| Kept | Reset | Taken back (staff grants, from the audit log) |
|---|---|---|
| Name, race, look, character slot | Every inventory: the starter kit only (below) | Skill tiers set in the admin panel, and panel hour grants |
| House claims, businesses (ownership), tenancies | Every container with items: barrels, chests, business chests, faction strongboxes, dungeon chests, the staff supply chest (DLE 12ae13). They are left empty and never refill from their base | "Give all spells" (the 133 tome spells), unless the character learned a spell itself (a tome, a study point) |
| Faction and guild membership, offices | Gold: carried, banked (`private.bankGold`), treasuries back to their seed (10,000 per hold), faction treasuries 0 | The werewolf and Vampire Lord grants (flags and powers), unless earned in a rite or by holding the Blood Crown |
| Skills earned by playing, spells learned by playing | Business takings, chest rentals, tenancy deposits held, commissions (cancelled, no refund), hunting contracts, owed wages | "Give every shout" (`private.dboAllShouts`) |
| Supernatural state from rites, the Blood Crown | Items lying in the world (none on 30 Sep) | Items: they go with the inventories |
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

## Decisions to confirm (defaults in the tool)

1. **Staff-granted skills on players' characters.** Flo'Riahn #Z7EG (a playtester) had her skills set to Master by
   staff on 22 Sep; 14 are set aside and alchemy goes to 0. Nilis Urnum, Angorion Spellian and Vaelis Duskwood also
   lose staff-set skills. Everything else they earned stays. If Nate wants some testers to keep their levels, list
   them and the tool can skip them.
2. **The Blood Crown** stays with vampiretestcharacter #2UBX (a rite on 29 Sep). The supernatural state from rites
   stays too: werewolves Dar Ra'jhir #5YMX and Julius Draconis #8KWH; vampires Vaeric Goldenshaft #FLC7 and
   vampiretestcharacter #2UBX. Should the crown be vacant at the opening?
3. **GM and test characters** (GM Nate, Hircine, Goddess Dibella, the "test" characters) are treated like any
   other: kept and reset. Decide whether they play in the alpha world at all (economy audit, 29 Sep).
4. **Treasuries** go back to 10,000 each rather than to 0. Commissions still open are cancelled without refund.
   Chest rentals end, and business takings go to 0. Tenancy deposits held go to 0, and tenants keep their houses.

## The dry run (30 Sep, sandbox of the live world)

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

Only with Nate's go, under a ledger claim on `game-server`, with 0 players (`/api/servers`) and a downtime notice.

```
touch /opt/skymp-dev-hold                                   # the updater waits
sudo python3 alpha_reset.py grants --out /opt/skymp-backups/alpha-reset/grants.json
sudo systemctl stop skymp
sudo python3 tools/backups/dbo_backup.py snapshot            # note the archive it names
sudo python3 alpha_reset.py plan  --state /opt/skymp-state --server /opt/alduinak/build/dist/server --live \
    --snapshot <archive> --originals /opt/skymp-backups/alpha-reset/originals \
    --grants /opt/skymp-backups/alpha-reset/grants.json --report /opt/skymp-backups/alpha-reset/plan.md
#   read plan.md; if it matches the dry run:
sudo python3 alpha_reset.py apply --state /opt/skymp-state --server /opt/alduinak/build/dist/server --live \
    --snapshot <archive> --originals /opt/skymp-backups/alpha-reset/originals \
    --grants /opt/skymp-backups/alpha-reset/grants.json --report /opt/skymp-backups/alpha-reset/applied.md
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
| `test_alpha_reset.py` | 41 checks on a small world in a temp folder, with a fake load order: the trail parser, the plan, apply, a second run, the refusals |

The staff trail comes from `/var/log/skymp-server.log*`, rotations and `.gz` included. They are kept 8 weeks, so all
of it (from 21 Sep, when the world moved to CT 115) is still there on 13 Oct. `grants` saves it as JSON either way.
Grants from before 21 Sep were made on the old home server and are not in these logs.
