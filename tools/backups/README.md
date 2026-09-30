# World backups, restore, and the disk

Status: built and tested on 2026-09-29. **Nothing is installed.** Everything waits for review (the server
session), then for Jake and Nate's decisions on the pruning proposal.

With alpha long term and no wipe, the world file is everyone's progress. Before this, it had one manual backup
(23 Sep) and nothing on a schedule.

## What gets saved

Each snapshot is one archive, `world-<UTC stamp>.tar.gz`, about 3.8 MB today. Every hour it contains:

- **World records:** `/opt/skymp-state/world/changeForms/*.json`, 3,584 files on 29 Sep. These are every character,
  inventory, container and placed object.
- **State files:** `/opt/skymp-state/*.json` (companions.json, zone-spawns.json).
- **The gameplay layer's files:** every top-level `*.json` beside dbo-gamemode.js (60 on 29 Sep). This includes the
  runtime state that lives only there:
  - bank.json, businesses.json, taxes.json, economy.json, tenancy.json
  - commissions.json, contracts.json, housing.json, officials.json, guilds.json, faction-storage.json
  - dungeon-cooldowns.json, parties.json, supernatural.json, revive.json, worldclock.json, jails.json
  - territory-owners.json, wars.json, patron-tokens.json, pigeon-cooldowns.json, notice-boards.json
  - staff-actions.json, game-tickets.json, ledger-points.json, placements.json, name-table.json, NPC-Spawns.json

  The generated data files (skills, loot, dungeons and so on) come along too. At 3.8 MB for the whole archive, it
  isn't worth maintaining a hand-kept list that could miss a new file.
- **The Character Journal's files:** `journal/<key>.json` and `journal/removed/<key>.json` beside dbo-gamemode.js
  (journalstats.js, one small file per character: play time, travel, counters, later the written profile). They can't
  be rebuilt from anything else. One bad file never stops the hourly backup: a file moved aside mid-snapshot is
  skipped, and one that does not parse is archived as it is and listed under `badJournal` in the manifest.
- **Not included:** `server-settings*.json`. These hold the Discord bot token. The updater snapshots settings
  separately.

Every archive also carries a `MANIFEST.json`, with record counts, file lists and a sha256 per world record.

## Why a snapshot is consistent

**How the server writes:** databaseDriver "file" is fork `FileDatabase.cpp`. The save thread writes each change form
to `<name>.json.tmp` and renames it over `<name>.json`. Any reader sees a whole file, old or new, never a torn one.
But the files aren't one transaction: a trade touches two characters as two separate writes.

**How the snapshot handles it:**
- **World records:** `cp -al` hard-links all 3,584 records into a staging folder in **82 ms** (measured). When the
  server later renames a new version over a record, it replaces its own directory entry. The linked inode, the
  version at link time, stays untouched.
- **What can still happen:** the window in which records can disagree with each other is under a tenth of a second.
  That's the same as a crash at that instant, and far smaller than a plain copy or tar of the folder.
- **Gameplay files:** Node writes some of these in place (`writeFileSync`). Each one is read twice and must be
  identical and parse, with up to 3 tries. Otherwise the snapshot is refused rather than saved torn.

**Every snapshot is checked before it's kept.** Every world record must parse as a change form (formDesc and recType
present). The archive is then re-read and checked against its manifest. Only after that does it lose its `.part`
suffix.

## Files

| File | What |
|---|---|
| `dbo_backup.py` | `snapshot`, `verify`, `restore`, `prune`, `report`, `disk`. Standard library, run as root |
| `test_dbo_backup.py` | Harness on temp folders, never live paths. 12 checks, including a record renamed over right after the link pass and a gameplay file rewritten in place during the copy |
| `systemd/dbo-world-backup.{service,timer}` | Hourly snapshot to `/opt/skymp-backups/world`, niced, idle IO |
| `systemd/dbo-disk-check.{service,timer}` | Every 15 min. Warns at 90%, critical at 95%, to the journal (`dbo-disk`), and fails the unit so it shows in `systemctl --failed` |
| `restore-test-2026-09-29.log` | The sandbox restore test (below) |

## Install (after review, under a ledger claim)

```
sudo install -d -m 755 /opt/dragonbreak-tools/backups
sudo install -m 755 dbo_backup.py /opt/dragonbreak-tools/backups/
sudo install -m 644 README.md /opt/dragonbreak-tools/backups/
sudo install -d -m 700 /opt/skymp-backups/world
sudo install -m 644 systemd/* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now dbo-world-backup.timer dbo-disk-check.timer
sudo systemctl start dbo-world-backup.service && ls -l /opt/skymp-backups/world
```

To undo: `sudo systemctl disable --now dbo-world-backup.timer dbo-disk-check.timer`, then remove the four unit files
and `daemon-reload`. The snapshots stay where they are.

## Restore test (29 Sep, sandbox only)

From `restore-test-2026-09-29.log`:
- The snapshot linked 3,584 records in 82 ms and took 60 gameplay files and 2 state files, 3.8 MB in all.
- The archive verified.
- Restore refused `/opt/skymp-state` and the live `world` folder.
- Restoring into an empty sandbox gave 3,584 records, all byte-identical to live at the moment of the check, with 42
  player characters among them.

**Not yet proven:** a server actually booting from a restored world. That needs a sandbox server. The load-test
sandbox on Nat's PC can do it (`node loadtest.js sandbox init` from a restored folder). Do it once before alpha.

## Restoring live (manual, never scripted)

1. Claim `game-server` in the ledger. Wait for 0 players online (`curl -s https://dragonbreakonline.com/api/servers`).
   Run `touch /opt/skymp-dev-hold`.
2. `sudo systemctl stop skymp`.
3. `sudo python3 dbo_backup.py restore /opt/skymp-backups/world/world-<stamp>.tar.gz /opt/skymp-restore-<stamp>`
   (a new, empty folder). Read the verify line.
4. Archive the current world, don't delete it:
   `sudo mv /opt/skymp-state/world /opt/dragonbreak-archive/world-before-restore-<now>`.
   Then `sudo cp -a /opt/skymp-restore-<stamp>/state/world /opt/skymp-state/world`.
5. Put back the gameplay state files that belong with that world. Copy the current ones to the archive first:
   `bank.json businesses.json taxes.json economy.json tenancy.json commissions.json contracts.json housing.json officials.json guilds.json faction-storage.json dungeon-cooldowns.json parties.json supernatural.json revive.json worldclock.json jails.json territory-owners.json wars.json patron-tokens.json`
   Then copy those from `/opt/skymp-restore-<stamp>/server/` into `/opt/alduinak/build/dist/server/`.
6. `sudo systemctl start skymp`. In `/var/log/skymp-server.log`, check the AttachSaveStorage line: the record count
   must match the manifest. Log in with a staff character to check.
7. Remove the hold and release the claim. Log it in `OPS_HANDOFF_<date>` with the rollback (step 4's archive).

## Retention for the world snapshots

- **Plan:** every snapshot for 48 h, then the first of each day for 30 days, then the first of each month for a year.
  At 3.8 MB each, that's about 48 + 30 + 12 = 90 archives, **about 350 MB**.
- **Without pruning,** snapshots grow about 90 MB a day, and the 14 GB free lasts about 5 months.
- `prune` touches only files named `world-<stamp>.tar.gz` in its own folder. It never removes the newest, and it
  prints what it would remove unless given `--apply`.
- **Decision for Jake and Nate:** ops rule 9 says "never delete: archive", so the `--apply` step is commented out in
  the service. Uncomment it once approved.

## Off-box copy (proposal)

The backups sit on the same disk as the live world, so a disk or container loss takes both. Proposal: a daily copy
of the newest snapshot to Jake's host, or any storage off CT 115. At about 4 MB it could even go as a private upload.
This needs Jake: the host and the transport are his.

## The disk: a proposal for Jake and Nate (nothing here deletes anything by itself)

`/` is at 89% (14 GB free of 118). `/opt/skymp-backups` holds 14.25 GB in 352 entries (`dbo_backup.py report`,
29 Sep):

| Kind | Size | Entries | Beyond the newest 5 |
|---|---|---|---|
| skymp-client.zip.bak | 3.84 GB | 21 | 2.93 GB |
| client-&lt;version&gt; | 3.30 GB | 18 | 2.38 GB |
| release bundles | 2.62 GB | 18 | 2.25 GB |
| client-files | 2.17 GB | 12 | 1.26 GB |
| gameplay | 1.92 GB | 172 | 1.85 GB (all text) |
| everything else | 0.4 GB | 111 | |

Moving files to `/opt/dragonbreak-archive` frees nothing, because it's the same disk. The options, ordered from the
one that removes nothing:

1. **Hard-link identical files: frees 1.69 GB.** 20 groups of byte-identical client zips and bundles (sha256
   measured). Every backup stays readable at its path; only duplicate copies of the same bytes go.
2. **Compress the 172 gameplay folders: frees about 1.65 GB.** They are text and compress about 7:1 (14 MB to
   1.9 MB, measured on the newest). Each folder becomes one `.tar.gz` with the same name. The content is kept; its
   form changes.
3. **Keep the newest 5 client zips of each kind and the newest 5 release bundles: frees up to 8.8 GB** before option
   1, and less after it, because options 1 and 3 overlap. These are old client packages: players are on 0.3.68, and
   the release bundles hold the same zips. This is the only option that deletes, so it's Jake and Nate's call. It
   could also be "keep 10" or "keep everything from the last 14 days".

Options 1 and 2 together bring the disk from 89% to about 86%. With option 3 as well, it's about 79%. Client zips
are already compressed, so compressing them again gains nothing.
