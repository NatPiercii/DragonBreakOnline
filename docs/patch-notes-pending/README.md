# Patch notes waiting for their release

A note here describes a feature whose gameplay is merged but which players cannot use until another part ships.
It is not in `patch-notes.json`, so `deploy-news` does not publish it. When that part ships, add the entry at the top
of `patch-notes.json` (newest first, with that day's date) and delete it here.

| File | Waits for |
|---|---|
| `rope-binding.json` | The fork release that sets `__dboRopeCapture` (captureSystem rope ties, fork `rope-binding-ts` da0ff303, going into server-next-v2). Until then the rope entries in the X menu stay hidden, so the note would announce something nobody can use. Gameplay: rope-binding 50ac4d44. |
