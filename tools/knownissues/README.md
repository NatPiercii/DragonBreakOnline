# Known issues

`knownissues.py` counts every error the game server, the clients and the launcher report, grouped by kind. It keeps one
post per kind in the Dev forum **#known-issues** (Council Chambers, `1555237156677754950`), and each run edits that post's
first message with the current numbers. Jake asked for it on 1 Oct 2026 in the "Bug and crash reporting" thread. The
docstring at the top of `knownissues.py` has the details.

| File | What |
|---|---|
| `knownissues.py` | the tool: dry run (default), `--collect`, `--write`, `--list` |
| `ignore.json` | known-harmless kinds, each with its reason and who decided: counted, never posted |
| `test_knownissues.py` | the harness: fixtures and a stub Discord, nothing real touched (`python3 tools/knownissues/test_knownissues.py`) |
| `knownissues.service`, `.timer` | the 15-minute timer; installed as below |

## Try it (as root: the log, the session ends, the snapshots and the bot token are root-only)

```
sudo python3 tools/knownissues/knownissues.py --offline     # what it counts and would post; no Discord
sudo python3 tools/knownissues/knownissues.py               # the same, reading the forum (tags, posts, #bug-tracker links)
sudo python3 tools/knownissues/knownissues.py --list 60     # the saved state's 60 biggest kinds
```

A dry run saves nothing and writes nothing to Discord.

## Install (a claim on `/opt/dragonbreak-tools` first; nothing posts yet)

```
sudo install -D -m 0755 tools/knownissues/knownissues.py /opt/dragonbreak-tools/knownissues/knownissues.py
sudo install -D -m 0644 tools/knownissues/ignore.json /opt/dragonbreak-tools/knownissues/ignore.json
sudo install -m 0644 tools/knownissues/knownissues.service tools/knownissues/knownissues.timer /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now knownissues.timer
```

- The service runs `--collect`. Its first run reads the whole current log and `.1` (about 10 s and 55 MB for 100 MB of
  log). Later runs read only what is new.
- The state is `/opt/dragonbreak-tools/state/known-issues.json` (0600).
- **Undo:**
  ```
  sudo systemctl disable --now knownissues.timer
  sudo rm /etc/systemd/system/knownissues.service /etc/systemd/system/knownissues.timer
  sudo rm -r /opt/dragonbreak-tools/knownissues
  sudo systemctl daemon-reload
  ```
  The state file can stay or go.

## Going live (after D's review and the go-ahead)

1. One run by hand:
   ```
   sudo python3 /opt/dragonbreak-tools/knownissues/knownissues.py --write
   ```
   - It creates the tags Known, Fixing, Fixed and Ignore if they are missing.
   - It opens at most `--max-new` posts (10). Only kinds over the threshold get one: 20 lines in 24 h, or 3 launcher
     crashes. Launcher crashes take their slots first, then the biggest kinds of the last 24 h.
   - What a player's own launcher or client reports could be made up, so:
     - a crash or client kind also needs two players before it gets a post;
     - exit codes go into fixed kinds: the named ones (exit code 1, access violation, stack buffer overrun, heap
       corruption and a few more), then "another exit code", with or without a crash log.
2. Then the timer, in `/etc/systemd/system/knownissues.service`: change `--collect` to `--write`, then
   `sudo systemctl daemon-reload`.
3. **Undo posting:** change it back to `--collect`. To remove posts, delete them in Discord: a deleted post mutes its kind
   for good.

## What staff do in the forum

| Tag | What the tool does |
|---|---|
| Known, Fixing | keeps the numbers current by editing the first message, never with a new one; an archived post is unarchived only when the kind happens again |
| Fixed | freezes the numbers; if the kind comes back, one reply says how often and when |
| Ignore | mutes the post while the tag is on. A locked or deleted post is muted the same way |

To stop a kind from ever getting a post, add it to `ignore.json` with its reason (`--list` shows each kind's signature).
