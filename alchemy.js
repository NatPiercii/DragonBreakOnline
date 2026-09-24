// DragonBreak Online: alchemy at the ordinary alchemy labs. Loaded by gamemode.js on every hot reload.
//
// The lab's own menu mixes on the client and makes a potion no plugin holds (a 0xff... form), so the server's recipe
// check never matches it: every potion made this way used to be refused and rolled back. CraftService now fires
// onCraftUnmatched for such a craft, and this module honours it the way Nat chose: the effect is worked out here from
// the ingredient records (never taken from the client), and the player gets the nearest vanilla potion or poison
// (alchemy-potions.json, weakest to strongest), its strength set by their Alchemist rank. One of each ingredient used
// is taken, as in vanilla.
'use strict';
const fs = require('fs');
const path = require('path');

module.exports = (api) => {
  const { mp, log, personal, audit, display, who } = api;

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
  const effectsOf = (ingredient) => {
    const lr = lookup(ingredient); if (!lr || String(lr.record.type) !== 'INGR') return null;
    const out = [];
    for (const f of lr.record.fields || []) if (f.type === 'EFID') { try { const g = lr.toGlobalRecordId(u32(f, 0)) >>> 0; if (g) out.push(g); } catch (e) { /* unmapped */ } }
    return out;
  };
  const baseCost = (effect) => { const lr = lookup(effect); const data = lr && (lr.record.fields || []).find((f) => f.type === 'DATA'); return data ? f32(data, 4) : 0; };
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
  const said = new Map();
  const tell = (a, text) => { if (Date.now() - (said.get(a) || 0) > 1500) { said.set(a, Date.now()); personal(a, text); } };

  const brew = (a, workbenchId, inputs) => {
    if (!isLab(workbenchId)) return;
    if (!atLab(a, workbenchId)) return log(`alchemy: ${display(a)} reported a mix at lab ${workbenchId.toString(16)} while not at it; ignored`);
    const reported = inputs && Array.isArray(inputs.entries) ? inputs.entries : [];
    // Distinct ingredients the client says went in; vanilla mixes two or three, one of each
    const used = [...new Set(reported.map((e) => Number(e.baseId) >>> 0))];
    // Anything else is not a mix (such as the inventory re-applied while seated at the lab), so nothing is made
    if (used.length > 3 || used.some((id) => !effectsOf(id))) {
      log(`alchemy: ${display(a)} reported ${used.map((id) => id.toString(16)).join(' + ')}, not a lab mix; ignored`);
      // Only ingredients, too many of them: a real mix the client misreported, so the player is told
      if (used.length > 3 && used.every((id) => id < 0xff000000 && effectsOf(id))) tell(a, 'The lab did not recognise that mix, so nothing was brewed. Your ingredients come back when you leave the lab. Try again.');
      return;
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
      log(`alchemy: ${display(a)} brewed the ${draught.name} (tier ${alchemistTier(a)}) from ${used.map((id) => { const r = lookup(id); return r ? r.record.editorId : id.toString(16); }).join(' + ')}`);
      return;
    }
    const hint = draught && draught.hint ? ` ${draught.hint}` : '';
    // Effects two or more of them share; the most valuable one that a known potion carries decides the potion
    const tally = new Map();
    for (const id of used) for (const e of new Set(effectsOf(id))) tally.set(e, (tally.get(e) || 0) + 1);
    const shared = [...tally].filter(([, n]) => n >= 2).map(([e]) => e).filter((e) => POTIONS.has(e));
    if (!shared.length) return tell(a, 'These ingredients share no effect that makes a potion you know. You keep them.');
    shared.sort((x, y) => baseCost(y) - baseCost(x));
    const pick = POTIONS.get(shared[0]);
    const tier = alchemistTier(a);   // 0 without the trade, 1..5 by rank
    const index = Math.max(0, Math.min(pick.potions.length - 1, Math.round(tier / 5 * (pick.potions.length - 1))));
    const potion = pick.potions[index];
    for (const id of used) take(entries, id, 1);
    give(entries, potion.id, 1);
    try { mp.set(a, 'inventory', { entries: entries.filter((e) => Number(e.count) > 0) }); } catch (e) { log(`alchemy: inventory write failed for ${display(a)}: ${e.message}`); return; }
    const name = potion.edid.replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/\s+0?(\d+)$/, ' $1');
    tell(a, `You brew ${name}.${hint}`);
    log(`alchemy: ${display(a)} brewed ${potion.edid} (${pick.name}, tier ${tier}) from ${used.map((id) => { const r = lookup(id); return r ? r.record.editorId : id.toString(16); }).join(' + ')}`);
    audit(`ALCHEMY ${who(a)} brewed ${potion.edid}`);
  };

  // CustomEvent prepends the actor: (actor, workbench, result, inputs)
  mp.onCraftUnmatched = (actorId, workbenchId, resultId, inputs) => {
    try { brew(Number(actorId) >>> 0, Number(workbenchId) >>> 0, inputs); } catch (e) { log(`alchemy: brew failed: ${e.message}`); }
    return true;
  };

  log(`alchemy on: ${POTIONS.size} effects with vanilla potions, strength by Alchemist rank`);
};
