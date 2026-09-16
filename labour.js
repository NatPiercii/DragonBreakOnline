// Mining and woodcutting as timing mini-games, loaded by gamemode.js like dungeons.js and wildlife.js.
// An ore vein (MineOre / CYRMineOre activators) belongs to the Miner skill, a chopping block to the
// Woodcutter. Both use the same front widget: a marker sweeps a bar and the worker strikes while it
// sits in the band. The server sends the round, judges the report and hands out the yield.
'use strict';

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
    oreYieldByOre: { copper: 3, tin: 3, iron: 3, corundum: 2, silver: 2, quicksilver: 2, orichalcum: 2, moonstone: 2, gold: 1, ebony: 1, malachite: 1, stalhrim: 1 },
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
    firewood: '6f993:Skyrim.esm',
  }, CFG.items || {});

  const MINER = (skills.skills || []).find((k) => k.id === 'miner') || {};
  const WOODCUTTER = (skills.skills || []).find((k) => k.id === 'woodcutter') || {};

  const sessions = new Map(); // actorId -> round
  const denied = new Map();

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
    return m[1].toLowerCase();
  };

  // Ores the tier may work, counting every tier below it
  const oresUpTo = (tier) => {
    const byTier = MINER.oreByTier || [];
    const out = [];
    for (let i = 0; i <= Math.min(tier, byTier.length - 1); i++) for (const ore of byTier[i] || []) out.push(String(ore).toLowerCase());
    return out;
  };

  const startRound = (a, round) => {
    sessions.set(a, round);
    const widget = {
      type: 'labour', id: WIDGET_ID, nonce: round.nonce, kind: round.kind, title: round.title,
      strikes: round.strikes, seconds: CFG.seconds, band: round.band, sweep: round.sweep,
    };
    if (!openWidget(a, widget, true)) sessions.delete(a);
    return true;
  };

  const roundFor = (a, kind, tier, strikes, title, refId) => ({
    nonce: `${a.toString(16)}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
    kind, tier, strikes, title, refId,
    startedAt: Date.now(),
  });

  const tierValue = (list, tier, fallback) => {
    const arr = Array.isArray(list) ? list : [];
    const v = Number(arr[Math.min(Math.max(tier, 0), arr.length - 1)]);
    return Number.isFinite(v) ? v : fallback;
  };

  const mine = (targetId, casterId, rec) => {
    const ore = oreOf(String(rec.record.editorId || ''));
    if (!ore) return false;
    const tier = tierOf(casterId, 'miner');
    if (tier < 0) return deny(casterId, 'Only a Miner can read a seam well enough to work it.');
    if (sessions.has(casterId)) return true;
    if (!ITEMS[ore]) return deny(casterId, 'You do not know what to do with this seam.');
    if (oresUpTo(tier).indexOf(ore) === -1) return deny(casterId, `${titleCase(ore)} is beyond your skill. Work the seams you know first.`);
    const rests = restsOf(casterId, 'private.minedVeins');
    const until = Number(rests[targetId.toString(16)]) || 0;
    if (until > Date.now()) return deny(casterId, `This seam is worked out for now. Come back in ${Math.ceil((until - Date.now()) / 60000)} minutes.`);
    const round = roundFor(casterId, 'mining', tier, Math.max(1, Number(CFG.oreStrikes) || 6), `${titleCase(ore)} Seam`, targetId);
    round.ore = ore;
    round.band = tierValue(CFG.bandByTier, tier, 8);
    round.sweep = tierValue(CFG.sweepByTier, tier, 1.4);
    return startRound(casterId, round);
  };

  const chop = (targetId, casterId) => {
    const tier = tierOf(casterId, 'woodcutter');
    if (tier < 0) return deny(casterId, 'Only a Woodcutter knows where to set the wedge.');
    if (sessions.has(casterId)) return true;
    const rests = restsOf(casterId, 'private.choppedBlocks');
    const until = Number(rests[targetId.toString(16)]) || 0;
    if (until > Date.now()) return deny(casterId, `You have split all the logs here. Come back in ${Math.ceil((until - Date.now()) / 60000)} minutes.`);
    const strikes = Math.max(1, tierValue(WOODCUTTER.chopStrikesByTier, tier, 4));
    const round = roundFor(casterId, 'chopping', tier, strikes, 'Chopping Block', targetId);
    round.band = tierValue(CFG.bandByTier, tier, 8);
    round.sweep = tierValue(CFG.sweepByTier, tier, 1.4);
    return startRound(casterId, round);
  };

  // Called from the gamemode's activate chain; true means the activation was ours
  globalThis.__dboLabour = (targetId, casterId) => {
    if (!CFG.enabled || targetId >= 0xff000000) return false;
    const rec = baseRecord(targetId);
    if (!rec || !rec.record) return false;
    const type = String(rec.record.type || '');
    const edid = String(rec.record.editorId || '');
    if (type === 'ACTI' && /^(CYR)?MineOre|^DLC2MineOre/.test(edid)) return mine(targetId, casterId, rec);
    if (type === 'FURN' && /^(DLC2)?WoodChoppingBlock/i.test(edid)) return chop(targetId, casterId);
    return false;
  };

  const finish = (a, round, win, text, kind) => {
    const rests = restsOf(a, round.kind === 'mining' ? 'private.minedVeins' : 'private.choppedBlocks');
    const restMinutes = win
      ? (round.kind === 'mining' ? CFG.veinRestMinutes : CFG.blockRestMinutes)
      : CFG.failRestMinutes;
    rests[round.refId.toString(16)] = Date.now() + restMinutes * 60000;
    saveRests(a, round.kind === 'mining' ? 'private.minedVeins' : 'private.choppedBlocks', rests);
    openWidget(a, {
      type: 'labour', id: WIDGET_ID, nonce: round.nonce, kind: round.kind, title: round.title,
      strikes: round.strikes, seconds: CFG.seconds, band: round.band, sweep: round.sweep,
      result: text, resultKind: kind,
    }, false);
    sessions.delete(a);
  };

  onUi('labourCancel', (a) => { sessions.delete(a); closeWidget(a, WIDGET_ID); });
  onUi('close', (a, args, widgetId) => { if (widgetId === WIDGET_ID) sessions.delete(a); });

  onUi('labour', (a, args) => {
    const round = sessions.get(a);
    if (!round || String(args[0]) !== round.nonce) return;
    const elapsed = Date.now() - round.startedAt;
    const hits = Math.max(0, Math.min(round.strikes, Math.floor(Number(args[1]) || 0)));
    // A strike cannot land faster than the marker can cross the band, so a flood of hits is a lie
    const tooFast = elapsed < hits * 350;
    const inTime = elapsed <= CFG.seconds * 1000 + 2500;
    const win = hits >= round.strikes && inTime && !tooFast;
    if (tooFast) log(`labour: ${display(a)} reported ${hits} strikes in ${elapsed} ms, refused`);

    if (!win) {
      const text = round.kind === 'mining'
        ? 'The seam holds. Your arms give out before the rock does.'
        : 'The log rolls off the block, still whole.';
      return finish(a, round, false, text, 'lose');
    }

    try { if (typeof globalThis.__alduinakMasteryEvent === 'function') globalThis.__alduinakMasteryEvent('activate', a, { refrId: round.refId }); } catch (e) { /* no skill system */ }

    let text = '';
    if (round.kind === 'mining') {
      const base = Number((CFG.oreYieldByOre || {})[round.ore]) || 1;
      const mult = tierValue(MINER.yieldMultiplierByTier, round.tier, 1);
      const count = Math.max(1, Math.round(base * mult));
      const ok = giveItem(a, idOf(ITEMS[round.ore]), count);
      text = ok
        ? `The seam gives way: ${count} ${titleCase(round.ore)} Ore.`
        : 'The seam gives way, but you cannot carry any more.';
      if (ok) audit(`MINE ${who(a)} worked a ${round.ore} seam (tier ${round.tier + 1}) -> ${count} ore`);
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

  log(`labour ${CFG.enabled ? 'on' : 'off'}: mining ${CFG.oreStrikes} strikes, chopping ${(WOODCUTTER.chopStrikesByTier || []).join('/')} by tier, ${CFG.seconds}s per round, vein rest ${CFG.veinRestMinutes} min`);
};
