// Mining and woodcutting as timing mini-games, loaded by gamemode.js like dungeons.js and wildlife.js.
// An ore vein (MineOre / CYRMineOre activators) belongs to the Miner skill, a chopping block to the
// Woodcutter. Both use the same front widget: a marker sweeps a bar and the worker strikes while it
// sits in the band. The server sends the round, judges the report and hands out the yield.
//
// The round is the server's, not the widget's (SERVER_AUTHORITY.md migration 7, the reading game in
// gamemode.js is the same pattern): the server rolls a seed, derives the band centre for every
// strike from it and sends the sweep, the band list and the cooldowns. The widget renders exactly
// that and reports WHEN each strike fell, never whether it landed; the server replays the sweep at
// those times and counts the hits itself. Both sides run markerAt() on the same integer millisecond,
// so the server's verdict is the same number the player saw — there is no latency term in the
// scoring at all. Latency only binds the widget's clock to the server's (see lagGraceMs).
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

module.exports = (api) => {
  const { mp, log, personal, audit, display, who, cfg, openWidget, closeWidget, onUi, giveItem, skills, sendPacket, onlineActors, distanceMeters, hasUiCap } = api;
  // The shared rules for client-judged mini-games, beside this file (reloaded with it)
  const MINIGAMES_JS = path.join(__dirname, 'minigames.js');
  delete require.cache[MINIGAMES_JS];
  const MG = require(MINIGAMES_JS);

  const WIDGET_ID = 33;
  const CFG = Object.assign({
    enabled: true,
    seconds: 30,
    // Band half-width in percent of the bar at tier 1..5: a higher tier is an easier strike
    bandByTier: [7, 8, 9, 11, 13],
    // Seconds the marker takes to cross the bar once, tier 1..5
    sweepByTier: [1.5, 1.4, 1.3, 1.2, 1.1],
    oreStrikes: 6,
    // The stagger after a strike, ms: the widget obeys these and the server re-checks them, so a
    // report cannot pack more strikes into the round than a hand could throw
    hitCooldownMs: 250,
    missStaggerMs: 600,
    // How much later than the round length a report may still arrive: the packet out, the widget's
    // mount in the browser, and the report back. Every verdict logs its measured lag ("lag=") —
    // read a playtest's worth out of server.log before tightening this.
    lagGraceMs: 2500,
    // A report may never claim more time on the widget's clock than the server has watched pass.
    // Both clocks are monotonic (QPC), so only crystal drift between the two machines (200 ppm over
    // a 30 s round is 6 ms) and the widget's 1 ms quantisation can make the difference negative.
    clockSlackMs: 50,
    // Client-judged rounds (Jake, 2026-09-30: the server-side judging failed rounds on latency). true: the widget's own
    // verdict stands and nothing measured on the server clock can refuse it; the server keeps only what latency cannot
    // fail - the nonce, one report per round, the worker still at the node, the widget's own strike times replaying to
    // its verdict (stagger, bands, no faster than the round allows), rests and yields. lagGraceMs and clockSlackMs then
    // only flag. false: rollback to server judging exactly as before.
    clientJudged: true,
    // A round nobody reports is cleaned up this long after its length: minutes, never a latency budget
    roundTimeoutMs: 180000,
    // How long past the round's length the node stays reserved for its worker; a soft lock, the shared rest decides pay
    reserveSlackMs: 10000,
    // The worker must still be this close to the node when the report lands (activation reach is 6.5 m); 0 = off
    nearMeters: 15,
    // Logged, never refused: a report this far behind the server's clock (slow motion, or a very bad connection)
    slowFlagMs: 5000,
    // A claimed win whose own strike times do not replay to a win (our bug or a modified widget; latency cannot cause
    // it): 'log' lets it stand if it is no faster than the round's exact minimum, with a LABOUR-MISMATCH audit line;
    // 'refuse' refuses it. 'log' for the first week of the new client, then Jake decides (DESIGN.md section 12, item 1).
    replayCheck: 'log',
    // Salt 4 (was 2): a cook needs a lot of it, and Bruma's deposits are few (groundedpasta, 2026-09-29; Nate: more yield).
    // Iron 5 (was 3) and corundum 3 (was 2): more iron (Nate, 4 Oct). The config's labour block is merged shallowly, so a
    // config oreYieldByOre would replace this whole map: the defaults are changed here.
    // Meteoric iron 2, as orichalcum and moonstone (Nate, 4 Oct: three Bleak-Frost Mine veins; see oreByRef)
    oreYieldByOre: { copper: 3, tin: 3, iron: 5, corundum: 3, silver: 2, quicksilver: 2, orichalcum: 2, moonstone: 2, gold: 1, ebony: 1, malachite: 1, stalhrim: 1, salt: 4, meteoriciron: 2 },
    // A placed vein that gives another ore than its base says, keyed by the reference's desc (never the base: the same
    // MineOreIron04 is placed all over Cyrodiil). No vein activator for meteoric iron exists in the load order, so three
    // iron veins of the Bleak-Frost Mine (CYRBleakFrostMine01, DLE v13), the three furthest from its door by the cell's
    // navmesh, give Meteoric Iron Ore instead (Nate, 4 Oct). They still look like iron veins; a new look is a plugin edit.
    oreByRef: {
      '178031:DragonBreak Online Edits.esp': 'meteoriciron',   // MineOreIron04, the lowest gallery, 7,398 units walked
      '17808d:DragonBreak Online Edits.esp': 'meteoriciron',   // MineOreIron04, the far end of the lowest gallery, 7,391
      '178026:DragonBreak Online Edits.esp': 'meteoriciron',   // MineOreIron04, beside the first, 7,295
    },
    // How long a won seam rests for everyone, by ore, where it differs from veinRestMinutes: meteoric iron is the rarest
    // seam in Bruma, three veins in the province
    veinRestByOre: { meteoriciron: 60 },
    // Sea Salt Deposits (Saltdeposits.esp, copied into DragonBreak.esp) and the geodes of Whistling Mine: the Miner tier (0 based)
    // that opens them, the chance of a rarer salt with the salt, and the cells whose geodes give soul gems
    extraOreTier: { salt: 0, geode: 1, amethyst: 1, topaz: 1, ruby: 2, sapphire: 2, emerald: 3, diamond: 4 },
    // Every other geode gives the gem it is named for (the CYR ones name it in their MineOreScript Ore property)
    gemOre: { amethyst: '63b46:Skyrim.esm', topaz: '602427:BSAssets.esm', ruby: '63b42:Skyrim.esm', sapphire: '63b44:Skyrim.esm', emerald: '63b43:Skyrim.esm', diamond: '63b47:Skyrim.esm' },
    saltBonusChance: 0.1,
    saltBonus: { '3ad5f:Skyrim.esm': 5, '3ad5e:Skyrim.esm': 4, '3ad60:Skyrim.esm': 1 },
    // Empty soul gems by weight; never black
    geodeGems: { '2e4e2:Skyrim.esm': 40, '2e4e4:Skyrim.esm': 30, '2e4e6:Skyrim.esm': 18, '2e4f4:Skyrim.esm': 9, '2e4fc:Skyrim.esm': 3 },
    firewoodByTier: [3, 4, 5, 6, 8],
    charcoalByTier: [1, 2, 3, 4, 5],
    veinRestMinutes: 30,   // 45 until 4 Oct (Nate: more iron); gamemode-config sets it too
    // A Sea Salt Deposit glows while it has salt for you (GroundedPasta, 30 Sep: "Finally found salt, they are very
    // small, very hard to see"). audience: 'miners' (Miner taken up, at extraOreTier.salt or above) or 'everyone'
    saltGlow: { enabled: true, audience: 'miners', seconds: 30 },
    blockRestMinutes: 10,
    failRestMinutes: 2,
  }, cfg.labour || {});
  // "Read the stone" (Nate, 4 Oct): a UI that names MG.PICK_CAP gets a round with no timing (minigames.js). Each blow shows
  // spotsByTier spots, one with the clearest cue; slipsByTier wasted blows are allowed, one more ends the round; seconds
  // bounds the whole round so an idle one ends. Strikes, rests and yields are the timing round's. enabled false: every
  // client gets the timing round.
  const PICK = MG.pickCfg(CFG, { slipsByTier: [2, 3, 3, 4, 4] });
  const pickFor = (a) => PICK.enabled !== false && typeof hasUiCap === 'function' && hasUiCap(a, MG.PICK_CAP);

  // Raw ore and firewood by name; every id is "<local form id>:<plugin>" like the rest of our data
  const ITEMS = Object.assign({
    iron: '71cf3:Skyrim.esm',
    corundum: '5acdb:Skyrim.esm',
    ebony: '5acdc:Skyrim.esm',
    orichalcum: '5acdd:Skyrim.esm',
    gold: '5acde:Skyrim.esm',
    silver: '5acdf:Skyrim.esm',
    moonstone: '5ace0:Skyrim.esm',
    malachite: '5ace1:Skyrim.esm',
    quicksilver: '5ace2:Skyrim.esm',
    stalhrim: '2b06b:Dragonborn.esm',
    copper: '601c50:BSAssets.esm',
    meteoriciron: '601c92:BSAssets.esm',   // BSKOreMeteoricIron; smelted 2:1 into BSKIngotMeteoricIron at any smelter
    tin: '601c4f:BSAssets.esm',
    salt: '34cdf:Skyrim.esm',
    firewood: '6f993:Skyrim.esm',
    charcoal: '33760:Skyrim.esm',
  }, CFG.gemOre || {}, CFG.items || {});

  const MINER = (skills.skills || []).find((k) => k.id === 'miner') || {};
  const WOODCUTTER = (skills.skills || []).find((k) => k.id === 'woodcutter') || {};

  // Rounds and spent nonces outlive a gamemode reload, or every save would strand a round in flight
  const sessions = globalThis.__dboLabourRounds || (globalThis.__dboLabourRounds = new Map()); // actorId -> round
  const spent = globalThis.__dboLabourSpent || (globalThis.__dboLabourSpent = new Map()); // nonce -> when judged
  const denied = new Map();

  // The round clock is monotonic: Date.now() can be stepped by the time service mid-round
  const nowMs = () => performance.now();

  const idOf = (desc) => { try { return mp.getIdFromDesc(String(desc)) >>> 0; } catch (e) { return 0; } };
  const baseRecord = (targetId) => {
    try { return mp.lookupEspmRecordById(idOf(mp.get(targetId, 'baseDesc'))); } catch (e) { return null; }
  };
  const masteryOf = (a) => { try { const r = mp.get(a, 'private.mastery'); return r && typeof r === 'object' ? r : null; } catch (e) { return null; } };
  // -1 when the player does not hold the skill at all, otherwise the rank as a 0 based tier
  const tierOf = (a, skillId) => {
    const r = masteryOf(a);
    if (!r || !Array.isArray(r.order) || !r.order.includes(skillId)) return -1;
    const p = r.skills && r.skills[skillId];
    return p ? Math.max(0, Number(p.rank) || 0) : 0;
  };
  const isPlayer = (a) => { try { return Number(mp.get(a, 'profileId')) >= 0; } catch (e) { return false; } };
  // Every pickaxe marker in the load order: Skyrim's, MS02's and Dragonborn's Stalhrim ones (Floor, Wall, Table)
  const MINING_MARKER = /^(MS02|DLC2)?PickaxeMining(Floor|Wall|Table)Marker/i;
  const restsOf = (a, prop) => { try { const r = mp.get(a, prop); return r && typeof r === 'object' ? r : {}; } catch (e) { return {}; } };
  const saveRests = (a, prop, rests) => {
    for (const k of Object.keys(rests)) if (Number(rests[k]) < Date.now()) delete rests[k];
    try { mp.set(a, prop, rests); } catch (e) { log('labour rest save failed', e.message); }
  };
  // A worked seam or block rests for everyone, not only for the worker: the rest was kept per character, so every
  // character could work the same seam (salt and soul-gem geodes included) each 45 minutes (loot review, 2026-09-29).
  // Kept on the reference, which survives restarts; only a won round sets it.
  const SHARED_REST = 'private.dboWorkedUntil';
  // Nate, 7 Oct: while the alpha is only Bruma, the everyday nodes rest per player (no race for the one mine); rare ores
  // and geodes keep the shared rest and the one-worker lock of 29 Sep. Swap back to shared when Skyrim opens.
  // labour.perPlayerNodes: false turns it off; labour.perPlayerOres: the ores ('wood' = chopping blocks) it covers
  const perPlayer = (ore) => CFG.perPlayerNodes !== false && (CFG.perPlayerOres || ['wood', 'iron', 'copper', 'tin', 'corundum', 'salt']).includes(String(ore || ''));
  const sharedRest = (ref, ore) => { if (perPlayer(ore)) return 0; try { return Number(mp.get(ref, SHARED_REST)) || 0; } catch (e) { return 0; } };
  // One worker per seam or block at a time: the shared rest is set only when a round is won, so two workers who
  // started together were both paid (economy review, 2026-09-29). ref -> { a, until }
  const working = globalThis.__dboLabourWorking instanceof Map ? globalThis.__dboLabourWorking : (globalThis.__dboLabourWorking = new Map());
  const workedByOther = (ref, a, ore) => { if (perPlayer(ore)) return false; const w = working.get(ref); return !!w && w.a !== a && w.until > Date.now() && sessions.has(w.a); };
  const reserve = (ref, a, round) => {
    working.set(ref, { a, until: Date.now() + (Number(round.totalMs) || 60000) + Math.max(Number(CFG.lagGraceMs) || 0, Number(CFG.reserveSlackMs) || 0) });
    if (working.size > 2000) for (const [k, w] of working) if (w.until <= Date.now()) working.delete(k);
  };
  const deny = (a, text) => {
    if (Date.now() - (denied.get(a) || 0) > 1500) { denied.set(a, Date.now()); personal(a, text); }
    return true;
  };
  const titleCase = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  // The name a player reads for an ore key: "meteoriciron" is "Meteoric Iron", the rest are one word
  const ORE_NAMES = { meteoriciron: 'Meteoric Iron' };
  const oreName = (ore) => ORE_NAMES[ore] || titleCase(ore);
  // oreByRef resolved to the server's form ids (the load order decides the plugin's index), once per load
  const REF_ORE = (() => {
    const m = new Map();
    for (const [desc, ore] of Object.entries(CFG.oreByRef || {})) {
      const id = idOf(desc);
      if (id && typeof ore === 'string' && ore) m.set(id, ore.toLowerCase());
      else log(`labour: oreByRef ${desc} did not resolve, left as its base`);
    }
    return m;
  })();

  // "MineOreQuicksilver02_LTundraRocks" and "CYRMineOreCopper01_Rocks01" both give "quicksilver" / "copper"
  const oreOf = (edid) => {
    const m = /^(?:CYR)?MineOre([A-Za-z]+?)\d/.exec(edid) || /^DLC2MineOre([A-Za-z]+?)\d/.exec(edid);
    if (!m) return '';
    // The vanilla Geode Veins (Whistling Mine, Blackreach) are MineOreBlackreach*: soul gems, not ore
    const ore = m[1].toLowerCase();
    return ore === 'blackreach' ? 'geode' : ore;
  };

  // A Sea Salt Deposit and a Beyond Skyrim gem geode are worked like a seam
  const nodeOf = (targetId, edid) => {
    if (/SeaSalt/i.test(edid)) return 'salt';
    if (!/^(?:CYR|BSK)MineGem/i.test(edid)) return '';
    const gem = (/MineGem([A-Za-z]+?)\d/i.exec(edid) || [])[1];
    return gem && (CFG.gemOre || {})[gem.toLowerCase()] ? gem.toLowerCase() : '';
  };
  const weighted = (table) => {
    const entries = Object.entries(table || {}).filter(([, w]) => Number(w) > 0);
    let roll = Math.random() * entries.reduce((n, [, w]) => n + Number(w), 0);
    for (const [d, w] of entries) { roll -= Number(w); if (roll <= 0) return d; }
    return entries.length ? entries[entries.length - 1][0] : '';
  };
  const itemName = (desc) => {
    try { const r = mp.lookupEspmRecordById(idOf(desc)); const f = r && r.record && r.record.fields && r.record.fields.find((x) => x.type === 'FULL'); if (f && typeof f.data === 'string') return f.data; } catch (e) { /* no name */ }
    return ({ '34cdf:Skyrim.esm': 'Salt Pile', '3ad5f:Skyrim.esm': 'Frost Salts', '3ad5e:Skyrim.esm': 'Fire Salts', '3ad60:Skyrim.esm': 'Void Salts',
      '2e4e2:Skyrim.esm': 'a Petty Soul Gem', '2e4e4:Skyrim.esm': 'a Lesser Soul Gem', '2e4e6:Skyrim.esm': 'a Common Soul Gem', '2e4f4:Skyrim.esm': 'a Greater Soul Gem', '2e4fc:Skyrim.esm': 'a Grand Soul Gem' })[desc] || 'something';
  };

  // Ores the tier may work, counting every tier below it
  const oresUpTo = (tier) => {
    const byTier = MINER.oreByTier || [];
    const out = [];
    for (let i = 0; i <= Math.min(tier, byTier.length - 1); i++) for (const ore of byTier[i] || []) out.push(String(ore).toLowerCase());
    for (const [ore, t] of Object.entries(CFG.extraOreTier || {})) if (Number(t) <= tier) out.push(ore);
    return out;
  };

  // The band an ore sits in, 0..4: the tier that first lists it. This is the `value` the point system
  // weighs a mining round by (skillPoints.weightOf, "ore band 0..4" — 1.0 units for copper, 2.0 for
  // ebony). An ore absent from oreByTier cannot be mined at all (oresUpTo refuses it), so the 0 here
  // is only a floor.
  const oreBand = (ore) => {
    if ((CFG.extraOreTier || {})[ore] !== undefined) return Number(CFG.extraOreTier[ore]) || 0;
    const byTier = MINER.oreByTier || [];
    for (let i = 0; i < byTier.length; i++) {
      if ((byTier[i] || []).some((o) => String(o).toLowerCase() === ore)) return i;
    }
    return 0;
  };

  const tierValue = (list, tier, fallback) => {
    const arr = Array.isArray(list) ? list : [];
    const v = Number(arr[Math.min(Math.max(tier, 0), arr.length - 1)]);
    return Number.isFinite(v) ? v : fallback;
  };

  // mulberry32: the band centres come from the round's seed, so a seed out of the log rebuilds the
  // exact round that was played.
  const rngOf = (seed) => {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = Math.imul(s ^ (s >>> 15), s | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  // Where the marker sits on the bar (0..100) at ms into the round. The widget runs this same
  // arithmetic on the same integer ms, so the two verdicts are the same double. Keep them in step.
  const markerAt = (ms, sweepMs) => {
    const phase = (ms % (sweepMs * 2)) / sweepMs;
    return phase <= 1 ? phase * 100 : (2 - phase) * 100;
  };

  // The earliest this round can be won on the widget's own clock: the first millisecond each band can be struck once
  // the stagger after the last hit has passed. No honest widget reports a win sooner, whatever the network did. Logged
  // with every verdict; real players have come within 1% of it (server.log, 54 wins to 1 Oct), so it is a floor, not a
  // humanity margin.
  const minMsOf = (round) => {
    let ready = 0, t = 0;
    for (const b of round.bands) {
      t = ready;
      while (t <= round.totalMs && Math.abs(markerAt(t, round.sweepMs) - b) > round.half) t++;
      if (t > round.totalMs) return round.totalMs + 1;
      ready = t + round.hitMs;
    }
    return t;
  };
  const clientJudged = () => MG.clientJudged(CFG);
  // How long a round may stay unreported before it is dead: the round plus minutes when the widget judges, the round
  // plus the transport grace when the server does (rollback)
  const limitMs = (r) => r.totalMs + (clientJudged() ? Math.max(60000, Number(CFG.roundTimeoutMs) || 180000) : CFG.lagGraceMs);

  const roundFor = (a, kind, tier, strikes, title, refId) => {
    const seed = crypto.randomBytes(4).readUInt32LE(0);
    const rand = rngOf(seed);
    // Clamp here, exactly as the widget used to, so the value the server judges with is the value
    // the widget draws with
    const half = Math.max(3, Math.min(30, tierValue(CFG.bandByTier, tier, 8)));
    const bands = [];
    for (let i = 0; i < strikes; i++) bands.push(Math.round((half + rand() * (100 - 2 * half)) * 100) / 100);
    const round = {
      nonce: `${a.toString(16)}-${Date.now().toString(36)}-${crypto.randomBytes(4).readUInt32LE(0).toString(36)}`,
      kind, tier, strikes, title, refId, seed, half, bands,
      sweepMs: Math.max(400, Math.round(tierValue(CFG.sweepByTier, tier, 1.4) * 1000)),
      totalMs: Math.max(1000, Math.round((Number(CFG.seconds) || 30) * 1000)),
      hitMs: Math.max(0, Math.round(Number(CFG.hitCooldownMs) || 250)),
      missMs: Math.max(0, Math.round(Number(CFG.missStaggerMs) || 600)),
      startedAt: 0,
    };
    if (pickFor(a)) {
      // The same seed, then the blows: a seed out of the log rebuilds the pick round as well
      const slips = Math.max(0, Math.round(MG.byTier(PICK.slipsByTier, tier, 3)));
      const p = MG.pickSteps(rand, strikes + slips, MG.byTier(PICK.spotsByTier, tier, 4), MG.byTier(PICK.cueByTier, tier, 0.7), MG.byTier(PICK.decoyByTier, tier, 0.35), 'face');
      Object.assign(round, { mode: 'pick', slips, steps: p.steps, right: p.right, totalMs: Math.max(10000, Math.round((Number(PICK.seconds) || 90) * 1000)), minPickMs: Math.max(0, Number(PICK.minPickMs) || 0) });
      round.minMs = MG.pickMinMs(strikes, round.minPickMs);
      return round;
    }
    round.minMs = minMsOf(round);
    return round;
  };

  // Everything the widget needs to draw the server's round, and nothing it could use to judge it
  const packetFor = (round, result, resultKind) => {
    if (round.mode === 'pick') {
      const p = {
        type: 'labour', id: WIDGET_ID, nonce: round.nonce, kind: round.kind, title: round.title, mode: 'pick',
        strikes: round.strikes, slips: round.slips, steps: round.steps, totalMs: round.totalMs, minPickMs: round.minPickMs,
        judge: clientJudged() ? 'client' : 'server',
      };
      if (result) { p.result = result; p.resultKind = resultKind; }
      return p;
    }
    const w = {
      type: 'labour', id: WIDGET_ID, nonce: round.nonce, kind: round.kind, title: round.title,
      strikes: round.strikes, band: round.half, bands: round.bands,
      sweepMs: round.sweepMs, totalMs: round.totalMs, hitMs: round.hitMs, missMs: round.missMs,
      // The widget shows its own verdict at once when it is the judge; an older widget ignores the field
      judge: clientJudged() ? 'client' : 'server',
    };
    if (result) { w.result = result; w.resultKind = resultKind; }
    return w;
  };

  const startRound = (a, round) => {
    sessions.set(a, round);
    round.startedAt = nowMs();
    // Every round issued is logged, so a round that never comes back (cancelled, hidden, lost) can be counted
    log(`labour issue ${display(a)} ${round.kind}${round.ore ? '/' + round.ore : ''} t${round.tier + 1} strikes=${round.strikes}${round.mode === 'pick' ? ` pick slips=${round.slips} spots=${round.steps[0].length}` : ''} min=${round.minMs} judge=${clientJudged() ? 'client' : 'server'} seed=${round.seed.toString(16)}`);
    if (!openWidget(a, packetFor(round), true)) sessions.delete(a);
    return true;
  };

  // A round whose report never came back (a crash, a lost packet, a closed browser) must not lock
  // the player out of the seam for ever, so anything past limitMs is dead.
  const liveRound = (a) => {
    const r = sessions.get(a);
    if (!r) return null;
    if (nowMs() - r.startedAt <= limitMs(r)) return r;
    sessions.delete(a);
    log(`labour expired ${display(a)} ${r.kind} after ${Math.round(nowMs() - r.startedAt)} ms, no report`);
    return null;
  };
  // Activating again while a round is live: with minutes before it expires, the widget may be gone (a browser reload, a
  // panel crash), so once the round's own length has passed the same round is drawn again instead of the activation
  // vanishing. Same nonce and bands; a widget still showing it keeps its state (it resets only on a new nonce).
  const reshow = (a, round) => {
    if (clientJudged() && nowMs() - round.startedAt > round.totalMs) openWidget(a, packetFor(round), true);
    return true;
  };

  const mine = (targetId, casterId, rec) => {
    const own = oreOf(String(rec.record.editorId || '')) || nodeOf(targetId, String(rec.record.editorId || ''));
    if (!own) return false;
    const ore = REF_ORE.get(targetId >>> 0) || own;
    const tier = tierOf(casterId, 'miner');
    // Not a miner yet: fall through rather than deny, so masterySystem's activation gate can grant
    // first touch (SKILLS_DESIGN 5.3). deny() returns true, which makes gamemode.js:638 stop the
    // activate chain before that gate ever runs - the skill could then never be opened at all.
    if (tier < 0) return false;
    { const live = liveRound(casterId); if (live) return reshow(casterId, live); }
    if (ore !== 'geode' && !ITEMS[ore]) return deny(casterId, 'You do not know what to do with this seam.');
    if (oresUpTo(tier).indexOf(ore) === -1) return deny(casterId, `${oreName(ore)} is beyond your skill. Work the seams you know first.`);
    const rests = restsOf(casterId, 'private.minedVeins');
    const until = Math.max(Number(rests[targetId.toString(16)]) || 0, sharedRest(targetId, ore));
    if (until > Date.now()) return deny(casterId, `This seam is worked out for now. Come back in ${Math.ceil((until - Date.now()) / 60000)} minutes.`);
    if (workedByOther(targetId, casterId, ore)) return deny(casterId, 'Someone is working this seam. Wait for them to finish.');
    const round = roundFor(casterId, 'mining', tier, Math.max(1, Number(CFG.oreStrikes) || 6), ore === 'salt' ? 'Sea Salt Deposit' : ore === 'geode' || (CFG.gemOre || {})[ore] ? 'Geode' : `${oreName(ore)} Seam`, targetId);
    round.ore = ore;
    const started = startRound(casterId, round);
    reserve(targetId, casterId, round);
    if (ore === 'salt') saltRefresh(targetId);
    return started;
  };

  const chop = (targetId, casterId) => {
    const tier = tierOf(casterId, 'woodcutter');
    if (tier < 0) return false;   // same first-touch fall-through as mine()
    { const live = liveRound(casterId); if (live) return reshow(casterId, live); }
    const rests = restsOf(casterId, 'private.choppedBlocks');
    const until = Math.max(Number(rests[targetId.toString(16)]) || 0, sharedRest(targetId, 'wood'));
    if (until > Date.now()) return deny(casterId, `You have split all the logs here. Come back in ${Math.ceil((until - Date.now()) / 60000)} minutes.`);
    if (workedByOther(targetId, casterId, 'wood')) return deny(casterId, 'Someone is splitting logs here. Wait for them to finish.');
    const strikes = Math.max(1, Math.round(tierValue(WOODCUTTER.chopStrikesByTier, tier, 4)));
    const round = roundFor(casterId, 'chopping', tier, strikes, 'Chopping Block', targetId);
    const started = startRound(casterId, round);
    reserve(targetId, casterId, round);
    return started;
  };

  // Called from the gamemode's activate chain; true means the activation was ours
  globalThis.__dboLabour = (targetId, casterId) => {
    if (!CFG.enabled || targetId >= 0xff000000) return false;
    const rec = baseRecord(targetId);
    if (!rec || !rec.record) return false;
    const type = String(rec.record.type || '');
    const edid = String(rec.record.editorId || '');
    if (type === 'ACTI' && (/^(CYR)?MineOre|^DLC2MineOre/.test(edid) || nodeOf(targetId, edid))) return mine(targetId, casterId, rec);
    if (type === 'FURN' && /^(DLC2)?WoodChoppingBlock/i.test(edid)) return chop(targetId, casterId);
    // A seam's pickaxe marker pays out through the vanilla mining script: no round, no skill, no rest (Nate on Falcius,
    // 2026-09-28: refused at a gold seam, then mined it from its PickaxeMiningFloorMarker). The round on the seam
    // replaces it, so a player never sits at one; NPCs keep them for their idles.
    if (type === 'FURN' && MINING_MARKER.test(edid) && isPlayer(casterId)) return deny(casterId, 'Strike the seam itself to mine it.');
    return false;
  };

  const writeRest = (a, round, restMinutes) => {
    const prop = round.kind === 'mining' ? 'private.minedVeins' : 'private.choppedBlocks';
    const rests = restsOf(a, prop);
    rests[round.refId.toString(16)] = Date.now() + restMinutes * 60000;
    saveRests(a, prop, rests);
  };
  // A won seam's rest: its ore's own (veinRestByOre) or every seam's
  const winRestOf = (round) => {
    if (round.kind !== 'mining') return CFG.blockRestMinutes;
    const own = Number((CFG.veinRestByOre || {})[round.ore]);
    return own > 0 ? own : CFG.veinRestMinutes;
  };
  const finish = (a, round, win, text, kind, rest) => {
    if (rest !== false) writeRest(a, round, win ? winRestOf(round) : CFG.failRestMinutes);
    if (win && rest !== false) {
      const minutes = winRestOf(round);
      if (!perPlayer(round.kind === 'mining' ? round.ore : 'wood')) { try { mp.set(round.refId, SHARED_REST, Date.now() + minutes * 60000); } catch (e) { log('labour shared rest save failed', e.message); } }
    }
    // A round walked away from before its report landed (see closing below) has no widget left to show the verdict in
    if (sessions.get(a) === round) { openWidget(a, packetFor(round, text, kind), false); sessions.delete(a); } else personal(a, text);
    if (round.ore === 'salt') { try { saltRefresh(round.refId); } catch (e) { log('salt glow failed', e.message); } }
    // Remembered only so a repeat of the same report is logged as a replay instead of vanishing
    spent.set(round.nonce, Date.now());
    while (spent.size > 200) spent.delete(spent.keys().next().value);
  };

  // A round walked away from rests like a failed one: cancelling cost nothing, so a worker could look at the bands
  // and cancel until an easy set came up (loot review, 2026-09-29)
  // Client -> server packets are RELIABLE but not ordered (skymp5-server/cpp/mp_common/Networking.cpp:91), so a Walk away
  // or an Escape sent just after the report can overtake it when a packet is lost and resent. A round walked away from
  // is kept by nonce until its timeout: a report that turns up after the cancel is still judged, and a win pays and
  // replaces the fail rest with the full one. Client-judged only; the rollback drops it as before.
  const closing = globalThis.__dboLabourClosing instanceof Map ? globalThis.__dboLabourClosing : (globalThis.__dboLabourClosing = new Map()); // nonce -> { a, round }
  const keepClosing = (a, round) => {
    if (!clientJudged()) return;
    for (const [n, c] of closing) if (nowMs() - c.round.startedAt > limitMs(c.round)) closing.delete(n);
    // Where the worker was when the close arrived: they leave after the verdict, so this is never further than when the
    // report was sent, and it still counts if a load door has since taken them to another cell (review LAT-1)
    try { if (typeof distanceMeters === 'function') round.closeNear = distanceMeters(a, round.refId); } catch (e) { /* unknown */ }
    closing.set(round.nonce, { a, round });
    while (closing.size > 500) closing.delete(closing.keys().next().value);
  };
  const abandon = (a, why) => {
    const round = sessions.get(a);
    if (round) {
      writeRest(a, round, CFG.failRestMinutes);
      log(`labour abandon(${why || 'cancel'}) ${display(a)} ${round.kind} after ${Math.round(nowMs() - round.startedAt)} ms`);
      keepClosing(a, round);
    }
    sessions.delete(a);
    if (round && round.ore === 'salt') saltRefresh(round.refId);
  };
  onUi('labourCancel', (a) => { abandon(a, 'cancel'); closeWidget(a, WIDGET_ID); });
  // F2 hides the interface by closing the focused widget (client closeFocused sends args ['hidden']): not walking away,
  // so the round ends with no rest and the seam opens again at once
  onUi('close', (a, args, widgetId) => {
    if (widgetId !== WIDGET_ID) return;
    if (!(Array.isArray(args) && args[0] === 'hidden')) return abandon(a, 'close:' + String(Array.isArray(args) ? args[0] : '').slice(0, 16));
    const round = sessions.get(a);
    sessions.delete(a);
    if (round) { log(`labour abandon(hidden) ${display(a)} ${round.kind} after ${Math.round(nowMs() - round.startedAt)} ms, no rest`); keepClosing(a, round); }
    if (round && round.ore === 'salt') saltRefresh(round.refId);   // the seam is free again: light it for the others
  });
  // A logout ends the round like walking away (gamemode.js disconnect handler, the __dbo*Leave list)
  globalThis.__dboLabourLeave = (a) => { if (sessions.has(a)) abandon(a, 'logout'); };

  // Replay the round against the report. The widget sends the millisecond of every strike it took,
  // hit or miss; the hits are counted here, from the sweep and the band list the server issued.
  const judge = (round, raw, at, elapsed) => {
    const r = { hits: 0, count: 0, last: 0, at, lag: Math.round(elapsed - at), err: 0, bad: '', sus: [] };
    let list = null;
    if (Array.isArray(raw)) list = raw;
    else if (typeof raw === 'string' && raw.length <= 2048) { try { list = JSON.parse(raw); } catch (e) { list = null; } }
    if (!Array.isArray(list)) { r.bad = 'malformed'; return r; }
    // One strike per cooldown is the most an honest widget can record in the round
    if (list.length > Math.floor(round.totalMs / Math.max(1, round.hitMs)) + 2) { r.bad = 'flood'; return r; }
    r.count = list.length;
    let ready = 0;
    for (const v of list) {
      const t = Number(v);
      if (!Number.isInteger(t) || t < 0 || t > round.totalMs) { r.bad = 'range'; break; }
      // The cooldown also orders the list: ready is always past the strike before this one
      if (t < ready) { r.bad = 'cooldown'; break; }
      if (r.hits >= round.strikes) { r.bad = 'extra'; break; } // the widget submits on the last hit
      const d = Math.abs(markerAt(t, round.sweepMs) - round.bands[r.hits]);
      const landed = d <= round.half;
      ready = t + (landed ? round.hitMs : round.missMs);
      if (landed) { r.err += d / round.half; r.hits++; }
      r.last = t;
    }
    if (r.hits) r.err /= r.hits;
    if (r.bad) return r;
    if (r.hits >= 3 && r.err < 0.05) r.sus.push('precise');   // every hit on the centre line: flagged, never refused
    if (r.last > at) { r.bad = 'submit'; return r; }        // a strike after the report went out
    if (clientJudged()) {
      // The widget judges: nothing measured on the server's clock refuses a round. What it shows is kept for review -
      // a report that outran the server's clock, or one far behind it (a sweep played in slow motion, or a bad line).
      r.sus.push(...MG.lagFlags(r.lag, CFG.clockSlackMs, CFG.slowFlagMs));
      return r;
    }
    // Rollback (clientJudged false): the server's clock binds the widget's as before
    if (r.lag < -CFG.clockSlackMs) r.bad = 'future';   // more time on its clock than the server watched pass
    // The widget's clock may only sit behind the server's by the transport: the packet out, the
    // mount, the report back. Further behind means the round was drawn out in real time and the
    // times scaled back down — a sweep played in slow motion is the one cheat the band check alone
    // would not see. It also expires a report that turns up minutes after its round.
    else if (r.lag > CFG.lagGraceMs) r.bad = 'late';
    return r;
  };

  // A pick round's report: '[[index, ms], ...]', replayed against the blows the server rolled (minigames.js judgePicks).
  // The same fields as judge() so the verdict below reads both; misses past the allowance end the round as a loss.
  const judgePick = (round, raw, at, elapsed) => {
    const p = MG.judgePicks(raw, { need: round.strikes, allowed: round.slips, steps: round.steps, right: round.right, totalMs: round.totalMs, minPickMs: round.minPickMs });
    const r = { hits: p.hits, misses: p.misses, count: p.count, last: p.last, at, lag: Math.round(elapsed - at), err: 0, bad: p.bad, sus: p.sus };
    if (r.bad) return r;
    if (r.last > at) { r.bad = 'submit'; return r; }
    if (clientJudged()) { r.sus.push(...MG.lagFlags(r.lag, CFG.clockSlackMs, CFG.slowFlagMs)); return r; }
    // Rollback: the server's clock binds the widget's as for the timing round
    if (r.lag < -CFG.clockSlackMs) r.bad = 'future';
    else if (r.lag > CFG.lagGraceMs) r.bad = 'late';
    return r;
  };

  // The new widget's own verdict, args[3]: '{"v":1,"win":true,"hits":6}' (MG.verdictOf: at most 256 characters, with v).
  // A 0.3.71 widget sends none and is judged from its strike times as before, with the server-clock limits relaxed to
  // the round timeout. Anything unreadable is an old widget, never a refusal.
  const claimOf = (raw) => {
    const c = MG.verdictOf(raw);
    return c && typeof c.win === 'boolean' ? { win: c.win, hits: Math.max(0, Math.floor(Number(c.hits) || 0)) } : null;
  };
  const ignored = MG.limiter(5000);
  onUi('labour', (a, args) => {
    const nonce = String(args[0]);
    let round = sessions.get(a);
    let closed = false;
    if (!round || nonce !== round.nonce) {
      const c = closing.get(nonce);
      if (c && c.a === a && nowMs() - c.round.startedAt <= limitMs(c.round)) { round = c.round; closed = true; }
      else {
        // A spent nonce is a replay, logged as before. Another player's nonce, or one for a round that is gone: nothing is
        // judged, and at most one line per player in 5 s says so
        if (spent.has(nonce)) log(`labour replay ${display(a)}: ${nonce.slice(0, 40)} was already judged`);
        else if (ignored(a, nowMs())) log(`labour ignored ${display(a)}: ${round ? 'another round is live' : 'no round'} for ${nonce.slice(0, 40)}`);
        return;
      }
    }
    closing.delete(nonce);
    const elapsed = nowMs() - round.startedAt;
    // An interface from before the round was server-issued reports a hit count and nothing else
    if (typeof args[1] === 'number' || /^\s*\d+\s*$/.test(String(args[1]))) {
      log(`labour stale-ui ${display(a)} ${round.kind}: a hit count, no strike times`);
      return finish(a, round, false, 'Your interface is out of date. Rejoin the server to pick up the new one.', 'lose', false);
    }
    const at = Math.max(0, Math.floor(Number(args[2]) || 0));
    const v = round.mode === 'pick' ? judgePick(round, args[1], at, elapsed) : judge(round, args[1], at, elapsed);
    const cj = clientJudged();
    const claim = cj ? claimOf(args[3]) : null;
    const replayWin = !v.bad && v.hits >= round.strikes && !(round.mode === 'pick' && v.misses > round.slips);
    // Only a cleanup bound, minutes past the round: a report this late belongs to a round already given up on
    if (!v.bad && cj && elapsed > limitMs(round)) v.bad = 'expired';
    // Still at the node: the server's last streamed position, against a radius twice the activation reach, plus what the
    // report's own lag lets a worker who left after the verdict cover (MG.lagReach), or where they were when their
    // close arrived. Neither depends on the connection: walking off before the verdict is still refused.
    let near = cj && Number(CFG.nearMeters) > 0 && typeof distanceMeters === 'function' ? distanceMeters(a, round.refId) : undefined;
    if (near !== undefined && closed && Number(round.closeNear) < near) near = Number(round.closeNear);
    if (!v.bad && near !== undefined && !(near <= Number(CFG.nearMeters) + MG.lagReach(elapsed - at))) v.bad = 'far';
    let win = !v.bad && replayWin;
    if (!v.bad && claim) {
      if (claim.win !== replayWin || claim.hits !== v.hits) v.sus.push('mismatch');
      if (!claim.win) win = false;                              // the widget's own loss stands
      else if (!replayWin) {
        // A claimed win its own strike times do not bear out: a forged report, or the widget and this file out of step.
        // replayCheck 'log' (the default) lets it stand if it is no faster than the round allows; 'refuse' refuses it.
        audit(`LABOUR-MISMATCH ${who(a)} ${round.kind} widget=win/${claim.hits} replay=${v.hits}/${round.strikes} seed=${round.seed.toString(16)}`);
        if (MG.replayRefuses(CFG)) v.bad = 'mismatch';
        else if (at < round.minMs) v.bad = 'fast';
        else win = true;
      }
    }
    // Humanly possible: no win sooner than the round's exact fastest, on the server's clock counted from when the round
    // was SENT (lag only adds to it, so no connection fails this). The widget's own clock is held to it by the replay.
    if (cj && win && MG.serverTooSoon(elapsed, round.minMs, CFG.clockSlackMs)) { v.bad = 'fast'; win = false; }
    // One line per verdict: hits of strikes taken, the last strike and the report's own clock, the
    // lag between that clock and the server's, how far off centre the hits were (0 is dead centre,
    // 1 is the band's edge — a player who is always at 0.00 is not a player), and the round's seed;
    // then who judged (client: the widget's verdict; legacy: a 0.3.71 widget judged from its times; server: rollback),
    // the widget's claim, the fastest the round could be won, the distance to the node and any review flags.
    // lag= is logged on every line and never decides anything when the widget judges.
    log(`labour ${v.bad ? 'refused(' + v.bad + ')' : win ? 'win' : 'lose'} ${display(a)} ${round.kind}${round.ore ? '/' + round.ore : ''} t${round.tier + 1} ${v.hits}/${round.strikes} of ${v.count}${round.mode === 'pick' ? ` pick slips=${v.misses}/${round.slips}` : ''} last=${v.last} at=${v.at} lag=${v.lag} err=${v.err.toFixed(2)} seed=${round.seed.toString(16)}`
      + MG.tail({ judge: !cj ? 'server' : claim ? 'client' : 'legacy', min: round.minMs, near: cj ? (near === undefined ? NaN : near) : undefined, claim: cj ? (claim ? `${claim.win ? 'win' : 'lose'}/${claim.hits}` : null) : undefined, sus: v.sus.concat(closed ? ['after-close'] : []) }));

    if (!win) {
      const text = round.kind === 'mining'
        ? 'The seam holds. Your arms give out before the rock does.'
        : 'The log rolls off the block, still whole.';
      return finish(a, round, false, text, 'lose');
    }

    // Won, but someone else's win on this node came first: nothing is left to pay out
    if (sharedRest(round.refId, round.kind === 'mining' ? round.ore : 'wood') > Date.now()) {
      return finish(a, round, false, round.kind === 'mining' ? 'Someone else worked this seam out before you finished.' : 'Someone else split the last of the logs before you finished.', 'lose', false);
    }
    // A finished round is its own event kind, not a bare 'activate': 'mine' is weighed by the ore band
    // and 'chop' is flat 1.0, against 0.5 for touching a thing. Emitting 'activate' here made the ore
    // band in skillPoints.weightOf dead code and cost a Novice miner twenty separate veins.
    try {
      if (typeof globalThis.__alduinakMasteryEvent === 'function') {
        if (round.kind === 'mining') globalThis.__alduinakMasteryEvent('mine', a, { refrId: round.refId, value: oreBand(round.ore) });
        else globalThis.__alduinakMasteryEvent('chop', a, { refrId: round.refId });
      }
    } catch (e) { /* no skill system */ }

    let text = '';
    if (round.kind === 'mining') {
      const base = Number((CFG.oreYieldByOre || {})[round.ore]) || 1;
      const mult = tierValue(MINER.yieldMultiplierByTier, round.tier, 1);
      const count = round.ore === 'geode' ? 1 : Math.max(1, Math.round(base * mult));
      // A geode holds one soul gem; salt sometimes comes with a rarer salt
      const gem = round.ore === 'geode' ? weighted(CFG.geodeGems) : '';
      const bonus = round.ore === 'salt' && Math.random() < (Number(CFG.saltBonusChance) || 0) ? weighted(CFG.saltBonus) : '';
      const ok = giveItem(a, idOf(gem || ITEMS[round.ore]), count);
      if (ok && bonus) giveItem(a, idOf(bonus), 1);
      text = !ok ? 'The seam gives way, but you cannot carry any more.'
        : round.ore === 'geode' ? `The geode cracks open: ${itemName(gem)}.`
        : round.ore === 'salt' ? `You scrape out ${count} Salt Pile${count === 1 ? '' : 's'}${bonus ? ` and some ${itemName(bonus)}` : ''}.`
        : (CFG.gemOre || {})[round.ore] ? `The geode cracks open: ${count} ${titleCase(round.ore)}${count === 1 ? '' : 's'}.`
        : `The seam gives way: ${count} ${oreName(round.ore)} Ore.`;
      if (ok) audit(`MINE ${who(a)} worked a ${round.ore} seam (tier ${round.tier + 1}) -> ${count} ${gem ? itemName(gem) : 'ore'}${bonus ? ` + ${itemName(bonus)}` : ''}`);
    } else {
      const count = Math.max(1, Math.round(tierValue(CFG.firewoodByTier, round.tier, 3)));
      const ok = giveItem(a, idOf(ITEMS.firewood), count);
      // A woodcutter also burns charcoal from the offcuts, more with each tier; smelting needs it (Nate, 7 Oct)
      const coal = ok ? Math.max(0, Math.round(tierValue(CFG.charcoalByTier, round.tier, 0))) : 0;
      const coalOk = coal > 0 && giveItem(a, idOf(ITEMS.charcoal), coal);
      text = ok
        ? `Split clean: ${count} Firewood${coalOk ? ` and ${coal} Charcoal` : ''}.`
        : 'Split clean, but you cannot carry any more.';
      if (ok) audit(`CHOP ${who(a)} split logs (tier ${round.tier + 1}) -> ${count} firewood${coalOk ? `, ${coal} charcoal` : ''}`);
    }
    finish(a, round, true, text, 'win');
  });

  // ---- the salt glow -------------------------------------------------------------------------------------------------
  // A Sea Salt Deposit glows for a Miner while it has salt for them, and goes dark while the seam rests (the shared rest
  // or their own) or someone else is working it: a glow always means salt to take, as a camp chest's does (wildlife.js).
  // salt-deposits.json (tools/labour/salt_deposits.py) lists every deposit; the client lights each one when it loads
  // (dboGlowService, kind 'loot'). The whole state goes out every tick, which also restores it after the login and
  // dungeon-entry clears, and to everyone outside the audience as "off", so narrowing the audience takes effect.
  const SALT_REFS = (() => {
    try {
      const list = JSON.parse(fs.readFileSync(path.resolve('salt-deposits.json'), 'utf8')).deposits || [];
      return list.map((d) => idOf(d.ref)).filter(Boolean);
    } catch (e) { log('salt-deposits.json unreadable, no salt glow:', e.message); return []; }
  })();
  const saltCfg = () => Object.assign({ enabled: true, audience: 'miners', seconds: 30 }, CFG.saltGlow || {});
  const saltAudience = (a) => saltCfg().audience === 'everyone' || tierOf(a, 'miner') >= (Number((CFG.extraOreTier || {}).salt) || 0);
  // own: the player's rests (private.minedVeins), read once per player; shared: ref -> the shared rest, once per tick
  const saltReady = (ref, a, own, shared) => {
    const mine = Number(own[ref.toString(16)]) || 0;
    const all = shared && shared.has(ref) ? shared.get(ref) : sharedRest(ref, 'salt');
    return Math.max(mine, all) <= Date.now() && !workedByOther(ref, a, 'salt');
  };
  const saltGlow = (a, shared) => {
    if (typeof sendPacket !== 'function' || !SALT_REFS.length) return;
    const c = saltCfg();
    const show = c.enabled !== false && CFG.enabled !== false && saltAudience(a);
    const own = show ? restsOf(a, 'private.minedVeins') : {};
    const on = [], off = [];
    for (const ref of SALT_REFS) (show && saltReady(ref, a, own, shared) ? on : off).push(ref);
    try {
      if (off.length) sendPacket(a, { customPacketType: 'dboGlow', refs: off, on: false, kind: 'loot' });
      if (on.length) sendPacket(a, { customPacketType: 'dboGlow', refs: on, on: true, kind: 'loot' });
    } catch (e) { /* offline */ }
  };
  // One deposit changed (a round reserved it, a win rested it for everyone, or the worker gave up): tell everyone in the
  // audience now instead of at the next tick, so nobody walks to a glow that has just gone out (Worker G's review)
  const saltRefresh = (ref) => {
    if (typeof sendPacket !== 'function' || !SALT_REFS.includes(ref >>> 0)) return;
    const c = saltCfg();
    if (c.enabled === false || CFG.enabled === false) return;
    let online = []; try { online = typeof onlineActors === 'function' ? onlineActors() : []; } catch (e) { return; }
    for (const a of online) {
      if (!saltAudience(a)) continue;
      const on = saltReady(ref >>> 0, a, restsOf(a, 'private.minedVeins'), null);
      try { sendPacket(a, { customPacketType: 'dboGlow', refs: [ref >>> 0], on, kind: 'loot' }); } catch (e) { /* offline */ }
    }
  };
  globalThis.__dboSaltGlow = saltGlow;
  if (globalThis.__dboSaltGlowTimer) clearInterval(globalThis.__dboSaltGlowTimer);
  globalThis.__dboSaltGlowTimer = setInterval(() => {
    let online = []; try { online = typeof onlineActors === 'function' ? onlineActors() : []; } catch (e) { return; }
    const shared = new Map(SALT_REFS.map((ref) => [ref, sharedRest(ref, 'salt')]));
    for (const a of online) { try { globalThis.__dboSaltGlow(a, shared); } catch (e) { log('salt glow failed', e.message); } }
  }, Math.max(5, Number(saltCfg().seconds) || 30) * 1000);

  log(`labour ${CFG.enabled ? 'on' : 'off'}: mining ${CFG.oreStrikes} strikes, chopping ${(WOODCUTTER.chopStrikesByTier || []).join('/')} by tier, ${CFG.seconds}s per round, vein rest ${CFG.veinRestMinutes} min${Object.keys(CFG.veinRestByOre || {}).length ? ` (${Object.entries(CFG.veinRestByOre).map(([o, m]) => `${o} ${m}`).join(', ')})` : ''}, ${REF_ORE.size} veins by reference; rounds issued server-side, ${clientJudged() ? `judged by the widget (replay ${MG.replayRefuses(CFG) ? 'refuses' : 'logs'} a mismatch, ${Math.round(Math.max(60000, Number(CFG.roundTimeoutMs) || 180000) / 1000)} s cleanup, ${CFG.nearMeters} m reach)` : 'judged server-side from strike times'} (stagger ${CFG.hitCooldownMs}/${CFG.missStaggerMs} ms, lag grace ${CFG.lagGraceMs} ms${clientJudged() ? ', logged only' : ''}); salt glow ${saltCfg().enabled !== false ? `for ${saltCfg().audience}, ${SALT_REFS.length} deposits` : 'off'}`);
};
