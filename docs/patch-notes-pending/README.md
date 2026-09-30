# Patch notes waiting for their release

A note here describes a feature whose gameplay is merged but which players cannot use until another part ships.
It is not in `patch-notes.json`, so `deploy-news` does not publish it. When that part ships, add the entry at the top
of `patch-notes.json` (newest first, with that day's date) and delete it here.

| File | Waits for |
|---|---|
| `rope-binding.json` | The fork release that sets `__dboRopeCapture` (captureSystem rope ties, fork `rope-binding-ts` da0ff303, going into server-next-v2). Until then the rope entries in the X menu stay hidden, so the note would announce something nobody can use. Gameplay: rope-binding 50ac4d44. |
| `trade-robbery-guard.json` | **Dormant until server-next-v4 is live.** The gameplay (robbery.js, pickpocket.js, server trade-robbery-guard 66a48a42, merged in release-1004) asks the fork's `__alduinakInTrade`, which only fork client-trade-open-hook b0b775e9 defines, going into server-next-v4. On the live fork (client-launch-min 021aaeec) the guard reads false and refuses nothing, so the note would be untrue. Put it at the top of `patch-notes.json` in the first gameplay release after v4 is live, dated that day. |
