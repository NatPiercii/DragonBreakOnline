# DragonBreak Online — The Player Economy and Hold Politics

**Final design, 2026-09-19.** Read-only pass; no files were modified. Code references below were opened and checked against the live tree.

---

## 1. Summary

This document merges three design passes into one build plan. The frame is **player-stories-first** — the acceptance test for any mechanic is whether it makes one of two paragraphs true (§2) — grafted with the constitutional discipline of the politics-first pass and the ledger engineering of the economy-first pass.

The shape of it:

- **One module owns every septim.** `server/economy.js` is the only writer of gold, with a serialised per-account queue, double-entry rows, a closed reason vocabulary, an append-only journal, and an hourly `sum(journal) == balance` reconciliation that freezes an account on mismatch. Today three separate read-modify-write implementations move treasury gold and at least eight places mint it, and nothing counts.
- **A treasury stops being a chest you can open.** Registered strongbox refs are refused in `mp.onActivate` — a three-line insert into a delegate chain that already exists at `gamemode.js:620-645` — and the chest is driven to zero and kept there as an inbox for the bundled board's fees. That closes the live Bruma-safe hole (`CHECKLIST.md:867`), the housing-claim lockout, and the container race, in the hot-reload layer, with no bundle rebuild.
- **Commissions with escrow are the first-hour hook and the highest stories-per-line system here.** A player posts work, the gold leaves their purse at posting, the board reads **Secured**, a stranger takes it, delivers, and gets paid. For a *deed* commission the server verifies nothing: it holds the money and records the poster's verdict, and an official arbitrates a refusal. That single decision lets players commission escorts, clearances, funerals, tournaments and weddings through one code path, and gives officials a job other players care about — which is what makes office worth contesting.
- **The Charter is the politics-to-economics bridge.** A dozen per-zone numbers with hard `[min,max]` clamps in `gamemode-config.json`, a proclamation delay during which a change sits on the board and can be withdrawn, and a per-day change-rate limit. Every phase-1 field re-points a constant that gameplay-layer code already reads, so it costs no rebuild.
- **The gold faucet question is answered:** the Crown is not a faucet. Adventuring stays the faucet; the hold *levies* it (a coin in N withheld at the moment `splitGold` and `corpseLoot` pay out — fully server-side, no client in the path), and pays it back out as commissions, contracts, payroll and requisitions. Sinks that **move** gold to a treasury players control beat sinks that **destroy** it.
- **One correctness fix outranks every feature here.** `isLawful` at `playermenu.js:37` is `isAdmin(a) || ranksOf(profileOf(a)).length > 0` — any rank in any zone grants restrain and search rights everywhere on the server, and `captureSystem.ts` and `searchSystem.ts` both read that one property. This design adds deputies, company ranks and thanes on top of it. Split it first.

Phase 1 is gameplay-layer only: `server/*.js` and `server/*.json`, hot-reloading, no bundle rebuild, no client relaunch.

---

## 2. The two stories

Every mechanic below serves one of these. If it does not, cut it.

**The first hour.** Edorin arrives at Pale Pass with a pickaxe and a woodcutter's axe (`gamemode.js:897-910`) and walks into Bruma. Everyone reads **Stranger** to him and he to them. At the cathedral board he finds three commissions posted by players, all marked **Secured** because the gold is already held. He takes one — twenty iron ore, 240 septims — mines it on the server-judged labour minigame, finds the poster at the forge, **Introduces** himself, hands the ore through `tradeSystem`, and the escrow releases. He signs the hold's **Roll** at the Lord's Manor for 25 septims, which drops his board fee to the citizen's rate and puts his name somewhere public. One hour in: three people met, one favour owed, a reason to log in tomorrow that nobody scripted.

**The five-hundredth hour.** Beriel holds a Charter of Company — four members, a chartered hall she pays rent on, a company strongbox with a per-rank daily draw, a rank ladder she named herself. She is the province's only Master Smith, so she buys ebony from a miner she does not control. She is also in a feud: the Captain levied a market duty she calls theft, her apprentice served three days' gaol over a brawl, the weregild came out of the company box under protest, and every septim of it is on the public ledger. She is quietly funding a rival's bid for the Steward's chair.

None of that is a quest. All of it is records the server keeps honestly and publishes.

---

## 3. Principles

1. **Players author content; the server enforces and records.** The server is a registry, a strongbox, a court clerk and a scoreboard. It never writes a storyline, never places a quest marker, never sets a price on its own initiative.
2. **No NPC merchants, ever** (standing decision, `CHECKLIST.md:757`). Anything that has the *server* deciding what to buy and at what price is an NPC merchant wearing a doublet. Where a hold buys goods (§4.8), a player official sets the price and the cap; the server only decays within the band they set.
3. **Server authority, two tests** (`SERVER_AUTHORITY.md`): could an edited client bundle change the outcome, and would a second player see the result if the actor's client froze. The client names an intent — a listing id, a quantity, an amount. The server recomputes everything else.
4. **Every septim is accounted for.** One implementation of "move gold", one append-only journal, one reconciliation. A faucet that does not report is a bug.
5. **Prefer sinks that move gold over sinks that destroy it.** Destroyed gold is a tax on the economy's existence. Moved gold is a reason to care who runs the hold.
6. **Lore is binding, not decorative.** Septims. A Count rules an Imperial county by appointment confirmed by the Elder Council; a Jarl rules a hold; a Thane is honorific with no treasury power; the Moot is for the High King only and is not used for a hold seat; an Orc Chieftain is succeeded by a consented Challenge, never a ballot. No percentage sliders in player-facing text — write "one coin in five". No auction house, no global market search, no item mail, no interest-bearing accounts, no currency but the Septim.
7. **It holds at 100+.** No O(n²), no broadcast on an event, no `readFileSync` on a hot path, no synchronous write inside a transaction. Lists are pulled, never pushed.
8. **Corruption is possible, bounded and legible.** An unstealable treasury is also an uninteresting one. Make theft slow, doubled, capped and public — then it is a story rather than an exploit.

---

## 4. Verified ground truth

Checked in the tree today, because three of these correct claims made in the source designs:

| Fact | Where |
|---|---|
| `isLawful = isAdmin(a) \|\| ranksOf(profileOf(a)).length > 0`, refreshed for every online actor every 15 s | `playermenu.js:37`, `:47-48` |
| `ranksOf` does a `readFileSync` of `officials.json` **plus** a full `zoneList()` rebuild per call | `gamemode.js:1277-1281` |
| `mp.onActivate` already has a delegate chain (`__dboLabour`, `__dboCoinPurse`, `__dboCampChest`, `__dboDungeonActivate`, …) any of which may veto by returning `false`, behind a bound-hands refusal and a 6.5 m range test | `gamemode.js:620-645` |
| **Restraint is already enforced** on activate (`:624`) and on the hit path (`:1935-1938`); `tradeSystem` refuses trades | `gamemode.js:624`, `:1935` |
| Dungeon cooldown is read for the claimant only; `partyMembers` is taken unfiltered at lease start | `dungeons.js:630` vs `:74`, `:301` |
| Dungeon cooldowns live in `private.dungeonCooldowns` **on the character**, so character-select cycling resets them | `dungeons.js:76-77` |
| **9 of 17 zones have a treasury**, seeded at 10,000 → **~90,000 minted, not 100,000**. Dawnstar, all six strongholds and Solstheim have none, so fees sent there are taken and destroyed | `zones.json`, `gamemode.js:677-690` |
| Hold treasuries are `DragonBreak.esp` HoldChests; Bruma's is the Lord's Manor safe `79b22:BSHeartland.esm` | `zones.json` |
| Reloot re-arms MISC/WEAP/ARMO/ALCH/INGR/BOOK/KEYM/SLGM/SCRL/AMMO/ACTI/FLOR/FURN/TREE/DOOR/LIGH hourly; `forbiddenReloot` is `["CONT"]` only. Gold001 is MISC | `server-settings.json:134-160` |
| Widget ids run to 34 (pigeon). **35, 36, 37, 38 are free** | `server/*.js` `WIDGET_ID` |
| `labour.js` already models the right pattern for a server-judged minigame: round + nonce, spent-nonce set, both on `globalThis` so a reload does not strand a round | `labour.js:68-70`, `:148`, `:239` |

**Correction to carry into the build:** `SERVER_AUTHORITY.md` migration 16 is stale. Only the `onUi` minigame handlers still need a restraint guard; the hit and activate paths are done. Gaol is closer to shippable than any source design assumed.

---

## 5. Systems

### S0. The Ledger — `server/economy.js`

**Behaviour.** Mostly invisible. `/purse` shows carried coin. `/ledger` shows a player their own last twenty movements in plain language ("15 septims to the Bruma treasury, notice board"). `/treasury <zone>` is public: balance and the last movements, with who authorised each.

**Authority model.** One module owns every movement of gold. Exposed on `globalThis.__dboBank` so other gameplay modules and (later) bundle systems call one implementation:

```js
globalThis.__dboBank = {
  balance(account),
  move({ from, to, amount, reason, by, note }),   // the only inter-account path
  take(actorId, amount, reason, to),              // purse -> account
  pay(actorId, amount, reason, from),             // account -> purse
  hold(from, amount, reason) -> escrowId,         // escrow:<id>
  release(escrowId, to, reason), refund(escrowId, reason),
  meter(profileId, source, amount) -> multiplier, // the yield budget, S9
  ledger(query),
};
```

Accounts: `player:<profileId>` (vault, phase 2), `zone:<zoneId>`, `company:<id>`, `escrow:<id>`, `mint:world`, `crown`. **Double entry:** a movement that does not balance is refused and logged. Amounts are integers, clamped `[1, 10_000_000]`. `reason` comes from a closed enum — no free text:

```
seed · donation · boardFee · pigeonFee · commissionStake · commissionRelease
commissionRefund · commissionDuty · contractEscrow · contractPay · dungeonLevy
dungeonFee · rent · licence · marketDuty · marketSale · fine · weregild
payroll · writ · tithe · charterFee · respec · adminGrant · adjustment
```

**Concurrency, and the real engine hazard.** A per-account promise chain serialises writes, so simultaneous deposit and payout cannot interleave. The hazard that matters is not the chest — it is the purse: **a purse write can be clobbered by the client's own `SetInventory` while that player has a container open.** Therefore:

- No gold operation touches a purse while that player has a container session open. Buying, paying fees and settling debts happen in a widget or a chat command, never inside a container UI.
- Every purse write is re-read afterwards and the delta verified. A mismatch increments `LEDGER DESYNC`, logs, and fails the whole transaction rather than half-completing it.

**Integrity.** The journal line is written **before** the state write, so a crash loses the snapshot and never the record. Hourly, per account: `sum(journal.delta) == balance`. On mismatch, freeze withdrawals for that account, log `LEDGER DRIFT`, raise a GM alert. At boot, the same check plus an escrow assertion: the sum of open stakes must equal the escrow balance, else `ESCROW DRIFT` and escrow is read-only until an admin clears it.

**Outflow controls live in the Ledger, not in each caller** — so they cover `/contract post`, payroll, writs and company boxes for free:

1. **Per-day outflow cap** per account per official: default `min(20% of balance, 3000)`.
2. **Two signatures** above `twoSignAbove` (default 1,000): the payment is *pending* until a second official of that zone confirms within ten minutes, else it lapses. A hold with one official can only make small payments — itself a reason to appoint a Steward.
3. **Public delay** above `delayAbove` (default 5,000): posted to the hold's board **at signature, not at maturity**, executing after `delayMinutes` (default 30). Cancellable by the signer before it matures.
4. Recipient may not be the signing profile. Reciprocal co-signature pairs surface in the weekly report.

**Data.** `server/ledger.jsonl`, append-only, one object per line, flushed through the existing `saveSoon` debounce (`gamemode.js:62`), rotated daily into `server/_ledger/`: `{t, from, to, amount, reason, by, tag, balAfter}`. Balances snapshot to `server/economy.json`, never written synchronously inside a transaction. A nightly rollup writes `server/ledger-daily.json` so the §9 metrics cost one file read, not a scan. Physical purse coin is not in the ledger; a census job sums online purses every ten minutes so total supply = vaults + treasuries + escrow + company boxes + measured float.

**Anti-exploit.** Single writer. No negative balances. Every faucet calls `mint` with a reason code, so an unreported faucet shows up as a gap between minted and observed gold. Escrow can be moved by nobody — including admins — except through `release` and `refund`.

---

### S1. The Strongbox — treasuries that are not chests

**Behaviour.** A registry of box refs (hold treasuries, company boxes, the counting house). **`mp.onActivate` refuses activation of any registered box by anyone, officials included.** You use `/treasury` or the Strongbox widget instead: balance, the last twenty ledger lines, and — for those with the right — Deposit, Withdraw, Pay, Payroll.

This is better lore than it is engineering. A strongbox with a clerk and a book is what an Imperial counting house is; withdrawal becomes an act that is logged, announced and rate-limited rather than a container you rummage.

**Authority model.** The activate guard slots into the existing delegate chain at `gamemode.js:620-645`, next to `__dboCoinPurse` and `__dboCampChest`, and returns `false`. Belt and braces, both cheap:

- **Activation refused** — closes hand-looting and makes a housing claim on the ref worthless even before `housingSystem.ts` excludes it in phase 3.
- **Chest driven to zero and swept** — the bundled `bountyBoardSystem.ts` still deposits fees into the chest and has no gameplay hook on that path, so `economy.js` sweeps the chest every few seconds, moves any gold found into `zone:<id>`, and journals it as `boardFee` (or `donation` above what the board could have deposited). The board keeps working untouched; phase 3 retires the sweep for a direct call. Hand donations work the same way: drop gold in, it is swept and recorded with the donor's name.

**Migration.** On first boot after the change, sweep each seeded chest's gold into its account under a new `private.treasuryLedgered` flag; leave `private.treasurySeeded` alone so the `__dboEmptyWorldContainer` interaction at `gamemode.js:1497-1510` is unchanged. Seeding is rewritten as a journal entry with `reason: "seed"`, so the ~90,000 already-minted septims finally appear on the books.

**Anti-exploit.** The registry is server data, never client-supplied. Zones with no `treasury` ref (Dawnstar, the six strongholds, Solstheim) get an **account anyway** — so pigeon and board fees stop being silently destroyed (`gamemode.js:510`) — and until a container is placed in phase 2 the fee is **refused with a message** rather than burnt.

---

### S2. The Roster — one cached read, and the lawful split

Two changes, both small, both blocking everything else.

**The cache.** `ranksOf` is called for every online player every 15 s by `playermenu.js:48`, and each call is a `readFileSync` plus a `zoneList()` rebuild: roughly 100 disk reads per 15 s at 100 players, before housing and the boards add theirs. Replace with a module-level cache invalidated on mtime, exposing `ranksOf`, `holdersOf(zone, rank)`, `zoneOf(actor)`. Ten lines; it is the single highest-value scaling change in this document, and every system below asks "what is this player entitled to?" on a hot path.

**The lawful split.** `isLawful` currently grants restrain and search rights to anyone holding any rank in any zone. This design adds thanes, company ranks and time-boxed deputies; shipping on top of the current rule would let a large fraction of the server detain strangers anywhere. `private.dboLawful` becomes true only for a named **watch set** — `captain`, `commander`, `bane`, plus sworn deputies — **and only inside that zone's bounds**. `captureSystem.ts` and `searchSystem.ts` read the same property, so this is one gameplay-layer module change with a large correctness payoff and no rebuild.

---

### S3. The Roll — residence, and the first-hour destination

**Behaviour.** Every hold keeps a Roll: the people who have declared residence there. You sign it at the seat of government (Bruma's Lord's Manor) for a small fee, default 25 septims. Signing gets you the **citizen's rate** on board posts (30 → 10 in your own hold; outsiders keep paying 30), the right to post a **grievance** the officials see and can answer publicly, your name and trade on `/roll bruma`, and a line telling you who your Count is.

Residence is one hold at a time; changing it costs the fee again and drops standing to zero. Officials may **strike** a name with a public, reversible reason: an exile pays the outsider rate, may hold no licence in that hold, and may not be appointed.

**Why it earns its place.** It gives a new player a destination, a five-minute errand, a reason to ask directions, and a first public record entry — and it finally makes the `ff_knownIds` Stranger system pay off, because the Roll becomes the only place a name is public without an introduction. Reading the Roll is how you learn the smith exists.

**Authority model.** Signing is an `mp.onActivate` on a registered ref — phase 1 reuses the notice board itself, so no ESP work. Fee through the Ledger, 100% to the hold account.

**Data.** `server/roll.json`: `{zones: {bruma: {residents: {"<profileId>": {name, tag, trade, since, standing}}, struck: {}}}}`, written through `saveSoon`, plus `private.dboResidence` on the character for the cheap per-request read.

**Module.** `server/civics.js`. `/roll [zone]`, `/sign`, `/grievance <text>`, official `/strike <player> <reason>`. Widget in phase 3; chat is enough to ship.

**Anti-exploit.** Residence is **per profile**, or the character-select cycle mints citizens. An **eligibility gate** — a minimum recorded playtime and profile age — applies to signing, to holding office, and to signing a petition. One field, and it is the whole practical defence against alt-account politics short of migration 1.

---

### S4. Commissions with escrow — the machine that makes strangers work together

The highest-value system here and among the cheapest to build.

**Behaviour.** A **Commissions** tab on any notice board (chat-only in phase 1):

> *Wanted: 20 iron ore. 240 septims. Expires in 3 days.* — posted by Beriel #7K2A — **Secured, 240 held**

Posting stakes the reward: the gold leaves your purse the moment you post. A commission with no stake cannot be posted, so "he never paid me" stops being a category of complaint.

- **Take** — one open commission per character; the poster is told who took it.
- **Deliver** — the poster marks **Done** (escrow releases) or **Refuse** (it goes to arbitration).
- **Arbitrate** — a refusal appears on the officials' board tab. An official who is neither party rules; escrow pays out accordingly; refusal and ruling are both public. This is the job that makes office worth holding.
- **Expire** — untaken, the stake returns minus the posting fee. Taken but unresolved past a grace window, it auto-releases to the taker, with the poster warned twice first.
- **Kinds** — `goods` (deliver items, through the existing `tradeSystem`), `deed` (a job the poster judges: escort, clearing, building, a performance), `bounty` (S7). **The server verifies nothing about a deed.** It holds the money and records a verdict. That is deliberate: verifying "20 iron ore" is easy and verifying "escort me to Fort Horunn" is not, and one rule for both is simpler and far less gameable than two.

**Authority model.** The server owns take/release/refund, the one-open rule, expiry timers and the verdict. Escrow is a **ledger account**, not a container (see §6, conflict 1). Item delivery may optionally be verified on a `goods` trade, but the default is poster confirmation.

**Data.** `server/commissions.json`: `{id, zone, kind, poster, posterTag, text, reward, escrowId, taker, takenAt, state: open|taken|done|refused|ruled|expired, rulingBy, expiresAt}`, debounced through `saveSoon`. Boot asserts open stakes against escrow balances.

**Module.** `server/commissions.js`. Phase 1: `/commission post|list|take|done|refuse|abandon`, `/commissions`. Phase 2: a tab on the existing `bountyBoard` widget.

**Anti-exploit.**

| Attack | Defence |
|---|---|
| Alt wash: post to yourself to launder or farm | Poster and taker must be different **profiles**; a fee on post plus a duty on release means a round trip always loses money; repeated poster/taker pairs surface in the weekly report rather than being blocked |
| Griefing takes | One open commission per character; an expired take costs a small forfeit and a strike; three strikes bars taking for 24 h |
| Escrow as a bank or gold parking | Stakes expire, a commission cannot be edited after posting, max stake per commission, per-profile cap on total escrow |
| Official rules on their own dispute | Refused; arbitration needs an official of that zone who is neither party, and their name is on the ruling |
| Spam | Board fee plus a per-poster cooldown; the list is pulled by the widget, never pushed |

---

### S5. The Charter — the numbers a ruler owns

**Behaviour.** `/charter` shows the hold's standing law: what a notice costs, what a dungeon charter costs, what the levy is, what a contract pays per kill, what rent is, what the watch is paid. The seat-holder changes a line with `/charter set <field> <value>`. A change takes effect after a **proclamation delay** (default 30 real minutes) during which it sits on the board as *"Proclaimed, takes effect at …"* and can be withdrawn. Citizens always get warning, and always get something to argue about.

**Authority model.** Every field has a hard `[min, max]` in `gamemode-config.json` that a ruler cannot escape, plus a `default` used when a zone has no seat-holder. Systems read through one cached accessor, `globalThis.__dboCharter(zoneId, field)`. No client ever supplies a rate.

**Phase-1 fields — every one re-points a constant that gameplay-layer code already reads:**

| Field | Clamp | Read by | Replaces |
|---|---|---|---|
| `dungeonFee` | 0–250 | `dungeons.js` claim | nothing (new sink → treasury) |
| `dungeonLevy` | 0–25 (coin in N) | `dungeons.js` `splitGold`, `corpseLoot` | nothing (the revenue organ, S8) |
| `contractPerKill` | 5–120 | `contracts.js` `CFG.rewardPerKill` | hardcoded `{1:12, 2:25, 3:60}` |
| `contractBudgetWeekly` | 0–5000 | `contracts.js` refresh | the unbounded balance check |
| `pigeonBase` / `pigeonPerKm` / `pigeonCap` | small bands | `gamemode.js:355` | hardcoded 5 / 10 / 50 |
| `rollFee` | 0–100 | `civics.js` | new |
| `commissionDuty` | 0–10 (coin in N) | `commissions.js` release | new |
| `wage.<rank>` | 0–500/wk | `economy.js` payroll | new |

**Phase-3 fields** (need the bundle): `noticeFee` and its treasury share (`bountyBoardSystem.ts:62`, `:69`), `recruitFeeCity`/`recruitFeeTown` (`costOf:679`), `rentWeekly` and `marketDuty` once `housingSystem.ts` owns tenancy.

**Data.** `server/charters.json`: `{bruma: {fields: {...}, pending: [{field, to, by, at, effectiveAt}], history: [{field, from, to, by, at}]}}`.

**Module.** `server/charter.js`. (Companies live in `companies.js` — see the naming note in §6.) Widget in phase 2.

**Anti-exploit.** Clamps live in config, not in the charter, so a ruler can never set a fee to zero or to a million. At most N changes per zone per day, and a field may not move more than X% per change — so no ruler flips rent to maximum for ten minutes while a rival is offline. The delay means no change can be timed at one player. Every change journalled with the before-value; reverting is one command and is also on the record.

---

### S6. Licensed premises — rent, shops, and the sink that is missing

**This answers `CHECKLIST.md:939`.** The faucet is already decided by the code — labour, dungeons, purses, reloot. What is missing is a drain, and the drain should be **rent**, because rent recurs, scales with what a player has invested, is thematically exactly what a hold does, and is paid *to a treasury other players then spend*.

**Behaviour.**

- **Claim** as today (`housingSystem.ts`, 8 free claims), but a claim is now a **tenancy** carrying a weekly **ground rent** to the hold, within the charter's band. **The first claim is rent-free, per profile** — a bedroll and a chest should never be a bill.
- **Licence to trade** turns claimed premises into a **shop**: one container you stock, plus a price list you write (`/shop price <item> <n>`). Any player browses the shopfront through a widget and buys at your listed price **without you online**; the item leaves the container, the coin leaves the buyer's purse, and the seller is credited to their account minus the hold's **market duty**. Sales while you are asleep are the whole point: a 100-player server is not 100 players at once, and the best reason to log in is that your shop sold three things overnight. It is also what makes crafting mastery socially real — the Master Smith's name is on a shop people visit when she is offline.
- **Market day**: an official proclaims a market in the capital for a window of hours; duty is halved and stall licences are cheap. A reason for everyone to be in one place at one time, which is the cheapest event technology that exists.
- **Arrears**: two weeks unpaid and the property is **distrained** — locked by the hold, contents held, posted on the board for seven days before it is re-let. Never deleted, never looted by the server. A struck player's shop is frozen, not seized.

**Authority model.** The purchase is entirely server-side: verify the item is in the container, remove it, move the gold through the Ledger, apply duty, give the item to the buyer. The client names `{shopId, listingId, count}`. Prices are server-held. **The shopfront is a registered box (S1), so activation is refused** — owner and buyer both use the widget, which means neither can race the server's write and nobody empties the shelf by hand. Listings are re-validated against the container's real contents on every browse.

**Data.** Extends `housing.json`: `{rentZone, rentWeekly, licence: {kind, until}, shop: {front, prices: {baseId: n}, takings}, arrearsSince}`. Rent runs on **one timer per real day over premises** (tens, not thousands), charges, logs, notifies owners who are online and pigeons those who are not.

**Module.** `server/premises.js`. Widget 36.

**Anti-exploit.** **Price band: a listing below 10% or above 1,000% of the record's base value is refused** — the main alt-to-alt laundering channel, closed cheaply. A price of zero is refused (use a gift or a commission). Per-buyer-per-shop rate limit; per-pair daily sale cap with asymmetric pairs in the weekly report. Duty taken at the moment of sale, before the seller sees the gold. Rent is charged per premises, not per character. No global search: you find shops through the board's existing **Shop Ads** tab and by walking.

---

### S7. Crime and law

Half of this exists and is the best-built code in the repo: consent-gated `captureSystem.ts` (bound hands, carry, leash), `searchSystem.ts`, the lawful flag, locked jail cells, and the playtest region lock as a proven confinement pattern. **And restraint is already enforced on the hit and activate paths** (`gamemode.js:1935`, `:624`) — only the `onUi` minigame handlers still need a guard. What is missing is the record, the process and the consequence.

**Behaviour.**

- **Report** — `/report <player> <what>`, from victim or witness, creates a complaint on the hold's record and the officials' tab. The server never judges.
- **Bounty** — an official records a public bounty with a stated crime and amount; it shows on `/wanted` and the board. Not an engine bounty; there are no guards.
- **Writ of arrest** — extends restraint rights for one named target to named deputies for a window. Without a writ, restraint stays what it is: the watch set only, in their own zone.
- **Deputy** — an official deputises a player for hours, granting the watch flag scoped to that hold. This is how the Captain builds a watch out of players, and it is the single feature most likely to create nightly roleplay.
- **Gaol** — a restrained prisoner is committed to a named cell for a sentence in **real minutes of online time**, capped (120 online minutes, never more than a day of real time), enforced on the server's timer. The sentence ticks only while online, so it cannot be slept off; leaving the cell returns you to it.
- **Fine and weregild** — a fine to the treasury, a weregild to the victim (the lore-correct Nordic blood price). Both collected through the Ledger, over time as a public debt if the convict cannot pay at once — far more interesting than an instant deduction. A debt blocks housing claims and contract payouts until settled.

**Authority model — the clerk model, stated out loud.** The server records three classes of fact and no more:

1. **Facts it owns** — a hit it adjudicated, a container it saw opened, a lockpick attempt it authorised, a gold movement, a lease claim. These are evidence.
2. **Facts a player swears to** — the complaint text. Testimony, marked as such, never auto-acted on.
3. **Facts a client asserts** — nothing. Ever.

"Caught in the act" is built only on **server-adjudicated PvP hits inside a settlement radius**, never on client-reported crime.

**Data.** `server/law.json` per zone: `complaints[]`, `bounties[]`, `writs[]`, `sentences[]`, `debts[]`, `deputies[]`; sentence state mirrored on `private.dboSentence` so a relog resumes it.

**Module.** `server/law.js`, plus the `onUi` guard in `gamemode.js`. `/report`, `/wanted`, `/bounty`, `/writ`, `/deputise`, `/commit`, `/release`, `/fine`, `/weregild`, `/record <player>`.

**Anti-exploit.** No gaol without a complaint on the record, so there is always a stated cause. Sentence caps and per-official daily caps on gaol minutes and fine totals, drawn from the charter. **Fines go to the treasury, never to the arresting official** — no bounty-hunting-for-profit loop, no shakedown incentive. Deputy grants are time-boxed, revocable, capped and logged. Fines above a threshold need the two-signature rule. **Appeal to the Empire**: any sentence can be appealed and admins can vacate it — the release valve that makes it safe to hand players real coercive power. Repeated arrests of the same player by the same official inside a window are flagged, because the abuse case here is harassment, not gold.

**Honest caveat:** every distance gate — arrest range, gaol containment, shop and counting-house range — reads a client-authored position until movement rate validation ships with `"enforce": true`. Say so out loud rather than claiming containment. It is also why every large withdrawal is gated by a delay, a co-signature and a public posting rather than by proximity.

---

### S8. Revenue, the levy, payroll, and the Crown

> **The Crown is not a faucet. The hold levies the faucets and pays the same coin back out.**

**Revenue in.** The **dungeon levy** is the important one: `dungeons.js` refills every chest on every lease, hands out `corpseLoot` per body and splits gold across the party, all server-side. Withholding a coin in N at the moment of payout costs nothing, cannot be touched by a client, and turns the largest managed faucet into the main organ of state revenue. In fiction it is the county's cut of a chartered expedition, which is how an Imperial county would treat freelance delving. Alongside it: dungeon charter fees, board fees, pigeon fees, the Roll fee, commission duty, ground rent, licences, market duty, fines, company charter fees, donations. Every one is coin the server itself created or moved, computed server-side, no client in the path.

**Spending out.** Commissions and contracts (escrowed at posting), **payroll** (weekly, per rank, from the charter), writs, requisitions, company grants.

**No daily stipend.** A stipend is a faucet with no story. Payroll from a treasury is the same coin with politics attached, and it recirculates rather than minting.

**The Crown.** A pseudo-account `crown` receives a clamped **tithe** of each zone's revenue — tribute rendered to the Elder Council, *not burnt* (see §6, conflict 2). It is the sink of last resort and the only place GM economic action should happen. Concretely: **admin gold grants stop minting and become transfers from the Crown**, journalled like everything else. `adminSystem.ts giveItem` is currently the most dangerous unjournalled faucet in the game; this puts it on the same record as a 30-gold notice fee.

**Hold requisitions** (phase 3, and the one genuinely contested mechanic — see §6, conflict 3). A hold's quartermaster *posts a standing order* to its notice board: *"Bruma will pay 14 septims a bar for 200 iron bars"*. **A player official sets the price, the cap and the commodity; the server never posts one on its own and never sets an opening price.** Each fill nudges that hold's price down within the band the official set, and it recovers over days. A hold cannot buy what its coffers cannot cover. This is the liquidity bootstrap for a thin playtest — something to sell when six people are online — and once region-locked gear lands, the spread between two holds is a real trade route you walk with a friend and a horse.

**Anti-exploit.** Wages capped as a share of trailing four-week revenue; a seat-holder's own wage capped harder than their subordinates' and raisable only with the delay and the co-signature. Payroll is one journal entry per zone per week on a timer over zones, never a loop over players; wages pay to the account, so payroll cannot be farmed by logging in and out. Unpaid wages accrue as visible `owed` — a bankrupt hold is a political event, not a silent failure. Per-profile daily fill cap per commodity; requisition spending sits inside the zone's outflow cap and counts against the yield budget.

---

### S9. The yield budget — built now, slack now

`meter(profileId, source, amount)` returns a multiplier applied to every adventuring faucet: dungeon chests and corpses (`dungeons.js:252/271/739`), coin purses (`gamemode.js:1449`), camp chests (`wildlife.js:83`), champions, contract rewards, requisition fills. One mechanism closes four holes at once — alt farming (budgets are per profile, not per character), the rotating-leader dungeon farm, the unbounded chest refill per lease, and the absence of any cap on total minting.

**Ship it wired and slack.** Set the soft cap far above what a long evening produces, so nothing is nerfed on a five-player playtest. The failure mode of the source design was shipping a farming nerf to the ten people currently keeping the playtest alive. Turn it down only when the population justifies it and the metrics say so — and when it does bite, it is described in-world ("the purses hereabouts are picked over"), never as a percentage.

**Riding along, in phase 1:** the dungeon cooldown is checked for **every party member** at claim, not only the claimant (`dungeons.js:630` vs `:301`); dungeon and camp-chest cooldowns move from character scope to **profile** scope; coin-purse rest timers move out of the `globalThis` Map (`gamemode.js:1451`) into the change form, so a restart stops re-opening every purse in the world at once.

---

### S10. Companies — charters, ranks, halls

**Behaviour.** A group petitions a hold official for a **Charter of Company**: a founding fee (default 1,000 septims, tuned), a name, a seat, a purpose in one line. The official grants or refuses; the grant is a Hold Notice. A chartered company gets a **rank ladder the founder writes** (up to five ranks, any names, three permission bits: *invite*, *spend* with a daily limit, *speak for the company*), a **company strongbox** on the same ledger with the same caps, a company line on inspect and `/who`, one **hall** (a housing claim owned by the company, paying rent like any premises), and a member-scoped `/c` channel.

A ruler may **revoke** a charter with a public reason: the ladder dissolves, the box returns to the founder minus fees, and it is an enormous political act. Companies are the natural home for a Fighters Guild, a mercenary crew, a merchant house, a temple order, and a criminal outfit that has bribed the right official into chartering it as a salvage company.

**Authority model.** The server owns membership, ranks, permissions, the box, the rent and the revocation. The *meaning* is entirely player-authored — no guild questline, no guild vendor, no rank-up requirement. Deliberately **no new machinery**: a company is a zone with no territory, using the same ledger and the same roster cache.

**Data.** `server/companies.json`: `{id, name, seatZone, purpose, founded, grantedBy, box, ranks: [{key, title, invite, spend, spendDaily, speak}], members: {"<profileId>": {rank, since, tag, name}}, hall, state}`, plus `private.dboCompany` for the O(1) lookup.

**Anti-exploit.** Membership per profile. **Company ranks never grant the watch flag** (S2). Daily draws cannot exceed the box cap; every box movement is journalled with the actor and the rank that authorised it. Mass-invite rate-limited. One hall and a capped number of premises, so charters cannot corner housing. A dissolved company's coin goes to the chartering treasury, not the master's purse, and the dissolution is on the record.

---

### S11. Governance — succession, grievance, the Record

**Delegated appointment.** `/appoint` and `/dismiss` widen from admin-only to **admin, or the seat-holder of that zone appointing a non-seat rank**. The Count appoints their own Steward, Captain and Thanes without an admin. `officials.json` keeps its exact schema — `zones.ts`, `bountyBoardSystem.rankIn:430` and `housingSystem.holdRanks:495` all read it — and everything new goes in a sidecar `offices.json` with one writer.

**Absence and succession.** No elections for a hold seat. A seat-holder absent `interregnumDays` (default 10) puts the zone in **Interregnum**: the Steward is *acting* — may pay wages and honour standing obligations, may not change the charter, appoint, or sign above the small cap. After `vacancyDays` (default 21) the seat is **Open**: a permanent Hold Notice, and citizens **petition** by signing at the board (one per profile, timestamped, public, subject to the eligibility gate). The Empire — admins — confirms from the petition. Lore-true, keeps admins out of daily work, and gives players a campaign to run. **Stronghold seats use a consented Challenge instead**, reusing `captureSystem`'s existing consent prompt: the survivor is Chieftain. Never a ballot in an Orc stronghold.

**Grievance and the Record.** Any resident posts a grievance to the officials' tab; officials answer publicly. `/record [zone] [n]` and a Record tab render the last N days of a zone's public acts — appointments, proclamations, writs, payroll runs, rulings, sentences, charters — in fiction ("On the 14th, the Count proclaimed the dungeon charter raised from twenty to forty Septims"), not as log lines. **Pull-only, never pushed, never broadcast** — the rule `champions.js` broke within an hour of being written.

The Record is four things at once: the anti-corruption mechanism, the campaign material that makes seats contested, the in-fiction reason a hold's politics are knowable, and the human-readable half of the metrics.

**Metric for this system:** routine `/appoint` calls by admins should trend to zero.

---

### S12. Feuds, duels, standing, proclamations

Light mechanics whose job is to *name* what players already do so it accretes history.

- **Grudge** — `/grudge <player> <reason>` records a public grievance visible on both players' inspect. Expires in thirty days unless renewed, or ends when one posts `/settle` and the other accepts, optionally with a weregild through escrow. Perhaps twenty lines, and the highest roleplay-per-line item on the table.
- **Sanctioned duel** — both consent; the server records the stakes (gold in escrow or an item), and a death inside the duel window is recorded as a duel, so no complaint can be filed on it.
- **Standing** per hold per profile, moved only by facts the server already owns — commissions completed, rent paid on time, offices held, convictions, being struck. Shown as a word, never a number ("well regarded in Bruma", "in bad odour"). Gates nothing mechanical. Cannot be farmed by alts, because every input is either paid for or requires a second distinct profile.
- **Proclamation** — a free, pinned, titled notice with a time and a place; `/events` lists what is coming. When an official calls `/attend`, the server takes **one position snapshot** of online players in that world and may pay an attendance purse from the treasury. Market day, a trial, a funeral, a tournament, a wedding at the Chapel — one object. Never a broadcast: it reaches the board, and one notice to online residents of that hold.

---

## 6. Conflicts between the source designs, resolved

**1. Escrow: a real container ref, or a ledger account?** → **Ledger account.** The winning design used a real box ref so world gold stays physically conserved, but that reintroduces exactly the container surface the activate guard exists to remove, and an escrow account nobody — including admins — can spend except through `release`/`refund` is strictly safer. Conservation is proven by the boot and hourly reconciliations, not by coins in a box.

**2. The imperial tithe: burnt, or paid to a Crown account?** → **Paid to the Crown.** Burning is balance maths in costume — tribute should reach the Empire, not evaporate. Routing it to a `crown` account gives the same macro lever (raise the tithe, drain supply), makes admin grants transfers instead of mints, and reads correctly in fiction: the county renders to the Elder Council, and later a Stormcloak hold withholding it is free roleplay. A `crownBurnShare` config knob stays available if supply ever needs a true destroyer.

**3. Hold requisitions vs "no NPC merchants".** → **Ship them, player-driven, in phase 3.** A server computing an EMA price and posting its own buy orders is an NPC merchant without the NPC. Resolved: a player official posts the requisition, sets the opening price, the band and the cap, and funds it from the treasury; the server only decays the price per fill inside that band and refuses what the coffers cannot cover. No requisition exists until a Count posts one. That keeps the liquidity bootstrap and keeps the standing decision intact.

**4. The yield budget: tune it now, or later?** → **Build it now, set it slack.** See S9. The mechanism closes four exploits; the *nerf* is premature on a five-player playtest.

**5. Sinks: destroy or move?** → **Move.** Rent, duty, levies and fines go to a treasury players control. The one existing destroyer that stays is respec (1,200), and it gets a reason code. The board fee's currently-destroyed half stops being destroyed and becomes duty to the treasury — one number, and it removes an invisible sink.

**6. Flat fees vs percentages.** → Both, by role. Flat where it is a stamp on a document (Roll 25, notice 30/10, charter 1,000) because that is what a clerk charges; percentage where it scales with activity (levy, duty, rent by property value) because a flat fee is noise at 1,000 players.

**7. Elections.** → **No.** Imperial confirmation from a public petition for county and hold seats; a consented Challenge for strongholds; the Moot reserved for the High King and unused. Revisit only if Skyrim opens with enough jarls to make one mean something.

**8. Restraint guards.** → **Mostly already done.** All three sources budgeted work for `onHitDamageAttempt` and `mp.onActivate` refusals that exist today (`gamemode.js:1935`, `:624`). Only the `onUi` minigame handlers need guarding. `SERVER_AUTHORITY.md` migration 16 should be corrected.

**9. Module naming.** The winning design used `charters.js` for companies and the politics design used `charter.js` for rates. Resolved: **`charter.js` = the hold's standing law** (rates), **`companies.js` = Charters of Company**. Player-facing language keeps both senses of "charter"; the files do not collide.

**10. "100,000 seeded".** → It is **~90,000**, across 9 of 17 zones, and the other 8 are silently burning every fee sent to them. Both are phase-1 fixes.

---

## 7. How existing code changes

| Existing piece | What changes | Rebuild? |
|---|---|---|
| `gamemode.js:428 takeGold`, `:440 depositToTreasury`, gold `giveItem` | Thin wrappers delegating to `__dboBank`, so call sites need not all move at once | none |
| `gamemode.js:676-695 seedTreasuries` | Seeds the **account**, journals it as `seed`, sweeps and leaves the chest empty under `private.treasuryLedgered`; `private.treasurySeeded` untouched so the `__dboEmptyWorldContainer` interaction at `:1497-1510` is unchanged | none |
| `gamemode.js:620-645 mp.onActivate` | One more delegate: `__dboStrongbox` refuses any registered box ref | none |
| `gamemode.js:355 / :509-510` pigeon fee | Reads the charter; a zone with no account **refuses the fee with a message** instead of burning it | none |
| `gamemode.js:1277 ranksOf` | Re-exported from the cached roster with an mtime watch; kills ~100 disk reads per 15 s at 100 players | none |
| `gamemode.js:1282 /appoint`, `:1296 /dismiss` | Widened to admin-or-seat-holder for non-seat ranks; new state in `offices.json`, `officials.json` schema untouched | none |
| `gamemode.js:1449-1484` coin purses | Rests persisted to the change form; grant goes through `mint` + `meter` | none |
| `gamemode.js` `onUi` minigame handlers | Refuse a restrained actor (the one remaining migration-16 gap) | none |
| `playermenu.js:37/47 isLawful` | Watch set in-zone instead of any-rank-anywhere; adds Report, Duel, Grudge to the X menu and company, title, residence, standing to inspect | none |
| `contracts.js:76/87` | Delegate to the Ledger; `:190-200` escrows at posting so a posted contract is always funded and an expired one refunds; rewards and weekly budget from the charter; `/contract post` becomes a writ under the caps | none |
| `dungeons.js:291/630` | Cooldown checked for **every** party member; cooldowns profile-scoped | none |
| `dungeons.js:252/271/739`, `wildlife.js:83`, `champions.js:168` | Each faucet calls `mint` with a reason code and the `meter` multiplier | none |
| `dungeons.js splitGold / corpseLoot` | Charter fee on claim; levy withheld at payout | none |
| `masterySystem.ts` respec (1,200) | Routed through `burn`/`move` with reason `respec` — phase 3, or left alone and counted by the census until then | server TS |
| `bountyBoardSystem.ts:62/69/329/334/493/679`, `rankIn:430` | Phase 1: untouched — the chest sweep puts its fees on the books. Phase 3: fees from the charter, deposits direct to the ledger, sweep retired, Commissions / Proclamations / Complaints tabs, `rankIn` narrowed so Thanes cannot post Hold Notices or remove others' notices | server TS + restart |
| `housingSystem.ts` (`MANAGER_RANKS:66`, claim/lock/key) | Phase 3: exclude registered box refs from `claim`; tenancy, rent, arrears, distraint; `kind:"stall"`; company ownership | server TS + restart |
| `captureSystem.ts`, `searchSystem.ts` | Read the narrowed watch flag automatically; phase 3 gains writ scoping | none for the flag |
| `tradeSystem.ts` | Stays the P2P channel; phase 3 journals gold moved in a trade — the last unlogged transfer path | server TS |
| `adminSystem.ts:578-589 giveItem` | Phase 3: gold grants become Crown transfers, journalled | server TS |
| `metricsSystem.ts` | Phase 3: economy gauges on the Prometheus endpoint; until then the hourly rollup line in `server.log` and `/econ` | server TS |
| `zones.json` | No schema change. Every zone gets an **account** regardless of a `treasury` ref; phase 2 places containers for Dawnstar, the six strongholds and Solstheim | none |
| `server-settings.json` | Remove `MISC` from `reloot` (or exclude placed gold) — **restart** | restart |
| Front (`constructor.js` widget switch, `dbo-theme.scss`) | New widgets **35** strongbox/treasury, **36** shopfront/market, **37** charter/record, **38** company — the `dungeonGate`/`bountyBoard` pattern exactly | front build only |
| `audit()` / Discord | Stays the GM channel. The journal is the durable record; do not conflate them | none |

---

## 8. Build plan

Standing hazards for every item below: **every save goes live mid-edit**, so land a module in one write, not two; **register `mp.on` listeners once via `globalThis` and delegate**, or each reload stacks another handler; state that must survive a reload goes on `globalThis`, state that must survive a restart goes in a change form or a file.

### Phase 1 — gameplay layer only, hot-reloads, no rebuild, no relaunch

**Must ship (this is the week):**

| # | Item | Files | Size |
|---|---|---|---|
| 1 | **Roster cache** with mtime invalidation replacing the per-call `readFileSync` + `zoneList()` rebuild; export `ranksOf`, `holdersOf`, `zoneOf` | `gamemode.js:1277-1281` | ~10 lines |
| 2 | **Lawful split** — watch set (`captain`/`commander`/`bane` + deputies) scoped to the zone's bounds | `playermenu.js:37,47` | small |
| 3 | **The Ledger** — accounts, double entry, closed reason enum, per-account promise chain, purse read-back + `LEDGER DESYNC`, no-purse-write-during-container rule, `ledger.jsonl` via `saveSoon`, boot + hourly reconciliation, `globalThis.__dboBank` | `economy.js` (new) | ~300 lines |
| 4 | **Strongbox registry + activate guard + chest sweep**; treasury migration under `private.treasuryLedgered`; accounts for the 8 treasury-less zones; `/treasury <zone>` public, `/purse`, `/ledger` | `economy.js`, `gamemode.js:620-645`, `:676-695` | medium |
| 5 | **Outflow caps, two-signature, public delay at signature** — in the Ledger, so contracts, payroll and writs inherit them | `economy.js` | medium |
| 6 | **Commissions + escrow**, chat-only, with arbitration | `commissions.js` (new) | ~350 lines |
| 7 | Re-point existing gold paths at the Ledger; **escrow contract rewards at posting**; pigeon fee refused (not burnt) in an account-less zone | `gamemode.js:428/440/509`, `contracts.js:76/87/190` | small |
| 8 | **Anti-exploit fixes**: party-wide dungeon cooldown check; dungeon and camp cooldowns profile-scoped; coin-purse rests to the change form; `onUi` restraint guard | `dungeons.js:291/630`, `gamemode.js:1451`, `wildlife.js` | small |
| 9 | **Gold out of world reloot** (`MISC` removed / placed gold excluded) and every faucet reporting to the Ledger with a reason code | `server-settings.json` (restart), faucet call sites | small |
| 10 | **Telemetry**: hourly `economy` rollup line — supply, faucet and sink by reason, top-decile share, escrow float; `/econ` (admin) | `economy.js` | small |

**If the week holds** (otherwise it is week two, and nothing above depends on it): the **Roll** (`civics.js` — `/sign`, `/roll`, `/grievance`, `/strike`, citizen board rate), the **Charter** (`charter.js` — clamps in `gamemode-config.json`, proclamation delay, `/charter`, the accessor), the **yield budget** wired slack, and `/record` chat-rendered.

**Phase 1 exit test, in game, two accounts.** Post a commission; confirm the stake leaves the purse and the escrow account holds it. Take it on the second account, deliver, confirm payout and both journal lines. Refuse one and have an official rule on it. Try to open the Bruma safe by hand — refused. Drop 100 gold into it — swept and recorded as a donation with your name. `/treasury bruma` shows the seed and every movement. Claim a dungeon, pay the charter fee, loot, and watch the levy land. `sum(journal) == balance` for every account.

### Phase 2 — the board and the shops (front build; one small TS change)

- Commissions, Proclamations and an officials-only Complaints/Arbitration tab on the existing `bountyBoard` widget (front build + `bountyBoardSystem.ts` for the tab and a pull endpoint).
- Widget **35** strongbox/treasury with the public ledger; **36** shopfront browse/buy with server-held prices and the price band; **37** charter proclamation sheet and Record.
- `premises.js`: ground rent on a daily timer over premises, licences, arrears and distraint, market day.
- Treasury containers placed for Dawnstar, the six strongholds and Solstheim.
- Interregnum, vacancy, petitions; delegated `/appoint`; `offices.json`.
- Payroll, wage clamps, the Crown account and the tithe.

### Phase 3 — the bundle, and the law

- `housingSystem.ts`: exclude registered box refs from `claim`; tenancy fields; `kind:"stall"`; company ownership.
- `bountyBoardSystem.ts`: fees from the charter, deposits direct to the ledger, sweep retired, `rankIn` narrowed.
- `adminSystem.ts`: gold grants become Crown transfers. `tradeSystem.ts`: journal gold moved. `masterySystem.ts`: respec through the Ledger. `metricsSystem.ts`: economy gauges.
- `companies.js` + widget 38: ranks, members, box, hall, `/c`.
- `law.js` + Record widget: complaints, bounties, writs, deputies, gaol, fines, weregild, debts, appeals.
- Hold requisitions (player-posted, player-priced) through the Hold Notices pool.
- Move the journal and accounts off JSON into `skymp5-backend` per `SCALING_NOTES.md §3.3` once the write rate justifies it — anything a player owns or trades is global state.

### Gates outside this plan

- **Login identity (migration 1).** In offline mode the client names its own `profileId` and `profileId: 1` is a full admin. Every record here — residence, escrow, office, membership, sentence, standing — is keyed to profileId. Build it; **do not open the port** until identity is bound. (`login.ts` already remaps admin profileIds arriving from a non-loopback IP, so the exposure is impersonating a non-admin office-holder, not walking in as an admin. Still a hard gate.)
- **Movement rate validation (migration 2)**, built on `movement-rate-validation`, not enforcing. Until it runs with `"enforce": true`, every proximity check here is advice — which is why the large-payment controls are a delay, a co-signature and a public posting rather than "you must be at the counting house".

---

## 9. Metrics

**Economy** (hourly rollup from the journal; daily file; `/econ` admin-only):

- **Total supply** = accounts + treasuries + escrow + company boxes + measured purse float. The one number that reveals duplication.
- **Minted minus observed.** Non-zero means an unledgered faucet or a dupe. Alert.
- **Faucet throughput by reason per hour** — dungeon chests, corpses, purses, camp chests, reloot (instrument it), admin grants. No single source above ~40%.
- **Sink throughput by reason**, and **burn ratio** = sinks ÷ faucets. Target 0.9–1.1. This is the tuning target; move the tithe in five-point steps, weekly, with this number in front of you.
- **Mean ÷ median** of purse+account (target under ~3) and **top-1% share** (trending flat).
- **Velocity** = market + trade + commission volume ÷ supply ÷ day. Rising through the first month. A high-supply, low-velocity economy is dead.
- **Yield-budget saturation** — share of active profiles hitting the soft cap. Under 10%, or the cap is wrong.
- **Trade-pair asymmetry** — net flow per profile pair over seven days. The collusion and RMT detector; surface it weekly rather than blocking.
- `LEDGER DESYNC`, `LEDGER DRIFT`, `ESCROW DRIFT` counts. Zero.

**Is it producing stories?**

- **First-hour social rate** — share of new characters who introduce themselves, take or post a commission, or sign the Roll within 60 minutes. The headline number, and the one to optimise.
- Commissions posted / taken / completed / refused / arbitrated per day; median time from post to take; **median time to a ruling** (if it climbs, add an auto-release default rather than more process).
- Distinct trading pairs per week — how wide the web is, not how deep one pair is.
- Companies chartered, alive at 30 days, median membership.
- Shops licensed, sales per shop per day, **share of sales made while the owner is offline**.
- Complaints, arrests, convictions, appeals, vacated sentences; grudges opened and settled.
- Seats filled, mean tenure, interregnums per month, contested petitions.
- **Charter changes per zone per week — if this is zero, the politics layer is furniture.**
- **Routine `/appoint` calls by admins — target zero.**
- Writs per week, share needing a second signature, share cancelled during the delay (small but non-zero is healthy: it means citizens are watching).

**Load**

- Roster cache hit rate; `officials.json` reads per minute ≈ writes.
- File write rate across `commissions.json`, `roll.json`, `companies.json`, `law.json`, `ledger.jsonl` — the trigger for a real store.
- `slow tick` lines for the new timers; journal writes per minute; payroll and Record render duration.
- Packets per minute per system. Anything proportional to player count squared is a bug (`SCALING_NOTES.md §4`).
- D1/D7/D30 retention split by "did something social in the first hour" versus not.

---

## 10. Open decisions for the owner

| # | Decision | Recommended default |
|---|---|---|
| 1 | **Do treasuries stop being physical chests?** Fixes the unlocked-safe hole, the three-writer race and the claim-lockout at once, but the Count's safe becomes a menu | **Yes** — and keep the safe as the counting-house *interface*, so the roleplay is unchanged: you still walk to it, you just cannot rummage it |
| 2 | **Coin loss on death.** Today death keeps inventory (playtest note 2026-09-15). Coin at risk is what makes banking mean anything | **Off for the playtest.** Ship it configurable at 10% / cap 500 / half dropped as a lootable purse, default zero, and revisit with numbers |
| 3 | **The imperial tithe** — how much of hold revenue renders to the Crown | **One coin in five (20%), paid to the Crown account, not burnt.** Adjust in five-point steps against the burn ratio |
| 4 | **Ground rent at all**, and the first-claim exemption | **Yes, per-profile first claim free**, rent default **zero in the charter** so each ruler chooses to impose it. If players hate it the fix is political, which is the right outcome |
| 5 | **Market duty band** a ruler may set | **0–10%, default 5%** |
| 6 | **Are `/econ` and world supply figures admin-only?** | **Yes.** Players see their own ledger and their hold's books; nobody sees the world's |
| 7 | **Remove `MISC` from reloot** (placed coin piles re-arm hourly, uncapped, unlogged — very likely the largest faucet on the server) | **Yes, phase 1.** Every other tuning number is guesswork until this is closed or measured |
| 8 | **Yield budget at launch** | **Wired into every faucet, cap set slack** so nothing is nerfed at playtest population |
| 9 | **Requisition commodity list** — which goods a hold may post orders for | Ores, ingots, firewood, pelts, leather, food, potions, arrows. Curated, not "any item" |
| 10 | **Where the admin line sits on official abuse** — write it down before the first incident | Harassment and real-money trade: intervene. A steward who overspends on his friends: that is politics, and the Record is the remedy |

---

## 11. Risks

1. **Identity is forgeable today.** Everything here is keyed to profileId. Build it; do not open the port until migration 1 lands. This is the one item that can invalidate the rest of the page.
2. **Positions are client-authored** until movement rate validation enforces. Shop range, arrest range, gaol containment and attendance are soft. Say so; do not claim containment.
3. **Purse races.** One writer per account, no hand-opening of any registered box, no purse write during a container session, read-back verification, and the minted-versus-observed gap to catch what slips. This is an engine-level limit, and `LEDGER DESYNC` exists to keep us honest about it.
4. **Hot-reload half-states.** Escrow and the ledger must be re-entrant: load, validate against the accounts, and refuse to operate on a mismatch rather than guessing.
5. **Over-tuned sinks kill a server faster than inflation does** — deflation is felt immediately by the poorest player. Start rent low, first claim free, distraint slow and loud, every rate in config. Over ~10% of players in arrears means the number is wrong, not the players.
6. **Official abuse is a feature until it is a problem.** Caps, signatures, delays and a public ledger make theft visible, slow and attributable; they do not prevent it. The appeal to the Empire is the release valve.
7. **Density.** A player market needs players in one place. Bruma-only is the right scope; resist spreading boards, shops and companies across nine holds before Skyrim opens.
8. **Six new JSON state files** on the main thread at 100 players. All through `saveSoon` from day one, none read per request; the roster cache is the pattern, and file write rate is the trigger to move to the backend store.
9. **Scope.** Three phases. **Phase 1 stands alone and is worth building even if nothing else ships**, because it is the measurement apparatus and it closes four live exploits. Phase 3 is the cut line.
10. **Nobody engages.** Possible, and survivable: the roster cache, the ledger and the strongbox guard are correctness wins regardless of whether anyone ever wants to be Count.

---

## 12. The one-paragraph version

Make a hold's money a ledger instead of a chest and refuse to let anyone open the chest. Let a player post work with the coin already held, so a stranger has a reason to speak to a stranger in the first ten minutes and an official has something to rule on. Give the seat-holder a dozen clamped numbers that the code already written will read, take the hold's cut at the moment the dungeon pays out, and pay it back as wages, commissions and contracts. Print every appointment, proclamation, payment and sentence on a board any citizen can walk up to. Then get out of the way: the server enforces the clamps, keeps the books, and remembers who did what — and the players supply the argument.