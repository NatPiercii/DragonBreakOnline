// DragonBreak Online: alchemy at the ordinary alchemy labs. Loaded by gamemode.js on every hot reload.
//
// The lab's own menu mixes on the client and makes a potion no plugin holds (a 0xff... form), so the server's recipe
// check never matches it: every potion made this way used to be refused and rolled back. CraftService now fires
// onCraftUnmatched for such a craft, and this module honours it the way Nat chose: the effect is worked out here from
// the ingredient records (never taken from the client), and the player gets the nearest vanilla potion or poison
// (alchemy-potions.json, weakest to strongest), its strength set by their Alchemist rank. One of each ingredient used
// is taken, as in vanilla. The arcane enchanter's reports come here too: a disenchanted item is taken (disenchant below).
'use strict';
const fs = require('fs');
const path = require('path');

module.exports = (api) => {
  const { mp, log, personal, audit, display, who, openWidget, closeWidget, every, itemName } = api;

  const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')); } catch (e) { log(`alchemy: ${file} unreadable (${e.message})`); return fallback; } };
  const TABLE = readJson('alchemy-potions.json', { effects: {} }).effects || {};
  const idOf = (desc) => { try { return mp.getIdFromDesc(desc) >>> 0; } catch (e) { return 0; } };
  // Effect (global id) -> potion ids, weakest first
  const POTIONS = new Map();
  for (const [mg, v] of Object.entries(TABLE)) {
    const effect = idOf(`${mg}:Skyrim.esm`);
    const ids = (v.potions || []).map((p) => ({ id: idOf(p.id), edid: p.edid })).filter((p) => p.id);
    if (effect && ids.length) POTIONS.set(effect, { name: v.effect, potions: ids });
  }

  const lookup = (id) => { try { const r = mp.lookupEspmRecordById(id >>> 0); return r && r.record ? r : null; } catch (e) { return null; } };
  const u32 = (f, off) => { const d = f && f.data; if (!(d instanceof Uint8Array) || d.byteLength < off + 4) return 0; return new DataView(d.buffer, d.byteOffset, d.byteLength).getUint32(off, true); };
  const f32 = (f, off) => { const d = f && f.data; if (!(d instanceof Uint8Array) || d.byteLength < off + 4) return 0; return new DataView(d.buffer, d.byteOffset, d.byteLength).getFloat32(off, true); };
  // An ingredient's effects as load-order ids (EFID is record-local, so it goes through the ingredient's own file)
  // A record lookup copies every subrecord and the plugins never change while the server runs, so both are kept per id
  // (the brew list pairs every ingredient carried)
  const CACHE = globalThis.__dboAlchemyCache || (globalThis.__dboAlchemyCache = { effects: new Map(), cost: new Map() });
  const effectsOf = (ingredient) => {
    const id = ingredient >>> 0;
    if (CACHE.effects.has(id)) return CACHE.effects.get(id);
    const lr = lookup(id);
    let out = null;
    if (lr && String(lr.record.type) === 'INGR') {
      out = [];
      for (const f of lr.record.fields || []) if (f.type === 'EFID') { try { const g = lr.toGlobalRecordId(u32(f, 0)) >>> 0; if (g) out.push(g); } catch (e) { /* unmapped */ } }
    }
    if (lr || id >= 0xff000000) CACHE.effects.set(id, out);
    return out;
  };
  const baseCost = (effect) => {
    const id = effect >>> 0;
    if (CACHE.cost.has(id)) return CACHE.cost.get(id);
    const lr = lookup(id); const data = lr && (lr.record.fields || []).find((f) => f.type === 'DATA');
    const cost = data ? f32(data, 4) : 0;
    if (lr) CACHE.cost.set(id, cost);
    return cost;
  };
  const isLab = (workbenchId) => {
    let base = 0; try { base = mp.getIdFromDesc(String(mp.get(workbenchId >>> 0, 'baseDesc'))) >>> 0; } catch (e) { return false; }
    const lr = lookup(base);
    return !!lr && /alchemy/i.test(String(lr.record.editorId || ''));
  };
  // The client names the workbench, so the brewer must stand at it (the old /brew range)
  const LAB_REACH = 400;
  const atLab = (a, workbenchId) => {
    try {
      if (String(mp.get(a, 'worldOrCellDesc')) !== String(mp.get(workbenchId, 'worldOrCellDesc'))) return false;
      const p = mp.get(a, 'pos'), q = mp.get(workbenchId, 'pos');
      if (!Array.isArray(p) || !Array.isArray(q)) return false;
      const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
      return Number.isFinite(d) && d <= LAB_REACH;
    } catch (e) { return false; }
  };
  const alchemistTier = (a) => {
    try {
      const r = mp.get(a, 'private.mastery');
      if (!r || !Array.isArray(r.order) || !r.order.includes('alchemist')) return 0;
      const p = r.skills && r.skills.alchemist;
      return (p ? Math.max(0, Number(p.rank) || 0) : 0) + 1;
    } catch (e) { return 0; }
  };
  const invOf = (a) => { try { const inv = mp.get(a, 'inventory'); return inv && Array.isArray(inv.entries) ? inv.entries.map((e) => Object.assign({}, e)) : []; } catch (e) { return []; } };
  const countOf = (entries, id) => entries.filter((e) => (Number(e.baseId) >>> 0) === id).reduce((n, e) => n + (Number(e.count) || 0), 0);
  const take = (entries, id, n) => {
    for (const e of entries) {
      if (n <= 0) break;
      if ((Number(e.baseId) >>> 0) !== id || e.worn) continue;
      const k = Math.min(n, Number(e.count) || 0); e.count = (Number(e.count) || 0) - k; n -= k;
    }
  };
  const give = (entries, id, n) => { const hit = entries.find((e) => (Number(e.baseId) >>> 0) === id && !e.worn); if (hit) hit.count = (Number(hit.count) || 0) + n; else entries.push({ baseId: id, count: n }); };
  // Effects two or more of the ingredients share that a known potion carries, the most valuable first: that one decides
  const sharedEffects = (used) => {
    const tally = new Map();
    for (const id of used) for (const e of new Set(effectsOf(id) || [])) tally.set(e, (tally.get(e) || 0) + 1);
    return [...tally].filter(([, n]) => n >= 2).map(([e]) => e).filter((e) => POTIONS.has(e)).sort((x, y) => baseCost(y) - baseCost(x));
  };
  const potionAt = (pick, tier) => pick.potions[Math.max(0, Math.min(pick.potions.length - 1, Math.round(tier / 5 * (pick.potions.length - 1))))];
  // Brewing is the Alchemist's work (Nate, 2026-09-30: Alchemist rose from picking mushrooms; gathering is the Harvesting
  // trade's). One brew is worth 1 at tier 1 up to 3 at tier 5, and the same potion again within the hour less
  // (masterySystem's repeat ring, keyed on the potion). __alduinakMasteryAward (fork server-next-v2) credits only a skill
  // already held; before that fork is live there is nothing to call, and the lab's own count in skills.json stands in.
  const creditBrew = (a, potionId, tier) => {
    const award = globalThis.__alduinakMasteryAward;
    if (typeof award !== 'function') return 0;
    try { return Number(award(a, 'alchemist', Math.min(3, 1 + 0.5 * Math.max(0, (Number(tier) || 1) - 1)), Number(potionId) >>> 0)) || 0; } catch (e) { log(`alchemy: mastery award failed for ${display(a)}: ${e.message}`); return 0; }
  };
  const potionName = (potion) => potion.edid.replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/\s+0?(\d+)$/, ' $1');
  // The F7 catalog's display name (gamemode adminItemName), else the editor id spaced out
  const ingredientName = (id) => {
    try { const n = itemName && mp.getDescFromId ? itemName(mp.getDescFromId(id >>> 0)) : ''; if (n) return n; } catch (e) { /* not in the catalog */ }
    const r = lookup(id);
    return String((r && r.record.editorId) || id.toString(16)).replace(/^(?:BSK|CYR|DLC\d|BYOH|cc[A-Z]+SSE\d+_?)/, '').replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/\s*\d+$/, '').trim();
  };

  // ---- what the lab can make from the pack (groundedpasta, 2026-09-29: "show the potions you can actually craft") -----
  // Using a lab opens an unfocused panel beside its menu: every potion two of the ingredients carried would make, worked
  // out exactly as brew() does, and a pair that makes each. It follows each brew and closes when the player leaves the lab.
  const PANEL_ID = 71;
  const PANEL_LINES = 14;
  const S = globalThis.__dboAlchemyPanel || (globalThis.__dboAlchemyPanel = { panels: new Map() });
  const brewable = (a) => {
    const held = [...new Set(invOf(a).filter((e) => (Number(e.count) || 0) > 0).map((e) => Number(e.baseId) >>> 0))].filter((id) => id < 0xff000000 && (effectsOf(id) || []).length);
    const tier = alchemistTier(a);
    const found = new Map();   // potion edid -> { name, value, pair }
    for (let i = 0; i < held.length; i++) {
      for (let j = i + 1; j < held.length; j++) {
        const shared = sharedEffects([held[i], held[j]]);
        if (!shared.length) continue;
        const potion = potionAt(POTIONS.get(shared[0]), tier);
        if (!found.has(potion.edid)) found.set(potion.edid, { name: potionName(potion), value: baseCost(shared[0]), pair: [held[i], held[j]] });
      }
    }
    return [...found.values()].sort((x, y) => y.value - x.value || x.name.localeCompare(y.name));
  };
  const showBrewable = (a) => {
    const list = brewable(a);
    const lines = list.length
      ? list.slice(0, PANEL_LINES).map((p) => `${p.name}: ${p.pair.map(ingredientName).join(' + ')}`).concat(list.length > PANEL_LINES ? [`and ${list.length - PANEL_LINES} more`] : [])
      : ['Nothing yet: no two of your ingredients share an effect.'];
    openWidget(a, { type: 'contextMenu', id: PANEL_ID, mode: 'inspect', targetName: list.length ? `You can brew (${list.length})` : 'You can brew', lines }, false);
  };
  globalThis.__dboAlchemyLab = (targetId, casterId) => {
    if (!openWidget || !isLab(targetId)) return false;
    S.panels.set(casterId >>> 0, targetId >>> 0);
    try { showBrewable(casterId >>> 0); } catch (e) { log(`alchemy: brew list failed: ${e.message}`); }
    return false;   // the lab's own menu still opens
  };
  if (every) every('alchemyPanel', 2000, () => {
    for (const [a, lab] of [...S.panels]) {
      if (atLab(a, lab)) continue;
      S.panels.delete(a);
      try { closeWidget(a, PANEL_ID); } catch (e) { /* gone */ }
    }
  });

  const said = new Map();
  const tell = (a, text) => { if (Date.now() - (said.get(a) || 0) > 1500) { said.set(a, Date.now()); personal(a, text); } };

  const brew = (a, workbenchId, inputs) => {
    if (!isLab(workbenchId)) return;
    if (!atLab(a, workbenchId)) return log(`alchemy: ${display(a)} reported a mix at lab ${workbenchId.toString(16)} while not at it; ignored`);
    const reported = inputs && Array.isArray(inputs.entries) ? inputs.entries : [];
    // Distinct ingredients the client says went in; vanilla mixes two or three, one of each
    const all = [...new Set(reported.map((e) => Number(e.baseId) >>> 0))];
    // A dynamic id is a created object, never an ingredient record, and the craft report carries the result
    // itself among its inputs (Falcius, 2026-09-28: pond fish + wormwood + ff000b2f, a perfectly good pair
    // refused because of a third thing that was never an ingredient). Drop those before judging the mix.
    const made = all.filter((id) => id >= 0xff000000);
    const used = all.filter((id) => id < 0xff000000);
    // Anything else is not a mix (such as the inventory re-applied while seated at the lab), so nothing is made
    if (used.length > 3 || used.some((id) => !effectsOf(id))) {
      const counts = reported.map((e) => `${(Number(e.baseId) >>> 0).toString(16)}x${Number(e.count) || 1}`).join(' ');
      log(`alchemy: ${display(a)} report detail: ${counts}${made.length ? `, ${made.length} created object(s) dropped` : ''}`);
      const why = used.length > 3 ? `${used.length} distinct items` : 'an item with no alchemy effect';
      log(`alchemy: ${display(a)} reported ${used.map((id) => { const r = lookup(id); return r ? r.record.editorId : id.toString(16); }).join(' + ')}, not a lab mix (${why}); ignored`);
      // Only ingredients, too many of them: a real mix the client misreported, so the player is told
      if (used.length > 3 && used.every((id) => id < 0xff000000 && effectsOf(id))) tell(a, 'The lab did not recognise that mix, so nothing was brewed. Your ingredients come back when you leave the lab. Try again.');
      return;
    }
    // One ingredient named twice: the player's own lab brewed from two, but the report lost the second (24 times 23-30 Sep,
    // e.g. BSKCairnBolete x1 + BSKCairnBolete x1; Skyrim cannot put one ingredient in a potion twice). The server cannot
    // know the other ingredient, and one ingredient never makes a potion here, so nothing is brewed and nothing is taken;
    // the player is told what happened instead of "needs two ingredients", and the line below gathers the evidence
    // (the report, and how the player's own stack of that ingredient is held) for the client fix.
    const ids = reported.filter((e) => (Number(e.baseId) >>> 0) < 0xff000000).map((e) => Number(e.baseId) >>> 0);
    if (used.length === 1 && ids.length >= 2) {
      const held = invOf(a).filter((e) => (Number(e.baseId) >>> 0) === used[0]);
      const r = lookup(used[0]);
      log(`alchemy: ${display(a)} report named ${r ? r.record.editorId : used[0].toString(16)} ${ids.length} times and nothing else at lab ${workbenchId.toString(16)}; `
        + `held as ${held.length} stack(s) [${held.map((e) => Object.entries(e).filter(([k]) => k !== 'baseId').map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ')).join(' | ')}]; `
        + `report ${reported.map((e) => `${(Number(e.baseId) >>> 0).toString(16)}x${Number(e.count) || 1}`).join(' ')}`);
      return tell(a, 'The lab lost track of your second ingredient, so nothing was brewed and nothing was used up. Try the mix again.');
    }
    if (used.length < 2) return tell(a, 'A potion needs at least two ingredients.');
    const entries = invOf(a);
    const missing = used.find((id) => countOf(entries, id) < 1);
    if (missing) { log(`alchemy: ${display(a)} reported ${missing.toString(16)} it does not hold`); return tell(a, 'You do not have those ingredients.'); }
    // The Draught of Revival replaces the ordinary potion for its exact recipe (downed.js decides)
    const draught = typeof globalThis.__dboLabDraught === 'function' ? globalThis.__dboLabDraught(a, used) : null;
    if (draught && draught.potion) {
      for (const id of used) take(entries, id, 1);
      give(entries, draught.potion, 1);
      try { mp.set(a, 'inventory', { entries: entries.filter((e) => Number(e.count) > 0) }); } catch (e) { log(`alchemy: inventory write failed for ${display(a)}: ${e.message}`); return; }
      draught.brewed();
      creditBrew(a, draught.potion, alchemistTier(a));
      log(`alchemy: ${display(a)} brewed the ${draught.name} (tier ${alchemistTier(a)}) from ${used.map((id) => { const r = lookup(id); return r ? r.record.editorId : id.toString(16); }).join(' + ')}`);
      return;
    }
    const hint = draught && draught.hint ? ` ${draught.hint}` : '';
    const shared = sharedEffects(used);
    if (!shared.length) {
      const tally = new Map();
      for (const id of used) for (const e of new Set(effectsOf(id))) tally.set(e, (tally.get(e) || 0) + 1);
      const seen = [...tally].map(([e, n]) => { const r = lookup(e); return `${r ? r.record.editorId : e.toString(16)} x${n}${POTIONS.has(e) ? '' : ' (no potion)'}`; });
      log(`alchemy: ${display(a)} mixed ${used.map((id) => { const r = lookup(id); return r ? r.record.editorId : id.toString(16); }).join(' + ')} and nothing matched; effects ${seen.join(', ')}`);
      return tell(a, 'These ingredients share no effect that makes a potion you know. You keep them.');
    }
    const pick = POTIONS.get(shared[0]);
    if (shared.length > 1) log(`alchemy: ${display(a)} shared ${shared.map((e) => { const r = lookup(e); return `${r ? r.record.editorId : e.toString(16)}@${Math.round(baseCost(e))}`; }).join(', ')}; took the first`);
    const tier = alchemistTier(a);   // 0 without the trade, 1..5 by rank
    const potion = potionAt(pick, tier);
    for (const id of used) take(entries, id, 1);
    give(entries, potion.id, 1);
    try { mp.set(a, 'inventory', { entries: entries.filter((e) => Number(e.count) > 0) }); } catch (e) { log(`alchemy: inventory write failed for ${display(a)}: ${e.message}`); return; }
    tell(a, `You brew ${potionName(potion)}.${hint}`);
    creditBrew(a, potion.id, tier);
    log(`alchemy: ${display(a)} brewed ${potion.edid} (${pick.name}, tier ${tier}) from ${used.map((id) => { const r = lookup(id); return r ? r.record.editorId : id.toString(16); }).join(' + ')}`);
    audit(`ALCHEMY ${who(a)} brewed ${potion.edid}`);
    if (S.panels.has(a)) showBrewable(a);
  };

  // ---- disenchanting at an arcane enchanter (/bug 2026-10-01 "disassembleenchantedweapon") ------------------------
  // Vanilla destroys the item it teaches the enchantment of. The game does that on the client and tells the server
  // nothing, so the server kept every disenchanted weapon and the next inventory sync handed it back: the enchantment
  // learned, the weapon kept, free to trade on and disenchant again. What the client does send is its craft report from
  // the enchanter: every item that left the pack while seated there, closed by the next one to arrive (usually the
  // weapon handed back). No recipe matches it, so it ends here. An item enchanted by its own record (EITM, "Elven
  // Dagger of the Blaze") in it was disenchanted: vanilla's enchanter takes nothing else of the kind (it never enchants
  // an enchanted item; enchanting takes a plain one and a soul gem, which craftedExtras records). So one unworn copy per
  // reported one is taken, as vanilla takes it.
  const BENCH_ENCHANTING = new Set([3, 4]); // FURN WBDT bench type: Enchanting, EnchantingExperiment
  const isEnchanter = (workbenchId) => {
    let base = 0; try { base = mp.getIdFromDesc(String(mp.get(workbenchId >>> 0, 'baseDesc'))) >>> 0; } catch (e) { return false; }
    const lr = lookup(base);
    if (!lr || String(lr.record.type) !== 'FURN') return false;
    const wbdt = (lr.record.fields || []).find((f) => f.type === 'WBDT');
    return !!wbdt && wbdt.data instanceof Uint8Array && wbdt.data.byteLength > 0 && BENCH_ENCHANTING.has(wbdt.data[0]);
  };
  const enchantedByRecord = (id) => {
    const lr = id < 0xff000000 ? lookup(id) : null;
    return !!lr && /^(WEAP|ARMO)$/.test(String(lr.record.type)) && (lr.record.fields || []).some((f) => f.type === 'EITM');
  };
  const disenchant = (a, workbenchId, inputs) => {
    const reported = inputs && Array.isArray(inputs.entries) ? inputs.entries : [];
    const wanted = new Map();
    for (const e of reported) {
      const id = Number(e.baseId) >>> 0;
      if (enchantedByRecord(id)) wanted.set(id, (wanted.get(id) || 0) + Math.max(1, Number(e.count) || 1));
    }
    if (!wanted.size) return;   // enchanting (a plain item and a soul gem): craftedExtras records that
    if (!atLab(a, workbenchId)) return log(`disenchant: ${display(a)} reported a disenchant at ${workbenchId.toString(16)} while not at it; ignored`);
    const entries = invOf(a);
    const taken = [];
    for (const [id, n] of wanted) {
      // Unworn copies only, one the player made nothing of first; a worn one is left and logged
      const copies = entries.filter((e) => (Number(e.baseId) >>> 0) === id && !e.worn && !e.wornLeft && (Number(e.count) || 0) > 0)
        .sort((x, y) => (x.name || x.enchantmentId ? 1 : 0) - (y.name || y.enchantmentId ? 1 : 0));
      let left = n;
      for (const e of copies) { if (left <= 0) break; const k = Math.min(left, Number(e.count) || 0); e.count = (Number(e.count) || 0) - k; left -= k; }
      if (n - left > 0) taken.push([id, n - left]);
      if (left > 0) log(`disenchant: ${display(a)} disenchanted ${ingredientName(id)} x${n} but holds only ${n - left} unworn; ${left} not taken`);
    }
    if (!taken.length) return;
    try { mp.set(a, 'inventory', { entries: entries.filter((e) => Number(e.count) > 0) }); } catch (e) { log(`disenchant: inventory write failed for ${display(a)}: ${e.message}`); return; }
    const what = taken.map(([id, k]) => `${ingredientName(id)}${k > 1 ? ` x${k}` : ''}`).join(', ');
    log(`disenchant: ${display(a)} disenchanted ${what} at ${workbenchId.toString(16)}; taken`);
    audit(`DISENCHANT ${who(a)} used up ${what}`);
    tell(a, `Disenchanting uses up the item: ${what} ${taken.length > 1 || taken[0][1] > 1 ? 'are' : 'is'} gone.`);
  };

  // CustomEvent prepends the actor: (actor, workbench, result, inputs)
  mp.onCraftUnmatched = (actorId, workbenchId, resultId, inputs) => {
    const a = Number(actorId) >>> 0, wb = Number(workbenchId) >>> 0;
    try { if (isEnchanter(wb)) { disenchant(a, wb, inputs); return true; } } catch (e) { log(`disenchant: failed: ${e.message}`); return true; }
    try { brew(a, wb, inputs); } catch (e) { log(`alchemy: brew failed: ${e.message}`); }
    return true;
  };

  log(`alchemy on: ${POTIONS.size} effects with vanilla potions, strength by Alchemist rank`);
};
