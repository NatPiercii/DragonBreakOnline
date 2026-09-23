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

module.exports = (api) => {
  const { mp, log, personal, audit, display, who, cfg, openWidget, closeWidget, onUi, giveItem, skills } = api;

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
    oreYieldByOre: { copper: 3, tin: 3, iron: 3, corundum: 2, silver: 2, quicksilver: 2, orichalcum: 2, moonstone: 2, gold: 1, ebony: 1, malachite: 1, stalhrim: 1, salt: 2 },
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
    veinRestMinutes: 45,
    blockRestMinutes: 10,
    failRestMinutes: 2,
  }, cfg.labour || {});

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
    tin: '601c4f:BSAssets.esm',
    salt: '34cdf:Skyrim.esm',
    firewood: '6f993:Skyrim.esm',
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
  const restsOf = (a, prop) => { try { const r = mp.get(a, prop); return r && typeof r === 'object' ? r : {}; } catch (e) { return {}; } };
  const saveRests = (a, prop, rests) => {
    for (const k of Object.keys(rests)) if (Number(rests[k]) < Date.now()) delete rests[k];
    try { mp.set(a, prop, rests); } catch (e) { log('labour rest save failed', e.message); }
  };
  const deny = (a, text) => {
    if (Date.now() - (denied.get(a) || 0) > 1500) { denied.set(a, Date.now()); personal(a, text); }
    return true;
  };
  const titleCase = (s) => s.charAt(0).toUpperCase() + s.slice(1);

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

  const roundFor = (a, kind, tier, strikes, title, refId) => {
    const seed = crypto.randomBytes(4).readUInt32LE(0);
    const rand = rngOf(seed);
    // Clamp here, exactly as the widget used to, so the value the server judges with is the value
    // the widget draws with
    const half = Math.max(3, Math.min(30, tierValue(CFG.bandByTier, tier, 8)));
    const bands = [];
    for (let i = 0; i < strikes; i++) bands.push(Math.round((half + rand() * (100 - 2 * half)) * 100) / 100);
    return {
      nonce: `${a.toString(16)}-${Date.now().toString(36)}-${crypto.randomBytes(4).readUInt32LE(0).toString(36)}`,
      kind, tier, strikes, title, refId, seed, half, bands,
      sweepMs: Math.max(400, Math.round(tierValue(CFG.sweepByTier, tier, 1.4) * 1000)),
      totalMs: Math.max(1000, Math.round((Number(CFG.seconds) || 30) * 1000)),
      hitMs: Math.max(0, Math.round(Number(CFG.hitCooldownMs) || 250)),
      missMs: Math.max(0, Math.round(Number(CFG.missStaggerMs) || 600)),
      startedAt: 0,
    };
  };

  // Everything the widget needs to draw the server's round, and nothing it could use to judge it
  const packetFor = (round, result, resultKind) => {
    const w = {
      type: 'labour', id: WIDGET_ID, nonce: round.nonce, kind: round.kind, title: round.title,
      strikes: round.strikes, band: round.half, bands: round.bands,
      sweepMs: round.sweepMs, totalMs: round.totalMs, hitMs: round.hitMs, missMs: round.missMs,
    };
    if (result) { w.result = result; w.resultKind = resultKind; }
    return w;
  };

  const startRound = (a, round) => {
    sessions.set(a, round);
    round.startedAt = nowMs();
    if (!openWidget(a, packetFor(round), true)) sessions.delete(a);
    return true;
  };

  // A round whose report never came back (a crash, a lost packet, a closed browser) must not lock
  // the player out of the seam for ever, so anything past the round plus the lag grace is dead.
  const liveRound = (a) => {
    const r = sessions.get(a);
    if (!r) return null;
    if (nowMs() - r.startedAt <= r.totalMs + CFG.lagGraceMs) return r;
    sessions.delete(a);
    return null;
  };

  const mine = (targetId, casterId, rec) => {
    const ore = oreOf(String(rec.record.editorId || '')) || nodeOf(targetId, String(rec.record.editorId || ''));
    if (!ore) return false;
    const tier = tierOf(casterId, 'miner');
    // Not a miner yet: fall through rather than deny, so masterySystem's activation gate can grant
    // first touch (SKILLS_DESIGN 5.3). deny() returns true, which makes gamemode.js:638 stop the
    // activate chain before that gate ever runs - the skill could then never be opened at all.
    if (tier < 0) return false;
    if (liveRound(casterId)) return true;
    if (ore !== 'geode' && !ITEMS[ore]) return deny(casterId, 'You do not know what to do with this seam.');
    if (oresUpTo(tier).indexOf(ore) === -1) return deny(casterId, `${titleCase(ore)} is beyond your skill. Work the seams you know first.`);
    const rests = restsOf(casterId, 'private.minedVeins');
    const until = Number(rests[targetId.toString(16)]) || 0;
    if (until > Date.now()) return deny(casterId, `This seam is worked out for now. Come back in ${Math.ceil((until - Date.now()) / 60000)} minutes.`);
    const round = roundFor(casterId, 'mining', tier, Math.max(1, Number(CFG.oreStrikes) || 6), ore === 'salt' ? 'Sea Salt Deposit' : ore === 'geode' || (CFG.gemOre || {})[ore] ? 'Geode' : `${titleCase(ore)} Seam`, targetId);
    round.ore = ore;
    return startRound(casterId, round);
  };

  const chop = (targetId, casterId) => {
    const tier = tierOf(casterId, 'woodcutter');
    if (tier < 0) return false;   // same first-touch fall-through as mine()
    if (liveRound(casterId)) return true;
    const rests = restsOf(casterId, 'private.choppedBlocks');
    const until = Number(rests[targetId.toString(16)]) || 0;
    if (until > Date.now()) return deny(casterId, `You have split all the logs here. Come back in ${Math.ceil((until - Date.now()) / 60000)} minutes.`);
    const strikes = Math.max(1, Math.round(tierValue(WOODCUTTER.chopStrikesByTier, tier, 4)));
    const round = roundFor(casterId, 'chopping', tier, strikes, 'Chopping Block', targetId);
    return startRound(casterId, round);
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
    return false;
  };

  const finish = (a, round, win, text, kind, rest) => {
    if (rest !== false) {
      const prop = round.kind === 'mining' ? 'private.minedVeins' : 'private.choppedBlocks';
      const rests = restsOf(a, prop);
      const restMinutes = win
        ? (round.kind === 'mining' ? CFG.veinRestMinutes : CFG.blockRestMinutes)
        : CFG.failRestMinutes;
      rests[round.refId.toString(16)] = Date.now() + restMinutes * 60000;
      saveRests(a, prop, rests);
    }
    openWidget(a, packetFor(round, text, kind), false);
    sessions.delete(a);
    // Remembered only so a repeat of the same report is logged as a replay instead of vanishing
    spent.set(round.nonce, Date.now());
    while (spent.size > 200) spent.delete(spent.keys().next().value);
  };

  onUi('labourCancel', (a) => { sessions.delete(a); closeWidget(a, WIDGET_ID); });
  onUi('close', (a, args, widgetId) => { if (widgetId === WIDGET_ID) sessions.delete(a); });

  // Replay the round against the report. The widget sends the millisecond of every strike it took,
  // hit or miss; the hits are counted here, from the sweep and the band list the server issued.
  const judge = (round, raw, at, elapsed) => {
    const r = { hits: 0, count: 0, last: 0, at, lag: Math.round(elapsed - at), err: 0, bad: '' };
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
      const landed = d <= round.half + 1e-9;
      ready = t + (landed ? round.hitMs : round.missMs);
      if (landed) { r.err += d / round.half; r.hits++; }
      r.last = t;
    }
    if (r.hits) r.err /= r.hits;
    if (r.bad) return r;
    if (r.last > at) r.bad = 'submit';                      // a strike after the report went out
    else if (r.lag < -CFG.clockSlackMs) r.bad = 'future';   // more time on its clock than the server watched pass
    // The widget's clock may only sit behind the server's by the transport: the packet out, the
    // mount, the report back. Further behind means the round was drawn out in real time and the
    // times scaled back down — a sweep played in slow motion is the one cheat the band check alone
    // would not see. It also expires a report that turns up minutes after its round.
    else if (r.lag > CFG.lagGraceMs) r.bad = 'late';
    return r;
  };

  onUi('labour', (a, args) => {
    const round = sessions.get(a);
    if (!round || String(args[0]) !== round.nonce) {
      if (spent.has(String(args[0]))) log(`labour replay ${display(a)}: ${String(args[0]).slice(0, 40)} was already judged`);
      return;
    }
    const elapsed = nowMs() - round.startedAt;
    // An interface from before the round was server-issued reports a hit count and nothing else
    if (typeof args[1] === 'number' || /^\s*\d+\s*$/.test(String(args[1]))) {
      log(`labour stale-ui ${display(a)} ${round.kind}: a hit count, no strike times`);
      return finish(a, round, false, 'Your interface is out of date. Rejoin the server to pick up the new one.', 'lose', false);
    }
    const v = judge(round, args[1], Math.max(0, Math.floor(Number(args[2]) || 0)), elapsed);
    const win = !v.bad && v.hits >= round.strikes;
    // One line per verdict: hits of strikes taken, the last strike and the report's own clock, the
    // lag between that clock and the server's, how far off centre the hits were (0 is dead centre,
    // 1 is the band's edge — a player who is always at 0.00 is not a player), and the round's seed.
    log(`labour ${v.bad ? 'refused(' + v.bad + ')' : win ? 'win' : 'lose'} ${display(a)} ${round.kind}${round.ore ? '/' + round.ore : ''} t${round.tier + 1} ${v.hits}/${round.strikes} of ${v.count} last=${v.last} at=${v.at} lag=${v.lag} err=${v.err.toFixed(2)} seed=${round.seed.toString(16)}`);

    if (!win) {
      const text = round.kind === 'mining'
        ? 'The seam holds. Your arms give out before the rock does.'
        : 'The log rolls off the block, still whole.';
      return finish(a, round, false, text, 'lose');
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
        : `The seam gives way: ${count} ${titleCase(round.ore)} Ore.`;
      if (ok) audit(`MINE ${who(a)} worked a ${round.ore} seam (tier ${round.tier + 1}) -> ${count} ${gem ? itemName(gem) : 'ore'}${bonus ? ` + ${itemName(bonus)}` : ''}`);
    } else {
      const count = Math.max(1, Math.round(tierValue(CFG.firewoodByTier, round.tier, 3)));
      const ok = giveItem(a, idOf(ITEMS.firewood), count);
      text = ok
        ? `Split clean: ${count} Firewood.`
        : 'Split clean, but you cannot carry any more.';
      if (ok) audit(`CHOP ${who(a)} split logs (tier ${round.tier + 1}) -> ${count} firewood`);
    }
    finish(a, round, true, text, 'win');
  });

  log(`labour ${CFG.enabled ? 'on' : 'off'}: mining ${CFG.oreStrikes} strikes, chopping ${(WOODCUTTER.chopStrikesByTier || []).join('/')} by tier, ${CFG.seconds}s per round, vein rest ${CFG.veinRestMinutes} min; rounds issued and judged server-side from strike times (stagger ${CFG.hitCooldownMs}/${CFG.missStaggerMs} ms, lag grace ${CFG.lagGraceMs} ms)`);
};
