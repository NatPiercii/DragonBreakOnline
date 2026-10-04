# Patch notes waiting for their release

A note here describes a feature whose gameplay is merged but which players cannot use until another part ships.
It is not in `patch-notes.json`, so `deploy-news` does not publish it. When that part ships, add the entry at the top
of `patch-notes.json` (newest first, with that day's date) and delete it here.

| File | Waits for |
|---|---|
| `rope-binding.json` | **A player source of Rope.** The mechanics are live since 1 Oct: fork main 021aaeec (client-launch-min, da0ff303) sets `__dboRopeCapture`, and the gameplay (rope-binding 50ac4d44) has been live since release-1003, so Tie Up shows in the X menu. But no player can get a Rope yet (Worker G's crafting audit, 30 Sep): no recipe, vendor or loot, only the staff admin catalogue, so the note would send players looking for something they cannot get. It goes out with the first release that gives players Rope (a vendor list or a recipe, likely with the recipe plugin run). |
| `trade-robbery-guard.json` | **Dormant until server-next-v4 is live.** The gameplay (robbery.js, pickpocket.js, server trade-robbery-guard 66a48a42, merged in release-1004) asks the fork's `__alduinakInTrade`, which only fork client-trade-open-hook b0b775e9 defines, going into server-next-v4. On the live fork (client-launch-min 021aaeec) the guard reads false and refuses nothing, so the note would be untrue. Put it at the top of `patch-notes.json` in the first gameplay release after v4 is live, dated that day. |
| `skill-rates.json` | **The fork's `__dboSkillRate` hook live and Nate's rates switched on.** skillrates.js ships every rate at x1 and the salvage loop guard off; masterySystem only asks it once fork mastery-skill-rates is in the server build (a restart). The note describes the proposal (miner 2, blacksmith craftByTier [2.5, 1, 1, 1, 1], skinner 1.5, salvageLoop on at 0 for 60 min): change its numbers to what goes live, drop the last line if the loop guard stays off, and put it at the top of `patch-notes.json` dated the day the rates go live. |
