# Patch notes waiting for their release

A note here describes a feature whose gameplay is merged but which players cannot use until another part ships.
It is not in `patch-notes.json`, so `deploy-news` does not publish it. When that part ships, add the entry at the top
of `patch-notes.json` (newest first, with that day's date) and delete it here.

| File | Waits for |
|---|---|
| `rope-binding.json` | The fork release that sets `__dboRopeCapture` (captureSystem rope ties, fork `rope-binding-ts` da0ff303, going into server-next-v2). Until then the rope entries in the X menu stay hidden, so the note would announce something nobody can use. Gameplay: rope-binding 50ac4d44. |
| `playtesters-thank-you.json` | The alpha's opening, 1 October 05:00 UTC (moved up from 3 October on 30 Sep). `playtesterBoost.enabled` is on (Nate approved it in claude-nate's session, 30 Sep). The launch news goes out with the launch; a copy for it is `~/claude-nate-release/launch-news-boost.json` on CT 115. Gameplay: playtester-boost 98b3631d. |
